// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { describe, expect, test } from "bun:test";
import { type Acknowledged, type AuditWatch, createAuditWatch, type Fingerprint, type ScanOutcome, type WatchAlert } from "./audit-watch.ts";

const GENESIS = "0".repeat(64);
const HEAD_HASH = "a".repeat(64);
const OTHER_HASH = "b".repeat(64);

function fp(size: number, mtimeMs: number, ino = 1): Fingerprint {
	return { size, mtimeMs, ino };
}

/**
 * A watch whose file, acknowledged head and scan results are plain variables the test edits between ticks. The timer
 * is captured, never started, so each tick is driven explicitly.
 */
function harness(options: { intervalMs?: number; fullScanEveryTicks?: number } = {}) {
	const world: {
		disk: Fingerprint | undefined;
		ack: Acknowledged;
		outcome: ScanOutcome;
		scans: number;
	} = {
		disk: fp(100, 1_000),
		ack: { fingerprint: fp(100, 1_000), seq: 5, hash: HEAD_HASH },
		outcome: { ok: true, records: 5, lastHash: HEAD_HASH },
		scans: 0,
	};
	const alerts: WatchAlert[] = [];
	const timers = { scheduled: undefined as (() => void) | undefined, handle: {} as object, cleared: 0 };
	let recovers = 0;

	const watch: AuditWatch = createAuditWatch({
		intervalMs: options.intervalMs ?? 1000,
		fullScanEveryTicks: options.fullScanEveryTicks,
		stat: () => world.disk,
		acknowledged: () => world.ack,
		scan: () => {
			world.scans += 1;
			return world.outcome;
		},
		onAlert: (alert) => alerts.push(alert),
		onRecover: () => {
			recovers += 1;
		},
		setTimer: (run) => {
			timers.scheduled = run;
			return timers.handle;
		},
		clearTimer: () => {
			timers.cleared += 1;
		},
	});

	return {
		world,
		watch,
		alerts,
		timers,
		recovers: () => recovers,
		tickMany: (count: number) => {
			for (let i = 0; i < count; i += 1) watch.tick();
		},
	};
}

describe("own writes", () => {
	test("after a stat match with the acknowledged fingerprint, ten ticks do no scan and no alert", () => {
		const h = harness();
		h.tickMany(10);
		expect(h.world.scans).toBe(0);
		expect(h.alerts).toEqual([]);
	});
});

describe("external edits", () => {
	test("a changed file whose chain is broken alerts chain_broken on the first tick after the change", () => {
		const h = harness();
		h.tickMany(3);
		expect(h.alerts).toEqual([]);

		h.world.disk = fp(120, 2_000);
		h.world.outcome = { ok: false, records: 3, brokenAt: 4, reason: "hash mismatch" };
		h.watch.tick();

		expect(h.world.scans).toBe(1);
		expect(h.alerts).toHaveLength(1);
		expect(h.alerts[0]?.kind).toBe("chain_broken");
		expect(h.alerts[0]?.reason).toContain("record 4");
	});

	test("tail truncation with an intact prefix alerts head_mismatch", () => {
		const h = harness();
		h.world.disk = fp(60, 2_000);
		h.world.outcome = { ok: true, records: 3, lastHash: OTHER_HASH };
		h.watch.tick();

		expect(h.alerts).toHaveLength(1);
		expect(h.alerts[0]?.kind).toBe("head_mismatch");
		expect(h.alerts[0]?.reason).toContain("3 records");
	});

	test("a clean chain whose last hash differs from the acknowledged hash alerts head_mismatch", () => {
		const h = harness();
		h.world.disk = fp(100, 2_000);
		h.world.outcome = { ok: true, records: 5, lastHash: OTHER_HASH };
		h.watch.tick();

		expect(h.alerts.map((alert) => alert.kind)).toEqual(["head_mismatch"]);
	});

	test("a removed file while the acknowledged seq is above zero alerts head_mismatch", () => {
		const h = harness();
		h.world.disk = undefined;
		h.watch.tick();

		expect(h.alerts).toHaveLength(1);
		expect(h.alerts[0]?.kind).toBe("head_mismatch");
	});

	test("a missing file with an empty acknowledged head is not an alert", () => {
		const h = harness();
		h.world.disk = undefined;
		h.world.ack = { fingerprint: undefined, seq: 0, hash: GENESIS };
		h.world.outcome = { ok: true, records: 0, lastHash: GENESIS };
		h.tickMany(3);

		expect(h.alerts).toEqual([]);
		expect(h.recovers()).toBe(0);
	});

	test("a touched file whose chain and head still match gives no alert", () => {
		const h = harness();
		h.world.disk = fp(100, 9_999);
		h.world.outcome = { ok: true, records: 5, lastHash: HEAD_HASH };
		h.watch.tick();

		expect(h.world.scans).toBe(1);
		expect(h.alerts).toEqual([]);
	});

	test("an in-place edit that keeps size and mtime is not caught on ticks 1 to 59 and is caught on tick 60", () => {
		const h = harness();
		// The file was edited in place: its stat still equals the acknowledged fingerprint.
		h.world.outcome = { ok: false, records: 2, brokenAt: 3, reason: "hash mismatch" };

		h.tickMany(59);
		expect(h.world.scans).toBe(0);
		expect(h.alerts).toEqual([]);

		h.watch.tick();
		expect(h.world.scans).toBe(1);
		expect(h.alerts.map((alert) => alert.kind)).toEqual(["chain_broken"]);
	});
});

