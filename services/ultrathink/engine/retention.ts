// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Retention for a connector's state directory. The directory grows by one file or folder per session in three
 * places (`jobs/<id>.json`, `sessions/<id>.json`, `journal/<id>/`) and nothing else ever removes them. A sweep
 * deletes the entries older than the retention window that no running work still needs: a job whose status is
 * `running` and a journal whose `meta.json` reports an in-progress session always survive, whatever their age.
 *
 * The walk mirrors the safety rules of the session listing: every path is `lstat`ed, so a symlink is never
 * followed; only names that are session ids are considered, so a sweep cannot leave the state directory; each
 * directory is read up to a cap; a file that cannot be parsed is left alone. A sweep never throws once its
 * options are valid: every failure is counted in `errors` and the walk continues.
 *
 * This module is pure. It has no logger and no clock of its own; `now` and the sweeper's timers are injected.
 */
import { type Dir, lstatSync, opendirSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { isSessionId } from "./journal.ts";

export interface SweepOptions {
	/** Root the connector writes under; its `jobs`, `sessions` and `journal` children are swept. */
	stateDir: string;
	/** Entries untouched for longer than this many days are removed. `0` disables the sweep entirely. */
	retentionDays: number;
	/** Clock in epoch milliseconds; defaults to `Date.now`. */
	now?: () => number;
	/** Directory entries read per directory; a runaway directory is swept in slices of this size. Default 5000. */
	maxEntries?: number;
}

export interface SweepResult {
	/** Entries deleted, per place. A journal counts once however many files it held. */
	removed: { jobs: number; sessions: number; journals: number };
	/** Entries inspected and left in place: newer than the window, or old but still in progress. */
	kept: number;
	/** Entries ignored unread: names that are not session ids, symlinks, wrong file types and unparsable files. */
	skipped: number;
	/** Failures to read or remove something; the sweep carries on past each one. */
	errors: number;
	/** True when `retentionDays` is 0: nothing was read and nothing was removed. */
	disabled: boolean;
}

export interface SweeperOptions {
	/** The sweep to run on each tick, typically `() => sweepStateDir(options)`. */
	sweep: () => SweepResult;
	/** Time between runs. The first run happens one interval after `start()`, never at construction. */
	intervalMs: number;
	/** Receives the result of every completed run. */
	onResult?: (result: SweepResult) => void;
	/** Receives anything `sweep` or `onResult` throws. A throwing `onError` is ignored. */
	onError?: (error: Error) => void;
	/** Timer factory for tests; defaults to an unref'd `setInterval`. */
	setTimer?: (run: () => void, intervalMs: number) => object;
	/** Cancels a handle returned by `setTimer`; defaults to `clearInterval`. */
	clearTimer?: (handle: object) => void;
}

export interface Sweeper {
	/** Schedules periodic runs and returns an idempotent stop. Calling `start()` while running returns that stop. */
	start(): () => void;
	/** Runs one sweep immediately; `undefined` when it threw (routed to `onError`) or a run is already in progress. */
	runNow(): SweepResult | undefined;
}

const DAY_MS = 86_400_000;
/** Same cap as the session listing: a hostile or runaway directory cannot make one sweep unbounded. */
const DEFAULT_MAX_ENTRIES = 5000;
/** Larger job and meta files are not parsed; a record the planner wrote stays far below this. */
const MAX_FILE_BYTES = 1024 * 1024;
const JSON_SUFFIX = ".json";

/** Journal statuses that mean the session is finished; anything else (or absent) is in progress, as in sessions.ts. */
const FINISHED_CLIENT_STATUSES: Record<string, true> = { planned: true, invalid: true, skipped: true };

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

interface Tally {
	removed: { jobs: number; sessions: number; journals: number };
	kept: number;
	skipped: number;
	errors: number;
}

interface Walk {
	tally: Tally;
	cutoff: number;
	maxEntries: number;
}

function realSetTimer(run: () => void, intervalMs: number): object {
	const timer = setInterval(run, intervalMs);
	timer.unref();
	return timer;
}

/** Open directory scans, kept between sweeps: each sweep resumes where the previous one stopped, so no entry is re-read. */
const scans = new Map<string, Dir>();

function closeScan(dir: string): void {
	const handle = scans.get(dir);
	scans.delete(dir);
	try {
		handle?.closeSync();
	} catch {
		// Nothing left to release.
	}
}

/**
 * Up to `max` names of a directory, continuing where the previous sweep stopped. When the directory ends, its scan is
 * closed and the next sweep starts again from the top, so every entry is visited once per cycle. `undefined` when the
 * directory cannot be read.
 */
function listNames(dir: string, max: number): string[] | undefined {
	const names: string[] = [];
	try {
		const handle = scans.get(dir) ?? opendirSync(dir);
		scans.set(dir, handle);
		while (names.length < max) {
			const entry = handle.readSync();
			if (entry === null) {
				closeScan(dir);
				break;
			}
			names.push(entry.name);
		}
		return names;
	} catch {
		closeScan(dir);
		return undefined;
	}
}

type Kind = "file" | "directory" | "other" | "missing";

/** `lstat` of a path: a symlink is reported as "other", never followed. */
function kindOf(path: string): { kind: Kind; mtime: number; size: number } {
	try {
		const stat = lstatSync(path);
		const kind: Kind = stat.isFile() ? "file" : stat.isDirectory() ? "directory" : "other";
		return { kind, mtime: Math.trunc(stat.mtimeMs), size: stat.size };
	} catch {
		return { kind: "missing", mtime: 0, size: 0 };
	}
}

/** Parsed JSON object of a regular file at most MAX_FILE_BYTES long; `undefined` for anything else. */
function readObject(path: string, size: number): Record<string, unknown> | undefined {
	if (size > MAX_FILE_BYTES) return undefined;
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
		return isObject(raw) ? raw : undefined;
	} catch {
		return undefined;
	}
}

