// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Hand-written client for OpenRouter's Decisions API (D1, D6, D7): local request checks, one POST inside a total
 * time budget, at most one retry for transient failures, strict response parsing and redacted, classified errors.
 * Never rejects except with an AbortError when the caller aborts. `postDecision` is the shared POST core the Vercel
 * rail (`./vercel.ts`) reuses, so both rails share timeout/retry/redaction discipline structurally.
 */
import { redactSecrets } from "../grok/auth.ts";
import { USER_AGENT } from "../mcp/providers.ts";
import {
	type DecisionAnswer,
	type DecisionQuestion,
	type DecisionsErrorKind,
	type DecisionsRequest,
	type DecisionsResponse,
	type DecisionsUsage,
	DecisionsError,
	DEFAULT_DECISIONS_URL,
	MAX_ERROR_CHARS,
	MAX_ESTIMATED_TOKENS,
	RETRY_MIN_REMAINING_MS,
} from "./types.ts";

type Env = Record<string, string | undefined>;

export interface DecideOptions {
	apiKey: string;
	/** Total budget for the decision, retries included (D6). */
	timeoutMs: number;
	/** Default per rail (OpenRouter default / Vercel endpoint). OpenRouter callers pass resolveDecisionsUrl(env).url. */
	url?: string;
	/** Default: globalThis.fetch looked up at call time (tests may replace globalThis.fetch). */
	fetch?: typeof fetch;
	/** Caller abort: rejects decide() with an AbortError. */
	signal?: AbortSignal;
	/** Default Date.now. Used for the budget, the ≥500 ms retry rule, latency and Retry-After dates. */
	now?: () => number;
	/** Default ms => Bun.sleep(ms). decide() races it with the caller signal. */
	sleep?: (ms: number) => Promise<void>;
	/** Default Math.random (jitter). */
	random?: () => number;
}

export type DecideOutcome =
	| { ok: true; response: DecisionsResponse; attempts: number; latencyMs: number }
	| { ok: false; error: DecisionsError; attempts: number; latencyMs: number };

/** ULTRATHINK_DECISIONS_URL is the one place the OpenRouter key can be pointed elsewhere, so it only accepts hosts that
 *  should ever see that key: OpenRouter itself over https, or a loopback test/proxy endpoint. */
const LOOPBACK_HOSTS: Record<string, true> = { localhost: true, "127.0.0.1": true, "[::1]": true, "::1": true };

export interface DecisionsUrl {
	url: string;
	source: "default" | "ULTRATHINK_DECISIONS_URL";
	/** ULTRATHINK_DECISIONS_URL was set but rejected; `url` is the default. */
	ignored?: true;
}

/** Appended to the status line and `decisions check` output when ULTRATHINK_DECISIONS_URL was set but rejected. */
export const DECISIONS_URL_IGNORED =
	" · ULTRATHINK_DECISIONS_URL ignored (must be https://openrouter.ai/… or a loopback URL)";

/**
 * env.ULTRATHINK_DECISIONS_URL (trimmed) when it has no userinfo and is https://openrouter.ai/… or an http(s) loopback
 * URL, normalised to origin + pathname (no query, no hash). A set-but-rejected value yields the default plus
 * `ignored: true`. Env only (D1).
 */
export function resolveDecisionsUrl(env: Env): DecisionsUrl {
	const raw = env.ULTRATHINK_DECISIONS_URL?.trim();
	if (!raw) return { url: DEFAULT_DECISIONS_URL, source: "default" };
	try {
		const parsed = new URL(raw);
		const { protocol, hostname } = parsed;
		const loopback = Object.hasOwn(LOOPBACK_HOSTS, hostname);
		const allowed =
			(protocol === "https:" && (hostname === "openrouter.ai" || loopback)) || (protocol === "http:" && loopback);
		if (allowed && !parsed.username && !parsed.password) {
			return { url: `${parsed.origin}${parsed.pathname}`, source: "ULTRATHINK_DECISIONS_URL" };
		}
	} catch {
		// not a URL: the default endpoint
	}
	return { url: DEFAULT_DECISIONS_URL, source: "default", ignored: true };
}

