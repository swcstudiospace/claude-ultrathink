import { ROOT_TAGS, type UpliftDecision, type UpliftState } from "../types.ts";

const ALREADY_TAGS = [...ROOT_TAGS, "uplifted", "ultrathink"] as const;
const ALREADY_ROOTS: Record<string, true> = Object.fromEntries(
	ALREADY_TAGS.map((tag) => [tag.toLowerCase(), true as const]),
);
const TRIVIAL_RE =
	/^(?:yes|y|no|n|ok|okay|k|continue|go|go ahead|do it|please|thanks|thank you|sure|yep|nope|lgtm)[.!?!,;:]*$/i;

const COMMAND_TAG_RE = /^<(?:command-name|command-message|local-command)\b/i;

/** User-typed `/cmd` and Claude Code expansions (`<command-name>…`) must not be rewritten. */
export function isCommandPrompt(text: string): boolean {
	const trimmed = text.trim();
	return trimmed.startsWith("/") || COMMAND_TAG_RE.test(trimmed);
}

export function stripPrefix(text: string): { text: string; force: boolean; raw: boolean } {
	const trimmed = text.trim();
	const rawMatch = trimmed.match(/^raw:\s*/i);
	if (rawMatch) {
		return { text: trimmed.slice(rawMatch[0].length).trim(), force: false, raw: true };
	}
	const forceMatch = trimmed.match(/^uplift:\s*/i);
	if (forceMatch) {
		return { text: trimmed.slice(forceMatch[0].length).trim(), force: true, raw: false };
	}
	return { text: trimmed, force: false, raw: false };
}

export function isTrivial(text: string): boolean {
	return TRIVIAL_RE.test(text.trim());
}

export function isAlreadyUplifted(text: string): boolean {
	const trimmed = text.trim();
	if (trimmed.startsWith("<")) {
		const tag = /^<([A-Za-z_][\w.-]*)/.exec(trimmed)?.[1];
		return tag !== undefined && ALREADY_ROOTS[tag.toLowerCase()] === true;
	}
	return ALREADY_ROOTS[trimmed.toLowerCase()] === true;
}

export function decideUplift(
	event: { text: string; source: string; streamingBehavior?: string; idle?: boolean },
	state: UpliftState,
): UpliftDecision {
	if (event.source === "extension") return { action: "skip" };
	if (event.idle === false || event.streamingBehavior === "steer") return { action: "skip" };

	const { text, force, raw } = stripPrefix(event.text);
	if (!text) return { action: "skip" };
	if (raw) return { action: "passthrough", text };

	if (isCommandPrompt(text)) return { action: "skip" };
	if (isAlreadyUplifted(text)) return { action: "skip" };

	if (state.skipOnce) {
		state.skipOnce = false;
		return { action: "skip" };
	}

	if (!state.enabled && !force) return { action: "skip" };
	if (isTrivial(text) && !force && state.skipTrivial !== false) return { action: "skip" };
	return { action: "uplift", text };
}
