// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { type PendingRequest, journalDir, listPending, readMeta, runGrokbotPlan, storeAnswer } from "../../../src/host/grokbot.ts";

export const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const SESSION_CONFLICT_MESSAGE = "session already holds a different original prompt; use a new session id";
const DEBOUNCE_MS = 20;
const REDACTED_STATE = "[state]";

export interface JournalOptions {
	stateDir: string;
	maxPromptChars: number;
	maxAnswerChars: number;
}

export interface PendingView {
	key: string;
	stage: string;
	nodeId?: string;
	nodeKind?: string;
	nodeTitle?: string;
}

export interface PlanView {
	sessionId: string;
	status: "needs-model" | "planned" | "invalid" | "skipped";
	pending: PendingView[];
}

export interface SessionView {
	sessionId: string;
	status: string;
	pendingCount: number;
	pending: PendingView[];
}

export interface RequestView {
	key: string;
	stage: string;
	system?: string;
	user?: string;
}

export type JournalErrorCode =
	| "invalid_session_id"
	| "session_conflict"
	| "not_found"
	| "answer_too_long"
	| "invalid_answer"
	| "invalid_input"
	| "engine_error"
	| "busy"
	| "budget_exceeded"
	| "not_ready"
	| "disabled";

export type JournalResult<T> = { ok: true; data: T } | { ok: false; code: JournalErrorCode; errors?: string[] };

type PendingFields = Pick<PendingRequest, "key" | "stage" | "nodeId" | "nodeKind" | "nodeTitle">;

const ok = <T>(data: T): JournalResult<T> => ({ ok: true, data });

const fail = (code: JournalErrorCode, errors?: string[]): JournalResult<never> => (errors ? { ok: false, code, errors } : { ok: false, code });

export function isSessionId(value: unknown): value is string {
	return typeof value === "string" && SESSION_ID_PATTERN.test(value);
}

/** Drops C0 control characters except tab and newline, then trims. */
export function cleanText(value: string): string {
	let out = "";
	for (const ch of value) {
		const code = ch.charCodeAt(0);
		if (code < 0x20 && code !== 0x09 && code !== 0x0a) continue;
		out += ch;
	}
	return out.trim();
}

function pendingView(entry: PendingFields): PendingView {
	const view: PendingView = { key: entry.key, stage: entry.stage };
	if (entry.nodeId !== undefined) view.nodeId = entry.nodeId;
	if (entry.nodeKind !== undefined) view.nodeKind = entry.nodeKind;
	if (entry.nodeTitle !== undefined) view.nodeTitle = entry.nodeTitle;
	return view;
}

/** Journal directory for a validated session id, or undefined when the session was never started. */
function sessionDir(opts: JournalOptions, sessionId: string): string | undefined {
	const dir = journalDir(opts.stateDir, sessionId);
	return existsSync(dir) ? dir : undefined;
}

/** Converts unexpected filesystem or parse failures into engine_error without leaking detail. */
function guard<T>(run: () => JournalResult<T>): JournalResult<T> {
	try {
		return run();
	} catch {
		return fail("engine_error");
	}
}

/**
 * Empty home and config directories under the state dir, as the env the plugin resolves its config files from. The
 * operator's own `~/.config/ultrathink` and `~/.claude/ultrathink.json` are never read by a service-driven plan.
 * `CLAUDE_CONFIG_DIR` is included because the Claude user layer resolves through it, not through HOME.
 */
export function isolatedConfigEnv(stateDir: string): Record<"HOME" | "XDG_CONFIG_HOME" | "CLAUDE_CONFIG_DIR", string> {
	const home = join(stateDir, "home");
	const env = { HOME: home, XDG_CONFIG_HOME: join(home, ".config"), CLAUDE_CONFIG_DIR: join(home, ".claude") };
	for (const dir of Object.values(env)) mkdirSync(dir, { recursive: true });
	return env;
}

