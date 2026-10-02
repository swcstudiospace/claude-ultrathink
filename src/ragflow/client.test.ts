// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import { createRagflowClient } from "./client.ts";
import type { RagflowClient, RagflowErrorKind } from "./types.ts";

const KEY = "rf-TESTKEY-0123456789abcdef";
const BASE = "https://rag.example.com";
const QUESTION = "how do we rotate the zebra credentials";

interface Call {
	url: string;
	method: string;
	headers: Record<string, string>;
	body: unknown;
}

/** Every URL any fake fetch in this file was asked for: the last test proves none of them is a healthz route. */
const requestedUrls: string[] = [];

function fakeFetch(handler: (call: Call, index: number) => Response | Promise<Response>): { fetch: typeof fetch; calls: Call[] } {
	const calls: Call[] = [];
	const impl = (async (input: string | URL | Request, init?: RequestInit) => {
		const headers: Record<string, string> = {};
		new Headers(init?.headers).forEach((value, name) => {
			headers[name] = value;
		});
		const call: Call = {
			url: String(input),
			method: init?.method ?? "GET",
			headers,
			body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : init?.body,
		};
		requestedUrls.push(call.url);
		calls.push(call);
		return handler(call, calls.length - 1);
	}) as typeof fetch;
	return { fetch: impl, calls };
}

function clientWith(fetchImpl: typeof fetch, overrides: { url?: string; timeoutMs?: number; signal?: AbortSignal } = {}): RagflowClient {
	return createRagflowClient({ url: overrides.url ?? BASE, apiKey: KEY, timeoutMs: overrides.timeoutMs ?? 2_000, fetch: fetchImpl, signal: overrides.signal });
}

function datasets(start: number, count: number): Array<Record<string, unknown>> {
	return Array.from({ length: count }, (_, i) => ({ id: `ds-${start + i}`, name: `Dataset ${start + i}`, chunk_count: 3, document_count: 1 }));
}

