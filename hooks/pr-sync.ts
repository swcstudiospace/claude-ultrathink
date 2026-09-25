#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * PostToolUse hook for Claude Code, Grok Build, and Muse (via
 * hooks/muse-post-tool). Claude's hooks.json matcher pre-filters to `Bash`
 * plus a few PR-creation tool names, but Muse has no matcher and sends every
 * tool call, so the event is filtered here by `isPrCreationTool`: a shell
 * `gh pr create`, or a tool whose name reads as PR creation. On a match for a
 * planned session, tells the agent (via `additionalContext`, the only field
 * the model sees) to invoke ultrathink-sync so the PR URL/number/branch land
 * on the tracked Notion Task row and Linear issues. Never calls Notion or
 * Linear itself. Silent and fail-open.
 */
import { resolve } from "node:path";
import { isChildInvocation } from "../src/claude/complete.ts";
import { defaultStateDir, readSession, sessionPath } from "../src/claude/state.ts";
import { isSubagentEnvelope, parseEnvelope } from "../src/host/envelope.ts";
import { extractPrFromOutput, isPrCreationTool } from "../src/track/pr-detect.ts";

interface HookInput {
	session_id?: string;
	tool_name?: string;
	tool_input?: { command?: string; cmd?: string };
	tool_response?: unknown;
}

function responseText(response: unknown): string {
	if (typeof response === "string") return response;
	try {
		return JSON.stringify(response ?? "");
	} catch {
		return "";
	}
}

async function main(): Promise<void> {
	if (isChildInvocation()) return;
	let raw: Record<string, unknown>;
	try {
		raw = parseEnvelope(await new Response(Bun.stdin.stream()).text());
	} catch {
		return;
	}
	// A subagent's PR is still caught when the parent turn stops.
	if (isSubagentEnvelope(raw)) return;
	const input = raw as HookInput;
	if (!input.session_id) return;
	if (!isPrCreationTool(input.tool_name, input.tool_input?.command ?? input.tool_input?.cmd)) return;

	const stateDir = defaultStateDir();
	const record = readSession(stateDir, input.session_id);
	if (!record?.plan) return;

	const pr = extractPrFromOutput(responseText(input.tool_response));
	const prNote = pr ? ` (${pr.url})` : "";
	const stateFile = resolve(sessionPath(stateDir, input.session_id));
	const prArg = pr ? ` and prUrl=${pr.url}` : " and the PR URL";
	console.log(
		JSON.stringify({
			systemMessage: `Ultrathink · a pull request was opened for a tracked task${prNote}. Invoke the ultrathink-sync skill now (graphId=${record.plan.graphId}) to write the PR URL/number/branch back onto the Notion Task row and Linear issue.`,
			hookSpecificOutput: {
				hookEventName: "PostToolUse",
				additionalContext: `Ultrathink: a pull request was opened for the tracked task${prNote}. Invoke the ultrathink-sync skill now with stateFile=${stateFile}${prArg}, so the tracked Notion Task row and Linear issues get the PR URL/number/branch and status. ultrathink-sync only updates existing rows; do not create new Notion rows or Linear issues.`,
			},
		}),
	);
}

main().catch(() => process.exit(0));
