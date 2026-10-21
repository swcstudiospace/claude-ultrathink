// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

// Load shedding, drain-aware readiness and runtime probes (Refs SPE-17437).
//
// Intended wiring:
// - The router calls `Inflight.enter()` for every non-health request. `null` means the
//   service is saturated and the router answers 503 (with `Retry-After`) without doing any
//   work. `/healthz`, `/readyz` and `/metrics` are exempt so operators can always observe
//   the process. The release function runs in a `finally` once the response has been sent.
// - `DrainState.begin()` is called from the SIGTERM handler. `/readyz` returns 503 while
//   `draining` so the load balancer stops routing new traffic; in-flight requests finish.
// - `createRuntimeProbe` samples event-loop lag, RSS and heap on an interval. The
//   integrator forwards each `RuntimeSample` into metrics gauges
//   (`ultrathink_event_loop_lag_seconds`, `ultrathink_process_rss_bytes`, ...).
//
// This module is pure: it never logs and never throws on the request path. Construction
// validates its inputs and throws `RangeError`/`TypeError` for invalid configuration.

/** Bounded in-flight request counter used for load shedding. */
export interface Inflight {
	/** Requests currently admitted and not yet released. Never negative. */
	readonly count: number;
	/** Capacity passed to `createInflight`. */
	readonly max: number;
	/**
	 * Admit one request. Returns `null` when `count === max` (caller answers 503);
	 * otherwise a release function. Release is idempotent: calling it more than once
	 * never decrements the count below what a single release would leave.
	 */
	enter(): (() => void) | null;
}

/**
 * Create an in-flight counter. `max` must be a positive safe integer, otherwise a
 * `RangeError` is thrown at construction (fail closed on misconfiguration).
 */
export function createInflight(max: number): Inflight {
	if (!Number.isSafeInteger(max) || max <= 0) {
		throw new RangeError(`createInflight: max must be a positive safe integer, got ${String(max)}`);
	}
	let count = 0;
	return {
		get count() {
			return count;
		},
		get max() {
			return max;
		},
		enter() {
			if (count >= max) return null;
			count++;
			let released = false;
			return () => {
				if (released) return;
				released = true;
				if (count > 0) count--;
			};
		},
	};
}

/** Shutdown state consulted by `/readyz`. */
export interface DrainState {
	/** True once `begin()` has been called; never reverts. */
	readonly draining: boolean;
	/** Clock value (ms) of the first `begin()` call; `undefined` while not draining. */
	readonly since: number | undefined;
	/** Enter the draining state. Idempotent: later calls keep the original `since`. */
	begin(): void;
}

/**
 * Create a drain state. `now` defaults to `Date.now` and is only read on the first
 * `begin()`.
 */
export function createDrainState(now: () => number = Date.now): DrainState {
	if (typeof now !== "function") throw new TypeError("createDrainState: now must be a function");
	let since: number | undefined;
	return {
		get draining() {
			return since !== undefined;
		},
		get since() {
			return since;
		},
		begin() {
			if (since === undefined) since = now();
		},
	};
}

/** One runtime observation. All values are finite and non-negative. */
export interface RuntimeSample {
	/** Last measured event-loop lag: how late the probe timer fired versus its schedule. */
	eventLoopLagMs: number;
	rssBytes: number;
	heapUsedBytes: number;
	uptimeSec: number;
}

/** Timer handle as returned by `setTimer`; `unref` is optional for injected timers. */
export type RuntimeTimerHandle = { unref?: () => void } & object;

