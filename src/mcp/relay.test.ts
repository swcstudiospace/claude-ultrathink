// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import { createRelay, type RelayAuth, runStdioRelay } from "./relay.ts";
import { createSseParser } from "./sse.ts";

const URL_ = "https://mcp.example.com/mcp";

interface Call {
	headers: Headers;
	body: { id?: unknown; method?: string };
	signal?: AbortSignal;
}

function fakeFetch(respond: (call: Call, index: number) => Response): { fetch: typeof fetch; calls: Call[] } {
	const calls: Call[] = [];
	const impl = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const call = { headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)), signal: init?.signal ?? undefined };
		calls.push(call);
		return respond(call, calls.length - 1);
	};
	return { fetch: impl as unknown as typeof fetch, calls };
}

const json = (value: unknown, headers: Record<string, string> = {}): Response =>
	new Response(JSON.stringify(value), { status: 200, headers: { "content-type": "application/json", ...headers } });

const staticAuth = (header?: string): RelayAuth => ({ header: async () => header, unauthorized: async () => false });

function setup(respond: (call: Call, index: number) => Response, auth: RelayAuth = staticAuth("Bearer t")) {
	const { fetch, calls } = fakeFetch(respond);
	const lines: string[] = [];
	const relay = createRelay({
		url: URL_,
		auth,
		fetch,
		userAgent: "ua/1",
		loginHint: "run: login",
		write: (line) => lines.push(line),
	});
	return { relay, calls, lines, out: () => lines.map((line) => JSON.parse(line)) };
}

describe("createSseParser", () => {
	test("ignores comments, joins data lines, skips empty events, handles chunk splits", () => {
		const got: string[] = [];
		const parser = createSseParser((data) => got.push(data));
		parser.push(": ping\n\ndata:\n\nevent: message\nda");
		parser.push("ta: {\"a\":\ndata: 1}\n");
		parser.push("\ndata: tail");
		parser.end();
		expect(got).toEqual(['{"a":\n1}', "tail"]);
	});
});

