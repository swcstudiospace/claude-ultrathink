// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ragflowStatusLine, resolveRagflow, resolveRagflowKey } from "./settings.ts";
import { DEFAULT_RAGFLOW_CONFIG, type RagflowConfig } from "./types.ts";

const STORED = "rf-stored-KEY-0123456789";
const ENV_KEY = "rf-env-KEY-9876543210";

let dir = "";
let withKey = "";
let oauthOnly = "";
let missing = "";
let garbage = "";

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "ragflow-settings-"));
	withKey = join(dir, "with-key.json");
	oauthOnly = join(dir, "oauth.json");
	missing = join(dir, "missing.json");
	garbage = join(dir, "garbage.json");
	writeFileSync(withKey, JSON.stringify({ version: 1, providers: { ragflow: { kind: "api_key", apiKey: `  ${STORED}  `, updatedAt: 1 } } }));
	writeFileSync(oauthOnly, JSON.stringify({ version: 1, providers: { ragflow: { kind: "oauth", updatedAt: 1 }, openrouter: { kind: "api_key", apiKey: "sk-or-other", updatedAt: 1 } } }));
	writeFileSync(garbage, "{ not json");
});

afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
});

function config(overrides: Partial<RagflowConfig> = {}): RagflowConfig {
	return { ...DEFAULT_RAGFLOW_CONFIG, datasetIds: [], enabled: true, url: "https://rag.example.com", ...overrides };
}

describe("resolveRagflowKey", () => {
	test("the stored key wins over the environment and is trimmed", () => {
		expect(resolveRagflowKey(withKey, { RAGFLOW_API_KEY: ENV_KEY })).toEqual({ key: STORED, source: "store" });
	});

	test("RAGFLOW_API_KEY is the fallback and is trimmed", () => {
		expect(resolveRagflowKey(missing, { RAGFLOW_API_KEY: `  ${ENV_KEY}\n` })).toEqual({ key: ENV_KEY, source: "RAGFLOW_API_KEY" });
	});

	test("no store entry and no env key is undefined; blank env values do not count", () => {
		expect(resolveRagflowKey(missing, {})).toBeUndefined();
		expect(resolveRagflowKey(missing, { RAGFLOW_API_KEY: "   " })).toBeUndefined();
	});

	test("a non-api-key credential or an unreadable store falls through to the environment", () => {
		expect(resolveRagflowKey(oauthOnly, { RAGFLOW_API_KEY: ENV_KEY })?.source).toBe("RAGFLOW_API_KEY");
		expect(resolveRagflowKey(oauthOnly, {})).toBeUndefined();
		expect(resolveRagflowKey(garbage, { RAGFLOW_API_KEY: ENV_KEY })?.source).toBe("RAGFLOW_API_KEY");
	});

	test("another provider's key is never used", () => {
		expect(resolveRagflowKey(oauthOnly, { OPENROUTER_API_KEY: "sk-or-x" })).toBeUndefined();
	});

	test("without an explicit store path the store location follows the environment", () => {
		expect(resolveRagflowKey(undefined, { ULTRATHINK_MCP_STORE: withKey })).toEqual({ key: STORED, source: "store" });
	});
});

