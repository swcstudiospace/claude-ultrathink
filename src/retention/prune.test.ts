// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readLast, readSession, withLastLock, writeSession } from "../claude/state.ts";
import { pruneSessions, pruneSessionsBestEffort } from "./prune.ts";

const DAY = 86_400_000;
const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 9, 9, 12);
const now = () => NOW;

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function makeState(): string {
	const root = mkdtempSync(join(tmpdir(), "ut-prune-"));
	roots.push(root);
	return root;
}

function put(path: string, body: string, ageMs: number): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, body);
	const seconds = (NOW - ageMs) / 1000;
	utimesSync(path, seconds, seconds);
}

interface SeedOptions {
	ship?: unknown;
	json?: boolean;
	xml?: boolean;
	body?: string;
}

/** Writes `sessions/<id>.json` and `<id>.xml` aged `ageDays`; the record carries a prompt string. */
function seed(state: string, id: string, ageDays: number, options: SeedOptions = {}): void {
	const age = ageDays * DAY;
	const record = options.body ?? JSON.stringify({ sessionId: id, at: 1, result: { original: `PROMPT-TEXT-${id}` }, ship: options.ship });
	if (options.json !== false) put(join(state, "sessions", `${id}.json`), record, age);
	if (options.xml !== false) put(join(state, "sessions", `${id}.xml`), `<spec>PROMPT-TEXT-${id}</spec>`, age);
}

function sessionFiles(state: string): string[] {
	return readdirSync(join(state, "sessions")).sort();
}

const OPEN_PR = { number: 7, url: "https://example.test/pull/7", headSha: "abc", branch: "feat/x" };

