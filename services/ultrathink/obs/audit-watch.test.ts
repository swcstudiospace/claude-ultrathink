// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { describe, expect, test } from "bun:test";
import { type Acknowledged, type AuditWatch, createAuditWatch, type Fingerprint, type ScanReply, type WatchAlert } from "./audit-watch.ts";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditPath, createAuditLog } from "./audit.ts";

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
		outcome: ScanReply;
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
		scan: async () => {
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
		tickMany: async (count: number) => {
			for (let i = 0; i < count; i += 1) await watch.tick();
		},
	};
}

describe("own writes", () => {
	test("after a stat match with the acknowledged fingerprint, ten ticks do no scan and no alert", async () => {
		const h = harness();
		await h.tickMany(10);
		expect(h.world.scans).toBe(0);
		expect(h.alerts).toEqual([]);
	});
});

describe("external edits", () => {
	test("a changed file whose chain is broken alerts chain_broken on the first tick after the change", async () => {
		const h = harness();
		await h.tickMany(3);
		expect(h.alerts).toEqual([]);

		h.world.disk = fp(120, 2_000);
		h.world.outcome = { ok: false, records: 3, brokenAt: 4, reason: "hash mismatch" };
		await h.watch.tick();

		expect(h.world.scans).toBe(1);
		expect(h.alerts).toHaveLength(1);
		expect(h.alerts[0]?.kind).toBe("chain_broken");
		expect(h.alerts[0]?.reason).toContain("record 4");
	});

	test("tail truncation with an intact prefix alerts head_mismatch", async () => {
		const h = harness();
		h.world.disk = fp(60, 2_000);
		h.world.outcome = { ok: true, records: 3, lastHash: OTHER_HASH };
		await h.watch.tick();

		expect(h.alerts).toHaveLength(1);
		expect(h.alerts[0]?.kind).toBe("head_mismatch");
		expect(h.alerts[0]?.reason).toContain("record 5");
	});

	test("a clean chain whose last hash differs from the acknowledged hash alerts head_mismatch", async () => {
		const h = harness();
		h.world.disk = fp(100, 2_000);
		h.world.outcome = { ok: true, records: 5, lastHash: OTHER_HASH };
		await h.watch.tick();

		expect(h.alerts.map((alert) => alert.kind)).toEqual(["head_mismatch"]);
	});

	test("a removed file while the acknowledged seq is above zero alerts head_mismatch", async () => {
		const h = harness();
		h.world.disk = undefined;
		await h.watch.tick();

		expect(h.alerts).toHaveLength(1);
		expect(h.alerts[0]?.kind).toBe("head_mismatch");
	});

	test("a missing file with an empty acknowledged head is not an alert", async () => {
		const h = harness();
		h.world.disk = undefined;
		h.world.ack = { fingerprint: undefined, seq: 0, hash: GENESIS };
		h.world.outcome = { ok: true, records: 0, lastHash: GENESIS };
		await h.tickMany(3);

		expect(h.alerts).toEqual([]);
		expect(h.recovers()).toBe(0);
	});

	test("a touched file whose chain and head still match gives no alert", async () => {
		const h = harness();
		h.world.disk = fp(100, 9_999);
		h.world.outcome = { ok: true, records: 5, lastHash: HEAD_HASH };
		await h.watch.tick();

		expect(h.world.scans).toBe(1);
		expect(h.alerts).toEqual([]);
	});

	test("an in-place edit that keeps size and mtime is not caught on ticks 1 to 59 and is caught on tick 60", async () => {
		const h = harness();
		// The file was edited in place: its stat still equals the acknowledged fingerprint.
		h.world.outcome = { ok: false, records: 2, brokenAt: 3, reason: "hash mismatch" };

		await h.tickMany(59);
		expect(h.world.scans).toBe(0);
		expect(h.alerts).toEqual([]);

		await h.watch.tick();
		expect(h.world.scans).toBe(1);
		expect(h.alerts.map((alert) => alert.kind)).toEqual(["chain_broken"]);
	});
});

