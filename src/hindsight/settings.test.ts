// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hindsightStatusLine, resolveHindsight, resolveHindsightKey } from "./settings.ts";
import { DEFAULT_HINDSIGHT_CONFIG, type HindsightConfig } from "./types.ts";

const dirs: string[] = [];

afterAll(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A credential store file in a temp dir; `hindsight` is the stored provider value (a raw credential) when given. */
function store(hindsight?: unknown, raw?: string): string {
	const dir = mkdtempSync(join(tmpdir(), "ut-hindsight-settings-"));
	dirs.push(dir);
	const path = join(dir, "mcp-credentials.json");
	writeFileSync(path, raw ?? JSON.stringify({ version: 1, providers: hindsight === undefined ? {} : { hindsight } }));
	return path;
}

const stored = (apiKey: string) => ({ kind: "api_key", apiKey, updatedAt: 1 });
const ON: HindsightConfig = { ...DEFAULT_HINDSIGHT_CONFIG, enabled: true, url: "https://hs.example.test", bank: "lessons" };

describe("resolveHindsightKey", () => {
	test("the stored key beats HINDSIGHT_API_KEY beats HINDSIGHT_API_TOKEN", () => {
		const path = store(stored("  from-store  "));
		expect(resolveHindsightKey(path, { HINDSIGHT_API_KEY: "k", HINDSIGHT_API_TOKEN: "t" })).toEqual({ key: "from-store", source: "store" });
		expect(resolveHindsightKey(store(), { HINDSIGHT_API_KEY: " k ", HINDSIGHT_API_TOKEN: "t" })).toEqual({ key: "k", source: "HINDSIGHT_API_KEY" });
		expect(resolveHindsightKey(store(), { HINDSIGHT_API_TOKEN: "t" })).toEqual({ key: "t", source: "HINDSIGHT_API_TOKEN" });
	});

	test("blank values are ignored at every level", () => {
		expect(resolveHindsightKey(store(stored("   ")), { HINDSIGHT_API_KEY: "  ", HINDSIGHT_API_TOKEN: "t" })).toEqual({
			key: "t",
			source: "HINDSIGHT_API_TOKEN",
		});
		expect(resolveHindsightKey(store(stored("")), { HINDSIGHT_API_KEY: "", HINDSIGHT_API_TOKEN: " " })).toBeUndefined();
	});

	test("no key anywhere is undefined", () => {
		expect(resolveHindsightKey(store(), {})).toBeUndefined();
	});

	test("a non-api_key credential, a corrupt store and a missing store fall back to the environment and never throw", () => {
		const env = { HINDSIGHT_API_KEY: "env-key" };
		expect(resolveHindsightKey(store({ kind: "oauth", tokens: { accessToken: "x" } }), env)?.source).toBe("HINDSIGHT_API_KEY");
		expect(resolveHindsightKey(store(undefined, "{ not json"), env)?.source).toBe("HINDSIGHT_API_KEY");
		expect(resolveHindsightKey(join(tmpdir(), "ut-hindsight-missing", "nope.json"), env)?.source).toBe("HINDSIGHT_API_KEY");
	});

	test("without an explicit path the store location comes from ULTRATHINK_MCP_STORE", () => {
		expect(resolveHindsightKey(undefined, { ULTRATHINK_MCP_STORE: store(stored("via-env-path")) })).toEqual({ key: "via-env-path", source: "store" });
	});
});

describe("resolveHindsight", () => {
	const path = store(stored("stored-key-123"));

	test("the kill switch wins over everything", () => {
		const resolution = resolveHindsight(ON, { ULTRATHINK_HINDSIGHT: "0" }, { storePath: path });
		expect(resolution.readiness).toEqual({ state: "off", reason: "killed" });
		expect(resolution.client).toBeUndefined();
	});

	test("other values of the kill switch do nothing", () => {
		expect(resolveHindsight(ON, { ULTRATHINK_HINDSIGHT: "1" }, { storePath: path }).readiness.state).toBe("ready");
	});

	test("disabled by default, even with a URL and key available", () => {
		const resolution = resolveHindsight(DEFAULT_HINDSIGHT_CONFIG, { HINDSIGHT_API_URL: "https://hs.example.test", HINDSIGHT_API_KEY: "k" }, { storePath: path });
		expect(resolution.readiness).toEqual({ state: "off", reason: "disabled" });
		expect(resolution.client).toBeUndefined();
	});

	test("no URL anywhere", () => {
		expect(resolveHindsight({ ...ON, url: "  " }, {}, { storePath: path }).readiness).toEqual({ state: "unready", reason: "no-url" });
	});

	test("HINDSIGHT_API_URL fills in when the config URL is empty, and the config URL wins otherwise", () => {
		const fromEnv = resolveHindsight({ ...ON, url: "" }, { HINDSIGHT_API_URL: " https://env.example.test/ " }, { storePath: path });
		expect(fromEnv.readiness).toMatchObject({ state: "ready", url: "https://env.example.test" });
		const both = resolveHindsight(ON, { HINDSIGHT_API_URL: "https://env.example.test" }, { storePath: path });
		expect(both.readiness).toMatchObject({ state: "ready", url: "https://hs.example.test" });
	});

	test("a URL the policy refuses is bad-url with the reason", () => {
		const insecure = resolveHindsight({ ...ON, url: "http://example.com" }, {}, { storePath: path });
		expect(insecure.readiness).toMatchObject({ state: "unready", reason: "bad-url" });
		expect(insecure.client).toBeUndefined();
		const userinfo = resolveHindsight({ ...ON, url: "https://user:pw@hs.example.test" }, {}, { storePath: path });
		expect(userinfo.readiness).toEqual({ state: "unready", reason: "bad-url", detail: "must not contain a user name or password" });
		const fromEnv = resolveHindsight({ ...ON, url: "" }, { HINDSIGHT_API_URL: "ftp://hs.example.test" }, { storePath: path });
		expect(fromEnv.readiness).toMatchObject({ state: "unready", reason: "bad-url" });
	});

	test("a valid URL but no key is no-key", () => {
		expect(resolveHindsight(ON, {}, { storePath: store() }).readiness).toEqual({ state: "unready", reason: "no-key" });
	});

	test("ready carries the normalized URL, the bank and the key source, and a working client", async () => {
		const requests: { url: string; authorization?: string }[] = [];
		const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
			requests.push({ url: String(input), authorization: (init?.headers as Record<string, string>).Authorization });
			return new Response(JSON.stringify({ results: [] }));
		}) as unknown as typeof fetch;
		const resolution = resolveHindsight({ ...ON, url: "https://hs.example.test/prefix/" }, { HINDSIGHT_API_KEY: "env-key" }, { storePath: path, fetch: fetchFn });
		expect(resolution.readiness).toEqual({ state: "ready", url: "https://hs.example.test/prefix", bank: "lessons", keySource: "store" });
		expect(resolution.client?.bank).toBe("lessons");
		await resolution.client?.recall({ query: "q" });
		expect(requests).toEqual([{ url: "https://hs.example.test/prefix/v1/default/banks/lessons/memories/recall", authorization: "Bearer stored-key-123" }]);
	});

	test("a blank bank falls back to the default bank", () => {
		expect(resolveHindsight({ ...ON, bank: " " }, {}, { storePath: path }).readiness).toMatchObject({ state: "ready", bank: "ultrathink" });
	});

	test("http is allowed for loopback", () => {
		expect(resolveHindsight({ ...ON, url: "http://localhost:8888" }, {}, { storePath: path }).readiness).toMatchObject({ state: "ready", url: "http://localhost:8888" });
	});
});

