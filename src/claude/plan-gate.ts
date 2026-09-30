// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * DP-PLAN: the one plan gate every host path shares. runPromptSubmit consults it once, after every deterministic
 * rule (host gates, planningTarget, decideUplift) left the prompt to plan and before anything is announced or run.
 * Jev only ever turns a plan into a skip; any failure plans exactly as without it.
 */
import type { Decisions } from "../decisions/gate.ts";
import { buildPlanState, lastAssistantTurn } from "../decisions/questions.ts";
import type { DecisionRecord } from "../decisions/types.ts";
import { stripPrefix } from "../uplift/detect.ts";
import { grokUserQuery, parseSlashCommand, type SkillInvocation } from "../uplift/skill.ts";

/** Skip reason of a Jev plan skip, everywhere a skip reason is reported. */
export const JEV_PLAN_SKIP = "jev-skip";

export interface PlanGateInput {
	/** Raw prompt as received by runPromptSubmit (input.prompt ?? ""): its typed text (inside Grok's `<user_query>`) decides the bypass. */
	prompt: string;
	/** decideUplift's uplift text (prefix stripped): becomes state.message. */
	text: string;
	skill?: SkillInvocation;
	/** deps.conversation?.(transcript_path) ?? "" — the uplift's own recent-conversation source. */
	history: string;
}

export type PlanGateVerdict = { plan: true; record?: DecisionRecord } | { plan: false; p: number; record: DecisionRecord };

/**
 * Skill invocations (every `/gsd-*` included, D9), a typed slash command, `uplift:` and an inactive point plan without
 * a request. The typed text is what the user typed: inside Grok's `<user_query>` wrapper, else the raw prompt. Otherwise
 * one `plan` decision: P < planSkipBelow skips; P at or above it, or any failure, plans and keeps the record.
 * Rejects only with an AbortError (caller abort).
 */
export async function planGate(input: PlanGateInput, decisions: Decisions, signal?: AbortSignal): Promise<PlanGateVerdict> {
	if (input.skill) return { plan: true };
	const typed = grokUserQuery(input.prompt) ?? input.prompt;
	if (parseSlashCommand(typed) || stripPrefix(typed).force) return { plan: true };
	if (!decisions.active("plan")) return { plan: true };
	const threshold = decisions.config.planSkipBelow;
	const outcome = await decisions.run(
		"plan",
		buildPlanState({ message: input.text, recentConversation: lastAssistantTurn(input.history) }),
		{ signal, threshold, action: (p) => (p < threshold ? "skip-plan" : "plan") },
	);
	if (outcome.status === "inactive") return { plan: true };
	if (outcome.status === "ok" && outcome.p < threshold) return { plan: false, p: outcome.p, record: outcome.record };
	return { plan: true, record: outcome.record };
}
