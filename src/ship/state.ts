// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/** Read-modify-write of the `ship` section inside a session state file. Never throws. */
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { MAX_ATTEMPTS } from "./types.ts";
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

export function writeShip(statePath: string, patch: Partial<ShipState>, now: number = Date.now()): ShipState | undefined {
	const record = readRecord(statePath);
	if (!record) return undefined;
	const prior = (record.ship && typeof record.ship === "object" ? record.ship : {}) as Partial<ShipState>;
	const ship: ShipState = { phase: "not-done", rounds: [], ...prior, ...patch, updatedAt: now };
	try {
		const tmp = `${statePath}.${process.pid}.${now}.tmp`;
		writeFileSync(tmp, `${JSON.stringify({ ...record, ship }, null, 2)}\n`);
		renameSync(tmp, statePath);
		return ship;
	} catch {
		return undefined;
	}
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
