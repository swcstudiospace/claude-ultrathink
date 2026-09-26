// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMcpClient, hasUsableCredential, loginHint } from "./client.ts";
import { writeStore } from "./store.ts";

interface Rpc {
	id?: number;
	method: string;
	params?: { name?: string; arguments?: Record<string, unknown> };
}

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function store(): string {
	const dir = mkdtempSync(join(tmpdir(), "mcp-client-"));
	dirs.push(dir);
	const path = join(dir, "creds.json");
	writeStore(path, { version: 1, providers: { linear: { kind: "api_key", apiKey: "k", updatedAt: 0 } } });
	return path;
}

type Handler = (rpc: Rpc, signal?: AbortSignal) => unknown | Promise<unknown>;

function fakeFetch(onTool: Handler): { fetch: typeof fetch; methods: string[] } {
	const methods: string[] = [];
	const impl = async (_url: unknown, init?: RequestInit): Promise<Response> => {
		const rpc = JSON.parse(String(init?.body)) as Rpc;
		methods.push(rpc.method);
		if (rpc.id === undefined) return new Response(null, { status: 202 });
		const result =
			rpc.method === "initialize" ? { protocolVersion: "2025-06-18", capabilities: {} } : await onTool(rpc, init?.signal ?? undefined);
		return Response.json({ jsonrpc: "2.0", id: rpc.id, result });
	};
	return { fetch: impl as unknown as typeof fetch, methods };
}

const text = (value: string) => ({ content: [{ type: "text", text: value }] });

describe("createMcpClient", () => {
	test("initializes once for concurrent calls and correlates interleaved responses", async () => {
		const gates: Record<string, PromiseWithResolvers<void>> = {
			a: Promise.withResolvers<void>(),
			b: Promise.withResolvers<void>(),
		};
		const bothArrived = Promise.withResolvers<void>();
		let arrived = 0;
		const fake = fakeFetch(async (rpc) => {
			const key = String(rpc.params?.arguments?.key);
			if (++arrived === 2) bothArrived.resolve();
			await gates[key]?.promise;
			return text(JSON.stringify({ identifier: `ENG-${key}` }));
		});
		const client = createMcpClient("linear", { storePath: store(), fetch: fake.fetch });
		const a = client.call("save_issue", { key: "a" });
		const b = client.call("save_issue", { key: "b" });
		await bothArrived.promise;
		gates.b?.resolve();
		expect(await b).toEqual({ identifier: "ENG-b" });
		gates.a?.resolve();
		expect(await a).toEqual({ identifier: "ENG-a" });
		expect(fake.methods.filter((m) => m === "initialize")).toHaveLength(1);
		expect(fake.methods.filter((m) => m === "notifications/initialized")).toHaveLength(1);
		client.close();
	});

	test("prefers structuredContent, falls back to raw text", async () => {
		const fake = fakeFetch((rpc) =>
			rpc.params?.name === "structured"
				? { ...text("{\"ignored\":true}"), structuredContent: { id: "x" } }
				: text("plain words"),
		);
		const client = createMcpClient("linear", { storePath: store(), fetch: fake.fetch });
		expect(await client.call("structured", {})).toEqual({ id: "x" });
		expect(await client.call("plain", {})).toBe("plain words");
		client.close();
	});

	test("isError rejects with a short message", async () => {
		const fake = fakeFetch(() => ({ ...text(`rate limited ${"x".repeat(500)}`), isError: true }));
		const client = createMcpClient("linear", { storePath: store(), fetch: fake.fetch });
		const error = await client.call("save_issue", {}).catch((e: unknown) => e as Error);
		expect(error).toBeInstanceOf(Error);
		expect((error as Error).message.startsWith("save_issue: rate limited")).toBe(true);
		expect((error as Error).message.length).toBeLessThanOrEqual(200);
		client.close();
	});

	test.each([
		["linear", "Linear"],
		["greptile", "Greptile"],
	] as const)("a %s call without credentials names OAuth login and the settings API key", async (provider, label) => {
		const dir = mkdtempSync(join(tmpdir(), "mcp-client-"));
		dirs.push(dir);
		const storePath = join(dir, "creds.json");
		writeStore(storePath, { version: 1, providers: {} });
		const unauthorized = (async () => new Response(null, { status: 401 })) as unknown as typeof fetch;
		const client = createMcpClient(provider, { storePath, fetch: unauthorized });
		const error = await client.call("list_issues", {}).catch((e: unknown) => e as Error);
		expect(error).toBeInstanceOf(Error);
		const message = (error as Error).message;
		expect(message).toContain("authentication required");
		expect(message).toContain(`ultrathink-mcp auth login ${provider}`);
		expect(message).toContain(`ultrathink-mcp auth set-key ${provider} --stdin`);
		expect(message).toContain(`${label} account settings`);
		client.close();
	});

	test("the notion hint offers OAuth login only", () => {
		const hint = loginHint("notion");
		expect(hint).toContain("ultrathink-mcp auth login notion");
		expect(hint).not.toContain("set-key");
		expect(hint).not.toContain("API key");
	});

	// Real 20ms timer: the timeout lives inside the client and is the behaviour under test.
	test("per-call timeout rejects", async () => {
		const never = Promise.withResolvers<void>();
		const fake = fakeFetch(async () => {
			await never.promise;
			return text("{}");
		});
		const client = createMcpClient("linear", { storePath: store(), fetch: fake.fetch, callTimeoutMs: 20 });
		await expect(client.call("slow", {})).rejects.toThrow("timed out");
		client.close();
		never.resolve();
	});

	// Real 20ms timer for the timeout case only: the timeout lives inside the client and is under test.
	test("caller abort, per-call timeout and close() abort the in-flight fetch", async () => {
		const reached: Record<string, PromiseWithResolvers<void>> = {};
		const fetchAborted: Record<string, PromiseWithResolvers<void>> = {};
		for (const name of ["caller", "timeout", "close"]) {
			reached[name] = Promise.withResolvers<void>();
			fetchAborted[name] = Promise.withResolvers<void>();
		}
		const fake = fakeFetch(async (rpc, signal) => {
			const name = String(rpc.params?.name);
			reached[name]?.resolve();
			const aborted = Promise.withResolvers<void>();
			if (signal?.aborted) aborted.resolve();
			signal?.addEventListener("abort", () => aborted.resolve(), { once: true });
			await aborted.promise;
			fetchAborted[name]?.resolve();
			throw new Error("aborted");
		});
		const client = createMcpClient("linear", { storePath: store(), fetch: fake.fetch, callTimeoutMs: 20 });
		const controller = new AbortController();
		const byCaller = client.call("caller", {}, controller.signal);
		await reached.caller?.promise;
		controller.abort();
		await expect(byCaller).rejects.toThrow("aborted");
		await fetchAborted.caller?.promise;
		await expect(client.call("timeout", {})).rejects.toThrow("timed out");
		await fetchAborted.timeout?.promise;
		const byClose = client.call("close", {});
		await reached.close?.promise;
		client.close();
		await expect(byClose).rejects.toThrow("client closed");
		await fetchAborted.close?.promise;
	});

	test("server ping sharing the request id does not steal the reply", async () => {
		const impl = async (_url: unknown, init?: RequestInit): Promise<Response> => {
			const rpc = JSON.parse(String(init?.body)) as Rpc;
			if (rpc.id === undefined) return new Response(null, { status: 202 });
			if (rpc.method === "initialize")
				return Response.json({ jsonrpc: "2.0", id: rpc.id, result: { protocolVersion: "2025-06-18" } });
			const body =
				`data: ${JSON.stringify({ jsonrpc: "2.0", id: rpc.id, method: "ping" })}\n\n` +
				`data: ${JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { structuredContent: { ok: 1 } } })}\n\n`;
			return new Response(body, { headers: { "content-type": "text/event-stream" } });
		};
		const client = createMcpClient("linear", { storePath: store(), fetch: impl as unknown as typeof fetch });
		expect(await client.call("save_issue", {})).toEqual({ ok: 1 });
		client.close();
	});

	test("close rejects pending and later calls", async () => {
		const never = Promise.withResolvers<void>();
		const reached = Promise.withResolvers<void>();
		const fake = fakeFetch(async () => {
			reached.resolve();
			await never.promise;
			return text("{}");
		});
		const client = createMcpClient("linear", { storePath: store(), fetch: fake.fetch });
		const pending = client.call("slow", {});
		await reached.promise;
		client.close();
		await expect(pending).rejects.toThrow("client closed");
		await expect(client.call("again", {})).rejects.toThrow("client closed");
		never.resolve();
	});
});

