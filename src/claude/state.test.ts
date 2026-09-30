// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DecisionRecord } from "../decisions/types.ts";
import { shipNudge } from "../ship/nudge.ts";
import { DEFAULT_SHIP_CONFIG } from "../ship/types.ts";
import {
	controlPath,
	defaultStateDir,
	readControl,
	readLast,
	readSession,
	type SessionRecord,
	sessionPath,
	writeControl,
	writeSession,
} from "./state.ts";

const dirs: string[] = [];
function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "ultrathink-state-"));
	dirs.push(dir);
	return join(dir, "ultrathink");
}
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("defaultStateDir", () => {
	test("prefers ULTRATHINK_STATE_DIR, then CLAUDE_CONFIG_DIR, then ~/.claude", () => {
		expect(defaultStateDir({ ULTRATHINK_STATE_DIR: "/x" })).toBe("/x");
		expect(defaultStateDir({ CLAUDE_CONFIG_DIR: "/cfg" })).toBe(join("/cfg", "ultrathink"));
		expect(defaultStateDir({}).endsWith(join(".claude", "ultrathink"))).toBe(true);
	});
});

describe("control state", () => {
	test("missing file is empty; write merges and persists", () => {
		const dir = tempDir();
		expect(readControl(dir)).toEqual({});
		expect(writeControl(dir, { enabled: false })).toEqual({ enabled: false });
		expect(writeControl(dir, { skipOnce: true })).toEqual({ enabled: false, skipOnce: true });
		expect(readControl(dir)).toEqual({ enabled: false, skipOnce: true });
	});

	test("hitlEnabled and engine persist; unknown engine values are dropped", () => {
		const dir = tempDir();
		writeControl(dir, { hitlEnabled: false, engine: "claude" });
		expect(readControl(dir)).toEqual({ hitlEnabled: false, engine: "claude" });
		writeControl(dir, { engine: "bogus" as unknown as "grok" });
		expect(readControl(dir).engine).toBeUndefined();
		expect(readControl(dir).hitlEnabled).toBe(false);
	});

	test("trackEnabled persists; a hand-edited non-boolean value is dropped", () => {
		const dir = tempDir();
		writeControl(dir, { trackEnabled: false });
		expect(readControl(dir)).toEqual({ trackEnabled: false });
		writeFileSync(controlPath(dir), JSON.stringify({ trackEnabled: "off", hitlEnabled: true }));
		expect(readControl(dir)).toEqual({ hitlEnabled: true });
	});
});

describe("session records", () => {
	test("round-trips and mirrors to last.json; ids are sanitized", () => {
		const dir = tempDir();
		const record = {
			sessionId: "abc/../evil",
			at: 1,
			result: { xml: "<X/>", original: "x", root: "X", source: "llm" as const },
		};
		writeSession(dir, record);
		expect(existsSync(sessionPath(dir, "abc/../evil"))).toBe(true);
		expect(sessionPath(dir, "abc/../evil")).toContain("abc_.._evil.json");
		expect(readSession(dir, "abc/../evil")).toEqual(record);
		expect(readLast(dir)).toEqual(record);
		expect(readSession(dir, "nope")).toBeUndefined();
	});

	test("round-trips a record carrying a track plan and kickoff/sync flags", () => {
		const dir = tempDir();
		const record = {
			sessionId: "s1",
			at: 2,
			engine: "claude:sonnet",
			result: { xml: "<X/>", original: "x", root: "X", source: "llm" as const },
			plan: {
				graphId: "ut-1",
				task: {
					graphId: "ut-1",
					item: "x",
					description: "x",
					upliftedPrompt: "<X/>",
					agent: "claude-code",
					status: "Planning",
					linearState: "Todo",
				},
				issues: [],
				subIssues: [],
				linearIssues: [],
				linearSubIssues: [],
				hitl: { blocking: [], nonBlocking: [] },
			},
			kickedOff: true,
			synced: false,
		};
		writeSession(dir, record);
		expect(readSession(dir, "s1")).toEqual(record);
	});
});

