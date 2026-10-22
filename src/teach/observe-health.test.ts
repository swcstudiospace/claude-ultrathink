// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { observeHealthPart, readObserveHealth, recordObserveFailure, recordObserveOk, shouldNotifyFailure } from "./observe-health.ts";

let root: string;
let stateDir: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "ut-observe-health-"));
	stateDir = join(root, "state");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const T1 = new Date("2026-10-20T07:07:49.000Z");
const T2 = new Date("2026-10-21T10:00:00.000Z");

describe("observe health", () => {
	test("no file means healthy, and nothing is shown", () => {
		expect(readObserveHealth(stateDir)).toBeUndefined();
		expect(observeHealthPart(stateDir)).toBeUndefined();
	});

	test("failures count up, keep the streak start and the newest reason", () => {
		recordObserveFailure(stateDir, "distiller failed: credit balance is too low", T1);
		const health = recordObserveFailure(stateDir, "distiller failed: still too low", T2);
		expect(health).toMatchObject({ failures: 2, failingSince: T1.toISOString(), lastFailureAt: T2.toISOString(), reason: "distiller failed: still too low" });
		expect(observeHealthPart(stateDir)).toBe("observe failing ×2 since 2026-10-20 07:07 UTC (distiller failed: still too low)");
		expect(statSync(join(stateDir, "teach", "observe-health.json")).mode & 0o777).toBe(0o600);
	});

	test("a reason is redacted and clipped", () => {
		const key = `sk-ant-api03-${"x".repeat(60)}`;
		recordObserveFailure(stateDir, `distiller failed: bad key ${key} ${"y".repeat(200)}`, T1);
		const stored = readFileSync(join(stateDir, "teach", "observe-health.json"), "utf8");
		expect(stored).not.toContain(key);
		expect((readObserveHealth(stateDir)?.reason ?? "").length).toBeLessThanOrEqual(80);
	});

	test("an answered run clears the streak", () => {
		recordObserveFailure(stateDir, "no engine: login required", T1);
		recordObserveOk(stateDir, T2);
		expect(readObserveHealth(stateDir)).toEqual({ failures: 0, lastOkAt: T2.toISOString() });
		expect(observeHealthPart(stateDir)).toBeUndefined();
	});

	test("an answered run creates nothing when there was never a failure", () => {
		recordObserveOk(stateDir, T2);
		expect(existsSync(join(stateDir, "teach"))).toBe(false);
	});

	test("a corrupt file reads as unknown and the next failure starts over", () => {
		mkdirSync(join(stateDir, "teach"), { recursive: true });
		writeFileSync(join(stateDir, "teach", "observe-health.json"), "{not json");
		expect(readObserveHealth(stateDir)).toBeUndefined();
		expect(recordObserveFailure(stateDir, "error: boom", T1)?.failures).toBe(1);
	});

	test("an unwritable state dir never throws", () => {
		writeFileSync(join(root, "file"), "x");
		expect(recordObserveFailure(join(root, "file"), "error", T1)).toBeUndefined();
		expect(() => recordObserveOk(join(root, "file"), T1)).not.toThrow();
	});

	test("a receipt is due on the first failure of a streak and every tenth", () => {
		expect(shouldNotifyFailure(undefined)).toBe(false);
		expect([1, 2, 9, 10, 11, 20].map((failures) => shouldNotifyFailure({ failures }))).toEqual([true, false, false, true, false, true]);
	});
});
