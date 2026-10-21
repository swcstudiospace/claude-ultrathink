// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

/**
 * Naming and retention policy for the point-in-time snapshot ring (Phase 74, D3-D4, D16).
 * Pure: no file or database access. The shell layer lists the ring, asks this module for the
 * next name and the retention plan, and performs the file operations itself.
 */

export interface RetentionWindows {
	/** Every snapshot at most this old is kept. */
	recentMs: number;
	/** Bucket width for the thinned band: the newest snapshot in each bucket survives. */
	thinMs: number;
	/** Snapshots older than this are deleted. The newest non-future snapshot is kept regardless. */
	windowMs: number;
}

export interface RetentionPlan {
	keep: string[];
	delete: string[];
}

/** `ultrathink-<stamp>` with an optional `.sqlite`, `.tar.gz` or `.tar.gz.age` suffix. Stamps are ms or seconds precision. */
const NAME_PATTERN =
	/^ultrathink-(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})?Z(?:\.sqlite|\.tar\.gz(?:\.age)?)?$/;

interface Entry {
	name: string;
	ms: number;
}

function requireFinite(value: number, label: string): void {
	if (!Number.isFinite(value)) throw new RangeError(`${label} must be a finite number, got ${value}`);
}

/** Orders by time, then by name, so every tie resolves the same way. */
function compareEntries(a: Entry, b: Entry): number {
	if (a.ms !== b.ms) return a.ms - b.ms;
	return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

function isNewer(a: Entry, b: Entry): boolean {
	return compareEntries(a, b) > 0;
}

function pad(value: number, width: number): string {
	return String(value).padStart(width, "0");
}

/** Formats epoch milliseconds as `YYYYMMDDTHHMMSSmmmZ` (UTC). Throws RangeError for non-finite or out-of-range input. */
export function formatStamp(ms: number): string {
	requireFinite(ms, "snapshot time");
	const date = new Date(ms);
	const year = date.getUTCFullYear();
	if (Number.isNaN(year) || year < 0 || year > 9999) throw new RangeError(`snapshot time out of range: ${ms}`);
	return (
		pad(year, 4) +
		pad(date.getUTCMonth() + 1, 2) +
		pad(date.getUTCDate(), 2) +
		"T" +
		pad(date.getUTCHours(), 2) +
		pad(date.getUTCMinutes(), 2) +
		pad(date.getUTCSeconds(), 2) +
		pad(date.getUTCMilliseconds(), 3) +
		"Z"
	);
}

/**
 * Epoch milliseconds for a snapshot name, or undefined when the name is not a snapshot name or its
 * stamp is not a real calendar time (month 13, Feb 30, hour 24 and similar). Accepts both precisions.
 */
export function parseStamp(name: string): number | undefined {
	const match = NAME_PATTERN.exec(name);
	if (match === null) return undefined;
	const [, yearText, monthText, dayText, hourText, minuteText, secondText, msText] = match;
	if (
		yearText === undefined ||
		monthText === undefined ||
		dayText === undefined ||
		hourText === undefined ||
		minuteText === undefined ||
		secondText === undefined
	) {
		return undefined;
	}
	const year = Number(yearText);
	const month = Number(monthText);
	const day = Number(dayText);
	const hour = Number(hourText);
	const minute = Number(minuteText);
	const second = Number(secondText);
	const millisecond = msText === undefined ? 0 : Number(msText);

	// Build the date, then require every field to survive unchanged: out-of-range fields roll over.
	const date = new Date(0);
	date.setUTCFullYear(year, month - 1, day);
	date.setUTCHours(hour, minute, second, millisecond);
	if (
		date.getUTCFullYear() !== year ||
		date.getUTCMonth() !== month - 1 ||
		date.getUTCDate() !== day ||
		date.getUTCHours() !== hour ||
		date.getUTCMinutes() !== minute ||
		date.getUTCSeconds() !== second ||
		date.getUTCMilliseconds() !== millisecond
	) {
		return undefined;
	}
	return date.getTime();
}

/**
 * The stamp for a new snapshot: `now`, or one millisecond after the newest parsed name when the
 * clock has stepped backward. The result never repeats or sorts before an existing name.
 */
export function nextStamp(nowMs: number, names: readonly string[]): string {
	let newest: number | undefined;
	for (const name of names) {
		const ms = parseStamp(name);
		if (ms !== undefined && (newest === undefined || ms > newest)) newest = ms;
	}
	return formatStamp(newest === undefined ? nowMs : Math.max(nowMs, newest + 1));
}

/** The newest parsed name at or before `targetMs` (an equal time counts), or undefined when none. */
export function pickAtOrBefore(names: readonly string[], targetMs: number): string | undefined {
	requireFinite(targetMs, "target time");
	let best: Entry | undefined;
	for (const name of names) {
		const ms = parseStamp(name);
		if (ms === undefined || ms > targetMs) continue;
		const candidate: Entry = { name, ms };
		if (best === undefined || isNewer(candidate, best)) best = candidate;
	}
	return best?.name;
}

/**
 * Retention decision for the ring. Unparseable names appear in neither list. Rules, in order:
 * 1. The newest non-future name is always kept.
 * 2. A future-dated name is kept and does not count as newest.
 * 3. Age <= recentMs: kept.
 * 4. recentMs < age <= windowMs: the newest name in each bucket floor(ms / thinMs) is kept, the rest deleted.
 * 5. Age > windowMs: deleted.
 * Both lists are sorted oldest first.
 */
export function retentionPlan(names: readonly string[], nowMs: number, windows: RetentionWindows): RetentionPlan {
	requireFinite(nowMs, "now");
	requireFinite(windows.recentMs, "recentMs");
	requireFinite(windows.windowMs, "windowMs");
	requireFinite(windows.thinMs, "thinMs");
	if (windows.recentMs < 0 || windows.windowMs < 0) throw new RangeError("retention windows must not be negative");
	if (windows.thinMs <= 0) throw new RangeError("thinMs must be positive");

	const seen = new Set<string>();
	const entries: Entry[] = [];
	for (const name of names) {
		const ms = parseStamp(name);
		if (ms === undefined || seen.has(name)) continue;
		seen.add(name);
		entries.push({ name, ms });
	}
	entries.sort(compareEntries);

	let newest: Entry | undefined;
	const winners = new Map<number, Entry>();
	for (const entry of entries) {
		if (entry.ms > nowMs) continue;
		if (newest === undefined || isNewer(entry, newest)) newest = entry;
		const age = nowMs - entry.ms;
		if (age <= windows.recentMs || age > windows.windowMs) continue;
		const bucket = Math.floor(entry.ms / windows.thinMs);
		const current = winners.get(bucket);
		if (current === undefined || isNewer(entry, current)) winners.set(bucket, entry);
	}

	const keep: string[] = [];
	const remove: string[] = [];
	for (const entry of entries) {
		if (entry.ms > nowMs || entry.name === newest?.name) {
			keep.push(entry.name);
			continue;
		}
		const age = nowMs - entry.ms;
		if (age <= windows.recentMs) {
			keep.push(entry.name);
		} else if (age <= windows.windowMs && winners.get(Math.floor(entry.ms / windows.thinMs)) === entry) {
			keep.push(entry.name);
		} else {
			remove.push(entry.name);
		}
	}
	return { keep, delete: remove };
}
