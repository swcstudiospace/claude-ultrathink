// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import type { ReasoningEffort } from "../config/config.ts";
import { currentRequestContext } from "../obs/context.ts";
import type { SpanSink } from "../obs/otel.ts";
import { childSpan, formatTraceparent } from "../obs/trace.ts";
import type { CircuitBreaker, ReleaseOutcome } from "./breaker.ts";

/**
 * OpenRouter chat completions behind the plugin's `Completer` shape.
 *
 * Failures are classified codes only. The API key, the response body and the
 * underlying fetch error never reach a message, a thrown value or the usage
 * callback, so callers can log or persist `error.message` safely.
 *
 * With a `breaker` (Refs SPE-17437) every HTTP attempt first takes a slot; a
 * refusal fails the call with `upstream_unavailable` without a request, and
 * each attempt reports back whether the upstream itself failed.
 */

export type OpenRouterErrorCode =
	| "auth"
	| "rate_limited"
	| "upstream"
	| "timeout"
	| "aborted"
	| "bad_response"
	| "empty"
	/** The circuit breaker refused the call; no request was sent. `retryAfterMs` says when to try again. */
	| "upstream_unavailable";

export class OpenRouterError extends Error {
	readonly code: OpenRouterErrorCode;
	readonly status: number | undefined;
	/** Set on `upstream_unavailable`: ms until the breaker hands out a slot again. */
	readonly retryAfterMs: number | undefined;

	constructor(code: OpenRouterErrorCode, status?: number, retryAfterMs?: number) {
		super(status === undefined ? `openrouter ${code}` : `openrouter ${code} (HTTP ${status})`);
		this.name = "OpenRouterError";
		this.code = code;
		this.status = status;
		this.retryAfterMs = retryAfterMs;
	}
}

export interface OpenRouterUsage {
	/** Absent when the endpoint did not report a valid count; unknown is not zero. */
	promptTokens?: number;
	completionTokens?: number;
	/** OpenRouter's `usage.cost` in USD when the response carries one. */
	costUsd?: number;
}

export type OpenRouterFetch = (input: string, init: RequestInit) => Promise<Response>;

/** Same shape as `Completer` in src/grok/complete.ts. */
export type OpenRouterCompleter = (system: string, user: string, signal?: AbortSignal) => Promise<string>;

export interface OpenRouterCompleterOptions {
	apiKey: string;
	/** Without a trailing slash, for example https://openrouter.ai/api/v1. */
	baseUrl: string;
	model: string;
	maxOutputTokens: number;
	/** Sent as `reasoning: { effort }`; unset omits the parameter. */
	reasoningEffort?: ReasoningEffort;
	/** Applies to each HTTP attempt, not to the whole call including retries. */
	timeoutMs: number;
	/** Sent as HTTP-Referer; pass the service origin. */
	referer?: string;
	fetch?: OpenRouterFetch;
	/** Backoff wait; must resolve early (or the caller must re-check the signal) when `signal` aborts. */
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
	/** Called once per successful completion; a throwing callback is ignored. */
	onUsage?: (usage: OpenRouterUsage) => void;
	/** Called exactly once per `complete()` after the final outcome; a throwing hook is ignored. */
	onCall?: (info: OpenRouterCallInfo) => void;
	/**
	 * Upstream circuit breaker, shared across completer instances so every call to the same endpoint counts. A slot is
	 * acquired before each HTTP attempt; a refusal fails the call with `upstream_unavailable` at once, without a retry.
	 * Absent: no breaker, calls always go out.
	 */
	breaker?: CircuitBreaker;
	/**
	 * Receives one CLIENT span per HTTP attempt made under a sampled request context. It never sees a URL path, query,
	 * key or header. A throwing sink is ignored.
	 */
	spans?: SpanSink;
}

/** Outcome of one `complete()` call, reported once after retries. Carries no key, header or body. */
export interface OpenRouterCallInfo {
	/** Total time including retries and backoff. */
	ms: number;
	outcome: "ok" | OpenRouterErrorCode;
	/** HTTP status of the final attempt when it reached a response. */
	status?: number;
	/** HTTP attempts made. */
	attempts: number;
}

