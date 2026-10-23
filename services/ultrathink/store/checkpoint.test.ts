// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import { createWalCheckpointer } from "./checkpoint.ts";

interface FakeTimer {
	run: () => void;
	intervalMs: number;
	cleared: boolean;
}

function fakeTimers() {
	const timers: FakeTimer[] = [];
	return {
		timers,
		setTimer: (run: () => void, intervalMs: number): object => {
			const timer: FakeTimer = { run, intervalMs, cleared: false };
			timers.push(timer);
			return timer;
		},
		clearTimer: (handle: object): void => {
			(handle as FakeTimer).cleared = true;
		},
	};
}

describe("createWalCheckpointer", () => {
	test("each tick runs one checkpoint and a blocked one is reported", () => {
		const outcomes = [{ ok: true }, { ok: false }];
		let checkpoints = 0;
		let blocked = 0;
		const timers = fakeTimers();
		createWalCheckpointer({
			checkpoint: () => {
				checkpoints += 1;
				return outcomes.shift() ?? { ok: true };
			},
			intervalMs: 600_000,
			onBlocked: () => {
				blocked += 1;
			},
			setTimer: timers.setTimer,
			clearTimer: timers.clearTimer,
		}).start();
		expect(timers.timers.map((timer) => timer.intervalMs)).toEqual([600_000]);
		timers.timers[0]?.run();
		expect(checkpoints).toBe(1);
		expect(blocked).toBe(0);
		timers.timers[0]?.run();
		expect(checkpoints).toBe(2);
		expect(blocked).toBe(1);
	});

	test("a second start changes nothing, stop cancels the timer, and start again schedules a new one", () => {
		const timers = fakeTimers();
		const checkpointer = createWalCheckpointer({
			checkpoint: () => ({ ok: true }),
			intervalMs: 1000,
			setTimer: timers.setTimer,
			clearTimer: timers.clearTimer,
		});
		const stop = checkpointer.start();
		expect(checkpointer.start()).toBe(stop);
		expect(timers.timers).toHaveLength(1);
		stop();
		expect(timers.timers[0]?.cleared).toBe(true);
		stop();
		expect(timers.timers).toHaveLength(1);
		checkpointer.start();
		expect(timers.timers).toHaveLength(2);
		expect(timers.timers[1]?.cleared).toBe(false);
	});

	test("invalid options are rejected before any timer exists", () => {
		const timers = fakeTimers();
		expect(() =>
			createWalCheckpointer({ checkpoint: () => ({ ok: true }), intervalMs: 0, setTimer: timers.setTimer }),
		).toThrow(RangeError);
		expect(() =>
			createWalCheckpointer({ checkpoint: "not a function" as never, intervalMs: 1000, setTimer: timers.setTimer }),
		).toThrow(TypeError);
		expect(timers.timers).toHaveLength(0);
	});
});
