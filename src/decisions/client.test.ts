// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, describe, expect, test } from "bun:test";
import { USER_AGENT } from "../mcp/providers.ts";
import {
	type DecideOptions,
	type DecisionsUrl,
	decide,
	estimateTokens,
	parseDecisionsResponse,
	redact,
	resolveDecisionsUrl,
	validateRequest,
} from "./client.ts";
import { QUESTIONS } from "./questions.ts";
import { DecisionsError, type DecisionsRequest, type DecisionsResponse } from "./types.ts";

const K = "sk-or-v1-UTTESTKEY-0123456789abcdef";
const ENDPOINT = "https://openrouter.ai/api/alpha/decisions";
interface Recorded {
	url: string;
	method: string;
	headers: Record<string, string>;
	body: unknown;
}

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

/** Recording fetch R: records every call, answers from a queue (last entry repeats). Installed as globalThis.fetch too. */
function recordingFetch(queue: Array<() => Response | Promise<Response>>): { fetch: typeof fetch; calls: Recorded[] } {
	const calls: Recorded[] = [];
	const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
		const headers: Record<string, string> = {};
		new Headers(init?.headers).forEach((value, key) => {
			headers[key] = value;
		});
		const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : init?.body;
		calls.push({ url: String(input), method: init?.method ?? "GET", headers, body });
		const next = queue[Math.min(calls.length, queue.length) - 1];
		if (!next) throw new Error("empty queue");
		return next();
	}) as typeof fetch;
	globalThis.fetch = fetchImpl;
	return { fetch: fetchImpl, calls };
}

const JEV =
	(p: number, key = "plan_worthy") =>
	() =>
		Response.json({
			id: "gen-dec-test",
			model: "typesafe/jev-1.13-20260917",
			provider: "TypeSafe",
			answers: { [key]: { type: "noul", noul: p } },
			usage: { input_tokens: 450, output_tokens: 0, cost: 0.000019 },
		});
const ERR = (s: number, headers?: Record<string, string>) => () =>
	Response.json({ error: { code: s, message: `upstream said no for ${K}` } }, { status: s, headers });
const OK = (body: unknown) => () => Response.json(body);

/** Never resolves; rejects with an AbortError when its signal fires (as src/grok/complete.test.ts hangingFetch). */
function hangingFetch(onCall?: () => void): typeof fetch {
	return ((_input: string | URL | Request, init?: RequestInit) =>
		new Promise<Response>((_resolve, reject) => {
			init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
			onCall?.();
		})) as typeof fetch;
}

async function rejection(promise: Promise<unknown>): Promise<{ name?: string }> {
	try {
		await promise;
	} catch (error) {
		return error as { name?: string };
	}
	throw new Error("expected promise to reject");
}

const REQUEST: DecisionsRequest = {
	model: "~typesafe/jev-latest",
	state: { message: "Add OAuth login with GitHub to the web app", recent_conversation: "" },
	questions: { plan_worthy: QUESTIONS.plan },
};
const CHOICE_REQUEST: DecisionsRequest = {
	model: "~typesafe/jev-latest",
	state: "state",
	questions: { pick: { type: "choice", instructions: "Pick one", criteria: { a: "first", b: "second" } } },
};
const SCORE_REQUEST: DecisionsRequest = {
	model: "~typesafe/jev-latest",
	state: ["state"],
	questions: { level: { type: "score", instructions: "Rate it", criteria: ["low", "mid", "high"] } },
};

function run(fetchImpl: typeof fetch, extra: Partial<DecideOptions> = {}, request: DecisionsRequest = REQUEST) {
	return decide(request, { apiKey: K, timeoutMs: 3000, fetch: fetchImpl, sleep: async () => {}, random: () => 0.5, ...extra });
}

