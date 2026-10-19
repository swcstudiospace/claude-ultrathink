// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import * as nodeFs from "node:fs";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAuth } from "../auth/auth.ts";
import { DEFAULT_REDIRECT_ORIGINS, type DurableFs, type OAuth, type OAuthOptions, createOAuth, writeFileDurably } from "./oauth.ts";
import type { UltrathinkConfig } from "../config/config.ts";
import { openStore, type Store } from "../store/store.ts";
import { createHandler } from "../routes/router.ts";

const ORIGIN = "https://ultrathink.test";
const RESOURCE = `${ORIGIN}/mcp`;
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const PEER = "127.0.0.1";
const ACCESS_TTL_MS = 60 * 60 * 1000;
const CODE_TTL_MS = 60 * 1000;
const CONNECTOR_KEY = randomBytes(24).toString("hex");

type Handler = (req: Request, peerIp: string) => Promise<Response>;

let dir: string;
let store: Store;
let handler: Handler;
let password: string;
let clock: number;

function pkcePair(): { verifier: string; challenge: string } {
	const verifier = randomBytes(32).toString("base64url");
	return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

function form(body: Record<string, string>): string {
	return new URLSearchParams(body).toString();
}

async function registerClient(redirect = REDIRECT): Promise<string> {
	const response = await handler(
		new Request(`${ORIGIN}/oauth/register`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ client_name: "Grok", redirect_uris: [redirect] }),
		}),
		freshIp(),
	);
	expect(response.status).toBe(201);
	const body = (await response.json()) as { client_id: string };
	return body.client_id;
}

async function startAuthorize(clientId: string, challenge: string, overrides: Record<string, string> = {}): Promise<Response> {
	const params = new URLSearchParams({
		response_type: "code",
		client_id: clientId,
		redirect_uri: REDIRECT,
		code_challenge: challenge,
		code_challenge_method: "S256",
		resource: RESOURCE,
		state: "state-1",
		...overrides,
	});
	return handler(new Request(`${ORIGIN}/oauth/authorize?${params.toString()}`, { method: "GET" }), freshIp());
}

function consentFrom(html: string): { requestId: string; nonce: string } {
	const requestId = /name="req" value="([^"]+)"/.exec(html)?.[1];
	const nonce = /name="nonce" value="([^"]+)"/.exec(html)?.[1];
	if (!requestId || !nonce) throw new Error("consent form has no request id");
	return { requestId, nonce };
}

let loginSeq = 0;
let ipSeq = 0;

// Registration, authorize and token calls are limited per IP, so each call gets its own peer.
function freshIp(): string {
	ipSeq += 1;
	return `198.18.${Math.floor(ipSeq / 250)}.${(ipSeq % 250) + 1}`;
}

// The owner login allows 5 attempts per IP per window, so each approval gets its own peer.
async function approve(html: string, owner: string, peer?: string): Promise<Response> {
	const { requestId, nonce } = consentFrom(html);
	loginSeq += 1;
	return handler(
		new Request(`${ORIGIN}/oauth/authorize`, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: form({ req: requestId, nonce, password: owner }),
		}),
		peer ?? `10.0.${Math.floor(loginSeq / 250)}.${(loginSeq % 250) + 1}`,
	);
}

async function pollConsent(html: string): Promise<Response> {
	const { requestId, nonce } = consentFrom(html);
	return handler(
		new Request(`${ORIGIN}/oauth/authorize`, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: form({ req: requestId, nonce, action: "poll" }),
		}),
		PEER,
	);
}

function codeFrom(response: Response): string {
	const location = response.headers.get("location");
	expect(location).not.toBeNull();
	const code = new URL(location ?? "").searchParams.get("code");
	expect(code).not.toBeNull();
	return code ?? "";
}

async function exchange(body: Record<string, string>): Promise<Response> {
	return handler(
		new Request(`${ORIGIN}/oauth/token`, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: form(body),
		}),
		freshIp(),
	);
}

async function issueTokens(clientId: string): Promise<{ access_token: string; refresh_token: string; code: string; verifier: string }> {
	const { verifier, challenge } = pkcePair();
	const consent = await startAuthorize(clientId, challenge);
	expect(consent.status).toBe(200);
	const granted = await approve(await consent.text(), password);
	const code = codeFrom(granted);
	const tokens = await exchange({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: clientId, redirect_uri: REDIRECT, resource: RESOURCE });
	expect(tokens.status).toBe(200);
	const body = (await tokens.json()) as { access_token: string; refresh_token: string };
	return { ...body, code, verifier };
}

function mcpToolsList(token: string | null): Request {
	const headers: Record<string, string> = { "Content-Type": "application/json" };
	if (token !== null) headers.Authorization = `Bearer ${token}`;
	return new Request(`${ORIGIN}/mcp`, {
		method: "POST",
		headers,
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
	});
}

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), "ultrathink-oauth-"));
	password = randomBytes(24).toString("base64url");
	const ownerPasswordHash = await Bun.password.hash(password);
	const sessionSecret = randomBytes(32).toString("hex");
	const config: UltrathinkConfig = {
		publicOrigin: ORIGIN,
		ownerPasswordHash,
		sessionSecret,
		stateDir: dir,
		dbPath: join(dir, "ultrathink.db"),
		port: 0,
		maxInputChars: 200,
		maxAnswerChars: 20000,
		maxBodyBytes: 16384,
		runTokenCeiling: 150000,
		dailyTokenCeiling: 1000000,
		planningModel: undefined,
		connectorKey: CONNECTOR_KEY,
		allowedOrigins: [],
		oauthRedirectOrigins: [],
		openRouterApiKey: undefined,
		openRouterBaseUrl: "https://openrouter.ai/api/v1",
		serverPlanning: false,
		maxConcurrentPlans: 2,
		modelTimeoutMs: 120000,
		planTimeoutMs: 600000,
		modelMaxOutputTokens: 8000,
		serverDecisions: false,
	};
	const auth = createAuth({ ownerPasswordHash, sessionSecret, cookieSecure: true });
	store = openStore(config.dbPath);
	clock = 1_700_000_000_000;
	handler = createHandler({ config, store, auth, now: () => clock });
});