/** A real (non-symlink) directory under the state dir, or `undefined` when it is absent or something else. */
function subdir(stateDir: string, name: string, tally: Tally): string | undefined {
	const path = join(stateDir, name);
	const { kind } = kindOf(path);
	if (kind === "directory") return path;
	if (kind !== "missing") tally.skipped += 1;
	return undefined;
}

/** Session id of a `<id>.json` name, or `undefined` for any other name. */
function recordId(name: string): string | undefined {
	if (!name.endsWith(JSON_SUFFIX)) return undefined;
	const id = name.slice(0, -JSON_SUFFIX.length);
	return isSessionId(id) ? id : undefined;
}

function removeFile(path: string, tally: Tally, place: "jobs" | "sessions"): void {
	try {
		unlinkSync(path);
		tally.removed[place] += 1;
	} catch {
		tally.errors += 1;
	}
}

/** Plan records: `sessions/<id>.json`, removed by file modification time alone. */
function sweepSessions(stateDir: string, walk: Walk): void {
	const { tally } = walk;
	const dir = subdir(stateDir, "sessions", tally);
	if (dir === undefined) return;
	const names = listNames(dir, walk.maxEntries);
	if (names === undefined) {
		tally.errors += 1;
		return;
	}
	for (const name of names) {
		if (recordId(name) === undefined) {
			tally.skipped += 1;
			continue;
		}
		const path = join(dir, name);
		const { kind, mtime } = kindOf(path);
		if (kind !== "file") {
			tally.skipped += 1;
			continue;
		}
		if (mtime >= walk.cutoff) {
			tally.kept += 1;
			continue;
		}
		removeFile(path, tally, "sessions");
	}
}

/**
 * Server jobs: `jobs/<id>.json`, aged by the record's own `updatedAt` when it is a finite number, else by file
 * modification time. A job that is still `running` is kept whatever its age; a file that is not a JSON object with a
 * string status is skipped, never removed.
 */
function sweepJobs(stateDir: string, walk: Walk): void {
	const { tally } = walk;
	const dir = subdir(stateDir, "jobs", tally);
	if (dir === undefined) return;
	const names = listNames(dir, walk.maxEntries);
	if (names === undefined) {
		tally.errors += 1;
		return;
	}
	for (const name of names) {
		if (recordId(name) === undefined) {
			tally.skipped += 1;
			continue;
		}
		const path = join(dir, name);
		const { kind, mtime, size } = kindOf(path);
		if (kind !== "file") {
			tally.skipped += 1;
			continue;
		}
		const job = readObject(path, size);
		if (job === undefined || typeof job.status !== "string") {
			tally.skipped += 1;
			continue;
		}
		const time = typeof job.updatedAt === "number" && Number.isFinite(job.updatedAt) ? Math.trunc(job.updatedAt) : mtime;
		if (time >= walk.cutoff || job.status === "running") {
			tally.kept += 1;
			continue;
		}
		removeFile(path, tally, "jobs");
	}
}

/**
 * Client journals: `journal/<id>/`, aged by the newer of the directory's and its `meta.json`'s modification time.
 * A journal whose meta reports an in-progress session (any status but planned/invalid/skipped) is kept; a meta that
 * is a symlink, oversized or not a JSON object skips the journal. A journal with no meta at all is removed by age.
 */
