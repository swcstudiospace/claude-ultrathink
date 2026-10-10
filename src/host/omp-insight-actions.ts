// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Guarded dashboard actions for Native Omp GenUI: explicit candidate confirmation, deterministic
 * skill-draft preview receipts, and separately confirmed Omp installs. The adapter owns selection
 * binding and stale-selection validation; the existing teaching command dispatcher and installer
 * remain the only policy and filesystem authority. No second policy, no `--due` promotion, no
 * `mark-promoted`, no shell or slash-text dispatch, no new persistence schema.
 *
 * Admission sequence (all synchronous, no await between final validation and command entry):
 * cancelled lifetime -> stale session -> exact lesson identity -> fresh effective policy ->
 * project match -> exact revision match -> status/eligibility -> single-flight claim -> dispatch.
 * Success is established only from the actual lifecycle/retention/installer outcome plus a fresh
 * persisted reread. A zero exit code alone is never success.
 */
import { createHash } from "node:crypto";
import { runTeachCommand } from "../teach/cli.ts";
import type { CommandDeps } from "../teach/cli.ts";
import { teachEnabled } from "../teach/context.ts";
import { projectOf } from "../teach/mapping.ts";
import { CONTENT_MAX_BYTES, renderSkillDraft } from "../teach/promote.ts";
import { redactLine } from "../teach/redact.ts";
import { isValidId, openStore, storeDir } from "../teach/store.ts";
import type { TeachableMoment, TeachContext } from "../teach/types.ts";
import { insightLessonRevision } from "./omp-insights.ts";
import type { InsightActionResult, InsightScope, LessonSelection, SkillPreview } from "./omp-insights.ts";

/** Host-owned lifetime handle for one dashboard session. The host owns the epoch behind `isCurrent`. */
export interface InsightActionRuntime {
	scope: InsightScope;
	getContext: () => TeachContext;
	isCurrent: () => boolean;
	signal: AbortSignal;
}

/** One mutation at a time per process: a dashboard has a single action owner, so a module
 * flag is the whole single-flight domain. Always released in a `finally`. */
let mutationInFlight = false;

const CANCELLED_MESSAGE = "Action cancelled before it started. No lesson change or installation was requested.";

const BUSY_MESSAGE = "Another action is already running. Wait for it to finish before starting a new one.";

function refused(message: string): InsightActionResult {
	return { status: "refused", message };
}

function failed(message: string): InsightActionResult {
	return { status: "error", message };
}

interface Admitted {
	ctx: TeachContext;
	moment: TeachableMoment;
}

function isAdmitted(value: InsightActionResult | Admitted): value is Admitted {
	return !("status" in value);
}

/** Which refusal copy applies when teaching is off: config-off versus the process kill switch. */
function offReason(ctx: TeachContext): string {
	return ctx.config.teach.enabled
		? "Teaching is disabled by the process kill switch. Change it outside this dashboard, then reopen."
		: "Teaching is off. Saved lessons remain readable; confirmation, preview, and installation are unavailable.";
}

/** Exact-id read through the existing noncreating store path; undefined when missing or unreadable. */
function readExact(ctx: TeachContext, id: string): TeachableMoment | undefined {
	try {
		return openStore(storeDir(ctx.stateDir)).get(id);
	} catch {
		return undefined;
	}
}

/** Why an eligible-draft action cannot proceed, or undefined when the lesson is preview/install-ready. */
function eligibilityRefusal(moment: TeachableMoment, ctx: TeachContext): string | undefined {
	if (moment.status === "candidate") return "This lesson is still a candidate. Confirm it before previewing a skill draft.";
	if (moment.status === "superseded") return "This lesson was superseded and is read-only. Choose another lesson.";
	if (moment.status !== "confirmed" || moment.promoted) {
		return "A promotion is already recorded for this lesson. Promotion recorded — current installation not verified.";
	}
	if (!(moment.occurrences >= ctx.config.teach.promoteAfter || moment.kind === "playbook")) {
		return "This lesson does not meet the promotion rules yet. Eligible lessons are confirmed and unpromoted, with the configured occurrence count or playbook exception.";
	}
	return undefined;
}

