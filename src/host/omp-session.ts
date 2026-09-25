// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Omp persists a task subagent's session one directory deeper than a
 * top-level session: `<root>/<cwd slug>/<parent session>/<Agent>.jsonl`.
 * The engine is spawned fresh per prompt, so it can recognise a subagent
 * session id on disk even when the long-running Omp extension cannot.
 * Always fail-open: any error means "not a subagent".
 */
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HEAD_BYTES = 4096;
const DEFAULT_MAX_AGE_MS = 12 * 60 * 60 * 1000;
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
