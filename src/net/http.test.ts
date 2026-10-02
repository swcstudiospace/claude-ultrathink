// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import { MAX_RESPONSE_CHARS, requestJson } from "./http.ts";

function respond(body: string, status = 200): typeof fetch {
	return (async () => new Response(body, { status })) as unknown as typeof fetch;
}

describe("requestJson", () => {
	test("returns status, parsed JSON and raw text", async () => {
		const out = await requestJson("https://svc.test/x", { timeoutMs: 1000, fetch: respond('{"a":1}', 201) });
		expect(out).toMatchObject({ kind: "response", status: 201, json: { a: 1 }, text: '{"a":1}' });
	});

	test("keeps the raw text and leaves json undefined for a non-JSON or empty body", async () => {
		const html = await requestJson("https://svc.test/x", { timeoutMs: 1000, fetch: respond("<html>", 502) });
		expect(html).toMatchObject({ kind: "response", status: 502, json: undefined, text: "<html>" });
		const empty = await requestJson("https://svc.test/x", { timeoutMs: 1000, fetch: respond("", 204) });
		expect(empty).toMatchObject({ kind: "response", status: 204, json: undefined, text: "" });
	});

	test("sends the body as JSON, never follows redirects and passes the caller's headers", async () => {
		let seen: { url: string; init: RequestInit } | undefined;
		const spy = (async (url: string, init: RequestInit) => {
			seen = { url, init };
			return new Response("{}");
		}) as unknown as typeof fetch;
		await requestJson("https://svc.test/p", { method: "PUT", headers: { Authorization: "Bearer k" }, body: { q: 1 }, timeoutMs: 1000, fetch: spy });
		const headers = seen?.init.headers as Record<string, string>;
		expect(seen?.url).toBe("https://svc.test/p");
		expect(seen?.init.method).toBe("PUT");
		expect(seen?.init.redirect).toBe("error");
		expect(seen?.init.body).toBe('{"q":1}');
		expect(headers.Authorization).toBe("Bearer k");
		expect(headers["Content-Type"]).toBe("application/json");
		expect(headers["User-Agent"]).toContain("ultrathink");
	});

	test("defaults to GET without a body and POST with one", async () => {
		const methods: Array<string | undefined> = [];
		const spy = (async (_url: string, init: RequestInit) => {
			methods.push(init.method);
			return new Response("{}");
		}) as unknown as typeof fetch;
		await requestJson("https://svc.test/a", { timeoutMs: 1000, fetch: spy });
		await requestJson("https://svc.test/a", { body: {}, timeoutMs: 1000, fetch: spy });
		expect(methods).toEqual(["GET", "POST"]);
	});

	test("times out even when fetch ignores the abort signal", async () => {
		const hang = (() => new Promise<Response>(() => {})) as unknown as typeof fetch;
		const out = await requestJson("https://svc.test/slow", { timeoutMs: 30, fetch: hang });
		expect(out.kind).toBe("timeout");
	});

	test("times out while the body is still streaming", async () => {
		const stall = (async () => ({ status: 200, text: () => new Promise<string>(() => {}) })) as unknown as typeof fetch;
		const out = await requestJson("https://svc.test/slow-body", { timeoutMs: 30, fetch: stall });
		expect(out.kind).toBe("timeout");
	});

	test("reports a network failure as a redacted one-line message", async () => {
		const fail = (async () => {
			throw new Error(`connect ECONNREFUSED Bearer ${"a".repeat(24)} ${"x".repeat(400)}`);
		}) as unknown as typeof fetch;
		const out = await requestJson("https://svc.test/x", { timeoutMs: 1000, fetch: fail });
		expect(out.kind).toBe("network");
		if (out.kind === "network") {
			expect(out.message).toContain("ECONNREFUSED");
			expect(out.message).not.toContain("aaaaaaaa");
			expect(out.message.length).toBeLessThanOrEqual(200);
		}
	});

	test("rejects with the abort error when the caller aborts", async () => {
		const controller = new AbortController();
		const hang = (() => new Promise<Response>(() => {})) as unknown as typeof fetch;
		const pending = requestJson("https://svc.test/x", { timeoutMs: 5000, fetch: hang, signal: controller.signal });
		controller.abort();
		await expect(pending).rejects.toBeDefined();
	});

	test("refuses an oversized response", async () => {
		const out = await requestJson("https://svc.test/big", { timeoutMs: 1000, fetch: respond("x".repeat(MAX_RESPONSE_CHARS + 1)) });
		expect(out).toMatchObject({ kind: "network", message: "response too large" });
	});
});
