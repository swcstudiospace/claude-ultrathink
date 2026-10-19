// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Graph of Thought x Chain of Thought views of a finished plan: a structured, capped `GraphView` for tool results
 * and the MCP App, a Mermaid flowchart and a plain-text wave tree for chats. Derived from `SessionRecord.graph`
 * only; there is no second reasoning model. Every string comes from a model and is untrusted: it is flattened,
 * capped and, for Mermaid, reduced to a character whitelist inside quoted labels.
 */
import type { SessionRecord } from "../../../src/claude/state.ts";
import { isFallbackGraph, topoSort, workflowWaves } from "../../../src/think/graph.ts";
import { NODE_KINDS, type NodeKind, type ThoughtNode } from "../../../src/think/types.ts";
import { splitRationaleSteps } from "../../../src/track/plan.ts";

export interface GraphViewNode {
	/** Model-supplied id, one line, at most 40 chars. */
	id: string;
	/** One line, at most 120 chars. */
	title: string;
	kind: NodeKind;
	/** Collapsed to one paragraph, at most 1000 chars. */
	question: string;
	/** Ids present in this graph; unknown ids dropped. */
	dependsOn: string[];
	/** 1-based dependency level. */
	wave: number;
	/** Chain of Thought steps in order, each at most 600 chars, at most 12 per node. */
	steps: string[];
	/** At most 2000 chars. */
	conclusion: string;
	/** This node's fill was boilerplate (record.degraded has "fill:<id>"). */
	fallback?: true;
}

export interface GraphViewWave {
	wave: number;
	parallel: boolean;
	ids: string[];
}

export interface GraphView {
	version: 1;
	/** One line, at most 300 chars. */
	goal: string;
	/** Topological order. */
	nodes: GraphViewNode[];
	waves: GraphViewWave[];
	counts: { nodes: number; edges: number; waves: number; steps: number };
	degraded: { fills: string[] };
	/** Some field was cut by the caps above. */
	truncated?: true;
}

const ID_MAX = 40;
const TITLE_MAX = 120;
const QUESTION_MAX = 1_000;
const STEP_MAX = 600;
const STEPS_MAX = 12;
const CONCLUSION_MAX = 2_000;
const GOAL_MAX = 300;
/** At most this many nodes are drawn; the pipeline itself never produces more than 8. */
const NODES_MAX = 24;
/** A record on disk may hold anything: bound the work before the real cap applies. */
const NODES_READ_MAX = 256;
const THINKING_READ_MAX = 100_000;

const LABEL_MAX = 44;
const TREE_GOAL_MAX = 160;
const TREE_TITLE_MAX = 60;

/** Fill and stroke per kind, chosen for contrast on light and dark chat backgrounds. */
const PALETTE: Record<NodeKind, { fill: string; stroke: string }> = {
	understand: { fill: "#dbeafe", stroke: "#1d4ed8" },
	decompose: { fill: "#e0e7ff", stroke: "#4338ca" },
	generate: { fill: "#dcfce7", stroke: "#15803d" },
	compare: { fill: "#fef9c3", stroke: "#a16207" },
	critique: { fill: "#fee2e2", stroke: "#b91c1c" },
	aggregate: { fill: "#ede9fe", stroke: "#6d28d9" },
	refine: { fill: "#ffedd5", stroke: "#c2410c" },
	synthesize: { fill: "#ccfbf1", stroke: "#0f766e" },
};
const TEXT_COLOR = "#0f172a";