/** Rule T6: every error message is redacted and short. */
function expectSafe(error: DecisionsError): void {
	expect(error).toBeInstanceOf(DecisionsError);
	expect(error.name).toBe("DecisionsError");
	expect(error.message).not.toContain(K);
	expect(error.message).not.toContain("Bearer sk-or-");
	expect(error.message.length).toBeLessThanOrEqual(200);
	expect(error.message).not.toContain("\n");
}

async function failure(fetchImpl: typeof fetch, extra: Partial<DecideOptions> = {}, request: DecisionsRequest = REQUEST) {
	const outcome = await run(fetchImpl, extra, request);
	if (outcome.ok) throw new Error("expected a failed decision");
	expectSafe(outcome.error);
	return outcome;
}

describe("decide: request", () => {
	test("POSTs the request as JSON to the default endpoint with Bearer auth and the ultrathink User-Agent", async () => {
		const r = recordingFetch([JEV(0.97)]);
		const outcome = await decide(REQUEST, { apiKey: K, timeoutMs: 3000 });
		expect(outcome.ok).toBe(true);
		expect(r.calls).toHaveLength(1);
		expect(r.calls[0]).toEqual({
			url: ENDPOINT,
			method: "POST",
			headers: { authorization: `Bearer ${K}`, "content-type": "application/json", "user-agent": USER_AGENT },
			body: REQUEST,
		});
	});

	test("sends to opts.url when given", async () => {
		const r = recordingFetch([JEV(0.5)]);
		await run(r.fetch, { url: "http://127.0.0.1:9999/decisions" });
		expect(r.calls.map((call) => call.url)).toEqual(["http://127.0.0.1:9999/decisions"]);
	});

	test("K3: a redirect is never followed, so the key never reaches the redirect target", async () => {
		const target: string[] = [];
		const evil = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: (req) => {
				target.push(req.headers.get("authorization") ?? "");
				return JEV(0.9)();
			},
		});
		const origin = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: () => new Response(null, { status: 307, headers: { Location: `http://127.0.0.1:${evil.port}/decisions` } }),
		});
		try {
			const outcome = await decide(REQUEST, {
				apiKey: K,
				timeoutMs: 3000,
				url: `http://127.0.0.1:${origin.port}/decisions`,
				fetch: realFetch,
				sleep: async () => {},
			});
			if (outcome.ok) throw new Error("expected the redirect to fail");
			expectSafe(outcome.error);
			expect(outcome.error.kind).toBe("network");
			expect(target).toEqual([]);
		} finally {
			origin.stop(true);
			evil.stop(true);
		}
	});

	test("F3: a timeout beyond what timers accept still settles instead of rejecting", async () => {
		const r = recordingFetch([JEV(0.5)]);
		const outcome = await run(r.fetch, { timeoutMs: 1e20 });
		expect(outcome).toMatchObject({ ok: true, attempts: 1 });
		expect(r.calls).toHaveLength(1);
	});

	test("a success returns the parsed response, one attempt and a latency from the injected clock", async () => {
		const r = recordingFetch([JEV(0.97)]);
		let clock = 1000;
		const outcome = await run(r.fetch, {
			now: () => {
				clock += 10;
				return clock;
			},
		});
		if (!outcome.ok) throw new Error("expected success");
		expect(outcome.attempts).toBe(1);
		expect(outcome.latencyMs).toBeGreaterThan(0);
		expect(outcome.response).toEqual({
			id: "gen-dec-test",
			model: "typesafe/jev-1.13-20260917",
			provider: "TypeSafe",
			answers: { plan_worthy: { type: "noul", noul: 0.97 } },
			usage: { input_tokens: 450, output_tokens: 0, cost: 0.000019 },
		});
	});
});

