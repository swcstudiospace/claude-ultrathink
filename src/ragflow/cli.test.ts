// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CommandDeps, runRagflowCommand } from "./cli.ts";
import { DEFAULT_RAGFLOW_CONFIG, type RagflowConfig } from "./types.ts";

const KEY = "rf-CLI-KEY-0123456789abcdef";
const QUESTION = "how to rotate the zebra credentials";
const URL_BASE = "https://rag.example.com";

interface Call {
	url: string;
	method: string;
	body: unknown;
}

let dir = "";
let noStore = "";

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "ragflow-cli-"));
	noStore = join(dir, "no-store.json");
});

afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
});

function fakeFetch(handler: (call: Call) => Response | Promise<Response>): { fetch: typeof fetch; calls: Call[] } {
	const calls: Call[] = [];
	const impl = (async (input: string | URL | Request, init?: RequestInit) => {
		const call: Call = {
			url: String(input),
			method: init?.method ?? "GET",
			body: typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined,
		};
		calls.push(call);
		return handler(call);
	}) as typeof fetch;
	return { fetch: impl, calls };
}

function config(overrides: Partial<RagflowConfig> = {}): RagflowConfig {
	return { ...DEFAULT_RAGFLOW_CONFIG, datasetIds: [], enabled: true, url: URL_BASE, topK: 4, similarityThreshold: 0.3, ...overrides };
}

function deps(fetchImpl: typeof fetch | undefined, overrides: Partial<CommandDeps> = {}): CommandDeps {
	return { cwd: dir, env: { RAGFLOW_API_KEY: KEY }, storePath: noStore, fetch: fetchImpl, config: config(), ...overrides };
}

function twelveMs(): () => number {
	const ticks = [0, 12];
	return () => ticks.shift() ?? 12;
}

const wireChunk = (id: string, content: string, name?: string, similarity?: number) => ({ id, content, document_keyword: name, similarity });

describe("ragflow check", () => {
	test("healthy: one health request, dataset count and elapsed time, exit 0", async () => {
		const { fetch, calls } = fakeFetch(() => Response.json({ code: 0, data: [{ id: "a", name: "A" }], total: 3 }));
		const result = await runRagflowCommand(["check"], deps(fetch, { now: twelveMs() }));
		expect(result).toEqual({ code: 0, text: "RAGFlow check: ok · 3 dataset(s) · 12 ms" });
		expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([`GET ${URL_BASE}/api/v1/datasets?page=1&page_size=1`]);
	});

	test("--json", async () => {
		const { fetch } = fakeFetch(() => Response.json({ code: 0, data: [], total: 3 }));
		const result = await runRagflowCommand(["check", "--json"], deps(fetch, { now: twelveMs() }));
		expect(result.code).toBe(0);
		expect(JSON.parse(result.text)).toEqual({ ok: true, datasets: 3, ms: 12 });
	});

	test("a failure names the kind and message, exits 1 and never prints the key", async () => {
		const { fetch } = fakeFetch(() => Response.json({ code: 109, message: `invalid key ${KEY}` }));
		const result = await runRagflowCommand(["check"], deps(fetch));
		expect(result.code).toBe(1);
		expect(result.text.startsWith("RAGFlow check: error (auth) · ragflow auth: ")).toBe(true);
		expect(result.text).not.toContain(KEY);
		const json = await runRagflowCommand(["check", "--json"], deps(fetch));
		expect(json.code).toBe(1);
		expect(JSON.parse(json.text)).toMatchObject({ ok: false, error: { kind: "auth", code: 109 } });
		expect(json.text).not.toContain(KEY);
	});

	test("an unreachable server is an error with exit 1", async () => {
		const { fetch } = fakeFetch(() => {
			throw new Error("connect ECONNREFUSED");
		});
		const result = await runRagflowCommand(["check"], deps(fetch));
		expect(result.code).toBe(1);
		expect(result.text).toContain("RAGFlow check: error (network)");
	});

	test("a timeout names the kind, exits 1 and never prints the key", async () => {
		const { fetch } = fakeFetch(() => new Promise<Response>(() => {}));
		const result = await runRagflowCommand(["check"], deps(fetch, { config: config({ timeoutMs: 25 }) }));
		expect(result.code).toBe(1);
		expect(result.text).toContain("RAGFlow check: error (timeout)");
		expect(result.text).not.toContain(KEY);
	});

	test("an API error exits 1 without the key", async () => {
		const { fetch } = fakeFetch(() => new Response("", { status: 500 }));
		const result = await runRagflowCommand(["check"], deps(fetch));
		expect(result.code).toBe(1);
		expect(result.text).toContain("RAGFlow check: error (server)");
		expect(result.text).not.toContain(KEY);
	});

	test("not ready: the reason, exit 1, and no request", async () => {
		const { fetch, calls } = fakeFetch(() => Response.json({ code: 0, data: [], total: 0 }));
		const disabled = await runRagflowCommand(["check"], deps(fetch, { config: config({ enabled: false }) }));
		expect(disabled).toEqual({ code: 1, text: "RAGFlow check: off (opt-in: set ragflow.enabled)" });
		const killed = await runRagflowCommand(["check"], deps(fetch, { env: { RAGFLOW_API_KEY: KEY, ULTRATHINK_RAGFLOW: "0" } }));
		expect(killed).toEqual({ code: 1, text: "RAGFlow check: off (ULTRATHINK_RAGFLOW=0)" });
		const noKey = await runRagflowCommand(["check"], deps(fetch, { env: {} }));
		expect(noKey.code).toBe(1);
		expect(noKey.text).toContain("no key");
		expect(noKey.text).toContain("auth set-key ragflow");
		const badUrl = await runRagflowCommand(["check"], deps(fetch, { config: config({ url: "http://rag.example.com" }) }));
		expect(badUrl.code).toBe(1);
		expect(badUrl.text).toContain("bad URL");
		const json = await runRagflowCommand(["check", "--json"], deps(fetch, { config: config({ enabled: false }) }));
		expect(JSON.parse(json.text)).toEqual({ ok: false, error: { kind: "not-ready", message: "off (opt-in: set ragflow.enabled)" } });
		expect(calls).toHaveLength(0);
	});

	test("without an injected config it is loaded from the user config file", async () => {
		const xdg = join(dir, "xdg");
		mkdirSync(join(xdg, "ultrathink"), { recursive: true });
		writeFileSync(join(xdg, "ultrathink", "config.json"), JSON.stringify({ ragflow: { enabled: true, url: "https://loaded.example.com" } }));
		const { fetch, calls } = fakeFetch(() => Response.json({ code: 0, data: [], total: 1 }));
		const env = { RAGFLOW_API_KEY: KEY, XDG_CONFIG_HOME: xdg, CLAUDE_CONFIG_DIR: join(dir, "claude") };
		const result = await runRagflowCommand(["check"], { cwd: dir, env, storePath: noStore, fetch, now: twelveMs() });
		expect(result.text).toBe("RAGFlow check: ok · 1 dataset(s) · 12 ms");
		expect(calls[0]?.url.startsWith("https://loaded.example.com/")).toBe(true);
	});
});

