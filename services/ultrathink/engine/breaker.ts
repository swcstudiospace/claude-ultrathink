// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

/**
 * Upstream circuit breaker for the OpenRouter completer (Refs SPE-17437).
 *
 * Pure state machine, no I/O, no logging and no timers: time comes from the
 * injected `now` clock and every transition is reported through
 * `onTransition` so the integrator can wire logs and metrics.
 *
 * States:
 * - `closed`: calls flow; failures are counted in a fixed window of `windowMs`
 *   starting at the first failure. When the window rolls the count restarts
 *   at the new failure. Reaching `failureThreshold` inside one window opens
 *   the breaker.
 * - `open`: `tryAcquire` refuses with the remaining `retryAfterMs` until
 *   `openMs` has elapsed since `openedAt`; the first `tryAcquire` after that
 *   moves to `half_open` and hands out a probe slot.
 * - `half_open`: at most `halfOpenMaxCalls` probes in flight; extra callers
 *   are refused with `retryAfterMs = HALF_OPEN_RETRY_MS` so they back off
 *   briefly instead of hammering. A probe released with `success` closes the
 *   breaker and resets counters; `failure` re-opens it with a fresh
 *   `openedAt`; `ignored` only frees the slot.
 *
 * `state()` and `snapshot()` are pure reads of the stored state: an open
 * breaker whose `openMs` has elapsed still reports `open` until a caller asks
 * for a probe slot via `tryAcquire`, which is the only place the
 * open -> half_open transition happens (so `onTransition` fires exactly once,
 * for the request that gets the probe).
 *
 * Fail-open semantics belong to the caller: this module only refuses slots.
 * The completer maps a refusal to `upstream_unavailable` and the service keeps
 * serving every non-planning tool while the upstream is cut off. Nothing here
 * throws after construction; `onTransition` exceptions are swallowed.
 */

export type BreakerState = "closed" | "open" | "half_open";

export interface CircuitBreakerOptions {
	/** Failures inside one window that open the breaker; `>= 1`. */
	failureThreshold: number;
	/** Fixed failure-counting window while closed, in ms. */
	windowMs: number;
	/** Time the breaker stays open before allowing a probe, in ms. */
	openMs: number;
	/** Probes allowed in flight while half-open; default 1. */
	halfOpenMaxCalls?: number;
	/** Clock in ms; default `Date.now`. */
	now?: () => number;
	/** Called after each state change, in order; a throwing hook is ignored. */
	onTransition?: (from: BreakerState, to: BreakerState) => void;
}

/** Result of one `release` on an acquired slot. */
export type ReleaseOutcome = "success" | "failure" | "ignored";

export type Acquire =
	| { ok: true; release: (outcome: ReleaseOutcome) => void }
	| { ok: false; state: "open"; retryAfterMs: number };

export interface CircuitBreakerSnapshot {
	state: BreakerState;
	/**
	 * Failures in the current window while closed; frozen at the count that
	 * opened the breaker while open/half-open (a failed probe adds one); 0
	 * after a successful probe closes it.
	 */
	failures: number;
	/** Clock value of the last close -> open or half_open -> open transition. */
	openedAt?: number;
	/** State transitions since construction. */
	transitions: number;
}

export interface CircuitBreaker {
	state(): BreakerState;
	/** Never throws. Call `release` exactly once per `{ ok: true }` result; extra calls are no-ops. */
	tryAcquire(): Acquire;
	/** Counters for metrics. */
	snapshot(): CircuitBreakerSnapshot;
}

/** `retryAfterMs` handed to callers refused because every half-open probe slot is taken. */
export const HALF_OPEN_RETRY_MS = 1000;

function requirePositiveInteger(name: string, value: unknown): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
		throw new RangeError(`circuit breaker: ${name} must be a positive safe integer`);
	}
	return value;
}

/** Build a breaker; throws `RangeError` on invalid options, never afterwards. */
export function createCircuitBreaker(options: CircuitBreakerOptions): CircuitBreaker {
	const failureThreshold = requirePositiveInteger("failureThreshold", options.failureThreshold);
	const windowMs = requirePositiveInteger("windowMs", options.windowMs);
	const openMs = requirePositiveInteger("openMs", options.openMs);
	const halfOpenMaxCalls =
		options.halfOpenMaxCalls === undefined ? 1 : requirePositiveInteger("halfOpenMaxCalls", options.halfOpenMaxCalls);
	if (options.now !== undefined && typeof options.now !== "function") {
		throw new RangeError("circuit breaker: now must be a function");
	}
	if (options.onTransition !== undefined && typeof options.onTransition !== "function") {
		throw new RangeError("circuit breaker: onTransition must be a function");
	}
	const now = options.now ?? Date.now;
	const onTransition = options.onTransition;

	let state: BreakerState = "closed";
	let failures = 0;
	let windowStart: number | undefined;
	let openedAt: number | undefined;
	let transitions = 0;
	/** Increments on every transition; stale probe releases compare against it. */
	let generation = 0;
	let inFlight = 0;

	function transition(to: BreakerState): void {
		const from = state;
		state = to;
		transitions += 1;
		generation += 1;
		inFlight = 0;
		if (onTransition !== undefined) {
			try {
				onTransition(from, to);
			} catch {
				// Hooks must not affect the request path.
			}
		}
	}

	function open(t: number): void {
		openedAt = t;
		transition("open");
	}

	function recordClosedFailure(t: number): void {
		if (windowStart === undefined || t - windowStart >= windowMs) {
			windowStart = t;
			failures = 1;
		} else {
			failures += 1;
		}
		if (failures >= failureThreshold) {
			open(t);
		}
	}

	function closedAcquire(): Acquire {
		let released = false;
		return {
			ok: true,
			release: (outcome) => {
				if (released) {
					return;
				}
				released = true;
				// Only failures observed while still closed count; once the breaker
				// has opened, probes decide the next state.
				if (outcome === "failure" && state === "closed") {
					recordClosedFailure(now());
				}
			},
		};
	}

	function probeAcquire(): Acquire {
		const probeGeneration = generation;
		inFlight += 1;
		let released = false;
		return {
			ok: true,
			release: (outcome) => {
				if (released) {
					return;
				}
				released = true;
				if (probeGeneration !== generation) {
					// Another probe already moved the breaker on; this result is stale.
					return;
				}
				inFlight -= 1;
				if (outcome === "success") {
					failures = 0;
					windowStart = undefined;
					transition("closed");
				} else if (outcome === "failure") {
					failures += 1;
					open(now());
				}
			},
		};
	}

	return {
		state: () => state,
		tryAcquire: () => {
			if (state === "open") {
				const t = now();
				const elapsed = t - (openedAt as number);
				if (elapsed < openMs) {
					return { ok: false, state: "open", retryAfterMs: Math.min(openMs, Math.max(1, openMs - elapsed)) };
				}
				transition("half_open");
			}
			if (state === "half_open") {
				if (inFlight >= halfOpenMaxCalls) {
					return { ok: false, state: "open", retryAfterMs: HALF_OPEN_RETRY_MS };
				}
				return probeAcquire();
			}
			return closedAcquire();
		},
		snapshot: () => ({
			state,
			failures,
			...(openedAt === undefined ? {} : { openedAt }),
			transitions,
		}),
	};
}
