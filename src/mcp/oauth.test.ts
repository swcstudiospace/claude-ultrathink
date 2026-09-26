// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	beginLogin,
	completeLogin,
	recoverUnauthorized,
	resolveAuthHeader,
	setApiKey,
	status,
} from "./oauth.ts";
import { readStore, withStoreLock, writeStore } from "./store.ts";
import type { OAuthClient } from "./store.ts";

const NOW = 1_700_000_000_000;
const REDIRECT = "http://127.0.0.1:8765/callback";

let dir: string;
let path: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ut-mcp-"));
	path = join(dir, "creds.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

interface Call {
	url: string;
	body?: string;
}

function fakeFetch(routes: Record<string, (body: string | undefined) => Response>): {
	fetch: typeof fetch;
	calls: Call[];
} {
	const calls: Call[] = [];
	const impl = async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		const body = typeof init?.body === "string" ? init.body : undefined;
		calls.push({ url, body });
		const route = routes[url];
		return route ? route(body) : new Response("nf", { status: 404 });
	};
	return { fetch: impl as typeof fetch, calls };
}

const json = (value: unknown, status = 200) => Response.json(value, { status });

const notionRoutes = (token: (body: string | undefined) => Response = () => json({})) => ({
	"https://mcp.notion.com/.well-known/oauth-protected-resource/mcp": () =>
		json({ resource: "https://mcp.notion.com/mcp", authorization_servers: ["https://mcp.notion.com"] }),
	"https://mcp.notion.com/.well-known/oauth-authorization-server": () =>
		json({
			issuer: "https://mcp.notion.com",
			authorization_endpoint: "https://mcp.notion.com/authorize",
			token_endpoint: "https://mcp.notion.com/token",
			registration_endpoint: "https://mcp.notion.com/register",
		}),
	"https://mcp.notion.com/register": () => json({ client_id: "cid-1" }, 201),
	"https://mcp.notion.com/token": token,
});

const client: OAuthClient = {
	clientId: "cid-1",
	redirectUri: REDIRECT,
	issuer: "https://mcp.notion.com",
	authorizationEndpoint: "https://mcp.notion.com/authorize",
	tokenEndpoint: "https://mcp.notion.com/token",
	registeredAt: NOW,
};

function seedOAuth(expiresAt: number, refreshToken = "rt-old") {
	writeStore(path, {
		version: 1,
		providers: {
			notion: { kind: "oauth", client, tokens: { accessToken: "at-old", refreshToken, expiresAt }, updatedAt: NOW },
		},
	});
}

