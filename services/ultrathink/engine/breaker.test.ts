// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { describe, expect, test } from "bun:test";
import {
	type Acquire,
	type BreakerState,
	type CircuitBreaker,
	type CircuitBreakerOptions,
	createCircuitBreaker,
	HALF_OPEN_RETRY_MS,
} from "./breaker.ts";

function clock(start = 1_000_000): { now: () => number; advance: (ms: number) => void; set: (t: number) => void } {
	let t = start;
	return { now: () => t, advance: (ms) => (t += ms), set: (v) => (t = v) };
}

function harness(overrides: Partial<CircuitBreakerOptions> = {}) {
	const c = clock();
	const transitions: Array<[BreakerState, BreakerState]> = [];
	const breaker = createCircuitBreaker({
		failureThreshold: 3,
		windowMs: 10_000,
		openMs: 30_000,
		now: c.now,
		onTransition: (from, to) => transitions.push([from, to]),
		...overrides,
	});
	return { breaker, clock: c, transitions };
}

function acquired(a: Acquire): Extract<Acquire, { ok: true }> {
	if (!a.ok) {
		throw new Error(`expected acquire, got refusal ${JSON.stringify(a)}`);
	}
	return a;
}

function refused(a: Acquire): Extract<Acquire, { ok: false }> {
	if (a.ok) {
		throw new Error("expected refusal, got acquire");
	}
	return a;
}

function fail(breaker: CircuitBreaker): void {
	acquired(breaker.tryAcquire()).release("failure");
}

describe("createCircuitBreaker options", () => {
	test("rejects non positive-integer thresholds and durations", () => {
		const base: CircuitBreakerOptions = { failureThreshold: 1, windowMs: 1, openMs: 1 };
		for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, "3"]) {
			expect(() => createCircuitBreaker({ ...base, failureThreshold: bad as number })).toThrow(RangeError);
			expect(() => createCircuitBreaker({ ...base, windowMs: bad as number })).toThrow(RangeError);
			expect(() => createCircuitBreaker({ ...base, openMs: bad as number })).toThrow(RangeError);
			expect(() => createCircuitBreaker({ ...base, halfOpenMaxCalls: bad as number })).toThrow(RangeError);
		}
		expect(() => createCircuitBreaker({ ...base, now: 5 as unknown as () => number })).toThrow(RangeError);
		expect(() => createCircuitBreaker({ ...base, onTransition: "x" as unknown as () => void })).toThrow(RangeError);
	});

	test("defaults: starts closed with zero counters and halfOpenMaxCalls 1", () => {
		const breaker = createCircuitBreaker({ failureThreshold: 1, windowMs: 1, openMs: 1 });
		expect(breaker.state()).toBe("closed");
		expect(breaker.snapshot()).toEqual({ state: "closed", failures: 0, transitions: 0 });
		expect(breaker.tryAcquire().ok).toBe(true);
	});
});

describe("closed state", () => {
	test("reaching the threshold within the window opens the breaker", () => {
		const { breaker, clock: c, transitions } = harness();
		fail(breaker);
		c.advance(1_000);
		fail(breaker);
		expect(breaker.state()).toBe("closed");
		expect(breaker.snapshot().failures).toBe(2);
		c.advance(1_000);
		fail(breaker);
		expect(breaker.state()).toBe("open");
		expect(breaker.snapshot()).toEqual({ state: "open", failures: 3, openedAt: c.now(), transitions: 1 });
		expect(transitions).toEqual([["closed", "open"]]);
	});

	test("failures spread across windows do not open the breaker", () => {
		const { breaker, clock: c, transitions } = harness();
		fail(breaker);
		c.advance(6_000);
		fail(breaker);
		c.advance(6_000); // window started at the first failure rolled; count restarts at 1
		fail(breaker);
		expect(breaker.state()).toBe("closed");
		expect(breaker.snapshot().failures).toBe(1);
		c.advance(6_000);
		fail(breaker);
		expect(breaker.state()).toBe("closed");
		expect(transitions).toEqual([]);
	});

	test("success and ignored outcomes do not count", () => {
		const { breaker } = harness();
		for (let i = 0; i < 10; i += 1) {
			acquired(breaker.tryAcquire()).release("success");
			acquired(breaker.tryAcquire()).release("ignored");
		}
		fail(breaker);
		fail(breaker);
		expect(breaker.state()).toBe("closed");
		expect(breaker.snapshot().failures).toBe(2);
	});

	test("many concurrent closed acquires can be released in any order", () => {
		const { breaker } = harness({ failureThreshold: 2 });
		const a = acquired(breaker.tryAcquire());
		const b = acquired(breaker.tryAcquire());
		const d = acquired(breaker.tryAcquire());
		b.release("failure");
		a.release("success");
		expect(breaker.state()).toBe("closed");
		d.release("failure");
		expect(breaker.state()).toBe("open");
	});
});

