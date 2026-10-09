// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/** Read-modify-write of the `ship` section inside a session state file. One locked cycle per call. Never throws. */
import { readFileSync } from "node:fs";
import { withFileLock, writeFileAtomic } from "../claude/atomic.ts";
import { MAX_ATTEMPTS, MAX_SHIP_HISTORY } from "./types.ts";
import type { ShipAttempt, ShipState } from "./types.ts";

function readRecord(statePath: string): Record<string, unknown> | undefined {
	try {
		const parsed: unknown = JSON.parse(readFileSync(statePath, "utf8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
	} catch {
		return undefined;
	}
}

export function readShip(statePath: string): ShipState | undefined {
	const ship = readRecord(statePath)?.ship;
	return ship && typeof ship === "object" ? (ship as ShipState) : undefined;
}

/** Atomically replaces the state file's record (owner-only); false when the write fails. */
function writeRecord(statePath: string, record: Record<string, unknown>): boolean {
	try {
		writeFileAtomic(statePath, `${JSON.stringify(record, null, 2)}\n`);
		return true;
	} catch {
		return false;
	}
}

function priorShip(record: Record<string, unknown>): Partial<ShipState> {
	return (record.ship && typeof record.ship === "object" ? record.ship : {}) as Partial<ShipState>;
}

/**
 * The single read-modify-write behind every public writer: under the file's lock, reads the record, builds the new
 * ship from it and writes it back. Takes the lock once, so a writer that needs the old ship never has to call another
 * public writer (which would lock a second time and lose updates between the two cycles).
 */
function updateShip(statePath: string, build: (record: Record<string, unknown>) => ShipState): ShipState | undefined {
	return withFileLock(statePath, () => {
		const record = readRecord(statePath);
		if (!record) return undefined;
		const ship = build(record);
		return writeRecord(statePath, { ...record, ship }) ? ship : undefined;
	});
}

export function writeShip(statePath: string, patch: Partial<ShipState>, now: number = Date.now()): ShipState | undefined {
	return updateShip(statePath, (record) => ({ phase: "not-done", rounds: [], ...priorShip(record), ...patch, updatedAt: now }));
}

/**
 * Starts a fresh ship in the same session: the current ship (without its own history) moves to the end of
 * `history`, keeping the newest MAX_SHIP_HISTORY. Replaces `ship` rather than merging into it. Never throws.
 */
export function archiveShip(statePath: string, now: number = Date.now()): ShipState | undefined {
	return updateShip(statePath, (record) => {
		const { history, ...finished } = priorShip(record) as ShipState;
		return {
			phase: "not-done",
			rounds: [],
			history: [...(Array.isArray(history) ? history : []), finished].slice(-MAX_SHIP_HISTORY),
			updatedAt: now,
		};
	});
}

/** Longest attempt detail kept in the log. */
const MAX_DETAIL = 200;

/** Appends attempts to the ship state's log, keeping the newest MAX_ATTEMPTS. Never throws. */
export function appendAttempts(statePath: string, attempts: ShipAttempt[], now: number = Date.now()): ShipState | undefined {
	// Details are one line of at most MAX_DETAIL characters.
	const added = attempts.map((attempt) =>
		attempt.detail === undefined ? attempt : { ...attempt, detail: attempt.detail.replace(/\s+/g, " ").trim().slice(0, MAX_DETAIL) },
	);
	return updateShip(statePath, (record) => {
		const prior = priorShip(record);
		const log = [...(Array.isArray(prior.attempts) ? prior.attempts : []), ...added].slice(-MAX_ATTEMPTS);
		return { phase: "not-done", rounds: [], ...prior, attempts: log, updatedAt: now };
	});
}
