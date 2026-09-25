// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { randomUUID } from "node:crypto";
import type { Clarification } from "../hitl/types.ts";
import type { ThoughtGraph, ThoughtNode } from "../think/types.ts";
import type { UpliftResult } from "../types.ts";
import type { HitlPlan, IssueRow, LinearIssuePlan, LinearSubIssuePlan, SubIssueRow, TaskRow, TrackPlan } from "./types.ts";

const MAX_TITLE_CHARS = 120;
/** Step titles carry a snippet of the step text; the full text lives in the row's thought/description. */
const MAX_STEP_TITLE_CHARS = 72;

/** Notion's single rich-text property limit is ~2000 chars; leave headroom under it. */
export const MAX_UPLIFTED_PROMPT_CHARS = 1900;

const TRUNCATION_MARKER = "\n<!-- truncated — full spec in the session's .xml file -->";

/** Truncates the uplifted XML for the Notion `Uplifted Prompt` property; the full XML is always persisted to sessions/<id>.xml. */
function truncateUpliftedPrompt(xml: string): string {
	if (xml.length <= MAX_UPLIFTED_PROMPT_CHARS) return xml;
	const cut = MAX_UPLIFTED_PROMPT_CHARS - TRUNCATION_MARKER.length;
	return `${xml.slice(0, cut)}${TRUNCATION_MARKER}`;
}

export function generateGraphId(now: () => number = Date.now): string {
	return `ut-${now().toString(36)}-${randomUUID().slice(0, 8)}`;
}

function taskTitle(original: string): string {
	const trimmed = original.trim().replace(/\s+/g, " ");
	if (!trimmed) return "Untitled task";
	return trimmed.length > MAX_TITLE_CHARS ? `${trimmed.slice(0, MAX_TITLE_CHARS - 3)}...` : trimmed;
}

function nodeConclusion(node: ThoughtNode): string {
	return (node.conclusion ?? "").trim();
}

function issueRow(graphId: string, node: ThoughtNode): IssueRow {
	return {
		graphId,
		nodeId: node.id,
		item: `[${node.id}] ${node.title}`,
		thought: nodeConclusion(node) || node.question,
	};
}

/** A step marker at the start of a line: `3.`, `3)`, `**3.**`, `Step 3:`, `Step 3 -` — any number. */
const LINE_MARKER_RE = /^[ \t]*(?:\*\*)?(?:step\s+)?(\d{1,2})(?:[.):]|\s+[-–—])(?:\*\*)?[ \t]+/gim;
/** A step marker inside running text: `2.` or `2)` after whitespace. */
const INLINE_MARKER_RE = /(?:^|\s)(\d{1,2})[.)]\s+/g;

interface Marker {
	start: number;
	end: number;
}

function lineMarkers(text: string): Marker[] {
	return [...text.matchAll(LINE_MARKER_RE)].map((match) => {
		const leading = match[0].length - match[0].trimStart().length;
		return { start: match.index + leading, end: match.index + match[0].length };
	});
}

/** Inline markers must continue the sequence from 1, so "5-8", "v2." and nested lists that restart stay in their step. */
function sequentialInlineMarkers(text: string): Marker[] {
	const markers: Marker[] = [];
	let expected = 1;
	for (const match of text.matchAll(INLINE_MARKER_RE)) {
		if (Number(match[1]) !== expected) continue;
		const leading = match[0].length - match[0].trimStart().length;
		markers.push({ start: match.index + leading, end: match.index + match[0].length });
		expected++;
	}
	return markers;
}

/**
 * Splits a CoT rationale into its numbered steps. One-step-per-line lists (`1.`, `2)`, `**3.**`,
 * `Step 4:`) split on every line marker, even when the model skipped or repeated a number. A
 * rationale written inline (`1. … 2. … 3. …`) splits only on markers that continue the sequence
 * from 1. Unnumbered text is one step; empty text is none. A preamble before the first marker is
 * folded into the first step.
 */
export function splitRationaleSteps(rationale: string): string[] {
	const text = rationale.trim();
	if (!text) return [];

	const byLine = lineMarkers(text);
	const markers = byLine.length >= 2 ? byLine : sequentialInlineMarkers(text);
	if (markers.length === 0) return [text];

	const steps = markers.map((marker, index) => {
		const next = markers[index + 1];
		return text.slice(marker.end, next ? next.start : text.length).trim();
	});
	const preamble = text.slice(0, markers[0]!.start).trim();
	if (preamble) steps[0] = `${preamble} ${steps[0]}`.trim();
	return steps.filter(Boolean);
}

/**
 * The per-step texts tracked as Sub-Issues under a node's Issue. A node whose fill produced no
 * rationale (engine failure, empty completion) still gets one step so every Issue keeps a Sub-Issue.
 */
function nodeSteps(node: ThoughtNode): string[] {
	const steps = splitRationaleSteps(node.thinking ?? "");
	return steps.length > 0 ? steps : [nodeConclusion(node) || node.question];
}

function stepTitle(step: number, text: string): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	const snippet =
		oneLine.length > MAX_STEP_TITLE_CHARS ? `${oneLine.slice(0, MAX_STEP_TITLE_CHARS - 1).trimEnd()}…` : oneLine;
	return `Step ${step}: ${snippet}`;
}

/** The "Step n: …" sub-issue titles for a node, in step order. */
export function nodeStepTitles(node: ThoughtNode): string[] {
	return nodeSteps(node).map((text, index) => stepTitle(index + 1, text));
}

function subIssueRows(graphId: string, node: ThoughtNode): SubIssueRow[] {
	return nodeSteps(node).map((thought, index) => ({
		graphId,
		nodeId: node.id,
		item: `[${node.id}] ${stepTitle(index + 1, thought)}`,
		step: index + 1,
		thought,
	}));
}

function linearIssue(node: ThoughtNode): LinearIssuePlan {
	return { nodeId: node.id, title: node.title, description: nodeConclusion(node) || node.question };
}

function linearSubIssues(node: ThoughtNode): LinearSubIssuePlan[] {
	return nodeSteps(node).map((description, index) => ({
		nodeId: node.id,
		step: index + 1,
		title: `${node.title} — ${stepTitle(index + 1, description)}`,
		description,
	}));
}

export function buildTrackPlan(input: {
	uplift: UpliftResult;
	graph?: ThoughtGraph;
	clarifications: Clarification[];
	repo?: string;
	branch?: string;
	graphId?: string;
	agent?: string;
}): TrackPlan {
	const graphId = input.graphId ?? generateGraphId();
	const nodes = input.graph?.nodes ?? [];

	const task: TaskRow = {
		graphId,
		item: taskTitle(input.uplift.original),
		description: input.uplift.original.trim(),
		upliftedPrompt: truncateUpliftedPrompt(input.uplift.xml),
		agent: input.agent ?? "claude-code",
		status: "Planning",
		linearState: "Todo",
		repo: input.repo,
		branch: input.branch,
	};

	const hitl: HitlPlan = {
		blocking: input.clarifications.filter((c) => c.blocking && c.answer === undefined),
		nonBlocking: input.clarifications.filter((c) => !c.blocking && c.answer === undefined),
	};

	return {
		graphId,
		task,
		issues: nodes.map((node) => issueRow(graphId, node)),
		subIssues: nodes.flatMap((node) => subIssueRows(graphId, node)),
		linearIssues: nodes.map(linearIssue),
		linearSubIssues: nodes.flatMap(linearSubIssues),
		hitl,
	};
}
