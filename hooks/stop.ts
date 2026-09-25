#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Claude Code Stop hook: when the agent finishes a turn that tracked a task,
 * nudge it to invoke ultrathink-sync so status/PR fields land on the Notion
 * Task row before the session ends. Never calls Notion or Linear itself.
 * Silent and fail-open.
 */
import { isChildInvocation } from "../src/claude/complete.ts";
import { defaultStateDir, readSession, type SessionRecord, sessionPath } from "../src/claude/state.ts";
import { claudeConfigPaths, loadConfig } from "../src/config.ts";
import { isSubagentEnvelope, parseEnvelope } from "../src/host/envelope.ts";
import { type ShipNudge, shipNudge } from "../src/ship/nudge.ts";
import { shipApplies } from "../src/ship/policy.ts";
import { shipPrecheck } from "../src/ship/precheck.ts";
import { writeShip } from "../src/ship/state.ts";

async function main(): Promise<void> {
	if (isChildInvocation()) return;
	let raw: Record<string, unknown>;
	try {
		raw = parseEnvelope(await new Response(Bun.stdin.stream()).text());
	} catch {
		return;
	}
	// parseEnvelope maps Grok camelCase (sessionId, stopHookActive, subagentType) onto the snake_case keys.
	if (isSubagentEnvelope(raw)) return;
	const input = raw as { session_id?: string; stop_hook_active?: boolean; cwd?: string; reason?: string };
	if (input.stop_hook_active || typeof input.session_id !== "string" || !input.session_id) return;
	// Grok also fires an observe-only session-end Stop (reason channel_closed/shutdown) that cannot be blocked.
	const endTurn = input.reason === undefined || input.reason === "end_turn";
	const stateDir = defaultStateDir();
	const record = readSession(stateDir, input.session_id);
	if (!record?.plan) return;

	const sync = `Ultrathink · this turn tracked a task (graphId=${record.plan.graphId}). If the work reached a stopping point worth recording, invoke the ultrathink-sync skill before the session ends.`;
	const cwd = typeof input.cwd === "string" && input.cwd ? input.cwd : process.cwd();
	const nudge = endTurn ? shipCheck(record, stateDir, input.session_id, cwd) : undefined;
	console.log(JSON.stringify(nudge ? { ...nudge, systemMessage: `${nudge.systemMessage}\n${sync}` } : { systemMessage: sync }));
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

main().catch(() => process.exit(0));
