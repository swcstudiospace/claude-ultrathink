// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { describe, expect, test } from "bun:test";
import { ConsoleSecurityEventLogger } from "../security/events.ts";
import { type Admission, type AdmitResult, type FairShare, type FairShareTimers, createFairShare } from "./fair-share.ts";
import { createLogger } from "./log.ts";

const owner: Admission = { principal: "owner", class: "owner" };
const connector = (principal: string): Admission => ({ principal, class: "connector" });

describe("createFairShare admission order", () => {
	test("owner fills to capacity; the next owner acquire is refused capacity", () => {
		const pool = createFairShare({ capacity: 3, reserve: 1 });
		for (let i = 0; i < 3; i++) {
			expect(pool.acquire(owner).ok).toBe(true);
		}
		expect(pool.held).toBe(3);
		expect(pool.acquire(owner)).toEqual({ ok: false, reason: "capacity" });
	});

	test("connector stops at capacity - reserve with reason reserved; owner still admitted into the reserve", () => {
		const pool = createFairShare({ capacity: 3, reserve: 1 });
		expect(pool.acquire(connector("a")).ok).toBe(true);
		expect(pool.acquire(connector("b")).ok).toBe(true);
		expect(pool.held).toBe(2);
		expect(pool.acquire(connector("c"))).toEqual({ ok: false, reason: "reserved" });
		expect(pool.acquire(owner).ok).toBe(true);
		expect(pool.held).toBe(3);
		expect(pool.acquire(owner)).toEqual({ ok: false, reason: "capacity" });
	});

	test("two connector principals each get their own admission until the reserve line", () => {
		const pool = createFairShare({ capacity: 4, reserve: 1, perPrincipalMax: 2 });
		expect(pool.acquire(connector("a")).ok).toBe(true);
		expect(pool.acquire(connector("b")).ok).toBe(true);
		expect(pool.acquire(connector("a")).ok).toBe(true);
		expect(pool.acquire(connector("c"))).toEqual({ ok: false, reason: "reserved" });
	});

	test("a single connector principal is refused principal at perPrincipalMax while another is still admitted", () => {
		const pool = createFairShare({ capacity: 4, reserve: 0, perPrincipalMax: 1 });
		expect(pool.acquire(connector("a")).ok).toBe(true);
		expect(pool.acquire(connector("a"))).toEqual({ ok: false, reason: "principal" });
		expect(pool.acquire(connector("b")).ok).toBe(true);
		expect(pool.held).toBe(2);
	});

	test("owner is never refused principal, even above perPrincipalMax", () => {
		const pool = createFairShare({ capacity: 4, reserve: 1, perPrincipalMax: 1 });
		expect(pool.acquire(owner).ok).toBe(true);
		expect(pool.acquire(owner).ok).toBe(true);
		expect(pool.acquire(owner).ok).toBe(true);
		expect(pool.held).toBe(3);
	});

	test("perPrincipalMax defaults to capacity", () => {
		const pool = createFairShare({ capacity: 3, reserve: 0 });
		expect(pool.acquire(connector("a")).ok).toBe(true);
		expect(pool.acquire(connector("a")).ok).toBe(true);
		expect(pool.acquire(connector("a")).ok).toBe(true);
		expect(pool.acquire(connector("a"))).toEqual({ ok: false, reason: "capacity" });
	});

	test("bearer class is non-owner: reserved and principal rules apply", () => {
		const pool = createFairShare({ capacity: 2, reserve: 1 });
		const bearer: Admission = { principal: "oauth-1", class: "bearer" };
		expect(pool.acquire(bearer).ok).toBe(true);
		expect(pool.acquire(bearer)).toEqual({ ok: false, reason: "reserved" });
	});
});

