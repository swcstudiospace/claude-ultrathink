// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { describe, expect, test } from "bun:test";
import { type AnomalyDetector, type AnomalyState, createAnomalyDetector } from "./signal-anomaly.ts";

const OFFSETS = [0.1, -0.1, 0.05, -0.05, 0, 0.1, -0.1, 0];

function offsetAt(index: number): number {
	return OFFSETS[index % OFFSETS.length] ?? 0;
}

function stableSeries(level: number, count: number, startAt = 0): number[] {
	return Array.from({ length: count }, (_, i) => level + offsetAt(startAt + i));
}

function run(detector: AnomalyDetector, values: readonly number[]): AnomalyState[] {
	return values.map((value) => detector.observe(value));
}

function indicesOf(states: readonly AnomalyState[], transition: "raised" | "cleared"): number[] {
	const out: number[] = [];
	states.forEach((state, index) => {
		if (state.transition === transition) out.push(index);
	});
	return out;
}

describe("createAnomalyDetector", () => {
	test("warmup of wild alternating values reports no transition", () => {
		const detector = createAnomalyDetector();
		const values = Array.from({ length: 30 }, (_, i) => (i % 2 === 0 ? 1 : 1000));
		const states = run(detector, values);
		expect(states.some((state) => state.transition !== undefined)).toBe(false);
		expect(states.some((state) => state.active)).toBe(false);
	});

	test("a deterministic stationary series of 500 samples never raises", () => {
		const detector = createAnomalyDetector();
		const states = run(detector, stableSeries(10, 500));
		expect(indicesOf(states, "raised")).toEqual([]);
		expect(states.some((state) => state.active)).toBe(false);
	});

	test("a sustained step to 3x raises on the consecutive-th breaching sample, exactly once", () => {
		const detector = createAnomalyDetector();
		run(detector, stableSeries(10, 60));
		const states = run(detector, [30, 30, 30, 30, 30]);
		expect(indicesOf(states, "raised")).toEqual([2]);
		expect(states[2]?.active).toBe(true);
		expect(states[1]?.active).toBe(false);
	});

	test("during a breach the baseline mean stays within 1% of the old level", () => {
		const detector = createAnomalyDetector();
		run(detector, stableSeries(10, 60));
		run(detector, [30, 30, 30, 30, 30]);
		const mean = detector.state().mean;
		expect(Math.abs(mean - 10)).toBeLessThan(0.1);
	});

	test("one isolated 3x spike between normal samples never raises", () => {
		const detector = createAnomalyDetector();
		const values = [...stableSeries(10, 60), 30, ...stableSeries(10, 20, 60)];
		const states = run(detector, values);
		expect(indicesOf(states, "raised")).toEqual([]);
		expect(states.some((state) => state.active)).toBe(false);
	});

	test("after raising, a return to the old level clears after `calm` in-bounds samples, exactly once", () => {
		const detector = createAnomalyDetector();
		run(detector, stableSeries(10, 60));
		run(detector, [30, 30, 30]);
		const states = run(detector, stableSeries(10, 5, 60));
		expect(indicesOf(states, "cleared")).toEqual([4]);
		expect(states[3]?.active).toBe(true);
		expect(states[4]?.active).toBe(false);
		expect(indicesOf(run(detector, stableSeries(10, 20, 65)), "cleared")).toEqual([]);
	});

	test("a sustained new level clears after rebaseAfter breaching samples and re-baselines", () => {
		const detector = createAnomalyDetector();
		run(detector, stableSeries(10, 60));
		const states = run(detector, Array.from({ length: 200 }, () => 30));
		expect(indicesOf(states, "raised")).toEqual([2]);
		expect(indicesOf(states, "cleared")).toEqual([119]);
		expect(states[119]?.active).toBe(false);
		expect(states[119]?.mean).toBe(30);
		expect(indicesOf(states.slice(120), "raised")).toEqual([]);
		expect(detector.state().active).toBe(false);
	});

	test("NaN and Infinity leave state deep-equal to its value before the call, even mid-breach", () => {
		const detector = createAnomalyDetector();
		run(detector, stableSeries(10, 40));
		const first = run(detector, [30])[0];
		expect(first?.active).toBe(false);
		for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
			const before = detector.state();
			expect(detector.observe(bad)).toEqual(before);
			expect(detector.state()).toEqual(before);
		}
		const states = run(detector, [30, 30]);
		expect(indicesOf(states, "raised")).toEqual([1]);
	});

	test("alpha 0, threshold 0 and warmup 0.5 each throw RangeError", () => {
		expect(() => createAnomalyDetector({ alpha: 0 })).toThrow(RangeError);
		expect(() => createAnomalyDetector({ threshold: 0 })).toThrow(RangeError);
		expect(() => createAnomalyDetector({ warmup: 0.5 })).toThrow(RangeError);
		expect(() => createAnomalyDetector({ alpha: 1.5 })).toThrow(RangeError);
		expect(() => createAnomalyDetector({ consecutive: 0 })).toThrow(RangeError);
		expect(() => createAnomalyDetector({ calm: 0 })).toThrow(RangeError);
		expect(() => createAnomalyDetector({ consecutive: 3, rebaseAfter: 2 })).toThrow(RangeError);
	});
});
