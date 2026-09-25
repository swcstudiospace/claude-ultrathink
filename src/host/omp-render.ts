// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { type GraphModel, renderGraph } from "./omp-graph.ts";
import { formatElapsed, type Paint, paint, truncateToWidth, visibleWidth } from "./omp-paint.ts";
import type { PlanView } from "./view.ts";

export const PLAN_TYPE = "ultrathink-plan";
export const PENDING_TYPE = "ultrathink-pending";
export const SYNC_TYPE = "ultrathink-sync";
export const SHIP_TYPE = "ultrathink-ship";

/** Graph rows in the collapsed card; the graph degrades its layout to fit. */
const COLLAPSED_GRAPH_ROWS = 18;
/** Below this width the border and padding leave no room for text, so rows render unframed. */
const MIN_FRAME_WIDTH = 8;
const INDENT = "  ";
/** Newlines, tabs and other non-space whitespace in free text (titles, answers, API errors) would break a one-line row. */
const NON_SPACE_WHITESPACE = /[^\S ]+/g;
const TRACKING_COLORS = { complete: "success", partial: "warning", failed: "error" } as const;

type Component = { render(width: number): readonly string[] };
type Renderer = (message: { content: unknown; details?: unknown }, options: { expanded: boolean }, theme: unknown) => Component | undefined;
type FrameOptions = { border: "borderMuted" | "borderAccent"; padY: number };

function isPlanView(value: unknown): value is PlanView {
	if (!value || typeof value !== "object") return false;
	const view = value as Partial<PlanView>;
	return typeof view.root === "string" && Array.isArray(view.nodes) && Array.isArray(view.waves) && Array.isArray(view.clarifications);
}

/**
 * Omp's own custom-message card around `rows`: rounded `theme.boxRound` border, `customMessageBg` interior with one
 * column of padding per side and `padY` blank rows top and bottom. Every returned row is exactly `width` columns.
 */
function frame(rows: (room: number) => string[], width: number, p: Paint, options: FrameOptions): string[] {
	if (width < MIN_FRAME_WIDTH) return rows(width).map((row) => truncateToWidth(row.replace(NON_SPACE_WHITESPACE, " "), width));
	const lines = rows(width - 4).map((row) => row.replace(NON_SPACE_WHITESPACE, " "));
	const box = p.boxChars();
	const inner = width - 2;
	const room = inner - 2;
	const side = p.fg(options.border, box.vertical);
	const blank = `${side}${p.bg("customMessageBg", " ".repeat(inner))}${side}`;
	const padding = Array.from({ length: options.padY }, () => blank);
	const body = lines.map((line) => {
		const text = truncateToWidth(line, room);
		// a cut row ends in a full reset (\x1b[0m) that would drop the background, so the fill is painted on its own
		const fill = `${" ".repeat(Math.max(0, room - visibleWidth(text)))} `;
		return `${side}${p.bg("customMessageBg", ` ${text}`)}${p.bg("customMessageBg", fill)}${side}`;
	});
	const rule = box.horizontal.repeat(inner);
	return [p.fg(options.border, `${box.topLeft}${rule}${box.topRight}`), ...padding, ...body, ...padding, p.fg(options.border, `${box.bottomLeft}${rule}${box.bottomRight}`)];
}

/** Frames the rows built for each render width's content room; repeated renders at the same width return the same array. */
function card(rows: (room: number) => string[], p: Paint, options: FrameOptions): Component {
	let cachedWidth: number | undefined;
	let cached: string[] = [];
	return {
		render(width) {
			if (width === cachedWidth) return cached;
			cachedWidth = width;
			try {
				cached = frame(rows, width, p, options);
			} catch {
				cached = [];
			}
			return cached;
		},
	};
}

/** The plan's final Graph of Thought: every node done, linked issues attached, no animation timestamps. */
export function planViewToGraph(view: PlanView): GraphModel {
	return {
		nodes: view.nodes.map((node) => ({
			id: node.id,
			title: node.title,
			kind: node.kind,
			dependsOn: node.dependsOn ?? [],
			status: "done",
			...(node.issue ? { issue: { identifier: node.issue.identifier, url: node.issue.url } } : {}),
			notion: Boolean(node.notionUrl),
			steps: node.steps.map((step) => ({
				step: step.step,
				title: step.title,
				...(step.url ? { issue: { ...(step.identifier ? { identifier: step.identifier } : {}), url: step.url } } : {}),
			})),
		})),
	};
}

