// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Shared read-model for Native Omp GenUI: scoped, noncreating, bounded,
 * sanitized projections of Jev/lesson/policy state. This module alone defines
 * the shared DTOs; the actions, presentation and host lanes import them.
 *
 * Passive inspection only: current-session `readSession`, noncreating store
 * reads, effective policy from the passed context. No credential/readiness
 * resolution, no recall counting, no store writes, no network, no model calls.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { readSession, sessionPath } from "../claude/state.ts";
import {
	DECISION_POINTS,
	DECISIONS_ERROR_KINDS,
	type DecisionAction,
	type DecisionPoint,
	type DecisionsErrorKind,
	formatP,
} from "../decisions/types.ts";
import { teachEnabled } from "../teach/context.ts";
import { projectOf } from "../teach/mapping.ts";
import { redactText } from "../teach/redact.ts";
import { isValidId, listRecentMoments, storeDir } from "../teach/store.ts";
import type {
	CaptureMode,
	MomentStatus,
	RetainState,
	SkillTarget,
	TeachableMoment,
	TeachContext,
} from "../teach/types.ts";

/** Rows kept per collection; anything beyond is disclosed, never silently dropped. */
export const INSIGHT_MAX_ROWS = 100;
/** Newest store files examined per snapshot (by file mtime), mirroring the skills lookup window. */
export const INSIGHT_SCAN_WINDOW = 500;
/** One moment file read per snapshot; anything larger was not written by the store. */
export const INSIGHT_MOMENT_BYTES = 64 * 1024;
/** Probability rows kept per decision. */
export const INSIGHT_MAX_QUESTIONS = 32;
/** Bounded collection sizes inside one lesson row. */
export const INSIGHT_MAX_LIST_ITEMS = 32;
/** Rows and columns of the plain-text fallback. */
export const INSIGHT_TEXT_MAX_ROWS = 24;
export const INSIGHT_TEXT_MAX_COLS = 120;
/** Card snapshots keep at most this many rows per collection (transcript-persisted). */
export const INSIGHT_CARD_MAX_ROWS = 24;

/** Private runtime identity of the owning session; never serialized into message details. */
export interface InsightScope {
	sessionId: string;
	cwd: string;
	stateDir: string;
	epoch: number;
}

/** Exact full lesson id plus a digest of the source state actions bind to. */
export interface LessonSelection {
	id: string;
	revision: string;
}

export interface InsightQuestionProbability {
	key: string;
	p: number;
}

/** Allowlisted Jev decision row: true recorded values, never recomputed or clamped. */
export interface InsightDecision {
	point: DecisionPoint;
	outcome: "ok" | "error";
	model: string;
	action: DecisionAction;
	threshold: number;
	latencyMs: number;
	attempts: number;
	at: number;
	p?: number;
	cost?: number;
	error?: DecisionsErrorKind;
	probabilities: Record<string, number>;
	questions: InsightQuestionProbability[];
}

export interface InsightPromotion {
	at: string;
	skill: string;
	target: SkillTarget;
	path?: string;
}

/** One project-scoped lesson with complete in-bound sanitized body. */
export interface InsightLesson {
	id: string;
	name: string;
	description: string;
	body: string;
	status: MomentStatus;
	kind: TeachableMoment["kind"];
	origin: TeachableMoment["origin"];
	host: string;
	occurrences: number;
	recalled: number;
	createdAt: string;
	lastSeenAt: string;
	sourcePhase: string;
	sourceArtifacts: string[];
	tags: string[];
	relatedIds: string[];
	supersedes?: string;
	selection: LessonSelection;
	/** Deterministic saved-lesson rule outcome, never a fresh Jev verdict. */
	eligible: boolean;
	/** Recorded promotion pointer, never proof of current installation. */
	promoted?: InsightPromotion;
}

export interface InsightPolicy {
	enabled: boolean;
	capture: CaptureMode;
	recall: boolean;
	recallLimit: number;
	recallChars: number;
	autoPromote: boolean;
	promoteAfter: number;
	jevEnabled: boolean;
}