const DEFAULT_REFERER = "https://ultrathink.swcstudio.space";
const MAX_RETRIES = 2;
const BACKOFF_BASE_MS = 500;
const BACKOFF_JITTER_MS = 250;
const MAX_RETRY_AFTER_MS = 20000;
/**
 * Largest reply body that is buffered. A completion is `maxOutputTokens` tokens of a few bytes each plus usage,
 * so 4 MiB leaves ample room while a runaway or hostile reply is cancelled instead of held whole in memory.
 */
export const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	if (signal?.aborted === true) {
		resolve();
		return promise;
	}
	const done = (): void => {
		clearTimeout(timer);
		signal?.removeEventListener("abort", done);
		resolve();
	};
	const timer = setTimeout(done, ms);
	signal?.addEventListener("abort", done, { once: true });
	return promise;
}

/** Retry-After as delay seconds or an HTTP date, clamped to the 0..20 s range; undefined when absent or unparseable. */
function parseRetryAfterMs(header: string | null): number | undefined {
	if (header === null) {
		return undefined;
	}
	const value = header.trim();
	let ms: number;
	if (/^[0-9]+(\.[0-9]+)?$/.test(value)) {
		ms = Number(value) * 1000;
	} else {
		const date = Date.parse(value);
		if (Number.isNaN(date)) {
			return undefined;
		}
		ms = date - Date.now();
	}
	return Math.min(Math.max(ms, 0), MAX_RETRY_AFTER_MS);
}

function backoffMs(retry: number): number {
	return BACKOFF_BASE_MS * 2 ** retry + Math.random() * BACKOFF_JITTER_MS;
}

function count(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Decodes the body up to `maxBytes`; `undefined` (with the stream cancelled) once it is longer than that. */
async function readBounded(response: Response, maxBytes: number): Promise<string | undefined> {
	const body = response.body;
	if (body === null) return response.text();
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let text = "";
	let bytes = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) return text + decoder.decode();
		bytes += value.byteLength;
		if (bytes > maxBytes) {
			void reader.cancel().catch(() => undefined);
			return undefined;
		}
		text += decoder.decode(value, { stream: true });
	}
}

/** Upstream JSON; every field is checked where it is used. Optional chaining is safe on any JSON value. */
interface CompletionReply {
	choices?: Array<{ message?: { content?: unknown } | null } | null> | null;
	usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; cost?: unknown } | null;
}

function contentText(content: unknown): string | undefined {
	if (typeof content === "string") {
		return content;
	}
	if (Array.isArray(content)) {
		return (content as Array<{ text?: unknown } | null>)
			.map((part) => (typeof part?.text === "string" ? part.text : ""))
			.join("");
	}
	return undefined;
}

type Attempt =
	| { ok: true; text: string; usage: OpenRouterUsage }
	| { ok: false; error: OpenRouterError; retry: boolean; retryAfterMs?: number };

/**
 * What one attempt tells the breaker: a reply counts as a success, an unreachable, slow or overloaded upstream as a
 * failure, and anything the upstream is not responsible for (our key, its body shape, the caller's abort) as neither.
 */
function releaseOutcome(result: Attempt): ReleaseOutcome {
	if (result.ok) return "success";
	switch (result.error.code) {
		case "upstream":
		case "timeout":
		case "rate_limited":
			return "failure";
		default:
			return "ignored";
	}
}

