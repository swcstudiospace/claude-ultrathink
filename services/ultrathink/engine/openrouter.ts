// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import type { ReasoningEffort } from "../config/config.ts";

/**
 * OpenRouter chat completions behind the plugin's `Completer` shape.
 *
 * Failures are classified codes only. The API key, the response body and the
 * underlying fetch error never reach a message, a thrown value or the usage
 * callback, so callers can log or persist `error.message` safely.
 */

export type OpenRouterErrorCode =
	| "auth"
	| "rate_limited"
	| "upstream"
	| "timeout"
	| "aborted"
	| "bad_response"
	| "empty";

export class OpenRouterError extends Error {
	readonly code: OpenRouterErrorCode;
	readonly status: number | undefined;

	constructor(code: OpenRouterErrorCode, status?: number) {
		super(status === undefined ? `openrouter ${code}` : `openrouter ${code} (HTTP ${status})`);
		this.name = "OpenRouterError";
		this.code = code;
		this.status = status;
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

export function createOpenRouterCompleter(
	opts: OpenRouterCompleterOptions,
): OpenRouterCompleter {
	const fetchImpl: OpenRouterFetch = opts.fetch ?? ((input, init) => fetch(input, init));
	const sleep = opts.sleep ?? defaultSleep;
	const url = `${opts.baseUrl.replace(/\/+$/, "")}/chat/completions`;
	const headers = {
		Authorization: `Bearer ${opts.apiKey}`,
		"Content-Type": "application/json",
		"HTTP-Referer": opts.referer ?? DEFAULT_REFERER,
		"X-Title": "ultrathink",
	};

	async function attempt(body: string, caller: AbortSignal | undefined): Promise<Attempt> {
		const controller = new AbortController();
		let timedOut = false;
		const onCallerAbort = (): void => controller.abort();
		caller?.addEventListener("abort", onCallerAbort, { once: true });
		const timer = setTimeout(() => {
			timedOut = true;
			controller.abort();
		}, opts.timeoutMs);
		try {
			let response: Response;
			let raw: string | undefined;
			try {
				response = await fetchImpl(url, {
					method: "POST",
					headers,
					body,
					signal: controller.signal,
					redirect: "error",
				});
				if (response.ok) {
					raw = await response.text();
				} else {
					void response.body?.cancel().catch(() => undefined);
				}
			} catch {
				if (caller?.aborted === true) {
					return { ok: false, error: new OpenRouterError("aborted"), retry: false };
				}
				if (timedOut) {
					return { ok: false, error: new OpenRouterError("timeout"), retry: false };
				}
				return { ok: false, error: new OpenRouterError("upstream"), retry: true };
			}
			if (raw !== undefined) {
				return parseCompletion(raw);
			}
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
			attempts += 1;
			const result = await attempt(body, signal);
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
			await sleep(result.retryAfterMs ?? backoffMs(retry), signal);
		}
	};
}