/** Read-only projection consumed by every panel, card, fallback and action guard. */
export interface InsightSnapshot {
	project: string;
	session: string;
	at: number;
	decisions: InsightDecision[];
	lessons: InsightLesson[];
	policy: InsightPolicy;
	/** Counts over the shown project-scoped rows, never host-wide totals. */
	counts: Record<MomentStatus, number>;
	eligible: number;
	promoted: number;
	partial: boolean;
	limitations: string[];
}

export interface InsightCardLessonSummary {
	id: string;
	name: string;
	status: MomentStatus;
	kind: TeachableMoment["kind"];
	occurrences: number;
	eligible: boolean;
	promoted?: { at: string; skill: string; target: SkillTarget };
}

/**
 * Transcript-persisted card DTO: policy/counts/decision rows and lesson
 * summaries only. Lesson bodies, selection revisions, runtime scope and
 * private objects are excluded by construction.
 */
export interface InsightCardSnapshot {
	project: string;
	session: string;
	at: number;
	decisions: InsightDecision[];
	lessons: InsightCardLessonSummary[];
	policy: InsightPolicy;
	counts: Record<MomentStatus, number>;
	eligible: number;
	promoted: number;
	partial: boolean;
	limitations: string[];
}

/** Deterministic draft receipt bound to one selection; display text is never installed. */
export interface SkillPreview {
	selection: LessonSelection;
	fingerprint: string;
	name: string;
	description: string;
	content: string;
	warnings: string[];
}

export interface InsightInstallResult {
	action: string;
	skill?: string;
	path?: string;
}

/** Normalized action outcome; transport completion is never equated with success. */
export type InsightActionResult =
	| { status: "ok"; message: string; lifecycle?: MomentStatus; retention?: RetainState; install?: InsightInstallResult; preview?: SkillPreview }
	| { status: "refused"; message: string; lifecycle?: MomentStatus; preview?: SkillPreview }
	| { status: "error"; message: string; lifecycle?: MomentStatus; preview?: SkillPreview }
	| { status: "cancelled"; message: string };

export interface SanitizeOptions {
	home?: string;
	repoRoot?: string;
	multiline?: boolean;
	maxChars?: number;
}

const DEFAULT_SANITIZE_MAX_CHARS = 2_400;

const DECISION_ACTION_LIST: readonly string[] = [
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
];

const SKILL_TARGET_LIST: readonly string[] = ["hermes", "omp", "claude", "prime-agent", "drafts"];

// Control patterns are built from code points so this source stays printable:
// a raw control byte in a regex literal would read as binary to tooling.
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
const OSC_SEQUENCE = new RegExp(`${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`, "g");
const CSI_SEQUENCE = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, "g");
const C1_CONTROLS = new RegExp(`[${String.fromCharCode(128)}-${String.fromCharCode(159)}]`, "g");
const LONE_ESCAPE = new RegExp(ESC, "g");
/** Directional-spoofing and invisible characters that survive plain control strips. */
const BIDI_POINTS = [0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0x200b, 0x200c, 0x200d, 0xfeff, 0x00ad];
const BIDI_INVISIBLE = new RegExp(BIDI_POINTS.map((point) => String.fromCharCode(point)).join("|"), "g");
const OTHER_CONTROLS = ((): RegExp => {
	const chars: string[] = [];
	for (let code = 0; code <= 31; code += 1) {
		if (code === 9 || code === 10 || code === 13) continue;
		chars.push(String.fromCharCode(code));
	}
	chars.push(String.fromCharCode(127));
	return new RegExp(`[${chars.join("")}]`, "g");
})();

function capCodePoints(text: string, max: number): string {
	if (max < 0) return "";
	const points = Array.from(text);
	return points.length <= max ? text : points.slice(0, max).join("");
}

/**
 * Neutralize terminal controls BEFORE existing secret redaction (so secrets
 * split by controls still redact), then cap. Trusted theme ANSI is applied
 * only afterward by the presentation layer, never here.
 */
export function sanitizeInsightText(value: unknown, options: SanitizeOptions = {}): string {
	if (typeof value !== "string") return "";
	const max = options.maxChars ?? DEFAULT_SANITIZE_MAX_CHARS;
	let text = value
		.replace(OSC_SEQUENCE, "")
		.replace(CSI_SEQUENCE, "")
		.replace(C1_CONTROLS, "")
		.replace(LONE_ESCAPE, "")
		.replace(BIDI_INVISIBLE, "")
		.replace(OTHER_CONTROLS, "")
		.replace(/\r/g, "")
		.replace(/\t/g, "");
	text = options.multiline ? text : text.replace(/\n/g, " ");
	let redacted: string;
	try {
		redacted = redactText(text, { home: options.home, repoRoot: options.repoRoot });
	} catch {
		redacted = "[redacted]";
	}
	return capCodePoints(redacted, Math.max(0, Math.floor(max)));
}

