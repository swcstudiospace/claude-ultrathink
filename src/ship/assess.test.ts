// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ClaudeCompleter } from "../claude/complete.ts";
import type { SessionRecord } from "../claude/state.ts";
import { createDecisions } from "../decisions/gate.ts";
import type { Decisions } from "../decisions/gate.ts";
import { QUESTIONS } from "../decisions/questions.ts";
import { DEFAULT_DECISIONS_CONFIG, DecisionsError } from "../decisions/types.ts";
import type { DecisionsConfig, DecisionsErrorKind } from "../decisions/types.ts";
import { assessDecisionJson, assessDone } from "./assess.ts";
import { collectSignals, gatherDiff, gsdToolsCandidates, resolveGsdTools } from "./signals.ts";
import type { ShipDiff } from "./signals.ts";
import type { Assessment, JudgeMode, Run, ShipSignals } from "./types.ts";

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

	/** A trusted repo with a roadmap, and archived milestones as `{ "<version>": { "<phase dir>": status | undefined } }`. */
	function archivedRepo(milestones: Record<string, Record<string, string | undefined>>): string {
		const cwd = tempDir();
		mkdirSync(join(cwd, ".planning", "phases"), { recursive: true });
		writeFileSync(join(cwd, ".planning", "ROADMAP.md"), "# r");
		for (const [version, phases] of Object.entries(milestones)) {
			for (const [phase, status] of Object.entries(phases)) {
				const phaseDir = join(cwd, ".planning", "milestones", `${version}-phases`, phase);
				mkdirSync(phaseDir, { recursive: true });
				if (status) writeFileSync(join(phaseDir, `${phase.slice(0, 2)}-VERIFICATION.md`), `---\nstatus: ${status}\n---\n`);
			}
		}
		return cwd;
	}
	const trustedRun = (cwd: string) =>
		fakeRun({
			...GIT,
			"git ls-files --error-unmatch .planning/ROADMAP.md": ".planning/ROADMAP.md",
			[`node g.cjs query roadmap.analyze --cwd ${cwd}`]: JSON.stringify({ phase_count: 0, completed_phases: 0 }),
		});

	test("with no active verification the archived milestone's phase verifications and audit are collected", () => {
		const cwd = archivedRepo({ "v2.0": { "02-b": "gaps_found", "01-a": "passed", "03-c": undefined } });
		writeFileSync(
			join(cwd, ".planning", "milestones", "v2.0-MILESTONE-AUDIT.md"),
			"---\nmilestone: v2.0\nstatus: tech_debt\nscores:\n  requirements: 12/12\n  phases: \"2/3\"\n  nyquist: '0.9'\ngaps: []\n---\n# Audit\n",
		);
		// 03-c has no verification file: it is reported as "missing", never dropped.
		const milestone = {
			version: "v2.0",
			verifications: [
				{ phase: "01-a", status: "passed" },
				{ phase: "02-b", status: "gaps_found" },
				{ phase: "03-c", status: "missing" },
			],
			audit: { status: "tech_debt", scores: { requirements: "12/12", phases: "2/3", nyquist: "0.9" } },
		};
		expect(collectSignals({ cwd, record: RECORD, run: trustedRun(cwd), gsdTools: "g.cjs" }).gsd?.milestone).toEqual(milestone);
		// The tools-missing early return carries it too.
		const missing = collectSignals({ cwd, record: RECORD, run: trustedRun(cwd), env: {}, home: tempDir() }).gsd;
		expect(missing).toMatchObject({ toolsMissing: true, milestone });
	});

	test("the highest archived version wins by numeric compare (v1.10 over v1.9); no audit file means no audit", () => {
		const cwd = archivedRepo({ "v1.9": { "01-a": "passed" }, "v1.10": { "01-x": "human_needed" }, "v1.2.3": { "01-z": "passed" } });
		mkdirSync(join(cwd, ".planning", "milestones", "v9-notes"), { recursive: true });
		expect(collectSignals({ cwd, record: RECORD, run: trustedRun(cwd), gsdTools: "g.cjs" }).gsd?.milestone).toEqual({
			version: "v1.10",
			verifications: [{ phase: "01-x", status: "human_needed" }],
		});
	});

	test("no milestones dir fails open: no milestone key", () => {
		const cwd = archivedRepo({});
		const gsd = collectSignals({ cwd, record: RECORD, run: trustedRun(cwd), gsdTools: "g.cjs" }).gsd;
		expect(gsd).toMatchObject({ phaseCount: 0, trusted: true });
		expect(gsd && "milestone" in gsd).toBe(false);
	});

	test("an active phase verification takes precedence: the archived milestone is not collected", () => {
		const cwd = archivedRepo({ "v1.0": { "01-a": "passed" } });
		mkdirSync(join(cwd, ".planning", "phases", "04-d"), { recursive: true });
		writeFileSync(join(cwd, ".planning", "phases", "04-d", "04-VERIFICATION.md"), "---\nstatus: gaps_found\n---\n");
		const gsd = collectSignals({ cwd, record: RECORD, run: trustedRun(cwd), gsdTools: "g.cjs" }).gsd;
		expect(gsd?.verification).toEqual({ phase: "04-d", status: "gaps_found" });
		expect(gsd && "milestone" in gsd).toBe(false);
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

test("gatherDiff flags patchTruncated only when it cut the patch at 24,000 chars", () => {
	const patchCommand =
		"git diff origin/master...HEAD -- . :(exclude)*.lock :(exclude)*.lockb :(exclude)package-lock.json :(exclude)pnpm-lock.yaml";
	const exact = gatherDiff({ cwd: "/", base: "master", run: fakeRun({ [patchCommand]: "p".repeat(24_000) }) });
	expect(exact.patch).toBe("p".repeat(24_000));
	expect("patchTruncated" in exact).toBe(false);
	const over = gatherDiff({ cwd: "/", base: "master", run: fakeRun({ [patchCommand]: "p".repeat(24_001) }) });
	expect(over.patchTruncated).toBe(true);
	expect(over.patch).toBe(`${"p".repeat(24_000)}\n…[truncated]`);
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

describe("assessDone modes", () => {
	const judge = (reply: object) => async () => JSON.stringify(reply);
	const MILESTONE_GSD: ShipSignals["gsd"] = {
		phaseCount: 0,
		completedPhases: 0,
		trusted: true,
		milestone: {
			version: "v2.0",
			verifications: [
				{ phase: "01-core", status: "passed" },
				{ phase: "02-ui", status: "gaps_found" },
			],
		},
	};

	test("gate: done judge below 0.7 -> still not done", async () => {
		const a = await assessDone({
			record: RECORD,
			signals: signals(),
			diff: DIFF,
			mode: "gate",
			complete: judge({ done: true, confidence: 0.6, summary: "maybe", gaps: [] }),
		});
		expect(a).toMatchObject({ done: false, mode: "gate", source: "llm" });
		expect(a.judge).toBeUndefined();
	});

	test("advisory: done judge below 0.7 -> done, verdict recorded", async () => {
		const a = await assessDone({
			record: RECORD,
			signals: signals(),
			diff: DIFF,
			mode: "advisory",
			complete: judge({ done: true, confidence: 0.6, summary: "maybe", gaps: [] }),
		});
		expect(a).toMatchObject({ done: true, confidence: 0.6, summary: "maybe", gaps: [], mode: "advisory", source: "llm" });
		expect(a.judge).toEqual({ done: true, confidence: 0.6, summary: "maybe", gaps: [] });
	});

	test("advisory: judge says not done -> done, judge gaps kept out of gaps", async () => {
		const a = await assessDone({
			record: RECORD,
			signals: signals(),
			diff: DIFF,
			mode: "advisory",
			complete: judge({ done: false, confidence: 0.9, summary: "missing docs", gaps: ["docs", "tests"] }),
		});
		expect(a).toMatchObject({ done: true, gaps: [], mode: "advisory" });
		expect(a.judge).toMatchObject({ done: false, gaps: ["docs", "tests"] });
	});

	test("advisory: judge throws -> done with judge error", async () => {
		const a = await assessDone({
			record: RECORD,
			signals: signals(),
			diff: DIFF,
			mode: "advisory",
			complete: async () => {
				throw new Error("offline");
			},
		});
		expect(a).toMatchObject({ done: true, confidence: 0, gaps: [], mode: "advisory" });
		expect(a.judge).toEqual({ done: false, confidence: 0, summary: "", gaps: [], error: "offline" });
	});

	test("advisory: unparsable reply -> done with judge error", async () => {
		const a = await assessDone({ record: RECORD, signals: signals(), diff: DIFF, mode: "advisory", complete: async () => "yes!" });
		expect(a).toMatchObject({ done: true, gaps: [], mode: "advisory" });
		expect(a.judge?.error).toBeDefined();
	});

	test("advisory without judge -> done at 0.5 from rules", async () => {
		const a = await assessDone({ record: RECORD, signals: signals(), diff: DIFF, mode: "advisory" });
		expect(a).toMatchObject({ done: true, confidence: 0.5, gaps: [], source: "rules", mode: "advisory" });
		expect(a.judge?.error).toBeDefined();
	});

	test("advisory: rule gap still blocks without calling the judge", async () => {
		let called = false;
		const a = await assessDone({
			record: RECORD,
			signals: signals({ onBase: true, branch: "master" }),
			diff: DIFF,
			mode: "advisory",
			complete: async () => {
				called = true;
				return JSON.stringify({ done: true, confidence: 1, summary: "", gaps: [] });
			},
		});
		expect(a).toMatchObject({ done: false, source: "rules", mode: "advisory" });
		expect(called).toBe(false);
	});

	for (const mode of ["gate", "advisory"] as const) {
		test(`${mode}: archived milestone with a non-passed verification is a rule gap`, async () => {
			const a = await assessDone({
				record: RECORD,
				signals: signals({}, MILESTONE_GSD),
				diff: DIFF,
				mode,
				complete: judge({ done: true, confidence: 1, summary: "", gaps: [] }),
			});
			expect(a).toMatchObject({ done: false, source: "rules" });
			expect(a.gaps).toEqual(["archived milestone v2.0: 02-ui verification is gaps_found"]);
		});
	}

	test("archived milestone with no phase verifications is a rule gap", async () => {
		const a = await assessDone({
			record: RECORD,
			signals: signals({}, { ...MILESTONE_GSD, milestone: { version: "v2.0", verifications: [] } } as ShipSignals["gsd"]),
			diff: DIFF,
			mode: "advisory",
			complete: judge({ done: true, confidence: 1, summary: "", gaps: [] }),
		});
		expect(a).toMatchObject({ done: false, source: "rules" });
		expect(a.gaps).toEqual(["archived milestone v2.0 has no phase verifications"]);
	});

	test("all-passed archived milestone is no gap; judge prompt carries the milestone line", async () => {
		let prompt = "";
		const gsd: ShipSignals["gsd"] = {
			phaseCount: 0,
			completedPhases: 0,
			trusted: true,
			milestone: {
				version: "v2.0",
				verifications: [
					{ phase: "01-core", status: "passed" },
					{ phase: "02-ui", status: "passed" },
				],
				audit: { status: "passed", scores: { requirements: "12/12", integration: "5/5" } },
			},
		};
		const a = await assessDone({
			record: RECORD,
			signals: signals({}, gsd),
			diff: DIFF,
			complete: async (_system, user) => {
				prompt = user;
				return JSON.stringify({ done: true, confidence: 0.9, summary: "ok", gaps: [] });
			},
		});
		expect(a.done).toBe(true);
		expect(prompt).toContain(
			"latest milestone: v2.0 archived: 2/2 phase verifications passed; audit passed (requirements 12/12, integration 5/5)",
		);
	});
});

// Jev ship decision point (DP-SHIP). Canonical Decisions fixtures, defined per test file.
const K = "sk-or-v1-UTTESTKEY-0123456789abcdef";
const ENDPOINT = "https://openrouter.ai/api/alpha/decisions";
interface Recorded {
	url: string;
	method: string;
	headers: Record<string, string>;
	body: unknown;
}

function toRecorded(input: string | URL | Request, init?: RequestInit): Recorded {
	const headers: Record<string, string> = {};
	new Headers(init?.headers).forEach((value, key) => {
		headers[key] = value;
	});
	const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : init?.body;
	return { url: String(input), method: init?.method ?? "GET", headers, body };
}

/** Recording fetch R: records every call, answers from a queue (last entry repeats). Installed as globalThis.fetch too. */
function recordingFetch(queue: Array<() => Response | Promise<Response>>): { fetch: typeof fetch; calls: Recorded[] } {
	const calls: Recorded[] = [];
	const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
		calls.push(toRecorded(input, init));
		const next = queue[Math.min(calls.length, queue.length) - 1];
		if (!next) throw new Error("empty queue");
		return next();
	}) as typeof fetch;
	globalThis.fetch = fetchImpl;
	return { fetch: fetchImpl, calls };
}

const JEV =
	(p: number, key = "plan_worthy") =>
	() =>
		Response.json({
			id: "gen-dec-test",
			model: "typesafe/jev-1.13-20260917",
			provider: "TypeSafe",
			answers: { [key]: { type: "noul", noul: p } },
			usage: { input_tokens: 450, output_tokens: 0, cost: 0.000019 },
		});
const ERR = (s: number, headers?: Record<string, string>) => () =>
	Response.json({ error: { code: s, message: `upstream said no for ${K}` } }, { status: s, headers });

/** Never resolves; rejects with an AbortError when its signal fires (as src/grok/complete.test.ts hangingFetch). */
function hangingFetch(onCall?: () => void): typeof fetch {
	return ((_input: string | URL | Request, init?: RequestInit) =>
		new Promise<Response>((_resolve, reject) => {
			init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
			onCall?.();
		})) as typeof fetch;
}

/** Holds every response until `release()`; for "N requests before any response". Installed as globalThis.fetch too. */
function heldFetch(respond: (call: Recorded) => Response): { fetch: typeof fetch; calls: Recorded[]; release(): void } {
	const calls: Recorded[] = [];
	const waiting: Array<() => void> = [];
	let released = false;
	const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
		const call = toRecorded(input, init);
		calls.push(call);
		return new Promise<Response>((resolve) => {
			const answer = () => resolve(respond(call));
			if (released) answer();
			else waiting.push(answer);
		});
	}) as typeof fetch;
	globalThis.fetch = fetchImpl;
	return {
		fetch: fetchImpl,
		calls,
		release() {
			released = true;
			for (const answer of waiting.splice(0)) answer();
		},
	};
}

