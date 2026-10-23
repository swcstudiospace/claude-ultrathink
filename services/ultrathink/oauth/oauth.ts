// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

// OAuth 2.1 authorization code flow with PKCE (S256) for the MCP endpoint.
// Discovery follows RFC 9728 (protected resource) and RFC 8414 (authorization
// server). Clients register with RFC 7591 dynamic registration, tokens are bound
// to the MCP resource (RFC 8707) and can be revoked (RFC 7009). Authorization
// redirects carry the issuer (RFC 9207). Only SHA-256 digests of secrets are stored.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import * as nodeFs from "node:fs";
import { chmodSync, existsSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { type ApprovalProof, type Auth, MAX_PASSWORD_CHARS } from "../auth/auth.ts";
import type { AuditEvent } from "../obs/audit.ts";
import { encodeHtml, encodeHtmlAttribute } from "../security/encoding.ts";
import { getSecurityLogger } from "../security/events.ts";
import { ArrayValidator, ObjectValidator, StringValidator, type Validator } from "../security/validation.ts";

export const DEFAULT_REDIRECT_ORIGINS: readonly string[] = ["https://claude.ai", "https://claude.com", "https://grok.com", "https://console.x.ai"];

const ACCESS_TTL_MS = 60 * 60 * 1000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// A rotated refresh token stays on record only long enough to detect reuse.
const SPENT_REFRESH_TTL_MS = 5 * 60 * 1000;
const CODE_TTL_MS = 60 * 1000;
const PENDING_TTL_MS = 10 * 60 * 1000;
const SWEEP_INTERVAL_MS = 30 * 1000;
const MAX_PENDING = 200;
const MAX_PENDING_PER_CLIENT = 5;
const EXPIRED_MESSAGE = "This authorization request expired. Start the connection again from your client.";
const MAX_CLIENTS = 200;
const UNGRANTED_CLIENT_TTL_MS = 24 * 60 * 60 * 1000;
const GRANTED_CLIENT_IDLE_MS = 30 * 24 * 60 * 60 * 1000;
const GRANT_IDLE_MS = 24 * 60 * 60 * 1000;
const MAX_REDIRECT_URIS = 5;
const MAX_REDIRECT_URI_CHARS = 2048;
const MAX_NAME_CHARS = 120;
const MAX_SCOPE_CHARS = 256;
const MAX_FORM_BYTES = 8192;
const VERIFIER_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/;
const CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const SCOPE_PATTERN = /^[\x21\x23-\x5b\x5d-\x7e]+( [\x21\x23-\x5b\x5d-\x7e]+)*$/;
const STATE_FILE = "oauth.json";
const SUPPORTED_GRANTS = ["authorization_code", "refresh_token"] as const;
// RFC 7591 §2: a registration that omits grant_types may only use the authorization code grant.
const DEFAULT_GRANT_TYPES: readonly string[] = ["authorization_code"];
const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const MAX_CLIENT_ID_CHARS = 256;
const MAX_SECRET_CHARS = 256;
const MAX_SHORT_CHARS = 64;
const MAX_STATE_CHARS = 512;
const MAX_CHALLENGE_INPUT_CHARS = 256;
const MAX_VERIFIER_INPUT_CHARS = 256;
const MAX_CLIENT_NAME_INPUT_CHARS = 1024;
/** No C0 control characters and no DEL: a text parameter carrying one is refused. */
const NO_CONTROL = /^[^\x00-\x1f\x7f]*$/;
/** What the registration schema yields once every field has passed. */
type RegisterFields = { redirect_uris: string[]; token_endpoint_auth_method: string; grant_types: string[]; response_types: string[]; client_name: string };
/** The parameters each endpoint reads. Each one is checked before its handler runs. */
const REGISTER_BODY: Record<string, Validator<unknown>> = {
	redirect_uris: new ArrayValidator(formText(MAX_REDIRECT_URI_CHARS), { minLength: 1, maxLength: MAX_REDIRECT_URIS }),
	token_endpoint_auth_method: new StringValidator({ allowedValues: ["none"] }),
	grant_types: new ArrayValidator(new StringValidator({ allowedValues: [...SUPPORTED_GRANTS] }), { minLength: 1 }),
	response_types: new ArrayValidator(new StringValidator({ allowedValues: ["code"] })),
	client_name: formText(MAX_CLIENT_NAME_INPUT_CHARS),
};
const TOKEN_FORM: Record<string, Validator<unknown>> = {
	client_id: formText(MAX_CLIENT_ID_CHARS),
	grant_type: formText(MAX_SHORT_CHARS),
	code: formText(MAX_SECRET_CHARS),
	code_verifier: formText(MAX_VERIFIER_INPUT_CHARS),
	redirect_uri: formText(MAX_REDIRECT_URI_CHARS),
	refresh_token: formText(MAX_SECRET_CHARS),
	resource: formText(MAX_REDIRECT_URI_CHARS),
};
const REVOKE_FORM: Record<string, Validator<unknown>> = {
	token: formText(MAX_SECRET_CHARS),
	client_id: formText(MAX_CLIENT_ID_CHARS),
};
/** `scope` is not listed: cleanScope drops an invalid scope rather than refusing the request, and a test pins that. */
const AUTHORIZE_QUERY: Record<string, Validator<unknown>> = {
	client_id: formText(MAX_CLIENT_ID_CHARS),
	redirect_uri: formText(MAX_REDIRECT_URI_CHARS),
	response_type: formText(MAX_SHORT_CHARS),
	state: formText(MAX_STATE_CHARS),
	code_challenge: formText(MAX_CHALLENGE_INPUT_CHARS),
	code_challenge_method: formText(MAX_SHORT_CHARS),
	resource: formText(MAX_REDIRECT_URI_CHARS),
};
const AUTHORIZE_FORM: Record<string, Validator<unknown>> = {
	req: formText(MAX_SECRET_CHARS),
	nonce: formText(MAX_SECRET_CHARS),
	action: formText(MAX_SHORT_CHARS),
	password: new StringValidator({ allowEmpty: true, maxLength: MAX_PASSWORD_CHARS }),
};

const REGISTER_LIMIT = { max: 10, windowMs: 60 * 60 * 1000 };
const AUTHORIZE_LIMIT = { max: 30, windowMs: 60 * 1000 };
const TOKEN_LIMIT = { max: 60, windowMs: 60 * 1000 };
const TOKEN_CLIENT_LIMIT = { max: 30, windowMs: 60 * 1000 };
const REVOKE_LIMIT = { max: 60, windowMs: 60 * 1000 };
const MAX_LIMITER_KEYS = 10_000;
const UNKNOWN_IP = "unknown";

interface ClientRecord {
	name: string;
	redirectUris: string[];
	createdAt: number;
	/** Grant types accepted at registration; the token endpoint refuses any other. */
	grantTypes: string[];
	/** Set on the first approved grant. A client without it is disposable. */
	grantedAt?: number;
	lastUsedAt?: number;
}

interface GrantRecord {
	clientId: string;
	resource: string;
	createdAt: number;
	lastUsedAt?: number;
}

interface CodeRecord {
	clientId: string;
	redirectUri: string;
	codeChallenge: string;
	resource: string;
	scope?: string | null;
	grantId: string;
	expiresAt: number;
	used: boolean;
}

interface TokenRecord {
	kind: "access" | "refresh";
	grantId: string;
	clientId: string;
	resource: string;
	scope?: string | null;
	expiresAt: number;
	used: boolean;
}

interface StoreShape {
	clients: Record<string, ClientRecord>;
	grants: Record<string, GrantRecord>;
	codes: Record<string, CodeRecord>;
	tokens: Record<string, TokenRecord>;
	pending: Record<string, PendingRequest>;
}

type ApprovalState = "PENDING_APPROVAL" | "APPROVED" | "EXPIRED";

interface PendingRequest {
	clientId: string;
	redirectUri: string;
	codeChallenge: string;
	resource: string;
	scope?: string | null;
	state: string | null;
	createdAt: number;
	expiresAt: number;
	refreshedAt: number;
	approvalState: ApprovalState;
	nonce: string;
	signature: string;
}

export interface OAuthOptions {
	origin: string;
	stateDir: string;
	auth: Auth;
	now?: () => number;
	/** Full https allow list for registered redirect URIs. Loopback http is always allowed. */
	redirectOrigins?: readonly string[];
	/** Client table size. Defaults to 200. */
	maxClients?: number;
	/**
	 * Runs `run` every `intervalMs` and returns a canceller. Defaults to an unref'd
	 * setInterval in production and to nothing when a test supplies a clock.
	 */
	schedule?: (run: () => void, intervalMs: number) => () => void;
	/** Receives one call per security event. A throwing sink never changes an OAuth response. */
	audit?: (event: AuditEvent, fields: Record<string, string | number | boolean>) => void;
}

export interface OAuth {
	readonly resource: string;
	readonly resourceMetadataUrl: string;
	protectedResourceMetadata(): Response;
	authorizationServerMetadata(): Response;
	register(req: Request, ip?: string): Promise<Response>;
	authorize(req: Request, ip: string): Promise<Response>;
	token(req: Request, ip?: string): Promise<Response>;
	revoke(req: Request, ip?: string): Promise<Response>;
	verifyAccessToken(token: string): boolean;
	classifyBearer(token: string | null): "valid" | "invalid" | "absent";
}

const NO_STORE = {
	"Cache-Control": "no-store",
	Pragma: "no-cache",
	"X-Content-Type-Options": "nosniff",
	"Referrer-Policy": "no-referrer",
};

// Every JSON response from the OAuth endpoints, and the revocation acknowledgement, refuses framing and turns off powerful features.
const API_HEADERS: Record<string, string> = {
	...NO_STORE,
	"X-Frame-Options": "DENY",
	"Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
	"Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};

// form-action must allow the registered redirect. Chrome applies it to the
// redirect that follows a form post, so 'self' alone cancels the jump back to
// the client. The origin is added per response, never as a wildcard.
function htmlHeaders(formAction: string): Record<string, string> {
	return {
		...NO_STORE,
		"Content-Type": "text/html; charset=utf-8",
		"Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; form-action ${formAction}; frame-ancestors 'none'; base-uri 'none'`,
		"X-Frame-Options": "DENY",
	};
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { ...API_HEADERS, "Content-Type": "application/json; charset=utf-8", ...headers },
	});
}

