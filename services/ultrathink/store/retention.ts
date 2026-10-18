// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import type { Database } from "bun:sqlite";

export interface PruneOptions {
	/** Runs with `updated_at` (epoch ms) below this are removed. */
	cutoffMs: number;
	/** UTC "YYYY-MM-DD". A run with a token_ledger row for this day or later is kept. */
	today: string;
}

export interface PruneResult {
	runs: number;
	/** Deleted row count per child table. */
	rows: Record<string, number>;
}

interface NameRow {
	name: string;
}

interface ForeignKeyRow {
	table: string;
	from: string;
}

function quote(identifier: string): string {
	return `"${identifier.replaceAll('"', '""')}"`;
}

function columnsOf(db: Database, table: string): Set<string> {
	const rows = db.query(`PRAGMA table_info(${quote(table)})`).all() as NameRow[];
	return new Set(rows.map((row) => row.name));
}

/** Child tables are found through their foreign keys to runs, so a new table that references runs is covered. */
function childTables(db: Database): Array<{ table: string; column: string }> {
	const tables = db
		.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'runs' ORDER BY name")
		.all() as NameRow[];
	const children: Array<{ table: string; column: string }> = [];
	for (const { name } of tables) {
		const keys = db.query(`PRAGMA foreign_key_list(${quote(name)})`).all() as ForeignKeyRow[];
		for (const key of keys) {
			if (key.table.toLowerCase() === "runs") children.push({ table: name, column: key.from });
		}
	}
	return children;
}

/**
 * Deletes runs not updated since `cutoffMs` (any status) and every row that references them, in one transaction.
 * The daily token ceiling sums token_ledger by day, so a run with a ledger row dated today or later is kept.
 * Any error rolls everything back and propagates.
 */
export function pruneRuns(db: Database, options: PruneOptions): PruneResult {
	return db.transaction((): PruneResult => {
		const ledger = columnsOf(db, "token_ledger");
		const guard =
			ledger.has("run_id") && ledger.has("day") ? " AND id NOT IN (SELECT run_id FROM token_ledger WHERE day >= ?)" : "";
		db.run("CREATE TEMP TABLE ut_doomed (id PRIMARY KEY)");
		const params: Array<number | string> = [options.cutoffMs];
		if (guard) params.push(options.today);
		db.query(`INSERT OR IGNORE INTO ut_doomed SELECT id FROM runs WHERE updated_at < ?${guard}`).run(...params);

		const rows: Record<string, number> = {};
		for (const { table, column } of childTables(db)) {
			const { changes } = db
				.query(`DELETE FROM ${quote(table)} WHERE ${quote(column)} IN (SELECT id FROM ut_doomed)`)
				.run();
			rows[table] = (rows[table] ?? 0) + changes;
		}
		const { changes: runs } = db.query("DELETE FROM runs WHERE id IN (SELECT id FROM ut_doomed)").run();
		db.run("DROP TABLE ut_doomed");
		return { runs, rows };
	})();
}