/** Card content rows (header, blank, graph, summaries) for a content room of `room` columns; the frame truncates each row. */
function planRows(view: PlanView, graph: GraphModel, expanded: boolean, p: Paint, theme: unknown, room: number): string[] {
	const icon = p.icon("package");
	const issues = view.tracking ? `${view.tracking.issues} issues` : "issues via kickoff";
	const label = p.fg("customMessageLabel", p.bold(icon ? `${icon} ${PLAN_TYPE}` : PLAN_TYPE));
	const via = view.skill ? ` · via /${view.skill}` : "";
	const header = `${label}${p.fg("muted", ` · ${view.root} · ${view.nodes.length} nodes · ${issues} · ${formatElapsed(view.elapsedMs)}${via}`)}`;
	const body = renderGraph(graph, theme, room, { now: 0, steps: expanded ? "all" : "none", animate: false, maxRows: expanded ? undefined : COLLAPSED_GRAPH_ROWS });
	if (expanded) {
		for (const node of view.nodes) {
			if (node.issue) body.push(p.fg("muted", `${node.issue.identifier} ${node.issue.url}`));
			if (node.notionUrl) body.push(`${p.fg("dim", "notion")} ${p.fg("muted", node.notionUrl)}`);
			for (const step of node.steps) {
				if (step.url) body.push(`${INDENT}${p.fg("muted", `${step.identifier ? `${step.identifier} ` : ""}${step.url}`)}`);
			}
		}
	} else if (view.nodes.some((node) => node.steps.length > 0)) {
		body.push(p.fg("dim", "ctrl+o drops down sub-issues"));
	}
	if (view.clarifications.length > 0) {
		const blocking = view.clarifications.filter((item) => item.blocking).length;
		const blockingCount = blocking > 0 ? `${p.fg("muted", " · ")}${p.fg("warning", `${blocking} blocking`)}` : "";
		const count = view.clarifications.length;
		body.push(`${p.fg("dim", "?")} ${p.fg("muted", `${count} clarification${count === 1 ? "" : "s"}`)}${blockingCount}`);
		if (expanded) {
			for (const item of view.clarifications) {
				const mark = item.blocking ? `${p.fg("warning", "[blocking]")} ` : "";
				const resolution = item.answer ? ` → ${item.answer}` : item.recommended ? ` · recommended: ${item.recommended}` : "";
				body.push(`${INDENT}${mark}${p.fg("customMessageText", item.question)}${resolution && p.fg("muted", resolution)}`);
			}
		}
	}
	if (view.tracking) {
		const { status, issues: count, subIssues, errors, notionTaskUrl } = view.tracking;
		body.push(`${p.fg("dim", "tracking")} ${p.fg(TRACKING_COLORS[status], status)}${p.fg("muted", ` · ${count} issues · ${subIssues} sub-issues`)}`);
		if (expanded) {
			for (const error of errors) body.push(`${INDENT}${p.fg("error", `${p.glyph("error")} ${error}`)}`);
		}
		if (notionTaskUrl) body.push(`${p.fg("dim", "notion")} ${p.fg("muted", notionTaskUrl)}`);
	}
	return [header, "", ...body];
}

export function registerUltrathinkRenderers(pi: { registerMessageRenderer(type: string, renderer: Renderer): void }): void {
	pi.registerMessageRenderer(PLAN_TYPE, (message, options, theme) => {
		// details are untrusted session data: a malformed view falls back to Omp's default card instead of throwing into Omp
		try {
			const view = message.details;
			if (!isPlanView(view)) return undefined;
			const p = paint(theme);
			// built eagerly so malformed nodes fall back to Omp's default card here
			const graph = planViewToGraph(view);
			return card((room) => planRows(view, graph, options.expanded, p, theme, room), p, { border: "borderMuted", padY: 1 });
		} catch {
			return undefined;
		}
	});
	pi.registerMessageRenderer(PENDING_TYPE, (_message, _options, theme) => {
		const p = paint(theme);
		const label = p.fg("customMessageLabel", p.bold(PENDING_TYPE));
		const row = `${p.fg("accent", p.glyph("running"))} ${label}${p.fg("muted", " · planning… live status in the ultrathink bar above the editor")}`;
		return card(() => [row], p, { border: "borderAccent", padY: 0 });
	});
	pi.registerMessageRenderer(SYNC_TYPE, (message, _options, theme) => {
		// details are untrusted session data: anything without a PR URL falls back to Omp's default card
		const { details } = message;
		const url = details && typeof details === "object" && "url" in details ? details.url : undefined;
		if (typeof url !== "string") return undefined;
		const p = paint(theme);
		const label = p.fg("customMessageLabel", p.bold(SYNC_TYPE));
		const row = `${p.fg("accent", p.glyph("running"))} ${label}${p.fg("muted", ` · PR ${url}`)}`;
		return card(() => [row], p, { border: "borderAccent", padY: 0 });
	});
	pi.registerMessageRenderer(SHIP_TYPE, (message, _options, theme) => {
		// details are untrusted session data: anything without branch/base/ahead falls back to Omp's default card
		const { details } = message;
		if (!details || typeof details !== "object") return undefined;
		const branch = "branch" in details ? details.branch : undefined;
		const base = "base" in details ? details.base : undefined;
		const ahead = "ahead" in details ? details.ahead : undefined;
		if (typeof branch !== "string" || typeof base !== "string" || typeof ahead !== "number") return undefined;
		const p = paint(theme);
		const label = p.fg("customMessageLabel", p.bold(SHIP_TYPE));
		const row = `${p.fg("accent", p.glyph("running"))} ${label}${p.fg("muted", ` · ${branch} → ${base} · ${ahead} commits`)}`;
		return card(() => [row], p, { border: "borderAccent", padY: 0 });
	});
}
