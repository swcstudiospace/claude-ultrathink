// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/** Read-modify-write of the `ship` section inside a session state file. Never throws. */
import { readFileSync, renameSync, writeFileSync } from "node:fs";
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

/** Atomically replaces the state file's record (tmp + rename); false when the write fails. */
function writeRecord(statePath: string, record: Record<string, unknown>, now: number): boolean {
	try {
		const tmp = `${statePath}.${process.pid}.${now}.tmp`;
		writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`);
		renameSync(tmp, statePath);
		return true;
	} catch {
		return false;
	}
}

export function writeShip(statePath: string, patch: Partial<ShipState>, now: number = Date.now()): ShipState | undefined {
	const record = readRecord(statePath);
	if (!record) return undefined;
	const prior = (record.ship && typeof record.ship === "object" ? record.ship : {}) as Partial<ShipState>;
	const ship: ShipState = { phase: "not-done", rounds: [], ...prior, ...patch, updatedAt: now };
	return writeRecord(statePath, { ...record, ship }, now) ? ship : undefined;
}

/**
 * Starts a fresh ship in the same session: the current ship (without its own history) moves to the end of
 * `history`, keeping the newest MAX_SHIP_HISTORY. Replaces `ship` rather than merging into it. Never throws.
 */
export function archiveShip(statePath: string, now: number = Date.now()): ShipState | undefined {
	const record = readRecord(statePath);
	if (!record) return undefined;
	const prior = (record.ship && typeof record.ship === "object" ? record.ship : {}) as ShipState;
	const { history, ...finished } = prior;
	const ship: ShipState = {
		phase: "not-done",
		rounds: [],
		history: [...(Array.isArray(history) ? history : []), finished].slice(-MAX_SHIP_HISTORY),
		updatedAt: now,
	};
	return writeRecord(statePath, { ...record, ship }, now) ? ship : undefined;
}

/** Longest attempt detail kept in the log. */
const MAX_DETAIL = 200;

/** Appends attempts to the ship state's log, keeping the newest MAX_ATTEMPTS. Never throws. */
export function appendAttempts(statePath: string, attempts: ShipAttempt[], now: number = Date.now()): ShipState | undefined {
	const prior = readShip(statePath)?.attempts;
	// Details are one line of at most MAX_DETAIL characters.
	const added = attempts.map((attempt) =>
		attempt.detail === undefined ? attempt : { ...attempt, detail: attempt.detail.replace(/\s+/g, " ").trim().slice(0, MAX_DETAIL) },
	);
	const log = [...(Array.isArray(prior) ? prior : []), ...added].slice(-MAX_ATTEMPTS);
	return writeShip(statePath, { attempts: log }, now);
}
