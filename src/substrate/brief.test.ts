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

	test("a caller signal is combined with the request timeout and ends the request as an empty brief", async () => {
		let seen: AbortSignal | undefined;
		globalThis.fetch = ((_url: string, init: RequestInit) => {
			seen = init.signal ?? undefined;
			return new Promise<Response>((_resolve, reject) => {
				init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
			});
		}) as unknown as typeof fetch;
		const caller = new AbortController();
		const pending = fetchBrief({ repo: "a/b", signal: caller.signal }, { SUBSTRATE_TIMEOUT_MS: "60000" }, URL_);
		expect(seen?.aborted).toBe(false);
		caller.abort();
		expect(await pending).toBe("");
		expect(seen?.aborted).toBe(true);
	});

	test("the request timeout still applies when the caller never aborts", async () => {
		// Real timer: the request timeout is the platform AbortSignal.timeout, which a fake clock does not drive; 20 ms keeps it short.
		globalThis.fetch = ((_url: string, init: RequestInit) =>
			new Promise<Response>((_resolve, reject) => {
				init.signal?.addEventListener("abort", () => reject(new DOMException("timed out", "TimeoutError")));
			})) as unknown as typeof fetch;
		const started = Date.now();
		expect(await fetchBrief({ repo: "a/b", signal: new AbortController().signal }, { SUBSTRATE_TIMEOUT_MS: "20" }, URL_)).toBe("");
		expect(Date.now() - started).toBeLessThan(2_000);
	});

	test("an already cancelled caller sends no request", async () => {
		const urls = recordFetch();
		const caller = new AbortController();
		caller.abort();
		expect(await fetchBrief({ repo: "a/b", signal: caller.signal }, {}, URL_)).toBe("");
		expect(urls).toEqual([]);
	});

	test("the body stays the snake_case keys: the signal goes to the request, never the server", async () => {
		const captured = stubFetch(() => new Response("ok"));
		await fetchBrief({ repo: "a/b", branch: "main", signal: new AbortController().signal }, {}, URL_);
		expect(JSON.parse(String(captured().body))).toEqual({ repo: "a/b", branch: "main", surface: "claude-code" });
		expect(captured().signal).toBeInstanceOf(AbortSignal);
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

	test("sends snake_case keys, the content type and the bearer token, which is what the server reads", async () => {
		const captured = stubFetch(() => new Response("{}", { status: 202 }));
		await emitEvent(
			{
				kind: "note",
				summary: "ultrathink planned graph ut-1 (5 nodes)",
				surface: "hermes",
				sessionId: "s1",
				graphId: "ut-1",
				nodeId: "n1",
				repo: "a/b",
				branch: "main",
				payload: { ultrathink: "plan", nodes: 5 },
			},
			{ SUBSTRATE_TOKEN: "secret-token" },
			URL_,
		);
		const init = captured();
		expect(init.method).toBe("POST");
		expect(init.headers).toEqual({ "content-type": "application/json", authorization: "Bearer secret-token" });
		expect(JSON.parse(String(init.body))).toEqual({
			kind: "note",
			summary: "ultrathink planned graph ut-1 (5 nodes)",
			surface: "hermes",
			session_id: "s1",
			graph_id: "ut-1",
			node_id: "n1",
			repo: "a/b",
			branch: "main",
			payload: { ultrathink: "plan", nodes: 5 },
		});

		// No surface named: the event is Claude Code's, as for the brief.
		await emitEvent({ kind: "note", summary: "s" }, {}, URL_);
		expect(JSON.parse(String(captured().body)).surface).toBe("claude-code");
	});

	test("a non-2xx answer is not an accepted event, and a server that never answers is given up on at the timeout", async () => {
		stubFetch(() => new Response("upstream exploded", { status: 503 }));
		expect(await emitEvent({ kind: "note", summary: "s" }, {}, URL_)).toBe(false);

		globalThis.fetch = ((_url: string, init: RequestInit) =>
			new Promise<Response>((_resolve, reject) => {
				init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
			})) as unknown as typeof fetch;
		expect(await emitEvent({ kind: "note", summary: "s" }, { SUBSTRATE_TIMEOUT_MS: "20" }, URL_)).toBe(false);
	});

	test("an already-aborted signal sends nothing", async () => {
		const urls = recordFetch();
		expect(await emitEvent({ kind: "note", summary: "s" }, {}, URL_, AbortSignal.abort())).toBe(false);
		expect(urls).toEqual([]);
	});

	test("a signal aborted while the request hangs ends it promptly, well inside the substrate timeout", async () => {
		globalThis.fetch = ((_url: string, init: RequestInit) => {
			const { promise, reject } = Promise.withResolvers<Response>();
			init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
			return promise;
		}) as unknown as typeof fetch;
		const controller = new AbortController();
		const started = performance.now();
		const pending = emitEvent({ kind: "note", summary: "s" }, { SUBSTRATE_TIMEOUT_MS: "30000" }, URL_, controller.signal);
		controller.abort();
		expect(await pending).toBe(false);
		expect(performance.now() - started).toBeLessThan(5_000);
	});

	test("a live signal leaves the request unchanged", async () => {
		const captured = stubFetch(() => new Response("{}", { status: 202 }));
		const controller = new AbortController();
		expect(await emitEvent({ kind: "note", summary: "s" }, {}, URL_, controller.signal)).toBe(true);
		expect(captured().signal?.aborted).toBe(false);
	});
});
