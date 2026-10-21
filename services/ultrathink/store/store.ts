// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type RunStatus =
	| "queued"
	| "discovering"
	| "discussing"
	| "planning"
	| "executing"
	| "paused-for-decision"
	| "paused-for-blocker"
	| "complete"
	| "failed";

export interface Run {
	id: string;
	ownerId: string;
	request: string;
	route: string;
	status: RunStatus;
	currentPhase: string | null;
	reason: string | null;
	createdAt: number;
	updatedAt: number;
}

export type PhaseStatus = "complete" | "failed";

export interface PhaseRecord {
	runId: string;
	phase: string;
	attempt: number;
	status: PhaseStatus;
	output: string | null;
	createdAt: number;
}

export class DuplicatePhaseError extends Error {}

export interface Store {
	readonly db: Database;
	ping(): boolean;
	createRun(input: { ownerId: string; request: string; route: string }): Run;
	getRunForOwner(runId: string, ownerId: string): Run | null;
	listRunsForOwner(ownerId: string, limit: number): Run[];
	updateRun(
		runId: string,
		patch: { status?: RunStatus; currentPhase?: string | null; reason?: string | null },
	): void;
	recordPhase(input: {
		runId: string;
		phase: string;
		attempt: number;
		status: PhaseStatus;
		output: string | null;
	}): void;
	getPhase(runId: string, phase: string, attempt: number): PhaseRecord | null;
	listPhases(runId: string): PhaseRecord[];
	/**
	 * `PRAGMA quick_check`: `ok` when the file structure is sound, else the first few problems SQLite reports, clipped
	 * to QUICK_CHECK_DETAIL_CHARS. An exception (closed handle, I/O error) is reported as `ok: false`; never throws.
	 */
	quickCheck(): { ok: true } | { ok: false; detail: string };
	/**
	 * `PRAGMA wal_checkpoint(PASSIVE)`: moves WAL frames into the main file without waiting on readers or writers.
	 * `ok` is false when the checkpoint was blocked (busy) or threw; never throws, and a false result is not corruption.
	 */
	checkpoint(): { ok: boolean };
	/** Runs `PRAGMA optimize` best-effort, then closes the handle. */
	close(): void;
}

const MIGRATIONS = `
CREATE TABLE IF NOT EXISTS runs (
	id TEXT PRIMARY KEY,
	owner_id TEXT NOT NULL,
	request TEXT NOT NULL,
	route TEXT NOT NULL,
	status TEXT NOT NULL,
	current_phase TEXT,
	reason TEXT,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS phases (
	run_id TEXT NOT NULL REFERENCES runs(id),
	phase TEXT NOT NULL,
	attempt INTEGER NOT NULL,
	status TEXT NOT NULL,
	output TEXT,
	created_at INTEGER NOT NULL,
	PRIMARY KEY(run_id, phase, attempt)
);
`;

interface RunRow {
	id: string;
	owner_id: string;
	request: string;
	route: string;
	status: RunStatus;
	current_phase: string | null;
	reason: string | null;
	created_at: number;
	updated_at: number;
}

interface PhaseRow {
	run_id: string;
	phase: string;
	attempt: number;
	status: PhaseStatus;
	output: string | null;
	created_at: number;
}