afterAll(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

describe("OAuth discovery", () => {
	test("publishes protected-resource and authorization-server metadata with S256 PKCE", async () => {
		const resource = await handler(new Request(`${ORIGIN}/.well-known/oauth-protected-resource/mcp`), PEER);
		expect(resource.status).toBe(200);
		const protectedBody = (await resource.json()) as { resource: string; authorization_servers: string[] };
		expect(protectedBody.resource).toBe(RESOURCE);
		expect(protectedBody.authorization_servers).toEqual([ORIGIN]);

		const server = await handler(new Request(`${ORIGIN}/.well-known/oauth-authorization-server`), PEER);
		const serverBody = (await server.json()) as Record<string, unknown>;
		expect(serverBody.code_challenge_methods_supported).toEqual(["S256"]);
		expect(serverBody.authorization_endpoint).toBe(`${ORIGIN}/oauth/authorize`);
		expect(serverBody.token_endpoint).toBe(`${ORIGIN}/oauth/token`);
		expect(serverBody.registration_endpoint).toBe(`${ORIGIN}/oauth/register`);
	});

	test("challenges MCP calls without a token with the metadata URL", async () => {
		const response = await handler(mcpToolsList(null), PEER);
		expect(response.status).toBe(401);
		expect(response.headers.get("www-authenticate")).toContain(`${ORIGIN}/.well-known/oauth-protected-resource/mcp`);
	});
});

describe("OAuth authorization code flow", () => {
	test("PKCE exchange issues a token that opens the MCP endpoint", async () => {
		const clientId = await registerClient();
		const tokens = await issueTokens(clientId);
		const list = await handler(mcpToolsList(tokens.access_token), PEER);
		expect(list.status).toBe(200);
		expect(await list.text()).toContain("ultrathink_plan");
	});

	test("a wrong owner password re-renders consent and issues no code", async () => {
		const clientId = await registerClient();
		const { challenge } = pkcePair();
		const consent = await startAuthorize(clientId, challenge);
		const retry = await approve(await consent.text(), "not-the-password");
		expect(retry.status).toBe(200);
		expect(retry.headers.get("location")).toBeNull();
		expect(await retry.text()).toContain("Incorrect password.");
	});

	test("a wrong PKCE verifier is refused and the code stays usable", async () => {
		const clientId = await registerClient();
		const { verifier, challenge } = pkcePair();
		const consent = await startAuthorize(clientId, challenge);
		const code = codeFrom(await approve(await consent.text(), password));
		const base = { grant_type: "authorization_code", code, client_id: clientId, redirect_uri: REDIRECT, resource: RESOURCE };
		const wrong = await exchange({ ...base, code_verifier: randomBytes(32).toString("base64url") });
		expect(wrong.status).toBe(400);
		expect(((await wrong.json()) as { error: string }).error).toBe("invalid_grant");
		const right = await exchange({ ...base, code_verifier: verifier });
		expect(right.status).toBe(200);
	});

	test("a replayed code revokes the tokens it issued", async () => {
		const clientId = await registerClient();
		const tokens = await issueTokens(clientId);
		const replay = await exchange({
			grant_type: "authorization_code",
			code: tokens.code,
			code_verifier: tokens.verifier,
			client_id: clientId,
			redirect_uri: REDIRECT,
			resource: RESOURCE,
		});
		expect(replay.status).toBe(400);
		expect((await handler(mcpToolsList(tokens.access_token), PEER)).status).toBe(401);
	});

	test("the code is bound to the MCP resource", async () => {
		const clientId = await registerClient();
		const { verifier, challenge } = pkcePair();
		const consent = await startAuthorize(clientId, challenge);
		const code = codeFrom(await approve(await consent.text(), password));
		const other = await exchange({
			grant_type: "authorization_code",
			code,
			code_verifier: verifier,
			client_id: clientId,
			redirect_uri: REDIRECT,
			resource: `${ORIGIN}/other`,
		});
		expect(other.status).toBe(400);
		expect(((await other.json()) as { error: string }).error).toBe("invalid_target");
	});

	test("authorize refuses a non-S256 challenge and a foreign resource through the redirect", async () => {
		const clientId = await registerClient();
		const { challenge } = pkcePair();
		const plain = await startAuthorize(clientId, challenge, { code_challenge_method: "plain" });
		expect(new URL(plain.headers.get("location") ?? "").searchParams.get("error")).toBe("invalid_request");
		const foreign = await startAuthorize(clientId, challenge, { resource: "https://other.test/mcp" });
		expect(new URL(foreign.headers.get("location") ?? "").searchParams.get("error")).toBe("invalid_target");
	});

	test("authorize rejects an unregistered redirect URI without redirecting", async () => {
		const clientId = await registerClient();
		const { challenge } = pkcePair();
		const response = await startAuthorize(clientId, challenge, { redirect_uri: "https://evil.test/cb" });
		expect(response.status).toBe(400);
		expect(response.headers.get("location")).toBeNull();
	});

	test("registration refuses plain http redirect URIs outside loopback", async () => {
		const response = await handler(
			new Request(`${ORIGIN}/oauth/register`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ redirect_uris: ["http://grok.example/cb"] }),
			}),
			PEER,
		);
		expect(response.status).toBe(400);
	});

	test("refresh tokens rotate, and a spent refresh token revokes the grant", async () => {
		const clientId = await registerClient();
		const first = await issueTokens(clientId);
		const rotated = await exchange({ grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: clientId });
		expect(rotated.status).toBe(200);
		const next = (await rotated.json()) as { access_token: string; refresh_token: string };
		const spent = await exchange({ grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: clientId });
		expect(spent.status).toBe(400);
		expect((await handler(mcpToolsList(next.access_token), PEER)).status).toBe(401);
	});

	test("access tokens and codes expire", async () => {
		const clientId = await registerClient();
		const tokens = await issueTokens(clientId);
		clock += ACCESS_TTL_MS + 1;
		expect((await handler(mcpToolsList(tokens.access_token), PEER)).status).toBe(401);

		const { verifier, challenge } = pkcePair();
		const consent = await startAuthorize(clientId, challenge);
		const code = codeFrom(await approve(await consent.text(), password));
		clock += CODE_TTL_MS + 1;
		const late = await exchange({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: clientId, redirect_uri: REDIRECT, resource: RESOURCE });
		expect(late.status).toBe(400);
	});

	test("the connector key still opens the MCP endpoint", async () => {
		const response = await handler(
			new Request(`${ORIGIN}/mcp`, {
				method: "POST",
				headers: { "Content-Type": "application/json", "x-connector-key": CONNECTOR_KEY },
				body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
			}),
			PEER,
		);
		expect(response.status).toBe(200);
	});

	test("a 45s delay stays PENDING_APPROVAL and approve does not expire", async () => {
		const clientId = await registerClient();
		const { challenge } = pkcePair();
		const consent = await startAuthorize(clientId, challenge);
		const html = await consent.text();
		expect(consent.headers.get("content-security-policy")).toContain("form-action 'self' https://claude.ai;");
		expect(html).toContain('data-approval-state="PENDING_APPROVAL"');
		clock += 45_000;
		const polled = await pollConsent(html);
		expect(polled.status).toBe(200);
		const body: unknown = await polled.json();
		if (typeof body !== "object" || body === null || !("state" in body) || body.state !== "PENDING_APPROVAL") {
			throw new Error("poll did not stay PENDING_APPROVAL");
		}
		if (!("refreshed_at" in body) || body.refreshed_at !== clock) throw new Error("approve poll did not refresh the timestamp");
		const granted = await approve(html, password);
		expect(granted.status).toBe(302);
		expect(await granted.text()).not.toContain("expired");
		expect(granted.headers.get("location")).toContain("code=");
	});

	test("approval stays PENDING_APPROVAL until the absolute timeout", async () => {
		const clientId = await registerClient();
		const { challenge } = pkcePair();
		const consent = await startAuthorize(clientId, challenge);
		const html = await consent.text();
		clock += 10 * 60 * 1000 - 1;
		const still = await pollConsent(html);
		expect(still.status).toBe(200);
		const stillBody: unknown = await still.json();
		if (typeof stillBody !== "object" || stillBody === null || !("state" in stillBody) || stillBody.state !== "PENDING_APPROVAL") {
			throw new Error("request left PENDING_APPROVAL before the deadline");
		}
		clock += 2;
		const late = await approve(html, password);
		expect(late.status).toBe(400);
		const text = await late.text();
		expect(text).toContain("This authorization request expired. Start the connection again from your client.");
		expect(text).not.toContain('data-approval-state="PENDING_APPROVAL"');
	});

	test("a third approve attempt in one minute is limited and the request stays pending", async () => {
		const clientId = await registerClient();
		const { challenge } = pkcePair();
		const html = await (await startAuthorize(clientId, challenge)).text();
		const peer = "198.51.100.77";
		expect(await (await approve(html, "not-the-password", peer)).text()).toContain("Incorrect password.");
		expect(await (await approve(html, "not-the-password", peer)).text()).toContain("Incorrect password.");
		const third = await approve(html, password, peer);
		const limited = await third.text();
		expect(third.status).toBe(429);
		expect(limited).toContain("Too many attempts");
		expect(limited).not.toContain("authorization request expired");
		const pendingBody: unknown = await (await pollConsent(html)).json();
		if (typeof pendingBody !== "object" || pendingBody === null || !("state" in pendingBody) || pendingBody.state !== "PENDING_APPROVAL") {
			throw new Error("rate limit expired the pending approval");
		}
	});

	test("a bad nonce is rejected without consuming the pending approval", async () => {
		const clientId = await registerClient();
		const { challenge } = pkcePair();
		const html = await (await startAuthorize(clientId, challenge)).text();
		const { requestId } = consentFrom(html);
		loginSeq += 1;
		const tampered = await handler(
			new Request(`${ORIGIN}/oauth/authorize`, {
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body: form({ req: requestId, nonce: "not-the-nonce", password }),
			}),
			`10.1.0.${loginSeq}`,
		);
		expect(tampered.status).toBe(400);
		expect(await tampered.text()).toContain("This authorization request expired");
		expect((await approve(html, password)).status).toBe(302);
	});

	test("reloading persisted state still approves after a 45s delay", async () => {
		const restartDir = mkdtempSync(join(tmpdir(), "ultrathink-oauth-restart-"));
		try {
			const localAuth = createAuth({
				ownerPasswordHash: await Bun.password.hash(password),
				sessionSecret: randomBytes(32).toString("hex"),
				cookieSecure: true,
				now: () => clock,
			});
			const opened = { origin: ORIGIN, stateDir: restartDir, auth: localAuth, now: () => clock };
			const first = createOAuth(opened);
			const registered = await first.register(
				new Request(`${ORIGIN}/oauth/register`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ client_name: "Grok", redirect_uris: [REDIRECT] }),
				}),
			);
			expect(registered.status).toBe(201);
			const registeredBody: unknown = await registered.json();
			if (typeof registeredBody !== "object" || registeredBody === null || !("client_id" in registeredBody) || typeof registeredBody.client_id !== "string") {
				throw new Error("registration has no client id");
			}
			const clientId = registeredBody.client_id;
			const { challenge } = pkcePair();
			const params = new URLSearchParams({
				response_type: "code",
				client_id: clientId,
				redirect_uri: REDIRECT,
				code_challenge: challenge,
				code_challenge_method: "S256",
				resource: RESOURCE,
				state: "state-1",
			});
			const consent = await first.authorize(new Request(`${ORIGIN}/oauth/authorize?${params}`), PEER);
			const html = await consent.text();
			const fields = consentFrom(html);
			clock += 45_000;
			const second = createOAuth(opened);
			const granted = await second.authorize(
				new Request(`${ORIGIN}/oauth/authorize`, {
					method: "POST",
					headers: { "content-type": "application/x-www-form-urlencoded" },
					body: form({ req: fields.requestId, nonce: fields.nonce, password }),
				}),
				"198.51.100.88",
			);
			expect(granted.status).toBe(302);
			expect(await granted.text()).not.toContain("expired");
		} finally {
			rmSync(restartDir, { recursive: true, force: true });
		}
	});
});

