// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendHistory, readHistory } from "./history.ts";
import type { RunResult } from "./run.ts";

const root = mkdtempSync(join(tmpdir(), "chaos-history-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function run(templateId: string, score: number): RunResult {
	return {
		templateId,
		driver: "inprocess",
		startedAt: "2026-10-21T10:00:00.000Z",
		finishedAt: "2026-10-21T10:00:05.000Z",
		settled: true,
		hypotheses: [{ id: "h1", passed: score === 100 }],
		passed: score === 100,
		score,
		rollback: "not_needed",
	};
}

function validLine(seq: number, score = 50): string {
	return JSON.stringify({ ...run("orders", score), seq });
}

describe("readHistory", () => {
	test("a missing file gives empty records without throwing", () => {
		expect(readHistory(join(root, "absent", "history.jsonl"))).toEqual({ records: [], skipped: 0 });
	});

	test("a blank line is neither a record nor a skip", () => {
		const path = join(root, "blank-lines.jsonl");
		writeFileSync(path, `\n${validLine(1)}\n\n   \n`);
		expect(readHistory(path)).toEqual({ records: [{ ...run("orders", 50), seq: 1 }], skipped: 0 });
	});

	test("skips and counts lines that are not JSON or fail the record checks", () => {
		const path = join(root, "invalid-fields.jsonl");
		const bad = [
			"not json at all",
			"null",
			"[1,2,3]",
			JSON.stringify({ ...run("orders", 50), seq: 1, templateId: 7 }),
			JSON.stringify({ ...run("orders", 101), seq: 2 }),
			JSON.stringify({ ...run("orders", -1), seq: 3 }),
			JSON.stringify({ ...run("orders", 50), seq: 4, score: "50" }),
			JSON.stringify({ ...run("orders", 50), seq: 0 }),
			JSON.stringify({ ...run("orders", 50), seq: 1.5 }),
			JSON.stringify({ ...run("orders", 50), seq: 5, hypotheses: "h1" }),
		];
		writeFileSync(path, [validLine(6), ...bad].join("\n"));
		const read = readHistory(path);
		expect(read.records.map((record) => record.seq)).toEqual([6]);
		expect(read.skipped).toBe(bad.length);
	});

	test("a corrupt middle line is skipped and the records around it are returned", () => {
		const path = join(root, "corrupt-middle.jsonl");
		writeFileSync(path, `${validLine(1)}\n{"seq":2,"templateId":\n${validLine(3)}\n`);
		const read = readHistory(path);
		expect(read.records.map((record) => record.seq)).toEqual([1, 3]);
		expect(read.skipped).toBe(1);
	});
});

describe("appendHistory", () => {
	test("creates the parent directory and returns the stored record with seq 1", () => {
		const path = join(root, "nested", "chaos", "history.jsonl");
		const stored = appendHistory(path, run("orders", 75));
		expect(stored).toEqual({ ...run("orders", 75), seq: 1 });
		expect(readHistory(path)).toEqual({ records: [stored], skipped: 0 });
	});

	test("seq runs 1, 2, 3 in file order across reopening the file", () => {
		const path = join(root, "reopen.jsonl");
		appendHistory(path, run("orders", 100));
		appendHistory(path, run("orders", 50));
		const third = appendHistory(path, run("cart", 0));
		expect(third.seq).toBe(3);
		expect(readHistory(path).records.map((record) => [record.seq, record.templateId])).toEqual([
			[1, "orders"],
			[2, "orders"],
			[3, "cart"],
		]);
	});

	test("seq is one above the last valid seq, so corrupt lines do not count", () => {
		const path = join(root, "after-corrupt.jsonl");
		writeFileSync(path, `${validLine(1)}\nnot json\n${validLine(2)}\nnot json either\n`);
		expect(appendHistory(path, run("orders", 50)).seq).toBe(3);
		expect(readHistory(path)).toEqual({ records: [{ ...run("orders", 50), seq: 1 }, { ...run("orders", 50), seq: 2 }, { ...run("orders", 50), seq: 3 }], skipped: 2 });
	});

	test("a torn last line is terminated before the new record, which stays readable", () => {
		const path = join(root, "torn-tail.jsonl");
		writeFileSync(path, `${validLine(1)}\n{"templateId":"orders","sc`);
		const stored = appendHistory(path, run("orders", 25));
		expect(stored.seq).toBe(2);
		expect(readFileSync(path, "utf8").endsWith("\n")).toBe(true);
		const read = readHistory(path);
		expect(read.records.map((record) => record.seq)).toEqual([1, 2]);
		expect(read.skipped).toBe(1);
	});
});
