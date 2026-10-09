// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DecisionRecord } from "../decisions/types.ts";
import { shipNudge } from "../ship/nudge.ts";
import { DEFAULT_SHIP_CONFIG } from "../ship/types.ts";
import type { ModelResolution } from "../host/engine.ts";
import {
	controlPath,
	defaultStateDir,
	readControl,
	readLast,
	readSession,
	type SessionRecord,
	sessionPath,
	updateSession,
	writeControl,
	writeSession,
    withLastLock,
} from "./state.ts";

const ANSWERS_HOOK = join(import.meta.dir, "..", "..", "hooks", "answers.ts");

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

describe("session records and lessons/docs lookups", () => {
	const base: SessionRecord = { sessionId: "lk-1", at: 3, result: { xml: "<X/>", original: "x", root: "X", source: "llm" } };

	test("both lookups round-trip through the session file and last.json", () => {
		const dir = tempDir();
		const record: SessionRecord = {
			...base,
			lessons: { outcome: "used", count: 2, ids: ["a1", "b2"], chars: 640, ms: 31, source: "hindsight" },
			docs: { status: "error", count: 0, chars: 0, ms: 9, datasets: 2, reason: "auth" },
		};
		writeSession(dir, record);
		expect(readSession(dir, "lk-1")).toEqual(record);
		expect(readLast(dir)).toEqual(record);
	});

	test("a record written before they existed reads back without them", () => {
		const dir = tempDir();
		mkdirSync(join(dir, "sessions"), { recursive: true });
		writeFileSync(sessionPath(dir, "old-2"), JSON.stringify({ sessionId: "old-2", at: 1, engine: "claude:sonnet", result: base.result, knowledge: { outcome: "none", docs: [], chars: 0, ms: 1 } }));
		const record = readSession(dir, "old-2");
		expect(record?.sessionId).toBe("old-2");
		expect(record?.knowledge?.outcome).toBe("none");
		expect(record).not.toHaveProperty("lessons");
		expect(record).not.toHaveProperty("docs");
		writeSession(dir, record as SessionRecord);
		expect(readSession(dir, "old-2")).toEqual(record);
	});
});

describe("session records and the model resolution record", () => {
	const base: SessionRecord = { sessionId: "mr-1", at: 4, engine: "claude:<model>", result: { xml: "<X/>", original: "x", root: "X", source: "llm" } };
	const resolution: ModelResolution = {
		version: "1.0.0",
		state: "detected",
		host: "omp",
		transport: "omp-native",
		source: "ctx.model",
		reason: "live-model",
		engineSelection: { engine: "auto", source: "config", nativeOptOut: false },
		api: "acme-chat",
		providerType: "acme",
		provider: "acme",
		modelId: "sol-1",
		modelKnown: true,
		label: "omp-native:acme/sol-1 [detected]",
	};

	test("the safe record round-trips through the session file and last.json, exactly as given", () => {
		const dir = tempDir();
		const record: SessionRecord = { ...base, modelResolution: resolution };
		writeSession(dir, record);
		expect(readSession(dir, "mr-1")).toEqual(record);
		expect(readLast(dir)).toEqual(record);
		expect(Object.keys(readSession(dir, "mr-1")?.modelResolution ?? {}).sort()).toEqual(Object.keys(resolution).sort());
	});

	test("a record written before it existed reads back without it and stays valid", () => {
		const dir = tempDir();
		mkdirSync(join(dir, "sessions"), { recursive: true });
		writeFileSync(sessionPath(dir, "old-3"), JSON.stringify({ sessionId: "old-3", at: 1, engine: "claude:<model>", result: base.result }));
		const record = readSession(dir, "old-3");
		expect(record?.sessionId).toBe("old-3");
		expect(record).not.toHaveProperty("modelResolution");
		writeSession(dir, record as SessionRecord);
		expect(readSession(dir, "old-3")).toEqual(record);
	});

	test("control engine values are unchanged: a resolution record is never control state", () => {
		const dir = tempDir();
		for (const engine of ["auto", "claude", "grok", "muse"] as const) {
			writeControl(dir, { engine });
			expect(readControl(dir).engine).toBe(engine);
		}
		writeFileSync(controlPath(dir), JSON.stringify({ engine: "omp-native", modelResolution: resolution }));
		expect(readControl(dir)).toEqual({});
	});
});

