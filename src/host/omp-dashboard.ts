import { formatP as formatDecisionP } from "../decisions/types.ts";
import { sanitizeInsightText } from "./omp-insights.ts";
import { truncateToWidth, visibleWidth } from "./omp-paint.ts";
import type {
	InsightActionResult,
	InsightDecision,
	InsightLesson,
	InsightSnapshot,
	LessonSelection,
	SkillPreview,
} from "./omp-insights.ts";
export type InsightPanel = "overview" | "jev" | "moments" | "skills";
export const PANELS: readonly InsightPanel[] = ["overview", "jev", "moments", "skills"];

export interface InsightDashboardCallbacks {
	refresh(): Promise<InsightSnapshot>;
	confirmCandidate(selection: LessonSelection): Promise<InsightActionResult>;
	previewSkill(selection: LessonSelection): Promise<InsightActionResult>;
	installPreview(preview: SkillPreview, confirmed: boolean): Promise<InsightActionResult>;
	publishCard(snapshot: InsightSnapshot): Promise<InsightActionResult>;
	close(): void;
}

export interface InsightDashboardOptions {
	theme: unknown;
	requestRender?: () => void;
	rows?: () => number | undefined;
	initialPanel?: InsightPanel;
}

export interface InsightDashboard {
	render(width: number): readonly string[];
	invalidate(): void;
	handleInput(data: unknown): void;
	dispose(): void;
}

const LIST_WINDOW = 12;
const DETAIL_WINDOW = 16;
const COLLECTION_CAP = 100;
const PREVIEW_MAX_BYTES = 60_000;
const MIN_MUTATE_COLS = 24;
const MIN_MUTATE_ROWS = 8;
const MIN_TAB_STRIP_COLS = 32;
const TAB_LABELS: Record<InsightPanel, string> = {
	overview: "Overview",
	jev: "Jev",
	moments: "Moments",
	skills: "Skills",
};

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const ENCODER = new TextEncoder();

/** Terminal text intake uses the read-model sanitizer (controls → redaction → cap); presentation only folds layout whitespace. */
function cleanText(value: unknown, maxChars: number): string {
	return sanitizeInsightText(value, { multiline: true, maxChars });
}

/** Single-line shell label: shared sanitizer, then inline whitespace folded. */
function cleanInline(value: unknown, maxChars = 160): string {
	return sanitizeInsightText(value, { maxChars }).replace(/[^\S ]+/g, " ").trim();
}




function asFiniteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function utf8Bytes(text: string): number {
	try {
		return ENCODER.encode(text).length;
	} catch {
		return text.length;
	}
}

/** Grapheme-safe byte cap for draft preview text. */
function capBytes(text: string, maxBytes: number): { text: string; clipped: boolean } {
	if (utf8Bytes(text) <= maxBytes) return { text, clipped: false };
	let kept = "";
	let used = 0;
	for (const segment of GRAPHEMES.segment(text)) {
		const size = utf8Bytes(segment.segment);
		if (used + size > maxBytes) break;
		kept += segment.segment;
		used += size;
	}
	return { text: kept, clipped: true };
}

/** Guarded dashboard probability wrapper: non-finite intake stays unrecorded; finite values reuse the canonical domain helper. */
function formatP(value: unknown): string | undefined {
	if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
	return formatDecisionP(value);
}

function formatTime(value: unknown): string {
	if (typeof value === "number" && Number.isFinite(value)) {
		try {
			return new Date(value).toISOString();
		} catch {
			return "Not recorded";
		}
	}
	if (typeof value === "string" && value !== "") return cleanInline(value, 40);
	return "Not recorded";
}

type DecisionRow = {
	key: string;
	point: string;
	action: string;
	outcome: string;
	model: string;
	pText: string;
	failure: string;
	at: number;
	source: InsightDecision;
};

function toDecisionRows(snapshot: InsightSnapshot): DecisionRow[] {
	const out: DecisionRow[] = [];
	const decisions = Array.isArray(snapshot.decisions) ? snapshot.decisions : [];
	for (const raw of decisions.slice(0, COLLECTION_CAP)) {
		const point = cleanInline(raw.point, 120);
		if (point === "") continue;
		out.push({
			key: `${point}|${String(raw.at)}|${out.length}`,
			point,
			action: cleanInline(raw.action, 80) || "Not recorded",
			outcome: cleanInline(raw.outcome, 40) || "Not recorded",
			model: cleanInline(raw.model, 80) || "Not recorded",
			pText: formatP(raw.p) ?? "Not recorded",
			failure:
				cleanInline(raw.error, 120) ||
				(raw.outcome === "error" ? "error" : ""),
			at: raw.at,
			source: raw,
		});
		if (out.length >= COLLECTION_CAP) break;
	}
	return out;
}

type LessonRow = {
	id: string;
	title: string;
	status: string;
	kind: string;
	occurrences: number | undefined;
	eligible: boolean;
	promoted: boolean;
	source: InsightLesson;
};

function toLessonRows(snapshot: InsightSnapshot): LessonRow[] {
	const out: LessonRow[] = [];
	const lessons = Array.isArray(snapshot.lessons) ? snapshot.lessons : [];
	for (const raw of lessons.slice(0, COLLECTION_CAP)) {
		if (raw.id === "") continue;
		out.push({
			id: raw.id,
			title: cleanInline(raw.name, 120) || raw.id,
			status: cleanInline(raw.status, 24) || "unknown",
			kind: cleanInline(raw.kind, 24) || "Not recorded",
			occurrences: raw.occurrences,
			eligible: raw.eligible,
			promoted: raw.promoted !== undefined,
			source: raw,
		});
		if (out.length >= COLLECTION_CAP) break;
	}
	return out;
}

function lessonSelection(row: LessonRow): LessonSelection {
	const selection = row.source.selection;
	if (selection && selection.id === row.id) return { id: selection.id, revision: selection.revision };
	return { id: row.id, revision: "" };
}

type DashboardAction = { id: string; label: string; mutating: boolean; enabled: boolean; disabledReason?: string };

type FocusRegion = "tabs" | "list" | "details" | "actions";
type ViewKind = "browse" | "detail" | "preview" | "confirm-candidate" | "confirm-install";

