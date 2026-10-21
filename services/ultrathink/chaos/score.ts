// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import type { HistoryRecord } from "./run.ts";

export interface Trend {
	slope: number;
	latest: number;
	mean: number;
}

export interface Resilience {
	runs: number;
	mean: number | undefined;
	trend: Trend | undefined;
}

// Run score: 100 x passed / total hypotheses. An empty run has no score, so it throws.
export function scoreRun(results: { passed: boolean }[]): number {
	if (results.length === 0) throw new RangeError("scoreRun needs at least one hypothesis result");
	let passed = 0;
	for (const result of results) if (result.passed) passed += 1;
	return (100 * passed) / results.length;
}

// Least-squares slope of the scores against their index 0..n-1. Undefined below two points,
// where a slope does not exist.
export function trend(scores: number[]): Trend | undefined {
	const n = scores.length;
	if (n < 2) return undefined;
	const meanX = (n - 1) / 2;
	const meanY = meanOf(scores);
	let numerator = 0;
	let denominator = 0;
	let latest = 0;
	for (const [i, score] of scores.entries()) {
		const dx = i - meanX;
		numerator += dx * (score - meanY);
		denominator += dx * dx;
		latest = score;
	}
	return { slope: numerator / denominator, latest, mean: meanY };
}

// Resilience of one template over its last `window` runs, taken in seq order.
// With no runs the mean and trend are undefined rather than NaN.
export function resilience(records: HistoryRecord[], templateId: string, window = 20): Resilience {
	if (!Number.isInteger(window) || window < 1) throw new RangeError("resilience window must be a positive integer");
	const scores = records
		.filter((record) => record.templateId === templateId)
		.sort((a, b) => a.seq - b.seq)
		.slice(-window)
		.map((record) => record.score);
	if (scores.length === 0) return { runs: 0, mean: undefined, trend: undefined };
	return { runs: scores.length, mean: meanOf(scores), trend: trend(scores) };
}

function meanOf(values: number[]): number {
	let sum = 0;
	for (const value of values) sum += value;
	return sum / values.length;
}