describe("private, atomic state files", () => {
	const record: SessionRecord = { sessionId: "p1", at: 5, result: { xml: "<X/>", original: "a verbatim prompt", root: "X", source: "llm" } };

	test.skipIf(process.platform === "win32")("session, last and control files are 0600 in 0700 directories", () => {
		const dir = tempDir();
		writeSession(dir, record);
		writeControl(dir, { enabled: true });
		for (const path of [sessionPath(dir, "p1"), join(dir, "last.json"), controlPath(dir)]) expect(statSync(path).mode & 0o777).toBe(0o600);
		for (const path of [dir, join(dir, "sessions")]) expect(statSync(path).mode & 0o777).toBe(0o700);
	});

	test.skipIf(process.platform === "win32")("a 0644 file written by an older version is 0600 after its next rewrite", () => {
		const dir = tempDir();
		mkdirSync(join(dir, "sessions"), { recursive: true });
		writeFileSync(sessionPath(dir, "p1"), JSON.stringify(record), { mode: 0o644 });
		writeSession(dir, record);
		expect(statSync(sessionPath(dir, "p1")).mode & 0o777).toBe(0o600);
	});

	test("writes keep the tab-indented JSON format and leave no temporary or lock files", () => {
		const dir = tempDir();
		writeSession(dir, record);
		writeControl(dir, { enabled: false });
		expect(readFileSync(sessionPath(dir, "p1"), "utf8")).toBe(`${JSON.stringify(record, null, "\t")}\n`);
		expect(readFileSync(controlPath(dir), "utf8")).toBe('{\n\t"enabled": false\n}\n');
		for (const where of [dir, join(dir, "sessions")]) {
			expect(readdirSync(where).filter((name) => name.endsWith(".tmp") || name.endsWith(".lock"))).toEqual([]);
		}
	});

	test("a truncated session file reads as missing and the next writeSession replaces it whole", () => {
		const dir = tempDir();
		mkdirSync(join(dir, "sessions"), { recursive: true });
		writeFileSync(sessionPath(dir, "p1"), '{"sessionId":"p1","at":5,"resu');
		expect(readSession(dir, "p1")).toBeUndefined();
		writeSession(dir, record);
		expect(readSession(dir, "p1")).toEqual(record);
	});
});

describe("updateSession", () => {
	const record: SessionRecord = { sessionId: "u1", at: 1, result: { xml: "<X/>", original: "x", root: "X", source: "llm" } };

	test("returns the mutated record, writing the session file and last.json", () => {
		const dir = tempDir();
		writeSession(dir, record);
		const next = updateSession(dir, "u1", (current) => ({ ...current, kickedOff: true }));
		expect(next).toEqual({ ...record, kickedOff: true });
		expect(readSession(dir, "u1")).toEqual({ ...record, kickedOff: true });
		expect(readLast(dir)).toEqual({ ...record, kickedOff: true });
		expect(existsSync(`${sessionPath(dir, "u1")}.lock`)).toBe(false);
	});

	test("a missing record is undefined, mutate is not called and nothing is written", () => {
		const dir = tempDir();
		let called = false;
		expect(
			updateSession(dir, "nope", (current) => {
				called = true;
				return current;
			}),
		).toBeUndefined();
		expect(called).toBe(false);
		expect(existsSync(sessionPath(dir, "nope"))).toBe(false);
		expect(existsSync(join(dir, "last.json"))).toBe(false);
	});

	test("a mutate that returns undefined leaves the record as it was", () => {
		const dir = tempDir();
		writeSession(dir, record);
		const before = readFileSync(sessionPath(dir, "u1"), "utf8");
		expect(updateSession(dir, "u1", () => undefined)).toBeUndefined();
		expect(readFileSync(sessionPath(dir, "u1"), "utf8")).toBe(before);
	});

	test("a throwing mutate propagates and releases the lock", () => {
		const dir = tempDir();
		writeSession(dir, record);
		expect(() =>
			updateSession(dir, "u1", () => {
				throw new Error("bad mutate");
			}),
		).toThrow("bad mutate");
		expect(existsSync(`${sessionPath(dir, "u1")}.lock`)).toBe(false);
		expect(readSession(dir, "u1")).toEqual(record);
	});
});

