// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Vercel AI Gateway rail for Jev: the v4 evaluation-model protocol. Maps the OpenRouter-shaped request to v4
 * (`noul`→`boolean`; the model travels in the `ai-model-id` header, never the body) and parses v4 answers/usage
 * back into the shared DecisionsResponse. Transport discipline (budget/retry/redaction) comes from the shared
 * `postDecision` core, so both rails behave identically there. Never rejects except with an AbortError when the
 * caller aborts. Reference: vercel/ai `gateway-evaluation-model.ts` + `typesafe-ai-evaluation-model.ts` at 20dd00a.
 */
import { USER_AGENT } from "../mcp/providers.ts";
import {
	abortError,
	isCount,
	isPlainObject,
	isUnit,
	postDecision,
	redact,
	validateRequest,
	type DecideOptions,
	type DecideOutcome,
} from "./client.ts";
import {
	DEFAULT_DECISIONS_MODEL,
	DecisionsError,
	VERCEL_DECISIONS_URL,
	VERCEL_JEV_MODEL,
	VERCEL_PROTOCOL_VERSION,
	VERCEL_SPEC_VERSION,
	type DecisionAnswer,
	type DecisionQuestion,
	type DecisionsRequest,
	type DecisionsResponse,
} from "./types.ts";

/**
 * `ai-model-id` for the call. The default model means "Jev latest" on either rails, so it maps to the gateway's id;
 * an explicit model passes through verbatim on both rails.
 */
export function resolveGatewayModel(model: string): string {
	return model === DEFAULT_DECISIONS_MODEL ? VERCEL_JEV_MODEL : model;
}

export function vercelHeaders(apiKey: string, modelId: string): Record<string, string> {
	return {
		Authorization: `Bearer ${apiKey}`,
		"Content-Type": "application/json",
		"User-Agent": USER_AGENT,
		"ai-gateway-protocol-version": VERCEL_PROTOCOL_VERSION,
		"ai-gateway-auth-method": "api-key",
		"ai-evaluation-model-specification-version": VERCEL_SPEC_VERSION,
		"ai-model-id": modelId,
	};
}

export interface VercelRequestBody {
	state: DecisionsRequest["state"];
	questions: Record<string, unknown>;
}

/** OpenRouter-shaped request → v4 body: `noul` questions become `boolean`; model/provider/session/trace stay out. */
export function buildVercelBody(request: DecisionsRequest): VercelRequestBody {
	const questions: Record<string, unknown> = {};
	for (const [key, question] of Object.entries(request.questions)) {
		questions[key] =
			question.type === "noul"
				? {
						type: "boolean",
						instructions: question.instructions,
						...(question.criteria ? { criteria: question.criteria } : {}),
					}
				: { ...question };
	}
	return { state: request.state, questions };
}

function invalid(rule: string): DecisionsError {
	return new DecisionsError("invalid-response", redact(`decisions invalid-response: ${rule}`));
}

/** `probabilities` keyed exactly by `keys`, every value in [0, 1]. */
function checkVercelProbabilities(value: unknown, keys: readonly string[], at: string): Record<string, number> {
	if (!isPlainObject(value)) throw invalid(`${at} must be an object`);
	const got = Object.keys(value);
	if (got.length !== keys.length || !keys.every((key) => Object.hasOwn(value, key))) {
		throw invalid(`${at} must be keyed exactly by ${keys.join(", ")}`);
	}
	const out: Record<string, number> = {};
	for (const key of keys) {
		const p = value[key];
		if (!isUnit(p)) throw invalid(`${at}.${key} must be a finite number in [0, 1]`);
		out[key] = p;
	}
	return out;
}

/** `providerMetadata.typesafe.confidence[id]` when it is a finite number in [0, 1]; else undefined. Never throws. */
function vercelConfidence(metadata: unknown, id: string): number | undefined {
	if (!isPlainObject(metadata)) return undefined;
	const typesafe = metadata.typesafe;
	if (!isPlainObject(typesafe)) return undefined;
	const confidence = typesafe.confidence;
	if (!isPlainObject(confidence)) return undefined;
	const p = confidence[id];
	return isUnit(p) ? p : undefined;
}

