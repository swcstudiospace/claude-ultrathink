// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { DECISIONS_ERROR_KINDS, formatP } from "../decisions/types.ts";
import { formatModelSelection } from "../claude/output.ts";
import { type SwarmLaneCard, type SwarmSpawnCardSnapshot, type SwarmStatusCardSnapshot, type SwarmStatusLane } from "../swarm/teams.ts";
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
/** Display-only swarm card over the spawn/status lane DTOs from ../swarm/teams.ts; transcript rows stay read-only. */
export const SWARM_TYPE = "ultrathink-swarm";

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
/** Footer rows (teaching state + limitations) always kept reachable in the expanded budget. */
const INSIGHT_FOOTER_FLOOR = 4;
/** Short leading marker for snapshots whose local reads partly failed; it must survive row truncation. */
const PARTIAL_READ_WARNING = "Partial snapshot — some reads failed";

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

type InsightCardQuestion = {
	key: string;
	p: number;
};

type InsightCardDecision = {
	point: string;
	outcome: string;
	model: string;
	action: string;
	/** Recorded P; absent stays absent — never defaulted to zero. */
	p?: number;
	/** The decision's own recorded threshold; never the current policy. */
	threshold?: number;
	/** Classified failure kind; unlisted strings are dropped, never shown raw. */
	error?: string;
	latencyMs?: number;
	attempts?: number;
	at?: number;
	/** Recorded cost; rendered only when present, never as an invented zero. */
	cost?: number;
	questions: InsightCardQuestion[];
};
type InsightCardPolicy = {
	teaching: boolean;
	capture: string;
	recall: boolean;
	recallLimit: number;
	recallChars: number;
	autoPromote: boolean;
	promoteAfter: number;
	jevEnabled: boolean;
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
	policy: InsightCardPolicy;
	counts: { status: string; total: number }[];
	eligible: number;
	promoted: number;
	partial: boolean;
	limitations: string[];
};

/** Recorded 0..1 probability; anything else leaves the field unrecorded. */
function insightProbability(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1 ? value : undefined;
}

/** Non-negative finite bound for latency/cost/epoch millis; anything else leaves the field unrecorded. */
function insightMillis(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? value : undefined;
}

function insightQuestion(value: unknown): InsightCardQuestion | undefined {
	if (!isRecord(value)) return undefined;
	const key = insightText(value.key, 80);
	const p = insightProbability(value.p);
	if (key === "" || p === undefined) return undefined;
	return { key, p };
}

function insightDecision(value: unknown): InsightCardDecision | undefined {
	if (!isRecord(value)) return undefined;
	if (!isLiteral(INSIGHT_POINTS, value.point)) return undefined;
	if (!isLiteral(INSIGHT_OUTCOMES, value.outcome)) return undefined;
	if (!isLiteral(INSIGHT_ACTIONS, value.action)) return undefined;
	const model = insightText(value.model, 40);
	const questions: InsightCardQuestion[] = [];
	if (Array.isArray(value.questions)) {
		for (const item of value.questions) {
			if (questions.length >= 32) break;
			const question = insightQuestion(item);
			if (question !== undefined) questions.push(question);
		}
	}
	const decision: InsightCardDecision = {
		point: value.point,
		outcome: value.outcome,
		model: model === "" ? "Not recorded" : model,
		action: value.action,
		questions,
	};
	if (value.p !== undefined) {
		const p = insightProbability(value.p);
		if (p !== undefined) decision.p = p;
	}
	if (value.threshold !== undefined) {
		const threshold = insightProbability(value.threshold);
		if (threshold !== undefined) decision.threshold = threshold;
	}
	if (typeof value.error === "string" && (DECISIONS_ERROR_KINDS as readonly string[]).includes(value.error)) {
		decision.error = value.error;
	}
	if (value.latencyMs !== undefined) {
		const latencyMs = insightMillis(value.latencyMs);
		if (latencyMs !== undefined) decision.latencyMs = latencyMs;
	}
	if (value.attempts !== undefined && typeof value.attempts === "number" && Number.isInteger(value.attempts) && value.attempts >= 0) {
		decision.attempts = value.attempts;
	}
	if (value.at !== undefined) {
		const at = insightMillis(value.at);
		if (at !== undefined) decision.at = at;
	}
	if (value.cost !== undefined) {
		const cost = insightMillis(value.cost);
		if (cost !== undefined) decision.cost = cost;
	}
	return decision;
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
	if (typeof details.policy.recall !== "boolean") return undefined;
	const recallLimit = insightCount(details.policy.recallLimit);
	const recallChars = insightCount(details.policy.recallChars);
	const promoteAfter = insightCount(details.policy.promoteAfter);
	if (recallLimit === undefined || recallChars === undefined || promoteAfter === undefined) return undefined;
	if (typeof details.policy.autoPromote !== "boolean") return undefined;
	if (typeof details.policy.jevEnabled !== "boolean") return undefined;
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
		policy: {
			teaching: details.policy.enabled,
			capture: details.policy.capture,
			recall: details.policy.recall,
			recallLimit,
			recallChars,
			autoPromote: details.policy.autoPromote,
			promoteAfter,
			jevEnabled: details.policy.jevEnabled,
		},
		counts,
		eligible,
		promoted,
		partial: details.partial,
		limitations,
	};
}

