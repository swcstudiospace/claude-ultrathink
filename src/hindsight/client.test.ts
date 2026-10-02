// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import { createHindsightClient } from "./client.ts";
import type { HindsightClient, HindsightClientOptions, HindsightResult } from "./types.ts";

const KEY = "hs-secret-key-0123456789abcdef";
const URL_BASE = "https://hindsight.example.test";
const BANK = "ultrathink";
const BANK_PATH = `/v1/default/banks/${BANK}`;

interface Call {
	method: string;
	path: string;
	headers: Record<string, string>;
	body: unknown;
}

interface Reply {
	status?: number;
	body?: unknown;
}

type Route = Reply | ((call: Call) => Reply);

/** Routes are keyed "METHOD /path"; an unrouted request answers 500 so the call log still shows it. */
function fake(routes: Record<string, Route>) {
	const calls: Call[] = [];
	const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(String(input));
		const method = init?.method ?? "GET";
		const call: Call = {
			method,
			path: url.pathname,
			headers: { ...(init?.headers as Record<string, string>) },
			body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
		};
		calls.push(call);
		const route = routes[`${method} ${url.pathname}`];
		const reply: Reply = route === undefined ? { status: 500, body: { detail: "unrouted" } } : typeof route === "function" ? route(call) : route;
		return new Response(reply.body === undefined ? "" : JSON.stringify(reply.body), { status: reply.status ?? 200 });
	}) as unknown as typeof fetch;
	return { fetch: fetchFn, calls };
}

function client(fetchFn: typeof fetch, overrides: Partial<HindsightClientOptions> = {}): HindsightClient {
	return createHindsightClient({ url: URL_BASE, apiKey: KEY, bank: BANK, timeoutMs: 1_000, retainTimeoutMs: 2_000, fetch: fetchFn, ...overrides });
}

function value<T>(result: HindsightResult<T>): T {
	if (!result.ok) throw new Error(`expected ok, got ${result.error.message}`);
	return result.value;
}

function error<T>(result: HindsightResult<T>) {
	if (result.ok) throw new Error("expected an error");
	return result.error;
}

const CHUNKS_CONFIG: Reply = { body: { bank_id: BANK, config: { retain_extraction_mode: "chunks" }, overrides: {} } };
const RETAIN_OK: Route = { body: { success: true, bank_id: BANK, items_count: 1, async: false } };

describe("health", () => {
	test("asks /health and /version without the key and reports version and features", async () => {
		const f = fake({
			"GET /health": { body: { status: "healthy", database: "connected", db_pool_max: 100 } },
			"GET /version": { body: { api_version: "0.9.1", features: { observations: false, worker: false, mcp: true, note: "x" } } },
		});
		const health = value(await client(f.fetch).health());
		expect(health).toEqual({ ok: true, apiVersion: "0.9.1", databaseConnected: true, features: { observations: false, worker: false, mcp: true } });
		expect(f.calls.map((c) => `${c.method} ${c.path}`)).toEqual(["GET /health", "GET /version"]);
		for (const call of f.calls) {
			expect(call.headers.Authorization).toBeUndefined();
			expect(call.body).toBeUndefined();
		}
	});

	test("a /health failure keeps what /version said and reports ok false", async () => {
		const f = fake({
			"GET /health": { status: 503, body: { detail: "starting" } },
			"GET /version": { body: { api_version: "0.9.1", features: { worker: false } } },
		});
		expect(value(await client(f.fetch).health())).toEqual({ ok: false, apiVersion: "0.9.1", databaseConnected: false, features: { worker: false } });
	});

	test("a database that is not connected is not ok", async () => {
		const f = fake({
			"GET /health": { body: { status: "healthy", database: "disconnected" } },
			"GET /version": { body: { api_version: "0.9.1" } },
		});
		expect(value(await client(f.fetch).health())).toMatchObject({ ok: false, databaseConnected: false, apiVersion: "0.9.1" });
	});

	test("a status other than healthy is not ok", async () => {
		const f = fake({
			"GET /health": { body: { status: "unhealthy", database: "connected" } },
			"GET /version": { body: { api_version: "0.9.1" } },
		});
		expect(value(await client(f.fetch).health())).toMatchObject({ ok: false, databaseConnected: true });
	});

	test("both endpoints failing is the /health error", async () => {
		const f = fake({ "GET /health": { status: 502 }, "GET /version": { status: 502 } });
		expect(error(await client(f.fetch).health())).toMatchObject({ kind: "server", status: 502 });
	});

	test("a missing /version leaves a healthy server ok with an empty version", async () => {
		const f = fake({ "GET /health": { body: { status: "healthy", database: "connected" } }, "GET /version": { status: 404 } });
		expect(value(await client(f.fetch).health())).toEqual({ ok: true, apiVersion: "", databaseConnected: true, features: {} });
	});
});

