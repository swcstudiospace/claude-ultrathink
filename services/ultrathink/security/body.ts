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

/**
 * Reads at most `limit` bytes of `response.body`, then cancels the rest of the stream.
 * An abort of `signal` cancels a pending read and rejects with the signal's reason;
 * a stream error is rethrown. The reader lock is always released.
 */
export async function readBodyPrefix(response: Response, limit: number, _signal?: AbortSignal): Promise<{ text: string; complete: boolean }> {
	if (!response.body) return { text: "", complete: true };
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let text = "";
	let size = 0;
	let complete = false;
	try {
		for (;;) {
			const { done, value } = await reader.read();
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
export async function readBodyText(response: Response, limit: number, _signal?: AbortSignal): Promise<string> {
	const result = await readBodyPrefix(response, limit);
	if (!result.complete) {
		throw new Error(`Response body exceeds limit of ${limit} bytes`);
	}
	return result.text;
}

/**
 * Reads and parses JSON with a size limit.
 * Returns the parsed object or throws if the body exceeds the limit or is not valid JSON.
 */
export async function readJsonBody<T = unknown>(response: Response, _limit: number, _signal?: AbortSignal): Promise<T> {
	const result = await readBodyPrefix(response, _limit);
	if (!result.complete) {
		throw new Error(`Response body exceeds limit of ${_limit} bytes`);
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