/** Revision digest over the source fields that affect eligibility and drafts. */
export function insightLessonRevision(moment: TeachableMoment): string {
	const promoted = moment.promoted
		? `${moment.promoted.at} ${moment.promoted.skill} ${moment.promoted.target} ${moment.promoted.path ?? ""}`
		: "";
	return createHash("sha256")
		.update(
			[moment.id, moment.kind, moment.status, String(moment.occurrences), moment.name, moment.description, moment.body, promoted].join(" "),
			"utf8",
		)
		.digest("hex");
}

function isFiniteInRange(value: unknown, min: number, max: number): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

function cleanProbabilities(raw: unknown): { probabilities: Record<string, number>; questions: InsightQuestionProbability[] } {
	const probabilities: Record<string, number> = {};
	const questions: InsightQuestionProbability[] = [];
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { probabilities, questions };
	for (const [key, p] of Object.entries(raw)) {
		if (questions.length >= INSIGHT_MAX_QUESTIONS) break;
		if (key.length === 0 || key.length > 80) continue;
		if (!isFiniteInRange(p, 0, 1)) continue;
		probabilities[key] = p;
		questions.push({ key, p });
	}
	return { probabilities, questions };
}

interface SanitizeContext {
	home?: string;
	repoRoot?: string;
}

/** Allowlisted Jev row; undefined for unknown/out-of-range rows (rejected, never clamped). */
function projectDecision(raw: unknown, redact: SanitizeContext): InsightDecision | undefined {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
	const record = raw as Record<string, unknown>;
	if (!(DECISION_POINTS as readonly unknown[]).includes(record.point)) return undefined;
	if (record.outcome !== "ok" && record.outcome !== "error") return undefined;
	if (typeof record.model !== "string" || record.model.length === 0) return undefined;
	if (typeof record.action !== "string" || !DECISION_ACTION_LIST.includes(record.action)) return undefined;
	if (!isFiniteInRange(record.threshold, 0, 1)) return undefined;
	if (!isFiniteInRange(record.latencyMs, 0, Number.MAX_SAFE_INTEGER)) return undefined;
	if (typeof record.attempts !== "number" || !Number.isInteger(record.attempts) || record.attempts < 0) return undefined;
	if (!isFiniteInRange(record.at, 0, Number.MAX_SAFE_INTEGER)) return undefined;
	let p: number | undefined;
	if (record.p !== undefined) {
		if (!isFiniteInRange(record.p, 0, 1)) return undefined;
		p = record.p;
	}
	let cost: number | undefined;
	if (record.cost !== undefined) {
		if (!isFiniteInRange(record.cost, 0, Number.MAX_SAFE_INTEGER)) return undefined;
		cost = record.cost;
	}
	let error: DecisionsErrorKind | undefined;
	if (record.error !== undefined) {
		if (!(DECISIONS_ERROR_KINDS as readonly unknown[]).includes(record.error)) return undefined;
		error = record.error as DecisionsErrorKind;
	}
	if (record.outcome === "ok" && error !== undefined) return undefined;
	const { probabilities, questions } = cleanProbabilities(record.probabilities);
	return {
		point: record.point as DecisionPoint,
		outcome: record.outcome,
		model: sanitizeInsightText(record.model, { ...redact, maxChars: 200 }),
		action: record.action as DecisionAction,
		threshold: record.threshold as number,
		latencyMs: record.latencyMs as number,
		attempts: record.attempts as number,
		at: record.at as number,
		...(p === undefined ? {} : { p }),
		...(cost === undefined ? {} : { cost }),
		...(error === undefined ? {} : { error }),
		probabilities,
		questions,
	};
}

function cleanStringList(raw: unknown, maxChars: number, redact: SanitizeContext): string[] {
	if (!Array.isArray(raw)) return [];
	const out: string[] = [];
	for (const item of raw) {
		if (out.length >= INSIGHT_MAX_LIST_ITEMS) break;
		if (typeof item !== "string" || item.length === 0) continue;
		out.push(sanitizeInsightText(item, { ...redact, maxChars }));
	}
	return out;
}