describe("store", () => {
	test("round trip, 0600 mode, corrupt reads empty", () => {
		const store = { version: 1 as const, providers: { linear: { kind: "api_key" as const, apiKey: "k", updatedAt: 1 } } };
		writeStore(path, store);
		expect(readStore(path)).toEqual(store);
		expect(statSync(path).mode & 0o777).toBe(0o600);
		writeFileSync(path, "{not json");
		expect(readStore(path)).toEqual({ version: 1, providers: {} });
		expect(readStore(join(dir, "missing.json"))).toEqual({ version: 1, providers: {} });
	});

	test("lock serializes concurrent callers", async () => {
		const events: string[] = [];
		const gate = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		const a = withStoreLock(path, async () => {
			events.push("a-start");
			entered.resolve();
			await gate.promise;
			events.push("a-end");
		}, { pollMs: 1 });
		await entered.promise;
		const b = withStoreLock(path, async () => {
			events.push("b-start");
		}, { pollMs: 1 });
		events.push("released");
		gate.resolve();
		await Promise.all([a, b]);
		expect(events).toEqual(["a-start", "released", "a-end", "b-start"]);
	});

	test("stale lock dir is removed", async () => {
		mkdirSync(`${path}.lock`);
		const old = new Date(Date.now() - 120_000);
		utimesSync(`${path}.lock`, old, old);
		expect(await withStoreLock(path, async () => 42, { waitMs: 200, pollMs: 5 })).toBe(42);
	});

	// Lock staleness is judged from real filesystem mtimes, so these lock tests need genuine (short) delays.
	test("a broken stale lock is never released by its previous holder", async () => {
		const lock = `${path}.lock`;
		const events: string[] = [];
		const a = withStoreLock(
			path,
			async () => {
				events.push("a-start");
				await Bun.sleep(400);
				events.push("a-end");
			},
			{ staleMs: 60_000, pollMs: 5 },
		);
		await Bun.sleep(5);
		const { promise: aDone, resolve: markADone } = Promise.withResolvers<void>();
		const b = withStoreLock(
			path,
			async () => {
				events.push("b-start");
				await aDone;
				await Bun.sleep(5);
				events.push(statSync(lock, { throwIfNoEntry: false }) ? "lock-held" : "lock-lost");
			},
			{ staleMs: 100, pollMs: 5, waitMs: 5_000 },
		);
		await a;
		markADone();
		await b;
		expect(events).toEqual(["a-start", "b-start", "a-end", "lock-held"]);
		expect(statSync(lock, { throwIfNoEntry: false })).toBeUndefined();
	});

	test("heartbeat keeps a long-running holder from being judged stale", async () => {
		const events: string[] = [];
		const opts = { staleMs: 150, pollMs: 10, waitMs: 5_000 };
		const a = withStoreLock(
			path,
			async () => {
				events.push("a-start");
				await Bun.sleep(400);
				events.push("a-end");
			},
			opts,
		);
		await Bun.sleep(5);
		const b = withStoreLock(path, async () => void events.push("b-start"), opts);
		await Promise.all([a, b]);
		expect(events).toEqual(["a-start", "a-end", "b-start"]);
	});
});