export interface RuntimeProbeOptions {
	/** Sampling period in milliseconds; must be a positive finite number. */
	intervalMs: number;
	/** Receives every sample taken by the timer. Exceptions are swallowed. */
	onSample: (sample: RuntimeSample) => void;
	/**
	 * Defaults to `setTimeout`. The probe calls `unref()` on every returned handle that
	 * has one, so the timer never keeps the process alive.
	 */
	setTimer?: (run: () => void, ms: number) => RuntimeTimerHandle;
	/** Defaults to `clearTimeout`. */
	clearTimer?: (handle: object) => void;
	/** Monotonic millisecond clock used for lag measurement. Defaults to `performance.now`. */
	now?: () => number;
	/** Memory source. Defaults to `process.memoryUsage()`. */
	memory?: () => { rss: number; heapUsed: number };
	/** Uptime source in seconds. Defaults to `process.uptime()`. */
	uptime?: () => number;
}

export interface RuntimeProbe {
	/**
	 * Begin periodic sampling. Returns a stop function that is idempotent. Calling
	 * `start()` while already running does not schedule a second timer; it returns a
	 * stop function for the same run.
	 */
	start(): () => void;
	/**
	 * Take a sample synchronously without the timer. `eventLoopLagMs` is the lag measured
	 * by the most recent timer tick (0 before any tick). Errors thrown by an injected
	 * `memory`/`uptime` source propagate from this method only; the timer path swallows
	 * them and skips that sample.
	 */
	sampleOnce(): RuntimeSample;
}

function nonNegative(value: number): number {
	return Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Create a runtime probe. Event-loop lag is `max(0, wake - scheduled)` where `scheduled`
 * is the clock value at scheduling plus `intervalMs`. Invalid options throw at
 * construction; nothing thrown by `onSample` escapes the timer.
 */
export function createRuntimeProbe(options: RuntimeProbeOptions): RuntimeProbe {
	const { intervalMs, onSample } = options;
	if (typeof intervalMs !== "number" || !Number.isFinite(intervalMs) || intervalMs <= 0) {
		throw new RangeError(`createRuntimeProbe: intervalMs must be a positive finite number, got ${String(intervalMs)}`);
	}
	if (typeof onSample !== "function") throw new TypeError("createRuntimeProbe: onSample must be a function");
	const setTimer = options.setTimer ?? ((run: () => void, ms: number) => setTimeout(run, ms));
	const clearTimer = options.clearTimer ?? ((handle: object) => clearTimeout(handle as NodeJS.Timeout));
	const now = options.now ?? (() => performance.now());
	const memory = options.memory ?? (() => process.memoryUsage());
	const uptime = options.uptime ?? (() => process.uptime());

	let lastLagMs = 0;
	let handle: RuntimeTimerHandle | undefined;
	let generation = 0;
	let stop: (() => void) | undefined;

	function sampleOnce(): RuntimeSample {
		const mem = memory();
		return {
			eventLoopLagMs: lastLagMs,
			rssBytes: nonNegative(mem.rss),
			heapUsedBytes: nonNegative(mem.heapUsed),
			uptimeSec: nonNegative(uptime()),
		};
	}

	function schedule(gen: number): void {
		const scheduled = now() + intervalMs;
		handle = setTimer(() => {
			if (gen !== generation) return; // stopped while the timer was pending
			handle = undefined;
			lastLagMs = nonNegative(now() - scheduled);
			let sample: RuntimeSample | undefined;
			try {
				sample = sampleOnce();
			} catch {
				sample = undefined;
			}
			if (sample !== undefined) {
				try {
					onSample(sample);
				} catch {
					// Observers must never break the sampler.
				}
			}
			if (gen === generation) schedule(gen);
		}, intervalMs);
		handle.unref?.();
	}

	return {
		start() {
			if (stop !== undefined) return stop;
			const gen = ++generation;
			schedule(gen);
			const stopFn = (): void => {
				if (gen !== generation) return;
				generation++;
				stop = undefined;
				if (handle !== undefined) {
					const pending = handle;
					handle = undefined;
					try {
						clearTimer(pending);
					} catch {
						// A failing clearTimer leaves a dead timer; the generation guard ignores it.
					}
				}
			};
			stop = stopFn;
			return stopFn;
		},
		sampleOnce,
	};
}
