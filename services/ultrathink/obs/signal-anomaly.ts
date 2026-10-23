// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

/**
 * Statistical anomaly detector for one runtime signal (phase 71, CONTEXT D5).
 *
 * An EWMA mean and variance form the baseline. A sample breaches when |z| >= threshold. Raising needs
 * `consecutive` breaching samples in a row; clearing needs `calm` in-bounds samples in a row. The baseline is
 * frozen during a breach run and while active, so a step cannot drag it along. After `rebaseAfter` consecutive
 * breaching samples while active, the detector adopts the current level as the new baseline and clears.
 * Memory is constant: no sample history is kept.
 */

export interface AnomalyOptions {
	alpha?: number;
	threshold?: number;
	warmup?: number;
	consecutive?: number;
	calm?: number;
	rebaseAfter?: number;
}

export interface AnomalyState {
	active: boolean;
	transition?: "raised" | "cleared";
	z: number;
	mean: number;
	samples: number;
}

export interface AnomalyDetector {
	observe(value: number): AnomalyState;
	state(): AnomalyState;
}

interface ResolvedOptions {
	alpha: number;
	threshold: number;
	warmup: number;
	consecutive: number;
	calm: number;
	rebaseAfter: number;
}

const DEFAULTS: ResolvedOptions = {
	alpha: 0.1,
	threshold: 4,
	warmup: 30,
	consecutive: 3,
	calm: 5,
	rebaseAfter: 120,
};

/** Floor on sigma, as a fraction of |mean|, so a flat signal does not turn tiny jitter into breaches. */
const RELATIVE_SIGMA_FLOOR = 0.05;
const ABSOLUTE_SIGMA_FLOOR = 1e-6;

function optionError(name: string, problem: string): RangeError {
	return new RangeError(`anomaly option ${name} ${problem}`);
}

function resolveOptions(options: AnomalyOptions): ResolvedOptions {
	const alpha = options.alpha ?? DEFAULTS.alpha;
	if (!(Number.isFinite(alpha) && alpha > 0 && alpha <= 1)) throw optionError("alpha", "must be in (0, 1]");
	const threshold = options.threshold ?? DEFAULTS.threshold;
	if (!(Number.isFinite(threshold) && threshold > 0)) throw optionError("threshold", "must be a positive number");
	const warmup = options.warmup ?? DEFAULTS.warmup;
	if (!(Number.isInteger(warmup) && warmup >= 0)) throw optionError("warmup", "must be a non-negative integer");
	const consecutive = options.consecutive ?? DEFAULTS.consecutive;
	if (!(Number.isInteger(consecutive) && consecutive >= 1)) throw optionError("consecutive", "must be an integer of at least 1");
	const calm = options.calm ?? DEFAULTS.calm;
	if (!(Number.isInteger(calm) && calm >= 1)) throw optionError("calm", "must be an integer of at least 1");
	const rebaseAfter = options.rebaseAfter ?? DEFAULTS.rebaseAfter;
	if (!(Number.isInteger(rebaseAfter) && rebaseAfter >= 1)) throw optionError("rebaseAfter", "must be an integer of at least 1");
	if (rebaseAfter < consecutive) throw optionError("rebaseAfter", "must be at least consecutive");
	return { alpha, threshold, warmup, consecutive, calm, rebaseAfter };
}

export function createAnomalyDetector(options: AnomalyOptions = {}): AnomalyDetector {
	const o = resolveOptions(options);

	let samples = 0;
	let mean = 0;
	let variance = 0;
	let z = 0;
	let active = false;
	let breachRun = 0;
	let calmRun = 0;

	function snapshot(transition?: "raised" | "cleared"): AnomalyState {
		const out: AnomalyState = { active, z, mean, samples };
		if (transition !== undefined) out.transition = transition;
		return out;
	}

	/** Folds an in-bounds value into the EWMA baseline. Called before `samples` counts this value. */
	function absorb(value: number): void {
		if (samples === 0) {
			mean = value;
			variance = 0;
			return;
		}
		const diff = value - mean;
		const step = o.alpha * diff;
		mean += step;
		variance = (1 - o.alpha) * (variance + diff * step);
	}

	return {
		observe(value: number): AnomalyState {
			if (!Number.isFinite(value)) return snapshot();

			const sigma = Math.max(Math.sqrt(variance), RELATIVE_SIGMA_FLOOR * Math.abs(mean), ABSOLUTE_SIGMA_FLOOR);
			z = samples === 0 ? 0 : (value - mean) / sigma;
			const warming = samples < Math.max(1, o.warmup);
			if (warming) {
				absorb(value);
				samples++;
				return snapshot();
			}
			samples++;

			if (Math.abs(z) >= o.threshold) {
				breachRun++;
				calmRun = 0;
				if (active) {
					if (breachRun >= o.rebaseAfter) {
						mean = value;
						variance = 0;
						active = false;
						breachRun = 0;
						return snapshot("cleared");
					}
					return snapshot();
				}
				if (breachRun >= o.consecutive) {
					active = true;
					calmRun = 0;
					return snapshot("raised");
				}
				return snapshot();
			}

			breachRun = 0;
			if (active) {
				calmRun++;
				if (calmRun >= o.calm) {
					active = false;
					calmRun = 0;
					return snapshot("cleared");
				}
				return snapshot();
			}
			absorb(value);
			return snapshot();
		},

		state(): AnomalyState {
			return snapshot();
		},
	};
}