describe("login", () => {
	test("beginLogin builds S256 URL and reuses the registered client", async () => {
		const fake = fakeFetch(notionRoutes());
		const deps = { fetch: fake.fetch, now: () => NOW, storePath: path, redirectUri: REDIRECT };
		const pending = await beginLogin("notion", deps);
		const url = new URL(pending.url);
		expect(url.origin + url.pathname).toBe("https://mcp.notion.com/authorize");
		expect(url.searchParams.get("code_challenge_method")).toBe("S256");
		expect(url.searchParams.get("code_challenge")).toBe(
			createHash("sha256").update(pending.verifier).digest("base64url"),
		);
		expect(url.searchParams.get("state")).toBe(pending.state);
		expect(url.searchParams.get("resource")).toBe("https://mcp.notion.com/mcp");
		expect(url.searchParams.get("redirect_uri")).toBe(REDIRECT);
		expect(url.searchParams.get("client_id")).toBe("cid-1");
		expect(url.searchParams.get("scope")).toBe("default");

		const second = await beginLogin("notion", deps);
		expect(second.client.clientId).toBe("cid-1");
		expect(fake.calls.filter(c => c.url.endsWith("/register"))).toHaveLength(1);
	});

	test("completeLogin exchanges with verifier + resource and persists tokens", async () => {
		const fake = fakeFetch(
			notionRoutes(() => json({ access_token: "at-1", refresh_token: "rt-1", expires_in: 3600 })),
		);
		const deps = { fetch: fake.fetch, now: () => NOW, storePath: path };
		const pending = await beginLogin("notion", { ...deps, redirectUri: REDIRECT });
		await completeLogin(pending, `${REDIRECT}?code=abc&state=${pending.state}`, deps);
		const body = new URLSearchParams(fake.calls.at(-1)?.body);
		expect(body.get("grant_type")).toBe("authorization_code");
		expect(body.get("code_verifier")).toBe(pending.verifier);
		expect(body.get("resource")).toBe("https://mcp.notion.com/mcp");
		expect(body.get("code")).toBe("abc");
		const cred = readStore(path).providers.notion;
		expect(cred?.kind === "oauth" && cred.tokens).toEqual({
			accessToken: "at-1",
			refreshToken: "rt-1",
			expiresAt: NOW + 3_600_000,
			scope: undefined,
		});
	});

	test("state mismatch rejects without persisting tokens", async () => {
		const fake = fakeFetch(notionRoutes(() => json({ access_token: "at-1" })));
		const deps = { fetch: fake.fetch, now: () => NOW, storePath: path };
		const pending = await beginLogin("notion", { ...deps, redirectUri: REDIRECT });
		await expect(completeLogin(pending, "code=abc&state=evil", deps)).rejects.toThrow("state mismatch");
		const cred = readStore(path).providers.notion;
		expect(cred?.kind === "oauth" && cred.tokens).toBeUndefined();
		expect(fake.calls.some(c => c.url.endsWith("/token"))).toBe(false);
	});

	test("callback without state is rejected before any token request; bare code accepted", async () => {
		const fake = fakeFetch(notionRoutes(() => json({ access_token: "at-1", refresh_token: "rt-1" })));
		const deps = { fetch: fake.fetch, now: () => NOW, storePath: path };
		const pending = await beginLogin("notion", { ...deps, redirectUri: REDIRECT });
		await expect(completeLogin(pending, "?code=X", deps)).rejects.toThrow("state mismatch");
		await expect(completeLogin(pending, `${REDIRECT}?code=X`, deps)).rejects.toThrow("state mismatch");
		expect(fake.calls.some(c => c.url.endsWith("/token"))).toBe(false);
		await completeLogin(pending, "X", deps);
		expect(new URLSearchParams(fake.calls.at(-1)?.body).get("code")).toBe("X");
		expect(await resolveAuthHeader("notion", deps)).toBe("Bearer at-1");
	});

	test("beginLogin keeps an existing api key or live tokens usable", async () => {
		const linearRoutes = {
			"https://mcp.linear.app/.well-known/oauth-protected-resource/mcp": () =>
				json({ authorization_servers: ["https://mcp.linear.app"] }),
			"https://mcp.linear.app/.well-known/oauth-authorization-server": () =>
				json({
					authorization_endpoint: "https://mcp.linear.app/authorize",
					token_endpoint: "https://mcp.linear.app/token",
					registration_endpoint: "https://mcp.linear.app/register",
				}),
			"https://mcp.linear.app/register": () => json({ client_id: "lin-cid" }, 201),
		};
		const fake = fakeFetch({ ...notionRoutes(), ...linearRoutes });
		const deps = { fetch: fake.fetch, now: () => NOW, storePath: path };
		await setApiKey("linear", "lin_api_x", deps);
		const pending = await beginLogin("linear", { ...deps, redirectUri: REDIRECT });
		expect(pending.client.clientId).toBe("lin-cid");
		expect(await resolveAuthHeader("linear", deps)).toBe("Bearer lin_api_x");

		seedOAuth(NOW + 3_600_000);
		await beginLogin("notion", { ...deps, redirectUri: "http://127.0.0.1:9999/other" });
		expect(await resolveAuthHeader("notion", deps)).toBe("Bearer at-old");
	});

	test("token errors never leak secrets", async () => {
		const fake = fakeFetch(
			notionRoutes(() => json({ error: "invalid_request", error_description: "code SECRETCODE bad" }, 400)),
		);
		const deps = { fetch: fake.fetch, now: () => NOW, storePath: path };
		const pending = await beginLogin("notion", { ...deps, redirectUri: REDIRECT });
		const error = await completeLogin(pending, "SECRETCODE", deps).catch((e: Error) => e);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message).toContain("HTTP 400");
		expect((error as Error).message).toContain("invalid_request");
		expect((error as Error).message).not.toContain("SECRETCODE");
		expect((error as Error).message).not.toContain(pending.verifier);
	});
});

