// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import type { Database } from "bun:sqlite";
import type { Store } from "../store/store.ts";

export const CEILING_RUN = "run_token_ceiling";
export const CEILING_DAY = "daily_token_ceiling";

export class CeilingError extends Error {
	constructor(readonly reason: typeof CEILING_RUN | typeof CEILING_DAY) {
		super(`token ceiling refused reservation: ${reason}`);
	}
}

export class LedgerWriteError extends Error {}

/** A ceiling of 0 means unlimited; a positive ceiling refuses any reservation that would exceed it. */
export interface LedgerLimits {
	runTokenCeiling: number;
	dailyTokenCeiling: number;
}

export interface Ledger {
	reserve(input: {
		runId: string;
		phase: string;
		attempt: number;
		estimatedTokens: number;
	}): { reservationId: number };
	settle(reservationId: number, actualTokens: number): void;
	/** Provider outcome unknown: the reserved amount keeps counting. */
	abandon(reservationId: number): void;
	spentForRun(runId: string): number;
	/** `day` is a UTC "YYYY-MM-DD" string. */
	spentForDay(day: string): number;
}

const CREATE_TOKEN_LEDGER = `
CREATE TABLE IF NOT EXISTS token_ledger(
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	run_id TEXT NOT NULL REFERENCES runs(id),
	phase TEXT NOT NULL,
	attempt INTEGER NOT NULL,
	day TEXT NOT NULL,
	reserved_tokens INTEGER NOT NULL,
	actual_tokens INTEGER,
	state TEXT NOT NULL CHECK(state IN ('reserved','settled','abandoned')),
	created_at INTEGER NOT NULL,
	UNIQUE(run_id, phase, attempt)
);
`;

// Settled rows count their actual usage; reserved and abandoned rows count the reservation.
const SPENT_FOR_RUN = `
SELECT COALESCE(SUM(CASE WHEN state = 'settled' THEN actual_tokens ELSE reserved_tokens END), 0) AS total
FROM token_ledger WHERE run_id = ?`;

const SPENT_FOR_DAY = `
SELECT COALESCE(SUM(CASE WHEN state = 'settled' THEN actual_tokens ELSE reserved_tokens END), 0) AS total
FROM token_ledger WHERE day = ?`;

const INSERT_RESERVATION = `
INSERT INTO token_ledger (run_id, phase, attempt, day, reserved_tokens, actual_tokens, state, created_at)
VALUES (?, ?, ?, ?, ?, NULL, 'reserved', ?)`;

function sumSpent(db: Database, sql: string, param: string): number {
	const row = db.query<{ total: number }, [string]>(sql).get(param);
	return row?.total ?? 0;
}

export function createLedger(
	store: Store,
	limits: LedgerLimits,
	now: () => number = Date.now,
): Ledger {
	const db = store.db;

	try {
		db.exec(CREATE_TOKEN_LEDGER);
	} catch (error) {
		throw new LedgerWriteError("token ledger schema could not be created", {
			cause: error,
		});
	}

	function transition(
		reservationId: number,
		state: "settled" | "abandoned",
		actualTokens: number | null,
	): void {
		let changes: number;
		try {
			changes = db
				.query(
					"UPDATE token_ledger SET state = ?, actual_tokens = ? WHERE id = ? AND state = 'reserved'",
				)
				.run(state, actualTokens, reservationId).changes;
		} catch (error) {
			throw new LedgerWriteError("token ledger update failed", { cause: error });
		}
		if (changes !== 1) {
			throw new Error(`reservation ${reservationId} is not in reserved state`);
		}
	}

	return {
		reserve(input) {
			if (!Number.isSafeInteger(input.estimatedTokens) || input.estimatedTokens <= 0) {
				throw new Error("estimatedTokens must be a positive integer");
			}
			const estimate = input.estimatedTokens;
			try {
				return db
					.transaction((): { reservationId: number } => {
						const at = now();
						const day = new Date(at).toISOString().slice(0, 10);

						const runSpent = sumSpent(db, SPENT_FOR_RUN, input.runId);
						if (limits.runTokenCeiling > 0 && runSpent + estimate > limits.runTokenCeiling) {
							throw new CeilingError(CEILING_RUN);
						}

						const daySpent = sumSpent(db, SPENT_FOR_DAY, day);
						if (limits.dailyTokenCeiling > 0 && daySpent + estimate > limits.dailyTokenCeiling) {
							throw new CeilingError(CEILING_DAY);
						}

						const result = db
							.query(INSERT_RESERVATION)
							.run(input.runId, input.phase, input.attempt, day, estimate, at);
						return { reservationId: Number(result.lastInsertRowid) };
					})
					.immediate();
			} catch (error) {
				if (error instanceof CeilingError) {
					throw error;
				}
				throw new LedgerWriteError("token reservation could not be recorded", {
					cause: error,
				});
			}
		},

		settle(reservationId, actualTokens) {
			if (!Number.isSafeInteger(actualTokens) || actualTokens < 0) {
				throw new Error("actualTokens must be a non-negative integer");
			}
			transition(reservationId, "settled", actualTokens);
		},

		abandon(reservationId) {
			transition(reservationId, "abandoned", null);
		},

		spentForRun(runId) {
			try {
				return sumSpent(db, SPENT_FOR_RUN, runId);
			} catch (error) {
				throw new LedgerWriteError("token ledger read failed", { cause: error });
			}
		},

		spentForDay(day) {
			try {
				return sumSpent(db, SPENT_FOR_DAY, day);
			} catch (error) {
				throw new LedgerWriteError("token ledger read failed", { cause: error });
			}
		},
	};
}
