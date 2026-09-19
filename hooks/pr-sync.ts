#!/usr/bin/env bun
/**
 * Claude Code PostToolUse hook (matcher: "Bash", plus a best-effort list of
 * PR-creation MCP tool names — see hooks/hooks.json). Detects an actual PR
 * creation two ways: a `gh pr create` Bash command (the common case, and one
 * that doesn't depend on knowing any MCP tool's exact name), or a match
 * against the MCP-tool-name candidates in hooks.json. Nudges the agent to
 * invoke ultrathink-sync now that a PR exists, so the PR URL/number/branch
 * land on the tracked Notion Task row and the Linear issue. Never calls
 * Notion or Linear itself. Silent and fail-open.
 */
import { isChildInvocation } from "../src/claude/complete.ts";
import { defaultStateDir, readSession } from "../src/claude/state.ts";
import { extractPrFromOutput, isGhPrCreateCommand } from "../src/track/pr-detect.ts";

interface HookInput {
	session_id?: string;
	tool_name?: string;
	tool_input?: { command?: string };
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

/**
 * `hooks.json` routes two shapes of event here: any `Bash` call (checked
 * below for an actual `gh pr create`), or a tool already filtered by
 * hooks.json's own PR-creation-tool-name matcher (trusted as-is, since the
 * matcher already did the filtering before this script ever runs).
 */
function isPrCreationEvent(input: HookInput): boolean {
	if (input.tool_name === "Bash") return isGhPrCreateCommand(input.tool_input?.command ?? "");
	return Boolean(input.tool_name);
}

async function main(): Promise<void> {
	if (isChildInvocation()) return;
	let input: HookInput = {};
	try {
		input = JSON.parse(await new Response(Bun.stdin.stream()).text()) as HookInput;
	} catch {
		return;
	}
	if (!input.session_id || !isPrCreationEvent(input)) return;

	const stateDir = defaultStateDir();
	const record = readSession(stateDir, input.session_id);
	if (!record?.plan) return;

	const pr = extractPrFromOutput(responseText(input.tool_response));
	const prNote = pr ? ` (${pr.url})` : "";
	console.log(
		JSON.stringify({
			systemMessage: `Ultrathink · a pull request was opened for a tracked task${prNote}. Invoke the ultrathink-sync skill now (graphId=${record.plan.graphId}) to write the PR URL/number/branch back onto the Notion Task row and Linear issue.`,
		}),
	);
}

main().catch(() => process.exit(0));
