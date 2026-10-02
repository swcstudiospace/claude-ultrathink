// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * The six Jev questions (the first four verbatim as probed, brief §2) and the pure builders of each point's minimal state.
 * Every state field is read by its question; nothing else (no GSD/git signals, no diff stat) is ever sent.
 */
import type { DecisionPoint, NoulQuestion } from "./types.ts";

export const QUESTION_KEYS: { readonly [P in DecisionPoint]: string } = {
	plan: "plan_worthy",
	ship: "complete",
	knowledge: "supported",
	blocking: "risky",
	teachable: "teachable",
	skillworthy: "skillworthy",
};

/** Brief §2 texts, verbatim (instructions, criteria.true, criteria.false), type "noul". */
export const QUESTIONS: { readonly [P in DecisionPoint]: NoulQuestion } = {
	plan: {
		type: "noul",
		instructions:
			"Does `message`, read together with `recent_conversation`, ask the coding agent to start new engineering work that takes several steps, files or decisions, so that writing a plan first would help?",
		criteria: {
			true: "The message asks for new work such as building a feature, fixing or investigating a bug, refactoring, migrating, or researching and writing up a design, or it approves a new multi-step proposal that the agent made in `recent_conversation`.",
			false: "The message acknowledges, thanks or greets; tells the agent to keep going with work already under way; asks a question that needs only an answer or an explanation; asks to show, run or repeat something; or asks for one small edit such as fixing a typo.",
		},
	},
	ship: {
		type: "noul",
		instructions:
			"Does the change in `patch` fully deliver the work that `request` asks for, meeting every item in `acceptance_criteria`, with no part left missing, stubbed or marked TODO?",
		criteria: {
			true: "Every requirement in `request` and every item in `acceptance_criteria` is implemented by real code in `patch`.",
			false: "At least one requirement is missing, only partly done, stubbed, left as a TODO or placeholder, or `patch` changes something unrelated to `request`.",
		},
	},
	knowledge: {
		type: "noul",
		instructions: "Is `answer` a correct answer to `question` according to `document`?",
		criteria: {
			true: "`document` contains information that directly supports `answer` as the answer to `question`.",
			false: "`document` does not cover `question`, contradicts `answer`, supports a different answer, or supports only part of `answer`.",
		},
	},
	blocking: {
		type: "noul",
		instructions:
			"If `default` turns out to be the wrong answer to `question`, would going ahead with it while doing `task` cause damage that is hard to undo?",
		criteria: {
			true: "Acting on a wrong `default` would lose or corrupt data, break callers of a public API, run a migration that cannot be reversed, or change the wrong system.",
			false: "Acting on a wrong `default` only produces code or settings that are easy to change in a later edit.",
		},
	},
	teachable: {
		type: "noul",
		instructions:
			"Is this candidate a reusable lesson that a future agent on this repository would otherwise have to rediscover?",
		criteria: {
			true: "The candidate states a specific pitfall, bug and its fix, convention, decision and its reason, or repeatable procedure about this repository, its tooling or its workflow, and a future agent could act on it.",
			false: "The candidate restates the task, summarizes a session, describes a one-off event, gives generic advice that holds for any project, or is too vague to act on.",
		},
	},
	skillworthy: {
		type: "noul",
		instructions: "Does this lesson describe a repeatable procedure or rule worth a standing skill?",
		criteria: {
			true: "The lesson gives steps or a rule that an agent would follow again and again on this repository, and its `occurrences` show it keeps coming up.",
			false: "The lesson records a one-time fix, a fact that is not a procedure or rule, or advice too narrow or too vague to be worth a skill.",
		},
	},
};

