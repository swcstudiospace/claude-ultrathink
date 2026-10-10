// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Swarm teams — the core behind `/ultrathink-swarm`: fan several concurrent AgentSwarm orchestrator lanes out
 * of one Omp command. Each lane is a detached `hooks/autonomous_run.py` process whose `SWARM_DIR` points at a
 * per-lane state directory, so the Task Store (SQLite plus `kickoffs/` locks) never contends across lanes.
 * Parsing and planning are pure and return `{ reason }` values instead of throwing; the effects — fs and
 * process starts — are injectable so tests never spawn a real process. This module composes with, and never
 * modifies, the AgentSwarm runtime checked out at `ULTRATHINK_SWARM_ROOT`.
 */
import { execFile as nodeExecFile, spawn as nodeSpawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { buildBlock, type PstackInput } from "../cursor/pstack.ts";

/** Hard ceiling on lanes per command, whatever the environment asks for. */
export const TEAMS_MAX_LANES = 6;

/** How long one lane's `orch_status.py` probe may run before it counts as a failed probe. */
export const ORCH_STATUS_TIMEOUT_MS = 10_000;

/** How many lanes `laneStatus` probes at once; the host must never block on a serial fan-out. */
export const LANE_STATUS_CONCURRENCY = 4;

/** How many historical lanes discovery reports at most (most recent by directory mtime). */
export const MAX_DISCOVERED_LANES = 24;

/** The run states AgentSwarm itself treats as finished (orch_status.py, swarm/observability.py). */
const DONE_STATES: Record<string, true> = { DONE: true, APPROVED: true, CANCELLED: true };

/** One-line user help for `/ultrathink-swarm`; the reply when parsing finds nothing usable. */
export const TEAMS_USAGE =
	"/ultrathink-swarm usage: `/ultrathink-swarm <brief>|<brief>|…` spawns one AgentSwarm orchestrator lane per " +
	`brief (up to ${TEAMS_MAX_LANES}); \`/ultrathink-swarm status\` reports each lane's task counts. Each lane ` +
	"gets its own SWARM_DIR, so state and logs are isolated under <state dir>/swarm/<lane>/run.log. Configuration " +
	"is env-only: ULTRATHINK_SWARM_ROOT (absolute agent-swarm checkout, required) and ULTRATHINK_SWARM_MAX_LANES " +
	`(default 3, cap ${TEAMS_MAX_LANES}).`;

/** The sync fs surface this module needs; injectable so tests never touch real state outside a tmpdir. */
export interface TeamsFs {
	existsSync(path: string): boolean;
	mkdirSync(path: string, options: { recursive: true }): void;
	openSync(path: string, flags: string): number;
	closeSync(fd: number): void;
	readdirSync(path: string): string[];
	statSync(path: string): { mtimeMs: number };
}

const defaultFs = { existsSync, mkdirSync, openSync, closeSync, readdirSync, statSync } satisfies TeamsFs;

/** A usable swarm checkout, or why lanes cannot run. */
export type SwarmRoot = { root: string } | { reason: string };

/** What the command argument parses into. */
export type LaneArgs =
	| { kind: "status" }
	| { kind: "spawn"; briefs: string[] }
	| { kind: "usage"; reason: string };

/** One planned lane: display brief, runtime brief (with skills block), and the exact process contract. */
export interface LanePlan {
	id: string;
	/** The brief as the user typed it, for display. */
	brief: string;
	/** What actually goes to `--brief`: the brief plus the pstack orchestrate block when one resolved. */
	laneBrief: string;
	cwd: string;
	stateDir: string;
	argv: string[];
	env: Record<string, string>;
}

/** One lane that was handed to the spawner: running, or the reason it never started. */
export interface LaneHandle {
	laneId: string;
	pid?: number;
	stateDir: string;
	logPath: string;
	/** Present only when this lane failed to start; sibling lanes are unaffected. */
	error?: string;
}

/** A lane addressable by status: its display id and the state directory that identifies it. */
export interface LaneRef {
	/** The lane state directory's full basename (`<sha8(brief)>-<i>-<nonce>`), so repeated lanes stay distinct. */
	laneId: string;
	stateDir: string;
}

/** What discovery found under one state directory, plus what its recency bound hid. */
export interface LaneDiscovery {
	/** The bounded lanes, ordered by lane index (then nonce). */
	lanes: LaneRef[];
	/** Older matching lanes beyond the {@link MAX_DISCOVERED_LANES} bound; they may still be running. */
	omitted: number;
}

/** Per-lane task counts, or why the probe failed. `logPath` always names the lane's run log. */
export type LaneStatusRow =
	| { laneId: string; logPath: string; total: number; byState: Record<string, number>; done: number; summary: string }
	| { laneId: string; logPath: string; error: string };

/** Process start seam; the default is a detached, unref'd `node:child_process` spawn. */
export type LaneSpawnFn = (
	cmd: string,
	args: readonly string[],
	opts: { cwd: string; env: Record<string, string>; detached: true; stdio: readonly ["ignore", number, number] },
) => { pid?: number };

/** Async probe seam for `orch_status.py`; injectable so status tests never run python. */
export type OrchStatusSpawn = (
	cmd: string,
	args: readonly string[],
	opts: { cwd: string; env: NodeJS.ProcessEnv; timeout: number },
) => Promise<{ stdout?: string | null; stderr?: string | null; error?: Error | null }>;

/** One lane's Task Store probe result: stdout to parse, or why the probe failed. */
export type LaneStatusProbe = (stateDir: string) => Promise<{ stdout: string } | { error: string }>;

/**
 * Validate `ULTRATHINK_SWARM_ROOT`: absolute, an existing directory, and containing `hooks/autonomous_run.py`.
 * Anything else is a `reason` the caller can show verbatim.
 */
export function resolveSwarmRoot(env: NodeJS.ProcessEnv, fs: TeamsFs = defaultFs): SwarmRoot {
	const raw = (env.ULTRATHINK_SWARM_ROOT ?? "").trim();
	if (!raw) return { reason: "ULTRATHINK_SWARM_ROOT is not set — point it at an absolute agent-swarm checkout" };
	if (!raw.startsWith("/")) return { reason: `ULTRATHINK_SWARM_ROOT must be an absolute path, got ${raw}` };
	const runner = join(raw, "hooks", "autonomous_run.py");
	if (!fs.existsSync(raw) || !fs.existsSync(runner)) {
		return { reason: `${raw} is not an agent-swarm checkout (missing ${runner})` };
	}
	return { root: raw };
}

/** The effective per-command lane limit: `ULTRATHINK_SWARM_MAX_LANES` (default 3), clamped to 1..6. */
export function maxLanes(env: NodeJS.ProcessEnv): number {
	const parsed = Number.parseInt(env.ULTRATHINK_SWARM_MAX_LANES ?? "", 10);
	if (!Number.isFinite(parsed) || parsed < 1) return 3;
	return Math.min(parsed, TEAMS_MAX_LANES);
}

/**
 * Split the command argument into `status`, a spawn plan, or a usage reply. Briefs are separated by `|`,
 * trimmed, and emptied ones dropped; more briefs than the lane limit (never more than the hard cap) is a
 * usage with the reason, never a partial spawn.
 */
export function parseLaneArgs(input: string, opts: { maxLanes?: number } = {}): LaneArgs {
	const text = (input ?? "").trim();
	if (text === "status") return { kind: "status" };
	const briefs = text
		.split("|")
		.map((brief) => brief.trim())
		.filter((brief) => brief.length > 0);
	if (briefs.length === 0) return { kind: "usage", reason: "no lane briefs given" };
	const limit = Math.min(Math.max(opts.maxLanes ?? 3, 1), TEAMS_MAX_LANES);
	if (briefs.length > limit) {
		return {
			kind: "usage",
			reason: `${briefs.length} briefs exceed the ${limit}-lane limit (ULTRATHINK_SWARM_MAX_LANES, cap ${TEAMS_MAX_LANES})`,
		};
	}
	return { kind: "spawn", briefs };
}

/** sha256 of the brief, first 8 hex characters: stable per brief, short enough for a directory name. */
const sha8 = (brief: string): string => createHash("sha256").update(brief, "utf8").digest("hex").slice(0, 8);

export interface PlanLanesOptions {
	cwd: string;
	/** The host state directory; each lane gets `<stateDir>/swarm/<sha8(brief)>-<i>-<nonce>`. */
	stateDir: string;
	swarmRoot: string;
	/** Parent env snapshot; the lane env merges it under the lane's own overrides (SWARM_DIR, cap). */
	env?: NodeJS.ProcessEnv;
	/** A pstack resolution (or a stand-in); when absent or unresolved the skills block is dropped. */
	pstack?: PstackInput;
	/** Invocation clock feeding the state-directory nonce; defaults to `Date.now`. */
	now?: () => number;
}

/**
 * Plan one lane per brief, 1-based: id `lane-i`, a per-invocation state directory (hash, index, nonce — so
 * repeated runs of the same briefs never share state), the runner argv, and the lane env: the parent env
 * merged under the lane's own overrides, so `PATH`/`HOME` and friends survive while `SWARM_DIR` and the cap
 * stay lane-local.
 */
export function planLanes(briefs: readonly string[], opts: PlanLanesOptions): LanePlan[] {
	const built = opts.pstack ? buildBlock("orchestrate", opts.pstack) : undefined;
	// Lanes never fail because of skills: an unresolved block is dropped silently.
	const skills = built && !("reason" in built) ? built.block : undefined;
	const cap = opts.env?.SWARM_AUTONOMOUS_RUN_CAP_S?.trim();
	const parentEnv: Record<string, string> = {};
	for (const [key, value] of Object.entries(opts.env ?? {})) {
		if (value !== undefined) parentEnv[key] = value;
	}
	// One nonce per invocation: base36 timestamp plus a few random hex digits so two invocations in the
	// same millisecond still land in distinct directories.
	const nonce = `${(opts.now ?? Date.now)().toString(36)}${randomBytes(2).toString("hex")}`;
	return briefs.map((brief, index) => {
		const i = index + 1;
		const stateDir = join(opts.stateDir, "swarm", `${sha8(brief)}-${i}-${nonce}`);
		const laneBrief = skills ? `${brief}\n\n${skills}` : brief;
		return {
			id: `lane-${i}`,
			brief,
			laneBrief,
			cwd: opts.cwd,
			stateDir,
			argv: [
				"python3",
				join(opts.swarmRoot, "hooks", "autonomous_run.py"),
				"--runtime",
				"omp",
				"--cwd",
				opts.cwd,
				"--brief",
				laneBrief,
			],
			env: { ...parentEnv, SWARM_DIR: stateDir, ...(cap ? { SWARM_AUTONOMOUS_RUN_CAP_S: cap } : {}) },
		};
	});
}

function startLaneDetached(
	cmd: string,
	args: readonly string[],
	opts: { cwd: string; env: Record<string, string>; detached: true; stdio: readonly ["ignore", number, number] },
): { pid?: number } {
	const child = nodeSpawn(cmd, args, { cwd: opts.cwd, env: opts.env, detached: true, stdio: opts.stdio as ["ignore", number, number] });
	// A missing launcher reports asynchronously as an 'error' event; without a listener it would crash the host.
	child.on("error", () => {});
	child.unref();
	return { pid: child.pid };
}

/**
 * Start every planned lane detached, each with `stdout`/`stderr` appended to `<stateDir>/run.log`. One lane
 * failing to start becomes an error row for that lane alone; the sibling lanes always spawn.
 */
export function spawnLanes(
	plan: readonly LanePlan[],
	spawnFn: LaneSpawnFn = startLaneDetached,
	fs: TeamsFs = defaultFs,
): LaneHandle[] {
	return plan.map((lane) => {
		const logPath = join(lane.stateDir, "run.log");
		try {
			fs.mkdirSync(lane.stateDir, { recursive: true });
			const log = fs.openSync(logPath, "a");
			try {
				const child = spawnFn(lane.argv[0]!, lane.argv.slice(1), {
					cwd: lane.cwd,
					env: lane.env,
					detached: true,
					stdio: ["ignore", log, log],
				});
				if (!child.pid) return { laneId: lane.id, stateDir: lane.stateDir, logPath, error: "spawned without a pid" };
				return { laneId: lane.id, pid: child.pid, stateDir: lane.stateDir, logPath };
			} finally {
				try {
					fs.closeSync(log);
				} catch {
					// the fd is the OS's to reap either way
				}
			}
		} catch (error) {
			return {
				laneId: lane.id,
				stateDir: lane.stateDir,
				logPath,
				error: error instanceof Error ? error.message.slice(0, 200) : "spawn failed",
			};
		}
	});
}

/** Lane state directories are `<sha8(brief)>-<i>-<nonce>`; the nonce is base36 alphanumerics. */
const LANE_DIR_PATTERN = /^([0-9a-f]{8})-(\d+)-([0-9a-z]+)$/;

/**
 * Discover recently spawned lanes under a host state directory: every `swarm/<sha8>-<i>-<nonce>`
 * subdirectory becomes a lane labelled by its full basename, ordered by lane index (then nonce). Discovery
 * is bounded to the {@link MAX_DISCOVERED_LANES} most recent directories by mtime, so history never floods
 * a status reply; the count of older lanes it hid is returned as `omitted`, because those lanes may still
 * be running and must not disappear silently.
 */
export function laneDirs(stateDir: string, fs: TeamsFs = defaultFs): LaneDiscovery {
	const swarmDir = join(stateDir, "swarm");
	let names: string[] = [];
	try {
		names = fs.readdirSync(swarmDir);
	} catch {
		return { lanes: [], omitted: 0 };
	}
	const lanes: Array<{ laneId: string; stateDir: string; index: number; nonce: string; mtimeMs: number }> = [];
	for (const name of names) {
		const match = LANE_DIR_PATTERN.exec(name);
		if (!match) continue;
		const full = join(swarmDir, name);
		let mtimeMs = 0;
		try {
			mtimeMs = fs.statSync(full).mtimeMs;
		} catch {
			// an entry that vanished mid-scan still counts, just as the oldest
		}
		lanes.push({ laneId: name, stateDir: full, index: Number.parseInt(match[2]!, 10), nonce: match[3]!, mtimeMs });
	}
	lanes.sort((a, b) => b.mtimeMs - a.mtimeMs);
	const kept = lanes.slice(0, MAX_DISCOVERED_LANES);
	return {
		lanes: kept
			.sort((a, b) => a.index - b.index || a.nonce.localeCompare(b.nonce))
			.map(({ laneId, stateDir }) => ({ laneId, stateDir })),
		omitted: lanes.length - kept.length,
	};
}

/**
 * Read every lane's Task Store through `runFn` (the injected `orch_status.py` probe) and aggregate
 * `{ total, byState, done }` per lane, tolerantly: bad JSON, a failed probe or a throwing one is an error
 * row for that lane alone. Probes run concurrently but at most {@link LANE_STATUS_CONCURRENCY} at a time,
 * and rows come back in input order. `done` follows AgentSwarm's own convention (DONE, APPROVED, CANCELLED).
 */
export async function laneStatus(lanes: readonly LaneRef[], runFn: LaneStatusProbe): Promise<LaneStatusRow[]> {
	const results = new Array<LaneStatusRow>(lanes.length);
	let next = 0;
	const worker = async (): Promise<void> => {
		for (;;) {
			const index = next;
			if (index >= lanes.length) return;
			next += 1;
			results[index] = await probeLane(lanes[index]!, runFn);
		}
	};
	await Promise.all(Array.from({ length: Math.min(LANE_STATUS_CONCURRENCY, lanes.length) }, () => worker()));
	return results;
}

/** Probe one lane and fold its Task Store into a status row; every failure mode stays lane-local. */
async function probeLane(lane: LaneRef, runFn: LaneStatusProbe): Promise<LaneStatusRow> {
	const logPath = join(lane.stateDir, "run.log");
	let probe: { stdout: string } | { error: string };
	try {
		probe = await runFn(lane.stateDir);
	} catch (error) {
		return { laneId: lane.laneId, logPath, error: error instanceof Error ? error.message.slice(0, 200) : "status probe failed" };
	}
	if ("error" in probe) return { laneId: lane.laneId, logPath, error: probe.error };
	let parsed: unknown;
	try {
		parsed = JSON.parse(probe.stdout) as unknown;
	} catch {
		return { laneId: lane.laneId, logPath, error: "unreadable status output (not JSON)" };
	}
	let tasks: unknown[] | undefined;
	if (parsed && typeof parsed === "object" && "tasks" in parsed && Array.isArray(parsed.tasks)) tasks = parsed.tasks;
	if (!tasks) return { laneId: lane.laneId, logPath, error: "status output had no task list" };
	const byState: Record<string, number> = {};
	let done = 0;
	for (const task of tasks) {
		let state = "UNKNOWN";
		if (task && typeof task === "object" && "state" in task && typeof task.state === "string") state = task.state;
		byState[state] = (byState[state] ?? 0) + 1;
		if (DONE_STATES[state]) done += 1;
	}
	const total = tasks.length;
	const counts = Object.entries(byState)
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.map(([state, count]) => `${count} ${state}`)
		.join(", ");
	const summary =
		total === 0
			? `${lane.laneId}: no tasks yet`
			: `${lane.laneId}: ${total} task${total === 1 ? "" : "s"} — ${counts} · ${done} done`;
	return { laneId: lane.laneId, logPath, total, byState, done, summary };
}

const execFileP = promisify(nodeExecFile);

/**
 * Default probe seam: promisified `execFile`, so a slow or hung `orch_status.py` never blocks the host's
 * hot path. A non-zero exit still surfaces whatever the probe printed, in `stdout`/`stderr`.
 */
const defaultStatusSpawn: OrchStatusSpawn = async (cmd, args, opts) => {
	try {
		const { stdout, stderr } = await execFileP(cmd, args as string[], { ...opts, encoding: "utf8" });
		return { stdout, stderr };
	} catch (error) {
		const err = error as (Error & { stdout?: unknown; stderr?: unknown }) | undefined;
		return {
			stdout: typeof err?.stdout === "string" ? err.stdout : "",
			stderr: (typeof err?.stderr === "string" ? err.stderr : "") || (err?.message ?? String(error)),
		};
	}
};

/**
 * Build the default probe for {@link laneStatus}: `orch_status.py --json --repo <cwd>` against the lane's
 * `SWARM_DIR`, capped at {@link ORCH_STATUS_TIMEOUT_MS}, run off the hot path through an injected async
 * seam. A probe that exits non-zero but printed JSON still reads; only missing output or a hard error is a
 * failure.
 */
export function orchStatusRunner(
	opts: { swarmRoot: string; cwd: string; env?: NodeJS.ProcessEnv },
	spawnFn: OrchStatusSpawn = defaultStatusSpawn,
): LaneStatusProbe {
	return async (stateDir) => {
		try {
			const result = await spawnFn(
				"python3",
				[join(opts.swarmRoot, "scripts", "orch_status.py"), "--json", "--repo", opts.cwd],
				{ cwd: opts.cwd, env: { ...opts.env, SWARM_DIR: stateDir }, timeout: ORCH_STATUS_TIMEOUT_MS },
			);
			if (typeof result.stdout === "string" && result.stdout.trim()) return { stdout: result.stdout };
			const raw = result.error ? result.error.message : (result.stderr ?? "");
			const detail = raw.replace(/\s+/g, " ").trim().slice(0, 200) || "no output";
			return { error: `orch_status.py probe failed: ${detail}` };
		} catch (error) {
			return { error: `orch_status.py probe failed: ${error instanceof Error ? error.message : String(error)}` };
		}
	};
}

/** The spawn reply: how many lanes started, where each one's state and log live, and any failed lane. */
export function formatLaneHandles(handles: readonly LaneHandle[]): string {
	if (handles.length === 0) return "No swarm lanes spawned.";
	const started = handles.filter((handle) => !handle.error).length;
	const lines = handles.map((handle) =>
		handle.error
			? `${handle.laneId}: failed to start — ${handle.error}`
			: `${handle.laneId}: pid ${handle.pid} · ${handle.stateDir}\n    log ${handle.logPath}`,
	);
	return [`Swarm lanes: ${started}/${handles.length} spawned`, ...lines].join("\n");
}

/**
 * The status reply: one summary per lane labelled by its state directory, with the log path; errors in
 * place of counts. When discovery hid older lanes behind its recency bound, a trailing line names the
 * omitted count instead of letting running lanes vanish from the report.
 */
export function formatLaneStatusText(rows: readonly LaneStatusRow[], omitted = 0): string {
	if (rows.length === 0 && omitted === 0) return "No swarm lanes found under this state directory yet.";
	const lines = rows.map(
		(row) => `${"error" in row ? `${row.laneId}: ${row.error}` : row.summary}\n    log ${row.logPath}`,
	);
	if (omitted > 0)
		lines.push(
			`${omitted} older lane${omitted === 1 ? "" : "s"} not shown — raise ULTRATHINK_SWARM_MAX_LANES-scoped discovery or prune <stateDir>/swarm`,
		);
	return lines.join("\n");
}

/** One GenUI card lane: the planned brief, where its state and log live, and how (or whether) it started. */
export interface SwarmLaneCard {
	laneId: string;
	brief: string;
	stateDir: string;
	logPath: string;
	pid?: number;
	error?: string;
}

/** The spawn reply as a card snapshot: how many lanes started out of how many planned, one card per lane. */
export interface SwarmSpawnCardSnapshot {
	spawned: number;
	total: number;
	lanes: SwarmLaneCard[];
}

/** One status card lane: the lane's own summary line and counts, or the probe error in their place; both carry the run log path. */
export type SwarmStatusLane =
	| { laneId: string; summary: string; logPath: string; done: number; total: number }
	| { laneId: string; summary: string; logPath: string; error: string };

/** The status reply as a card snapshot, plus how many discovered lanes the recency bound hid. */
export interface SwarmStatusCardSnapshot {
	lanes: SwarmStatusLane[];
	omitted: number;
}

/**
 * Project spawn results into a card snapshot: each handle joins its plan by position, so the lane card
 * carries the plan's display brief plus the handle's state dir, log path, pid, or start error. A plain
 * projection — text sanitization stays at render time, and nothing here touches fs or env.
 */
export function toSwarmSpawnCard(handles: readonly LaneHandle[], plans: readonly LanePlan[]): SwarmSpawnCardSnapshot {
	return {
		spawned: handles.filter((handle) => handle.pid !== undefined).length,
		total: plans.length,
		lanes: handles.map((handle, i) => ({
			laneId: handle.laneId,
			brief: plans[i]?.brief ?? handle.laneId,
			stateDir: handle.stateDir,
			logPath: handle.logPath,
			...(handle.pid === undefined ? {} : { pid: handle.pid }),
			...(handle.error === undefined ? {} : { error: handle.error }),
		})),
	};
}

/**
 * Project status rows into a card snapshot: a probed lane keeps its own summary and counts; a failed probe
 * becomes a bare error lane with empty counts; every lane carries its run log path, and the discovery
 * bound's omitted count passes through untouched.
 */
export function toSwarmStatusCard(rows: readonly LaneStatusRow[], omitted: number): SwarmStatusCardSnapshot {
	return {
		lanes: rows.map((row) =>
			"error" in row
				? { laneId: row.laneId, summary: "", logPath: row.logPath, error: row.error }
				: { laneId: row.laneId, summary: row.summary, logPath: row.logPath, done: row.done, total: row.total },
		),
		omitted,
	};
}
