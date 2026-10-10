// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
// Covers /ultrathink-swarm's core: parsing, lane planning (ids, hashing, pstack block), detached spawning
// through an injected spawner, and tolerant per-lane status aggregation. No test spawns a real process and
// real fs touches only tmpdirs.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type LaneHandle,
	formatLaneHandles,
	formatLaneStatusText,
	laneDirs,
	laneStatus,
	type LaneStatusRow,
	maxLanes,
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
const realFs: TeamsFs = { existsSync, mkdirSync, openSync, closeSync: () => {}, readdirSync };

const baseOpts = (stateDir: string, env: NodeJS.ProcessEnv = {}): PlanLanesOptions => ({
	cwd: "/repo",
	stateDir,
	swarmRoot: "/opt/agent-swarm",
	env,
});

/** Spawner that records every start request; optionally fails one lane (the one whose dir ends in `-2`). */
function recordingSpawner(failLane2: boolean) {
	const calls: Array<{ cmd: string; args: readonly string[]; env: Record<string, string>; detached: boolean; stdio: readonly unknown[]; cwd: string }> = [];
	const fn = (cmd: string, args: readonly string[], opts: { cwd: string; env: Record<string, string>; detached: true; stdio: readonly ["ignore", number, number] }) => {
		calls.push({ cmd, args, env: opts.env, detached: opts.detached, stdio: opts.stdio, cwd: opts.cwd });
		if (failLane2 && opts.env.SWARM_DIR?.endsWith("-2")) throw new Error("boom");
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
	test("plans 1-based ids and per-brief hashed state directories", () => {
		const plan = planLanes(["first brief", "second brief"], baseOpts("/state/host"));
		expect(plan.map((lane) => lane.id)).toEqual(["lane-1", "lane-2"]);
		expect(plan[0]!.stateDir).toBe(join("/state/host", "swarm", `${sha8("first brief")}-1`));
		expect(plan[1]!.stateDir).toBe(join("/state/host", "swarm", `${sha8("second brief")}-2`));
		// Hashing is stable per brief and distinct across briefs.
		expect(plan[0]!.stateDir).not.toBe(plan[1]!.stateDir);
		expect(planLanes(["first brief"], baseOpts("/state/host"))[0]!.stateDir).toBe(plan[0]!.stateDir);
	});

	test("argv is the runner contract and env isolates SWARM_DIR", () => {
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
		expect(lane!.env).toEqual({ SWARM_DIR: lane!.stateDir });
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
		const plan = planLanes(["one", "two"], baseOpts(stateDir));
		const handles = spawnLanes(plan, fn, realFs);
		expect(handles.map((handle) => handle.laneId)).toEqual(["lane-1", "lane-2"]);
		expect(handles.every((handle) => !handle.error)).toBe(true);
		expect(calls.length).toBe(2);
		expect(calls[0]!.cmd).toBe("python3");
		expect(calls[0]!.args[0]).toBe(join("/opt/agent-swarm", "hooks", "autonomous_run.py"));
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
	const lane = (stateDir: string) => ({ laneId: `lane-${stateDir.at(-1)}`, stateDir });

	test("aggregates task counts and a summary per lane, accepting id or task_id rows", () => {
		const probes = new Map<string, { stdout: string } | { error: string }>([
			["/s/x-1", { stdout: JSON.stringify({ tasks: [
				{ id: "T-1", state: "DONE" },
				{ task_id: "T-2", state: "RUNNING" },
				{ id: "T-3", state: "DONE" },
			] }) }],
			["/s/x-2", { error: "timed out" }],
		]);
		const results = laneStatus([lane("/s/x-1"), lane("/s/x-2")], (stateDir) => {
			const probe = probes.get(stateDir);
			if (!probe) throw new Error("unexpected probe");
			return probe;
		});
		expect(results[0]).toMatchObject({ laneId: "lane-1", total: 3, done: 2, byState: { DONE: 2, RUNNING: 1 } });
		const good = results[0] as { summary: string };
		expect(good.summary).toContain("3 tasks");
		expect(good.summary).toContain("2 done");
		expect(results[1]).toEqual({ laneId: "lane-2", error: "timed out" });
	});

	test("bad JSON, missing task lists and throwing probes are error rows", () => {
		const probes = new Map<string, { stdout: string }>([
			["/s/y-1", { stdout: "not json {" }],
			["/s/y-2", { stdout: JSON.stringify({ nope: true }) }],
		]);
		const results = laneStatus([lane("/s/y-1"), lane("/s/y-2"), lane("/s/y-3")], (stateDir) => {
			const probe = probes.get(stateDir);
			if (!probe) throw new Error("probe exploded");
			return probe;
		});
		expect(results[0]).toEqual({ laneId: "lane-1", error: expect.stringContaining("not JSON") });
		expect(results[1]).toEqual({ laneId: "lane-2", error: expect.stringContaining("no task list") });
		expect(results[2]).toEqual({ laneId: "lane-3", error: "probe exploded" });
	});

	test("an empty task store is a lane with nothing to do, not an error", () => {
		const results = laneStatus([lane("/s/z-1")], () => ({ stdout: JSON.stringify({ tasks: [] }) }));
		expect(results[0]).toMatchObject({ laneId: "lane-1", total: 0, done: 0 });
		expect((results[0] as { summary: string }).summary).toContain("no tasks yet");
	});
});

describe("orchStatusRunner", () => {
	test("probes orch_status.py with the lane SWARM_DIR and a 10s cap", () => {
		const seen: Array<{ cmd: string; args: readonly string[]; opts: { env: NodeJS.ProcessEnv; timeout: number } }> = [];
		const runner = orchStatusRunner({ swarmRoot: "/opt/agent-swarm", cwd: "/repo", env: { ULTRATHINK_HOST: "omp" } }, (cmd, args, opts) => {
			seen.push({ cmd, args, opts });
			return { stdout: JSON.stringify({ tasks: [] }) };
		});
		expect(runner("/lane/dir")).toEqual({ stdout: JSON.stringify({ tasks: [] }) });
		expect(seen[0]!.cmd).toBe("python3");
		expect(seen[0]!.args).toEqual([join("/opt/agent-swarm", "scripts", "orch_status.py"), "--json", "--repo", "/repo"]);
		expect(seen[0]!.opts.env.SWARM_DIR).toBe("/lane/dir");
		expect(seen[0]!.opts.env.ULTRATHINK_HOST).toBe("omp");
		expect(seen[0]!.opts.timeout).toBe(ORCH_STATUS_TIMEOUT_MS);
	});

	test("missing stdout is an error carrying the failure detail", () => {
		const stderrProbe = orchStatusRunner({ swarmRoot: "/opt/agent-swarm", cwd: "/repo" }, () => ({
			stdout: "",
			stderr: "traceback (line 1)\n    boom",
		}));
		const stderrResult = stderrProbe("/lane/dir");
		expect("error" in stderrResult && stderrResult.error).toContain("boom");
		const errorProbe = orchStatusRunner({ swarmRoot: "/opt/agent-swarm", cwd: "/repo" }, () => ({
			error: new Error("spawn python3 ENOENT"),
		}));
		const errorResult = errorProbe("/lane/dir");
		expect("error" in errorResult && errorResult.error).toContain("ENOENT");
	});
});

describe("laneDirs", () => {
	test("discovers spawned lanes by their state directories and ignores strangers", () => {
		const stateDir = mkdtempSync(join(tmpdir(), "teams-dirs-"));
		mkdirSync(join(stateDir, "swarm", "abcd1234-1"), { recursive: true });
		mkdirSync(join(stateDir, "swarm", "ef567890-2"), { recursive: true });
		mkdirSync(join(stateDir, "swarm", "not-a-lane"), { recursive: true });
		writeFileSync(join(stateDir, "swarm", "stray.txt"), "x");
		const lanes = laneDirs(stateDir, realFs);
		expect(lanes.map((entry) => entry.laneId)).toEqual(["lane-1", "lane-2"]);
		expect(lanes[0]!.stateDir).toBe(join(stateDir, "swarm", "abcd1234-1"));
		// A state directory without swarm lanes discovers nothing.
		expect(laneDirs(join(stateDir, "empty"), realFs)).toEqual([]);
		rmSync(stateDir, { recursive: true, force: true });
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

	test("formatLaneStatusText joins summaries and names errors", () => {
		const rows: LaneStatusRow[] = [
			{ laneId: "lane-1", total: 2, byState: { DONE: 2 }, done: 2, summary: "lane-1: 2 tasks — 2 DONE · 2 done" },
			{ laneId: "lane-2", error: "timed out" },
		];
		const text = formatLaneStatusText(rows);
		expect(text).toContain("lane-1: 2 tasks — 2 DONE · 2 done");
		expect(text).toContain("lane-2: timed out");
		expect(formatLaneStatusText([])).toContain("No swarm lanes");
	});

	test("TEAMS_USAGE documents the command surface", () => {
		expect(TEAMS_USAGE).toContain("/ultrathink-swarm");
		expect(TEAMS_USAGE).toContain("ULTRATHINK_SWARM_ROOT");
		expect(TEAMS_USAGE).toContain("ULTRATHINK_SWARM_MAX_LANES");
		expect(TEAMS_USAGE).toContain("status");
	});
});
