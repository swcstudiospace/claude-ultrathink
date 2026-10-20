// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { createHmac, randomBytes } from "node:crypto";
import { beforeAll, describe, expect, test } from "bun:test";
import { type Auth, type AuthOptions, clientIpFrom, createAuth, keyIdOf, sessionCookieName } from "./auth.ts";

const PASSWORD = randomBytes(24).toString("base64url");
const WRONG_PASSWORD = `${PASSWORD}-wrong`;
const SESSION_SECRET = randomBytes(48).toString("base64url");
const OTHER_SECRET = randomBytes(48).toString("base64url");
const OLDER_SECRET = randomBytes(48).toString("base64url");
const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;
const COOKIE_PREFIX = "__Host-ut_session=";
const KID = /^[0-9a-f]{8}$/;
const BASE64URL_MAC = /^[A-Za-z0-9_-]{43}$/;
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
	test("correct password issues a __Host- HttpOnly, SameSite=Strict, Secure session cookie", async () => {
		const auth = makeAuth(makeClock());
		const result = await auth.login({ password: PASSWORD, clientIp: "198.51.100.1" });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.setCookie.startsWith(COOKIE_PREFIX)).toBe(true);
		expect(result.setCookie).toContain("; Path=/");
		expect(result.setCookie).toContain("; HttpOnly");
		expect(result.setCookie).toContain("; SameSite=Strict");
		expect(result.setCookie).toContain("; Max-Age=43200");
		expect(result.setCookie).not.toContain("Domain=");
		expect(result.setCookie.endsWith("; Secure")).toBe(true);
	});

	test("cookie value is <kid>.<expiresAt>.<mac> signed by the current secret", async () => {
		const clock = makeClock();
		const auth = makeAuth(clock);
		const result = await auth.login({ password: PASSWORD, clientIp: "198.51.100.1" });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const [kid, expiresAt, mac, ...rest] = cookieValueOf(result.setCookie).split(".");
		expect(rest).toEqual([]);
		expect(kid).toBe(keyIdOf(SESSION_SECRET));
		expect(kid).toMatch(KID);
		expect(expiresAt).toBe(String(clock.t + TWELVE_HOURS_MS));
		expect(mac).toMatch(BASE64URL_MAC);
	});

	test("uses the plain ut_session name and omits Secure when cookieSecure is false", async () => {
		const auth = makeAuth(makeClock(), { cookieSecure: false });
		const result = await auth.login({ password: PASSWORD, clientIp: "198.51.100.1" });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.setCookie.startsWith("ut_session=")).toBe(true);
		expect(result.setCookie.split("; ").includes("Secure")).toBe(false);
		const value = result.setCookie.slice("ut_session=".length, result.setCookie.indexOf(";"));
		const req = new Request(ORIGIN, { headers: { cookie: `ut_session=${value}` } });
		expect(auth.sessionFor(req)).toEqual({ ownerId: "owner" });
		expect(auth.sessionFor(requestWithCookieValue(value))).toBeNull();
	});

	test("sessionCookieName follows the Secure flag", () => {
		expect(sessionCookieName(true)).toBe("__Host-ut_session");
		expect(sessionCookieName(false)).toBe("ut_session");
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

	test("successful logins do not consume the per-IP window: six in a row from one IP all succeed", async () => {
		const auth = makeAuth(makeClock());
		const ip = "198.51.100.3";
		for (let i = 0; i < 6; i++) {
			const result = await auth.login({ password: PASSWORD, clientIp: ip });
			expect(result.ok).toBe(true);
		}
	});

	test("a success between failures does not reset the per-IP failure count", async () => {
		const auth = makeAuth(makeClock());
		const ip = "198.51.100.4";
		for (let i = 0; i < 4; i++) {
			expect(await auth.login({ password: WRONG_PASSWORD, clientIp: ip })).toEqual({ ok: false, reason: "invalid" });
		}
		expect((await auth.login({ password: PASSWORD, clientIp: ip })).ok).toBe(true);
		expect(await auth.login({ password: WRONG_PASSWORD, clientIp: ip })).toEqual({ ok: false, reason: "invalid" });
		const limited = await auth.login({ password: PASSWORD, clientIp: ip });
		expect(limited.ok).toBe(false);
		if (limited.ok) return;
		expect(limited.reason).toBe("rate_limited");
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
		const [kid, expiresAt, mac] = cookieValueOf(result.setCookie).split(".");
		const forged = `${kid}.${Number(expiresAt) + 60_000}.${mac}`;
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

	test("accepts a cookie signed with a previous secret during rotation", async () => {
		const clock = makeClock();
		const before = makeAuth(clock, { sessionSecret: OTHER_SECRET, previousSessionSecrets: [OLDER_SECRET] });
		const result = await before.login({ password: PASSWORD, clientIp: "198.51.100.1" });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const value = cookieValueOf(result.setCookie);
		expect(value.startsWith(`${keyIdOf(OTHER_SECRET)}.`)).toBe(true);
		const rotated = makeAuth(clock, { previousSessionSecrets: [OTHER_SECRET, OLDER_SECRET] });
		expect(rotated.sessionFor(requestWithCookieValue(value))).toEqual({ ownerId: "owner" });
		// New sessions are signed with the current secret.
		const fresh = await rotated.login({ password: PASSWORD, clientIp: "198.51.100.1" });
		expect(fresh.ok).toBe(true);
		if (!fresh.ok) return;
		expect(cookieValueOf(fresh.setCookie).startsWith(`${keyIdOf(SESSION_SECRET)}.`)).toBe(true);
		// Once the previous secret is dropped from the ring the old cookie is rejected.
		expect(makeAuth(clock).sessionFor(requestWithCookieValue(value))).toBeNull();
	});

	test("rejects a cookie that names an unknown key id, even with a valid mac shape", async () => {
		const clock = makeClock();
		const auth = makeAuth(clock);
		const result = await auth.login({ password: PASSWORD, clientIp: "198.51.100.1" });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const [, expiresAt, mac] = cookieValueOf(result.setCookie).split(".");
		expect(auth.sessionFor(requestWithCookieValue(`${keyIdOf(OTHER_SECRET)}.${expiresAt}.${mac}`))).toBeNull();
		expect(auth.sessionFor(requestWithCookieValue(`DEADBEEF.${expiresAt}.${mac}`))).toBeNull();
		expect(auth.sessionFor(requestWithCookieValue(`${keyIdOf(SESSION_SECRET)}.${expiresAt}.${mac}.x`))).toBeNull();
	});

	test("rejects the pre-ring two-part <expiresAt>.<mac> layout", async () => {
		const clock = makeClock();
		const auth = makeAuth(clock);
		const expiresAt = clock.t + TWELVE_HOURS_MS;
		const legacyMac = createHmac("sha256", SESSION_SECRET).update(`ut-session|${expiresAt}`).digest("base64url");
		expect(auth.sessionFor(requestWithCookieValue(`${expiresAt}.${legacyMac}`))).toBeNull();
	});

	test("rejects every session once the owner password hash changes", async () => {
		const clock = makeClock();
		const auth = makeAuth(clock);
		const result = await auth.login({ password: PASSWORD, clientIp: "198.51.100.1" });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const request = requestWithCookieValue(cookieValueOf(result.setCookie));
		expect(auth.sessionFor(request)).toEqual({ ownerId: "owner" });
		const rehashed = makeAuth(clock, { ownerPasswordHash: await Bun.password.hash(PASSWORD) });
		expect(rehashed.sessionFor(request)).toBeNull();
	});

	test("a previous secret shorter than 32 characters throws at construction", () => {
		expect(() => makeAuth(makeClock(), { previousSessionSecrets: [OTHER_SECRET.slice(0, 31)] })).toThrow(
			/at least 32 characters/,
		);
		expect(() => makeAuth(makeClock(), { previousSessionSecrets: [OTHER_SECRET.slice(0, 32)] })).not.toThrow();
	});

	test("a previous entry equal to the current secret is ignored", async () => {
		const clock = makeClock();
		const auth = makeAuth(clock, { previousSessionSecrets: [SESSION_SECRET] });
		const result = await auth.login({ password: PASSWORD, clientIp: "198.51.100.1" });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(auth.sessionFor(requestWithCookieValue(cookieValueOf(result.setCookie)))).toEqual({ ownerId: "owner" });
	});

	test("keyIdOf is 8 lowercase hex, stable, and distinct per secret", () => {
		expect(keyIdOf(SESSION_SECRET)).toMatch(KID);
		expect(keyIdOf(SESSION_SECRET)).toBe(keyIdOf(SESSION_SECRET));
		expect(keyIdOf(SESSION_SECRET)).not.toBe(keyIdOf(OTHER_SECRET));
		expect(keyIdOf(SESSION_SECRET)).toBe(
			createHmac("sha256", SESSION_SECRET).update("ut-kid").digest("hex").slice(0, 8),
		);
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
		expect(cookie).toBe("__Host-ut_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0; Secure");
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
		expect(denied.scope).toBe("owner");
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
		expect(denied.scope).toBe("ip");
		expect(denied.retryAfterSec).toBeGreaterThan(0);
	});

	test("a principal is limited to 60 per minute while another principal on the same IP still passes", () => {
		const clock = makeClock();
		const auth = makeAuth(clock);
		const ip = "203.0.113.8";
		const first = "bearer:0123456789abcdef";
		const second = "key:connector";
		for (let i = 0; i < 60; i++) {
			expect(auth.allowRequest({ clientIp: ip, ownerId: `owner-${i}`, principal: first })).toEqual({ ok: true });
		}
		const denied = auth.allowRequest({ clientIp: ip, ownerId: "owner-x", principal: first });
		expect(denied.ok).toBe(false);
		if (denied.ok) return;
		expect(denied.scope).toBe("principal");
		expect(denied.retryAfterSec).toBeGreaterThan(0);
		// 61 IP hits so far; the second principal passes until the IP window (120) closes.
		for (let i = 0; i < 59; i++) {
			expect(auth.allowRequest({ clientIp: ip, ownerId: `owner-b${i}`, principal: second })).toEqual({ ok: true });
		}
		const ipDenied = auth.allowRequest({ clientIp: ip, ownerId: "owner-y", principal: second });
		expect(ipDenied.ok).toBe(false);
		if (ipDenied.ok) return;
		expect(ipDenied.scope).toBe("ip");
		clock.t += 60_000;
		expect(auth.allowRequest({ clientIp: ip, ownerId: "owner-x", principal: first })).toEqual({ ok: true });
	});

	test("the owner window applies across principals and honours the ownerLimit override", () => {
		const auth = makeAuth(makeClock());
		const first = "bearer:aaaa";
		const second = "bearer:bbbb";
		for (let i = 0; i < 10; i++) {
			expect(
				auth.allowRequest({ clientIp: `10.1.0.${i}`, ownerId: "owner", principal: first, ownerLimit: 10 }),
			).toEqual({ ok: true });
		}
		const denied = auth.allowRequest({ clientIp: "10.1.1.1", ownerId: "owner", principal: second, ownerLimit: 10 });
		expect(denied.ok).toBe(false);
		if (denied.ok) return;
		expect(denied.scope).toBe("owner");
		// The default owner window (60) is unaffected for other owners.
		expect(auth.allowRequest({ clientIp: "10.1.1.1", ownerId: "other", principal: second })).toEqual({ ok: true });
	});

	test("principal ids longer than 128 characters are hashed to one window", () => {
		const auth = makeAuth(makeClock());
		const long = `bearer:${"x".repeat(200)}`;
		for (let i = 0; i < 60; i++) {
			expect(auth.allowRequest({ clientIp: `10.2.0.${i}`, ownerId: `owner-${i}`, principal: long })).toEqual({ ok: true });
		}
		const denied = auth.allowRequest({ clientIp: "10.2.1.1", ownerId: "owner-z", principal: long });
		expect(denied.ok).toBe(false);
		if (denied.ok) return;
		expect(denied.scope).toBe("principal");
		expect(auth.allowRequest({ clientIp: "10.2.1.1", ownerId: "owner-z", principal: `${long}y` })).toEqual({ ok: true });
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

	test("signs and verifies a nonce-bound approval proof as <kid>.<mac>", () => {
		const auth = makeAuth(makeClock());
		const nonce = auth.newApprovalNonce();
		expect(nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
		const signature = auth.signApproval({ ...proof, nonce });
		const [kid, mac, ...rest] = signature.split(".");
		expect(rest).toEqual([]);
		expect(kid).toBe(keyIdOf(SESSION_SECRET));
		expect(mac).toMatch(BASE64URL_MAC);
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

	test("a proof signed with a previous secret verifies after rotation", () => {
		const signature = makeAuth(makeClock(), { sessionSecret: OTHER_SECRET }).signApproval(proof);
		const rotated = makeAuth(makeClock(), { previousSessionSecrets: [OTHER_SECRET] });
		expect(rotated.verifyApproval(proof, signature)).toBe(true);
		expect(rotated.signApproval(proof).startsWith(`${keyIdOf(SESSION_SECRET)}.`)).toBe(true);
	});

	test("rejects a foreign key id, a missing key id, and an over-long signature", () => {
		const auth = makeAuth(makeClock());
		const [, mac = ""] = auth.signApproval(proof).split(".");
		expect(auth.verifyApproval(proof, `${keyIdOf(OTHER_SECRET)}.${mac}`)).toBe(false);
		expect(auth.verifyApproval(proof, `ZZZZZZZZ.${mac}`)).toBe(false);
		expect(auth.verifyApproval(proof, mac)).toBe(false);
		expect(auth.verifyApproval(proof, `${keyIdOf(SESSION_SECRET)}.${mac}${"A".repeat(90)}`)).toBe(false);
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
		expect(clientIpFrom(requestWithRealIp("1:2:3:4:5:6:7:8:9"), "127.0.0.1")).toBe("127.0.0.1");
	});

	test("keys an IPv6 client by its /64 so rotating the low bits does not dodge a per-IP limit", () => {
		const loopback = "127.0.0.1";
		const a = clientIpFrom(requestWithRealIp("2001:db8:1:2:aaaa:bbbb:cccc:dddd"), loopback);
		const b = clientIpFrom(requestWithRealIp("2001:DB8:1:2::1"), loopback);
		expect(a).toBe("2001:db8:1:2::/64");
		expect(b).toBe(a);
		expect(clientIpFrom(requestWithRealIp("2001:db8:1:3::1"), loopback)).toBe("2001:db8:1:3::/64");
		expect(clientIpFrom(requestWithRealIp("2001:db8::1"), loopback)).toBe("2001:db8:0:0::/64");
		expect(clientIpFrom(requestWithRealIp(), "2001:db8:9:9:1:2:3:4")).toBe("2001:db8:9:9::/64");
	});

	test("keys an IPv4-mapped IPv6 address as the IPv4 address", () => {
		expect(clientIpFrom(requestWithRealIp("::ffff:198.51.100.9"), "127.0.0.1")).toBe("198.51.100.9");
	});
});