describe("OAuth through the router", () => {
	test("registration and token calls are limited per client IP", async () => {
		const peer = "203.0.113.50";
		const register = () =>
			handler(
				new Request(`${ORIGIN}/oauth/register`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ redirect_uris: [REDIRECT] }),
				}),
				peer,
			);
		for (let i = 0; i < 10; i += 1) expect((await register()).status).toBe(201);
		expect((await register()).status).toBe(429);

		const tokenPeer = "203.0.113.51";
		const token = () =>
			handler(
				new Request(`${ORIGIN}/oauth/token`, {
					method: "POST",
					headers: { "content-type": "application/x-www-form-urlencoded" },
					body: form({ grant_type: "unsupported" }),
				}),
				tokenPeer,
			);
		for (let i = 0; i < 60; i += 1) expect((await token()).status).toBe(400);
		expect((await token()).status).toBe(429);
	});
});

// Direct module tests: the router has no revoke route yet and these need injected clocks and schedulers.
const HARNESS_SECRET = randomBytes(32).toString("hex");
const HARNESS_START = 1_800_000_000_000;
const HOUR_MS = 60 * 60 * 1000;
const PENDING_TTL_MS = 10 * 60 * 1000;

interface Timer {
	run: () => void;
	intervalMs: number;
	cancelled: boolean;
}

interface Harness {
	oauth: OAuth;
	dir: string;
	clock: { now: number };
	timers: Timer[];
	statePath: string;
}

interface Granted {
	access: string;
	refresh: string;
	body: Record<string, unknown>;
}

let ownerHash: string | undefined;
const harnessDirs: string[] = [];

