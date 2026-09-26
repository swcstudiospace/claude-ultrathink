// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { extractJsonObject } from "../think/graph.ts";
import type { ThoughtGraph } from "../think/types.ts";
import type { UpliftResult } from "../types.ts";
import { clarifySystemPrompt } from "./prompts.ts";
import {
	type Clarification,
	type ClarificationOption,
	MAX_HEADER_CHARS,
	MAX_QUESTIONS,
	MAX_SETTLED,
} from "./types.ts";

/** Same shape as `Completer` in src/grok/complete.ts and `ClaudeCompleter` in src/claude/complete.ts. */
export type Completer = (system: string, user: string, signal?: AbortSignal) => Promise<string>;

export interface RunClarifyOptions {
	uplift: UpliftResult;
	graph?: ThoughtGraph;
	conversation?: string;
	answered?: Clarification[];
	complete: Completer;
	signal?: AbortSignal;
	maxQuestions?: number;
	onProgress?: (message: string) => void;
	/** Greptile knowledge-base digest (untrusted evidence) and the document paths it holds; questions it settles are recorded, not asked. */
	knowledge?: { digest: string; docs: string[] };
}

const MIN_OPTIONS = 2;
const MAX_OPTIONS = 4;
const MAX_KNOWLEDGE_ANSWER_CHARS = 500;
/** Longest claimed answer shown as the "As stated" option description of a rejected knowledge claim. */
const MAX_CLAIMED_DESCRIPTION_CHARS = 200;

function isAbortError(error: unknown): boolean {
	if (error instanceof Error) return error.name === "AbortError";
	if (!error || typeof error !== "object" || !("name" in error)) return false;
	return error.name === "AbortError";
}

function asString(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

export function normalizeQuestion(question: string): string {
	return question
		.toLowerCase()
		.replace(/\s+/g, " ")
		.trim()
		.replace(/[?.!:;,\s]+$/, "");
}

function normalizeOption(raw: unknown): ClarificationOption | undefined {
	if (typeof raw === "string") {
		const label = raw.trim();
		return label ? { label } : undefined;
	}
	if (!raw || typeof raw !== "object") return undefined;
	const obj = raw as Record<string, unknown>;
	const label = asString(obj.label) || asString(obj.name) || asString(obj.value);
	if (!label) return undefined;
	const description = asString(obj.description);
	return description ? { label, description } : { label };
}

function normalizeOptions(raw: unknown): ClarificationOption[] {
	if (!Array.isArray(raw)) return [];
	const seen = new Set<string>();
	const options: ClarificationOption[] = [];
	for (const item of raw) {
		const option = normalizeOption(item);
		if (!option) continue;
		const key = option.label.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		options.push(option);
		if (options.length === MAX_OPTIONS) break;
	}
	return options;
}

function normalizeHeader(raw: unknown, fallback: string): string {
	const header = asString(raw).replace(/\s+/g, " ").slice(0, MAX_HEADER_CHARS).trim();
	return header || fallback;
}

function normalizeQuestionText(raw: unknown): string {
	const question = asString(raw).replace(/\s+/g, " ");
	if (!question) return "";
	return /[?]$/.test(question) ? question : `${question.replace(/[.!:;,]+$/, "")}?`;
}

/**
 * Options for a question whose knowledge claim was rejected and that came without two options of its own:
 * accept the claimed answer ("As stated") or give another. An empty claim offers the default instead.
 */
function claimedOptions(claimed: string): ClarificationOption[] {
	const first: ClarificationOption = claimed ? { label: "As stated", description: claimed } : { label: "Proceed with the default" };
	return [first, { label: "Something else" }];
}

/**
 * An open question (id `q{index+1}`), or undefined when it has no question text or fewer than two options.
 * `claimed` is the collapsed answer of a rejected knowledge claim: when given, an item short of two options
 * is asked with {@link claimedOptions} instead of being dropped.
 */
function normalizeItem(raw: unknown, index: number, claimed?: string): Clarification | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const obj = raw as Record<string, unknown>;
	const question = normalizeQuestionText(obj.question);
	if (!question) return undefined;

	let options = normalizeOptions(obj.options);
	let wanted = asString(obj.default).toLowerCase();
	if (options.length < MIN_OPTIONS) {
		if (claimed === undefined) return undefined;
		options = claimedOptions(claimed);
		wanted = "";
	}

	const match = wanted ? options.find((option) => option.label.toLowerCase() === wanted) : undefined;
	const fallbackDefault = options[0]!.label;

	return {
		id: `q${index + 1}`,
		question,
		header: normalizeHeader(obj.header, `Q${index + 1}`),
		why: asString(obj.why).replace(/\s+/g, " "),
		options,
		default: match?.label ?? fallbackDefault,
		blocking: obj.blocking === true,
	};
}

/** The verified `{answer, source}` of an item's knowledge object, or undefined when invalid or citing a document not read. */
function knowledgeClaim(knowledge: Record<string, unknown>, docs: ReadonlySet<string>): { answer: string; source: string } | undefined {
	const answer = asString(knowledge.answer).replace(/\s+/g, " ");
	if (!answer || answer.length > MAX_KNOWLEDGE_ANSWER_CHARS) return undefined;
	const source = asString(knowledge.source);
	if (!source || !docs.has(source)) return undefined;
	return { answer, source };
}

function normalizeSettledItem(raw: Record<string, unknown>, index: number, claim: { answer: string; source: string }): Clarification | undefined {
	const question = normalizeQuestionText(raw.question);
	if (!question) return undefined;

	const options = normalizeOptions(raw.options);
	const wanted = asString(raw.default).toLowerCase();
	const match = wanted ? options.find((option) => option.label.toLowerCase() === wanted) : undefined;

	const settled: Clarification = {
		id: `k${index + 1}`,
		question,
		header: normalizeHeader(raw.header, "KB"),
		why: asString(raw.why).replace(/\s+/g, " "),
		options,
		blocking: false,
		answer: claim.answer,
		source: "knowledge",
		evidence: claim.source,
	};
	if (match) settled.default = match.label;
	return settled;
}

