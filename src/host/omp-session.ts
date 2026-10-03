// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Omp persists a task subagent's session one directory deeper than a
 * top-level session: `<root>/<cwd slug>/<parent session>/<Agent>.jsonl`.
 * The engine is spawned fresh per prompt, so it can recognise a subagent
 * session id on disk even when the long-running Omp extension cannot.
 * Always fail-open: any error means "not a subagent".
 */
import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HEAD_BYTES = 4096;
const DEFAULT_MAX_AGE_MS = 12 * 60 * 60 * 1000;
const MAX_SESSION_BYTES = 32 * 1024 * 1024;
const SESSION_ID = /^[A-Za-z0-9-]+$/;

export interface OmpSessionScanOptions {
	root?: string;
	now?: number;
	maxAgeMs?: number;
}

function headSessionId(path: string): string | undefined {
	const fd = openSync(path, "r");
	try {
		const buffer = Buffer.alloc(HEAD_BYTES);
		const read = readSync(fd, buffer, 0, HEAD_BYTES, 0);
		const line = buffer.toString("utf8", 0, read).split("\n").find((l) => l.includes('"type":"session"'));
		if (!line) return undefined;
		const parsed: unknown = JSON.parse(line);
		if (!parsed || typeof parsed !== "object" || !("id" in parsed)) return undefined;
		return typeof parsed.id === "string" ? parsed.id : undefined;
	} finally {
		closeSync(fd);
	}
}

/**
 * Active model of one Omp session file: the last `model_change` entry's model ("provider/model").
 * Always fail-open: any error, an oversize file or a missing entry means "unknown".
 */
export function readOmpSessionModelFile(path: string | undefined): string | undefined {
	if (!path?.trim()) return undefined;
	try {
		const stat = statSync(path);
		if (!stat.isFile() || stat.size > MAX_SESSION_BYTES) return undefined;
		// Reverse scan without splitting: sessions reach tens of MB, and a split doubles memory.
		// A bounded tail scan would miss the start-anchored entry of sessions that never switched.
		const content = readFileSync(path, "utf8");
		let index = content.length;
		for (;;) {
			index = content.lastIndexOf('"model_change"', index - 1);
			if (index === -1) return undefined;
			const start = content.lastIndexOf("\n", index) + 1;
			let end = content.indexOf("\n", index);
			if (end === -1) end = content.length;
			try {
				const parsed: unknown = JSON.parse(content.slice(start, end));
				if (parsed && typeof parsed === "object") {
					const entry = parsed as { type?: unknown; model?: unknown };
					if (entry.type === "model_change" && typeof entry.model === "string" && entry.model.trim()) return entry.model;
				}
			} catch {
				// malformed lines are skipped
			}
			index = start;
		}
	} catch {
		return undefined;
	}
}

export function isOmpSubagentSessionId(sessionId: string, opts: OmpSessionScanOptions = {}): boolean {
	if (!SESSION_ID.test(sessionId)) return false;
	try {
		const root = opts.root ?? join(homedir(), ".omp", "agent", "sessions");
		const now = opts.now ?? Date.now();
		const maxAgeMs = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
		const glob = new Bun.Glob("*/*/*.jsonl");
		for (const rel of glob.scanSync({ cwd: root, dot: true, followSymlinks: false, onlyFiles: true })) {
			try {
				const path = join(root, rel);
				if (now - statSync(path).mtimeMs > maxAgeMs) continue;
				if (headSessionId(path) === sessionId) return true;
			} catch {
				// fail-open: an unreadable or malformed session file is skipped
			}
		}
		return false;
	} catch {
		return false;
	}
}