async function makeHarness(options: Partial<OAuthOptions> = {}, from?: { dir: string; clock: { now: number } }): Promise<Harness> {
	ownerHash ??= await Bun.password.hash(password);
	let dir = from?.dir;
	if (dir === undefined) {
		dir = mkdtempSync(join(tmpdir(), "ultrathink-oauth-h-"));
		harnessDirs.push(dir);
	}
	const clock = from?.clock ?? { now: HARNESS_START };
	const timers: Timer[] = [];
	const auth = createAuth({ ownerPasswordHash: ownerHash, sessionSecret: HARNESS_SECRET, cookieSecure: true, now: () => clock.now });
	const oauth = createOAuth({
		origin: ORIGIN,
		stateDir: dir,
		auth,
		now: () => clock.now,
		schedule: (run, intervalMs) => {
			const timer: Timer = { run, intervalMs, cancelled: false };
			timers.push(timer);
			return () => {
				timer.cancelled = true;
			};
		},
		...options,
	});
	return { oauth, dir, clock, timers, statePath: join(dir, "oauth.json") };
}

function firstTimer(h: Harness): Timer {
	const timer = h.timers[0];
	if (timer === undefined) throw new Error("no sweeper was scheduled");
	return timer;
}

async function bodyOf(response: Response): Promise<Record<string, unknown>> {
	const parsed: unknown = await response.json();
	if (typeof parsed !== "object" || parsed === null) throw new Error("response is not a JSON object");
	return Object.fromEntries(Object.entries(parsed));
}

function registerCall(h: Harness, body: Record<string, unknown>, ip = freshIp()): Promise<Response> {
	return h.oauth.register(
		new Request(`${ORIGIN}/oauth/register`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(body),
		}),
		ip,
	);
}

async function registered(h: Harness, overrides: Record<string, unknown> = {}): Promise<string> {
	const response = await registerCall(h, { client_name: "Test client", redirect_uris: [REDIRECT], ...overrides });
	expect(response.status).toBe(201);
	const id = (await bodyOf(response)).client_id;
	if (typeof id !== "string") throw new Error("registration has no client id");
	return id;
}

function authorizeCall(h: Harness, clientId: string, challenge: string, overrides: Record<string, string> = {}, ip = freshIp()): Promise<Response> {
	const params = new URLSearchParams({
		response_type: "code",
		client_id: clientId,
		redirect_uri: REDIRECT,
		code_challenge: challenge,
		code_challenge_method: "S256",
		resource: RESOURCE,
		state: "state-1",
		...overrides,
	});
	return h.oauth.authorize(new Request(`${ORIGIN}/oauth/authorize?${params.toString()}`), ip);
}

function approveWith(h: Harness, html: string, owner: string, ip = freshIp()): Promise<Response> {
	const { requestId, nonce } = consentFrom(html);
	return h.oauth.authorize(
		new Request(`${ORIGIN}/oauth/authorize`, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: form({ req: requestId, nonce, password: owner }),
		}),
		ip,
	);
}

function tokenCall(h: Harness, fields: Record<string, string>, ip = freshIp()): Promise<Response> {
	return h.oauth.token(
		new Request(`${ORIGIN}/oauth/token`, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: form(fields),
		}),
		ip,
	);
}

function revokeCall(h: Harness, fields: Record<string, string>, ip = freshIp()): Promise<Response> {
	return h.oauth.revoke(
		new Request(`${ORIGIN}/oauth/revoke`, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: form(fields),
		}),
		ip,
	);
}

async function authorizedCode(h: Harness, clientId: string, options: { redirect?: string; scope?: string } = {}): Promise<{ code: string; verifier: string; redirect: string }> {
	const { verifier, challenge } = pkcePair();
	const redirect = options.redirect ?? REDIRECT;
	const overrides: Record<string, string> = { redirect_uri: redirect };
	if (options.scope !== undefined) overrides.scope = options.scope;
	const consent = await authorizeCall(h, clientId, challenge, overrides);
	expect(consent.status).toBe(200);
	const approved = await approveWith(h, await consent.text(), password);
	return { code: codeFrom(approved), verifier, redirect };
}

async function grant(h: Harness, clientId: string, options: { redirect?: string; scope?: string } = {}): Promise<Granted> {
	const { code, verifier, redirect } = await authorizedCode(h, clientId, options);
	const response = await tokenCall(h, { grant_type: "authorization_code", code, code_verifier: verifier, client_id: clientId, redirect_uri: redirect, resource: RESOURCE });
	expect(response.status).toBe(200);
	const body = await bodyOf(response);
	const { access_token: access, refresh_token: refresh } = body;
	if (typeof access !== "string" || typeof refresh !== "string") throw new Error("token response has no tokens");
	return { access, refresh, body };
}

function formAction(response: Response): string {
	const policy = response.headers.get("content-security-policy") ?? "";
	const action = /form-action ([^;]+)/.exec(policy)?.[1];
	if (action === undefined) throw new Error("no form-action directive");
	return action;
}

function savedKeys(h: Harness, section: "clients" | "grants" | "tokens" | "pending"): string[] {
	const saved = JSON.parse(readFileSync(h.statePath, "utf8")) as Record<string, unknown>;
	if (!(section in saved)) throw new Error(`state file has no ${section}`);
	const value = saved[section];
	if (typeof value !== "object" || value === null) throw new Error(`state file ${section} is malformed`);
	return Object.keys(value);
}

afterAll(() => {
	for (const dir of harnessDirs) rmSync(dir, { recursive: true, force: true });
});