function toRun(row: RunRow): Run {
	return {
		id: row.id,
		ownerId: row.owner_id,
		request: row.request,
		route: row.route,
		status: row.status,
		currentPhase: row.current_phase,
		reason: row.reason,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function toPhase(row: PhaseRow): PhaseRecord {
	return {
		runId: row.run_id,
		phase: row.phase,
		attempt: row.attempt,
		status: row.status,
		output: row.output,
		createdAt: row.created_at,
	};
}

function clampLimit(limit: number): number {
	if (Number.isNaN(limit)) return 1;
	return Math.min(100, Math.max(1, Math.trunc(limit)));
}

function isUniqueViolation(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	if ("code" in error && (error.code === "SQLITE_CONSTRAINT_PRIMARYKEY" || error.code === "SQLITE_CONSTRAINT_UNIQUE")) {
		return true;
	}
	return error.message.includes("UNIQUE constraint failed");
}

/** Size of the WAL file after a checkpoint; SQLite truncates it back to this when it has grown past it. */
const JOURNAL_SIZE_LIMIT_BYTES = 64 * 1024 * 1024;
/** Problem rows `quick_check` is asked for, and the character cap on the detail built from them. */
const QUICK_CHECK_MAX_ROWS = 10;
const QUICK_CHECK_DETAIL_CHARS = 512;

interface QuickCheckRow {
	quick_check: string;
}

interface CheckpointRow {
	busy: number;
	log: number;
	checkpointed: number;
}

function quickCheck(db: Database): { ok: true } | { ok: false; detail: string } {
	let detail: string;
	try {
		const rows = db.query<QuickCheckRow, []>(`PRAGMA quick_check(${QUICK_CHECK_MAX_ROWS})`).all();
		if (rows.length === 1 && rows[0]?.quick_check === "ok") return { ok: true };
		detail = rows.length === 0 ? "quick_check returned no rows" : rows.map((row) => String(row.quick_check)).join("; ");
	} catch (error) {
		detail = error instanceof Error ? error.message : String(error);
	}
	return { ok: false, detail: detail.length > QUICK_CHECK_DETAIL_CHARS ? `${detail.slice(0, QUICK_CHECK_DETAIL_CHARS - 1)}…` : detail };
}

function createStore(db: Database): Store {
	const insertRun = db.query(
		`INSERT INTO runs (id, owner_id, request, route, status, current_phase, reason, created_at, updated_at)
		 VALUES (?, ?, ?, ?, 'queued', NULL, NULL, ?, ?)`,
	);
	const selectRunForOwner = db.query<RunRow, [string, string]>(
		"SELECT * FROM runs WHERE id = ? AND owner_id = ?",
	);
	const selectRunsForOwner = db.query<RunRow, [string, number]>(
		"SELECT * FROM runs WHERE owner_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?",
	);
	const insertPhase = db.query(
		`INSERT INTO phases (run_id, phase, attempt, status, output, created_at)
		 VALUES (?, ?, ?, ?, ?, ?)`,
	);
	const selectPhase = db.query<PhaseRow, [string, string, number]>(
		"SELECT * FROM phases WHERE run_id = ? AND phase = ? AND attempt = ?",
	);
	const selectPhases = db.query<PhaseRow, [string]>(
		"SELECT * FROM phases WHERE run_id = ? ORDER BY created_at, phase, attempt",
	);

	return {
		db,

		ping(): boolean {
			try {
				db.query("SELECT 1").get();
				return true;
			} catch {
				return false;
			}
		},

		createRun(input): Run {
			const now = Date.now();
			const run: Run = {
				id: randomUUID(),
				ownerId: input.ownerId,
				request: input.request,
				route: input.route,
				status: "queued",
				currentPhase: null,
				reason: null,
				createdAt: now,
				updatedAt: now,
			};
			insertRun.run(run.id, run.ownerId, run.request, run.route, now, now);
			return run;
		},

		getRunForOwner(runId, ownerId): Run | null {
			const row = selectRunForOwner.get(runId, ownerId);
			return row ? toRun(row) : null;
		},

		listRunsForOwner(ownerId, limit): Run[] {
			return selectRunsForOwner.all(ownerId, clampLimit(limit)).map(toRun);
		},

		updateRun(runId, patch): void {
			const sets: string[] = ["updated_at = ?"];
			const params: (string | number | null)[] = [Date.now()];
			if (patch.status !== undefined) {
				sets.push("status = ?");
				params.push(patch.status);
			}
			if (patch.currentPhase !== undefined) {
				sets.push("current_phase = ?");
				params.push(patch.currentPhase);
			}
			if (patch.reason !== undefined) {
				sets.push("reason = ?");
				params.push(patch.reason);
			}
			params.push(runId);
			db.query(`UPDATE runs SET ${sets.join(", ")} WHERE id = ?`).run(...params);
		},

		recordPhase(input): void {
			try {
				insertPhase.run(
					input.runId,
					input.phase,
					input.attempt,
					input.status,
					input.output,
					Date.now(),
				);
			} catch (error) {
				if (isUniqueViolation(error)) {
					throw new DuplicatePhaseError(
						`phase ${input.phase} attempt ${input.attempt} already recorded for run ${input.runId}`,
					);
				}
				throw error;
			}
		},

		getPhase(runId, phase, attempt): PhaseRecord | null {
			const row = selectPhase.get(runId, phase, attempt);
			return row ? toPhase(row) : null;
		},

		listPhases(runId): PhaseRecord[] {
			return selectPhases.all(runId).map(toPhase);
		},

		quickCheck(): { ok: true } | { ok: false; detail: string } {
			return quickCheck(db);
		},

		checkpoint(): { ok: boolean } {
			try {
				const row = db.query<CheckpointRow, []>("PRAGMA wal_checkpoint(PASSIVE)").get();
				return { ok: row !== null && row.busy === 0 };
			} catch {
				return { ok: false };
			}
		},

		close(): void {
			try {
				db.exec("PRAGMA optimize;");
			} catch {
				// Statistics are a hint; a failed optimize must not keep the handle open.
			}
			db.close();
		},
	};
}

/**
 * Opens (creating when absent) the SQLite store at `dbPath` in WAL mode and applies the migrations. The file is
 * verified with `PRAGMA quick_check` before any migration runs, so a corrupt database fails fast with
 * `sqlite quick_check failed: <detail>` instead of a confusing migration error later.
 */
export function openStore(dbPath: string): Store {
	mkdirSync(dirname(dbPath), { recursive: true });
	const db = new Database(dbPath, { create: true });
	try {
		db.exec("PRAGMA journal_mode = WAL;");
		db.exec(`PRAGMA journal_size_limit = ${JOURNAL_SIZE_LIMIT_BYTES};`);
		db.exec("PRAGMA busy_timeout = 5000;");
		db.exec("PRAGMA foreign_keys = ON;");
		const check = quickCheck(db);
		if (!check.ok) throw new Error(`sqlite quick_check failed: ${check.detail}`);
		db.exec(MIGRATIONS);
	} catch (error) {
		db.close();
		throw error;
	}
	return createStore(db);
}
