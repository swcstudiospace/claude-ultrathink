// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Removes old session records (`sessions/<id>.json` plus its `<id>.xml` spec) and the leftovers of crashed writes.
 * The records hold the user's prompt, so the rules are conservative: a session with a live ship, the session the
 * plan carrier or `last.json` points at, and anything that is a symlink are never removed; file contents are never
 * reported (names, sizes and counts only); every failure is recorded and the sweep carries on; nothing here throws.
 * Nothing calls this unless the operator runs `ultrathink prune` or opts in with `state.retentionDays`.
 */
import { lstatSync, readdirSync, readFileSync, statSync, unlinkSync, utimesSync, writeFileSync, type Stats } from "node:fs";
import { basename, join } from "node:path";
import { sessionPath } from "../claude/state.ts";
import { carrierPath } from "../host/carrier.ts";

const DAY_MS = 86_400_000;
const ORPHAN_AGE_MS = 3_600_000;
/** Entries one scheduled run may examine, so a huge state directory never slows a prompt. */
const BEST_EFFORT_LIMIT = 500;
const MARKER_NAME = ".last-prune";

export interface PrunedSession {
	id: string;
	bytes: number;
	ageDays: number;
}

export interface PrunedOrphan {
	name: string;
	bytes: number;
}

export interface PruneResult {
	dryRun: boolean;
	/** Directory entries examined. */
	scanned: number;
	/** Sessions left in place for any reason, `keptActive` included. */
	kept: number;
	/** Sessions left in place only because their ship is still running. */
	keptActive: number;
	pruned: PrunedSession[];
	orphans: PrunedOrphan[];
	/** Bytes removed (or, for a dry run, that would be removed): sessions and orphans. */
	bytes: number;
	/** One `<file name>: <code or message>` per failure; never file content. */
	errors: string[];
}

export interface PruneOptions {
	stateDir: string;
	/** Sessions whose newest file is older than this are removed. Must be above 0. */
	olderThanMs: number;
	dryRun?: boolean;
	/** Caps the directory entries examined. Default: no cap. */
	limit?: number;
	now?: () => number;
	log?: (message: string) => void;
	/** File removal seam; production default is `unlinkSync`. */
	remove?: (path: string) => void;
}

export interface BestEffortOptions {
	stateDir: string;
	retentionDays: number;
	now?: () => number;
	log?: (message: string) => void;
}

interface SessionFile {
	name: string;
	path: string;
	size: number;
	mtimeMs: number;
}

interface SessionGroup {
	files: SessionFile[];
	/** A symlink or directory carries the session's name: leave the whole session alone. */
	unsafe: boolean;
}

interface Sweep {
	now: number;
	dryRun: boolean;
	remove: (path: string) => void;
	budget: number;
	result: PruneResult;
	log?: (message: string) => void;
}

function describeError(error: unknown): string {
	if (error instanceof Error) return (error as NodeJS.ErrnoException).code ?? error.message;
	return String(error);
}

function fail(sweep: Sweep, name: string, error: unknown): void {
	const line = `${name}: ${describeError(error)}`;
	sweep.result.errors.push(line);
	sweep.log?.(`prune: ${line}`);
}

function listEntries(sweep: Sweep, dir: string, label: string): string[] {
	try {
		const names = readdirSync(dir).sort().slice(0, Math.max(0, sweep.budget));
		sweep.budget -= names.length;
		sweep.result.scanned += names.length;
		return names;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") fail(sweep, label, error);
		return [];
	}
}

