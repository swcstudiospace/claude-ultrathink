// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Shared types for the OpenRouter Decisions API (Jev): wire shapes, the `decisions` config section, the named
 * thresholds, error kinds and the per-call `DecisionRecord`. Imports nothing, so every layer can depend on it.
 */

export type DecisionPoint = "plan" | "ship" | "knowledge" | "blocking" | "teachable" | "skillworthy";
export const DECISION_POINTS: readonly DecisionPoint[] = ["plan", "ship", "knowledge", "blocking", "teachable", "skillworthy"];

export const DEFAULT_DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";
export const DEFAULT_DECISIONS_MODEL = "~typesafe/jev-latest";
/** D7: estimated tokens (chars / 4 of JSON {state, questions}) above this fail locally as too-large. */
export const MAX_ESTIMATED_TOKENS = 28_000;
/** D6: a retry needs at least this much of the budget left. */
export const RETRY_MIN_REMAINING_MS = 500;
export const MAX_ERROR_CHARS = 200;

// Thresholds: the §5 defaults, probed on typesafe/jev-1.13-20260917 (brief §2). Each comment names both mistakes.
/** Plan gate: skip planning when P(plan_worthy) < this. False skip → the prompt reaches the agent unplanned (resend with `uplift:`); false plan → today's cost. */
export const PLAN_SKIP_BELOW = 0.2;
/** Ship veto: an LLM "done" becomes not done when P(complete) <= this on an untruncated patch. False veto → PR not opened (gate mode hands back); false keep → today's behaviour. */
export const SHIP_VETO_AT_OR_BELOW = 0.2;
/** Ship verdict without a usable LLM verdict: done iff P(complete) >= this. False approve → a PR opens and still faces the unchanged Greptile merge gate; false reject → not done, the user re-runs. */
export const SHIP_APPROVE_AT = 0.7;
/** KB claim kept when P(supported) >= this. False reject → one extra question; false keep → today's behaviour. */
export const GROUNDED_AT = 0.8;
/** Promote to blocking when P(risky) >= this. False promote → one extra question before work; missed promote → today's behaviour. */
export const BLOCKING_AT = 0.5;
/** Teachable lesson: dropped before it is stored when P(teachable) < this. False drop → a lesson is lost (the next session can rediscover it); false keep → one more candidate to review. */
export const TEACHABLE_BELOW = 0.3;
/** Auto capture confirms a candidate only when P(teachable) >= this as well as confidence >= 0.8. False hold → a human confirms it; false confirm → today's auto behaviour. */
export const TEACHABLE_AUTO_AT = 0.8;
/** Promote a lesson to a skill (`promote --due`, `promoteDue`) only when P(skillworthy) >= this. False skip → promoted by hand later; false keep → today's behaviour. */
export const SKILLWORTHY_AT = 0.5;

export interface DecisionsConfig {
	enabled: boolean;
	model: string;
	points: DecisionPoint[];
	timeoutMs: number;
	zdr: boolean;
	planSkipBelow: number;
	shipVetoAtOrBelow: number;
	shipApproveAt: number;
	groundedAt: number;
	blockingAt: number;
	teachableBelow: number;
	teachableAutoAt: number;
	skillworthyAt: number;
}

export const DEFAULT_DECISIONS_CONFIG: DecisionsConfig = {
	enabled: false,
	model: DEFAULT_DECISIONS_MODEL,
	points: ["plan", "ship", "knowledge", "blocking", "teachable", "skillworthy"],
	timeoutMs: 3000,
	zdr: true,
	planSkipBelow: PLAN_SKIP_BELOW,
	shipVetoAtOrBelow: SHIP_VETO_AT_OR_BELOW,
	shipApproveAt: SHIP_APPROVE_AT,
	groundedAt: GROUNDED_AT,
	blockingAt: BLOCKING_AT,
	teachableBelow: TEACHABLE_BELOW,
	teachableAutoAt: TEACHABLE_AUTO_AT,
	skillworthyAt: SKILLWORTHY_AT,
};

