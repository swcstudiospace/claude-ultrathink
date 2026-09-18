import { randomUUID } from "node:crypto";
import type { Clarification } from "../hitl/types.ts";
import type { ThoughtGraph, ThoughtNode } from "../think/types.ts";
import type { UpliftResult } from "../types.ts";
import type { HitlPlan, IssueRow, LinearIssuePlan, LinearSubIssuePlan, SubIssueRow, TaskRow, TrackPlan } from "./types.ts";

const MAX_TITLE_CHARS = 120;

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

function cotThought(node: ThoughtNode): string {
	const thinking = (node.thinking ?? "").trim();
	const conclusion = nodeConclusion(node);
	const parts = [thinking && `THINKING: ${thinking}`, conclusion && `CONCLUSION: ${conclusion}`].filter(
		(part): part is string => Boolean(part),
	);
	return parts.length > 0 ? parts.join("\n") : node.question;
}

function subIssueRow(graphId: string, node: ThoughtNode): SubIssueRow {
	return { graphId, nodeId: node.id, item: `[${node.id}] Chain of Thought`, step: 1, thought: cotThought(node) };
}

function linearIssue(node: ThoughtNode): LinearIssuePlan {
	return { nodeId: node.id, title: node.title, description: nodeConclusion(node) || node.question };
}

function linearSubIssue(node: ThoughtNode): LinearSubIssuePlan {
	return { nodeId: node.id, title: `${node.title} — Chain of Thought`, description: cotThought(node) };
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
		upliftedPrompt: input.uplift.xml,
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