describe("createFairShare release and refusal", () => {
	test("refused acquire leaves held unchanged", () => {
		const pool = createFairShare({ capacity: 2, reserve: 1 });
		expect(pool.acquire(owner).ok).toBe(true);
		expect(pool.acquire(owner).ok).toBe(true);
		expect(pool.held).toBe(2);
		expect(pool.acquire(owner)).toEqual({ ok: false, reason: "capacity" });
		expect(pool.acquire(connector("a"))).toEqual({ ok: false, reason: "capacity" });
		expect(pool.held).toBe(2);
	});

	test("releasing a handle frees its slot", () => {
		const pool = createFairShare({ capacity: 1, reserve: 0 });
		const first = pool.acquire(owner);
		if (!first.ok) throw new Error("expected admission");
		expect(pool.acquire(owner)).toEqual({ ok: false, reason: "capacity" });
		first.release();
		expect(pool.held).toBe(0);
		expect(pool.acquire(owner).ok).toBe(true);
	});

	test("double release frees exactly one slot: the next connector acquire is still refused reserved", () => {
		const pool = createFairShare({ capacity: 2, reserve: 1 });
		const first = pool.acquire(owner);
		const second = pool.acquire(owner);
		if (!first.ok || !second.ok) throw new Error("expected admissions");
		first.release();
		first.release();
		expect(pool.held).toBe(1);
		expect(pool.acquire(connector("a"))).toEqual({ ok: false, reason: "reserved" });
		expect(pool.acquire(owner).ok).toBe(true);
		expect(pool.acquire(owner)).toEqual({ ok: false, reason: "capacity" });
	});

	test("double release does not free the principal slot twice", () => {
		const pool = createFairShare({ capacity: 4, reserve: 0, perPrincipalMax: 1 });
		const a = pool.acquire(connector("a"));
		if (!a.ok) throw new Error("expected admission");
		a.release();
		a.release();
		expect(pool.acquire(connector("a")).ok).toBe(true);
		expect(pool.acquire(connector("a"))).toEqual({ ok: false, reason: "principal" });
		expect(pool.held).toBe(1);
	});
});

describe("createFairShare option validation", () => {
	test("invalid options throw RangeError", () => {
		expect(() => createFairShare({ capacity: 0, reserve: 0 })).toThrow(RangeError);
		expect(() => createFairShare({ capacity: 2.5, reserve: 0 })).toThrow(RangeError);
		expect(() => createFairShare({ capacity: Number.NaN, reserve: 0 })).toThrow(RangeError);
		expect(() => createFairShare({ capacity: 4, reserve: -1 })).toThrow(RangeError);
		expect(() => createFairShare({ capacity: 4, reserve: 4 })).toThrow(RangeError);
		expect(() => createFairShare({ capacity: 4, reserve: 1.5 })).toThrow(RangeError);
		expect(() => createFairShare({ capacity: 4, reserve: 1, perPrincipalMax: 0 })).toThrow(RangeError);
		expect(() => createFairShare({ capacity: 4, reserve: 1, perPrincipalMax: 5 })).toThrow(RangeError);
		expect(() => createFairShare({ capacity: 4, reserve: 1, perPrincipalMax: 1.5 })).toThrow(RangeError);
	});

	test("reserve 0 and perPrincipalMax equal to capacity are accepted", () => {
		expect(() => createFairShare({ capacity: 1, reserve: 0 })).not.toThrow();
		expect(() => createFairShare({ capacity: 4, reserve: 0, perPrincipalMax: 4 })).not.toThrow();
	});
});

interface FakeTimer {
	ms: number;
	cleared: boolean;
	fired: boolean;
	run: () => void;
}

/** A timer seam the test drives: `timers[i].run()` fires a wait, and a cleared timer is recorded. */
function fakeTimers() {
	const timers: FakeTimer[] = [];
	const seam: FairShareTimers = {
		setTimeout: (run, ms) => {
			const timer: FakeTimer = {
				ms,
				cleared: false,
				fired: false,
				run: () => {
					timer.fired = true;
					run();
				},
			};
			timers.push(timer);
			return timer;
		},
		clearTimeout: (handle) => {
			(handle as FakeTimer).cleared = true;
		},
	};
	return { seam, timers, pending: () => timers.filter((timer) => !timer.cleared && !timer.fired).length };
}

