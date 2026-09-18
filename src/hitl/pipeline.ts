import { extractJsonObject } from "../think/graph.ts";
import type { ThoughtGraph } from "../think/types.ts";
import type { UpliftResult } from "../types.ts";
import { clarifySystemPrompt } from "./prompts.ts";
import {
	type Clarification,
	type ClarificationOption,
	MAX_HEADER_CHARS,
	MAX_QUESTIONS,
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
}

const MIN_OPTIONS = 2;
const MAX_OPTIONS = 4;

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

function normalizeItem(raw: unknown, index: number): Clarification | undefined {
	if (!raw || typeof raw !== "object") return undefined;
	const obj = raw as Record<string, unknown>;
	let question = asString(obj.question).replace(/\s+/g, " ");
	if (!question) return undefined;
	if (!/[?]$/.test(question)) question = `${question.replace(/[.!:;,]+$/, "")}?`;

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

export function normalizeClarifications(raw: unknown, maxQuestions: number): Clarification[] {
	const max = Math.max(0, Math.floor(Number.isFinite(maxQuestions) ? maxQuestions : MAX_QUESTIONS));
	let items: unknown[] = [];
	if (Array.isArray(raw)) items = raw;
	else if (raw && typeof raw === "object" && "questions" in raw && Array.isArray(raw.questions)) {
		items = raw.questions;
	}

	const seen = new Set<string>();
	const list: Clarification[] = [];
	for (const item of items) {
		if (list.length >= max) break;
		const clarification = normalizeItem(item, list.length);
		if (!clarification) continue;
		const key = normalizeQuestion(clarification.question);
		if (!key || seen.has(key)) continue;
		seen.add(key);
		list.push(clarification);
	}
	return list;
}

function graphConclusions(graph: ThoughtGraph): string {
	return graph.nodes
		.filter((node) => (node.conclusion ?? "").trim())
		.map((node) => `[${node.id}] ${node.title}\n${(node.conclusion ?? "").trim()}`)
		.join("\n\n");
}

export function clarifyUserPayload(opts: RunClarifyOptions, maxQuestions: number): string {
	const parts = ["<spec>", opts.uplift.xml.trim(), "</spec>"];

	const conclusions = opts.graph ? graphConclusions(opts.graph) : "";
	if (conclusions) parts.push("", "<graph_conclusions>", conclusions, "</graph_conclusions>");

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
	try {
		opts.onProgress?.("Clarifications…");
		const text = await opts.complete(clarifySystemPrompt(max), clarifyUserPayload(opts, max), opts.signal);
		const parsed = extractJsonObject(text);
		if (!parsed || typeof parsed !== "object") throw new Error("unparsable JSON");
		const list = normalizeClarifications(parsed, max);
		opts.onProgress?.(`Clarifications → ${list.length}`);
		return list;
	} catch (error) {
		if (isAbortError(error)) throw error;
		opts.onProgress?.(`clarify failed: ${error instanceof Error ? error.message : String(error)}`);
		return [];
	}
}