describe("decide: failures are classified and redacted (D6)", () => {
	test("AC-4.1: a 401 maps to auth after one request, with the key redacted", async () => {
		const r = recordingFetch([ERR(401)]);
		const outcome = await failure(r.fetch);
		expect(outcome.error.kind).toBe("auth");
		expect(outcome.error.status).toBe(401);
		expect(outcome.error.message).toBe("decisions auth: HTTP 401: upstream said no for [redacted]");
		expect(outcome.attempts).toBe(1);
		expect(r.calls).toHaveLength(1);
	});

	test.each([
		[402, "credits"],
		[400, "bad-request"],
		[403, "auth"],
		[404, "bad-request"],
		[413, "too-large"],
		[418, "bad-request"],
		[501, "upstream"],
		[504, "upstream"],
	] as const)("AC-4.2/4.3/4.19: HTTP %d maps to %s and is not retried", async (status, kind) => {
		const r = recordingFetch([ERR(status), JEV(0.97)]);
		const outcome = await failure(r.fetch);
		expect(outcome.error.kind).toBe(kind);
		expect(outcome.attempts).toBe(1);
		expect(r.calls).toHaveLength(1);
	});

	test("AC-4.4: 429 then 429 maps to rate-limit after two requests", async () => {
		const r = recordingFetch([ERR(429)]);
		const outcome = await failure(r.fetch);
		expect(outcome.error.kind).toBe("rate-limit");
		expect(outcome.attempts).toBe(2);
		expect(r.calls).toHaveLength(2);
	});

	test.each([500, 502, 503, 524, 529])("AC-4.5: %d twice maps to upstream after two requests", async (status) => {
		const r = recordingFetch([ERR(status)]);
		const outcome = await failure(r.fetch);
		expect(outcome.error.kind).toBe("upstream");
		expect(outcome.attempts).toBe(2);
		expect(r.calls).toHaveLength(2);
	});

	test("A15: a final 408 maps to timeout after the retry", async () => {
		const r = recordingFetch([ERR(408)]);
		const outcome = await failure(r.fetch);
		expect(outcome.error.kind).toBe("timeout");
		expect(outcome.attempts).toBe(2);
	});

	test("AC-4.19: a fetch that throws twice maps to network after two requests", async () => {
		const r = recordingFetch([
			() => {
				throw new TypeError("fetch failed");
			},
		]);
		const outcome = await failure(r.fetch);
		expect(outcome.error.kind).toBe("network");
		expect(outcome.error.message).toBe("decisions network: fetch failed");
		expect(outcome.attempts).toBe(2);
		expect(r.calls).toHaveLength(2);
	});

	// Real timers (rule T7): the budget is enforced by AbortSignal.timeout, which fake clocks do not drive.
	test("AC-4.6: a hanging request maps to timeout within the budget", async () => {
		let calls = 0;
		const started = performance.now();
		const outcome = await failure(hangingFetch(() => calls++), { timeoutMs: 400 });
		const elapsed = performance.now() - started;
		expect(outcome.error.kind).toBe("timeout");
		expect(outcome.error.message).toBe("decisions timeout: no answer within 400 ms");
		expect(outcome.attempts).toBe(1);
		expect(calls).toBe(1);
		expect(elapsed).toBeLessThanOrEqual(400 + 250);
	});

	// Real timers: proves the budget holds even when a fetch never observes its abort signal.
	test("a fetch that ignores its signal still times out", async () => {
		const ignoring = (() => new Promise<Response>(() => {})) as unknown as typeof fetch;
		const started = performance.now();
		const outcome = await failure(ignoring, { timeoutMs: 300 });
		expect(outcome.error.kind).toBe("timeout");
		expect(performance.now() - started).toBeLessThanOrEqual(300 + 250);
	});

	test("the upstream detail falls back to the body text, then the status text", async () => {
		const text = await failure(recordingFetch([() => new Response(`gateway broke ${K}`, { status: 400 })]).fetch);
		expect(text.error.message).toBe("decisions bad-request: HTTP 400: gateway broke [redacted]");
		const empty = await failure(recordingFetch([() => new Response("", { status: 404, statusText: "Not Found" })]).fetch);
		expect(empty.error.message).toBe("decisions bad-request: HTTP 404: Not Found");
	});

	test("AC-4.15: a key echoed in a long, multi-line upstream error never reaches the message", async () => {
		const noisy = () =>
			Response.json(
				{ error: { message: `bad\nkey ${K} Authorization: Bearer ${K} other sk-or-v1-OTHER-KEY ${"x".repeat(400)}` } },
				{ status: 401 },
			);
		const outcome = await failure(recordingFetch([noisy]).fetch);
		expect(outcome.error.message.length).toBe(200);
		expect(outcome.error.message.endsWith("...")).toBe(true);
		expect(outcome.error.message).not.toContain("sk-or-");
	});
});