function checkVercelAnswer(
	value: unknown,
	question: DecisionQuestion,
	at: string,
	confidence: number | undefined,
): DecisionAnswer {
	if (!isPlainObject(value)) throw invalid(`${at} must be an object`);
	if (question.type === "noul") {
		if (value.type !== "boolean") throw invalid(`${at}.type must be boolean`);
		const probability = value.probability;
		if (!isUnit(probability)) throw invalid(`${at}.probability must be a finite number in [0, 1]`);
		return { type: "noul", noul: probability };
	}
	if (question.type === "choice") {
		if (value.type !== "choice") throw invalid(`${at}.type must be choice`);
		const options = Object.keys(question.criteria);
		const choice = value.choice;
		if (typeof choice !== "string" || !options.includes(choice)) {
			throw invalid(`${at}.choice must be one of ${options.join(", ")}`);
		}
		return {
			type: "choice",
			choice,
			...(value.probabilities !== undefined
				? { probabilities: checkVercelProbabilities(value.probabilities, options, `${at}.probabilities`) }
				: {}),
			...(confidence !== undefined ? { confidence } : {}),
		};
	}
	if (value.type !== "score") throw invalid(`${at}.type must be score`);
	const top = question.criteria.length - 1;
	const score = value.score;
	if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > top) {
		throw invalid(`${at}.score must be a finite number in [0, ${top}]`);
	}
	const levels = question.criteria.map((_, index) => String(index));
	return {
		type: "score",
		score,
		...(value.probabilities !== undefined
			? { probabilities: checkVercelProbabilities(value.probabilities, levels, `${at}.probabilities`) }
			: {}),
		...(confidence !== undefined ? { confidence } : {}),
	};
}

/**
 * Strict v4 parse into the shared DecisionsResponse. `modelId` is the sent `ai-model-id` (v4 reports no model, id or
 * cost). Missing usage counts become 0 ("not reported"); only `cost` is consumed downstream and Vercel reports none.
 */
export function parseVercelResponse(
	body: unknown,
	questions: Record<string, DecisionQuestion>,
	modelId: string,
): DecisionsResponse {
	if (!isPlainObject(body)) throw invalid("response must be a JSON object");
	const { answers, usage, providerMetadata } = body;
	if (!isPlainObject(answers)) throw invalid("answers must be an object");
	for (const key of Object.keys(answers)) {
		if (!Object.hasOwn(questions, key)) throw invalid(`answers.${key} was not asked`);
	}
	const parsed: Record<string, DecisionAnswer> = {};
	for (const [key, question] of Object.entries(questions)) {
		if (!Object.hasOwn(answers, key)) throw invalid(`answers.${key} is missing`);
		parsed[key] = checkVercelAnswer(answers[key], question, `answers.${key}`, vercelConfidence(providerMetadata, key));
	}
	let inputTokens = 0;
	let outputTokens = 0;
	if (usage !== undefined) {
		if (!isPlainObject(usage)) throw invalid("usage must be an object");
		const { inputTokens: input, outputTokens: output } = usage;
		if (input !== undefined) {
			if (!isCount(input)) throw invalid("usage.inputTokens must be a finite number >= 0");
			inputTokens = input;
		}
		if (output !== undefined) {
			if (!isCount(output)) throw invalid("usage.outputTokens must be a finite number >= 0");
			outputTokens = output;
		}
	}
	return { model: modelId, answers: parsed, usage: { input_tokens: inputTokens, output_tokens: outputTokens } };
}

/**
 * Vercel rail: the same local D7 checks on the OpenRouter-shaped request, then the shared POST core against the v4
 * evaluation-model endpoint. `opts.url` overrides the endpoint (tests). Never rejects except with an AbortError when
 * opts.signal aborts.
 */
export async function decideVercel(request: DecisionsRequest, opts: DecideOptions): Promise<DecideOutcome> {
	const now = opts.now ?? Date.now;
	const start = now();
	if (opts.signal?.aborted) throw abortError(opts.signal);
	const local = validateRequest(request);
	if (local) {
		return {
			ok: false as const,
			error: new DecisionsError(local.kind, redact(local.message, opts.apiKey)),
			attempts: 0,
			latencyMs: Math.max(0, now() - start),
		};
	}
	const modelId = resolveGatewayModel(request.model);
	return postDecision(
		opts.url ?? VERCEL_DECISIONS_URL,
		vercelHeaders(opts.apiKey, modelId),
		JSON.stringify(buildVercelBody(request)),
		(json) => parseVercelResponse(json, request.questions, modelId),
		opts,
	);
}
