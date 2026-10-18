// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { randomBytes } from "node:crypto";
import { beforeAll, describe, expect, test } from "bun:test";
import { type Auth, type AuthOptions, clientIpFrom, createAuth } from "./auth.ts";

const PASSWORD = randomBytes(24).toString("base64url");
const WRONG_PASSWORD = `${PASSWORD}-wrong`;
const SESSION_SECRET = randomBytes(48).toString("base64url");
const OTHER_SECRET = randomBytes(48).toString("base64url");
const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;
const COOKIE_PREFIX = "ut_session=";
const ORIGIN = "https://ultrathink.swcstudio.space/ultrathink";

let HASH = "";

beforeAll(async () => {
	HASH = await Bun.password.hash(PASSWORD);
});

function makeClock(start = 1_700_000_000_000): { t: number } {
	return { t: start };
}

function makeAuth(clock: { t: number }, overrides: Partial<AuthOptions> = {}): Auth {
	return createAuth({
		ownerPasswordHash: HASH,
		sessionSecret: SESSION_SECRET,
		cookieSecure: true,
		now: () => clock.t,
		...overrides,
	});
}

function cookieValueOf(setCookie: string): string {
	return setCookie.slice(COOKIE_PREFIX.length, setCookie.indexOf(";"));
}

function requestWithCookieValue(value: string): Request {
	return new Request(ORIGIN, { headers: { cookie: `${COOKIE_PREFIX}${value}` } });
}

describe("login", () => {
	test("correct password issues a HttpOnly, SameSite=Strict, Secure session cookie", async () => {
		const auth = makeAuth(makeClock());
		const result = await auth.login({ password: PASSWORD, clientIp: "198.51.100.1" });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.setCookie.startsWith(COOKIE_PREFIX)).toBe(true);
		expect(result.setCookie).toContain("; Path=/");
		expect(result.setCookie).toContain("; HttpOnly");
		expect(result.setCookie).toContain("; SameSite=Strict");
		expect(result.setCookie).toContain("; Max-Age=43200");
		expect(result.setCookie.endsWith("; Secure")).toBe(true);
	});

	test("omits Secure when cookieSecure is false", async () => {
		const auth = makeAuth(makeClock(), { cookieSecure: false });
		const result = await auth.login({ password: PASSWORD, clientIp: "198.51.100.1" });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.setCookie.split("; ").includes("Secure")).toBe(false);
	});

	test("wrong password returns invalid", async () => {
		const auth = makeAuth(makeClock());
		const result = await auth.login({ password: WRONG_PASSWORD, clientIp: "198.51.100.1" });
		expect(result).toEqual({ ok: false, reason: "invalid" });
	});

	test("sixth attempt from one IP is rate limited", async () => {
		const auth = makeAuth(makeClock());
		const ip = "198.51.100.2";
		for (let i = 0; i < 5; i++) {
			const result = await auth.login({ password: WRONG_PASSWORD, clientIp: ip });
			expect(result).toEqual({ ok: false, reason: "invalid" });
		}
		const sixth = await auth.login({ password: PASSWORD, clientIp: ip });
		expect(sixth.ok).toBe(false);
		if (sixth.ok) return;
		expect(sixth.reason).toBe("rate_limited");
		expect(sixth.retryAfterSec ?? 0).toBeGreaterThan(0);
	});

	test("owner-level limit blocks after ten failures from distinct IPs", async () => {
		const auth = makeAuth(makeClock());
		for (let i = 0; i < 10; i++) {
			const result = await auth.login({ password: WRONG_PASSWORD, clientIp: `198.51.100.${10 + i}` });
			expect(result).toEqual({ ok: false, reason: "invalid" });
		}
		const eleventh = await auth.login({ password: PASSWORD, clientIp: "198.51.100.99" });
		expect(eleventh.ok).toBe(false);
		if (eleventh.ok) return;
		expect(eleventh.reason).toBe("rate_limited");
		expect(eleventh.retryAfterSec ?? 0).toBeGreaterThan(0);
	});

	test("malformed stored hash fails closed without throwing", async () => {
		const auth = makeAuth(makeClock(), { ownerPasswordHash: "not-a-hash" });
		const result = await auth.login({ password: PASSWORD, clientIp: "198.51.100.1" });
		expect(result).toEqual({ ok: false, reason: "invalid" });
	});

	test("results never contain the password, hash, or session secret", async () => {
		const auth = makeAuth(makeClock());
		const results = [
			await auth.login({ password: WRONG_PASSWORD, clientIp: "198.51.100.1" }),
			await auth.login({ password: PASSWORD, clientIp: "198.51.100.2" }),
			auth.logoutCookie(),
		];
		const blob = JSON.stringify(results);
		for (const secret of [PASSWORD, HASH, SESSION_SECRET]) {
			expect(blob.includes(secret)).toBe(false);
		}
	});
});

