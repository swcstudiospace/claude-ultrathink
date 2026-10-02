// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * One JSON request for the Hindsight and RAGFlow clients: a hard time budget, no redirects (a redirect would carry the
 * bearer key to another origin), a bounded response, and a result value instead of an exception. The only rejection is
 * an AbortError when the caller's own signal aborts. Error text is run through `redactSecrets`.
 */
import { redactSecrets } from "../grok/auth.ts";
import { USER_AGENT } from "../mcp/providers.ts";

export const MAX_RESPONSE_CHARS = 4_000_000;
/** setTimeout/AbortSignal.timeout reject delays above the signed 32-bit range. */
const MAX_TIMEOUT_MS = 2_147_483_647;

export interface HttpRequest {
	method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
	headers?: Record<string, string>;
	/** Serialized with JSON.stringify when present. */
	body?: unknown;
	timeoutMs: number;
	signal?: AbortSignal;
	fetch?: typeof fetch;
}

export type HttpOutcome =
	| { kind: "response"; status: number; json: unknown; text: string; ms: number }
	| { kind: "timeout"; ms: number }
	| { kind: "network"; message: string; ms: number };

function parseJson(text: string): unknown {
	if (text === "") return undefined;
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

/** Rejects with the signal's reason as soon as it aborts, even when `work` ignores the signal. */
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		if (signal.aborted) {
			reject(signal.reason);
			return;
		}
		const onAbort = () => reject(signal.reason);
		signal.addEventListener("abort", onAbort, { once: true });
		work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
	});
}

/** `json` is `undefined` when the body is empty or is not JSON; `text` is always the raw body. */
export async function requestJson(url: string, request: HttpRequest): Promise<HttpOutcome> {
	const started = Date.now();
	const budget = Math.min(Math.max(1, request.timeoutMs), MAX_TIMEOUT_MS);
	const timeout = AbortSignal.timeout(budget);
	const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
	const headers: Record<string, string> = { "User-Agent": USER_AGENT, Accept: "application/json", ...request.headers };
	if (request.body !== undefined) headers["Content-Type"] = "application/json";
	try {
		const response = await abortable(
			(request.fetch ?? fetch)(url, {
				method: request.method ?? (request.body === undefined ? "GET" : "POST"),
				headers,
				body: request.body === undefined ? undefined : JSON.stringify(request.body),
				signal,
				redirect: "error",
			}),
			signal,
		);
		const text = await abortable(response.text(), signal);
		const ms = Date.now() - started;
		if (text.length > MAX_RESPONSE_CHARS) return { kind: "network", message: "response too large", ms };
		return { kind: "response", status: response.status, json: parseJson(text), text, ms };
	} catch (error) {
		if (request.signal?.aborted) throw error;
		const ms = Date.now() - started;
		if (timeout.aborted) return { kind: "timeout", ms };
		const message = error instanceof Error ? error.message : String(error);
		return { kind: "network", message: redactSecrets(message).slice(0, 200), ms };
	}
}
