// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Display-only projection of a planned session for host UIs (Omp transcript
 * cards), and of a model resolution record for every display surface. Pure:
 * the model never reads this, it reads the hook context.
 */
import type { SessionRecord } from "../claude/state.ts";
import { displayId, displayLabel, displayToken, OPAQUE_MODEL, OPAQUE_PROVIDER } from "../claude/output.ts";
import { dependencyLevels } from "../think/graph.ts";
import type { ModelResolution } from "./engine.ts";

export interface PlanView {
	root: string;
	source: "llm" | "fallback";
	/** Display label of the planning selection: the resolution record's safe label, else the recorded engine label. */
	engine?: string;
	/** The selection's safe record, projected for display (§9 path 3): engine request kept apart from model state. */
	modelResolution?: ModelResolution;
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

/** A JSON object: not null, not an array. */
function isFields(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Display projection of a model resolution record (§6, §9, D-11): only the allowlisted fields, the label through
 * `displayLabel`, ids through `displayId` and fixed-vocabulary values as plain tokens. A record read back from disk or
 * carried between processes brings no extra or unsafe content into a view, status line or summary. Anything that is not
 * a version 1.0.0 record projects to undefined, so a malformed saved record shows nothing instead of failing the surface.
 */
export function projectResolution(value: unknown): ModelResolution | undefined {
	if (!isFields(value) || value.version !== "1.0.0" || !isFields(value.engineSelection)) return undefined;
	const selection = value.engineSelection;
	const state = displayToken(value.state);
	const host = displayToken(value.host);
	const source = displayToken(value.source);
	const reason = displayToken(value.reason);
	const engine = displayToken(selection.engine);
	const requestSource = displayToken(selection.source);
	if (!state || !host || !source || !reason || !engine || !requestSource) return undefined;
	if (typeof selection.nativeOptOut !== "boolean" || typeof value.modelKnown !== "boolean") return undefined;
	const transport = displayToken(value.transport);
	const defaultSource = displayToken(value.defaultSource);
	const api = typeof value.api === "string" ? displayId(value.api, OPAQUE_PROVIDER) : undefined;
	const providerType = typeof value.providerType === "string" ? displayId(value.providerType, OPAQUE_PROVIDER) : undefined;
	const provider = typeof value.provider === "string" ? displayId(value.provider, OPAQUE_PROVIDER) : undefined;
	const modelId = typeof value.modelId === "string" ? displayId(value.modelId, OPAQUE_MODEL) : undefined;
	return {
		version: "1.0.0",
		state,
		host,
		...(transport ? { transport } : {}),
		source,
		reason,
		engineSelection: { engine, source: requestSource, nativeOptOut: selection.nativeOptOut },
		...(defaultSource ? { defaultSource } : {}),
		...(api ? { api } : {}),
		...(providerType ? { providerType } : {}),
		...(provider ? { provider } : {}),
		...(modelId ? { modelId } : {}),
		modelKnown: value.modelKnown,
		label: displayLabel(value.label),
	} as ModelResolution;
}

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
	const modelResolution = projectResolution(record.modelResolution);
	return {
		root: record.result.root,
		source: record.result.source,
		...(modelResolution ? { engine: modelResolution.label, modelResolution } : record.engine ? { engine: displayLabel(record.engine) } : {}),
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
