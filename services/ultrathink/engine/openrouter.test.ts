// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { describe, expect, test } from "bun:test";
import {
	createOpenRouterCompleter,
	OpenRouterError,
	type OpenRouterCallInfo,
	type OpenRouterCompleter,
	type OpenRouterCompleterOptions,
	type OpenRouterErrorCode,
	type OpenRouterUsage,
} from "./openrouter.ts";

const KEY = "sk-or-test-SECRETKEY-0123456789";
const BODY_MARK = "UPSTREAM-BODY-MARK";
const BASE = "https://router.example.test/api/v1";
const REFERER = "https://ultrathink.example.test";

interface Call {
	url: string;
	init: RequestInit;
}

type Step = (init: RequestInit) => Response | Promise<Response>;

function scripted(steps: Step[]): { fetch: (input: string, init: RequestInit) => Promise<Response>; calls: Call[] } {
	const calls: Call[] = [];
	return {
		calls,
		fetch: async (input, init) => {
			calls.push({ url: input, init });
			const step = steps[calls.length - 1];
			if (step === undefined) {
				throw new Error("unscripted fetch call");
			}
			return step(init);
		},
	};
}

function completion(content: unknown, usage?: Record<string, unknown>): Step {
	return () =>
		new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content } }], ...(usage ? { usage } : {}) }), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
}

function status(code: number, headers: Record<string, string> = {}, body = BODY_MARK): Step {
	return () => new Response(body, { status: code, headers });
}

function pendingUntilAbort(init: RequestInit): Promise<Response> {
	const { promise, reject } = Promise.withResolvers<Response>();
	init.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
	return promise;
}

function setup(
	steps: Step[],
	overrides: Partial<OpenRouterCompleterOptions> = {},
): { complete: OpenRouterCompleter; calls: Call[]; sleeps: number[] } {
	const script = scripted(steps);
	const sleeps: number[] = [];
	const complete = createOpenRouterCompleter({
		apiKey: KEY,
		baseUrl: BASE,
		model: "x-ai/grok-4.7",
		maxOutputTokens: 1234,
		timeoutMs: 5000,
		referer: REFERER,
		fetch: script.fetch,
		sleep: async (ms) => {
			sleeps.push(ms);
		},
		...overrides,
	});
	return { complete, calls: script.calls, sleeps };
}

async function failure(promise: Promise<unknown>): Promise<OpenRouterError> {
	try {
		await promise;
	} catch (error) {
		expect(error).toBeInstanceOf(OpenRouterError);
		return error as OpenRouterError;
	}
	throw new Error("expected the completer to reject");
}

function expectNoLeak(error: OpenRouterError): void {
	for (const text of [error.message, String(error), error.stack ?? "", JSON.stringify(error)]) {
		expect(text).not.toContain(KEY);
		expect(text).not.toContain(BODY_MARK);
	}
}

describe("request shape", () => {
	test("posts the exact URL, headers and body, and the key only appears in Authorization", async () => {
		const { complete, calls } = setup([completion("hello")]);
		expect(await complete("SYS", "USR")).toBe("hello");
		expect(calls).toHaveLength(1);
		const call = calls[0] as Call;
		expect(call.url).toBe(`${BASE}/chat/completions`);
		expect(call.init.method).toBe("POST");
		expect(call.init.headers).toEqual({
			Authorization: `Bearer ${KEY}`,
			"Content-Type": "application/json",
			"HTTP-Referer": REFERER,
			"X-Title": "ultrathink",
		});
		expect(JSON.parse(call.init.body as string)).toEqual({
			model: "x-ai/grok-4.7",
			messages: [
				{ role: "system", content: "SYS" },
				{ role: "user", content: "USR" },
			],
			max_tokens: 1234,
			usage: { include: true },
		});
		expect(call.init.body as string).not.toContain(KEY);
		expect(call.url).not.toContain(KEY);
		const others = Object.entries(call.init.headers as Record<string, string>).filter(([name]) => name !== "Authorization");
		for (const [, value] of others) {
			expect(value).not.toContain(KEY);
		}
	});

	test("a trailing slash on the base URL does not double up", async () => {
		const { complete, calls } = setup([completion("ok")], { baseUrl: `${BASE}/` });
		await complete("s", "u");
		expect((calls[0] as Call).url).toBe(`${BASE}/chat/completions`);
	});

	test("passes a signal to fetch that is not the caller's", async () => {
		const { complete, calls } = setup([completion("ok")]);
		const controller = new AbortController();
		await complete("s", "u", controller.signal);
		const sent = (calls[0] as Call).init.signal;
		expect(sent).toBeInstanceOf(AbortSignal);
		expect(sent).not.toBe(controller.signal);
	});
});

