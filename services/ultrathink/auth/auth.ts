// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

/**
 * Owner session, approval-proof and request-limiting primitives.
 *
 * Session-secret key ring. Session cookies and approval proofs are signed with
 * the current `sessionSecret`; verification also accepts any secret listed in
 * `previousSessionSecrets`. Every value carries the 8-hex key id (`keyIdOf`) of
 * the secret that signed it, so rotation needs no downtime:
 *
 *   1. Set `ULTRATHINK_SESSION_SECRET` to the new value and move the old value
 *      into `ULTRATHINK_SESSION_SECRET_PREVIOUS` (comma-separated, newest first
 *      if several). Restart the service. Existing sessions and pending consents
 *      keep verifying; new ones are signed with the new secret.
 *   2. After the longest-lived value signed by the old secret has expired, i.e.
 *      12 h for sessions (SESSION_LIFETIME_MS) and 10 min for pending consents,
 *      remove the old entry from `ULTRATHINK_SESSION_SECRET_PREVIOUS` and
 *      restart. Cookies naming an unknown key id are rejected from then on.
 *
 * Sessions are bound to the owner password hash: the session MAC covers
 * `sha256(ownerPasswordHash)`, so changing the owner password invalidates every
 * session without rotating the secret. Cookie values from before the key ring
 * (`<expiresAt>.<mac>`) are rejected outright; such sessions end at deploy.
 *
 * Session cookie: `__Host-ut_session` when the cookie is Secure, otherwise
 * `ut_session` (the `__Host-` prefix requires Secure). Value layout is
 * `<kid>.<expiresAt>.<mac>` with `mac = HMAC-SHA256(secret,
 * "ut-session|<expiresAt>|<sha256hex(ownerPasswordHash)>")` in base64url.
 *
 * Approval proofs are `<kid>.<mac>` and verify with the ring key named by the
 * key id, so consents issued before a rotation survive it.
 *
 * Request limits (fixed one-minute windows sharing one bounded table, checked
 * in this order): 120 per client IP, 60 per principal (an opaque id the router
 * derives, e.g. `bearer:<sha256 prefix>` or `key:connector`), and 60 per owner
 * unless the caller passes `ownerLimit`.
 */

import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

export interface AuthOptions {
	ownerPasswordHash: string;
	/** Signs new sessions and approval proofs; also verifies. */
	sessionSecret: string;
	/**
	 * Verification-only secrets kept during a rotation, newest first. Each must
	 * be at least 32 characters; entries equal to `sessionSecret` are ignored.
	 */
	previousSessionSecrets?: string[];
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

/** Which window refused a request. */
export type RequestLimitScope = "ip" | "principal" | "owner";

export interface Auth {
	login(input: { password: string; clientIp: string }): Promise<
		| { ok: true; setCookie: string }
		| { ok: false; reason: "invalid" | "rate_limited"; retryAfterSec?: number }
	>;
	sessionFor(req: Request): { ownerId: "owner" } | null;
	logoutCookie(): string;
	/**
	 * Counts one request against the IP, principal (when given) and owner
	 * windows, in that order, and reports the first one that is exhausted.
	 * `principal` is an opaque id of at most 128 characters; longer ids are
	 * hashed. `ownerLimit` overrides the 60-per-minute owner window.
	 */
	allowRequest(input: {
		clientIp: string;
		ownerId: string;
		principal?: string;
		ownerLimit?: number;
	}): { ok: true } | { ok: false; retryAfterSec: number; scope: RequestLimitScope };
	newApprovalNonce(): string;
	/** Returns `<kid>.<mac>`, signed with the current secret. */
	signApproval(proof: ApprovalProof): string;
	/** Verifies a `<kid>.<mac>` proof with the ring key named by `kid`. */
	verifyApproval(proof: ApprovalProof, signature: string): boolean;
	allowApprovalAttempt(clientIp: string): { ok: true } | { ok: false; retryAfterSec: number };
}

const OWNER_ID = "owner" as const;
const SESSION_LIFETIME_MS = 12 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_ATTEMPTS_PER_IP = 5;
const OWNER_FAILURES_PER_WINDOW = 10;
const REQUEST_WINDOW_MS = 60 * 1000;
const OWNER_REQUESTS_PER_WINDOW = 60;
const PRINCIPAL_REQUESTS_PER_WINDOW = 60;
const IP_REQUESTS_PER_WINDOW = 120;
const MAX_PRINCIPAL_LENGTH = 128;
const APPROVAL_WINDOW_MS = 60 * 1000;
const APPROVAL_ATTEMPTS_PER_WINDOW = 2;
const APPROVAL_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const MIN_SECRET_LENGTH = 32;
const KEY_ID = /^[0-9a-f]{8}$/;
const SESSION_EXPIRY = /^\d{1,16}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const MAX_TRACKED_KEYS = 10_000;
const PRUNE_INTERVAL_MS = 60 * 1000;
const OWNER_KEY = "owner";
const LOOPBACK_PEERS: Record<string, true> = { "127.0.0.1": true, "::1": true, "::ffff:127.0.0.1": true };
const HASH_FORMAT = /^\$(?:argon2(?:id|i|d)|2[abxy]?)\$/;
const FORWARDED_IP = /^[0-9A-Fa-f:.]{1,45}$/;

/**
 * Key id of a session secret: the first 8 hex characters of
 * HMAC-SHA256(secret, "ut-kid"). Safe to print; it does not reveal the secret.
 */
export function keyIdOf(secret: string): string {
	return createHmac("sha256", secret).update("ut-kid").digest("hex").slice(0, 8);
}

/** Session cookie name: `__Host-ut_session` for Secure cookies, else `ut_session`. */
export function sessionCookieName(cookieSecure: boolean): string {
	return cookieSecure ? "__Host-ut_session" : "ut_session";
}

/**
 * Verification secrets by key id: the current secret plus every previous one.
 * Throws on a previous secret shorter than MIN_SECRET_LENGTH or a key-id
 * collision between distinct secrets, both of which are configuration errors.
 * Lookups must validate the kid against KEY_ID first; the table is a plain
 * object and 8-hex ids can never name a prototype property.
 */
function buildKeyRing(current: string, previous: string[]): Record<string, string> {
	const secrets: Record<string, string> = { [keyIdOf(current)]: current };
	for (const secret of previous) {
		if (typeof secret !== "string" || secret.length < MIN_SECRET_LENGTH) {
			throw new Error(`previous session secrets must be at least ${MIN_SECRET_LENGTH} characters`);
		}
		const kid = keyIdOf(secret);
		const existing = secrets[kid];
		if (existing === undefined) secrets[kid] = secret;
		else if (existing !== secret) throw new Error(`session secret key id collision on ${kid}`);
	}
	return secrets;
}

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
	const secretsByKid = buildKeyRing(sessionSecret, options.previousSessionSecrets ?? []);
	const signingKid = keyIdOf(sessionSecret);
	// Covered by every session MAC so an owner password change ends all sessions. A KDF, not a bare hash: its input is a
	// password hash, and the fixed salt keeps the value stable across restarts.
	const passwordBinding = scryptSync(ownerPasswordHash, "ut-session-binding-v1", 32).toString("hex");
	const cookieName = sessionCookieName(cookieSecure);
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

