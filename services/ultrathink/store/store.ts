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

		close(): void {
			db.close();
		},
	};
}

export function openStore(dbPath: string): Store {
	mkdirSync(dirname(dbPath), { recursive: true });
	const db = new Database(dbPath, { create: true });
	try {
		db.exec("PRAGMA journal_mode = WAL;");
		db.exec("PRAGMA busy_timeout = 5000;");
		db.exec("PRAGMA foreign_keys = ON;");
		db.exec(MIGRATIONS);
	} catch (error) {
		db.close();
		throw error;
	}
	return createStore(db);
}