function projectPromotion(raw: TeachableMoment["promoted"], redact: SanitizeContext): InsightPromotion | undefined {
	if (raw === undefined) return undefined;
	if (!SKILL_TARGET_LIST.includes(raw.target)) return undefined;
	const promotion: InsightPromotion = {
		at: sanitizeInsightText(raw.at, { ...redact, maxChars: 64 }),
		skill: sanitizeInsightText(raw.skill, { ...redact, maxChars: 120 }),
		target: raw.target,
	};
	if (raw.path !== undefined) promotion.path = sanitizeInsightText(raw.path, { ...redact, maxChars: 300 });
	return promotion;
}

function isEligible(kind: TeachableMoment["kind"], status: MomentStatus, occurrences: number, promoted: boolean, promoteAfter: number): boolean {
	return status === "confirmed" && !promoted && (occurrences >= promoteAfter || kind === "playbook");
}

function projectLesson(moment: TeachableMoment, promoteAfter: number, redact: SanitizeContext): InsightLesson {
	const promoted = projectPromotion(moment.promoted, redact);
	const lesson: InsightLesson = {
		id: moment.id,
		name: sanitizeInsightText(moment.name, { ...redact, maxChars: 120 }),
		description: sanitizeInsightText(moment.description, { ...redact, maxChars: 300 }),
		body: sanitizeInsightText(moment.body, { ...redact, multiline: true, maxChars: 2_400 }),
		status: moment.status,
		kind: moment.kind,
		origin: moment.origin,
		host: sanitizeInsightText(moment.host, { ...redact, maxChars: 120 }),
		occurrences: moment.occurrences,
		recalled: moment.recalled,
		createdAt: sanitizeInsightText(moment.createdAt, { ...redact, maxChars: 64 }),
		lastSeenAt: sanitizeInsightText(moment.lastSeenAt, { ...redact, maxChars: 64 }),
		sourcePhase: sanitizeInsightText(moment.sourcePhase, { ...redact, maxChars: 300 }),
		sourceArtifacts: cleanStringList(moment.sourceArtifacts, 200, redact),
		tags: cleanStringList(moment.tags, 40, redact),
		relatedIds: cleanStringList(moment.relatedIds, 80, redact),
		selection: { id: moment.id, revision: insightLessonRevision(moment) },
		eligible: isEligible(moment.kind, moment.status, moment.occurrences, promoted !== undefined, promoteAfter),
		...(moment.supersedes !== undefined ? { supersedes: sanitizeInsightText(moment.supersedes, { ...redact, maxChars: 80 }) } : {}),
		...(promoted === undefined ? {} : { promoted }),
	};
	return lesson;
}

const TEACH_JEV_NOTE = "Teaching Jev history is not recorded. Lesson state is not a verdict receipt.";
const WORKER_NOTE = "Detached worker outcomes are not recorded. No completion or install result can be inferred.";
const PARTIAL_NOTE = "Partial snapshot — some local data could not be read. Available records remain visible; press r to refresh.";
const SCAN_LIMIT_NOTE = "Showing up to 100 local records; this is not a complete inventory.";
/** Neutral display-cap disclosure: a complete read capped for display is healthy, never a failed read. */
export const RECORD_LIMIT_NOTE = `Only the newest ${INSIGHT_MAX_ROWS} records are shown.`;
const CANCEL_NOTE = "Snapshot refresh was cancelled; showing available records.";

/**
 * Scoped read-model snapshot. Reads the current session envelope only (never
 * another session's record), scans the existing store without creating it,
 * and reports honest missing/partial explanations instead of invented history.
 */