describe("OAuth redirect allowlist", () => {
	test("registers every default https origin", async () => {
		const h = await makeHarness();
		for (const allowed of DEFAULT_REDIRECT_ORIGINS) {
			const response = await registerCall(h, { redirect_uris: [`${allowed}/oauth/callback`] });
			expect(response.status).toBe(201);
		}
	});

	test("refuses an https origin that is not on the list", async () => {
		const h = await makeHarness();
		const response = await registerCall(h, { redirect_uris: ["https://grok.example/callback"] });
		expect(response.status).toBe(400);
		expect((await bodyOf(response)).error).toBe("invalid_redirect_uri");
		const mixed = await registerCall(h, { redirect_uris: [REDIRECT, "https://evil.test/cb"] });
		expect(mixed.status).toBe(400);
	});

	test("refuses embedded credentials and fragments", async () => {
		const h = await makeHarness();
		expect((await registerCall(h, { redirect_uris: ["https://claude.ai@evil.test/cb"] })).status).toBe(400);
		expect((await registerCall(h, { redirect_uris: ["https://user:pw@claude.ai/cb"] })).status).toBe(400);
		expect((await registerCall(h, { redirect_uris: [`${REDIRECT}#frag`] })).status).toBe(400);
	});

	test("the list is configurable and replaces the default", async () => {
		const h = await makeHarness({ redirectOrigins: ["https://custom.example"] });
		expect((await registerCall(h, { redirect_uris: ["https://custom.example/cb"] })).status).toBe(201);
		expect((await registerCall(h, { redirect_uris: [REDIRECT] })).status).toBe(400);
	});

	test("loopback http is accepted with any port", async () => {
		const h = await makeHarness();
		for (const uri of ["http://127.0.0.1:53211/cb", "http://localhost:1/x", "http://[::1]:8080/cb", "http://127.0.0.1/cb"]) {
			expect((await registerCall(h, { redirect_uris: [uri] })).status).toBe(201);
		}
		expect((await registerCall(h, { redirect_uris: ["http://192.168.1.5:8080/cb"] })).status).toBe(400);
	});

	test("a loopback client may authorize on another port but not another path", async () => {
		const h = await makeHarness();
		const clientId = await registered(h, { redirect_uris: ["http://127.0.0.1:50000/cb"] });
		const { challenge } = pkcePair();
		const moved = await authorizeCall(h, clientId, challenge, { redirect_uri: "http://127.0.0.1:61234/cb" });
		expect(moved.status).toBe(200);
		expect(formAction(moved)).toBe("'self' http://127.0.0.1:61234");
		const other = await authorizeCall(h, clientId, challenge, { redirect_uri: "http://127.0.0.1:61234/other" });
		expect(other.status).toBe(400);
		const tokens = await grant(h, clientId, { redirect: "http://127.0.0.1:61234/cb" });
		expect(tokens.access).not.toBe("");
	});

	test("a non-loopback redirect must match the registration exactly", async () => {
		const h = await makeHarness();
		const clientId = await registered(h);
		const { challenge } = pkcePair();
		const response = await authorizeCall(h, clientId, challenge, { redirect_uri: "https://claude.ai/other" });
		expect(response.status).toBe(400);
		expect(response.headers.get("location")).toBeNull();
	});

	test("duplicate redirect URIs are collapsed", async () => {
		const h = await makeHarness();
		const response = await registerCall(h, { redirect_uris: [REDIRECT, REDIRECT, "https://claude.ai/other"] });
		expect(response.status).toBe(201);
		expect((await bodyOf(response)).redirect_uris).toEqual([REDIRECT, "https://claude.ai/other"]);
	});

	test("registration echoes the registered grant types", async () => {
		const h = await makeHarness();
		const both = await registerCall(h, { redirect_uris: [REDIRECT], grant_types: ["authorization_code", "refresh_token", "refresh_token"] });
		expect((await bodyOf(both)).grant_types).toEqual(["authorization_code", "refresh_token"]);
		const plain = await registerCall(h, { redirect_uris: [REDIRECT] });
		expect((await bodyOf(plain)).grant_types).toEqual(["authorization_code"]);
		const bad = await registerCall(h, { redirect_uris: [REDIRECT], grant_types: ["password"] });
		expect(bad.status).toBe(400);
	});
});

describe("OAuth per-IP rate limits", () => {
	test("registration allows 10 an hour per IP and recovers after the window", async () => {
		const h = await makeHarness();
		const ip = "203.0.113.9";
		for (let i = 0; i < 10; i += 1) expect((await registerCall(h, { redirect_uris: [REDIRECT] }, ip)).status).toBe(201);
		const limited = await registerCall(h, { redirect_uris: [REDIRECT] }, ip);
		expect(limited.status).toBe(429);
		expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
		expect((await registerCall(h, { redirect_uris: [REDIRECT] })).status).toBe(201);
		h.clock.now += HOUR_MS + 1;
		expect((await registerCall(h, { redirect_uris: [REDIRECT] }, ip)).status).toBe(201);
	});

	test("authorize allows 30 a minute per IP and recovers after the window", async () => {
		const h = await makeHarness();
		const clientId = await registered(h);
		const { challenge } = pkcePair();
		const ip = "203.0.113.10";
		// response_type=token redirects with an error, so no pending request builds up.
		const probe = (address: string) => authorizeCall(h, clientId, challenge, { response_type: "token" }, address);
		for (let i = 0; i < 30; i += 1) expect((await probe(ip)).status).toBe(302);
		const limited = await probe(ip);
		expect(limited.status).toBe(429);
		expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
		expect((await probe(freshIp())).status).toBe(302);
		h.clock.now += 61_000;
		expect((await probe(ip)).status).toBe(302);
	});

	test("token allows 60 a minute per IP and recovers after the window", async () => {
		const h = await makeHarness();
		const ip = "203.0.113.11";
		for (let i = 0; i < 60; i += 1) expect((await tokenCall(h, { grant_type: "unsupported" }, ip)).status).toBe(400);
		const limited = await tokenCall(h, { grant_type: "unsupported" }, ip);
		expect(limited.status).toBe(429);
		expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
		expect((await tokenCall(h, { grant_type: "unsupported" })).status).toBe(400);
		h.clock.now += 61_000;
		expect((await tokenCall(h, { grant_type: "unsupported" }, ip)).status).toBe(400);
	});

	test("revoke allows 60 a minute per IP", async () => {
		const h = await makeHarness();
		const ip = "203.0.113.12";
		for (let i = 0; i < 60; i += 1) expect((await revokeCall(h, { token: "ut_at_unknown" }, ip)).status).toBe(200);
		expect((await revokeCall(h, { token: "ut_at_unknown" }, ip)).status).toBe(429);
		expect((await revokeCall(h, { token: "ut_at_unknown" })).status).toBe(200);
		h.clock.now += 61_000;
		expect((await revokeCall(h, { token: "ut_at_unknown" }, ip)).status).toBe(200);
	});
});