const COMPLETE = "complete";
const MODEL = "typesafe/jev-1.13-20260917";
const ON: DecisionsConfig = { ...DEFAULT_DECISIONS_CONFIG, enabled: true, points: [...DEFAULT_DECISIONS_CONFIG.points] };
const realFetch = globalThis.fetch;

function decisionsDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "ut-decisions-ship-"));
	dirs.push(dir);
	return dir;
}

/** The Jev runtime: ON (overridable), K in the injected env only, an empty temp store, no real waits, debug lines kept. */
function jevRuntime(fetchImpl: typeof fetch, config: Partial<DecisionsConfig> = {}): { decisions: Decisions; lines: string[] } {
	const lines: string[] = [];
	const decisions = createDecisions({
		config: { ...ON, ...config },
		sessionId: RECORD.sessionId,
		env: { OPENROUTER_API_KEY: K },
		storePath: join(decisionsDir(), "mcp-credentials.json"),
		fetch: fetchImpl,
		sleep: async () => {},
		random: () => 0.5,
		debug: (line) => lines.push(line),
	});
	return { decisions, lines };
}

/** T6: the key and a bearer header never reach a collected output. */
function expectNoKey(...outputs: unknown[]): void {
	for (const output of outputs) {
		const text = typeof output === "string" ? output : JSON.stringify(output);
		expect(text).not.toContain(K);
		expect(text).not.toContain("Bearer sk-or-");
	}
}

