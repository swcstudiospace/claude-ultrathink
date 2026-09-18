import { escapeXml } from "../uplift/xml.ts";
import {
	FALLBACK_GRAPH,
	NODE_KINDS,
	type NodeKind,
	type ThoughtGraph,
	type ThoughtNode,
} from "./types.ts";

export function extractTag(xml: string, tag: string): string {
	const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, "i");
	return xml.match(re)?.[1]?.trim() ?? "";
}

export function extractJsonObject(text: string): unknown {
	const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
	const raw = (fenced?.[1] ?? text).trim();
	try {
		return JSON.parse(raw);
	} catch {
		// fall through
	}
	const start = raw.indexOf("{");
	const end = raw.lastIndexOf("}");
	if (start >= 0 && end > start) {
		try {
			return JSON.parse(raw.slice(start, end + 1));
		} catch {
			return null;
		}
	}
	return null;
}

function asString(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

function isNodeKind(value: string): value is NodeKind {
	return (NODE_KINDS as readonly string[]).includes(value);
}

function parseDependsOn(value: unknown): string[] {
	if (Array.isArray(value)) return value.map((item) => asString(item)).filter(Boolean);
	if (typeof value === "string") {
		return value
			.split(/[,\s]+/)
			.map((part) => part.trim())
			.filter(Boolean);
	}
	return [];
}

export function normalizeGraph(
	raw: unknown,
	fallbackGoal: string,
	minNodes: number,
	maxNodes: number,
): ThoughtGraph {
	const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
	const sourceNodes = Array.isArray(obj.nodes) ? obj.nodes : [];
	const nodes: ThoughtNode[] = [];
	const seen = new Set<string>();

	for (const [index, entry] of sourceNodes.entries()) {
		if (!entry || typeof entry !== "object") continue;
		const rec = entry as Record<string, unknown>;
		const id = asString(rec.id) || `n${index + 1}`;
		if (seen.has(id)) continue;
		seen.add(id);
		const kindRaw = asString(rec.kind).toLowerCase();
		const kind: NodeKind = isNodeKind(kindRaw) ? kindRaw : index === 0 ? "understand" : "generate";
		nodes.push({
			id,
			title: asString(rec.title) || id,
			kind,
			question: asString(rec.question) || asString(rec.prompt) || `Reason about ${id}`,
			dependsOn: parseDependsOn(rec.depends_on ?? rec.dependsOn),
		});
		if (nodes.length >= maxNodes) break;
	}

	if (nodes.length < minNodes) {
		return {
			goal: FALLBACK_GRAPH.goal,
			nodes: FALLBACK_GRAPH.nodes.map((node) => ({ ...node, dependsOn: [...node.dependsOn] })),
		};
	}

	const ids = new Set(nodes.map((node) => node.id));
	for (const node of nodes) {
		node.dependsOn = node.dependsOn.filter((dep) => ids.has(dep) && dep !== node.id);
	}

	const last = nodes[nodes.length - 1];
	if (last) last.kind = "synthesize";

	return {
		goal: asString(obj.goal) || fallbackGoal || FALLBACK_GRAPH.goal,
		nodes,
	};
}

export function topoSort(nodes: ThoughtNode[]): ThoughtNode[] {
	const byId = new Map(nodes.map((node) => [node.id, node]));
	const incoming = new Map<string, number>();
	const children = new Map<string, string[]>();

	for (const node of nodes) {
		incoming.set(node.id, 0);
		children.set(node.id, []);
	}

	for (const node of nodes) {
		for (const dep of node.dependsOn) {
			if (!byId.has(dep)) continue;
			incoming.set(node.id, (incoming.get(node.id) ?? 0) + 1);
			children.get(dep)?.push(node.id);
		}
	}

	const queue = nodes.filter((node) => (incoming.get(node.id) ?? 0) === 0).map((node) => node.id);
	const ordered: ThoughtNode[] = [];

	while (queue.length > 0) {
		const id = queue.shift();
		if (!id) break;
		const node = byId.get(id);
		if (node) ordered.push(node);
		for (const child of children.get(id) ?? []) {
			const next = (incoming.get(child) ?? 1) - 1;
			incoming.set(child, next);
			if (next === 0) queue.push(child);
		}
	}

	for (const node of nodes) {
		if (!ordered.includes(node)) ordered.push(node);
	}

	return ordered;
}

/** Groups topologically sorted nodes into dependency levels (all deps in earlier levels). */
export function dependencyLevels(nodes: ThoughtNode[]): ThoughtNode[][] {
	const level = new Map<string, number>();
	const levels: ThoughtNode[][] = [];
	for (const node of nodes) {
		let depth = 0;
		for (const dep of node.dependsOn) {
			const seen = level.get(dep);
			if (seen !== undefined) depth = Math.max(depth, seen + 1);
		}
		level.set(node.id, depth);
		(levels[depth] ??= []).push(node);
	}
	return levels.filter((group) => group.length > 0);
}

export interface WorkflowWave {
	wave: number;
	parallel: boolean;
	ids: string[];
}

/** Execution waves: nodes in the same wave have every dependency in an earlier wave. */
export function workflowWaves(graph: ThoughtGraph): WorkflowWave[] {
	return dependencyLevels(topoSort(graph.nodes)).map((group, index) => ({
		wave: index + 1,
		parallel: group.length > 1,
		ids: group.map((node) => node.id),
	}));
}

export function parseNodeFill(xml: string): { thinking: string; conclusion: string } {
	const body = extractTag(xml, "node") || xml;
	const thinking = extractTag(body, "thinking") || extractTag(body, "chain_of_thought");
	const conclusion = extractTag(body, "conclusion") || extractTag(body, "answer");
	if (thinking || conclusion) {
		return { thinking: thinking || conclusion, conclusion: conclusion || thinking };
	}
	const trimmed = xml.trim();
	return { thinking: trimmed, conclusion: trimmed };
}

function nodeXml(node: ThoughtNode): string {
	const deps =
		node.dependsOn.length > 0
			? `		<DEPENDS_ON>${escapeXml(node.dependsOn.join(","))}</DEPENDS_ON>`
			: "		<DEPENDS_ON></DEPENDS_ON>";
	return [
		`	<NODE id="${escapeXml(node.id)}" kind="${escapeXml(node.kind)}" title="${escapeXml(node.title)}">`,
		`		<QUESTION>${escapeXml(node.question)}</QUESTION>`,
		deps,
		`		<THINKING>${escapeXml(node.thinking ?? "")}</THINKING>`,
		`		<CONCLUSION>${escapeXml(node.conclusion ?? "")}</CONCLUSION>`,
		"	</NODE>",
	].join("\n");
}

function workflowXml(graph: ThoughtGraph): string[] {
	return [
		"	<WORKFLOW>",
		...workflowWaves(graph).map(
			(wave) => `		<WAVE n="${wave.wave}" parallel="${wave.parallel}">${escapeXml(wave.ids.join(", "))}</WAVE>`,
		),
		"	</WORKFLOW>",
	];
}

export function graphToXml(graph: ThoughtGraph): string {
	return [
		"<GRAPH_OF_THOUGHT>",
		`	<GOAL>${escapeXml(graph.goal)}</GOAL>`,
		...graph.nodes.map((node) => nodeXml(node)),
		...workflowXml(graph),
		"</GRAPH_OF_THOUGHT>",
	].join("\n");
}

const GRAPH_BLOCK_RE = /<GRAPH_OF_THOUGHT\b[\s\S]*?<\/GRAPH_OF_THOUGHT>/i;

export function injectGraphXml(upliftXml: string, graph: ThoughtGraph): string {
	const graphXml = graphToXml(graph);
	if (GRAPH_BLOCK_RE.test(upliftXml)) {
		return upliftXml.replace(GRAPH_BLOCK_RE, graphXml);
	}

	const trimmed = upliftXml.trim();
	const open = trimmed.match(/^<([A-Za-z_][\w.-]*)\b([^>]*)>/);
	if (!open) return trimmed ? `${trimmed}\n${graphXml}` : graphXml;

	const tag = open[1]!;
	const closeRe = new RegExp(`</${tag}\\s*>\\s*$`, "i");
	if (!closeRe.test(trimmed)) return `${trimmed}\n${graphXml}`;
	return trimmed.replace(closeRe, `\n${graphXml}\n</${tag}>`);
}

export function graphSketch(graph: ThoughtGraph): string {
	return graph.nodes
		.map((node) => {
			const deps = node.dependsOn.length > 0 ? `  deps=${node.dependsOn.join(",")}` : "";
			return `${node.id}  ${node.title}  ${node.kind}${deps}`;
		})
		.join("\n");
}
