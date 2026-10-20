// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Bounded Body Reading Utilities
 * Provides safe reading of HTTP response/request bodies with size limits
 */

export interface BodyPrefix {
	/** The first `limit` bytes decoded as UTF-8. */
	text: string;
	/** True when the stream ended within `limit` bytes; false when the body is longer (the rest was cancelled). */
	complete: boolean;
}

type ChunkResult = { done: false; value: Uint8Array } | { done: true; value?: Uint8Array };
type ChunkReader = Pick<ReadableStreamDefaultReader<Uint8Array>, "read" | "cancel" | "releaseLock">;

/**
 * Waits for the next chunk. If `signal` aborts first, the stream is cancelled and the read rejects
 * with the signal's reason, so a pending read never outlives the abort.
 */
function readChunk(reader: ChunkReader, signal?: AbortSignal): Promise<ChunkResult> {
	if (!signal) return reader.read();
	if (signal.aborted) return Promise.reject(signal.reason);
	const { promise, resolve, reject } = Promise.withResolvers<ChunkResult>();
	const onAbort = () => {
		reader.cancel(signal.reason).catch(() => {});
		reject(signal.reason);
	};
	signal.addEventListener("abort", onAbort, { once: true });
	reader.read().then(
		(chunk) => {
			signal.removeEventListener("abort", onAbort);
			resolve(chunk);
		},
		(err: unknown) => {
			signal.removeEventListener("abort", onAbort);
			reject(err);
		},
	);
	return promise;
}

/**
 * Reads at most `limit` bytes of `response.body`, then cancels the rest of the stream.
 * An abort of `signal` cancels a pending read and rejects with the signal's reason;
 * a stream error is rethrown. The reader lock is always released.
 */
export async function readBodyPrefix(response: Response, limit: number, signal?: AbortSignal): Promise<{ text: string; complete: boolean }> {
	signal?.throwIfAborted();
	if (!response.body) return { text: "", complete: true };
	const reader: ChunkReader = response.body.getReader();
	const decoder = new TextDecoder();
	let text = "";
	let size = 0;
	let complete = false;
	try {
		for (;;) {
			const { done, value } = await readChunk(reader, signal);
			if (done) {
				complete = true;
				break;
			}
			// Past the limit: keep the part that fits; the rest is left unread and the stream is cancelled below.
			if (size + value.length > limit) {
				text += decoder.decode(value.subarray(0, limit - size), { stream: true });
				break;
			}
			size += value.length;
			text += decoder.decode(value, { stream: true });
		}
		return { text: text + decoder.decode(), complete };
	} finally {
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}

/**
 * Reads the full body as text with a size limit.
 * Returns the body text or throws if the body exceeds the limit.
 */
export async function readBodyText(response: Response, limit: number, signal?: AbortSignal): Promise<string> {
	const result = await readBodyPrefix(response, limit, signal);
	if (!result.complete) {
		throw new Error(`Response body exceeds limit of ${limit} bytes`);
	}
	return result.text;
}

/**
 * Reads and parses JSON with a size limit.
 * Returns the parsed object or throws if the body exceeds the limit or is not valid JSON.
 */
export async function readJsonBody<T = unknown>(response: Response, limit: number, signal?: AbortSignal): Promise<T> {
	const result = await readBodyPrefix(response, limit, signal);
	if (!result.complete) {
		throw new Error(`Response body exceeds limit of ${limit} bytes`);
	}
	try {
		return JSON.parse(result.text) as T;
	} catch {
		throw new Error('Response body is not valid JSON');
	}
}

export default {
	readBodyPrefix,
	readBodyText,
	readJsonBody,
};