describe("ragflow datasets", () => {
	test("prints an id / name / documents / chunks table", async () => {
		const { fetch, calls } = fakeFetch(() =>
			Response.json({
				code: 0,
				data: [
					{ id: "ds-1", name: "Alpha", document_count: 2, chunk_count: 30 },
					{ id: "ds-long-identifier", name: "Beta" },
				],
				total: 2,
			}),
		);
		const result = await runRagflowCommand(["datasets"], deps(fetch));
		expect(result.code).toBe(0);
		const lines = result.text.split("\n");
		expect(lines).toHaveLength(3);
		expect(lines[0]).toMatch(/^id\s+name\s+documents\s+chunks$/);
		expect(lines[1]).toMatch(/^ds-1\s+Alpha\s+2\s+30$/);
		expect(lines[2]).toMatch(/^ds-long-identifier\s+Beta\s+-\s+-$/);
		expect(calls.map((c) => c.url)).toEqual([`${URL_BASE}/api/v1/datasets?page=1&page_size=100`]);
	});

	test("--json and the empty case", async () => {
		const some = fakeFetch(() => Response.json({ code: 0, data: [{ id: "ds-1", name: "Alpha", chunk_count: 5 }], total: 1 }));
		const json = await runRagflowCommand(["datasets", "--json"], deps(some.fetch));
		expect(JSON.parse(json.text)).toEqual({ ok: true, datasets: [{ id: "ds-1", name: "Alpha", chunkCount: 5 }] });
		const none = fakeFetch(() => Response.json({ code: 0, data: [], total: 0 }));
		expect(await runRagflowCommand(["datasets"], deps(none.fetch))).toEqual({ code: 0, text: "RAGFlow datasets: none visible to this key" });
	});

	test("a failure exits 1", async () => {
		const { fetch } = fakeFetch(() => new Response("", { status: 500 }));
		const result = await runRagflowCommand(["datasets"], deps(fetch));
		expect(result.code).toBe(1);
		expect(result.text).toContain("RAGFlow datasets: error (server)");
	});

	test("auth and timeout failures exit 1 without the key", async () => {
		const denied = fakeFetch(() => Response.json({ code: 109, message: `invalid key ${KEY}` }));
		const auth = await runRagflowCommand(["datasets"], deps(denied.fetch));
		expect(auth.code).toBe(1);
		expect(auth.text).toContain("RAGFlow datasets: error (auth)");
		expect(auth.text).not.toContain(KEY);

		const hanging = fakeFetch(() => new Promise<Response>(() => {}));
		const timeout = await runRagflowCommand(["datasets"], deps(hanging.fetch, { config: config({ timeoutMs: 25 }) }));
		expect(timeout.code).toBe(1);
		expect(timeout.text).toContain("RAGFlow datasets: error (timeout)");
		expect(timeout.text).not.toContain(KEY);
	});

	test("not ready exits 1 without a request", async () => {
		const { fetch, calls } = fakeFetch(() => Response.json({ code: 0, data: [] }));
		const result = await runRagflowCommand(["datasets"], deps(fetch, { env: {} }));
		expect(result.code).toBe(1);
		expect(result.text).toContain("RAGFlow datasets: on · no key");
		expect(calls).toHaveLength(0);
	});
});

