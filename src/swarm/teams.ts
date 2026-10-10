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
import { spawn as nodeSpawn, spawnSync as nodeSpawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { buildBlock, type PstackInput } from "../cursor/pstack.ts";

/** Hard ceiling on lanes per command, whatever the environment asks for. */
export const TEAMS_MAX_LANES = 6;

/** How long one lane's `orch_status.py` probe may run before it counts as a failed probe. */
export const ORCH_STATUS_TIMEOUT_MS = 10_000;

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
}

const defaultFs = { existsSync, mkdirSync, openSync, closeSync, readdirSync } satisfies TeamsFs;

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
	laneId: string;
	stateDir: string;
}

/** Per-lane task counts, or why the probe failed. */
export type LaneStatusRow =
	| { laneId: string; total: number; byState: Record<string, number>; done: number; summary: string }
	| { laneId: string; error: string };

/** Process start seam; the default is a detached, unref'd `node:child_process` spawn. */
export type LaneSpawnFn = (
	cmd: string,
	args: readonly string[],
	opts: { cwd: string; env: Record<string, string>; detached: true; stdio: readonly ["ignore", number, number] },
) => { pid?: number };

/** Synchronous probe seam for `orch_status.py`; injectable so status tests never run python. */
export type OrchStatusSpawn = (
	cmd: string,
	args: readonly string[],
	opts: { cwd: string; env: NodeJS.ProcessEnv; timeout: number },
) => { stdout?: string | null; stderr?: string | null; error?: Error | null };

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
	/** The host state directory; each lane gets `<stateDir>/swarm/<sha8(brief)>-<i>`. */
	stateDir: string;
	swarmRoot: string;
	/** Parent env, read for the optional `SWARM_AUTONOMOUS_RUN_CAP_S` passthrough. */
	env?: NodeJS.ProcessEnv;
	/** A pstack resolution (or a stand-in); when absent or unresolved the skills block is dropped. */
	pstack?: PstackInput;
}

/**
 * Plan one lane per brief, 1-based: id `lane-i`, an isolated state directory, the runner argv, and the lane
 * env. Deterministic — the same briefs and options always produce the same plan.
 */
export function planLanes(briefs: readonly string[], opts: PlanLanesOptions): LanePlan[] {
	const built = opts.pstack ? buildBlock("orchestrate", opts.pstack) : undefined;
	// Lanes never fail because of skills: an unresolved block is dropped silently.
	const skills = built && !("reason" in built) ? built.block : undefined;
	const cap = opts.env?.SWARM_AUTONOMOUS_RUN_CAP_S?.trim();
	return briefs.map((brief, index) => {
		const i = index + 1;
		const stateDir = join(opts.stateDir, "swarm", `${sha8(brief)}-${i}`);
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
			env: { SWARM_DIR: stateDir, ...(cap ? { SWARM_AUTONOMOUS_RUN_CAP_S: cap } : {}) },
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

/**
 * Discover previously spawned lanes under a host state directory: every `swarm/<sha8>-<i>` subdirectory
 * becomes `lane-<i>`, ordered by index; anything else is ignored.
 */
export function laneDirs(stateDir: string, fs: TeamsFs = defaultFs): LaneRef[] {
	const swarmDir = join(stateDir, "swarm");
	let names: string[] = [];
	try {
		names = fs.readdirSync(swarmDir);
	} catch {
		return [];
	}
	const lanes: LaneRef[] = [];
	for (const name of names) {
		const match = /^([0-9a-f]{8})-(\d+)$/.exec(name);
		if (!match) continue;
		lanes.push({ laneId: `lane-${match[2]}`, stateDir: join(swarmDir, name) });
	}
	lanes.sort((a, b) => a.laneId.localeCompare(b.laneId, undefined, { numeric: true }));
	return lanes;
}

/**
 * Read every lane's Task Store through `runFn` (the injected `orch_status.py` probe) and aggregate
 * `{ total, byState, done }` per lane, tolerantly: bad JSON, a failed probe or a throwing one is an error
 * row for that lane alone. `done` follows AgentSwarm's own convention (DONE, APPROVED, CANCELLED).
 */
export function laneStatus(
	lanes: readonly LaneRef[],
	runFn: (stateDir: string) => { stdout: string } | { error: string },
): LaneStatusRow[] {
	return lanes.map((lane) => {
		let probe: { stdout: string } | { error: string };
		try {
			probe = runFn(lane.stateDir);
		} catch (error) {
			return { laneId: lane.laneId, error: error instanceof Error ? error.message.slice(0, 200) : "status probe failed" };
		}
		if ("error" in probe) return { laneId: lane.laneId, error: probe.error };
		let parsed: unknown;
		try {
			parsed = JSON.parse(probe.stdout) as unknown;
		} catch {
			return { laneId: lane.laneId, error: "unreadable status output (not JSON)" };
		}
		let tasks: unknown[] | undefined;
		if (parsed && typeof parsed === "object" && "tasks" in parsed && Array.isArray(parsed.tasks)) tasks = parsed.tasks;
		if (!tasks) return { laneId: lane.laneId, error: "status output had no task list" };
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
		return { laneId: lane.laneId, total, byState, done, summary };
	});
}

/**
 * Build the default `runFn` for {@link laneStatus}: `orch_status.py --json --repo <cwd>` against the lane's
 * `SWARM_DIR`, capped at {@link ORCH_STATUS_TIMEOUT_MS}. A probe that exits non-zero but printed JSON still
 * reads; only missing output or a hard error is a failure.
 */
export function orchStatusRunner(
	opts: { swarmRoot: string; cwd: string; env?: NodeJS.ProcessEnv },
	spawnSyncFn: OrchStatusSpawn = (cmd, args, opts) => nodeSpawnSync(cmd, args as string[], { ...opts, encoding: "utf8" }),
): (stateDir: string) => { stdout: string } | { error: string } {
	return (stateDir) => {
		try {
			const result = spawnSyncFn(
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

/** The status reply: one summary line per lane, errors in place of counts. */
export function formatLaneStatusText(rows: readonly LaneStatusRow[]): string {
	if (rows.length === 0) return "No swarm lanes found under this state directory yet.";
	return rows.map((row) => ("error" in row ? `${row.laneId}: ${row.error}` : row.summary)).join("\n");
}