/** Invalid epoch millis render as unavailable instead of throwing out of the card. */
function insightTimestamp(at: number | undefined): string | undefined {
	if (at === undefined) return undefined;
	const time = new Date(at).getTime();
	if (!Number.isFinite(time)) return undefined;
	return new Date(at).toISOString();
}

/** Actionable cap/read truth outranks fixed no-history boilerplate when rows are scarce. */
function isActionableLimitation(line: string): boolean {
	return /partial|showing up to|could not|excluded|omitt|more .*open|cancel/i.test(line);
}

function pickLimitations(limitations: string[], budget: number): string[] {
	if (budget <= 0) return [];
	const actionable = limitations.filter(isActionableLimitation);
	const rest = limitations.filter((line) => !isActionableLimitation(line));
	return [...actionable, ...rest].slice(0, budget);
}

/** One expanded Jev row: labeled recorded fields only, canonical truncating formatP, no invented zeroes. */
function decisionRow(decision: InsightCardDecision): string {
	const parts = [
		decision.point,
		decision.outcome,
		decision.action,
		decision.model,
		"P " + (decision.p === undefined ? "Not recorded" : formatP(decision.p)),
		"thr " + (decision.threshold === undefined ? "Not recorded" : formatP(decision.threshold)),
	];
	if (decision.error !== undefined) parts.push("err " + decision.error);
	parts.push(decision.latencyMs === undefined ? "latency Not recorded" : decision.latencyMs + "ms");
	parts.push(decision.attempts === undefined ? "attempts Not recorded" : decision.attempts + (decision.attempts === 1 ? " attempt" : " attempts"));
	if (decision.cost !== undefined) parts.push("Cost " + decision.cost);
	const first = decision.questions[0];
	if (first !== undefined) {
		const extra = decision.questions.length > 1 ? " +" + (decision.questions.length - 1) + " more" : "";
		parts.push("Q " + first.key + " (" + formatP(first.p) + ")" + extra);
	}
	const at = insightTimestamp(decision.at);
	if (at !== undefined) parts.push(at);
	return "  Jev: " + parts.join(" · ");
}

/** Wrap sanitized card metadata by terminal cells, retaining whole graphemes. */
function wrapInsightLines(lines: string[], room: number): string[] {
	const rows: string[] = [];
	const width = Math.max(1, room);
	const segments = new Intl.Segmenter(undefined, { granularity: "grapheme" });
	for (const line of lines) {
		let row = "";
		let cells = 0;
		for (const word of line.split(" ").filter(Boolean)) {
			const wordCells = visibleWidth(word);
			if (row !== "" && cells + 1 + wordCells > width) {
				rows.push(row);
				row = "";
				cells = 0;
			}
			if (row !== "") {
				row += " ";
				cells += 1;
			}
			for (const { segment } of segments.segment(word)) {
				const size = visibleWidth(segment);
				if (cells + size > width && row !== "") {
					rows.push(row);
					row = "";
					cells = 0;
				}
				const fitted = size > width ? truncateToWidth(segment, width) : segment;
				row += fitted;
				cells += visibleWidth(fitted);
			}
		}
		rows.push(row);
	}
	return rows;
}