describe("ensureBank", () => {
	test("a bank already in chunks mode costs one GET and is cached afterwards", async () => {
		const f = fake({ [`GET ${BANK_PATH}/config`]: CHUNKS_CONFIG });
		const c = client(f.fetch);
		expect(value(await c.ensureBank())).toEqual({ bankId: BANK, created: false, extractionMode: "chunks" });
		expect(value(await c.ensureBank())).toEqual({ bankId: BANK, created: false, extractionMode: "chunks" });
		expect(f.calls).toHaveLength(1);
		expect(f.calls[0]?.headers.Authorization).toBe(`Bearer ${KEY}`);
	});

	test("another extraction mode is patched to chunks", async () => {
		const f = fake({
			[`GET ${BANK_PATH}/config`]: { body: { bank_id: BANK, config: { retain_extraction_mode: "concise" }, overrides: {} } },
			[`PATCH ${BANK_PATH}/config`]: { body: { bank_id: BANK } },
		});
		expect(value(await client(f.fetch).ensureBank())).toMatchObject({ created: false, extractionMode: "chunks" });
		expect(f.calls.map((c) => `${c.method} ${c.path}`)).toEqual([`GET ${BANK_PATH}/config`, `PATCH ${BANK_PATH}/config`]);
		expect(f.calls[1]?.body).toEqual({ updates: { retain_extraction_mode: "chunks" } });
		expect(f.calls[1]?.headers.Authorization).toBe(`Bearer ${KEY}`);
	});

	test("a missing bank is created with PUT {} and then set to chunks", async () => {
		const f = fake({
			[`GET ${BANK_PATH}/config`]: { status: 404, body: { detail: "bank not found" } },
			[`PUT ${BANK_PATH}`]: { body: { bank_id: BANK } },
			[`PATCH ${BANK_PATH}/config`]: { body: {} },
		});
		expect(value(await client(f.fetch).ensureBank())).toEqual({ bankId: BANK, created: true, extractionMode: "chunks" });
		expect(f.calls.map((c) => `${c.method} ${c.path}`)).toEqual([`GET ${BANK_PATH}/config`, `PUT ${BANK_PATH}`, `PATCH ${BANK_PATH}/config`]);
		expect(f.calls[1]?.body).toEqual({});
		expect(f.calls[2]?.body).toEqual({ updates: { retain_extraction_mode: "chunks" } });
	});

	test("a failure is not cached: the next call asks again", async () => {
		let first = true;
		const f = fake({
			[`GET ${BANK_PATH}/config`]: () => {
				if (first) {
					first = false;
					return { status: 401, body: { detail: "bad key" } };
				}
				return CHUNKS_CONFIG;
			},
		});
		const c = client(f.fetch);
		expect(error(await c.ensureBank())).toMatchObject({ kind: "auth", status: 401 });
		expect(value(await c.ensureBank())).toMatchObject({ created: false });
		expect(f.calls).toHaveLength(2);
	});

	test("a failing PATCH is an error and is not cached", async () => {
		const f = fake({
			[`GET ${BANK_PATH}/config`]: { body: { config: { retain_extraction_mode: "verbatim" } } },
			[`PATCH ${BANK_PATH}/config`]: { status: 422, body: { detail: "nope" } },
		});
		const c = client(f.fetch);
		expect(error(await c.ensureBank())).toMatchObject({ kind: "bad-request" });
		await c.ensureBank();
		expect(f.calls.filter((call) => call.method === "GET")).toHaveLength(2);
	});

	test("a config response without a config object is invalid", async () => {
		const f = fake({ [`GET ${BANK_PATH}/config`]: { body: { bank_id: BANK } } });
		expect(error(await client(f.fetch).ensureBank()).kind).toBe("invalid-response");
	});

	test("concurrent callers share one bootstrap", async () => {
		const f = fake({ [`GET ${BANK_PATH}/config`]: CHUNKS_CONFIG });
		const c = client(f.fetch);
		await Promise.all([c.ensureBank(), c.ensureBank(), c.ensureBank()]);
		expect(f.calls).toHaveLength(1);
	});

	test("the bank id is URL-encoded in every path", async () => {
		const f = fake({ "GET /v1/default/banks/team%2Fa%20b/config": CHUNKS_CONFIG });
		expect(value(await client(f.fetch, { bank: "team/a b" }).ensureBank())).toMatchObject({ bankId: "team/a b" });
	});

	test("deleting the bank clears the cache", async () => {
		const f = fake({ [`GET ${BANK_PATH}/config`]: CHUNKS_CONFIG, [`DELETE ${BANK_PATH}`]: { body: { success: true } } });
		const c = client(f.fetch);
		await c.ensureBank();
		await c.deleteBank();
		await c.ensureBank();
		expect(f.calls.filter((call) => call.method === "GET")).toHaveLength(2);
	});
});