describe("resolveRagflow readiness", () => {
	const env = { RAGFLOW_API_KEY: ENV_KEY };

	test("the kill switch beats everything, including an enabled config", () => {
		expect(resolveRagflow(config(), { ...env, ULTRATHINK_RAGFLOW: "0" }, { storePath: missing })).toEqual({
			readiness: { state: "off", reason: "killed" },
		});
		expect(resolveRagflow(config({ enabled: false }), { ULTRATHINK_RAGFLOW: "0" }, { storePath: missing }).readiness).toEqual({ state: "off", reason: "killed" });
	});

	test("any other kill value does not kill", () => {
		expect(resolveRagflow(config(), { ...env, ULTRATHINK_RAGFLOW: "1" }, { storePath: missing }).readiness.state).toBe("ready");
	});

	test("disabled by default, with no client", () => {
		const resolved = resolveRagflow({ ...DEFAULT_RAGFLOW_CONFIG, url: "https://rag.example.com" }, env, { storePath: missing });
		expect(resolved).toEqual({ readiness: { state: "off", reason: "disabled" } });
		expect(resolved.client).toBeUndefined();
	});

	test("no URL anywhere is unready", () => {
		expect(resolveRagflow(config({ url: "  " }), env, { storePath: missing }).readiness).toEqual({ state: "unready", reason: "no-url" });
	});

	test("RAGFLOW_URL fills in an empty config URL; the config URL wins when both are set", () => {
		const fromEnv = resolveRagflow(config({ url: "" }), { ...env, RAGFLOW_URL: "https://env.example.com/rf/" }, { storePath: missing });
		expect(fromEnv.readiness).toEqual({ state: "ready", url: "https://env.example.com/rf", keySource: "RAGFLOW_API_KEY" });
		const both = resolveRagflow(config({ url: "https://cfg.example.com" }), { ...env, RAGFLOW_URL: "https://env.example.com" }, { storePath: missing });
		expect(both.readiness).toMatchObject({ state: "ready", url: "https://cfg.example.com" });
	});

	test("a URL the key may not travel to is unready with the reason", () => {
		const resolved = resolveRagflow(config({ url: "http://rag.example.com" }), env, { storePath: missing });
		expect(resolved.readiness.state).toBe("unready");
		if (resolved.readiness.state === "unready") {
			expect(resolved.readiness.reason).toBe("bad-url");
			expect(resolved.readiness.detail).toContain("http is allowed only for");
		}
		expect(resolved.client).toBeUndefined();
		expect(resolveRagflow(config({ url: "https://user:pw@rag.example.com" }), env, { storePath: missing }).readiness).toMatchObject({ reason: "bad-url" });
		expect(resolveRagflow(config({ url: "not a url" }), env, { storePath: missing }).readiness).toMatchObject({ reason: "bad-url" });
	});

	test("a good URL without a key is unready", () => {
		expect(resolveRagflow(config(), {}, { storePath: missing }).readiness).toEqual({ state: "unready", reason: "no-key" });
	});

	test("loopback and tailnet http URLs are ready", () => {
		expect(resolveRagflow(config({ url: "http://127.0.0.1:9380" }), env, { storePath: missing }).readiness.state).toBe("ready");
		expect(resolveRagflow(config({ url: "http://rag.tail1234.ts.net" }), env, { storePath: missing }).readiness.state).toBe("ready");
	});

	test("ready reports the key source and the client uses the injected fetch with the resolved key", async () => {
		const seen: Array<{ url: string; auth: string | null }> = [];
		const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
			seen.push({ url: String(input), auth: new Headers(init?.headers).get("authorization") });
			return Response.json({ code: 0, data: [], total: 7 });
		}) as typeof fetch;
		const resolved = resolveRagflow(config(), { RAGFLOW_API_KEY: ENV_KEY }, { storePath: withKey, fetch: fakeFetch });
		expect(resolved.readiness).toEqual({ state: "ready", url: "https://rag.example.com", keySource: "store" });
		expect(await resolved.client?.health()).toEqual({ ok: true, value: { datasets: 7 } });
		expect(seen).toEqual([{ url: "https://rag.example.com/api/v1/datasets?page=1&page_size=1", auth: `Bearer ${STORED}` }]);
	});
});

describe("ragflowStatusLine", () => {
	const env = { RAGFLOW_API_KEY: ENV_KEY };

	test("off lines", () => {
		expect(ragflowStatusLine({ ...DEFAULT_RAGFLOW_CONFIG }, env, missing)).toBe("RAGFlow: off (opt-in: set ragflow.enabled)");
		expect(ragflowStatusLine(config(), { ...env, ULTRATHINK_RAGFLOW: "0" }, missing)).toBe("RAGFlow: off (ULTRATHINK_RAGFLOW=0)");
	});

	test("unready lines", () => {
		expect(ragflowStatusLine(config({ url: "" }), env, missing)).toBe("RAGFlow: on · no URL (set ragflow.url or RAGFLOW_URL)");
		expect(ragflowStatusLine(config({ url: "http://rag.example.com" }), env, missing)).toMatch(/^RAGFlow: on · bad URL \(http is allowed only for .+\)$/);
		expect(ragflowStatusLine(config(), {}, missing)).toBe(
			"RAGFlow: on · no key (run bin/ultrathink-mcp auth set-key ragflow --stdin, or set RAGFLOW_API_KEY)",
		);
	});

	test("ready lines name the origin, key source, grounding and dataset scope but never the key", () => {
		const fromEnv = ragflowStatusLine(config({ url: "https://rag.example.com/rf" }), env, missing);
		expect(fromEnv).toBe("RAGFlow: on · https://rag.example.com · key from RAGFLOW_API_KEY · grounding off · all datasets");
		const stored = ragflowStatusLine(config({ ground: true, datasetIds: ["a", "b"] }), env, withKey);
		expect(stored).toBe("RAGFlow: on · https://rag.example.com · key from store · grounding on · 2 dataset(s) pinned");
		expect(`${fromEnv}${stored}`).not.toContain(ENV_KEY);
		expect(`${fromEnv}${stored}`).not.toContain(STORED);
	});
});
