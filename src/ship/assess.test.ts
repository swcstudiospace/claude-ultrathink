// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionRecord } from "../claude/state.ts";
import { assessDone } from "./assess.ts";
import { collectSignals, gatherDiff, gsdToolsCandidates, resolveGsdTools } from "./signals.ts";
import type { Run, ShipSignals } from "./types.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "ship-assess-"));
	dirs.push(dir);
	return dir;
}

function fakeRun(table: Record<string, string | undefined>): Run {
	return (argv) => {
		const out = table[argv.join(" ")];
		return out === undefined ? { exitCode: 1, stdout: "", stderr: "no" } : { exitCode: 0, stdout: out, stderr: "" };
	};
}

const RECORD: SessionRecord = {
	sessionId: "s1",
	at: 0,
	result: { xml: "<spec/>", original: "add ship", root: "", source: "llm" },
	graph: {
		goal: "ship it",
		nodes: [
			{ id: "n1", title: "U", kind: "understand", question: "q", dependsOn: [] },
			{
				id: "n2",
				title: "S",
				kind: "synthesize",
				question: "q",
				dependsOn: ["n1"],
				conclusion: "WORKFLOW\n- Wave 1: a\n- Wave 2: b\nnotes",
			},
		],
	},
};

const GIT: Record<string, string> = {
	"git rev-parse --abbrev-ref HEAD": "feat/x\n",
	"gh repo view --json defaultBranchRef -q .defaultBranchRef.name": "master\n",
	"git fetch --quiet origin master": "",
	"git rev-list --count origin/master..HEAD": "3\n",
	"git status --porcelain": " M src/a.ts\n?? tmp.txt\nA  src/b.ts\n",
	"git remote get-url origin": "https://github.com/acme/widget.git\n",
	"git rev-parse @{u}": "abc\n",
	"git rev-parse HEAD": "abc\n",
};

