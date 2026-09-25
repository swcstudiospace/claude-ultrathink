// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/** Pure Graph-of-Thought renderer for the Omp TUI: wave columns of node cards with sub-issues dropping down beneath each card. */
import { type Paint, paint, truncateToWidth, visibleWidth } from "./omp-paint.ts";

export type NodeStatus = "pending" | "running" | "done" | "fallback";
export interface GraphIssue {
	identifier?: string;
	url: string;
	/** ms timestamp the row appeared; drives the flash */
	at?: number;
}
export interface GraphStepModel {
	step: number;
	title: string;
	/** drop-down start (ms); undefined = already shown */
	appearedAt?: number;
	issue?: GraphIssue;
}
export interface GraphNodeModel {
	id: string;
	title: string;
	kind: string;
	dependsOn: string[];
	status: NodeStatus;
	/** pop-up start (ms); undefined = already shown */
	appearedAt?: number;
	issue?: GraphIssue;
	notion?: boolean;
	steps: GraphStepModel[];
}
export interface GraphModel {
	nodes: GraphNodeModel[];
}
export interface GraphRenderOptions {
	now: number;
	/** "all": every node's sub-issues dropped down; "active": only running or recently changed nodes; "none": a one-row fold per node. */
	steps: "all" | "active" | "none";
	/** Hard cap on returned rows; the layout degrades to fit. */
	maxRows?: number;
	/** false renders the final state with no pop/drop/flash/spinner timing. */
	animate: boolean;
}

export const POP_MS = 450;
export const NODE_STAGGER_MS = 90;
export const STEP_STAGGER_MS = 70;
export const FLASH_MS = 700;
export const ACTIVE_MS = 4000;

const GAP = 5;
const MIN_COLUMN = 22;
const STEP_MODES = ["all", "active", "none"] as const;
type StepMode = (typeof STEP_MODES)[number];

/** Dependency levels in input order; unknown deps ignored; unresolvable (cyclic) nodes go in the level after the last. */
export function waveLayout(nodes: ReadonlyArray<{ id: string; dependsOn: string[] }>): string[][] {
	const known = new Set(nodes.map((node) => node.id));
	const level = new Map<string, number>();
	let progress = true;
	while (progress) {
		progress = false;
		for (const node of nodes) {
			if (level.has(node.id)) continue;
			const deps = node.dependsOn.filter((dep) => known.has(dep) && dep !== node.id);
			if (!deps.every((dep) => level.has(dep))) continue;
			level.set(node.id, deps.reduce((max, dep) => Math.max(max, (level.get(dep) ?? 0) + 1), 0));
			progress = true;
		}
	}
	const last = Math.max(-1, ...level.values());
	for (const node of nodes) if (!level.has(node.id)) level.set(node.id, last + 1);
	const waves: string[][] = [];
	for (const node of nodes) {
		const index = level.get(node.id) ?? 0;
		if (waves.some((wave) => wave.includes(node.id))) continue;
		(waves[index] ??= []).push(node.id);
	}
	return waves.filter((wave) => wave !== undefined);
}

function within(now: number, start: number | undefined, span: number): boolean {
	return start !== undefined && now >= start && now - start < span;
}

/** Model reduced to what is on screen at `now`, so later columns never jump when earlier ones grow. */
function visibleModel(model: GraphModel, options: GraphRenderOptions): GraphNodeModel[] {
	if (!options.animate) return model.nodes;
	const { now } = options;
	return model.nodes
		.filter((node) => node.appearedAt === undefined || now >= node.appearedAt)
		.map((node) => ({
			...node,
			steps: node.steps.filter((step, index) => step.appearedAt === undefined || now >= step.appearedAt + index * STEP_STAGGER_MS),
		}));
}

function isActive(node: GraphNodeModel, now: number): boolean {
	const recent = (at: number | undefined) => at !== undefined && now >= at && now - at < ACTIVE_MS;
	return (
		node.status === "running" ||
		recent(node.issue?.at) ||
		node.steps.some((step) => recent(step.appearedAt) || recent(step.issue?.at))
	);
}

interface Ctx {
	p: Paint;
	ascii: boolean;
	now: number;
	animate: boolean;
}

function pad(text: string, width: number): string {
	const cut = truncateToWidth(text, width);
	return cut + " ".repeat(Math.max(0, width - visibleWidth(cut)));
}

function statusText(node: GraphNodeModel, ctx: Ctx, glyphOnly: boolean): string {
	const { p } = ctx;
	switch (node.status) {
		case "running": {
			const spin = ctx.animate ? p.spinner(ctx.now) : p.glyph("running");
			return glyphOnly ? p.fg("accent", spin) : p.fg("accent", `${spin} thinking…`);
		}
		case "done": {
			const notion = node.notion ? ` ${p.fg("dim", "notion")}` : "";
			if (glyphOnly) return p.fg("success", p.glyph("success"));
			const id = node.issue?.identifier;
			return (id ? issueLabel(node.issue, ctx) : `${p.fg("success", p.glyph("success"))} done`) + notion;
		}
		case "fallback":
			return p.fg("warning", glyphOnly ? p.glyph("warning") : `${p.glyph("warning")} fallback`);
		default:
			return p.fg("dim", glyphOnly ? p.glyph("pending") : `${p.glyph("pending")} waiting`);
	}
}

