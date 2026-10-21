// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * On-disk state for the ultrathink Claude Code plugin. Hooks are one-shot
 * processes, so this lives under ~/.claude/ultrathink instead of in-session.
 */
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { type LockOptions, withFileLock, writeFileAtomic, withLockMutation } from "./atomic.ts";
import type { DecisionRecord } from "../decisions/types.ts";
import type { Clarification } from "../hitl/types.ts";
import { THINK_ENGINES, type ThinkEngine, type ThoughtGraph } from "../think/types.ts";
import type { TrackingRefs, TrackPlan } from "../track/types.ts";
import type { UpliftResult } from "../types.ts";
import type { SkillInvocation } from "../uplift/skill.ts";
import type { ModelResolution } from "../host/engine.ts";
import { resolveStateDir } from "../host/paths.ts";
import type { ShipState } from "../ship/types.ts";
import type { KnowledgeLookup } from "../greptile/knowledge.ts";
import type { DocsLookup } from "../ragflow/types.ts";
import type { LessonsLookup, SkillsLookup } from "../teach/types.ts";

export interface ControlState {
	enabled?: boolean;
	thinkEnabled?: boolean;
	hitlEnabled?: boolean;
	/** Create Linear/Notion rows; overrides `track.enabled` from config. `false` also stops kickoff from creating them. */
	trackEnabled?: boolean;
	engine?: ThinkEngine;
}

export interface SessionRecord {
	sessionId: string;
	at: number;
	/** Thinking engine label: the selected route and its wire model, e.g. "claude:<model>", "<model>@<effort>" or "<shuntModel or model>@shunt". */
	engine?: string;
	/**
	 * Safe selection record (UT-Planning-ModelSelection §6) of the engine that planned this prompt: allowlisted and
	 * display-safe, never a Model, endpoint or credential. Set only on a real persisted plan; absent on older records.
	 */
	modelResolution?: ModelResolution;
	/** First engine error message (redacted), when a plan call threw; explains a fallback source. */
	engineError?: string;
	/** Plan stages that fell back to boilerplate, in run order: "uplift", "graph", "fill:<nodeId>". Absent when every stage used LLM output. */
	degraded?: string[];
	/** Host that planned this prompt. Absent on records written before multi-host support. */
	host?: string;
	result: UpliftResult;
	graph?: ThoughtGraph;
	clarifications?: Clarification[];
	plan?: TrackPlan;
	/**
	 * Set true once ultrathink-kickoff has run for the plan in this record. Plan-scoped: the record holds the session's
	 * latest plan, so the next planned prompt writes a new graph with kickedOff and synced false again.
	 */
	kickedOff?: boolean;
	/** Set true once ultrathink-sync has run at least once for the plan in this record (plan-scoped, like kickedOff). */
	synced?: boolean;
	/** Tracker rows the planner created (Linear issues/sub-issues, Notion rows). */
	tracking?: TrackingRefs;
	/** The skill the user invoked; the plan covers its instruction, the skill owns the workflow. */
	skill?: { name: string; summary?: string; source: SkillInvocation["source"] };
	/** Ship lifecycle (assess -> PR -> review -> merge) after a GSD skill run. */
	ship?: ShipState;
	/** Greptile knowledge-base lookup the planner ran before the HITL clarify step. */
	knowledge?: KnowledgeLookup;
	/** Teachable Moments lessons lookup the planner ran (no lesson text). Absent on older records and when none ran. */
	lessons?: LessonsLookup;
	/** Teachable Moments skills lookup the planner ran (skill names only). Absent on older records and when none ran. */
	skills?: SkillsLookup;
	/** RAGFlow grounding lookup the planner ran (no document text). Absent on older records and when none ran. */
	docs?: DocsLookup;
	/** Jev decisions made while planning this prompt (plan, knowledge, blocking), in call order. Absent on older records and when none ran. */
	decisions?: DecisionRecord[];
	/** Repos of the files this session's edit/write tools changed (omp), sorted and unique. Attribution only; never changes the label. */
	workRepos?: string[];
	/**
	 * Set when an edited repo differs from the plan's labelled repo (`plan.task.repo`; null when the plan has none).
	 * `edited` is the full `workRepos` at that point, so a warning fires once per distinct edited set.
	 */
	repoMismatch?: { labelled: string | null; edited: string[] } | null;
}

export function defaultStateDir(env: Record<string, string | undefined> = process.env): string {
	return resolveStateDir(env);
}

function readJson(path: string): unknown {
	try {
		if (!existsSync(path)) return undefined;
		return JSON.parse(readFileSync(path, "utf8")) as unknown;
	} catch {
		return undefined;
	}
}

/** Owner-only and atomic: a crash mid-write leaves the previous file, never a truncated one. */
function writeJson(path: string, value: unknown): void {
	writeFileAtomic(path, `${JSON.stringify(value, null, "\t")}\n`);
}

export function controlPath(dir: string): string {
	return join(dir, "control.json");
}

