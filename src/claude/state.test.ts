import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	defaultStateDir,
	readControl,
	readLast,
	readSession,
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
