/**
 * On-disk state for the ultrathink Claude Code plugin. Hooks are one-shot
 * processes, so this lives under ~/.claude/ultrathink instead of in-session.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Clarification } from "../hitl/types.ts";
import type { ThoughtGraph } from "../think/types.ts";
import type { TrackPlan } from "../track/types.ts";
import type { UpliftResult } from "../types.ts";

export interface ControlState {
	enabled?: boolean;
	skipOnce?: boolean;
	thinkEnabled?: boolean;
	hitlEnabled?: boolean;
	engine?: "grok" | "claude";
}

export interface SessionRecord {
	sessionId: string;
	at: number;
	/** Thinking engine label, e.g. "grok-4.6@xhigh" or "claude:sonnet". */
	engine?: string;
	result: UpliftResult;
	graph?: ThoughtGraph;
	clarifications?: Clarification[];
	plan?: TrackPlan;
	/** Set true once ultrathink-kickoff has run for this session's plan. */
	kickedOff?: boolean;
	/** Set true once ultrathink-sync has run at least once for this session's plan. */
	synced?: boolean;
}

export function defaultStateDir(env: Record<string, string | undefined> = process.env): string {
	const override = env.ULTRATHINK_STATE_DIR?.trim();
	if (override) return override;
	const home = env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");
	return join(home, "ultrathink");
}

function readJson(path: string): unknown {
	try {
		if (!existsSync(path)) return undefined;
		return JSON.parse(readFileSync(path, "utf8")) as unknown;
	} catch {
		return undefined;
	}
}

function writeJson(path: string, value: unknown): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, `${JSON.stringify(value, null, "\t")}\n`);
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
	if (rec.engine === "grok" || rec.engine === "claude") out.engine = rec.engine;
	return out;
}

export function writeControl(dir: string, patch: ControlState): ControlState {
	const next = { ...readControl(dir), ...patch };
	writeJson(controlPath(dir), next);
	return next;
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

export function writeSession(dir: string, record: SessionRecord): void {
	writeJson(sessionPath(dir, record.sessionId), record);
	writeJson(join(dir, "last.json"), record);
}

export function readLast(dir: string): SessionRecord | undefined {
	const raw = readJson(join(dir, "last.json"));
	if (!raw || typeof raw !== "object") return undefined;
	const rec = raw as Partial<SessionRecord>;
	if (!rec.result || typeof rec.result !== "object") return undefined;
	return rec as SessionRecord;
}
