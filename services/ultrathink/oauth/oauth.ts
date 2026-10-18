// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

// OAuth 2.1 authorization code flow with PKCE (S256) for the MCP endpoint.
// Discovery follows RFC 9728 (protected resource) and RFC 8414 (authorization
// server). Clients register with RFC 7591 dynamic registration. Tokens are bound
// to the MCP resource (RFC 8707). Only SHA-256 digests of secrets are stored.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ApprovalProof, Auth } from "../auth/auth.ts";

const ACCESS_TTL_MS = 60 * 60 * 1000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CODE_TTL_MS = 60 * 1000;
const PENDING_TTL_MS = 10 * 60 * 1000;
const POLL_INTERVAL_MS = 10 * 1000;
const MAX_PENDING = 200;
const EXPIRED_MESSAGE = "This authorization request expired. Start the connection again from your client.";
const MAX_CLIENTS = 200;
const MAX_REDIRECT_URIS = 5;
const MAX_REDIRECT_URI_CHARS = 2048;
const MAX_NAME_CHARS = 120;
const MAX_FORM_BYTES = 8192;
const VERIFIER_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/;
const CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const STATE_FILE = "oauth.json";
const SUPPORTED_GRANTS = ["authorization_code", "refresh_token"] as const;

interface ClientRecord {
	name: string;
	redirectUris: string[];
	createdAt: number;
}

interface GrantRecord {
	clientId: string;
	resource: string;
	createdAt: number;
}

interface CodeRecord {
	clientId: string;
	redirectUri: string;
	codeChallenge: string;
	resource: string;
	grantId: string;
	expiresAt: number;
	used: boolean;
}

interface TokenRecord {
	kind: "access" | "refresh";
	grantId: string;
	clientId: string;
	resource: string;
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
}

export interface OAuth {
	readonly resource: string;
	readonly resourceMetadataUrl: string;
	protectedResourceMetadata(): Response;
	authorizationServerMetadata(): Response;
	register(req: Request): Promise<Response>;
	authorize(req: Request, ip: string): Promise<Response>;
	token(req: Request): Promise<Response>;
	verifyAccessToken(token: string): boolean;
}

const NO_STORE = {
	"Cache-Control": "no-store",
	Pragma: "no-cache",
	"X-Content-Type-Options": "nosniff",
	"Referrer-Policy": "no-referrer",
};

const HTML_HEADERS = {
	...NO_STORE,
	"Content-Type": "text/html; charset=utf-8",
	// form-action must allow the registered redirect. Chrome applies it to the
	// redirect that follows this form post. 'self' alone cancels the jump to
	// https://grok.com, so the page does not move and the next click is expired.
	"Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https: http://127.0.0.1:* http://localhost:* http://[::1]:*; frame-ancestors 'none'; base-uri 'none'",
	"X-Frame-Options": "DENY",
};

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { ...NO_STORE, "Content-Type": "application/json; charset=utf-8", ...headers },
	});
}

function oauthError(status: number, error: string, description: string): Response {
	return jsonResponse(status, { error, error_description: description });
}

function invalidGrant(description = "The authorization is invalid or expired."): Response {
	return oauthError(400, "invalid_grant", description);
}

function htmlPage(status: number, body: string): Response {
	return new Response(body, { status, headers: HTML_HEADERS });
}

function errorPage(status: number, message: string): Response {
	return htmlPage(
		status,
		page("Authorization failed", `<p class="err">${escapeHtml(message)}</p>`),
	);
}