describe("closed slot generations", () => {
	test("a slot admitted before the breaker opened and closed again does not count", () => {
		const { breaker, clock: c } = harness({ failureThreshold: 2, openMs: 5_000 });
		const stale = [acquired(breaker.tryAcquire()), acquired(breaker.tryAcquire()), acquired(breaker.tryAcquire())];
		fail(breaker);
		fail(breaker);
		expect(breaker.state()).toBe("open");
		c.advance(5_000);
		acquired(breaker.tryAcquire()).release("success");
		expect(breaker.state()).toBe("closed");
		for (const slot of stale) slot.release("failure");
		expect(breaker.snapshot()).toMatchObject({ state: "closed", failures: 0 });
	});
});

describe("open state", () => {
	test("refuses with decreasing retryAfterMs until openMs elapses", () => {
		const { breaker, clock: c } = harness({ failureThreshold: 1, openMs: 5_000 });
		fail(breaker);
		expect(refused(breaker.tryAcquire())).toEqual({ ok: false, state: "open", retryAfterMs: 5_000 });
		c.advance(1_000);
		expect(refused(breaker.tryAcquire()).retryAfterMs).toBe(4_000);
		c.advance(3_999);
		expect(refused(breaker.tryAcquire()).retryAfterMs).toBe(1);
		expect(breaker.state()).toBe("open");
	});

	test("a clock that runs backwards is clamped to openMs", () => {
		const { breaker, clock: c } = harness({ failureThreshold: 1, openMs: 5_000 });
		fail(breaker);
		c.advance(-60_000);
		expect(refused(breaker.tryAcquire()).retryAfterMs).toBe(5_000);
	});

	test("state() keeps reporting open past openMs until a probe slot is requested", () => {
		const { breaker, clock: c, transitions } = harness({ failureThreshold: 1, openMs: 5_000 });
		fail(breaker);
		c.advance(5_000);
		expect(breaker.state()).toBe("open");
		expect(breaker.snapshot().state).toBe("open");
		expect(transitions).toEqual([["closed", "open"]]);
		acquired(breaker.tryAcquire());
		expect(breaker.state()).toBe("half_open");
		expect(transitions).toEqual([
			["closed", "open"],
			["open", "half_open"],
		]);
	});

	test("stale releases from before the breaker opened are ignored", () => {
		const { breaker, clock: c } = harness({ failureThreshold: 1, openMs: 5_000 });
		const early = acquired(breaker.tryAcquire());
		fail(breaker);
		const openedAt = breaker.snapshot().openedAt;
		c.advance(1_000);
		early.release("failure");
		expect(breaker.snapshot()).toMatchObject({ state: "open", failures: 1, openedAt });
		c.advance(4_000);
		const probe = acquired(breaker.tryAcquire());
		early.release("failure");
		expect(breaker.state()).toBe("half_open");
		probe.release("success");
		expect(breaker.state()).toBe("closed");
	});
});