/** The assessment without its Jev addition, for BASELINE comparisons. */
function withoutDecision(assessment: Assessment): Assessment {
	const { decision: _decision, ...rest } = assessment;
	return rest;
}

const reply =
	(verdict: object): ClaudeCompleter =>
	async () =>
		JSON.stringify(verdict);
const DONE_09 = reply({ done: true, confidence: 0.9, summary: "ok", gaps: [] });
const PATCH = "diff --git a/src/flag.ts b/src/flag.ts\n--- a/src/flag.ts\n+++ b/src/flag.ts\n@@ -1 +1,2 @@\n+export const verbose = true;\n";
const FULL_DIFF: ShipDiff = { stat: "1 file", log: "abc x", patch: PATCH };
const vetoGap = (p: string) => `Jev judged the change incomplete (P(complete) ${p})`;
const now = () => 7;

/** Every failure of AC-4.1–4.9, as a fresh fetch per run. */
const FAILURES: { name: string; kind: DecisionsErrorKind; fetch: () => typeof fetch; timeoutMs?: number }[] = [
	{ name: "401", kind: "auth", fetch: () => recordingFetch([ERR(401)]).fetch },
	{ name: "402", kind: "credits", fetch: () => recordingFetch([ERR(402)]).fetch },
	{ name: "400", kind: "bad-request", fetch: () => recordingFetch([ERR(400)]).fetch },
	{ name: "429 twice", kind: "rate-limit", fetch: () => recordingFetch([ERR(429)]).fetch },
	...[500, 502, 503, 524, 529].map((status) => ({
		name: `${status} twice`,
		kind: "upstream" as const,
		fetch: () => recordingFetch([ERR(status)]).fetch,
	})),
	{ name: "a hanging request", kind: "timeout", fetch: () => hangingFetch(), timeoutMs: 50 },
	{ name: "a body that is not JSON", kind: "invalid-response", fetch: () => recordingFetch([() => new Response("{not json")]).fetch },
	{
		name: "a missing answer key",
		kind: "invalid-response",
		fetch: () =>
			recordingFetch([
				() => Response.json({ model: MODEL, answers: {}, usage: { input_tokens: 450, output_tokens: 0, cost: 0.000019 } }),
			]).fetch,
	},
	{ name: "a noul out of range", kind: "invalid-response", fetch: () => recordingFetch([JEV(1.5, COMPLETE)]).fetch },
];

