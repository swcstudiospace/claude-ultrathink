// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Builds the `TeachContext` every Teachable Moments operation runs in, and answers the two questions all of them ask:
 * is the feature on, and is there a Hindsight client to talk to. Config comes from the same layered files the rest of
 * ultrathink reads, so a project file can switch the feature off but never on.
 */
import { claudeConfigPaths, loadConfig } from "../config.ts";
import { type DecisionOutcome, type Decisions, createDecisions } from "../decisions/gate.ts";
import type { DecisionStates } from "../decisions/questions.ts";
import { DEFAULT_DECISIONS_CONFIG, type DecisionAction, type DecisionPoint, formatP } from "../decisions/types.ts";
import { resolveHindsight } from "../hindsight/settings.ts";
import { DEFAULT_HINDSIGHT_CONFIG, type HindsightClient } from "../hindsight/types.ts";
import { resolveStateDir } from "../host/paths.ts";
import { storePath as defaultStorePath } from "../mcp/store.ts";
import { openStore, storeDir } from "./store.ts";
import { DEFAULT_TEACH_CONFIG, TEACH_KILL_ENV, type TeachContext, type TeachStore } from "./types.ts";

export interface TeachContextOptions {
	host?: string;
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	sessionId?: string;
	stateDir?: string;
	storePath?: string;
	config?: TeachContext["config"];
	now?: () => number;
	fetch?: typeof fetch;
	hindsight?: HindsightClient;
	complete?: TeachContext["complete"];
	signal?: AbortSignal;
	log?: (line: string) => void;
}

function loadTeachConfig(cwd: string, env: NodeJS.ProcessEnv): TeachContext["config"] {
	try {
		const config = loadConfig(claudeConfigPaths(cwd, env));
		return { teach: config.teach, hindsight: config.hindsight, decisions: config.decisions };
	} catch {
		return {
			teach: { ...DEFAULT_TEACH_CONFIG },
			hindsight: { ...DEFAULT_HINDSIGHT_CONFIG },
			decisions: { ...DEFAULT_DECISIONS_CONFIG, points: [...DEFAULT_DECISIONS_CONFIG.points] },
		};
	}
}

/** Defaults: process env and cwd, host `ULTRATHINK_HOST` else "claude-code", the host's state directory, the shared credential store. */
export function teachContext(options: TeachContextOptions): TeachContext {
	const env = options.env ?? process.env;
	const cwd = options.cwd ?? process.cwd();
	const ctx: TeachContext = {
		host: options.host ?? (env.ULTRATHINK_HOST?.trim() || "claude-code"),
		cwd,
		config: options.config ?? loadTeachConfig(cwd, env),
		env,
		stateDir: options.stateDir ?? resolveStateDir(env),
		storePath: options.storePath ?? defaultStorePath(env),
	};
	if (options.sessionId !== undefined) ctx.sessionId = options.sessionId;
	if (options.now) ctx.now = options.now;
	if (options.fetch) ctx.fetch = options.fetch;
	if (options.hindsight) ctx.hindsight = options.hindsight;
	if (options.complete) ctx.complete = options.complete;
	if (options.signal) ctx.signal = options.signal;
	if (options.log) ctx.log = options.log;
	return ctx;
}

export function teachEnabled(ctx: TeachContext): boolean {
	return ctx.config.teach.enabled && ctx.env[TEACH_KILL_ENV] !== "0";
}

/** The local store, or undefined when it cannot be opened (an unwritable or `.planning` state directory). */
export function tryStore(ctx: TeachContext): TeachStore | undefined {
	try {
		return openStore(storeDir(ctx.stateDir));
	} catch {
		return undefined;
	}
}

/**
 * The Hindsight client for this context, or why there is none (a line for `reason`). `options.timeoutMs` lowers the
 * per-request budget (a planner that has 2.5 s must not wait 5 s on one request); `options.signal` replaces the context's.
 */
export function hindsightFor(ctx: TeachContext, options: { timeoutMs?: number; signal?: AbortSignal } = {}): { client?: HindsightClient; reason?: string } {
	if (ctx.hindsight) return { client: ctx.hindsight };
	try {
		const config = { ...ctx.config.hindsight };
		if (options.timeoutMs !== undefined) {
			config.timeoutMs = Math.max(1, Math.min(config.timeoutMs, Math.floor(options.timeoutMs)));
			config.retainTimeoutMs = Math.max(1, Math.min(config.retainTimeoutMs, Math.floor(options.timeoutMs)));
		}
		const { readiness, client } = resolveHindsight(config, ctx.env, {
			storePath: ctx.storePath,
			fetch: ctx.fetch,
			signal: options.signal ?? ctx.signal,
			gateway: ctx.config.gateway,
		});
		if (readiness.state === "ready" && client) return { client };
		if (readiness.state === "off") return { reason: `hindsight is off (${readiness.reason})` };
		return { reason: `hindsight is not ready (${readiness.state === "unready" ? readiness.reason : "no client"})` };
	} catch {
		return { reason: "hindsight is not ready (settings error)" };
	}
}

/** The Jev runtime for this context, or undefined when the context carries no `decisions` section. Reads no key until a point is asked. */
export function lessonDecisions(ctx: TeachContext): Decisions | undefined {
	const config = ctx.config.decisions;
	if (!config) return undefined;
	try {
		return createDecisions({
			config,
			env: ctx.env,
			...(ctx.storePath !== undefined ? { storePath: ctx.storePath } : {}),
			...(ctx.fetch ? { fetch: ctx.fetch } : {}),
			...(ctx.now ? { now: ctx.now } : {}),
			...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
		});
	} catch {
		return undefined;
	}
}

/**
 * One Jev question about a lesson. Never throws: every failure, a caller abort included, is the same as Decisions being
 * off, so the caller keeps today's behavior. `inactive` also covers no runtime, the kill switch, a point that is not listed and no key.
 */
export async function askLesson<P extends "teachable" | "skillworthy">(
	ctx: TeachContext,
	decisions: Decisions | undefined,
	point: P,
	state: DecisionStates[P],
	rule: { threshold: number; action: (p: number) => DecisionAction },
): Promise<DecisionOutcome> {
	if (!decisions) return { status: "inactive" };
	try {
		return await decisions.run(point, state, { ...rule, ...(ctx.signal ? { signal: ctx.signal } : {}) });
	} catch {
		return { status: "inactive" };
	}
}

/** What `teach observe --json` reports about a Jev call: the point, P (two decimals, truncated) when it answered, and the action. Never the lesson. */
export interface DecisionSummary {
	point: DecisionPoint;
	p?: number;
	action: DecisionAction;
}

export function summarizeDecision(outcome: Exclude<DecisionOutcome, { status: "inactive" }>): DecisionSummary {
	const { record } = outcome;
	return { point: record.point, ...(record.p !== undefined ? { p: Number(formatP(record.p)) } : {}), action: record.action };
}