function insightRows(details: unknown, expanded: boolean, p: Paint, room: number): string[] {
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
		(insightTimestamp(card.at) ?? "unavailable");
	const latest = card.decisions[0];
	const latestLine =
		latest === undefined
			? "No saved Jev decisions for this session"
			: "Latest decision: " +
				latest.point +
				" · " +
				latest.outcome +
				" · " +
				latest.action +
				" · P " +
				(latest.p === undefined ? "Not recorded" : formatP(latest.p));
	const first = card.lessons[0];
	const omittedLessons = Math.max(0, card.counts.reduce((total, entry) => total + entry.total, 0) - card.lessons.length);
	const lessonLine =
		first === undefined
			? "No lessons recorded for this project"
			: "Moments: " + card.lessons.length + " shown" + (omittedLessons > 0 ? " · " + omittedLessons + " omitted from card" : "") + " · " + first.name + " · " + first.status;
	const autonomyCounts = "Autonomy: " + card.eligible + " eligible · " + card.promoted + " promoted";
	const autonomySettings =
		" · capture " +
		card.policy.capture +
		" · recall " +
		(card.policy.recall ? "on (" + card.policy.recallLimit + "/" + card.policy.recallChars + ")" : "off") +
		" · auto-promote " +
		(card.policy.autoPromote ? "on" : "off") +
		" after " +
		card.policy.promoteAfter;
	// a failed read must never read as ordinary missing history: the short warning leads the row so
	// it survives truncation, while the settings trail as optional text that narrow rows may clip
	const autonomyLine = (card.partial ? PARTIAL_READ_WARNING + " · " : "") + autonomyCounts + autonomySettings;
	const countsLine =
		card.counts.length === 0
			? "Counts (shown): none recorded"
			: "Counts (shown): " + card.counts.map((entry) => entry.total + " " + entry.status).join(" · ");
	if (!expanded) {
		const rows = [`${label}`, scopeLine, latestLine, lessonLine, autonomyLine];
		// Counts lead on the final row so they survive truncation: real snapshots always carry
		// limitation notes, so a separate counts row never fits the compact budget.
		const note = pickLimitations(card.limitations, 1)[0];
		rows.push(countsLine + (note === undefined ? "" : " · " + note));
		return rows.slice(0, INSIGHT_COMPACT_ROWS);
	}
	const rows = [`${label}`, scopeLine, latestLine, lessonLine];
	const jevShown = card.decisions.slice(0, INSIGHT_SUMMARY_CAP);
	for (const decision of jevShown) rows.push(decisionRow(decision));
	if (card.decisions.length > jevShown.length) rows.push("  " + (card.decisions.length - jevShown.length) + " more decisions — open /ultrathink-ui");
	const lessonsShown = card.lessons.slice(0, INSIGHT_SUMMARY_CAP);
	for (const lesson of lessonsShown) {
		rows.push(
			"  Lesson: " + lesson.name + " · " + lesson.status + " · " + lesson.kind + " ×" + lesson.occurrences + (lesson.promotion === "" ? "" : " · " + lesson.promotion),
		);
	}
	if (card.lessons.length > lessonsShown.length) rows.push("  " + (card.lessons.length - lessonsShown.length) + " more lessons — open /ultrathink-ui");
	const flagged = card.lessons.filter((lesson) => lesson.eligible || lesson.promotion !== "");
	const skillsShown = flagged.slice(0, INSIGHT_SUMMARY_CAP);
	for (const lesson of skillsShown) {
		rows.push("  Skill: " + lesson.name + " · " + (lesson.promotion === "" ? "eligible by saved lesson rules" : lesson.promotion));
	}
	if (flagged.length > skillsShown.length) {
		rows.push("  " + (flagged.length - skillsShown.length) + " more skills omitted — open /ultrathink-ui");
	}
	// the footer autonomy row keeps the recorded counts and the partial-read warning but drops the
	// settings: the "Effective policy" row below already states them, and fewer fixed rows keep the
	// footer (teaching state + limitations) inside the expanded budget at narrow widths
	const footer = [(card.partial ? PARTIAL_READ_WARNING + " · " : "") + autonomyCounts, countsLine];
	footer.push(
		"Effective policy: teaching " +
			(card.policy.teaching ? "on" : "off") +
			" · capture " +
			card.policy.capture +
			" · recall " +
			(card.policy.recall ? "on (" + card.policy.recallLimit + "/" + card.policy.recallChars + ")" : "off") +
			" · auto-promote " +
			(card.policy.autoPromote ? "on" : "off") +
			" after " +
			card.policy.promoteAfter +
			" · Jev " +
			(card.policy.jevEnabled ? "on" : "off"),
	);
	for (const limitation of pickLimitations(card.limitations, 2)) footer.push("Limitation: " + limitation);
	const identity = [rows[0]!, ...wrapInsightLines(rows.slice(1, 4), room)];
	const detailsRows = wrapInsightLines(rows.slice(4), room);
	const footerRows = wrapInsightLines(footer, room);
	// Records keep their rows; the footer (teaching state + limitations) takes bounded leftover
	// space but always stays reachable: both bookends are capped so their sum can never overflow
	// the 24-row budget, and when that saturation would swallow omitted details entirely, one
	// row is reclaimed from the budgets for the detail-omission notice — the dashboard carries
	// the detail rows the card omits, but the omission itself is always announced here.
	const fitBookends = (reserved: number): { id: string[]; footer: string[]; available: number } => {
		let id = identity;
		const identityCap = INSIGHT_EXPANDED_ROWS - INSIGHT_FOOTER_FLOOR - reserved;
		if (id.length > identityCap) {
			const hidden = id.length - identityCap + 1;
			id = [...id.slice(0, identityCap - 1), truncateToWidth(hidden + " more record lines — open /ultrathink-ui", room)];
		}
		let booked = footerRows;
		const footerBudget = Math.max(INSIGHT_FOOTER_FLOOR, INSIGHT_EXPANDED_ROWS - reserved - id.length);
		if (booked.length > footerBudget) {
			const hidden = booked.length - footerBudget + 1;
			booked = [...booked.slice(0, footerBudget - 1), truncateToWidth(hidden + " more policy and limitation lines — open /ultrathink-ui", room)];
		}
		return { id, footer: booked, available: Math.max(0, INSIGHT_EXPANDED_ROWS - id.length - booked.length) };
	};
	let { id: shownIdentity, footer: shownFooter, available } = fitBookends(0);
	if (detailsRows.length > 0 && available === 0) ({ id: shownIdentity, footer: shownFooter, available } = fitBookends(1));
	if (detailsRows.length > available) {
		const shown = available - 1;
		const notice = (detailsRows.length - shown) + " more detail lines — open /ultrathink-ui";
		return [...shownIdentity, ...detailsRows.slice(0, shown), truncateToWidth(notice, room), ...shownFooter];
	}
	return [...shownIdentity, ...detailsRows, ...shownFooter];
}