describe("decide: strict response validation (D7)", () => {
	test("AC-4.7: a 200 with a body that is not JSON maps to invalid-response and is not retried", async () => {
		const r = recordingFetch([() => new Response("{not json", { status: 200 }), JEV(0.9)]);
		const outcome = await failure(r.fetch);
		expect(outcome.error.kind).toBe("invalid-response");
		expect(outcome.attempts).toBe(1);
		expect(r.calls).toHaveLength(1);
	});

	test("AC-4.8: a missing answer key maps to invalid-response", async () => {
		const outcome = await failure(recordingFetch([OK({ model: "m", answers: {}, usage: { input_tokens: 1, output_tokens: 0 } })]).fetch);
		expect(outcome.error.kind).toBe("invalid-response");
		expect(outcome.error.message).toBe("decisions invalid-response: answers.plan_worthy is missing");
	});

	test("AC-4.9: noul 1.5 maps to invalid-response and no probability is returned", async () => {
		const outcome = await failure(recordingFetch([JEV(1.5)]).fetch);
		expect(outcome.error.kind).toBe("invalid-response");
		expect(outcome.error.message).toBe("decisions invalid-response: answers.plan_worthy.noul must be a finite number in [0, 1]");
		expect(outcome).not.toHaveProperty("response");
	});

	test("AC-4.10: a choice outside the criteria maps to invalid-response", async () => {
		const body = { model: "m", answers: { pick: { type: "choice", choice: "c" } }, usage: { input_tokens: 1, output_tokens: 0 } };
		const outcome = await failure(recordingFetch([OK(body)]).fetch, {}, CHOICE_REQUEST);
		expect(outcome.error.kind).toBe("invalid-response");
	});

	const usage = { input_tokens: 450, output_tokens: 0, cost: 0.000019 };
	test.each([
		["an extra answer key", REQUEST, { model: "m", answers: { plan_worthy: { type: "noul", noul: 0.5 }, extra: { type: "noul", noul: 0.5 } }, usage }],
		["type score for a noul question", REQUEST, { model: "m", answers: { plan_worthy: { type: "score", score: 1 } }, usage }],
		["noul NaN encoded as null", REQUEST, { model: "m", answers: { plan_worthy: { type: "noul", noul: null } }, usage }],
		["a noul given as a string", REQUEST, { model: "m", answers: { plan_worthy: { type: "noul", noul: "0.5" } }, usage }],
		["a score one past the top level", SCORE_REQUEST, { model: "m", answers: { level: { type: "score", score: 3 } }, usage }],
		["confidence 1.2", CHOICE_REQUEST, { model: "m", answers: { pick: { type: "choice", choice: "a", confidence: 1.2 } }, usage }],
		[
			"probabilities keyed by a non-option",
			CHOICE_REQUEST,
			{ model: "m", answers: { pick: { type: "choice", choice: "a", probabilities: { a: 0.5, c: 0.5 } } }, usage },
		],
		[
			"score probabilities missing a level",
			SCORE_REQUEST,
			{ model: "m", answers: { level: { type: "score", score: 1, probabilities: { "0": 0.5, "1": 0.5 } } }, usage },
		],
		["usage.input_tokens as a string", REQUEST, { model: "m", answers: { plan_worthy: { type: "noul", noul: 0.5 } }, usage: { ...usage, input_tokens: "450" } }],
		["usage.cost as a string", REQUEST, { model: "m", answers: { plan_worthy: { type: "noul", noul: 0.5 } }, usage: { ...usage, cost: "x" } }],
		["a missing model", REQUEST, { answers: { plan_worthy: { type: "noul", noul: 0.5 } }, usage }],
		["an id that is not a string", REQUEST, { id: 7, model: "m", answers: { plan_worthy: { type: "noul", noul: 0.5 } }, usage }],
		["a missing usage", REQUEST, { model: "m", answers: { plan_worthy: { type: "noul", noul: 0.5 } } }],
		["a body that is an array", REQUEST, [1, 2]],
	] as const)("AC-4.18: %s maps to invalid-response", async (_name, request, body) => {
		const r = recordingFetch([OK(body)]);
		const outcome = await failure(r.fetch, {}, request);
		expect(outcome.error.kind).toBe("invalid-response");
		expect(outcome.attempts).toBe(1);
		expect(r.calls).toHaveLength(1);
	});

	test("AC-4.18: a response without the optional cost, id and provider is accepted", async () => {
		const body: DecisionsResponse = {
			model: "m",
			answers: { plan_worthy: { type: "noul", noul: 0.5 } },
			usage: { input_tokens: 1, output_tokens: 0 },
		};
		const outcome = await run(recordingFetch([OK(body)]).fetch);
		expect(outcome).toMatchObject({ ok: true, attempts: 1 });
		if (outcome.ok) expect(outcome.response).toEqual(body);
	});

	test("parseDecisionsResponse keeps only the typed fields and accepts valid choice and score answers", () => {
		const usage = { input_tokens: 1, output_tokens: 2, cost: 0, extra: true };
		expect(
			parseDecisionsResponse(
				{ model: "m", surprise: 1, answers: { pick: { type: "choice", choice: "b", probabilities: { a: 0.1, b: 0.9 }, confidence: 0.8, note: "x" } }, usage },
				CHOICE_REQUEST.questions,
			),
		).toEqual({
			model: "m",
			answers: { pick: { type: "choice", choice: "b", probabilities: { a: 0.1, b: 0.9 }, confidence: 0.8 } },
			usage: { input_tokens: 1, output_tokens: 2, cost: 0 },
		});
		expect(
			parseDecisionsResponse(
				{ model: "m", answers: { level: { type: "score", score: 2, probabilities: { "0": 0, "1": 0.2, "2": 0.8 } } }, usage },
				SCORE_REQUEST.questions,
			).answers,
		).toEqual({ level: { type: "score", score: 2, probabilities: { "0": 0, "1": 0.2, "2": 0.8 } } });
	});
});