describe("pruneSessions", () => {
	test("removes sessions older than the cutoff with their spec files and keeps newer ones", () => {
		const state = makeState();
		seed(state, "new", 5);
		seed(state, "old", 40);
		seed(state, "older", 100);
		const result = pruneSessions({ stateDir: state, olderThanMs: 30 * DAY, now });
		expect(result.dryRun).toBe(false);
		expect(result.pruned.map((session) => session.id)).toEqual(["older", "old"]);
		expect(result.pruned.map((session) => session.ageDays)).toEqual([100, 40]);
		expect(result.kept).toBe(1);
		expect(result.keptActive).toBe(0);
		expect(result.errors).toEqual([]);
		expect(sessionFiles(state)).toEqual(["new.json", "new.xml"]);
	});

	test("reports bytes as the size of what was removed", () => {
		const state = makeState();
		seed(state, "old", 40);
		const expected = statSync(join(state, "sessions", "old.json")).size + statSync(join(state, "sessions", "old.xml")).size;
		const result = pruneSessions({ stateDir: state, olderThanMs: 30 * DAY, now });
		expect(result.pruned[0]?.bytes).toBe(expected);
		expect(result.bytes).toBe(expected);
	});

	test("a session's age is its newest file: a fresh spec keeps an old record", () => {
		const state = makeState();
		seed(state, "mixed", 90, { xml: false });
		put(join(state, "sessions", "mixed.xml"), "<spec/>", DAY);
		const result = pruneSessions({ stateDir: state, olderThanMs: 30 * DAY, now });
		expect(result.pruned).toEqual([]);
		expect(sessionFiles(state)).toEqual(["mixed.json", "mixed.xml"]);
	});

	test("a spec file without its record is a session of its own", () => {
		const state = makeState();
		seed(state, "lonely", 60, { json: false });
		seed(state, "fresh", 1, { json: false });
		const result = pruneSessions({ stateDir: state, olderThanMs: 30 * DAY, now });
		expect(result.pruned.map((session) => session.id)).toEqual(["lonely"]);
		expect(sessionFiles(state)).toEqual(["fresh.xml"]);
	});

	test("dry run returns the result a real run returns and removes nothing", () => {
		const state = makeState();
		seed(state, "keep", 2);
		seed(state, "old", 45);
		seed(state, "active", 200, { ship: { phase: "pr-open", pr: OPEN_PR } });
		put(join(state, "sessions", "a.json.tmp"), "partial", 3 * HOUR);
		put(join(state, "stray.lock"), "", 3 * HOUR);
		const before = sessionFiles(state);
		const dry = pruneSessions({ stateDir: state, olderThanMs: 30 * DAY, dryRun: true, now });
		expect(dry.dryRun).toBe(true);
		expect(sessionFiles(state)).toEqual(before);
		expect(existsSync(join(state, "stray.lock"))).toBe(true);
		const real = pruneSessions({ stateDir: state, olderThanMs: 30 * DAY, now });
		expect({ ...real, dryRun: true }).toEqual(dry);
		expect(dry.pruned.map((session) => session.id)).toEqual(["old"]);
		expect(dry.orphans.map((orphan) => orphan.name).sort()).toEqual(["a.json.tmp", "stray.lock"]);
		expect(sessionFiles(state)).toEqual(["active.json", "active.xml", "keep.json", "keep.xml"]);
	});

	test("a session whose ship has an open PR is kept however old; merged and blocked ones are not", () => {
		const state = makeState();
		seed(state, "open", 300, { ship: { phase: "pr-open", pr: OPEN_PR } });
		seed(state, "fixes", 300, { ship: { phase: "needs-fixes", pr: OPEN_PR } });
		seed(state, "ready", 300, { ship: { phase: "ready", pr: OPEN_PR } });
		seed(state, "merged", 300, { ship: { phase: "merged", pr: OPEN_PR } });
		seed(state, "blocked", 300, { ship: { phase: "blocked", pr: OPEN_PR } });
		seed(state, "no-pr", 300, { ship: { phase: "pr-open" } });
		seed(state, "not-done", 300, { ship: { phase: "not-done" } });
		const result = pruneSessions({ stateDir: state, olderThanMs: 30 * DAY, now });
		expect(result.keptActive).toBe(3);
		expect(result.kept).toBe(3);
		expect(result.pruned.map((session) => session.id).sort()).toEqual(["blocked", "merged", "no-pr", "not-done"]);
		expect(sessionFiles(state)).toEqual(["fixes.json", "fixes.xml", "open.json", "open.xml", "ready.json", "ready.xml"]);
	});

	test("the sessions last.json and the plan carrier point at are kept", () => {
		const state = makeState();
		seed(state, "last-one", 300);
		seed(state, "carried", 300);
		seed(state, "by-path", 300);
		seed(state, "gone", 300);
		writeFileSync(join(state, "last.json"), JSON.stringify({ sessionId: "last-one", result: {} }));
		writeFileSync(
			join(state, "last-plan.json"),
			JSON.stringify({ host: "omp", sessionId: "carried", specPath: join(state, "sessions", "by-path.xml"), instruction: "x", context: "" }),
		);
		const result = pruneSessions({ stateDir: state, olderThanMs: 30 * DAY, now });
		expect(result.pruned.map((session) => session.id)).toEqual(["gone"]);
		expect(result.kept).toBe(3);
		expect(result.keptActive).toBe(0);
		expect(sessionFiles(state)).toHaveLength(6);
		expect(existsSync(join(state, "last.json"))).toBe(true);
		expect(existsSync(join(state, "last-plan.json"))).toBe(true);
	});

	test("a session id with unsafe characters is protected under its on-disk name", () => {
		const state = makeState();
		seed(state, "a_b", 300);
		writeFileSync(join(state, "last.json"), JSON.stringify({ sessionId: "a/b", result: {} }));
		const result = pruneSessions({ stateDir: state, olderThanMs: 30 * DAY, now });
		expect(result.pruned).toEqual([]);
		expect(result.kept).toBe(1);
	});

	test("never follows or removes a symlink", () => {
		const state = makeState();
		const outside = makeState();
		const target = join(outside, "target.json");
		put(target, JSON.stringify({ sessionId: "t" }), 400 * DAY);
		put(join(outside, "target.tmp"), "x", 5 * HOUR);
		mkdirSync(join(state, "sessions"), { recursive: true });
		symlinkSync(target, join(state, "sessions", "linked.json"));
		symlinkSync(join(outside, "target.tmp"), join(state, "sessions", "linked.json.tmp"));
		const result = pruneSessions({ stateDir: state, olderThanMs: 30 * DAY, now });
		expect(result.pruned).toEqual([]);
		expect(result.orphans).toEqual([]);
		expect(result.kept).toBe(1);
		expect(sessionFiles(state)).toEqual(["linked.json", "linked.json.tmp"]);
		expect(existsSync(target)).toBe(true);
		expect(existsSync(join(outside, "target.tmp"))).toBe(true);
	});

	test("unparseable JSON is judged by age alone", () => {
		const state = makeState();
		seed(state, "broken-old", 60, { body: "{not json" });
		seed(state, "broken-new", 2, { body: "{not json" });
		const result = pruneSessions({ stateDir: state, olderThanMs: 30 * DAY, now });
		expect(result.pruned.map((session) => session.id)).toEqual(["broken-old"]);
		expect(sessionFiles(state)).toEqual(["broken-new.json", "broken-new.xml"]);
		expect(result.errors).toEqual([]);
	});

	test("removes temporary and lock files older than an hour, in sessions and the state root", () => {
		const state = makeState();
		put(join(state, "sessions", "x.json.tmp"), "12345", 2 * HOUR);
		put(join(state, "sessions", "x.json.lock"), "", 2 * HOUR);
		put(join(state, "sessions", "young.json.tmp"), "", 10 * 60_000);
		put(join(state, "last.json.tmp"), "123", 5 * HOUR);
		put(join(state, "young.lock"), "", HOUR / 2);
		put(join(state, "control.json"), "{}", 5 * HOUR);
		const result = pruneSessions({ stateDir: state, olderThanMs: 30 * DAY, now });
		expect(result.orphans.map((orphan) => orphan.name).sort()).toEqual(["last.json.tmp", "x.json.lock", "x.json.tmp"]);
		expect(result.bytes).toBe(8);
		expect(sessionFiles(state)).toEqual(["young.json.tmp"]);
		expect(readdirSync(state).sort()).toEqual(["control.json", "sessions", "young.lock"]);
	});

	for (const dryRun of [true, false]) {
		test(`reclaims only dead prepared mutation guards (${dryRun ? "dry" : "actual"} prune)`, () => {
			const state = makeState();
			const create = (name: string, owner: string | undefined, age: number, extra?: string): string => {
				const path = join(state, name);
				mkdirSync(path, { mode: 0o700 });
				if (owner) writeFileSync(join(path, owner), "", { mode: 0o600 });
				if (extra) writeFileSync(join(path, extra), "keep");
				const seconds = (NOW - age) / 1000;
				utimesSync(path, seconds, seconds);
				return path;
			};
			const dead = `2147483647.${"a".repeat(32)}`;
			const live = `${process.pid}.${"b".repeat(32)}`;
			const old = create(`state.json.lock.guard.${dead}.tmp`, dead, 2 * HOUR);
			const empty = create(`last.json.lock.guard.${dead}.tmp`, undefined, 2 * HOUR);
			const held = create(`control.json.lock.guard.${live}.tmp`, live, 2 * HOUR);
			const young = create(`young.json.lock.guard.${dead}.tmp`, dead, HOUR / 2);
			const foreign = create(`foreign.json.lock.guard.${dead}.tmp`, live, 2 * HOUR);
			const extra = create(`extra.json.lock.guard.${dead}.tmp`, dead, 2 * HOUR, "unrelated");
			const unrelated = create("unrelated.tmp", undefined, 2 * HOUR);
			const outside = makeState();
			const linkedName = `linked.json.lock.guard.${dead}.tmp`;
			symlinkSync(outside, join(state, linkedName));
			const result = pruneSessions({ stateDir: state, olderThanMs: 30 * DAY, dryRun, now });
			expect(result.orphans.map((orphan) => orphan.name).sort()).toEqual([`last.json.lock.guard.${dead}.tmp`, `state.json.lock.guard.${dead}.tmp`]);
			expect(result.errors).toEqual([]);
			expect(existsSync(old)).toBe(dryRun);
			expect(existsSync(empty)).toBe(dryRun);
			if (dryRun) expect(readFileSync(join(old, dead), "utf8")).toBe("");
			expect(readFileSync(join(held, live), "utf8")).toBe("");
			expect(readFileSync(join(young, dead), "utf8")).toBe("");
			expect(readFileSync(join(foreign, live), "utf8")).toBe("");
			expect(readFileSync(join(extra, "unrelated"), "utf8")).toBe("keep");
			expect(readdirSync(unrelated)).toEqual([]);
			expect(statSync(join(state, linkedName)).isDirectory()).toBe(true);
			expect(readdirSync(outside)).toEqual([]);
		});
	}

	for (const dryRun of [true, false]) {
		test(`preserves an aged live strict-last lock and its counters (${dryRun ? "dry" : "actual"} prune)`, () => {
			const state = makeState();
			seed(state, "held", 300);
			const lastPath = join(state, "last.json");
			const lockPath = `${lastPath}.lock`;
			const last = JSON.stringify({ sessionId: "held", at: 1, result: { original: "previous plan" } });
			const holder = String(process.pid);
			put(lastPath, last, 300 * DAY);
			put(lockPath, holder, 3 * HOUR);
			const lockMtime = statSync(lockPath).mtimeMs;

			const result = pruneSessions({ stateDir: state, olderThanMs: 30 * DAY, dryRun, now });

			expect(result).toEqual({ dryRun, scanned: 5, kept: 1, keptActive: 0, pruned: [], orphans: [], bytes: 0, errors: [] });
			expect(readFileSync(lastPath, "utf8")).toBe(last);
			expect(readFileSync(lockPath, "utf8")).toBe(holder);
			expect(statSync(lockPath).mtimeMs).toBe(lockMtime);
			expect(sessionFiles(state)).toEqual(["held.json", "held.xml"]);
		});

		for (const [kind, holder] of [["dead", "2147483647"], ["empty", ""]] as const) {
			test(`cleans an aged ${kind} strict-last lock (${dryRun ? "dry" : "actual"} prune)`, () => {
				const state = makeState();
				const lastPath = join(state, "last.json");
				const lockPath = `${lastPath}.lock`;
				const last = '{"sessionId":"previous","result":{}}';
				put(lastPath, last, 300 * DAY);
				// Epoch mtime is stale for both the prune clock and the strict-lock clock.
				put(lockPath, holder, NOW);

				const result = pruneSessions({ stateDir: state, olderThanMs: 30 * DAY, dryRun, now });

				expect(result).toEqual({
					dryRun, scanned: 2, kept: 0, keptActive: 0, pruned: [],
					orphans: [{ name: "last.json.lock", bytes: holder.length }], bytes: holder.length, errors: [],
				});
				expect(existsSync(lockPath)).toBe(dryRun);
				if (dryRun) expect(readFileSync(lockPath, "utf8")).toBe(holder);
				expect(readFileSync(lastPath, "utf8")).toBe(last);
			});
		}

		test(`a session writer cannot replace last while an aged holder survives ${dryRun ? "dry" : "actual"} prune`, () => {
			const state = makeState();
			const previous = {
				sessionId: "previous", at: 1,
				result: { xml: "<X/>", original: "previous plan", root: "X", source: "llm" as const },
			};
			const next = { ...previous, sessionId: "next", at: 2 };
			expect(writeSession(state, previous)).toBeUndefined();
			const lastPath = join(state, "last.json");
			const before = readFileSync(lastPath, "utf8");

			expect(withLastLock(lastPath, () => {
				const seconds = (NOW - 3 * HOUR) / 1000;
				utimesSync(`${lastPath}.lock`, seconds, seconds);
				const result = pruneSessions({ stateDir: state, olderThanMs: 30 * DAY, dryRun, now });
				expect(result.orphans).toEqual([]);
				expect(result.bytes).toBe(0);
				expect(writeSession(state, next)).toBeDefined();
				expect(readSession(state, "next")).toEqual(next);
				expect(readLast(state)).toEqual(previous);
				expect(readFileSync(lastPath, "utf8")).toBe(before);
				expect(readFileSync(`${lastPath}.lock`, "utf8")).toBe(String(process.pid));
			})).toBe(true);
			expect(existsSync(`${lastPath}.lock`)).toBe(false);
			expect(readFileSync(lastPath, "utf8")).toBe(before);
		});
	}

	test("generic aged locks keep their existing orphan rules even when their PID is live", () => {
		const state = makeState();
		const holder = String(process.pid);
		put(join(state, "control.json.lock"), holder, 3 * HOUR);
		put(join(state, "sessions", "last.json.lock"), holder, 3 * HOUR);
		const result = pruneSessions({ stateDir: state, olderThanMs: 30 * DAY, now });
		expect(result.orphans.map((orphan) => orphan.name)).toEqual(["control.json.lock", "last.json.lock"]);
		expect(result.bytes).toBe(2 * holder.length);
		expect(existsSync(join(state, "control.json.lock"))).toBe(false);
		expect(sessionFiles(state)).toEqual([]);
	});

	test("never follows or removes a strict-last lock symlink", () => {
		const state = makeState();
		const outside = makeState();
		const target = join(outside, "dead.lock");
		put(target, "2147483647", 3 * HOUR);
		symlinkSync(target, join(state, "last.json.lock"));
		const result = pruneSessions({ stateDir: state, olderThanMs: 30 * DAY, now });
		expect(result.orphans).toEqual([]);
		expect(result.bytes).toBe(0);
		expect(result.errors).toEqual([]);
		expect(existsSync(join(state, "last.json.lock"))).toBe(true);
		expect(readFileSync(target, "utf8")).toBe("2147483647");
	});

	test("a missing state directory gives an empty result without an error", () => {
		const state = join(makeState(), "nope");
		const result = pruneSessions({ stateDir: state, olderThanMs: DAY, now });
		expect(result).toEqual({ dryRun: false, scanned: 0, kept: 0, keptActive: 0, pruned: [], orphans: [], bytes: 0, errors: [] });
	});

	test("an unreadable sessions directory gives an empty result and an error line, not a throw", () => {
		const state = makeState();
		writeFileSync(join(state, "sessions"), "not a directory");
		const messages: string[] = [];
		const result = pruneSessions({ stateDir: state, olderThanMs: DAY, now, log: (message) => messages.push(message) });
		expect(result.pruned).toEqual([]);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0]?.startsWith("sessions: ")).toBe(true);
		expect(messages).toEqual([`prune: ${result.errors[0]}`]);
	});

	test("one failing removal is reported by file name and code and the rest still goes", () => {
		const state = makeState();
		seed(state, "a-oldest", 90);
		seed(state, "b-older", 60);
		seed(state, "c-old", 40);
		const remove = (path: string): void => {
			if (path.endsWith("a-oldest.json")) throw Object.assign(new Error("EACCES: permission denied, unlink with PROMPT-TEXT"), { code: "EACCES" });
			unlinkSync(path);
		};
		const result = pruneSessions({ stateDir: state, olderThanMs: 30 * DAY, now, remove });
		expect(result.errors).toEqual(["a-oldest.json: EACCES"]);
		expect(result.pruned.map((session) => session.id)).toEqual(["a-oldest", "b-older", "c-old"]);
		expect(sessionFiles(state)).toEqual(["a-oldest.json"]);
	});

	test("a session none of whose files could be removed counts as kept, not pruned", () => {
		const state = makeState();
		seed(state, "stuck", 90);
		const remove = (): void => {
			throw Object.assign(new Error("read-only"), { code: "EROFS" });
		};
		const result = pruneSessions({ stateDir: state, olderThanMs: 30 * DAY, now, remove });
		expect(result.errors).toEqual(["stuck.json: EROFS", "stuck.xml: EROFS"]);
		expect(result.pruned).toEqual([]);
		expect(result.kept).toBe(1);
		expect(result.bytes).toBe(0);
	});

	test("limit caps the entries examined", () => {
		const state = makeState();
		for (let index = 0; index < 5; index++) seed(state, `s${index}`, 90, { xml: false });
		const result = pruneSessions({ stateDir: state, olderThanMs: 30 * DAY, now, limit: 3 });
		expect(result.scanned).toBe(3);
		expect(result.pruned.length + result.kept).toBeLessThan(5);
		expect(sessionFiles(state).length).toBeGreaterThan(2);
	});

	test("an entry limit never splits a session pair: a fresh sibling keeps its old record", () => {
		const state = makeState();
		seed(state, "a-single", 90, { xml: false });
		seed(state, "m-pair", 90);
		put(join(state, "sessions", "m-pair.xml"), "<spec/>", DAY);
		seed(state, "z-pair", 90);
		const first = pruneSessions({ stateDir: state, olderThanMs: 30 * DAY, now, limit: 3 });
		expect(first.pruned.map((session) => session.id)).toEqual(["a-single"]);
		expect(sessionFiles(state)).toEqual(["m-pair.json", "m-pair.xml", "z-pair.json", "z-pair.xml"]);
		const second = pruneSessions({ stateDir: state, olderThanMs: 30 * DAY, now, limit: 3 });
		expect(second.pruned).toEqual([]);
		expect(sessionFiles(state)).toEqual(["m-pair.json", "m-pair.xml", "z-pair.json", "z-pair.xml"]);
	});

	test("a session resumed while an earlier session is deleted is kept", () => {
		const state = makeState();
		seed(state, "aaa-first", 90);
		seed(state, "mmm-third", 80);
		seed(state, "zzz-second", 60);
		const remove = (path: string): void => {
			unlinkSync(path);
			if (path.endsWith("aaa-first.json")) {
				// another process resumes two sessions between their age checks and their deletions
				const seconds = NOW / 1000;
				utimesSync(join(state, "sessions", "zzz-second.json"), seconds, seconds);
				utimesSync(join(state, "sessions", "zzz-second.xml"), seconds, seconds);
				writeFileSync(join(state, "last.json"), JSON.stringify({ sessionId: "mmm-third", result: {} }));
			}
		};
		const result = pruneSessions({ stateDir: state, olderThanMs: 30 * DAY, now, remove });
		expect(result.pruned.map((session) => session.id)).toEqual(["aaa-first"]);
		expect(result.kept).toBe(2);
		expect(sessionFiles(state)).toEqual(["mmm-third.json", "mmm-third.xml", "zzz-second.json", "zzz-second.xml"]);
	});

	test("the locked re-check sees a sibling added after the first listing", () => {
		const state = makeState();
		seed(state, "aaa-first", 100);
		seed(state, "mmm-later", 90, { xml: false });
		const remove = (path: string): void => {
			unlinkSync(path);
			if (path.endsWith("aaa-first.json")) {
				// another process writes the spec between the first listing and the locked re-check
				put(join(state, "sessions", "mmm-later.xml"), "<spec/>", 0);
			}
		};
		const result = pruneSessions({ stateDir: state, olderThanMs: 30 * DAY, now, remove });
		expect(result.pruned.map((session) => session.id)).toEqual(["aaa-first"]);
		expect(result.kept).toBe(1);
		expect(sessionFiles(state)).toEqual(["mmm-later.json", "mmm-later.xml"]);
	});

	test("a session still missing its sibling at the locked re-check is pruned", () => {
		const state = makeState();
		seed(state, "solo", 90, { xml: false });
		const result = pruneSessions({ stateDir: state, olderThanMs: 30 * DAY, now });
		expect(result.pruned.map((session) => session.id)).toEqual(["solo"]);
		expect(result.kept).toBe(0);
		expect(sessionFiles(state)).toEqual([]);
	});

	test("bounded runs resume past the previous cursor so every session is eventually reached", () => {
		const state = makeState();
		seed(state, "keep-a", 1);
		seed(state, "keep-b", 1);
		seed(state, "old-c", 90);
		seed(state, "old-d", 80);
		const first = pruneSessions({ stateDir: state, olderThanMs: 30 * DAY, now, limit: 5 });
		expect(first.pruned).toEqual([]);
		expect(first.kept).toBe(2);
		const second = pruneSessions({ stateDir: state, olderThanMs: 30 * DAY, now, limit: 5 });
		expect(second.pruned.map((session) => session.id)).toEqual(["old-c"]);
		expect(sessionFiles(state)).toEqual(["keep-a.json", "keep-a.xml", "keep-b.json", "keep-b.xml", "old-d.json", "old-d.xml"]);
	});

	test("refuses a cutoff that is not above zero instead of removing everything", () => {
		const state = makeState();
		seed(state, "fresh", 0);
		for (const olderThanMs of [0, -1, Number.NaN]) {
			const result = pruneSessions({ stateDir: state, olderThanMs, now });
			expect(result.pruned).toEqual([]);
			expect(result.errors).toHaveLength(1);
		}
		expect(sessionFiles(state)).toEqual(["fresh.json", "fresh.xml"]);
	});

	test("never touches Teachable Moments lessons or other state files", () => {
		const state = makeState();
		put(join(state, "teach", "lessons.json"), "[]", 900 * DAY);
		put(join(state, "control.json"), "{}", 900 * DAY);
		put(join(state, "claims", "abc"), "", 900 * DAY);
		seed(state, "old", 90);
		pruneSessions({ stateDir: state, olderThanMs: 30 * DAY, now });
		expect(existsSync(join(state, "teach", "lessons.json"))).toBe(true);
		expect(existsSync(join(state, "control.json"))).toBe(true);
		expect(existsSync(join(state, "claims", "abc"))).toBe(true);
	});
});

