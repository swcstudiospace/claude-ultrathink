// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runPruneCommand } from "./cli.ts";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 9, 12);
const now = () => NOW;
const USAGE = "Usage: ultrathink prune [--older-than <days>[d]] [--dry-run]";
const SIZE = "\\d+(?:\\.\\d)? (?:B|KB|MB)";
const PROMPT = "PROMPT-SECRET-deploy the staging cluster with key sk-test-not-a-real-key";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

interface Fixture {
	root: string;
	state: string;
	env: Record<string, string | undefined>;
}

function makeFixture(): Fixture {
	const root = mkdtempSync(join(tmpdir(), "ut-prune-cli-"));
	roots.push(root);
	const state = join(root, "state");
	mkdirSync(join(state, "sessions"), { recursive: true });
	return { root, state, env: { XDG_CONFIG_HOME: join(root, "xdg"), CLAUDE_CONFIG_DIR: join(root, "claude"), ULTRATHINK_STATE_DIR: state } };
}

function put(path: string, body: string, ageMs: number): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, body);
	const seconds = (NOW - ageMs) / 1000;
	utimesSync(path, seconds, seconds);
}

function seed(state: string, id: string, ageDays: number, ship?: unknown): void {
	put(join(state, "sessions", `${id}.json`), JSON.stringify({ sessionId: id, result: { original: PROMPT }, ship }), ageDays * DAY);
	put(join(state, "sessions", `${id}.xml`), `<spec>${PROMPT}</spec>`, ageDays * DAY);
}

function remaining(state: string): string[] {
	return readdirSync(join(state, "sessions")).sort();
}

