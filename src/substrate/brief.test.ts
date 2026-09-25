// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, describe, expect, test } from "bun:test";
import { emitEvent, fetchBrief } from "./brief.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

function stubFetch(handler: (url: string, init: RequestInit) => Response | Promise<Response>): () => RequestInit {
	let captured: RequestInit = {};
	globalThis.fetch = ((url: string, init: RequestInit) => {
		captured = init;
		return Promise.resolve(handler(url, init));
	}) as unknown as typeof fetch;
	return () => captured;
}

/** Record every URL fetch is called with; responds 200 "ok". */
function recordFetch(): string[] {
	const urls: string[] = [];
	globalThis.fetch = ((url: string) => {
		urls.push(String(url));
		return Promise.resolve(new Response("ok"));
	}) as unknown as typeof fetch;
	return urls;
}

const URL_ = "http://substrate.test:9000";

describe("fetchBrief", () => {
	test("returns the brief body", async () => {
		stubFetch(() => new Response("## Substrate brief: repo\nNodes: n1 done"));
		const brief = await fetchBrief({ repo: "a/b" }, {}, URL_);
		expect(brief).toContain("## Substrate brief");
	});

	test("sends snake_case keys, which is what the server reads", async () => {
		const captured = stubFetch(() => new Response("ok"));
		await fetchBrief({ repo: "a/b", branch: "main", graphId: "ut-1" }, {}, URL_);
		expect(JSON.parse(String(captured().body))).toEqual({
			repo: "a/b",
			branch: "main",
			graph_id: "ut-1",
			surface: "claude-code",
		});
	});

	test("returns empty when the substrate is down — the prompt must not block", async () => {
		globalThis.fetch = (() => Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch;
		expect(await fetchBrief({ repo: "a/b" }, {}, URL_)).toBe("");
	});

	test("returns empty on a non-2xx rather than surfacing an error page", async () => {
		stubFetch(() => new Response("upstream exploded", { status: 500 }));
		expect(await fetchBrief({ repo: "a/b" }, {}, URL_)).toBe("");
	});

	test("makes no request when no URL is configured anywhere", async () => {
		const urls = recordFetch();
		expect(await fetchBrief({ repo: "a/b" }, {})).toBe("");
		expect(await fetchBrief({ repo: "a/b" }, { SUBSTRATE_URL: "  " }, "")).toBe("");
		expect(urls).toEqual([]);
	});

	test("uses the configured URL, without a trailing slash", async () => {
		const urls = recordFetch();
		await fetchBrief({ repo: "a/b" }, {}, `${URL_}/`);
		expect(urls).toEqual([`${URL_}/brief`]);
	});

	test("SUBSTRATE_URL wins over the configured URL", async () => {
		const urls = recordFetch();
		await fetchBrief({ repo: "a/b" }, { SUBSTRATE_URL: "https://env.test" }, URL_);
		expect(urls).toEqual(["https://env.test/brief"]);
	});

	test("SUBSTRATE_DISABLED beats both the env and the configured URL", async () => {
		const urls = recordFetch();
		expect(
			await fetchBrief({ repo: "a/b" }, { SUBSTRATE_DISABLED: "1", SUBSTRATE_URL: "https://env.test" }, URL_),
		).toBe("");
		expect(urls).toEqual([]);
	});

	test("sends a bearer token when one is configured", async () => {
		const captured = stubFetch(() => new Response("ok"));
		await fetchBrief({ repo: "a/b" }, { SUBSTRATE_TOKEN: "secret-token" }, URL_);
		expect((captured().headers as Record<string, string>).authorization).toBe("Bearer secret-token");
	});
});

describe("emitEvent", () => {
	test("reports success and failure without throwing", async () => {
		stubFetch(() => new Response("{}", { status: 202 }));
		expect(await emitEvent({ kind: "commit", summary: "abc" }, {}, URL_)).toBe(true);

		globalThis.fetch = (() => Promise.reject(new Error("down"))) as unknown as typeof fetch;
		expect(await emitEvent({ kind: "commit", summary: "abc" }, {}, URL_)).toBe(false);
	});

	test("follows the same opt-in rule as fetchBrief", async () => {
		const urls = recordFetch();
		expect(await emitEvent({ kind: "commit", summary: "abc" }, {})).toBe(false);
		expect(await emitEvent({ kind: "commit", summary: "abc" }, { SUBSTRATE_DISABLED: "1" }, URL_)).toBe(false);
		expect(await emitEvent({ kind: "commit", summary: "abc" }, { SUBSTRATE_URL: "https://env.test" }, URL_)).toBe(
			true,
		);
		expect(urls).toEqual(["https://env.test/events"]);
	});
});
