// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { createSseParser } from "./sse.ts";

export interface RelayAuth {
	header(): Promise<string | undefined>;
	unauthorized(failedHeader: string | undefined): Promise<boolean>;
}

export interface RelayOptions {
	url: string;
	auth: RelayAuth;
	write: (line: string) => void;
	fetch?: typeof fetch;
	userAgent: string;
	loginHint: string;
	log?: (message: string) => void;
}

interface RateLimit {
	retryAfter?: string;
}

interface Posted {
	response?: Response;
	header: string | undefined;
	sessionUsed: string | undefined;
	rateLimit?: RateLimit;
}

type JsonRpc = { id?: unknown; method?: unknown; result?: unknown };

function asRpc(message: unknown): JsonRpc {
	return typeof message === "object" && message !== null && !Array.isArray(message) ? (message as JsonRpc) : {};
}

const RATE_LIMIT_BODY_BYTES = 4096;
const RATE_LIMIT_TEXT = /rate[\s_-]?limit/i;

/** Reads at most `limit` bytes of the body, then cancels the rest of the stream. */
async function readBodyPrefix(response: Response, limit: number): Promise<string> {
	if (!response.body) return "";
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let text = "";
	let size = 0;
	try {
		while (size < limit) {
			const { done, value } = await reader.read();
			if (done) break;
			const chunk = value.subarray(0, limit - size);
			size += chunk.length;
			text += decoder.decode(chunk, { stream: true });
		}
		return text + decoder.decode();
	} catch {
		return text;
	} finally {
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}

function retryAfterSeconds(headers: Headers, body: string): string | undefined {
	const header = headers.get("retry-after")?.trim();
	if (header) {
		if (/^\d+$/.test(header)) return header;
		const at = Date.parse(header);
		if (!Number.isNaN(at)) return String(Math.max(0, Math.ceil((at - Date.now()) / 1000)));
	}
	return /retry[\s_-]?after\D{0,3}(\d+)/i.exec(body)?.[1];
}

/** 429, or a 401/403 that is really a rate limit. Consumes (bounded) the body of any 401/403/429. */
async function detectRateLimit(response: Response): Promise<RateLimit | undefined> {
	const { status, headers } = response;
	if (status !== 429 && status !== 401 && status !== 403) return undefined;
	const body = await readBodyPrefix(response, RATE_LIMIT_BODY_BYTES);
	const limited =
		status === 429 || headers.has("retry-after") || headers.get("x-ratelimit-remaining")?.trim() === "0" || RATE_LIMIT_TEXT.test(body);
	return limited ? { retryAfter: retryAfterSeconds(headers, body) } : undefined;
}

export function createRelay(options: RelayOptions): { handle(message: unknown, signal?: AbortSignal): Promise<void> } {
	const doFetch = options.fetch ?? fetch;
	const log = options.log ?? ((): void => {});
	const host = new URL(options.url).host;
	let sessionId: string | undefined;
	let protocolVersion: string | undefined;
	let initMessage: unknown;
	let reinitializing: Promise<void> | undefined;

	const post = async (message: unknown, withSession: boolean, signal?: AbortSignal): Promise<Posted> => {
		const header = await options.auth.header();
		const headers: Record<string, string> = {
			Accept: "application/json, text/event-stream",
			"Content-Type": "application/json",
			"User-Agent": options.userAgent,
		};
		if (header !== undefined) headers.Authorization = header;
		const sessionUsed = withSession ? sessionId : undefined;
		if (sessionUsed !== undefined) headers["Mcp-Session-Id"] = sessionUsed;
		if (protocolVersion !== undefined) headers["MCP-Protocol-Version"] = protocolVersion;
		try {
			const response = await doFetch(options.url, { method: "POST", headers, body: JSON.stringify(message), signal });
			return { response, header, sessionUsed, rateLimit: await detectRateLimit(response) };
		} catch {
			return { header, sessionUsed };
		}
	};

	const postWithAuth = async (message: unknown, withSession = true, signal?: AbortSignal): Promise<Posted> => {
		const first = await post(message, withSession, signal);
		if (first.rateLimit || first.response?.status !== 401) return first;
		if (!(await options.auth.unauthorized(first.header))) return first;
		return post(message, withSession, signal);
	};

	const observe = (message: unknown, initId: unknown, emit: (line: string) => void): void => {
		const rpc = asRpc(message);
		if (initId !== undefined && rpc.id === initId && typeof rpc.result === "object" && rpc.result !== null) {
			const version = (rpc.result as { protocolVersion?: unknown }).protocolVersion;
			if (typeof version === "string") protocolVersion = version;
		}
		emit(JSON.stringify(message));
	};

	const consume = async (response: Response, initId: unknown, emit: (line: string) => void, signal?: AbortSignal): Promise<void> => {
		if (response.status === 202 || !response.body) {
			await response.body?.cancel().catch(() => {});
			return;
		}
		const type = response.headers.get("content-type") ?? "";
		if (type.includes("text/event-stream")) {
			const parser = createSseParser((data) => {
				let parsed: unknown;
				try {
					parsed = JSON.parse(data);
				} catch {
					log("skipping unparsable SSE payload");
					return;
				}
				observe(parsed, initId, emit);
			});
			const decoder = new TextDecoder();
			for await (const chunk of response.body) {
				if (signal?.aborted) throw new Error("aborted");
				parser.push(decoder.decode(chunk, { stream: true }));
			}
			parser.push(decoder.decode());
			parser.end();
			return;
		}
		const text = await response.text();
		if (text.trim() === "") return;
		let parsed: unknown;
		try {
			parsed = JSON.parse(text);
		} catch {
			log("skipping unparsable JSON response");
			return;
		}
		for (const item of Array.isArray(parsed) ? parsed : [parsed]) observe(item, initId, emit);
	};

	const reinitialize = async (): Promise<void> => {
		if (initMessage === undefined) {
			sessionId = undefined;
			return;
		}
		const posted = await postWithAuth(initMessage, false);
		if (!posted.response?.ok) {
			log(`re-initialize failed: ${posted.response ? `HTTP ${posted.response.status}` : "unreachable"}`);
			await posted.response?.body?.cancel().catch(() => {});
			sessionId = undefined;
			return;
		}
		sessionId = posted.response.headers.get("mcp-session-id") ?? undefined;
		await consume(posted.response, asRpc(initMessage).id, () => {});
		const notified = await postWithAuth({ jsonrpc: "2.0", method: "notifications/initialized" });
		await notified.response?.body?.cancel().catch(() => {});
	};

	const writeError = (id: unknown, code: number, message: string): void => {
		options.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }));
	};

	const relay = async (
		message: unknown,
		rpc: JsonRpc,
		isRequest: boolean,
		emit: (line: string) => void,
		answered: () => boolean,
		signal: AbortSignal | undefined,
	): Promise<void> => {
		const isInitialize = rpc.method === "initialize";
		if (isInitialize) initMessage = message;
		else if (reinitializing) await reinitializing;
		let posted = await postWithAuth(message, true, signal);
		if (posted.response?.status === 404 && posted.sessionUsed !== undefined && !isInitialize) {
			await posted.response.body?.cancel().catch(() => {});
			if (posted.sessionUsed === sessionId) {
				reinitializing ??= reinitialize().finally(() => {
					reinitializing = undefined;
				});
			}
			if (reinitializing) await reinitializing;
			posted = await postWithAuth(message, true, signal);
		}
		const response = posted.response;
		if (!response) {
			log(`upstream unreachable (${String(rpc.method ?? "response")})`);
			if (isRequest) writeError(rpc.id, -32000, "upstream unreachable");
			return;
		}
		if (posted.rateLimit) {
			const { retryAfter } = posted.rateLimit;
			log(`upstream rate limited (HTTP ${response.status})`);
			if (isRequest) writeError(rpc.id, -32029, `${host} rate limited${retryAfter ? `; retry after ${retryAfter}s` : ""}`);
			return;
		}
		if (response.status === 401) {
			log("upstream authentication required");
			if (isRequest) writeError(rpc.id, -32001, `${host} MCP authentication required: ${options.loginHint}`);
			return;
		}
		if (!response.ok) {
			await response.body?.cancel().catch(() => {});
			log(`upstream HTTP ${response.status}`);
			if (isRequest) writeError(rpc.id, -32000, `upstream HTTP ${response.status}`);
			return;
		}
		if (isInitialize) {
			const captured = response.headers.get("mcp-session-id");
			if (captured) sessionId = captured;
		}
		try {
			await consume(response, isInitialize ? rpc.id : undefined, emit, signal);
		} catch {
			log("upstream stream failed");
			if (isRequest && !answered()) writeError(rpc.id, -32000, "upstream unreachable");
			return;
		}
		if (isRequest && !answered() && response.status !== 202) {
			writeError(rpc.id, -32000, "upstream closed stream before response");
		}
	};

	return {
		async handle(message: unknown, signal?: AbortSignal): Promise<void> {
			const rpc = asRpc(message);
			const isRequest = rpc.id !== undefined && rpc.id !== null && typeof rpc.method === "string";
			let replied = false;
			const emit = (line: string): void => {
				if (isRequest && !replied) {
					const out = asRpc(JSON.parse(line)) as JsonRpc & { error?: unknown };
					if (out.id === rpc.id && out.method === undefined && ("result" in out || "error" in out)) replied = true;
				}
				options.write(line);
			};
			try {
				await relay(message, rpc, isRequest, emit, () => replied, signal);
			} catch (error) {
				log("relay error");
				if (isRequest && !replied) writeError(rpc.id, -32603, `relay error: ${error instanceof Error ? error.message : String(error)}`);
			}
		},
	};
}

export async function runStdioRelay(
	options: Omit<RelayOptions, "write">,
	input: ReadableStream<Uint8Array> = Bun.stdin.stream(),
	output: (line: string) => void = (line) => {
		process.stdout.write(`${line}\n`);
	},
): Promise<void> {
	const relay = createRelay({ ...options, write: output });
	const inFlight = new Set<Promise<void>>();
	const dispatch = (line: string): void => {
		if (line.trim() === "") return;
		let message: unknown;
		try {
			message = JSON.parse(line);
		} catch {
			output(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }));
			return;
		}
		const task = relay.handle(message).catch(() => {
			options.log?.("relay handler failed");
		});
		inFlight.add(task);
		void task.finally(() => inFlight.delete(task));
	};
	const decoder = new TextDecoder();
	let buffer = "";
	for await (const chunk of input) {
		buffer += decoder.decode(chunk, { stream: true });
		let index = buffer.indexOf("\n");
		while (index !== -1) {
			dispatch(buffer.slice(0, index));
			buffer = buffer.slice(index + 1);
			index = buffer.indexOf("\n");
		}
	}
	buffer += decoder.decode();
	dispatch(buffer);
	while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
}
