// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import { QUESTIONS } from "./questions.ts";
import type { DecisionQuestion, DecisionsRequest } from "./types.ts";
import { VERCEL_DECISIONS_URL } from "./types.ts";
import { buildVercelBody, decideVercel, parseVercelResponse, resolveGatewayModel, vercelHeaders } from "./vercel.ts";

const K = "vck_test_key_do_not_use";
const MODEL = "~typesafe/jev-latest";

function request(questions: DecisionsRequest["questions"] = { plan_worthy: QUESTIONS.plan }): DecisionsRequest {
	return { model: MODEL, state: { message: "hi" }, questions };
}

describe("resolveGatewayModel", () => {
	test("the default model maps to the gateway id; an explicit model passes through verbatim", () => {
		expect(resolveGatewayModel("~typesafe/jev-latest")).toBe("typesafe-ai/jev");
		expect(resolveGatewayModel("typesafe/jev-1.13")).toBe("typesafe/jev-1.13");
		expect(resolveGatewayModel("custom/jev")).toBe("custom/jev");
	});
});

describe("vercelHeaders", () => {
	test("the exact v4 header set with the key and model id", () => {
		expect(vercelHeaders(K, "typesafe-ai/jev")).toEqual({
			Authorization: `Bearer ${K}`,
			"Content-Type": "application/json",
			"User-Agent": expect.any(String),
			"ai-gateway-protocol-version": "0.0.1",
			"ai-gateway-auth-method": "api-key",
			"ai-evaluation-model-specification-version": "4",
			"ai-model-id": "typesafe-ai/jev",
		});
	});
});

describe("buildVercelBody", () => {
	test("noul becomes boolean with criteria; model, provider, session and trace stay out", () => {
		const body = buildVercelBody({
			...request(),
			provider: { zdr: true, data_collection: "deny" },
			session_id: "s1",
			trace: { trace_name: "ultrathink" },
		});
		expect(body).toEqual({
			state: { message: "hi" },
			questions: {
				plan_worthy: { type: "boolean", instructions: QUESTIONS.plan.instructions, criteria: QUESTIONS.plan.criteria },
			},
		});
	});

	test("noul criteria pass through; choice and score pass through unchanged", () => {
		const questions: Record<string, DecisionQuestion> = {
			a: { type: "noul", instructions: "i", criteria: { true: "y", false: "n" } },
			b: { type: "choice", instructions: "i", criteria: { x: "X", y: "Y" } },
			c: { type: "score", instructions: "i", criteria: ["low", "high"] },
		};
		expect(buildVercelBody(request({ ...questions })).questions).toEqual({
			a: { type: "boolean", instructions: "i", criteria: { true: "y", false: "n" } },
			b: { type: "choice", instructions: "i", criteria: { x: "X", y: "Y" } },
			c: { type: "score", instructions: "i", criteria: ["low", "high"] },
		});
	});
});

describe("parseVercelResponse", () => {
	const questions = { plan_worthy: QUESTIONS.plan };

	test("boolean answers become noul; the model is the sent id; missing usage is 0 (not reported)", () => {
		const response = parseVercelResponse(
			{ answers: { plan_worthy: { type: "boolean", probability: 0.97 } } },
			questions,
			"typesafe-ai/jev",
		);
		expect(response).toEqual({
			model: "typesafe-ai/jev",
			answers: { plan_worthy: { type: "noul", noul: 0.97 } },
			usage: { input_tokens: 0, output_tokens: 0 },
		});
	});

	test("camelCase usage maps to snake_case; rounding, warnings and extra metadata are ignored", () => {
		const response = parseVercelResponse(
			{
				answers: { plan_worthy: { type: "boolean", probability: 0.5 } },
				usage: { inputTokens: 450, outputTokens: 12 },
				rounding: { probabilityDecimals: 2 },
				warnings: [{ type: "other", message: "m" }],
			},
			questions,
			"typesafe-ai/jev",
		);
		expect(response.usage).toEqual({ input_tokens: 450, output_tokens: 12 });
	});

	test("choice and score answers map with optional probabilities and metadata confidence", () => {
		const qs: Record<string, DecisionQuestion> = {
			c: { type: "choice", instructions: "i", criteria: { x: "X", y: "Y" } },
			s: { type: "score", instructions: "i", criteria: ["low", "high"] },
		};
		const response = parseVercelResponse(
			{
				answers: {
					c: { type: "choice", choice: "x", probabilities: { x: 0.7, y: 0.3 } },
					s: { type: "score", score: 1 },
				},
				providerMetadata: { typesafe: { confidence: { c: 0.9, s: 0.4 } } },
			},
			{ ...qs },
			"typesafe-ai/jev",
		);
		expect(response.answers).toEqual({
			c: { type: "choice", choice: "x", probabilities: { x: 0.7, y: 0.3 }, confidence: 0.9 },
			s: { type: "score", score: 1, confidence: 0.4 },
		});
	});

	test("a non-unit confidence is dropped, not an error", () => {
		const qs: Record<string, DecisionQuestion> = { c: { type: "choice", instructions: "i", criteria: { x: "X", y: "Y" } } };
		const response = parseVercelResponse(
			{
				answers: { c: { type: "choice", choice: "x" } },
				providerMetadata: { typesafe: { confidence: { c: 7 } } },
			},
			{ ...qs },
			"typesafe-ai/jev",
		);
		expect(response.answers).toEqual({ c: { type: "choice", choice: "x" } });
	});

	test.each([
		["not an object", 42, "response must be a JSON object"],
		["answers not an object", { answers: [] }, "answers must be an object"],
		["unasked answer", { answers: { nope: { type: "boolean", probability: 1 } } }, "answers.nope was not asked"],
		["missing answer", { answers: {} }, "answers.plan_worthy is missing"],
		[
			"wrong answer type",
			{ answers: { plan_worthy: { type: "choice", choice: "x" } } },
			"answers.plan_worthy.type must be boolean",
		],
		[
			"out-of-range probability",
			{ answers: { plan_worthy: { type: "boolean", probability: 2 } } },
			"answers.plan_worthy.probability must be a finite number in [0, 1]",
		],
		[
			"usage not an object",
			{ answers: { plan_worthy: { type: "boolean", probability: 1 } }, usage: 7 },
			"usage must be an object",
		],
		[
			"negative usage count",
			{ answers: { plan_worthy: { type: "boolean", probability: 1 } }, usage: { inputTokens: -1 } },
			"usage.inputTokens must be a finite number >= 0",
		],
	])("rejects %s", (_name, body, rule) => {
		expect(() => parseVercelResponse(body, questions, "typesafe-ai/jev")).toThrow(`decisions invalid-response: ${rule}`);
	});
});

