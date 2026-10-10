// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
// Covers /ultrathink-swarm's core: parsing, lane planning (ids, hashing, parent-env merging, per-invocation
// nonced state dirs, pstack block), detached spawning through an injected spawner, discovery bounded by
// mtime, and tolerant per-lane status aggregation through an async injected probe with bounded concurrency.
// No test spawns a real process, no real wall-clock timers, and real fs touches only tmpdirs.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
	type LaneHandle,
	formatLaneHandles,
	formatLaneStatusText,
	laneDirs,
	laneStatus,
	type LaneStatusRow,
	maxLanes,
	LANE_STATUS_CONCURRENCY,
	MAX_DISCOVERED_LANES,
	ORCH_STATUS_TIMEOUT_MS,
	orchStatusRunner,
	parseLaneArgs,
	planLanes,
	type PlanLanesOptions,
	resolveSwarmRoot,
	spawnLanes,
	type TeamsFs,
	TEAMS_MAX_LANES,
	TEAMS_USAGE,
} from "./teams.ts";

const sha8 = (brief: string): string => createHash("sha256").update(brief, "utf8").digest("hex").slice(0, 8);

/** A fs seam over real syscalls; tests only ever point it at tmpdir paths. */
const realFs: TeamsFs = { existsSync, mkdirSync, openSync, closeSync: () => {}, readdirSync, statSync };

const baseOpts = (stateDir: string, env: NodeJS.ProcessEnv = {}): PlanLanesOptions => ({
	cwd: "/repo",
	stateDir,
	swarmRoot: "/opt/agent-swarm",
	env,
});

/** Spawner that records every start request; optionally fails one lane (the one whose dir is `…-2-<nonce>`). */
function recordingSpawner(failLane2: boolean) {
	const calls: Array<{ cmd: string; args: readonly string[]; env: Record<string, string>; detached: boolean; stdio: readonly unknown[]; cwd: string }> = [];
	const fn = (cmd: string, args: readonly string[], opts: { cwd: string; env: Record<string, string>; detached: true; stdio: readonly ["ignore", number, number] }) => {
		calls.push({ cmd, args, env: opts.env, detached: opts.detached, stdio: opts.stdio, cwd: opts.cwd });
		if (failLane2 && /-2-[0-9a-z]+$/.test(opts.env.SWARM_DIR ?? "")) throw new Error("boom");
		return { pid: 1000 + calls.length };
	};
	return { calls, fn };
}

describe("resolveSwarmRoot", () => {
	test("refuses a missing, relative, or incomplete root with a reason", () => {
		expect(resolveSwarmRoot({})).toHaveProperty("reason");
		const relative = resolveSwarmRoot({ ULTRATHINK_SWARM_ROOT: "relative/path" });
		if (!("reason" in relative)) throw new Error("expected a refusal");
		expect(relative.reason).toContain("absolute");
		const bare = mkdtempSync(join(tmpdir(), "teams-bare-"));
		const incomplete = resolveSwarmRoot({ ULTRATHINK_SWARM_ROOT: bare });
		if (!("reason" in incomplete)) throw new Error("expected a refusal");
		expect(incomplete.reason).toContain("autonomous_run.py");
		rmSync(bare, { recursive: true, force: true });
	});

	test("accepts a checkout containing hooks/autonomous_run.py", () => {
		const root = mkdtempSync(join(tmpdir(), "teams-root-"));
		mkdirSync(join(root, "hooks"), { recursive: true });
		writeFileSync(join(root, "hooks", "autonomous_run.py"), "# runner\n");
		expect(resolveSwarmRoot({ ULTRATHINK_SWARM_ROOT: root }, realFs)).toEqual({ root });
		rmSync(root, { recursive: true, force: true });
	});
});

