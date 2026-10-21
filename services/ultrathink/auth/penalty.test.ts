// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { describe, expect, test } from "bun:test";
import { createLogger } from "../obs/log.ts";
import { ConsoleSecurityEventLogger } from "../security/events.ts";
import { createPenaltyLadder, type PenaltyLadder, type PenaltyOptions } from "./penalty.ts";

const WINDOW_MS = 60_000;
const DECAY_MS = 15 * 60_000;
const START = 600_000;

interface Clock {
	t: number;
}

function ladderAt(clock: Clock, overrides: Partial<PenaltyOptions> = {}) {
	return createPenaltyLadder({
		windowMs: WINDOW_MS,
		failuresPerWindow: 3,
		baseSec: 60,
		maxSec: 3600,
		decayMs: DECAY_MS,
		maxKeys: 100,
		now: () => clock.t,
		...overrides,
	});
}

function failTimes(ladder: PenaltyLadder, key: string, count: number) {
	let result = ladder.fail(key);
	for (let i = 1; i < count; i++) result = ladder.fail(key);
	return result;
}

function escalateThrough(ladder: PenaltyLadder, clock: Clock, count: number): void {
	for (let i = 0; i < count; i++) {
		const result = failTimes(ladder, "ip", 4);
		clock.t += result.blockedSec * 1000;
	}
}

describe("createPenaltyLadder", () => {
	test("N failures do not block; the N+1th blocks at the base", () => {
		const clock = { t: START };
		const ladder = ladderAt(clock);

		for (let i = 0; i < 3; i++) {
			expect(ladder.fail("ip")).toEqual({ blockedSec: 0, escalated: false, level: 0, tracked: true });
		}
		expect(ladder.blockedSec("ip")).toBe(0);

		expect(ladder.fail("ip")).toEqual({ blockedSec: 60, escalated: true, level: 1, tracked: true });
		expect(ladder.blockedSec("ip")).toBe(60);
	});

	test("escalation doubles the block and caps it at maxSec", () => {
		const clock = { t: START };
		// Decay longer than the longest block, so consecutive offences stay in one ladder.
		const ladder = ladderAt(clock, { decayMs: 2 * 60 * 60_000 });
		const expected = [60, 120, 240, 480, 960, 1920, 3600, 3600];

		expected.forEach((seconds, index) => {
			const result = failTimes(ladder, "ip", 4);
			expect(result).toEqual({ blockedSec: seconds, escalated: true, level: index + 1, tracked: true });
			expect(result.blockedSec).toBeLessThanOrEqual(3600);
			clock.t += seconds * 1000;
		});
	});

	test("quiet for longer than the decay period resets the level to one", () => {
		const clock = { t: START };
		const ladder = ladderAt(clock);

		expect(failTimes(ladder, "ip", 4).level).toBe(1);
		clock.t += 60_000;
		expect(failTimes(ladder, "ip", 4)).toMatchObject({ escalated: true, level: 2, blockedSec: 120 });

		clock.t = START + 60_000 + 120_000 + DECAY_MS + 1;
		expect(failTimes(ladder, "ip", 4)).toEqual({ blockedSec: 60, escalated: true, level: 1, tracked: true });
	});

	test("escalates level by level at defaults until the maxSec cap", () => {
		const clock = { t: START };
		const ladder = ladderAt(clock);
		const expected = [60, 120, 240, 480, 960, 1920, 3600, 3600];

		expected.forEach((seconds, index) => {
			const result = failTimes(ladder, "ip", 4);
			expect(result).toEqual({ blockedSec: seconds, escalated: true, level: index + 1, tracked: true });
			clock.t += seconds * 1000;
		});
	});

	test("quiet for less than the decay period after a block keeps the escalated level", () => {
		const clock = { t: START };
		const ladder = ladderAt(clock);
		escalateThrough(ladder, clock, 5);

		clock.t += DECAY_MS - 1_000;
		expect(failTimes(ladder, "ip", 4)).toEqual({ blockedSec: 1920, escalated: true, level: 6, tracked: true });
	});

	test("quiet for more than the decay period after a block resets the level to one", () => {
		const clock = { t: START };
		const ladder = ladderAt(clock);
		escalateThrough(ladder, clock, 5);

		clock.t += DECAY_MS + 1;
		expect(failTimes(ladder, "ip", 4)).toEqual({ blockedSec: 60, escalated: true, level: 1, tracked: true });
	});

	test("failures during an active block change neither level nor block end", () => {
		const clock = { t: START };
		const ladder = ladderAt(clock);
		failTimes(ladder, "ip", 4);

		clock.t = START + 10_000;
		expect(ladder.blockedSec("ip")).toBe(50);
		for (let i = 0; i < 10; i++) {
			expect(ladder.fail("ip")).toEqual({ blockedSec: 50, escalated: false, level: 1, tracked: true });
		}
		expect(ladder.blockedSec("ip")).toBe(50);

		clock.t = START + 30_000;
		expect(ladder.blockedSec("ip")).toBe(30);
	});

	test("failures split across two fixed windows do not add up", () => {
		const clock = { t: START };
		const ladder = ladderAt(clock);

		for (let i = 0; i < 3; i++) expect(ladder.fail("ip").escalated).toBe(false);
		clock.t = START + WINDOW_MS;
		for (let i = 0; i < 3; i++) expect(ladder.fail("ip").escalated).toBe(false);
		expect(ladder.blockedSec("ip")).toBe(0);
	});

	test("blockedSec rounds the remaining time up to whole seconds", () => {
		const clock = { t: START };
		const ladder = ladderAt(clock);
		failTimes(ladder, "ip", 4);

		clock.t = START + 59_500;
		expect(ladder.blockedSec("ip")).toBe(1);
		clock.t = START + 60_000;
		expect(ladder.blockedSec("ip")).toBe(0);
	});

	test("a full table tracks existing keys and reports new keys untracked", () => {
		const clock = { t: START };
		const ladder = ladderAt(clock, { maxKeys: 2 });
		failTimes(ladder, "a", 4);
		ladder.fail("b");

		expect(ladder.fail("c")).toEqual({ blockedSec: 0, escalated: false, level: 0, tracked: false });
		expect(ladder.blockedSec("c")).toBe(0);

		const blockedA = ladder.fail("a");
		expect(blockedA).toMatchObject({ escalated: false, tracked: true });
		expect(blockedA.blockedSec).toBeGreaterThan(0);
	});

	test("a full table prunes expired keys before refusing a new one", () => {
		const clock = { t: START };
		const ladder = ladderAt(clock, { maxKeys: 2 });
		failTimes(ladder, "a", 4);
		ladder.fail("b");

		clock.t = START + 60_000 + DECAY_MS + 1;
		expect(ladder.fail("c")).toMatchObject({ tracked: true, escalated: false });
	});

	test("invalid options throw RangeError", () => {
		const clock = { t: START };
		expect(() => ladderAt(clock, { baseSec: 3601 })).toThrow(RangeError);
		expect(() => ladderAt(clock, { windowMs: 0 })).toThrow(RangeError);
		expect(() => ladderAt(clock, { failuresPerWindow: 0 })).toThrow(RangeError);
		expect(() => ladderAt(clock, { maxKeys: 0 })).toThrow(RangeError);
		expect(() => ladderAt(clock, { baseSec: 0 })).toThrow(RangeError);
		expect(() => ladderAt(clock, { decayMs: Number.NaN })).toThrow(RangeError);
	});
});