describe("sessionFor", () => {
	test("accepts the cookie it issued", async () => {
		const auth = makeAuth(makeClock());
		const result = await auth.login({ password: PASSWORD, clientIp: "198.51.100.1" });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const value = cookieValueOf(result.setCookie);
		expect(auth.sessionFor(requestWithCookieValue(value))).toEqual({ ownerId: "owner" });
	});

	test("rejects a tampered signature", async () => {
		const auth = makeAuth(makeClock());
		const result = await auth.login({ password: PASSWORD, clientIp: "198.51.100.1" });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const value = cookieValueOf(result.setCookie);
		const last = value.slice(-1);
		const tampered = value.slice(0, -1) + (last === "A" ? "B" : "A");
		expect(auth.sessionFor(requestWithCookieValue(tampered))).toBeNull();
	});

	test("rejects a tampered expiry that keeps the original signature", async () => {
		const auth = makeAuth(makeClock());
		const result = await auth.login({ password: PASSWORD, clientIp: "198.51.100.1" });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const value = cookieValueOf(result.setCookie);
		const dot = value.indexOf(".");
		const forged = `${Number(value.slice(0, dot)) + 60_000}${value.slice(dot)}`;
		expect(auth.sessionFor(requestWithCookieValue(forged))).toBeNull();
	});

	test("rejects a cookie signed with a different secret", async () => {
		const clock = makeClock();
		const other = makeAuth(clock, { sessionSecret: OTHER_SECRET });
		const result = await other.login({ password: PASSWORD, clientIp: "198.51.100.1" });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const auth = makeAuth(clock);
		expect(auth.sessionFor(requestWithCookieValue(cookieValueOf(result.setCookie)))).toBeNull();
	});

	test("rejects an expired cookie once twelve hours have passed", async () => {
		const clock = makeClock();
		const auth = makeAuth(clock);
		const result = await auth.login({ password: PASSWORD, clientIp: "198.51.100.1" });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const request = requestWithCookieValue(cookieValueOf(result.setCookie));
		clock.t += TWELVE_HOURS_MS - 1;
		expect(auth.sessionFor(request)).toEqual({ ownerId: "owner" });
		clock.t += 1;
		expect(auth.sessionFor(request)).toBeNull();
	});

	test("returns null when no session cookie is present", () => {
		const auth = makeAuth(makeClock());
		expect(auth.sessionFor(new Request(ORIGIN))).toBeNull();
	});
});

describe("logoutCookie", () => {
	test("expires the session cookie with Max-Age=0 and an empty value", () => {
		const cookie = makeAuth(makeClock()).logoutCookie();
		expect(cookie).toBe("ut_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0; Secure");
	});
});

describe("allowRequest", () => {
	test("owner is limited to 60 requests per minute", () => {
		const clock = makeClock();
		const auth = makeAuth(clock);
		for (let i = 0; i < 60; i++) {
			expect(auth.allowRequest({ clientIp: `10.0.0.${i}`, ownerId: "owner" })).toEqual({ ok: true });
		}
		const denied = auth.allowRequest({ clientIp: "10.0.1.1", ownerId: "owner" });
		expect(denied.ok).toBe(false);
		if (denied.ok) return;
		expect(denied.retryAfterSec).toBeGreaterThan(0);
		clock.t += 60_000;
		expect(auth.allowRequest({ clientIp: "10.0.1.1", ownerId: "owner" })).toEqual({ ok: true });
	});

	test("client IP is limited to 120 requests per minute", () => {
		const auth = makeAuth(makeClock());
		for (let i = 0; i < 120; i++) {
			expect(auth.allowRequest({ clientIp: "203.0.113.7", ownerId: `owner-${i}` })).toEqual({ ok: true });
		}
		const denied = auth.allowRequest({ clientIp: "203.0.113.7", ownerId: "owner-extra" });
		expect(denied.ok).toBe(false);
		if (denied.ok) return;
		expect(denied.retryAfterSec).toBeGreaterThan(0);
	});
});