describe("parseLaneArgs", () => {
	test("status subcommand", () => {
		expect(parseLaneArgs("status")).toEqual({ kind: "status" });
		expect(parseLaneArgs("  status  ")).toEqual({ kind: "status" });
	});

	test("empty input is a usage with a reason", () => {
		expect(parseLaneArgs("   ")).toEqual({ kind: "usage", reason: expect.stringContaining("no lane briefs") });
	});

	test("splits briefs on |, trims each, drops empties", () => {
		expect(parseLaneArgs("fix the parser |  add tests  | |  ")).toEqual({
			kind: "spawn",
			briefs: ["fix the parser", "add tests"],
		});
	});

	test("more briefs than the lane limit is a usage, never a partial spawn", () => {
		const seven = "a|b|c|d|e|f|g";
		expect(parseLaneArgs(seven).kind).toBe("usage");
		// The default limit is 3; raising it admits more, but never past the hard cap.
		expect(parseLaneArgs("a|b|c|d").kind).toBe("usage");
		expect(parseLaneArgs("a|b|c|d", { maxLanes: 4 })).toEqual({ kind: "spawn", briefs: ["a", "b", "c", "d"] });
		expect(parseLaneArgs("a|b|c|d|e|f", { maxLanes: TEAMS_MAX_LANES }).kind).toBe("spawn");
		expect(parseLaneArgs(seven, { maxLanes: TEAMS_MAX_LANES }).kind).toBe("usage");
	});

	test("maxLanes reads ULTRATHINK_SWARM_MAX_LANES, defaults to 3, clamps to 1..6", () => {
		expect(maxLanes({})).toBe(3);
		expect(maxLanes({ ULTRATHINK_SWARM_MAX_LANES: "5" })).toBe(5);
		expect(maxLanes({ ULTRATHINK_SWARM_MAX_LANES: "0" })).toBe(3);
		expect(maxLanes({ ULTRATHINK_SWARM_MAX_LANES: "junk" })).toBe(3);
		expect(maxLanes({ ULTRATHINK_SWARM_MAX_LANES: "99" })).toBe(TEAMS_MAX_LANES);
	});
});

describe("planLanes", () => {
	const dirName = (stateDir: string): string => basename(stateDir);

	test("plans 1-based ids and per-brief hashed, nonced state directories", () => {
		const plan = planLanes(["first brief", "second brief"], baseOpts("/state/host"));
		expect(plan.map((lane) => lane.id)).toEqual(["lane-1", "lane-2"]);
		// Directory shape: <sha8(brief)>-<i>-<nonce>.
		expect(dirName(plan[0]!.stateDir)).toMatch(new RegExp(`^${sha8("first brief")}-1-[0-9a-z]+$`));
		expect(dirName(plan[1]!.stateDir)).toMatch(new RegExp(`^${sha8("second brief")}-2-[0-9a-z]+$`));
		// Hashing is stable per brief and distinct across briefs.
		expect(dirName(plan[0]!.stateDir).startsWith(sha8("first brief"))).toBe(true);
		expect(plan[0]!.stateDir).not.toBe(plan[1]!.stateDir);
		// One nonce per invocation: lanes of the same run share it, so repeated briefs stay distinct by index.
		expect(dirName(plan[0]!.stateDir).split("-")[2]).toBe(dirName(plan[1]!.stateDir).split("-")[2]);
		const [dupA, dupB] = planLanes(["same brief", "same brief"], baseOpts("/state/host"));
		expect(dupA!.stateDir).not.toBe(dupB!.stateDir);
	});

	test("repeated invocations never share a state directory", () => {
		const first = planLanes(["same brief"], baseOpts("/state/host"))[0]!;
		const second = planLanes(["same brief"], baseOpts("/state/host"))[0]!;
		expect(first.stateDir).not.toBe(second.stateDir);
	});

	test("the nonce carries the injected clock", () => {
		const [lane] = planLanes(["same brief"], { ...baseOpts("/state/host"), now: () => 12345 });
		const stamp = (12345).toString(36);
		expect(dirName(lane!.stateDir)).toMatch(new RegExp(`^${sha8("same brief")}-1-${stamp}[0-9a-f]{4}$`));
	});

	test("lane env merges the parent environment; lane keys win", () => {
		const parent = { PATH: "/usr/bin:/bin", HOME: "/root", SWARM_DIR: "/parent/dir", SWARM_AUTONOMOUS_RUN_CAP_S: "45", EMPTY: undefined };
		const [lane] = planLanes(["do it"], baseOpts("/state/host", parent));
		// Parent basics survive into the lane.
		expect(lane!.env.PATH).toBe("/usr/bin:/bin");
		expect(lane!.env.HOME).toBe("/root");
		// The lane's own keys override the parent.
		expect(lane!.env.SWARM_DIR).toBe(lane!.stateDir);
		expect(lane!.env.SWARM_AUTONOMOUS_RUN_CAP_S).toBe("45");
		// Undefined parent values are dropped, never stringified.
		expect("EMPTY" in lane!.env).toBe(false);
	});

	test("without a parent env the lane env is just the lane's own keys", () => {
		const [lane] = planLanes(["do it"], baseOpts("/state/host"));
		expect(lane!.env).toEqual({ SWARM_DIR: lane!.stateDir });
	});

	test("argv is the runner contract", () => {
		const [lane] = planLanes(["do it"], baseOpts("/state/host"));
		expect(lane!.argv).toEqual([
			"python3",
			join("/opt/agent-swarm", "hooks", "autonomous_run.py"),
			"--runtime",
			"omp",
			"--cwd",
			"/repo",
			"--brief",
			"do it",
		]);
		expect(lane!.cwd).toBe("/repo");
	});

	test("passes SWARM_AUTONOMOUS_RUN_CAP_S through when set", () => {
		const [lane] = planLanes(["do it"], baseOpts("/state/host", { SWARM_AUTONOMOUS_RUN_CAP_S: "1800" }));
		expect(lane!.env.SWARM_AUTONOMOUS_RUN_CAP_S).toBe("1800");
	});

	test("appends a resolved pstack orchestrate block to the brief, drops an unresolved one silently", () => {
		const skillsDir = mkdtempSync(join(tmpdir(), "teams-pstack-"));
		for (const name of ["how", "architect", "arena", "tdd", "interrogate", "no-comments"]) {
			mkdirSync(join(skillsDir, name), { recursive: true });
			writeFileSync(join(skillsDir, name, "SKILL.md"), `# ${name}\n`);
		}
		const [withSkills] = planLanes(["build it"], { ...baseOpts("/s"), pstack: { skillsDir } });
		expect(withSkills!.laneBrief).toContain("build it");
		expect(withSkills!.laneBrief).toContain("pstack alongside GSD (orchestrate");
		expect(withSkills!.argv.at(-1)).toBe(withSkills!.laneBrief);
		const [unresolved] = planLanes(["build it"], { ...baseOpts("/s"), pstack: { reason: "no cache" } });
		expect(unresolved!.laneBrief).toBe("build it");
		const [noPstack] = planLanes(["build it"], baseOpts("/s"));
		expect(noPstack!.laneBrief).toBe("build it");
		rmSync(skillsDir, { recursive: true, force: true });
	});
});