/**
 * Fully synchronous admission: every check below runs without an await so the validated record
 * cannot change between the final check and entering the existing command. Returns the refusal
 * result, or the live context plus the freshly reread moment.
 */
function admitSelection(
	selection: LessonSelection,
	runtime: InsightActionRuntime,
	mode: "confirm" | "eligible",
): InsightActionResult | Admitted {
	if (runtime.signal.aborted) return { status: "cancelled", message: CANCELLED_MESSAGE };
	if (!runtime.isCurrent()) {
		return refused("Session changed. Dashboard closed; no further action was started for the old selection.");
	}
	if (!selection || typeof selection.id !== "string" || !isValidId(selection.id)) {
		return refused("Selected record is no longer in this snapshot. Choose another record.");
	}
	if (typeof selection.revision !== "string" || selection.revision === "") {
		return refused("Lesson or preview changed. No new action was started; refresh and preview again.");
	}
	const ctx = runtime.getContext();
	if (!teachEnabled(ctx)) return refused(offReason(ctx));
	if (ctx.stateDir !== runtime.scope.stateDir) {
		return refused("Session changed. Dashboard closed; no further action was started for the old selection.");
	}
	const moment = readExact(ctx, selection.id);
	if (!moment) {
		return refused("Selected record is no longer in this snapshot. Choose another record.");
	}
	if (moment.project !== projectOf(runtime.scope.cwd)) {
		return refused("Lesson or preview changed. No new action was started; refresh and preview again.");
	}
	if (insightLessonRevision(moment) !== selection.revision) {
		return refused("Lesson or preview changed. No new action was started; refresh and preview again.");
	}
	if (mode === "confirm") {
		if (moment.status !== "candidate") {
			return refused(
				`Candidate was not confirmed: lesson is ${moment.status}, not a candidate. Refresh the lesson before trying again.`,
			);
		}
		return { ctx, moment };
	}
	const ineligible = eligibilityRefusal(moment, ctx);
	if (ineligible) return refused(ineligible);
	return { ctx, moment };
}

/**
 * Dispatcher dependencies rebuilt from the live context: the same cwd, host, state, injected
 * config/clock/client seams and the dashboard lifetime signal, so the command enforces the same
 * effective policy the adapter just validated. `autoPromote` is never consulted: it governs
 * automation, not an explicit human approval.
 */
function depsFor(ctx: TeachContext, runtime: InsightActionRuntime): CommandDeps {
	const deps: CommandDeps = {
		cwd: ctx.cwd,
		env: { ...ctx.env, ULTRATHINK_HOST: ctx.host },
		stateDir: ctx.stateDir,
		config: ctx.config,
		signal: runtime.signal,
	};
	if (ctx.storePath !== undefined) deps.storePath = ctx.storePath;
	if (ctx.fetch) deps.fetch = ctx.fetch;
	if (ctx.now) deps.now = ctx.now;
	if (ctx.hindsight) deps.hindsight = ctx.hindsight;
	if (ctx.complete) deps.complete = ctx.complete;
	return deps;
}