describe("collectSignals", () => {
	test("parses git state and https remote; no GSD without ROADMAP", () => {
		const s = collectSignals({ cwd: tempDir(), record: RECORD, run: fakeRun(GIT), gsdTools: "g.cjs" });
		expect(s.git).toEqual({
			branch: "feat/x",
			base: "master",
			onBase: false,
			ahead: 3,
			dirty: ["src/a.ts", "src/b.ts"],
			untracked: 1,
			repo: "acme/widget",
			pushed: true,
		});
		expect(s.gsd).toBeUndefined();
		expect(s.graph).toEqual({ nodes: 2, workflowUnits: 2 });
	});

	test("ssh remote, origin/HEAD fallback, unpushed", () => {
		const table: Record<string, string | undefined> = {
			...GIT,
			"git remote get-url origin": "git@github.com:acme/tool.git",
			"git rev-parse @{u}": undefined,
		};
		table["gh repo view --json defaultBranchRef -q .defaultBranchRef.name"] = undefined;
		table["git symbolic-ref --short refs/remotes/origin/HEAD"] = "origin/main";
		table["git rev-list --count origin/main..HEAD"] = "0";
		const s = collectSignals({ cwd: tempDir(), record: { ...RECORD, graph: undefined }, run: fakeRun(table) });
		expect(s.git.repo).toBe("acme/tool");
		expect(s.git.base).toBe("main");
		expect(s.git.ahead).toBe(0);
		expect(s.git.pushed).toBe(false);
		expect(s.graph).toBeUndefined();
	});

	test("GSD roadmap and newest verification frontmatter", () => {
		const cwd = tempDir();
		mkdirSync(join(cwd, ".planning", "phases", "01-a"), { recursive: true });
		mkdirSync(join(cwd, ".planning", "phases", "02-b"), { recursive: true });
		writeFileSync(join(cwd, ".planning", "ROADMAP.md"), "# r");
		writeFileSync(join(cwd, ".planning", "STATE.md"), "---\nstatus: 'executing'\n---\n");
		writeFileSync(join(cwd, ".planning", "phases", "01-a", "01-VERIFICATION.md"), "---\nstatus: passed\n---\n");
		writeFileSync(join(cwd, ".planning", "phases", "02-b", "02-VERIFICATION.md"), '---\nphase: 2\nstatus: "gaps_found"\n---\nbody');
		const run = fakeRun({
			...GIT,
			"git ls-files --error-unmatch .planning/ROADMAP.md": ".planning/ROADMAP.md",
			[`node g.cjs query roadmap.analyze --cwd ${cwd}`]: JSON.stringify({ phase_count: 3, completed_phases: 2 }),
		});
		const s = collectSignals({ cwd, record: RECORD, run, gsdTools: "g.cjs" });
		expect(s.gsd).toEqual({
			phaseCount: 3,
			completedPhases: 2,
			trusted: true,
			state: "executing",
			verification: { phase: "02-b", status: "gaps_found" },
		});
	});

	test("untracked .planning is untrusted; tool failure fails open to 0/0", () => {
		const cwd = tempDir();
		mkdirSync(join(cwd, ".planning"), { recursive: true });
		writeFileSync(join(cwd, ".planning", "ROADMAP.md"), "# r");
		expect(collectSignals({ cwd, record: RECORD, run: fakeRun(GIT), gsdTools: "g.cjs" }).gsd).toEqual({
			phaseCount: 0,
			completedPhases: 0,
			trusted: false,
			state: undefined,
			verification: undefined,
		});
		const ignored = fakeRun({ ...GIT, "git check-ignore -q .planning": "" });
		expect(collectSignals({ cwd, record: RECORD, run: ignored, gsdTools: "g.cjs" }).gsd?.trusted).toBe(true);
	});

	test("a roadmap with gsd-tools.cjs installed nowhere is flagged tools-missing without running node", () => {
		const cwd = tempDir();
		mkdirSync(join(cwd, ".planning"), { recursive: true });
		writeFileSync(join(cwd, ".planning", "ROADMAP.md"), "# r");
		const argvs: string[][] = [];
		const base = fakeRun({ ...GIT, "git ls-files --error-unmatch .planning/ROADMAP.md": ".planning/ROADMAP.md" });
		const run: Run = (argv, opts) => (argvs.push(argv), base(argv, opts));
		const s = collectSignals({ cwd, record: RECORD, run, env: {}, home: tempDir() });
		expect(s.gsd).toMatchObject({ phaseCount: 0, completedPhases: 0, trusted: true, toolsMissing: true });
		expect(argvs.some((argv) => argv[0] === "node")).toBe(false);
	});

	test("a gsd-tools.cjs installed under home is found and run", () => {
		const cwd = tempDir();
		const home = tempDir();
		mkdirSync(join(cwd, ".planning"), { recursive: true });
		writeFileSync(join(cwd, ".planning", "ROADMAP.md"), "# r");
		const tool = join(home, ".agents", "gsd-core", "bin", "gsd-tools.cjs");
		mkdirSync(join(home, ".agents", "gsd-core", "bin"), { recursive: true });
		writeFileSync(tool, "");
		const run = fakeRun({ ...GIT, [`node ${tool} query roadmap.analyze --cwd ${cwd}`]: JSON.stringify({ phase_count: 2, completed_phases: 2 }) });
		const s = collectSignals({ cwd, record: RECORD, run, env: {}, home });
		expect(s.gsd).toMatchObject({ phaseCount: 2, completedPhases: 2 });
		expect(s.gsd?.toolsMissing).toBeUndefined();
	});

	test("node that cannot be spawned is flagged node-missing; any other run failure still fails open to 0/0", () => {
		const cwd = tempDir();
		mkdirSync(join(cwd, ".planning"), { recursive: true });
		writeFileSync(join(cwd, ".planning", "ROADMAP.md"), "# r");
		const withNode = (reply: { exitCode: number; stderr: string }): Run => {
			const git = fakeRun(GIT);
			return (argv, opts) => (argv[0] === "node" ? { stdout: "", ...reply } : git(argv, opts));
		};
		for (const reply of [{ exitCode: 127, stderr: "" }, { exitCode: 1, stderr: "Executable not found in $PATH: \"node\" (ENOENT)" }]) {
			const s = collectSignals({ cwd, record: RECORD, run: withNode(reply), gsdTools: "g.cjs" });
			expect(s.gsd).toMatchObject({ phaseCount: 0, completedPhases: 0, nodeMissing: true });
		}
		const crashed = collectSignals({ cwd, record: RECORD, run: withNode({ exitCode: 1, stderr: "TypeError: boom" }), gsdTools: "g.cjs" });
		expect(crashed.gsd).toMatchObject({ phaseCount: 0, completedPhases: 0 });
		expect(crashed.gsd?.nodeMissing).toBeUndefined();
		expect(crashed.gsd?.toolsMissing).toBeUndefined();
	});
});