describe("decide: local request validation (D7)", () => {
	test("AC-4.16: an oversized state fails locally as too-large with zero requests; a 100,000-char state is sent", async () => {
		const r = recordingFetch([JEV(0.5)]);
		const big = { ...REQUEST, state: "x".repeat(120_000) };
		const outcome = await failure(r.fetch, {}, big);
		expect(outcome.error.kind).toBe("too-large");
		expect(outcome.error.message).toBe(`decisions too-large: request is about ${estimateTokens(big)} tokens (limit 28000)`);
		expect(outcome.attempts).toBe(0);
		expect(r.calls).toHaveLength(0);
		const fits = await run(r.fetch, {}, { ...REQUEST, state: "x".repeat(100_000) });
		expect(fits.ok).toBe(true);
		expect(r.calls).toHaveLength(1);
	});

	test.each([
		["empty questions", { ...REQUEST, questions: {} }],
		["noul criteria with only true", { ...REQUEST, questions: { q: { type: "noul", instructions: "i", criteria: { true: "yes" } } } }],
		["a choice with 1 option", { ...REQUEST, questions: { q: { type: "choice", instructions: "i", criteria: { a: "only" } } } }],
		["a score with 1 level", { ...REQUEST, questions: { q: { type: "score", instructions: "i", criteria: ["only"] } } }],
		["state 42", { ...REQUEST, state: 42 }],
		["state null", { ...REQUEST, state: null }],
		["state true", { ...REQUEST, state: true }],
		["an empty model", { ...REQUEST, model: "" }],
		["instructions that are not a string", { ...REQUEST, questions: { q: { type: "noul" } } }],
		["an unknown question type", { ...REQUEST, questions: { q: { type: "text", instructions: "i" } } }],
	])("AC-4.17: %s fails locally as bad-request with zero requests", async (_name, request) => {
		const r = recordingFetch([JEV(0.5)]);
		const outcome = await failure(r.fetch, {}, request as unknown as DecisionsRequest);
		expect(outcome.error.kind).toBe("bad-request");
		expect(outcome.error.message.startsWith("decisions bad-request: ")).toBe(true);
		expect(outcome.attempts).toBe(0);
		expect(r.calls).toHaveLength(0);
	});

	test("validateRequest accepts the shipped plan question with object, string and array state", () => {
		expect(validateRequest(REQUEST)).toBeUndefined();
		expect(validateRequest({ ...REQUEST, state: "text" })).toBeUndefined();
		expect(validateRequest({ ...REQUEST, state: [] })).toBeUndefined();
		expect(validateRequest(CHOICE_REQUEST)).toBeUndefined();
		expect(validateRequest(SCORE_REQUEST)).toBeUndefined();
	});
});