describe("ragflow search", () => {
	const hits = [wireChunk("c1", "low  scoring\nexcerpt", "notes.md", 0.5), wireChunk("c2", "top excerpt", "guide.md", 0.91), wireChunk("c3", "unscored text")];

	test("configured datasets: request body, lines ordered by similarity", async () => {
		const { fetch, calls } = fakeFetch(() => Response.json({ code: 0, data: { chunks: hits } }));
		const result = await runRagflowCommand(["search", QUESTION], deps(fetch, { config: config({ datasetIds: ["cfg1"] }) }));
		expect(result.code).toBe(0);
		expect(result.text.split("\n")).toEqual(["0.91  guide.md: top excerpt", "0.50  notes.md: low scoring excerpt", "n/a   document: unscored text"]);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.method).toBe("POST");
		expect(calls[0]?.url).toBe(`${URL_BASE}/api/v1/retrieval`);
		expect(calls[0]?.body).toMatchObject({ question: QUESTION, dataset_ids: ["cfg1"], page_size: 4, similarity_threshold: 0.3 });
		expect(result.text).not.toContain(KEY);
	});

	test("--dataset (repeatable) and --limit override the config", async () => {
		const { fetch, calls } = fakeFetch(() => Response.json({ code: 0, data: { chunks: hits } }));
		const result = await runRagflowCommand(
			["search", QUESTION, "--dataset", "a", "--dataset", "b", "--limit", "7"],
			deps(fetch, { config: config({ datasetIds: ["cfg1"] }) }),
		);
		expect(result.code).toBe(0);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.body).toMatchObject({ dataset_ids: ["a", "b"], page_size: 7 });
	});

	test("flags may precede the question", async () => {
		const { fetch, calls } = fakeFetch(() => Response.json({ code: 0, data: { chunks: [] } }));
		await runRagflowCommand(["search", "--dataset", "a", QUESTION], deps(fetch));
		expect(calls[0]?.body).toMatchObject({ question: QUESTION, dataset_ids: ["a"] });
	});

	test("with no datasets configured or given, every dataset is listed first", async () => {
		const { fetch, calls } = fakeFetch((call) =>
			call.method === "GET" ? Response.json({ code: 0, data: [{ id: "x1", name: "X" }, { id: "x2", name: "Y" }], total: 2 }) : Response.json({ code: 0, data: { chunks: hits } }),
		);
		const result = await runRagflowCommand(["search", QUESTION], deps(fetch));
		expect(result.code).toBe(0);
		expect(calls.map((c) => c.method)).toEqual(["GET", "POST"]);
		expect(calls[1]?.body).toMatchObject({ dataset_ids: ["x1", "x2"] });
	});

	test("nothing to search is a failure; no matches is not", async () => {
		const none = fakeFetch(() => Response.json({ code: 0, data: [], total: 0 }));
		expect(await runRagflowCommand(["search", QUESTION], deps(none.fetch))).toEqual({ code: 1, text: "RAGFlow search: no datasets to search" });
		expect(none.calls).toHaveLength(1);
		const empty = fakeFetch(() => Response.json({ code: 0, data: { chunks: [] } }));
		expect(await runRagflowCommand(["search", QUESTION, "--dataset", "a"], deps(empty.fetch))).toEqual({ code: 0, text: "RAGFlow search: no matches" });
	});

	test("--json lists the chunks in similarity order", async () => {
		const { fetch } = fakeFetch(() => Response.json({ code: 0, data: { chunks: hits } }));
		const result = await runRagflowCommand(["search", QUESTION, "--dataset", "a", "--json"], deps(fetch));
		const parsed = JSON.parse(result.text) as { ok: boolean; count: number; chunks: Array<{ id: string; content: string; documentName?: string; similarity?: number }> };
		expect(parsed.ok).toBe(true);
		expect(parsed.count).toBe(3);
		expect(parsed.chunks.map((c) => c.id)).toEqual(["c2", "c1", "c3"]);
		expect(parsed.chunks[0]).toMatchObject({ content: "top excerpt", documentName: "guide.md", similarity: 0.91 });
	});

	test("a failure exits 1 without the key or the question", async () => {
		const { fetch } = fakeFetch(() => Response.json({ code: 109, message: `denied ${KEY} for "${QUESTION}"` }));
		const result = await runRagflowCommand(["search", QUESTION, "--dataset", "a"], deps(fetch));
		expect(result.code).toBe(1);
		expect(result.text).toContain("RAGFlow search: error (auth)");
		expect(result.text).not.toContain(KEY);
		expect(result.text).not.toContain(QUESTION);
	});

	test("timeout and API failures exit 1 without the key or the question", async () => {
		const hanging = fakeFetch(() => new Promise<Response>(() => {}));
		const timeout = await runRagflowCommand(["search", QUESTION, "--dataset", "a"], deps(hanging.fetch, { config: config({ datasetIds: ["a"], timeoutMs: 25 }) }));
		expect(timeout.code).toBe(1);
		expect(timeout.text).toContain("RAGFlow search: error (timeout)");
		expect(timeout.text).not.toContain(KEY);
		expect(timeout.text).not.toContain(QUESTION);

		const broken = fakeFetch(() => new Response("", { status: 500 }));
		const api = await runRagflowCommand(["search", QUESTION, "--dataset", "a"], deps(broken.fetch));
		expect(api.code).toBe(1);
		expect(api.text).toContain("RAGFlow search: error (server)");
		expect(api.text).not.toContain(KEY);
		expect(api.text).not.toContain(QUESTION);
	});

	test("not ready exits 1 without a request", async () => {
		const { fetch, calls } = fakeFetch(() => Response.json({ code: 0, data: { chunks: [] } }));
		const result = await runRagflowCommand(["search", QUESTION], deps(fetch, { config: config({ enabled: false }) }));
		expect(result).toEqual({ code: 1, text: "RAGFlow search: off (opt-in: set ragflow.enabled)" });
		expect(calls).toHaveLength(0);
	});
});

