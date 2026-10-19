// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import { checkOpenRouterKeyFormat, OPENROUTER_KEY_URL, verifyOpenRouterKey } from "./openrouter-key.ts";

// Built at runtime so no key-shaped literal sits in source.
const KEY = `sk-or-v1-${"Abc123_-".repeat(4)}`;

function fakeFetch(responses: Array<Response | Error>): { fetch: typeof fetch; calls: Array<{ url: string; auth: string | null }> } {
	const calls: Array<{ url: string; auth: string | null }> = [];
	let i = 0;
	const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
		const headers = new Headers(init?.headers);
		calls.push({ url: String(input), auth: headers.get("authorization") });
		const next = responses[Math.min(i++, responses.length - 1)];
		if (next instanceof Error) throw next;
		return next as Response;
	}) as typeof fetch;
	return { fetch: fetchImpl, calls };
}

const noSleep = async () => undefined;

describe("checkOpenRouterKeyFormat", () => {
	test("accepts a well-formed OpenRouter key", () => {
		expect(checkOpenRouterKeyFormat(KEY)).toEqual({ ok: true });
	});

	test("refuses another provider's key, whitespace, and a truncated key", () => {
		expect(checkOpenRouterKeyFormat("sk-ant-api03-abcdefghijklmnopqrst").ok).toBe(false);
		expect(checkOpenRouterKeyFormat(`${KEY} `).ok).toBe(false);
		expect(checkOpenRouterKeyFormat("sk-or-short").ok).toBe(false);
	});
});

describe("verifyOpenRouterKey", () => {
	test("a key OpenRouter accepts is ok, sent as a bearer to the key endpoint", async () => {
		const { fetch, calls } = fakeFetch([new Response("{}", { status: 200 })]);
		expect(await verifyOpenRouterKey(KEY, { fetch, sleep: noSleep })).toEqual({ ok: true });
		expect(calls).toEqual([{ url: OPENROUTER_KEY_URL, auth: `Bearer ${KEY}` }]);
	});

	test("a 401 is a final rejection and is not retried", async () => {
		const { fetch, calls } = fakeFetch([new Response("", { status: 401 })]);
		const check = await verifyOpenRouterKey(KEY, { fetch, sleep: noSleep });
		expect(check).toMatchObject({ ok: false, reason: "rejected" });
		expect(calls).toHaveLength(1);
	});

	test("a transient 5xx is retried and succeeds on the next attempt", async () => {
		const { fetch, calls } = fakeFetch([new Response("", { status: 503 }), new Response("{}", { status: 200 })]);
		expect(await verifyOpenRouterKey(KEY, { fetch, sleep: noSleep })).toEqual({ ok: true });
		expect(calls).toHaveLength(2);
	});

	test("three network failures are reported as unreachable after three attempts", async () => {
		const { fetch, calls } = fakeFetch([new Error("ECONNRESET")]);
		const check = await verifyOpenRouterKey(KEY, { fetch, sleep: noSleep });
		expect(check).toMatchObject({ ok: false, reason: "unreachable" });
		expect(calls).toHaveLength(3);
	});

	test("no message from any failure ever contains the key", async () => {
		const cases: Array<Response | Error> = [
			new Response("", { status: 401 }),
			new Response("", { status: 404 }),
			new Error(`socket reset while sending ${KEY}`),
		];
		for (const response of cases) {
			const { fetch } = fakeFetch([response]);
			const check = await verifyOpenRouterKey(KEY, { fetch, sleep: noSleep });
			if (check.ok) throw new Error("expected a failure");
			expect(check.message).not.toContain(KEY);
		}
	});

	test("a malformed key is refused before any request is made", async () => {
		const { fetch, calls } = fakeFetch([new Response("{}", { status: 200 })]);
		expect(await verifyOpenRouterKey("nope", { fetch, sleep: noSleep })).toMatchObject({ ok: false, reason: "format" });
		expect(calls).toHaveLength(0);
	});
});
