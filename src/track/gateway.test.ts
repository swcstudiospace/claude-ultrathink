// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, type UltrathinkConfig } from "../config.ts";
import { resolveAuthHeader } from "../mcp/oauth.ts";
import { writeStore } from "../mcp/store.ts";
import { createGatewayTracker, shellArg, trackCommand } from "./gateway.ts";
import type { TrackPlan } from "./types.ts";

let dir: string;
let path: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ut-gateway-"));
	path = join(dir, "creds.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

// Never reached by these cases: the tracker must bail before creation.
const plan = { graphId: "g1" } as TrackPlan;

function configured(over: { team?: string; dataSourceUrl?: string } = { team: "Team", dataSourceUrl: "collection://ds" }): UltrathinkConfig {
	const config = defaultConfig();
	config.linear.team = over.team ?? "";
	config.notion.dataSourceUrl = over.dataSourceUrl ?? "";
	return config;
}

/** An expired OAuth credential: resolving its auth header POSTs to `tokenEndpoint`. */
function expiredOauth(issuer: string, now: number) {
	return {
		kind: "oauth" as const,
		client: {
			clientId: "cid-1",
			redirectUri: "http://127.0.0.1:8765/callback",
			issuer,
			authorizationEndpoint: `${issuer}/authorize`,
			tokenEndpoint: `${issuer}/token`,
			registeredAt: now,
		},
		tokens: { accessToken: "at", refreshToken: "rt", expiresAt: now - 1 },
		updatedAt: now,
	};
}

function recordingFetch(urls: string[]): typeof fetch {
	return (async (input: string | URL | Request) => {
		urls.push(String(input));
		return new Response("{}", { status: 500 });
	}) as typeof fetch;
}

describe("trackCommand", () => {
	test("a plain clone path is printed as-is", () => {
		expect(trackCommand("/opt/ultrathink")).toBe("/opt/ultrathink/bin/ultrathink-mcp track complete");
	});

	test("a clone path with a space or a quote is single-quoted so the command still runs", () => {
		expect(trackCommand("/Users/Jane Doe/ultrathink")).toBe("'/Users/Jane Doe/ultrathink/bin/ultrathink-mcp' track complete");
		expect(shellArg("/Users/o'neil/x")).toBe(`'/Users/o'\\''neil/x'`);
	});
});

describe("createGatewayTracker", () => {
	test("is undefined when neither Linear nor Notion is configured", () => {
		expect(createGatewayTracker(defaultConfig(), { storePath: path })).toBeUndefined();
		expect(createGatewayTracker(configured({ team: "  " }), { storePath: path })).toBeUndefined();
	});

	test("Linear-only config never contacts Notion", async () => {
		writeStore(path, { version: 1, providers: { notion: expiredOauth("https://mcp.notion.com", Date.now()) } });
		const urls: string[] = [];
		const tracker = createGatewayTracker(configured({ team: "Team" }), { storePath: path, fetch: recordingFetch(urls) })!;
		expect(await tracker({ plan })).toBeUndefined();
		expect(urls).toEqual([]);
	});

	test("Notion-only config never contacts Linear", async () => {
		writeStore(path, { version: 1, providers: { linear: expiredOauth("https://mcp.linear.app", Date.now()) } });
		const urls: string[] = [];
		const tracker = createGatewayTracker(configured({ dataSourceUrl: "collection://ds" }), { storePath: path, fetch: recordingFetch(urls) })!;
		expect(await tracker({ plan })).toBeUndefined();
		expect(urls).toEqual([]);
	});

	test("already-aborted signal returns undefined without any request", async () => {
		writeStore(path, { version: 1, providers: { linear: { kind: "api_key", apiKey: "k", updatedAt: 1 } } });
		const urls: string[] = [];
		const fakeFetch = (async (input: string | URL | Request) => {
			urls.push(String(input));
			return new Response("{}");
		}) as typeof fetch;
		const tracker = createGatewayTracker(configured(), { storePath: path, fetch: fakeFetch })!;
		const result = await tracker({ plan, signal: AbortSignal.abort() });
		expect(result).toBeUndefined();
		expect(urls).toEqual([]);
	});

	test("auth resolution slower than the budget returns undefined", async () => {
		const now = Date.now();
		writeStore(path, { version: 1, providers: { notion: expiredOauth("https://mcp.notion.com", now) } });
		const hang = Promise.withResolvers<Response>();
		const urls: string[] = [];
		const fakeFetch = (async (input: string | URL | Request) => {
			urls.push(String(input));
			return hang.promise;
		}) as typeof fetch;
		const config = configured();
		config.track.budgetMs = 50;
		const tracker = createGatewayTracker(config, { storePath: path, fetch: fakeFetch })!;
		const started = Date.now();
		const result = await tracker({ plan });
		expect(result).toBeUndefined();
		expect(Date.now() - started).toBeLessThan(1_000);
		expect(urls).toEqual(["https://mcp.notion.com/token"]);
		// Let the pending refresh settle before the temp dir is removed: a second resolve
		// waits on the store lock the first refresh still holds.
		hang.resolve(new Response("{}", { status: 500 }));
		await resolveAuthHeader("notion", { storePath: path, fetch: fakeFetch }).catch(() => undefined);
	});
});
