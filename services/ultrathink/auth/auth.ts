// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export interface AuthOptions {
	ownerPasswordHash: string;
	sessionSecret: string;
	cookieSecure: boolean;
	now?: () => number;
}

export interface ApprovalProof {
	subject: string;
	nonce: string;
	issuedAt: number;
	expiresAt: number;
	refreshedAt: number;
}

export interface Auth {
	login(input: { password: string; clientIp: string }): Promise<
		| { ok: true; setCookie: string }
		| { ok: false; reason: "invalid" | "rate_limited"; retryAfterSec?: number }
	>;
	sessionFor(req: Request): { ownerId: "owner" } | null;
	logoutCookie(): string;
	allowRequest(input: { clientIp: string; ownerId: string }): { ok: true } | { ok: false; retryAfterSec: number };
	newApprovalNonce(): string;
	signApproval(proof: ApprovalProof): string;
	verifyApproval(proof: ApprovalProof, signature: string): boolean;
	allowApprovalAttempt(clientIp: string): { ok: true } | { ok: false; retryAfterSec: number };
}

const COOKIE_NAME = "ut_session";
const OWNER_ID = "owner" as const;
const SESSION_LIFETIME_MS = 12 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_ATTEMPTS_PER_IP = 5;
const OWNER_FAILURES_PER_WINDOW = 10;
const REQUEST_WINDOW_MS = 60 * 1000;
const OWNER_REQUESTS_PER_WINDOW = 60;
const IP_REQUESTS_PER_WINDOW = 120;
const APPROVAL_WINDOW_MS = 60 * 1000;
const APPROVAL_ATTEMPTS_PER_WINDOW = 2;
const APPROVAL_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const MAX_TRACKED_KEYS = 10_000;
const PRUNE_INTERVAL_MS = 60 * 1000;
const OWNER_KEY = "owner";
const LOOPBACK_PEERS: Record<string, true> = { "127.0.0.1": true, "::1": true, "::ffff:127.0.0.1": true };
const HASH_FORMAT = /^\$(?:argon2(?:id|i|d)|2[abxy]?)\$/;
const FORWARDED_IP = /^[0-9A-Fa-f:.]{1,45}$/;

interface Window {
	count: number;
	resetAt: number;
}

interface Hit {
	count: number;
	retryAfterSec: number;
}

/**
 * Fixed-window counter with a hard cap on tracked keys. When the table is full
 * and no expired window can be reclaimed, a new key is refused (hit returns null)
 * so that churning keys cannot evict live windows and reset a limit.
 */
class FixedWindowLimiter {
	private readonly windows = new Map<string, Window>();
	private readonly now: () => number;
	private readonly maxKeys: number;
	private nextPruneAt = 0;

	constructor(now: () => number, maxKeys: number) {
		this.now = now;
		this.maxKeys = maxKeys;
	}

	hit(key: string, windowMs: number): Hit | null {
		const t = this.now();
		this.pruneIfDue(t);
		let window = this.live(key, t);
		if (!window) {
			if (this.windows.size >= this.maxKeys) this.prune(t);
			if (this.windows.size >= this.maxKeys) return null;
			window = { count: 0, resetAt: t + windowMs };
			this.windows.set(key, window);
		}
		window.count += 1;
		return { count: window.count, retryAfterSec: Math.max(1, Math.ceil((window.resetAt - t) / 1000)) };
	}

	release(key: string): void {
		const window = this.live(key, this.now());
		if (window && window.count > 0) window.count -= 1;
	}

	private live(key: string, t: number): Window | undefined {
		const window = this.windows.get(key);
		if (window && window.resetAt > t) return window;
		if (window) this.windows.delete(key);
		return undefined;
	}

	private prune(t: number): void {
		for (const [key, window] of this.windows) {
			if (window.resetAt <= t) this.windows.delete(key);
		}
	}

	private pruneIfDue(t: number): void {
		if (t < this.nextPruneAt) return;
		this.prune(t);
		this.nextPruneAt = t + PRUNE_INTERVAL_MS;
	}
}

function retryAfterOf(hit: Hit | null, windowMs: number): number {
	return hit ? hit.retryAfterSec : Math.ceil(windowMs / 1000);
}

