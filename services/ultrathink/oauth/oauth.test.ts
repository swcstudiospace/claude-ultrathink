// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAuth } from "../auth/auth.ts";
import type { UltrathinkConfig } from "../config/config.ts";
import { openStore, type Store } from "../store/store.ts";
import { createHandler } from "../routes/router.ts";

const ORIGIN = "https://ultrathink.test";
const RESOURCE = `${ORIGIN}/mcp`;
const REDIRECT = "https://grok.example/callback";
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
		PEER,
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
	return handler(new Request(`${ORIGIN}/oauth/authorize?${params.toString()}`, { method: "GET" }), PEER);
}

function requestIdFrom(html: string): string {
	const match = /name="req" value="([^"]+)"/.exec(html);
	if (!match?.[1]) throw new Error("consent form has no request id");
	return match[1];
}

let loginSeq = 0;

// The owner login allows 5 attempts per IP per window, so each approval gets its own peer.
async function approve(requestId: string, owner: string): Promise<Response> {
	loginSeq += 1;
	return handler(
		new Request(`${ORIGIN}/oauth/authorize`, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: form({ req: requestId, password: owner }),
		}),
		`10.0.${Math.floor(loginSeq / 250)}.${(loginSeq % 250) + 1}`,
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
		PEER,
	);
}

async function issueTokens(clientId: string): Promise<{ access_token: string; refresh_token: string; code: string; verifier: string }> {
	const { verifier, challenge } = pkcePair();
	const consent = await startAuthorize(clientId, challenge);
	expect(consent.status).toBe(200);
	const granted = await approve(requestIdFrom(await consent.text()), password);
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
		const retry = await approve(requestIdFrom(await consent.text()), "not-the-password");
		expect(retry.status).toBe(200);
		expect(retry.headers.get("location")).toBeNull();
		expect(await retry.text()).toContain("Incorrect password.");
	});

	test("a wrong PKCE verifier is refused and the code stays usable", async () => {
		const clientId = await registerClient();
		const { verifier, challenge } = pkcePair();
		const consent = await startAuthorize(clientId, challenge);
		const code = codeFrom(await approve(requestIdFrom(await consent.text()), password));
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
		const code = codeFrom(await approve(requestIdFrom(await consent.text()), password));
		const other = await exchange({
			grant_type: "authorization_code",
			code,
			code_verifier: verifier,
			client_id: clientId,
			redirect_uri: REDIRECT,
			resource: `${ORIGIN}/other`,
		});
		expect(other.status).toBe(400);
		expect(((await other.json()) as { error: string }).error).toBe("invalid_grant");
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
		const code = codeFrom(await approve(requestIdFrom(await consent.text()), password));
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
});