describe("createRelay", () => {
	test("writes JSON, array elements separately, nothing on 202", async () => {
		const { relay, out } = setup((call) => {
			if (call.body.method === "a") return json({ jsonrpc: "2.0", id: 1, result: {} });
			if (call.body.method === "b") return json([{ jsonrpc: "2.0", id: 2, result: {} }, { jsonrpc: "2.0", id: 3, result: {} }]);
			return new Response(null, { status: 202 });
		});
		await relay.handle({ jsonrpc: "2.0", id: 1, method: "a" });
		await relay.handle({ jsonrpc: "2.0", id: 2, method: "b" });
		await relay.handle({ jsonrpc: "2.0", method: "notifications/x" });
		expect(out().map((m) => m.id)).toEqual([1, 2, 3]);
	});

	test("SSE notification then response written in order", async () => {
		const body = 'data: {"jsonrpc":"2.0","method":"notifications/progress"}\n\ndata: {"jsonrpc":"2.0","id":7,"result":{}}\n\n';
		const { relay, out } = setup(() => new Response(body, { headers: { "content-type": "text/event-stream" } }));
		await relay.handle({ jsonrpc: "2.0", id: 7, method: "tools/list" });
		expect(out()).toEqual([
			{ jsonrpc: "2.0", method: "notifications/progress" },
			{ jsonrpc: "2.0", id: 7, result: {} },
		]);
	});

	test("headers, session capture, protocol version", async () => {
		const { relay, calls } = setup((call) =>
			call.body.method === "initialize"
				? json({ jsonrpc: "2.0", id: 0, result: { protocolVersion: "2025-06-18" } }, { "mcp-session-id": "s1" })
				: json({ jsonrpc: "2.0", id: call.body.id, result: {} }),
		);
		await relay.handle({ jsonrpc: "2.0", id: 0, method: "initialize", params: {} });
		await relay.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" });
		expect(calls[0]?.headers.get("authorization")).toBe("Bearer t");
		expect(calls[0]?.headers.get("user-agent")).toBe("ua/1");
		expect(calls[0]?.headers.get("accept")).toBe("application/json, text/event-stream");
		expect(calls[0]?.headers.get("mcp-session-id")).toBeNull();
		expect(calls[0]?.headers.get("mcp-protocol-version")).toBeNull();
		expect(calls[1]?.headers.get("mcp-session-id")).toBe("s1");
		expect(calls[1]?.headers.get("mcp-protocol-version")).toBe("2025-06-18");
	});

	test("404 with session re-initializes then retries", async () => {
		let session = 0;
		const { relay, calls, out } = setup((call, index) => {
			if (call.body.method === "initialize") {
				session += 1;
				return json({ jsonrpc: "2.0", id: 0, result: { protocolVersion: "2025-06-18" } }, { "mcp-session-id": `s${session}` });
			}
			if (call.body.method === "notifications/initialized") return new Response(null, { status: 202 });
			if (index === 1) return new Response("gone", { status: 404 });
			return json({ jsonrpc: "2.0", id: call.body.id, result: { ok: true } });
		});
		await relay.handle({ jsonrpc: "2.0", id: 0, method: "initialize", params: {} });
		await relay.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" });
		expect(calls.map((c) => c.body.method)).toEqual(["initialize", "tools/list", "initialize", "notifications/initialized", "tools/list"]);
		expect(calls[2]?.headers.get("mcp-session-id")).toBeNull();
		expect(calls[4]?.headers.get("mcp-session-id")).toBe("s2");
		expect(out().map((m) => m.id)).toEqual([0, 1]);
	});

	test("401 recovered retries with fresh header", async () => {
		let token = "Bearer old";
		const failed: (string | undefined)[] = [];
		const auth: RelayAuth = {
			header: async () => token,
			unauthorized: async (h) => {
				failed.push(h);
				token = "Bearer new";
				return true;
			},
		};
		const { relay, calls, out } = setup(
			(call) =>
				call.headers.get("authorization") === "Bearer new"
					? json({ jsonrpc: "2.0", id: 1, result: {} })
					: new Response(null, { status: 401 }),
			auth,
		);
		await relay.handle({ jsonrpc: "2.0", id: 1, method: "tools/call" });
		expect(failed).toEqual(["Bearer old"]);
		expect(calls.length).toBe(2);
		expect(out()).toEqual([{ jsonrpc: "2.0", id: 1, result: {} }]);
	});

	test("caller signal reaches every fetch for the message, including the 401 retry, but not the shared re-initialize", async () => {
		let token = "Bearer old";
		const auth: RelayAuth = {
			header: async () => token,
			unauthorized: async () => {
				token = "Bearer new";
				return true;
			},
		};
		let session = 0;
		const { relay, calls } = setup((call) => {
			if (call.body.method === "initialize")
				return json({ jsonrpc: "2.0", id: 0, result: {} }, { "mcp-session-id": `s${++session}` });
			if (call.body.method === "notifications/initialized") return new Response(null, { status: 202 });
			if (call.headers.get("authorization") !== "Bearer new") return new Response(null, { status: 401 });
			if (call.headers.get("mcp-session-id") === "s1") return new Response(null, { status: 404 });
			return json({ jsonrpc: "2.0", id: 1, result: {} });
		}, auth);
		await relay.handle({ jsonrpc: "2.0", id: 0, method: "initialize" });
		const controller = new AbortController();
		await relay.handle({ jsonrpc: "2.0", id: 1, method: "tools/call" }, controller.signal);
		const toolCalls = calls.filter((call) => call.body.method === "tools/call");
		expect(toolCalls.length).toBe(3);
		expect(toolCalls.every((call) => call.signal === controller.signal)).toBe(true);
		const reinit = calls.slice(1).filter((call) => call.body.method !== "tools/call");
		expect(reinit.map((call) => call.body.method)).toEqual(["initialize", "notifications/initialized"]);
		expect(reinit.every((call) => call.signal === undefined)).toBe(true);
	});

	test("401 twice yields -32001 with login hint; notification writes nothing", async () => {
		const auth: RelayAuth = { header: async () => "Bearer x", unauthorized: async () => true };
		const { relay, out } = setup(() => new Response(null, { status: 401 }), auth);
		await relay.handle({ jsonrpc: "2.0", id: 5, method: "tools/call" });
		await relay.handle({ jsonrpc: "2.0", method: "notifications/initialized" });
		const [error, ...rest] = out();
		expect(rest).toEqual([]);
		expect(error.id).toBe(5);
		expect(error.error.code).toBe(-32001);
		expect(error.error.message).toContain("mcp.example.com");
		expect(error.error.message).toContain("run: login");
	});

	test("429 with Retry-After yields -32029 with the wait, not the login hint", async () => {
		const { relay, calls, out } = setup(() => new Response("slow down", { status: 429, headers: { "retry-after": "30" } }));
		await relay.handle({ jsonrpc: "2.0", id: 6, method: "tools/call" });
		expect(calls.length).toBe(1);
		expect(out()).toEqual([
			{ jsonrpc: "2.0", id: 6, error: { code: -32029, message: "mcp.example.com rate limited; retry after 30s" } },
		]);
	});

	test("401 whose body says rate limited yields -32029 without a re-auth refresh", async () => {
		let refreshed = 0;
		const auth: RelayAuth = {
			header: async () => "Bearer x",
			unauthorized: async () => {
				refreshed++;
				return true;
			},
		};
		const body = JSON.stringify({ error: "rate_limited", message: "Rate limited. Retry after 3600 seconds." });
		const { relay, calls, out } = setup(() => new Response(body, { status: 401 }), auth);
		await relay.handle({ jsonrpc: "2.0", id: 7, method: "tools/call" });
		expect(refreshed).toBe(0);
		expect(calls.length).toBe(1);
		expect(out()).toEqual([
			{ jsonrpc: "2.0", id: 7, error: { code: -32029, message: "mcp.example.com rate limited; retry after 3600s" } },
		]);
	});

	test("403 with exhausted x-ratelimit-remaining is a rate limit; a plain 403 stays a generic HTTP error", async () => {
		let limited = true;
		const { relay, out } = setup(() =>
			limited
				? new Response(null, { status: 403, headers: { "x-ratelimit-remaining": "0" } })
				: new Response("forbidden", { status: 403, headers: { "x-ratelimit-remaining": "42" } }),
		);
		await relay.handle({ jsonrpc: "2.0", id: 8, method: "tools/call" });
		limited = false;
		await relay.handle({ jsonrpc: "2.0", id: 9, method: "tools/call" });
		expect(out()).toEqual([
			{ jsonrpc: "2.0", id: 8, error: { code: -32029, message: "mcp.example.com rate limited" } },
			{ jsonrpc: "2.0", id: 9, error: { code: -32000, message: "upstream HTTP 403" } },
		]);
	});

	test("rate-limit detection reads only a bounded prefix of a huge body", async () => {
		let pulled = 0;
		const stream = new ReadableStream<Uint8Array>({
			pull(controller) {
				pulled++;
				controller.enqueue(new Uint8Array(1024).fill(120));
			},
		});
		const { relay, out } = setup(() => new Response(stream, { status: 401 }));
		await relay.handle({ jsonrpc: "2.0", id: 10, method: "tools/call" });
		expect(pulled).toBeLessThan(10);
		expect(out()[0].error.code).toBe(-32001);
	});

	test("thrown auth error answers requests with -32603; notifications stay silent", async () => {
		const auth: RelayAuth = {
			header: async () => {
				throw new Error("lock timeout");
			},
			unauthorized: async () => false,
		};
		const { relay, out } = setup(() => json({}), auth);
		await relay.handle({ jsonrpc: "2.0", id: 9, method: "tools/call" });
		await relay.handle({ jsonrpc: "2.0", method: "notifications/initialized" });
		expect(out()).toEqual([{ jsonrpc: "2.0", id: 9, error: { code: -32603, message: "relay error: lock timeout" } }]);
	});

	test("concurrent re-initialize: waiters use new session, late 404 does not re-init twice", async () => {
		const initGate = Promise.withResolvers<void>();
		const lateGate = Promise.withResolvers<void>();
		const reinitStarted = Promise.withResolvers<void>();
		const calls: Call[] = [];
		let session = 0;
		const impl = async (_url: string | URL | Request, init?: RequestInit): Promise<Response> => {
			const call = { headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) };
			calls.push(call);
			const sid = call.headers.get("mcp-session-id");
			if (call.body.method === "initialize") {
				if (session > 0) {
					reinitStarted.resolve();
					await initGate.promise;
				}
				session += 1;
				return json({ jsonrpc: "2.0", id: 0, result: { protocolVersion: "2025-06-18" } }, { "mcp-session-id": `s${session}` });
			}
			if (call.body.method === "notifications/initialized") return new Response(null, { status: 202 });
			if (sid === "s1") {
				if (call.body.id === 2) await lateGate.promise;
				return new Response("gone", { status: 404 });
			}
			return json({ jsonrpc: "2.0", id: call.body.id, result: {} });
		};
		const lines: string[] = [];
		const relay = createRelay({
			url: URL_,
			auth: staticAuth("Bearer t"),
			fetch: impl as unknown as typeof fetch,
			userAgent: "ua/1",
			loginHint: "run: login",
			write: (line) => lines.push(line),
		});
		const initCount = (): number => calls.filter((c) => c.body.method === "initialize").length;
		await relay.handle({ jsonrpc: "2.0", id: 0, method: "initialize", params: {} });
		const first = relay.handle({ jsonrpc: "2.0", id: 1, method: "tools/list" });
		const late = relay.handle({ jsonrpc: "2.0", id: 2, method: "tools/list" });
		await reinitStarted.promise;
		// handle() reaches `await reinitializing` synchronously, so no wait is needed here.
		const during = relay.handle({ jsonrpc: "2.0", id: 3, method: "tools/list" });
		initGate.resolve();
		await Promise.all([first, during]);
		lateGate.resolve();
		await late;
		expect(initCount()).toBe(2);
		for (const call of calls.filter((c) => c.body.id === 3)) expect(call.headers.get("mcp-session-id")).toBe("s2");
		const retried = calls.filter((c) => c.body.method === "tools/list" && c.headers.get("mcp-session-id") !== "s1");
		expect(retried.every((c) => c.headers.get("mcp-session-id") === "s2")).toBe(true);
		expect(lines.map((line) => JSON.parse(line).id).sort()).toEqual([0, 1, 2, 3]);
	});

	test("SSE without the response yields -32000 after forwarded notifications", async () => {
		const body = 'data: {"jsonrpc":"2.0","method":"notifications/progress","params":{"progressToken":4}}\n\n';
		const { relay, out } = setup(() => new Response(body, { headers: { "content-type": "text/event-stream" } }));
		await relay.handle({ jsonrpc: "2.0", id: 4, method: "tools/call" });
		expect(out()).toEqual([
			{ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: 4 } },
			{ jsonrpc: "2.0", id: 4, error: { code: -32000, message: "upstream closed stream before response" } },
		]);
	});

	test("SSE stream error after the response writes nothing more", async () => {
		const encoder = new TextEncoder();
		let pulls = 0;
		const stream = new ReadableStream<Uint8Array>({
			pull(controller) {
				pulls += 1;
				if (pulls === 1) controller.enqueue(encoder.encode('data: {"jsonrpc":"2.0","id":6,"result":{}}\n\n'));
				else controller.error(new Error("reset"));
			},
		});
		const { relay, out } = setup(() => new Response(stream, { headers: { "content-type": "text/event-stream" } }));
		await relay.handle({ jsonrpc: "2.0", id: 6, method: "tools/call" });
		expect(out()).toEqual([{ jsonrpc: "2.0", id: 6, result: {} }]);
	});
});

describe("runStdioRelay", () => {
	test("relays two lines split across chunks and resolves", async () => {
		const { fetch } = fakeFetch((call) => json({ jsonrpc: "2.0", id: call.body.id, result: {} }));
		const encoder = new TextEncoder();
		const chunks = ['{"jsonrpc":"2.0","id":1,"me', 'thod":"a"}\n\n{"jsonrpc":"2.0",', '"id":2,"method":"b"}\n'];
		const input = new ReadableStream<Uint8Array>({
			start(controller) {
				for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
				controller.close();
			},
		});
		const lines: string[] = [];
		await runStdioRelay({ url: URL_, auth: staticAuth(), fetch, userAgent: "ua", loginHint: "h" }, input, (line) => lines.push(line));
		expect(lines.map((line) => JSON.parse(line).id).sort()).toEqual([1, 2]);
	});
});
