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
 */
export async function readBodyPrefix(response: Response, limit: number, signal?: AbortSignal): Promise<BodyPrefix> {
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
		while (size < limit) {
			const { done, value } = await reader.read();
			if (signal?.aborted) throw signal.reason;
			if (done) {
				complete = true;
				break;
			}
			const chunk = value.subarray(0, limit - size);
			size += chunk.length;
			text += decoder.decode(chunk, { stream: true });
		}
		return { text: text + decoder.decode(), complete };
	} finally {
		signal?.removeEventListener("abort", onAbort);
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}
