// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { afterEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { createHttpTransport, createKafkaRestTransport } from "./http.ts";
import type { SinkEnvelope } from "./types.ts";

const TOKEN = "tok-0123456789abcdef";

interface Captured {
	readonly method: string;
	readonly path: string;
	readonly contentType: string | null;
	readonly accept: string | null;
	readonly authorization: string | null;
	readonly body: string;
}

const servers: Server<unknown>[] = [];

afterEach(() => {
	for (const s of servers.splice(0)) s.stop(true);
});

function envelope(seq: number, kind: SinkEnvelope["kind"] = "audit"): SinkEnvelope {
	return { kind, at: "2026-01-01T00:00:00.000Z", body: { seq } };
}

function serve(handler: (req: Request, captured: Captured) => Response): { server: Server<unknown>; calls: Captured[] } {
	const calls: Captured[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(req) {
			const captured: Captured = {
				method: req.method,
				path: new URL(req.url).pathname,
				contentType: req.headers.get("content-type"),
				accept: req.headers.get("accept"),
				authorization: req.headers.get("authorization"),
				body: await req.text(),
			};
			calls.push(captured);
			return handler(req, captured);
		},
	});
	servers.push(server);
	return { server, calls };
}

function statusServer(status: number): { server: Server<unknown>; calls: Captured[] } {
	return serve(() => new Response("", { status }));
}

function baseUrl(server: Server<unknown>): string {
	return `http://127.0.0.1:${server.port}`;
}

describe("createHttpTransport", () => {
	test("a 2xx response is ok, and the batch arrives in order with the bearer token", async () => {
		const { server, calls } = serve(() => new Response("", { status: 204 }));
		const transport = createHttpTransport({ url: `${baseUrl(server)}/ingest`, token: TOKEN });
		const batch = [envelope(1), envelope(2), envelope(3, "alert")];

		const result = await transport.send(batch, new AbortController().signal);

		expect(result).toEqual({ ok: true });
		expect(calls).toHaveLength(1);
		const [call] = calls;
		expect(call?.method).toBe("POST");
		expect(call?.path).toBe("/ingest");
		expect(call?.contentType).toBe("application/x-ndjson");
		expect(call?.authorization).toBe(`Bearer ${TOKEN}`);
		const lines = (call?.body ?? "").split("\n").filter((line) => line.length > 0);
		expect(lines.map((line) => JSON.parse(line))).toEqual(batch);
	});

	test("no authorization header is sent when no token is configured", async () => {
		const { server, calls } = statusServer(200);
		const transport = createHttpTransport({ url: baseUrl(server) });

		await transport.send([envelope(1)], new AbortController().signal);

		expect(calls[0]?.authorization).toBeNull();
	});

	test("500 and 429 are retryable, 400 is not", async () => {
		const signal = new AbortController().signal;
		const cases: Array<[number, boolean]> = [
			[500, true],
			[503, true],
			[429, true],
			[408, true],
			[425, true],
			[400, false],
			[404, false],
			[401, false],
		];
		for (const [status, retryable] of cases) {
			const { server } = statusServer(status);
			const transport = createHttpTransport({ url: baseUrl(server), token: TOKEN });
			const result = await transport.send([envelope(1)], signal);
			expect(result).toEqual({ ok: false, retryable, reason: `http ${status}` });
		}
	});

	test("a redirect to another origin is refused and the token never reaches it", async () => {
		const target = serve(() => new Response("", { status: 200 }));
		const origin = serve(
			() => new Response("", { status: 302, headers: { location: `${baseUrl(target.server)}/steal` } }),
		);
		const transport = createHttpTransport({ url: `${baseUrl(origin.server)}/ingest`, token: TOKEN });

		const result = await transport.send([envelope(1)], new AbortController().signal);

		expect(result).toEqual({ ok: false, retryable: false, reason: "redirect refused" });
		expect(target.calls).toHaveLength(0);
	});

	test("the failure reason never contains the token, even when the transport error text does", async () => {
		const leaky = (async () => {
			throw new Error(`connect failed for token ${TOKEN}`);
		}) as unknown as typeof fetch;
		const transport = createHttpTransport({ url: "https://siem.example.test/ingest", token: TOKEN, fetch: leaky });

		const result = await transport.send([envelope(1)], new AbortController().signal);

		expect(result.ok).toBe(false);
		expect(result).toEqual({ ok: false, retryable: true, reason: "network error: Error" });
		expect(JSON.stringify(result)).not.toContain(TOKEN);
	});

	test("an unreachable endpoint is a retryable network error without the token in the reason", async () => {
		const closed = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
		const port = closed.port;
		closed.stop(true);
		const transport = createHttpTransport({ url: `http://127.0.0.1:${port}/ingest?key=q-secret`, token: TOKEN });

		const result = await transport.send([envelope(1)], new AbortController().signal);

		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable endpoint reported ok");
		expect(result.retryable).toBe(true);
		expect(result.reason).not.toContain(TOKEN);
		expect(result.reason).not.toContain("q-secret");
	});

	test("an already-aborted signal returns retryable without calling the network", async () => {
		let called = 0;
		const counting = (async () => {
			called += 1;
			return new Response("");
		}) as unknown as typeof fetch;
		const transport = createHttpTransport({ url: "https://siem.example.test/ingest", fetch: counting });
		const controller = new AbortController();
		controller.abort();

		const result = await transport.send([envelope(1)], controller.signal);

		expect(result).toEqual({ ok: false, retryable: true, reason: "aborted" });
		expect(called).toBe(0);
	});

	test("an empty batch is ok and sends nothing", async () => {
		const { server, calls } = statusServer(200);
		const transport = createHttpTransport({ url: baseUrl(server) });

		expect(await transport.send([], new AbortController().signal)).toEqual({ ok: true });
		expect(calls).toHaveLength(0);
	});

	test("plain http to a non-loopback host, and URLs with credentials, are rejected", () => {
		expect(() => createHttpTransport({ url: "http://example.com/ingest" })).toThrow(TypeError);
		expect(() => createHttpTransport({ url: "https://user:pw@host.example.test/ingest" })).toThrow(TypeError);
		expect(() => createHttpTransport({ url: "https://user@host.example.test/ingest" })).toThrow(TypeError);
		expect(() => createHttpTransport({ url: "not a url" })).toThrow(TypeError);
	});

	test("loopback http is accepted, and https is accepted", () => {
		expect(() => createHttpTransport({ url: "http://127.0.0.1:9/ingest" })).not.toThrow();
		expect(() => createHttpTransport({ url: "http://localhost:9/ingest" })).not.toThrow();
		expect(() => createHttpTransport({ url: "https://siem.example.test/ingest" })).not.toThrow();
	});

	test("a token shorter than 16 characters is rejected without echoing it", () => {
		const short = "short-token";
		let message = "";
		try {
			createHttpTransport({ url: "https://siem.example.test/ingest", token: short });
		} catch (err) {
			message = err instanceof Error ? err.message : String(err);
		}
		expect(message).toContain("at least 16");
		expect(message).not.toContain(short);
	});
});

