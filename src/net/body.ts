// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/** A bounded body read: never buffers more than `limit` bytes, whatever the upstream sends. */

export interface BodyPrefix {
	/** The first `limit` bytes decoded as UTF-8. */
	text: string;
	/** True when the stream ended within `limit` bytes; false when the body is longer (the rest was cancelled). */
	complete: boolean;
}

/**
 * Reads at most `limit` bytes of `response.body`, then cancels the rest of the stream. An abort of `signal` cancels a
 * pending read and rejects with the signal's reason; a stream error is rethrown. The reader lock is always released.
 * `needComplete` decides whether a body of exactly `limit` bytes is awaited to its end (complete) or returned at once.
 */
async function readPrefix(response: Response, limit: number, signal: AbortSignal | undefined, needComplete: boolean): Promise<BodyPrefix> {
	if (!response.body) return { text: "", complete: true };
	const reader = response.body.getReader();
	const onAbort = (): void => {
		reader.cancel(signal?.reason).catch(() => {});
	};
	signal?.addEventListener("abort", onAbort, { once: true });
	const decoder = new TextDecoder();
	let text = "";
	let size = 0;
	let complete = false;
	try {
		if (signal?.aborted) throw signal.reason;
		for (;;) {
			if (!needComplete && size === limit) break;
			const { done, value } = await reader.read();
			if (signal?.aborted) throw signal.reason;
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
		signal?.removeEventListener("abort", onAbort);
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}

/** Reads a body up to `limit` bytes and reports whether the whole body fit (waits for the stream to end at the limit). */
export function readBodyPrefix(response: Response, limit: number, signal?: AbortSignal): Promise<BodyPrefix> {
	return readPrefix(response, limit, signal, true);
}

/**
 * The first `limit` bytes as text, returned as soon as they are read. Use when only the text matters: a body that
 * ends exactly at the limit is not awaited, so a stalled upstream cannot hold the caller past the first `limit` bytes.
 */
export async function readBodyText(response: Response, limit: number, signal?: AbortSignal): Promise<string> {
	return (await readPrefix(response, limit, signal, false)).text;
}
