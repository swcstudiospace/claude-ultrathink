// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

/**
 * Per-minute request history and a short-horizon load forecast.
 *
 * The history is a one-day ring of per-minute admitted-request counts. Holt's
 * linear method forecasts the next 15 minutes; the counts for the same 15
 * minutes one day earlier act as a seasonal floor. The output feeds a gauge and
 * a replica recommendation for an operator or external autoscaler; nothing here
 * scales anything.
 */

const MINUTE_MS = 60_000;
const SLOTS = 1440;
const HORIZON_MINUTES = 15;
const MIN_OBSERVED_MINUTES = 5;
const HOLT_ALPHA = 0.3;
const HOLT_BETA = 0.1;

export interface LoadHistory {
	/** Counts one admitted request in its minute bucket. */
	record(nowMs: number): void;
	/** Forecast peak request rate over the next 15 minutes, in requests per second. */
	forecast(nowMs: number): { rps: number; source: "cold" | "holt" | "holt+yesterday" };
	/** Serialises the ring and its current minute index as JSON text. */
	toJSON(): string;
}

interface RingState {
	/** Minute index of the newest recorded minute; null before the first record. */
	last: number | null;
	/** Counts by slot (minute mod SLOTS); valid for minutes in (last - SLOTS, last]. */
	counts: number[];
}

function minuteOf(nowMs: number): number {
	return Math.floor(nowMs / MINUTE_MS);
}

function slotOf(minute: number): number {
	return ((minute % SLOTS) + SLOTS) % SLOTS;
}

function historyOver(state: RingState): LoadHistory {
	// Count of an absolute minute. Minutes after the newest record, or older than
	// the ring, read as zero: a gap is never stale data.
	const countAt = (minute: number): number => {
		const last = state.last;
		if (last === null || minute > last || minute <= last - SLOTS) return 0;
		return state.counts[slotOf(minute)] ?? 0;
	};

	return {
		record(nowMs) {
			if (!Number.isFinite(nowMs)) return;
			const minute = minuteOf(nowMs);
			const last = state.last;
			// A minute before `last` (clock moved back) is counted into `last`.
			const current = last === null ? minute : Math.max(minute, last);
			if (last !== null && current > last) {
				// Clear every slot the clock passed, so reused slots start at zero.
				const steps = Math.min(current - last, SLOTS);
				for (let k = 1; k <= steps; k++) state.counts[slotOf(last + k)] = 0;
			}
			state.last = current;
			const slot = slotOf(current);
			state.counts[slot] = (state.counts[slot] ?? 0) + 1;
		},

		forecast(nowMs) {
			const last = state.last;
			if (last === null || !Number.isFinite(nowMs)) return { rps: 0, source: "cold" };
			const now = Math.max(minuteOf(nowMs), last);

			let first: number | null = null;
			let observed = 0;
			for (let m = now - SLOTS + 1; m <= now; m++) {
				if (countAt(m) > 0) {
					observed += 1;
					if (first === null) first = m;
				}
			}
			if (first === null || observed < MIN_OBSERVED_MINUTES) {
				return { rps: countAt(now) / 60, source: "cold" };
			}

			// Holt's linear method over every minute from the first observed minute
			// to now, zeros included, initialised from the first two minutes.
			const series: number[] = [];
			for (let m = first; m <= now; m++) series.push(countAt(m));
			const firstCount = series[0] ?? 0;
			const second = series[1] ?? 0;
			let level = second;
			let trend = second - firstCount;
			for (let t = 2; t < series.length; t++) {
				const observedNow = series[t] ?? 0;
				const previous = level;
				level = HOLT_ALPHA * observedNow + (1 - HOLT_ALPHA) * (level + trend);
				trend = HOLT_BETA * (level - previous) + (1 - HOLT_BETA) * trend;
			}
			let peak = 0;
			for (let h = 1; h <= HORIZON_MINUTES; h++) peak = Math.max(peak, level + h * trend);

			// Same 15 minutes one day earlier: a seasonal floor for the forecast.
			let yesterday = 0;
			for (let h = 1; h <= HORIZON_MINUTES; h++) yesterday = Math.max(yesterday, countAt(now + h - SLOTS));
			if (yesterday > peak) return { rps: yesterday / 60, source: "holt+yesterday" };
			return { rps: peak / 60, source: "holt" };
		},

		toJSON() {
			return JSON.stringify({ last: state.last, counts: state.counts });
		},
	};
}

/** Parses the shape `toJSON` writes; any other input yields null. */
function parseState(text: string): RingState | null {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return null;
	}
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
	const { last, counts } = raw as { last?: unknown; counts?: unknown };
	const validCounts = Array.isArray(counts)
		&& counts.length === SLOTS
		&& counts.every((count) => typeof count === "number" && Number.isSafeInteger(count) && count >= 0);
	if (!validCounts) return null;
	const ring = counts as number[];
	if (last === null) return ring.every((count) => count === 0) ? { last: null, counts: ring } : null;
	if (typeof last !== "number" || !Number.isSafeInteger(last)) return null;
	return { last, counts: ring };
}

export function createLoadHistory(): LoadHistory {
	return historyOver({ last: null, counts: new Array<number>(SLOTS).fill(0) });
}

/** Restores a history from `toJSON` text. Any unreadable or malformed text yields an empty history. */
export function loadLoadHistory(text: string): LoadHistory {
	return historyOver(parseState(text) ?? { last: null, counts: new Array<number>(SLOTS).fill(0) });
}

/** Replicas needed to serve `rps` at `capacityRps` each, never fewer than one. */
export function recommendedReplicas(rps: number, capacityRps: number): number {
	if (!Number.isFinite(capacityRps) || capacityRps <= 0) {
		throw new RangeError(`capacityRps must be a positive finite number, got ${capacityRps}`);
	}
	if (!Number.isFinite(rps) || rps < 0) {
		throw new RangeError(`rps must be a non-negative finite number, got ${rps}`);
	}
	return Math.max(1, Math.ceil(rps / capacityRps));
}
