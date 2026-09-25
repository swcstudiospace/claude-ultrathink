// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionRecord } from "../claude/state.ts";
import { assessDone } from "./assess.ts";
import { collectSignals, gatherDiff } from "./signals.ts";
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
