// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import type { CompletionReport, UpliftResult } from "../types.ts";
import { fallbackUplift } from "./fallback.ts";
import { UPLIFT_SYSTEM_PROMPT } from "./prompt.ts";
import { sanitizeUpliftXml } from "./xml.ts";

/** Input gate in characters; 0 means no gate. A positive value is an explicit cap. */
export const DEFAULT_MAX_CHARS = 0;

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}

function buildPayload(original: string, conversation?: string): string {
	if (conversation?.trim()) {
		return `<conversation>\n${conversation}\n</conversation>\n\n<user_request>\n${original}\n</user_request>`;
	}
	return `<user_request>\n${original}\n</user_request>`;
}

function fallbackResult(original: string): UpliftResult {
	const xml = fallbackUplift(original);
	return { xml, original, root: "UPLIFTED_PROMPT", source: "fallback" };
}

function fallbackWith(original: string, fallbackReason: string, rawReplyChars: number, attempts: number): UpliftResult {
	return { ...fallbackResult(original), fallbackReason, rawReplyChars, attempts };
}

/** `provider_error:<status>` when the provider's HTTP status is known, else `provider_error`. */
function providerReason(report: CompletionReport | undefined): string {
	return report?.httpStatus === undefined ? "provider_error" : `provider_error:${report.httpStatus}`;
}

export async function runUplift(input: {
	original: string;
	conversation?: string;
	complete: (system: string, user: string, signal?: AbortSignal) => Promise<string>;
	signal?: AbortSignal;
	maxChars?: number;
	/** The completer's report for its most recent call; absent when the route reports nothing. */
	report?: () => CompletionReport | undefined;
}): Promise<UpliftResult> {
	const maxChars = input.maxChars ?? DEFAULT_MAX_CHARS;
	const original = input.original;

	if (maxChars > 0 && original.length > maxChars) return { ...fallbackResult(original), fallbackReason: "input_over_limit", rawReplyChars: 0, attempts: 0 };

	try {
		const raw = await input.complete(UPLIFT_SYSTEM_PROMPT, buildPayload(original, input.conversation), input.signal);
		const report = input.report?.();
		const attempts = report?.attempts ?? 1;
		const reply = raw ?? "";
		if (!reply.trim()) return fallbackWith(original, "empty_reply", reply.length, attempts);
		const xml = sanitizeUpliftXml(raw, original);
		if (!xml) return fallbackWith(original, "unparseable_reply", reply.length, attempts);
		return {
			xml,
			original,
			root: xml.trim().match(/^<([A-Za-z_][\w.-]*)\b/)?.[1] ?? "UPLIFTED_PROMPT",
			source: "llm",
			...(report ? { attempts } : {}),
		};
	} catch (error) {
		if (isAbortError(error)) throw error;
		const report = input.report?.();
		return fallbackWith(original, providerReason(report), 0, report?.attempts ?? 1);
	}
}
