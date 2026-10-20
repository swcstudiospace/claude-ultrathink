// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSweeper, type SweepResult, sweepStateDir } from "./retention.ts";

const dirs: string[] = [];
const tmp = (): string => {
	const dir = mkdtempSync(join(tmpdir(), "ut-retention-"));
	dirs.push(dir);
	return dir;
};
afterAll(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const DAY = 86_400_000;
const NOW = 1_800_000_000_000;
const OLD = NOW - 10 * DAY;
const FRESH = NOW - 1 * DAY;
const RETENTION = { retentionDays: 7, now: () => NOW };

function touch(path: string, ms: number): void {
	utimesSync(path, ms / 1000, ms / 1000);
}

/** `jobs/<id>.json` as the headless planner persists it; `updatedAt` and the file mtime agree unless `mtime` says otherwise. */
function writeJob(stateDir: string, id: string, status: string, updatedAt: number, mtime = updatedAt): void {
	mkdirSync(join(stateDir, "jobs"), { recursive: true });
	const path = join(stateDir, "jobs", `${id}.json`);
	writeFileSync(path, `${JSON.stringify({ sessionId: id, runId: randomUUID(), status, createdAt: updatedAt - 1000, updatedAt, usage: { calls: 1, inputTokens: 1, outputTokens: 1 }, promptSha256: "0".repeat(64) })}\n`);
	touch(path, mtime);
}

function writeRawJob(stateDir: string, name: string, body: string, mtime: number): void {
	mkdirSync(join(stateDir, "jobs"), { recursive: true });
	const path = join(stateDir, "jobs", name);
	writeFileSync(path, body);
	touch(path, mtime);
}

function writeRecord(stateDir: string, id: string, mtime: number): void {
	mkdirSync(join(stateDir, "sessions"), { recursive: true });
	const path = join(stateDir, "sessions", `${id}.json`);
	writeFileSync(path, `${JSON.stringify({ sessionId: id, result: { original: "goal" } })}\n`);
	touch(path, mtime);
}

/** `journal/<id>/` with an optional `meta.json`; the directory's mtime is pinned last so the write of meta does not bump it. */
function writeJournal(stateDir: string, id: string, mtime: number, meta?: string | object): string {
	const dir = join(stateDir, "journal", id);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "answers.json"), "[]\n");
	touch(join(dir, "answers.json"), mtime);
	if (meta !== undefined) {
		const path = join(dir, "meta.json");
		writeFileSync(path, typeof meta === "string" ? meta : `${JSON.stringify({ sessionId: id, original: "goal", cwd: "/work", updatedAt: mtime, ...meta })}\n`);
		touch(path, mtime);
	}
	touch(dir, mtime);
	return dir;
}

const names = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).sort() : []);