/** Compact content rows for the swarm card; the frame truncates each row to the room. */
const SWARM_COMPACT_ROWS = 6;
/** Expanded content rows for the swarm card; the rest stays in the dashboard. */
const SWARM_EXPANDED_ROWS = 24;
/** Field caps keep one hostile lane from pushing megabytes through the sanitizer before width truncation. */
const SWARM_ID_CHARS = 48;
const SWARM_TEXT_CHARS = 160;
const SWARM_PATH_CHARS = 240;
/** Hard lane ceiling applied before validation; anything past it is counted in the omission notice instead of drawn. */
const SWARM_MAX_LANES = 64;
/** The real recovery path for hidden lanes: the text status reply lists every lane, the dashboard does not. */
const SWARM_RECOVERY = "run /ultrathink-swarm status for the full list";

/** Trailing segment of a state dir or log path; computed inline so the card needs no node:path import. */
function pathBasename(path: string): string {
	const parts = path.split(/[\\/]/).filter(Boolean);
	return parts.length === 0 ? path : parts[parts.length - 1]!;
}

/** Code-point-safe truncation, so surrogate pairs never split mid-character. */
function capPoints(text: string, maxChars: number): string {
	if (maxChars <= 0) return "";
	const points = Array.from(text);
	return points.length <= maxChars ? text : points.slice(0, maxChars).join("");
}

// Control patterns for path fields, built from code points so this source stays printable.
const PATH_ESC = String.fromCharCode(27);
const PATH_BEL = String.fromCharCode(7);
/** OSC, CSI, C1, lone ESC, bidi/invisible spoofing, and every C0 control including DEL. */
const PATH_STRIP = [
	new RegExp(`${PATH_ESC}\\][^${PATH_BEL}${PATH_ESC}]*(?:${PATH_BEL}|${PATH_ESC}\\\\)`, "g"),
	new RegExp(`${PATH_ESC}\\[[0-9;?]*[ -/]*[@-~]`, "g"),
	new RegExp(`[${String.fromCharCode(128)}-${String.fromCharCode(159)}]`, "g"),
	new RegExp(PATH_ESC, "g"),
	/[\u200e\u200f\u202a-\u202e\u2066-\u2069\u200b-\u200d\ufeff\u00ad]/g,
	/[\u0000-\u001f\u007f]/g,
];