describe("createPenaltyLadder security events", () => {
	/** Parsed log lines of the security logger, in emission order. */
	function capture() {
		const lines: string[] = [];
		const security = new ConsoleSecurityEventLogger(createLogger({ write: (line) => lines.push(line) }));
		const events = () => lines.map((line) => JSON.parse(line) as Record<string, unknown>);
		return { security, events };
	}

	test("each escalation emits one suspicious-activity event carrying the key, level and block; other failures emit nothing", () => {
		const clock = { t: START };
		const log = capture();
		const ladder = ladderAt(clock, { security: log.security });

		for (let i = 0; i < 3; i++) ladder.fail("ip");
		expect(log.events()).toEqual([]);

		expect(ladder.fail("ip")).toMatchObject({ escalated: true, level: 1, blockedSec: 60 });
		expect(log.events()).toMatchObject([
			{ event: "abuse.penalty_escalated", type: "suspicious_activity", severity: "high", ip: "ip", details: { level: 1, blockedSec: 60 } },
		]);

		for (let i = 0; i < 5; i++) ladder.fail("ip");
		expect(log.events()).toHaveLength(1);

		clock.t += 60_000;
		failTimes(ladder, "ip", 4);
		expect(log.events()).toHaveLength(2);
		expect(log.events()[1]).toMatchObject({ event: "abuse.penalty_escalated", ip: "ip", details: { level: 2, blockedSec: 120 } });
	});

	test("the event carries only the key, the level, the block and the fixed event fields", () => {
		const clock = { t: START };
		const log = capture();
		const ladder = ladderAt(clock, { security: log.security });
		failTimes(ladder, "ip", 4);

		const [event] = log.events();
		expect(Object.keys(event ?? {}).sort()).toEqual(["correlationId", "details", "event", "ip", "level", "severity", "source", "timestamp", "ts", "type"]);
		expect(Object.keys((event?.details ?? {}) as Record<string, unknown>).sort()).toEqual(["blockedSec", "eventType", "level"]);
	});
});
