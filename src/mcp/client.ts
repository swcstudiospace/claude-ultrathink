// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { recoverUnauthorized, resolveAuthHeader } from "./oauth.ts";
import { PROVIDERS, USER_AGENT } from "./providers.ts";
import type { ProviderId } from "./providers.ts";
import { createRelay } from "./relay.ts";
import { readStore } from "./store.ts";
import type { ToolCaller } from "../track/create.ts";

export interface McpClient extends ToolCaller {
	listTools(signal?: AbortSignal): Promise<Array<{ name: string; inputSchema?: unknown }>>;
	close(): void;
}

export interface McpClientDeps {
	storePath: string;
	fetch?: typeof fetch;
	callTimeoutMs?: number;
}

interface RpcReply {
	id?: unknown;
	method?: unknown;
	result?: unknown;
	error?: { message?: unknown };
}

interface Pending {
	waiter: PromiseWithResolvers<unknown>;
	controller: AbortController;
}

interface ToolResult {
	content?: Array<{ type?: string; text?: string }>;
	structuredContent?: unknown;
	isError?: boolean;
}

/**
 * What to run when `provider` has no usable credential: OAuth login, plus the API-key route where the provider
 * takes one (a personal key created in the provider's account settings).
 */
export function loginHint(provider: ProviderId): string {
	const login = `ultrathink-mcp auth login ${provider}`;
	if (!PROVIDERS[provider].apiKey) return `run: ${login}`;
	return `run: ${login} (OAuth) or ultrathink-mcp auth set-key ${provider} --stdin (API key from your ${PROVIDERS[provider].label} account settings)`;
}

function short(text: string): string {
	const line = text.replace(/\s+/g, " ").trim();
	return line.length > 200 ? `${line.slice(0, 197)}...` : line;
}

function unwrapToolResult(name: string, raw: unknown): unknown {
	const result = (typeof raw === "object" && raw !== null ? raw : {}) as ToolResult;
	const text = result.content?.find((item) => item.type === "text" && typeof item.text === "string")?.text;
	if (result.isError) throw new Error(short(`${name}: ${text ?? "tool error"}`));
	if (result.structuredContent !== undefined) return result.structuredContent;
	if (text === undefined) return raw;
	try {
		return JSON.parse(text);
	} catch {
		return text;
	}
}

export function createMcpClient(provider: ProviderId, deps: McpClientDeps): McpClient {
	const timeoutMs = deps.callTimeoutMs ?? 30_000;
	const authDeps = { storePath: deps.storePath, fetch: deps.fetch };
	const pending = new Map<number, Pending>();
	let closed = false;
	let nextId = 1;
	let initialized: Promise<void> | undefined;

	const relay = createRelay({
		url: PROVIDERS[provider].url,
		userAgent: USER_AGENT,
		loginHint: loginHint(provider),
		fetch: deps.fetch,
		auth: {
			header: () => resolveAuthHeader(provider, authDeps),
			unauthorized: (failed) => recoverUnauthorized(provider, failed, authDeps),
		},
		write(line) {
			let reply: RpcReply;
			try {
				reply = JSON.parse(line) as RpcReply;
			} catch {
				return;
			}
			if (typeof reply !== "object" || reply === null) return;
			if (typeof reply.id !== "number" || reply.method !== undefined || !("result" in reply || "error" in reply)) return;
			const entry = pending.get(reply.id);
			if (!entry) return;
			pending.delete(reply.id);
			if (reply.error) {
				const message = typeof reply.error.message === "string" ? reply.error.message : "request failed";
				entry.waiter.reject(new Error(short(message)));
			} else entry.waiter.resolve(reply.result);
		},
	});

	const request = async (method: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> => {
		if (closed) throw new Error(`${provider}: client closed`);
		if (signal?.aborted) throw new Error(`${method}: aborted`);
		const id = nextId++;
		const entry: Pending = { waiter: Promise.withResolvers<unknown>(), controller: new AbortController() };
		const { waiter, controller } = entry;
		pending.set(id, entry);
		const fail = (message: string): void => {
			pending.delete(id);
			waiter.reject(new Error(message));
			controller.abort();
		};
		const timer = setTimeout(() => fail(`${method}: timed out after ${timeoutMs}ms`), timeoutMs);
		const onAbort = (): void => fail(`${method}: aborted`);
		signal?.addEventListener("abort", onAbort, { once: true });
		void relay.handle({ jsonrpc: "2.0", id, method, params }, controller.signal).then(() => {
			if (pending.get(id) === entry) {
				pending.delete(id);
				waiter.reject(new Error(`${method}: no response`));
			}
		});
		try {
			return await waiter.promise;
		} finally {
			clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		}
	};

	const ensureInitialized = (signal?: AbortSignal): Promise<void> => {
		initialized ??= (async () => {
			await request(
				"initialize",
				{ protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "ultrathink-track", version: "0.2.0" } },
				signal,
			);
			await relay.handle({ jsonrpc: "2.0", method: "notifications/initialized" });
		})();
		const current = initialized;
		current.catch(() => {
			if (initialized === current) initialized = undefined;
		});
		return current;
	};

	return {
		async call(name, args, signal) {
			await ensureInitialized(signal);
			return unwrapToolResult(name, await request("tools/call", { name, arguments: args }, signal));
		},
		async listTools(signal) {
			await ensureInitialized(signal);
			const tools: Array<{ name: string; inputSchema?: unknown }> = [];
			let cursor: string | undefined;
			do {
				const result = (await request("tools/list", cursor ? { cursor } : {}, signal)) as
					| { tools?: Array<{ name: string; inputSchema?: unknown }>; nextCursor?: string }
					| undefined;
				tools.push(...(result?.tools ?? []));
				cursor = result?.nextCursor;
			} while (cursor);
			return tools;
		},
		close() {
			closed = true;
			for (const [id, entry] of pending) {
				pending.delete(id);
				entry.waiter.reject(new Error(`${provider}: client closed`));
				entry.controller.abort();
			}
		},
	};
}

/** True when `provider` has a usable stored credential: an API key, or OAuth tokens that do not need a new login. */
export function hasUsableCredential(provider: ProviderId, storePath: string): boolean {
	const credential = readStore(storePath).providers[provider];
	if (!credential) return false;
	return credential.kind === "api_key" || (!credential.needsLogin && Boolean(credential.tokens));
}

/** A client for `provider` when hasUsableCredential is true; otherwise undefined. Never throws. */
export function createMcpClientIfCredentialed(provider: ProviderId, deps: McpClientDeps): McpClient | undefined {
	try {
		return hasUsableCredential(provider, deps.storePath) ? createMcpClient(provider, deps) : undefined;
	} catch {
		return undefined;
	}
}
