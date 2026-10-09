// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * `ultrathink-grokbot teach digest`: the grok-bot stand-in for the plugin's Stop hook hand-off to `teach observe`.
 * Grok Bot has no Stop hook, so Desk Lead writes the finished run's recent turns as JSONL and this reduces them to the
 * plugin's bounded `TeachDigest` (host "grok-bot"), ready for `teach observe --stdin`. Each line is normalized into
 * the agent-message shape (`role`/`content`, plus tool-call and tool-result rows) before one digest is built, so a
 * Claude-shaped line and a desk tool row in the same file both count. Nothing is redacted here: `observe` redacts
 * before anything is stored or sent.
 */
import { readFileSync } from "node:fs";
import { digestFromAgentMessages } from "../teach/digest.ts";
import type { TeachDigest } from "../teach/types.ts";

export const GROKBOT_TEACH_HOST = "grok-bot";

/** Same marker `digestFromClaudeTranscript` treats as an interrupted run, and does not keep as a turn. */
const INTERRUPTED = /^\[Request interrupted by user/i;

function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}

interface ConvertMarks {
	interrupted: boolean;
}

/** Claude transcript entries become agent messages. `tool_use` becomes a tool call; `tool_result` a tool result. */
function claudeToAgent(entry: Record<string, unknown>, toolNames: Map<string, string>, marks: ConvertMarks): unknown[] {
	const message = asRecord(entry.message);
	if (entry.isMeta === true || !message || (entry.type !== "user" && entry.type !== "assistant")) return [];
	const role = entry.type === "assistant" ? "assistant" : "user";
	const content = message.content;
	if (typeof content === "string") {
		if (INTERRUPTED.test(content.trim())) {
			marks.interrupted = true;
			return [];
		}
		return [{ role, content }];
	}
	if (!Array.isArray(content)) return [{ role, content: "" }];
	const parts: unknown[] = [];
	const out: unknown[] = [];
	const flush = (): void => {
		if (parts.length === 0) return;
		const chunk = parts.splice(0, parts.length);
		const joined = chunk
			.map((part) => {
				const rec = asRecord(part);
				return typeof rec?.text === "string" ? rec.text : "";
			})
			.join("\n")
			.trim();
		if (INTERRUPTED.test(joined)) {
			marks.interrupted = true;
			return;
		}
		out.push({ role, content: chunk });
	};
	for (const part of content) {
		const item = asRecord(part);
		if (!item) continue;
		if (item.type === "text") parts.push({ type: "text", text: item.text });
		else if (item.type === "tool_use") {
			flush();
			const name = typeof item.name === "string" && item.name.trim() ? item.name.trim() : "tool";
			if (typeof item.id === "string") toolNames.set(item.id, name);
			out.push({ role: "assistant", content: [{ type: "toolCall", name, arguments: item.input ?? {} }] });
		} else if (item.type === "tool_result") {
			flush();
			const fromId = typeof item.tool_use_id === "string" ? toolNames.get(item.tool_use_id) : undefined;
			const toolName = typeof item.name === "string" && item.name.trim() ? item.name.trim() : fromId;
			out.push({
				role: "toolResult",
				content: item.content ?? "",
				...(item.is_error === true ? { isError: true } : {}),
				...(toolName ? { toolName } : {}),
			});
		}
	}
	flush();
	return out;
}

export function grokbotDigest(
	transcriptPath: string,
	meta: { sessionId: string; cwd: string; outcome?: TeachDigest["outcome"]; now?: () => number },
): TeachDigest | undefined {
	const text = readFileSync(transcriptPath, "utf8");
	const messages: unknown[] = [];
	const toolNames = new Map<string, string>();
	const marks: ConvertMarks = { interrupted: false };
	for (const line of text.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let entry: Record<string, unknown> | undefined;
		try {
			entry = asRecord(JSON.parse(trimmed));
		} catch {
			continue;
		}
		if (!entry) continue;
		if (entry.role === "tool") {
			const name = typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : "tool";
			messages.push({ role: "assistant", content: [{ type: "toolCall", name, arguments: entry.input ?? {} }] });
			messages.push({ role: "toolResult", toolName: name, content: entry.content ?? "", ...(entry.isError === true ? { isError: true } : {}) });
			continue;
		}
		if ((entry.type === "user" || entry.type === "assistant") && entry.message) {
			messages.push(...claudeToAgent(entry, toolNames, marks));
			continue;
		}
		messages.push(entry);
	}
	return digestFromAgentMessages(messages, {
		host: GROKBOT_TEACH_HOST,
		...meta,
		...(meta.outcome === undefined && marks.interrupted ? { outcome: "interrupted" as const } : {}),
	});
}