describe("decide: retry (D6)", () => {
	test("AC-5.1: 503 then 200 succeeds on the second attempt", async () => {
		const r = recordingFetch([ERR(503), JEV(0.97)]);
		const outcome = await run(r.fetch);
		expect(outcome).toMatchObject({ ok: true, attempts: 2 });
		if (outcome.ok) expect(outcome.response.answers.plan_worthy).toEqual({ type: "noul", noul: 0.97 });
		expect(r.calls).toHaveLength(2);
	});

	test("AC-5.2: no retry when less than 500 ms of the budget is left", async () => {
		let clock = 0;
		const r = recordingFetch([
			() => {
				clock += 2600;
				return ERR(503)();
			},
			JEV(0.97),
		]);
		const sleeps: number[] = [];
		const outcome = await failure(r.fetch, { now: () => clock, sleep: async (ms) => void sleeps.push(ms) });
		expect(outcome.error.kind).toBe("upstream");
		expect(outcome.attempts).toBe(1);
		expect(outcome.latencyMs).toBe(2600);
		expect(r.calls).toHaveLength(1);
		expect(sleeps).toEqual([]);
	});

	test("AC-5.3: a 402 is not retried and never sleeps", async () => {
		const r = recordingFetch([ERR(402), JEV(0.97)]);
		const sleeps: number[] = [];
		const outcome = await failure(r.fetch, { sleep: async (ms) => void sleeps.push(ms) });
		expect(outcome.error.kind).toBe("credits");
		expect(r.calls).toHaveLength(1);
		expect(sleeps).toEqual([]);
	});

	const thrown = () => {
		throw new TypeError("fetch failed");
	};
	test.each([
		["a thrown network error", thrown],
		["408", ERR(408)],
		["429", ERR(429)],
		["500", ERR(500)],
		["502", ERR(502)],
		["503", ERR(503)],
		["524", ERR(524)],
		["529", ERR(529)],
	])("AC-5.4: a transient first failure (%s) is retried once and succeeds", async (_name, first) => {
		const r = recordingFetch([first, JEV(0.5)]);
		const outcome = await run(r.fetch);
		expect(outcome).toMatchObject({ ok: true, attempts: 2 });
		expect(r.calls).toHaveLength(2);
	});

	test.each([
		[400, "bad-request"],
		[401, "auth"],
		[403, "auth"],
		[404, "bad-request"],
		[413, "too-large"],
	] as const)("AC-5.4: a non-transient first failure (%d) returns %s after one request", async (status, kind) => {
		const r = recordingFetch([ERR(status), JEV(0.5)]);
		const outcome = await failure(r.fetch);
		expect(outcome.error.kind).toBe(kind);
		expect(r.calls).toHaveLength(1);
	});

	test("AC-5.5: Retry-After is honoured when it fits the budget", async () => {
		const r = recordingFetch([ERR(429, { "Retry-After": "1" }), JEV(0.5)]);
		const sleeps: number[] = [];
		const outcome = await run(r.fetch, { now: () => 0, sleep: async (ms) => void sleeps.push(ms) });
		expect(outcome).toMatchObject({ ok: true, attempts: 2 });
		expect(sleeps).toEqual([1000]);
		expect(r.calls).toHaveLength(2);
	});

	test("AC-5.5: a Retry-After that does not fit is replaced by one jittered wait under 500 ms", async () => {
		const r = recordingFetch([ERR(429, { "Retry-After": "10" }), JEV(0.5)]);
		const sleeps: number[] = [];
		const outcome = await run(r.fetch, { now: () => 0, sleep: async (ms) => void sleeps.push(ms), random: Math.random });
		expect(outcome).toMatchObject({ ok: true, attempts: 2 });
		expect(sleeps).toHaveLength(1);
		expect(sleeps[0]).toBeGreaterThan(0);
		expect(sleeps[0]).toBeLessThan(500);
		expect(r.calls).toHaveLength(2);
	});

	test("A9: the jitter spans 125 to 375 ms", async () => {
		for (const [random, expected] of [
			[0, 125],
			[0.5, 250],
			[0.999999, 375],
		] as const) {
			const sleeps: number[] = [];
			await run(recordingFetch([ERR(503), JEV(0.5)]).fetch, { random: () => random, sleep: async (ms) => void sleeps.push(ms) });
			expect(sleeps).toEqual([expected]);
		}
	});

	test("an HTTP-date Retry-After waits until that date when it fits", async () => {
		const start = Date.UTC(2026, 8, 30, 12, 0, 0);
		const date = new Date(start + 2000).toUTCString();
		const sleeps: number[] = [];
		const outcome = await run(recordingFetch([ERR(503, { "Retry-After": date }), JEV(0.5)]).fetch, {
			now: () => start,
			sleep: async (ms) => void sleeps.push(ms),
		});
		expect(outcome.ok).toBe(true);
		expect(sleeps).toEqual([2000]);
	});

	// Real timers (rule T7): the retry wait and the second attempt's timeout run on the platform clock.
	test("AC-5.8: the total budget covers the retry on real timers", async () => {
		let calls = 0;
		const fetchImpl = ((_input: string | URL | Request, init?: RequestInit) => {
			calls++;
			if (calls === 1) return Bun.sleep(200).then(() => ERR(503)());
			return new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
			});
		}) as typeof fetch;
		const started = performance.now();
		const outcome = await decide(REQUEST, { apiKey: K, timeoutMs: 1200, fetch: fetchImpl });
		const elapsed = performance.now() - started;
		if (outcome.ok) throw new Error("expected a timeout");
		expectSafe(outcome.error);
		expect(outcome.error.kind).toBe("timeout");
		expect(outcome.attempts).toBe(2);
		expect(calls).toBe(2);
		expect(elapsed).toBeLessThanOrEqual(1200 + 250);
	});
});