describe("strict last-lock completion", () => {
	test("a completed live writer can be replaced after a competing mutation guard is freed", () => {
		const dir = tempDir();
		mkdirSync(dir, { recursive: true });
		const last = join(dir, "last.json");
		const guard = `${last}.lock.guard`;
		const owner = `${process.pid}.${"a".repeat(32)}`;
		const before: SessionRecord = { sessionId: "before", at: 1, result: { xml: "<X/>", original: "x", root: "X", source: "llm" } };
		const after: SessionRecord = { ...before, sessionId: "after" };
		expect(withLastLock(last, () => {
			writeFileSync(last, JSON.stringify(before));
			mkdirSync(guard, { mode: 0o700 });
			writeFileSync(join(guard, owner), "", { mode: 0o600 });
		})).toBe(true);
		expect(writeSession(dir, after)).toBeDefined();
		expect(readSession(dir, "after")).toEqual(after);
		expect(readLast(dir)).toEqual(before);
		rmSync(guard, { recursive: true });
		expect(writeSession(dir, after)).toBeUndefined();
		expect(readLast(dir)).toEqual(after);
		expect(existsSync(`${last}.lock`)).toBe(false);
	});

	test("finishing an old inode cannot release a successor with the same live PID", () => {
		const dir = tempDir();
		mkdirSync(dir, { recursive: true });
		const last = join(dir, "last.json");
		const lock = `${last}.lock`;
		const before: SessionRecord = { sessionId: "before", at: 1, result: { xml: "<X/>", original: "x", root: "X", source: "llm" } };
		expect(withLastLock(last, () => {
			writeFileSync(last, JSON.stringify(before));
			rmSync(lock);
			writeFileSync(lock, String(process.pid), { mode: 0o600 });
		})).toBe(true);
		expect(withLastLock(last, () => writeFileSync(last, '{"sessionId":"incorrect"}'))).toBe(false);
		expect(readLast(dir)).toEqual(before);
		expect(readFileSync(lock, "utf8")).toBe(String(process.pid));
	});
});

describe("the HITL answers hook", () => {
	test("folds the user's answers into the session record and spec file, keeping other fields, owner-only", async () => {
		const dir = tempDir();
		const record: SessionRecord = {
			sessionId: "h1",
			at: 1,
			kickedOff: true,
			result: { xml: "<BUILD_PROMPT>\n<ORIGINAL>x</ORIGINAL>\n</BUILD_PROMPT>", original: "x", root: "BUILD_PROMPT", source: "llm" },
		};
		writeSession(dir, record);
		const envelope = {
			session_id: "h1",
			tool_name: "AskUserQuestion",
			tool_input: { questions: [{ question: "Which database?", header: "Database", options: [{ label: "Postgres" }, { label: "SQLite" }] }] },
			tool_response: { answers: { "Which database?": "Postgres" } },
		};
		const proc = Bun.spawn([process.execPath, ANSWERS_HOOK], {
			cwd: join(dir, ".."),
			env: { PATH: process.env.PATH, HOME: dir, ULTRATHINK_STATE_DIR: dir },
			stdin: new TextEncoder().encode(JSON.stringify(envelope)),
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, exit] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
		expect(exit).toBe(0);
		expect(JSON.parse(stdout)).toEqual({ systemMessage: "HITL · 1 answer(s) recorded" });

		const saved = readSession(dir, "h1");
		expect(saved?.kickedOff).toBe(true);
		expect(saved?.clarifications).toHaveLength(1);
		expect(saved?.clarifications?.[0]).toMatchObject({ question: "Which database?", answer: "Postgres", source: "user" });
		expect(saved?.result.xml).toContain("Postgres");
		const specPath = sessionPath(dir, "h1").replace(/\.json$/, ".xml");
		expect(readFileSync(specPath, "utf8")).toBe(`${saved?.result.xml}\n`);
		expect(readLast(dir)?.clarifications).toHaveLength(1);
		if (process.platform !== "win32") {
			expect(statSync(specPath).mode & 0o777).toBe(0o600);
			expect(statSync(sessionPath(dir, "h1")).mode & 0o777).toBe(0o600);
		}
	});

	test("a session with no record is left alone and the hook stays silent", async () => {
		const dir = tempDir();
		const proc = Bun.spawn([process.execPath, ANSWERS_HOOK], {
			cwd: join(dir, ".."),
			env: { PATH: process.env.PATH, HOME: dir, ULTRATHINK_STATE_DIR: dir },
			stdin: new TextEncoder().encode(
				JSON.stringify({ session_id: "ghost", tool_name: "AskUserQuestion", tool_input: {}, tool_response: { answers: { Q: "a" } } }),
			),
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, exit] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
		expect(exit).toBe(0);
		expect(stdout).toBe("");
		expect(existsSync(sessionPath(dir, "ghost"))).toBe(false);
	});
});
