// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import type { SessionRecord } from "../../../src/claude/state.ts";
import type { Clarification } from "../../../src/hitl/types.ts";
import { dependencyLevels, isFallbackGraph, topoSort } from "../../../src/think/graph.ts";
import type { ThoughtNode } from "../../../src/think/types.ts";
import { buildGraphView, fenced, renderGraphBlock } from "./graph-view.ts";

export interface ChatQuestion {
	question: string;
	default?: string;
	blocking?: boolean;
}

export interface RenderOptions {
	detail: "brief" | "full";
	maxChars: number;
}

export interface RenderedPlan {
	text: string;
	truncated: boolean;
	questions: ChatQuestion[];
}

/** Default size caps for each detail level, in characters. */
export const DEFAULT_MAX_CHARS = { brief: 40_000, full: 80_000 } as const;

const INDENT = "    ";
const CLOSING =
	"Ask the user the clarifying questions that matter, state the defaults you assume for the rest, and carry out the plan.";
const CLOSING_DIAGRAM = " Show the wave tree first.";
const TRUNCATION_NOTE =
	"[This plan was shortened to fit the size limit; later parts were left out. Ask the user for anything you still need.]";

const ORIGINAL_RE = /<ORIGINAL\b[^>]*>[\s\S]*?<\/ORIGINAL>/gi;
const GRAPH_RE = /<GRAPH_OF_THOUGHT\b[\s\S]*?<\/GRAPH_OF_THOUGHT>/gi;
const CLARIFICATIONS_RE = /<CLARIFICATIONS\b[\s\S]*?<\/CLARIFICATIONS>/gi;
// Tracker rows (Linear and Notion links) added to a tracked session's spec; a chat has no use for them.
const TRACKER_BLOCK_RE = /<(ISSUES|TRACKING|LINKED_ISSUES)\b[\s\S]*?<\/\1\s*>/gi;
const TRACKER_ATTR_RE = /\s+(?:notionTaskUrl|notionUrl|issueUrl|linearUrl)="[^"]*"/gi;
const TRACKER_URL_RE = /https?:\/\/(?:[\w-]+\.)*(?:notion\.(?:so|com|site)|linear\.app)(?:[/?#][^\s"'<>)\]]*)?/gi;

/** Share of maxChars the specification may take when the whole plan would not fit. */
const SPEC_SHARE = 0.55;
const SPEC_MARKER = "[specification shortened]";

interface Unit {
	text: string;
	optional: boolean;
	/** The Graph of Thought x Chain of Thought block; the closing sentence refers to it only when it is kept. */
	diagram?: true;
}

/** One line, bounded: ids, titles and labels come from model output and must not open a new section. */
function oneLine(value: string | undefined, max = 200): string {
	const flat = (value ?? "").replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Indents every line so model text can never start a line that reads like a section heading. */
function indent(text: string, prefix = INDENT): string {
	return text
		.trim()
		.split(/\r?\n/)
		.map((line) => (line.length > 0 ? `${prefix}${line}` : ""))
		.join("\n");
}

/** The uplifted specification without the original prompt (shown separately) and the injected graph and question blocks. */
export function specificationText(xml: string): string {
	let body = xml
		.replace(ORIGINAL_RE, "")
		.replace(GRAPH_RE, "")
		.replace(CLARIFICATIONS_RE, "")
		.replace(TRACKER_BLOCK_RE, "")
		.replace(TRACKER_ATTR_RE, "")
		.replace(TRACKER_URL_RE, "")
		.trim();
	const open = body.match(/^<([A-Za-z_][\w.-]*)\b[^>]*>/);
	if (open && !open[0].endsWith("/>")) {
		const close = new RegExp(`</${open[1]!}\\s*>\\s*$`, "i");
		if (close.test(body)) body = body.slice(open[0].length).replace(close, "");
	}
	return body.replace(/\n{3,}/g, "\n\n").trim();
}

/** Cuts the specification at a line (else tag) boundary so that the result, marker included, is at most `cap` characters. */
function shortenSpecification(spec: string, cap: number): string {
	const room = Math.max(0, cap - SPEC_MARKER.length - 1);
	const head = spec.slice(0, room);
	let cut = head.lastIndexOf("\n");
	if (cut < 0) cut = head.lastIndexOf(">") + 1;
	const kept = cut > 0 ? head.slice(0, cut).trimEnd() : "";
	return kept ? `${kept}\n${SPEC_MARKER}` : SPEC_MARKER;
}

function nodeText(node: ThoughtNode, detail: RenderOptions["detail"]): string {
	const lines = [`- ${oneLine(node.id, 40)} ${oneLine(node.title)} [${oneLine(node.kind, 40)}]`];
	lines.push(`${INDENT}Question: ${oneLine(node.question, 2_000)}`);
	const conclusion = node.conclusion?.trim();
	if (conclusion) lines.push(`${INDENT}Conclusion:`, indent(conclusion, INDENT.repeat(2)));
	const thinking = node.thinking?.trim();
	if (detail === "full" && thinking && thinking !== conclusion) {
		lines.push(`${INDENT}Chain of Thought:`, indent(thinking, INDENT.repeat(2)));
	}
	return lines.join("\n");
}

function graphUnits(record: SessionRecord, detail: RenderOptions["detail"]): Unit[] {
	const graph = record.graph;
	if (!graph || graph.nodes.length === 0 || isFallbackGraph(graph)) return [];
	const waves = dependencyLevels(topoSort(graph.nodes));
	return waves.map((wave, index) => {
		const label = `Wave ${index + 1}${wave.length > 1 ? " (independent of each other)" : ""}`;
		const body = `${label}\n${wave.map((node) => nodeText(node, detail)).join("\n")}`;
		const head = index === 0 ? `## Graph of Thought\nGoal: ${oneLine(graph.goal, 2_000)}\n\n` : "";
		return { text: `${head}${body}`, optional: true };
	});
}

function questionText(item: Clarification, detail: RenderOptions["detail"], index: number): string {
	const flags = item.blocking ? " (blocking)" : "";
	const lines = [`${index}. ${oneLine(item.question, 2_000)}${flags}`];
	const fallback = oneLine(item.default, 500);
	if (fallback) lines.push(`${INDENT}Default: ${fallback}`);
	if (detail === "full") {
		const why = oneLine(item.why, 1_000);
		if (why) lines.push(`${INDENT}Why: ${why}`);
		const options = item.options.map((option) => oneLine(option.label, 200)).filter((label) => label.length > 0);
		if (options.length > 0) lines.push(`${INDENT}Options: ${options.join(" | ")}`);
	}
	return lines.join("\n");
}

function questionsUnit(list: Clarification[], detail: RenderOptions["detail"]): Unit | null {
	const open = list.filter((item) => item.answer === undefined);
	const settled = list.filter((item) => item.answer !== undefined);
	if (open.length === 0 && settled.length === 0) return null;
	const lines = ["## Clarifying questions"];
	if (open.length > 0) lines.push(open.map((item, i) => questionText(item, detail, i + 1)).join("\n"));
	if (settled.length > 0) {
		lines.push(
			"Already settled:",
			settled.map((item) => `- ${oneLine(item.question, 2_000)}\n${INDENT}Answer: ${oneLine(item.answer, 2_000)}`).join("\n"),
		);
	}
	return { text: lines.join("\n"), optional: false };
}

function extractQuestions(list: Clarification[]): ChatQuestion[] {
	const out: ChatQuestion[] = [];
	for (const item of list) {
		if (item.answer !== undefined) continue;
		const question: ChatQuestion = { question: oneLine(item.question, 2_000) };
		const fallback = oneLine(item.default, 500);
		if (fallback) question.default = fallback;
		question.blocking = item.blocking === true;
		out.push(question);
	}
	return out;
}

/**
 * Renders a finished session as plain text for a chat model. Sections are only ever cut whole: required parts
 * (request, specification, questions) are kept ahead of Graph of Thought waves, and the result never exceeds maxChars.
 */
export function renderChatPlan(record: SessionRecord, options: RenderOptions): RenderedPlan {
	const max = Math.max(0, Math.floor(options.maxChars));
	const clarifications = Array.isArray(record.clarifications) ? record.clarifications : [];
	const graph = record.graph;
	const nodeCount = graph && !isFallbackGraph(graph) ? graph.nodes.length : 0;

	const headerLines = [
		"# Ultrathink plan",
		`Session: ${oneLine(record.sessionId, 120)}`,
		`Engine: ${oneLine(record.engine, 120) || "unknown"}`,
		`Graph of Thought nodes: ${nodeCount}`,
	];
	if (record.degraded && record.degraded.length > 0) {
		headerLines.push(`Stages that used boilerplate instead of model output: ${record.degraded.map((s) => oneLine(s, 60)).join(", ")}`);
	}

	const original = record.result.original;
	const spec = specificationText(record.result.xml);
	const view = buildGraphView(record);
	// First among the optional units, so the request, specification and questions keep priority when the cap bites.
	const diagram: Unit[] = view ? [{ text: renderGraphBlock(view), optional: true, diagram: true }] : [];
	const build = (specBody: string): Unit[] => {
		const units: Unit[] = [
			{ text: headerLines.join("\n"), optional: false },
			...diagram,
			{ text: `## Request\n${fenced(original)}`, optional: false },
			{ text: `## Specification\n${specBody ? fenced(specBody, "xml") : "(none)"}`, optional: false },
			...graphUnits(record, options.detail),
		];
		const questions = questionsUnit(clarifications, options.detail);
		if (questions) units.push(questions);
		return units;
	};
	const questionList = extractQuestions(clarifications);
	const compose = (units: readonly Unit[], keep: readonly boolean[], note: boolean): string => {
		const kept = units.filter((_, i) => keep[i]);
		const parts = kept.map((unit) => unit.text);
		if (note) parts.push(TRUNCATION_NOTE);
		parts.push(kept.some((unit) => unit.diagram) ? `${CLOSING}${CLOSING_DIAGRAM}` : CLOSING);
		return parts.join("\n\n");
	};

	let units = build(spec);
	let keep = units.map(() => true);
	const whole = compose(units, keep, false);
	if (whole.length <= max) return { text: whole, truncated: false, questions: questionList };

	// Over budget: the specification gives way first so the Graph of Thought conclusions keep their share.
	const specCap = Math.floor(max * SPEC_SHARE);
	if (spec.length > specCap) {
		units = build(shortenSpecification(spec, specCap));
		keep = units.map(() => true);
		const capped = compose(units, keep, false);
		if (capped.length <= max) return { text: capped, truncated: true, questions: questionList };
	}

	// Keep required units in order while they fit, then add optional ones in order until the first that does not.
	keep = units.map(() => false);
	for (const requiredPass of [true, false]) {
		for (const [i, unit] of units.entries()) {
			if (unit.optional === requiredPass) continue;
			keep[i] = true;
			if (compose(units, keep, true).length > max) {
				keep[i] = false;
				break;
			}
		}
		if (requiredPass && units.some((unit, i) => !unit.optional && !keep[i])) break;
	}
	let text = compose(units, keep, true);
	if (text.length > max) text = text.slice(0, max);
	return { text, truncated: true, questions: questionList };
}