describe("pruneSessionsBestEffort", () => {
	test("does nothing, not even a marker, unless retentionDays is above 0", () => {
		const state = makeState();
		seed(state, "old", 400);
		for (const retentionDays of [0, -3, Number.NaN]) {
			expect(pruneSessionsBestEffort({ stateDir: state, retentionDays, now })).toBeUndefined();
		}
		expect(existsSync(join(state, ".last-prune"))).toBe(false);
		expect(sessionFiles(state)).toEqual(["old.json", "old.xml"]);
	});

	test("prunes by retentionDays and writes the marker", () => {
		const state = makeState();
		seed(state, "old", 40);
		seed(state, "new", 3);
		const result = pruneSessionsBestEffort({ stateDir: state, retentionDays: 30, now });
		expect(result?.pruned.map((session) => session.id)).toEqual(["old"]);
		expect(sessionFiles(state)).toEqual(["new.json", "new.xml"]);
		expect(existsSync(join(state, ".last-prune"))).toBe(true);
	});

	test("runs at most once in 24 hours and again after that", () => {
		const state = makeState();
		seed(state, "old", 40);
		expect(pruneSessionsBestEffort({ stateDir: state, retentionDays: 30, now })).toBeDefined();
		seed(state, "old-again", 40);
		expect(pruneSessionsBestEffort({ stateDir: state, retentionDays: 30, now: () => NOW + 23 * HOUR })).toBeUndefined();
		expect(sessionFiles(state)).toEqual(["old-again.json", "old-again.xml"]);
		const later = pruneSessionsBestEffort({ stateDir: state, retentionDays: 30, now: () => NOW + 25 * HOUR });
		expect(later?.pruned.map((session) => session.id)).toEqual(["old-again"]);
		expect(sessionFiles(state)).toEqual([]);
	});

	test("a marker claimed by a sibling process is honored: no second prune", () => {
		const state = makeState();
		seed(state, "old", 40);
		put(join(state, ".last-prune"), "", HOUR);
		expect(pruneSessionsBestEffort({ stateDir: state, retentionDays: 30, now })).toBeUndefined();
		expect(sessionFiles(state)).toEqual(["old.json", "old.xml"]);
	});

	test("an old marker on disk lets it run", () => {
		const state = makeState();
		seed(state, "old", 40);
		put(join(state, ".last-prune"), "", 25 * HOUR);
		expect(pruneSessionsBestEffort({ stateDir: state, retentionDays: 30, now })).toBeDefined();
		expect(statSync(join(state, ".last-prune")).mtimeMs).toBe(NOW);
	});

	test("touches the marker before pruning, so a failing prune is not retried on every prompt", () => {
		const state = makeState();
		writeFileSync(join(state, "sessions"), "not a directory");
		const first = pruneSessionsBestEffort({ stateDir: state, retentionDays: 30, now });
		expect(first?.errors).toHaveLength(1);
		expect(pruneSessionsBestEffort({ stateDir: state, retentionDays: 30, now: () => NOW + HOUR })).toBeUndefined();
	});

	test("never throws on a state directory that does not exist, and does not create it", () => {
		const state = join(makeState(), "missing");
		const messages: string[] = [];
		expect(pruneSessionsBestEffort({ stateDir: state, retentionDays: 30, now, log: (message) => messages.push(message) })).toBeUndefined();
		expect(existsSync(state)).toBe(false);
		expect(messages).toHaveLength(1);
	});

	test("examines at most 500 entries per run", () => {
		const state = makeState();
		for (let index = 0; index < 520; index++) seed(state, `s${String(index).padStart(3, "0")}`, 90, { xml: false });
		const result = pruneSessionsBestEffort({ stateDir: state, retentionDays: 30, now });
		expect(result?.scanned).toBe(500);
		expect(sessionFiles(state).length).toBeGreaterThan(20);
	});
});
