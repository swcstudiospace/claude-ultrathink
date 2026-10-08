// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * `ultrathink-grokbot teach digest`: the grok-bot stand-in for the plugin's Stop hook hand-off to `teach observe`.
 * Grok Bot has no Stop hook, so Desk Lead writes the finished run's recent turns as JSONL and this reduces them to the
 * plugin's bounded `TeachDigest` (host "grok-bot"), ready for `teach observe --stdin`. Simple
 * `{"role","content"}` lines (plus `{"role":"tool","name","input"?,"content","isError"?}` for each tool call Desk Lead
 * made, so observe's minimum tool-call count can be met) go through `digestFromAgentMessages`; Claude Code transcript lines through
 * `digestFromClaudeTranscript`. Nothing is redacted here: `observe` redacts before anything is stored or sent.
 */
import { readFileSync } from "node:fs";
import { digestFromAgentMessages, digestFromClaudeTranscript } from "../teach/digest.ts";
import type { TeachDigest } from "../teach/types.ts";

export const GROKBOT_TEACH_HOST = "grok-bot";

export function grokbotDigest(
	transcriptPath: string,
	meta: { sessionId: string; cwd: string; outcome?: TeachDigest["outcome"]; now?: () => number },
): TeachDigest | undefined {
	const text = readFileSync(transcriptPath, "utf8");
	const messages: unknown[] = [];
	let claudeShaped = false;
	for (const line of text.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			const entry = JSON.parse(trimmed) as Record<string, unknown>;
			if (entry && typeof entry === "object" && (entry.type === "user" || entry.type === "assistant") && entry.message) claudeShaped = true;
			if (entry && typeof entry === "object" && entry.role === "tool") {
				const name = typeof entry.name === "string" && entry.name.trim() ? entry.name.trim() : "tool";
				messages.push({ role: "assistant", content: [{ type: "toolCall", name, arguments: entry.input ?? {} }] });
				messages.push({ role: "toolResult", toolName: name, content: entry.content ?? "", ...(entry.isError === true ? { isError: true } : {}) });
				continue;
			}
			messages.push(entry);
		} catch {
			// a torn line is skipped, as the plugin's readers do
		}
	}
	const digestMeta = { host: GROKBOT_TEACH_HOST, ...meta };
	return claudeShaped ? digestFromClaudeTranscript(transcriptPath, digestMeta) : digestFromAgentMessages(messages, digestMeta);
}
