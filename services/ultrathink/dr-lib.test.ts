// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
//
// Tests for deploy/ultrathink-dr-lib.sh. Each case spawns bash, sources the lib and calls one helper. Databases are
// real SQLite files written through the store's openStore, in temp directories. Nothing here touches /etc, /var, a
// service user, a timer or a production host, and no test sleeps.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	truncateSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { openStore } from "./store/store.ts";

const LIB = resolve(import.meta.dir, "../../deploy/ultrathink-dr-lib.sh");

let work = "";

beforeAll(() => {
	work = mkdtempSync(join(tmpdir(), "dr-lib-test-"));
});

afterAll(() => {
	if (work) rmSync(work, { recursive: true, force: true });
});

interface Outcome {
	code: number;
	stdout: string;
	stderr: string;
}

// Runs `script` after sourcing the lib. Positional arguments reach the script as $1, $2, ... so no path is spliced
// into shell text. The environment is clean apart from PATH, a temp HOME, a missing env file and the Bun binary.
async function lib(script: string, args: string[] = [], env: Record<string, string> = {}): Promise<Outcome> {
	const home = mkdtempSync(join(work, "home-"));
	const proc = Bun.spawn({
		cmd: ["bash", "-c", `source "$0"\n${script}`, LIB, ...args],
		env: {
			PATH: process.env.PATH ?? "/usr/bin:/bin",
			HOME: home,
			ULTRATHINK_ENV_FILE: "/nonexistent",
			ULTRATHINK_BUN: process.execPath,
			...env,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { code, stdout, stderr };
}

function caseDir(name: string): string {
	return mkdtempSync(join(work, `${name}-`));
}

function makeStore(path: string): void {
	openStore(path).close();
}

describe("dr_setting", () => {
	test("environment value beats the environment file, and a file value containing $ is returned unexpanded", async () => {
		const dir = caseDir("setting");
		const envFile = join(dir, "ultrathink.env");
		writeFileSync(envFile, "ULTRATHINK_BACKUP_KEEP=7\nULTRATHINK_SNAPSHOT_TREE=/srv/$HOME/tree\n");

		const fromEnv = await lib("dr_setting ULTRATHINK_BACKUP_KEEP 14", [], {
			ULTRATHINK_ENV_FILE: envFile,
			ULTRATHINK_BACKUP_KEEP: "3",
		});
		expect(fromEnv.code).toBe(0);
		expect(fromEnv.stdout).toBe("3");

		const fromFile = await lib("dr_setting ULTRATHINK_BACKUP_KEEP 14", [], { ULTRATHINK_ENV_FILE: envFile });
		expect(fromFile.code).toBe(0);
		expect(fromFile.stdout).toBe("7");

		const literal = await lib("dr_setting ULTRATHINK_SNAPSHOT_TREE fallback", [], { ULTRATHINK_ENV_FILE: envFile });
		expect(literal.code).toBe(0);
		expect(literal.stdout).toBe("/srv/$HOME/tree");
	});

	test("the default is used when neither the environment nor the file sets the name", async () => {
		const dir = caseDir("setting-default");
		const envFile = join(dir, "ultrathink.env");
		writeFileSync(envFile, "ULTRATHINK_BACKUP_KEEP=7\n");

		const result = await lib("dr_setting ULTRATHINK_NOT_SET_ANYWHERE fallback-value", [], {
			ULTRATHINK_ENV_FILE: envFile,
		});
		expect(result.code).toBe(0);
		expect(result.stdout).toBe("fallback-value");
	});

	test("a directory ENV_FILE is treated as absent: the default is returned and nothing crashes", async () => {
		const dir = caseDir("setting-dir");
		const envDir = join(dir, "env-as-directory");
		mkdirSync(envDir);

		const result = await lib("dr_setting ULTRATHINK_BACKUP_KEEP fallback-value", [], {
			ULTRATHINK_ENV_FILE: envDir,
		});
		expect(result.code).toBe(0);
		expect(result.stdout).toBe("fallback-value");
		expect(result.stderr).toBe("");
	});
});

describe("dr_bun", () => {
	test("copy refuses an existing destination and leaves its bytes unchanged", async () => {
		const dir = caseDir("copy");
		const src = join(dir, "src.sqlite");
		makeStore(src);

		const occupied = join(dir, "occupied.sqlite");
		writeFileSync(occupied, "keep me");

		const refused = await lib('dr_bun copy "$1" "$2"', [src, occupied]);
		expect(refused.code).not.toBe(0);
		expect(readFileSync(occupied, "utf8")).toBe("keep me");

		const empty = join(dir, "empty.sqlite");
		writeFileSync(empty, "");
		const refusedEmpty = await lib('dr_bun copy "$1" "$2"', [src, empty]);
		expect(refusedEmpty.code).not.toBe(0);
		expect(readFileSync(empty).byteLength).toBe(0);

		const fresh = join(dir, "fresh.sqlite");
		const copied = await lib('dr_bun copy "$1" "$2"', [src, fresh]);
		expect(copied.code).toBe(0);
		expect(copied.stdout.startsWith("sqlite copy ok")).toBe(true);
		expect(existsSync(fresh)).toBe(true);
	});

	test("quick passes on a fresh store database and fails on that database truncated to half its size", async () => {
		const dir = caseDir("quick");
		const fresh = join(dir, "fresh.sqlite");
		makeStore(fresh);

		const passed = await lib('dr_bun quick "$1"', [fresh]);
		expect(passed.code).toBe(0);
		expect(passed.stdout).toContain("sqlite quick ok");

		const truncated = join(dir, "truncated.sqlite");
		copyFileSync(fresh, truncated);
		truncateSync(truncated, Math.floor(statSync(truncated).size / 2));

		const failed = await lib('dr_bun quick "$1"', [truncated]);
		expect(failed.code).not.toBe(0);
	});

	test("compat fails on a runs table without owner_id and passes on a fresh database, leaving the source unchanged", async () => {
		const dir = caseDir("compat");

		const legacy = join(dir, "legacy.sqlite");
		const legacyDb = new Database(legacy, { create: true });
		legacyDb.exec(
			"CREATE TABLE runs (id TEXT PRIMARY KEY, request TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0)",
		);
		legacyDb.close();
		const before = readFileSync(legacy);

		const conflict = await lib('dr_bun compat "$1"', [legacy]);
		expect(conflict.code).not.toBe(0);
		expect(conflict.stderr).toContain("owner_id");
		expect(readFileSync(legacy).equals(before)).toBe(true);

		const fresh = join(dir, "fresh.sqlite");
		makeStore(fresh);
		const passed = await lib('dr_bun compat "$1"', [fresh]);
		expect(passed.code).toBe(0);
		expect(passed.stdout).toContain("compat ok");
	});
});

describe("dr_age", () => {
	test("encrypt without a recipient exits 2 and creates no output", async () => {
		const dir = caseDir("age-norecipient");
		const input = join(dir, "archive.tar.gz");
		writeFileSync(input, "plaintext");
		const output = join(dir, "archive.tar.gz.age");

		const result = await lib('dr_age encrypt "$1" "$2"', [input, output]);
		expect(result.code).toBe(2);
		expect(readdirSync(dir).filter((name) => name.startsWith("archive.tar.gz.age"))).toEqual([]);
	});

	test("with ULTRATHINK_AGE pointing at a missing binary it exits 2 and creates no output", async () => {
		const dir = caseDir("age-nobinary");
		const input = join(dir, "archive.tar.gz");
		writeFileSync(input, "plaintext");
		const output = join(dir, "archive.tar.gz.age");

		const result = await lib('dr_age encrypt "$1" "$2"', [input, output], {
			ULTRATHINK_BACKUP_RECIPIENT: "age1placeholderrecipient",
			ULTRATHINK_AGE: join(dir, "no-such-age"),
		});
		expect(result.code).toBe(2);
		expect(existsSync(output)).toBe(false);
	});

	test("decrypt without an identity exits 2", async () => {
		const dir = caseDir("age-noidentity");
		const input = join(dir, "archive.tar.gz.age");
		writeFileSync(input, "ciphertext");
		const output = join(dir, "archive.tar.gz");

		const result = await lib('dr_age decrypt "$1" "$2"', [input, output]);
		expect(result.code).toBe(2);
		expect(existsSync(output)).toBe(false);
	});
});

describe("timing and disk helpers", () => {
	test("dr_now_ms honours ULTRATHINK_DR_NOW_MS, dr_timing reports the elapsed time, and a bad seam exits 2", async () => {
		const seam = { ULTRATHINK_DR_NOW_MS: "1700000000250" };

		const now = await lib("dr_now_ms", [], seam);
		expect(now.code).toBe(0);
		expect(now.stdout).toBe("1700000000250\n");

		const timing = await lib('dr_timing copy "$1"', ["1700000000000"], seam);
		expect(timing.code).toBe(0);
		expect(timing.stdout).toBe("step copy 250ms\n");

		const bad = await lib("dr_now_ms", [], { ULTRATHINK_DR_NOW_MS: "12x" });
		expect(bad.code).toBe(2);
	});

	test("dr_free_bytes reports a positive byte count for a directory", async () => {
		const dir = caseDir("free");
		const result = await lib('dr_free_bytes "$1"', [dir]);
		expect(result.code).toBe(0);
		expect(Number(result.stdout.trim())).toBeGreaterThan(0);
	});
});
