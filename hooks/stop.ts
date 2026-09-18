#!/usr/bin/env bun
/**
 * Claude Code Stop hook: when the agent finishes a turn that tracked a task,
 * nudge it to invoke ultrathink-sync so status/PR fields land on the Notion
 * Task row before the session ends. Never calls Notion or Linear itself.
 * Silent and fail-open.
 */
import { isChildInvocation } from "../src/claude/complete.ts";
import { defaultStateDir, readSession } from "../src/claude/state.ts";

async function main(): Promise<void> {
	if (isChildInvocation()) return;
	let input: { session_id?: string; stop_hook_active?: boolean } = {};
	try {
		input = JSON.parse(await new Response(Bun.stdin.stream()).text()) as typeof input;
	} catch {
		return;
	}
	if (input.stop_hook_active || !input.session_id) return;
	const stateDir = defaultStateDir();
	const record = readSession(stateDir, input.session_id);
	if (!record?.plan) return;

	console.log(
		JSON.stringify({
			systemMessage: `Ultrathink · this turn tracked a task (graphId=${record.plan.graphId}). If the work reached a stopping point worth recording, invoke the ultrathink-sync skill before the session ends.`,
		}),
	);
}

main().catch(() => process.exit(0));
