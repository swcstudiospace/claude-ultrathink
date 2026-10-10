// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { formatP } from "../decisions/types.ts";
import { formatModelSelection } from "../claude/output.ts";
import { type GraphModel, renderGraph } from "./omp-graph.ts";
import { sanitizeInsightText } from "./omp-insights.ts";
import { formatElapsed, type Paint, paint, truncateToWidth, visibleWidth } from "./omp-paint.ts";
import { type PlanView, projectResolution } from "./view.ts";

export const PLAN_TYPE = "ultrathink-plan";
export const PENDING_TYPE = "ultrathink-pending";
export const SYNC_TYPE = "ultrathink-sync";
export const SHIP_TYPE = "ultrathink-ship";
/** Display-only insight card over a captured card DTO; dashboard actions never live in transcript rows. */
export const INSIGHT_TYPE = "ultrathink-insight";

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
	// The planning model's safe record (details are untrusted session data, so it is projected again): label, reason and
	// engine request, e.g. `omp-native:openai-codex/gpt-6.1-sol [detected] · reason live-model · engine auto (config)`.
	const resolution = projectResolution(view.modelResolution);
	if (resolution) body.push(`${p.fg("dim", "model")} ${p.fg("muted", formatModelSelection(resolution))}`);
	return [header, "", ...body];
}

/** Compact content rows; the frame truncates each row to the room. */
const INSIGHT_COMPACT_ROWS = 6;
/** Expanded content rows; the rest stays in the dashboard. */
const INSIGHT_EXPANDED_ROWS = 24;
/** Summaries per section in the expanded card. */
const INSIGHT_SUMMARY_CAP = 3;