export async function startPlan(opts: JournalOptions, input: { prompt: unknown; sessionId?: unknown }): Promise<JournalResult<PlanView>> {
	const sessionId = input.sessionId === undefined ? randomUUID() : input.sessionId;
	if (!isSessionId(sessionId)) return fail("invalid_session_id");
	if (typeof input.prompt !== "string") return fail("invalid_input");
	const prompt = cleanText(input.prompt);
	if (prompt.length === 0 || prompt.length > opts.maxPromptChars) return fail("invalid_input");
	try {
		const cwd = join(opts.stateDir, "cwd");
		mkdirSync(cwd, { recursive: true });
		const run = await runGrokbotPlan({
			sessionId,
			prompt,
			cwd,
			stateDir: opts.stateDir,
			env: {
				ULTRATHINK_DECISIONS: "0",
				SUBSTRATE_DISABLED: "1",
				ULTRATHINK_HINDSIGHT: "0",
				ULTRATHINK_RAGFLOW: "0",
				ULTRATHINK_STATE_DIR: opts.stateDir,
				...isolatedConfigEnv(opts.stateDir),
			},
			debounceMs: DEBOUNCE_MS,
		});
		return ok({ sessionId, status: run.status, pending: run.pending.map(pendingView) });
	} catch (error) {
		if (error instanceof Error && error.message === SESSION_CONFLICT_MESSAGE) return fail("session_conflict");
		return fail("engine_error");
	}
}

export function listPendingRequests(opts: JournalOptions, input: { sessionId: unknown }): JournalResult<PendingView[]> {
	const sessionId = input.sessionId;
	if (!isSessionId(sessionId)) return fail("invalid_session_id");
	const dir = sessionDir(opts, sessionId);
	if (!dir) return fail("not_found");
	return guard((): JournalResult<PendingView[]> => ok(listPending(dir).map(pendingView)));
}

export function showRequest(opts: JournalOptions, input: { sessionId: unknown; key: unknown; part?: unknown }): JournalResult<RequestView> {
	const { sessionId, key, part } = input;
	if (!isSessionId(sessionId)) return fail("invalid_session_id");
	if (typeof key !== "string") return fail("invalid_input");
	if (part !== undefined && part !== "system" && part !== "user") return fail("invalid_input");
	const dir = sessionDir(opts, sessionId);
	if (!dir) return fail("not_found");
	return guard((): JournalResult<RequestView> => {
		const request = listPending(dir).find((entry) => entry.key === key);
		if (!request) return fail("not_found");
		const view: RequestView = { key: request.key, stage: request.stage };
		if (part !== "user") view.system = request.system;
		if (part !== "system") view.user = request.user;
		return ok(view);
	});
}

export function answerRequest(opts: JournalOptions, input: { sessionId: unknown; key: unknown; answer: unknown }): JournalResult<{ accepted: true }> {
	const { sessionId, key, answer } = input;
	if (!isSessionId(sessionId)) return fail("invalid_session_id");
	if (typeof key !== "string") return fail("invalid_input");
	if (typeof answer !== "string") return fail("invalid_answer");
	const text = cleanText(answer);
	if (text.length === 0) return fail("invalid_answer");
	if (text.length > opts.maxAnswerChars) return fail("answer_too_long");
	const dir = sessionDir(opts, sessionId);
	if (!dir) return fail("not_found");
	return guard((): JournalResult<{ accepted: true }> => {
		// Only keys from the live pending listing reach storeAnswer, which joins the key into file paths.
		if (!listPending(dir).some((entry) => entry.key === key)) return fail("not_found");
		const result = storeAnswer(dir, key, text);
		if (!result.ok) return fail("invalid_answer", result.errors.map((message) => message.replaceAll(opts.stateDir, REDACTED_STATE)));
		return ok({ accepted: true });
	});
}

export function sessionStatus(opts: JournalOptions, input: { sessionId: unknown }): JournalResult<SessionView> {
	const sessionId = input.sessionId;
	if (!isSessionId(sessionId)) return fail("invalid_session_id");
	const dir = sessionDir(opts, sessionId);
	if (!dir) return fail("not_found");
	return guard((): JournalResult<SessionView> => {
		const pending = listPending(dir).map(pendingView);
		return ok({ sessionId, status: readMeta(dir)?.status ?? "unknown", pendingCount: pending.length, pending });
	});
}