describe("assessDone with Jev (DP-SHIP)", () => {
	afterEach(() => {
		globalThis.fetch = realFetch;
	});
	const clean = signals();

	test("a fresh install makes zero requests without a key, and consults Jev with one (AC-1.3, JEV-01)", async () => {
		const r = recordingFetch([JEV(0.03, COMPLETE)]);
		const decisions = createDecisions({
			config: { ...DEFAULT_DECISIONS_CONFIG, points: [...DEFAULT_DECISIONS_CONFIG.points] },
			sessionId: RECORD.sessionId,
			env: {},
			storePath: join(decisionsDir(), "mcp-credentials.json"),
			fetch: r.fetch,
		});
		const runs: { mode: JudgeMode; complete?: ClaudeCompleter; expected: Partial<Assessment> }[] = [
			{ mode: "gate", complete: DONE_09, expected: { done: true, source: "llm" } },
			{ mode: "gate", expected: { done: true, confidence: 0.5, source: "rules" } },
			{ mode: "advisory", complete: DONE_09, expected: { done: true, source: "llm", mode: "advisory" } },
		];
		for (const { mode, complete, expected } of runs) {
			const input = { record: RECORD, signals: clean, diff: FULL_DIFF, complete, now, mode };
			const fresh = await assessDone({ ...input, decisions });
			expect(fresh).toEqual(await assessDone(input));
			expect(fresh).toMatchObject(expected);
			expect("decision" in fresh).toBe(false);
		}
		expect(r.calls).toHaveLength(0);

		// With a key, the same default config consults Jev.
		const store = join(decisionsDir(), "mcp-credentials.json");
		const credential = { openrouter: { kind: "api_key", apiKey: K, updatedAt: 1 } };
		writeFileSync(store, JSON.stringify({ version: 1, providers: credential }), { mode: 0o600 });
		const r2 = recordingFetch([JEV(0.03, COMPLETE)]);
		const keyed = createDecisions({
			config: { ...DEFAULT_DECISIONS_CONFIG, points: [...DEFAULT_DECISIONS_CONFIG.points] },
			sessionId: RECORD.sessionId,
			env: { OPENROUTER_API_KEY: K },
			storePath: store,
			fetch: r2.fetch,
		});
		const vetoed = await assessDone({ record: RECORD, signals: clean, diff: FULL_DIFF, complete: DONE_09, now, mode: "gate", decisions: keyed });
		expect(vetoed).toMatchObject({ done: false, decision: { point: "ship", p: 0.03, action: "veto" } });
		expect(r2.calls).toHaveLength(1);
	});

	test("Jev vetoes a confident LLM done on a full patch, after the judge's own gaps (AC-6.1)", async () => {
		const r = recordingFetch([JEV(0.03, COMPLETE)]);
		const { decisions, lines } = jevRuntime(r.fetch);
		const a = await assessDone({ record: RECORD, signals: clean, diff: FULL_DIFF, complete: DONE_09, now, decisions });
		expect(a).toMatchObject({ done: false, confidence: 0.9, summary: vetoGap("0.03"), gaps: [vetoGap("0.03")], source: "llm" });
		expect(a.decision).toMatchObject({
			point: "ship",
			outcome: "ok",
			model: MODEL,
			p: 0.03,
			probabilities: { complete: 0.03 },
			action: "veto",
			threshold: 0.2,
		});
		expect(a.decision && assessDecisionJson(a.decision)).toEqual({ p: 0.03, model: MODEL, action: "veto" });
		expect(r.calls.map((call) => call.url)).toEqual([ENDPOINT]);
		expectNoKey(a, lines);

		const noted = reply({ done: true, confidence: 0.9, summary: "ok", gaps: ["follow-up: docs"] });
		const withGaps = await assessDone({ record: RECORD, signals: clean, diff: FULL_DIFF, complete: noted, now, decisions });
		expect(withGaps.gaps).toEqual(["follow-up: docs", vetoGap("0.03")]);
	});

	test("a truncated patch disables the veto, whether gatherDiff or the state builder cut it (AC-6.2)", async () => {
		const long = `${PATCH}${"+const filler = 1;\n".repeat(1400)}`;
		expect(long.length).toBeGreaterThan(24_000);
		const diffs: ShipDiff[] = [
			{ ...FULL_DIFF, patch: long },
			{ ...FULL_DIFF, patchTruncated: true },
		];
		for (const diff of diffs) {
			const { decisions } = jevRuntime(recordingFetch([JEV(0.03, COMPLETE)]).fetch);
			const a = await assessDone({ record: RECORD, signals: clean, diff, complete: DONE_09, now, decisions });
			expect(a).toMatchObject({ done: true, source: "llm", gaps: [] });
			expect(a.gaps.some((gap) => gap.startsWith("Jev "))).toBe(false);
			expect(a.decision).toMatchObject({ outcome: "ok", p: 0.03, action: "none", threshold: 0.2 });
		}
	});

	test("without a completer Jev judges: done at or above shipApproveAt with source jev (AC-6.3)", async () => {
		const { decisions } = jevRuntime(recordingFetch([JEV(0.79, COMPLETE)]).fetch);
		const a = await assessDone({ record: RECORD, signals: clean, diff: FULL_DIFF, now, decisions });
		expect(a).toEqual({
			done: true,
			confidence: 0.79,
			summary: "Jev judged the change complete (P(complete) 0.79)",
			gaps: [],
			signals: clean,
			source: "jev",
			mode: "gate",
			at: 7,
			decision: expect.objectContaining({ outcome: "ok", p: 0.79, model: MODEL, action: "approve", threshold: 0.7 }),
		});
	});

	test("without a completer a Jev P below shipApproveAt is not done (AC-6.5)", async () => {
		const { decisions } = jevRuntime(recordingFetch([JEV(0.3, COMPLETE)]).fetch);
		const a = await assessDone({ record: RECORD, signals: clean, diff: FULL_DIFF, now, decisions });
		const gap = "Jev P(complete) 0.30 is below 0.7";
		expect(a).toMatchObject({ done: false, confidence: 0.3, summary: gap, gaps: [gap], source: "jev", mode: "gate" });
		expect(a.decision).toMatchObject({ outcome: "ok", p: 0.3, action: "reject", threshold: 0.7 });
	});

	test("Jev judges when the LLM verdict is unusable; a failed Jev keeps today's unavailable gap (AC-6.6)", async () => {
		const offline: ClaudeCompleter = async () => {
			throw new Error("offline");
		};
		const notJson: ClaudeCompleter = async () => "not json";
		for (const complete of [offline, notJson]) {
			const input = { record: RECORD, signals: clean, diff: FULL_DIFF, complete, now };
			const baseline = await assessDone(input);
			expect(baseline.gaps[0]).toStartWith("assessment unavailable: ");

			const approved = await assessDone({ ...input, decisions: jevRuntime(recordingFetch([JEV(0.79, COMPLETE)]).fetch).decisions });
			expect(approved).toMatchObject({ done: true, source: "jev", gaps: [] });
			expect(approved.decision?.action).toBe("approve");

			const rejected = await assessDone({ ...input, decisions: jevRuntime(recordingFetch([JEV(0.3, COMPLETE)]).fetch).decisions });
			expect(rejected).toMatchObject({ done: false, source: "jev", gaps: ["Jev P(complete) 0.30 is below 0.7"] });
			expect(rejected.decision?.action).toBe("reject");

			const r = recordingFetch([ERR(503)]);
			const { decisions, lines } = jevRuntime(r.fetch);
			const failed = await assessDone({ ...input, decisions });
			expect(withoutDecision(failed)).toEqual(baseline);
			expect(failed.decision).toMatchObject({ outcome: "error", error: "upstream", action: "fail-open", threshold: 0.7, attempts: 2 });
			expect(r.calls).toHaveLength(2);
			expectNoKey(failed, lines);
		}
	});

	test("a rule gap returns before any request, in gate and advisory mode (AC-6.7)", async () => {
		const unverified = signals({}, { phaseCount: 1, completedPhases: 1, trusted: true, verification: { phase: "01", status: "gaps_found" } });
		for (const mode of ["gate", "advisory"] as const) {
			const r = recordingFetch([JEV(0.95, COMPLETE)]);
			const input = { record: RECORD, signals: unverified, diff: FULL_DIFF, complete: DONE_09, now, mode };
			const a = await assessDone({ ...input, decisions: jevRuntime(r.fetch).decisions });
			expect(a).toEqual(await assessDone(input));
			expect(a).toMatchObject({ done: false, source: "rules", gaps: ["latest GSD verification is gaps_found"] });
			expect(r.calls).toHaveLength(0);
		}
	});

	test("Jev never turns an LLM not done into done (AC-6.8)", async () => {
		const cases: [object, string[]][] = [
			[{ done: false, confidence: 0.9, summary: "", gaps: ["missing flag"] }, ["missing flag"]],
			[{ done: true, confidence: 0.6, summary: "", gaps: [] }, ["judge confidence 0.6 below 0.7"]],
		];
		for (const [verdict, gaps] of cases) {
			const input = { record: RECORD, signals: clean, diff: FULL_DIFF, complete: reply(verdict), now };
			const { decisions } = jevRuntime(recordingFetch([JEV(0.95, COMPLETE)]).fetch);
			const a = await assessDone({ ...input, decisions });
			expect(withoutDecision(a)).toEqual(await assessDone(input));
			expect(a).toMatchObject({ done: false, gaps, source: "llm" });
			expect(a.decision).toMatchObject({ p: 0.95, action: "none", threshold: 0.2 });
		}
	});

	test("threshold boundaries: veto at P <= shipVetoAtOrBelow, done at P >= shipApproveAt, both read from config (AC-6.9)", async () => {
		const run = (p: number, complete?: ClaudeCompleter, config: Partial<DecisionsConfig> = {}) =>
			assessDone({
				record: RECORD,
				signals: clean,
				diff: FULL_DIFF,
				complete,
				now,
				decisions: jevRuntime(recordingFetch([JEV(p, COMPLETE)]).fetch, config).decisions,
			});
		expect(await run(0.2, DONE_09)).toMatchObject({ done: false, gaps: [vetoGap("0.20")], decision: { action: "veto" } });
		expect(await run(0.21, DONE_09)).toMatchObject({ done: true, gaps: [], decision: { action: "none" } });
		expect(await run(0.7)).toMatchObject({ done: true, source: "jev", decision: { action: "approve" } });
		expect(await run(0.69)).toMatchObject({
			done: false,
			source: "jev",
			gaps: ["Jev P(complete) 0.69 is below 0.7"],
			decision: { action: "reject" },
		});
		const strict = { shipVetoAtOrBelow: 0.5, shipApproveAt: 0.9 };
		expect(await run(0.45, DONE_09, strict)).toMatchObject({ done: false, decision: { action: "veto", threshold: 0.5 } });
		expect(await run(0.85, undefined, strict)).toMatchObject({
			done: false,
			gaps: ["Jev P(complete) 0.85 is below 0.9"],
			decision: { action: "reject", threshold: 0.9 },
		});
	});

	test("advisory mode always ships; Jev is recorded as advise-veto only where gate mode would veto", async () => {
		const cases: [number, ShipDiff, string][] = [
			[0.03, FULL_DIFF, "advise-veto"],
			[0.03, { ...FULL_DIFF, patchTruncated: true }, "none"],
			[0.94, FULL_DIFF, "none"],
		];
		for (const [p, diff, action] of cases) {
			const input = { record: RECORD, signals: clean, diff, complete: DONE_09, now, mode: "advisory" as const };
			const { decisions } = jevRuntime(recordingFetch([JEV(p, COMPLETE)]).fetch);
			const a = await assessDone({ ...input, decisions });
			expect(withoutDecision(a)).toEqual(await assessDone(input));
			expect(a).toMatchObject({ done: true, gaps: [], mode: "advisory" });
			expect(a.decision).toMatchObject({ p, action, threshold: 0.2 });
		}
	});

	test("with autoMerge Jev never stands in for a missing or unusable judge; its veto of a usable done still applies", async () => {
		const offline: ClaudeCompleter = async () => {
			throw new Error("offline");
		};
		const notJson: ClaudeCompleter = async () => "not json";
		const run = (jev: () => Response, complete: ClaudeCompleter | undefined, autoMerge: boolean) => {
			const r = recordingFetch([jev]);
			const input = { record: RECORD, signals: clean, diff: FULL_DIFF, complete, now, autoMerge };
			return { calls: r.calls, input, result: assessDone({ ...input, decisions: jevRuntime(r.fetch).decisions }) };
		};
		// Jev at 0.95 is ignored: exactly the result without Jev, the decision recorded as "none".
		for (const complete of [undefined, offline, notJson]) {
			const { calls, input, result } = run(JEV(0.95, COMPLETE), complete, true);
			const a = await result;
			expect(withoutDecision(a)).toEqual(await assessDone(input));
			expect(a.source).not.toBe("jev");
			expect(a.decision).toMatchObject({ outcome: "ok", p: 0.95, action: "none", threshold: 0.2 });
			expect(calls).toHaveLength(1);
		}
		// No completer: the rules-only result that ship's cli turns into "no judge available".
		expect(await run(JEV(0.95, COMPLETE), undefined, true).result).toMatchObject({ done: true, confidence: 0.5, source: "rules" });
		expect(await run(JEV(0.95, COMPLETE), offline, true).result).toMatchObject({
			done: false,
			source: "llm",
			gaps: ["assessment unavailable: offline"],
		});
		expect(await run(JEV(0.03, COMPLETE), DONE_09, true).result).toMatchObject({
			done: false,
			source: "llm",
			gaps: [vetoGap("0.03")],
			decision: { action: "veto", threshold: 0.2 },
		});
		expect(await run(ERR(503), offline, true).result).toMatchObject({
			done: false,
			gaps: ["assessment unavailable: offline"],
			decision: { action: "fail-open", threshold: 0.2 },
		});
		// autoMerge off: Jev alone still decides when there is no completer.
		expect(await run(JEV(0.79, COMPLETE), undefined, false).result).toMatchObject({
			done: true,
			confidence: 0.79,
			source: "jev",
			decision: { action: "approve", threshold: 0.7 },
		});
	});

	test("the ship state holds only request, capped criteria and the lockfile-free capped patch (AC-6.12)", async () => {
		const items = Array.from({ length: 25 }, (_, i) => `<item>${`AC-${String(i + 1).padStart(2, "0")} `.padEnd(800, "x")}</item>`);
		const spec = `<UPLIFTED_PROMPT><ACCEPTANCE_CRITERIA>\n${items.join("\n")}\n</ACCEPTANCE_CRITERIA></UPLIFTED_PROMPT>`;
		const lockHunk =
			"diff --git a/bun.lock b/bun.lock\nindex 1111111..2222222 100644\n--- a/bun.lock\n+++ b/bun.lock\n@@ -1 +1 @@\n+LOCK-MARKER-2d4\n";
		const source = `diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1,1250 @@\n${"+const filler = 1; // x\n".repeat(1250)}`;
		const gsd = {
			phaseCount: 1,
			completedPhases: 1,
			trusted: true,
			state: "GSD-MARKER-7f3",
			verification: { phase: "01-GSD-MARKER-7f3", status: "passed" },
		};
		const diff: ShipDiff = { stat: "src/app.ts | 1250 +++ STAT-MARKER-9c1", log: "abc1234 add app", patch: `${lockHunk}${source}` };
		let judgePrompt = "";
		const complete: ClaudeCompleter = async (_system, user) => {
			judgePrompt = user;
			return JSON.stringify({ done: true, confidence: 0.9, summary: "ok", gaps: [] });
		};
		const r = recordingFetch([JEV(0.9, COMPLETE)]);
		const { decisions } = jevRuntime(r.fetch);
		for (const xml of [spec, "<UPLIFTED_PROMPT><GOAL>ship</GOAL></UPLIFTED_PROMPT>"]) {
			const record = { ...RECORD, result: { ...RECORD.result, xml } };
			await assessDone({ record, signals: signals({}, gsd), diff, complete, now, decisions });
		}
		// The judge still reads the GSD and stat signals; Jev never does (D9).
		expect(judgePrompt).toContain("GSD-MARKER-7f3");
		expect(judgePrompt).toContain("STAT-MARKER-9c1");
		expect(r.calls).toHaveLength(2);
		type Body = { state: { request: string; acceptance_criteria: string[]; patch: string }; questions: object; trace: object };
		const [first, second] = r.calls.map((call) => call.body as Body);
		if (!first || !second) throw new Error("expected two requests");
		expect(Object.keys(first.state).sort()).toEqual(["acceptance_criteria", "patch", "request"]);
		expect(first.state.request).toBe("add ship");
		expect(first.state.acceptance_criteria).toHaveLength(20);
		expect(first.state.acceptance_criteria.every((item) => item.length <= 500)).toBe(true);
		expect(first.state.acceptance_criteria[0]).toStartWith("AC-01 ");
		expect(first.state.acceptance_criteria[19]).toStartWith("AC-20 ");
		expect(first.state.patch.length).toBeLessThanOrEqual(24_000);
		expect(first.state.patch).toStartWith("diff --git a/src/app.ts b/src/app.ts");
		expect(first.state.patch).not.toContain("bun.lock");
		expect(first.state.patch).not.toContain("LOCK-MARKER-2d4");
		expect(second.state.acceptance_criteria).toEqual([]);
		for (const body of [first, second]) {
			const serialized = JSON.stringify(body);
			expect(serialized).not.toContain("GSD-MARKER-7f3");
			expect(serialized).not.toContain("STAT-MARKER-9c1");
			expect(body.questions).toEqual({ complete: QUESTIONS.ship });
			expect(body.trace).toMatchObject({ trace_name: "ultrathink", span_name: "ship" });
		}
	});

	test("Jev runs concurrently with the LLM judge: its request is sent before the judge answers (AC-6.13)", async () => {
		const held = heldFetch(() => JEV(0.9, COMPLETE)());
		const { decisions } = jevRuntime(held.fetch);
		let requestsWhenJudged = -1;
		let judgeCalled!: () => void;
		const judging = new Promise<void>((resolve) => {
			judgeCalled = resolve;
		});
		let answer!: (text: string) => void;
		const complete: ClaudeCompleter = () => {
			requestsWhenJudged = held.calls.length;
			judgeCalled();
			return new Promise<string>((resolve) => {
				answer = resolve;
			});
		};
		const pending = assessDone({ record: RECORD, signals: clean, diff: FULL_DIFF, complete, now, decisions });
		await judging;
		expect(requestsWhenJudged).toBe(1);
		expect(held.calls).toHaveLength(1);
		answer(JSON.stringify({ done: true, confidence: 0.9, summary: "ok", gaps: [] }));
		held.release();
		const a = await pending;
		expect(a).toMatchObject({ done: true, source: "llm", decision: { p: 0.9, action: "none" } });
	});

	test("a caller abort during the decision rejects assessDone with an AbortError instead of failing open (AC-5.7)", async () => {
		const hangingJudge: ClaudeCompleter = (_system, _user, signal) =>
			new Promise<string>((_resolve, reject) => {
				signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
			});
		const runs: { mode: JudgeMode; complete?: ClaudeCompleter }[] = [
			{ mode: "gate" },
			{ mode: "gate", complete: hangingJudge },
			{ mode: "advisory", complete: hangingJudge },
		];
		for (const { mode, complete } of runs) {
			const controller = new AbortController();
			let requested!: () => void;
			const started = new Promise<void>((resolve) => {
				requested = resolve;
			});
			const { decisions, lines } = jevRuntime(hangingFetch(() => requested()));
			const pending = assessDone({ record: RECORD, signals: clean, diff: FULL_DIFF, complete, now, mode, signal: controller.signal, decisions });
			await started;
			controller.abort();
			const error = await pending.then(
				() => undefined,
				(rejection: unknown) => rejection,
			);
			expect((error as { name?: unknown } | undefined)?.name).toBe("AbortError");
			expect(error).not.toBeInstanceOf(DecisionsError);
			expect(lines).toEqual([]);
		}
	});

	for (const failure of FAILURES) {
		test(`${failure.name} fails open to today's assessment in gate and advisory mode (AC-4.12)`, async () => {
			const runs: [JudgeMode, ClaudeCompleter | undefined, number][] = [
				["gate", DONE_09, 0.2],
				["gate", undefined, 0.7],
				["advisory", DONE_09, 0.2],
			];
			for (const [mode, complete, threshold] of runs) {
				const input = { record: RECORD, signals: clean, diff: FULL_DIFF, complete, now, mode };
				const config: Partial<DecisionsConfig> = { points: ["ship"], ...(failure.timeoutMs ? { timeoutMs: failure.timeoutMs } : {}) };
				const { decisions, lines } = jevRuntime(failure.fetch(), config);
				const a = await assessDone({ ...input, decisions });
				expect(withoutDecision(a)).toEqual(await assessDone(input));
				expect(a.decision).toMatchObject({
					point: "ship",
					outcome: "error",
					model: ON.model,
					probabilities: {},
					error: failure.kind,
					action: "fail-open",
					threshold,
				});
				expect(a.decision && assessDecisionJson(a.decision)).toEqual({ action: "fail-open", error: failure.kind });
				expect(lines).toHaveLength(1);
				expectNoKey(a, lines);
			}
		});
	}
});
