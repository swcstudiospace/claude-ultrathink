// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionRecord } from "../claude/state.ts";
import { collectSignals, lookupGsdTools, resolveGsdTools } from "./signals.ts";
import type { Run } from "./types.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "ship-signals-"));
	dirs.push(dir);
	return dir;
}

/** Replies by joined argv; unknown commands fail (exit 1), so an unlisted `git ls-files --error-unmatch` means untracked. */
function fakeRun(table: Record<string, string | undefined>, argvs: string[][] = []): Run {
	return (argv) => {
		argvs.push(argv);
		const out = table[argv.join(" ")];
		return out === undefined ? { exitCode: 1, stdout: "", stderr: "no" } : { exitCode: 0, stdout: out, stderr: "" };
	};
}

const RECORD: SessionRecord = {
	sessionId: "s1",
	at: 0,
	result: { xml: "<spec/>", original: "add ship", root: "", source: "llm" },
};

describe("resolveGsdTools never picks a repository-tracked copy", () => {
	const cwd = "/work/app";
	const home = "/home/u";
	const local = "/work/app/gsd-core/bin/gsd-tools.cjs";
	const localLegacy = "/work/app/.claude/get-shit-done/bin/gsd-tools.cjs";
	const homeTool = "/home/u/.claude/gsd-core/bin/gsd-tools.cjs";

	test("a tracked project-local copy is skipped and reported; nothing else installed resolves to undefined", () => {
		const asked: string[] = [];
		const isTracked = (path: string) => (asked.push(path), true);
		expect(resolveGsdTools({ cwd, home, env: {}, exists: (p) => p === local, isTracked })).toBeUndefined();
		expect(asked).toEqual([local]);
		expect(lookupGsdTools({ cwd, home, env: {}, exists: (p) => p === local, isTracked })).toEqual({ path: undefined, tracked: [local] });
	});

	test("a tracked local copy falls through to the next untracked or home install", () => {
		const installed: Record<string, true> = { [local]: true, [localLegacy]: true, [homeTool]: true };
		const exists = (p: string) => installed[p] === true;
		expect(resolveGsdTools({ cwd, home, env: {}, exists, isTracked: (p) => p === local })).toBe(localLegacy);
		expect(lookupGsdTools({ cwd, home, env: {}, exists, isTracked: () => true })).toEqual({
			path: homeTool,
			tracked: [local, localLegacy],
		});
	});

	test("an untracked (locally installed) project copy is still used; only existing local candidates are checked", () => {
		const asked: string[] = [];
		const isTracked = (path: string) => (asked.push(path), false);
		expect(resolveGsdTools({ cwd, home, env: {}, exists: (p) => p === local || p === homeTool, isTracked })).toBe(local);
		expect(asked).toEqual([local]);
	});

	test("home and config-dir installs are never tracked-checked", () => {
		const isTracked = () => {
			throw new Error("home install must not be checked");
		};
		expect(resolveGsdTools({ cwd, home, env: {}, exists: (p) => p === homeTool, isTracked })).toBe(homeTool);
		const cfg = "/cfg/claude/gsd-core/bin/gsd-tools.cjs";
		expect(resolveGsdTools({ cwd, home, env: { CLAUDE_CONFIG_DIR: "/cfg/claude" }, exists: (p) => p === cfg, isTracked })).toBe(cfg);
	});

	test("GSD_TOOLS still wins, even when it points into the repository", () => {
		const isTracked = () => true;
		expect(resolveGsdTools({ cwd, home, env: { GSD_TOOLS: local }, exists: () => true, isTracked })).toBe(local);
		expect(lookupGsdTools({ cwd, home, env: { GSD_TOOLS: local }, exists: () => true, isTracked })).toEqual({ path: local, tracked: [] });
	});

	test("the default tracked check runs `git ls-files --error-unmatch <relative path>` in cwd through run", () => {
		const argvs: string[][] = [];
		const trackedRun = fakeRun({ "git ls-files --error-unmatch gsd-core/bin/gsd-tools.cjs": "gsd-core/bin/gsd-tools.cjs\n" }, argvs);
		expect(resolveGsdTools({ cwd, home, env: {}, exists: (p) => p === local, run: trackedRun })).toBeUndefined();
		expect(argvs).toEqual([["git", "ls-files", "--error-unmatch", "gsd-core/bin/gsd-tools.cjs"]]);
		// Any non-zero exit (untracked, or not a git repository at all) allows the local copy.
		expect(resolveGsdTools({ cwd, home, env: {}, exists: (p) => p === local, run: fakeRun({}) })).toBe(local);
	});
});

describe("collectSignals with a repository-tracked gsd-tools.cjs", () => {
	test("never runs node on the tracked copy and flags it as missing and tracked", () => {
		const cwd = tempDir();
		mkdirSync(join(cwd, ".planning"), { recursive: true });
		writeFileSync(join(cwd, ".planning", "ROADMAP.md"), "# r");
		mkdirSync(join(cwd, "gsd-core", "bin"), { recursive: true });
		writeFileSync(join(cwd, "gsd-core", "bin", "gsd-tools.cjs"), 'require("fs").writeFileSync("/tmp/pwned", "1")');
		const argvs: string[][] = [];
		const run = fakeRun(
			{
				"git ls-files --error-unmatch .planning/ROADMAP.md": ".planning/ROADMAP.md",
				"git ls-files --error-unmatch gsd-core/bin/gsd-tools.cjs": "gsd-core/bin/gsd-tools.cjs",
			},
			argvs,
		);
		const s = collectSignals({ cwd, record: RECORD, run, env: {}, home: tempDir() });
		expect(s.gsd).toMatchObject({ phaseCount: 0, completedPhases: 0, trusted: true, toolsMissing: true, toolsTracked: true });
		expect(argvs.some((argv) => argv[0] === "node")).toBe(false);
		expect(argvs.filter((argv) => argv[1] === "ls-files").map((argv) => argv[3])).toContain("gsd-core/bin/gsd-tools.cjs");
	});

	test("an untracked local install is run as before and carries no tracked flag", () => {
		const cwd = tempDir();
		mkdirSync(join(cwd, ".planning"), { recursive: true });
		writeFileSync(join(cwd, ".planning", "ROADMAP.md"), "# r");
		const tool = join(cwd, ".claude", "gsd-core", "bin", "gsd-tools.cjs");
		mkdirSync(join(cwd, ".claude", "gsd-core", "bin"), { recursive: true });
		writeFileSync(tool, "");
		const run = fakeRun({
			"git check-ignore -q .planning": "",
			[`node ${tool} query roadmap.analyze --cwd ${cwd}`]: JSON.stringify({ phase_count: 3, completed_phases: 1 }),
		});
		const s = collectSignals({ cwd, record: RECORD, run, env: {}, home: tempDir() });
		expect(s.gsd).toMatchObject({ phaseCount: 3, completedPhases: 1, trusted: true });
		expect(s.gsd?.toolsMissing).toBeUndefined();
		expect(s.gsd?.toolsTracked).toBeUndefined();
	});
});