export async function readInsightSnapshot(scope: InsightScope, ctx: TeachContext, signal?: AbortSignal): Promise<InsightSnapshot> {
	const redact: SanitizeContext = { home: ctx.env.HOME ?? ctx.env.USERPROFILE, repoRoot: scope.cwd };
	const project = projectOf(scope.cwd);
	const session = sanitizeInsightText(scope.sessionId, { ...redact, maxChars: 120 });
	const limitations: string[] = [TEACH_JEV_NOTE, WORKER_NOTE];
	let partial = false;
	const markPartial = (note: string): void => {
		partial = true;
		if (!limitations.includes(note)) limitations.push(note);
	};
	/** Disclosure without the failure flag: the display cap hides nothing that was unread. */
	const noteLimit = (note: string): void => {
		if (!limitations.includes(note)) limitations.push(note);
	};
	const cancelled = (): boolean => signal?.aborted === true || ctx.signal?.aborted === true;

	if (cancelled()) markPartial(CANCEL_NOTE);

	// Jev: current-session envelope only.
	let decisions: InsightDecision[] = [];
	try {
		if (!existsSync(sessionPath(scope.stateDir, scope.sessionId))) {
			limitations.push(
				"No saved Jev decisions for this session (no saved plan was found). This view reads the latest saved plan, not a complete history.",
			);
		} else {
			const record = readSession(scope.stateDir, scope.sessionId);
			if (record === undefined || record.sessionId !== scope.sessionId) {
				markPartial("Could not read local snapshot: the saved session record could not be parsed. Press r to refresh or Esc to close; no lesson changes were made by this read.");
			} else if (!("decisions" in record) || record.decisions === undefined) {
				limitations.push(
					"No saved Jev decisions for this session (the saved plan recorded no decisions). This view reads the latest saved plan, not a complete history.",
				);
			} else if (!Array.isArray(record.decisions)) {
				markPartial("Could not read local snapshot: the saved decision list could not be read. Press r to refresh or Esc to close; no lesson changes were made by this read.");
			} else if (record.decisions.length === 0) {
				limitations.push(
					"No saved Jev decisions for this session (the saved plan holds an empty decision list). This view reads the latest saved plan, not a complete history.",
				);
			} else {
				const valid: InsightDecision[] = [];
				let rejected = 0;
				for (const raw of record.decisions) {
					if (cancelled()) {
						markPartial(CANCEL_NOTE);
						break;
					}
					const projected = projectDecision(raw, redact);
					if (projected) valid.push(projected);
					else rejected += 1;
				}
				// Newest settled first; stored call order survives ties (stable sort), never deduplicated.
				valid.sort((a, b) => b.at - a.at);
				if (valid.length > INSIGHT_MAX_ROWS) {
					decisions = valid.slice(0, INSIGHT_MAX_ROWS);
					noteLimit(RECORD_LIMIT_NOTE);
				} else {
					decisions = valid;
				}
				if (rejected > 0) markPartial(`${rejected} saved decision row${rejected === 1 ? " was" : "s were"} excluded (unknown or out-of-range values are never clamped into verdicts).`);
			}
		}
	} catch {
		markPartial("Could not read local snapshot: the saved session record could not be read. Press r to refresh or Esc to close; no lesson changes were made by this read.");
		decisions = [];
	}

	// Lessons: current-project rows from the existing store; missing stores stay missing.
	let lessons: InsightLesson[] = [];
	try {
		const dir = storeDir(scope.stateDir);
		if (!existsSync(dir)) {
			lessons = [];
		} else {
			let candidates = 0;
			try {
				const files = await readdir(`${dir}/moments`);
				candidates = files.filter((file) => file.endsWith(".json") && isValidId(file.slice(0, -".json".length))).length;
			} catch (error) {
				candidates = 0;
				// A missing moments directory is an honestly empty store; any other read
				// failure is disclosed instead of passing as an empty store.
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
					markPartial(
						"Could not read local snapshot: the lesson directory could not be read. Press r to refresh or Esc to close; no lesson changes were made by this read.",
					);
				}
			}
			const scanned = await listRecentMoments(dir, { max: INSIGHT_SCAN_WINDOW, maxBytes: INSIGHT_MOMENT_BYTES, signal });
			if (cancelled()) markPartial(CANCEL_NOTE);
			if (scanned.length < candidates) markPartial(PARTIAL_NOTE);
			if (candidates > INSIGHT_SCAN_WINDOW) markPartial(SCAN_LIMIT_NOTE);
			const promoteAfter = ctx.config.teach.promoteAfter;
			const scoped = scanned.filter((moment) => moment.project === project);
			scoped.sort((a, b) => (a.createdAt === b.createdAt ? (a.id < b.id ? -1 : 1) : a.createdAt < b.createdAt ? 1 : -1));
			if (scoped.length > INSIGHT_MAX_ROWS) {
				lessons = scoped.slice(0, INSIGHT_MAX_ROWS).map((moment) => projectLesson(moment, promoteAfter, redact));
				noteLimit(RECORD_LIMIT_NOTE);
			} else {
				lessons = scoped.map((moment) => projectLesson(moment, promoteAfter, redact));
			}
		}
	} catch {
		markPartial(PARTIAL_NOTE);
		lessons = [];
	}

	const counts: Record<MomentStatus, number> = { candidate: 0, confirmed: 0, promoted: 0, superseded: 0 };
	for (const lesson of lessons) counts[lesson.status] += 1;
	const eligible = lessons.filter((lesson) => lesson.eligible).length;
	const promoted = lessons.filter((lesson) => lesson.promoted !== undefined).length;
	const policy: InsightPolicy = {
		enabled: teachEnabled(ctx),
		capture: ctx.config.teach.capture,
		recall: ctx.config.teach.recall,
		recallLimit: ctx.config.teach.recallLimit,
		recallChars: ctx.config.teach.recallChars,
		autoPromote: ctx.config.teach.autoPromote,
		promoteAfter: ctx.config.teach.promoteAfter,
		jevEnabled: ctx.config.decisions !== undefined,
	};
	return { project, session, at: Date.now(), decisions, lessons, policy, counts, eligible, promoted, partial, limitations };
}

