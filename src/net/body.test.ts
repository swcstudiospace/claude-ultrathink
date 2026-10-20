// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import { readBodyPrefix } from "./body.ts";

const encoder = new TextEncoder();

function chunked(chunks: string[]): { response: Response; cancelled: () => boolean; pulled: () => number } {
	let cancelled = false;
	let pulled = 0;
	const stream = new ReadableStream<Uint8Array>({
		pull(controller) {
			pulled++;
			const next = chunks.shift();
			if (next === undefined) controller.close();
			else controller.enqueue(encoder.encode(next));
		},
		cancel() {
			cancelled = true;
		},
	});
	return { response: new Response(stream), cancelled: () => cancelled, pulled: () => pulled };
}

describe("readBodyPrefix", () => {
	test("returns the whole body as complete when it fits", async () => {
		const { response, cancelled } = chunked(["ab", "cd"]);
		expect(await readBodyPrefix(response, 10)).toEqual({ text: "abcd", complete: true });
		expect(cancelled()).toBe(false);
	});

	test("stops at the limit, cancels the rest and reports an incomplete body", async () => {
		const { response, cancelled, pulled } = chunked(["abc", "def", "ghi", "jkl"]);
		expect(await readBodyPrefix(response, 4)).toEqual({ text: "abcd", complete: false });
		expect(cancelled()).toBe(true);
		expect(pulled()).toBeLessThan(4);
	});

	test("a body of exactly the limit is incomplete only when more follows", async () => {
		expect(await readBodyPrefix(chunked(["abcd"]).response, 4)).toEqual({ text: "abcd", complete: false });
		expect(await readBodyPrefix(chunked(["abc"]).response, 4)).toEqual({ text: "abc", complete: true });
	});

	test("decodes multi-byte characters split across chunks", async () => {
		const bytes = encoder.encode("héllo");
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(bytes.subarray(0, 2));
				controller.enqueue(bytes.subarray(2));
				controller.close();
			},
		});
		expect(await readBodyPrefix(new Response(stream), 100)).toEqual({ text: "héllo", complete: true });
	});

	test("an empty body is complete", async () => {
		expect(await readBodyPrefix(new Response(null), 10)).toEqual({ text: "", complete: true });
	});

	test("an abort cancels a stalled read and rejects with the reason", async () => {
		let cancelled = false;
		const stream = new ReadableStream<Uint8Array>({
			pull: () => new Promise<void>(() => {}),
			cancel() {
				cancelled = true;
			},
		});
		const controller = new AbortController();
		const pending = readBodyPrefix(new Response(stream), 10, controller.signal);
		controller.abort(new Error("stop"));
		await expect(pending).rejects.toThrow("stop");
		expect(cancelled).toBe(true);
	});

	test("a stream error is rethrown", async () => {
		const stream = new ReadableStream<Uint8Array>({
			pull(controller) {
				controller.error(new Error("reset"));
			},
		});
		await expect(readBodyPrefix(new Response(stream), 10)).rejects.toThrow("reset");
	});
});