	function sessionMac(secret: string, expiresAtMs: number): string {
		return createHmac("sha256", secret).update(`ut-session|${expiresAtMs}|${passwordBinding}`).digest("base64url");
	}

	function approvalMac(secret: string, proof: ApprovalProof): string | null {
		const times = [proof.issuedAt, proof.expiresAt, proof.refreshedAt];
		const timesOk = times.every((value) => Number.isSafeInteger(value) && value >= 0 && value <= 9_999_999_999_999_999);
		if (!APPROVAL_TOKEN.test(proof.subject) || !APPROVAL_TOKEN.test(proof.nonce) || !timesOk) return null;
		if (proof.expiresAt < proof.issuedAt || proof.refreshedAt < proof.issuedAt) return null;
		return createHmac("sha256", secret)
			.update(`ut-approval|${proof.subject}|${proof.nonce}|${proof.issuedAt}|${proof.expiresAt}|${proof.refreshedAt}`)
			.digest("base64url");
	}

	/** Secret for a value's key id, or null when the kid is malformed or unknown. */
	function ringSecret(kid: string): string | null {
		if (!KEY_ID.test(kid)) return null;
		return secretsByKid[kid] ?? null;
	}

	function cookieHeader(value: string, maxAgeSec: number): string {
		const attributes = [`${cookieName}=${value}`, "Path=/", "HttpOnly", "SameSite=Strict", `Max-Age=${maxAgeSec}`];
		if (cookieSecure) attributes.push("Secure");
		return attributes.join("; ");
	}