/** Shared with the Vercel rail: plain-object check for strict response parsing. */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

/** Shared with the Vercel rail: a finite number in [0, 1]. */
export function isUnit(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

/** Math.ceil(JSON.stringify({ state, questions }).length / 4). */
export function estimateTokens(request: Pick<DecisionsRequest, "state" | "questions">): number {
	return Math.ceil(JSON.stringify({ state: request.state, questions: request.questions }).length / 4);
}

/** The first violated D7 request rule, or undefined. */
function requestViolation(request: DecisionsRequest): string | undefined {
	if (typeof request.model !== "string" || !request.model.trim()) return "model must be a non-empty string";
	const state: unknown = request.state;
	if (typeof state !== "string" && !Array.isArray(state) && !isPlainObject(state)) {
		return "state must be a string, an object or an array";
	}
	const questions: unknown = request.questions;
	if (!isPlainObject(questions) || Object.keys(questions).length === 0) return "questions must be a non-empty object";
	for (const [key, value] of Object.entries(questions)) {
		const at = `questions.${key}`;
		if (!isPlainObject(value)) return `${at} must be an object`;
		if (typeof value.instructions !== "string") return `${at}.instructions must be a string`;
		const criteria = value.criteria;
		switch (value.type) {
			case "noul":
				if (criteria !== undefined && (!isPlainObject(criteria) || typeof criteria.true !== "string" || typeof criteria.false !== "string")) {
					return `${at}.criteria must have string true and false`;
				}
				break;
			case "choice":
				if (!isPlainObject(criteria) || Object.keys(criteria).length < 2 || !Object.values(criteria).every((v) => typeof v === "string")) {
					return `${at}.criteria must map at least 2 options to strings`;
				}
				break;
			case "score":
				if (!Array.isArray(criteria) || criteria.length < 2 || !criteria.every((v) => typeof v === "string")) {
					return `${at}.criteria must be at least 2 level strings`;
				}
				break;
			default:
				return `${at}.type must be noul, choice or score`;
		}
	}
	return undefined;
}

/** Local checks (D7). undefined when the request may be sent. */
export function validateRequest(request: DecisionsRequest): DecisionsError | undefined {
	const violation = requestViolation(request);
	if (violation) return new DecisionsError("bad-request", redact(`decisions bad-request: ${violation}`));
	const tokens = estimateTokens(request);
	if (tokens > MAX_ESTIMATED_TOKENS) {
		return new DecisionsError(
			"too-large",
			redact(`decisions too-large: request is about ${tokens} tokens (limit ${MAX_ESTIMATED_TOKENS})`),
		);
	}
	return undefined;
}

function invalid(rule: string): DecisionsError {
	return new DecisionsError("invalid-response", redact(`decisions invalid-response: ${rule}`));
}

/** `probabilities` keyed exactly by `keys`, every value in [0, 1]. */
function checkProbabilities(value: unknown, keys: readonly string[], at: string): Record<string, number> {
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

/** The optional `probabilities` (keyed exactly by `keys`) and `confidence` of a choice or score answer. */
function optionalFields(
	value: Record<string, unknown>,
	keys: readonly string[],
	at: string,
): { probabilities?: Record<string, number>; confidence?: number } {
	const confidence = value.confidence;
	if (confidence !== undefined && !isUnit(confidence)) throw invalid(`${at}.confidence must be a finite number in [0, 1]`);
	return {
		...(value.probabilities !== undefined ? { probabilities: checkProbabilities(value.probabilities, keys, `${at}.probabilities`) } : {}),
		...(isUnit(confidence) ? { confidence } : {}),
	};
}

function checkAnswer(value: unknown, question: DecisionQuestion, at: string): DecisionAnswer {
	if (!isPlainObject(value)) throw invalid(`${at} must be an object`);
	if (value.type !== question.type) throw invalid(`${at}.type must be ${question.type}`);
	if (question.type === "noul") {
		const noul = value.noul;
		if (!isUnit(noul)) throw invalid(`${at}.noul must be a finite number in [0, 1]`);
		return { type: "noul", noul };
	}
	if (question.type === "choice") {
		const options = Object.keys(question.criteria);
		const choice = value.choice;
		if (typeof choice !== "string" || !options.includes(choice)) {
			throw invalid(`${at}.choice must be one of ${options.join(", ")}`);
		}
		return { type: "choice", choice, ...optionalFields(value, options, at) };
	}
	const top = question.criteria.length - 1;
	const score = value.score;
	if (typeof score !== "number" || !Number.isFinite(score) || score < 0 || score > top) {
		throw invalid(`${at}.score must be a finite number in [0, ${top}]`);
	}
	const levels = question.criteria.map((_, index) => String(index));
	return { type: "score", score, ...optionalFields(value, levels, at), ...(value.legend !== undefined ? { legend: value.legend } : {}) };
}

/** Shared with the Vercel rail: a finite number >= 0. */
export function isCount(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** Strict D7 parse; throws DecisionsError("invalid-response") on any violation. */
export function parseDecisionsResponse(body: unknown, questions: Record<string, DecisionQuestion>): DecisionsResponse {
	if (!isPlainObject(body)) throw invalid("response must be a JSON object");
	const { id, model, provider, answers } = body;
	if (typeof model !== "string" || !model) throw invalid("model must be a non-empty string");
	if (id !== undefined && typeof id !== "string") throw invalid("id must be a string");
	if (provider !== undefined && typeof provider !== "string") throw invalid("provider must be a string");
	if (!isPlainObject(answers)) throw invalid("answers must be an object");
	for (const key of Object.keys(answers)) {
		if (!Object.hasOwn(questions, key)) throw invalid(`answers.${key} was not asked`);
	}
	const parsed: Record<string, DecisionAnswer> = {};
	for (const [key, question] of Object.entries(questions)) {
		if (!Object.hasOwn(answers, key)) throw invalid(`answers.${key} is missing`);
		parsed[key] = checkAnswer(answers[key], question, `answers.${key}`);
	}
	const usage = body.usage;
	if (!isPlainObject(usage)) throw invalid("usage must be an object");
	const { input_tokens, output_tokens, cost } = usage;
	if (!isCount(input_tokens)) throw invalid("usage.input_tokens must be a finite number >= 0");
	if (!isCount(output_tokens)) throw invalid("usage.output_tokens must be a finite number >= 0");
	if (cost !== undefined && !isCount(cost)) throw invalid("usage.cost must be a finite number >= 0");
	const typedUsage: DecisionsUsage = { input_tokens, output_tokens, ...(isCount(cost) ? { cost } : {}) };
	return {
		...(typeof id === "string" ? { id } : {}),
		model,
		...(typeof provider === "string" ? { provider } : {}),
		answers: parsed,
		usage: typedUsage,
	};
}

const SK_OR_RE = /sk-or-[A-Za-z0-9_-]+/g;

/** Replaces apiKey (every occurrence), /sk-or-[A-Za-z0-9_-]+/g and redactSecrets() patterns with "[redacted]"; collapses whitespace to one line; cuts to 200 chars (197 + "..."). */
export function redact(text: string, apiKey?: string): string {
	const key = apiKey?.trim();
	let out = key ? text.replaceAll(key, "[redacted]") : text;
	out = redactSecrets(out.replace(SK_OR_RE, "[redacted]"));
	out = out.replace(/\s+/g, " ").trim();
	return out.length > MAX_ERROR_CHARS ? `${out.slice(0, MAX_ERROR_CHARS - 3)}...` : out;
}

/** HTTP status → kind (D6, A15). */
function statusKind(status: number): DecisionsErrorKind {
	if (status === 401 || status === 403) return "auth";
	if (status === 402) return "credits";
	if (status === 413) return "too-large";
	if (status === 429) return "rate-limit";
	if (status === 408) return "timeout";
	if (status >= 500) return "upstream";
	return "bad-request";
}

const TRANSIENT_STATUSES: ReadonlySet<number> = new Set([408, 429, 500, 502, 503, 524, 529]);

/** Shared with the Vercel rail: the caller's abort reason, or an AbortError. */
export function abortError(signal: AbortSignal): Error {
	const reason: unknown = signal.reason;
	if ((reason instanceof Error || reason instanceof DOMException) && reason.name === "AbortError") return reason;
	return new DOMException("The operation was aborted.", "AbortError");
}

/** Settles with `work`, or rejects as soon as `signal` aborts, even if `work` ignores the signal. */
function raceAbort<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
	if (signal.aborted) {
		work.catch(() => {});
		return Promise.reject(signal.reason);
	}
	return new Promise<T>((resolve, reject) => {
		const onAbort = () => reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
		work.then(
			(value) => {
				signal.removeEventListener("abort", onAbort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	});
}

/** Milliseconds to wait from a Retry-After header (delta seconds or HTTP-date), or undefined. */
function retryAfterMs(header: string | null, now: number): number | undefined {
	const value = header?.trim();
	if (!value) return undefined;
	if (/^\d+$/.test(value)) return Number(value) * 1000;
	const date = Date.parse(value);
	return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

/** The upstream error detail: `error.message`, else the body text, else the status text. */
function upstreamDetail(text: string, statusText: string): string {
	try {
		const parsed: unknown = JSON.parse(text);
		if (isPlainObject(parsed) && isPlainObject(parsed.error) && typeof parsed.error.message === "string") {
			return parsed.error.message;
		}
	} catch {
		// not JSON: use the text
	}
	return text.trim() ? text.slice(0, MAX_ERROR_CHARS) : statusText;
}

type Attempt =
	| { ok: true; response: DecisionsResponse }
	| { ok: false; error: DecisionsError; transient: boolean; retryAfter?: string | null };

export interface PostDecisionOptions {
	apiKey: string;
	/** Total budget for the decision, retries included (D6). */
	timeoutMs: number;
	/** Default: globalThis.fetch looked up at call time (tests may replace globalThis.fetch). */
	fetch?: typeof fetch;
	/** Caller abort: rejects with an AbortError. */
	signal?: AbortSignal;
	/** Default Date.now. Used for the budget, the ≥500 ms retry rule, latency and Retry-After dates. */
	now?: () => number;
	/** Default ms => Bun.sleep(ms). Raced with the caller signal. */
	sleep?: (ms: number) => Promise<void>;
	/** Default Math.random (jitter). */
	random?: () => number;
}

/**
 * One POST inside a total time budget, at most one retry for transient failures, strict `parse` of a 2xx JSON
 * body, redacted classified errors. Shared by the OpenRouter rail (`decide`) and the Vercel rail (`./vercel.ts`).
 * Never rejects except with an AbortError when opts.signal aborts.
 */
export async function postDecision(
	url: string,
	headers: Record<string, string>,
	bodyText: string,
	parse: (json: unknown) => DecisionsResponse,
	opts: PostDecisionOptions,
): Promise<DecideOutcome> {
	const now = opts.now ?? Date.now;
	const sleep = opts.sleep ?? ((ms: number) => Bun.sleep(ms));
	const random = opts.random ?? Math.random;
	const caller = opts.signal;
	const start = now();
	const deadline = start + opts.timeoutMs;
	const settle = <T extends object>(result: T) => ({ ...result, latencyMs: Math.max(0, now() - start) });
	if (caller?.aborted) throw abortError(caller);

	const fetchImpl = opts.fetch ?? globalThis.fetch;
	const fail = (kind: DecisionsErrorKind, detail: string, status?: number) =>
		new DecisionsError(kind, redact(`decisions ${kind}: ${redact(detail, opts.apiKey)}`, opts.apiKey), status);

	const attempt = async (): Promise<Attempt> => {
		let timeout: AbortSignal | undefined;
		const timedOut = () => ({
			ok: false as const,
			error: fail("timeout", `no answer within ${opts.timeoutMs} ms`),
			transient: false,
		});
		let status: number;
		let statusText: string;
		let text: string;
		let retryAfter: string | null;
		try {
			// Clamped to the largest delay timers accept; created inside the try so no timer quirk can escape decide().
			timeout = AbortSignal.timeout(Math.min(Math.max(1, deadline - now()), 2_147_483_647));
			const signal = caller ? AbortSignal.any([caller, timeout]) : timeout;
			const response = await raceAbort(
				fetchImpl(url, {
					method: "POST",
					headers,
					body: bodyText,
					signal,
					// The key must never follow a redirect to another host.
					redirect: "error",
				}),
				signal,
			);
			status = response.status;
			statusText = response.statusText;
			retryAfter = response.headers.get("retry-after");
			text = await raceAbort(response.text(), signal);
		} catch (error) {
			if (caller?.aborted) throw abortError(caller);
			if (timeout?.aborted) return timedOut();
			const message = error instanceof Error ? error.message : String(error);
			return { ok: false, error: fail("network", message || "fetch failed"), transient: true };
		}
		if (status >= 200 && status < 300) {
			let json: unknown;
			try {
				json = JSON.parse(text);
			} catch {
				return { ok: false, error: fail("invalid-response", "response body is not JSON"), transient: false };
			}
			try {
				return { ok: true, response: parse(json) };
			} catch (error) {
				const message = error instanceof DecisionsError ? error.message : "response could not be parsed";
				return { ok: false, error: new DecisionsError("invalid-response", redact(message, opts.apiKey)), transient: false };
			}
		}
		const kind = statusKind(status);
		return {
			ok: false,
			error: fail(kind, `HTTP ${status}: ${upstreamDetail(text, statusText)}`, status),
			transient: TRANSIENT_STATUSES.has(status),
			retryAfter,
		};
	};

	const first = await attempt();
	if (first.ok) return settle({ ok: true as const, response: first.response, attempts: 1 });
	const remaining = deadline - now();
	if (!first.transient || remaining < RETRY_MIN_REMAINING_MS) return settle({ ok: false as const, error: first.error, attempts: 1 });

	const hinted = retryAfterMs(first.retryAfter ?? null, now());
	const wait =
		hinted !== undefined && remaining - hinted >= RETRY_MIN_REMAINING_MS ? hinted : Math.round(125 + random() * 250);
	// A failing sleep seam only shortens the wait; a caller abort during it is re-thrown.
	const pause = Promise.resolve().then(() => sleep(wait));
	await (caller ? raceAbort(pause, caller) : pause).catch(() => {});
	if (caller?.aborted) throw abortError(caller);

	const second = await attempt();
	if (second.ok) return settle({ ok: true as const, response: second.response, attempts: 2 });
	return settle({ ok: false as const, error: second.error, attempts: 2 });
}

/** OpenRouter rail: local D7 checks, then the shared POST core. Never rejects except with an AbortError when opts.signal aborts. */
export async function decide(request: DecisionsRequest, opts: DecideOptions): Promise<DecideOutcome> {
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
	return postDecision(
		opts.url ?? DEFAULT_DECISIONS_URL,
		{
			Authorization: `Bearer ${opts.apiKey}`,
			"Content-Type": "application/json",
			"User-Agent": USER_AGENT,
		},
		JSON.stringify(request),
		(json) => parseDecisionsResponse(json, request.questions),
		opts,
	);
}
