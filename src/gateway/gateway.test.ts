// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, mergeConfig } from "../config.ts";
import { hindsightStatusLine, resolveHindsight } from "../hindsight/settings.ts";
import { ragflowStatusLine, resolveRagflow } from "../ragflow/settings.ts";
import { emitEvent, fetchBrief } from "../substrate/brief.ts";
import { DEFAULT_HINDSIGHT_CONFIG } from "../hindsight/types.ts";
import { DEFAULT_RAGFLOW_CONFIG } from "../ragflow/types.ts";

/** Argument keys allowed by contracts/tool-rosters/_core.yaml (additionalProperties false). */
const TOOL_KEYS: Record<string, readonly string[]> = {
	desk_memory_recall: ["query", "limit", "include_shared"],
	desk_memory_retain: ["content", "receipt_path", "source", "graph_id", "task_id", "tags"],
	desk_docs_search: ["query", "repo", "limit"],
	desk_brief: ["graph_id", "task_id", "refresh"],
	desk_event_emit: ["kind", "graph_id", "task_id", "payload"],
};

const GATEWAY = { url: "https://gateway.example/desk", seat: "lead", timeoutMs: 8_000 };
const TOKEN = "seat-token-value";
const HS_KEY = "hindsight-key-should-not-be-read";
const RF_KEY = "ragflow-key-should-not-be-read";
const GRAPH = "ut-mv10s1se-50878383";

interface Sent {
	url: string;
	headers: Record<string, string>;
	body: { method?: string; params?: { name?: string; arguments?: Record<string, unknown> } };
}

function headerRecord(headers: RequestInit["headers"]): Record<string, string> {
	const out: Record<string, string> = {};
	if (!headers) return out;
	if (headers instanceof Headers || Array.isArray(headers)) {
		for (const [key, value] of headers) out[key] = value;
		return out;
	}
	for (const [key, value] of Object.entries(headers)) out[key] = Array.isArray(value) ? value.join(",") : String(value);
	return out;
}

function trackedEnv(values: Record<string, string | undefined>): { env: NodeJS.ProcessEnv; seen: Set<string> } {
	const seen = new Set<string>();
	const env = new Proxy(values, {
		get(target, prop, receiver) {
			if (typeof prop === "string") seen.add(prop);
			return Reflect.get(target, prop, receiver);
		},
	}) as NodeJS.ProcessEnv;
	return { env, seen };
}

function storeWith(token: string): string {
	const dir = mkdtempSync(join(tmpdir(), "ut-gw-"));
	const path = join(dir, "mcp-credentials.json");
	const providers = token
		? { "desk-gateway": { kind: "api_key", apiKey: token, updatedAt: 1 } }
		: {};
	writeFileSync(path, JSON.stringify({ version: 1, providers }));
	return path;
}

function scripted(handler: (sent: Sent) => Response | Promise<Response>): { fetch: typeof fetch; sent: Sent[] } {
	const sent: Sent[] = [];
	const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
		const headers = headerRecord(init?.headers);
		const body = JSON.parse(String(init?.body ?? "{}")) as Sent["body"];
		const item = { url: String(input), headers, body };
		sent.push(item);
		return handler(item);
	}) as typeof fetch;
	return { fetch: fetchImpl, sent };
}

