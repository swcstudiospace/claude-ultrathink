// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { describe, expect, test } from "bun:test";
import { type Admission, createFairShare } from "./fair-share.ts";

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
