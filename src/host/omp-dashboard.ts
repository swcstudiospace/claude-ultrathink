import { formatP as formatDecisionP } from "../decisions/types.ts";
import { MAX_BODY_CHARS } from "../teach/types.ts";
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
// Whole-draft character bound shared by intake sanitation and per-line display;
// per-line use never truncates because the whole draft is already capped.
const PREVIEW_MAX_CHARS = 200_000;
const MIN_MUTATE_COLS = 24;
const MIN_MUTATE_ROWS = 8;
const MIN_TAB_STRIP_COLS = 32;
// Header is always the title row plus the tab-strip/position row.
const HEAD_ROWS = 2;
// Lesson bodies arrive sanitized and bounded by the read model at the imported
// MAX_BODY_CHARS. Re-sanitizing at that same authoritative bound strips hostile
// controls from untrusted fixtures without narrowing in-bound text; line
// completeness comes from never slicing lines here.
const TINY_REASON = "Terminal too small to review an action. Resize to at least 24 columns and 8 rows; browsing and Escape remain available.";
const CLIPPED_PREVIEW_REASON = "Preview exceeds the supported 60KB bound; the complete draft cannot be reviewed here, so install is unavailable.";
const FIT_REASON = "Action identity does not fit the current viewport. Resize to review the full identity and effect; browsing and Escape remain available.";
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
	let overviewScroll = 0;
	// previewLines() is width-independent; memoize on preview identity so action
	// gates and scroll handlers reuse the render's computation.
	let previewMemo: { preview: SkillPreview; result: { lines: string[]; clipped: boolean } } | undefined;
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
		const gate = (action: DashboardAction): DashboardAction =>
			action.mutating && tiny ? { ...action, enabled: false, disabledReason: TINY_REASON } : action;
		// A clipped preview exceeded the 60KB producer bound: its tail/ownership
		// marker cannot be reviewed, so every install path stays disabled.
		const previewClipped = pendingPreview !== undefined && previewLines().clipped;
		const installBlocked: DashboardAction | undefined = previewClipped
			? { id: "open-install", label: "Install into Omp", mutating: true, enabled: false, disabledReason: CLIPPED_PREVIEW_REASON }
			: undefined;
		if (view === "confirm-candidate") {
			return [
				{ id: "keep", label: "Keep candidate", mutating: false, enabled: true },
				gate({ id: "confirm-yes", label: "Confirm candidate", mutating: true, enabled: !busy }),
			];
		}
		if (view === "confirm-install") {
			return [
				{ id: "keep", label: "Keep preview", mutating: false, enabled: true },
				previewClipped
					? { id: "install-yes", label: "Install into Omp", mutating: true, enabled: false, disabledReason: CLIPPED_PREVIEW_REASON }
					: gate({ id: "install-yes", label: "Install into Omp", mutating: true, enabled: !busy }),
			];
		}
		if (view === "preview") {
			return [
				{ id: "back", label: "Back to lesson", mutating: false, enabled: true },
				installBlocked ?? gate({ id: "open-install", label: "Install into Omp", mutating: true, enabled: !busy }),
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
		if (view === "confirm-candidate" || view === "confirm-install") return ["actions"];
		const regions: FocusRegion[] = ["tabs"];
		// The size guard only gates data-changing actions. List navigation
		// (Tab focus and ↑/↓ selection) stays available below the mutation
		// floor so records remain browsable and selectable when narrow.
		if (view === "browse" && (tab === "jev" || tab === "moments" || tab === "skills") && listRows(tab).length > 0) {
			regions.push("list");
		}
		if (view === "detail" || view === "preview") regions.push("details");
		if (visibleActions(lastWidth).length > 0) regions.push("actions");
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
		overviewScroll = 0;
		syncSelection(tab);
		focus = listRows(tab).length > 0 && tab !== "overview" ? "list" : "tabs";
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
		if (!policy) return ["Autonomy policy is unavailable. Saved lessons remain readable; no current policy can be inferred."];
		const lines: string[] = [];
		if (!policy.enabled) lines.push("Teaching is off. Saved lessons remain readable; confirmation, preview, and installation are unavailable.");
		const capture = cleanInline(policy.capture, 24);
		lines.push(
			`Capture: ${capture || "Not recorded"} · Recall: ${policy.recall ? `enabled (limit ${policy.recallLimit}, ${policy.recallChars} chars)` : "disabled"} · Auto-promotion: ${policy.autoPromote ? "enabled" : "disabled"} · Threshold: ${policy.promoteAfter}`,
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
	// The body arrives sanitized and bounded from the read model; every in-bound
	// line stays complete here and the viewport wraps/scrolls it into cells.
	const body = cleanText(source.body, MAX_BODY_CHARS);
	if (body) {
		lines.push("Body:");
		for (const chunk of body.split("\n")) lines.push(`  ${chunk}`);
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
	}
		return lines;
	};

/**
 * Deterministic eligibility reasoning from saved lesson rules only: confirmed
 * plus unpromoted plus occurrences meeting the effective threshold, or the
 * playbook-kind exception. Never a fresh Jev verdict or installation proof.
 */
const eligibilityLine = (row: LessonRow): string | undefined => {
	const source = row.source;
	const policy = snapshot.policy;
	const threshold = policy ? policy.promoteAfter : undefined;
	const thresholdText = typeof threshold === "number" && Number.isFinite(threshold) ? String(threshold) : "unavailable";
	const occ = row.occurrences;
	const occText = typeof occ === "number" && Number.isFinite(occ) ? String(occ) : "unrecorded";
	if (row.eligible) {
		const basis =
			source.kind === "playbook" && typeof occ === "number" && typeof threshold === "number" && occ < threshold
				? `playbook exception (occurrences ${occText} below threshold ${thresholdText})`
				: `occurrences ${occText} meet threshold ${thresholdText}`;
		return `Eligible: confirmed · unpromoted · ${basis} — not a new Jev verdict`;
	}
	if (source.status !== "confirmed") return `Not eligible: status ${row.status} (needs confirmed) — not a new Jev verdict`;
	if (typeof occ === "number" && typeof threshold === "number" && occ < threshold && source.kind !== "playbook")
		return `Not eligible: occurrences ${occText} below threshold ${thresholdText} — not a new Jev verdict`;
	if (occ === undefined || threshold === undefined) return "Not eligible: occurrence count or threshold unrecorded — not a new Jev verdict";
	return undefined;
};

	/**
	 * Saved eligibility facts for the selected lesson as physical rows that
	 * lead the scrolled detail surface: they are the consent context for the
	 * strip's confirm/preview actions, so a freshly opened detail always shows
	 * them first and scrolling can always bring them back at any viewport.
	 */
	const detailFactRows = (width: number): string[] => {
		if (tab === "jev") return [];
		const row = currentLesson();
		if (!row) return [];
		const reason = eligibilityLine(row);
		return reason ? wrappedRows([reason], width) : [];
	};

	const previewLines = (): { lines: string[]; clipped: boolean } => {
		if (!pendingPreview) {
			return { lines: ["Preview unavailable. Go back and preview again."], clipped: false };
		}
		if (previewMemo?.preview === pendingPreview) return previewMemo.result;
		const preview: SkillPreview = pendingPreview;
		const name = cleanInline(preview.name, 100) || "Not recorded";
		const description = cleanInline(preview.description, 300) || "Not recorded";
		const warnings = preview.warnings
			.map((item) => cleanInline(item, 160))
			.filter(Boolean)
			.slice(0, 8);
		const sourceId = cleanInline(preview.selection.id, 120);
		// Unsupported payloads are withheld before text processing, just as
		// oversized persisted records are refused before reading their bodies.
		const overBound = preview.content.length > PREVIEW_MAX_BYTES || utf8Bytes(preview.content) > PREVIEW_MAX_BYTES;
		const text = overBound ? "" : cleanText(preview.content, PREVIEW_MAX_CHARS);
		const clipped = overBound || utf8Bytes(text) > PREVIEW_MAX_BYTES;
		const contentLines = text.split("\n");
		const header = [
			"Preview only — not installed. Deterministic content from the selected lesson.",
			`Draft: ${name} · Source: ${sourceId || "Not recorded"} · Target: Omp`,
			`Description: ${description}`,
			"Terminal controls are removed from this display; existing draft redaction warnings are shown below.",
		];
		const warningLines = warnings.map((warning) => `Warning: ${warning}`);
		// A clipped preview exceeded the producer bound: the tail/ownership marker
		// cannot be reviewed, so install stays disabled and nothing claims review
		// of regenerated content under this consent.
		if (clipped) warningLines.push("Preview exceeds the 60KB bound; draft content is withheld and install is unavailable.");
		const result = {
			// In-bound lines stay whole and scrollable. An over-bound draft is
			// withheld, not expensively wrapped into an unreviewable fragment.
			lines: [...header, ...warningLines, ...(clipped ? [] : ["---", ...contentLines.map((line) => cleanInline(line, PREVIEW_MAX_CHARS))])],
			clipped,
		};
		previewMemo = { preview, result };
		return result;
	};

	const candidateConfirmLines = (row: LessonRow): string[] => [
		"Confirm this candidate?",
		`Confirm lesson ${row.title} (${row.id}) for the current project. Existing retention may run or queue; this action does not install a skill.`,
	];

	const installConfirmLines = (): string[] => {
		const name = pendingPreview ? cleanInline(pendingPreview.name, 80) || "the preview" : "the preview";
		return [
			"Install this preview into Omp?",
			`Source lesson: ${pendingPreview ? cleanInline(pendingPreview.selection.id, 120) : "Not recorded"}`,
			`Install ${name} into Omp managed skills. Only an owned generated slot may be updated; authored, foreign, symlinked, or conflicting slots are refused.`,
		];
	};

	const confirmBodyLines = (): string[] => {
		if (view === "confirm-install") return installConfirmLines();
		if (view === "confirm-candidate" && confirmTarget) return candidateConfirmLines(confirmTarget);
		return [];
	};

	/**
	 * Status rows: snapshot error, busy or receipt notice, tiny-viewport
	 * guidance. Never trimmed silently by callers without keeping help.
	 */
	const statusRows = (width: number): string[] => {
		const status: string[] = [];
		const emit = (text: string): void => {
			status.push(fitRow(text, width));
		};
		const emitWrapped = (text: string, indent = ""): void => {
			for (const line of wrapRow(text, width, indent)) emit(line);
		};
		if (snapshotError) {
			emitWrapped(`Could not read local snapshot: ${snapshotError}. Press r to refresh or Esc to close; no lesson changes were made by this read.`);
		}
		if (busy) {
			emit(`${busy.label}${busyCancelled ? " · cancelling…" : "…"}`);
			// The settled confirm/install receipt stays on screen while its
			// owned follow-up refresh re-reads; every other busy run keeps the
			// existing behavior of showing only the busy label.
			if (busy.kind === "refresh" && actionRefresh && notice) emitWrapped(notice);
		} else if (notice) {
			emitWrapped(notice);
		}
		if (!canMutate(width)) {
			emitWrapped(TINY_REASON);
		}
		return status;
	};

	/**
	 * Action-strip rows. Below the mutation floor every mutating entry already
	 * carries the full guidance in the status rows above, so the strip compacts
	 * to a short marker instead of repeating the whole reason per action.
	 */
	const actionRows = (width: number, list: DashboardAction[]): string[] => {
		const rows: string[] = [];
		const tiny = !canMutate(width);
		for (const [index, action] of list.entries()) {
			const marker = focus === "actions" && (actionCursor[view] ?? 0) === index ? ">" : " ";
			const reason = action.disabledReason ?? TINY_REASON;
			const state = action.enabled ? "" : tiny && reason === TINY_REASON ? " (Unavailable)" : ` (Unavailable: ${reason})`;
			for (const line of wrapRow(`${marker} ${action.label}${state}`, width, "")) rows.push(fitRow(line, width));
		}
		return rows;
	};

	/**
	 * Every non-content row, built exactly as emitted: status, action strip,
	 * and help. Sizing the content window against this tail keeps header,
	 * actions, status, and help on screen at any height.
	 */
	const buildTail = (width: number, list: DashboardAction[]): string[] => [
		...statusRows(width),
		...actionRows(width, list),
		fitRow(helpLine(), width),
	];

	/** The affirmative may fire only when its full identity/effect text fits the actual content window. */
	const confirmScreenFits = (width: number, list: DashboardAction[]): boolean => {
		const body = confirmBodyLines();
		if (body.length === 0) return false;
		const tail = buildTail(width, list);
		const budget = Math.max(0, viewportHeight() - HEAD_ROWS - tail.length);
		return wrappedRows(body, width).length <= budget;
	};

	/**
	 * actions() plus the viewport-fit gate: never silently clip an identity and
	 * still offer the mutation. Tiny and clipped-preview gates live in actions();
	 * this layer only refuses an affirmative whose text cannot be reviewed.
	 */
	const visibleActions = (width: number): DashboardAction[] => {
		const list = actions(width);
		if (view !== "confirm-candidate" && view !== "confirm-install") return list;
		const affirmative = view === "confirm-candidate" ? "confirm-yes" : "install-yes";
		if (!list.some((action) => action.id === affirmative && action.enabled)) return list;
		if (confirmScreenFits(width, list)) return list;
		return list.map((action) =>
			action.id === affirmative && action.enabled ? { ...action, enabled: false, disabledReason: FIT_REASON } : action,
		);
	};

	/**
	 * Bounded refusal shown when a confirmation identity/effect cannot fit the
	 * viewport: it names the withheld action and the resize path explicitly, so
	 * nothing is silently clipped and no affirmative is offered on unseen text.
	 */
	const confirmRefusalLines = (): string[] => {
		const label = view === "confirm-install" ? "Install into Omp" : "Confirm candidate";
		return [
			`${label} is withheld: the full identity and effect do not fit this viewport.`,
			"Resize to review the complete text; browsing and Escape remain available. No action was taken.",
		];
	};

	interface DashboardLayout {
		list: DashboardAction[];
		status: string[];
		strip: string[];
		help: string;
		tail: string[];
		budget: (reserved: number) => number;
	}

	/**
	 * The single physical-window budget shared by render, scroll/page steps,
	 * and clamps: header plus the exact tail (status, strip, help) are
	 * reserved first, so every consumer windows the same remainder.
	 */
	const layoutFor = (width: number): DashboardLayout => {
		const list = visibleActions(width);
		const status = statusRows(width);
		const strip = actionRows(width, list);
		const help = fitRow(helpLine(), width);
		const tail = [...status, ...strip, help];
		return {
			list,
			status,
			strip,
			help,
			tail,
			budget: (reserved: number): number => Math.max(0, viewportHeight() - HEAD_ROWS - tail.length - reserved),
		};
	};

	/** Preview content rows: the position header keeps one reserved row. */
	const previewWindow = (layout: DashboardLayout): number => Math.min(DETAIL_WINDOW, layout.budget(1));

	/**
	 * Detail and overview content rows: the position footer keeps one reserved
	 * row only when the content actually overflows the windowless budget.
	 */
	const contentWindow = (layout: DashboardLayout, totalWrapped: number): number => {
		let windowRows = Math.min(DETAIL_WINDOW, layout.budget(0));
		if (totalWrapped > windowRows && windowRows > 0) windowRows = Math.min(DETAIL_WINDOW, layout.budget(1));
		return windowRows;
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

	/** DETAIL_WINDOW caps content rows; layoutFor owns the actual budget. */

	/** Physical rows each logical line occupies at the given width; scroll positions index these wrapped rows. */
	const wrappedRows = (lines: readonly string[], width: number): string[] => {
		const room = Math.max(1, width);
		const rows: string[] = [];
		for (const line of lines) rows.push(...wrapRow(line, room, ""));
		return rows;
	};

	/** The detail surface: eligibility facts lead the scrolled lesson body rows. */
	const detailSurface = (width: number): string[] => [...detailFactRows(width), ...wrappedRows(detailLines(), width)];

	/** Overview body reflowed to physical rows; scroll positions index these rows. */
	const overviewSurface = (width: number): string[] => {
		const rows: string[] = [];
		for (const line of overviewLines()) for (const row of wrapRow(line, width, "")) rows.push(fitRow(row, width));
		return rows;
	};

	const fitRow = (text: string, width: number): string => {
		if (width <= 0) return "";
		return truncateToWidth(text, width);
	};

	const renderInto = (width: number): string[] => {
		const safeWidth = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
		if (safeWidth <= 0) return [];
		const height = viewportHeight();
		const head: string[] = [`Ultrathink · ${snapshotLabel()} · Snapshot: ${snapshotTime()}`].map((text) => fitRow(text, safeWidth));
		if (safeWidth < MIN_TAB_STRIP_COLS) {
			const index = PANELS.indexOf(tab) + 1;
			head.push(fitRow(`[${TAB_LABELS[tab]}] ${index}/${PANELS.length}`, safeWidth));
		} else {
			const strip = PANELS.map((panel) => (panel === tab ? `[${TAB_LABELS[panel]}]` : TAB_LABELS[panel])).join("  ");
			head.push(fitRow(strip, safeWidth));
		}

		// Tail first: status, strip, and help are all known before the content
		// window is sized, so header, actions, status, and help stay
		// discoverable at any height and scrollable content never pushes them
		// off screen. Render, scroll/page steps, and clamps share layoutFor.
		const layout = layoutFor(safeWidth);
		let body: string[] = [];
		const emitBody = (text: string): void => {
			body.push(fitRow(text, safeWidth));
		};
		const emitBodyWrapped = (text: string, indent = ""): void => {
			for (const line of wrapRow(text, safeWidth, indent)) emitBody(line);
		};

		if (view === "confirm-candidate" || view === "confirm-install") {
			// A refused identity is never silently clipped into an enabled
			// affirmative and never relies on terminal scrollback: it either
			// fits complete or is replaced by an explicit bounded refusal.
			const full = view === "confirm-candidate"
				? (confirmTarget ? candidateConfirmLines(confirmTarget) : [])
				: pendingPreview ? installConfirmLines() : ["Preview unavailable. Go back and preview again."];
			if (wrappedRows(full, safeWidth).length <= layout.budget(0) && full.length > 0) {
				for (const line of full) emitBodyWrapped(line);
			} else if (full.length > 0) {
				const refusal = wrappedRows(confirmRefusalLines(), safeWidth);
				body = refusal.slice(0, layout.budget(0));
			}
		} else if (view === "preview") {
			const { lines: logical, clipped } = previewLines();
			// Reflow before windowing, then draw and scroll the same wrapped rows,
			// so the complete in-bound tail/ownership marker stays reachable.
			const lines = wrappedRows(logical, safeWidth);
			const windowRows = previewWindow(layout);
			previewScroll = clampScroll(previewScroll, lines.length, windowRows);
			if (windowRows > 0) {
				const start = previewScroll;
				const end = Math.min(lines.length, start + windowRows);
				emitBody(`Preview lines ${lines.length === 0 ? 0 : start + 1}–${end} of ${lines.length}${clipped ? " · draft withheld at 60KB bound" : ""}`);
				for (const line of lines.slice(start, end)) emitBody(line);
			}
		} else if (view === "detail") {
			// Eligibility facts lead the lesson body as one scrolled surface:
			// every line — facts included — stays reachable by scrolling at any
			// viewport, and a freshly opened detail shows the consent facts first.
			const lines = detailSurface(safeWidth);
			const windowRows = contentWindow(layout, lines.length);
			detailScroll = clampScroll(detailScroll, lines.length, windowRows);
			if (windowRows > 0) {
				const start = detailScroll;
				for (const line of lines.slice(start, start + windowRows)) emitBody(line);
				if (lines.length > windowRows) emitBody(`Details ${start + 1}–${Math.min(lines.length, start + windowRows)} of ${lines.length} shown`);
			}
		} else if (tab === "overview") {
			// The overview body scrolls like detail/preview content: lesson
			// totals and teaching settings stay reachable when scope/time text
			// fills a short viewport instead of being clipped away.
			const lines = overviewSurface(safeWidth);
			const windowRows = contentWindow(layout, lines.length);
			overviewScroll = clampScroll(overviewScroll, lines.length, windowRows);
			if (windowRows > 0) {
				const start = overviewScroll;
				for (const row of lines.slice(start, start + windowRows)) emitBody(row);
				if (lines.length > windowRows) emitBody(`Overview ${start + 1}–${Math.min(lines.length, start + windowRows)} of ${lines.length} shown`);
			}
		} else {
			// Skills root keeps Main's effective-policy prefix: live policy plus
			// the saved-rules caveat, never a fresh Jev or installation claim.
			const prefix: string[] = [];
			if (tab === "skills") {
				for (const line of [...policyLines(), "Eligibility uses saved lesson rules, not a fresh Jev verdict. Recorded promotion is not proof of current installation or loading."])
					for (const row of wrapRow(line, safeWidth, "")) prefix.push(fitRow(row, safeWidth));
			}
			const rows_list = listRows(tab);
			if (rows_list.length === 0) {
				const wrapped: string[] = [];
				for (const line of panelEmptyCopy(tab)) for (const row of wrapRow(line, safeWidth, "")) wrapped.push(fitRow(row, safeWidth));
				if (tab === "skills") {
					// Shared budget: the why-empty copy stays complete and
					// reachable; the policy prefix fills whatever rows remain
					// above it instead of clipping the message away.
					const surface = Math.max(1, layout.budget(0));
					const copy = wrapped.slice(0, surface);
					body = [...prefix.slice(0, Math.max(0, surface - copy.length)), ...copy];
				} else {
					body = [...prefix, ...wrapped].slice(0, layout.budget(0));
				}
			} else {
				const total = rows_list.length;
				// Resize clamps the stored selection; lesson data is untouched.
				cursors[tab] = Math.min(Math.max(0, cursors[tab]), total - 1);
				const cursor = cursors[tab];
				const count: string[] = [fitRow(total === 1 ? "1 record shown" : `item ${cursor + 1} of ${total} shown`, safeWidth)];
				if (total >= COLLECTION_CAP) count.push(fitRow("Showing up to 100 local records; this is not a complete inventory.", safeWidth));
				// Skills shares one row budget across the policy prefix and the
				// list: the prefix renders first, the list keeps at least one
				// row, and the combined surface scrolls as one when it exceeds
				// the budget — the lesson window and count line stay reachable
				// while the prefix scrolls away above them.
				const skillsBudget = Math.max(1, layout.budget(0));
				const windowRows = tab === "skills"
					? Math.max(1, Math.min(LIST_WINDOW, skillsBudget - prefix.length - count.length))
					: Math.min(LIST_WINDOW, layout.budget(prefix.length + count.length));
				const start = clampScroll(cursor - Math.floor(windowRows / 2), total, windowRows);
				const shown = rows_list.slice(start, Math.min(total, start + windowRows));
				const rows: string[] = [];
				shown.forEach((row, offset) => {
					const marker = start + offset === cursor && focus === "list" ? ">" : " ";
					rows.push(fitRow(`${marker} ${row.label}`, safeWidth));
				});
				if (tab === "skills") {
					const combined = [...prefix, ...rows, ...count];
					// Never smaller than the lesson window plus the count line,
					// so a scrolled surface keeps the selection on screen.
					const surface = Math.min(combined.length, Math.max(skillsBudget, windowRows + count.length));
					body = combined.slice(Math.max(0, combined.length - surface));
				} else {
					body = [...prefix, ...rows, ...count];
				}
			}
		}

		// The segments above already bound body to the exact remainder, but a
		// status-heavy tail can itself exceed a tiny viewport: trim without
		// ever losing the header, the close/help row, or the leading status.
		const help = layout.help;
		const status = layout.status;
		const strip = layout.strip;
		let rows = [...head, ...body, ...status, ...strip, help];
		if (rows.length > height) {
			rows = [...head, ...status, ...strip, help];
		}
		if (rows.length > height) {
			const keepStrip = Math.max(0, height - head.length - status.length - 1);
			rows = [...head, ...status, ...strip.slice(0, keepStrip), help];
		}
		if (rows.length > height) {
			const keepStatus = Math.max(0, height - head.length - 1);
			rows = [...head, ...status.slice(0, keepStatus), help].slice(0, height);
		}
		return rows;
	};

	const helpLine = (): string => {
		if (view === "confirm-candidate") return "Esc keep candidate · ↑/↓ choose · Enter select · Tab change focus";
		if (view === "confirm-install") return "Esc keep preview · ↑/↓ choose · Enter select · Tab change focus";
		if (focus === "actions") {
			const back = view === "preview" ? "Esc back to lesson" : view === "detail" ? "Esc back to list" : "Esc close dashboard";
			return `${back} · ←/→ choose action · Enter select action · Tab change focus`;
		}
		if (view === "preview") return "Esc back to lesson · ↑/↓ scroll preview · Enter actions · Tab change focus";
		if (view === "detail") return "Esc back to list · ↑/↓ scroll details · Enter actions · r refresh snapshot · Tab change focus";
		if (focus === "tabs") {
			return tab === "overview"
				? "Esc close dashboard · ←/→ choose panel · ↑/↓ scroll overview · Enter actions · r refresh snapshot · Tab change focus"
				: "Esc close dashboard · ←/→ choose panel · ↑/↓ choose lesson · Enter view details · r refresh snapshot · Tab change focus";
		}
		return "Esc close dashboard · ↑/↓ choose lesson · Enter view details · r refresh snapshot · Tab change focus";
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
			overviewScroll,
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
		overviewScroll = 0;
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
						notice = failResult(result);
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
		if (view === "confirm-candidate" || view === "confirm-install") {
			const count = actions(lastWidth).length;
			if (count > 0) actionCursor[view] = ((actionCursor[view] ?? 0) + direction + count) % count;
			focus = "actions";
			touch();
			return;
		}
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
		const list = visibleActions(lastWidth);
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
					// Discarding the preview must also leave the preview view;
					// otherwise the refresh lands on an empty preview with a
					// dead install action.
					pendingPreview = undefined;
					openView("detail", "details");
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
				notice = TINY_REASON;
				touch();
				return;
			}
			confirmTarget = row;
			actionCursor["confirm-candidate"] = 0;
			openView("confirm-candidate", "actions");
			return;
		}
		case "open-preview": {
			const row = currentLesson();
			if (!row) return;
			startPreview(row);
			return;
		}
		case "open-install": {
			// A clipped preview has no reviewable tail: opening install consent
			// over it would ask approval for unseen content, so refuse here.
			if (!pendingPreview || previewLines().clipped || !canMutate(width)) {
				notice = pendingPreview && previewLines().clipped ? CLIPPED_PREVIEW_REASON : TINY_REASON;
				touch();
				return;
			}
			actionCursor["confirm-install"] = 0;
			openView("confirm-install", "actions");
			return;
		}
		case "confirm-yes": {
			// The Enter that opened this confirmation advanced `seq`; require a
			// strictly later input before the affirmative can fire so the
			// triggering keypress never activates the mutating choice.
			if (seq <= viewOpenedAtSeq || !confirmTarget || !canMutate(width)) return;
			if (!confirmScreenFits(width, actions(width))) return;
			const row = confirmTarget;
			confirmTarget = undefined;
			startConfirm(row);
			return;
		}
		case "install-yes": {
			if (seq <= viewOpenedAtSeq || !pendingPreview || !canMutate(width)) return;
			if (previewLines().clipped || !confirmScreenFits(width, actions(width))) return;
			startInstall();
			return;
		}
			default:
				return;
		}
	};

	const focusedAction = (width: number): DashboardAction | undefined => {
		const list = visibleActions(width);
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
					const kind = busy.kind;
					const wasAction = kind === "refresh" && actionRefresh;
					const receipt = wasAction ? notice : "";
					// Cancellation is a request to stop owned UI work, never a
					// claim of rollback: detach the run so late completions are
					// ignored, keep the snapshot that is already on screen.
					epoch += 1;
					busy = undefined;
					busyCancelled = false;
					actionRefresh = false;
					notice = "Closing dashboard. An already-started action is not claimed to be rolled back; inspect actual state when reopening.";
					if (kind === "confirm" || kind === "install") {
						// The mutating callback was dispatched before this Escape:
						// it is in flight and cannot be stopped, so the
						// before-it-started copy would be false. Report the
						// unobserved outcome honestly instead.
						openView("detail", "details");
						notice = kind === "confirm"
							? "Escape dismissed the wait, but candidate confirmation had already started and cannot be stopped. Its result is not reported here; press r to refresh actual state. No rollback is claimed."
							: "Escape dismissed the wait, but installation had already started and cannot be stopped. Its result is not reported here; press r to refresh actual state. No rollback is claimed.";
					} else if (kind === "preview") {
						// The preview build was dispatched too; it only reads local data.
						openView("detail", "details");
						notice = "Escape dismissed the wait. The preview build had already started; it reads local data only and makes no changes. Preview again to see its result.";
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
					// Same as the refresh action: discarding the preview also
					// leaves the preview view so the refresh cannot strand it.
					pendingPreview = undefined;
					openView("detail", "details");
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
					overviewScroll = 0;
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
				if (tab === "overview" && focus === "tabs") {
					// The overview body scrolls like detail/preview content: steps
					// share layoutFor with the renderer, so a step stops exactly on
					// the displayed tail and never past it.
					const layout = layoutFor(lastWidth);
					const total = overviewSurface(lastWidth).length;
					overviewScroll = clampScroll(overviewScroll + delta, total, contentWindow(layout, total));
					touch();
					return;
				}
				if (focus === "details" && (view === "detail" || view === "preview")) {
					// Steps share layoutFor with the renderer, so a step can stop
					// exactly on the displayed tail and never past it.
					const layout = layoutFor(lastWidth);
					if (view === "detail") {
						const total = detailSurface(lastWidth).length;
						detailScroll = clampScroll(detailScroll + delta, total, contentWindow(layout, total));
					} else {
						const total = wrappedRows(previewLines().lines, lastWidth).length;
						previewScroll = clampScroll(previewScroll + delta, total, previewWindow(layout));
					}
					touch();
					return;
				}
				if (focus === "actions") {
					// A focused strip chooses with ↑/↓ exactly as with ←/→ in every
					// view, so Enter fires precisely the labeled action under the
					// cursor instead of the stale first entry.
					moveAction(delta as 1 | -1);
					return;
				}
				return;
			}
			if (key === "pageup" || key === "pagedown") {
				const layout = layoutFor(lastWidth);
				if (tab === "overview" && focus === "tabs") {
					const total = overviewSurface(lastWidth).length;
					const step = contentWindow(layout, total);
					overviewScroll = clampScroll(overviewScroll + (key === "pagedown" ? step : -step), total, step);
					touch();
					return;
				}
				const detailTotal = detailSurface(lastWidth).length;
				const previewTotal = wrappedRows(previewLines().lines, lastWidth).length;
				const step = view === "preview" ? previewWindow(layout) : contentWindow(layout, detailTotal);
				const delta = key === "pagedown" ? step : -step;
				if (focus === "details" && view === "detail") {
					detailScroll = clampScroll(detailScroll + delta, detailTotal, contentWindow(layout, detailTotal));
					touch();
					return;
				}
				if (view === "preview") {
					previewScroll = clampScroll(previewScroll + delta, previewTotal, previewWindow(layout));
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
					focus = view === "browse" && listRows(tab).length > 0 && tab !== "overview" ? "list" : "actions";
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