describe("OAuth client table", () => {
	test("a full table evicts the oldest client that never received a grant", async () => {
		const h = await makeHarness({ maxClients: 2 });
		const first = await registered(h);
		h.clock.now += 1000;
		const second = await registered(h);
		h.clock.now += 1000;
		const third = await registered(h);
		const { challenge } = pkcePair();
		expect((await authorizeCall(h, first, challenge)).status).toBe(400);
		expect((await authorizeCall(h, second, challenge)).status).toBe(200);
		expect((await authorizeCall(h, third, challenge)).status).toBe(200);
	});

	test("a client with a grant is never evicted", async () => {
		const h = await makeHarness({ maxClients: 2 });
		const granted = await registered(h);
		const tokens = await grant(h, granted);
		h.clock.now += 1000;
		const spare = await registered(h);
		h.clock.now += 1000;
		const newest = await registered(h);
		const { challenge } = pkcePair();
		expect((await authorizeCall(h, spare, challenge)).status).toBe(400);
		expect((await authorizeCall(h, granted, challenge)).status).toBe(200);
		expect((await authorizeCall(h, newest, challenge)).status).toBe(200);
		const refreshed = await tokenCall(h, { grant_type: "refresh_token", refresh_token: tokens.refresh, client_id: granted });
		expect(refreshed.status).toBe(200);
	});

	test("a client whose owner approval is being checked is not evicted; another ungranted client is", async () => {
		const entered = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		const real = createAuth({ ownerPasswordHash: ownerHash ?? (ownerHash = await Bun.password.hash(password)), sessionSecret: HARNESS_SECRET, cookieSecure: true });
		const auth = {
			...real,
			login: async (input: { password: string; clientIp: string }) => {
				entered.resolve();
				await gate.promise;
				return real.login(input);
			},
		};
		const h = await makeHarness({ maxClients: 2, auth });
		const approving = await registered(h);
		h.clock.now += 1000;
		const bystander = await registered(h);
		const { verifier, challenge } = pkcePair();
		const consent = await authorizeCall(h, approving, challenge);
		expect(consent.status).toBe(200);
		const approval = approveWith(h, await consent.text(), password);
		await entered.promise;

		// The approving client is the oldest never-granted one, so without protection it would be the victim.
		h.clock.now += 1000;
		const newest = await registered(h);
		gate.resolve();
		const approved = await approval;
		const code = codeFrom(approved);
		const redeemed = await tokenCall(h, { grant_type: "authorization_code", code, code_verifier: verifier, client_id: approving, redirect_uri: REDIRECT, resource: RESOURCE });
		expect(redeemed.status).toBe(200);

		const other = pkcePair().challenge;
		expect((await authorizeCall(h, bystander, other)).status).toBe(400);
		expect((await authorizeCall(h, newest, other)).status).toBe(200);
	});

	test("registration reports unavailable while the only ungranted client is being approved", async () => {
		const entered = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<void>();
		const real = createAuth({ ownerPasswordHash: ownerHash ?? (ownerHash = await Bun.password.hash(password)), sessionSecret: HARNESS_SECRET, cookieSecure: true });
		const auth = {
			...real,
			login: async (input: { password: string; clientIp: string }) => {
				entered.resolve();
				await gate.promise;
				return real.login(input);
			},
		};
		const h = await makeHarness({ maxClients: 1, auth });
		const clientId = await registered(h);
		const { verifier, challenge } = pkcePair();
		const consent = await authorizeCall(h, clientId, challenge);
		const approval = approveWith(h, await consent.text(), password);
		await entered.promise;
		expect((await registerCall(h, { redirect_uris: [REDIRECT] })).status).toBe(503);
		gate.resolve();
		const code = codeFrom(await approval);
		const redeemed = await tokenCall(h, { grant_type: "authorization_code", code, code_verifier: verifier, client_id: clientId, redirect_uri: REDIRECT, resource: RESOURCE });
		expect(redeemed.status).toBe(200);
	});

	test("registration reports unavailable only when every client holds a grant", async () => {
		const h = await makeHarness({ maxClients: 1 });
		await grant(h, await registered(h));
		const full = await registerCall(h, { redirect_uris: [REDIRECT] });
		expect(full.status).toBe(503);
		expect((await bodyOf(full)).error).toBe("temporarily_unavailable");
	});

	test("clients that never received a grant expire after 24 hours, granted ones do not", async () => {
		const h = await makeHarness();
		const idle = await registered(h);
		const used = await registered(h);
		await grant(h, used);
		h.clock.now += 25 * HOUR_MS;
		const { challenge } = pkcePair();
		expect((await authorizeCall(h, idle, challenge)).status).toBe(400);
		expect((await authorizeCall(h, used, challenge)).status).toBe(200);
		expect(savedKeys(h, "clients")).toEqual([used]);
	});

	test("grants and clients with nothing live and no recent use are pruned", async () => {
		const h = await makeHarness();
		const clientId = await registered(h);
		const tokens = await grant(h, clientId);
		h.clock.now += 31 * 24 * HOUR_MS;
		const { challenge } = pkcePair();
		expect((await authorizeCall(h, clientId, challenge)).status).toBe(400);
		const refreshed = await tokenCall(h, { grant_type: "refresh_token", refresh_token: tokens.refresh, client_id: clientId });
		expect(refreshed.status).toBe(401);
		const fresh = await registered(h);
		expect(savedKeys(h, "clients")).toEqual([fresh]);
		expect(savedKeys(h, "grants")).toEqual([]);
		expect(savedKeys(h, "tokens")).toEqual([]);
	});

	test("a client holds at most 5 pending authorizations", async () => {
		const h = await makeHarness();
		const busy = await registered(h);
		const other = await registered(h);
		const { challenge } = pkcePair();
		for (let i = 0; i < 5; i += 1) expect((await authorizeCall(h, busy, challenge)).status).toBe(200);
		expect((await authorizeCall(h, busy, challenge)).status).toBe(429);
		expect((await authorizeCall(h, other, challenge)).status).toBe(200);
		h.clock.now += PENDING_TTL_MS + 1;
		expect((await authorizeCall(h, busy, challenge)).status).toBe(200);
	});
});

describe("OAuth sweeper", () => {
	test("one shared timer serves every pending request", async () => {
		const h = await makeHarness();
		const clientId = await registered(h);
		expect(h.timers).toHaveLength(0);
		const { challenge } = pkcePair();
		for (let i = 0; i < 3; i += 1) expect((await authorizeCall(h, clientId, challenge)).status).toBe(200);
		expect(h.timers).toHaveLength(1);
		expect(firstTimer(h).intervalMs).toBeGreaterThan(0);
	});

	test("a pass writes the state only when something expired, then stops when nothing is pending", async () => {
		const h = await makeHarness();
		const clientId = await registered(h);
		const { challenge } = pkcePair();
		expect((await authorizeCall(h, clientId, challenge)).status).toBe(200);
		const timer = firstTimer(h);

		rmSync(h.statePath);
		timer.run();
		expect(existsSync(h.statePath)).toBe(false);
		expect(timer.cancelled).toBe(false);

		h.clock.now += PENDING_TTL_MS + 1;
		timer.run();
		expect(existsSync(h.statePath)).toBe(true);
		expect(timer.cancelled).toBe(true);
		expect(savedKeys(h, "pending")).toEqual([]);
	});

	test("a restart re-arms one sweeper for restored pending requests", async () => {
		const first = await makeHarness();
		const clientId = await registered(first);
		const { challenge } = pkcePair();
		expect((await authorizeCall(first, clientId, challenge)).status).toBe(200);
		const second = await makeHarness({}, first);
		expect(second.timers).toHaveLength(1);
	});
});