function issueLabel(issue: GraphIssue | undefined, ctx: Ctx): string {
	const id = issue?.identifier;
	if (!id) return "";
	if (ctx.animate && within(ctx.now, issue?.at, FLASH_MS)) return ctx.p.bold(ctx.p.fg("accent", id));
	return ctx.p.fg("customMessageLabel", id);
}

function stepText(step: GraphStepModel, ctx: Ctx): string {
	const { p } = ctx;
	const glyph = step.issue ? p.fg("success", p.glyph("success")) : p.fg("dim", p.glyph("pending"));
	const id = issueLabel(step.issue, ctx);
	return `${glyph} ${id ? `${id} ` : ""}${p.fg("muted", step.title)}`;
}

function foldText(node: GraphNodeModel, ctx: Ctx): string {
	const linked = node.steps.filter((step) => step.issue).length;
	return ctx.p.fg("dim", `${ctx.ascii ? ">" : "▸"} ${node.steps.length} sub-issues${linked ? ` · ${linked} linked` : ""}`);
}

function borderColor(node: GraphNodeModel, ctx: Ctx): string {
	if ((ctx.animate && within(ctx.now, node.appearedAt, POP_MS)) || node.status === "running") return "borderAccent";
	return node.status === "done" ? "success" : "borderMuted";
}

/** One node card; returns rows and the index of its title row. */
function card(node: GraphNodeModel, width: number, mode: StepMode, ctx: Ctx): string[] {
	const { p } = ctx;
	const box = p.boxChars();
	const color = borderColor(node, ctx);
	const h = box.horizontal;
	const inner = width - 4;
	const side = p.fg(color, box.vertical);
	const cell = (content: string) => `${side} ${pad(content, inner)} ${side}`;

	const room = width - 2;
	let id = node.id;
	let kind = node.kind;
	if (visibleWidth(`${h} ${id} ${h} ${kind} `) > room) kind = "";
	if (!kind) id = truncateToWidth(id, Math.max(1, room - 3));
	const labelWidth = visibleWidth(kind ? `${h} ${id} ${h} ${kind} ` : `${h} ${id} `);
	const top =
		p.fg(color, `${box.topLeft}${h} `) +
		p.bold(p.fg("accent", id)) +
		(kind ? `${p.fg(color, ` ${h} `)}${p.fg("dim", kind)}` : "") +
		p.fg(color, ` ${h.repeat(Math.max(0, room - labelWidth))}${box.topRight}`);

	const rows = [top, cell(p.fg("customMessageText", node.title)), cell(statusText(node, ctx, false))];
	if (node.steps.length > 0) {
		if (mode === "all" || (mode === "active" && isActive(node, ctx.now))) {
			node.steps.forEach((step, index) => {
				const last = index === node.steps.length - 1;
				const branch = ctx.ascii ? (last ? "`" : "|") : last ? "└" : "├";
				rows.push(cell(`${p.fg(color, branch)} ${stepText(step, ctx)}`));
			});
		} else rows.push(cell(foldText(node, ctx)));
	}
	const deps = node.dependsOn.length > 0 ? truncateToWidth(`${h} ${ctx.ascii ? "<-" : "←"} ${node.dependsOn.join(" ")} `, room) : "";
	rows.push(p.fg(color, `${box.bottomLeft}${deps}${h.repeat(Math.max(0, room - visibleWidth(deps)))}${box.bottomRight}`));
	return rows;
}

const JUNCTIONS: Record<string, string> = {
	"0001": "─",
	"0010": "─",
	"0011": "─",
	"0101": "┌",
	"0110": "┐",
	"0111": "┬",
	"1001": "└",
	"1010": "┘",
	"1011": "┴",
	"1100": "│",
	"0100": "│",
	"1000": "│",
	"1101": "├",
	"1110": "┤",
	"1111": "┼",
};

function junction(up: boolean, down: boolean, left: boolean, right: boolean, ascii: boolean): string {
	const key = [up, down, left, right].map(Number).join("");
	if (key === "0000") return " ";
	if (!ascii) return JUNCTIONS[key] ?? " ";
	if (!up && !down) return "-";
	if (!left && !right) return "|";
	return "+";
}

