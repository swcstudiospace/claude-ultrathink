// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Builds and validates `TeachDigest`: the bounded record of a finished session that `observe` distills lessons from.
 * Hosts reduce their own transcript shape (Claude Code JSONL, Omp/aimee `agent_end` messages) here, and the
 * `teach observe` CLI re-validates whatever it reads from an inbox file or stdin with `parseDigest`, so a hand-edited
 * or truncated file can never feed unbounded text to the distiller. Nothing is redacted here: `observe` does that.
 */
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { isNoise } from "../claude/transcript.ts";
import { DIGEST_MAX_CHARS, DIGEST_MAX_TURNS, DIGEST_TURN_CHARS, type DigestTurn, type TeachDigest } from "./types.ts";

const TAIL_BYTES = 512 * 1024;
const TOOL_SUMMARY_CHARS = 200;
const TOOL_NAME_CHARS = 80;
const SUMMARY_KEYS = ["command", "file_path", "path", "pattern", "url", "query", "description", "prompt"] as const;
const ROLES: Record<DigestTurn["role"], true> = { user: true, assistant: true, tool: true };
const OUTCOMES: Record<NonNullable<TeachDigest["outcome"]>, true> = { completed: true, failed: true, interrupted: true };
const INTERRUPTED = /^\[Request interrupted by user/i;

export interface DigestMeta {
	host: string;
	sessionId: string;
	cwd: string;
	outcome?: TeachDigest["outcome"];
	now?: () => number;
}

function clip(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function nonEmpty(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Keeps the newest turns that fit the turn count and the total character budget, each clipped to the per-turn cap. */
function capTurns(turns: readonly DigestTurn[]): DigestTurn[] {
	const kept: DigestTurn[] = [];
	let chars = 0;
	for (let i = turns.length - 1; i >= 0 && kept.length < DIGEST_MAX_TURNS; i--) {
		const turn = turns[i];
		if (!turn) continue;
		const text = clip(turn.text, DIGEST_TURN_CHARS);
		if (kept.length > 0 && chars + text.length > DIGEST_MAX_CHARS) break;
		chars += text.length;
		kept.push({ ...turn, text });
	}
	return kept.reverse();
}

export function parseDigest(raw: unknown): TeachDigest | undefined {
	if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
	const rec = raw as Record<string, unknown>;
	const host = nonEmpty(rec.host);
	const sessionId = nonEmpty(rec.sessionId);
	const cwd = nonEmpty(rec.cwd);
	if (!host || !sessionId || !cwd) return undefined;
	if (!Array.isArray(rec.turns)) return undefined;
	if (typeof rec.toolCalls !== "number" || !Number.isInteger(rec.toolCalls) || rec.toolCalls < 0) return undefined;
	let outcome: TeachDigest["outcome"];
	if (rec.outcome !== undefined) {
		if (typeof rec.outcome !== "string" || !Object.hasOwn(OUTCOMES, rec.outcome)) return undefined;
		outcome = rec.outcome as TeachDigest["outcome"];
	}
	const turns: DigestTurn[] = [];
	for (const item of rec.turns) {
		if (!item || typeof item !== "object" || Array.isArray(item)) return undefined;
		const turn = item as Record<string, unknown>;
		if (typeof turn.role !== "string" || !Object.hasOwn(ROLES, turn.role) || typeof turn.text !== "string") return undefined;
		const parsed: DigestTurn = { role: turn.role as DigestTurn["role"], text: turn.text };
		const tool = nonEmpty(turn.tool);
		if (tool) parsed.tool = clip(tool, TOOL_NAME_CHARS);
		if (turn.isError === true) parsed.isError = true;
		turns.push(parsed);
	}
	const at = typeof rec.at === "string" ? Date.parse(rec.at) : Number.NaN;
	return {
		host,
		sessionId,
		cwd,
		at: new Date(Number.isNaN(at) ? Date.now() : at).toISOString(),
		turns: capTurns(turns),
		toolCalls: rec.toolCalls,
		...(outcome ? { outcome } : {}),
	};
}

function partsText(content: unknown): string {
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

function summarizeInput(input: unknown): string {
	let text = "";
	if (typeof input === "string") text = input;
	else if (input && typeof input === "object") {
		const rec = input as Record<string, unknown>;
		const key = SUMMARY_KEYS.find((name) => nonEmpty(rec[name]));
		if (key) text = String(rec[key]);
		else {
			try {
				text = JSON.stringify(input) ?? "";
			} catch {
				text = "";
			}
		}
	}
	return clip(text.replace(/\s+/g, " ").trim(), TOOL_SUMMARY_CHARS);
}

function toolCallTurn(name: unknown, input: unknown): DigestTurn {
	const tool = clip(nonEmpty(name) ?? "tool", TOOL_NAME_CHARS);
	const summary = summarizeInput(input);
	return { role: "assistant", tool, text: summary ? `${tool}: ${summary}` : tool };
}

/** Reads the last `TAIL_BYTES` of a file as text, dropping the first line when the read started mid-file. */
function readTail(path: string): string | undefined {
	let fd: number | undefined;
	try {
		fd = openSync(path, "r");
		const size = fstatSync(fd).size;
		const length = Math.min(size, TAIL_BYTES);
		if (length === 0) return undefined;
		const buffer = Buffer.alloc(length);
		let read = 0;
		while (read < length) {
			const n = readSync(fd, buffer, read, length - read, size - length + read);
			if (n === 0) break;
			read += n;
		}
		const text = buffer.subarray(0, read).toString("utf8");
		return size > length ? text.slice(text.indexOf("\n") + 1) : text;
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) {
			try {
				closeSync(fd);
			} catch {
				// nothing to release
			}
		}
	}
}

function finish(turns: DigestTurn[], toolCalls: number, meta: DigestMeta, outcome: TeachDigest["outcome"]): TeachDigest | undefined {
	if (!turns.some((turn) => turn.role === "user") || !turns.some((turn) => turn.role === "assistant")) return undefined;
	const resolved = meta.outcome ?? outcome;
	return {
		host: meta.host,
		sessionId: meta.sessionId,
		cwd: meta.cwd,
		at: new Date((meta.now ?? Date.now)()).toISOString(),
		turns: capTurns(turns),
		toolCalls,
		...(resolved ? { outcome: resolved } : {}),
	};
}

export function digestFromClaudeTranscript(path: string, meta: DigestMeta): TeachDigest | undefined {
	const jsonl = readTail(path);
	if (!jsonl) return undefined;
	const turns: DigestTurn[] = [];
	const toolNames = new Map<string, string>();
	let toolCalls = 0;
	let interrupted = false;
	for (const line of jsonl.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		let entry: unknown;
		try {
			entry = JSON.parse(trimmed);
		} catch {
			continue;
		}
		if (!entry || typeof entry !== "object") continue;
		const rec = entry as { type?: unknown; isMeta?: unknown; message?: unknown };
		if (rec.isMeta === true || (rec.type !== "user" && rec.type !== "assistant")) continue;
		if (!rec.message || typeof rec.message !== "object") continue;
		const role = rec.type;
		const content = "content" in rec.message ? rec.message.content : undefined;
		if (typeof content === "string") {
			const text = content.trim();
			if (!text) continue;
			if (INTERRUPTED.test(text)) interrupted = true;
			else if (!isNoise(text)) turns.push({ role, text });
			continue;
		}
		if (!Array.isArray(content)) continue;
		let pending: string[] = [];
		const flush = (): void => {
			const text = pending.join("\n").trim();
			pending = [];
			if (!text) return;
			if (INTERRUPTED.test(text)) interrupted = true;
			else if (!isNoise(text)) turns.push({ role, text });
		};
		for (const part of content) {
			if (!part || typeof part !== "object") continue;
			const p = part as Record<string, unknown>;
			if (p.type === "text" && typeof p.text === "string") {
				pending.push(p.text);
			} else if (p.type === "tool_use") {
				flush();
				toolCalls++;
				if (typeof p.id === "string") toolNames.set(p.id, clip(nonEmpty(p.name) ?? "tool", TOOL_NAME_CHARS));
				turns.push(toolCallTurn(p.name, p.input));
			} else if (p.type === "tool_result") {
				flush();
				const tool = typeof p.tool_use_id === "string" ? toolNames.get(p.tool_use_id) : undefined;
				const turn: DigestTurn = { role: "tool", text: partsText(p.content) || "(no output)" };
				if (tool) turn.tool = tool;
				if (p.is_error === true) turn.isError = true;
				turns.push(turn);
			}
		}
		flush();
	}
	return finish(turns, toolCalls, meta, interrupted ? "interrupted" : undefined);
}

export function digestFromAgentMessages(messages: readonly unknown[], meta: DigestMeta): TeachDigest | undefined {
	const turns: DigestTurn[] = [];
	let toolCalls = 0;
	let lastStop: unknown;
	for (const message of messages) {
		if (!message || typeof message !== "object") continue;
		const rec = message as Record<string, unknown>;
		if (rec.role === "user") {
			if (rec.synthetic === true) continue;
			const text = partsText(rec.content);
			if (text && !isNoise(text)) turns.push({ role: "user", text });
		} else if (rec.role === "assistant") {
			lastStop = rec.stopReason;
			const content = Array.isArray(rec.content) ? rec.content : typeof rec.content === "string" ? [{ type: "text", text: rec.content }] : [];
			let pending: string[] = [];
			const flush = (): void => {
				const text = pending.join("\n").trim();
				pending = [];
				if (text) turns.push({ role: "assistant", text });
			};
			for (const part of content) {
				if (!part || typeof part !== "object") continue;
				const p = part as Record<string, unknown>;
				if (p.type === "text" && typeof p.text === "string") {
					pending.push(p.text);
				} else if (p.type === "toolCall") {
					flush();
					toolCalls++;
					turns.push(toolCallTurn(p.name, p.arguments));
				}
			}
			flush();
		} else if (rec.role === "toolResult") {
			const turn: DigestTurn = { role: "tool", text: partsText(rec.content) || "(no output)" };
			const tool = nonEmpty(rec.toolName);
			if (tool) turn.tool = clip(tool, TOOL_NAME_CHARS);
			if (rec.isError === true) turn.isError = true;
			turns.push(turn);
		}
	}
	return finish(turns, toolCalls, meta, lastStop === "aborted" ? "interrupted" : lastStop === "error" ? "failed" : undefined);
}
