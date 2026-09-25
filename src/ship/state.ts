// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/** Read-modify-write of the `ship` section inside a session state file. Never throws. */
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import type { ShipState } from "./types.ts";

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
