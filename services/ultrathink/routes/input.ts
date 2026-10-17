// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

export const ROUTES = ["planning", "research", "build-plan"] as const;
export type Route = (typeof ROUTES)[number];

export type SanitizeResult =
	| { ok: true; text: string }
	| { ok: false; code: "empty" | "too_long" | "not_string" };

// C0 controls except TAB (U+0009) and LF (U+000A), DEL (U+007F), and C1 controls (U+0080-U+009F).
const DISALLOWED_CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

const PLANNING_TERMS = /\b(plan|planning|roadmap|scope|phases?|milestones?|break down)\b/i;
const RESEARCH_TERMS =
	/\b(research|compare|comparison|investigate|survey|benchmark|find out|what are the options)\b/i;
const BUILD_PLAN_TERMS = /\b(build|implement|scaffold|code|develop|ship)\b/i;

export function sanitizeInput(raw: unknown, maxChars: number): SanitizeResult {
	if (typeof raw !== "string") {
		return { ok: false, code: "not_string" };
	}
	const text = raw.replace(DISALLOWED_CONTROL_CHARS, "").trim();
	if (text.length === 0) {
		return { ok: false, code: "empty" };
	}
	if (text.length > maxChars) {
		return { ok: false, code: "too_long" };
	}
	return { ok: true, text };
}

export function selectRoute(text: string): { route: Route; reason: string } {
	if (PLANNING_TERMS.test(text)) {
		return { route: "planning", reason: "matched planning terms" };
	}
	if (RESEARCH_TERMS.test(text)) {
		return { route: "research", reason: "matched research terms" };
	}
	if (BUILD_PLAN_TERMS.test(text)) {
		return { route: "build-plan", reason: "matched build-plan terms" };
	}
	return { route: "planning", reason: "no route terms matched; defaulting to planning" };
}

export function parseRouteFlag(
	raw: unknown,
): { ok: true; route: Route | undefined } | { ok: false; code: "unknown_flag" | "invalid_value" } {
	if (raw === undefined || raw === "auto") {
		return { ok: true, route: undefined };
	}
	if (typeof raw === "string" && (ROUTES as readonly string[]).includes(raw)) {
		return { ok: true, route: raw as Route };
	}
	return { ok: false, code: "invalid_value" };
}
