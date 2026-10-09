// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * One JSON-RPC `tools/call` per desk tool. The desk contract is a single POST to
 * `<url>/mcp/<seat>`, not the streaming MCP session in `src/mcp/client.ts` (initialize,
 * notifications, SSE relay). This client reuses that session's tool envelope and the
 * shared HTTP helper (`requestJson`: hard budget, no redirects, redacted errors).
 */
import { redactSecrets } from "../grok/auth.ts";
import { requestJson } from "../net/http.ts";
import type { GatewayCallResult, GatewayFailure } from "./types.ts";

const MAX_REASON = 200;

export interface GatewayClientOptions {
	/** Normalized gateway origin (no trailing slash). */
	url: string;
	seat: string;
	token: string;
	timeoutMs: number;
	fetch?: typeof fetch;
	signal?: AbortSignal;
}

interface ToolPayload {
	payload: Record<string, unknown>;
	isError: boolean;
}

function oneLine(text: string, token: string): string {
	const hidden = token.trim();
	const out = redactSecrets(hidden ? text.replaceAll(hidden, "[redacted]") : text)
		.replace(/\s+/g, " ")
		.trim();
	return out.length > MAX_REASON ? `${out.slice(0, MAX_REASON - 3)}...` : out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonRecord(text: string): Record<string, unknown> | undefined {
	try {
		const parsed = JSON.parse(text) as unknown;
		return isRecord(parsed) ? parsed : undefined;
	} catch {
		return undefined;
	}
}

/** A JSON body, or the last SSE `data:` record from a streamable-HTTP response. */
function rpcMessage(json: unknown, text: string): Record<string, unknown> | undefined {
	if (isRecord(json)) return json;
	const data = text
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.startsWith("data:"))
		.map((line) => line.slice(5).trim())
		.filter((line) => line !== "" && line !== "[DONE]");
	const last = data.at(-1);
	return last ? jsonRecord(last) : undefined;
}

function toolPayload(message: Record<string, unknown>, token: string): ToolPayload | GatewayFailure {
	if (isRecord(message.error)) {
		const code = typeof message.error.message === "string" ? message.error.message : "request failed";
		const unknown = code.includes("unknown_tool");
		return { state: unknown ? "unready" : "degraded", reason: oneLine(code, token) };
	}
	const result = isRecord(message.result) ? message.result : message;
	const structured = isRecord(result.structuredContent) ? result.structuredContent : undefined;
	let payload = structured;
	if (!payload) {
		const content = Array.isArray(result.content) ? result.content : [];
		const text = content.find((item) => isRecord(item) && item.type === "text" && typeof item.text === "string");
		const raw = isRecord(text) && typeof text.text === "string" ? text.text : undefined;
		payload = raw ? (jsonRecord(raw) ?? { text: raw }) : isRecord(result) && !("content" in result) ? result : {};
	}
	return { payload, isError: result.isError === true };
}

function classify(payload: Record<string, unknown>, isError: boolean, token: string): GatewayFailure | undefined {
	const error = typeof payload.error === "string" ? payload.error : "";
	const reason = typeof payload.reason === "string" ? payload.reason : error;
	if (error === "unknown_tool") return { state: "unready", reason: oneLine(`unready: unknown_tool: ${reason}`, token) };
	if (error === "not_configured" || payload.state === "not_configured") {
		return { state: "degraded", reason: oneLine(`degraded: not_configured: ${reason}`, token) };
	}
	if (error || isError) return { state: "degraded", reason: oneLine(`degraded: ${error || "error"}: ${reason || "gateway tool error"}`, token) };
	return undefined;
}

export function createGatewayClient(options: GatewayClientOptions): {
	/** Top-level `error` / `isError` is already classified. Nested per-bank errors stay in the payload. */
	call(name: string, args: Record<string, unknown>): Promise<GatewayCallResult<Record<string, unknown>>>;
} {
	const endpoint = `${options.url}/mcp/${options.seat}`;
	return {
		async call(name: string, args: Record<string, unknown>): Promise<GatewayCallResult<Record<string, unknown>>> {
			const outcome = await requestJson(endpoint, {
				method: "POST",
				headers: {
					Accept: "application/json, text/event-stream",
					Authorization: `Bearer ${options.token}`,
				},
				body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
				timeoutMs: options.timeoutMs,
				signal: options.signal,
				fetch: options.fetch,
			});
			if (outcome.kind === "timeout") return { ok: false, state: "degraded", reason: `degraded: timeout after ${options.timeoutMs}ms` };
			if (outcome.kind === "network") return { ok: false, state: "degraded", reason: oneLine(`degraded: ${outcome.message}`, options.token) };
			if (outcome.status < 200 || outcome.status >= 300) {
				return { ok: false, state: "degraded", reason: oneLine(`degraded: gateway HTTP ${outcome.status}`, options.token) };
			}
			const message = rpcMessage(outcome.json, outcome.text);
			if (!message) return { ok: false, state: "degraded", reason: "degraded: gateway response was not JSON" };
			const parsed = toolPayload(message, options.token);
			if ("state" in parsed) return { ok: false, ...parsed };
			const failure = classify(parsed.payload, parsed.isError, options.token);
			if (failure) return { ok: false, ...failure };
			return { ok: true, value: parsed.payload };
		},
	};
}