describe("sweepStateDir", () => {
	test("removes exactly the stale finished entries and keeps running work, symlinks and foreign names", () => {
		const stateDir = tmp();
		const outside = tmp();
		writeFileSync(join(outside, "victim.json"), "{}\n");
		touch(join(outside, "victim.json"), OLD);
		mkdirSync(join(outside, "victim-dir"));
		writeFileSync(join(outside, "victim-dir", "meta.json"), JSON.stringify({ status: "planned" }));
		touch(join(outside, "victim-dir"), OLD);

		const oldPlanned = randomUUID();
		const oldFailed = randomUUID();
		const oldRunning = randomUUID();
		const freshPlanned = randomUUID();
		const unparsable = randomUUID();
		const mtimeOnly = randomUUID();
		writeJob(stateDir, oldPlanned, "planned", OLD);
		writeJob(stateDir, oldFailed, "failed", OLD);
		writeJob(stateDir, oldRunning, "running", OLD);
		writeJob(stateDir, freshPlanned, "planned", FRESH);
		writeRawJob(stateDir, `${unparsable}.json`, "{not json", OLD);
		writeRawJob(stateDir, `${mtimeOnly}.json`, JSON.stringify({ status: "skipped", updatedAt: "yesterday" }), OLD);
		writeRawJob(stateDir, "notes.json", JSON.stringify({ status: "planned", updatedAt: OLD }), OLD);
		// updatedAt wins over mtime in both directions: a stale file with a fresh record stays, a fresh file with a stale record goes.
		const freshRecordStaleFile = randomUUID();
		const staleRecordFreshFile = randomUUID();
		writeJob(stateDir, freshRecordStaleFile, "planned", FRESH, OLD);
		writeJob(stateDir, staleRecordFreshFile, "invalid", OLD, FRESH);
		symlinkSync(join(outside, "victim.json"), join(stateDir, "jobs", `${randomUUID()}.json`));

		const oldRecord = randomUUID();
		const freshRecord = randomUUID();
		writeRecord(stateDir, oldRecord, OLD);
		writeRecord(stateDir, freshRecord, FRESH);
		writeFileSync(join(stateDir, "sessions", "README.md"), "keep\n");
		touch(join(stateDir, "sessions", "README.md"), OLD);
		symlinkSync(join(outside, "victim.json"), join(stateDir, "sessions", `${randomUUID()}.json`));

		const oldFinished = randomUUID();
		const oldInProgress = randomUUID();
		const oldNoMeta = randomUUID();
		const freshFinished = randomUUID();
		const brokenMeta = randomUUID();
		const oldInvalid = randomUUID();
		writeJournal(stateDir, oldFinished, OLD, { status: "planned" });
		writeJournal(stateDir, oldInProgress, OLD, { status: "answering" });
		writeJournal(stateDir, oldNoMeta, OLD);
		writeJournal(stateDir, freshFinished, FRESH, { status: "planned" });
		writeJournal(stateDir, brokenMeta, OLD, "[1, 2");
		writeJournal(stateDir, oldInvalid, OLD, { status: "invalid" });
		mkdirSync(join(stateDir, "journal", "not-a-session"));
		touch(join(stateDir, "journal", "not-a-session"), OLD);
		symlinkSync(join(outside, "victim-dir"), join(stateDir, "journal", randomUUID()));

		const result = sweepStateDir({ stateDir, ...RETENTION });

		// kept: running, fresh, fresh-record jobs; in-progress and fresh journals; fresh record.
		// skipped: unparsable, notes.json and symlink jobs; broken meta, not-a-session and symlink journals; README and symlink records.
		expect(result).toEqual({ removed: { jobs: 4, sessions: 1, journals: 3 }, kept: 6, skipped: 8, errors: 0, disabled: false });
		expect(names(join(stateDir, "jobs"))).toHaveLength(6);
		expect(existsSync(join(stateDir, "jobs", `${oldRunning}.json`))).toBe(true);
		expect(existsSync(join(stateDir, "jobs", `${freshPlanned}.json`))).toBe(true);
		expect(existsSync(join(stateDir, "jobs", `${unparsable}.json`))).toBe(true);
		expect(existsSync(join(stateDir, "jobs", `${freshRecordStaleFile}.json`))).toBe(true);
		expect(existsSync(join(stateDir, "jobs", "notes.json"))).toBe(true);
		for (const gone of [oldPlanned, oldFailed, mtimeOnly, staleRecordFreshFile]) expect(existsSync(join(stateDir, "jobs", `${gone}.json`))).toBe(false);

		expect(names(join(stateDir, "sessions"))).toHaveLength(3);
		expect(existsSync(join(stateDir, "sessions", `${oldRecord}.json`))).toBe(false);
		expect(existsSync(join(stateDir, "sessions", `${freshRecord}.json`))).toBe(true);
		expect(existsSync(join(stateDir, "sessions", "README.md"))).toBe(true);

		expect(names(join(stateDir, "journal"))).toHaveLength(5);
		for (const gone of [oldFinished, oldNoMeta, oldInvalid]) expect(existsSync(join(stateDir, "journal", gone))).toBe(false);
		for (const kept of [oldInProgress, freshFinished, brokenMeta, "not-a-session"]) expect(existsSync(join(stateDir, "journal", kept))).toBe(true);

		// Symlink targets outside the state directory are untouched, and the links themselves are still there.
		expect(existsSync(join(outside, "victim.json"))).toBe(true);
		expect(existsSync(join(outside, "victim-dir", "meta.json"))).toBe(true);
	});

	test("a journal with a fresh meta inside a stale directory is kept", () => {
		const stateDir = tmp();
		const id = randomUUID();
		const dir = writeJournal(stateDir, id, FRESH, { status: "planned" });
		touch(dir, OLD);
		const result = sweepStateDir({ stateDir, ...RETENTION });
		expect(result.removed.journals).toBe(0);
		expect(result.kept).toBe(1);
		expect(existsSync(join(stateDir, "journal", id))).toBe(true);
	});

	test("an entry exactly at the cutoff is kept; one millisecond older goes", () => {
		const stateDir = tmp();
		const atCutoff = randomUUID();
		const justOlder = randomUUID();
		const cutoff = NOW - 7 * DAY;
		writeRecord(stateDir, atCutoff, cutoff);
		writeRecord(stateDir, justOlder, cutoff - 1000);
		const result = sweepStateDir({ stateDir, ...RETENTION });
		expect(result.removed.sessions).toBe(1);
		expect(existsSync(join(stateDir, "sessions", `${atCutoff}.json`))).toBe(true);
		expect(existsSync(join(stateDir, "sessions", `${justOlder}.json`))).toBe(false);
	});

	test("retentionDays 0 is disabled and touches nothing", () => {
		const stateDir = tmp();
		const id = randomUUID();
		writeJob(stateDir, id, "planned", OLD);
		writeRecord(stateDir, id, OLD);
		writeJournal(stateDir, id, OLD, { status: "planned" });
		expect(sweepStateDir({ stateDir, retentionDays: 0, now: () => NOW })).toEqual({ removed: { jobs: 0, sessions: 0, journals: 0 }, kept: 0, skipped: 0, errors: 0, disabled: true });
		expect(existsSync(join(stateDir, "jobs", `${id}.json`))).toBe(true);
		expect(existsSync(join(stateDir, "sessions", `${id}.json`))).toBe(true);
		expect(existsSync(join(stateDir, "journal", id, "meta.json"))).toBe(true);
	});

	test("a missing state directory or sub-directory is an empty sweep, not an error", () => {
		expect(sweepStateDir({ stateDir: join(tmp(), "never-created"), ...RETENTION })).toEqual({ removed: { jobs: 0, sessions: 0, journals: 0 }, kept: 0, skipped: 0, errors: 0, disabled: false });
		const stateDir = tmp();
		writeRecord(stateDir, randomUUID(), OLD);
		expect(sweepStateDir({ stateDir, ...RETENTION }).removed).toEqual({ jobs: 0, sessions: 1, journals: 0 });
	});

	test("a sub-directory that is a symlink is skipped whole", () => {
		const stateDir = tmp();
		const outside = tmp();
		writeRecord(outside, randomUUID(), OLD);
		symlinkSync(join(outside, "sessions"), join(stateDir, "sessions"));
		const result = sweepStateDir({ stateDir, ...RETENTION });
		expect(result).toEqual({ removed: { jobs: 0, sessions: 0, journals: 0 }, kept: 0, skipped: 1, errors: 0, disabled: false });
		expect(names(join(outside, "sessions"))).toHaveLength(1);
	});

	test("maxEntries caps each directory scan; the rest waits for a later sweep", () => {
		const stateDir = tmp();
		for (let i = 0; i < 5; i += 1) writeRecord(stateDir, randomUUID(), OLD);
		const first = sweepStateDir({ stateDir, ...RETENTION, maxEntries: 2 });
		expect(first.removed.sessions).toBe(2);
		expect(names(join(stateDir, "sessions"))).toHaveLength(3);
		const second = sweepStateDir({ stateDir, ...RETENTION, maxEntries: 10 });
		expect(second.removed.sessions).toBe(3);
	});

	test("uses Date.now when no clock is injected", () => {
		const stateDir = tmp();
		const stale = randomUUID();
		const live = randomUUID();
		writeRecord(stateDir, stale, Date.now() - 30 * DAY);
		writeRecord(stateDir, live, Date.now());
		expect(sweepStateDir({ stateDir, retentionDays: 7 }).removed.sessions).toBe(1);
		expect(existsSync(join(stateDir, "sessions", `${live}.json`))).toBe(true);
	});

	test("invalid options are rejected before anything is read", () => {
		const stateDir = tmp();
		writeRecord(stateDir, randomUUID(), OLD);
		expect(() => sweepStateDir({ stateDir: "", ...RETENTION })).toThrow(TypeError);
		expect(() => sweepStateDir({ stateDir, retentionDays: -1 })).toThrow(RangeError);
		expect(() => sweepStateDir({ stateDir, retentionDays: Number.NaN })).toThrow(RangeError);
		expect(() => sweepStateDir({ stateDir, retentionDays: Number.POSITIVE_INFINITY })).toThrow(RangeError);
		expect(() => sweepStateDir({ stateDir, ...RETENTION, maxEntries: 0 })).toThrow(RangeError);
		expect(() => sweepStateDir({ stateDir, ...RETENTION, maxEntries: 1.5 })).toThrow(RangeError);
		expect(names(join(stateDir, "sessions"))).toHaveLength(1);
	});
});

