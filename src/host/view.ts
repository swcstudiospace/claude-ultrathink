// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Display-only projection of a planned session for host UIs (Omp transcript
 * cards). Pure: the model never reads this, it reads the hook context.
 */
import type { SessionRecord } from "../claude/state.ts";
import { dependencyLevels } from "../think/graph.ts";

export interface PlanView {
	root: string;
	source: "llm" | "fallback";
	engine?: string;
	/** Name of the skill the user invoked, when the plan covers a skill invocation. */
	skill?: string;
	graphId?: string;
	goal?: string;
	elapsedMs: number;
	nodes: Array<{
		id: string;
		title: string;
		kind: string;
		wave: number;
		dependsOn: string[];
		conclusion?: string;
		issue?: { identifier: string; url: string };
		notionUrl?: string;
		steps: Array<{ step: number; title: string; identifier?: string; url?: string }>;
	}>;
	waves: string[][];
	clarifications: Array<{ id: string; question: string; blocking: boolean; answer?: string; recommended?: string }>;
	tracking?: {
		status: "complete" | "partial" | "failed";
		notionTaskUrl?: string;
		errors: string[];
		issues: number;
		subIssues: number;
	};
}

const NODE_PREFIX = /^\[[^\]]*\]\s*/;

export function buildPlanView(record: SessionRecord, elapsedMs: number): PlanView {
	const { graph, plan, tracking } = record;
	const levels = graph ? dependencyLevels(graph.nodes) : [];
	const waveOf = new Map<string, number>();
	levels.forEach((level, index) => {
		for (const node of level) waveOf.set(node.id, index);
	});
	const nodes: PlanView["nodes"] = (graph?.nodes ?? []).map((node) => {
		const issue = tracking?.linear.nodes[node.id];
		const steps = (plan?.subIssues ?? [])
			.filter((row) => row.nodeId === node.id)
			.map((row) => {
				const ref = tracking?.linear.steps[`${node.id}.${row.step}`];
				return {
					step: row.step,
					title: row.item.replace(NODE_PREFIX, ""),
					...(ref ? { identifier: ref.identifier, url: ref.url } : {}),
				};
			});
		const notionUrl = tracking?.notion.nodes[node.id];
		return {
			id: node.id,
			title: node.title,
			kind: node.kind,
			wave: waveOf.get(node.id) ?? 0,
			dependsOn: [...node.dependsOn],
			...(node.conclusion ? { conclusion: node.conclusion } : {}),
			...(issue ? { issue: { identifier: issue.identifier, url: issue.url } } : {}),
			...(notionUrl ? { notionUrl } : {}),
			steps,
		};
	});
	const clarifications = (record.clarifications ?? []).map((c) => {
		const recommended = c.options.find((o) => o.label === c.default)?.label ?? c.default;
		return {
			id: c.id,
			question: c.question,
			blocking: c.blocking,
			...(c.answer ? { answer: c.answer } : {}),
			...(recommended ? { recommended } : {}),
		};
	});
	return {
		root: record.result.root,
		source: record.result.source,
		...(record.engine ? { engine: record.engine } : {}),
		...(record.skill ? { skill: record.skill.name } : {}),
		...(plan?.graphId ? { graphId: plan.graphId } : {}),
		...(graph?.goal ? { goal: graph.goal } : {}),
		elapsedMs,
		nodes,
		waves: levels.map((level) => level.map((node) => node.id)),
		clarifications,
		...(tracking
			? {
					tracking: {
						status: tracking.status,
						...(tracking.notion.taskUrl ? { notionTaskUrl: tracking.notion.taskUrl } : {}),
						errors: [...tracking.errors],
						issues: Object.keys(tracking.linear.nodes).length,
						subIssues: Object.keys(tracking.linear.steps).length,
					},
				}
			: {}),
	};
}