describe("request paths", () => {
	test("check, datasets and search never request a healthz URL; check uses the one-row datasets probe", async () => {
		const seen: string[] = [];
		const listing = () => Response.json({ code: 0, data: [{ id: "d1", name: "D" }], total: 1 });
		const checkServer = fakeFetch((call) => {
			seen.push(call.url);
			return listing();
		});
		const checkResult = await runRagflowCommand(["check"], deps(checkServer.fetch));
		expect(checkResult.code).toBe(0);
		expect(checkServer.calls.map((c) => `${c.method} ${c.url}`)).toEqual([`GET ${URL_BASE}/api/v1/datasets?page=1&page_size=1`]);

		const datasetsServer = fakeFetch((call) => {
			seen.push(call.url);
			return listing();
		});
		expect((await runRagflowCommand(["datasets"], deps(datasetsServer.fetch))).code).toBe(0);

		const searchServer = fakeFetch((call) => {
			seen.push(call.url);
			return call.method === "GET" ? listing() : Response.json({ code: 0, data: { chunks: [] } });
		});
		expect((await runRagflowCommand(["search", QUESTION], deps(searchServer.fetch))).code).toBe(0);

		expect(seen.length).toBeGreaterThan(0);
		expect(seen.some((url) => url.includes("healthz"))).toBe(false);
	});
});

describe("usage errors", () => {
	const cases: string[][] = [
		[],
		["bogus"],
		["check", "--nope"],
		["check", "extra"],
		["datasets", "--limit", "3"],
		["datasets", "--dataset", "a"],
		["search"],
		["search", ""],
		["search", "   "],
		["search", "one", "two"],
		["search", "q", "--limit", "0"],
		["search", "q", "--limit", "x"],
		["search", "q", "--limit", "101"],
		["search", "q", "--limit"],
		["search", "q", "--dataset"],
		["search", "q", "--dataset", "--json"],
		["search", "q", "--wat"],
	];

	for (const argv of cases) {
		test(`ultrathink ragflow ${JSON.stringify(argv)} -> usage, exit 2, no request`, async () => {
			const { fetch, calls } = fakeFetch(() => Response.json({ code: 0, data: [] }));
			const result = await runRagflowCommand(argv, deps(fetch, { config: config({ enabled: false }) }));
			expect(result.code).toBe(2);
			expect(result.text.startsWith("Usage: ultrathink ragflow")).toBe(true);
			expect(calls).toHaveLength(0);
		});
	}
});
