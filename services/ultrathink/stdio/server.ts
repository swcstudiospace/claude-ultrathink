// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

/**
 * The MCP stdio transport: newline-delimited JSON-RPC in, one JSON line out per reply. It owns framing only; every
 * message is answered by the same handleMcpPayload the HTTP route uses. It never touches process streams, so a test
 * drives it with an array of chunks and a collecting callback, and the entry point (main.ts) wires stdin and stdout.
 */

import { type McpToolHost, handleMcpPayload } from "../mcp/mcp.ts";
import type { Logger } from "../obs/log.ts";

/** A line longer than this is refused and discarded, so one runaway message cannot grow memory without bound. */
export const MAX_LINE_BYTES = 1024 * 1024;

const NEWLINE = 0x0a;
const CARRIAGE_RETURN = 0x0d;
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const INTERNAL_ERROR = -32603;

/** What handleMcpPayload answers with: null when nothing is to be sent back. */
interface McpReply {
	body: unknown;
	status?: number;
}

export interface StdioServerOptions {
	host: McpToolHost;
	/** Raw input in arbitrary chunks (a chunk may hold several lines, or half of one, even half of a UTF-8 character). */
	input: AsyncIterable<Uint8Array | string>;
	/** Receives one complete JSON document without a newline; the caller adds the framing. Awaited, so output stays ordered. */
	write: (line: string) => void | Promise<void>;
	logger?: Logger;
	/** Stops the loop between messages: the message being handled finishes first. */
	signal?: AbortSignal;
	maxLineBytes?: number;
}

function errorLine(id: unknown, code: number, message: string): string {
	return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
}

/** `value[key]` when `value` is a plain object, otherwise undefined. */
function field(value: unknown, key: string): unknown {
	return typeof value === "object" && value !== null && !Array.isArray(value) && key in value
		? Object.getOwnPropertyDescriptor(value, key)?.value
		: undefined;
}

/** The id to answer a failed request with: the request's own when it is a valid id, otherwise null. */
function requestId(payload: unknown): string | number | null {
	const id = field(payload, "id");
	return typeof id === "string" || (typeof id === "number" && Number.isInteger(id)) ? id : null;
}

/** The protocol version an initialize reply settled on, if `reply` is one. */
function negotiatedVersion(payload: unknown, reply: unknown): string | undefined {
	if (field(payload, "method") !== "initialize") return undefined;
	const version = field(field(reply, "result"), "protocolVersion");
	return typeof version === "string" ? version : undefined;
}

function toBytes(chunk: Uint8Array | string): Uint8Array {
	return typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk;
}

function join(parts: Uint8Array[], total: number): Uint8Array {
	if (parts.length === 1 && parts[0] !== undefined) return parts[0];
	const joined = new Uint8Array(total);
	let offset = 0;
	for (const part of parts) {
		joined.set(part, offset);
		offset += part.length;
	}
	return joined;
}

/**
 * Reads lines from `input` until it ends or `signal` aborts, answers each sequentially, and resolves when done.
 * Nothing here throws on bad input: a line that is not JSON gets -32700, an oversized one -32600, a handler that
 * throws -32603 without the thrown message (it could carry request data).
 */
export async function serveStdio(options: StdioServerOptions): Promise<void> {
	const { host, write, logger, signal } = options;
	const maxLine = options.maxLineBytes ?? MAX_LINE_BYTES;
	const decoder = new TextDecoder();
	let protocolVersion: string | undefined;
	let parts: Uint8Array[] = [];
	let partsBytes = 0;
	// After an oversized line is refused its remaining bytes are skipped up to the next newline.
	let discarding = false;

	async function refuseOversized(bytes: number): Promise<void> {
		logger?.warn("line_too_long", { bytes });
		await write(errorLine(null, INVALID_REQUEST, "invalid request: line too long"));
	}

	async function handleLine(bytes: Uint8Array): Promise<void> {
		let end = bytes.length;
		if (end > 0 && bytes[end - 1] === CARRIAGE_RETURN) end -= 1;
		const text = decoder.decode(bytes.subarray(0, end));
		if (text.trim() === "") return;
		let payload: unknown;
		try {
			payload = JSON.parse(text);
		} catch {
			logger?.warn("parse_error", { bytes: end });
			await write(errorLine(null, PARSE_ERROR, "parse error"));
			return;
		}
		let reply: McpReply | null;
		try {
			reply = await handleMcpPayload(host, payload, protocolVersion === undefined ? undefined : { protocolVersion });
		} catch (error) {
			// Only the error class is kept: the message may quote request content.
			logger?.error("handler_error", { error: error instanceof Error ? error.name : "UnknownError" });
			await write(errorLine(requestId(payload), INTERNAL_ERROR, "internal error"));
			return;
		}
		if (reply === null) return;
		protocolVersion = negotiatedVersion(payload, reply.body) ?? protocolVersion;
		await write(JSON.stringify(reply.body));
	}

	/** Consumes one chunk: completes every line it ends and keeps the unfinished tail. */
	async function feed(chunk: Uint8Array): Promise<void> {
		let offset = 0;
		while (offset < chunk.length && signal?.aborted !== true) {
			const newline = chunk.indexOf(NEWLINE, offset);
			const end = newline === -1 ? chunk.length : newline;
			const segment = chunk.subarray(offset, end);
			offset = newline === -1 ? chunk.length : newline + 1;
			if (discarding) {
				if (newline !== -1) discarding = false;
				continue;
			}
			const total = partsBytes + segment.length;
			if (total > maxLine) {
				parts = [];
				partsBytes = 0;
				await refuseOversized(total);
				// A newline in this very chunk already ended the oversized line.
				discarding = newline === -1;
				continue;
			}
			if (newline === -1) {
				// Copied: the chunk's buffer may be reused by the stream after this call.
				parts.push(segment.slice());
				partsBytes = total;
				continue;
			}
			parts.push(segment);
			const line = join(parts, total);
			parts = [];
			partsBytes = 0;
			await handleLine(line);
		}
	}

	const iterator = options.input[Symbol.asyncIterator]();
	const aborted = new Promise<"aborted">((resolve) => {
		if (signal?.aborted) resolve("aborted");
		signal?.addEventListener("abort", () => resolve("aborted"), { once: true });
	});

	try {
		for (;;) {
			if (signal?.aborted) return;
			const next = await Promise.race([iterator.next(), aborted]);
			if (next === "aborted") return;
			if (next.done) break;
			await feed(toBytes(next.value));
		}
		// Input ended in the middle of a line: it is still a message.
		if (!discarding && partsBytes > 0) await handleLine(join(parts, partsBytes));
	} finally {
		// Not awaited: a stream that never yields would keep a shutdown waiting.
		void Promise.resolve(iterator.return?.()).catch(() => undefined);
	}
}
