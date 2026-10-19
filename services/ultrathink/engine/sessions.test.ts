// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeSession } from "../../../src/claude/state.ts";
import type { SessionRecord } from "../../../src/claude/state.ts";
import { type JournalMeta, journalDir, writeMeta } from "../../../src/host/grokbot.ts";
import { FALLBACK_GRAPH } from "../../../src/think/types.ts";
import type { ThoughtGraph } from "../../../src/think/types.ts";
import { GOAL_MAX_CHARS, listSessions, newestPlannedSessionId } from "./sessions.ts";

const dirs: string[] = [];
const tmp = (): string => {
	const dir = mkdtempSync(join(tmpdir(), "ut-sessions-"));
	dirs.push(dir);
	return dir;
};
afterAll(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const NOW = 1_800_000_000_000;
const SECRET_PROMPT = "SECRET-PROMPT-BODY please do the thing\nsecond line of the prompt";
const SECRET_ERROR = "SECRET-ERROR-TEXT from the provider";
const SECRET_SPEC = "SECRET-SPEC-XML";

/** Sets both timestamps so the directory scan order matches the timestamps the files carry. */
function touch(path: string, ms: number): void {
	utimesSync(path, ms / 1000, ms / 1000);
}

/** `jobs/<id>.json` exactly as the headless planner persists it. */
function writeJob(stateDir: string, sessionId: string, status: string, updatedAt: number, error?: string): void {
	mkdirSync(join(stateDir, "jobs"), { recursive: true });
	const path = join(stateDir, "jobs", `${sessionId}.json`);
	const body = {
		sessionId,
		runId: randomUUID(),
		status,
		createdAt: updatedAt - 1000,
		updatedAt,
		...(error === undefined ? {} : { error }),
		usage: { calls: 3, inputTokens: 100, outputTokens: 50 },
		promptSha256: "0".repeat(64),
	};
	writeFileSync(path, `${JSON.stringify(body)}\n`);
	touch(path, updatedAt);
}

/** `journal/<id>/meta.json` through the real writer, then pinned to a known timestamp. */
function writeClient(stateDir: string, sessionId: string, status: JournalMeta["status"] | string, updatedAt: number, original = SECRET_PROMPT): void {
	const dir = journalDir(stateDir, sessionId);
	writeMeta(dir, { sessionId, original, cwd: "/work", status: status as JournalMeta["status"] });
	const path = join(dir, "meta.json");
	writeFileSync(path, `${JSON.stringify({ sessionId, original, cwd: "/work", status, updatedAt }, null, 2)}\n`);
	touch(path, updatedAt);
}

function graph(goal: string, count = 3): ThoughtGraph {
	return {
		goal,
		nodes: Array.from({ length: count }, (_, i) => ({ id: `n${i + 1}`, title: `Node ${i + 1}`, kind: "decompose" as const, question: `Question ${i + 1}?`, dependsOn: [] })),
	};
}

/** `sessions/<id>.json` through the real writer, then pinned to a known timestamp. */
function writeRecord(stateDir: string, sessionId: string, at: number, options: { graph?: ThoughtGraph; original?: string } = {}): void {
	const record: SessionRecord = {
		sessionId,
		at,
		result: { xml: SECRET_SPEC, original: options.original ?? SECRET_PROMPT, root: "BUILD_PROMPT", source: "llm" },
		...(options.graph ? { graph: options.graph } : {}),
	};
	writeSession(stateDir, record);
	touch(join(stateDir, "sessions", `${sessionId}.json`), at);
}

describe("listSessions", () => {
	test("a missing state directory and an empty one list nothing", () => {
		const root = tmp();
		expect(listSessions(join(root, "absent"))).toEqual([]);
		expect(listSessions(root)).toEqual([]);
		expect(newestPlannedSessionId(join(root, "absent"))).toBeUndefined();
	});

	test("merges jobs, client journals and plan records newest first", () => {
		const state = tmp();
		const [server, client, running] = [randomUUID(), randomUUID(), randomUUID()];
		writeJob(state, server, "planned", NOW - 1000);
		writeRecord(state, server, NOW - 1000, { graph: graph("Ship the CSV converter", 5) });
		writeClient(state, client, "planned", NOW - 2000);
		writeRecord(state, client, NOW - 2000, { graph: graph("Refactor the parser", 4) });
		writeJob(state, running, "running", NOW);

		const list = listSessions(state);
		expect(list.map((s) => s.sessionId)).toEqual([running, server, client]);
		expect(list[0]).toEqual({ sessionId: running, status: "running", mode: "server", updatedAt: NOW, goal: "", nodeCount: 0, hasGraph: false });
		expect(list[1]).toEqual({ sessionId: server, status: "planned", mode: "server", updatedAt: NOW - 1000, goal: "Ship the CSV converter", nodeCount: 5, hasGraph: true });
		expect(list[2]).toEqual({ sessionId: client, status: "planned", mode: "client", updatedAt: NOW - 2000, goal: "Refactor the parser", nodeCount: 4, hasGraph: true });
	});

	test("a plan record with neither a job nor a journal is not listed and is never the newest planned session", () => {
		const state = tmp();
		const [recordOnly, served] = [randomUUID(), randomUUID()];
		writeRecord(state, recordOnly, NOW, { original: "Document the CLI" });
		expect(listSessions(state)).toEqual([]);
		expect(newestPlannedSessionId(state)).toBeUndefined();
		// An older served session is still found behind the newer record-only one.
		writeJob(state, served, "planned", NOW - 1000);
		expect(listSessions(state).map((s) => s.sessionId)).toEqual([served]);
		expect(newestPlannedSessionId(state)).toBe(served);
	});

	test("server job statuses are reported as stored", () => {
		const state = tmp();
		const ids: Record<string, string> = {};
		let offset = 0;
		for (const status of ["running", "planned", "failed", "invalid", "skipped"]) {
			ids[status] = randomUUID();
			writeJob(state, ids[status], status, NOW - offset++);
		}
		const list = listSessions(state, { limit: 20 });
		expect(list.map((s) => s.status)).toEqual(["running", "planned", "failed", "invalid", "skipped"]);
		expect(list.every((s) => s.mode === "server")).toBe(true);
	});

	test("client statuses follow the planner's result view: unfinished states report running", () => {
		const state = tmp();
		const statuses = ["needs-model", "planned", "invalid", "skipped", "something-else"];
		const ids = statuses.map(() => randomUUID());
		statuses.forEach((status, i) => {
			const id = ids[i];
			if (id === undefined) throw new Error(`no id for status ${status}`);
			writeClient(state, id, status, NOW - i);
		});
		const list = listSessions(state, { limit: 20 });
		expect(list.map((s) => s.status)).toEqual(["running", "planned", "invalid", "skipped", "running"]);
		expect(list.every((s) => s.mode === "client")).toBe(true);
		// The goal of an unplanned client session is the first line of its request, never the whole prompt.
		expect(list[0]?.goal).toBe("SECRET-PROMPT-BODY please do the thing");
	});

	test("a client session without a stored updatedAt falls back to the file time", () => {
		const state = tmp();
		const id = randomUUID();
		const dir = journalDir(state, id);
		mkdirSync(dir, { recursive: true });
		const path = join(dir, "meta.json");
		writeFileSync(path, JSON.stringify({ sessionId: id, status: "planned" }));
		touch(path, NOW - 5000);
		expect(listSessions(state)[0]?.updatedAt).toBe(NOW - 5000);
	});

	test("one id in several places is listed once and the job wins", () => {
		const state = tmp();
		const id = randomUUID();
		writeJob(state, id, "failed", NOW - 10);
		writeClient(state, id, "planned", NOW - 5);
		writeRecord(state, id, NOW - 1, { graph: graph("Goal from the record", 2) });
		const list = listSessions(state);
		expect(list).toEqual([{ sessionId: id, status: "failed", mode: "server", updatedAt: NOW - 10, goal: "Goal from the record", nodeCount: 2, hasGraph: true }]);
	});

	test("a job whose file is not a valid job falls back to the journal", () => {
		const state = tmp();
		const id = randomUUID();
		mkdirSync(join(state, "jobs"), { recursive: true });
		writeFileSync(join(state, "jobs", `${id}.json`), JSON.stringify({ sessionId: id, status: "exploded", updatedAt: 1 }));
		writeClient(state, id, "planned", NOW);
		expect(listSessions(state)).toMatchObject([{ sessionId: id, mode: "client", status: "planned" }]);
	});

	test("clamps limit to 1..20 and falls back to 5 for non-numbers", () => {
		const state = tmp();
		for (let i = 0; i < 25; i++) writeJob(state, randomUUID(), "planned", NOW - i * 10);
		expect(listSessions(state, { limit: 0 })).toHaveLength(1);
		expect(listSessions(state, { limit: -4 })).toHaveLength(1);
		expect(listSessions(state, { limit: 99 })).toHaveLength(20);
		expect(listSessions(state, { limit: 3.9 })).toHaveLength(3);
		expect(listSessions(state, { limit: Number.NaN })).toHaveLength(5);
		expect(listSessions(state)).toHaveLength(5);
		expect(listSessions(state, { limit: 20 })[0]?.updatedAt).toBe(NOW);
	});

	test("returns the newest sessions even when many older ones exist", () => {
		const state = tmp();
		const newest = randomUUID();
		for (let i = 1; i <= 30; i++) writeJob(state, randomUUID(), "planned", NOW - i * 1000);
		writeJob(state, newest, "planned", NOW);
		expect(listSessions(state, { limit: 1 }).map((s) => s.sessionId)).toEqual([newest]);
	});

	test("skips malformed, empty and oversized files without failing", () => {
		const state = tmp();
		const good = randomUUID();
		writeJob(state, good, "planned", NOW);
		mkdirSync(join(state, "jobs"), { recursive: true });
		mkdirSync(join(state, "sessions"), { recursive: true });
		writeFileSync(join(state, "jobs", `${randomUUID()}.json`), "{not json");
		writeFileSync(join(state, "jobs", `${randomUUID()}.json`), "");
		writeFileSync(join(state, "jobs", `${randomUUID()}.json`), "null");
		writeFileSync(join(state, "sessions", `${randomUUID()}.json`), JSON.stringify({ sessionId: "x", result: "not an object" }));
		writeFileSync(join(state, "sessions", `${randomUUID()}.json`), "[1,2,3]");
		const brokenMeta = journalDir(state, randomUUID());
		mkdirSync(brokenMeta, { recursive: true });
		writeFileSync(join(brokenMeta, "meta.json"), "<<<");
		mkdirSync(journalDir(state, randomUUID()), { recursive: true });
		expect(listSessions(state, { limit: 20 }).map((s) => s.sessionId)).toEqual([good]);
	});

	test("a malformed graph does not hide its session", () => {
		const state = tmp();
		const id = randomUUID();
		writeJob(state, id, "planned", NOW);
		mkdirSync(join(state, "sessions"), { recursive: true });
		const record = { sessionId: id, at: NOW, result: { xml: "", original: "Plan the release", root: "BUILD_PROMPT", source: "llm" }, graph: { goal: "G", nodes: [null, 3] } };
		writeFileSync(join(state, "sessions", `${id}.json`), JSON.stringify(record));
		expect(listSessions(state)).toEqual([{ sessionId: id, status: "planned", mode: "server", updatedAt: NOW, goal: "Plan the release", nodeCount: 0, hasGraph: false }]);
	});

	test("ignores names that are not session ids and never reads outside the state directory", () => {
		const root = tmp();
		const state = join(root, "state");
		const outside = join(root, "x");
		mkdirSync(outside, { recursive: true });
		writeFileSync(join(outside, "meta.json"), JSON.stringify({ sessionId: "x", status: "planned", original: "outside" }));
		writeFileSync(join(root, "outside.json"), JSON.stringify({ sessionId: "y", status: "planned", updatedAt: NOW, usage: {}, createdAt: 1, promptSha256: "" }));

		mkdirSync(join(state, "journal"), { recursive: true });
		mkdirSync(join(state, "jobs"), { recursive: true });
		mkdirSync(join(state, "sessions"), { recursive: true });
		// The hostile names a listing could meet; each fails isSessionId before any path is built.
		for (const name of ["..", ".", "x", "..x", "%2e%2e%2fx", "not-a-session", randomUUID().toUpperCase(), `${randomUUID()}x`]) {
			mkdirSync(join(state, "journal", name), { recursive: true });
			writeFileSync(join(state, "journal", name, "meta.json"), JSON.stringify({ sessionId: name, status: "planned", original: "hostile" }));
			writeFileSync(join(state, "jobs", `${name}.json`), JSON.stringify({ sessionId: name, status: "planned", updatedAt: NOW, usage: {}, createdAt: 1, promptSha256: "" }));
			writeFileSync(join(state, "sessions", `${name}.json`), JSON.stringify({ sessionId: name, at: NOW, result: { original: "hostile" } }));
		}
		// Symlinks that carry a valid id but point outside the state directory are not followed.
		const linkedDir = randomUUID();
		const linkedFile = randomUUID();
		symlinkSync(outside, join(state, "journal", linkedDir));
		symlinkSync(join(root, "outside.json"), join(state, "jobs", `${linkedFile}.json`));
		expect(listSessions(state, { limit: 20 })).toEqual([]);
		expect(newestPlannedSessionId(state)).toBeUndefined();
	});

	test("goal is one line of at most 120 characters, whatever the request or graph looks like", () => {
		const state = tmp();
		const [fromGraph, fromRequest, control] = [randomUUID(), randomUUID(), randomUUID()];
		const huge = `${"A very long goal ".repeat(2000)}\nsecond line`;
		writeJob(state, fromGraph, "planned", NOW);
		writeRecord(state, fromGraph, NOW, { graph: graph(huge) });
		writeJob(state, fromRequest, "planned", NOW - 1);
		writeRecord(state, fromRequest, NOW - 1, { original: `\n\n   ${"word ".repeat(500)}\nnext` });
		writeJob(state, control, "planned", NOW - 2);
		writeRecord(state, control, NOW - 2, { graph: graph("Tabs\tand\u0007bells\r\nthen more") });

		const [a, b, c] = listSessions(state);
		expect(a?.goal.length).toBeLessThanOrEqual(GOAL_MAX_CHARS);
		expect(a?.goal.startsWith("A very long goal")).toBe(true);
		expect(a?.goal.endsWith("…")).toBe(true);
		expect(b?.goal.length).toBeLessThanOrEqual(GOAL_MAX_CHARS);
		expect(b?.goal.startsWith("word word")).toBe(true);
		expect(c?.goal).toBe("Tabs and bells");
		for (const summary of [a, b, c]) expect(summary?.goal).not.toMatch(/[\r\n\t\u0007]/);
	});

	test("a goal is never cut in the middle of a surrogate pair", () => {
		const state = tmp();
		const id = randomUUID();
		writeJob(state, id, "planned", NOW);
		// 119 ASCII characters then an emoji: the cut falls inside the pair.
		writeRecord(state, id, NOW, { graph: graph(`${"a".repeat(118)}😀😀😀`) });
		const goal = listSessions(state)[0]?.goal ?? "";
		expect(goal.length).toBeLessThanOrEqual(GOAL_MAX_CHARS);
		expect(goal).not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])/);
	});

	test("the boilerplate fallback graph is not a graph", () => {
		const state = tmp();
		const id = randomUUID();
		writeJob(state, id, "planned", NOW);
		writeRecord(state, id, NOW, { graph: structuredClone(FALLBACK_GRAPH), original: "Migrate the billing tables" });
		expect(listSessions(state)).toEqual([{ sessionId: id, status: "planned", mode: "server", updatedAt: NOW, goal: "Migrate the billing tables", nodeCount: 0, hasGraph: false }]);
	});

	test("never returns a prompt body, specification, answer or error text", () => {
		const state = tmp();
		const [failed, planned, client] = [randomUUID(), randomUUID(), randomUUID()];
		writeJob(state, failed, "failed", NOW, SECRET_ERROR);
		writeJob(state, planned, "planned", NOW - 1);
		writeRecord(state, planned, NOW - 1, { graph: graph("Public goal"), original: SECRET_PROMPT });
		writeClient(state, client, "planned", NOW - 2);
		mkdirSync(join(journalDir(state, client), "answers"), { recursive: true });
		writeFileSync(join(journalDir(state, client), "answers", "k.txt"), "SECRET-ANSWER");
		const text = JSON.stringify(listSessions(state, { limit: 20 }));
		for (const secret of [SECRET_ERROR, SECRET_SPEC, "SECRET-ANSWER", "second line of the prompt"]) expect(text).not.toContain(secret);
		expect(Object.keys(listSessions(state)[0] ?? {}).sort()).toEqual(["goal", "hasGraph", "mode", "nodeCount", "sessionId", "status", "updatedAt"]);
	});
});

describe("newestPlannedSessionId", () => {
	test("ignores running and failed sessions and picks the newest planned one", () => {
		const state = tmp();
		const [older, newer, running, failed, invalid] = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
		writeJob(state, older, "planned", NOW - 5000);
		writeClient(state, newer, "planned", NOW - 4000);
		writeJob(state, running, "running", NOW - 1000);
		writeJob(state, failed, "failed", NOW - 500, SECRET_ERROR);
		writeJob(state, invalid, "invalid", NOW);
		expect(newestPlannedSessionId(state)).toBe(newer);
	});

	test("finds a planned session behind many newer unfinished ones", () => {
		const state = tmp();
		const planned = randomUUID();
		writeJob(state, planned, "planned", NOW - 100_000);
		for (let i = 0; i < 30; i++) writeJob(state, randomUUID(), "running", NOW - i);
		expect(newestPlannedSessionId(state)).toBe(planned);
	});

	test("is undefined when nothing is planned", () => {
		const state = tmp();
		writeJob(state, randomUUID(), "running", NOW);
		writeJob(state, randomUUID(), "failed", NOW - 1);
		writeClient(state, randomUUID(), "needs-model", NOW - 2);
		expect(newestPlannedSessionId(state)).toBeUndefined();
	});
});