export function readControl(dir: string): ControlState {
	const raw = readJson(controlPath(dir));
	if (!raw || typeof raw !== "object") return {};
	const rec = raw as Record<string, unknown>;
	const out: ControlState = {};
	if (typeof rec.enabled === "boolean") out.enabled = rec.enabled;
	if (typeof rec.thinkEnabled === "boolean") out.thinkEnabled = rec.thinkEnabled;
	if (typeof rec.hitlEnabled === "boolean") out.hitlEnabled = rec.hitlEnabled;
	if (typeof rec.trackEnabled === "boolean") out.trackEnabled = rec.trackEnabled;
	if (THINK_ENGINES.includes(rec.engine as ThinkEngine)) out.engine = rec.engine as ThinkEngine;
	return out;
}

/** Merges `patch` into control.json; the read-merge-write runs under the file's lock so two toggles never undo each other. */
export function writeControl(dir: string, patch: ControlState): ControlState {
	// The lock file lives next to control.json, so the directory must exist before the lock is taken.
	try {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
	} catch {
		// writeJson reports the same failure below
	}
	return withFileLock(controlPath(dir), () => {
		const next = { ...readControl(dir), ...patch };
		writeJson(controlPath(dir), next);
		return next;
	});
}

/** A plain session id keeps its name: lowercase, letters, digits, `_`, `.`, `-`, at most 120 characters. */
const PLAIN_SESSION_ID_RE = /^[a-z0-9_.-]{1,120}$/;

/**
 * The file-name stem of a session id. Host ids are case-sensitive and may hold characters a file name cannot, and macOS
 * and Windows ignore case: `Claude-A` and `claude-a` would then share one record and one skip flag. A plain id keeps its
 * name; any other id gets a readable lowercase slug plus a hash of the exact id after `~`, which a plain id never holds.
 * Every stem is lowercase, and distinct ids get distinct stems.
 */
function safeSessionId(id: string): string {
	if (PLAIN_SESSION_ID_RE.test(id)) return id;
	const slug = Array.from(id, (char) => (/[A-Za-z0-9_.-]/.test(char) ? char.toLowerCase() : "_")).join("").slice(0, 80);
	return `${slug}~${createHash("sha256").update(id).digest("hex").slice(0, 16)}`;
}

/**
 * The host's session id, trimmed, or undefined when it names no session: blank, or Prime Agent's `unknown` placeholder
 * for a kernel with no session. Such a prompt gets its own turn id, never a record or skip flag shared by every prompt.
 */
export function hostSessionId(id: string | undefined): string | undefined {
	const trimmed = id?.trim();
	return trimmed && trimmed !== "unknown" ? trimmed : undefined;
}

export function sessionPath(dir: string, sessionId: string): string {
	return join(dir, "sessions", `${safeSessionId(sessionId)}.json`);
}

/**
 * Where earlier builds wrote this id's record: the id with characters a file name cannot hold replaced by `_`, its case
 * kept. Only read as a fallback; a record found there is used only when its stored sessionId is this id, since on a
 * case-insensitive file system `Claude-A.json` is also `claude-a.json`.
 */
export function legacySessionPath(dir: string, sessionId: string): string {
	return join(dir, "sessions", `${sessionId.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 120) || "unknown"}.json`);
}

/**
 * The file that holds this session's record: its current name, or the earlier name when only that file exists and names
 * this id. Otherwise the current name, which may not exist yet.
 */
export function sessionRecordPath(dir: string, sessionId: string): string {
	const current = sessionPath(dir, sessionId);
	if (existsSync(current)) return current;
	const legacy = legacySessionPath(dir, sessionId);
	if (legacy !== current && existsSync(legacy)) {
		const raw = readJson(legacy) as { sessionId?: unknown } | undefined;
		if (raw && typeof raw === "object" && raw.sessionId === sessionId) return legacy;
	}
	return current;
}

/** A fresh id for a turn whose host gave no session id: unique to that prompt, so no turn reads or writes another's state. */
export function newTurnSessionId(): string {
	return `turn-${randomUUID()}`;
}

const TURN_SESSION_RE = /^turn-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isTurnSessionId(id: string): boolean {
	return TURN_SESSION_RE.test(id);
}

/**
 * Path of a session's armed /ultrathink-skip. A flag file beside the session's record, not part of it: a session can be
 * skipped before its first plan writes a record. The `.skip` suffix keeps it out of the `sessions/*.json` record count.
 */
export function skipOncePath(dir: string, sessionId: string): string {
	return join(dir, "sessions", `${safeSessionId(sessionId)}.skip`);
}

export function readSkipOnce(dir: string, sessionId: string): boolean {
	return existsSync(skipOncePath(dir, sessionId));
}

export function armSkipOnce(dir: string, sessionId: string): void {
	writeFileAtomic(skipOncePath(dir, sessionId), "skip\n");
}

/** Clears the session's armed skip; an already clear session is left as it is. */
export function clearSkipOnce(dir: string, sessionId: string): void {
	try {
		unlinkSync(skipOncePath(dir, sessionId));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
	}
}