function sweepJournals(stateDir: string, walk: Walk): void {
	const { tally } = walk;
	const root = subdir(stateDir, "journal", tally);
	if (root === undefined) return;
	const names = listNames(root, walk.maxEntries);
	if (names === undefined) {
		tally.errors += 1;
		return;
	}
	for (const name of names) {
		if (!isSessionId(name)) {
			tally.skipped += 1;
			continue;
		}
		const dir = join(root, name);
		const entry = kindOf(dir);
		if (entry.kind !== "directory") {
			tally.skipped += 1;
			continue;
		}
		const metaPath = join(dir, "meta.json");
		const meta = kindOf(metaPath);
		let time = entry.mtime;
		if (meta.kind !== "missing") {
			if (meta.kind !== "file") {
				tally.skipped += 1;
				continue;
			}
			const parsed = readObject(metaPath, meta.size);
			if (parsed === undefined) {
				tally.skipped += 1;
				continue;
			}
			if (typeof parsed.status !== "string" || !Object.hasOwn(FINISHED_CLIENT_STATUSES, parsed.status)) {
				tally.kept += 1;
				continue;
			}
			time = Math.max(time, meta.mtime);
		}
		if (time >= walk.cutoff) {
			tally.kept += 1;
			continue;
		}
		try {
			rmSync(dir, { recursive: true, force: true });
			tally.removed.journals += 1;
		} catch {
			tally.errors += 1;
		}
	}
}

/**
 * Removes the entries of `stateDir` older than `retentionDays` that no running work needs; see the module comment
 * for what is removed and what is protected. Throws only for invalid options (a blank `stateDir`, a negative or
 * non-finite `retentionDays`, a `maxEntries` below 1); validate configuration by calling it once at startup. A
 * missing state directory or sub-directory is not an error: there is nothing to sweep.
 */
export function sweepStateDir(options: SweepOptions): SweepResult {
	if (typeof options.stateDir !== "string" || options.stateDir.trim() === "") throw new TypeError("retention: stateDir must be a non-empty path");
	if (typeof options.retentionDays !== "number" || !Number.isFinite(options.retentionDays) || options.retentionDays < 0) {
		throw new RangeError("retention: retentionDays must be a finite number >= 0 (0 disables the sweep)");
	}
	const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
	if (!Number.isInteger(maxEntries) || maxEntries < 1) throw new RangeError("retention: maxEntries must be an integer >= 1");

	const tally: Tally = { removed: { jobs: 0, sessions: 0, journals: 0 }, kept: 0, skipped: 0, errors: 0 };
	if (options.retentionDays === 0) return { ...tally, disabled: true };

	const now = options.now ?? Date.now;
	const walk: Walk = { tally, cutoff: now() - options.retentionDays * DAY_MS, maxEntries };
	sweepJobs(options.stateDir, walk);
	sweepJournals(options.stateDir, walk);
	sweepSessions(options.stateDir, walk);
	return { ...tally, disabled: false };
}

/**
 * Periodic runner for a sweep. Timers are unref'd by default, so a scheduled sweep never keeps the process alive.
 * Throws only for invalid options (`intervalMs` not a positive finite number, `sweep` not a function). Nothing a
 * run throws escapes: it reaches `onError` and the next tick runs as usual.
 */
export function createSweeper(options: SweeperOptions): Sweeper {
	if (typeof options.sweep !== "function") throw new TypeError("retention: sweep must be a function");
	if (typeof options.intervalMs !== "number" || !Number.isFinite(options.intervalMs) || options.intervalMs <= 0) {
		throw new RangeError("retention: intervalMs must be a positive finite number");
	}
	const setTimer = options.setTimer ?? realSetTimer;
	const clearTimer = options.clearTimer ?? ((handle: object) => clearInterval(handle as NodeJS.Timeout));
	const report = (error: unknown): void => {
		try {
			options.onError?.(error instanceof Error ? error : new Error(String(error)));
		} catch {
			// An error hook that throws has nowhere further to report.
		}
	};

	let running = false;
	let stop: (() => void) | undefined;

	const runNow = (): SweepResult | undefined => {
		if (running) return undefined;
		running = true;
		try {
			const result = options.sweep();
			options.onResult?.(result);
			return result;
		} catch (error) {
			report(error);
			return undefined;
		} finally {
			running = false;
		}
	};

	return {
		start(): () => void {
			if (stop) return stop;
			const handle = setTimer(() => {
				runNow();
			}, options.intervalMs);
			let stopped = false;
			const cancel = (): void => {
				if (stopped) return;
				stopped = true;
				stop = undefined;
				clearTimer(handle);
			};
			stop = cancel;
			return cancel;
		},
		runNow,
	};
}