describe("spawnLanes", () => {
	test("starts one detached process per lane with the log appended in the lane state dir", () => {
		const stateDir = mkdtempSync(join(tmpdir(), "teams-spawn-"));
		const { calls, fn } = recordingSpawner(false);
		const plan = planLanes(["one", "two"], baseOpts(stateDir, { PATH: "/usr/bin:/bin" }));
		const handles = spawnLanes(plan, fn, realFs);
		expect(handles.map((handle) => handle.laneId)).toEqual(["lane-1", "lane-2"]);
		expect(handles.every((handle) => !handle.error)).toBe(true);
		expect(calls.length).toBe(2);
		expect(calls[0]!.cmd).toBe("python3");
		expect(calls[0]!.args[0]).toBe(join("/opt/agent-swarm", "hooks", "autonomous_run.py"));
		// The child env carries the parent basics plus the lane's own SWARM_DIR.
		expect(calls[0]!.env.PATH).toBe("/usr/bin:/bin");
		expect(calls[0]!.env.SWARM_DIR).toBe(plan[0]!.stateDir);
		expect(calls[0]!.detached).toBe(true);
		expect(calls[0]!.cwd).toBe("/repo");
		// stdout/stderr are file descriptors onto the lane's log.
		expect(typeof calls[0]!.stdio[1]).toBe("number");
		expect(handles[0]!.logPath).toBe(join(plan[0]!.stateDir, "run.log"));
		expect(existsSync(handles[0]!.logPath)).toBe(true);
		rmSync(stateDir, { recursive: true, force: true });
	});

	test("one failing lane is an error row for that lane alone; siblings still spawn", () => {
		const stateDir = mkdtempSync(join(tmpdir(), "teams-fail-"));
		const { calls, fn } = recordingSpawner(true);
		const handles = spawnLanes(planLanes(["a", "b", "c"], baseOpts(stateDir)), fn, realFs);
		expect(calls.length).toBe(3);
		expect(handles[1]).toMatchObject({ laneId: "lane-2", error: "boom" });
		expect(handles[0]).toMatchObject({ laneId: "lane-1", pid: 1001 });
		expect(handles[2]!.pid).toBeDefined();
		rmSync(stateDir, { recursive: true, force: true });
	});

	test("a spawner that returns no pid is an error row", () => {
		const stateDir = mkdtempSync(join(tmpdir(), "teams-nopid-"));
		const handles = spawnLanes(planLanes(["only"], baseOpts(stateDir)), () => ({}), realFs);
		expect(handles[0]).toMatchObject({ laneId: "lane-1", error: expect.stringContaining("pid") });
		rmSync(stateDir, { recursive: true, force: true });
	});
});

