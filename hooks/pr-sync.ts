#!/usr/bin/env bun
/**
 * Claude Code PostToolUse hook (matcher: a GitHub PR-creation tool — the
 * exact MCP-qualified tool name is environment-dependent, see the note on
 * this hook's matcher in hooks/hooks.json). Nudges the agent to invoke
 * ultrathink-sync now that a PR exists, so the PR URL/number/branch land on
 * the tracked Notion Task row and the Linear issue. Never calls Notion or
 * Linear itself. Silent and fail-open.
 */
import { isChildInvocation } from "../src/claude/complete.ts";
import { defaultStateDir, readSession } from "../src/claude/state.ts";

interface HookInput {
	session_id?: string;
	tool_name?: string;
	tool_response?: unknown;
}

async function main(): Promise<void> {
	if (isChildInvocation()) return;
	let input: HookInput = {};
	try {
		input = JSON.parse(await new Response(Bun.stdin.stream()).text()) as HookInput;
	} catch {
		return;
	}
	if (!input.session_id) return;

	const stateDir = defaultStateDir();
	const record = readSession(stateDir, input.session_id);
	if (!record?.plan) return;

	console.log(
		JSON.stringify({
			systemMessage: `Ultrathink · a pull request was opened for a tracked task. Invoke the ultrathink-sync skill now (graphId=${record.plan.graphId}) to write the PR URL/number/branch back onto the Notion Task row and Linear issue.`,
		}),
	);
}

main().catch(() => process.exit(0));
