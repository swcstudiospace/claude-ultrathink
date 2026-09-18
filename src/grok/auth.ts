/**
 * Reads the Grok Build CLI OAuth session (`~/.grok/auth.json`) so the plugin can
 * call the CLI chat proxy with the user's existing SuperGrok login.
 *
 * Tokens never leave this module except inside request headers; status objects
 * and error messages are redacted.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { GROK_CLIENT_VERSION_FALLBACK } from "./types.ts";

export interface GrokAuth {
	token: string;
	refreshToken?: string;
	/** Epoch milliseconds. */
	expiresAt?: number;
	email?: string;
	userId?: string;
	issuer?: string;
	clientId?: string;
}

/** Safe to print: never contains the token. */
export interface GrokAuthStatus {
	loggedIn: boolean;
	expired: boolean;
	email?: string;
	/** ISO timestamp. */
	expiresAt?: string;
	home: string;
}

export class GrokAuthError extends Error {
	override name = "GrokAuthError";
}

export class GrokHttpError extends Error {
	override name = "GrokHttpError";
	status: number;
	body: string;

	constructor(message: string, status: number, body: string) {
		super(message);
		this.status = status;
		this.body = body;
	}
}

export function grokHome(home?: string, env: Record<string, string | undefined> = process.env): string {
	return home?.trim() || env.GROK_HOME?.trim() || join(homedir(), ".grok");
}

function readJson(path: string): unknown {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as unknown;
	} catch {
		return undefined;
	}
}

function optionalString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

function parseIso(value: unknown): number | undefined {
	if (typeof value !== "string" || !value.trim()) return undefined;
	const ms = Date.parse(value);
	return Number.isFinite(ms) ? ms : undefined;
}

/** One `auth.json` entry as written by `grok login`; fields are still validated at use. */
interface AuthEntry {
	key?: unknown;
	refresh_token?: unknown;
	expires_at?: unknown;
	email?: unknown;
	user_id?: unknown;
	oidc_issuer?: unknown;
	oidc_client_id?: unknown;
}

export function readGrokAuth(home?: string): GrokAuth | undefined {
	const parsed = readJson(join(grokHome(home), "auth.json"));
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
	const first: unknown = Object.values(parsed)[0];
	if (!first || typeof first !== "object") return undefined;
	const entry: AuthEntry = first;
	const token = optionalString(entry.key);
	if (!token) return undefined;
	return {
		token,
		refreshToken: optionalString(entry.refresh_token),
		expiresAt: parseIso(entry.expires_at),
		email: optionalString(entry.email),
		userId: optionalString(entry.user_id),
		issuer: optionalString(entry.oidc_issuer),
		clientId: optionalString(entry.oidc_client_id),
	};
}

export function grokClientVersion(home?: string): string {
	const parsed = readJson(join(grokHome(home), "version.json"));
	if (parsed && typeof parsed === "object" && "version" in parsed) {
		const version = optionalString(parsed.version);
		if (version) return version.trim();
	}
	return GROK_CLIENT_VERSION_FALLBACK;
}

export function isGrokAuthExpired(auth: GrokAuth, now: number = Date.now(), skewMs = 60_000): boolean {
	return auth.expiresAt !== undefined && auth.expiresAt - skewMs <= now;
}

function statusFromAuth(auth: GrokAuth | undefined, home: string, now: number): GrokAuthStatus {
	if (!auth) return { loggedIn: false, expired: false, home };
	return {
		loggedIn: true,
		expired: isGrokAuthExpired(auth, now),
		email: auth.email,
		expiresAt: auth.expiresAt === undefined ? undefined : new Date(auth.expiresAt).toISOString(),
		home,
	};
}

export function grokAuthStatus(home?: string, now: number = Date.now()): GrokAuthStatus {
	const resolvedHome = grokHome(home);
	return statusFromAuth(readGrokAuth(resolvedHome), resolvedHome, now);
}

export interface EnsureFreshOptions {
	home?: string;
	/** Grok CLI executable; default `grok` on PATH. */
	bin?: string;
	now?: number;
	skewMs?: number;
	/** Kill the CLI after this long; default 20 s. */
	timeoutMs?: number;
	/** Run the CLI even when the token is not expired (e.g. after an upstream 401). */
	force?: boolean;
	/** Test seam: runs `cmd` with `env`, resolves with the exit code. */
	spawn?: (cmd: string[], env: Record<string, string | undefined>) => Promise<number>;
}

async function spawnGrok(cmd: string[], env: Record<string, string | undefined>, timeoutMs: number): Promise<number> {
	const proc = Bun.spawn(cmd, { env, stdin: "ignore", stdout: "ignore", stderr: "ignore" });
	const timer = timeoutMs > 0 ? setTimeout(() => proc.kill(), timeoutMs) : undefined;
	try {
		return await proc.exited;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Returns the current session, letting the Grok CLI refresh it first when it is
 * expired (or `force` is set) and a refresh token exists. `grok models` makes an
 * authenticated call, and the CLI rewrites `auth.json` itself when the access
 * token needs refreshing; this module never touches the token endpoint or the
 * file. The result may still be expired — callers decide what that means.
 * Never throws: a failed or missing CLI just leaves the session as it was.
 */
export async function ensureFreshGrokAuth(opts: EnsureFreshOptions = {}): Promise<GrokAuth | undefined> {
	const auth = readGrokAuth(opts.home);
	if (!auth) return undefined;
	if (!opts.force && !isGrokAuthExpired(auth, opts.now, opts.skewMs)) return auth;
	if (!auth.refreshToken) return auth;

	const env: Record<string, string | undefined> = { ...process.env };
	const home = opts.home?.trim();
	if (home) env.GROK_HOME = home;
	const cmd = [opts.bin?.trim() || "grok", "models"];
	try {
		if (opts.spawn) await opts.spawn(cmd, env);
		else await spawnGrok(cmd, env, opts.timeoutMs ?? 20_000);
	} catch {
		// The CLI is optional here: fall through and report whatever auth.json holds now.
	}
	return readGrokAuth(opts.home);
}

/** `grokAuthStatus` after giving the CLI a chance to refresh an expired session. */
export async function grokAuthStatusFresh(opts: EnsureFreshOptions = {}): Promise<GrokAuthStatus> {
	return statusFromAuth(await ensureFreshGrokAuth(opts), grokHome(opts.home), opts.now ?? Date.now());
}

export function grokHeaders(auth: GrokAuth, model: string, version: string): Record<string, string> {
	return {
		Authorization: `Bearer ${auth.token}`,
		"X-XAI-Token-Auth": "xai-grok-cli",
		"x-grok-model-override": model,
		"x-grok-client-version": version,
	};
}

const BEARER_RE = /Bearer\s+\S+/g;
const JWT_RE = /[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/g;

/** Masks `Bearer …` credentials and JWT-like strings so text is safe to log. */
export function redactSecrets(text: string): string {
	return text.replace(BEARER_RE, "[redacted]").replace(JWT_RE, "[redacted]");
}
