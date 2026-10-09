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

function asRecord(value: unknown): Record<string, unknown> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}

/** Claude transcript entries become agent messages. `tool_use` becomes a tool call; `tool_result` a tool result. */
function claudeToAgent(entry: Record<string, unknown>): unknown[] {
	const message = asRecord(entry.message);
	if (!message || (entry.type !== "user" && entry.type !== "assistant")) return [];
	const role = entry.type === "assistant" ? "assistant" : "user";
	const content = message.content;
	if (!Array.isArray(content)) return [{ role, content: typeof content === "string" ? content : "" }];
	const parts: unknown[] = [];
	const out: unknown[] = [];
	const flush = (): void => {
		if (parts.length === 0) return;
		out.push({ role, content: parts.splice(0, parts.length) });
	};
	for (const part of content) {
		const item = asRecord(part);
		if (!item) continue;
		if (item.type === "text") parts.push({ type: "text", text: item.text });
		else if (item.type === "tool_use") {
			flush();
			out.push({ role: "assistant", content: [{ type: "toolCall", name: item.name, arguments: item.input ?? {} }] });
		} else if (item.type === "tool_result") {
			flush();
			out.push({
				role: "toolResult",
				content: item.content ?? "",
				...(item.is_error === true ? { isError: true } : {}),
				...(typeof item.name === "string" ? { toolName: item.name } : {}),
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
			messages.push(...claudeToAgent(entry));
			continue;
		}
		messages.push(entry);
	}
	return digestFromAgentMessages(messages, { host: GROKBOT_TEACH_HOST, ...meta });
}