describe("session records and Jev decisions", () => {
	/** A record as written before Decisions existed: a GSD skill run with a plan and an unfinished ship phase, no `decisions`. */
	const OLD_RECORD: SessionRecord = {
		sessionId: "old-1",
		at: 1_759_000_000_000,
		engine: "claude:sonnet",
		host: "claude-code",
		result: { xml: "<BUILD_PROMPT/>", original: "run the phase", root: "BUILD_PROMPT", source: "llm" },
		plan: {
			graphId: "ut-old",
			task: {
				graphId: "ut-old",
				item: "run the phase",
				description: "run the phase",
				upliftedPrompt: "<BUILD_PROMPT/>",
				agent: "claude-code",
				status: "Planning",
				linearState: "Todo",
			},
			issues: [],
			subIssues: [],
			linearIssues: [],
			linearSubIssues: [],
			hitl: { blocking: [], nonBlocking: [] },
		},
		kickedOff: true,
		synced: false,
		skill: { name: "gsd-execute-phase", source: "slash" },
		ship: { phase: "needs-fixes", rounds: [], updatedAt: 5 },
	};
	const nudgeInput = (record: SessionRecord) => ({
		record,
		config: { ...DEFAULT_SHIP_CONFIG, enabled: true },
		precheck: { ok: true, branch: "feat/x", base: "main", ahead: 2 },
		statePath: "/s/old-1.json",
		env: {},
	});
	/** Writes raw JSON the way the pre-Decisions writer did (tab-indented, trailing newline), bypassing writeSession. */
	function writeRaw(dir: string, sessionId: string, value: unknown): void {
		const text = `${JSON.stringify(value, null, "\t")}\n`;
		mkdirSync(join(dir, "sessions"), { recursive: true });
		writeFileSync(sessionPath(dir, sessionId), text);
		writeFileSync(join(dir, "last.json"), text);
	}

	test("a record written before Decisions loads with every field intact and the ship nudge decides as today (AC-3.15)", () => {
		const dir = tempDir();
		writeRaw(dir, "old-1", OLD_RECORD);
		const loaded = readSession(dir, "old-1");
		expect(loaded).toEqual(OLD_RECORD);
		expect(readLast(dir)).toEqual(OLD_RECORD);
		expect(loaded && "decisions" in loaded).toBe(false);
		const today = shipNudge(nudgeInput(OLD_RECORD));
		expect(today?.decision).toBe("block");
		expect(shipNudge(nudgeInput(loaded as SessionRecord))).toEqual(today);
	});

	test("round-trips a planned record carrying its Jev decisions in call order", () => {
		const dir = tempDir();
		const decisions: DecisionRecord[] = [
			{
				point: "plan",
				outcome: "ok",
				model: "typesafe/jev-1.13-20260917",
				id: "gen-dec-test",
				p: 0.97,
				probabilities: { plan_worthy: 0.97 },
				threshold: 0.2,
				action: "plan",
				latencyMs: 412,
				attempts: 1,
				cost: 0.000019,
				at: 1_759_000_000_500,
			},
			{
				point: "knowledge",
				outcome: "error",
				model: "~typesafe/jev-latest",
				probabilities: {},
				threshold: 0.8,
				action: "fail-open",
				latencyMs: 3000,
				attempts: 2,
				error: "timeout",
				at: 1_759_000_003_600,
			},
		];
		const record: SessionRecord = { ...OLD_RECORD, sessionId: "new-1", decisions };
		writeSession(dir, record);
		expect(readSession(dir, "new-1")).toEqual(record);
		expect(readLast(dir)?.decisions).toEqual(decisions);
	});

	test("a malformed decisions value does not break loading the rest of the record or the ship nudge", () => {
		for (const decisions of ["oops", 7, { point: "plan" }, [null, { bogus: true }], null]) {
			const dir = tempDir();
			writeRaw(dir, "old-1", { ...OLD_RECORD, decisions });
			const loaded = readSession(dir, "old-1");
			expect(loaded).toBeDefined();
			const { decisions: _ignored, ...rest } = loaded as SessionRecord;
			expect(rest).toEqual(OLD_RECORD);
			expect(shipNudge(nudgeInput(loaded as SessionRecord))?.decision).toBe("block");
		}
	});
});
