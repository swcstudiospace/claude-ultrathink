#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * PostToolUse hook: score a gsd-autonomous skill or phase command through OpenRouter.
 * Writes a sidecar record only. additionalContext reports the score or the error.
 * It does not rewrite artifacts and does not clear a human pause.
 */
import { join } from "node:path";
import { isChildInvocation } from "../src/claude/complete.ts";
import { defaultStateDir } from "../src/claude/state.ts";
import { appendFlowScore, evaluateFlowOutput, flowHash, isGsdFlowCommand, lookupFlowScore, openRouterKey, type FlowRecord } from "../src/decisions/flow.ts";
import { parseEnvelope } from "../src/host/envelope.ts";
import { storePath as defaultStorePath } from "../src/mcp/store.ts";

interface HookInput {
	session_id?: string;
	tool_name?: string;
	tool_input?: { command?: string; cmd?: string; skill?: string; args?: string };
	tool_response?: unknown;
	cwd?: string;
}

function commandOf(input: HookInput): string {
	const skill = input.tool_input?.skill;
	if (skill) return `${skill} ${input.tool_input?.args ?? ""}`.trim();
	return input.tool_input?.command ?? input.tool_input?.cmd ?? "";
}

function textOf(response: unknown): string {
	if (typeof response === "string") return response;
	try {
		return JSON.stringify(response ?? "");
	} catch {
		return "";
	}
}

export function formatFlowNote(record: FlowRecord): string {
	if (record.state === "success") {
		return `Jev · ${record.decision} · confidence ${record.confidence} · OpenRouter · ${record.model}${record.requestId ? ` · ${record.requestId}` : ""}. This does not clear a human pause.`;
	}
	if (record.state === "empty") return "Jev · skipped · empty output. Not an approval.";
	return `Jev · error · ${record.errorClass ?? "unknown"} · retries ${record.retryCount}. Not an approval. Do not mark this output Jev-approved.`;
}

async function main(): Promise<void> {
	if (isChildInvocation()) return;
	if (process.env.ULTRATHINK_DECISIONS === "0") return;
	let raw: Record<string, unknown>;
	try {
		raw = parseEnvelope(await new Response(Bun.stdin.stream()).text());
	} catch {
		return;
	}
	const input = raw as HookInput;
	const command = commandOf(input);
	if (!isGsdFlowCommand(input.tool_name, command)) return;
	const output = textOf(input.tool_response);
	const subject = `${input.session_id ?? "unknown"}:${command}`;
	const stateDir = defaultStateDir();
	const logPath = join(stateDir, "flow-decisions.jsonl");
	const hash = flowHash(output);
	const cached = lookupFlowScore(logPath, hash);
	const record = cached ?? (await evaluateFlowOutput({
		subject,
		output,
		command,
		apiKey: openRouterKey(defaultStorePath(process.env), process.env),
	}));
	if (!cached) appendFlowScore(logPath, record);
	console.log(JSON.stringify({ additionalContext: formatFlowNote(record) }));
}

if (import.meta.main) main().catch(() => process.exit(0));