describe("retain", () => {
	test("ensures the bank first, then upserts one document synchronously", async () => {
		const f = fake({ [`GET ${BANK_PATH}/config`]: CHUNKS_CONFIG, [`POST ${BANK_PATH}/memories`]: RETAIN_OK });
		const c = client(f.fetch);
		const outcome = value(
			await c.retain({
				documentId: "tm:abc",
				content: "# Lesson\n\nbody",
				context: "teachable moment: build",
				tags: ["ultrathink", "project:x"],
				metadata: { tm_id: "abc" },
				timestamp: "2026-10-02T00:00:00.000Z",
			}),
		);
		expect(outcome).toEqual({ bankId: BANK, documentId: "tm:abc", itemsCount: 1 });
		expect(f.calls.map((call) => `${call.method} ${call.path}`)).toEqual([`GET ${BANK_PATH}/config`, `POST ${BANK_PATH}/memories`]);
		expect(f.calls[1]?.body).toEqual({
			items: [
				{
					content: "# Lesson\n\nbody",
					context: "teachable moment: build",
					tags: ["ultrathink", "project:x"],
					metadata: { tm_id: "abc" },
					document_id: "tm:abc",
					timestamp: "2026-10-02T00:00:00.000Z",
					update_mode: "replace",
				},
			],
			async: false,
		});
		expect(f.calls[1]?.headers.Authorization).toBe(`Bearer ${KEY}`);
		expect(f.calls[1]?.headers["Content-Type"]).toBe("application/json");
		await c.retain({ documentId: "tm:abc", content: "again", tags: [] });
		expect(f.calls.filter((call) => call.method === "GET")).toHaveLength(1);
	});

	test("optional fields are left out of the item", async () => {
		const f = fake({ [`GET ${BANK_PATH}/config`]: CHUNKS_CONFIG, [`POST ${BANK_PATH}/memories`]: RETAIN_OK });
		await client(f.fetch).retain({ documentId: "tm:abc", content: "c", tags: ["t"] });
		const sent: { items: Record<string, unknown>[] } = f.calls[1]?.body as { items: Record<string, unknown>[] };
		const item = sent.items[0] ?? {};
		expect(Object.keys(item).sort()).toEqual(["content", "document_id", "tags", "update_mode"]);
	});

	test("an ensureBank failure stops before any memory is written", async () => {
		const f = fake({ [`GET ${BANK_PATH}/config`]: { status: 403 } });
		expect(error(await client(f.fetch).retain({ documentId: "tm:abc", content: "c", tags: [] }))).toMatchObject({ kind: "auth" });
		expect(f.calls).toHaveLength(1);
	});

	test("a response without success true and a numeric items_count is invalid", async () => {
		for (const body of [{ success: false, items_count: 1 }, { success: true }, { success: true, items_count: "1" }, "ok"]) {
			const f = fake({ [`GET ${BANK_PATH}/config`]: CHUNKS_CONFIG, [`POST ${BANK_PATH}/memories`]: { body } });
			expect(error(await client(f.fetch).retain({ documentId: "tm:abc", content: "c", tags: [] })).kind).toBe("invalid-response");
		}
	});

	test("uses retainTimeoutMs for the retain and timeoutMs for everything else", async () => {
		const hang = ((_: string | URL | Request, init?: RequestInit) => {
			if (new URL(String(_)).pathname.endsWith("/config")) {
				return Promise.resolve(new Response(JSON.stringify({ config: { retain_extraction_mode: "chunks" } })));
			}
			return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
		}) as unknown as typeof fetch;
		const c = client(hang, { timeoutMs: 5_000, retainTimeoutMs: 30 });
		const started = Date.now();
		const failure = error(await c.retain({ documentId: "tm:abc", content: "c", tags: [] }));
		expect(failure.kind).toBe("timeout");
		expect(failure.message).toContain("30 ms");
		expect(Date.now() - started).toBeLessThan(2_000);
		const recallFailure = error(await client(hang, { timeoutMs: 25, retainTimeoutMs: 5_000 }).recall({ query: "q" }));
		expect(recallFailure.message).toContain("25 ms");
	});
});

