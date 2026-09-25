// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFdProgressSink, createLineSplitter, type ProgressEvent, parseProgressLine } from "./progress.ts";

const events: ProgressEvent[] = [
	{ type: "begin", at: 1, sessionId: "s", engine: "grok" },
	{ type: "stage", at: 2, stage: "uplift", phase: "end", ok: true, detail: "BUILD_PROMPT · llm" },
	{ type: "graph", at: 3, total: 1, nodes: [{ id: "n1", title: "A", kind: "understand" }] },
	{ type: "node", at: 4, phase: "done", id: "n1", title: "A", kind: "understand", index: 0, total: 1, fallback: true },
	{
		type: "track",
		at: 5,
		linear: { nodes: [1, 2], steps: [0, 3] },
		notion: { task: true, nodes: [0, 2], steps: [0, 3] },
		error: "boom",
	},
	{ type: "begin", at: 6, sessionId: "s", engine: "grok", skill: "gsd-plan-phase" },
	{ type: "graph", at: 6, total: 2, nodes: [{ id: "n1", title: "A", kind: "understand", dependsOn: [] }, { id: "n2", title: "B", kind: "generate", dependsOn: ["n1"] }] },
	{ type: "node", at: 6, phase: "done", id: "n1", title: "A", kind: "understand", index: 0, total: 2, steps: ["Step 1: read"] },
	{ type: "issue", at: 6, provider: "linear", nodeId: "n1", step: 2, identifier: "SPE-1", url: "https://linear.app/o/issue/SPE-1" },
	{ type: "issue", at: 6, provider: "notion", nodeId: "n1", url: "https://www.notion.so/p" },
	{ type: "end", at: 6, outcome: "planned" },
];

describe("createFdProgressSink", () => {
	test("undefined without env var, for fd < 3, or non-integer", () => {
		expect(createFdProgressSink({})).toBeUndefined();
		expect(createFdProgressSink({ ULTRATHINK_PROGRESS_FD: "1" })).toBeUndefined();
		expect(createFdProgressSink({ ULTRATHINK_PROGRESS_FD: "2" })).toBeUndefined();
		expect(createFdProgressSink({ ULTRATHINK_PROGRESS_FD: "3.5" })).toBeUndefined();
		expect(createFdProgressSink({ ULTRATHINK_PROGRESS_FD: "abc" })).toBeUndefined();
	});

	test("writes one JSON line per event and swallows write errors on a closed fd", () => {
		const dir = mkdtempSync(join(tmpdir(), "ut-progress-"));
		try {
			const path = join(dir, "events.jsonl");
			const fd = openSync(path, "w");
			const sink = createFdProgressSink({ ULTRATHINK_PROGRESS_FD: String(fd) });
			expect(sink).toBeDefined();
			for (const event of events) sink?.(event);
			closeSync(fd);
			const lines = readFileSync(path, "utf8").split("\n");
			expect(lines.at(-1)).toBe("");
			expect(lines.slice(0, -1).map((line) => JSON.parse(line))).toEqual(events);
			expect(() => sink?.(events[0]!)).not.toThrow();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("parseProgressLine", () => {
	test("accepts every event type", () => {
		for (const event of events) expect(parseProgressLine(JSON.stringify(event))).toEqual(event);
	});

	test("rejects junk, unknown types, and missing at", () => {
		expect(parseProgressLine("not json")).toBeUndefined();
		expect(parseProgressLine("{broken")).toBeUndefined();
		expect(parseProgressLine("[1,2]")).toBeUndefined();
		expect(parseProgressLine(JSON.stringify({ type: "mystery", at: 1 }))).toBeUndefined();
		expect(parseProgressLine(JSON.stringify({ type: "issue", provider: "linear", nodeId: "n1", url: "u" }))).toBeUndefined();
		expect(parseProgressLine(JSON.stringify({ type: "toString", at: 1 }))).toBeUndefined();
		expect(parseProgressLine(JSON.stringify({ type: "end", outcome: "planned" }))).toBeUndefined();
		expect(parseProgressLine(JSON.stringify({ type: "end", at: "1" }))).toBeUndefined();
	});
});

describe("createLineSplitter", () => {
	test("joins chunks split mid-line and flushes a trailing partial line on end", () => {
		const lines: string[] = [];
		const splitter = createLineSplitter((line) => lines.push(line));
		splitter.push('{"a":');
		splitter.push('1}\n{"b"');
		expect(lines).toEqual(['{"a":1}']);
		splitter.push(":2}\r\n\npartial");
		expect(lines).toEqual(['{"a":1}', '{"b":2}']);
		splitter.end();
		expect(lines).toEqual(['{"a":1}', '{"b":2}', "partial"]);
		splitter.end();
		expect(lines).toHaveLength(3);
	});
});