/** Parsed security log lines, in emission order. */
function capture() {
	const lines: string[] = [];
	const security = new ConsoleSecurityEventLogger(createLogger({ write: (line) => lines.push(line) }));
	const events = () => lines.map((line) => JSON.parse(line) as { event: string; details: Record<string, unknown> });
	return { security, events };
}

/** Lets resolved promises and their continuations run. */
async function flush(): Promise<void> {
	for (let i = 0; i < 5; i++) await Promise.resolve();
}

const bearer = (principal: string): Admission => ({ principal, class: "bearer" });

async function heldSlot(pool: FairShare, admission: Admission): Promise<() => void> {
	const result = await pool.admit(admission);
	if (!result.ok) throw new Error("expected admission");
	return result.release;
}

describe("createFairShare queue admission order", () => {
	test("waiters of one class are granted first in, first out as slots free", async () => {
		const fake = fakeTimers();
		const pool = createFairShare({ capacity: 1, reserve: 0, queue: { depth: 4, waitMs: 1000, timers: fake.seam } });
		const release = await heldSlot(pool, owner);
		const grants: string[] = [];
		const releases = new Map<string, () => void>();
		const enqueue = (who: Admission) =>
			pool.admit(who).then((result) => {
				if (!result.ok) throw new Error(`refused ${who.principal}`);
				grants.push(who.principal);
				releases.set(who.principal, result.release);
			});
		const waits = [enqueue(connector("a")), enqueue(connector("b")), enqueue(connector("c"))];
		expect(pool.queued).toBe(3);

		release();
		await flush();
		expect(grants).toEqual(["a"]);
		releases.get("a")?.();
		await flush();
		expect(grants).toEqual(["a", "b"]);
		releases.get("b")?.();
		await Promise.all(waits);
		expect(grants).toEqual(["a", "b", "c"]);
		expect(pool.queued).toBe(0);
	});

	test("a freed slot goes to the highest class with waiters: owner, then connector, then bearer", async () => {
		const fake = fakeTimers();
		const pool = createFairShare({ capacity: 2, reserve: 0, queue: { depth: 4, waitMs: 1000, timers: fake.seam } });
		const releaseFirst = await heldSlot(pool, owner);
		const releaseSecond = await heldSlot(pool, { principal: "owner-2", class: "owner" });
		const grants: string[] = [];
		const releases = new Map<string, () => void>();
		const enqueue = (who: Admission) =>
			pool.admit(who).then((result) => {
				if (!result.ok) throw new Error(`refused ${who.principal}`);
				grants.push(who.principal);
				releases.set(who.principal, result.release);
			});
		// Arrival order is bearer, connector, owner: the grant order must be owner, connector, bearer.
		const waits = [enqueue(bearer("b")), enqueue(connector("c")), enqueue({ principal: "o3", class: "owner" })];
		expect(pool.queued).toBe(3);

		releaseFirst();
		await flush();
		expect(grants).toEqual(["o3"]);
		releaseSecond();
		await flush();
		expect(grants).toEqual(["o3", "c"]);
		releases.get("o3")?.();
		await flush();
		expect(grants).toEqual(["o3", "c", "b"]);
		releases.get("c")?.();
		releases.get("b")?.();
		await Promise.all(waits);
	});

	test("a principal at its cap waits behind its own slot and is granted when that slot frees", async () => {
		const fake = fakeTimers();
		const pool = createFairShare({ capacity: 4, reserve: 0, perPrincipalMax: 1, queue: { depth: 4, waitMs: 1000, timers: fake.seam } });
		const release = await heldSlot(pool, connector("a"));
		const waiting = pool.admit(connector("a"));
		expect(pool.queued).toBe(1);
		release();
		expect(await waiting).toMatchObject({ ok: true });
	});

	test("an admission that fits takes its slot at once and sets no timer", async () => {
		const fake = fakeTimers();
		const pool = createFairShare({ capacity: 2, reserve: 0, queue: { depth: 4, waitMs: 1000, timers: fake.seam } });
		expect((await pool.admit(connector("a"))).ok).toBe(true);
		expect(fake.timers).toEqual([]);
	});
});