describe("usage", () => {
	test("onUsage receives prompt tokens, completion tokens and cost", async () => {
		const seen: OpenRouterUsage[] = [];
		const { complete } = setup([completion("hi", { prompt_tokens: 11, completion_tokens: 7, cost: 0.0021 })], {
			onUsage: (usage) => seen.push(usage),
		});
		await complete("s", "u");
		expect(seen).toEqual([{ promptTokens: 11, completionTokens: 7, costUsd: 0.0021 }]);
	});

	test("a response without cost omits costUsd; missing or invalid counts stay unknown, never zero", async () => {
		const seen: OpenRouterUsage[] = [];
		const { complete } = setup(
			[
				completion("a", { prompt_tokens: 3, completion_tokens: 4 }),
				completion("b"),
				completion("c", { prompt_tokens: "x", completion_tokens: -1, cost: "free" }),
				completion("d", { prompt_tokens: 9 }),
			],
			{ onUsage: (usage) => seen.push(usage) },
		);
		await complete("s", "u");
		await complete("s", "u");
		await complete("s", "u");
		await complete("s", "u");
		expect(seen).toEqual([{ promptTokens: 3, completionTokens: 4 }, {}, {}, { promptTokens: 9 }]);
		expect("costUsd" in (seen[0] as OpenRouterUsage)).toBe(false);
	});

	test("only the successful attempt is reported", async () => {
		const seen: OpenRouterUsage[] = [];
		const { complete } = setup([status(503), completion("fine", { prompt_tokens: 1, completion_tokens: 2 })], {
			onUsage: (usage) => seen.push(usage),
		});
		await complete("s", "u");
		expect(seen).toHaveLength(1);
	});

	test("failures never call onUsage", async () => {
		const seen: OpenRouterUsage[] = [];
		const { complete } = setup([status(401)], { onUsage: (usage) => seen.push(usage) });
		await failure(complete("s", "u"));
		expect(seen).toEqual([]);
	});

	test("a throwing onUsage does not fail a finished completion", async () => {
		const { complete } = setup([completion("done", { prompt_tokens: 1, completion_tokens: 1 })], {
			onUsage: () => {
				throw new Error(`accounting broke ${KEY}`);
			},
		});
		expect(await complete("s", "u")).toBe("done");
	});
});