function page(title: string, content: string): string {
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><style>body{font-family:system-ui,sans-serif;max-width:28rem;margin:4rem auto;padding:0 1rem;color:#111}input,button{font:inherit;padding:.6rem;width:100%;box-sizing:border-box;margin-top:.4rem}button{margin-top:1rem;cursor:pointer}.err{color:#b00020}</style></head><body><h1>${escapeHtml(title)}</h1>${content}</body></html>`;
}

function escapeHtml(value: string): string {
	const map: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
	return value.replace(/[&<>"']/g, (char) => map[char] ?? char);
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

function validRedirectUri(raw: unknown): raw is string {
	if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_REDIRECT_URI_CHARS) return false;
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		return false;
	}
	if (url.hash !== "") return false;
	if (url.protocol === "https:") return true;
	return url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
}

function pkceMatches(verifier: string, challenge: string): boolean {
	if (!VERIFIER_PATTERN.test(verifier)) return false;
	const computed = Buffer.from(digest(verifier));
	const expected = Buffer.from(challenge);
	return computed.length === expected.length && timingSafeEqual(computed, expected);
}

function emptyStore(): StoreShape {
	return { clients: {}, grants: {}, codes: {}, tokens: {}, pending: {} };
}

function loadStore(path: string): StoreShape {
	if (!existsSync(path)) return emptyStore();
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<StoreShape>;
		return {
			clients: parsed.clients ?? {},
			grants: parsed.grants ?? {},
			codes: parsed.codes ?? {},
			tokens: parsed.tokens ?? {},
			pending: parsed.pending ?? {},
		};
	} catch {
		// A corrupt file forgets every client and token. Users re-consent; nothing is granted by default.
		return emptyStore();
	}
}

function saveStore(dir: string, path: string, data: StoreShape): void {
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
	renameSync(tmp, path);
}

export function createOAuth(options: OAuthOptions): OAuth {
	const origin = options.origin;
	const resource = `${origin}/mcp`;
	const resourceMetadataUrl = `${origin}/.well-known/oauth-protected-resource/mcp`;
	const now = options.now ?? Date.now;
	const path = join(options.stateDir, STATE_FILE);
	const data = loadStore(path);
	const pending = new Map<string, PendingRequest>();
	const polls = new Map<string, NodeJS.Timeout>();
	const approving = new Set<string>();
	// A fake clock means a test. Wall-clock polling would race that clock, so only production arms it.
	const armPolls = options.now === undefined;

	function stopPoll(key: string): void {
		const timer = polls.get(key);
		if (timer === undefined) return;
		clearInterval(timer);
		polls.delete(key);
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

	function prune(): void {
		const t = now();
		for (const [key, record] of Object.entries(data.codes)) if (record.expiresAt <= t) delete data.codes[key];
		for (const [key, record] of Object.entries(data.tokens)) if (record.expiresAt <= t) delete data.tokens[key];
		for (const [key, request] of pending) {
			if (request.expiresAt <= t || request.approvalState === "EXPIRED") {
				request.approvalState = "EXPIRED";
				stopPoll(key);
				pending.delete(key);
			}
		}
	}

	function persist(): void {
		prune();
		data.pending = {};
		for (const [key, request] of pending) data.pending[key] = { ...request };
		saveStore(options.stateDir, path, data);
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
			stopPoll(key);
			return "EXPIRED";
		}
		request.refreshedAt = t;
		request.expiresAt = deadline;
		request.signature = options.auth.signApproval(proofOf(key, request));
		return "PENDING_APPROVAL";
	}

	function startPoll(key: string): void {
		if (!armPolls || polls.has(key)) return;
		const timer = setInterval(() => {
			try {
				const state = tickApproval(key);
				if (state !== "PENDING_APPROVAL") stopPoll(key);
				persist();
			} catch {
				// A disk error must not take down consent. The in-memory request stays pending.
			}
		}, POLL_INTERVAL_MS);
		timer.unref();
		polls.set(key, timer);
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
		if (record.approvalState === "PENDING_APPROVAL" && record.expiresAt > now()) startPoll(key);
	}

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

	function issueTokens(grantId: string, clientId: string, grantResource: string): Record<string, unknown> {
		const t = now();
		const access = secret("ut_at_");
		const refresh = secret("ut_rt_");
		data.tokens[digest(access)] = { kind: "access", grantId, clientId, resource: grantResource, expiresAt: t + ACCESS_TTL_MS, used: false };
		data.tokens[digest(refresh)] = { kind: "refresh", grantId, clientId, resource: grantResource, expiresAt: t + REFRESH_TTL_MS, used: false };
		return {
			access_token: access,
			token_type: "Bearer",
			expires_in: Math.floor(ACCESS_TTL_MS / 1000),
			refresh_token: refresh,
		};
	}

	function consentPage(requestId: string, nonce: string, clientName: string, message: string, status: number): Response {
		const alert = message === "" ? "" : `<p class="err">${escapeHtml(message)}</p>`;
		const content = `<p data-approval-state="PENDING_APPROVAL">Allow <strong>${escapeHtml(clientName)}</strong> to use the ultrathink planning tools on this server? Enter the owner password to approve.</p>${alert}<form method="post" action="/oauth/authorize"><input type="hidden" name="req" value="${escapeHtml(requestId)}"><input type="hidden" name="nonce" value="${escapeHtml(nonce)}"><label>Owner password<input type="password" name="password" autocomplete="current-password" required></label><button type="submit">Approve</button></form>`;
		return htmlPage(status, page("Authorize ultrathink", content));
	}

	function redirectWith(redirectUri: string, params: Record<string, string>, state: string | null): Response {
		const url = new URL(redirectUri);
		for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
		if (state !== null) url.searchParams.set("state", state);
		return new Response(null, { status: 302, headers: { ...NO_STORE, Location: url.toString() } });
	}

	function authorizeGet(params: URLSearchParams): Response {
		const client = own(data.clients, params.get("client_id") ?? "");
		if (!client) return errorPage(400, "This client is not registered with ultrathink.");
		const redirectUri = params.get("redirect_uri") ?? "";
		if (!client.redirectUris.includes(redirectUri)) {
			return errorPage(400, "The redirect address does not match this client's registration.");
		}
		const state = params.get("state");
		if (params.get("response_type") !== "code") {
			return redirectWith(redirectUri, { error: "unsupported_response_type", error_description: "response_type must be code." }, state);
		}
		const challenge = params.get("code_challenge") ?? "";
		if (params.get("code_challenge_method") !== "S256" || !CHALLENGE_PATTERN.test(challenge)) {
			return redirectWith(redirectUri, { error: "invalid_request", error_description: "PKCE with S256 is required." }, state);
		}
		if (params.get("resource") !== resource) {
			return redirectWith(redirectUri, { error: "invalid_target", error_description: "resource must be the ultrathink MCP endpoint." }, state);
		}
		if (pending.size >= MAX_PENDING) {
			prune();
			if (pending.size >= MAX_PENDING) return errorPage(503, "Authorization is temporarily unavailable. Start the connection again from your client.");
		}
		const requestId = secret("ut_req_");
		const key = digest(requestId);
		const createdAt = now();
		const nonce = options.auth.newApprovalNonce();
		const request: PendingRequest = {
			clientId: params.get("client_id") ?? "",
			redirectUri,
			codeChallenge: challenge,
			resource,
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
		startPoll(key);
		persist();
		return consentPage(requestId, nonce, client.name, "", 200);
	}

	async function authorizePost(req: Request, ip: string): Promise<Response> {
		const text = await readBodyText(req, MAX_FORM_BYTES);
		if (text === null) return errorPage(413, "The request is too large.");
		const form = new URLSearchParams(text);
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
		persist();
		if (polling) {
			const remaining = Math.max(0, Math.ceil((found.request.expiresAt - now()) / 1000));
			return jsonResponse(200, { state: "PENDING_APPROVAL", expires_in: remaining, refreshed_at: found.request.refreshedAt });
		}
		const clientName = own(data.clients, found.request.clientId)?.name ?? "MCP client";
		if (approving.has(found.key)) {
			return consentPage(requestId, found.request.nonce, clientName, "This approval is already being checked. Wait for the result.", 200);
		}
		const attempt = options.auth.allowApprovalAttempt(ip);
		if (!attempt.ok) return errorPage(429, "Too many attempts. Wait and try again.");
		approving.add(found.key);
		try {
			const login = await options.auth.login({ password: form.get("password") ?? "", clientIp: ip });
			if (!login.ok) {
				if (login.reason === "rate_limited") return errorPage(429, "Too many attempts. Wait and try again.");
				if (found.request.approvalState !== "PENDING_APPROVAL") return expiredResponse(false);
				return consentPage(requestId, found.request.nonce, clientName, "Incorrect password.", 200);
			}
			if (found.request.approvalState !== "PENDING_APPROVAL") return expiredResponse(false);
			found.request.approvalState = "APPROVED";
			stopPoll(found.key);
			pending.delete(found.key);
			const grantId = randomBytes(16).toString("base64url");
			const code = secret("ut_code_");
			data.grants[grantId] = { clientId: found.request.clientId, resource: found.request.resource, createdAt: now() };
			data.codes[digest(code)] = {
				clientId: found.request.clientId,
				redirectUri: found.request.redirectUri,
				codeChallenge: found.request.codeChallenge,
				resource: found.request.resource,
				grantId,
				expiresAt: now() + CODE_TTL_MS,
				used: false,
			};
			persist();
			return redirectWith(found.request.redirectUri, { code }, found.request.state);
		} finally {
			approving.delete(found.key);
		}
	}

	async function exchangeCode(form: URLSearchParams): Promise<Response> {
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
		if (
			record.clientId !== (form.get("client_id") ?? "") ||
			record.redirectUri !== (form.get("redirect_uri") ?? "") ||
			record.resource !== (form.get("resource") ?? "")
		) {
			return invalidGrant("The code does not match this request.");
		}
		if (!pkceMatches(form.get("code_verifier") ?? "", record.codeChallenge)) {
			return invalidGrant("PKCE verification failed.");
		}
		record.used = true;
		const body = issueTokens(record.grantId, record.clientId, record.resource);
		persist();
		return jsonResponse(200, body);
	}

	function refreshGrant(form: URLSearchParams): Response {
		const clientId = form.get("client_id") ?? "";
		const record = own(data.tokens, digest(form.get("refresh_token") ?? ""));
		if (!record || record.kind !== "refresh") return invalidGrant("The refresh token is unknown.");
		if (record.clientId !== clientId) return invalidGrant("The refresh token belongs to another client.");
		if (record.used) {
			// Refresh rotation: presenting a spent refresh token revokes the whole grant.
			revokeGrant(record.grantId);
			persist();
			return invalidGrant("The refresh token was already used.");
		}
		if (record.expiresAt <= now()) return invalidGrant("The refresh token expired.");
		if (!own(data.grants, record.grantId)) return invalidGrant("The grant was revoked.");
		record.used = true;
		const body = issueTokens(record.grantId, record.clientId, record.resource);
		persist();
		return jsonResponse(200, body);
	}

	async function register(req: Request): Promise<Response> {
		if (!isJsonRequest(req)) return oauthError(415, "invalid_client_metadata", "Content-Type must be application/json.");
		const text = await readBodyText(req, MAX_FORM_BYTES);
		if (text === null) return oauthError(413, "invalid_client_metadata", "The request is too large.");
		let body: Record<string, unknown>;
		try {
			const parsed: unknown = JSON.parse(text);
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
			body = parsed as Record<string, unknown>;
		} catch {
			return oauthError(400, "invalid_client_metadata", "The body must be a JSON object.");
		}
		const uris = body.redirect_uris;
		if (!Array.isArray(uris) || uris.length === 0 || uris.length > MAX_REDIRECT_URIS || !uris.every(validRedirectUri)) {
			return oauthError(400, "invalid_redirect_uri", "Register 1 to 5 https redirect URIs, or loopback http URIs.");
		}
		if (body.token_endpoint_auth_method !== undefined && body.token_endpoint_auth_method !== "none") {
			return oauthError(400, "invalid_client_metadata", "Only token_endpoint_auth_method none is supported (PKCE public clients).");
		}
		const grants = body.grant_types ?? ["authorization_code"];
		if (!Array.isArray(grants) || !grants.every((g) => (SUPPORTED_GRANTS as readonly unknown[]).includes(g))) {
			return oauthError(400, "invalid_client_metadata", "Supported grant types: authorization_code, refresh_token.");
		}
		const responseTypes = body.response_types ?? ["code"];
		if (!Array.isArray(responseTypes) || !responseTypes.every((r) => r === "code")) {
			return oauthError(400, "invalid_client_metadata", "Only response_type code is supported.");
		}
		if (Object.keys(data.clients).length >= MAX_CLIENTS) {
			return oauthError(503, "temporarily_unavailable", "Client registration is full.");
		}
		const rawName = typeof body.client_name === "string" ? body.client_name.slice(0, MAX_NAME_CHARS) : "";
		const name = rawName.trim() === "" ? "MCP client" : rawName.trim();
		const clientId = `ut_client_${randomBytes(16).toString("base64url")}`;
		const issuedAt = now();
		data.clients[clientId] = { name, redirectUris: [...uris], createdAt: issuedAt };
		persist();
		return jsonResponse(201, {
			client_id: clientId,
			client_id_issued_at: Math.floor(issuedAt / 1000),
			client_name: name,
			redirect_uris: uris,
			token_endpoint_auth_method: "none",
			grant_types: [...SUPPORTED_GRANTS],
			response_types: ["code"],
		});
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
					response_types_supported: ["code"],
					grant_types_supported: [...SUPPORTED_GRANTS],
					code_challenge_methods_supported: ["S256"],
					token_endpoint_auth_methods_supported: ["none"],
				},
				{ "Cache-Control": "public, max-age=3600" },
			);
		},
		register,
		async authorize(req, ip) {
			if (req.method === "GET") return authorizeGet(new URL(req.url).searchParams);
			return await authorizePost(req, ip);
		},
		async token(req) {
			const text = await readBodyText(req, MAX_FORM_BYTES);
			if (text === null) return oauthError(400, "invalid_request", "The request body is too large.");
			const form = new URLSearchParams(text);
			const grantType = form.get("grant_type");
			if (grantType === "authorization_code") return await exchangeCode(form);
			if (grantType === "refresh_token") return refreshGrant(form);
			return oauthError(400, "unsupported_grant_type", "Use authorization_code or refresh_token.");
		},
		verifyAccessToken(token) {
			if (token === "") return false;
			const record = own(data.tokens, digest(token));
			if (!record || record.kind !== "access") return false;
			if (record.expiresAt <= now()) return false;
			if (record.resource !== resource) return false;
			return own(data.grants, record.grantId) !== undefined;
		},
	};
}
