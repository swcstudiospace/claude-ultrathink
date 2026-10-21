// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { describe, expect, test } from "bun:test";
import { createAdaptiveQuota } from "./quota.ts";

const calm = { lagMs: 0, utilisation: 0 };
const pressured = { lagMs: 1000, utilisation: 0 };

describe("createAdaptiveQuota AIMD steps", () => {
	test("starts at factor 1", () => {
		expect(createAdaptiveQuota({ minFactor: 0.5, lagTargetMs: 100 }).factor()).toBe(1);
	});

	test("pressure from 1 with floor 0.5: after 1 sample 0.5, after 2 samples still 0.5", () => {
		const quota = createAdaptiveQuota({ minFactor: 0.5, lagTargetMs: 100 });
		quota.observe(pressured);
		expect(quota.factor()).toBe(0.5);
		quota.observe(pressured);
		expect(quota.factor()).toBe(0.5);
	});

	test("sustained pressure walks 1 -> 0.5 -> floor and stops at the floor", () => {
		const quota = createAdaptiveQuota({ minFactor: 0.1, lagTargetMs: 100 });
		const walked: number[] = [];
		for (let i = 0; i < 5; i++) {
			quota.observe(pressured);
			walked.push(quota.factor());
		}
		expect(walked[0]).toBe(0.5);
		expect(walked[1]).toBe(0.25);
		expect(walked[2]).toBeCloseTo(0.125, 12);
		expect(walked[3]).toBe(0.1);
		expect(walked[4]).toBe(0.1);
	});

	test("calm recovery from 0.5 to 1 takes 10 samples and never rises above 1", () => {
		const quota = createAdaptiveQuota({ minFactor: 0.5, lagTargetMs: 100 });
		quota.observe(pressured);
		expect(quota.factor()).toBe(0.5);
		for (let i = 1; i <= 10; i++) {
			quota.observe(calm);
			expect(quota.factor()).toBeLessThanOrEqual(1);
			if (i === 9) expect(quota.factor()).toBeCloseTo(0.95, 9);
		}
		expect(quota.factor()).toBeCloseTo(1, 9);
		quota.observe(calm);
		expect(quota.factor()).toBe(1);
	});
});

describe("createAdaptiveQuota pressure boundaries", () => {
	test("lag equal to the target is calm; lag one above is pressure", () => {
		const atTarget = createAdaptiveQuota({ minFactor: 0.1, lagTargetMs: 100 });
		atTarget.observe(pressured);
		expect(atTarget.factor()).toBe(0.5);
		atTarget.observe({ lagMs: 100, utilisation: 0 });
		expect(atTarget.factor()).toBeCloseTo(0.55, 9);

		const aboveTarget = createAdaptiveQuota({ minFactor: 0.1, lagTargetMs: 100 });
		aboveTarget.observe(pressured);
		aboveTarget.observe({ lagMs: 101, utilisation: 0 });
		expect(aboveTarget.factor()).toBe(0.25);
	});

	test("utilisation 0.8 is pressure at zero lag; 0.79 is calm", () => {
		const atBoundary = createAdaptiveQuota({ minFactor: 0.1, lagTargetMs: 100 });
		atBoundary.observe({ lagMs: 0, utilisation: 0.8 });
		expect(atBoundary.factor()).toBe(0.5);

		const belowBoundary = createAdaptiveQuota({ minFactor: 0.1, lagTargetMs: 100 });
		belowBoundary.observe(pressured);
		belowBoundary.observe({ lagMs: 0, utilisation: 0.79 });
		expect(belowBoundary.factor()).toBeCloseTo(0.55, 9);
	});
});

describe("createAdaptiveQuota ignored inputs", () => {
	test("NaN, Infinity and negative values change nothing", () => {
		const quota = createAdaptiveQuota({ minFactor: 0.1, lagTargetMs: 100 });
		quota.observe(pressured);
		expect(quota.factor()).toBe(0.5);

		// Each of these would move the factor if it were accepted: NaN and -1 lag are calm
		// (+0.05), Infinity lag and Infinity utilisation are pressure (x0.5).
		quota.observe({ lagMs: Number.NaN, utilisation: 0 });
		expect(quota.factor()).toBe(0.5);
		quota.observe({ lagMs: -1, utilisation: 0 });
		expect(quota.factor()).toBe(0.5);
		quota.observe({ lagMs: Number.POSITIVE_INFINITY, utilisation: 0 });
		expect(quota.factor()).toBe(0.5);
		quota.observe({ lagMs: Number.NEGATIVE_INFINITY, utilisation: 0 });
		expect(quota.factor()).toBe(0.5);
		quota.observe({ lagMs: 0, utilisation: -1 });
		expect(quota.factor()).toBe(0.5);
		quota.observe({ lagMs: 0, utilisation: Number.NaN });
		expect(quota.factor()).toBe(0.5);
		quota.observe({ lagMs: 0, utilisation: Number.POSITIVE_INFINITY });
		expect(quota.factor()).toBe(0.5);
	});
});

describe("createAdaptiveQuota option validation", () => {
	test("minFactor outside (0, 1] throws RangeError", () => {
		expect(() => createAdaptiveQuota({ minFactor: 0, lagTargetMs: 100 })).toThrow(RangeError);
		expect(() => createAdaptiveQuota({ minFactor: -0.5, lagTargetMs: 100 })).toThrow(RangeError);
		expect(() => createAdaptiveQuota({ minFactor: 1.01, lagTargetMs: 100 })).toThrow(RangeError);
		expect(() => createAdaptiveQuota({ minFactor: Number.NaN, lagTargetMs: 100 })).toThrow(RangeError);
		expect(() => createAdaptiveQuota({ minFactor: Number.POSITIVE_INFINITY, lagTargetMs: 100 })).toThrow(RangeError);
	});

	test("minFactor 1 is accepted and pins the factor at 1", () => {
		const quota = createAdaptiveQuota({ minFactor: 1, lagTargetMs: 100 });
		quota.observe(pressured);
		expect(quota.factor()).toBe(1);
	});

	test("lagTargetMs NaN, Infinity and negative throw RangeError", () => {
		expect(() => createAdaptiveQuota({ minFactor: 0.5, lagTargetMs: Number.NaN })).toThrow(RangeError);
		expect(() => createAdaptiveQuota({ minFactor: 0.5, lagTargetMs: Number.POSITIVE_INFINITY })).toThrow(RangeError);
		expect(() => createAdaptiveQuota({ minFactor: 0.5, lagTargetMs: Number.NEGATIVE_INFINITY })).toThrow(RangeError);
		expect(() => createAdaptiveQuota({ minFactor: 0.5, lagTargetMs: -1 })).toThrow(RangeError);
	});

	test("lagTargetMs 0 is accepted and any positive lag is pressure", () => {
		const quota = createAdaptiveQuota({ minFactor: 0.5, lagTargetMs: 0 });
		quota.observe({ lagMs: 0.001, utilisation: 0 });
		expect(quota.factor()).toBe(0.5);
	});
});