export const PLAN_MESSAGE_MAX = 4000;
export const PLAN_CONVERSATION_MAX = 2000;
export const SHIP_CRITERIA_MAX_ITEMS = 20;
export const SHIP_CRITERION_MAX_CHARS = 500;
export const SHIP_PATCH_MAX = 24_000;
export const KNOWLEDGE_DOCUMENT_MAX = 12_000;
export const BLOCKING_TASK_MAX = 4000;
export const LESSON_BODY_MAX = 800;
/** Same list as src/ship/signals.ts LOCKFILES. */
export const LOCKFILE_PATTERNS: readonly RegExp[] = [
	/\.lock$/,
	/\.lockb$/,
	/(^|\/)package-lock\.json$/,
	/(^|\/)pnpm-lock\.yaml$/,
];

// Type aliases, not interfaces: an object type alias is assignable to the wire's
// `Record<string, unknown>` state (interfaces carry no implicit index signature).
export type PlanDecisionState = {
	message: string;
	recent_conversation: string;
};
export type ShipDecisionState = {
	request: string;
	acceptance_criteria: string[];
	patch: string;
};
export type KnowledgeDecisionState = {
	question: string;
	answer: string;
	document: string;
};
export type BlockingDecisionState = {
	task: string;
	question: string;
	default: string;
};
export type TeachableDecisionState = {
	name: string;
	description: string;
	body: string;
	kind: string;
};
export type SkillworthyDecisionState = TeachableDecisionState & {
	occurrences: number;
};
export interface DecisionStates {
	plan: PlanDecisionState;
	ship: ShipDecisionState;
	knowledge: KnowledgeDecisionState;
	blocking: BlockingDecisionState;
	teachable: TeachableDecisionState;
	skillworthy: SkillworthyDecisionState;
}

/** The message head and the conversation tail (the proposal a "go ahead" answers is at the end). */
export function buildPlanState(input: { message: string; recentConversation: string }): PlanDecisionState {
	return {
		message: input.message.slice(0, PLAN_MESSAGE_MAX),
		recent_conversation: input.recentConversation.slice(-PLAN_CONVERSATION_MAX),
	};
}

const ASSISTANT = "Assistant: ";

/**
 * The last `Assistant: …` chunk of recentConversationFromTranscript() text (chunks joined by "\n\n"), up to the next
 * "\n\nUser: " or the end, trimmed; "" when there is none.
 */
export function lastAssistantTurn(history: string): string {
	const after = history.lastIndexOf(`\n\n${ASSISTANT}`);
	const start = after >= 0 ? after + 2 : history.startsWith(ASSISTANT) ? 0 : -1;
	if (start < 0) return "";
	const end = history.indexOf("\n\nUser: ", start);
	return history.slice(start, end < 0 ? undefined : end).trim();
}

const ENTITIES: ReadonlyArray<[RegExp, string]> = [
	[/&lt;/g, "<"],
	[/&gt;/g, ">"],
	[/&quot;/g, '"'],
	[/&apos;/g, "'"],
	[/&#39;/g, "'"],
	[/&amp;/g, "&"],
];

function itemText(raw: string): string {
	let text = raw.replace(/<[^>]*>/g, " ");
	for (const [pattern, value] of ENTITIES) text = text.replace(pattern, value);
	return text.replace(/\s+/g, " ").trim();
}

/** Items of the spec's first ACCEPTANCE_CRITERIA element: one per child element, else one per non-empty line. */
export function extractAcceptanceCriteria(specXml: string): string[] {
	const inner = /<ACCEPTANCE_CRITERIA\b[^>]*>([\s\S]*?)<\/ACCEPTANCE_CRITERIA\s*>/i.exec(specXml)?.[1];
	if (inner === undefined) return [];
	const children = [...inner.matchAll(/<([A-Za-z_][\w.-]*)\b[^>]*>([\s\S]*?)<\/\1\s*>/g)];
	const raw =
		children.length > 0
			? children.map((match) => match[2] ?? "")
			: inner.split("\n").map((line) => line.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, ""));
	return raw.map(itemText).filter((item) => item.length > 0);
}

