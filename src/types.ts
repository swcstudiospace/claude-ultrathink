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