/** Re-sanitized question rows for transcript persistence; invalid rows are dropped, never clamped. */
function cleanCardQuestions(raw: unknown): { key: string; p: number }[] {
	if (!Array.isArray(raw)) return [];
	const out: { key: string; p: number }[] = [];
	for (const item of raw) {
		if (out.length >= INSIGHT_MAX_QUESTIONS) break;
		if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
		const key = sanitizeInsightText((item as Record<string, unknown>).key, { maxChars: 80 });
		const p = (item as Record<string, unknown>).p;
		if (key === "" || !isFiniteInRange(p, 0, 1)) continue;
		out.push({ key, p: p as number });
	}
	return out;
}

/** Re-sanitized probability map for transcript persistence; invalid entries are dropped. */
function cleanCardProbabilities(raw: unknown): Record<string, number> {
	const out: Record<string, number> = {};
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
	for (const [key, p] of Object.entries(raw)) {
		if (Object.keys(out).length >= INSIGHT_MAX_QUESTIONS) break;
		const cleanKey = sanitizeInsightText(key, { maxChars: 80 });
		if (cleanKey === "" || !isFiniteInRange(p, 0, 1)) continue;
		out[cleanKey] = p as number;
	}
	return out;
}

 /**
  * Independent transcript-persisted card DTO. All free text is re-sanitized on
  * intake (persisted cards are untrusted), and bodies, selection revisions,
  * runtime scope and private objects are excluded by construction. Truncation
  * to INSIGHT_CARD_MAX_ROWS per collection is disclosed with bounded omission
  * notes in `limitations`; the DTO shape itself is unchanged.
  */
 export function toInsightCardSnapshot(snapshot: InsightSnapshot): InsightCardSnapshot {
 	const redact: SanitizeContext = {};
 	const decisions = snapshot.decisions.slice(0, INSIGHT_CARD_MAX_ROWS).map((decision) => ({
 		...decision,
 		model: sanitizeInsightText(decision.model, { ...redact, maxChars: 200 }),
		probabilities: cleanCardProbabilities(decision.probabilities),
		questions: cleanCardQuestions(decision.questions),
 	}));
 	const lessons: InsightCardLessonSummary[] = snapshot.lessons.slice(0, INSIGHT_CARD_MAX_ROWS).map((lesson) => ({
 		id: sanitizeInsightText(lesson.id, { ...redact, maxChars: 80 }),
 		name: sanitizeInsightText(lesson.name, { ...redact, maxChars: 120 }),
 		status: lesson.status,
 		kind: lesson.kind,
 		occurrences: lesson.occurrences,
 		eligible: lesson.eligible,
 		...(lesson.promoted === undefined
 			? {}
 			: {
 					promoted: {
						at: sanitizeInsightText(lesson.promoted.at, { ...redact, maxChars: 64 }),
 						skill: sanitizeInsightText(lesson.promoted.skill, { ...redact, maxChars: 120 }),
 						target: lesson.promoted.target,
 					},
 				}),
 	}));
	const limitations = snapshot.limitations.map((limitation) => sanitizeInsightText(limitation, { ...redact, maxChars: 300 }));
	const omittedDecisions = snapshot.decisions.length - decisions.length;
	if (omittedDecisions > 0) {
		limitations.push(
			`${omittedDecisions} more decision${omittedDecisions === 1 ? "" : "s"} omitted — card keeps ${INSIGHT_CARD_MAX_ROWS} per collection; open /ultrathink-ui for the full view.`,
		);
	}
	const omittedLessons = snapshot.lessons.length - lessons.length;
	if (omittedLessons > 0) {
		limitations.push(
			`${omittedLessons} more lesson${omittedLessons === 1 ? "" : "s"} omitted — card keeps ${INSIGHT_CARD_MAX_ROWS} per collection; open /ultrathink-ui for the full view.`,
		);
	}
 	return {
 		project: sanitizeInsightText(snapshot.project, { ...redact, maxChars: 120 }),
 		session: sanitizeInsightText(snapshot.session, { ...redact, maxChars: 120 }),
 		at: snapshot.at,
 		decisions,
 		lessons,
 		policy: { ...snapshot.policy },
 		counts: { ...snapshot.counts },
 		eligible: snapshot.eligible,
 		promoted: snapshot.promoted,
 		partial: snapshot.partial,
		limitations,
 	};
 }

