// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { pruneRuns } from "./retention.ts";

const DAY_MS = 86_400_000;
const NOW = Date.UTC(2026, 9, 18, 12, 0, 0);
const TODAY = "2026-10-18";
const CUTOFF = NOW - 30 * DAY_MS;
const OLD = NOW - 40 * DAY_MS;
const RECENT = NOW - 5 * DAY_MS;

function openDb(options: { ledger?: boolean } = {}): Database {
	const db = new Database(":memory:");
	db.run("PRAGMA foreign_keys = ON");
	db.run("CREATE TABLE runs (id TEXT PRIMARY KEY, status TEXT NOT NULL, updated_at INTEGER NOT NULL)");
	db.run("CREATE TABLE phases (run_id TEXT NOT NULL REFERENCES runs(id), phase TEXT NOT NULL)");
	if (options.ledger !== false) {
		db.run("CREATE TABLE token_ledger (id INTEGER PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), day TEXT NOT NULL)");
	}
	db.run("CREATE TABLE future_notes (run_id TEXT NOT NULL REFERENCES runs(id), note TEXT)");
	return db;
}

function addRun(db: Database, id: string, status: string, updatedAt: number, ledgerDay?: string): void {
	db.query("INSERT INTO runs (id, status, updated_at) VALUES (?, ?, ?)").run(id, status, updatedAt);
	db.query("INSERT INTO phases (run_id, phase) VALUES (?, 'discover')").run(id);
	db.query("INSERT INTO future_notes (run_id, note) VALUES (?, 'n')").run(id);
	if (ledgerDay !== undefined) db.query("INSERT INTO token_ledger (run_id, day) VALUES (?, ?)").run(id, ledgerDay);
}

function count(db: Database, table: string, runId?: string): number {
	const column = table === "runs" ? "id" : "run_id";
	const sql = runId === undefined ? `SELECT count(*) AS n FROM ${table}` : `SELECT count(*) AS n FROM ${table} WHERE ${column} = ?`;
	const row = (runId === undefined ? db.query(sql).get() : db.query(sql).get(runId)) as { n: number };
	return row.n;
}

describe("pruneRuns", () => {
	test("removes an old run with every row that references it, including tables it was not told about", () => {
		const db = openDb();
		addRun(db, "old", "complete", OLD, "2026-09-08");

		const result = pruneRuns(db, { cutoffMs: CUTOFF, today: TODAY });

		expect(result).toEqual({ runs: 1, rows: { future_notes: 1, phases: 1, token_ledger: 1 } });
		for (const table of ["runs", "phases", "token_ledger", "future_notes"]) expect(count(db, table)).toBe(0);
	});

	test("leaves a recent run and its rows untouched", () => {
		const db = openDb();
		addRun(db, "old", "complete", OLD, "2026-09-08");
		addRun(db, "recent", "executing", RECENT, "2026-10-13");

		const result = pruneRuns(db, { cutoffMs: CUTOFF, today: TODAY });

		expect(result.runs).toBe(1);
		expect(count(db, "runs")).toBe(1);
		for (const table of ["phases", "token_ledger", "future_notes"]) expect(count(db, table, "recent")).toBe(1);
	});

	test("keeps an old run that has a ledger row dated today, with all its rows", () => {
		const db = openDb();
		addRun(db, "old-but-spending", "executing", OLD, TODAY);

		const result = pruneRuns(db, { cutoffMs: CUTOFF, today: TODAY });

		expect(result).toEqual({ runs: 0, rows: { future_notes: 0, phases: 0, token_ledger: 0 } });
		for (const table of ["runs", "phases", "token_ledger", "future_notes"]) expect(count(db, table)).toBe(1);
	});

	test("removes an old run stuck in a paused status", () => {
		const db = openDb();
		addRun(db, "stuck", "paused-for-blocker", OLD, "2026-09-08");

		expect(pruneRuns(db, { cutoffMs: CUTOFF, today: TODAY }).runs).toBe(1);
		expect(count(db, "runs")).toBe(0);
	});

	test("works when there is no token_ledger table", () => {
		const db = openDb({ ledger: false });
		addRun(db, "old", "complete", OLD);
		addRun(db, "recent", "complete", RECENT);

		const result = pruneRuns(db, { cutoffMs: CUTOFF, today: TODAY });

		expect(result).toEqual({ runs: 1, rows: { future_notes: 1, phases: 1 } });
		expect(count(db, "runs")).toBe(1);
	});

	test("is all or nothing: a failing delete rolls back the deletes that already ran", () => {
		const db = openDb();
		addRun(db, "old", "complete", OLD, "2026-09-08");
		db.run("CREATE TRIGGER block_ledger BEFORE DELETE ON token_ledger BEGIN SELECT RAISE(ABORT, 'blocked'); END");

		expect(() => pruneRuns(db, { cutoffMs: CUTOFF, today: TODAY })).toThrow();

		for (const table of ["runs", "phases", "token_ledger", "future_notes"]) expect(count(db, table, "old")).toBe(1);
	});

	test("takes the write lock up front: a deferred transaction can fail with SQLITE_BUSY_SNAPSHOT when the web process commits mid-prune", () => {
		const db = openDb();
		addRun(db, "old", "complete", OLD, "2026-09-08");
		const modes: string[] = [];
		const spy = new Proxy(db, {
			get(target, property) {
				if (property === "transaction") {
					return (fn: () => unknown) => {
						const wrapped = target.transaction(fn);
						return Object.assign(
							() => {
								modes.push("deferred");
								return wrapped();
							},
							{
								immediate: () => {
									modes.push("immediate");
									return wrapped.immediate();
								},
							},
						);
					};
				}
				const value = Reflect.get(target, property, target);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});

		const result = pruneRuns(spy, { cutoffMs: CUTOFF, today: TODAY });

		expect(modes).toEqual(["immediate"]);
		expect(result.runs).toBe(1);
	});
});