describe("resolveAuthHeader", () => {
	test("api key", async () => {
		await setApiKey("linear", "lin_api_x", { storePath: path });
		expect(await resolveAuthHeader("linear", { storePath: path })).toBe("Bearer lin_api_x");
		expect(status({ storePath: path }).find(s => s.provider === "linear")?.detail).not.toContain("lin_api_x");
	});

	test("setApiKey rejects notion", async () => {
		await expect(setApiKey("notion", "k", { storePath: path })).rejects.toThrow();
	});

	test("fresh token needs no network", async () => {
		seedOAuth(NOW + 3_600_000);
		const fake = fakeFetch({});
		expect(await resolveAuthHeader("notion", { fetch: fake.fetch, now: () => NOW, storePath: path })).toBe(
			"Bearer at-old",
		);
		expect(fake.calls).toHaveLength(0);
	});

	test("expiring token is refreshed and rotated refresh token persisted", async () => {
		seedOAuth(NOW + 10_000);
		const fake = fakeFetch({
			"https://mcp.notion.com/token": () => json({ access_token: "at-new", refresh_token: "rt-new", expires_in: 28_800 }),
		});
		expect(await resolveAuthHeader("notion", { fetch: fake.fetch, now: () => NOW, storePath: path })).toBe(
			"Bearer at-new",
		);
		const body = new URLSearchParams(fake.calls[0]?.body);
		expect(body.get("refresh_token")).toBe("rt-old");
		expect(body.get("resource")).toBe("https://mcp.notion.com/mcp");
		const cred = readStore(path).providers.notion;
		expect(cred?.kind === "oauth" && cred.tokens?.refreshToken).toBe("rt-new");
	});

	test("concurrent callers perform exactly one refresh", async () => {
		seedOAuth(NOW + 10_000);
		const fake = fakeFetch({
			"https://mcp.notion.com/token": () => json({ access_token: "at-new", refresh_token: "rt-new", expires_in: 28_800 }),
		});
		const deps = { fetch: fake.fetch, now: () => NOW, storePath: path };
		const results = await Promise.all([resolveAuthHeader("notion", deps), resolveAuthHeader("notion", deps)]);
		expect(results).toEqual(["Bearer at-new", "Bearer at-new"]);
		expect(fake.calls).toHaveLength(1);
	});

	test("refresh slower than staleMs still happens exactly once (heartbeat)", async () => {
		seedOAuth(NOW + 10_000);
		let tokenCalls = 0;
		// Real time on purpose: the lock's staleness compares Date.now() with the lock directory's filesystem
		// mtime, which fake timers cannot advance. The refresh outlasts staleMs, so only the heartbeat
		// (every staleMs / 3) stops the second caller from stealing the lock; the margins tolerate slow CI runners.
		const slowFetch = (async () => {
			tokenCalls++;
			await Bun.sleep(400);
			return json({ access_token: "at-new", refresh_token: "rt-new", expires_in: 28_800 });
		}) as unknown as typeof fetch;
		const deps = { fetch: slowFetch, now: () => NOW, storePath: path, lock: { staleMs: 150, pollMs: 10, waitMs: 5_000 } };
		const results = await Promise.all([resolveAuthHeader("notion", deps), resolveAuthHeader("notion", deps)]);
		expect(results).toEqual(["Bearer at-new", "Bearer at-new"]);
		expect(tokenCalls).toBe(1);
	});
});

describe("recoverUnauthorized", () => {
	test("token already replaced -> true without network", async () => {
		seedOAuth(NOW + 3_600_000);
		const fake = fakeFetch({});
		expect(await recoverUnauthorized("notion", "Bearer stale", { fetch: fake.fetch, storePath: path })).toBe(true);
		expect(fake.calls).toHaveLength(0);
	});

	test("invalid_grant marks needsLogin", async () => {
		seedOAuth(NOW + 3_600_000);
		const fake = fakeFetch({ "https://mcp.notion.com/token": () => json({ error: "invalid_grant" }, 400) });
		const deps = { fetch: fake.fetch, now: () => NOW, storePath: path };
		expect(await recoverUnauthorized("notion", "Bearer at-old", deps)).toBe(false);
		const cred = readStore(path).providers.notion;
		expect(cred?.kind === "oauth" && cred.needsLogin).toBe("invalid_grant");
		expect(await resolveAuthHeader("notion", deps)).toBeUndefined();
		expect(status(deps).find(s => s.provider === "notion")).toMatchObject({ ready: false });
	});

	test("api key -> false", async () => {
		await setApiKey("greptile", "g", { storePath: path });
		expect(await recoverUnauthorized("greptile", "Bearer g", { storePath: path })).toBe(false);
	});
});