	function readCookie(req: Request): string | null {
		const header = req.headers.get("cookie");
		if (!header) return null;
		for (const part of header.split(";")) {
			const eq = part.indexOf("=");
			if (eq < 0) continue;
			if (part.slice(0, eq).trim() === cookieName) return part.slice(eq + 1).trim();
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
			// cannot all pass the check at once. Both reservations are released on
			// success, so only failures count against either window.
			const perOwner = ownerFailures.hit(OWNER_KEY, LOGIN_WINDOW_MS);
			if (!perOwner || perOwner.count > OWNER_FAILURES_PER_WINDOW) {
				return { ok: false, reason: "rate_limited", retryAfterSec: retryAfterOf(perOwner, LOGIN_WINDOW_MS) };
			}

			if (!(await passwordMatches(password))) {
				return { ok: false, reason: "invalid" };
			}

			ownerFailures.release(OWNER_KEY);
			loginsByIp.release(clientIp);
			const expiresAt = now() + SESSION_LIFETIME_MS;
			const value = `${signingKid}.${expiresAt}.${sessionMac(sessionSecret, expiresAt)}`;
			return { ok: true, setCookie: cookieHeader(value, SESSION_LIFETIME_MS / 1000) };
		},

		sessionFor(req) {
			const value = readCookie(req);
			if (!value) return null;
			// Exactly `<kid>.<expiresAt>.<mac>`; the pre-ring two-part layout is refused.
			const parts = value.split(".");
			if (parts.length !== 3) return null;
			const [kid = "", expiresRaw = "", mac = ""] = parts;
			const secret = ringSecret(kid);
			if (secret === null || !SESSION_EXPIRY.test(expiresRaw) || !BASE64URL.test(mac)) return null;
			const expiresAt = Number(expiresRaw);
			if (!Number.isSafeInteger(expiresAt) || expiresAt <= now()) return null;

			const expected = Buffer.from(sessionMac(secret, expiresAt));
			const actual = Buffer.from(mac);
			if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
			return { ownerId: OWNER_ID };
		},

		logoutCookie() {
			return cookieHeader("", 0);
		},

		allowRequest({ clientIp, ownerId, principal, ownerLimit }) {
			const ip = requests.hit(`ip:${clientIp}`, REQUEST_WINDOW_MS);
			if (!ip || ip.count > IP_REQUESTS_PER_WINDOW) {
				return { ok: false, retryAfterSec: retryAfterOf(ip, REQUEST_WINDOW_MS), scope: "ip" };
			}
			if (principal !== undefined) {
				const key = principal.length <= MAX_PRINCIPAL_LENGTH
					? principal
					: `sha256:${createHash("sha256").update(principal).digest("hex")}`;
				const hit = requests.hit(`principal:${key}`, REQUEST_WINDOW_MS);
				if (!hit || hit.count > PRINCIPAL_REQUESTS_PER_WINDOW) {
					return { ok: false, retryAfterSec: retryAfterOf(hit, REQUEST_WINDOW_MS), scope: "principal" };
				}
			}
			const owner = requests.hit(`owner:${ownerId}`, REQUEST_WINDOW_MS);
			if (!owner || owner.count > (ownerLimit ?? OWNER_REQUESTS_PER_WINDOW)) {
				return { ok: false, retryAfterSec: retryAfterOf(owner, REQUEST_WINDOW_MS), scope: "owner" };
			}
			return { ok: true };
		},

		newApprovalNonce() {
			return randomBytes(32).toString("base64url");
		},

		signApproval(proof) {
			const mac = approvalMac(sessionSecret, proof);
			if (mac === null) throw new Error("invalid approval proof");
			return `${signingKid}.${mac}`;
		},

		verifyApproval(proof, signature) {
			if (typeof signature !== "string" || signature.length === 0 || signature.length > 128) return false;
			const dot = signature.indexOf(".");
			if (dot < 0) return false;
			const secret = ringSecret(signature.slice(0, dot));
			if (secret === null) return false;
			const expected = approvalMac(secret, proof);
			if (expected === null) return false;
			const expectedBuf = Buffer.from(expected);
			const actualBuf = Buffer.from(signature.slice(dot + 1));
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

/**
 * Limiter key for an address. An IPv6 client controls its whole /64, so the
 * key is the /64 prefix; otherwise rotating the low 64 bits would bypass every
 * per-IP window. IPv4-mapped IPv6 addresses key as the IPv4 address.
 */
function limiterKey(address: string): string {
	if (isIP(address) !== 6) return address;
	const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
	if (mapped?.[1] !== undefined && isIP(mapped[1]) === 4) return mapped[1];
	const [head = "", tail = ""] = address.split("::", 2);
	const headGroups = head === "" ? [] : head.split(":");
	const tailGroups = address.includes("::") ? (tail === "" ? [] : tail.split(":")) : [];
	const groups = address.includes("::")
		? [...headGroups, ...Array<string>(Math.max(0, 8 - headGroups.length - tailGroups.length)).fill("0"), ...tailGroups]
		: headGroups;
	return `${groups
		.slice(0, 4)
		.map((group) => Number.parseInt(group, 16).toString(16))
		.join(":")}::/64`;
}

export function clientIpFrom(req: Request, peerIp: string): string {
	if (LOOPBACK_PEERS[peerIp] !== true) return limiterKey(peerIp);
	const forwarded = req.headers.get("x-real-ip")?.trim();
	if (forwarded && FORWARDED_IP.test(forwarded) && isIP(forwarded) !== 0) return limiterKey(forwarded);
	return limiterKey(peerIp);
}