// The host delivers raw terminal bytes to handleInput (data: string).
// Decode the same wire protocols the host key matcher understands — legacy
// xterm, SS3 application-cursor, CSI-u/Kitty, and modifyOtherKeys — without
// importing the host runtime. Releases never act; modified keys (ctrl/alt or
// shift beyond shift+tab) never act either.
const CSI_U = /^\x1b\[(\d+)((?::\d+)*)(?:;(\d+)((?::\d+)*))?u$/;
const LEGACY_ARROW = /^\x1b\[(?:1;(\d+))?([ABCD])$/;
const LEGACY_TILDE = /^\x1b\[([2356])(?:;(\d+))?~$/;
const LEGACY_SS3 = /^\x1bO([ABCD])$/;
const MODIFY_OTHER = /^\x1b\[27;(\d+);(\d+)~$/;
const KEY_RELEASE = /^\x1b\[[\d:;]*:3[u~A-Z]$/;

function modifierBits(modifier: string | undefined): number {
	if (modifier === undefined) return 0;
	const value = Number.parseInt(modifier, 10);
	if (!Number.isFinite(value) || value < 1) return -1;
	return (value - 1) & 7;
}

function unmodifiedKey(code: number, bits: number): string | undefined {
	if (bits !== 0) return undefined;
	if (code === 9) return "tab";
	if (code === 13) return "enter";
	if (code === 27) return "escape";
	return undefined;
}

function normalizeKey(data: unknown): string | undefined {
	if (typeof data !== "string" || data === "") return undefined;
	if (KEY_RELEASE.test(data)) return undefined;
	if (data === "\t") return "tab";
	if (data === "\x1b[Z" || data === "\x1b[1;2Z") return "shift-tab";
	if (data === "\r" || data === "\n" || data === "\x1bOM") return "enter";
	if (data === "\x1b") return "escape";
	const csiU = CSI_U.exec(data);
	if (csiU) {
		// Press (:1), repeat (:2), or absent event types act; release (:3) never does.
		if (/(^|:)3($|:)/.test(csiU[4] ?? "")) return undefined;
		const code = Number.parseInt(csiU[1] ?? "0", 10);
		const bits = modifierBits(csiU[3]);
		if (bits < 0) return undefined;
		if (code === 9) {
			if (bits === 0) return "tab";
			if (bits === 1) return "shift-tab";
			return undefined;
		}
		return unmodifiedKey(code, bits);
	}
	const modifyOther = MODIFY_OTHER.exec(data);
	if (modifyOther) {
		const bits = modifierBits(modifyOther[1]);
		const code = Number.parseInt(modifyOther[2] ?? "0", 10);
		if (bits < 0) return undefined;
		if (code === 9) {
			if (bits === 0) return "tab";
			if (bits === 1) return "shift-tab";
			return undefined;
		}
		return unmodifiedKey(code, bits);
	}
	const legacy = LEGACY_ARROW.exec(data);
	if (legacy) {
		if (modifierBits(legacy[1]) !== 0) return undefined;
		if (legacy[2] === "A") return "up";
		if (legacy[2] === "B") return "down";
		if (legacy[2] === "C") return "right";
		if (legacy[2] === "D") return "left";
		return undefined;
	}
	const ss3 = LEGACY_SS3.exec(data);
	if (ss3) {
		if (ss3[1] === "A") return "up";
		if (ss3[1] === "B") return "down";
		if (ss3[1] === "C") return "right";
		if (ss3[1] === "D") return "left";
		return undefined;
	}
	const tilde = LEGACY_TILDE.exec(data);
	if (tilde) {
		if (modifierBits(tilde[2]) !== 0) return undefined;
		if (tilde[1] === "5") return "pageup";
		if (tilde[1] === "6") return "pagedown";
		return undefined;
	}
	if (data === "r") return "r";
	if (data.length === 1) return undefined;
	switch (data.toLowerCase()) {
		case "tab":
		case "shift-tab":
		case "shift+tab":
		case "up":
		case "down":
		case "left":
		case "right":
		case "enter":
		case "escape":
		case "esc":
		case "q":
		case "pageup":
		case "pagedown":
			return data.toLowerCase() === "esc" ? "escape" : data.toLowerCase();
		default:
			return undefined;
	}
}

export function createInsightDashboard(
	initial: InsightSnapshot,
	callbacks: InsightDashboardCallbacks,
	options: InsightDashboardOptions,
): InsightDashboard {
	let snapshot: InsightSnapshot = initial;
	let disposed = false;
	let seq = 0;
	let viewOpenedAtSeq = -1;
	let epoch = 0;

	let tab: InsightPanel = options.initialPanel && PANELS.includes(options.initialPanel) ? options.initialPanel : "overview";
	let focus: FocusRegion = "tabs";
	let view: ViewKind = "browse";
	const cursors: Record<InsightPanel, number> = { overview: 0, jev: 0, moments: 0, skills: 0 };
	const actionCursor: Record<string, number> = {};
	const selectedKeys: Record<InsightPanel, string | undefined> = {
		overview: undefined,
		jev: undefined,
		moments: undefined,
		skills: undefined,
	};
	let detailScroll = 0;
	let previewScroll = 0;
	let notice = "";
	// True while the follow-up refresh owned by a settled confirm/install is in
	// flight. The receipt in `notice` survives that refresh (busy render,
	// success, failure, or disappeared selection); the next explicit manual
	// refresh clears it as obsolete. Boring boolean, no timers or history.
	let actionRefresh = false;
	let snapshotError = "";
	let busy: { kind: "refresh" | "preview" | "confirm" | "install"; label: string } | undefined;
	let busyCancelled = false;
	let pendingPreview: SkillPreview | undefined;
	let confirmTarget: LessonRow | undefined;

	let cachedKey = "";
	let cachedRows: string[] = [];

	const requestRender = (): void => {
		try {
			options.requestRender?.();
		} catch {
			// Host redraw is best-effort; state already advanced.
		}
	};
	const touch = (): void => {
		cachedKey = "";
		requestRender();
	};

	const viewportHeight = (): number => {
		try {
			const rows = options.rows?.() ?? 40;
			return Number.isFinite(rows) && rows > 0 ? Math.floor(rows) : 40;
		} catch {
			return 40;
		}
	};

	const decisions = (): DecisionRow[] => {
		try {
			return toDecisionRows(snapshot);
		} catch {
			return [];
		}
	};
	const lessons = (): LessonRow[] => {
		try {
			return toLessonRows(snapshot);
		} catch {
			return [];
		}
	};
	const skillRows = (): LessonRow[] => {
		const all = lessons();
		const flagged = all.filter((row) => row.eligible || row.promoted);
		return flagged.length > 0 ? flagged : [];
	};

	const listRows = (panel: InsightPanel): { key: string; label: string }[] => {
		if (panel === "jev") {
			return decisions().map((row) => ({
				key: row.key,
				label: `${row.point} · ${row.action}${row.pText !== "Not recorded" ? ` · P ${row.pText}` : ""}${row.failure ? ` · ${row.failure}` : ""}`,
			}));
		}
		if (panel === "moments") {
			return lessons().map((row) => ({
				key: row.id,
				label: `${row.title} · ${row.status}${row.occurrences !== undefined ? ` · ×${row.occurrences}` : ""}`,
			}));
		}
		if (panel === "skills") {
			return skillRows().map((row) => ({
				key: row.id,
				label: `${row.promoted ? "promoted" : "eligible"} · ${row.title}`,
			}));
		}
		return [];
	};

	const selectedRow = (panel: InsightPanel): { key: string; label: string } | undefined => {
		const rows = listRows(panel);
		if (rows.length === 0) return undefined;
		const key = selectedKeys[panel];
		if (key !== undefined) {
			const match = rows.find((row) => row.key === key);
			if (match) return match;
		}
		const cursor = Math.min(Math.max(0, cursors[panel]), rows.length - 1);
		return rows[cursor];
	};

	const syncSelection = (panel: InsightPanel): void => {
		const rows = listRows(panel);
		if (rows.length === 0) {
			cursors[panel] = 0;
			selectedKeys[panel] = undefined;
			return;
		}
		const key = selectedKeys[panel];
		if (key !== undefined) {
			const index = rows.findIndex((row) => row.key === key);
			if (index >= 0) {
				cursors[panel] = index;
				return;
			}
		}
		cursors[panel] = Math.min(Math.max(0, cursors[panel]), rows.length - 1);
		selectedKeys[panel] = rows[cursors[panel]]?.key;
	};

	const canMutate = (width: number): boolean => width >= MIN_MUTATE_COLS && viewportHeight() >= MIN_MUTATE_ROWS;

	const actions = (width: number): DashboardAction[] => {
		const tiny = !canMutate(width);
		const tinyReason = "Terminal too small to review an action. Resize to at least 24 columns and 8 rows; browsing and Escape remain available.";
		const gate = (action: DashboardAction): DashboardAction =>
			action.mutating && tiny ? { ...action, enabled: false, disabledReason: tinyReason } : action;
		if (view === "confirm-candidate") {
			return [
				{ id: "keep", label: "Keep candidate", mutating: false, enabled: true },
				gate({ id: "confirm-yes", label: "Confirm candidate", mutating: true, enabled: !busy }),
			];
		}
		if (view === "confirm-install") {
			return [
				{ id: "keep", label: "Keep preview", mutating: false, enabled: true },
				gate({ id: "install-yes", label: "Install into Omp", mutating: true, enabled: !busy }),
			];
		}
		if (view === "preview") {
			return [
				{ id: "back", label: "Back to lesson", mutating: false, enabled: true },
				gate({ id: "open-install", label: "Install into Omp", mutating: true, enabled: !busy }),
			];
		}
		if (view === "detail") {
			const base: DashboardAction[] = [{ id: "back", label: "Back to list", mutating: false, enabled: true }];
			if (tab === "moments" || tab === "skills") {
				const row = currentLesson();
				if (row?.status === "candidate" && tab === "moments") {
					base.push(gate({ id: "open-confirm", label: "Confirm candidate", mutating: true, enabled: !busy }));
				} else if (row?.eligible && !row.promoted) {
					base.push(gate({ id: "open-preview", label: "Preview skill draft", mutating: false, enabled: !busy }));
				}
			}
			if (tab === "jev") base.push({ id: "refresh", label: "Refresh snapshot", mutating: false, enabled: !busy });
			return base;
		}
		if (tab === "overview") {
			return [
				{ id: "nav-jev", label: "Open Jev details", mutating: false, enabled: true },
				{ id: "nav-moments", label: "Open Moments", mutating: false, enabled: true },
				{ id: "nav-skills", label: "Open Skills", mutating: false, enabled: true },
				{ id: "refresh", label: "Refresh snapshot", mutating: false, enabled: !busy },
			];
		}
		if (tab === "jev") {
			const rows = listRows(tab);
			const list: DashboardAction[] = [];
			if (rows.length > 0) list.push({ id: "open-detail", label: "View decision details", mutating: false, enabled: true });
			list.push({ id: "refresh", label: "Refresh snapshot", mutating: false, enabled: !busy });
			return list;
		}
		const rows = listRows(tab);
		const list: DashboardAction[] = [];
		if (rows.length > 0) {
			list.push({
				id: "open-detail",
				label: "View lesson details",
				mutating: false,
				enabled: true,
			});
		}
		list.push({ id: "refresh", label: "Refresh snapshot", mutating: false, enabled: !busy });
		return list;
	};

	const currentLesson = (): LessonRow | undefined => {
		const key = selectedKeys[tab];
		const all = tab === "skills" ? skillRows() : lessons();
		if (key === undefined) return all[0];
		return all.find((row) => row.id === key) ?? all[0];
	};

	const currentDecision = (): DecisionRow | undefined => {
		const key = selectedKeys.jev;
		const all = decisions();
		if (key === undefined) return all[0];
		return all.find((row) => row.key === key) ?? all[0];
	};

	const focusable = (): FocusRegion[] => {
		const regions: FocusRegion[] = ["tabs"];
		// Below the mutation floor, rows are too truncated to act on as identity:
		// the list is not a focus stop; browsing continues through the action strip.
		if (view === "browse" && (tab === "jev" || tab === "moments" || tab === "skills") && listRows(tab).length > 0 && canMutate(lastWidth)) {
			regions.push("list");
		}
		if (view === "detail" || view === "preview") regions.push("details");
		if (actions(lastWidth).length > 0) regions.push("actions");
		return regions;
	};

	let lastWidth = 80;

	const clampScroll = (value: number, total: number, windowSize: number): number =>
		Math.min(Math.max(0, value), Math.max(0, total - windowSize));

	const openDetail = (): void => {
		const row = selectedRow(tab);
		if (!row) return;
		view = "detail";
		viewOpenedAtSeq = seq;
		detailScroll = 0;
		focus = "details";
		touch();
	};

	const openView = (kind: ViewKind, keepFocus: FocusRegion): void => {
		view = kind;
		viewOpenedAtSeq = seq;
		detailScroll = 0;
		previewScroll = 0;
		focus = keepFocus;
		touch();
	};

	const closeToBrowse = (): void => {
		view = "browse";
		pendingPreview = undefined;
		confirmTarget = undefined;
		detailScroll = 0;
		previewScroll = 0;
		syncSelection(tab);
		focus = listRows(tab).length > 0 && tab !== "overview" && canMutate(lastWidth) ? "list" : "tabs";
		touch();
	};

	const snapshotLabel = (): string => {
		const project = cleanInline(snapshot.project, 48) || "unavailable";
		const session = cleanInline(snapshot.session, 48) || "unavailable";
		return `Host: Omp | Project: ${project} | Session: ${session}`;
	};

	const snapshotTime = (): string => formatTime(snapshot.at);

	const policyLines = (): string[] => {
		const policy = snapshot.policy;
		if (!policy || !policy.enabled) return ["Teaching is off. Saved lessons remain readable; confirmation, preview, and installation are unavailable."];
		const lines: string[] = [];
		const capture = cleanInline(policy.capture, 24);
		lines.push(
			`Capture: ${capture || "Not recorded"} · Recall: ${policy.recall ? `enabled (limit ${policy.recallLimit})` : "disabled"} · Auto-promotion: ${policy.autoPromote ? "enabled" : "disabled"} · Threshold: ${policy.promoteAfter}`,
		);
		if (!policy.jevEnabled) {
			lines.push("Jev is off for current policy. Recorded past decisions remain readable; this view performs no evaluation.");
		}
		return lines;
	};

	const detailLines = (): string[] => {
		if (tab === "jev") {
			const row = currentDecision();
			if (!row) return [];
			const source = row.source;
			const lines = [
				`Point: ${row.point}`,
				`Outcome: ${row.outcome}`,
				`Action: ${row.action}`,
				`Model: ${row.model}`,
				`Settled: ${formatTime(source.at)}`,
			];
			const threshold = formatP(source.threshold) ?? "Not recorded";
			const questions = source.questions.slice(0, COLLECTION_CAP);
			if (questions.length > 0) {
				lines.push("Recorded question probabilities:");
				for (const question of questions) {
					const label = cleanInline(question.key, 100);
					const p = formatP(question.p);
					if (label === "") continue;
					lines.push(`  ${label} · P ${p ?? "Not recorded"}`);
				}
			} else {
				lines.push(`P: ${row.pText} · Threshold: ${threshold}`);
			}
			if (questions.length > 0) lines.push(`Threshold: ${threshold}`);
			const latency = source.latencyMs;
			const attempts = source.attempts;
			if (latency !== undefined || attempts !== undefined) {
				lines.push(
					`Latency: ${latency !== undefined ? `${latency} ms` : "Not recorded"} · Attempts: ${attempts !== undefined ? String(attempts) : "Not recorded"}`,
				);
			}
			if (source.cost !== undefined) lines.push(`Cost: ${String(source.cost)}`);
			if (row.failure) lines.push(`Failure: ${row.failure}`);
			return lines;
		}
		const row = currentLesson();
		if (!row) return [];
		const source = row.source;
		const lines = [
			`Title: ${row.title}`,
			`Id: ${cleanInline(row.id, 120)}`,
			`Lifecycle: ${row.status} · Kind: ${row.kind}${row.occurrences !== undefined ? ` · Occurrences: ${row.occurrences}` : ""}`,
			`Description: ${cleanInline(source.description, 400) || "Not recorded"}`,
		];
		const body = cleanText(source.body, 4000);
		if (body) {
			lines.push("Body:");
			for (const chunk of body.split("\n").slice(0, 64)) lines.push(`  ${cleanInline(chunk, 200)}`);
		}
		const origin = cleanInline(source.origin, 60);
			const host = cleanInline(source.host, 60);
		if (origin || host) lines.push(`Provenance: ${[origin, host ? `host ${host}` : ""].filter(Boolean).join(" · ") || "Not recorded"}`);
		const phase = cleanInline(source.sourcePhase, 60);
			const artifacts = Array.isArray(source.sourceArtifacts) ? source.sourceArtifacts : [];
		if (phase || artifacts.length > 0) {
			const shown = artifacts
				.slice(0, 8)
				.map((item) => cleanInline(item, 80))
				.filter(Boolean);
			const omitted = artifacts.length - shown.length;
			lines.push(`Sources: ${[phase, ...shown].filter(Boolean).join(" · ") || "Not recorded"}${omitted > 0 ? ` · ${omitted} more` : ""}`);
		}
		lines.push(`Created: ${formatTime(source.createdAt)} · Last seen: ${formatTime(source.lastSeenAt)}`);
			const recalled = source.recalled;
		if (recalled !== undefined) lines.push(`Stored recall count: ${recalled}`);
			const related = Array.isArray(source.relatedIds) ? source.relatedIds : [];
			const supersedes = source.supersedes === undefined ? [] : [source.supersedes];
			if (related.length > 0 || supersedes.length > 0) {
				lines.push(
					`Related: ${related.map((item) => cleanInline(item, 48)).filter(Boolean).join(", ") || "none"} · Supersedes: ${supersedes.map((item) => cleanInline(item, 48)).filter(Boolean).join(", ") || "none"}`,
				);
			}
		const promotion = source.promoted;
		if (promotion) {
			lines.push(
				`Promotion recorded — current installation not verified · Skill: ${cleanInline(promotion.skill, 80) || "Not recorded"} · Target: ${cleanInline(promotion.target, 24) || "Not recorded"} · At: ${formatTime(promotion.at)}${promotion.path ? ` · Path: ${cleanInline(promotion.path, 100)}` : ""}`,
			);
		} else if (row.eligible) {
			lines.push("Eligible by saved lesson rules — not a new Jev verdict");
		}
		return lines;
	};

	const previewLines = (): { lines: string[]; total: number; clipped: boolean } => {
		if (!pendingPreview) {
			return { lines: ["Preview unavailable. Go back and preview again."], total: 1, clipped: false };
		}
		const preview: SkillPreview = pendingPreview;
		const name = cleanInline(preview.name, 100) || "Not recorded";
		const description = cleanInline(preview.description, 300) || "Not recorded";
		const warnings = preview.warnings
			.map((item) => cleanInline(item, 160))
			.filter(Boolean)
			.slice(0, 8);
		const sourceId = cleanInline(preview.selection.id, 120);
		const { text, clipped } = capBytes(cleanText(preview.content, 200_000), PREVIEW_MAX_BYTES);
		const contentLines = text.split("\n");
		const header = [
			"Preview only — not installed. Deterministic content from the selected lesson.",
			`Draft: ${name} · Source: ${sourceId || "Not recorded"} · Target: Omp`,
			`Description: ${description}`,
			"Terminal controls are removed from this display; existing draft redaction warnings are shown below.",
		];
		const warningLines = warnings.map((warning) => `Warning: ${warning}`);
		if (clipped) warningLines.push("Preview clipped at the 60KB bound; install reviews the complete regenerated draft.");
		return {
			lines: [...header, ...warningLines, "---", ...contentLines.map((line) => cleanInline(line, 400))],
			total: contentLines.length,
			clipped,
		};
	};

	const panelEmptyCopy = (panel: InsightPanel): string[] => {
		switch (panel) {
			case "jev":
				return ["No saved Jev decisions for this session", "This view reads the latest saved plan, not a complete history. Refresh after a plan is saved; opening this view never evaluates Jev."];
			case "moments":
				return ["No lessons recorded for this project", "Use the existing teaching workflow to capture a lesson, then refresh. This view does not create the store or capture lessons."];
			case "skills":
				return ["No lessons meet the promotion rules", "Eligible lessons are confirmed and unpromoted, with the configured occurrence count or playbook exception. Refresh after lesson state changes."];
			default:
				return [];
		}
	};

	const overviewLines = (): string[] => {
		const decisionList = decisions();
		const lessonList = lessons();
		const lines = [snapshotLabel(), `Snapshot: ${snapshotTime()}`];
		if (decisionList.length === 0) {
			lines.push("No saved Jev decisions for this session");
			lines.push("This view reads the latest saved plan, not a complete history. Refresh after a plan is saved; opening this view never evaluates Jev.");
		} else {
			const latest = decisionList[0];
			if (latest) {
				lines.push(`Latest decision: ${truncateGraphemes(latest.point, 60)} · ${latest.action} · P ${latest.pText}`);
			}
		}
		const parts = Object.entries(snapshot.counts)
			.slice(0, 8)
			.map(([status, value]) => `${cleanInline(status, 20)}: ${asFiniteNumber(value) ?? 0}`);
		lines.push(`Moments: ${parts.join(" · ") || `${lessonList.length} shown`}`);
		lines.push(`Skills: ${snapshot.eligible} eligible · ${snapshot.promoted} promoted`);
		lines.push(...policyLines());
		const limitations = snapshot.limitations.map((item) => cleanInline(item, 160)).filter(Boolean).slice(0, 4);
		for (const limitation of limitations) lines.push(`Limitation: ${limitation}`);
		if (snapshot.partial) lines.push("Partial snapshot — some local data could not be read. Available records remain visible; press r to refresh.");
		return lines;
	};

	const wrapRow = (text: string, width: number, indent: string): string[] => {
		const room = Math.max(1, width);
		const words = text.split(" ").filter((part) => part !== "");
		const lines: string[] = [];
		let current = indent;
		for (const word of words) {
			const candidate = current === indent ? `${indent}${word}` : `${current} ${word}`;
			if (visibleWidth(candidate) <= room) {
				current = candidate;
				continue;
			}
			if (current !== indent) lines.push(current);
			if (visibleWidth(`${indent}${word}`) <= room) {
				current = `${indent}${word}`;
				continue;
			}
			// Hard-break unbroken text on grapheme boundaries without splitting cells.
			let piece = indent;
			for (const segment of GRAPHEMES.segment(word)) {
				const next = `${piece}${segment.segment}`;
				if (visibleWidth(next) > room && piece !== indent) {
					lines.push(piece);
					piece = `${indent}${segment.segment}`;
				} else {
					piece = next;
				}
			}
			current = piece;
		}
		if (current !== indent || lines.length === 0) lines.push(current);
		return lines;
	};

	function truncateGraphemes(text: string, max: number): string {
		let kept = "";
		let count = 0;
		for (const segment of GRAPHEMES.segment(text)) {
			if (count >= max) return `${kept}…`;
			kept += segment.segment;
			count += 1;
		}
		return kept;
	}

	const fitRow = (text: string, width: number): string => {
		if (width <= 0) return "";
		return truncateToWidth(text, width);
	};

	const renderInto = (width: number): string[] => {
		const safeWidth = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
		if (safeWidth <= 0) return [];
		const rows: string[] = [];
		const push = (text: string): void => {
			rows.push(fitRow(text, safeWidth));
		};
		const pushWrapped = (text: string, indent = ""): void => {
			for (const line of wrapRow(text, safeWidth, indent)) push(line);
		};

		push(`Ultrathink · ${snapshotLabel()} · Snapshot: ${snapshotTime()}`);
		if (safeWidth < MIN_TAB_STRIP_COLS) {
			const index = PANELS.indexOf(tab) + 1;
			push(`[${TAB_LABELS[tab]}] ${index}/${PANELS.length}`);
		} else {
			const strip = PANELS.map((panel) => (panel === tab ? `[${TAB_LABELS[panel]}]` : TAB_LABELS[panel])).join("  ");
			push(strip);
		}

		const tiny = !canMutate(safeWidth);
		const available = Math.max(0, viewportHeight() - 6);

		if (snapshotError) {
			pushWrapped(`Could not read local snapshot: ${snapshotError}. Press r to refresh or Esc to close; no lesson changes were made by this read.`);
		}
		if (view === "confirm-candidate" && confirmTarget) {
			push("Confirm this candidate?");
			pushWrapped(`Confirm lesson ${confirmTarget.title} (${confirmTarget.id}) for the current project. Existing retention may run or queue; this action does not install a skill.`);
		} else if (view === "confirm-install") {
			push("Install this preview into Omp?");
			const name = pendingPreview ? cleanInline(pendingPreview.name, 80) || "the preview" : "the preview";
			pushWrapped(`Install ${name} into Omp managed skills. Only an owned generated slot may be updated; authored, foreign, symlinked, or conflicting slots are refused.`);
		} else if (view === "preview") {
			const { lines, total, clipped } = previewLines();
			const windowRows = Math.min(DETAIL_WINDOW, Math.max(1, available));
			const start = clampScroll(previewScroll, lines.length, windowRows);
			const end = Math.min(lines.length, start + windowRows);
			push(`Preview lines ${lines.length === 0 ? 0 : start + 1}–${end} of ${lines.length}${clipped ? ` · source truncated at 60KB, ${total} draft lines` : ""}`);
			for (const line of lines.slice(start, end)) pushWrapped(line);
		} else if (view === "detail") {
			const lines = detailLines();
			const windowRows = Math.min(DETAIL_WINDOW, Math.max(1, available));
			const start = clampScroll(detailScroll, lines.length, windowRows);
			for (const line of lines.slice(start, start + windowRows)) pushWrapped(line);
			if (lines.length > windowRows) push(`Details ${start + 1}–${Math.min(lines.length, start + windowRows)} of ${lines.length} shown`);
		} else if (tab === "overview") {
			for (const line of overviewLines().slice(0, Math.max(4, available))) pushWrapped(line);
		} else {
			const rows_list = listRows(tab);
			if (rows_list.length === 0) {
				for (const line of panelEmptyCopy(tab)) pushWrapped(line);
			} else {
				const total = rows_list.length;
				const windowRows = Math.min(LIST_WINDOW, Math.max(1, available));
				const cursor = Math.min(Math.max(0, cursors[tab]), total - 1);
				const start = clampScroll(cursor - Math.floor(windowRows / 2), total, windowRows);
				const shown = rows_list.slice(start, start + windowRows);
				shown.forEach((row, offset) => {
					const marker = start + offset === cursor && focus === "list" ? ">" : " ";
					push(`${marker} ${row.label}`);
				});
				const one = total === 1;
				push(one ? "1 record shown" : `item ${cursor + 1} of ${total} shown`);
				if (total >= COLLECTION_CAP) push("Showing up to 100 local records; this is not a complete inventory.");
			}
		}

		if (busy) {
			push(`${busy.label}${busyCancelled ? " · cancelling…" : "…"}`);
			// The settled confirm/install receipt stays on screen while its
			// owned follow-up refresh re-reads; every other busy run keeps the
			// existing behavior of showing only the busy label.
			if (busy.kind === "refresh" && actionRefresh && notice) pushWrapped(notice);
		} else if (notice) {
			pushWrapped(notice);
		}
		if (tiny) {
			pushWrapped("Terminal too small to review an action. Resize to at least 24 columns and 8 rows; browsing and Escape remain available.");
		}

		const list = actions(safeWidth);
		if (list.length > 0) {
			const parts = list.map((action, index) => {
				const marker = focus === "actions" && (actionCursor[view] ?? 0) === index ? ">" : " ";
				const state = action.enabled ? "" : " (Unavailable: Terminal too small to review an action.)";
				return `${marker} ${action.label}${state}`;
			});
			for (const part of parts) pushWrapped(part);
		}

		push(helpLine());
		return rows;
	};

	const helpLine = (): string => {
		if (view === "confirm-candidate") return "Tab change focus · ↑/↓ choose · Enter confirm candidate · Esc keep candidate";
		if (view === "confirm-install") return "Tab change focus · ↑/↓ choose · Enter install · Esc keep preview";
		if (view === "preview") return "Tab change focus · ↑/↓ scroll preview · Enter install into Omp · Esc back to lesson";
		if (view === "detail") return "Tab change focus · ↑/↓ scroll details · Enter actions · r refresh snapshot · Esc back to list";
		if (focus === "tabs") return "Tab change focus · ←/→ choose panel · ↑/↓ choose lesson · Enter view details · r refresh snapshot · Esc close dashboard";
		return "Tab change focus · ↑/↓ choose lesson · Enter view details · r refresh snapshot · Esc close dashboard";
	};

	const stateKey = (width: number): string =>
		[
			width,
			viewportHeight(),
			tab,
			focus,
			view,
			cursors.jev,
			cursors.moments,
			cursors.skills,
			selectedKeys.jev ?? "",
			selectedKeys.moments ?? "",
			selectedKeys.skills ?? "",
			detailScroll,
			previewScroll,
			actionCursor[view] ?? 0,
			notice,
			snapshotError,
			busy ? `${busy.kind}:${busyCancelled}:${actionRefresh ? "action" : "manual"}` : "",
			pendingPreview ? "preview" : "",
			formatTime(snapshot.at),
		].join("|");

	const finishRefresh = (run: number, next: InsightSnapshot | undefined, failure: string): void => {
		if (disposed || run !== epoch || busy?.kind !== "refresh") return;
		const wasAction = actionRefresh;
		const receipt = wasAction ? notice : "";
		busy = undefined;
		busyCancelled = false;
		actionRefresh = false;
		if (next && typeof next === "object" && !Array.isArray(next)) {
			const previous: Record<InsightPanel, string | undefined> = { ...selectedKeys };
			snapshot = next;
			snapshotError = "";
			if (wasAction) {
				// The confirm/install already settled: its receipt stands. The
				// refresh only re-reads; disappearance or preview drift is
				// appended as read state, never as a rollback claim.
				notice = receipt;
				let disappeared = false;
				for (const panel of PANELS) {
					const retained = previous[panel];
					syncSelection(panel);
					if (retained !== undefined && selectedKeys[panel] !== retained) disappeared = true;
				}
				if (disappeared) {
					if (view === "detail" || view === "preview") closeToBrowseSilent();
					notice = `${receipt ? `${receipt} ` : ""}Selected record is no longer in this snapshot. Choose another record. No rollback is claimed; the action result above stands.`;
				}
				if (pendingPreview) {
					pendingPreview = undefined;
					if (view === "preview" || view === "confirm-install") {
						view = "detail";
						notice = `${notice ? `${notice} ` : ""}Lesson or preview changed. No new action was started; refresh and preview again.`;
					}
				}
			} else {
				// Explicit manual refresh: prior receipts are obsolete once the
				// new snapshot lands.
				notice = "";
				let disappeared = false;
				for (const panel of PANELS) {
					const retained = previous[panel];
					syncSelection(panel);
					if (retained !== undefined && selectedKeys[panel] !== retained) disappeared = true;
				}
				if (disappeared) {
					// A retained identity disappeared: clear details/preview rather than reusing an index.
					if (view === "detail" || view === "preview") closeToBrowseSilent();
					notice = "Selected record is no longer in this snapshot. Choose another record.";
				}
				if (pendingPreview) {
					pendingPreview = undefined;
					if (view === "preview" || view === "confirm-install") {
						view = "detail";
						notice = `${notice ? `${notice} ` : ""}Lesson or preview changed. No new action was started; refresh and preview again.`;
					}
				}
			}
		} else if (wasAction) {
			// The mutation settled before this read failed: keep the receipt and
			// report the read failure beside it, never as a rollback.
			snapshotError = failure || "refresh failed";
			const followUp = `Follow-up refresh failed: ${snapshotError}. No rollback is claimed; the action result above stands. Press r to refresh actual state.`;
			notice = receipt ? `${receipt} ${followUp}` : followUp;
		} else {
			snapshotError = failure || "refresh failed";
			notice = "";
		}
		touch();
	};

	const closeToBrowseSilent = (): void => {
		view = "browse";
		pendingPreview = undefined;
		confirmTarget = undefined;
		detailScroll = 0;
		previewScroll = 0;
	};

	const startRefresh = (fromAction = false): void => {
		if (disposed || busy) return;
		epoch += 1;
		const run = epoch;
		actionRefresh = fromAction;
		busy = { kind: "refresh", label: "Refreshing local snapshot… Showing the previous snapshot until ready." };
		touch();
		Promise.resolve()
			.then(() => callbacks.refresh())
			.then(
				(next) => {
					finishRefresh(run, next, "");
				},
				(error) => {
					const reason = cleanInline(error instanceof Error ? error.message : String(error), 160) || "refresh failed";
					finishRefresh(run, undefined, reason);
				},
			);
	};

	const failResult = (result: InsightActionResult | undefined): string => {
		if (!result || typeof result !== "object") return "action failed";
		return cleanInline(result.message, 200) || "action failed";
	};

	const startPreview = (row: LessonRow): void => {
		if (disposed || busy) return;
		epoch += 1;
		const run = epoch;
		busy = { kind: "preview", label: "Building deterministic preview… No installation or model call." };
		busyCancelled = false;
		touch();
		Promise.resolve()
			.then(() => callbacks.previewSkill(lessonSelection(row)))
			.then(
				(result) => {
					if (disposed || run !== epoch || busy?.kind !== "preview") return;
					busy = undefined;
					busyCancelled = false;
					if (result && result.status === "ok" && result.preview) {
						pendingPreview = result.preview;
						openView("preview", "details");
						// The strip's focused action is the named install action, so
						// the next Enter opens the separate installation confirmation;
						// that confirmation still starts on Keep preview.
						actionCursor.preview = 1;
						notice = "";
					} else {
						notice = `Preview unavailable: ${failResult(result)}. Refresh the lesson before trying again.`;
						touch();
					}
				},
				(error) => {
					if (disposed || run !== epoch || busy?.kind !== "preview") return;
					busy = undefined;
					busyCancelled = false;
					notice = `Preview unavailable: ${cleanInline(error instanceof Error ? error.message : String(error), 200)}. Refresh the lesson before trying again.`;
					touch();
				},
			);
	};

	const startConfirm = (row: LessonRow): void => {
		if (disposed || busy) return;
		epoch += 1;
		const run = epoch;
		busy = { kind: "confirm", label: "Confirming candidate… Checking current session and lesson." };
		busyCancelled = false;
		touch();
		Promise.resolve()
			.then(() => callbacks.confirmCandidate(lessonSelection(row)))
			.then(
				(result) => {
					if (disposed || run !== epoch || busy?.kind !== "confirm") return;
					busy = undefined;
					busyCancelled = false;
					if (result && result.status === "ok") {
						const receipt = cleanInline(result.message, 200) || "Candidate confirmed.";
						const retention = result.retention ? ` Retention: ${cleanInline(result.retention, 40)}.` : "";
						const lifecycle = result.lifecycle ? ` Lifecycle: ${cleanInline(result.lifecycle, 40)}.` : "";
						notice = `${receipt}${retention}${lifecycle}`;
						closeToBrowseSilent();
						focus = "list";
						touch();
						startRefresh(true);
					} else {
						notice = `Candidate was not confirmed: ${failResult(result)}. Refresh the lesson before trying again.`;
						openView("detail", "details");
					}
				},
				(error) => {
					if (disposed || run !== epoch || busy?.kind !== "confirm") return;
					busy = undefined;
					busyCancelled = false;
					notice = `Candidate was not confirmed: ${cleanInline(error instanceof Error ? error.message : String(error), 200)}. Refresh the lesson before trying again.`;
					openView("detail", "details");
				},
			);
	};

	const startInstall = (): void => {
		if (disposed || busy || !pendingPreview) return;
		const preview = pendingPreview;
		epoch += 1;
		const run = epoch;
		busy = { kind: "install", label: "Installing into Omp… Existing ownership guards remain active." };
		busyCancelled = false;
		touch();
		Promise.resolve()
			.then(() => callbacks.installPreview(preview, true))
			.then(
				(result) => {
					if (disposed || run !== epoch || busy?.kind !== "install") return;
					busy = undefined;
					busyCancelled = false;
					if (result && result.status === "ok") {
						const receipt = cleanInline(result.message, 200) || "Omp install returned success.";
						const install = result.install;
						const recorded = install ? ` Recorded action: ${cleanInline(install.action, 40)}${install.skill ? ` · Skill: ${cleanInline(install.skill, 80)}` : ""}${install.path ? ` · Path: ${cleanInline(install.path, 120)}` : ""}.` : "";
						notice = `${receipt}${recorded}`;
						closeToBrowseSilent();
						focus = "list";
						touch();
						startRefresh(true);
					} else if (result && result.status === "refused") {
						notice = `Installation refused: ${failResult(result)}. Existing files were not replaced by this refused install; review the lesson/slot outside this dashboard, then preview again.`;
						openView("preview", "details");
					} else {
						notice = `Installation did not return a successful Omp result: ${failResult(result)}. Refresh actual lesson state before trying again; no rollback is claimed.`;
						openView("preview", "details");
					}
				},
				(error) => {
					if (disposed || run !== epoch || busy?.kind !== "install") return;
					busy = undefined;
					busyCancelled = false;
					notice = `Installation did not return a successful Omp result: ${cleanInline(error instanceof Error ? error.message : String(error), 200)}. Refresh actual lesson state before trying again; no rollback is claimed.`;
					openView("preview", "details");
				},
			);
	};

	const cycleFocus = (direction: 1 | -1): void => {
		const regions = focusable();
		if (regions.length === 0) return;
		let index = regions.indexOf(focus);
		if (index < 0) index = direction === 1 ? -1 : 0;
		focus = regions[(index + direction + regions.length) % regions.length] ?? regions[0] ?? "tabs";
		touch();
	};

	const moveCursor = (delta: 1 | -1): void => {
		const rows = listRows(tab);
		if (rows.length === 0) return;
		const next = cursors[tab] + delta;
		if (next < 0 || next >= rows.length) return;
		cursors[tab] = next;
		selectedKeys[tab] = rows[next]?.key;
		touch();
	};

	const moveAction = (delta: 1 | -1): void => {
		const list = actions(lastWidth);
		if (list.length === 0) return;
		const current = actionCursor[view] ?? 0;
		const next = current + delta;
		if (next < 0 || next >= list.length) return;
		actionCursor[view] = next;
		touch();
	};

	const activateAction = (action: DashboardAction | undefined, width: number): void => {
		if (!action || !action.enabled) {
			if (action && !action.enabled && action.disabledReason) notice = action.disabledReason;
			touch();
			return;
		}
		switch (action.id) {
			case "nav-jev":
			case "nav-moments":
			case "nav-skills": {
				const target = action.id === "nav-jev" ? "jev" : action.id === "nav-moments" ? "moments" : "skills";
				tab = target;
				view = "browse";
				syncSelection(tab);
				focus = listRows(tab).length > 0 ? "list" : "tabs";
				touch();
				return;
			}
			case "open-detail":
				openDetail();
				return;
			case "back":
				closeToBrowse();
				return;
			case "keep":
				if (view === "confirm-install") {
					openView("preview", "actions");
					notice = "";
				} else {
					openView("detail", "details");
					notice = "";
				}
				return;
			case "refresh":
				if (view === "preview") {
					pendingPreview = undefined;
					notice = "Lesson or preview changed. No new action was started; refresh and preview again.";
					startRefresh();
					return;
				}
				if (view === "confirm-candidate" || view === "confirm-install" || busy) return;
				startRefresh();
				return;
			case "open-confirm": {
				const row = currentLesson();
				if (!row || !canMutate(width)) {
					notice = "Terminal too small to review an action. Resize to at least 24 columns and 8 rows; browsing and Escape remain available.";
					touch();
					return;
				}
				confirmTarget = row;
				// Focus starts on the question region: the next Enter only moves to
				// the two choices, so the opening keypress can never confirm.
				openView("confirm-candidate", "details");
				actionCursor["confirm-candidate"] = 0;
				return;
			}
			case "open-preview": {
				const row = currentLesson();
				if (!row) return;
				startPreview(row);
				return;
			}
			case "open-install": {
				if (!pendingPreview || !canMutate(width)) {
					notice = "Terminal too small to review an action. Resize to at least 24 columns and 8 rows; browsing and Escape remain available.";
					touch();
					return;
				}
				openView("confirm-install", "details");
				actionCursor["confirm-install"] = 0;
				return;
			}
			case "confirm-yes": {
				// The Enter that opened this confirmation advanced `seq`; require a
				// strictly later input before the affirmative can fire so the
				// triggering keypress never activates the mutating choice.
				if (seq <= viewOpenedAtSeq || !confirmTarget || !canMutate(width)) return;
				const row = confirmTarget;
				confirmTarget = undefined;
				startConfirm(row);
				return;
			}
			case "install-yes": {
				if (seq <= viewOpenedAtSeq || !pendingPreview || !canMutate(width)) return;
				startInstall();
				return;
			}
			default:
				return;
		}
	};

	const focusedAction = (width: number): DashboardAction | undefined => {
		const list = actions(width);
		if (list.length === 0) return undefined;
		return list[Math.min(Math.max(0, actionCursor[view] ?? 0), list.length - 1)];
	};

	syncSelection(tab);

	return {
		render(width: number): readonly string[] {
			if (disposed) return cachedRows;
			const safeWidth = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
			lastWidth = safeWidth;
			const key = `${stateKey(safeWidth)}|${safeWidth}`;
			if (key === cachedKey) return cachedRows;
			let rows: string[] = [];
			try {
				rows = renderInto(safeWidth);
			} catch {
				rows = [fitRow("Ultrathink dashboard hit an error; no lesson changes were made. Press r to refresh or Esc to close.", safeWidth)];
			}
			cachedKey = key;
			cachedRows = rows;
			return cachedRows;
		},
		invalidate(): void {
			cachedKey = "";
			if (!disposed) requestRender();
		},
		handleInput(data: unknown): void {
			if (disposed) return;
			const key = normalizeKey(data);
			if (!key) return;
			seq += 1;
			if (key === "tab") {
				cycleFocus(1);
				return;
			}
			if (key === "shift-tab") {
				cycleFocus(-1);
				return;
			}
			if (key === "escape") {
				if (busy) {
					const wasAction = busy.kind === "refresh" && actionRefresh;
					const receipt = wasAction ? notice : "";
					// Cancellation is a request to stop owned UI work, never a
					// claim of rollback: detach the run so late completions are
					// ignored, keep the snapshot that is already on screen.
					epoch += 1;
					busy = undefined;
					busyCancelled = false;
					actionRefresh = false;
					notice = "Closing dashboard. An already-started action is not claimed to be rolled back; inspect actual state when reopening.";
					if (view === "confirm-candidate" || view === "confirm-install" || view === "preview") {
						openView("detail", "details");
						notice = "Action cancelled before it started. No lesson change or installation was requested.";
					} else if (wasAction && receipt) {
						// The confirm/install settled before this read was cancelled:
						// the receipt stands, the cancelled re-read claims nothing.
						notice = `${receipt} Follow-up refresh cancelled before it finished; no rollback is claimed. Press r to refresh actual state.`;
					}
					touch();
					return;
				}
				if (view === "confirm-candidate") {
					openView("detail", "details");
					notice = "";
					confirmTarget = undefined;
					return;
				}
				if (view === "confirm-install") {
					openView("preview", "details");
					notice = "";
					return;
				}
				if (view === "preview") {
					openView("detail", "details");
					pendingPreview = undefined;
					notice = "";
					return;
				}
				if (view === "detail") {
					closeToBrowse();
					return;
				}
				try {
					callbacks.close();
				} catch {
					// Host close is best-effort.
				}
				return;
			}
			if (busy) return;
			if (key === "r") {
				if (view === "confirm-candidate" || view === "confirm-install") return;
				if (view === "preview") {
					pendingPreview = undefined;
					notice = "Lesson or preview changed. No new action was started; refresh and preview again.";
				}
				startRefresh();
				return;
			}
			if (key === "left" || key === "right") {
				const delta = key === "right" ? 1 : -1;
				if (focus === "tabs") {
					const index = PANELS.indexOf(tab);
					const next = index + delta;
					if (next < 0 || next >= PANELS.length) return;
					tab = PANELS[next] ?? tab;
					view = "browse";
					pendingPreview = undefined;
					confirmTarget = undefined;
					syncSelection(tab);
					touch();
					return;
				}
				if (focus === "actions") {
					moveAction(delta as 1 | -1);
					return;
				}
				return;
			}
			if (key === "up" || key === "down") {
				const delta = key === "down" ? 1 : -1;
				if (focus === "list") {
					moveCursor(delta as 1 | -1);
					return;
				}
				if (focus === "details" && (view === "detail" || view === "preview")) {
					if (view === "detail") {
						detailScroll = clampScroll(detailScroll + delta, detailLines().length, DETAIL_WINDOW);
					} else {
						previewScroll = clampScroll(previewScroll + delta, previewLines().lines.length, DETAIL_WINDOW);
					}
					touch();
					return;
				}
				if (focus === "actions" && (view === "confirm-candidate" || view === "confirm-install")) {
					moveAction(delta as 1 | -1);
					return;
				}
				return;
			}
			if (key === "pageup" || key === "pagedown") {
				const delta = key === "pagedown" ? DETAIL_WINDOW : -DETAIL_WINDOW;
				if (focus === "details" && view === "detail") {
					detailScroll = clampScroll(detailScroll + delta, detailLines().length, DETAIL_WINDOW);
					touch();
					return;
				}
				if (view === "preview") {
					previewScroll = clampScroll(previewScroll + delta, previewLines().lines.length, DETAIL_WINDOW);
					touch();
				}
				return;
			}
			if (key === "enter") {
				if (focus === "tabs") {
					// Opening confirmations consumes the triggering Enter: the named
					// action only opens its screen; the screen itself starts on the
					// non-mutating choice and needs a strictly later input.
					if (view === "detail") {
						const primary = actions(lastWidth).find((action) => action.id === "open-confirm" || action.id === "open-preview");
						if (primary) {
							activateAction(primary, lastWidth);
							return;
						}
					}
					focus = view === "browse" && listRows(tab).length > 0 && tab !== "overview" && canMutate(lastWidth) ? "list" : "actions";
					touch();
					return;
				}
				if (focus === "list") {
					openDetail();
					return;
				}
				if (focus === "details") {
					focus = "actions";
					touch();
					return;
				}
				activateAction(focusedAction(lastWidth), lastWidth);
				return;
			}
		},
		dispose(): void {
			if (disposed) return;
			disposed = true;
			epoch += 1;
			busy = undefined;
			pendingPreview = undefined;
			confirmTarget = undefined;
			cachedRows = [];
			cachedKey = "";
		},
	};
}
