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

function normalizeItem(raw: unknown, index: number): Clarification | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const obj = raw as Record<string, unknown>;
	const question = normalizeQuestionText(obj.question);
	if (!question) return undefined;

	const options = normalizeOptions(obj.options);
	if (options.length < MIN_OPTIONS) return undefined;

	const wanted = asString(obj.default).toLowerCase();
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

/** The verified `{answer, source}` of an item's knowledge object, or undefined when missing, invalid, or citing a document not read. */
function knowledgeClaim(raw: unknown, docs: ReadonlySet<string>): { answer: string; source: string } | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const obj = raw as Record<string, unknown>;
	const answer = asString(obj.answer).replace(/\s+/g, " ");
	if (!answer || answer.length > MAX_KNOWLEDGE_ANSWER_CHARS) return undefined;
	const source = asString(obj.source);
	if (!source || !docs.has(source)) return undefined;
	return { answer, source };
}

function normalizeSettledItem(raw: unknown, index: number, docs: ReadonlySet<string>): Clarification | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const obj = raw as Record<string, unknown>;
	const claim = knowledgeClaim(obj.knowledge, docs);
	if (!claim) return undefined;
	const question = normalizeQuestionText(obj.question);
	if (!question) return undefined;

	const options = normalizeOptions(obj.options);
	const wanted = asString(obj.default).toLowerCase();
	const match = wanted ? options.find((option) => option.label.toLowerCase() === wanted) : undefined;

	const settled: Clarification = {
		id: `k${index + 1}`,
		question,
		header: normalizeHeader(obj.header, "KB"),
		why: asString(obj.why).replace(/\s+/g, " "),
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
 * knowledge-base document settled (ids k1.., at most MAX_SETTLED). An item is settled only when its `knowledge`
 * object has a non-empty answer and cites one of `knowledgeDocs`; otherwise it is an ordinary open question.
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
		const known = docs.size > 0 ? normalizeSettledItem(item, settled.length, docs) : undefined;
		if (known && settled.length >= MAX_SETTLED) continue;
		const clarification = known ?? (open.length < max ? normalizeItem(item, open.length) : undefined);
		if (!clarification) continue;
		const key = normalizeQuestion(clarification.question);
		if (!key || seen.has(key)) continue;
		seen.add(key);
		(known ? settled : open).push(clarification);
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