export function readSession(dir: string, sessionId: string): SessionRecord | undefined {
	const raw = readJson(sessionRecordPath(dir, sessionId));
	if (!raw || typeof raw !== "object") return undefined;
	const rec = raw as Partial<SessionRecord>;
	// A file names its session: on a case-insensitive file system another id's record can share this file's name.
	if (rec.sessionId !== sessionId || !rec.result || typeof rec.result !== "object") return undefined;
	return rec as SessionRecord;
}

const LAST_LOCK_WAIT_MS = 5;
const LAST_LOCK_ATTEMPTS = 40;
const LAST_LOCK_STALE_MS = 5_000;
const LAST_LOCK_SLEEP = new Int32Array(new SharedArrayBuffer(4));

/** True for a live PID, a fresh empty lock, or an existing lock that cannot be safely inspected. */
export function lastLockHeld(lockPath: string): boolean {
	let text: string;
	try {
		text = readFileSync(lockPath, "utf8").trim();
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== "ENOENT";
	}
	if (!text) {
		try {
			return Date.now() - statSync(lockPath).mtimeMs <= LAST_LOCK_STALE_MS;
		} catch (error) {
			return (error as NodeJS.ErrnoException).code !== "ENOENT";
		}
	}
	const pid = Number(text);
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * Exclusive lock for `last.json`. A busy lock does not run `body`: replacing the current plan is worse than
 * leaving the previous copy, so this does not degrade to an unlocked write the way `withFileLock` does.
 * Returns false when the lock cannot be taken within 200ms. A dead pid is reclaimed immediately and an empty
 * lock after 5s; a live pid stays protected regardless of the lock's age.
 */
export function withLastLock(lastPath: string, body: () => void): boolean {
	const lockPath = `${lastPath}.lock`;
	let fd: number | undefined;
	for (let attempt = 0; attempt < LAST_LOCK_ATTEMPTS && fd === undefined; attempt++) {
		try {
			fd = withLockMutation(lockPath, () => {
				if (lastLockHeld(lockPath)) return undefined;
				try {
					unlinkSync(lockPath);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				}
				const opened = openSync(lockPath, "wx", 0o600);
				try {
					writeFileSync(opened, String(process.pid));
					return opened;
				} catch (error) {
					closeSync(opened);
					unlinkSync(lockPath);
					throw error;
				}
			});
		} catch {
			return false;
		}
		if (fd === undefined) Atomics.wait(LAST_LOCK_SLEEP, 0, 0, LAST_LOCK_WAIT_MS);
	}
	if (fd === undefined) return false;
	const ownedFd = fd;
	try {
		body();
		return true;
	} finally {
		try {
			// Mark the opened inode complete even if another mutator temporarily owns the pathname.
			// A live host PID must not keep a finished writer held, and a successor inode is untouched.
			writeSync(ownedFd, "!", 0, "utf8");
		} catch {
			// Still attempt guarded removal when the completion marker could not be written.
		}
		try {
			withLockMutation(lockPath, () => {
				const owned = fstatSync(ownedFd);
				const current = statSync(lockPath);
				if (current.dev === owned.dev && current.ino === owned.ino) unlinkSync(lockPath);
			});
		} catch {
			// The next acquisition or orphan sweep can remove the completed marker under the guard.
		} finally {
			try { closeSync(ownedFd); } catch { /* do not replace a body error with a cleanup error */ }
		}
	}
}

export function lastRefreshMessage(lastPath: string): string {
	return `could not refresh ${lastPath}; the session was saved, but ctl last may still show the previous plan`;
}

/** Writes the session. Returns a warning when `last.json` could not be refreshed; the session file is still saved. */
export function writeSession(dir: string, record: SessionRecord): string | undefined {
	writeJson(sessionPath(dir, record.sessionId), record);
	const last = join(dir, "last.json");
	if (!withLastLock(last, () => writeJson(last, record))) return lastRefreshMessage(last);
	return undefined;
}

/**
 * Locked read-mutate-write of one session record (the session file and last.json). Returns the written record, or
 * undefined without writing when the record is missing or `mutate` returns undefined. `mutate` must not write the
 * same session file itself.
 */
export function updateSession(
	dir: string,
	sessionId: string,
	mutate: (record: SessionRecord) => SessionRecord | undefined,
	lock?: LockOptions,
): SessionRecord | undefined {
	return withFileLock(
		sessionPath(dir, sessionId),
		() => {
			const record = readSession(dir, sessionId);
			if (!record) return undefined;
			const next = mutate(record);
			if (!next) return undefined;
			writeSession(dir, next);
			return next;
		},
		lock,
	);
}

export function readLast(dir: string): SessionRecord | undefined {
	const raw = readJson(join(dir, "last.json"));
	if (!raw || typeof raw !== "object") return undefined;
	const rec = raw as Partial<SessionRecord>;
	if (!rec.result || typeof rec.result !== "object") return undefined;
	return rec as SessionRecord;
}
