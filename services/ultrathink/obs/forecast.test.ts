// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { describe, expect, test } from "bun:test";
import { createLoadHistory, loadLoadHistory, recommendedReplicas, type LoadHistory } from "./forecast.ts";

const MINUTE_MS = 60_000;
const MINUTES_PER_DAY = 1440;

/** Records `count` requests inside minute `minute` (at its 1-second mark). */
function recordRequests(history: LoadHistory, minute: number, count: number): void {
	for (let i = 0; i < count; i++) history.record(minute * MINUTE_MS + 1_000);
}

function at(minute: number): number {
	return minute * MINUTE_MS;
}

describe("createLoadHistory forecast", () => {
	test("constant 60 requests per minute forecasts 1.0 rps from holt", () => {
		const history = createLoadHistory();
		for (let minute = 0; minute < 10; minute++) recordRequests(history, minute, 60);

		const forecast = history.forecast(at(9));
		expect(forecast.source).toBe("holt");
		expect(Math.abs(forecast.rps - 1)).toBeLessThan(1e-9);
	});

	test("a rising series forecasts above its current level", () => {
		const history = createLoadHistory();
		for (let minute = 0; minute < 10; minute++) recordRequests(history, minute, 10 * (minute + 1));

		const currentRps = 100 / 60;
		const forecast = history.forecast(at(9));
		expect(forecast.source).toBe("holt");
		expect(forecast.rps).toBeGreaterThan(currentRps);
	});

	test("a spike recorded yesterday forecasts its minute of day even with zero current load", () => {
		const history = createLoadHistory();
		const spikeMinute = 100;
		const spike = 600;
		recordRequests(history, spikeMinute, spike);
		for (let minute = spikeMinute + 1; minute <= spikeMinute + 4; minute++) recordRequests(history, minute, 1);

		// Current minute is 1439 minutes after the spike: nothing was recorded in the
		// current minute, and the next 15 minutes include spikeMinute + 1440.
		const now = spikeMinute + MINUTES_PER_DAY - 1;
		const forecast = history.forecast(at(now));
		expect(forecast.source).toBe("holt+yesterday");
		expect(forecast.rps).toBeGreaterThanOrEqual(spike / 60 - 1e-9);
	});

	test("fewer than five recorded minutes is cold, reporting the current minute only", () => {
		const history = createLoadHistory();
		for (let minute = 0; minute < 4; minute++) recordRequests(history, minute, 60);

		const forecast = history.forecast(at(3));
		expect(forecast.source).toBe("cold");
		expect(forecast.rps).toBeCloseTo(1, 9);
	});

	test("a gap clears the slots it passes, so stale counts never reappear", () => {
		const history = createLoadHistory();
		recordRequests(history, 0, 600);
		// Minute 1440 reuses slot 0. The 600 requests from minute 0 must be gone.
		history.record(at(MINUTES_PER_DAY));

		const forecast = history.forecast(at(MINUTES_PER_DAY));
		expect(forecast.source).toBe("cold");
		expect(forecast.rps).toBeCloseTo(1 / 60, 12);
	});

	test("recording far after the last minute clears the whole ring", () => {
		const history = createLoadHistory();
		recordRequests(history, 0, 600);
		recordRequests(history, 2000, 1);

		const forecast = history.forecast(at(2000));
		expect(forecast.source).toBe("cold");
		expect(forecast.rps).toBeCloseTo(1 / 60, 12);
	});

	test("JSON round trip preserves the forecast and the serialised form", () => {
		const history = createLoadHistory();
		for (let minute = 0; minute < 30; minute++) recordRequests(history, minute, (minute % 7) + 1);
		const original = history.forecast(at(29));

		const restored = loadLoadHistory(history.toJSON());
		expect(restored.forecast(at(29))).toEqual(original);
		expect(restored.toJSON()).toBe(history.toJSON());
	});

	test("corrupt or wrong-shape text yields an empty history without throwing", () => {
		const valid = createLoadHistory();
		for (let minute = 0; minute < 10; minute++) recordRequests(valid, minute, 60);
		const negativeCount = JSON.parse(valid.toJSON()) as { last: number; counts: number[] };
		negativeCount.counts[5] = -1;

		const inputs = ["not json", "{}", "[-1]", JSON.stringify(negativeCount), JSON.stringify({ last: 3, counts: [1, 2] })];
		for (const text of inputs) {
			const history = loadLoadHistory(text);
			expect(history.forecast(at(9))).toEqual({ rps: 0, source: "cold" });
			expect(() => history.record(at(9))).not.toThrow();
		}
	});
});

describe("recommendedReplicas", () => {
	test("returns one replica at zero load and at exactly capacity", () => {
		expect(recommendedReplicas(0, 20)).toBe(1);
		expect(recommendedReplicas(20, 20)).toBe(1);
	});

	test("rounds up just above capacity", () => {
		expect(recommendedReplicas(20.0001, 20)).toBe(2);
		expect(recommendedReplicas(40, 20)).toBe(2);
		expect(recommendedReplicas(40.5, 20)).toBe(3);
	});

	test("throws RangeError for non-positive capacity", () => {
		expect(() => recommendedReplicas(10, 0)).toThrow(RangeError);
		expect(() => recommendedReplicas(10, -1)).toThrow(RangeError);
	});
});