describe("laneStatus", () => {
	const lane = (stateDir: string) => ({ laneId: basename(stateDir), stateDir });

	test("aggregates task counts and a summary per lane, accepting id or task_id rows", async () => {
		const probes: Record<string, { stdout: string } | { error: string }> = {
			"/s/x-1": { stdout: JSON.stringify({ tasks: [
				{ id: "T-1", state: "DONE" },
				{ task_id: "T-2", state: "RUNNING" },
				{ id: "T-3", state: "DONE" },
			] }) },
			"/s/x-2": { error: "timed out" },
		};
		const results = await laneStatus([lane("/s/x-1"), lane("/s/x-2")], async (stateDir) => {
			const probe = probes[stateDir];
			if (!probe) throw new Error("unexpected probe");
			return probe;
		});
		expect(results[0]).toMatchObject({
			laneId: "x-1",
			logPath: "/s/x-1/run.log",
			total: 3,
			done: 2,
			byState: { DONE: 2, RUNNING: 1 },
		});
		const good = results[0]!;
		if ("error" in good) throw new Error("expected an aggregate row");
		expect(good.summary).toContain("x-1: 3 tasks");
		expect(good.summary).toContain("2 done");
		expect(results[1]).toEqual({ laneId: "x-2", logPath: "/s/x-2/run.log", error: "timed out" });
	});

	test("bad JSON, missing task lists and throwing probes are error rows", async () => {
		const probes: Record<string, { stdout: string }> = {
			"/s/y-1": { stdout: "not json {" },
			"/s/y-2": { stdout: JSON.stringify({ nope: true }) },
		};
		const results = await laneStatus([lane("/s/y-1"), lane("/s/y-2"), lane("/s/y-3")], async (stateDir) => {
			const probe = probes[stateDir];
			if (!probe) throw new Error("probe exploded");
			return probe;
		});
		expect(results[0]).toEqual({ laneId: "y-1", logPath: "/s/y-1/run.log", error: expect.stringContaining("not JSON") });
		expect(results[1]).toEqual({ laneId: "y-2", logPath: "/s/y-2/run.log", error: expect.stringContaining("no task list") });
		expect(results[2]).toEqual({ laneId: "y-3", logPath: "/s/y-3/run.log", error: "probe exploded" });
	});

	test("an empty task store is a lane with nothing to do, not an error", async () => {
		const results = await laneStatus([lane("/s/z-1")], async () => ({ stdout: JSON.stringify({ tasks: [] }) }));
		expect(results[0]).toMatchObject({ laneId: "z-1", logPath: "/s/z-1/run.log", total: 0, done: 0 });
		const row = results[0]!;
		if ("error" in row) throw new Error("expected an aggregate row");
		expect(row.summary).toContain("no tasks yet");
	});

	test("probes overlap up to the concurrency cap and rows keep input order", async () => {
		let inFlight = 0;
		let maxInFlight = 0;
		let started = 0;
		const lanes = Array.from({ length: 8 }, (_, index) => ({ laneId: `lane-${index + 1}`, stateDir: `/s/lane-${index + 1}` }));
		// Each probe parks on its own gate; the test releases them — no real timers anywhere.
		const gates = lanes.map(() => Promise.withResolvers<void>());
		const rows = laneStatus(lanes, async (stateDir) => {
			const gate = gates[Number(stateDir.split("-").pop()) - 1]!;
			started += 1;
			inFlight += 1;
			maxInFlight = Math.max(maxInFlight, inFlight);
			await gate.promise;
			inFlight -= 1;
			return { stdout: JSON.stringify({ tasks: [{ id: "T-1", state: "DONE" }] }) };
		});
		// The cap is LANE_STATUS_CONCURRENCY: exactly that many probes can be parked at once. Drain
		// microtasks to let any illegally scheduled extra worker start — started must stay at the cap.
		for (let tick = 0; tick < 25; tick += 1) await Promise.resolve();
		expect(started).toBe(LANE_STATUS_CONCURRENCY);
		for (const gate of gates) gate.resolve();
		expect((await rows).map((row) => row.laneId)).toEqual(lanes.map((entry) => entry.laneId));
		expect(maxInFlight).toBe(LANE_STATUS_CONCURRENCY);
	});
});