/**
 * Validate the clarifier's JSON: open questions (ids q1.., at most `maxQuestions`) followed by questions a
 * knowledge-base document settled (ids k1.., at most MAX_SETTLED). With `knowledgeDocs`, an item is settled only
 * when its `knowledge` object has a non-empty answer of at most 500 chars citing one of `knowledgeDocs` and fewer
 * than MAX_SETTLED items are settled. A rejected claim is never dropped: it becomes an open question (subject to
 * `maxQuestions`) with its own options, or, short of two, "As stated" (the claimed answer) / "Something else".
 * Items without a knowledge object, and every item without `knowledgeDocs`, need two options or are dropped.
 */
export function normalizeClarifications(raw: unknown, maxQuestions: number, knowledgeDocs?: string[]): Clarification[] {
	const max = Math.max(0, Math.floor(Number.isFinite(maxQuestions) ? maxQuestions : MAX_QUESTIONS));
	let items: unknown[] = [];
	if (Array.isArray(raw)) items = raw;
	else if (raw && typeof raw === "object" && "questions" in raw && Array.isArray(raw.questions)) {
		items = raw.questions;
	}
	const docs = new Set((knowledgeDocs ?? []).map((path) => path.trim()).filter(Boolean));

	const seen = new Set<string>();
	const open: Clarification[] = [];
	const settled: Clarification[] = [];
	for (const item of items) {
		if (open.length >= max && (docs.size === 0 || settled.length >= MAX_SETTLED)) break;
		const obj = docs.size > 0 && item && typeof item === "object" ? (item as Record<string, unknown>) : undefined;
		const knowledge = obj?.knowledge && typeof obj.knowledge === "object" ? (obj.knowledge as Record<string, unknown>) : undefined;
		const claim = knowledge && settled.length < MAX_SETTLED ? knowledgeClaim(knowledge, docs) : undefined;
		let clarification: Clarification | undefined;
		if (obj && claim) clarification = normalizeSettledItem(obj, settled.length, claim);
		else if (open.length < max) {
			const claimed = knowledge ? asString(knowledge.answer).replace(/\s+/g, " ").slice(0, MAX_CLAIMED_DESCRIPTION_CHARS).trim() : undefined;
			clarification = normalizeItem(item, open.length, claimed);
		}
		if (!clarification) continue;
		const key = normalizeQuestion(clarification.question);
		if (!key || seen.has(key)) continue;
		seen.add(key);
		(claim ? settled : open).push(clarification);
	}
	return [...open, ...settled];
}

function graphConclusions(graph: ThoughtGraph): string {
	return graph.nodes
		.filter((node) => (node.conclusion ?? "").trim())
		.map((node) => `[${node.id}] ${node.title}\n${(node.conclusion ?? "").trim()}`)
		.join("\n\n");
}

/** The knowledge to use: only when a non-empty digest is given. */
function activeKnowledge(opts: RunClarifyOptions): { digest: string; docs: string[] } | undefined {
	const digest = opts.knowledge?.digest.trim() ?? "";
	return digest ? { digest, docs: opts.knowledge!.docs } : undefined;
}

export function clarifyUserPayload(opts: RunClarifyOptions, maxQuestions: number): string {
	const parts = ["<spec>", opts.uplift.xml.trim(), "</spec>"];

	const conclusions = opts.graph ? graphConclusions(opts.graph) : "";
	if (conclusions) parts.push("", "<graph_conclusions>", conclusions, "</graph_conclusions>");

	const knowledge = activeKnowledge(opts);
	if (knowledge) parts.push("", "<knowledge_base>", knowledge.digest, "</knowledge_base>");

	const conversation = opts.conversation?.trim() ?? "";
	if (conversation) parts.push("", "<conversation>", conversation, "</conversation>");

	const answered = (opts.answered ?? []).filter((item) => (item.answer ?? "").trim());
	if (answered.length > 0) {
		parts.push(
			"",
			"<answered>",
			...answered.map((item) => `${item.question} → ${item.answer!.trim()}`),
			"</answered>",
		);
	}

	parts.push("", `<max_questions>${maxQuestions}</max_questions>`);
	return parts.join("\n");
}

/** Fail-open: returns [] on any failure except an abort, which is rethrown. */
export async function runClarify(opts: RunClarifyOptions): Promise<Clarification[]> {
	const max = Math.max(0, Math.floor(opts.maxQuestions ?? MAX_QUESTIONS));
	if (max === 0) return [];
	const knowledge = activeKnowledge(opts);
	try {
		opts.onProgress?.("Clarifications…");
		const system = clarifySystemPrompt(max, knowledge ? { knowledge: true } : {});
		const text = await opts.complete(system, clarifyUserPayload(opts, max), opts.signal);
		const parsed = extractJsonObject(text);
		if (!parsed || typeof parsed !== "object") throw new Error("unparsable JSON");
		const list = normalizeClarifications(parsed, max, knowledge?.docs);
		const settled = list.filter((item) => item.source === "knowledge").length;
		const settledBit = settled > 0 ? ` (+${settled} settled)` : "";
		opts.onProgress?.(`Clarifications → ${list.length - settled}${settledBit}`);
		return list;
	} catch (error) {
		if (isAbortError(error)) throw error;
		opts.onProgress?.(`clarify failed: ${error instanceof Error ? error.message : String(error)}`);
		return [];
	}
}
