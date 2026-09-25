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