/**
 * Copy-pasteable path text: the same terminal-control classes as the full sanitizer, stripped and
 * width-capped — but WITHOUT `redactText`, whose `$HOME` → `~` collapsing would break copied paths.
 * Recorded state dirs and log paths are host-generated; free text keeps the full sanitizer.
 */
function pathText(value: unknown, maxChars: number): string {
	if (typeof value !== "string" || value === "") return "";
	let text = value;
	for (const pattern of PATH_STRIP) text = text.replace(pattern, "");
	return capPoints(text, maxChars);
}

/** Word-wrap one sanitized row across as many physical rows as the content room needs; overlong tokens hard-break so nothing is silently cut. */
function wrapRow(text: string, room: number): string[] {
	const width = Math.max(1, room);
	const lines: string[] = [];
	let current = "";
	for (const word of text.split(" ").filter((part) => part !== "")) {
		const candidate = current === "" ? word : `${current} ${word}`;
		if (visibleWidth(candidate) <= width) {
			current = candidate;
			continue;
		}
		if (current !== "") lines.push(current);
		current = "";
		if (visibleWidth(word) <= width) {
			current = word;
			continue;
		}
		for (const point of Array.from(word)) {
			if (current !== "" && visibleWidth(`${current}${point}`) > width) {
				lines.push(current);
				current = point;
			} else {
				current = `${current}${point}`;
			}
		}
	}
	if (current !== "") lines.push(current);
	return lines;
}

/** 4× each render cap: drawn text always truncates below these bounds, so per-lane work stays proportional to what a row can show. */
const SWARM_INPUT_CHARS = { id: SWARM_ID_CHARS * 4, text: SWARM_TEXT_CHARS * 4, path: SWARM_PATH_CHARS * 4 };

/** Shallow copy of one persisted lane with every string field pre-truncated to its input bound, before validation or sanitization runs. */
function capLaneStrings(value: unknown): unknown {
	if (!isRecord(value)) return value;
	const capped: Record<string, unknown> = { ...value };
	const cap = (key: string, maxChars: number): void => {
		const field = capped[key];
		if (typeof field === "string") capped[key] = capPoints(field, maxChars);
	};
	cap("laneId", SWARM_INPUT_CHARS.id);
	cap("brief", SWARM_INPUT_CHARS.text);
	cap("summary", SWARM_INPUT_CHARS.text);
	cap("error", SWARM_INPUT_CHARS.text);
	cap("stateDir", SWARM_INPUT_CHARS.path);
	cap("logPath", SWARM_INPUT_CHARS.path);
	return capped;
}

/** Validated spawn lane; pid/error stay only when recorded, exactly as the frozen DTO carries them. */
function swarmSpawnLane(value: unknown): SwarmLaneCard | undefined {
	if (!isRecord(value)) return undefined;
	if (typeof value.laneId !== "string" || value.laneId === "") return undefined;
	if (typeof value.brief !== "string") return undefined;
	if (typeof value.stateDir !== "string" || value.stateDir === "" || typeof value.logPath !== "string") return undefined;
	const lane: SwarmLaneCard = { laneId: value.laneId, brief: value.brief, stateDir: value.stateDir, logPath: value.logPath };
	if (value.pid !== undefined) {
		if (typeof value.pid !== "number" || !Number.isInteger(value.pid) || value.pid <= 0) return undefined;
		lane.pid = value.pid;
	}
	if (value.error !== undefined) {
		if (typeof value.error !== "string") return undefined;
		lane.error = value.error;
	}
	return lane;
}