/** Validates a 200 body; `null` content (tool call, refusal) counts as empty, a missing message or content as malformed. */
function parseCompletion(raw: string): Attempt {
	let reply: CompletionReply | null;
	try {
		reply = JSON.parse(raw) as CompletionReply | null;
	} catch {
		return { ok: false, error: new OpenRouterError("bad_response"), retry: false };
	}
	const content = reply?.choices?.[0]?.message?.content;
	const text = content === null ? "" : contentText(content);
	if (text === undefined) {
		return { ok: false, error: new OpenRouterError("bad_response"), retry: false };
	}
	if (text.trim() === "") {
		return { ok: false, error: new OpenRouterError("empty"), retry: false };
	}
	const cost = reply?.usage?.cost;
	const promptTokens = count(reply?.usage?.prompt_tokens);
	const completionTokens = count(reply?.usage?.completion_tokens);
	return {
		ok: true,
		text,
		usage: {
			...(promptTokens === undefined ? {} : { promptTokens }),
			...(completionTokens === undefined ? {} : { completionTokens }),
			...(typeof cost === "number" && Number.isFinite(cost) && cost >= 0 ? { costUsd: cost } : {}),
		},
	};
}

/** Host of the endpoint URL, the only part of it a span may carry; undefined when the URL does not parse. */
function hostOf(baseUrl: string): string | undefined {
	try {
		return new URL(baseUrl).hostname;
	} catch {
		return undefined;
	}
}