describe("createFairShare queue refusals", () => {
	test("a full queue refuses at once with the budget reason, leaves the queue alone and reports the refusal", async () => {
		const fake = fakeTimers();
		const log = capture();
		const pool = createFairShare({
			capacity: 1,
			reserve: 0,
			queue: { depth: 1, waitMs: 1000, timers: fake.seam },
			security: log.security,
		});
		const release = await heldSlot(pool, owner);
		const waiting = pool.admit(connector("a"));

		expect(await pool.admit(connector("b"))).toEqual({ ok: false, reason: "capacity", cause: "queue_full" });
		expect(pool.queued).toBe(1);
		expect(fake.timers).toHaveLength(1);
		expect(log.events()).toMatchObject([
			{ event: "rate_limit.fair_share_refused", details: { class: "connector", reason: "capacity", cause: "queue_full" } },
		]);

		release();
		expect((await waiting).ok).toBe(true);
	});

	test("queue depth 0 refuses at once and never sets a timer", async () => {
		const fake = fakeTimers();
		const pool = createFairShare({ capacity: 1, reserve: 0, queue: { depth: 0, waitMs: 1000, timers: fake.seam } });
		await heldSlot(pool, owner);
		expect(await pool.admit(connector("a"))).toEqual({ ok: false, reason: "capacity", cause: "queue_full" });
		expect(fake.timers).toEqual([]);
	});

	test("an expired wait refuses with the budget reason, leaves the queue and reports the expiry", async () => {
		const fake = fakeTimers();
		const log = capture();
		const pool = createFairShare({
			capacity: 1,
			reserve: 0,
			queue: { depth: 4, waitMs: 1500, timers: fake.seam },
			security: log.security,
		});
		const release = await heldSlot(pool, owner);
		const waiting = pool.admit(connector("a"));
		expect(fake.timers.map((timer) => timer.ms)).toEqual([1500]);

		fake.timers[0]?.run();
		expect(await waiting).toEqual({ ok: false, reason: "capacity", cause: "expired" });
		expect(pool.queued).toBe(0);
		expect(log.events()).toMatchObject([{ event: "rate_limit.fair_share_refused", details: { cause: "expired" } }]);

		release();
		expect(pool.held).toBe(0);
		expect(pool.acquire(connector("c")).ok).toBe(true);
	});

	test("an acquire refusal reports the budget reason through the security logger, with no principal", () => {
		const log = capture();
		const pool = createFairShare({ capacity: 1, reserve: 0, security: log.security });
		expect(pool.acquire(owner).ok).toBe(true);
		expect(pool.acquire(owner)).toEqual({ ok: false, reason: "capacity" });
		const events = log.events();
		expect(events).toMatchObject([{ event: "rate_limit.fair_share_refused", details: { class: "owner", reason: "capacity", cause: "budget" } }]);
		expect(Object.keys(events[0]?.details ?? {}).sort()).toEqual(["cause", "class", "eventType", "reason"]);
	});

	test("an already aborted signal is refused without taking a slot", async () => {
		const pool = createFairShare({ capacity: 2, reserve: 0, queue: { depth: 4, waitMs: 1000 } });
		const controller = new AbortController();
		controller.abort();
		expect(await pool.admit(owner, { signal: controller.signal })).toEqual({ ok: false, cause: "aborted" });
		expect(pool.held).toBe(0);
	});
});