function parseResultJson(text: string): Record<string, unknown> | undefined {
	try {
		const value: unknown = JSON.parse(text);
		if (value && typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
		return undefined;
	} catch {
		return undefined;
	}
}

function fingerprintOf(content: string): string {
	return createHash("sha256").update(content, "utf8").digest("hex");
}

const CONFIRM_RETAINS: Record<string, true> = { retained: true, queued: true, "local-only": true };

/**
 * Normalizes the `teach confirm` JSON envelope. The dispatcher never rejects, and a zero code
 * can still carry the original candidate after a write failure, so success requires the returned
 * status plus a fresh persisted reread to both read `confirmed`. Queued and local-only retention
 * are reported truthfully as pending, never as retained success.
 */
function normalizeConfirm(text: string, admitted: Admitted): InsightActionResult {
	const body = parseResultJson(text);
	const status = body?.status;
	const retain = body?.retain;
	const reason = body?.reason;
	if (body?.ok !== true || body.id !== admitted.moment.id || typeof status !== "string") {
		return failed("Candidate was not confirmed: the command did not return a readable result. Refresh the lesson before trying again.");
	}
	const fresh = readExact(admitted.ctx, admitted.moment.id);
	if (status !== "confirmed" || fresh?.status !== "confirmed") {
		const detail = typeof reason === "string" && reason !== "" ? redactLine(reason) : "no reason was returned";
		return refused(`Candidate was not confirmed: ${detail}. Refresh the lesson before trying again.`);
	}
	if (typeof retain !== "string" || !Object.hasOwn(CONFIRM_RETAINS, retain)) {
		return failed("Candidate was not confirmed: the command did not return a readable result. Refresh the lesson before trying again.");
	}
	const suffix = typeof reason === "string" && reason.trim() !== "" ? ` ${redactLine(reason)}` : "";
	return { status: "ok", message: `Candidate confirmed. Retention: ${retain}.${suffix}` };
}

/**
 * Normalizes the `teach promote --install` JSON envelope. Only an authoritative `created` or
 * `updated` outcome together with a matching `promoted` entry and a fresh persisted promotion
 * record reads as an Omp install. Refused, drafted, missing-outcome and changed-record paths
 * never read as success; a created/updated outcome without matching metadata stays a distinct
 * partial error, never a collapsed success.
 */
function installFailure(detail: string): InsightActionResult {
	return failed(`Installation did not return a successful Omp result: ${detail}. Refresh actual lesson state before trying again; no rollback is claimed.`);
}

function normalizeInstall(text: string, admitted: Admitted, draftName: string): InsightActionResult {
	const body = parseResultJson(text);
	const rawOutcome = body?.outcome;
	const outcomeRecord =
		rawOutcome && typeof rawOutcome === "object" && !Array.isArray(rawOutcome)
			? (rawOutcome as Record<string, unknown>)
			: undefined;
	const promoted = body?.promoted;
	if (!body || !outcomeRecord) return installFailure("the command returned no installer outcome");
	const action = outcomeRecord.action;
	const reason = typeof outcomeRecord.reason === "string" ? outcomeRecord.reason : undefined;
	if (action === "refused") {
		const detail = reason && reason.trim() !== "" ? redactLine(reason) : "no reason was returned";
		return refused(
			`Installation refused: ${detail}. Existing files were not replaced by this refused install; review the lesson/slot outside this dashboard, then preview again.`,
		);
	}
	if (action !== "created" && action !== "updated") {
		return installFailure(typeof action === "string" ? `installer reported ${redactLine(action, 40)}` : "the installer outcome is unreadable");
	}
	if (outcomeRecord.target !== "omp") {
		return installFailure("the installer outcome names a different target");
	}
	const path = typeof outcomeRecord.path === "string" ? outcomeRecord.path : "";
	const fresh = readExact(admitted.ctx, admitted.moment.id);
	const recorded =
		Array.isArray(promoted) &&
		promoted.includes(admitted.moment.id) &&
		fresh?.status === "promoted" &&
		fresh.promoted?.skill === draftName &&
		fresh.promoted?.target === "omp";
	if (!recorded) {
		return failed("Partial action result — installation and promotion metadata did not both complete. Refresh actual state before repeating the action.");
	}
	const past = action === "created" ? "created" : "updated";
	const destination = path !== "" ? ` Installed to ${redactLine(path)}.` : "";
	const recordedAt = fresh?.promoted && typeof fresh.promoted.at === "string" ? ` Promotion recorded at ${fresh.promoted.at}.` : "";
	return { status: "ok", message: `Skill ${past} in Omp.${destination}${recordedAt}` };
}

/** Explicit candidate confirmation through the existing `teach confirm` command. */
export async function confirmInsightLesson(
	selection: LessonSelection,
	runtime: InsightActionRuntime,
): Promise<InsightActionResult> {
	const admitted = admitSelection(selection, runtime, "confirm");
	if (!isAdmitted(admitted)) return admitted;
	if (mutationInFlight) return refused(BUSY_MESSAGE);
	mutationInFlight = true;
	try {
		const raw = await runTeachCommand(["confirm", admitted.moment.id, "--json"], depsFor(admitted.ctx, runtime));
		return normalizeConfirm(raw.text, admitted);
	} finally {
		mutationInFlight = false;
	}
}

/**
 * Deterministic local preview: calls the existing `renderSkillDraft` directly on the reread
 * moment with no `--due`, no skillworthy Jev, no writes, no network and no installation. The
 * receipt binds the source selection to the private full-draft fingerprint; display text is
 * never installed.
 */
export async function previewInsightSkill(
	selection: LessonSelection,
	runtime: InsightActionRuntime,
): Promise<InsightActionResult> {
	const admitted = admitSelection(selection, runtime, "eligible");
	if (!isAdmitted(admitted)) return admitted;
	let draft: { name: string; description: string; content: string; sourceIds: string[]; warnings: string[] };
	try {
		draft = renderSkillDraft([admitted.moment], admitted.ctx);
	} catch (error) {
		return failed(
			`Could not build a preview: ${redactLine(error instanceof Error ? error.message : String(error))}. Refresh the lesson before trying again.`,
		);
	}
	if (Buffer.byteLength(draft.content, "utf8") > CONTENT_MAX_BYTES || draft.content.trim() === "") {
		return failed("Could not build a preview: the deterministic draft exceeds the supported bounds. Refresh the lesson before trying again.");
	}
	if (!draft.sourceIds.includes(admitted.moment.id)) {
		return failed("Could not build a preview: the deterministic draft does not cover the selected lesson. Refresh the lesson before trying again.");
	}
	const preview: SkillPreview = {
		selection: { id: admitted.moment.id, revision: insightLessonRevision(admitted.moment) },
		fingerprint: fingerprintOf(draft.content),
		name: draft.name,
		description: draft.description,
		content: draft.content,
		warnings: [...draft.warnings],
	};
	return {
		status: "ok",
		message: "Preview only — not installed. Deterministic content from the selected lesson.",
		preview,
	};
}

/**
 * Separately confirmed Omp install: requires affirmative `confirmed` plus a live preview receipt,
 * regenerates the draft immediately before dispatch and compares its fingerprint against the
 * displayed preview. Any material change refuses and requires a new preview; the full
 * regenerated draft installs, never clipped display text. The existing installer stays
 * authoritative on destination, ownership, symlink and conflict refusal.
 */
export async function installInsightSkill(
	preview: SkillPreview,
	confirmed: boolean,
	runtime: InsightActionRuntime,
): Promise<InsightActionResult> {
	if (!preview || typeof preview !== "object" || !preview.selection || typeof preview.fingerprint !== "string") {
		return refused("Lesson or preview changed. No new action was started; refresh and preview again.");
	}
	if (confirmed !== true) {
		return refused("Install into Omp needs a separate confirmation. Review the preview, then confirm the installation.");
	}
	const admitted = admitSelection(preview.selection, runtime, "eligible");
	if (!isAdmitted(admitted)) return admitted;
	let draft: { name: string; description: string; content: string; sourceIds: string[]; warnings: string[] };
	try {
		draft = renderSkillDraft([admitted.moment], admitted.ctx);
	} catch (error) {
		return failed(
			`Installation did not return a successful Omp result: ${redactLine(error instanceof Error ? error.message : String(error))}. Refresh actual lesson state before trying again; no rollback is claimed.`,
		);
	}
	if (fingerprintOf(draft.content) !== preview.fingerprint) {
		return refused("Lesson or preview changed. No new action was started; refresh and preview again.");
	}
	if (mutationInFlight) return refused(BUSY_MESSAGE);
	mutationInFlight = true;
	try {
		const raw = await runTeachCommand(
			["promote", admitted.moment.id, "--target", "omp", "--install", "--json"],
			depsFor(admitted.ctx, runtime),
		);
		return normalizeInstall(raw.text, admitted, draft.name);
	} finally {
		mutationInFlight = false;
	}
}