function toolReply(payload: unknown, isError = false): Response {
	return new Response(
		JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			result: { content: [{ type: "text", text: JSON.stringify(payload) }], isError },
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
}

function expectTool(sent: Sent, name: string): Record<string, unknown> {
	expect(sent.url).toBe("https://gateway.example/desk/mcp/lead");
	expect(sent.headers.Authorization).toBe(`Bearer ${TOKEN}`);
	expect(JSON.stringify(sent.headers)).not.toContain(HS_KEY);
	expect(JSON.stringify(sent.headers)).not.toContain(RF_KEY);
	expect(sent.body.method).toBe("tools/call");
	expect(sent.body.params?.name).toBe(name);
	const args = sent.body.params?.arguments ?? {};
	for (const key of Object.keys(args)) expect(TOOL_KEYS[name]).toContain(key);
	return args;
}

const hindsightOn = { ...DEFAULT_HINDSIGHT_CONFIG, enabled: true, backend: "gateway" as const };
const ragflowOn = { ...DEFAULT_RAGFLOW_CONFIG, enabled: true, ground: true, backend: "gateway" as const };

describe("gateway backend", () => {
	test("recall and retain send desk tools and never read a Hindsight or RAGFlow key", async () => {
		const { env, seen } = trackedEnv({
			HINDSIGHT_API_KEY: HS_KEY,
			HINDSIGHT_API_TOKEN: "token-also-unread",
			RAGFLOW_API_KEY: RF_KEY,
			DESK_GATEWAY_TOKEN: TOKEN,
		});
		const recallFetch = scripted(() =>
			toolReply({
				banks: ["pd-lead"],
				results: [{ bank: "pd-lead", ok: true, status: "ok", body: { results: [{ id: "m1", text: "a remembered fact", tags: ["seat:lead"] }] } }],
			}),
		);
		const resolution = resolveHindsight(hindsightOn, env, { storePath: storeWith(""), fetch: recallFetch.fetch, gateway: GATEWAY });
		expect(resolution.readiness).toMatchObject({ state: "ready", backend: "gateway", seat: "lead", tokenSource: "DESK_GATEWAY_TOKEN" });
		const recalled = await resolution.client?.recall({ query: "remembered fact", maxTokens: 800 });
		expect(recalled).toEqual({ ok: true, value: [{ id: "m1", text: "a remembered fact", tags: ["seat:lead"], metadata: {} }] });
		const recallArgs = expectTool(recallFetch.sent[0]!, "desk_memory_recall");
		expect(recallArgs).toEqual({ query: "remembered fact", include_shared: true, limit: 2 });

		const retainFetch = scripted(() => toolReply({ ok: true, bank: "pd-lead" }));
		const retain = await resolveHindsight(hindsightOn, env, { fetch: retainFetch.fetch, gateway: GATEWAY }).client?.retain({
			documentId: "doc-1",
			content: "kept this decision",
			tags: ["plan"],
			metadata: { graph_id: GRAPH },
		});
		expect(retain?.ok).toBe(true);
		const retainArgs = expectTool(retainFetch.sent[0]!, "desk_memory_retain");
		expect(retainArgs.content).toBe("kept this decision");
		expect(retainArgs.graph_id).toBe(GRAPH);
		expect(retainArgs.source).toBe("https://example.com/ultrathink/documents/doc-1");
		expect(retainArgs).not.toHaveProperty("receipt_path");
		expect(seen.has("HINDSIGHT_API_KEY")).toBe(false);
		expect(seen.has("HINDSIGHT_API_TOKEN")).toBe(false);
		expect(seen.has("RAGFLOW_API_KEY")).toBe(false);
	});

	test("document search uses desk_docs_search and does not send dataset ids or a RAGFlow key", async () => {
		const { env, seen } = trackedEnv({ RAGFLOW_API_KEY: RF_KEY, HINDSIGHT_API_KEY: HS_KEY, DESK_GATEWAY_TOKEN: TOKEN });
		const fetchImpl = scripted(() =>
			toolReply({ results: [{ content: "a chunk", document: "docs/readme.md", dataset_id: "ds", score: 0.4 }] }),
		);
		const resolution = resolveRagflow(ragflowOn, env, { fetch: fetchImpl.fetch, gateway: GATEWAY });
		const found = await resolution.client?.retrieve({ question: "where is the brief", datasetIds: ["should-not-be-sent"], topK: 5 });
		expect(found).toMatchObject({ ok: true, value: [{ content: "a chunk", documentName: "docs/readme.md", datasetId: "ds", similarity: 0.4 }] });
		expect(expectTool(fetchImpl.sent[0]!, "desk_docs_search")).toEqual({ query: "where is the brief", limit: 5 });
		expect(seen.has("RAGFLOW_API_KEY")).toBe(false);
		expect(seen.has("HINDSIGHT_API_KEY")).toBe(false);
	});

	test("brief and events use desk_brief and desk_event_emit", async () => {
		const env = { DESK_GATEWAY_TOKEN: TOKEN };
		const binding = { backend: "gateway" as const, gateway: GATEWAY };
		const briefFetch = scripted(() => toolReply({ substrate: { ok: true, brief: "other agents already landed the cache" } }));
		const brief = await fetchBrief({ repo: "swcstudiospace/claude-ultrathink", graphId: GRAPH }, env, "", { ...binding, fetch: briefFetch.fetch });
		expect(brief).toBe("other agents already landed the cache");
		expect(expectTool(briefFetch.sent[0]!, "desk_brief")).toEqual({ graph_id: GRAPH });

		const emitFetch = scripted(() => toolReply({ ok: true }));
		expect(await emitEvent({ kind: "note", summary: "planned", graphId: "not a graph id" }, env, "", undefined, { ...binding, fetch: emitFetch.fetch })).toBe(true);
		const args = expectTool(emitFetch.sent[0]!, "desk_event_emit");
		expect(args.kind).toBe("note");
		expect(args).not.toHaveProperty("graph_id");
		expect(args.payload).toEqual({ summary: "planned" });
	});

	test("not_configured, error/reason, unknown_tool and timeouts degrade without throwing", async () => {
		const env = { DESK_GATEWAY_TOKEN: TOKEN };
		const cases = [
			{ payload: { error: "not_configured", reason: "hindsight is not configured on the gateway" }, isError: false, message: "not_configured" },
			{ payload: { error: "upstream_error", reason: "hindsight returned HTTP 503" }, isError: false, message: "upstream_error" },
			{ payload: { error: "unknown_tool", reason: "desk_memory_recall is not on the lead roster" }, isError: true, message: "unknown_tool" },
		];
		for (const item of cases) {
			const fetchImpl = scripted(() => toolReply(item.payload, item.isError));
			const result = await resolveHindsight(hindsightOn, env, { fetch: fetchImpl.fetch, gateway: GATEWAY }).client?.recall({ query: "hello" });
			expect(result?.ok).toBe(false);
			if (result?.ok === false) {
				expect(result.error.message).toContain(item.message);
				expect(result.error.message).not.toContain(TOKEN);
			}
		}
		const slow = (async (_input: string | URL | Request, init?: RequestInit) => {
			await new Promise((_resolve, reject) => {
				const onAbort = (): void => reject(Object.assign(new Error("aborted"), { name: "TimeoutError" }));
				if (init?.signal?.aborted) onAbort();
				init?.signal?.addEventListener("abort", onAbort, { once: true });
			});
			return new Response("late");
		}) as typeof fetch;
		const timed = await resolveHindsight(hindsightOn, env, { fetch: slow, gateway: { ...GATEWAY, timeoutMs: 30 } }).client?.recall({ query: "hello" });
		expect(timed?.ok).toBe(false);
		if (timed?.ok === false) expect(timed.error.kind).toBe("timeout");
	});

	test("a gateway error that echoes the token is redacted", async () => {
		const env = { DESK_GATEWAY_TOKEN: TOKEN };
		const fetchImpl = scripted(() => toolReply({ error: "upstream_error", reason: `refused ${TOKEN}` }));
		const result = await resolveRagflow(ragflowOn, env, { fetch: fetchImpl.fetch, gateway: GATEWAY }).client?.retrieve({
			question: "docs",
			datasetIds: [],
		});
		expect(result?.ok).toBe(false);
		if (result?.ok === false) expect(result.error.message).not.toContain(TOKEN);
	});

	test("ULTRATHINK_GATEWAY=0 forces the direct client and status lines stay the direct wording", async () => {
		const env = { ULTRATHINK_GATEWAY: "0", HINDSIGHT_API_KEY: HS_KEY, RAGFLOW_API_KEY: RF_KEY };
		const direct = scripted(() => new Response(JSON.stringify({ results: [] }), { status: 200 }));
		const resolution = resolveHindsight(
			{ ...hindsightOn, url: "https://hs.example.test" },
			env,
			{ fetch: direct.fetch, gateway: GATEWAY },
		);
		expect(resolution.readiness).toMatchObject({ state: "ready", bank: "ultrathink", keySource: "HINDSIGHT_API_KEY" });
		expect(resolution.readiness).not.toHaveProperty("backend");
		await resolution.client?.recall({ query: "q" });
		expect(direct.sent[0]?.url).toContain("/v1/default/banks/");
		expect(direct.sent[0]?.url).not.toContain("/mcp/");
		expect(hindsightStatusLine({ ...hindsightOn, url: "https://hs.example.test" }, env, storeWith(TOKEN), GATEWAY)).toBe(
			"Hindsight: on · https://hs.example.test · bank ultrathink · key from HINDSIGHT_API_KEY",
		);
		expect(ragflowStatusLine({ ...ragflowOn, url: "https://rag.example.test" }, env, storeWith(TOKEN), GATEWAY)).toContain("RAGFlow: on ·");
	});

	test("status names backend, readiness and reason, and a project file cannot retarget the gateway", () => {
		const env = { DESK_GATEWAY_TOKEN: TOKEN };
		expect(hindsightStatusLine(hindsightOn, env, undefined, GATEWAY)).toBe(
			"Hindsight: gateway · ready · https://gateway.example · seat lead · token from DESK_GATEWAY_TOKEN",
		);
		expect(hindsightStatusLine(hindsightOn, {}, undefined, GATEWAY)).toBe(
			"Hindsight: gateway · unready · no token (set DESK_GATEWAY_TOKEN or store a desk-gateway credential)",
		);
		expect(ragflowStatusLine(ragflowOn, env, undefined, GATEWAY)).toContain("RAGFlow: gateway · ready ·");
		const user = mergeConfig(
			{ hindsight: { enabled: true, backend: "gateway" }, ragflow: { enabled: true, backend: "gateway" }, substrate: { backend: "gateway" }, gateway: GATEWAY },
			defaultConfig(),
		);
		expect(user.hindsight.backend).toBe("gateway");
		expect(user.substrate.backend).toBe("gateway");
		const project = mergeConfig(
			{ hindsight: { backend: "direct", url: "https://evil.example" }, gateway: { url: "https://evil.example", seat: "other" }, substrate: { backend: "direct" } },
			user,
			{ project: true },
		);
		expect(project.hindsight.backend).toBe("gateway");
		expect(project.hindsight.url).toBe("");
		expect(project.gateway).toEqual(GATEWAY);
		expect(project.substrate.backend).toBe("gateway");
		expect(JSON.stringify(project)).not.toContain("evil");
	});

	test("a stored desk-gateway oauth token is used and the direct defaults omit backend", () => {
		expect(defaultConfig().hindsight).not.toHaveProperty("backend");
		expect(defaultConfig().ragflow).not.toHaveProperty("backend");
		expect(defaultConfig().substrate).toEqual({ url: "" });
		const dir = mkdtempSync(join(tmpdir(), "ut-gw-oauth-"));
		const path = join(dir, "mcp-credentials.json");
		writeFileSync(
			path,
			JSON.stringify({
				version: 1,
				providers: {
					"desk-gateway": {
						kind: "oauth",
						client: { clientId: "c", redirectUri: "http://127.0.0.1", issuer: "https://gateway.example", authorizationEndpoint: "https://gateway.example/a", tokenEndpoint: "https://gateway.example/t", registeredAt: 1 },
						tokens: { accessToken: TOKEN },
						updatedAt: 1,
					},
				},
			}),
		);
		const resolution = resolveHindsight(hindsightOn, { HINDSIGHT_API_KEY: HS_KEY }, { storePath: path, gateway: GATEWAY });
		expect(resolution.readiness).toMatchObject({ state: "ready", tokenSource: "store" });
	});
});
