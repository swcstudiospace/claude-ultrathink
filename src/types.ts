// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
export const ROOT_TAGS = [
	"BUILD_PROMPT",
	"FIX_PROMPT",
	"RESEARCH_PROMPT",
	"CHANGE_PROMPT",
	"UPLIFTED_PROMPT",
] as const;

export type RootTag = (typeof ROOT_TAGS)[number];

export interface UpliftResult {
	xml: string;
	original: string;
	root: string;
	source: "llm" | "fallback";
	/** Why the uplift fell back: `provider_error:<http status>`, `provider_error`, `empty_reply`, `unparseable_reply`, `graph_minimum_not_met` or `input_over_limit`. Absent for `llm`. */
	fallbackReason?: string;
	/** Characters in the raw model reply; 0 when there was no reply. */
	rawReplyChars?: number;
	/** Completion attempts made for the uplift call, transient retries included. */
	attempts?: number;
}

/** What a completer reports about its most recent call: attempts and HTTP status, never the reply text. */
export interface CompletionReport {
	attempts: number;
	httpStatus?: number;
}

export interface UpliftState {
	enabled: boolean;
	skipOnce: boolean;
	skipTrivial: boolean;
}

export type UpliftDecision =
	| { action: "skip" }
	| { action: "passthrough"; text: string }
	| { action: "uplift"; text: string };