describe("half-open state", () => {
	test("after openMs one probe is allowed and a second is refused", () => {
		const { breaker, clock: c } = harness({ failureThreshold: 1, openMs: 5_000 });
		fail(breaker);
		c.advance(5_000);
		const probe = acquired(breaker.tryAcquire());
		expect(breaker.state()).toBe("half_open");
		expect(refused(breaker.tryAcquire())).toEqual({ ok: false, state: "open", retryAfterMs: HALF_OPEN_RETRY_MS });
		expect(HALF_OPEN_RETRY_MS).toBeGreaterThan(0);
		probe.release("ignored");
		expect(acquired(breaker.tryAcquire()).ok).toBe(true);
	});

	test("halfOpenMaxCalls bounds probes in flight", () => {
		const { breaker, clock: c } = harness({ failureThreshold: 1, openMs: 5_000, halfOpenMaxCalls: 2 });
		fail(breaker);
		c.advance(5_000);
		const first = acquired(breaker.tryAcquire());
		acquired(breaker.tryAcquire());
		refused(breaker.tryAcquire());
		first.release("ignored");
		acquired(breaker.tryAcquire());
		refused(breaker.tryAcquire());
	});

	test("probe success closes the breaker and resets counters", () => {
		const { breaker, clock: c, transitions } = harness({ failureThreshold: 2, openMs: 5_000 });
		fail(breaker);
		fail(breaker);
		const openedAt = c.now();
		c.advance(5_000);
		acquired(breaker.tryAcquire()).release("success");
		expect(breaker.state()).toBe("closed");
		expect(breaker.snapshot()).toEqual({ state: "closed", failures: 0, openedAt, transitions: 3 });
		expect(transitions).toEqual([
			["closed", "open"],
			["open", "half_open"],
			["half_open", "closed"],
		]);
		// Fresh window: a single failure must not reopen.
		fail(breaker);
		expect(breaker.state()).toBe("closed");
		expect(breaker.snapshot().failures).toBe(1);
	});

	test("probe failure re-opens with a new openedAt", () => {
		const { breaker, clock: c, transitions } = harness({ failureThreshold: 1, openMs: 5_000 });
		fail(breaker);
		const firstOpenedAt = c.now();
		c.advance(5_000);
		acquired(breaker.tryAcquire()).release("failure");
		expect(breaker.state()).toBe("open");
		expect(breaker.snapshot()).toEqual({ state: "open", failures: 2, openedAt: firstOpenedAt + 5_000, transitions: 3 });
		expect(refused(breaker.tryAcquire()).retryAfterMs).toBe(5_000);
		expect(transitions).toEqual([
			["closed", "open"],
			["open", "half_open"],
			["half_open", "open"],
		]);
	});

	test("ignored outcome frees the slot without changing state", () => {
		const { breaker, clock: c, transitions } = harness({ failureThreshold: 1, openMs: 5_000 });
		fail(breaker);
		c.advance(5_000);
		acquired(breaker.tryAcquire()).release("ignored");
		expect(breaker.state()).toBe("half_open");
		expect(transitions).toHaveLength(2);
		acquired(breaker.tryAcquire()).release("ignored");
		expect(breaker.state()).toBe("half_open");
		expect(transitions).toHaveLength(2);
	});

	test("double release is harmless", () => {
		const { breaker, clock: c, transitions } = harness({ failureThreshold: 1, openMs: 5_000 });
		fail(breaker);
		c.advance(5_000);
		const probe = acquired(breaker.tryAcquire());
		probe.release("success");
		probe.release("failure");
		probe.release("success");
		expect(breaker.state()).toBe("closed");
		expect(transitions).toHaveLength(3);
		const closed = acquired(breaker.tryAcquire());
		closed.release("failure");
		closed.release("failure");
		expect(breaker.state()).toBe("open");
		expect(breaker.snapshot().transitions).toBe(4);
	});

	test("a stale probe cannot move the breaker after another probe decided", () => {
		const { breaker, clock: c } = harness({ failureThreshold: 1, openMs: 5_000, halfOpenMaxCalls: 2 });
		fail(breaker);
		c.advance(5_000);
		const a = acquired(breaker.tryAcquire());
		const b = acquired(breaker.tryAcquire());
		a.release("success");
		expect(breaker.state()).toBe("closed");
		b.release("failure");
		expect(breaker.state()).toBe("closed");
		expect(breaker.snapshot().failures).toBe(0);
	});
});

describe("transitions", () => {
	test("reported in order and a throwing hook does not break the breaker", () => {
		const seen: string[] = [];
		const { breaker, clock: c } = harness({
			failureThreshold: 1,
			openMs: 5_000,
			onTransition: (from, to) => {
				seen.push(`${from}>${to}`);
				throw new Error("hook boom");
			},
		});
		fail(breaker);
		c.advance(5_000);
		acquired(breaker.tryAcquire()).release("failure");
		c.advance(5_000);
		acquired(breaker.tryAcquire()).release("success");
		expect(seen).toEqual(["closed>open", "open>half_open", "half_open>open", "open>half_open", "half_open>closed"]);
		expect(breaker.snapshot().transitions).toBe(5);
		expect(breaker.state()).toBe("closed");
	});
});