describe("recall", () => {
	test("sends the defaults and omits what was not given", async () => {
		const f = fake({ [`POST ${BANK_PATH}/memories/recall`]: { body: { results: [] } } });
		expect(value(await client(f.fetch).recall({ query: "how do I fix X" }))).toEqual([]);
		expect(f.calls[0]?.body).toEqual({
			query: "how do I fix X",
			types: ["world", "experience", "observation"],
			budget: "low",
			max_tokens: 1500,
		});
		expect(f.calls[0]?.headers.Authorization).toBe(`Bearer ${KEY}`);
	});

	test("passes tags, tag match, tag groups, types, budget and max tokens through", async () => {
		const f = fake({ [`POST ${BANK_PATH}/memories/recall`]: { body: { results: [] } } });
		const groups = [{ tags: ["a"], match: "any" }];
		await client(f.fetch).recall({ query: "q", tags: ["project:x"], tagsMatch: "all_strict", tagGroups: groups, types: ["world"], budget: "high", maxTokens: 300 });
		expect(f.calls[0]?.body).toEqual({
			query: "q",
			types: ["world"],
			budget: "high",
			max_tokens: 300,
			tags: ["project:x"],
			tags_match: "all_strict",
			tag_groups: groups,
		});
	});

	test("maps hits, tolerating null tags and metadata and dropping malformed items", async () => {
		const f = fake({
			[`POST ${BANK_PATH}/memories/recall`]: {
				body: {
					results: [
						{
							id: "m1",
							text: "lesson one",
							type: "world",
							context: "ctx",
							mentioned_at: "2026-10-02T00:00:00Z",
							document_id: "tm:a",
							tags: ["t1", 7, "t2"],
							metadata: { tm_id: "a", count: 3, nested: { x: 1 } },
						},
						{ id: "m2", text: "lesson two", tags: null, metadata: null, document_id: null, type: null },
						{ id: "m3" },
						{ text: "no id" },
						"junk",
						null,
					],
				},
			},
		});
		expect(value(await client(f.fetch).recall({ query: "q" }))).toEqual([
			{
				id: "m1",
				text: "lesson one",
				type: "world",
				context: "ctx",
				mentionedAt: "2026-10-02T00:00:00Z",
				documentId: "tm:a",
				tags: ["t1", "t2"],
				metadata: { tm_id: "a" },
			},
			{ id: "m2", text: "lesson two", tags: [], metadata: {} },
		]);
	});

	test("a response without a results array is invalid", async () => {
		const f = fake({ [`POST ${BANK_PATH}/memories/recall`]: { body: { hits: [] } } });
		expect(error(await client(f.fetch).recall({ query: "q" })).kind).toBe("invalid-response");
	});
});

