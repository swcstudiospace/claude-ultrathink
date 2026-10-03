// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isOmpSubagentSessionId, readOmpSessionModelFile } from "./omp-session.ts";
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

describe("readOmpSessionModelFile", () => {
	function writeJsonl(rel: string, lines: string[]): string {
		const path = join(root, rel);
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, `${lines.join("\n")}\n`);
		return path;
	}

	const change = (model: string) =>
		JSON.stringify({ type: "model_change", id: "e1", parentId: null, timestamp: "2026-10-03T00:00:00.000Z", model });

	test("the last model_change wins", () => {
		const path = writeJsonl("-proj/2026_s1.jsonl", [
			JSON.stringify({ type: "session", version: 3, id: "s1" }),
			change("xai-oauth/grok-4.6"),
			JSON.stringify({ type: "message", message: { role: "user" } }),
			change("anthropic/claude-sonnet-4-5"),
		]);
		expect(readOmpSessionModelFile(path)).toBe("anthropic/claude-sonnet-4-5");
	});

	test("a message body quoting model_change does not shadow the entry", () => {
		const path = writeJsonl("-proj/2026_s1.jsonl", [
			change("xai-oauth/grok-4.6"),
			JSON.stringify({ type: "message", message: { role: "user", content: 'what does "model_change" mean?' } }),
		]);
		expect(readOmpSessionModelFile(path)).toBe("xai-oauth/grok-4.6");
	});

	test("a malformed marker on the first line terminates without a model", () => {
		const path = writeJsonl("-proj/2026_s1.jsonl", [
			'"model_change" not json at byte zero',
			JSON.stringify({ type: "session", version: 3, id: "s1" }),
		]);
		expect(readOmpSessionModelFile(path)).toBeUndefined();
	});

	test("malformed lines and entries without a model are skipped", () => {
		const path = writeJsonl("-proj/2026_s1.jsonl", [
			change("xai-oauth/grok-4.6"),
			'{"type":"model_change","model":',
			JSON.stringify({ type: "model_change", model: 42 }),
			JSON.stringify({ type: "model_change" }),
		]);
		expect(readOmpSessionModelFile(path)).toBe("xai-oauth/grok-4.6");
	});

	test("missing, unreadable or model-less inputs mean unknown", () => {
		expect(readOmpSessionModelFile(undefined)).toBeUndefined();
		expect(readOmpSessionModelFile("")).toBeUndefined();
		expect(readOmpSessionModelFile(join(root, "missing.jsonl"))).toBeUndefined();
		expect(readOmpSessionModelFile(root)).toBeUndefined();
		const path = writeJsonl("-proj/2026_s1.jsonl", [JSON.stringify({ type: "session", version: 3, id: "s1" })]);
		expect(readOmpSessionModelFile(path)).toBeUndefined();
	});
});
