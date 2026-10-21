// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { describe, expect, test } from "bun:test";
import type { HistoryRecord } from "./run.ts";
import { resilience, scoreRun, trend } from "./score.ts";

function record(seq: number, templateId: string, score: number): HistoryRecord {
	return {
		seq,
		templateId,
		driver: "inprocess",
		startedAt: "2026-10-21T10:00:00.000Z",
		finishedAt: "2026-10-21T10:00:05.000Z",
		settled: true,
		hypotheses: [{ id: "h1", passed: score === 100 }],
		passed: score === 100,
		score,
		rollback: "not_needed",
	};
}

describe("scoreRun", () => {
	test("is 100 times passed over total", () => {
		expect(scoreRun([{ passed: true }, { passed: true }, { passed: true }, { passed: false }])).toBe(75);
	});

	test("is 100 when every hypothesis passed and 0 when none did", () => {
		expect(scoreRun([{ passed: true }, { passed: true }])).toBe(100);
		expect(scoreRun([{ passed: false }])).toBe(0);
	});

	test("throws RangeError for an empty run", () => {
		expect(() => scoreRun([])).toThrow(RangeError);
	});
});

describe("trend", () => {
	test("falling scores have the least-squares slope against index", () => {
		expect(trend([90, 80, 70])).toEqual({ slope: -10, latest: 70, mean: 80 });
	});

	test("flat scores have slope 0", () => {
		const flat = trend([50, 50, 50]);
		expect(flat?.slope).toBe(0);
		expect(flat?.latest).toBe(50);
		expect(flat?.mean).toBe(50);
	});

	test("rising scores have a positive slope", () => {
		expect(trend([0, 50, 100])).toEqual({ slope: 50, latest: 100, mean: 50 });
	});

	test("is undefined below two runs, not 0", () => {
		expect(trend([42])).toBeUndefined();
		expect(trend([])).toBeUndefined();
	});
});

describe("resilience", () => {
	test("uses the last 20 runs by default, in seq order, regardless of array order", () => {
		const records = Array.from({ length: 25 }, (_, i) => record(i + 1, "orders", i < 5 ? 0 : 100)).reverse();
		const result = resilience(records, "orders");
		expect(result.runs).toBe(20);
		expect(result.mean).toBe(100);
		expect(result.trend?.slope).toBe(0);
	});

	test("orders the window by seq, not by array position", () => {
		const records = [record(3, "orders", 30), record(1, "orders", 10), record(2, "orders", 20)];
		const result = resilience(records, "orders", 2);
		expect(result.runs).toBe(2);
		expect(result.mean).toBe(25);
		expect(result.trend).toEqual({ slope: 10, latest: 30, mean: 25 });
	});

	test("ignores runs of other templates", () => {
		const records = [record(1, "orders", 100), record(2, "cart", 0), record(3, "orders", 50)];
		const result = resilience(records, "orders");
		expect(result.runs).toBe(2);
		expect(result.mean).toBe(75);
	});

	test("reports no runs with undefined mean and trend", () => {
		expect(resilience([], "orders")).toEqual({ runs: 0, mean: undefined, trend: undefined });
		expect(resilience([record(1, "cart", 100)], "orders")).toEqual({ runs: 0, mean: undefined, trend: undefined });
	});

	test("rejects a window below 1", () => {
		expect(() => resilience([record(1, "orders", 50)], "orders", 0)).toThrow(RangeError);
	});
});