describe("documents and banks", () => {
	const DOC = `${BANK_PATH}/documents/tm%3Aabc`;

	test("getDocument maps the response and encodes the id", async () => {
		const f = fake({
			[`GET ${DOC}`]: { body: { id: "tm:abc", bank_id: BANK, created_at: "c", updated_at: "u", memory_unit_count: 2, tags: ["a", "b"], original_text: "x" } },
		});
		expect(value(await client(f.fetch).getDocument("tm:abc"))).toEqual({ id: "tm:abc", tags: ["a", "b"], createdAt: "c", updatedAt: "u", memoryUnitCount: 2 });
		expect(f.calls[0]?.headers.Authorization).toBe(`Bearer ${KEY}`);
	});

	test("getDocument answers null for a missing document and errors on a body without an id", async () => {
		expect(value(await client(fake({ [`GET ${DOC}`]: { status: 404 } }).fetch).getDocument("tm:abc"))).toBeNull();
		expect(error(await client(fake({ [`GET ${DOC}`]: { body: { tags: [] } } }).fetch).getDocument("tm:abc")).kind).toBe("invalid-response");
	});

	test("getDocument still reports a 500 as an error", async () => {
		expect(error(await client(fake({ [`GET ${DOC}`]: { status: 500 } }).fetch).getDocument("tm:abc")).kind).toBe("server");
	});

	test("deleteDocument is true when deleted, false when already gone, an error otherwise", async () => {
		const f = fake({ [`DELETE ${DOC}`]: { body: { success: true, document_id: "tm:abc", memory_units_deleted: 1 } } });
		expect(value(await client(f.fetch).deleteDocument("tm:abc"))).toBe(true);
		expect(f.calls[0]?.method).toBe("DELETE");
		expect(value(await client(fake({ [`DELETE ${DOC}`]: { status: 404 } }).fetch).deleteDocument("tm:abc"))).toBe(false);
		expect(error(await client(fake({ [`DELETE ${DOC}`]: { status: 401 } }).fetch).deleteDocument("tm:abc")).kind).toBe("auth");
	});

	test("setDocumentTags PATCHes the tags", async () => {
		const f = fake({ [`PATCH ${DOC}`]: { body: { success: true } } });
		expect(value(await client(f.fetch).setDocumentTags("tm:abc", ["status:superseded"]))).toBe(true);
		expect(f.calls[0]?.body).toEqual({ tags: ["status:superseded"] });
		expect(f.calls[0]?.headers.Authorization).toBe(`Bearer ${KEY}`);
		expect(error(await client(fake({ [`PATCH ${DOC}`]: { status: 404 } }).fetch).setDocumentTags("tm:abc", [])).kind).toBe("not-found");
	});

	test("deleteBank DELETEs the bank and treats 404 as success", async () => {
		const f = fake({ [`DELETE ${BANK_PATH}`]: { body: { success: true } } });
		expect(value(await client(f.fetch).deleteBank())).toBe(true);
		expect(f.calls[0]).toMatchObject({ method: "DELETE", path: BANK_PATH });
		expect(value(await client(fake({ [`DELETE ${BANK_PATH}`]: { status: 404 } }).fetch).deleteBank())).toBe(true);
		expect(error(await client(fake({ [`DELETE ${BANK_PATH}`]: { status: 500 } }).fetch).deleteBank()).kind).toBe("server");
	});
});

