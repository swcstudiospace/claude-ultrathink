// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { describe, expect, test } from "bun:test";
import { createDrainState, createInflight, createRuntimeProbe, type RuntimeSample } from "./runtime.ts";

interface FakeTimer {
	run: () => void;
	ms: number;
	unrefCalls: number;
	cleared: boolean;
	unref: () => void;
}

interface Harness {
	clock: { now: number };
	timers: FakeTimer[];
	samples: RuntimeSample[];
	memory: { rss: number; heapUsed: number };
}

function harness(opts: { intervalMs?: number; onSample?: (s: RuntimeSample) => void; clearTimer?: (h: object) => void } = {}) {
	const h: Harness = { clock: { now: 1000 }, timers: [], samples: [], memory: { rss: 100, heapUsed: 40 } };
	const probe = createRuntimeProbe({
		intervalMs: opts.intervalMs ?? 500,
		onSample: opts.onSample ?? ((s) => h.samples.push(s)),
		now: () => h.clock.now,
		memory: () => h.memory,
		uptime: () => 12.5,
		setTimer: (run, ms) => {
			const timer: FakeTimer = {
				run,
				ms,
				unrefCalls: 0,
				cleared: false,
				unref() {
					timer.unrefCalls++;
				},
			};
			h.timers.push(timer);
			return timer;
		},
		clearTimer:
			opts.clearTimer ??
			((handle) => {
				(handle as FakeTimer).cleared = true;
			}),
	});
	return { h, probe };
}

function pending(h: Harness): FakeTimer {
	const timer = h.timers.at(-1);
	if (timer === undefined || timer.cleared) throw new Error("no pending timer");
	return timer;
}

describe("createInflight", () => {
	test("rejects a non-positive or non-integer max", () => {
		for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53]) {
			expect(() => createInflight(bad)).toThrow(RangeError);
		}
	});

	test("admits up to max and returns null at capacity", () => {
		const inflight = createInflight(2);
		expect(inflight.max).toBe(2);
		const a = inflight.enter();
		const b = inflight.enter();
		expect(a).not.toBeNull();
		expect(b).not.toBeNull();
		expect(inflight.count).toBe(2);
		expect(inflight.enter()).toBeNull();
		expect(inflight.count).toBe(2);
		a?.();
		expect(inflight.count).toBe(1);
		expect(inflight.enter()).not.toBeNull();
		expect(inflight.enter()).toBeNull();
	});

	test("release is idempotent and the count never underflows", () => {
		const inflight = createInflight(1);
		const release = inflight.enter();
		expect(release).not.toBeNull();
		release?.();
		release?.();
		release?.();
		expect(inflight.count).toBe(0);
		const again = inflight.enter();
		expect(again).not.toBeNull();
		expect(inflight.count).toBe(1);
		release?.(); // stale release from the earlier admission must not touch the live one
		expect(inflight.count).toBe(1);
		again?.();
		expect(inflight.count).toBe(0);
	});
});

describe("createDrainState", () => {
	test("is not draining until begin() and begin() is idempotent", () => {
		const clock = { now: 5000 };
		const drain = createDrainState(() => clock.now);
		expect(drain.draining).toBe(false);
		expect(drain.since).toBeUndefined();
		drain.begin();
		expect(drain.draining).toBe(true);
		expect(drain.since).toBe(5000);
		clock.now = 9000;
		drain.begin();
		expect(drain.since).toBe(5000);
		expect(drain.draining).toBe(true);
	});

	test("defaults to Date.now", () => {
		const before = Date.now();
		const drain = createDrainState();
		drain.begin();
		expect(drain.since).toBeGreaterThanOrEqual(before);
		expect(drain.since).toBeLessThanOrEqual(Date.now());
	});

	test("rejects a non-function clock", () => {
		expect(() => createDrainState(5 as unknown as () => number)).toThrow(TypeError);
	});
});

