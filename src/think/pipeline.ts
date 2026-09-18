import type { UpliftResult } from "../types.ts";
import {
	dependencyLevels,
	extractJsonObject,
	graphSketch,
	injectGraphXml,
	normalizeGraph,
	parseNodeFill,
	topoSort,
} from "./graph.ts";
import { COT_SYSTEM_PROMPT, GRAPH_SYSTEM_PROMPT } from "./prompts.ts";
import { MAX_NODES, MIN_NODES, type ThoughtGraph, type ThoughtNode } from "./types.ts";

export interface ThinkResult extends UpliftResult {
	graph: ThoughtGraph;
}

export interface RunThinkOptions {
	uplift: UpliftResult;
	complete: (system: string, user: string, signal?: AbortSignal) => Promise<string>;
	signal?: AbortSignal;
	minNodes?: number;
	maxNodes?: number;
	onProgress?: (message: string) => void;
	/** Fill independent nodes concurrently, level by level. Default 1 (sequential). */
	concurrency?: number;
}

function isAbortError(error: unknown): boolean {
	if (error instanceof Error) return error.name === "AbortError";
	if (!error || typeof error !== "object" || !("name" in error)) return false;
	return error.name === "AbortError";
}

function predecessorBlock(graph: ThoughtGraph, node: ThoughtNode): string {
	const byId = new Map(graph.nodes.map((item) => [item.id, item]));
	const preds = node.dependsOn.map((id) => byId.get(id)).filter((item): item is ThoughtNode => Boolean(item));
	if (preds.length === 0) return "(no predecessors)";
	return preds
		.map((pred) => {
			const conclusion = pred.conclusion?.trim() || "(not filled)";
			return `<predecessor id="${pred.id}" title="${pred.title}">\n${conclusion}\n</predecessor>`;
		})
		.join("\n\n");
}

function graphUserPayload(uplift: UpliftResult): string {
	return `${uplift.original}\n\n${uplift.xml}`;
}

function cotUserPayload(uplift: UpliftResult, graph: ThoughtGraph, node: ThoughtNode): string {
	return [
		`<original>${uplift.original}</original>`,
		"",
		uplift.xml,
		"",
		`<graph_goal>${graph.goal}</graph_goal>`,
		"<graph>",
		graphSketch(graph),
		"</graph>",
		"",
		"<predecessors>",
		predecessorBlock(graph, node),
		"</predecessors>",
		"",
		`<current_node id="${node.id}" kind="${node.kind}" title="${node.title}">`,
		node.question,
		"</current_node>",
	].join("\n");
}

async function buildGraph(
	opts: RunThinkOptions,
	minNodes: number,
	maxNodes: number,
): Promise<ThoughtGraph> {
	try {
		const raw = await opts.complete(GRAPH_SYSTEM_PROMPT, graphUserPayload(opts.uplift), opts.signal);
		return normalizeGraph(extractJsonObject(raw), opts.uplift.original, minNodes, maxNodes);
	} catch (error) {
		if (isAbortError(error)) throw error;
		return normalizeGraph(null, opts.uplift.original, minNodes, maxNodes);
	}
}

async function fillNode(
	opts: RunThinkOptions,
	graph: ThoughtGraph,
	node: ThoughtNode,
): Promise<void> {
	try {
		const raw = await opts.complete(COT_SYSTEM_PROMPT, cotUserPayload(opts.uplift, graph, node), opts.signal);
		const fill = parseNodeFill(raw);
		node.thinking = fill.thinking;
		node.conclusion = fill.conclusion;
	} catch (error) {
		if (isAbortError(error)) throw error;
		node.thinking = node.question;
		node.conclusion = node.question;
	}
}

async function fillLevel(opts: RunThinkOptions, graph: ThoughtGraph, group: ThoughtNode[], limit: number): Promise<void> {
	let cursor = 0;
	const worker = async (): Promise<void> => {
		while (cursor < group.length) {
			const node = group[cursor++]!;
			await fillNode(opts, graph, node);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, group.length) }, worker));
}

export async function runThink(opts: RunThinkOptions): Promise<ThinkResult> {
	const minNodes = opts.minNodes ?? MIN_NODES;
	const maxNodes = opts.maxNodes ?? MAX_NODES;
	const concurrency = Math.max(1, Math.floor(opts.concurrency ?? 1));

	opts.onProgress?.("Graph of Thought…");
	const graph = await buildGraph(opts, minNodes, maxNodes);
	graph.nodes = topoSort(graph.nodes);

	if (concurrency === 1) {
		for (let index = 0; index < graph.nodes.length; index++) {
			const node = graph.nodes[index]!;
			opts.onProgress?.(`Chain of Thought n${index + 1}/${graph.nodes.length} · ${node.kind}…`);
			await fillNode(opts, graph, node);
		}
	} else {
		let done = 0;
		for (const group of dependencyLevels(graph.nodes)) {
			opts.onProgress?.(`Chain of Thought ${done + 1}-${done + group.length}/${graph.nodes.length}…`);
			await fillLevel(opts, graph, group, concurrency);
			done += group.length;
		}
	}

	const xml = injectGraphXml(opts.uplift.xml, graph);
	return { ...opts.uplift, xml, graph, source: opts.uplift.source };
}
