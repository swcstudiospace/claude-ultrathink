// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claimTurn } from "./claim.ts";

const dirs: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "ultrathink-claim-"));
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("claimTurn", () => {
	test("the first hook for a turn wins; a repeat loses; another turn is independent", () => {
		const stateDir = tempDir();
		expect(claimTurn(stateDir, "s1:p1")).toBe(true);
		expect(claimTurn(stateDir, "s1:p1")).toBe(false);
		expect(claimTurn(stateDir, "s1:p2")).toBe(true);
	});

	test("a claim older than 24h is pruned so the key can be claimed again", () => {
		const stateDir = tempDir();
		expect(claimTurn(stateDir, "s1:p1")).toBe(true);
		const claims = join(stateDir, "claims");
		const stale = (Date.now() - 25 * 60 * 60 * 1000) / 1000;
		for (const name of readdirSync(claims)) utimesSync(join(claims, name), stale, stale);
		expect(claimTurn(stateDir, "s1:p1")).toBe(true);
		expect(claimTurn(stateDir, "s1:p1")).toBe(false);
	});

	test("an unwritable state dir fails open", () => {
		const blocker = join(tempDir(), "not-a-dir");
		writeFileSync(blocker, "");
		expect(claimTurn(join(blocker, "state"), "s1:p1")).toBe(true);
		expect(claimTurn(join(blocker, "state"), "s1:p1")).toBe(true);
	});
});