// Wire types (brief §1)
export interface NoulQuestion {
	type: "noul";
	instructions: string;
	criteria?: { true: string; false: string };
}
export interface ChoiceQuestion {
	type: "choice";
	instructions: string;
	criteria: Record<string, string>;
}
export interface ScoreQuestion {
	type: "score";
	instructions: string;
	criteria: string[];
}
export type DecisionQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;
export type DecisionState = string | Record<string, unknown> | unknown[];
export interface ProviderPreferences {
	zdr?: boolean;
	data_collection?: "allow" | "deny";
}
export interface DecisionsTrace {
	trace_id?: string;
	trace_name?: string;
	span_name?: string;
}
export interface DecisionsRequest {
	model: string;
	state: DecisionState;
	questions: Record<string, DecisionQuestion>;
	provider?: ProviderPreferences;
	session_id?: string;
	trace?: DecisionsTrace;
	user?: string;
}
export interface NoulAnswer {
	type: "noul";
	noul: number;
}
export interface ChoiceAnswer {
	type: "choice";
	choice: string;
	probabilities?: Record<string, number>;
	confidence?: number;
}
export interface ScoreAnswer {
	type: "score";
	score: number;
	probabilities?: Record<string, number>;
	confidence?: number;
	legend?: unknown;
}
export type DecisionAnswer = NoulAnswer | ChoiceAnswer | ScoreAnswer;
export interface DecisionsUsage {
	input_tokens: number;
	output_tokens: number;
	cost?: number;
}
export interface DecisionsResponse {
	id?: string;
	model: string;
	provider?: string;
	answers: Record<string, DecisionAnswer>;
	usage: DecisionsUsage;
}

export type DecisionsErrorKind =
	| "auth"
	| "credits"
	| "bad-request"
	| "too-large"
	| "rate-limit"
	| "upstream"
	| "timeout"
	| "network"
	| "invalid-response";
export const DECISIONS_ERROR_KINDS: readonly DecisionsErrorKind[] = [
	"auth",
	"credits",
	"bad-request",
	"too-large",
	"rate-limit",
	"upstream",
	"timeout",
	"network",
	"invalid-response",
];

/** A classified, redacted Decisions failure. `message` is one line, ≤ 200 chars, format `decisions <kind>: <detail>`. */
export class DecisionsError extends Error {
	readonly kind: DecisionsErrorKind;
	/** HTTP status when the failure was an HTTP response. */
	readonly status?: number;
	constructor(kind: DecisionsErrorKind, message: string, status?: number) {
		super(message);
		this.name = "DecisionsError";
		this.kind = kind;
		if (status !== undefined) this.status = status;
	}
}

export type DecisionAction =
	| "plan"
	| "skip-plan" // plan
	| "veto"
	| "advise-veto"
	| "approve"
	| "reject"
	| "none" // ship
	| "keep"
	| "reject-claim" // knowledge (keep also = blocking unchanged)
	| "promote" // blocking
	| "drop"
	| "hold"
	| "auto-confirm" // teachable (keep also = unchanged)
	| "skip" // skillworthy (keep also = unchanged)
	| "fail-open"; // any point, any error

/** One Jev call. Never holds state content or the key. */
export interface DecisionRecord {
	point: DecisionPoint;
	outcome: "ok" | "error";
	/** Resolved `response.model` when ok; the requested model (config) on error. */
	model: string;
	/** `response.id` when returned. */
	id?: string;
	/** P of the point's single question; present iff outcome is "ok". */
	p?: number;
	/** P by question key, e.g. {plan_worthy: 0.97}; {} on error. */
	probabilities: Record<string, number>;
	threshold: number;
	action: DecisionAction;
	/** Wall time of the whole decision, retries included (≥ 0). */
	latencyMs: number;
	/** HTTP requests made (0 for a local validation failure). */
	attempts: number;
	/** `usage.cost` when returned. */
	cost?: number;
	/** Set iff outcome is "error". */
	error?: DecisionsErrorKind;
	/** Epoch ms when the decision settled. */
	at: number;
}

/** Two decimals, truncated (A2): a printed P never crosses its threshold (0.199 prints `0.19`). */
export function formatP(p: number): string {
	return (Math.floor(p * 100 + 1e-9) / 100).toFixed(2);
}