describe("status handling", () => {
	test("401 and 403 map to auth without a retry", async () => {
		for (const code of [401, 403]) {
			const { complete, calls, sleeps } = setup([status(code), completion("never")]);
			const error = await failure(complete("s", "u"));
			expect(error.code).toBe("auth");
			expect(error.status).toBe(code);
			expect(calls).toHaveLength(1);
			expect(sleeps).toEqual([]);
			expectNoLeak(error);
		}
	});

	test("other 4xx are upstream failures and are not retried", async () => {
		for (const code of [400, 402, 404, 408, 422]) {
			const { complete, calls, sleeps } = setup([status(code), completion("never")]);
			const error = await failure(complete("s", "u"));
			expect(error.code).toBe("upstream");
			expect(calls).toHaveLength(1);
			expect(sleeps).toEqual([]);
			expectNoLeak(error);
		}
	});

	test("429 honors Retry-After seconds and then succeeds", async () => {
		const { complete, calls, sleeps } = setup([status(429, { "retry-after": "3" }), completion("after")]);
		expect(await complete("s", "u")).toBe("after");
		expect(calls).toHaveLength(2);
		expect(sleeps).toEqual([3000]);
	});

	test("Retry-After is clamped to 20 seconds", async () => {
		const { complete, sleeps } = setup([status(429, { "retry-after": "120" }), completion("after")]);
		await complete("s", "u");
		expect(sleeps).toEqual([20000]);
	});

	test("Retry-After accepts an HTTP date, clamped to the 0..20 s range", async () => {
		const past = new Date(Date.now() - 60_000).toUTCString();
		const future = new Date(Date.now() + 3_600_000).toUTCString();
		const first = setup([status(429, { "retry-after": past }), completion("ok")]);
		await first.complete("s", "u");
		expect(first.sleeps).toEqual([0]);
		const second = setup([status(503, { "retry-after": future }), completion("ok")]);
		await second.complete("s", "u");
		expect(second.sleeps).toEqual([20000]);
	});

	test("an unparseable Retry-After falls back to exponential backoff with jitter", async () => {
		const { complete, sleeps } = setup([status(429, { "retry-after": "soon" }), status(429), completion("ok")]);
		await complete("s", "u");
		expect(sleeps).toHaveLength(2);
		expect(sleeps[0] as number).toBeGreaterThanOrEqual(500);
		expect(sleeps[0] as number).toBeLessThan(750);
		expect(sleeps[1] as number).toBeGreaterThanOrEqual(1000);
		expect(sleeps[1] as number).toBeLessThan(1250);
	});

	test("429 that never clears ends as rate_limited after three attempts", async () => {
		const { complete, calls, sleeps } = setup([status(429), status(429), status(429), completion("never")]);
		const error = await failure(complete("s", "u"));
		expect(error.code).toBe("rate_limited");
		expect(calls).toHaveLength(3);
		expect(sleeps).toHaveLength(2);
		expectNoLeak(error);
	});

	test("5xx is retried twice and then reported as upstream", async () => {
		const { complete, calls, sleeps } = setup([status(500), status(502), status(503), completion("never")]);
		const error = await failure(complete("s", "u"));
		expect(error.code).toBe("upstream");
		expect(error.status).toBe(503);
		expect(calls).toHaveLength(3);
		expect(sleeps).toHaveLength(2);
		expectNoLeak(error);
	});

	test("a 5xx followed by success returns the text", async () => {
		const { complete, calls } = setup([status(500), completion("recovered")]);
		expect(await complete("s", "u")).toBe("recovered");
		expect(calls).toHaveLength(2);
	});
});

describe("network errors", () => {
	test("a network error is retried and the call can still succeed", async () => {
		const boom: Step = () => {
			throw new TypeError(`connect ECONNRESET while sending ${KEY}`);
		};
		const { complete, calls, sleeps } = setup([boom, boom, completion("third time")]);
		expect(await complete("s", "u")).toBe("third time");
		expect(calls).toHaveLength(3);
		expect(sleeps).toHaveLength(2);
	});

	test("a network error that persists is upstream and does not leak the underlying message", async () => {
		const boom: Step = () => {
			throw new TypeError(`connect ECONNRESET while sending ${KEY} ${BODY_MARK}`);
		};
		const { complete, calls } = setup([boom, boom, boom, completion("never")]);
		const error = await failure(complete("s", "u"));
		expect(error.code).toBe("upstream");
		expect(calls).toHaveLength(3);
		expect(error.cause).toBeUndefined();
		expectNoLeak(error);
	});
});

