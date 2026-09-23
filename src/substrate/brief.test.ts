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

describe("fetchBrief", () => {
	test("returns the brief body", async () => {
		stubFetch(() => new Response("## Substrate brief: repo\nNodes: n1 done"));
		const brief = await fetchBrief({ repo: "a/b" }, {});
		expect(brief).toContain("## Substrate brief");
	});

	test("sends snake_case keys, which is what the server reads", async () => {
		const captured = stubFetch(() => new Response("ok"));
		await fetchBrief({ repo: "a/b", branch: "main", graphId: "ut-1" }, {});
		expect(JSON.parse(String(captured().body))).toEqual({
			repo: "a/b",
			branch: "main",
			graph_id: "ut-1",
			surface: "claude-code",
		});
	});

	test("returns empty when the substrate is down — the prompt must not block", async () => {
		globalThis.fetch = (() => Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch;
		expect(await fetchBrief({ repo: "a/b" }, {})).toBe("");
	});

	test("returns empty on a non-2xx rather than surfacing an error page", async () => {
		stubFetch(() => new Response("upstream exploded", { status: 500 }));
		expect(await fetchBrief({ repo: "a/b" }, {})).toBe("");
	});

	test("honours SUBSTRATE_DISABLED without making a request", async () => {
		let called = false;
		globalThis.fetch = (() => {
			called = true;
			return Promise.resolve(new Response("nope"));
		}) as unknown as typeof fetch;
		expect(await fetchBrief({ repo: "a/b" }, { SUBSTRATE_DISABLED: "1" })).toBe("");
		expect(called).toBe(false);
	});

	test("sends a bearer token when one is configured", async () => {
		const captured = stubFetch(() => new Response("ok"));
		await fetchBrief({ repo: "a/b" }, { SUBSTRATE_TOKEN: "secret-token" });
		expect((captured().headers as Record<string, string>).authorization).toBe("Bearer secret-token");
	});
});

describe("emitEvent", () => {
	test("reports success and failure without throwing", async () => {
		stubFetch(() => new Response("{}", { status: 202 }));
		expect(await emitEvent({ kind: "commit", summary: "abc" }, {})).toBe(true);

		globalThis.fetch = (() => Promise.reject(new Error("down"))) as unknown as typeof fetch;
		expect(await emitEvent({ kind: "commit", summary: "abc" }, {})).toBe(false);
	});
});