describe("alert lifecycle", () => {
	test("a persisting condition alerts once, and onRecover fires after it clears", () => {
		const h = harness();
		h.world.disk = fp(120, 2_000);
		h.world.outcome = { ok: false, records: 3, brokenAt: 4, reason: "hash mismatch" };
		h.tickMany(5);

		expect(h.alerts).toHaveLength(1);
		expect(h.world.scans).toBe(1);
		expect(h.recovers()).toBe(0);

		// The file is restored to the log's own fingerprint and head.
		h.world.disk = fp(100, 1_000);
		h.world.outcome = { ok: true, records: 5, lastHash: HEAD_HASH };
		h.watch.tick();

		expect(h.recovers()).toBe(1);
		expect(h.alerts).toHaveLength(1);
	});

	test("a condition that changes again while still broken re-scans without a second alert for the same reason", () => {
		const h = harness();
		h.world.disk = fp(120, 2_000);
		h.world.outcome = { ok: false, records: 3, brokenAt: 4, reason: "hash mismatch" };
		h.watch.tick();

		h.world.disk = fp(121, 3_000);
		h.watch.tick();

		expect(h.world.scans).toBe(2);
		expect(h.alerts).toHaveLength(1);
	});

	test("onRecover does not fire when nothing was alerting", () => {
		const h = harness();
		h.world.disk = fp(120, 2_000);
		h.world.outcome = { ok: true, records: 5, lastHash: HEAD_HASH };
		h.tickMany(3);

		expect(h.alerts).toEqual([]);
		expect(h.recovers()).toBe(0);
	});
});

describe("timer and interval", () => {
	test("intervalMs 99 and 1001 throw RangeError; the 100 and 1000 bounds are accepted", () => {
		const base = { stat: () => undefined, acknowledged: () => ({ fingerprint: undefined, seq: 0, hash: GENESIS }), scan: () => ({ ok: true as const, records: 0, lastHash: GENESIS }), onAlert: () => {} };
		expect(() => createAuditWatch({ ...base, intervalMs: 99 })).toThrow(RangeError);
		expect(() => createAuditWatch({ ...base, intervalMs: 1001 })).toThrow(RangeError);
		expect(() => createAuditWatch({ ...base, intervalMs: 100 })).not.toThrow();
		expect(() => createAuditWatch({ ...base, intervalMs: 1000 })).not.toThrow();
	});

	test("start schedules one tick callback, and the returned stop cancels it once", () => {
		const h = harness();
		const stop = h.watch.start();
		expect(h.timers.scheduled).toBeDefined();

		stop();
		stop();
		expect(h.timers.cleared).toBe(1);
	});

	test("a second start does not schedule another timer", () => {
		let scheduled = 0;
		const watch = createAuditWatch({
			intervalMs: 500,
			stat: () => undefined,
			acknowledged: () => ({ fingerprint: undefined, seq: 0, hash: GENESIS }),
			scan: () => ({ ok: true, records: 0, lastHash: GENESIS }),
			onAlert: () => {},
			setTimer: () => {
				scheduled += 1;
				return {};
			},
			clearTimer: () => {},
		});

		watch.start();
		watch.start();
		expect(scheduled).toBe(1);
	});

	test("the scheduled callback runs the same tick as a manual call", () => {
		const h = harness();
		h.watch.start();
		h.world.disk = fp(120, 2_000);
		h.world.outcome = { ok: false, records: 3, brokenAt: 4, reason: "hash mismatch" };
		h.timers.scheduled?.();

		expect(h.alerts.map((alert) => alert.kind)).toEqual(["chain_broken"]);
	});

	test("fullScanEveryTicks below 1 is rejected", () => {
		expect(() => harness({ fullScanEveryTicks: 0 })).toThrow(RangeError);
	});
});