function fitCell(text: string, width: number): string {
	const segments = new Intl.Segmenter(undefined, { granularity: "grapheme" });
	let used = 0;
	let out = "";
	for (const { segment } of segments.segment(text)) {
		const w = Bun.stringWidth(segment);
		if (used + w > width) {
			while (out.length > 0 && used + 1 > width) {
				const points = Array.from(out);
				used -= Bun.stringWidth(points[points.length - 1] ?? "");
				out = points.slice(0, -1).join("");
			}
			return `${out}…`;
		}
		out += segment;
		used += w;
	}
	return out;
}

/** Bounded plain-text fallback: at most 24 rows of 120 visible columns, no controls. */
export function formatInsightText(snapshot: InsightSnapshot): string {
	const rows: string[] = [];
	rows.push(`Ultrathink snapshot — Project: ${snapshot.project} | Session: ${snapshot.session}`);
	const latest = snapshot.decisions[0];
	if (latest) {
		const p = latest.p === undefined ? "Not recorded" : formatP(latest.p);
		rows.push(`Latest Jev: ${latest.point} ${latest.action} (P ${p})${latest.error ? ` [${latest.error}]` : ""}`);
	} else {
		rows.push("No saved Jev decisions for this session");
	}
	rows.push(
		`Autonomy: teaching ${snapshot.policy.enabled ? "on" : "off"}; capture ${snapshot.policy.capture}; eligible ${snapshot.eligible}; promoted ${snapshot.promoted}`,
	);
	const available = Math.max(0, INSIGHT_TEXT_MAX_ROWS - rows.length - snapshot.limitations.length - 2);
	const shown = snapshot.lessons.slice(0, Math.max(0, available - (snapshot.lessons.length > available ? 1 : 0)));
	rows.push(`Lessons for ${snapshot.project} (${shown.length} of ${snapshot.lessons.length} shown):`);
	for (const lesson of shown) {
		rows.push(`- [${lesson.status}] ${lesson.name} (x${lesson.occurrences})${lesson.eligible ? " — eligible by saved lesson rules" : ""}`);
	}
	if (shown.length < snapshot.lessons.length) rows.push(`Note: ${snapshot.lessons.length - shown.length} more lessons omitted from this text.`);
	for (const limitation of snapshot.limitations) rows.push(`Note: ${limitation}`);
	rows.push("Guarded actions require the Omp TUI (/ultrathink-ui).");
	return rows
		.slice(0, INSIGHT_TEXT_MAX_ROWS)
		.map((row) => fitCell(sanitizeInsightText(row, { maxChars: INSIGHT_TEXT_MAX_COLS * 4 }), INSIGHT_TEXT_MAX_COLS))
		.join("\n");
}