export function createOpenRouterCompleter(
	opts: OpenRouterCompleterOptions,
): OpenRouterCompleter {
	const fetchImpl: OpenRouterFetch = opts.fetch ?? ((input, init) => fetch(input, init));
	const sleep = opts.sleep ?? defaultSleep;
	const spans = opts.spans;
	const serverAddress = hostOf(opts.baseUrl);
	const url = `${opts.baseUrl.replace(/\/+$/, "")}/chat/completions`;
	const headers = {
		Authorization: `Bearer ${opts.apiKey}`,
		"Content-Type": "application/json",
		"HTTP-Referer": opts.referer ?? DEFAULT_REFERER,
		"X-Title": "ultrathink",
	};

	async function exchange(
		body: string,
		caller: AbortSignal | undefined,
		requestHeaders: Record<string, string>,
		reply: { status?: number },
	): Promise<Attempt> {
		const controller = new AbortController();
		let timedOut = false;
		const onCallerAbort = (): void => controller.abort();
		caller?.addEventListener("abort", onCallerAbort, { once: true });
		const timer = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, opts.timeoutMs);
		const interrupted = (): Attempt | undefined => {
			if (caller?.aborted === true) {
				return { ok: false, error: new OpenRouterError("aborted"), retry: false };
			}
			if (timedOut) {
				return { ok: false, error: new OpenRouterError("timeout"), retry: false };
			}
			return undefined;
		};
		const badResponse = (): Attempt => ({ ok: false, error: new OpenRouterError("bad_response"), retry: false });
		try {
			let response: Response;
			try {
				response = await fetchImpl(url, {
					method: "POST",
					headers: requestHeaders,
					body,
					signal: controller.signal,
					redirect: "error",
				});
			} catch {
				// No reply was seen, so the request is retried as it would be by any client.
				return interrupted() ?? { ok: false, error: new OpenRouterError("upstream"), retry: true };
			}
			reply.status = response.status;
			if (response.ok) {
				const declared = response.headers.get("content-length");
				if (declared !== null && Number(declared) > MAX_RESPONSE_BYTES) {
					void response.body?.cancel().catch(() => undefined);
					return badResponse();
				}
				let raw: string | undefined;
				try {
					raw = await readBounded(response, MAX_RESPONSE_BYTES);
				} catch {
					// The reply was started and may already be billed: a body that cannot be read is not requested again.
					return interrupted() ?? badResponse();
				}
				return raw === undefined ? badResponse() : parseCompletion(raw);
			}
			void response.body?.cancel().catch(() => undefined);
			const status = response.status;
			if (status === 429) {
				return {
					ok: false,
					error: new OpenRouterError("rate_limited", status),
					retry: true,
					retryAfterMs: parseRetryAfterMs(response.headers.get("retry-after")),
				};
			}
			if (status >= 500) {
				return {
					ok: false,
					error: new OpenRouterError("upstream", status),
					retry: true,
					retryAfterMs: parseRetryAfterMs(response.headers.get("retry-after")),
				};
			}
			const code = status === 401 || status === 403 ? "auth" : "upstream";
			return { ok: false, error: new OpenRouterError(code, status), retry: false };
		} finally {
			clearTimeout(timer);
			caller?.removeEventListener("abort", onCallerAbort);
		}
	}

	/** One HTTP attempt. Under a sampled request context it is recorded as a CLIENT span of that trace, parented by the context span. */
	async function attempt(body: string, caller: AbortSignal | undefined, attemptNo: number): Promise<Attempt> {
		const ctx = currentRequestContext();
		// Each attempt is a fresh span of the caller's trace. Only the ids go upstream, never the key or the body.
		const hop = ctx === undefined ? undefined : childSpan({ traceId: ctx.traceId, spanId: ctx.spanId, sampled: ctx.sampled ?? true });
		const requestHeaders: Record<string, string> = hop === undefined ? headers : { ...headers, traceparent: formatTraceparent(hop) };
		const reply: { status?: number } = {};
		const startWall = Date.now();
		const startMono = performance.now();
		let result: Attempt | undefined;
		try {
			result = await exchange(body, caller, requestHeaders, reply);
			return result;
		} finally {
			if (ctx !== undefined && hop !== undefined && ctx.sampled !== false && spans !== undefined) {
				const startUnixNano = BigInt(startWall) * 1_000_000n;
				const attributes: Record<string, string | number | boolean> = { "http.request.method": "POST", "ultrathink.attempt": attemptNo };
				if (serverAddress !== undefined) attributes["server.address"] = serverAddress;
				if (reply.status !== undefined) attributes["http.response.status_code"] = reply.status;
				try {
					spans.record({
						traceId: ctx.traceId,
						spanId: hop.spanId,
						parentSpanId: ctx.spanId,
						name: "POST chat/completions",
						kind: 3,
						startUnixNano,
						endUnixNano: startUnixNano + BigInt(Math.round((performance.now() - startMono) * 1_000_000)),
						attributes,
						error: result !== undefined && releaseOutcome(result) === "failure",
					});
				} catch {
					// A throwing sink must not change the attempt's result.
				}
			}
		}
	}

	return async (system, user, signal) => {
		const body = JSON.stringify({
			model: opts.model,
			messages: [
				{ role: "system", content: system },
				{ role: "user", content: user },
			],
			max_tokens: opts.maxOutputTokens,
			usage: { include: true },
			...(opts.reasoningEffort === undefined ? {} : { reasoning: { effort: opts.reasoningEffort } }),
		});
		const started = performance.now();
		let attempts = 0;
		const report = (outcome: OpenRouterCallInfo["outcome"], status?: number): void => {
			try {
				opts.onCall?.({
					ms: performance.now() - started,
					outcome,
					...(status === undefined ? {} : { status }),
					attempts,
				});
			} catch {
				// Telemetry must not change the result of the call.
			}
		};
		for (let retry = 0; ; retry += 1) {
			if (signal?.aborted === true) {
				report("aborted");
				throw new OpenRouterError("aborted");
			}
			const slot = opts.breaker?.tryAcquire();
			if (slot !== undefined && !slot.ok) {
				report("upstream_unavailable");
				throw new OpenRouterError("upstream_unavailable", undefined, slot.retryAfterMs);
			}
			attempts += 1;
			let result: Attempt;
			try {
				result = await attempt(body, signal, attempts);
			} catch (error) {
				// An attempt that threw never classified the upstream, so it only frees the slot.
				slot?.release("ignored");
				throw error;
			}
			slot?.release(releaseOutcome(result));
			if (result.ok) {
				try {
					opts.onUsage?.(result.usage);
				} catch {
					// Accounting must not fail a completion that already succeeded.
				}
				report("ok");
				return result.text;
			}
			if (!result.retry || retry >= MAX_RETRIES) {
				report(result.error.code, result.error.status);
				throw result.error;
			}
			// A failure that just opened the breaker is refused on the next pass; backing off first would only delay that.
			if (opts.breaker?.state() === "open") continue;
			await sleep(result.retryAfterMs ?? backoffMs(retry), signal);
		}
	};
}