/** `diff --git a/<a> b/<b>` → both paths, so a renamed lockfile is excluded too. */
function isLockfileSection(section: string): boolean {
	const header = /^diff --git a\/(.*?) b\/(.*)$/m.exec(section);
	if (!header) return false;
	return [header[1] ?? "", header[2] ?? ""].some((path) => LOCKFILE_PATTERNS.some((pattern) => pattern.test(path)));
}

/** The patch without lockfile sections (same exclusions as the judge's `git diff`). */
function withoutLockfiles(patch: string): string {
	const starts: number[] = [];
	for (let i = patch.indexOf("diff --git a/"); i >= 0; i = patch.indexOf("diff --git a/", i + 1)) {
		if (i === 0 || patch[i - 1] === "\n") starts.push(i);
	}
	if (starts.length === 0) return patch;
	let kept = patch.slice(0, starts[0]);
	starts.forEach((start, index) => {
		const section = patch.slice(start, starts[index + 1]);
		if (!isLockfileSection(section)) kept += section;
	});
	return kept;
}

export function buildShipState(input: {
	request: string;
	acceptanceCriteria: readonly string[];
	patch: string;
	patchTruncated?: boolean;
}): { state: ShipDecisionState; truncated: boolean } {
	const patch = withoutLockfiles(input.patch);
	const cut = patch.length > SHIP_PATCH_MAX;
	return {
		state: {
			request: input.request,
			acceptance_criteria: input.acceptanceCriteria
				.slice(0, SHIP_CRITERIA_MAX_ITEMS)
				.map((item) => item.slice(0, SHIP_CRITERION_MAX_CHARS)),
			patch: cut ? patch.slice(0, SHIP_PATCH_MAX) : patch,
		},
		truncated: input.patchTruncated === true || cut,
	};
}

/**
 * The text of `path`'s `### <path>` section in a knowledge digest, up to the next listed document's heading or the
 * end; trimmed. "" when the heading is missing.
 */
export function extractDigestDocument(digest: string, path: string, docs: readonly string[]): string {
	const heading = `\n\n### ${path}\n\n`;
	const at = digest.indexOf(heading);
	if (at < 0) return "";
	const start = at + heading.length;
	let end = digest.length;
	for (const other of docs) {
		if (other === path) continue;
		const next = digest.indexOf(`\n\n### ${other}\n\n`, start);
		if (next >= 0 && next < end) end = next;
	}
	return digest.slice(start, end).trim();
}

export function buildKnowledgeState(input: { question: string; answer: string; document: string }): KnowledgeDecisionState {
	return { question: input.question, answer: input.answer, document: input.document.slice(0, KNOWLEDGE_DOCUMENT_MAX) };
}

/** The default option as `<label>: <description>` (or `<label>`); falls back to the first option, then the bare label. */
export function formatDefaultOption(
	defaultLabel: string | undefined,
	options: readonly { label: string; description?: string }[],
): string {
	const option = options.find((o) => o.label === defaultLabel) ?? options[0];
	if (!option) return defaultLabel ?? "";
	return option.description ? `${option.label}: ${option.description}` : option.label;
}

export function buildBlockingState(input: { task: string; question: string; defaultText: string }): BlockingDecisionState {
	return { task: input.task.slice(0, BLOCKING_TASK_MAX), question: input.question, default: input.defaultText };
}

/** Name, description, the first 800 characters of the body and the kind; no ids, paths or project names. */
export function buildTeachableState(input: { name: string; description: string; body: string; kind: string }): TeachableDecisionState {
	return { name: input.name, description: input.description, body: input.body.slice(0, LESSON_BODY_MAX), kind: input.kind };
}

export function buildSkillworthyState(input: {
	name: string;
	description: string;
	body: string;
	kind: string;
	occurrences: number;
}): SkillworthyDecisionState {
	return { ...buildTeachableState(input), occurrences: input.occurrences };
}