describe("createRagflowClient", () => {
	test("refuses a URL the key may not travel to and an empty key", () => {
		expect(() => createRagflowClient({ url: "http://example.com", apiKey: KEY, timeoutMs: 1000 })).toThrow(/ragflow url/);
		expect(() => createRagflowClient({ url: "", apiKey: KEY, timeoutMs: 1000 })).toThrow(/ragflow url/);
		expect(() => createRagflowClient({ url: BASE, apiKey: "   ", timeoutMs: 1000 })).toThrow(/api key/);
	});

	test("health: one-row dataset listing with the Bearer key; datasets comes from total", async () => {
		const { fetch, calls } = fakeFetch(() => Response.json({ code: 0, data: datasets(0, 1), total: 42 }));
		const result = await clientWith(fetch).health();
		expect(result).toEqual({ ok: true, value: { datasets: 42 } });
		expect(calls).toHaveLength(1);
		expect(calls[0]?.method).toBe("GET");
		expect(calls[0]?.url).toBe(`${BASE}/api/v1/datasets?page=1&page_size=1`);
		expect(calls[0]?.headers.authorization).toBe(`Bearer ${KEY}`);
		expect(calls[0]?.body).toBeUndefined();
	});

	test("health: without a numeric total the row count is used", async () => {
		const { fetch } = fakeFetch(() => Response.json({ code: 0, data: datasets(0, 1), total: "many" }));
		expect(await clientWith(fetch).health()).toEqual({ ok: true, value: { datasets: 1 } });
	});

	test("a path in the configured URL is kept and a trailing slash is not doubled", async () => {
		const { fetch, calls } = fakeFetch(() => Response.json({ code: 0, data: [], total: 0 }));
		await clientWith(fetch, { url: `${BASE}/ragflow/` }).health();
		expect(calls[0]?.url).toBe(`${BASE}/ragflow/api/v1/datasets?page=1&page_size=1`);
	});

	test("listDatasets: pages of 100 until a short page, mapping the dataset fields", async () => {
		const pages: Record<string, Array<Record<string, unknown>>> = { "1": datasets(0, 100), "2": datasets(100, 100), "3": datasets(200, 30) };
		const { fetch, calls } = fakeFetch((call) => {
			const page = new URL(call.url).searchParams.get("page") ?? "";
			return Response.json({ code: 0, data: pages[page] ?? [] });
		});
		const result = await clientWith(fetch).listDatasets();
		expect(calls.map((c) => c.url)).toEqual([
			`${BASE}/api/v1/datasets?page=1&page_size=100`,
			`${BASE}/api/v1/datasets?page=2&page_size=100`,
			`${BASE}/api/v1/datasets?page=3&page_size=100`,
		]);
		expect(calls.every((c) => c.method === "GET" && c.headers.authorization === `Bearer ${KEY}`)).toBe(true);
		expect(result.ok && result.value).toHaveLength(230);
		if (result.ok) expect(result.value[0]).toEqual({ id: "ds-0", name: "Dataset 0", chunkCount: 3, documentCount: 1 });
	});

	test("listDatasets: optional fields are mapped and non-dataset entries are dropped", async () => {
		const { fetch } = fakeFetch(() =>
			Response.json({
				code: 0,
				data: [{ id: "a", name: "Alpha", description: "docs", chunk_count: 9, document_count: 2, embedding_model: "bge@x" }, { name: "no id" }, "junk", { id: "b" }],
			}),
		);
		const result = await clientWith(fetch).listDatasets();
		expect(result).toEqual({
			ok: true,
			value: [
				{ id: "a", name: "Alpha", description: "docs", chunkCount: 9, documentCount: 2, embeddingModel: "bge@x" },
				{ id: "b", name: "b" },
			],
		});
	});

	test("listDatasets: stops when the collected count reaches total", async () => {
		const { fetch, calls } = fakeFetch((call) => {
			const page = Number(new URL(call.url).searchParams.get("page"));
			return Response.json({ code: 0, data: datasets((page - 1) * 100, 100), total: 200 });
		});
		const result = await clientWith(fetch).listDatasets();
		expect(calls).toHaveLength(2);
		expect(result.ok && result.value).toHaveLength(200);
	});

	test("listDatasets: stops at an empty page when the server reports no total", async () => {
		const { fetch, calls } = fakeFetch((call) => {
			const page = Number(new URL(call.url).searchParams.get("page"));
			return Response.json({ code: 0, data: page === 1 ? datasets(0, 100) : [] });
		});
		const result = await clientWith(fetch).listDatasets();
		expect(calls).toHaveLength(2);
		expect(result.ok && result.value).toHaveLength(100);
	});

	test("listDatasets: never collects more than 1000 datasets even when total says more", async () => {
		const { fetch, calls } = fakeFetch((call) => {
			const page = Number(new URL(call.url).searchParams.get("page"));
			return Response.json({ code: 0, data: datasets((page - 1) * 100, 100), total: 5000 });
		});
		const result = await clientWith(fetch).listDatasets();
		expect(calls).toHaveLength(10);
		expect(result.ok && result.value).toHaveLength(1000);
		if (result.ok) expect(result.value[999]?.id).toBe("ds-999");
	});

	test("listDatasets: a failing page fails the whole listing", async () => {
		const { fetch } = fakeFetch((_call, index) => (index === 0 ? Response.json({ code: 0, data: datasets(0, 100), total: 300 }) : Response.json({ code: 109, message: "nope" })));
		const result = await clientWith(fetch).listDatasets();
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.kind).toBe("auth");
	});

	test("retrieve: POST body, defaults and chunk mapping", async () => {
		const { fetch, calls } = fakeFetch(() =>
			Response.json({
				code: 0,
				data: {
					chunks: [
						{ id: "c1", content: "first", document_id: "d1", document_keyword: "guide.md", dataset_id: "ds-1", similarity: 0.91 },
						{ id: "c2", content: "second" },
						{ content: "no id" },
						{ id: "c4", content: 7 },
						null,
					],
					total: 5,
				},
			}),
		);
		const result = await clientWith(fetch).retrieve({ question: QUESTION, datasetIds: ["ds-1", "ds-2"] });
		expect(calls).toHaveLength(1);
		expect(calls[0]?.method).toBe("POST");
		expect(calls[0]?.url).toBe(`${BASE}/api/v1/retrieval`);
		expect(calls[0]?.headers.authorization).toBe(`Bearer ${KEY}`);
		expect(calls[0]?.headers["content-type"]).toBe("application/json");
		expect(calls[0]?.body).toEqual({
			question: QUESTION,
			dataset_ids: ["ds-1", "ds-2"],
			page: 1,
			page_size: 5,
			similarity_threshold: 0.2,
			vector_similarity_weight: 0.3,
			top_k: 1024,
		});
		expect(result).toEqual({
			ok: true,
			value: [
				{ id: "c1", content: "first", documentId: "d1", documentName: "guide.md", datasetId: "ds-1", similarity: 0.91 },
				{ id: "c2", content: "second" },
			],
		});
	});

	test("retrieve: topK and similarityThreshold override the defaults", async () => {
		const { fetch, calls } = fakeFetch(() => Response.json({ code: 0, data: { chunks: [] } }));
		const result = await clientWith(fetch).retrieve({ question: QUESTION, datasetIds: ["d"], topK: 12, similarityThreshold: 0.55 });
		expect(result).toEqual({ ok: true, value: [] });
		expect(calls[0]?.body).toMatchObject({ page_size: 12, similarity_threshold: 0.55 });
	});

	test("retrieve: an empty question or no datasets is a bad-request without a request", async () => {
		const { fetch, calls } = fakeFetch(() => Response.json({ code: 0, data: { chunks: [] } }));
		const client = clientWith(fetch);
		const blank = await client.retrieve({ question: "  \n", datasetIds: ["d"] });
		const none = await client.retrieve({ question: QUESTION, datasetIds: [] });
		expect(blank.ok === false && blank.error.kind).toBe("bad-request");
		expect(none.ok === false && none.error.kind).toBe("bad-request");
		expect(calls).toHaveLength(0);
		if (!none.ok) expect(none.error.message).not.toContain(QUESTION);
	});

	test("retrieve: a body without data.chunks is invalid-response", async () => {
		const { fetch } = fakeFetch(() => Response.json({ code: 0, data: { total: 0 } }));
		const result = await clientWith(fetch).retrieve({ question: QUESTION, datasetIds: ["d"] });
		expect(result.ok === false && result.error.kind).toBe("invalid-response");
	});
});