describe("alert lifecycle", () => {
	test("a persisting condition alerts once, and onRecover fires after it clears", async () => {
		const h = harness();
		h.world.disk = fp(120, 2_000);
		h.world.outcome = { ok: false, records: 3, brokenAt: 4, reason: "hash mismatch" };
		await h.tickMany(5);

		expect(h.alerts).toHaveLength(1);
		expect(h.world.scans).toBe(1);
		expect(h.recovers()).toBe(0);

		// The file is restored to the log's own fingerprint and head. Ticks that are not full scans do not clear the alert.
		h.world.disk = fp(100, 1_000);
		h.world.outcome = { ok: true, records: 5, lastHash: HEAD_HASH };
		await h.tickMany(54);
		expect(h.recovers()).toBe(0);
		expect(h.alerts).toHaveLength(1);

		// The next full scan (tick 60) finds the chain healthy and clears the alert.
		await h.watch.tick();

		expect(h.recovers()).toBe(1);
		expect(h.alerts).toHaveLength(1);
	});

	test("a condition that changes again while still broken re-scans without a second alert for the same reason", async () => {
		const h = harness();
		h.world.disk = fp(120, 2_000);
		h.world.outcome = { ok: false, records: 3, brokenAt: 4, reason: "hash mismatch" };
		await h.watch.tick();

		h.world.disk = fp(121, 3_000);
		await h.watch.tick();

		expect(h.world.scans).toBe(2);
		expect(h.alerts).toHaveLength(1);
	});

	test("onRecover does not fire when nothing was alerting", async () => {
		const h = harness();
		h.world.disk = fp(120, 2_000);
		h.world.outcome = { ok: true, records: 5, lastHash: HEAD_HASH };
		await h.tickMany(3);

		expect(h.alerts).toEqual([]);
		expect(h.recovers()).toBe(0);
	});

	test("a broken scan under an unchanged fingerprint keeps the alert across non-full ticks", async () => {
		const h = harness();
		h.world.outcome = { ok: false, records: 2, brokenAt: 3, reason: "hash mismatch" };
		await h.tickMany(60);
		expect(h.alerts.map((alert) => alert.kind)).toEqual(["chain_broken"]);

		// The file still matches the acknowledged fingerprint. Ticks that are not full scans must not retract the alert.
		await h.tickMany(59);
		expect(h.world.scans).toBe(1);
		expect(h.recovers()).toBe(0);
		expect(h.alerts).toHaveLength(1);

		// Only a full scan that comes back healthy clears it.
		h.world.outcome = { ok: true, records: 5, lastHash: HEAD_HASH };
		await h.tickMany(60);
		expect(h.recovers()).toBe(1);
	});
});