describe("runPruneCommand", () => {
	test("prunes sessions older than --older-than and reports counts, size and the state directory", async () => {
		const { state, env } = makeFixture();
		seed(state, "old-one", 45);
		seed(state, "old-two", 90);
		seed(state, "recent", 3);
		const result = await runPruneCommand(["--older-than", "30"], { env, cwd: state, now });
		expect(result.exitCode).toBe(0);
		const lines = result.output.split("\n");
		expect(lines[0]).toMatch(new RegExp(`^Pruned 2 sessions \\(${SIZE}\\) older than 30 days from `));
		expect(lines[0]?.endsWith(state)).toBe(true);
		expect(lines).toContain("Kept 1 (0 active ships)");
		expect(lines).toContain("Removed 0 leftover temporary or lock files");
		expect(remaining(state)).toEqual(["recent.json", "recent.xml"]);
	});

	test("accepts a d suffix and the --older-than=<days> form", async () => {
		const { state, env } = makeFixture();
		seed(state, "old", 45);
		expect((await runPruneCommand(["--older-than", "30d", "--dry-run"], { env, cwd: state, now })).exitCode).toBe(0);
		expect(remaining(state)).toHaveLength(2);
		const result = await runPruneCommand(["--older-than=30d"], { env, cwd: state, now });
		expect(result.exitCode).toBe(0);
		expect(result.output.startsWith("Pruned 1 session ")).toBe(true);
		expect(remaining(state)).toEqual([]);
	});

	test("--dry-run says Would prune, lists ids with size and age, and deletes nothing", async () => {
		const { state, env } = makeFixture();
		seed(state, "aaa", 45);
		seed(state, "bbb", 120);
		seed(state, "live", 400, { phase: "pr-open", pr: { number: 3 } });
		put(join(state, "sessions", "x.json.tmp"), "partial", 3 * 3_600_000);
		const result = await runPruneCommand(["--dry-run", "--older-than", "30"], { env, cwd: state, now });
		expect(result.exitCode).toBe(0);
		const lines = result.output.split("\n");
		expect(lines[0]?.startsWith("Would prune 2 sessions (")).toBe(true);
		expect(lines[1]).toMatch(new RegExp(`^ {2}bbb {2}${SIZE} {2}120d$`));
		expect(lines[2]).toMatch(new RegExp(`^ {2}aaa {2}${SIZE} {2}45d$`));
		expect(lines).toContain("Kept 1 (1 active ship)");
		expect(lines).toContain("Would remove 1 leftover temporary or lock file");
		expect(remaining(state)).toEqual(["aaa.json", "aaa.xml", "bbb.json", "bbb.xml", "live.json", "live.xml", "x.json.tmp"]);
	});

	test("--dry-run lists at most 20 sessions", async () => {
		const { state, env } = makeFixture();
		for (let index = 0; index < 25; index++) seed(state, `s${String(index).padStart(2, "0")}`, 60);
		const result = await runPruneCommand(["--dry-run", "--older-than", "30"], { env, cwd: state, now });
		const listed = result.output.split("\n").filter((line) => /^ {2}s\d\d /.test(line));
		expect(listed).toHaveLength(20);
		expect(result.output).toContain("and 5 more");
		expect(result.output.startsWith("Would prune 25 sessions")).toBe(true);
	});

	test("a real run removes exactly the set a dry run listed", async () => {
		const { state, env } = makeFixture();
		seed(state, "a", 45);
		seed(state, "b", 2);
		const dry = await runPruneCommand(["--older-than", "30", "--dry-run"], { env, cwd: state, now });
		const real = await runPruneCommand(["--older-than", "30"], { env, cwd: state, now });
		expect(dry.output.replace(/\n {2}a {2}.*$/m, "").replace("Would prune", "Pruned").replace("Would remove", "Removed")).toBe(real.output);
		expect(remaining(state)).toEqual(["b.json", "b.xml"]);
	});

	test("refuses a cutoff below one day, above 3650, or not a whole number", async () => {
		const { state, env } = makeFixture();
		seed(state, "ancient", 500);
		for (const value of ["0", "-3", "1.5", "abc", "", "3651", "0d", "30dd", "1e2"]) {
			const result = await runPruneCommand(["--older-than", value], { env, cwd: state, now });
			expect(result).toEqual({ output: "refusing to prune everything: --older-than must be 1 to 3650 days", exitCode: 2 });
		}
		expect(remaining(state)).toEqual(["ancient.json", "ancient.xml"]);
		expect((await runPruneCommand(["--older-than", "3650"], { env, cwd: state, now })).exitCode).toBe(0);
		expect((await runPruneCommand(["--older-than", "1"], { env, cwd: state, now })).exitCode).toBe(0);
	});

	test("unknown flags, stray arguments and a missing value print the usage line", async () => {
		const { state, env } = makeFixture();
		for (const args of [["--force"], ["30"], ["--dry-run", "--nope"], ["--older-than"], ["--older-than", "30", "extra"]]) {
			expect(await runPruneCommand(args, { env, cwd: state, now })).toEqual({ output: USAGE, exitCode: 2 });
		}
	});

	test("without --older-than and without a configured cutoff it exits 2 and deletes nothing", async () => {
		const { state, env, root } = makeFixture();
		seed(state, "old", 500);
		const result = await runPruneCommand([], { env, cwd: join(root, "repo"), now });
		expect(result).toEqual({ output: "no cutoff: pass --older-than <days> or set state.retentionDays", exitCode: 2 });
		expect(remaining(state)).toHaveLength(2);
	});

	test("uses state.retentionDays from the user's config when --older-than is absent", async () => {
		const { state, env, root } = makeFixture();
		put(join(root, "xdg", "ultrathink", "config.json"), JSON.stringify({ state: { retentionDays: 30 } }), 0);
		seed(state, "old", 45);
		seed(state, "new", 5);
		const result = await runPruneCommand([], { env, cwd: join(root, "repo"), now });
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain("older than 30 days");
		expect(remaining(state)).toEqual(["new.json", "new.xml"]);
	});

	test("a project config file cannot supply the cutoff", async () => {
		const { state, env, root } = makeFixture();
		const repo = join(root, "repo");
		put(join(repo, ".claude", "ultrathink.json"), JSON.stringify({ state: { retentionDays: 1 } }), 0);
		seed(state, "old", 45);
		const result = await runPruneCommand([], { env, cwd: repo, now });
		expect(result.exitCode).toBe(2);
		expect(remaining(state)).toHaveLength(2);
	});

	test("--older-than wins over the configured cutoff", async () => {
		const { state, env, root } = makeFixture();
		put(join(root, "xdg", "ultrathink", "config.json"), JSON.stringify({ state: { retentionDays: 30 } }), 0);
		seed(state, "mid", 45);
		const result = await runPruneCommand(["--older-than", "60"], { env, cwd: join(root, "repo"), now });
		expect(result.output).toContain("older than 60 days");
		expect(remaining(state)).toHaveLength(2);
	});

	test("resolves the state directory from the environment when none is injected", async () => {
		const { state, env } = makeFixture();
		seed(state, "old", 45);
		const result = await runPruneCommand(["--older-than", "30"], { env, cwd: state, now });
		expect(result.output.split("\n")[0]?.endsWith(state)).toBe(true);
		expect(remaining(state)).toEqual([]);
	});

	test("deps.stateDir overrides the environment", async () => {
		const { state, env, root } = makeFixture();
		const other = join(root, "other");
		mkdirSync(join(other, "sessions"), { recursive: true });
		seed(other, "old", 45);
		seed(state, "old", 45);
		const result = await runPruneCommand(["--older-than", "30"], { env, cwd: state, now, stateDir: other });
		expect(result.exitCode).toBe(0);
		expect(remaining(other)).toEqual([]);
		expect(remaining(state)).toHaveLength(2);
	});

	test("a state directory with no sessions is a clean zero", async () => {
		const { root, env } = makeFixture();
		const empty = join(root, "never-created");
		const result = await runPruneCommand(["--older-than", "30"], { env, cwd: root, now, stateDir: empty });
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain("Pruned 0 sessions (0 B)");
		expect(existsSync(empty)).toBe(false);
	});

	test("an unreadable sessions directory prints the error and exits 1", async () => {
		const { root, env } = makeFixture();
		const broken = join(root, "broken");
		mkdirSync(broken, { recursive: true });
		writeFileSync(join(broken, "sessions"), "a file where the directory should be");
		const result = await runPruneCommand(["--older-than", "30"], { env, cwd: root, now, stateDir: broken });
		expect(result.exitCode).toBe(1);
		expect(result.output).toMatch(/^error: sessions: \w+$/m);
	});

	test("output never contains prompt content or file contents", async () => {
		const { state, env } = makeFixture();
		seed(state, "old", 45);
		seed(state, "live", 400, { phase: "pr-open", pr: { number: 3 } });
		put(join(state, "sessions", "broken.json"), `{"prompt": "${PROMPT}"`, 200 * DAY);
		for (const args of [["--older-than", "30", "--dry-run"], ["--older-than", "30"], ["--older-than", "x"], ["--bogus"], []]) {
			const result = await runPruneCommand(args, { env, cwd: state, now });
			expect(result.output).not.toContain("PROMPT-SECRET");
			expect(result.output).not.toContain("sk-test-not-a-real-key");
		}
	});
});