describe("createFairShare queue abort and timer cleanup", () => {
	test("an aborted wait leaves the queue, clears its timer and reports no refusal", async () => {
		const fake = fakeTimers();
		const log = capture();
		const pool = createFairShare({
			capacity: 1,
			reserve: 0,
			queue: { depth: 4, waitMs: 1500, timers: fake.seam },
			security: log.security,
		});
		const release = await heldSlot(pool, owner);
		const controller = new AbortController();
		const waiting = pool.admit(connector("a"), { signal: controller.signal });
		expect(pool.queued).toBe(1);

		controller.abort();
		expect(await waiting).toEqual({ ok: false, cause: "aborted" });
		expect(pool.queued).toBe(0);
		expect(fake.timers[0]?.cleared).toBe(true);
		expect(fake.pending()).toBe(0);
		expect(log.events()).toEqual([]);

		release();
		expect(pool.held).toBe(0);
	});

	test("an aborted head does not hold back the waiter behind it", async () => {
		const fake = fakeTimers();
		const pool = createFairShare({ capacity: 1, reserve: 0, queue: { depth: 4, waitMs: 1500, timers: fake.seam } });
		const release = await heldSlot(pool, owner);
		const controller = new AbortController();
		const aborted = pool.admit(connector("a"), { signal: controller.signal });
		const next = pool.admit(connector("b"));

		controller.abort();
		expect(await aborted).toEqual({ ok: false, cause: "aborted" });
		expect(pool.queued).toBe(1);

		release();
		expect(await next).toMatchObject({ ok: true });
		expect(pool.queued).toBe(0);
	});

	test("a waiter granted from the queue clears its timer, and a later abort changes nothing", async () => {
		const fake = fakeTimers();
		const pool = createFairShare({ capacity: 1, reserve: 0, queue: { depth: 4, waitMs: 1500, timers: fake.seam } });
		const release = await heldSlot(pool, owner);
		const controller = new AbortController();
		const waiting = pool.admit(connector("a"), { signal: controller.signal });

		release();
		const granted: AdmitResult = await waiting;
		expect(granted.ok).toBe(true);
		expect(fake.timers[0]?.cleared).toBe(true);
		expect(fake.pending()).toBe(0);

		controller.abort();
		expect(pool.held).toBe(1);
		expect(pool.queued).toBe(0);
	});

	test("invalid queue options throw RangeError", () => {
		expect(() => createFairShare({ capacity: 2, reserve: 0, queue: { depth: -1, waitMs: 1000 } })).toThrow(RangeError);
		expect(() => createFairShare({ capacity: 2, reserve: 0, queue: { depth: 1.5, waitMs: 1000 } })).toThrow(RangeError);
		expect(() => createFairShare({ capacity: 2, reserve: 0, queue: { depth: 4, waitMs: 0 } })).toThrow(RangeError);
	});
});

describe("createFairShare onWait", () => {
	test("onWait runs once, before the admission queues, and not when the admission fits or is refused", async () => {
		const fake = fakeTimers();
		const pool = createFairShare({ capacity: 1, reserve: 0, queue: { depth: 1, waitMs: 1000, timers: fake.seam } });
		let waits = 0;
		const onWait = () => {
			waits += 1;
			expect(pool.queued).toBe(0);
		};

		const release = await heldSlot(pool, owner);
		const waiting = pool.admit(connector("a"), { onWait });
		expect(waits).toBe(1);
		expect(pool.queued).toBe(1);

		expect(await pool.admit(connector("b"), { onWait })).toMatchObject({ ok: false, cause: "queue_full" });
		expect(waits).toBe(1);

		release();
		expect(await waiting).toMatchObject({ ok: true });
		expect(waits).toBe(1);

		const fits = createFairShare({ capacity: 2, reserve: 0, queue: { depth: 1, waitMs: 1000, timers: fake.seam } });
		expect((await fits.admit(connector("c"), { onWait })).ok).toBe(true);
		expect(waits).toBe(1);
	});

	test("an arrival that fits takes its slot even while a same-class waiter is blocked by its own principal cap", async () => {
		const fake = fakeTimers();
		const pool = createFairShare({ capacity: 4, reserve: 0, perPrincipalMax: 1, queue: { depth: 4, waitMs: 1000, timers: fake.seam } });
		const release = await heldSlot(pool, connector("a"));
		const blocked = pool.admit(connector("a"));
		expect(pool.queued).toBe(1);
		expect((await pool.admit(connector("b"))).ok).toBe(true);
		expect(pool.held).toBe(2);

		release();
		expect(await blocked).toMatchObject({ ok: true });
	});
});