/** Closed vocabularies of the frozen card DTO; anything outside them is untrusted persisted data. */
const INSIGHT_POINTS = ["plan", "ship", "knowledge", "blocking", "teachable", "skillworthy"] as const;
const INSIGHT_OUTCOMES = ["ok", "error"] as const;
const INSIGHT_ACTIONS = [
	"plan",
	"skip-plan",
	"veto",
	"advise-veto",
	"approve",
	"reject",
	"none",
	"keep",
	"reject-claim",
	"promote",
	"drop",
	"hold",
	"auto-confirm",
	"skip",
	"fail-open",
] as const;
const INSIGHT_STATUSES = ["candidate", "confirmed", "promoted", "superseded"] as const;
const INSIGHT_KINDS = ["bug", "pitfall", "pattern", "decision", "playbook"] as const;
const INSIGHT_CAPTURES = ["explicit", "observe", "auto"] as const;
const INSIGHT_TARGETS = ["hermes", "omp", "claude", "prime-agent", "drafts"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isLiteral<T extends string>(list: readonly T[], value: unknown): value is T {
	return typeof value === "string" && (list as readonly string[]).includes(value);
}

function insightText(value: unknown, maxChars: number): string {
	if (typeof value !== "string" || value === "") return "";
	return sanitizeInsightText(value, { maxChars }).replace(/[^\S ]+/g, " ").trim();
}

/** Validated non-negative integer counts; anything else is not the canonical DTO. */
function insightCount(value: unknown): number | undefined {
	return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

type InsightCardDecision = {
	point: string;
	outcome: string;
	model: string;
	action: string;
	question: string;
};

type InsightCardLesson = {
	name: string;
	status: string;
	kind: string;
	occurrences: number;
	eligible: boolean;
	promotion: string;
};

type InsightCard = {
	project: string;
	session: string;
	at: number;
	decisions: InsightCardDecision[];
	lessons: InsightCardLesson[];
	teaching: boolean;
	capture: string;
	counts: { status: string; total: number }[];
	eligible: number;
	promoted: number;
	partial: boolean;
	limitations: string[];
};

function insightDecision(value: unknown): InsightCardDecision | undefined {
	if (!isRecord(value)) return undefined;
	if (!isLiteral(INSIGHT_POINTS, value.point)) return undefined;
	if (!isLiteral(INSIGHT_OUTCOMES, value.outcome)) return undefined;
	if (!isLiteral(INSIGHT_ACTIONS, value.action)) return undefined;
	const model = insightText(value.model, 40);
	let question = "";
	if (Array.isArray(value.questions) && isRecord(value.questions[0])) {
		const first = value.questions[0];
		const key = insightText(first.key, 24);
		if (key !== "" && typeof first.p === "number" && Number.isFinite(first.p)) {
			question = " · First question: " + key + " (" + formatP(first.p) + ")";
		}
	}
	return {
		point: value.point,
		outcome: value.outcome,
		model: model === "" ? "Not recorded" : model,
		action: value.action,
		question,
	};
}

function insightLesson(value: unknown): InsightCardLesson | undefined {
	if (!isRecord(value)) return undefined;
	if (typeof value.id !== "string" || value.id === "") return undefined;
	if (!isLiteral(INSIGHT_STATUSES, value.status)) return undefined;
	if (!isLiteral(INSIGHT_KINDS, value.kind)) return undefined;
	const occurrences = insightCount(value.occurrences);
	if (occurrences === undefined) return undefined;
	if (typeof value.eligible !== "boolean") return undefined;
	const name = insightText(value.name, 60);
	let promotion = "";
	if (value.promoted !== undefined) {
		if (!isRecord(value.promoted)) return undefined;
		if (!isLiteral(INSIGHT_TARGETS, value.promoted.target)) return undefined;
		const skill = insightText(value.promoted.skill, 40);
		promotion = "promoted " + (skill === "" ? "skill" : skill) + " (" + value.promoted.target + ")";
	}
	return {
		name: name === "" ? "lesson" : name,
		status: value.status,
		kind: value.kind,
		occurrences,
		eligible: value.eligible,
		promotion,
	};
}

/**
 * Validates untrusted persisted details against the exact frozen card DTO.
 * Numeric eligible/promoted are read as numbers; legacy list shapes and
 * invented aliases (title, eligibleLessons, eligibleCount, lessonSummaries)
 * are not recognized. Anything off-shape returns undefined and the caller
 * renders the bounded SAFE fallback; raw message content is never read here.
 */
function asInsightCard(details: unknown): InsightCard | undefined {
	if (!isRecord(details)) return undefined;
	if (typeof details.project !== "string" || typeof details.session !== "string") return undefined;
	if (typeof details.at !== "number" || !Number.isFinite(details.at)) return undefined;
	if (!Array.isArray(details.decisions) || !Array.isArray(details.lessons)) return undefined;
	if (!isRecord(details.policy)) return undefined;
	if (typeof details.policy.enabled !== "boolean") return undefined;
	if (!isLiteral(INSIGHT_CAPTURES, details.policy.capture)) return undefined;
	if (!isRecord(details.counts)) return undefined;
	const counts: { status: string; total: number }[] = [];
	for (const status of INSIGHT_STATUSES) {
		const total = insightCount(details.counts[status]);
		if (total === undefined) return undefined;
		if (total > 0) counts.push({ status, total });
	}
	const eligible = insightCount(details.eligible);
	const promoted = insightCount(details.promoted);
	if (eligible === undefined || promoted === undefined) return undefined;
	if (typeof details.partial !== "boolean") return undefined;
	if (!Array.isArray(details.limitations)) return undefined;
	const decisions: InsightCardDecision[] = [];
	for (const item of details.decisions) {
		const decision = insightDecision(item);
		if (decision !== undefined) decisions.push(decision);
	}
	const lessons: InsightCardLesson[] = [];
	for (const item of details.lessons) {
		const lesson = insightLesson(item);
		if (lesson !== undefined) lessons.push(lesson);
	}
	const limitations: string[] = [];
	for (const item of details.limitations) {
		const line = insightText(item, 160);
		if (line !== "") limitations.push(line);
	}
	const project = insightText(details.project, 48);
	const session = insightText(details.session, 48);
	return {
		project: project === "" ? "unavailable" : project,
		session: session === "" ? "unavailable" : session,
		at: details.at,
		decisions,
		lessons,
		teaching: details.policy.enabled,
		capture: details.policy.capture,
		counts,
		eligible,
		promoted,
		partial: details.partial,
		limitations,
	};
}

function insightRows(details: unknown, expanded: boolean, p: Paint): string[] {
	// the frame truncates every row to the room (width - 4), so the not-live marker rides on the
	// label row: after time/scope it vanishes at common widths and the card reads as live state.
	const label = p.fg("customMessageLabel", p.bold(INSIGHT_TYPE + " · captured — not live"));
	const fallback = [`${label}`, "Insight snapshot unavailable. Open /ultrathink-ui for the live view."];
	const card = asInsightCard(details);
	if (card === undefined) return fallback;
	const scopeLine =
		"Project: " +
		card.project +
		" · Session: " +
		card.session +
		" · Snapshot: " +
		new Date(card.at).toISOString();
	const latest = card.decisions[0];
	const latestLine =
		latest === undefined
			? "No saved Jev decisions for this session"
			: "Latest decision: " + latest.point + " · " + latest.outcome + " · " + latest.action;
	const first = card.lessons[0];
	const lessonLine =
		first === undefined
			? "No lessons recorded for this project"
			: "Moments: " +
				(card.lessons.length === 1 ? "1 lesson" : card.lessons.length + " lessons") +
				" · " +
				first.name +
				" · " +
				first.status;
	const autonomyLine =
		"Autonomy: " + card.eligible + " eligible · " + card.promoted + " promoted" + (card.partial ? " · partial snapshot" : "");
	if (!expanded) {
		const rows = [`${label}`, scopeLine, latestLine, lessonLine, autonomyLine];
		// Counts lead on the final row so they survive truncation: real snapshots always carry
		// limitation notes, so a separate counts row never fits the compact budget.
		const counts = card.counts.length === 0 ? "none recorded" : card.counts.map((entry) => entry.total + " " + entry.status).join(" · ");
		rows.push("Counts: " + counts + (card.limitations[0] === undefined ? "" : " · " + card.limitations[0]));
		return rows.slice(0, INSIGHT_COMPACT_ROWS);
	}
	const rows = [`${label}`, scopeLine, latestLine];
	const jevShown = card.decisions.slice(0, INSIGHT_SUMMARY_CAP);
	for (const decision of jevShown) {
		rows.push("  Jev: " + decision.point + " · " + decision.outcome + " · " + decision.action + " · " + decision.model + decision.question);
	}
	if (card.decisions.length > jevShown.length) rows.push("  " + (card.decisions.length - jevShown.length) + " more decisions — open /ultrathink-ui");
	const lessonsShown = card.lessons.slice(0, INSIGHT_SUMMARY_CAP);
	for (const lesson of lessonsShown) {
		rows.push(
			"  Lesson: " + lesson.name + " · " + lesson.status + " · " + lesson.kind + " ×" + lesson.occurrences + (lesson.promotion === "" ? "" : " · " + lesson.promotion),
		);
	}
	if (card.lessons.length > lessonsShown.length) rows.push("  " + (card.lessons.length - lessonsShown.length) + " more lessons — open /ultrathink-ui");
	const flagged = card.lessons.filter((lesson) => lesson.eligible || lesson.promotion !== "").slice(0, INSIGHT_SUMMARY_CAP);
	for (const lesson of flagged) {
		rows.push("  Skill: " + lesson.name + " · " + (lesson.promotion === "" ? "eligible by saved lesson rules" : lesson.promotion));
	}
	rows.push(autonomyLine);
	if (card.counts.length === 0) rows.push("Counts: none recorded");
	else rows.push("Counts: " + card.counts.map((entry) => entry.total + " " + entry.status).join(" · "));
	rows.push("Policy: teaching " + (card.teaching ? "on" : "off") + " · capture " + card.capture);
	for (const limitation of card.limitations.slice(0, 2)) rows.push("Limitation: " + limitation);
	return rows.slice(0, INSIGHT_EXPANDED_ROWS);
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
	pi.registerMessageRenderer(INSIGHT_TYPE, (message, options, theme) => {
		// details are untrusted persisted data: validated defensively into a
		// bounded display-only card, never throwing raw text into the host.
		try {
			const p = paint(theme);
			return card(() => insightRows(message.details, options.expanded, p), p, { border: "borderMuted", padY: 1 });
		} catch {
			return undefined;
		}
	});
}