describe("decide: caller abort (AC-5.6)", () => {
	test("an abort after the first request starts rejects with AbortError and makes no retry", async () => {
		const controller = new AbortController();
		let calls = 0;
		const fetchImpl = hangingFetch(() => {
			calls++;
			queueMicrotask(() => controller.abort());
		});
		const error = await rejection(run(fetchImpl, { signal: controller.signal }));
		expect(error.name).toBe("AbortError");
		expect(error).not.toBeInstanceOf(DecisionsError);
		expect(calls).toBe(1);
	});

	test("an abort reason that is not an AbortError still rejects with an AbortError", async () => {
		const controller = new AbortController();
		const fetchImpl = hangingFetch(() => queueMicrotask(() => controller.abort("stop")));
		const error = await rejection(run(fetchImpl, { signal: controller.signal }));
		expect(error.name).toBe("AbortError");
	});

	test("an already-aborted signal rejects before any request", async () => {
		const r = recordingFetch([JEV(0.5)]);
		const controller = new AbortController();
		controller.abort();
		const error = await rejection(run(r.fetch, { signal: controller.signal }));
		expect(error.name).toBe("AbortError");
		expect(r.calls).toHaveLength(0);
	});

	test("an abort during the retry wait rejects with AbortError and makes no second request", async () => {
		const r = recordingFetch([ERR(503), JEV(0.5)]);
		const controller = new AbortController();
		const error = await rejection(
			run(r.fetch, {
				signal: controller.signal,
				sleep: () => {
					controller.abort();
					return new Promise<void>(() => {});
				},
			}),
		);
		expect(error.name).toBe("AbortError");
		expect(r.calls).toHaveLength(1);
	});
});