function oauthError(status: number, error: string, description: string, headers: Record<string, string> = {}): Response {
	return jsonResponse(status, { error, error_description: description }, headers);
}

function invalidGrant(description = "The authorization is invalid or expired."): Response {
	return oauthError(400, "invalid_grant", description);
}

function invalidClient(): Response {
	return oauthError(401, "invalid_client", "Unknown client. Register the client again.", { "WWW-Authenticate": 'Basic realm="ultrathink"' });
}

function htmlPage(status: number, body: string, formAction = "'self'", headers: Record<string, string> = {}): Response {
	return new Response(body, { status, headers: { ...htmlHeaders(formAction), ...headers } });
}

function errorPage(status: number, message: string, headers: Record<string, string> = {}): Response {
	return htmlPage(status, page("Authorization failed", `<p class="err">${encodeHtml(message)}</p>`), "'self'", headers);
}

function page(title: string, content: string): string {
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${encodeHtml(title)}</title><style>body{font-family:system-ui,sans-serif;max-width:28rem;margin:4rem auto;padding:0 1rem;color:#111}input,button{font:inherit;padding:.6rem;width:100%;box-sizing:border-box;margin-top:.4rem}button{margin-top:1rem;cursor:pointer}.err{color:#b00020}</style></head><body><h1>${encodeHtml(title)}</h1>${content}</body></html>`;
}

/** Text in a form or query parameter: any characters but controls, at most `max` long. An absent one reads as "", which passes. */
function formText(max: number): StringValidator {
	return new StringValidator({ allowEmpty: true, maxLength: max, pattern: NO_CONTROL });
}

/** The schema's verdict: the typed value when every field passes, else the first refused field and its validator code. */
function checkedFields<T extends Record<string, unknown>>(schema: Record<string, Validator<unknown>>, values: Record<string, unknown>): { value: T } | { refused: { field: string; code: string } } {
	const verdict = new ObjectValidator<T>(schema, { allowExtraKeys: true, strict: true }).validate(values);
	if (verdict.valid && verdict.value !== undefined) return { value: verdict.value };
	// ObjectValidator reports a value's type rather than its key, so the refused field is found by checking each one.
	for (const [field, validator] of Object.entries(schema)) {
		const result = validator.validate(values[field]);
		if (!result.valid) return { refused: { field, code: result.errors[0]?.code ?? "INVALID" } };
	}
	return { refused: { field: "body", code: "INVALID" } };
}

/** Form parameters checked against their schema. A name sent twice is refused first: RFC 6749 section 3.1 forbids it. */
function formRefusal(form: URLSearchParams, schema: Record<string, Validator<unknown>>): { field: string; code: string } | null {
	for (const name of Object.keys(schema)) {
		if (form.getAll(name).length > 1) return { field: name, code: "DUPLICATE" };
	}
	const values: Record<string, unknown> = {};
	for (const name of Object.keys(schema)) values[name] = form.get(name) ?? "";
	const checked = checkedFields(schema, values);
	return "refused" in checked ? checked.refused : null;
}

/** Records a refused request on the security feed: the endpoint, the field and the validator code, never the value. */
function refusedInput(endpoint: string, field: string, code: string, ip?: string): void {
	getSecurityLogger().logValidationFailure({ source: "oauth", resource: endpoint, ip, details: { field, code } });
}

/** Logs a refused form and answers with the 400 shape the endpoint already returns for a bad request. */
function refuseForm(endpoint: string, refused: { field: string; code: string }, ip: string): Response {
	refusedInput(endpoint, refused.field, refused.code, ip);
	const description = refused.code === "DUPLICATE" ? `${refused.field} must appear once.` : `${refused.field} is not valid.`;
	return oauthError(400, "invalid_request", description);
}

function digest(value: string): string {
	return createHash("sha256").update(value).digest("base64url");
}

function secret(prefix: string): string {
	return prefix + randomBytes(32).toString("base64url");
}

function own<T>(record: Record<string, T>, key: string): T | undefined {
	return Object.hasOwn(record, key) ? record[key] : undefined;
}

function isJsonRequest(req: Request): boolean {
	const contentType = req.headers.get("content-type");
	return contentType !== null && contentType.split(";")[0]?.trim().toLowerCase() === "application/json";
}

async function readBodyText(req: Request, maxBytes: number): Promise<string | null> {
	const declared = req.headers.get("content-length");
	if (declared !== null && Number(declared) > maxBytes) return null;
	const text = await req.text();
	return text.length > maxBytes ? null : text;
}

function normalizeOrigins(origins: readonly string[]): string[] {
	const out = new Set<string>();
	for (const raw of origins) {
		try {
			const url = new URL(raw);
			if (url.protocol === "https:") out.add(url.origin);
		} catch {
			// An unparsable entry grants nothing.
		}
	}
	return [...out];
}

function isLoopbackHttp(url: URL): boolean {
	return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
}

function parseRedirect(raw: unknown): URL | null {
	if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_REDIRECT_URI_CHARS) return null;
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return null;
	}
	if (url.hash !== "" || url.username !== "" || url.password !== "") return null;
	return url;
}