describe("resolveGsdTools", () => {
	const cwd = "/work/app";
	const home = "/home/u";

	test("GSD_TOOLS wins even over an installed copy", () => {
		expect(resolveGsdTools({ cwd, home, env: { GSD_TOOLS: "/opt/gsd.cjs" }, exists: () => true })).toBe("/opt/gsd.cjs");
	});

	test("the first existing location wins: project-local before host config dirs", () => {
		const installed = new Set([
			"/work/app/.codex/gsd-core/bin/gsd-tools.cjs",
			"/home/u/.claude/gsd-core/bin/gsd-tools.cjs",
			"/home/u/.agents/gsd-core/bin/gsd-tools.cjs",
		]);
		expect(resolveGsdTools({ cwd, home, env: {}, exists: (p) => installed.has(p) })).toBe(
			"/work/app/.codex/gsd-core/bin/gsd-tools.cjs",
		);
		installed.delete("/work/app/.codex/gsd-core/bin/gsd-tools.cjs");
		expect(resolveGsdTools({ cwd, home, env: {}, exists: (p) => installed.has(p) })).toBe(
			"/home/u/.claude/gsd-core/bin/gsd-tools.cjs",
		);
	});

	test("host config dir overrides replace their home defaults", () => {
		const env = {
			CLAUDE_CONFIG_DIR: "/cfg/claude",
			HERMES_HOME: "/cfg/hermes",
			CODEX_HOME: "/cfg/codex",
			GEMINI_CONFIG_DIR: "/cfg/gemini",
			XDG_CONFIG_HOME: "/cfg/xdg",
		};
		expect(gsdToolsCandidates(cwd, env, home)).toEqual([
			"/work/app/gsd-core/bin/gsd-tools.cjs",
			"/work/app/.claude/gsd-core/bin/gsd-tools.cjs",
			"/work/app/.codex/gsd-core/bin/gsd-tools.cjs",
			"/work/app/.claude/get-shit-done/bin/gsd-tools.cjs",
			"/cfg/claude/gsd-core/bin/gsd-tools.cjs",
			"/home/u/.claude/gsd-core/bin/gsd-tools.cjs",
			"/home/u/.agents/gsd-core/bin/gsd-tools.cjs",
			"/cfg/hermes/gsd-core/bin/gsd-tools.cjs",
			"/cfg/codex/gsd-core/bin/gsd-tools.cjs",
			"/cfg/gemini/gsd-core/bin/gsd-tools.cjs",
			"/home/u/.cursor/gsd-core/bin/gsd-tools.cjs",
			"/cfg/xdg/opencode/gsd-core/bin/gsd-tools.cjs",
			"/home/u/.claude/get-shit-done/bin/gsd-tools.cjs",
		]);
	});

	test("the legacy get-shit-done install resolves project-local before home, home last; nothing installed is undefined", () => {
		const projectLegacy = "/work/app/.claude/get-shit-done/bin/gsd-tools.cjs";
		const homeLegacy = "/home/u/.claude/get-shit-done/bin/gsd-tools.cjs";
		expect(resolveGsdTools({ cwd, home, env: {}, exists: (p) => p === projectLegacy })).toBe(projectLegacy);
		const bothLegacy = new Set([projectLegacy, homeLegacy, "/home/u/.claude/gsd-core/bin/gsd-tools.cjs"]);
		expect(resolveGsdTools({ cwd, home, env: {}, exists: (p) => bothLegacy.has(p) })).toBe(projectLegacy);
		expect(resolveGsdTools({ cwd, home, env: {}, exists: (p) => p === homeLegacy })).toBe(homeLegacy);
		expect(resolveGsdTools({ cwd, home, env: {}, exists: () => false })).toBeUndefined();
	});
});

test("gatherDiff caps output at 8000 chars", () => {
	const big = "x".repeat(20_000);
	const d = gatherDiff({
		cwd: "/",
		base: "master",
		run: fakeRun({ "git diff --stat origin/master...HEAD": big, "git log --oneline origin/master..HEAD": "abc feat" }),
	});
	expect(d.stat.length).toBeLessThan(8100);
	expect(d.stat.startsWith("x".repeat(8000))).toBe(true);
	expect(d.log).toBe("abc feat");
});