describe("error mapping", () => {
	const table: Array<[string, number, unknown, RagflowErrorKind, number | undefined]> = [
		["HTTP 401", 401, { code: 401, message: "Unauthorized" }, "auth", 401],
		["HTTP 403", 403, { code: 403, message: "Forbidden" }, "auth", 403],
		["HTTP 200 with code 109", 200, { code: 109, message: "Authentication error: API key is invalid!" }, "auth", 109],
		["HTTP 200 with code 108", 200, { code: 108, message: "No permission" }, "auth", 108],
		["HTTP 404", 404, { code: 404, message: "missing" }, "not-found", 404],
		["HTTP 400", 400, { code: 400, message: "bad" }, "bad-request", 400],
		["HTTP 422", 422, {}, "bad-request", undefined],
		["HTTP 200 with code 102", 200, { code: 102, message: "`dataset_ids` is required." }, "bad-request", 102],
		["HTTP 200 with code 101", 200, { code: 101, message: "invalid argument" }, "bad-request", 101],
		["HTTP 429", 429, { message: "slow down" }, "rate-limit", undefined],
		["HTTP 500", 500, { code: 500, message: "boom" }, "server", 500],
		["HTTP 503 without a body", 503, undefined, "server", undefined],
		["HTTP 200 with code 100", 200, { code: 100, message: "exception" }, "api-error", 100],
		["HTTP 200 with code 103", 200, { code: 103, message: "operation error" }, "api-error", 103],
		["HTTP 409", 409, { code: 409, message: "conflict" }, "api-error", 409],
		["HTTP 200 with a non-object body", 200, ["code", 0], "invalid-response", undefined],
		["HTTP 200 with no code", 200, { data: [] }, "invalid-response", undefined],
		["HTTP 200 with a string code", 200, { code: "0", data: [] }, "invalid-response", undefined],
	];

	for (const [name, status, body, kind, code] of table) {
		test(`${name} -> ${kind}`, async () => {
			const respond = () => (body === undefined ? new Response("", { status }) : Response.json(body, { status }));
			const { fetch } = fakeFetch(respond);
			const client = clientWith(fetch);
			for (const result of [await client.health(), await client.retrieve({ question: QUESTION, datasetIds: ["d"] })]) {
				expect(result.ok).toBe(false);
				if (result.ok) continue;
				expect(result.error.kind).toBe(kind);
				expect(result.error.code).toBe(code);
				expect(result.error.message.startsWith(`ragflow ${kind}: `)).toBe(true);
				expect(result.error.message.length).toBeLessThanOrEqual(200);
				expect(result.error.message).not.toContain("\n");
				if (kind !== "invalid-response") expect(result.error.status).toBe(status);
			}
		});
	}

	test("a non-JSON 200 is invalid-response", async () => {
		const { fetch } = fakeFetch(() => new Response("<html>ok</html>", { status: 200 }));
		const result = await clientWith(fetch).health();
		expect(result.ok === false && result.error.kind).toBe("invalid-response");
	});

	test("messages carry the server's detail but never the key or the question", async () => {
		const echo = (question: string) => `rejected key ${KEY}${question}\nBearer ${KEY}`;
		const { fetch } = fakeFetch((call) => Response.json({ code: 109, message: echo(call.method === "POST" ? ` for question "${QUESTION}"` : "") }));
		const client = clientWith(fetch);
		const health = await client.health();
		const retrieved = await client.retrieve({ question: QUESTION, datasetIds: ["d"] });
		for (const result of [health, retrieved]) {
			expect(result.ok).toBe(false);
			if (result.ok) continue;
			expect(result.error.message).not.toContain(KEY);
			expect(result.error.message).not.toContain(QUESTION);
			expect(result.error.message).toContain("[redacted]");
			expect(result.error.message).toContain("rejected key");
		}
	});

	test("a long server message is cut to 200 characters", async () => {
		const { fetch } = fakeFetch(() => Response.json({ code: 100, message: "x".repeat(5000) }));
		const result = await clientWith(fetch).health();
		expect(result.ok === false && result.error.message.length).toBe(200);
	});

	test("a non-string message falls back to the status or code", async () => {
		const { fetch } = fakeFetch(() => Response.json({ code: 100, message: { nested: true } }));
		const result = await clientWith(fetch).health();
		expect(result.ok === false && result.error.message).toBe("ragflow api-error: code 100");
	});

	test("a network failure is classified and redacted", async () => {
		const { fetch } = fakeFetch(() => {
			throw new Error(`connect ECONNREFUSED while sending ${KEY} with Bearer ${KEY}`);
		});
		const result = await clientWith(fetch).health();
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.kind).toBe("network");
			expect(result.error.message).not.toContain(KEY);
			expect(result.error.message).toContain("ECONNREFUSED");
		}
	});

	test("no answer within the budget is a timeout", async () => {
		const { fetch } = fakeFetch(() => new Promise<Response>(() => {}));
		const result = await clientWith(fetch, { timeoutMs: 25 }).retrieve({ question: QUESTION, datasetIds: ["d"] });
		expect(result.ok === false && result.error.kind).toBe("timeout");
		if (!result.ok) expect(result.error.message).not.toContain(QUESTION);
	});

	test("the caller's abort is the only rejection", async () => {
		const controller = new AbortController();
		controller.abort();
		const { fetch } = fakeFetch(() => Response.json({ code: 0, data: [] }));
		await expect(clientWith(fetch, { signal: controller.signal }).health()).rejects.toBeDefined();
	});
});

describe("health probe", () => {
	test("no request in this file ever touches a healthz route", async () => {
		const { fetch, calls } = fakeFetch(() => Response.json({ code: 0, data: [], total: 0 }));
		const client = clientWith(fetch);
		await client.health();
		await client.listDatasets();
		await client.retrieve({ question: QUESTION, datasetIds: ["d"] });
		expect(calls.length).toBeGreaterThan(0);
		expect(calls.some((c) => c.url.includes("healthz"))).toBe(false);
		expect(requestedUrls.some((url) => url.includes("healthz"))).toBe(false);
	});
});