describe("createRuntimeProbe", () => {
	test("rejects an invalid interval or onSample", () => {
		const onSample = () => {};
		for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(() => createRuntimeProbe({ intervalMs: bad, onSample })).toThrow(RangeError);
		}
		expect(() => createRuntimeProbe({ intervalMs: 10, onSample: null as unknown as () => void })).toThrow(TypeError);
	});

	test("computes lag from the injected clock and passes memory/uptime through", () => {
		const { h, probe } = harness({ intervalMs: 500 });
		const stop = probe.start();
		expect(h.timers).toHaveLength(1);
		expect(pending(h).ms).toBe(500);

		h.clock.now = 1000 + 500 + 37; // woke 37ms late
		pending(h).run();
		expect(h.samples).toHaveLength(1);
		expect(h.samples[0]).toEqual({ eventLoopLagMs: 37, rssBytes: 100, heapUsedBytes: 40, uptimeSec: 12.5 });

		// Rescheduled from the wake time; an early wake clamps to 0.
		expect(h.timers).toHaveLength(2);
		h.memory = { rss: 250, heapUsed: 90 };
		h.clock.now = 1537 + 500 - 3;
		pending(h).run();
		expect(h.samples[1]).toEqual({ eventLoopLagMs: 0, rssBytes: 250, heapUsedBytes: 90, uptimeSec: 12.5 });
		stop();
	});

	test("sampleOnce reports the last measured lag without scheduling", () => {
		const { h, probe } = harness();
		expect(probe.sampleOnce()).toEqual({ eventLoopLagMs: 0, rssBytes: 100, heapUsedBytes: 40, uptimeSec: 12.5 });
		expect(h.timers).toHaveLength(0);
		const stop = probe.start();
		h.clock.now = 1000 + 500 + 8;
		pending(h).run();
		stop();
		expect(probe.sampleOnce().eventLoopLagMs).toBe(8);
	});

	test("stop clears the pending timer, is idempotent, and a late tick is ignored", () => {
		const { h, probe } = harness();
		const stop = probe.start();
		const timer = pending(h);
		stop();
		expect(timer.cleared).toBe(true);
		stop();
		stop();
		// Even if the timer backend fires anyway, nothing is sampled or rescheduled.
		timer.run();
		expect(h.samples).toHaveLength(0);
		expect(h.timers).toHaveLength(1);
	});

	test("start while running does not schedule a second timer; restart after stop does", () => {
		const { h, probe } = harness();
		const stop1 = probe.start();
		const stop2 = probe.start();
		expect(stop2).toBe(stop1);
		expect(h.timers).toHaveLength(1);
		stop1();
		const stop3 = probe.start();
		expect(h.timers).toHaveLength(2);
		expect(pending(h).cleared).toBe(false);
		stop3();
		expect(h.timers[1]?.cleared).toBe(true);
	});

	test("a stale stop from an earlier run does not cancel a later run", () => {
		const { h, probe } = harness();
		const stop1 = probe.start();
		stop1();
		probe.start();
		stop1();
		expect(pending(h).cleared).toBe(false);
	});

	test("swallows onSample exceptions and keeps sampling", () => {
		let calls = 0;
		const { h, probe } = harness({
			onSample: () => {
				calls++;
				throw new Error("observer broke");
			},
		});
		const stop = probe.start();
		h.clock.now = 1500;
		expect(() => pending(h).run()).not.toThrow();
		expect(calls).toBe(1);
		expect(h.timers).toHaveLength(2);
		h.clock.now = 2000;
		pending(h).run();
		expect(calls).toBe(2);
		stop();
	});

	test("a failing memory source skips that sample on the timer path but throws from sampleOnce", () => {
		const samples: RuntimeSample[] = [];
		let tick: (() => void) | undefined;
		const probe = createRuntimeProbe({
			intervalMs: 10,
			onSample: (s) => samples.push(s),
			now: () => 0,
			memory: () => {
				throw new Error("no memory");
			},
			setTimer: (run) => {
				tick = run;
				return {};
			},
			clearTimer: () => {},
		});
		expect(() => probe.sampleOnce()).toThrow("no memory");
		const stop = probe.start();
		expect(() => tick?.()).not.toThrow();
		expect(samples).toHaveLength(0);
		stop();
	});

	test("a throwing clearTimer does not escape stop", () => {
		const { probe } = harness({
			clearTimer: () => {
				throw new Error("cannot clear");
			},
		});
		const stop = probe.start();
		expect(() => stop()).not.toThrow();
	});

	test("default timer works end to end and samples real process memory", () => {
		const probe = createRuntimeProbe({ intervalMs: 60_000, onSample: () => {} });
		const stop = probe.start();
		stop();
		const sample = probe.sampleOnce();
		expect(sample.rssBytes).toBeGreaterThan(0);
		expect(sample.heapUsedBytes).toBeGreaterThan(0);
		expect(sample.uptimeSec).toBeGreaterThanOrEqual(0);
		expect(sample.eventLoopLagMs).toBe(0);
	});

	test("unref is called on every scheduled timer handle so the probe never keeps the process alive", () => {
		const { h, probe } = harness();
		const stop = probe.start();
		expect(pending(h).unrefCalls).toBe(1);
		h.clock.now = 1500;
		pending(h).run();
		expect(pending(h).unrefCalls).toBe(1);
		stop();
	});
});