describe("resolveDecisionsUrl (D1, K2)", () => {
	const resolve = (value: string) => resolveDecisionsUrl({ ULTRATHINK_DECISIONS_URL: value });
	const IGNORED: DecisionsUrl = { url: ENDPOINT, source: "default", ignored: true };

	test("unset or blank is the default endpoint, not an ignored override", () => {
		expect(resolveDecisionsUrl({})).toEqual({ url: ENDPOINT, source: "default" });
		expect(resolve("   ")).toEqual({ url: ENDPOINT, source: "default" });
	});

	test("accepts https://openrouter.ai paths and http or https loopback URLs", () => {
		expect(resolve(" https://openrouter.ai/api/beta/decisions ")).toEqual({
			url: "https://openrouter.ai/api/beta/decisions",
			source: "ULTRATHINK_DECISIONS_URL",
		});
		for (const url of [
			"http://127.0.0.1:9999/decisions",
			"https://127.0.0.1:9999/decisions",
			"http://localhost:8080/d",
			"http://[::1]:9999/decisions",
		]) {
			expect(resolve(url)).toEqual({ url, source: "ULTRATHINK_DECISIONS_URL" });
		}
	});

	test("rejects every other host, plain-http OpenRouter, userinfo and non-http schemes, falling back to the default", () => {
		for (const bad of [
			"https://gw.example/d",
			"https://openrouter.ai.evil.example/api/alpha/decisions",
			"https://evil.example/openrouter.ai",
			"http://gw.example/d",
			"http://openrouter.ai/api/alpha/decisions",
			"https://user:pass@openrouter.ai/api/alpha/decisions",
			"http://token@127.0.0.1:9999/decisions",
			"ftp://127.0.0.1/x",
			"file:///etc/passwd",
			"not a url",
		]) {
			expect(resolve(bad)).toEqual(IGNORED);
		}
	});

	test("drops the query and hash, so neither is sent nor printed", () => {
		expect(resolve("http://127.0.0.1:9999/decisions?token=secret#frag")).toEqual({
			url: "http://127.0.0.1:9999/decisions",
			source: "ULTRATHINK_DECISIONS_URL",
		});
	});
});

describe("redact (§5.9)", () => {
	test("masks the key, any sk-or- key, Bearer credentials and JWTs, on one line of at most 200 chars", () => {
		const jwt = `${"a".repeat(24)}.${"b".repeat(24)}.${"c".repeat(12)}`;
		const text = redact(`key ${K}\nBearer abc123 other sk-or-v1-zzz jwt ${jwt}`, K);
		expect(text).toBe("key [redacted] [redacted] other [redacted] jwt [redacted]");
		const long = redact(`${"y".repeat(300)} ${K}`, K);
		expect(long).toHaveLength(200);
		expect(long.endsWith("...")).toBe(true);
		expect(redact("short", "")).toBe("short");
	});
});