describe("createKafkaRestTransport", () => {
	test("the topic is percent-encoded in the path, the content type is v2 JSON, and the value is the envelope", async () => {
		const { server, calls } = serve(() => new Response("{}", { status: 200 }));
		const transport = createKafkaRestTransport({ baseUrl: baseUrl(server), topic: "a/b", token: TOKEN });
		const batch = [envelope(7), envelope(8, "security")];

		const result = await transport.send(batch, new AbortController().signal);

		expect(result).toEqual({ ok: true });
		const [call] = calls;
		expect(call?.method).toBe("POST");
		expect(call?.path).toBe("/topics/a%2Fb");
		expect(call?.contentType).toBe("application/vnd.kafka.json.v2+json");
		expect(call?.accept).toBe("application/vnd.kafka.v2+json");
		expect(call?.authorization).toBe(`Bearer ${TOKEN}`);
		expect(JSON.parse(call?.body ?? "")).toEqual({ records: [{ value: batch[0] }, { value: batch[1] }] });
	});

	test("a trailing slash on the base URL does not double up in the path", async () => {
		const { server, calls } = statusServer(200);
		const transport = createKafkaRestTransport({ baseUrl: `${baseUrl(server)}/`, topic: "audit" });

		await transport.send([envelope(1)], new AbortController().signal);

		expect(calls[0]?.path).toBe("/topics/audit");
	});

	test("kafka status classification matches the HTTP transport", async () => {
		const signal = new AbortController().signal;
		const retryable = statusServer(503);
		const fatal = statusServer(422);
		const retryTransport = createKafkaRestTransport({ baseUrl: baseUrl(retryable.server), topic: "audit" });
		const fatalTransport = createKafkaRestTransport({ baseUrl: baseUrl(fatal.server), topic: "audit" });

		expect(await retryTransport.send([envelope(1)], signal)).toEqual({ ok: false, retryable: true, reason: "http 503" });
		expect(await fatalTransport.send([envelope(1)], signal)).toEqual({ ok: false, retryable: false, reason: "http 422" });
	});

	test("an empty topic, a plaintext remote URL, and URL credentials are rejected", () => {
		expect(() => createKafkaRestTransport({ baseUrl: "https://kafka.example.test", topic: "" })).toThrow(RangeError);
		expect(() => createKafkaRestTransport({ baseUrl: "http://kafka.example.test", topic: "audit" })).toThrow(TypeError);
		expect(() => createKafkaRestTransport({ baseUrl: "https://u:p@kafka.example.test", topic: "audit" })).toThrow(
			TypeError,
		);
	});
});