/** Everything but letters, digits, space and `. , : + - _ / '` is replaced inside a Mermaid label. */
const LABEL_UNSAFE_RE = /[^\p{L}\p{N} .,:+_\/'-]/gu;
const CONTROL_RE = /[\p{Cc}\u202A-\u202E\u2066-\u2069]/gu;
/** Controls other than line breaks and tabs; used where line structure is kept. */
const BLOCK_CONTROL_RE = /(?![\n\t])\p{Cc}|[\u202A-\u202E\u2066-\u2069]/gu;

interface Ctx {
	truncated: boolean;
}

function str(value: unknown): string {
	return typeof value === "string" ? value : "";
}

/** Cuts to at most `max` characters, ellipsis included, without splitting a surrogate pair. */
function clip(text: string, max: number): string {
	if (text.length <= max) return text;
	let end = Math.max(0, max - 1);
	const last = text.charCodeAt(end - 1);
	if (end > 0 && last >= 0xd800 && last <= 0xdbff) end -= 1;
	return `${text.slice(0, end).trimEnd()}…`;
}

/** One line: controls become spaces, whitespace collapses. */
function flat(value: unknown): string {
	return str(value).replace(CONTROL_RE, " ").replace(/\s+/g, " ").trim();
}

function bound(text: string, max: number, ctx: Ctx): string {
	if (text.length <= max) return text;
	ctx.truncated = true;
	return clip(text, max);
}

/** Keeps line structure (conclusions carry lists), drops control characters and runs of blank lines. */
function block(value: unknown): string {
	return str(value).replace(/\r\n?/g, "\n").replace(BLOCK_CONTROL_RE, "").replace(/\n{3,}/g, "\n\n").trim();
}

function isNodeKind(value: unknown): value is NodeKind {
	return typeof value === "string" && (NODE_KINDS as readonly string[]).includes(value);
}

/** Steps as the tracker derives them (`nodeSteps` in src/track/plan.ts): a node with no rationale still has one. */
function nodeSteps(thinking: string, conclusion: string, question: string): string[] {
	const steps = splitRationaleSteps(thinking);
	return steps.length > 0 ? steps : [conclusion || question];
}

/**
 * The structured view of a finished plan. Null when there is no graph, no nodes, or only the boilerplate fallback
 * graph. Hostile or malformed input (duplicate ids, unknown, self or cyclic dependencies, oversized text) is repaired:
 * the result is always an acyclic graph with unique ids.
 */
export function buildGraphView(record: SessionRecord): GraphView | null {
	const graph = record?.graph;
	if (!graph || typeof graph !== "object" || !Array.isArray(graph.nodes)) return null;
	const items = graph.nodes.filter((item): item is ThoughtNode => typeof item === "object" && item !== null);
	if (items.length === 0) return null;
	if (isFallbackGraph({ goal: graph.goal, nodes: items })) return null;

	const ctx: Ctx = { truncated: false };
	const read = items.slice(0, NODES_READ_MAX);
	if (read.length < items.length) ctx.truncated = true;

	// Unique, bounded ids. The first node with a given id owns it (dependencies resolve to it); later duplicates,
	// empty ids and ids that collide once cut get a generated one.
	const taken = new Set<string>();
	const ids: string[] = read.map(() => "");
	const byRaw = new Map<string, string>();
	for (const [i, item] of read.entries()) {
		const raw = str(item.id).trim();
		if (!raw || byRaw.has(raw)) continue;
		const id = bound(flat(raw), ID_MAX, ctx);
		if (!id || taken.has(id)) continue;
		taken.add(id);
		ids[i] = id;
		byRaw.set(raw, id);
	}
	for (const [i, item] of read.entries()) {
		if (ids[i]) continue;
		let id = `n${i + 1}`;
		for (let n = 2; taken.has(id); n++) id = `n${i + 1}-${n}`;
		taken.add(id);
		ids[i] = id;
		const raw = str(item.id).trim();
		if (raw && !byRaw.has(raw)) byRaw.set(raw, id);
	}

	// Dependencies resolved to view ids: unknown, self and repeated ones dropped.
	const skeleton: ThoughtNode[] = read.map((item, i) => {
		const own = ids[i]!;
		const deps: string[] = [];
		for (const dep of Array.isArray(item.dependsOn) ? item.dependsOn : []) {
			const id = byRaw.get(str(dep).trim());
			if (id !== undefined && id !== own && !deps.includes(id)) deps.push(id);
		}
		return { id: own, title: "", kind: "understand", question: "", dependsOn: deps };
	});

	// Dependencies first; nodes caught in a cycle come last, in input order, so a back edge is detectable by position.
	const ordered = topoSort(skeleton);
	if (ordered.length > NODES_MAX) ctx.truncated = true;
	const kept = ordered.slice(0, NODES_MAX);
	const position = new Map(kept.map((node, i) => [node.id, i] as const));
	const acyclic: ThoughtNode[] = kept.map((node, i) => ({
		...node,
		dependsOn: node.dependsOn.filter((dep) => {
			const at = position.get(dep);
			return at !== undefined && at < i;
		}),
	}));
	const waves = workflowWaves({ goal: "", nodes: acyclic });

	const degraded = new Set<string>();
	for (const entry of Array.isArray(record.degraded) ? record.degraded : []) {
		if (typeof entry === "string" && entry.startsWith("fill:")) degraded.add(entry.slice("fill:".length).trim());
	}

	const sourceById = new Map<string, ThoughtNode>();
	for (const [i, item] of read.entries()) sourceById.set(ids[i]!, item);
	const dependsById = new Map(acyclic.map((node) => [node.id, node.dependsOn] as const));
	const waveOf = new Map<string, number>();
	for (const wave of waves) for (const id of wave.ids) waveOf.set(id, wave.wave);

	const built = new Map<string, GraphViewNode>();
	for (const id of position.keys()) {
		const source = sourceById.get(id)!;
		const raw = str(source.id).trim();
		let thinking = str(source.thinking);
		if (thinking.length > THINKING_READ_MAX) {
			thinking = thinking.slice(0, THINKING_READ_MAX);
			ctx.truncated = true;
		}
		const conclusion = block(source.conclusion);
		const question = flat(source.question);
		const steps = nodeSteps(thinking, conclusion, question);
		if (steps.length > STEPS_MAX) ctx.truncated = true;
		const node: GraphViewNode = {
			id,
			title: bound(flat(source.title), TITLE_MAX, ctx),
			kind: isNodeKind(source.kind) ? source.kind : "understand",
			question: bound(question, QUESTION_MAX, ctx),
			dependsOn: [...(dependsById.get(id) ?? [])],
			wave: waveOf.get(id) ?? 1,
			steps: steps
				.slice(0, STEPS_MAX)
				.map((step) => bound(flat(step), STEP_MAX, ctx))
				.filter((step) => step.length > 0),
			conclusion: bound(conclusion, CONCLUSION_MAX, ctx),
		};
		if (degraded.has(raw) && byRaw.get(raw) === id) node.fallback = true;
		built.set(id, node);
	}

	const nodes: GraphViewNode[] = [];
	for (const wave of waves) for (const id of wave.ids) nodes.push(built.get(id)!);

	const view: GraphView = {
		version: 1,
		goal: bound(flat(graph.goal), GOAL_MAX, ctx),
		nodes,
		waves: waves.map((wave) => ({ wave: wave.wave, parallel: wave.parallel, ids: [...wave.ids] })),
		counts: {
			nodes: nodes.length,
			edges: nodes.reduce((sum, node) => sum + node.dependsOn.length, 0),
			waves: waves.length,
			steps: nodes.reduce((sum, node) => sum + node.steps.length, 0),
		},
		degraded: { fills: nodes.filter((node) => node.fallback).map((node) => node.id) },
	};
	if (ctx.truncated) view.truncated = true;
	return view;
}

/** A Mermaid label body: whitelisted characters only, so no quote, bracket, tag or directive can survive. */
function labelText(value: string): string {
	return value.replace(LABEL_UNSAFE_RE, " ").replace(/\s+/g, " ").trim();
}

function nodeLabel(node: GraphViewNode, position: number): string {
	const joined = [labelText(node.id), labelText(node.title)].filter((part) => part.length > 0).join(": ");
	return clip(joined || `node ${position}`, LABEL_MAX);
}

/**
 * Mermaid flowchart source, no fences. Node ids are positional and subgraph ids and labels come from numbers, so the
 * model's text appears only inside double-quoted, sanitized node labels.
 */
export function renderMermaid(view: GraphView): string {
	const nodes = view.nodes.slice(0, NODES_MAX);
	const index = new Map<string, number>();
	for (const [i, node] of nodes.entries()) if (!index.has(node.id)) index.set(node.id, i);
	const placed = new Set<number>();
	const lines = ["flowchart TD"];
	for (const [w, wave] of view.waves.entries()) {
		const members = wave.ids.map((id) => index.get(id)).filter((i): i is number => i !== undefined && !placed.has(i));
		if (members.length === 0) continue;
		lines.push(`  subgraph W${w + 1}["Wave ${w + 1}${wave.parallel ? " - parallel" : ""}"]`);
		for (const i of members) {
			placed.add(i);
			lines.push(`    N${i + 1}["${nodeLabel(nodes[i]!, i + 1)}"]`);
		}
		lines.push("  end");
	}
	const edges = new Set<string>();
	for (const [i, node] of nodes.entries()) {
		if (!placed.has(i)) continue;
		for (const dep of node.dependsOn) {
			const from = index.get(dep);
			if (from === undefined || from === i || !placed.has(from)) continue;
			edges.add(`  N${from + 1} --> N${i + 1}`);
		}
	}
	lines.push(...edges);
	const byKind = new Map<NodeKind, number[]>();
	for (const [i, node] of nodes.entries()) {
		if (!placed.has(i)) continue;
		const kind = isNodeKind(node.kind) ? node.kind : "understand";
		byKind.set(kind, [...(byKind.get(kind) ?? []), i + 1]);
	}
	for (const kind of NODE_KINDS) {
		const members = byKind.get(kind);
		if (!members) continue;
		const { fill, stroke } = PALETTE[kind];
		lines.push(`  classDef ${kind} fill:${fill},stroke:${stroke},color:${TEXT_COLOR}`);
		lines.push(`  class ${members.map((n) => `N${n}`).join(",")} ${kind}`);
	}
	return lines.join("\n");
}

const pad = (text: string, width: number): string => text + " ".repeat(Math.max(0, width - text.length));

/** Plain-text wave tree: one aligned line per node, every model string collapsed to one line. */
export function renderTree(view: GraphView): string {
	const lines = [`Goal: ${clip(flat(view.goal), TREE_GOAL_MAX)}`];
	const byId = new Map(view.nodes.map((node) => [node.id, node] as const));
	const rows: Array<{ wave: number; id: string; title: string; kind: string; steps: string; after: string }> = [];
	for (const [w, wave] of view.waves.entries()) {
		for (const id of wave.ids) {
			const node = byId.get(id);
			if (!node) continue;
			const count = node.steps.length;
			rows.push({
				wave: w,
				id: clip(flat(node.id), ID_MAX),
				title: clip(flat(node.title), TREE_TITLE_MAX) || "(untitled)",
				kind: `[${flat(node.kind)}]`,
				steps: `${count} ${count === 1 ? "step" : "steps"}`,
				after: node.dependsOn.length > 0 ? `after ${node.dependsOn.map((dep) => clip(flat(dep), ID_MAX)).join(", ")}` : "",
			});
		}
	}
	const width = (pick: (row: (typeof rows)[number]) => string): number => rows.reduce((max, row) => Math.max(max, pick(row).length), 0);
	const idW = width((row) => row.id);
	const titleW = width((row) => row.title);
	const kindW = width((row) => row.kind);
	const stepsW = width((row) => row.steps);
	for (const [w, wave] of view.waves.entries()) {
		const members = rows.filter((row) => row.wave === w);
		if (members.length === 0) continue;
		lines.push(`Wave ${w + 1}${wave.parallel ? " (parallel)" : ""}`);
		for (const row of members) {
			const cells = [pad(row.id, idW), pad(row.title, titleW), pad(row.kind, kindW), pad(row.steps, stepsW), row.after];
			lines.push(`  ${cells.join("  ")}`.trimEnd());
		}
	}
	return lines.join("\n");
}

/** Fenced block whose fence is longer than any backtick run inside, so the content cannot close it. */
export function fenced(text: string, info = ""): string {
	let longest = 0;
	for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
	const fence = "`".repeat(Math.max(3, longest + 1));
	return `${fence}${info}\n${text}\n${fence}`;
}

/** The plan-text block: heading, one instruction for the chat model, the wave tree first and the diagram second. */
export function renderGraphBlock(view: GraphView): string {
	return [
		"## Graph of Thought x Chain of Thought",
		"Show the user the wave tree below first, unchanged, in a code block. If your interface renders Mermaid, also show the diagram after it as a mermaid code block.",
		fenced(renderTree(view), "text"),
		fenced(renderMermaid(view), "mermaid"),
	].join("\n\n");
}
