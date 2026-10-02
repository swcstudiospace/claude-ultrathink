#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Claude Code Stop hook: when the agent finishes a turn that tracked a task,
 * nudge it to invoke ultrathink-sync so status/PR fields land on the Notion
 * Task row before the session ends. Never calls Notion or Linear itself.
 * With Teachable Moments capture `observe` or `auto`, it also hands the
 * finished session's transcript to a detached `teach observe` (tracked or not).
 * Silent and fail-open.
 */
import { fileURLToPath } from "node:url";
import { isChildInvocation } from "../src/claude/complete.ts";
import { defaultStateDir, readSession, type SessionRecord, sessionPath } from "../src/claude/state.ts";
import { claudeConfigPaths, loadConfig } from "../src/config.ts";
import { detectHost } from "../src/host/detect.ts";
import { isSubagentEnvelope, parseEnvelope } from "../src/host/envelope.ts";
import { type ShipNudge, shipNudge } from "../src/ship/nudge.ts";
import { shipApplies } from "../src/ship/policy.ts";
import { shipPrecheck } from "../src/ship/precheck.ts";
import { writeShip } from "../src/ship/state.ts";
import { teachContext, teachEnabled } from "../src/teach/context.ts";
import { digestFromClaudeTranscript } from "../src/teach/digest.ts";
import { spawnObserveDetached } from "../src/teach/spawn.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

/** Test seams: the real context, digest reader and detached spawn by default. */
export interface ObserveStopDeps {
	teachContext?: typeof teachContext;
	digest?: typeof digestFromClaudeTranscript;
	spawn?: typeof spawnObserveDetached;
	env?: NodeJS.ProcessEnv;
	repoRoot?: string;
}

/**
 * One file read, one small inbox write and a detached spawn: Muse's Stop budget is 5s, so nothing here waits on
 * `teach observe` or the network. Returns whether a spawn started; an error means no capture, never a failed hook.
 */
export function observeStop(
	input: { sessionId: string; cwd: string; transcriptPath: unknown },
	deps: ObserveStopDeps = {},
): boolean {
	try {
		if (typeof input.transcriptPath !== "string" || !input.transcriptPath) return false;
		const env = deps.env ?? process.env;
		const host = detectHost(env);
		const ctx = (deps.teachContext ?? teachContext)({ host, cwd: input.cwd, env, sessionId: input.sessionId });
		if (!teachEnabled(ctx) || ctx.config.teach.capture === "explicit") return false;
		const digest = (deps.digest ?? digestFromClaudeTranscript)(input.transcriptPath, {
			host,
			sessionId: input.sessionId,
			cwd: input.cwd,
			outcome: "completed",
		});
		if (!digest) return false;
		return (deps.spawn ?? spawnObserveDetached)(digest, { repoRoot: deps.repoRoot ?? ROOT, env, stateDir: ctx.stateDir, host }).spawned;
	} catch {
		return false;
	}
}

export interface StopDeps extends ObserveStopDeps {
	stateDir?: string;
	/** Defaults to `isChildInvocation()`. */
	child?: boolean;
}

/** The hook's output line for one stdin envelope, or undefined for silence. */
export function runStop(stdin: string, deps: StopDeps = {}): string | undefined {
	if (deps.child ?? isChildInvocation()) return undefined;
	const raw = parseEnvelope(stdin);
	// parseEnvelope maps Grok camelCase (sessionId, stopHookActive, subagentType) onto the snake_case keys.
	if (isSubagentEnvelope(raw)) return undefined;
	const input = raw as { session_id?: string; stop_hook_active?: boolean; cwd?: string; reason?: string; transcript_path?: unknown };
	if (input.stop_hook_active || typeof input.session_id !== "string" || !input.session_id) return undefined;
	// Grok also fires an observe-only session-end Stop (reason channel_closed/shutdown) that cannot be blocked.
	const endTurn = input.reason === undefined || input.reason === "end_turn";
	const stateDir = deps.stateDir ?? defaultStateDir(deps.env);
	const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd();
	// Before the tracked-session return: untracked sessions teach too.
	observeStop({ sessionId: input.session_id, cwd, transcriptPath: input.transcript_path }, deps);
	const record = readSession(stateDir, input.session_id);
	if (!record?.plan) return undefined;

	const sync = `Ultrathink · this turn tracked a task (graphId=${record.plan.graphId}). If the work reached a stopping point worth recording, invoke the ultrathink-sync skill before the session ends.`;
	const nudge = endTurn ? shipCheck(record, stateDir, input.session_id, cwd) : undefined;
	return JSON.stringify(nudge ? { ...nudge, systemMessage: `${nudge.systemMessage}\n${sync}` } : { systemMessage: sync });
}

async function main(): Promise<void> {
	let stdin: string;
	try {
		stdin = await new Response(Bun.stdin.stream()).text();
	} catch {
		return;
	}
	const out = runStop(stdin);
	if (out !== undefined) console.log(out);
}

/** Fail-open: any error means no nudge, and the nudge is recorded before it is printed so it fires once. */
function shipCheck(record: SessionRecord, stateDir: string, sessionId: string, cwd: string): ShipNudge | undefined {
	try {
		const config = loadConfig(claudeConfigPaths(cwd)).ship;
		if (!shipApplies(config, record.skill?.name) || record.ship?.nudgedAt !== undefined) return undefined;
		const statePath = sessionPath(stateDir, sessionId);
		const nudge = shipNudge({ record, config, precheck: shipPrecheck(cwd), statePath });
		if (!nudge || !writeShip(statePath, { nudgedAt: Date.now() })) return undefined;
		return nudge;
	} catch {
		return undefined;
	}
}

if (import.meta.main) main().catch(() => process.exit(0));