function signals(git: Partial<ShipSignals["git"]> = {}, gsd?: ShipSignals["gsd"]): ShipSignals {
	return {
		git: { branch: "feat", base: "master", onBase: false, ahead: 2, dirty: [], untracked: 0, pushed: true, ...git },
		gsd,
	};
}
const DIFF = { stat: "1 file", log: "abc x" };

describe("assessDone rules", () => {
	const cases: [string, ShipSignals, string][] = [
		["on base", signals({ onBase: true, branch: "master" }), "working on the default branch"],
		["nothing ahead", signals({ ahead: 0 }), "nothing to ship: no commits ahead of master"],
		["dirty", signals({ dirty: ["a.ts"] }), "uncommitted tracked changes: a.ts; commit"],
		[
			"dirty planning",
			signals({ dirty: [".planning/STATE.md"] }),
			"uncommitted tracked changes: .planning/STATE.md; uncommitted .planning/ changes (another session",
		],
		[
			"stray planning",
			signals({}, { phaseCount: 1, completedPhases: 1, trusted: false }),
			".planning/ is neither tracked nor ignored",
		],
		[
			"gsd incomplete",
			signals({}, { phaseCount: 3, completedPhases: 1, trusted: true }),
			"GSD roadmap incomplete: 1/3 phases",
		],
		[
			"gsd tools missing",
			signals({}, { phaseCount: 0, completedPhases: 0, trusted: true, toolsMissing: true }),
			"GSD roadmap found but gsd-tools.cjs was not found; set GSD_TOOLS or rerun assess with --ignore-gsd",
		],
		[
			"node missing",
			signals({}, { phaseCount: 0, completedPhases: 0, trusted: true, nodeMissing: true }),
			"GSD roadmap found but node is not on PATH, so gsd-tools.cjs could not run; install Node.js or rerun assess with --ignore-gsd",
		],
		[
			"verification",
			signals({}, { phaseCount: 1, completedPhases: 1, trusted: true, verification: { phase: "01", status: "human_needed" } }),
			"latest GSD verification is human_needed",
		],
	];
	for (const [name, sig, gap] of cases) {
		test(name, async () => {
			let called = false;
			const a = await assessDone({
				record: RECORD,
				signals: sig,
				diff: DIFF,
				complete: async () => {
					called = true;
					return "";
				},
			});
			expect(a.done).toBe(false);
			expect(a.source).toBe("rules");
			expect(a.gaps.some((g) => g.startsWith(gap))).toBe(true);
			expect(called).toBe(false);
		});
	}

	test("rules pass without judge -> done at 0.5", async () => {
		const a = await assessDone({ record: RECORD, signals: signals(), diff: DIFF, now: () => 7 });
		expect(a).toMatchObject({ done: true, confidence: 0.5, source: "rules", at: 7 });
	});
});

describe("assessDone judge", () => {
	test("JSON wrapped in prose", async () => {
		const a = await assessDone({
			record: RECORD,
			signals: signals(),
			diff: DIFF,
			complete: async () => 'Sure: {"done": true, "confidence": 0.9, "summary": "all {good}", "gaps": []} thanks',
		});
		expect(a).toMatchObject({ done: true, confidence: 0.9, summary: "all {good}", source: "llm" });
	});

	test("low confidence -> not done", async () => {
		const a = await assessDone({
			record: RECORD,
			signals: signals(),
			diff: DIFF,
			complete: async () => '{"done": true, "confidence": 0.6, "summary": "maybe", "gaps": []}',
		});
		expect(a.done).toBe(false);
		expect(a.source).toBe("llm");
	});

	test("judge throws -> not done with gap", async () => {
		const a = await assessDone({
			record: RECORD,
			signals: signals(),
			diff: DIFF,
			complete: async () => {
				throw new Error("offline");
			},
		});
		expect(a).toMatchObject({ done: false, source: "llm", gaps: ["assessment unavailable: offline"] });
	});

	test("unparsable reply -> not done", async () => {
		const a = await assessDone({ record: RECORD, signals: signals(), diff: DIFF, complete: async () => "yes!" });
		expect(a.done).toBe(false);
		expect(a.gaps[0]).toStartWith("assessment unavailable:");
	});
});
