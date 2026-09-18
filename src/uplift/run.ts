import type { UpliftResult } from "../types.ts";
import { fallbackUplift } from "./fallback.ts";
import { UPLIFT_SYSTEM_PROMPT } from "./prompt.ts";
import { sanitizeUpliftXml } from "./xml.ts";

const DEFAULT_MAX_CHARS = 20000;

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

export async function runUplift(input: {
	original: string;
	conversation?: string;
	complete: (system: string, user: string, signal?: AbortSignal) => Promise<string>;
	signal?: AbortSignal;
	maxChars?: number;
}): Promise<UpliftResult> {
	const maxChars = input.maxChars ?? DEFAULT_MAX_CHARS;
	const original = input.original;

	if (original.length > maxChars) return fallbackResult(original);

	try {
		const raw = await input.complete(UPLIFT_SYSTEM_PROMPT, buildPayload(original, input.conversation), input.signal);
		if (!raw?.trim()) return fallbackResult(original);
		const xml = sanitizeUpliftXml(raw, original);
		if (!xml) return fallbackResult(original);
		return { xml, original, root: xml.trim().match(/^<([A-Za-z_][\w.-]*)\b/)?.[1] ?? "UPLIFTED_PROMPT", source: "llm" };
	} catch (error) {
		if (isAbortError(error)) throw error;
		return fallbackResult(original);
	}
}
