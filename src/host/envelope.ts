// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Claude hooks read snake_case. Grok's stdin is camelCase, with PascalCase
 * carried on the snake_case key `hook_event_name`. Snake_case wins when both
 * shapes are present so a Claude envelope round-trips byte-identical.
 */

const GROK_EVENT_TO_PASCAL: Record<string, string> = {
	user_prompt_submit: "UserPromptSubmit",
	pre_tool_use: "PreToolUse",
	post_tool_use: "PostToolUse",
	post_tool_use_failure: "PostToolUseFailure",
	permission_denied: "PermissionDenied",
	stop: "Stop",
	stop_failure: "StopFailure",
	stop_cancelled: "StopCancelled",
	session_start: "SessionStart",
	session_end: "SessionEnd",
	notification: "Notification",
	subagent_start: "SubagentStart",
	subagent_stop: "SubagentStop",
	pre_compact: "PreCompact",
	post_compact: "PostCompact",
};


function pick(record: Record<string, unknown>, snake: string, camel: string): unknown {
	if (record[snake] !== undefined) return record[snake];
	if (record[camel] !== undefined) return record[camel];
	return undefined;
}

function hookEventName(record: Record<string, unknown>): string | undefined {
	const pascal = record.hook_event_name;
	if (typeof pascal === "string" && pascal.trim()) return pascal;
	const grok = record.hookEventName;
	if (typeof grok !== "string" || !grok.trim()) return undefined;
	return GROK_EVENT_TO_PASCAL[grok] ?? grok;
}

/** Malformed input normalises to `{}` and never throws. */
export function normalizeEnvelope(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const record = value as Record<string, unknown>;
	const prompt = pick(record, "prompt", "userPrompt") ?? record.user_prompt;
	const cwd = record.cwd !== undefined ? record.cwd : record.workspaceRoot;
	const normalized: Record<string, unknown> = { ...record };
	const sessionId = pick(record, "session_id", "sessionId");
	const transcriptPath = pick(record, "transcript_path", "transcriptPath");
	const toolName = pick(record, "tool_name", "toolName");
	const toolInput = pick(record, "tool_input", "toolInput");
	const toolResponse = pick(record, "tool_response", "toolResult");
	const stopHookActive = pick(record, "stop_hook_active", "stopHookActive");
	const subagentType = pick(record, "subagent_type", "subagentType");
	const event = hookEventName(record);
	if (sessionId !== undefined) normalized.session_id = sessionId;
	if (transcriptPath !== undefined) normalized.transcript_path = transcriptPath;
	if (cwd !== undefined) normalized.cwd = cwd;
	if (prompt !== undefined) normalized.prompt = prompt;
	if (toolName !== undefined) normalized.tool_name = toolName;
	if (toolInput !== undefined) normalized.tool_input = toolInput;
	if (toolResponse !== undefined) normalized.tool_response = toolResponse;
	if (stopHookActive !== undefined) normalized.stop_hook_active = stopHookActive;
	if (subagentType !== undefined) normalized.subagent_type = subagentType;
	if (event !== undefined) normalized.hook_event_name = event;
	return normalized;
}

export function parseEnvelope(raw: string): Record<string, unknown> {
	try {
		return normalizeEnvelope(JSON.parse(raw));
	} catch {
		return {};
	}
}

/**
 * Grok stamps `subagentType` on events fired inside a subagent; Claude Code
 * stamps `agent_id`/`agent_type`. The main session carries none of them.
 * Expects a normalized envelope.
 */
export function isSubagentEnvelope(input: Record<string, unknown>): boolean {
	return ["subagent_type", "agent_type", "agent_id"].some((key) => {
		const value = input[key];
		return typeof value === "string" && value.trim() !== "";
	});
}