/** Validated status lane: a probed lane carries strict done/total counts; a failed probe is bare (error only). Both carry the run log path. */
function swarmStatusLane(value: unknown): SwarmStatusLane | undefined {
	if (!isRecord(value)) return undefined;
	if (typeof value.laneId !== "string" || value.laneId === "" || typeof value.summary !== "string") return undefined;
	if (typeof value.logPath !== "string") return undefined;
	if (typeof value.error === "string") return { laneId: value.laneId, summary: value.summary, logPath: value.logPath, error: value.error };
	const done = insightCount(value.done);
	const total = insightCount(value.total);
	if (done === undefined || total === undefined) return undefined;
	return { laneId: value.laneId, summary: value.summary, logPath: value.logPath, done, total };
}

/**
 * Validates untrusted persisted details against the frozen swarm card DTOs. Both snapshots share
 * the `lanes` array; a valid `spawned`/`total` pair selects the spawn snapshot, otherwise a valid
 * `omitted` selects the status one. Input is bounded before anything else runs: at most
 * {@link SWARM_MAX_LANES} lanes, each string field pre-truncated to 4× its render cap, so a hostile
 * snapshot never drives sanitizer work proportional to its size. Lanes that fail their own shape are
 * dropped silently, mirroring the insight card's per-item leniency; anything off at the top level
 * returns undefined and the caller renders the bounded SAFE fallback. Recorded text is never rewritten
 * beyond that cap — sanitization happens at draw time on every rendered row.
 */
function asSwarmCard(details: unknown): SwarmSpawnCardSnapshot | SwarmStatusCardSnapshot | undefined {
	if (!isRecord(details) || !Array.isArray(details.lanes)) return undefined;
	const spawned = insightCount(details.spawned);
	const total = insightCount(details.total);
	const lanes = details.lanes.slice(0, SWARM_MAX_LANES);
	if (spawned !== undefined && total !== undefined) {
		const cards: SwarmLaneCard[] = [];
		for (const item of lanes) {
			const lane = swarmSpawnLane(capLaneStrings(item));
			if (lane !== undefined) cards.push(lane);
		}
		return { spawned, total, lanes: cards };
	}
	const omitted = insightCount(details.omitted);
	if (omitted !== undefined) {
		const cards: SwarmStatusLane[] = [];
		for (const item of lanes) {
			const lane = swarmStatusLane(capLaneStrings(item));
			if (lane !== undefined) cards.push(lane);
		}
		return { lanes: cards, omitted };
	}
	return undefined;
}

/** Lane buckets by recorded state: done, incomplete (anything not proven done), empty (zero recorded tasks), or failed probe; the buckets always sum to the lane count. */
function swarmStatusCounts(lanes: readonly SwarmStatusLane[]): string {
	const failed = lanes.filter((lane) => "error" in lane).length;
	const empty = lanes.filter((lane) => !("error" in lane) && lane.total === 0).length;
	const done = lanes.filter((lane) => !("error" in lane) && lane.total > 0 && lane.done >= lane.total).length;
	const incomplete = lanes.length - done - failed - empty;
	const parts: string[] = [];
	if (done > 0) parts.push(`${done} done`);
	if (incomplete > 0) parts.push(`${incomplete} incomplete`);
	if (empty > 0) parts.push(`${empty} empty`);
	if (failed > 0) parts.push(`${failed} failed`);
	return parts.join(" · ");
}

/** One compact row per lane; compact rows trade full paths for the state dir basename. */
function swarmCompactRow(lane: SwarmLaneCard | SwarmStatusLane): string {
	const id = insightText(lane.laneId, SWARM_ID_CHARS);
	if ("brief" in lane) {
		const lead = insightText(lane.error ?? lane.brief, SWARM_TEXT_CHARS);
		return [id, lead, pathBasename(pathText(lane.stateDir, SWARM_PATH_CHARS))].filter((part) => part !== "").join(" · ");
	}
	if ("error" in lane) return [id, insightText(lane.error, SWARM_TEXT_CHARS)].filter((part) => part !== "").join(" · ");
	return [id, `${lane.done}/${lane.total} done`, insightText(lane.summary, SWARM_TEXT_CHARS)].filter((part) => part !== "").join(" · ");
}

/**
 * Expanded rows for one lane, wrapped to the content room so every field stays reachable instead of
 * being cut at the frame border: a heading (id, plus the pid for spawned lanes), the brief/summary or
 * failure wrapped over as many rows as it needs, then the state dir and the run log path — the two
 * fields that must stay copy-pasteable, so they use the light path sanitizer, not the full one.
 */