describe("timeout and abort", () => {
	test("the per-call timeout cancels the request and is not retried", async () => {
		const { complete, calls, sleeps } = setup([pendingUntilAbort, completion("never")], { timeoutMs: 10 });
		const error = await failure(complete("s", "u"));
		expect(error.code).toBe("timeout");
		expect(calls).toHaveLength(1);
		expect((calls[0] as Call).init.signal?.aborted).toBe(true);
		expect(sleeps).toEqual([]);
	});

	test("a caller abort during the request cancels it and reports aborted", async () => {
		const controller = new AbortController();
		const { complete, calls, sleeps } = setup(
			[
				(init) => {
					queueMicrotask(() => controller.abort());
					return pendingUntilAbort(init);
				},
				completion("never"),
			],
			{ timeoutMs: 60_000 },
		);
		const error = await failure(complete("s", "u", controller.signal));
		expect(error.code).toBe("aborted");
		expect(calls).toHaveLength(1);
		expect((calls[0] as Call).init.signal?.aborted).toBe(true);
		expect(sleeps).toEqual([]);
	});

	test("an already aborted signal never reaches fetch", async () => {
		const controller = new AbortController();
		controller.abort();
		const { complete, calls } = setup([completion("never")]);
		const error = await failure(complete("s", "u", controller.signal));
		expect(error.code).toBe("aborted");
		expect(calls).toHaveLength(0);
	});

	test("an abort during the backoff wait stops the retry", async () => {
		const controller = new AbortController();
		const script = scripted([status(503), completion("never")]);
		const complete = createOpenRouterCompleter({
			apiKey: KEY,
			baseUrl: BASE,
			model: "m",
			maxOutputTokens: 256,
			timeoutMs: 5000,
			fetch: script.fetch,
			sleep: async () => {
				controller.abort();
			},
		});
		const error = await failure(complete("s", "u", controller.signal));
		expect(error.code).toBe("aborted");
		expect(script.calls).toHaveLength(1);
	});

	test("an abort while the body is being read reports aborted", async () => {
		const controller = new AbortController();
		const { complete } = setup([
			(init) => {
				const stream = new ReadableStream<Uint8Array>({
					start(streamController) {
						init.signal?.addEventListener("abort", () => streamController.error(new DOMException("aborted", "AbortError")), { once: true });
						queueMicrotask(() => controller.abort());
					},
				});
				return new Response(stream, { status: 200 });
			},
		]);
		const error = await failure(complete("s", "u", controller.signal));
		expect(error.code).toBe("aborted");
	});
});

describe("response validation", () => {
	test("malformed JSON gives bad_response without a retry", async () => {
		const { complete, calls } = setup([status(200, {}, `{"choices": [ ${BODY_MARK} ${KEY}`), completion("never")]);
		const error = await failure(complete("s", "u"));
		expect(error.code).toBe("bad_response");
		expect(calls).toHaveLength(1);
		expectNoLeak(error);
	});

	test("JSON without a usable message gives bad_response", async () => {
		const bodies = [
			"null",
			"[]",
			"42",
			`{"error":{"message":"${BODY_MARK}"}}`,
			`{"choices":[]}`,
			`{"choices":[null]}`,
			`{"choices":[{}]}`,
			`{"choices":[{"message":{}}]}`,
			`{"choices":[{"message":{"content":42}}]}`,
		];
		for (const body of bodies) {
			const { complete, calls } = setup([status(200, {}, body), completion("never")]);
			const error = await failure(complete("s", "u"));
			expect(error.code).toBe("bad_response");
			expect(calls).toHaveLength(1);
			expectNoLeak(error);
		}
	});

	test("empty, blank or null content gives empty without a retry", async () => {
		for (const content of ["", "  \n\t ", null, []]) {
			const { complete, calls } = setup([completion(content), completion("never")]);
			const error = await failure(complete("s", "u"));
			expect(error.code).toBe("empty");
			expect(calls).toHaveLength(1);
		}
	});

	test("content parts are joined into text", async () => {
		const { complete } = setup([completion([{ type: "text", text: "one " }, { type: "image" }, { type: "text", text: "two" }])]);
		expect(await complete("s", "u")).toBe("one two");
	});

	test("every failure carries one of the documented codes", async () => {
		const codes: OpenRouterErrorCode[] = [];
		for (const step of [status(401), status(429), status(500), status(200, {}, "not json"), completion("")]) {
			const { complete } = setup([step, step, step]);
			codes.push((await failure(complete("s", "u"))).code);
		}
		expect(codes).toEqual(["auth", "rate_limited", "upstream", "bad_response", "empty"]);
	});
});

describe("reasoning effort", () => {
	test("the option is sent as reasoning.effort next to the other fields", async () => {
		const { complete, calls } = setup([completion("ok")], { reasoningEffort: "low" });
		await complete("SYS", "USR");
		expect(JSON.parse((calls[0] as Call).init.body as string)).toEqual({
			model: "x-ai/grok-4.7",
			messages: [
				{ role: "system", content: "SYS" },
				{ role: "user", content: "USR" },
			],
			max_tokens: 1234,
			usage: { include: true },
			reasoning: { effort: "low" },
		});
	});

	test("every effort value is passed through unchanged", async () => {
		for (const effort of ["minimal", "low", "medium", "high"] as const) {
			const { complete, calls } = setup([completion("ok")], { reasoningEffort: effort });
			await complete("s", "u");
			expect(JSON.parse((calls[0] as Call).init.body as string).reasoning).toEqual({ effort });
		}
	});

	test("without the option the body has no reasoning key", async () => {
		const { complete, calls } = setup([completion("ok")]);
		await complete("s", "u");
		expect("reasoning" in JSON.parse((calls[0] as Call).init.body as string)).toBe(false);
	});
});