describe("approval proofs", () => {
	const proof = {
		subject: "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG",
		nonce: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij0123456",
		issuedAt: 1_700_000_000_000,
		expiresAt: 1_700_000_600_000,
		refreshedAt: 1_700_000_045_000,
	};

	test("signs and verifies a nonce-bound approval proof", () => {
		const auth = makeAuth(makeClock());
		const nonce = auth.newApprovalNonce();
		expect(nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
		const signature = auth.signApproval({ ...proof, nonce });
		expect(auth.verifyApproval({ ...proof, nonce }, signature)).toBe(true);
	});

	test("rejects a tampered nonce, timestamp, or signature", () => {
		const auth = makeAuth(makeClock());
		// Always change the last character: overwriting it with a fixed "A" is a no-op about 1 run in 16.
		const flip = (value: string): string => `${value.slice(0, -1)}${value.endsWith("A") ? "B" : "A"}`;
		const signature = auth.signApproval(proof);
		expect(auth.verifyApproval({ ...proof, nonce: flip(proof.nonce) }, signature)).toBe(false);
		expect(auth.verifyApproval({ ...proof, expiresAt: proof.expiresAt + 1 }, signature)).toBe(false);
		expect(auth.verifyApproval({ ...proof, refreshedAt: proof.refreshedAt + 1 }, signature)).toBe(false);
		expect(auth.verifyApproval(proof, flip(signature))).toBe(false);
		expect(auth.verifyApproval(proof, signature.slice(0, -1))).toBe(false);
	});

	test("a signature from another secret does not verify", () => {
		const signature = makeAuth(makeClock(), { sessionSecret: OTHER_SECRET }).signApproval(proof);
		expect(makeAuth(makeClock()).verifyApproval(proof, signature)).toBe(false);
	});

	test("allows two approve attempts per minute and the third is limited", () => {
		const clock = makeClock();
		const auth = makeAuth(clock);
		expect(auth.allowApprovalAttempt("198.51.100.40")).toEqual({ ok: true });
		expect(auth.allowApprovalAttempt("198.51.100.40")).toEqual({ ok: true });
		const denied = auth.allowApprovalAttempt("198.51.100.40");
		expect(denied.ok).toBe(false);
		if (denied.ok) return;
		expect(denied.retryAfterSec).toBeGreaterThan(0);
		expect(auth.allowApprovalAttempt("198.51.100.41")).toEqual({ ok: true });
		clock.t += 60_000;
		expect(auth.allowApprovalAttempt("198.51.100.40")).toEqual({ ok: true });
	});
});

describe("clientIpFrom", () => {
	function requestWithRealIp(value?: string): Request {
		return new Request(ORIGIN, { headers: value === undefined ? {} : { "x-real-ip": value } });
	}

	test("ignores X-Real-IP from a non-loopback peer", () => {
		expect(clientIpFrom(requestWithRealIp("198.51.100.9"), "203.0.113.5")).toBe("203.0.113.5");
	});

	test("honours X-Real-IP from loopback peers", () => {
		for (const peer of ["127.0.0.1", "::1", "::ffff:127.0.0.1"]) {
			expect(clientIpFrom(requestWithRealIp("198.51.100.9"), peer)).toBe("198.51.100.9");
		}
	});

	test("falls back to the peer when a loopback request has no usable header", () => {
		expect(clientIpFrom(requestWithRealIp(), "127.0.0.1")).toBe("127.0.0.1");
		expect(clientIpFrom(requestWithRealIp("not an ip!"), "127.0.0.1")).toBe("127.0.0.1");
	});
});