function columnLayout(nodes: GraphNodeModel[], width: number, mode: StepMode, ctx: Ctx): string[] | undefined {
	const waves = waveLayout(nodes);
	if (waves.length === 0) return [];
	const colWidth = Math.floor((width - (waves.length - 1) * GAP) / waves.length);
	if (colWidth < MIN_COLUMN) return undefined;
	const byId = new Map(nodes.map((node) => [node.id, node]));
	const columnOf = new Map<string, number>();
	waves.forEach((wave, index) => {
		for (const id of wave) columnOf.set(id, index);
	});
	const columns = waves.map((wave) => {
		const rows: string[] = [];
		const titleRow = new Map<string, number>();
		wave.forEach((id, index) => {
			const node = byId.get(id);
			if (!node) return;
			if (index > 0) rows.push("");
			titleRow.set(id, rows.length + 1);
			rows.push(...card(node, colWidth, mode, ctx));
		});
		return { rows, titleRow };
	});
	const height = Math.max(...columns.map((column) => column.rows.length));
	const blank = " ".repeat(colWidth);
	const { p, ascii } = ctx;
	const gaps = columns.slice(1).map((column, offset) => {
		const c = offset + 1;
		const sources = new Set<number>();
		for (const [id, row] of columns[c - 1]?.titleRow ?? []) {
			if (nodes.some((node) => (columnOf.get(node.id) ?? 0) >= c && node.dependsOn.includes(id))) sources.add(row);
		}
		const targets = new Map<number, GraphNodeModel>();
		for (const [id, row] of column.titleRow) {
			const node = byId.get(id);
			if (node && node.dependsOn.length > 0) targets.set(row, node);
		}
		const lines = Array.from({ length: height }, () => " ".repeat(GAP));
		if (sources.size === 0 || targets.size === 0) return lines;
		const all = [...sources, ...targets.keys()];
		const lo = Math.min(...all);
		const hi = Math.max(...all);
		const h = ascii ? "-" : "─";
		for (let r = lo; r <= hi; r++) {
			const left = sources.has(r);
			const target = targets.get(r);
			const bus = junction(r > lo, r < hi, left, target !== undefined, ascii);
			const arrow = target ? p.fg(target.status === "running" ? "accent" : "borderMuted", `${h}${ascii ? ">" : "▶"}`) : "  ";
			lines[r] = `${p.fg("borderMuted", `${left ? h.repeat(2) : "  "}${bus}`)}${arrow}`;
		}
		return lines;
	});
	return Array.from({ length: height }, (_, r) =>
		columns.map((column, c) => `${c > 0 ? (gaps[c - 1]?.[r] ?? "") : ""}${column.rows[r] ? column.rows[r] : blank}`).join(""),
	);
}

/** Tree rows grouped per node (for node-granular truncation). */
function treeGroups(nodes: GraphNodeModel[], width: number, mode: StepMode, ctx: Ctx): string[][] {
	const { p, ascii } = ctx;
	const order = waveLayout(nodes).flat();
	const byId = new Map(nodes.map((node) => [node.id, node]));
	return order.flatMap((id, index) => {
		const node = byId.get(id);
		if (!node) return [];
		const last = index === order.length - 1;
		const branch = p.fg("borderMuted", ascii ? (last ? "`-" : "|-") : last ? "└─" : "├─");
		const rail = p.fg("borderMuted", last ? "   " : ascii ? "|  " : "│  ");
		const issue = issueLabel(node.issue, ctx);
		const deps = node.dependsOn.length > 0 ? p.fg("dim", ` ${ascii ? "<-" : "←"} ${node.dependsOn.join(" ")}`) : "";
		const head = `${branch} ${statusText(node, ctx, true)} ${p.bold(p.fg("accent", node.id))} ${p.fg("customMessageText", node.title)}${issue ? ` · ${issue}` : ""}${deps}`;
		const rows = [head];
		if (node.steps.length > 0) {
			if (mode === "all" || (mode === "active" && isActive(node, ctx.now))) {
				node.steps.forEach((step, j) => {
					const end = j === node.steps.length - 1;
					rows.push(`${rail}${p.fg("borderMuted", ascii ? (end ? "`" : "|") : end ? "└" : "├")} ${stepText(step, ctx)}`);
				});
			} else rows.push(`${rail}${foldText(node, ctx)}`);
		}
		return [rows.map((row) => truncateToWidth(row, width))];
	});
}

export function renderGraph(model: GraphModel, theme: unknown, width: number, options: GraphRenderOptions): string[] {
	if (width < 10 || model.nodes.length === 0) return [];
	const p = paint(theme);
	const ctx: Ctx = { p, ascii: p.boxChars().horizontal === "-", now: options.now, animate: options.animate };
	const nodes = visibleModel(model, options);
	if (nodes.length === 0) return [];
	const max = options.maxRows ?? Number.POSITIVE_INFINITY;
	if (max <= 0) return [];
	const modes = STEP_MODES.slice(STEP_MODES.indexOf(options.steps));
	for (const mode of modes) {
		const rows = columnLayout(nodes, width, mode, ctx);
		if (rows === undefined) break;
		if (rows.length <= max) return rows;
	}
	for (const mode of modes) {
		const rows = treeGroups(nodes, width, mode, ctx).flat();
		if (rows.length <= max) return rows;
	}
	const groups = treeGroups(nodes, width, "none", ctx);
	const out: string[] = [];
	let shown = 0;
	for (const group of groups) {
		if (out.length + group.length > max - 1) break;
		out.push(...group);
		shown++;
	}
	if (shown === 0 && max > 1 && groups[0]?.[0]) {
		out.push(groups[0][0]);
		shown = 1;
	}
	out.push(truncateToWidth(p.fg("dim", `… ${groups.length - shown} more nodes`), width));
	return out;
}