describe("errors", () => {
	const QUERY = "my private prompt about the secret project";
	const STATUS_KINDS: [number, string][] = [
		[401, "auth"],
		[403, "auth"],
		[404, "not-found"],
		[400, "bad-request"],
		[409, "bad-request"],
		[422, "bad-request"],
		[429, "rate-limit"],
		[500, "server"],
		[503, "server"],
	];

	for (const [status, kind] of STATUS_KINDS) {
		test(`HTTP ${status} is ${kind}, one redacted line, no key and no request content`, async () => {
			const f = fake({
				[`POST ${BANK_PATH}/memories/recall`]: {
					status,
					body: { detail: [{ loc: ["body", "query"], msg: "bad", input: QUERY }], echo: `${KEY} ${QUERY}` },
				},
			});
			const failure = error(await client(f.fetch).recall({ query: QUERY }));
			expect(failure.kind).toBe(kind as typeof failure.kind);
			expect(failure.status).toBe(status);
			expect(failure.message.startsWith(`hindsight ${kind}: `)).toBe(true);
			expect(failure.message).toBe(`hindsight ${kind}: HTTP ${status}`);
			expect(failure.message).not.toContain(KEY);
			expect(failure.message).not.toContain(QUERY);
		});
	}

	test("a string detail is shown, with the key redacted, on one line and capped at 200 characters", async () => {
		const f = fake({
			[`POST ${BANK_PATH}/memories/recall`]: { status: 401, body: { detail: `invalid key ${KEY}\nnext line ${"x".repeat(400)}` } },
		});
		const failure = error(await client(f.fetch).recall({ query: "q" }));
		expect(failure.message).toContain("invalid key [redacted] next line");
		expect(failure.message).not.toContain(KEY);
		expect(failure.message).not.toContain("\n");
		expect(failure.message.length).toBeLessThanOrEqual(200);
		const viaMessage = fake({ [`POST ${BANK_PATH}/memories/recall`]: { status: 500, body: { message: "database is down" } } });
		expect(error(await client(viaMessage.fetch).recall({ query: "q" })).message).toBe("hindsight server: HTTP 500: database is down");
	});

	test("a network failure is classified and never shows the key", async () => {
		const boom = (() => Promise.reject(new Error(`connect ECONNREFUSED while sending Bearer ${KEY}`))) as unknown as typeof fetch;
		const failure = error(await client(boom).recall({ query: "q" }));
		expect(failure.kind).toBe("network");
		expect(failure.message).not.toContain(KEY);
		expect(failure.message.startsWith("hindsight network: ")).toBe(true);
	});

	test("a 2xx with an unusable body is invalid-response", async () => {
		const f = fake({ [`POST ${BANK_PATH}/memories/recall`]: { body: "not an object" } });
		expect(error(await client(f.fetch).recall({ query: "q" })).kind).toBe("invalid-response");
	});

	test("an aborted caller signal rejects instead of returning an error", async () => {
		const controller = new AbortController();
		controller.abort();
		const c = client(fake({}).fetch, { signal: controller.signal });
		await expect(c.recall({ query: "q" })).rejects.toMatchObject({ name: "AbortError" });
	});
});

describe("factory", () => {
	test("refuses an unsafe URL, an empty bank and an empty key", () => {
		const base = { apiKey: KEY, bank: BANK, timeoutMs: 1, retainTimeoutMs: 1 };
		expect(() => createHindsightClient({ ...base, url: "http://example.com" })).toThrow(/invalid url/);
		expect(() => createHindsightClient({ ...base, url: "" })).toThrow(/invalid url/);
		expect(() => createHindsightClient({ ...base, url: URL_BASE, bank: " " })).toThrow(/bank/);
		expect(() => createHindsightClient({ ...base, url: URL_BASE, apiKey: "" })).toThrow(/apiKey/);
	});

	test("a URL path prefix is kept and a trailing slash dropped", async () => {
		const f = fake({ "GET /api/health": { body: { status: "healthy", database: "connected" } }, "GET /api/version": { body: { api_version: "0.9.1" } } });
		expect(value(await client(f.fetch, { url: `${URL_BASE}/api/` }).health()).ok).toBe(true);
	});

	test("exposes the bank", () => {
		expect(client(fake({}).fetch).bank).toBe(BANK);
	});
});