describe("onCall", () => {
	function recorded(
		steps: Step[],
		overrides: Partial<OpenRouterCompleterOptions> = {},
	): { complete: OpenRouterCompleter; infos: OpenRouterCallInfo[] } {
		const infos: OpenRouterCallInfo[] = [];
		const { complete } = setup(steps, { onCall: (info) => infos.push(info), ...overrides });
		return { complete, infos };
	}

	test("success reports ok with one attempt and a non-negative duration", async () => {
		const { complete, infos } = recorded([completion("fine")]);
		await complete("s", "u");
		expect(infos).toHaveLength(1);
		const info = infos[0] as OpenRouterCallInfo;
		expect(info.outcome).toBe("ok");
		expect(info.attempts).toBe(1);
		expect(info.status).toBeUndefined();
		expect(Number.isFinite(info.ms)).toBe(true);
		expect(info.ms).toBeGreaterThanOrEqual(0);
	});

	test("a retried 429 then success reports once with two attempts", async () => {
		const { complete, infos } = recorded([status(429, { "retry-after": "1" }), completion("fine")]);
		await complete("s", "u");
		expect(infos).toHaveLength(1);
		expect(infos[0]).toMatchObject({ outcome: "ok", attempts: 2 });
	});

	test("a terminal auth error reports the code and status once, before the throw", async () => {
		const { complete, infos } = recorded([status(401)]);
		const error = await failure(complete("s", "u"));
		expect(error.code).toBe("auth");
		expect(infos).toHaveLength(1);
		expect(infos[0]).toMatchObject({ outcome: "auth", status: 401, attempts: 1 });
	});

	test("exhausted retries report the final error and all attempts", async () => {
		const { complete, infos } = recorded([status(500), status(502), status(503)]);
		await failure(complete("s", "u"));
		expect(infos).toHaveLength(1);
		expect(infos[0]).toMatchObject({ outcome: "upstream", status: 503, attempts: 3 });
	});

	test("a timeout reports timeout with one attempt", async () => {
		const { complete, infos } = recorded([pendingUntilAbort], { timeoutMs: 10 });
		const error = await failure(complete("s", "u"));
		expect(error.code).toBe("timeout");
		expect(infos).toHaveLength(1);
		expect(infos[0]).toMatchObject({ outcome: "timeout", attempts: 1 });
	});

	test("an already aborted signal reports aborted with zero attempts", async () => {
		const controller = new AbortController();
		controller.abort();
		const { complete, infos } = recorded([completion("never")]);
		await failure(complete("s", "u", controller.signal));
		expect(infos).toHaveLength(1);
		expect(infos[0]).toMatchObject({ outcome: "aborted", attempts: 0 });
	});

	test("the info carries only the documented fields, never the key or a body", async () => {
		const { complete, infos } = recorded([status(500), completion("secret answer")]);
		await complete("s", "u");
		const json = JSON.stringify(infos);
		expect(Object.keys(infos[0] as OpenRouterCallInfo).sort()).toEqual(["attempts", "ms", "outcome"]);
		expect(json).not.toContain(KEY);
		expect(json).not.toContain(BODY_MARK);
		expect(json).not.toContain("secret answer");
	});

	test("a throwing hook does not change a success", async () => {
		const { complete } = setup([completion("fine")], {
			onCall: () => {
				throw new Error(`hook broke ${KEY}`);
			},
		});
		expect(await complete("s", "u")).toBe("fine");
	});

	test("a throwing hook does not change the thrown error", async () => {
		const { complete } = setup([status(401)], {
			onCall: () => {
				throw new Error(`hook broke ${KEY}`);
			},
		});
		const error = await failure(complete("s", "u"));
		expect(error.code).toBe("auth");
		expectNoLeak(error);
	});
});
