// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Reads recent user/assistant turns from a Claude Code session transcript (JSONL)
 * so Prompt Uplift can recover product and prior-decision facts, mirroring the
 * OMP `recentConversation` helper.
 */
import { closeSync, fstatSync, openSync, readSync } from "node:fs";

const DEFAULT_CONVERSATION_CHARS = 3500;
const MAX_SNIPPETS = 8;
const MAX_MESSAGE_CHARS = 600;
const TAIL_BYTES = 256 * 1024;

function textParts(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const rec = part as { type?: unknown; text?: unknown };
		if (rec.type === "text" && typeof rec.text === "string") parts.push(rec.text);
	}
	return parts.join("\n").trim();
}

export function isNoise(text: string): boolean {
	// Skip injected system/hook context and the plugin's own uplift blocks.
	return /^<(?:system-reminder|command-name|local-command|UPLIFTED_PROMPT|BUILD_PROMPT|FIX_PROMPT|RESEARCH_PROMPT|CHANGE_PROMPT)/i.test(text);
}

export function conversationFromJsonl(jsonl: string, maxChars = DEFAULT_CONVERSATION_CHARS): string {
	const lines = jsonl.split(/\r?\n/);
	const chunks: string[] = [];
	for (let i = lines.length - 1; i >= 0 && chunks.length < MAX_SNIPPETS; i--) {
		const line = lines[i]?.trim();
		if (!line) continue;
		let entry: unknown;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (!entry || typeof entry !== "object") continue;
		const rec = entry as { type?: unknown; isMeta?: unknown; message?: unknown };
		if (rec.isMeta === true) continue;
		if (rec.type !== "user" && rec.type !== "assistant") continue;
		if (!rec.message || typeof rec.message !== "object") continue;
		const message = rec.message as { role?: unknown; content?: unknown };
		const role = message.role === "assistant" ? "Assistant" : rec.type === "assistant" ? "Assistant" : "User";
		const text = textParts(message.content);
		if (!text || isNoise(text)) continue;
		const clipped = text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS)}…` : text;
		chunks.push(`${role}: ${clipped}`);
	}
	if (chunks.length === 0) return "";
	const combined = chunks.reverse().join("\n\n");
	return combined.length > maxChars ? combined.slice(-maxChars) : combined;
}

export function recentConversationFromTranscript(path: string | undefined, maxChars = DEFAULT_CONVERSATION_CHARS): string {
	if (!path) return "";
	let fd: number | undefined;
	try {
		// Bounded tail read: transcripts of long sessions can reach hundreds of MB.
		fd = openSync(path, "r");
		const size = fstatSync(fd).size;
		const length = Math.min(size, TAIL_BYTES);
		if (length === 0) return "";
		const buffer = Buffer.alloc(length);
		let read = 0;
		while (read < length) {
			const n = readSync(fd, buffer, read, length - read, size - length + read);
			if (n === 0) break;
			read += n;
		}
		const text = buffer.subarray(0, read).toString("utf8");
		// Drop a possibly truncated first line when we started mid-file.
		const jsonl = size > length ? text.slice(text.indexOf("\n") + 1) : text;
		return conversationFromJsonl(jsonl, maxChars);
	} catch {
		return "";
	} finally {
		if (fd !== undefined) {
			try {
				closeSync(fd);
			} catch {
				// already closed or never opened
			}
		}
	}
}