interface FakeTimer {
	run: () => void;
	intervalMs: number;
	cleared: boolean;
}

function harness(sweep: () => SweepResult) {
	const timers: FakeTimer[] = [];
	const results: SweepResult[] = [];
	const errors: Error[] = [];
	const sweeper = createSweeper({
		sweep,
		intervalMs: 60_000,
		onResult: (result) => results.push(result),
		onError: (error) => errors.push(error),
		setTimer: (run, intervalMs) => {
			const timer: FakeTimer = { run, intervalMs, cleared: false };
			timers.push(timer);
			return timer;
		},
		clearTimer: (handle) => {
			(handle as FakeTimer).cleared = true;
		},
	});
	return { sweeper, timers, results, errors };
}

const EMPTY: SweepResult = { removed: { jobs: 0, sessions: 0, journals: 0 }, kept: 0, skipped: 0, errors: 0, disabled: false };

describe("createSweeper", () => {
	test("does not run at construction; the first run is one interval after start", () => {
		let calls = 0;
		const h = harness(() => {
			calls += 1;
			return EMPTY;
		});
		expect(calls).toBe(0);
		expect(h.timers).toHaveLength(0);
		const stop = h.sweeper.start();
		expect(calls).toBe(0);
		expect(h.timers).toHaveLength(1);
		expect(h.timers[0]?.intervalMs).toBe(60_000);
		h.timers[0]?.run();
		h.timers[0]?.run();
		expect(calls).toBe(2);
		expect(h.results).toHaveLength(2);
		stop();
	});

	test("stop is idempotent and start while running reuses the timer", () => {
		const h = harness(() => EMPTY);
		const stop = h.sweeper.start();
		expect(h.sweeper.start()).toBe(stop);
		expect(h.timers).toHaveLength(1);
		stop();
		stop();
		expect(h.timers[0]?.cleared).toBe(true);
		expect(h.timers).toHaveLength(1);
		// After a stop, start schedules afresh.
		const again = h.sweeper.start();
		expect(again).not.toBe(stop);
		expect(h.timers).toHaveLength(2);
		again();
		expect(h.timers[1]?.cleared).toBe(true);
	});

	test("runNow returns the result and reports it; a throwing sweep is routed to onError", () => {
		let fail = false;
		const h = harness(() => {
			if (fail) throw new Error("disk on fire");
			return { ...EMPTY, kept: 3 };
		});
		expect(h.sweeper.runNow()).toEqual({ ...EMPTY, kept: 3 });
		expect(h.results).toHaveLength(1);
		fail = true;
		expect(h.sweeper.runNow()).toBeUndefined();
		expect(h.errors.map((error) => error.message)).toEqual(["disk on fire"]);
		fail = false;
		h.sweeper.start();
		h.timers[0]?.run();
		expect(h.results).toHaveLength(2);
	});

	test("a throwing timer tick does not escape and the next tick runs again", () => {
		let calls = 0;
		const h = harness(() => {
			calls += 1;
			if (calls === 1) throw "not even an Error";
			return EMPTY;
		});
		h.sweeper.start();
		expect(() => h.timers[0]?.run()).not.toThrow();
		expect(h.errors[0]?.message).toBe("not even an Error");
		h.timers[0]?.run();
		expect(h.results).toHaveLength(1);
	});

	test("a throwing onResult reaches onError; a throwing onError is swallowed", () => {
		const errors: Error[] = [];
		const sweeper = createSweeper({
			sweep: () => EMPTY,
			intervalMs: 1,
			onResult: () => {
				throw new Error("hook broke");
			},
			onError: (error) => {
				errors.push(error);
				throw new Error("hook broke harder");
			},
			setTimer: () => ({}),
			clearTimer: () => {},
		});
		expect(sweeper.runNow()).toBeUndefined();
		expect(errors.map((error) => error.message)).toEqual(["hook broke"]);
	});

	test("runNow from inside a run is a no-op", () => {
		let inner: SweepResult | undefined = EMPTY;
		const h = harness(() => {
			inner = h.sweeper.runNow();
			return EMPTY;
		});
		expect(h.sweeper.runNow()).toEqual(EMPTY);
		expect(inner).toBeUndefined();
	});

	test("invalid options are rejected at construction", () => {
		expect(() => createSweeper({ sweep: () => EMPTY, intervalMs: 0 })).toThrow(RangeError);
		expect(() => createSweeper({ sweep: () => EMPTY, intervalMs: Number.NaN })).toThrow(RangeError);
		expect(() => createSweeper({ sweep: "nope" as unknown as () => SweepResult, intervalMs: 1000 })).toThrow(TypeError);
	});

	test("the default timer is unref'd so it never keeps the process alive", () => {
		const sweeper = createSweeper({ sweep: () => EMPTY, intervalMs: 3_600_000 });
		const stop = sweeper.start();
		stop();
	});
});