describe("OAuth consent page and CSP", () => {
	test("form-action allows the registered redirect origin and nothing else", async () => {
		const h = await makeHarness();
		const clientId = await registered(h);
		const { challenge } = pkcePair();
		const consent = await authorizeCall(h, clientId, challenge);
		expect(formAction(consent)).toBe("'self' https://claude.ai");

		const loopback = await registered(h, { redirect_uris: ["http://127.0.0.1:53211/cb"] });
		const local = await authorizeCall(h, loopback, challenge, { redirect_uri: "http://127.0.0.1:53211/cb" });
		expect(formAction(local)).toBe("'self' http://127.0.0.1:53211");
	});

	test("error pages allow 'self' only", async () => {
		const h = await makeHarness();
		const { challenge } = pkcePair();
		const unknown = await authorizeCall(h, "ut_client_missing", challenge);
		expect(unknown.status).toBe(400);
		expect(formAction(unknown)).toBe("'self'");
		const expired = await approveWith(h, `<input name="req" value="nope"><input name="nonce" value="nope">`, password);
		expect(expired.status).toBe(400);
		expect(formAction(expired)).toBe("'self'");
	});

	test("a wrong password keeps the redirect origin in the policy", async () => {
		const h = await makeHarness();
		const clientId = await registered(h);
		const { challenge } = pkcePair();
		const consent = await authorizeCall(h, clientId, challenge);
		const retry = await approveWith(h, await consent.text(), "not-the-password");
		expect(retry.status).toBe(200);
		expect(formAction(retry)).toBe("'self' https://claude.ai");
	});

	test("the page shows the redirect origin and marks the client name unverified", async () => {
		const h = await makeHarness();
		const clientId = await registered(h, { client_name: "Claude <script>alert(1)</script>" });
		const { challenge } = pkcePair();
		const html = await (await authorizeCall(h, clientId, challenge)).text();
		expect(html).toContain('data-redirect-origin="https://claude.ai"');
		expect(html).toContain('data-client-unverified="true"');
		expect(html).not.toContain("<script>");
	});
});

describe("OAuth resource, scope, client and issuer handling", () => {
	test("authorize accepts a trailing slash on the resource", async () => {
		const h = await makeHarness();
		const clientId = await registered(h);
		const { challenge } = pkcePair();
		expect((await authorizeCall(h, clientId, challenge, { resource: `${RESOURCE}/` })).status).toBe(200);
		const foreign = await authorizeCall(h, clientId, challenge, { resource: `${ORIGIN}/other` });
		expect(new URL(foreign.headers.get("location") ?? "").searchParams.get("error")).toBe("invalid_target");
	});

	test("resource is optional at the token endpoint and a different one is invalid_target", async () => {
		const h = await makeHarness();
		const clientId = await registered(h);
		const { code, verifier } = await authorizedCode(h, clientId);
		const base = { grant_type: "authorization_code", code, code_verifier: verifier, client_id: clientId, redirect_uri: REDIRECT };
		const wrong = await tokenCall(h, { ...base, resource: `${ORIGIN}/other` });
		expect(wrong.status).toBe(400);
		expect((await bodyOf(wrong)).error).toBe("invalid_target");
		const without = await tokenCall(h, base);
		expect(without.status).toBe(200);
		const tokens = await bodyOf(without);
		expect(typeof tokens.refresh_token).toBe("string");
	});

	test("a trailing-slash resource is accepted at the token endpoint", async () => {
		const h = await makeHarness();
		const clientId = await registered(h);
		const { code, verifier } = await authorizedCode(h, clientId);
		const response = await tokenCall(h, { grant_type: "authorization_code", code, code_verifier: verifier, client_id: clientId, redirect_uri: REDIRECT, resource: `${RESOURCE}/` });
		expect(response.status).toBe(200);
	});

	test("resource is optional on refresh, a different one is invalid_target and keeps the token usable", async () => {
		const h = await makeHarness();
		const clientId = await registered(h);
		const first = await grant(h, clientId);
		const wrong = await tokenCall(h, { grant_type: "refresh_token", refresh_token: first.refresh, client_id: clientId, resource: `${ORIGIN}/other` });
		expect(wrong.status).toBe(400);
		expect((await bodyOf(wrong)).error).toBe("invalid_target");
		const without = await tokenCall(h, { grant_type: "refresh_token", refresh_token: first.refresh, client_id: clientId });
		expect(without.status).toBe(200);
		const next = await bodyOf(without);
		const withResource = await tokenCall(h, { grant_type: "refresh_token", refresh_token: String(next.refresh_token), client_id: clientId, resource: RESOURCE });
		expect(withResource.status).toBe(200);
	});

	test("an unknown client_id at the token endpoint is 401 invalid_client", async () => {
		const h = await makeHarness();
		const cases: Record<string, string>[] = [
			{ grant_type: "authorization_code", code: "ut_code_x", client_id: "ut_client_gone", redirect_uri: REDIRECT },
			{ grant_type: "refresh_token", refresh_token: "ut_rt_x", client_id: "ut_client_gone" },
			{ grant_type: "refresh_token", refresh_token: "ut_rt_x" },
		];
		for (const fields of cases) {
			const response = await tokenCall(h, fields);
			expect(response.status).toBe(401);
			expect((await bodyOf(response)).error).toBe("invalid_client");
			expect(response.headers.get("www-authenticate")).not.toBeNull();
		}
	});

	test("a known client with a bad code stays invalid_grant", async () => {
		const h = await makeHarness();
		const clientId = await registered(h);
		const response = await tokenCall(h, { grant_type: "authorization_code", code: "ut_code_x", client_id: clientId, redirect_uri: REDIRECT });
		expect(response.status).toBe(400);
		expect((await bodyOf(response)).error).toBe("invalid_grant");
	});

	test("authorization redirects carry the issuer", async () => {
		const h = await makeHarness();
		const clientId = await registered(h);
		const { challenge } = pkcePair();
		const failure = await authorizeCall(h, clientId, challenge, { response_type: "token" });
		expect(new URL(failure.headers.get("location") ?? "").searchParams.get("iss")).toBe(ORIGIN);
		const consent = await authorizeCall(h, clientId, challenge);
		const approved = await approveWith(h, await consent.text(), password);
		const location = new URL(approved.headers.get("location") ?? "");
		expect(location.searchParams.get("iss")).toBe(ORIGIN);
		expect(location.searchParams.get("state")).toBe("state-1");
		expect(location.searchParams.get("code")).not.toBeNull();
	});

	test("any requested scope is accepted and echoed on issue and refresh", async () => {
		const h = await makeHarness();
		const clientId = await registered(h);
		const first = await grant(h, clientId, { scope: "claudeai" });
		expect(first.body.scope).toBe("claudeai");
		const refreshed = await tokenCall(h, { grant_type: "refresh_token", refresh_token: first.refresh, client_id: clientId });
		expect((await bodyOf(refreshed)).scope).toBe("claudeai");
		const several = await grant(h, clientId, { scope: "mcp something:else" });
		expect(several.body.scope).toBe("mcp something:else");
	});

	test("no scope means no scope in the response, and a malformed one is ignored", async () => {
		const h = await makeHarness();
		const clientId = await registered(h);
		expect("scope" in (await grant(h, clientId)).body).toBe(false);
		expect("scope" in (await grant(h, clientId, { scope: "bad\u0001scope" })).body).toBe(false);
	});

	test("metadata advertises issuer response, revocation and scopes", async () => {
		const h = await makeHarness();
		const metadata = await bodyOf(h.oauth.authorizationServerMetadata());
		expect(metadata.authorization_response_iss_parameter_supported).toBe(true);
		expect(metadata.revocation_endpoint).toBe(`${ORIGIN}/oauth/revoke`);
		expect(metadata.scopes_supported).toEqual(["mcp"]);
		expect(metadata.issuer).toBe(ORIGIN);
	});
});