describe("off the request path", () => {
	/** A watch whose scan waits for the test to release it, so the scan is visibly in flight. */
	function deferredWatch(alerts: WatchAlert[]) {
		let scans = 0;
		let release: ((reply: ScanReply) => void) | undefined;
		const watch = createAuditWatch({
			intervalMs: 1000,
			stat: () => fp(120, 2_000),
			acknowledged: () => ({ fingerprint: fp(100, 1_000), seq: 5, hash: HEAD_HASH }),
			scan: () => {
				scans += 1;
				return new Promise<ScanReply>((resolve) => {
					release = resolve;
				});
			},
			onAlert: (alert) => alerts.push(alert),
		});
		return { watch, scans: () => scans, release: (reply: ScanReply) => release?.(reply) };
	}

	test("a tick returns before its scan settles, and raises nothing until the verdict lands", async () => {
		const alerts: WatchAlert[] = [];
		const d = deferredWatch(alerts);
		const pending = d.watch.tick();
		expect(d.scans()).toBe(1);
		expect(alerts).toEqual([]);

		d.release({ ok: false, records: 2, brokenAt: 3, reason: "hash mismatch" });
		await pending;
		expect(alerts.map((alert) => alert.kind)).toEqual(["chain_broken"]);
	});

	test("while a scan is in flight, further ticks start no second scan", async () => {
		const alerts: WatchAlert[] = [];
		const d = deferredWatch(alerts);
		const first = d.watch.tick();
		const second = d.watch.tick();
		const third = d.watch.tick();
		expect(d.scans()).toBe(1);

		d.release({ ok: true, records: 5, lastHash: HEAD_HASH });
		await Promise.all([first, second, third]);
		expect(alerts).toEqual([]);
	});

	test("a raced verdict decides nothing, and the next tick scans again", async () => {
		const h = harness();
		h.world.disk = fp(120, 2_000);
		h.world.outcome = "raced";
		await h.watch.tick();
		expect(h.world.scans).toBe(1);
		expect(h.alerts).toEqual([]);

		h.world.outcome = { ok: false, records: 3, brokenAt: 4, reason: "hash mismatch" };
		await h.watch.tick();
		expect(h.world.scans).toBe(2);
		expect(h.alerts.map((alert) => alert.kind)).toEqual(["chain_broken"]);
	});

	test("a full scan that comes back raced is run again on the next tick", async () => {
		const h = harness();
		// The file matches the acknowledged fingerprint, so only a full scan can look at it, and tick 60 is the first one.
		h.world.outcome = "raced";
		await h.tickMany(59);
		expect(h.world.scans).toBe(0);

		await h.watch.tick();
		expect(h.world.scans).toBe(1);
		expect(h.alerts).toEqual([]);

		// Tick 61 is not a full-scan tick and the file is unchanged, but the discarded full scan is owed.
		h.world.outcome = { ok: true, records: 5, lastHash: HEAD_HASH };
		await h.watch.tick();
		expect(h.world.scans).toBe(2);
		expect(h.alerts).toEqual([]);
	});

	test("a verdict from a scan that began before the file went missing does not clear the newer alert", async () => {
		const alerts: WatchAlert[] = [];
		let disk: Fingerprint | undefined = fp(120, 2_000);
		const slot: { release?: (reply: ScanReply) => void } = {};
		const watch = createAuditWatch({
			intervalMs: 1000,
			stat: () => disk,
			acknowledged: () => ({ fingerprint: fp(100, 1_000), seq: 5, hash: HEAD_HASH }),
			scan: () =>
				new Promise<ScanReply>((resolve) => {
					slot.release = resolve;
				}),
			onAlert: (alert) => alerts.push(alert),
			onRecover: () => alerts.push({ kind: "head_mismatch", reason: "recovered" }),
		});

		const pending = watch.tick();
		disk = undefined;
		void watch.tick();
		expect(alerts.map((alert) => alert.kind)).toEqual(["head_mismatch"]);

		// The scan that started before the removal reports a healthy chain; it must not clear the missing-file alert.
		slot.release?.({ ok: true, records: 5, lastHash: HEAD_HASH });
		await pending;
		expect(alerts.map((alert) => alert.kind)).toEqual(["head_mismatch"]);
	});

	test("a scan that rejects alerts once with the failure, and the next tick scans again", async () => {
		const alerts: WatchAlert[] = [];
		let scans = 0;
		const watch = createAuditWatch({
			intervalMs: 1000,
			stat: () => fp(120, 2_000),
			acknowledged: () => ({ fingerprint: fp(100, 1_000), seq: 5, hash: HEAD_HASH }),
			scan: async () => {
				scans += 1;
				throw new Error("worker crashed");
			},
			onAlert: (alert) => alerts.push(alert),
		});
		await watch.tick();
		await watch.tick();

		expect(scans).toBe(2);
		expect(alerts).toEqual([{ kind: "chain_broken", reason: "verifier failed: worker crashed" }]);
	});

	test("idle resolves once no scan is in flight", async () => {
		const alerts: WatchAlert[] = [];
		const d = deferredWatch(alerts);
		void d.watch.tick();
		let settled = false;
		const waiting = d.watch.idle().then(() => {
			settled = true;
		});
		await Promise.resolve();
		expect(settled).toBe(false);

		d.release({ ok: true, records: 5, lastHash: HEAD_HASH });
		await waiting;
		expect(settled).toBe(true);
	});

	test("an onAlert that throws is reported through onError, and idle still resolves", async () => {
		const errors: unknown[] = [];
		const watch = createAuditWatch({
			intervalMs: 1000,
			stat: () => fp(120, 2_000),
			acknowledged: () => ({ fingerprint: fp(100, 1_000), seq: 5, hash: HEAD_HASH }),
			scan: async () => ({ ok: false, records: 2, brokenAt: 3, reason: "hash mismatch" }),
			onAlert: () => {
				throw new Error("sink down");
			},
			onError: (error) => errors.push(error),
		});
		await watch.tick();
		await watch.idle();

		expect(errors).toEqual([expect.objectContaining({ message: "sink down" })]);
	});

	test("a full scan due while another runs is owed to the next tick, which runs it though the fingerprint matches", async () => {
		const alerts: WatchAlert[] = [];
		const resolvers: Array<(reply: ScanReply) => void> = [];
		let scans = 0;
		let disk = fp(120, 2_000);
		const watch = createAuditWatch({
			intervalMs: 1000,
			fullScanEveryTicks: 2,
			stat: () => disk,
			acknowledged: () => ({ fingerprint: fp(100, 1_000), seq: 5, hash: HEAD_HASH }),
			scan: () => {
				scans += 1;
				return new Promise<ScanReply>((resolve) => resolvers.push(resolve));
			},
			onAlert: (alert) => alerts.push(alert),
		});
		// Tick 1 starts a scan of the changed file and leaves it in flight. Tick 2 is a full-scan tick that falls due meanwhile.
		const first = watch.tick();
		const second = watch.tick();
		expect(scans).toBe(1);
		// The file is back to the log's own identity, so only the owed full scan can scan it on tick 3.
		disk = fp(100, 1_000);
		resolvers.shift()?.({ ok: true, records: 5, lastHash: HEAD_HASH });
		await Promise.all([first, second]);
		const third = watch.tick();
		expect(scans).toBe(2);
		resolvers.shift()?.({ ok: true, records: 5, lastHash: HEAD_HASH });
		await third;
		expect(alerts).toEqual([]);
	});
});