export function createAuth(options: AuthOptions): Auth {
	const { ownerPasswordHash, sessionSecret, cookieSecure } = options;
	const now = options.now ?? (() => Date.now());
	const dummyHash = Bun.password.hashSync(randomBytes(32).toString("base64url"));
	const loginsByIp = new FixedWindowLimiter(now, MAX_TRACKED_KEYS);
	const ownerFailures = new FixedWindowLimiter(now, MAX_TRACKED_KEYS);
	const requests = new FixedWindowLimiter(now, MAX_TRACKED_KEYS);
	const approvalAttempts = new FixedWindowLimiter(now, MAX_TRACKED_KEYS);

	// Always performs one Argon2/bcrypt verify so a malformed stored hash
	// takes the same time as a well-formed one.
	async function passwordMatches(password: string): Promise<boolean> {
		if (!HASH_FORMAT.test(ownerPasswordHash)) {
			await Bun.password.verify(password, dummyHash);
			return false;
		}
		try {
			return await Bun.password.verify(password, ownerPasswordHash);
		} catch {
			await Bun.password.verify(password, dummyHash);
			return false;
		}
	}

	function sign(expiresAtMs: number): string {
		return createHmac("sha256", sessionSecret).update(`ut-session|${expiresAtMs}`).digest("base64url");
	}

	function approvalMac(proof: ApprovalProof): string | null {
		const times = [proof.issuedAt, proof.expiresAt, proof.refreshedAt];
		const timesOk = times.every((value) => Number.isSafeInteger(value) && value >= 0 && value <= 9_999_999_999_999_999);
		if (!APPROVAL_TOKEN.test(proof.subject) || !APPROVAL_TOKEN.test(proof.nonce) || !timesOk) return null;
		if (proof.expiresAt < proof.issuedAt || proof.refreshedAt < proof.issuedAt) return null;
		return createHmac("sha256", sessionSecret)
			.update(`ut-approval|${proof.subject}|${proof.nonce}|${proof.issuedAt}|${proof.expiresAt}|${proof.refreshedAt}`)
			.digest("base64url");
	}

	function cookieHeader(value: string, maxAgeSec: number): string {
		const attributes = [`${COOKIE_NAME}=${value}`, "Path=/", "HttpOnly", "SameSite=Strict", `Max-Age=${maxAgeSec}`];
		if (cookieSecure) attributes.push("Secure");
		return attributes.join("; ");
	}

	function readCookie(req: Request): string | null {
		const header = req.headers.get("cookie");
		if (!header) return null;
		for (const part of header.split(";")) {
			const eq = part.indexOf("=");
			if (eq < 0) continue;
			if (part.slice(0, eq).trim() === COOKIE_NAME) return part.slice(eq + 1).trim();
		}
		return null;
	}

	return {
		async login({ password, clientIp }) {
			const perIp = loginsByIp.hit(clientIp, LOGIN_WINDOW_MS);
			if (!perIp || perIp.count > LOGIN_ATTEMPTS_PER_IP) {
				return { ok: false, reason: "rate_limited", retryAfterSec: retryAfterOf(perIp, LOGIN_WINDOW_MS) };
			}

			// Reserve an owner-level slot before verifying so concurrent attempts
			// cannot all pass the check at once. Released on success.
			const perOwner = ownerFailures.hit(OWNER_KEY, LOGIN_WINDOW_MS);
			if (!perOwner || perOwner.count > OWNER_FAILURES_PER_WINDOW) {
				return { ok: false, reason: "rate_limited", retryAfterSec: retryAfterOf(perOwner, LOGIN_WINDOW_MS) };
			}

			if (!(await passwordMatches(password))) {
				return { ok: false, reason: "invalid" };
			}

			ownerFailures.release(OWNER_KEY);
			const expiresAt = now() + SESSION_LIFETIME_MS;
			return {
				ok: true,
				setCookie: cookieHeader(`${expiresAt}.${sign(expiresAt)}`, SESSION_LIFETIME_MS / 1000),
			};
		},

		sessionFor(req) {
			const value = readCookie(req);
			if (!value) return null;
			const dot = value.indexOf(".");
			if (dot < 0) return null;
			const expiresRaw = value.slice(0, dot);
			const mac = value.slice(dot + 1);
			if (!/^\d{1,16}$/.test(expiresRaw)) return null;
			const expiresAt = Number(expiresRaw);
			if (!Number.isSafeInteger(expiresAt) || expiresAt <= now()) return null;

			const expected = Buffer.from(sign(expiresAt));
			const actual = Buffer.from(mac);
			if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
			return { ownerId: OWNER_ID };
		},

		logoutCookie() {
			return cookieHeader("", 0);
		},

		allowRequest({ clientIp, ownerId }) {
			const ip = requests.hit(`ip:${clientIp}`, REQUEST_WINDOW_MS);
			if (!ip || ip.count > IP_REQUESTS_PER_WINDOW) {
				return { ok: false, retryAfterSec: retryAfterOf(ip, REQUEST_WINDOW_MS) };
			}
			const owner = requests.hit(`owner:${ownerId}`, REQUEST_WINDOW_MS);
			if (!owner || owner.count > OWNER_REQUESTS_PER_WINDOW) {
				return { ok: false, retryAfterSec: retryAfterOf(owner, REQUEST_WINDOW_MS) };
			}
			return { ok: true };
		},

		newApprovalNonce() {
			return randomBytes(32).toString("base64url");
		},

		signApproval(proof) {
			const mac = approvalMac(proof);
			if (mac === null) throw new Error("invalid approval proof");
			return mac;
		},

		verifyApproval(proof, signature) {
			if (typeof signature !== "string" || signature.length === 0 || signature.length > 128) return false;
			const expected = approvalMac(proof);
			if (expected === null) return false;
			const expectedBuf = Buffer.from(expected);
			const actualBuf = Buffer.from(signature);
			return actualBuf.length === expectedBuf.length && timingSafeEqual(actualBuf, expectedBuf);
		},

		allowApprovalAttempt(clientIp) {
			const hit = approvalAttempts.hit(clientIp, APPROVAL_WINDOW_MS);
			if (!hit || hit.count > APPROVAL_ATTEMPTS_PER_WINDOW) {
				return { ok: false, retryAfterSec: retryAfterOf(hit, APPROVAL_WINDOW_MS) };
			}
			return { ok: true };
		},
	};
}

export function clientIpFrom(req: Request, peerIp: string): string {
	if (LOOPBACK_PEERS[peerIp] !== true) return peerIp;
	const forwarded = req.headers.get("x-real-ip")?.trim();
	if (forwarded && FORWARDED_IP.test(forwarded)) return forwarded;
	return peerIp;
}
