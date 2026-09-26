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
		const milestone = {
			version: "v2.0",
			verifications: [
				{ phase: "01-a", status: "passed" },
				{ phase: "02-b", status: "gaps_found" },
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
