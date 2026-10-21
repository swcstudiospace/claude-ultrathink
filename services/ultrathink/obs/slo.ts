// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

/**
 * In-process SLO error-budget tracker (phase 71, CONTEXT D7).
 *
 * Callers feed cumulative `good` and `total` counters. The tracker turns them into per-sample deltas (a counter
 * that moved backwards is a reset, and its delta is the new value), keeps the last `maxSamples` deltas in a
 * fixed ring, and answers windowed budget and burn-rate questions from the ring. Memory is bounded by
 * `maxSamples`; history older than the ring is gone, and `observedMs` reports how much of the window it covers.
 */

export interface SloDefinition {
	name: string;
	/** Target good share in (0, 1), for example 0.99. */
	objective: number;
	/** Window in ms over which `errorBudgetRemaining` is computed. */
	windowMs: number;
}

/** `at` is a wall-clock time in ms. `good` and `total` are cumulative counters. */
export interface SloSample {
	at: number;
	good: number;
	total: number;
}

export interface SloBudget {
	/** Span in ms actually covered by the answer; less than the requested window when history is short. */
	observedMs: number;
	total: number;
	bad: number;
	/** `1 - (bad/total) / (1 - objective)` over the definition's window. Negative when the budget is overspent. */
	errorBudgetRemaining: number | undefined;
	/** `(bad/total) / (1 - objective)` over the requested window. */
	burnRate: number | undefined;
}

export interface SloTracker {
	observe(sample: SloSample): void;
	budget(now: number, windowMs?: number): SloBudget;
}

interface Entry {
	at: number;
	cumGood: number;
	cumTotal: number;
	dGood: number;
	dTotal: number;
}

interface Counts {
	observedMs: number;
	total: number;
	bad: number;
}

export function createSloTracker(definition: SloDefinition, options: { maxSamples: number }): SloTracker {
	const { objective } = definition;
	const definedWindowMs = definition.windowMs;
	const capacity = options.maxSamples;
	if (!(Number.isFinite(objective) && objective > 0 && objective < 1)) {
		throw new RangeError("slo objective must be a number in (0, 1)");
	}
	if (!(definedWindowMs > 0)) throw new RangeError("slo windowMs must be greater than 0");
	if (!(Number.isInteger(capacity) && capacity >= 2)) throw new RangeError("slo maxSamples must be an integer of at least 2");

	const ring = new Array<Entry | undefined>(capacity);
	let head = 0;
	let size = 0;
	/** Running sums of the deltas: the cumulative good and total over the whole process lifetime. */
	let accGood = 0;
	let accTotal = 0;
	/** Last accepted raw counters, used to detect resets. Both start at 0 so the first delta is measured from 0. */
	let lastGood = 0;
	let lastTotal = 0;

	function entryAt(index: number): Entry {
		const entry = ring[(head + index) % capacity];
		if (entry === undefined) throw new Error("slo ring read outside retained range");
		return entry;
	}

	function push(entry: Entry): void {
		if (size < capacity) {
			ring[(head + size) % capacity] = entry;
			size++;
			return;
		}
		ring[head] = entry;
		head = (head + 1) % capacity;
	}

	/**
	 * Counts over `windowMs` ending at the newest entry. The reference is the newest entry at or before `now -
	 * windowMs`; when none is retained, the oldest entry's pre-entry state is the reference.
	 */
	function countsOver(now: number, windowMs: number): Counts {
		if (size === 0) return { observedMs: 0, total: 0, bad: 0 };
		const end = entryAt(size - 1);
		const cutoff = now - windowMs;

		let lo = 0;
		let hi = size - 1;
		let reference = -1;
		while (lo <= hi) {
			const mid = (lo + hi) >>> 1;
			if (entryAt(mid).at <= cutoff) {
				reference = mid;
				lo = mid + 1;
			} else {
				hi = mid - 1;
			}
		}

		let refGood: number;
		let refTotal: number;
		let refAt: number;
		if (reference >= 0) {
			const ref = entryAt(reference);
			refGood = ref.cumGood;
			refTotal = ref.cumTotal;
			refAt = ref.at;
		} else {
			const oldest = entryAt(0);
			refGood = oldest.cumGood - oldest.dGood;
			refTotal = oldest.cumTotal - oldest.dTotal;
			refAt = oldest.at;
		}

		const total = end.cumTotal - refTotal;
		const good = end.cumGood - refGood;
		return { observedMs: end.at - refAt, total, bad: total - good };
	}

	return {
		observe(sample: SloSample): void {
			const { at, good, total } = sample;
			if (!(Number.isFinite(at) && Number.isFinite(good) && Number.isFinite(total))) return;
			if (good < 0 || total < 0 || good > total) return;
			// A rejected sample changes nothing: the next accepted one carries its events in its delta.
			if (size > 0 && at < entryAt(size - 1).at) return;

			const dGood = good >= lastGood ? good - lastGood : good;
			const dTotal = total >= lastTotal ? total - lastTotal : total;
			accGood += dGood;
			accTotal += dTotal;
			lastGood = good;
			lastTotal = total;
			push({ at, cumGood: accGood, cumTotal: accTotal, dGood, dTotal });
		},

		budget(now: number, windowMs: number = definedWindowMs): SloBudget {
			if (!(windowMs > 0)) throw new RangeError("slo budget windowMs must be greater than 0");

			const requested = countsOver(now, windowMs);
			const defined = countsOver(now, definedWindowMs);
			const errorBudgetRemaining =
				defined.total > 0 ? 1 - (defined.bad / defined.total) / (1 - objective) : undefined;
			const burnRate = requested.total > 0 ? (requested.bad / requested.total) / (1 - objective) : undefined;

			return {
				observedMs: requested.observedMs,
				total: requested.total,
				bad: requested.bad,
				errorBudgetRemaining,
				burnRate,
			};
		},
	};
}