describe("hasUsableCredential", () => {
	const oauthClient = {
		clientId: "c",
		redirectUri: "http://127.0.0.1/callback",
		issuer: "https://issuer.example",
		authorizationEndpoint: "https://issuer.example/authorize",
		tokenEndpoint: "https://issuer.example/token",
		registeredAt: 0,
	};

	function storeWith(providers: Parameters<typeof writeStore>[1]["providers"]): string {
		const dir = mkdtempSync(join(tmpdir(), "mcp-cred-"));
		dirs.push(dir);
		const path = join(dir, "creds.json");
		writeStore(path, { version: 1, providers });
		return path;
	}

	test("an API key is usable", () => {
		const path = storeWith({ greptile: { kind: "api_key", apiKey: "k", updatedAt: 0 } });
		expect(hasUsableCredential("greptile", path)).toBe(true);
	});

	test("OAuth tokens are usable until a new login is needed", () => {
		const tokens = { accessToken: "a" };
		expect(hasUsableCredential("greptile", storeWith({ greptile: { kind: "oauth", client: oauthClient, tokens, updatedAt: 0 } }))).toBe(true);
		const stale = storeWith({ greptile: { kind: "oauth", client: oauthClient, tokens, needsLogin: "refresh rejected", updatedAt: 0 } });
		expect(hasUsableCredential("greptile", stale)).toBe(false);
		expect(hasUsableCredential("greptile", storeWith({ greptile: { kind: "oauth", client: oauthClient, updatedAt: 0 } }))).toBe(false);
	});

	test("a provider without a stored credential, or no store at all, is not usable", () => {
		const path = storeWith({ linear: { kind: "api_key", apiKey: "k", updatedAt: 0 } });
		expect(hasUsableCredential("greptile", path)).toBe(false);
		expect(hasUsableCredential("greptile", join(path, "..", "missing.json"))).toBe(false);
	});
});