describe("hindsightStatusLine", () => {
	const path = store(stored("stored-key-123"));
	const noKey = store();

	test("off states", () => {
		expect(hindsightStatusLine(DEFAULT_HINDSIGHT_CONFIG, {}, path)).toBe("Hindsight: off (opt-in: set hindsight.enabled)");
		expect(hindsightStatusLine(ON, { ULTRATHINK_HINDSIGHT: "0" }, path)).toBe("Hindsight: off (ULTRATHINK_HINDSIGHT=0)");
	});

	test("unready states", () => {
		expect(hindsightStatusLine({ ...ON, url: "" }, {}, path)).toBe("Hindsight: on · no URL (set hindsight.url or HINDSIGHT_API_URL)");
		expect(hindsightStatusLine({ ...ON, url: "http://example.com" }, {}, path)).toBe(
			"Hindsight: on · bad URL (http is allowed only for localhost, *.ts.net and 100.64.0.0/10; use https)",
		);
		expect(hindsightStatusLine(ON, {}, noKey)).toBe("Hindsight: on · no key (run bin/ultrathink-mcp auth set-key hindsight --stdin, or set HINDSIGHT_API_KEY)");
	});

	test("ready names the origin, bank and key source but never the key or the path", () => {
		const config = { ...ON, url: "https://hs.example.test/secret-prefix" };
		expect(hindsightStatusLine(config, {}, path)).toBe("Hindsight: on · https://hs.example.test · bank lessons · key from store");
		expect(hindsightStatusLine(ON, { HINDSIGHT_API_KEY: "env-key-value" }, noKey)).toBe("Hindsight: on · https://hs.example.test · bank lessons · key from HINDSIGHT_API_KEY");
		expect(hindsightStatusLine(ON, { HINDSIGHT_API_TOKEN: "tok-value" }, noKey)).toBe("Hindsight: on · https://hs.example.test · bank lessons · key from HINDSIGHT_API_TOKEN");
		for (const line of [hindsightStatusLine(config, {}, path), hindsightStatusLine(ON, { HINDSIGHT_API_KEY: "env-key-value" }, noKey)]) {
			expect(line).not.toContain("stored-key-123");
			expect(line).not.toContain("env-key-value");
			expect(line).not.toContain("secret-prefix");
		}
	});
});