describe("timer and interval", () => {
	test("intervalMs 99 and 1001 throw RangeError; the 100 and 1000 bounds are accepted", () => {
		const base = { stat: () => undefined, acknowledged: () => ({ fingerprint: undefined, seq: 0, hash: GENESIS }), scan: async () => ({ ok: true as const, records: 0, lastHash: GENESIS }), onAlert: () => {} };
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
			scan: async () => ({ ok: true, records: 0, lastHash: GENESIS }),
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

	test("the scheduled callback runs the same tick as a manual call", async () => {
		const h = harness();
		h.watch.start();
		h.world.disk = fp(120, 2_000);
		h.world.outcome = { ok: false, records: 3, brokenAt: 4, reason: "hash mismatch" };
		h.timers.scheduled?.();
		await h.watch.idle();

		expect(h.alerts.map((alert) => alert.kind)).toEqual(["chain_broken"]);
	});

	test("fullScanEveryTicks below 1 is rejected", () => {
		expect(() => harness({ fullScanEveryTicks: 0 })).toThrow(RangeError);
	});
});

describe("pruned chain", () => {
	const MIB = 1024 * 1024;

	function bulk(i: number): Record<string, string | number> {
		const fields: Record<string, string | number> = { n: i };
		for (let k = 0; k < 31; k += 1) fields[`k${k}`] = "x".repeat(250);
		return fields;
	}

	function diskOf(path: string): Fingerprint | undefined {
		try {
			const stat = statSync(path);
			return { size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino };
		} catch {
			return undefined;
		}
	}

	test("a full scan of a pruned chain raises no tamper alert, and dropping its boundary record alerts", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ultrathink-watch-"));
		try {
			const path = auditPath(dir);
			let t = 1_700_000_000_000;
			const log = createAuditLog({ path, now: () => (t += 1000), segmentBytes: MIB });
			for (let i = 1; i <= 140; i += 1) log.record("login_ok", bulk(i));
			expect(log.prune(Number.MAX_SAFE_INTEGER)).toEqual({ segments: 1 });

			const alerts: WatchAlert[] = [];
			const watch = createAuditWatch({
				intervalMs: 1000,
				fullScanEveryTicks: 1,
				stat: () => diskOf(path),
				acknowledged: () => {
					const head = log.head();
					return { fingerprint: log.fingerprint(), seq: head.seq, hash: head.hash };
				},
				scan: async () => log.verify(),
				onAlert: (alert) => alerts.push(alert),
			});
			await watch.tick();
			expect(alerts).toEqual([]);

			// Drop the boundary record at the end of the file: the pruned chain no longer verifies, so the full scan alerts.
			const kept = readFileSync(path, "utf8").split("\n").filter((l) => l.length > 0).slice(0, -1);
			writeFileSync(path, kept.map((l) => `${l}\n`).join(""));
			await watch.tick();
			expect(alerts.map((alert) => alert.kind)).toEqual(["chain_broken"]);
			log.close();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
