// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, beforeEach, describe, expect, type Mock, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	__injectFaultForTest,
	invokeA01OrchestratorWithGraceful,
	withA01OrchestratorTimeout,
} from "./a01-orchestrator-hook.ts";

const dirs: string[] = [];
const originalCwd = process.cwd();
const originalStateDir = process.env.ULTRATHINK_STATE_DIR;
let warn: Mock<typeof console.warn>;

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "ultrathink-a01-"));
	dirs.push(dir);
	return dir;
}

function logOf(stateDir: string): string {
	return readFileSync(join(stateDir, "a01-failures.log"), "utf8");
}

beforeEach(() => {
	warn = spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
	warn.mockRestore();
	process.chdir(originalCwd);
	if (originalStateDir === undefined) delete process.env.ULTRATHINK_STATE_DIR;
	else process.env.ULTRATHINK_STATE_DIR = originalStateDir;
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("a01 orchestrator hook failure log", () => {
	test("timeout appends a line to <stateDir>/a01-failures.log", async () => {
		const stateDir = join(tempDir(), "state");
		const out = await withA01OrchestratorTimeout(() => new Promise<string>(() => {}), {
			timeoutMs: 20,
			stateDir,
		});
		expect(out).toEqual({ ok: false, timedOut: true });
		const log = logOf(stateDir);
		expect(log).toContain("FAILED (timeout after 20ms)");
		expect(log.trim().split("\n")).toHaveLength(1);
	});

	test("rejection appends the error message and returns it", async () => {
		const stateDir = join(tempDir(), "state");
		const out = await withA01OrchestratorTimeout(__injectFaultForTest("error"), { timeoutMs: 5_000, stateDir });
		expect(out.ok).toBe(false);
		expect(out.error).toContain("sim-error-in-a01");
		expect(logOf(stateDir)).toContain("FAILED: sim-error-in-a01");
	});

	test("failures accumulate in one file; directory and file are private", async () => {
		const stateDir = join(tempDir(), "state");
		for (let i = 0; i < 2; i++) {
			await withA01OrchestratorTimeout(__injectFaultForTest("error"), { timeoutMs: 5_000, stateDir });
		}
		expect(logOf(stateDir).trim().split("\n")).toHaveLength(2);
		expect(statSync(stateDir).mode & 0o777).toBe(0o700);
		expect(statSync(join(stateDir, "a01-failures.log")).mode & 0o777).toBe(0o600);
	});

	test("success writes nothing", async () => {
		const stateDir = join(tempDir(), "state");
		const out = await withA01OrchestratorTimeout(__injectFaultForTest("success", 1), { timeoutMs: 5_000, stateDir });
		expect(out).toEqual({ ok: true, result: "a01-ok" });
		expect(existsSync(stateDir)).toBe(false);
	});

	test("secrets in the failure text and the brief are redacted in the log", async () => {
		const stateDir = join(tempDir(), "state");
		const out = await invokeA01OrchestratorWithGraceful(
			"deploy with key sk-briefsecret123456",
			() => Promise.reject(new Error("401 for sk-livesecret987654321 and Bearer abc.def-ghi123")),
			{ timeoutMs: 5_000, stateDir },
		);
		expect(out.ok).toBe(false);
		const log = logOf(stateDir);
		expect(log).toContain("sk-REDACTED");
		expect(log).toContain("Bearer REDACTED");
		expect(log).not.toContain("livesecret");
		expect(log).not.toContain("briefsecret");
		expect(log).not.toContain("abc.def-ghi123");
	});

	test("without opts.stateDir it uses the resolved host state dir, never <cwd>/.planning", async () => {
		const cwd = tempDir();
		mkdirSync(join(cwd, ".planning"));
		const stateDir = join(tempDir(), "resolved-state");
		process.env.ULTRATHINK_STATE_DIR = stateDir;
		process.chdir(cwd);

		await withA01OrchestratorTimeout(__injectFaultForTest("error"), { timeoutMs: 5_000 });

		expect(logOf(stateDir)).toContain("FAILED: sim-error-in-a01");
		expect(readdirSync(cwd)).toEqual([".planning"]);
		expect(readdirSync(join(cwd, ".planning"))).toEqual([]);
	});

	test("an unwritable state dir never blocks the caller", async () => {
		const blocker = join(tempDir(), "file");
		await Bun.write(blocker, "x");
		const out = await withA01OrchestratorTimeout(__injectFaultForTest("error"), {
			timeoutMs: 5_000,
			stateDir: join(blocker, "state"),
		});
		expect(out.ok).toBe(false);
		expect(out.error).toContain("sim-error-in-a01");
	});
});