describe("orchStatusRunner", () => {
	test("probes orch_status.py with the lane SWARM_DIR and a 10s cap", async () => {
		const seen: Array<{ cmd: string; args: readonly string[]; opts: { env: NodeJS.ProcessEnv; timeout: number } }> = [];
		const runner = orchStatusRunner({ swarmRoot: "/opt/agent-swarm", cwd: "/repo", env: { ULTRATHINK_HOST: "omp" } }, async (cmd, args, opts) => {
			seen.push({ cmd, args, opts });
			return { stdout: JSON.stringify({ tasks: [] }) };
		});
		expect(await runner("/lane/dir")).toEqual({ stdout: JSON.stringify({ tasks: [] }) });
		expect(seen[0]!.cmd).toBe("python3");
		expect(seen[0]!.args).toEqual([join("/opt/agent-swarm", "scripts", "orch_status.py"), "--json", "--repo", "/repo"]);
		expect(seen[0]!.opts.env.SWARM_DIR).toBe("/lane/dir");
		expect(seen[0]!.opts.env.ULTRATHINK_HOST).toBe("omp");
		expect(seen[0]!.opts.timeout).toBe(ORCH_STATUS_TIMEOUT_MS);
	});

	test("a non-zero exit that still printed JSON reads as stdout", async () => {
		const runner = orchStatusRunner({ swarmRoot: "/opt/agent-swarm", cwd: "/repo" }, async () => ({
			stdout: JSON.stringify({ tasks: [] }),
			error: new Error("exited with code 1"),
		}));
		expect(await runner("/lane/dir")).toEqual({ stdout: JSON.stringify({ tasks: [] }) });
	});

	test("missing stdout is an error carrying the failure detail", async () => {
		const stderrProbe = orchStatusRunner({ swarmRoot: "/opt/agent-swarm", cwd: "/repo" }, async () => ({
			stdout: "",
			stderr: "traceback (line 1)\n    boom",
		}));
		const stderrResult = await stderrProbe("/lane/dir");
		expect("error" in stderrResult && stderrResult.error).toContain("boom");
		const errorProbe = orchStatusRunner({ swarmRoot: "/opt/agent-swarm", cwd: "/repo" }, async () => ({
			error: new Error("spawn python3 ENOENT"),
		}));
		const errorResult = await errorProbe("/lane/dir");
		expect("error" in errorResult && errorResult.error).toContain("ENOENT");
	});

	test("a throwing probe seam is a failure, not a crash", async () => {
		const runner = orchStatusRunner({ swarmRoot: "/opt/agent-swarm", cwd: "/repo" }, async () => {
			throw new Error("kaboom");
		});
		const result = await runner("/lane/dir");
		expect("error" in result && result.error).toContain("kaboom");
	});
});

