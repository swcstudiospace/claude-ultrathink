// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * On-disk state for the ultrathink Claude Code plugin. Hooks are one-shot
 * processes, so this lives under ~/.claude/ultrathink instead of in-session.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type LockOptions, withFileLock, writeFileAtomic } from "./atomic.ts";
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
	skipOnce?: boolean;
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
	if (typeof rec.skipOnce === "boolean") out.skipOnce = rec.skipOnce;
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

function safeSessionId(id: string): string {
	return id.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 120) || "unknown";
}

export function sessionPath(dir: string, sessionId: string): string {
	return join(dir, "sessions", `${safeSessionId(sessionId)}.json`);
}

export function readSession(dir: string, sessionId: string): SessionRecord | undefined {
	const raw = readJson(sessionPath(dir, sessionId));
	if (!raw || typeof raw !== "object") return undefined;
	const rec = raw as Partial<SessionRecord>;
	if (!rec.result || typeof rec.result !== "object") return undefined;
	return rec as SessionRecord;
}

/** Exclusive lock for `last.json`, delegated to the shared file lock on `<lastPath>.lock`. Every writer uses it, so a replace cannot land between another writer's check and rename. When the lock cannot be taken in time the body still runs unlocked and `false` is returned. */
export function withLastLock(lastPath: string, body: () => void): boolean {
	let locked = false;
	withFileLock(lastPath, () => {
		locked = true;
		body();
	});
	return locked;
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