function redirectAllowed(raw: unknown, allowed: ReadonlySet<string>): raw is string {
	const url = parseRedirect(raw);
	if (url === null) return false;
	if (isLoopbackHttp(url)) return true;
	return url.protocol === "https:" && allowed.has(url.origin);
}

// RFC 8252 section 7.3: a loopback redirect may use any port, so the port is ignored there.
function redirectMatches(registered: string, requested: string): boolean {
	if (registered === requested) return true;
	const a = parseRedirect(registered);
	const b = parseRedirect(requested);
	if (a === null || b === null) return false;
	return isLoopbackHttp(a) && isLoopbackHttp(b) && a.hostname === b.hostname && a.pathname === b.pathname && a.search === b.search;
}

function cleanScope(raw: string | null): string | null {
	if (raw === null) return null;
	const value = raw.trim();
	if (value === "" || value.length > MAX_SCOPE_CHARS || !SCOPE_PATTERN.test(value)) return null;
	return value;
}

function pkceMatches(verifier: string, challenge: string): boolean {
	if (!VERIFIER_PATTERN.test(verifier)) return false;
	const computed = Buffer.from(digest(verifier));
	const expected = Buffer.from(challenge);
	return computed.length === expected.length && timingSafeEqual(computed, expected);
}

interface Limiter {
	hit(key: string): { ok: true } | { ok: false; retryAfterSec: number };
}

// Fixed window per key. The table is bounded: expired windows go first, then the oldest.
function createLimiter(limit: { max: number; windowMs: number }, now: () => number): Limiter {
	const windows = new Map<string, { count: number; resetAt: number }>();
	return {
		hit(key) {
			const t = now();
			let entry = windows.get(key);
			if (entry !== undefined && entry.resetAt <= t) {
				windows.delete(key);
				entry = undefined;
			}
			if (entry === undefined) {
				if (windows.size >= MAX_LIMITER_KEYS) {
					for (const [other, window] of windows) if (window.resetAt <= t) windows.delete(other);
					while (windows.size >= MAX_LIMITER_KEYS) {
						const oldest = windows.keys().next();
						if (oldest.done) break;
						windows.delete(oldest.value);
					}
				}
				entry = { count: 0, resetAt: t + limit.windowMs };
				windows.set(key, entry);
			}
			entry.count += 1;
			if (entry.count > limit.max) return { ok: false, retryAfterSec: Math.max(1, Math.ceil((entry.resetAt - t) / 1000)) };
			return { ok: true };
		},
	};
}

function emptyStore(): StoreShape {
	return { clients: {}, grants: {}, codes: {}, tokens: {}, pending: {} };
}

function section<T>(value: unknown): Record<string, T> {
	if (value === undefined) return {};
	if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("malformed store section");
	return value as Record<string, T>;
}

function loadStore(path: string, stamp: number): StoreShape {
	if (!existsSync(path)) return emptyStore();
	try {
		chmodSync(path, 0o600);
	} catch {
		// Not the owner or a read-only mount: reading still works.
	}
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("malformed store");
		const record = parsed as Record<string, unknown>;
		return {
			clients: section(record.clients),
			grants: section(record.grants),
			codes: section(record.codes),
			tokens: section(record.tokens),
			pending: section(record.pending),
		};
	} catch {
		// Never silently wipe: keep the bad file for the operator and start empty. Users re-consent.
		try {
			renameSync(path, `${path}.corrupt-${stamp}`);
		} catch {
			// The move failed; the next save replaces the file.
		}
		return emptyStore();
	}
}