function statEntry(sweep: Sweep, path: string, name: string): Stats | undefined {
	try {
		return lstatSync(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") fail(sweep, name, error);
		return undefined;
	}
}

/** True when the file is gone (or, for a dry run, would be). */
function removeFile(sweep: Sweep, path: string, name: string): boolean {
	if (sweep.dryRun) return true;
	try {
		sweep.remove(path);
		return true;
	} catch (error) {
		fail(sweep, name, error);
		return false;
	}
}

/** Removes `*.tmp` and `*.lock` regular files older than an hour: leftovers of a crashed atomic write. */
function sweepOrphans(sweep: Sweep, dir: string, names: string[]): void {
	for (const name of names) {
		if (!name.endsWith(".tmp") && !name.endsWith(".lock")) continue;
		const path = join(dir, name);
		const stat = statEntry(sweep, path, name);
		if (!stat?.isFile() || sweep.now - stat.mtimeMs <= ORPHAN_AGE_MS) continue;
		if (!removeFile(sweep, path, name)) continue;
		sweep.result.orphans.push({ name, bytes: stat.size });
		sweep.result.bytes += stat.size;
	}
}

function readRecord(path: string): Record<string, unknown> | undefined {
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
		return raw !== null && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

/** A ship with a PR that has neither merged nor been given up on: its record is still being written. */
function hasActiveShip(record: Record<string, unknown>): boolean {
	const ship = record.ship;
	if (ship === null || typeof ship !== "object") return false;
	const { pr, phase } = ship as { pr?: unknown; phase?: unknown };
	return Boolean(pr) && phase !== "merged" && phase !== "blocked";
}

/** Stems of the sessions `last.json` and the plan carrier point at; those are what the next turn reads. */
function protectedStems(stateDir: string): Set<string> {
	const stems = new Set<string>();
	const addPath = (value: unknown): void => {
		if (typeof value !== "string") return;
		const name = basename(value);
		const stem = name.replace(/\.(json|xml)$/, "");
		if (stem !== name && stem) stems.add(stem);
	};
	for (const path of [join(stateDir, "last.json"), carrierPath(stateDir)]) {
		const record = readRecord(path);
		if (!record) continue;
		if (typeof record.sessionId === "string" && record.sessionId) {
			stems.add(basename(sessionPath(stateDir, record.sessionId), ".json"));
		}
		addPath(record.specPath);
		addPath(record.statePath);
	}
	return stems;
}

function groupSessions(sweep: Sweep, dir: string, names: string[]): Map<string, SessionGroup> {
	const groups = new Map<string, SessionGroup>();
	for (const name of names) {
		const extension = name.endsWith(".json") ? ".json" : name.endsWith(".xml") ? ".xml" : undefined;
		if (!extension) continue;
		const stem = name.slice(0, -extension.length);
		if (!stem) continue;
		const path = join(dir, name);
		const stat = statEntry(sweep, path, name);
		if (!stat) continue;
		let group = groups.get(stem);
		if (!group) {
			group = { files: [], unsafe: false };
			groups.set(stem, group);
		}
		if (stat.isFile()) group.files.push({ name, path, size: stat.size, mtimeMs: stat.mtimeMs });
		else group.unsafe = true;
	}
	return groups;
}

function sweepSessions(sweep: Sweep, stateDir: string, dir: string, names: string[], olderThanMs: number): void {
	const groups = [...groupSessions(sweep, dir, names)]
		.map(([stem, group]) => ({ stem, group, newest: Math.max(0, ...group.files.map((file) => file.mtimeMs)) }))
		.sort((a, b) => a.newest - b.newest);
	const keep = protectedStems(stateDir);
	const { result } = sweep;
	for (const { stem, group, newest } of groups) {
		const age = sweep.now - newest;
		if (group.unsafe || group.files.length === 0 || age <= olderThanMs || keep.has(stem)) {
			result.kept++;
			continue;
		}
		const json = group.files.find((file) => file.name.endsWith(".json"));
		const record = json ? readRecord(json.path) : undefined;
		if (record && hasActiveShip(record)) {
			result.kept++;
			result.keptActive++;
			continue;
		}
		let removed = 0;
		let bytes = 0;
		for (const file of group.files) {
			if (!removeFile(sweep, file.path, file.name)) continue;
			removed++;
			bytes += file.size;
		}
		if (removed === 0) {
			result.kept++;
			continue;
		}
		result.pruned.push({ id: stem, bytes, ageDays: Math.floor(age / DAY_MS) });
		result.bytes += bytes;
	}
}

/**
 * Removes sessions older than `olderThanMs` and stale temporary/lock files. `dryRun` returns the result a real run
 * would, touching nothing. Never throws: failures land in `errors`.
 */
export function pruneSessions(options: PruneOptions): PruneResult {
	const dryRun = options.dryRun === true;
	const result: PruneResult = { dryRun, scanned: 0, kept: 0, keptActive: 0, pruned: [], orphans: [], bytes: 0, errors: [] };
	const sweep: Sweep = {
		now: (options.now ?? Date.now)(),
		dryRun,
		remove: options.remove ?? unlinkSync,
		budget: options.limit ?? Number.POSITIVE_INFINITY,
		result,
		log: options.log,
	};
	try {
		if (!(options.olderThanMs > 0)) {
			fail(sweep, "cutoff", "olderThanMs must be above 0");
			return result;
		}
		const sessionsDir = join(options.stateDir, "sessions");
		sweepOrphans(sweep, options.stateDir, listEntries(sweep, options.stateDir, "state directory"));
		const names = listEntries(sweep, sessionsDir, "sessions");
		sweepOrphans(sweep, sessionsDir, names);
		sweepSessions(sweep, options.stateDir, sessionsDir, names, options.olderThanMs);
	} catch (error) {
		fail(sweep, "prune", error);
	}
	return result;
}

/**
 * The scheduled prune: does nothing unless `retentionDays` is above 0 and the last run was over 24 hours ago. The
 * marker is touched before the work so a failing prune cannot retry on every prompt. Never throws.
 */
export function pruneSessionsBestEffort(options: BestEffortOptions): PruneResult | undefined {
	try {
		if (!Number.isFinite(options.retentionDays) || options.retentionDays <= 0) return undefined;
		const now = (options.now ?? Date.now)();
		const marker = join(options.stateDir, MARKER_NAME);
		try {
			if (now - statSync(marker).mtimeMs < DAY_MS) return undefined;
		} catch {
			// no marker yet: first run
		}
		writeFileSync(marker, "", { mode: 0o600 });
		utimesSync(marker, now / 1000, now / 1000);
		return pruneSessions({
			stateDir: options.stateDir,
			olderThanMs: options.retentionDays * DAY_MS,
			limit: BEST_EFFORT_LIMIT,
			now: () => now,
			log: options.log,
		});
	} catch (error) {
		options.log?.(`prune: ${describeError(error)}`);
		return undefined;
	}
}