describe("laneDirs", () => {
	test("discovers nonced lane directories, labels them by full basename, ignores strangers", () => {
		const stateDir = mkdtempSync(join(tmpdir(), "teams-dirs-"));
		mkdirSync(join(stateDir, "swarm", `${sha8("a")}-1-m0a`), { recursive: true });
		mkdirSync(join(stateDir, "swarm", `${sha8("b")}-2-m0b`), { recursive: true });
		// Pre-nonce shape and non-lane entries are ignored.
		mkdirSync(join(stateDir, "swarm", "abcd1234-1"), { recursive: true });
		mkdirSync(join(stateDir, "swarm", "zzzzzzzz-3-m0c"), { recursive: true });
		writeFileSync(join(stateDir, "swarm", "stray.txt"), "x");
		const lanes = laneDirs(stateDir, realFs);
		expect(lanes.map((entry) => entry.laneId)).toEqual([`${sha8("a")}-1-m0a`, `${sha8("b")}-2-m0b`]);
		expect(lanes[0]!.stateDir).toBe(join(stateDir, "swarm", `${sha8("a")}-1-m0a`));
		// A state directory without swarm lanes discovers nothing.
		expect(laneDirs(join(stateDir, "empty"), realFs)).toEqual([]);
		rmSync(stateDir, { recursive: true, force: true });
	});

	test("bounds discovery to the most recent lanes by mtime, ordered by index then nonce", () => {
		const entries: Record<string, { mtimeMs: number }> = {};
		for (let i = 1; i <= 30; i += 1) entries[`abcd1234-${i}-m${i.toString(36)}`] = { mtimeMs: i };
		// A relabelled (re-spawned) lane keeps its index but jumps the recency queue.
		entries["abcd1234-2-mzz"] = { mtimeMs: 999 };
		const fakeFs: TeamsFs = {
			existsSync: () => false,
			mkdirSync: () => {},
			openSync: () => 0,
			closeSync: () => {},
			readdirSync: () => Object.keys(entries),
			statSync: (path: string) => {
				const entry = entries[basename(path)];
				if (!entry) throw new Error(`vanished: ${path}`);
				return entry;
			},
		};
		const lanes = laneDirs("/state", fakeFs);
		expect(lanes.length).toBe(MAX_DISCOVERED_LANES);
		const ids = lanes.map((entry) => entry.laneId);
		expect(ids).not.toContain("abcd1234-1-m1"); // oldest dropped
		expect(ids).not.toContain("abcd1234-7-m7");
		expect(ids).toContain("abcd1234-30-m30");
		expect(ids).toContain("abcd1234-2-mzz"); // recent despite its low index
		// Within the kept set, labels order by lane index then nonce.
		const keys = ids.map((id) => {
			const parts = id.split("-");
			return { index: Number(parts[1]), nonce: parts[2]! };
		});
		for (let i = 1; i < keys.length; i += 1) {
			expect(keys[i]!.index).toBeGreaterThanOrEqual(keys[i - 1]!.index);
			if (keys[i]!.index === keys[i - 1]!.index) expect(keys[i]!.nonce >= keys[i - 1]!.nonce).toBe(true);
		}
	});
});

describe("display formatting", () => {
	test("formatLaneHandles shows started counts, pids, log paths and failed lanes", () => {
		const handles: LaneHandle[] = [
			{ laneId: "lane-1", pid: 7, stateDir: "/s/ab-1", logPath: "/s/ab-1/run.log" },
			{ laneId: "lane-2", stateDir: "/s/cd-2", logPath: "/s/cd-2/run.log", error: "boom" },
		];
		const text = formatLaneHandles(handles);
		expect(text).toContain("1/2 spawned");
		expect(text).toContain("lane-1: pid 7");
		expect(text).toContain("log /s/ab-1/run.log");
		expect(text).toContain("lane-2: failed to start — boom");
		expect(formatLaneHandles([])).toContain("No swarm lanes");
	});

	test("formatLaneStatusText joins summaries, names errors, and shows each lane's log", () => {
		const rows: LaneStatusRow[] = [
			{
				laneId: "abcd1234-1-m9x",
				logPath: "/s/abcd1234-1-m9x/run.log",
				total: 2,
				byState: { DONE: 2 },
				done: 2,
				summary: "abcd1234-1-m9x: 2 tasks — 2 DONE · 2 done",
			},
			{ laneId: "ef567890-2-m9y", logPath: "/s/ef567890-2-m9y/run.log", error: "timed out" },
		];
		const text = formatLaneStatusText(rows);
		expect(text).toContain("abcd1234-1-m9x: 2 tasks — 2 DONE · 2 done");
		expect(text).toContain("log /s/abcd1234-1-m9x/run.log");
		expect(text).toContain("ef567890-2-m9y: timed out");
		expect(text).toContain("log /s/ef567890-2-m9y/run.log");
		expect(formatLaneStatusText([])).toContain("No swarm lanes");
	});

	test("TEAMS_USAGE documents the command surface", () => {
		expect(TEAMS_USAGE).toContain("/ultrathink-swarm");
		expect(TEAMS_USAGE).toContain("ULTRATHINK_SWARM_ROOT");
		expect(TEAMS_USAGE).toContain("ULTRATHINK_SWARM_MAX_LANES");
		expect(TEAMS_USAGE).toContain("status");
	});
});