function swarmLaneExpandedRows(lane: SwarmLaneCard | SwarmStatusLane, room: number): string[] {
	if ("brief" in lane) {
		const id = insightText(lane.laneId, SWARM_ID_CHARS);
		const heading = [id, lane.pid === undefined ? "" : `pid ${lane.pid}`].filter((part) => part !== "").join(" · ");
		const lead = insightText(lane.error ?? lane.brief, SWARM_TEXT_CHARS);
		return [heading, ...wrapRow(lead, room), pathText(lane.stateDir, SWARM_PATH_CHARS), `log ${pathText(lane.logPath, SWARM_PATH_CHARS)}`].filter((row) => row !== "");
	}
	const id = insightText(lane.laneId, SWARM_ID_CHARS);
	if ("error" in lane) {
		return [id, ...wrapRow(insightText(lane.error, SWARM_TEXT_CHARS), room), `log ${pathText(lane.logPath, SWARM_PATH_CHARS)}`].filter((row) => row !== "");
	}
	const heading = [id, `${lane.done}/${lane.total} done`].filter((part) => part !== "").join(" · ");
	return [heading, ...wrapRow(insightText(lane.summary, SWARM_TEXT_CHARS), room), `log ${pathText(lane.logPath, SWARM_PATH_CHARS)}`].filter((row) => row !== "");
}

function swarmRows(details: unknown, expanded: boolean, p: Paint, room: number): string[] {
	const label = p.fg("customMessageLabel", p.bold(SWARM_TYPE));
	const fallback = [`${label}`, "Swarm lanes — details unavailable. Run /ultrathink-swarm status for the full list."];
	const swarm = asSwarmCard(details);
	if (swarm === undefined) return fallback;
	const omitted = "omitted" in swarm ? swarm.omitted : 0;
	// a zero-lane report is a real state, not an empty frame: one bounded content row names it
	if (swarm.lanes.length === 0) {
		return omitted === 0 ? ["No swarm lanes"] : ["No swarm lanes", `${omitted} older lanes not shown`];
	}
	const counts = "spawned" in swarm ? `${swarm.spawned}/${swarm.total} lanes spawned` : swarmStatusCounts(swarm.lanes);
	// counts — and any omission notice — lead so they survive truncation before the per-lane rows
	const head = [`${label}`, counts];
	if (omitted > 0) head.push(`${omitted} older lanes not shown`);
	if (!expanded) {
		// compact budget: lanes dropped by the row cap are counted in a notice, never silently sliced
		const budget = Math.max(0, SWARM_COMPACT_ROWS - head.length);
		const reserve = swarm.lanes.length > budget ? 1 : 0; // the notice row itself
		const shown = Math.max(0, budget - reserve);
		const dropped = Math.max(0, swarm.lanes.length - shown);
		const rows = [...head, ...swarm.lanes.slice(0, shown).map(swarmCompactRow)];
		if (dropped > 0) rows.push(`${dropped} more lanes not shown — ${SWARM_RECOVERY}`);
		return rows;
	}
	// expanded: each lane wraps to the physical rows it needs; one row stays reserved for the
	// overflow notice whenever any lane would be dropped, so the notice always fits the budget
	const rows = [...head];
	let shown = 0;
	while (shown < swarm.lanes.length) {
		const laneRows = swarmLaneExpandedRows(swarm.lanes[shown]!, room);
		const spare = shown + 1 < swarm.lanes.length ? 1 : 0;
		if (rows.length + laneRows.length > SWARM_EXPANDED_ROWS - spare) break;
		rows.push(...laneRows);
		shown += 1;
	}
	if (shown < swarm.lanes.length) rows.push(`${shown} of ${swarm.lanes.length} lanes shown — ${SWARM_RECOVERY}`);
	return rows;
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
			return card((room) => insightRows(message.details, options.expanded, p, room), p, { border: "borderMuted", padY: options.expanded ? 1 : 0 });
		} catch {
			return undefined;
		}
	});
	pi.registerMessageRenderer(SWARM_TYPE, (message, options, theme) => {
		// details are untrusted persisted data: validated defensively into a
		// bounded display-only card, never throwing raw text into the host.
		try {
			const p = paint(theme);
			return card((room) => swarmRows(message.details, options.expanded, p, room), p, { border: "borderMuted", padY: options.expanded ? 1 : 0 });
		} catch {
			return undefined;
		}
	});
}