export type DurableFs = Pick<typeof nodeFs, "mkdirSync" | "openSync" | "fchmodSync" | "writeFileSync" | "fsyncSync" | "closeSync" | "renameSync" | "unlinkSync">;

// Write to a temp file, fsync it, rename over the target, then fsync the directory so a
// power loss cannot leave an empty state file that reads as "no clients".
export function writeFileDurably(dir: string, path: string, content: string, io: DurableFs = nodeFs): void {
	io.mkdirSync(dir, { recursive: true, mode: 0o700 });
	const tmp = `${path}.${process.pid}.tmp`;
	const fd = io.openSync(tmp, "w", 0o600);
	try {
		io.fchmodSync(fd, 0o600);
		io.writeFileSync(fd, content);
		io.fsyncSync(fd);
	} catch (error) {
		try {
			io.closeSync(fd);
			io.unlinkSync(tmp);
		} catch {
			// Best effort cleanup of the temp file.
		}
		throw error;
	}
	io.closeSync(fd);
	io.renameSync(tmp, path);
	let dirFd: number | undefined;
	try {
		dirFd = io.openSync(dir, "r");
		io.fsyncSync(dirFd);
	} catch {
		// Some filesystems refuse to open or sync a directory. The rename is still atomic.
	} finally {
		if (dirFd !== undefined) io.closeSync(dirFd);
	}
}

function realSchedule(run: () => void, intervalMs: number): () => void {
	const timer = setInterval(run, intervalMs);
	timer.unref();
	return () => clearInterval(timer);
}

