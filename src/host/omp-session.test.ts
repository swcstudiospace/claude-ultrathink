// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isOmpSubagentSessionId } from "./omp-session.ts";
import { planPrompt } from "./plan.ts";
import type { ProgressEvent } from "./progress.ts";

let agentDir: string;
let root: string;

function writeSession(rel: string, id: string): string {
	const path = join(root, rel);
	mkdirSync(join(path, ".."), { recursive: true });
	const title = JSON.stringify({ type: "title", v: 1, title: "" });
	const session = JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-09-25T00:00:00.000Z", cwd: "/proj" });
	writeFileSync(path, `${title}\n${session}\n`);
	return path;
}

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "ultrathink-omp-session-"));
	root = join(agentDir, "sessions");
});

afterEach(() => {
	rmSync(agentDir, { recursive: true, force: true });
});

describe("isOmpSubagentSessionId", () => {
	test("matches only the id of a session nested under a parent session", () => {
		writeSession("-proj/2026_parent/Worker.jsonl", "abc-1");
		writeSession("-proj/2026_abc-2.jsonl", "abc-2");
		expect(isOmpSubagentSessionId("abc-1", { root })).toBe(true);
		expect(isOmpSubagentSessionId("zzz", { root })).toBe(false);
		expect(isOmpSubagentSessionId("abc-2", { root })).toBe(false);
	});

	test("ignores nested sessions older than maxAgeMs", () => {
		const path = writeSession("-proj/2026_parent/Worker.jsonl", "abc-1");
		const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
		utimesSync(path, old, old);
		expect(isOmpSubagentSessionId("abc-1", { root, maxAgeMs: 60 * 60 * 1000 })).toBe(false);
		expect(isOmpSubagentSessionId("abc-1", { root, maxAgeMs: 3 * 60 * 60 * 1000 })).toBe(true);
	});

	test("a malformed session line is skipped without throwing", () => {
		mkdirSync(join(root, "-proj/2026_parent"), { recursive: true });
		writeFileSync(join(root, "-proj/2026_parent/Broken.jsonl"), '{"type":"title"}\n{"type":"session","id":"abc-1",\n');
		writeSession("-proj/2026_parent/Worker.jsonl", "abc-3");
		expect(isOmpSubagentSessionId("abc-1", { root })).toBe(false);
		expect(isOmpSubagentSessionId("abc-3", { root })).toBe(true);
	});

	test("a missing root or an unsafe id is never a subagent", () => {
		expect(isOmpSubagentSessionId("abc-1", { root: join(agentDir, "missing") })).toBe(false);
		writeSession("-proj/2026_parent/Worker.jsonl", "abc-1");
		expect(isOmpSubagentSessionId("abc-1/..", { root })).toBe(false);
		expect(isOmpSubagentSessionId("", { root })).toBe(false);
		expect(isOmpSubagentSessionId("   ", { root })).toBe(false);
	});
});

describe("planPrompt omp subagent guard", () => {
	test("an omp subagent session skips before planning", async () => {
		writeSession("-proj/2026_parent/Worker.jsonl", "abc-1");
		const events: ProgressEvent[] = [];
		const response = await planPrompt(
			{ host: "omp", session_id: "abc-1", prompt: "build it" },
			{ PI_CODING_AGENT_DIR: agentDir },
			{ progress: (e) => events.push(e) },
		);
		expect(response).toEqual({ context: "", skipped: "subagent" });
		expect(events).toEqual([expect.objectContaining({ type: "end", outcome: "skipped", detail: "subagent" })]);
	});
});