describe("decideVercel", () => {
	interface Recorded {
		url: string;
		headers: Record<string, string>;
		body: unknown;
	}
	function recordingFetch(queue: Array<() => Response>): { fetch: typeof fetch; calls: Recorded[] } {
		const calls: Recorded[] = [];
		const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
			const headers: Record<string, string> = {};
			new Headers(init?.headers).forEach((value, key) => {
				headers[key] = value;
			});
			calls.push({ url: String(input), headers, body: JSON.parse(String(init?.body)) as unknown });
			const next = queue[Math.min(calls.length, queue.length) - 1];
			if (!next) throw new Error("empty queue");
			return next();
		}) as typeof fetch;
		return { fetch: fetchImpl, calls };
	}
	const VEV = (p: number) => () =>
		Response.json({
			answers: { plan_worthy: { type: "boolean", probability: p } },
			usage: { inputTokens: 100, outputTokens: 5 },
		});
	const ERR = (s: number) => () => Response.json({ error: { message: `no for ${K}` } }, { status: s });

	test("posts the v4 endpoint with the gateway headers and a model-free body", async () => {
		const r = recordingFetch([VEV(0.97)]);
		const outcome = await decideVercel(request(), { apiKey: K, timeoutMs: 3000, fetch: r.fetch });
		expect(outcome.ok).toBe(true);
		expect(r.calls).toHaveLength(1);
		const call = r.calls[0];
		if (!call) throw new Error("expected a gateway call");
		expect(call.url).toBe(VERCEL_DECISIONS_URL);
		expect(call.headers["ai-model-id"]).toBe("typesafe-ai/jev");
		expect(call.headers["ai-evaluation-model-specification-version"]).toBe("4");
		expect(call.headers["ai-gateway-protocol-version"]).toBe("0.0.1");
		expect(call.headers["ai-gateway-auth-method"]).toBe("api-key");
		expect(call.headers["authorization"]).toBe(`Bearer ${K}`);
		expect(call.body).toEqual({
			state: { message: "hi" },
			questions: {
				plan_worthy: { type: "boolean", instructions: QUESTIONS.plan.instructions, criteria: QUESTIONS.plan.criteria },
			},
		});
		if (!outcome.ok) throw new Error("expected ok");
		expect(outcome.response).toMatchObject({
			model: "typesafe-ai/jev",
			answers: { plan_worthy: { type: "noul", noul: 0.97 } },
			usage: { input_tokens: 100, output_tokens: 5 },
		});
		expect(outcome.attempts).toBe(1);
	});

	test("an explicit model travels verbatim in ai-model-id", async () => {
		const r = recordingFetch([VEV(0.5)]);
		await decideVercel({ ...request(), model: "custom/jev" }, { apiKey: K, timeoutMs: 3000, fetch: r.fetch });
		expect(r.calls[0]?.headers?.["ai-model-id"]).toBe("custom/jev");
	});

	test("shares the core's retry and error discipline: 503 retries once, 401 maps to auth", async () => {
		const retry = recordingFetch([ERR(503), VEV(0.5)]);
		const retried = await decideVercel(request(), { apiKey: K, timeoutMs: 10_000, fetch: retry.fetch });
		expect(retried.ok).toBe(true);
		expect(retried.attempts).toBe(2);
		const auth = recordingFetch([ERR(401), VEV(0.5)]);
		const denied = await decideVercel(request(), { apiKey: K, timeoutMs: 10_000, fetch: auth.fetch });
		expect(denied.ok).toBe(false);
		if (denied.ok) throw new Error("expected error");
		expect(denied.error.kind).toBe("auth");
		expect(denied.attempts).toBe(1);
		expect(denied.error.message).not.toContain(K);
	});

	test("a locally invalid request fails without a call", async () => {
		const r = recordingFetch([VEV(0.5)]);
		const outcome = await decideVercel({ ...request(), questions: {} }, { apiKey: K, timeoutMs: 3000, fetch: r.fetch });
		expect(outcome.ok).toBe(false);
		expect(outcome.attempts).toBe(0);
		expect(r.calls).toHaveLength(0);
	});
});