export function createOAuth(options: OAuthOptions): OAuth {
	const origin = options.origin;
	const resource = `${origin}/mcp`;
	const resourceMetadataUrl = `${origin}/.well-known/oauth-protected-resource/mcp`;
	const now = options.now ?? Date.now;
	const path = join(options.stateDir, STATE_FILE);
	const redirectOrigins = normalizeOrigins(options.redirectOrigins ?? DEFAULT_REDIRECT_ORIGINS);
	const allowedRedirectOrigins = new Set(redirectOrigins);
	const redirectHelp = `Register 1 to ${MAX_REDIRECT_URIS} redirect URIs: https on an allowed origin (${redirectOrigins.join(", ")}) or loopback http.`;
	const maxClients = options.maxClients ?? MAX_CLIENTS;
	// A fake clock means a test. Wall-clock polling would race that clock, so only production arms it.
	const schedule = options.schedule ?? (options.now === undefined ? realSchedule : undefined);
	const data = loadStore(path, now());
	const pending = new Map<string, PendingRequest>();
	const approving = new Set<string>();
	const registerLimiter = createLimiter(REGISTER_LIMIT, now);
	const authorizeLimiter = createLimiter(AUTHORIZE_LIMIT, now);
	const tokenLimiter = createLimiter(TOKEN_LIMIT, now);
	const tokenClientLimiter = createLimiter(TOKEN_CLIENT_LIMIT, now);
	const revokeLimiter = createLimiter(REVOKE_LIMIT, now);
	let cancelSweep: (() => void) | null = null;

	// Clients saved before grantedAt existed keep their protection from eviction.
	for (const grant of Object.values(data.grants)) {
		const client = own(data.clients, grant.clientId);
		if (client !== undefined && client.grantedAt === undefined) client.grantedAt = grant.createdAt;
	}
	// Clients saved before grantTypes existed could refresh unconditionally; keep that so existing connections are not forced to re-consent on deploy.
	for (const client of Object.values(data.clients)) {
		if (!Array.isArray(client.grantTypes)) client.grantTypes = [...SUPPORTED_GRANTS];
	}

	function proofOf(key: string, request: PendingRequest): ApprovalProof {
		return {
			subject: key,
			nonce: request.nonce,
			issuedAt: request.createdAt,
			expiresAt: request.expiresAt,
			refreshedAt: request.refreshedAt,
		};
	}

	function clientRemovable(id: string, client: ClientRecord, t: number): boolean {
		for (const request of pending.values()) if (request.clientId === id) return false;
		if (client.grantedAt === undefined) return t - client.createdAt > UNGRANTED_CLIENT_TTL_MS;
		for (const grant of Object.values(data.grants)) if (grant.clientId === id) return false;
		return t - (client.lastUsedAt ?? client.grantedAt) > GRANTED_CLIENT_IDLE_MS;
	}

	// Returns true when anything was removed so callers can skip a pointless disk write.
	function prune(): boolean {
		const t = now();
		let changed = false;
		for (const [key, record] of Object.entries(data.codes)) {
			if (record.expiresAt <= t) {
				delete data.codes[key];
				changed = true;
			}
		}
		for (const [key, record] of Object.entries(data.tokens)) {
			if (record.expiresAt <= t) {
				delete data.tokens[key];
				changed = true;
			}
		}
		for (const [key, request] of pending) {
			if (request.expiresAt <= t || request.approvalState === "EXPIRED") {
				request.approvalState = "EXPIRED";
				pending.delete(key);
				changed = true;
			}
		}
		const live = new Set<string>();
		for (const record of Object.values(data.codes)) live.add(record.grantId);
		for (const record of Object.values(data.tokens)) live.add(record.grantId);
		for (const [id, grant] of Object.entries(data.grants)) {
			if (!live.has(id) && t - (grant.lastUsedAt ?? grant.createdAt) > GRANT_IDLE_MS) {
				delete data.grants[id];
				changed = true;
			}
		}
		for (const [id, client] of Object.entries(data.clients)) {
			if (clientRemovable(id, client, t)) {
				delete data.clients[id];
				changed = true;
			}
		}
		return changed;
	}

	function flush(): void {
		data.pending = {};
		for (const [key, request] of pending) data.pending[key] = { ...request };
		writeFileDurably(options.stateDir, path, JSON.stringify(data));
	}

	function persist(): void {
		prune();
		flush();
	}

	function snapshotStore(): string {
		return JSON.stringify(data);
	}

	function restoreStore(snapshot: string): void {
		Object.assign(data, JSON.parse(snapshot) as typeof data);
	}

	// One timer for every pending request. It stops itself when nothing is pending.
	function ensureSweeper(): void {
		if (schedule === undefined || cancelSweep !== null) return;
		cancelSweep = schedule(sweep, SWEEP_INTERVAL_MS);
	}

	function sweep(): void {
		try {
			if (prune()) flush();
		} catch {
			// A disk error must not take down consent. The in-memory state stays authoritative.
		}
		if (pending.size === 0 && cancelSweep !== null) {
			cancelSweep();
			cancelSweep = null;
		}
	}

	function expiredResponse(asJson: boolean): Response {
		if (asJson) return jsonResponse(400, { state: "EXPIRED", error: EXPIRED_MESSAGE });
		return errorPage(400, EXPIRED_MESSAGE);
	}

	// Stays PENDING_APPROVAL until the absolute deadline. Each tick refreshes the activity
	// timestamp and re-signs; it does not extend the deadline or rotate the nonce.
	function tickApproval(key: string): ApprovalState | null {
		const request = pending.get(key);
		if (!request) return null;
		if (request.approvalState !== "PENDING_APPROVAL") return request.approvalState;
		const t = now();
		const deadline = request.createdAt + PENDING_TTL_MS;
		if (t >= deadline || request.expiresAt <= t) {
			request.approvalState = "EXPIRED";
			request.expiresAt = deadline;
			return "EXPIRED";
		}
		request.refreshedAt = t;
		request.expiresAt = deadline;
		request.signature = options.auth.signApproval(proofOf(key, request));
		return "PENDING_APPROVAL";
	}

	function trustedPending(record: PendingRequest, key: string): boolean {
		if (typeof record?.nonce !== "string" || typeof record.signature !== "string" || typeof record.clientId !== "string") return false;
		if (record.approvalState !== "PENDING_APPROVAL" && record.approvalState !== "APPROVED" && record.approvalState !== "EXPIRED") return false;
		if (!Number.isSafeInteger(record.createdAt) || !Number.isSafeInteger(record.expiresAt) || !Number.isSafeInteger(record.refreshedAt)) return false;
		if (record.expiresAt !== record.createdAt + PENDING_TTL_MS) return false;
		return options.auth.verifyApproval(proofOf(key, record), record.signature);
	}

	for (const [key, record] of Object.entries(data.pending)) {
		if (!trustedPending(record, key)) continue;
		pending.set(key, { ...record });
	}
	if (pending.size > 0) ensureSweeper();

	function findPending(requestId: string, nonce: string): { key: string; request: PendingRequest } | null {
		if (requestId === "" || nonce === "") return null;
		const key = digest(requestId);
		const request = pending.get(key);
		if (!request) return null;
		const submitted = Buffer.from(nonce);
		const stored = Buffer.from(request.nonce);
		if (submitted.length !== stored.length || !timingSafeEqual(submitted, stored)) return null;
		if (!options.auth.verifyApproval(proofOf(key, request), request.signature)) return null;
		return { key, request };
	}

	function revokeGrant(grantId: string): void {
		delete data.grants[grantId];
		for (const [key, record] of Object.entries(data.tokens)) if (record.grantId === grantId) delete data.tokens[key];
		for (const [key, record] of Object.entries(data.codes)) if (record.grantId === grantId) delete data.codes[key];
	}

	function sameResource(value: string | null): boolean {
		return value === resource || value === `${resource}/`;
	}

	function issueTokens(grantId: string, clientId: string, grantResource: string, scope: string | null): Record<string, unknown> {
		const t = now();
		const access = secret("ut_at_");
		const refresh = secret("ut_rt_");
		data.tokens[digest(access)] = { kind: "access", grantId, clientId, resource: grantResource, scope, expiresAt: t + ACCESS_TTL_MS, used: false };
		data.tokens[digest(refresh)] = { kind: "refresh", grantId, clientId, resource: grantResource, scope, expiresAt: t + REFRESH_TTL_MS, used: false };
		const grant = own(data.grants, grantId);
		if (grant !== undefined) grant.lastUsedAt = t;
		const body: Record<string, unknown> = {
			access_token: access,
			token_type: "Bearer",
			expires_in: Math.floor(ACCESS_TTL_MS / 1000),
			refresh_token: refresh,
		};
		if (scope !== null) body.scope = scope;
		return body;
	}

	function rateLimited(retryAfterSec: number): Record<string, string> {
		return { "Retry-After": String(retryAfterSec) };
	}

	function audit(event: AuditEvent, fields: Record<string, string | number | boolean>): void {
		try {
			options.audit?.(event, fields);
		} catch {
			// The decision is already made; the sink owns its own failures.
		}
	}

	function consentPage(requestId: string, nonce: string, clientName: string, redirectUri: string, message: string, status: number): Response {
		const redirectOrigin = new URL(redirectUri).origin;
		const alert = message === "" ? "" : `<p class="err">${encodeHtml(message)}</p>`;
		const content =
			`<p data-approval-state="PENDING_APPROVAL">Allow <strong>${encodeHtml(clientName)}</strong> to use the ultrathink planning tools on this server? Enter the owner password to approve.</p>` +
			`<p data-client-unverified="true">The client name was supplied by the client and is not verified. If you approve, you are sent back to <strong data-redirect-origin="${encodeHtmlAttribute(redirectOrigin)}">${encodeHtml(redirectOrigin)}</strong>. Only approve if you recognize that address.</p>` +
			`${alert}<form method="post" action="/oauth/authorize"><input type="hidden" name="req" value="${encodeHtmlAttribute(requestId)}"><input type="hidden" name="nonce" value="${encodeHtmlAttribute(nonce)}"><label>Owner password<input type="password" name="password" autocomplete="current-password" required></label><button type="submit">Approve</button></form>`;
		return htmlPage(status, page("Authorize ultrathink", content), `'self' ${redirectOrigin}`);
	}

	function redirectWith(redirectUri: string, params: Record<string, string>, state: string | null): Response {
		const url = new URL(redirectUri);
		for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
		if (state !== null) url.searchParams.set("state", state);
		url.searchParams.set("iss", origin);
		return new Response(null, { status: 302, headers: { ...NO_STORE, Location: url.toString() } });
	}

	function authorizeGet(params: URLSearchParams): Response {
		const refused = formRefusal(params, AUTHORIZE_QUERY);
		if (refused !== null) {
			refusedInput("/oauth/authorize", refused.field, refused.code);
			return errorPage(400, "This authorization request is not valid. Start the connection again from your client.");
		}
		prune();
		const clientId = params.get("client_id") ?? "";
		const client = own(data.clients, clientId);
		if (!client) return errorPage(400, "This client is not registered with ultrathink.");
		const redirectUri = params.get("redirect_uri") ?? "";
		if (!client.redirectUris.some((registered) => redirectMatches(registered, redirectUri))) {
			return errorPage(400, "The redirect address does not match this client's registration.");
		}
		client.lastUsedAt = now();
		const state = params.get("state");
		if (params.get("response_type") !== "code") {
			return redirectWith(redirectUri, { error: "unsupported_response_type", error_description: "response_type must be code." }, state);
		}
		const challenge = params.get("code_challenge") ?? "";
		if (params.get("code_challenge_method") !== "S256" || !CHALLENGE_PATTERN.test(challenge)) {
			return redirectWith(redirectUri, { error: "invalid_request", error_description: "PKCE with S256 is required." }, state);
		}
		if (!sameResource(params.get("resource"))) {
			return redirectWith(redirectUri, { error: "invalid_target", error_description: "resource must be the ultrathink MCP endpoint." }, state);
		}
		let forClient = 0;
		for (const request of pending.values()) if (request.clientId === clientId) forClient += 1;
		if (forClient >= MAX_PENDING_PER_CLIENT) {
			return errorPage(429, "This client already has several authorizations waiting. Finish one or wait and try again.", rateLimited(60));
		}
		if (pending.size >= MAX_PENDING) {
			return errorPage(503, "Authorization is temporarily unavailable. Start the connection again from your client.");
		}
		const requestId = secret("ut_req_");
		const key = digest(requestId);
		const createdAt = now();
		const nonce = options.auth.newApprovalNonce();
		const request: PendingRequest = {
			clientId,
			redirectUri,
			codeChallenge: challenge,
			resource,
			scope: cleanScope(params.get("scope")),
			state,
			createdAt,
			expiresAt: createdAt + PENDING_TTL_MS,
			refreshedAt: createdAt,
			approvalState: "PENDING_APPROVAL",
			nonce,
			signature: "",
		};
		request.signature = options.auth.signApproval(proofOf(key, request));
		pending.set(key, request);
		ensureSweeper();
		persist();
		return consentPage(requestId, nonce, client.name, redirectUri, "", 200);
	}

	async function authorizePost(req: Request, ip: string): Promise<Response> {
		const text = await readBodyText(req, MAX_FORM_BYTES);
		if (text === null) {
			refusedInput("/oauth/authorize", "body", "TOO_LARGE");
			return errorPage(413, "The request is too large.");
		}
		const form = new URLSearchParams(text);
		const refused = formRefusal(form, AUTHORIZE_FORM);
		if (refused !== null) {
			refusedInput("/oauth/authorize", refused.field, refused.code);
			// A malformed req or nonce names no pending request, so it gets the answer an unknown one gets.
			if (refused.field === "password") return errorPage(400, "This request is not valid. Start the connection again from your client.");
			return expiredResponse(form.get("action") === "poll");
		}
		const requestId = form.get("req") ?? "";
		const nonce = form.get("nonce") ?? "";
		const polling = form.get("action") === "poll";
		const found = findPending(requestId, nonce);
		if (!found) return expiredResponse(polling);
		const approvalState = tickApproval(found.key);
		if (approvalState !== "PENDING_APPROVAL") {
			persist();
			return expiredResponse(polling);
		}
		if (polling) {
			// The refreshed timestamp and signature only matter in memory and the sweeper flushes them;
			// an unauthenticated poll must not cost a full fsync unless pruning removed something.
			if (prune()) flush();
			const remaining = Math.max(0, Math.ceil((found.request.expiresAt - now()) / 1000));
			return jsonResponse(200, { state: "PENDING_APPROVAL", expires_in: remaining, refreshed_at: found.request.refreshedAt });
		}
		persist();
		const clientName = own(data.clients, found.request.clientId)?.name ?? "MCP client";
		const redirectUri = found.request.redirectUri;
		if (approving.has(found.key)) {
			return consentPage(requestId, found.request.nonce, clientName, redirectUri, "This approval is already being checked. Wait for the result.", 200);
		}
		const attempt = options.auth.allowApprovalAttempt(ip);
		if (!attempt.ok) return errorPage(429, "Too many attempts. Wait and try again.");
		approving.add(found.key);
		try {
			const login = await options.auth.login({ password: form.get("password") ?? "", clientIp: ip });
			if (!login.ok) {
				if (login.reason === "rate_limited") {
					audit("rate_limited", { scope: "login", ip });
					return errorPage(429, "Too many attempts. Wait and try again.");
				}
				audit("login_failed", { ip });
				if (found.request.approvalState !== "PENDING_APPROVAL") return expiredResponse(false);
				return consentPage(requestId, found.request.nonce, clientName, redirectUri, "Incorrect password.", 200);
			}
			audit("login_ok", { ip });
			// Registration or pruning may have dropped the client or its pending entry while the password was checked; a code for a missing client could never be redeemed.
			if (found.request.approvalState !== "PENDING_APPROVAL" || pending.get(found.key) !== found.request || own(data.clients, found.request.clientId) === undefined) {
				return expiredResponse(false);
			}
			found.request.approvalState = "APPROVED";
			pending.delete(found.key);
			const t = now();
			const grantId = randomBytes(16).toString("base64url");
			const code = secret("ut_code_");
			data.grants[grantId] = { clientId: found.request.clientId, resource: found.request.resource, createdAt: t, lastUsedAt: t };
			const client = own(data.clients, found.request.clientId);
			if (client !== undefined && client.grantedAt === undefined) client.grantedAt = t;
			data.codes[digest(code)] = {
				clientId: found.request.clientId,
				redirectUri: found.request.redirectUri,
				codeChallenge: found.request.codeChallenge,
				resource: found.request.resource,
				scope: found.request.scope ?? null,
				grantId,
				expiresAt: t + CODE_TTL_MS,
				used: false,
			};
			persist();
			audit("consent_approved", { clientId: found.request.clientId });
			return redirectWith(found.request.redirectUri, { code }, found.request.state);
		} finally {
			approving.delete(found.key);
		}
	}

	async function exchangeCode(form: URLSearchParams, clientId: string): Promise<Response> {
		const key = digest(form.get("code") ?? "");
		const record = own(data.codes, key);
		if (!record) return invalidGrant();
		if (record.used) {
			// A replayed code means the grant leaked. Revoke every token it issued.
			revokeGrant(record.grantId);
			persist();
			return invalidGrant("The authorization code was already used.");
		}
		if (record.expiresAt <= now()) return invalidGrant("The authorization code expired.");
		if (record.clientId !== clientId || record.redirectUri !== (form.get("redirect_uri") ?? "")) {
			return invalidGrant("The code does not match this request.");
		}
		const presented = form.get("resource");
		if (presented !== null && presented !== "" && !sameResource(presented)) {
			return oauthError(400, "invalid_target", "resource must be the ultrathink MCP endpoint.");
		}
		if (!pkceMatches(form.get("code_verifier") ?? "", record.codeChallenge)) {
			return invalidGrant("PKCE verification failed.");
		}
		const snapshot = snapshotStore();
		record.used = true;
		const body = issueTokens(record.grantId, record.clientId, record.resource, record.scope ?? null);
		try {
			persist();
		} catch {
			restoreStore(snapshot);
			return oauthError(500, "server_error", "OAuth state could not be saved.");
		}
		audit("code_exchanged", { clientId });
		return jsonResponse(200, body);
	}

	function refreshGrant(form: URLSearchParams, clientId: string): Response {
		const record = own(data.tokens, digest(form.get("refresh_token") ?? ""));
		if (!record || record.kind !== "refresh") return invalidGrant("The refresh token is unknown.");
		if (record.clientId !== clientId) return invalidGrant("The refresh token belongs to another client.");
		if (record.used) {
			// Refresh rotation: presenting a spent refresh token revokes the whole grant.
			revokeGrant(record.grantId);
			persist();
			audit("refresh_reuse_detected", { clientId });
			return invalidGrant("The refresh token was already used.");
		}
		if (record.expiresAt <= now()) return invalidGrant("The refresh token expired.");
		if (!own(data.grants, record.grantId)) return invalidGrant("The grant was revoked.");
		const presented = form.get("resource");
		if (presented !== null && presented !== "" && !sameResource(presented)) {
			return oauthError(400, "invalid_target", "resource must be the ultrathink MCP endpoint.");
		}
		const snapshot = snapshotStore();
		record.used = true;
		// Keep the spent token only for the reuse-detection window so prune() reclaims it.
		record.expiresAt = Math.min(record.expiresAt, now() + SPENT_REFRESH_TTL_MS);
		const body = issueTokens(record.grantId, record.clientId, record.resource, record.scope ?? null);
		try {
			persist();
		} catch {
			restoreStore(snapshot);
			return oauthError(500, "server_error", "OAuth state could not be saved.");
		}
		audit("token_refreshed", { clientId });
		return jsonResponse(200, body);
	}

	function makeRoomForClient(): boolean {
		prune();
		if (Object.keys(data.clients).length < maxClients) return true;
		// Never evict a client that holds a grant or whose owner approval is being checked right now. Drop the oldest one that never did.
		const approvingClients = new Set<string>();
		for (const key of approving) {
			const request = pending.get(key);
			if (request !== undefined) approvingClients.add(request.clientId);
		}
		let victim: string | null = null;
		let oldest = Number.POSITIVE_INFINITY;
		for (const [id, client] of Object.entries(data.clients)) {
			if (client.grantedAt === undefined && !approvingClients.has(id) && client.createdAt < oldest) {
				oldest = client.createdAt;
				victim = id;
			}
		}
		if (victim === null) return false;
		delete data.clients[victim];
		for (const [key, request] of pending) if (request.clientId === victim) pending.delete(key);
		return true;
	}

	async function register(req: Request, ip = UNKNOWN_IP): Promise<Response> {
		const limit = registerLimiter.hit(ip);
		if (!limit.ok) return oauthError(429, "temporarily_unavailable", "Too many registrations. Try again later.", rateLimited(limit.retryAfterSec));
		if (!isJsonRequest(req)) {
			refusedInput("/oauth/register", "content-type", "UNSUPPORTED_MEDIA_TYPE", ip);
			return oauthError(415, "invalid_client_metadata", "Content-Type must be application/json.");
		}
		const text = await readBodyText(req, MAX_FORM_BYTES);
		if (text === null) {
			refusedInput("/oauth/register", "body", "TOO_LARGE", ip);
			return oauthError(413, "invalid_client_metadata", "The request is too large.");
		}
		let body: Record<string, unknown>;
		try {
			const parsed: unknown = JSON.parse(text);
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
			body = parsed as Record<string, unknown>;
		} catch {
			refusedInput("/oauth/register", "body", "INVALID_JSON", ip);
			return oauthError(400, "invalid_client_metadata", "The body must be a JSON object.");
		}
		const values: Record<string, unknown> = {
			redirect_uris: body.redirect_uris,
			token_endpoint_auth_method: body.token_endpoint_auth_method === undefined ? "none" : body.token_endpoint_auth_method,
			grant_types: body.grant_types ?? [...DEFAULT_GRANT_TYPES],
			response_types: body.response_types ?? ["code"],
			client_name: body.client_name ?? "",
		};
		const checked = checkedFields<RegisterFields>(REGISTER_BODY, values);
		if ("refused" in checked) {
			const { field, code } = checked.refused;
			refusedInput("/oauth/register", field, code, ip);
			if (field === "token_endpoint_auth_method") {
				return oauthError(400, "invalid_client_metadata", "Only token_endpoint_auth_method none is supported (PKCE public clients).");
			}
			if (field === "grant_types") return oauthError(400, "invalid_client_metadata", "Supported grant types: authorization_code, refresh_token.");
			if (field === "response_types") return oauthError(400, "invalid_client_metadata", "Only response_type code is supported.");
			if (field === "client_name") return oauthError(400, "invalid_client_metadata", "client_name must be text without control characters.");
			return oauthError(400, "invalid_redirect_uri", redirectHelp);
		}
		const fields = checked.value;
		if (!fields.redirect_uris.every((uri) => redirectAllowed(uri, allowedRedirectOrigins))) {
			refusedInput("/oauth/register", "redirect_uris", "NOT_ALLOWED", ip);
			return oauthError(400, "invalid_redirect_uri", redirectHelp);
		}
		const redirectUris = [...new Set(fields.redirect_uris)];
		const grantTypes = [...new Set(fields.grant_types)];
		if (!makeRoomForClient()) {
			return oauthError(503, "temporarily_unavailable", "Client registration is full.");
		}
		const rawName = fields.client_name.slice(0, MAX_NAME_CHARS);
		const name = rawName.trim() === "" ? "MCP client" : rawName.trim();
		const clientId = `ut_client_${randomBytes(16).toString("base64url")}`;
		const issuedAt = now();
		data.clients[clientId] = { name, redirectUris, grantTypes, createdAt: issuedAt, lastUsedAt: issuedAt };
		persist();
		audit("client_registered", { clientId });
		return jsonResponse(201, {
			client_id: clientId,
			client_id_issued_at: Math.floor(issuedAt / 1000),
			client_name: name,
			redirect_uris: redirectUris,
			token_endpoint_auth_method: "none",
			grant_types: grantTypes,
			response_types: ["code"],
		});
	}

	async function token(req: Request, ip = UNKNOWN_IP): Promise<Response> {
		const limit = tokenLimiter.hit(ip);
		if (!limit.ok) return oauthError(429, "temporarily_unavailable", "Too many token requests. Try again later.", rateLimited(limit.retryAfterSec));
		const text = await readBodyText(req, MAX_FORM_BYTES);
		if (text === null) {
			refusedInput("/oauth/token", "body", "TOO_LARGE", ip);
			return oauthError(400, "invalid_request", "The request body is too large.");
		}
		const form = new URLSearchParams(text);
		const refused = formRefusal(form, TOKEN_FORM);
		if (refused !== null) return refuseForm("/oauth/token", refused, ip);
		// The per-client budget keys on the client_id the body names, so it runs once the body is read.
		const clientId = form.get("client_id") ?? "";
		if (clientId !== "") {
			const clientLimit = tokenClientLimiter.hit(`client:${clientId}`);
			if (!clientLimit.ok) return oauthError(429, "temporarily_unavailable", "Too many token requests. Try again later.", rateLimited(clientLimit.retryAfterSec));
		}
		const grantType = form.get("grant_type");
		if (grantType !== "authorization_code" && grantType !== "refresh_token") {
			return oauthError(400, "unsupported_grant_type", "Use authorization_code or refresh_token.");
		}
		// An unknown client gets 401 so the client registers again instead of looping on invalid_grant.
		const client = own(data.clients, clientId);
		if (!client) return invalidClient();
		client.lastUsedAt = now();
		if (!client.grantTypes.includes(grantType)) {
			return oauthError(400, "unauthorized_client", `The client was not registered for grant_type ${grantType}.`);
		}
		if (grantType === "authorization_code") return await exchangeCode(form, clientId);
		return refreshGrant(form, clientId);
	}

	async function revoke(req: Request, ip = UNKNOWN_IP): Promise<Response> {
		const limit = revokeLimiter.hit(ip);
		if (!limit.ok) return oauthError(429, "temporarily_unavailable", "Too many revocation requests. Try again later.", rateLimited(limit.retryAfterSec));
		const text = await readBodyText(req, MAX_FORM_BYTES);
		if (text === null) {
			refusedInput("/oauth/revoke", "body", "TOO_LARGE", ip);
			return oauthError(400, "invalid_request", "The request body is too large.");
		}
		const form = new URLSearchParams(text);
		const refused = formRefusal(form, REVOKE_FORM);
		if (refused !== null) return refuseForm("/oauth/revoke", refused, ip);
		const presented = form.get("token") ?? "";
		if (presented === "") return oauthError(400, "invalid_request", "token is required.");
		const record = own(data.tokens, digest(presented));
		if (record !== undefined) {
			const clientId = form.get("client_id") ?? "";
			// Possession is enough, but a client that names itself must be the token's client.
			if (clientId === "" || clientId === record.clientId) {
				revokeGrant(record.grantId);
				persist();
				audit("token_revoked", { clientId: record.clientId });
			}
		}
		// RFC 7009: the answer never reveals whether the token existed.
		return new Response(null, { status: 200, headers: API_HEADERS });
	}

	function verifyAccessToken(presented: string): boolean {
		if (presented === "") return false;
		const record = own(data.tokens, digest(presented));
		if (!record || record.kind !== "access") return false;
		if (record.expiresAt <= now()) return false;
		if (record.resource !== resource) return false;
		return own(data.grants, record.grantId) !== undefined;
	}

	return {
		resource,
		resourceMetadataUrl,
		protectedResourceMetadata() {
			return jsonResponse(
				200,
				{ resource, authorization_servers: [origin], bearer_methods_supported: ["header"], resource_name: "ultrathink" },
				{ "Cache-Control": "public, max-age=3600" },
			);
		},
		authorizationServerMetadata() {
			return jsonResponse(
				200,
				{
					issuer: origin,
					authorization_endpoint: `${origin}/oauth/authorize`,
					token_endpoint: `${origin}/oauth/token`,
					registration_endpoint: `${origin}/oauth/register`,
					revocation_endpoint: `${origin}/oauth/revoke`,
					response_types_supported: ["code"],
					grant_types_supported: [...SUPPORTED_GRANTS],
					code_challenge_methods_supported: ["S256"],
					token_endpoint_auth_methods_supported: ["none"],
					revocation_endpoint_auth_methods_supported: ["none"],
					scopes_supported: ["mcp"],
					authorization_response_iss_parameter_supported: true,
				},
				{ "Cache-Control": "public, max-age=3600" },
			);
		},
		register,
		async authorize(req, ip) {
			// GET and POST (approve or poll) share one budget: every hit reaches the consent machinery.
			const limit = authorizeLimiter.hit(ip);
			if (!limit.ok) return errorPage(429, "Too many requests. Wait and try again.", rateLimited(limit.retryAfterSec));
			if (req.method === "GET") return authorizeGet(new URL(req.url).searchParams);
			return await authorizePost(req, ip);
		},
		token,
		revoke,
		verifyAccessToken,
		classifyBearer(presented) {
			if (presented === null || presented === "") return "absent";
			return verifyAccessToken(presented) ? "valid" : "invalid";
		},
	};
}
