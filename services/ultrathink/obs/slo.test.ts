// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { describe, expect, test } from "bun:test";
import { createSloTracker, type SloDefinition } from "./slo.ts";

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

const definition: SloDefinition = { name: "http_availability", objective: 0.99, windowMs: HOUR_MS };

describe("createSloTracker budget math", () => {
	test("objective 0.99 with 5 bad out of 1000 leaves half the error budget", () => {
		const tracker = createSloTracker(definition, { maxSamples: 10 });
		tracker.observe({ at: 1000, good: 995, total: 1000 });
		const budget = tracker.budget(1000);
		expect(budget.total).toBe(1000);
		expect(budget.bad).toBe(5);
		expect(budget.errorBudgetRemaining).toBeCloseTo(0.5, 9);
	});

	test("burn rate for 10 bad out of 100 at objective 0.99 is 10", () => {
		const tracker = createSloTracker(definition, { maxSamples: 10 });
		tracker.observe({ at: 1000, good: 90, total: 100 });
		expect(tracker.budget(1000).burnRate).toBeCloseTo(10, 6);
	});

	test("a counter reset counts its new value as the delta, so no events are lost or invented", () => {
		const tracker = createSloTracker(definition, { maxSamples: 10 });
		tracker.observe({ at: 1000, good: 900, total: 1000 });
		tracker.observe({ at: 2000, good: 50, total: 60 });
		const budget = tracker.budget(2000);
		expect(budget.total).toBe(1060);
		expect(budget.bad).toBe(110);
		expect(budget.bad).toBeGreaterThanOrEqual(0);
	});

	test("a rejected out-of-order sample is not double counted by the next accepted one", () => {
		const tracker = createSloTracker(definition, { maxSamples: 10 });
		tracker.observe({ at: 2000, good: 10, total: 10 });
		tracker.observe({ at: 1000, good: 20, total: 20 });
		tracker.observe({ at: 3000, good: 30, total: 30 });
		expect(tracker.budget(3000).total).toBe(30);
	});

	test("events older than the window fall out of it but still count in the definition window", () => {
		const tracker = createSloTracker({ ...definition, windowMs: 6 * HOUR_MS }, { maxSamples: 200 });
		tracker.observe({ at: 0, good: 90, total: 100 });
		for (let k = 1; k <= 120; k++) {
			tracker.observe({ at: k * MINUTE_MS, good: 90 + 100 * k, total: 100 + 100 * k });
		}
		const now = 2 * HOUR_MS;
		const lastHour = tracker.budget(now, HOUR_MS);
		expect(lastHour.bad).toBe(0);
		expect(lastHour.total).toBe(6000);
		const sinceStart = tracker.budget(now);
		expect(sinceStart.bad).toBe(10);
		expect(sinceStart.total).toBe(12100);
	});

	test("a window longer than retained history reports the retained span, not the requested window", () => {
		const tracker = createSloTracker(definition, { maxSamples: 5 });
		for (let k = 0; k <= 7; k++) {
			tracker.observe({ at: k * MINUTE_MS, good: k * 100, total: k * 100 });
		}
		const budget = tracker.budget(7 * MINUTE_MS, HOUR_MS);
		expect(budget.observedMs).toBeLessThan(HOUR_MS);
		expect(budget.observedMs).toBe(4 * MINUTE_MS);
	});

	test("a window with no traffic gives undefined error budget and burn rate", () => {
		const tracker = createSloTracker(definition, { maxSamples: 10 });
		tracker.observe({ at: 0, good: 0, total: 0 });
		tracker.observe({ at: 1000, good: 0, total: 0 });
		const budget = tracker.budget(1000);
		expect(budget.total).toBe(0);
		expect(budget.errorBudgetRemaining).toBeUndefined();
		expect(budget.burnRate).toBeUndefined();
	});

	test("memory is bounded: a huge window reports the span from the oldest retained sample", () => {
		const tracker = createSloTracker(definition, { maxSamples: 10 });
		for (let k = 0; k < 100; k++) {
			tracker.observe({ at: k * 1000, good: k, total: k });
		}
		const budget = tracker.budget(99_000, Number.POSITIVE_INFINITY);
		expect(budget.observedMs).toBe(9000);
		expect(budget.total).toBe(10);
	});

	test("invalid objective, window or capacity throws RangeError", () => {
		expect(() => createSloTracker({ ...definition, objective: 0 }, { maxSamples: 10 })).toThrow(RangeError);
		expect(() => createSloTracker({ ...definition, objective: 1 }, { maxSamples: 10 })).toThrow(RangeError);
		expect(() => createSloTracker({ ...definition, objective: Number.NaN }, { maxSamples: 10 })).toThrow(RangeError);
		expect(() => createSloTracker({ ...definition, windowMs: 0 }, { maxSamples: 10 })).toThrow(RangeError);
		expect(() => createSloTracker({ ...definition, windowMs: -1 }, { maxSamples: 10 })).toThrow(RangeError);
		expect(() => createSloTracker(definition, { maxSamples: 1 })).toThrow(RangeError);
		expect(() => createSloTracker(definition, { maxSamples: 2.5 })).toThrow(RangeError);
		expect(() => createSloTracker(definition, { maxSamples: 10 }).budget(0, 0)).toThrow(RangeError);
	});
});