describe("OAuth revocation and bearer classification", () => {
	test("revoking an access token ends the grant", async () => {
		const h = await makeHarness();
		const clientId = await registered(h);
		const tokens = await grant(h, clientId);
		expect(h.oauth.classifyBearer(tokens.access)).toBe("valid");
		const response = await revokeCall(h, { token: tokens.access, token_type_hint: "access_token" });
		expect(response.status).toBe(200);
		expect(h.oauth.verifyAccessToken(tokens.access)).toBe(false);
		expect(h.oauth.classifyBearer(tokens.access)).toBe("invalid");
		const refreshed = await tokenCall(h, { grant_type: "refresh_token", refresh_token: tokens.refresh, client_id: clientId });
		expect(refreshed.status).toBe(400);
	});

	test("revoking a refresh token ends the access token too", async () => {
		const h = await makeHarness();
		const clientId = await registered(h);
		const tokens = await grant(h, clientId);
		expect((await revokeCall(h, { token: tokens.refresh, client_id: clientId })).status).toBe(200);
		expect(h.oauth.verifyAccessToken(tokens.access)).toBe(false);
		const refreshed = await tokenCall(h, { grant_type: "refresh_token", refresh_token: tokens.refresh, client_id: clientId });
		expect(refreshed.status).toBe(400);
	});

	test("an unknown token still answers 200 and changes nothing", async () => {
		const h = await makeHarness();
		const clientId = await registered(h);
		const tokens = await grant(h, clientId);
		expect((await revokeCall(h, { token: "ut_at_does-not-exist" })).status).toBe(200);
		expect(h.oauth.classifyBearer(tokens.access)).toBe("valid");
	});

	test("a client that names itself must own the token", async () => {
		const h = await makeHarness();
		const owner = await registered(h);
		const stranger = await registered(h);
		const tokens = await grant(h, owner);
		expect((await revokeCall(h, { token: tokens.access, client_id: stranger })).status).toBe(200);
		expect(h.oauth.classifyBearer(tokens.access)).toBe("valid");
	});

	test("a call without a token is a bad request", async () => {
		const h = await makeHarness();
		expect((await revokeCall(h, { token_type_hint: "access_token" })).status).toBe(400);
	});

	test("classifyBearer separates valid, invalid and absent", async () => {
		const h = await makeHarness();
		const tokens = await grant(h, await registered(h));
		expect(h.oauth.classifyBearer(tokens.access)).toBe("valid");
		expect(h.oauth.classifyBearer("ut_at_not-a-real-token")).toBe("invalid");
		expect(h.oauth.classifyBearer(tokens.refresh)).toBe("invalid");
		expect(h.oauth.classifyBearer(null)).toBe("absent");
		expect(h.oauth.classifyBearer("")).toBe("absent");
		h.clock.now += ACCESS_TTL_MS + 1;
		expect(h.oauth.classifyBearer(tokens.access)).toBe("invalid");
	});
});

describe("OAuth state file", () => {
	test("is written 0600 with no temp file left behind", async () => {
		const h = await makeHarness();
		await registered(h);
		expect(statSync(h.statePath).mode & 0o777).toBe(0o600);
		expect(readdirSync(h.dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
	});

	test("loading tightens a loose file mode", async () => {
		const first = await makeHarness();
		await registered(first);
		chmodSync(first.statePath, 0o644);
		await makeHarness({}, first);
		expect(statSync(first.statePath).mode & 0o777).toBe(0o600);
	});

	test("registered clients survive a restart", async () => {
		const first = await makeHarness();
		const clientId = await registered(first);
		const second = await makeHarness({}, first);
		const { challenge } = pkcePair();
		expect((await authorizeCall(second, clientId, challenge)).status).toBe(200);
	});

	for (const [label, content] of [
		["garbage", "{not json"],
		["empty", ""],
		["a JSON array", "[]"],
	] as const) {
		test(`a corrupt file (${label}) is moved aside and the store starts empty`, async () => {
			const dir = mkdtempSync(join(tmpdir(), "ultrathink-oauth-corrupt-"));
			harnessDirs.push(dir);
			writeFileSync(join(dir, "oauth.json"), content);
			const h = await makeHarness({}, { dir, clock: { now: HARNESS_START } });
			const aside = `oauth.json.corrupt-${HARNESS_START}`;
			expect(readdirSync(dir)).toContain(aside);
			expect(readFileSync(join(dir, aside), "utf8")).toBe(content);
			expect(existsSync(h.statePath)).toBe(false);
			await registered(h);
			expect(savedKeys(h, "clients")).toHaveLength(1);
		});
	}
});

describe("durable state writes", () => {
	function recordingFs(ops: string[]): DurableFs {
		return {
			...nodeFs,
			fsyncSync(fd) {
				ops.push("fsync");
				nodeFs.fsyncSync(fd);
			},
			renameSync(from, to) {
				ops.push("rename");
				nodeFs.renameSync(from, to);
			},
		};
	}

	test("syncs the file, renames it, then syncs the directory", () => {
		const dir = mkdtempSync(join(tmpdir(), "ultrathink-oauth-durable-"));
		harnessDirs.push(dir);
		const ops: string[] = [];
		const path = join(dir, "state.json");
		writeFileDurably(dir, path, '{"a":1}', recordingFs(ops));
		expect(ops).toEqual(["fsync", "rename", "fsync"]);
		expect(readFileSync(path, "utf8")).toBe('{"a":1}');
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(readdirSync(dir)).toEqual(["state.json"]);
	});

	test("a failed sync leaves the old file and removes the temp file", () => {
		const dir = mkdtempSync(join(tmpdir(), "ultrathink-oauth-durable-"));
		harnessDirs.push(dir);
		const path = join(dir, "state.json");
		writeFileSync(path, "old");
		const failing: DurableFs = {
			...nodeFs,
			fsyncSync() {
				throw new Error("disk full");
			},
		};
		expect(() => writeFileDurably(dir, path, "new", failing)).toThrow("disk full");
		expect(readFileSync(path, "utf8")).toBe("old");
		expect(readdirSync(dir)).toEqual(["state.json"]);
	});
});
