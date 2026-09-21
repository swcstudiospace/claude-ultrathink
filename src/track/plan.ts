import { randomUUID } from "node:crypto";
import type { Clarification } from "../hitl/types.ts";
import type { ThoughtGraph, ThoughtNode } from "../think/types.ts";
import type { UpliftResult } from "../types.ts";
import type { HitlPlan, IssueRow, LinearIssuePlan, LinearSubIssuePlan, SubIssueRow, TaskRow, TrackPlan } from "./types.ts";

const MAX_TITLE_CHARS = 120;

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

/** Renders a node's rationale + conclusion as a plan artifact — plain prose, not a labeled reasoning-trace dump. */
function nodeDetail(node: ThoughtNode): string {
	const rationale = (node.thinking ?? "").trim();
	const conclusion = nodeConclusion(node);
	const parts = [rationale && `Rationale: ${rationale}`, conclusion && `Conclusion: ${conclusion}`].filter(
		(part): part is string => Boolean(part),
	);
	return parts.length > 0 ? parts.join("\n") : node.question;
}

function subIssueRow(graphId: string, node: ThoughtNode): SubIssueRow {
	return { graphId, nodeId: node.id, item: `[${node.id}] Node Detail`, step: 1, thought: nodeDetail(node) };
}

function linearIssue(node: ThoughtNode): LinearIssuePlan {
	return { nodeId: node.id, title: node.title, description: nodeConclusion(node) || node.question };
}

function linearSubIssue(node: ThoughtNode): LinearSubIssuePlan {
	return { nodeId: node.id, title: `${node.title} — Node Detail`, description: nodeDetail(node) };
}

export function buildTrackPlan(input: {
	uplift: UpliftResult;
	graph?: ThoughtGraph;
	clarifications: Clarification[];
	repo?: string;
	branch?: string;
	graphId?: string;
}): TrackPlan {
	const graphId = input.graphId ?? generateGraphId();
	const nodes = input.graph?.nodes ?? [];

	const task: TaskRow = {
		graphId,
		item: taskTitle(input.uplift.original),
		description: input.uplift.original.trim(),
		upliftedPrompt: truncateUpliftedPrompt(input.uplift.xml),
		agent: "claude-code",
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
		subIssues: nodes.map((node) => subIssueRow(graphId, node)),
		linearIssues: nodes.map(linearIssue),
		linearSubIssues: nodes.map(linearSubIssue),
		hitl,
	};
}
