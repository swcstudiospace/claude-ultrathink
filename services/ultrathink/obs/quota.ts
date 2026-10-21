// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

// Adaptive quota factor (Phase 70, RATE-01). AIMD on process load: each sample is one step.
//
// Pressure (event-loop lag above target, or in-flight utilisation at or above 0.8) halves the
// factor down to `minFactor`. Calm samples add 0.05 back up to 1. The factor scales the request
// windows only; it is not driven by the upstream breaker (CONTEXT decision 1).
//
// Pure: no clock, no I/O. Invalid samples (non-finite or negative) are ignored.

/** One load observation from the runtime probe. `utilisation` is `inflight.count / inflight.max`. */
export interface QuotaSample {
	lagMs: number;
	utilisation: number;
}

export interface AdaptiveQuota {
	/** Current scale in `[minFactor, 1]`. Starts at 1. */
	factor(): number;
	/** Apply one AIMD step for `sample`. Ignored when any field is non-finite or negative. */
	observe(sample: QuotaSample): void;
}

const STEP_DOWN = 0.5;
const STEP_UP = 0.05;
const PRESSURE_UTILISATION = 0.8;

/** Create an adaptive quota. `minFactor` must be in `(0, 1]` and `lagTargetMs` a finite number `>= 0`; otherwise `RangeError`. */
export function createAdaptiveQuota(options: { minFactor: number; lagTargetMs: number }): AdaptiveQuota {
	const { minFactor, lagTargetMs } = options;
	if (!(Number.isFinite(minFactor) && minFactor > 0 && minFactor <= 1)) {
		throw new RangeError(`createAdaptiveQuota: minFactor must be in (0, 1], got ${String(minFactor)}`);
	}
	if (!(Number.isFinite(lagTargetMs) && lagTargetMs >= 0)) {
		throw new RangeError(`createAdaptiveQuota: lagTargetMs must be a finite number >= 0, got ${String(lagTargetMs)}`);
	}

	let factor = 1;
	return {
		factor() {
			return factor;
		},
		observe(sample) {
			const { lagMs, utilisation } = sample;
			if (!Number.isFinite(lagMs) || lagMs < 0) return;
			if (!Number.isFinite(utilisation) || utilisation < 0) return;
			if (lagMs > lagTargetMs || utilisation >= PRESSURE_UTILISATION) {
				factor = Math.max(minFactor, factor * STEP_DOWN);
			} else {
				factor = Math.min(1, factor + STEP_UP);
			}
		},
	};
}
