// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "../store/store.ts";
import {
	CEILING_DAY,
	CEILING_RUN,
	CeilingError,
	createLedger,
	LedgerWriteError,
	type LedgerLimits,
} from "./ledger.ts";

const root = mkdtempSync(join(tmpdir(), "ultrathink-ledger-"));
const openStores: Store[] = [];
let counter = 0;

afterAll(() => {
	for (const store of openStores) {
		try {
			store.close();
		} catch {
			// already closed by the test
		}
	}
	rmSync(root, { recursive: true, force: true });
});

// 2026-10-15T12:00:00Z
const START_MS = Date.UTC(2026, 9, 15, 12, 0, 0);

function freshDbPath(): string {
	counter += 1;
	return join(root, `db-${counter}`, "ultrathink.db");
}

function setup(limits: LedgerLimits) {
	const dbPath = freshDbPath();
	const store = openStore(dbPath);
	openStores.push(store);
	const run = store.createRun({
		ownerId: "owner-a",
		request: "plan the release",
		route: "planning",
	});
	const clock = { ms: START_MS };
	const ledger = createLedger(store, limits, () => clock.ms);
	return { dbPath, store, runId: run.id, ledger, clock };
}

function captureError(fn: () => unknown): unknown {
	try {
		fn();
	} catch (error) {
		return error;
	}
	return undefined;
}

describe("token ledger", () => {
	test("refuses a reservation that exceeds the run ceiling with CEILING_RUN", () => {
		const { ledger, runId } = setup({
			runTokenCeiling: 100,
			dailyTokenCeiling: 10_000,
		});
		ledger.reserve({ runId, phase: "a", attempt: 1, estimatedTokens: 60 });

		const error = captureError(() =>
			ledger.reserve({ runId, phase: "b", attempt: 1, estimatedTokens: 50 }),
		);
		expect(error).toBeInstanceOf(CeilingError);
		expect((error as CeilingError).reason).toBe(CEILING_RUN);
		// The refused reservation wrote no row.
		expect(ledger.spentForRun(runId)).toBe(60);
	});

	test("refuses a reservation that exceeds the daily ceiling with CEILING_DAY", () => {
		const { store, ledger, runId } = setup({
			runTokenCeiling: 10_000,
			dailyTokenCeiling: 100,
		});
		ledger.reserve({ runId, phase: "a", attempt: 1, estimatedTokens: 60 });

		const otherRun = store.createRun({
			ownerId: "owner-a",
			request: "second run",
			route: "research",
		});
		const error = captureError(() =>
			ledger.reserve({
				runId: otherRun.id,
				phase: "a",
				attempt: 1,
				estimatedTokens: 50,
			}),
		);
		expect(error).toBeInstanceOf(CeilingError);
		expect((error as CeilingError).reason).toBe(CEILING_DAY);
	});

	test("a zero ceiling is unlimited and never raises CeilingError", () => {
		const { ledger, runId } = setup({
			runTokenCeiling: 0,
			dailyTokenCeiling: 0,
		});
		expect(() => ledger.reserve({ runId, phase: "a", attempt: 1, estimatedTokens: 10_000_000 })).not.toThrow();
		expect(() => ledger.reserve({ runId, phase: "b", attempt: 1, estimatedTokens: 10_000_000 })).not.toThrow();
		expect(ledger.spentForRun(runId)).toBe(20_000_000);
	});

	test("a zero run ceiling leaves the daily ceiling enforced", () => {
		const { store, ledger, runId } = setup({
			runTokenCeiling: 0,
			dailyTokenCeiling: 100,
		});
		ledger.reserve({ runId, phase: "a", attempt: 1, estimatedTokens: 60 });

		const otherRun = store.createRun({
			ownerId: "owner-a",
			request: "second run",
			route: "research",
		});
		const error = captureError(() =>
			ledger.reserve({ runId: otherRun.id, phase: "a", attempt: 1, estimatedTokens: 50 }),
		);
		expect(error).toBeInstanceOf(CeilingError);
		expect((error as CeilingError).reason).toBe(CEILING_DAY);
	});

	test("a zero daily ceiling leaves the run ceiling enforced", () => {
		const { ledger, runId } = setup({
			runTokenCeiling: 100,
			dailyTokenCeiling: 0,
		});
		ledger.reserve({ runId, phase: "a", attempt: 1, estimatedTokens: 60 });

		const error = captureError(() => ledger.reserve({ runId, phase: "b", attempt: 1, estimatedTokens: 50 }));
		expect(error).toBeInstanceOf(CeilingError);
		expect((error as CeilingError).reason).toBe(CEILING_RUN);
	});

	test("the daily total resets on the next UTC day", () => {
		const { store, ledger, runId, clock } = setup({
			runTokenCeiling: 10_000,
			dailyTokenCeiling: 100,
		});
		ledger.reserve({ runId, phase: "a", attempt: 1, estimatedTokens: 60 });

		clock.ms = START_MS + 24 * 60 * 60 * 1000;
		const otherRun = store.createRun({
			ownerId: "owner-a",
			request: "next day run",
			route: "research",
		});
		expect(() =>
			ledger.reserve({
				runId: otherRun.id,
				phase: "a",
				attempt: 1,
				estimatedTokens: 90,
			}),
		).not.toThrow();
		expect(ledger.spentForDay("2026-10-15")).toBe(60);
		expect(ledger.spentForDay("2026-10-16")).toBe(90);
	});

	test("settled actuals replace reservations in later totals", () => {
		const { ledger, runId } = setup({
			runTokenCeiling: 1_000,
			dailyTokenCeiling: 1_000,
		});
		const { reservationId } = ledger.reserve({
			runId,
			phase: "a",
			attempt: 1,
			estimatedTokens: 500,
		});
		expect(ledger.spentForRun(runId)).toBe(500);

		ledger.settle(reservationId, 100);
		expect(ledger.spentForRun(runId)).toBe(100);
		expect(ledger.spentForDay("2026-10-15")).toBe(100);

		// 100 settled + 850 reserved = 950, which fits under 1000.
		expect(() =>
			ledger.reserve({ runId, phase: "b", attempt: 1, estimatedTokens: 850 }),
		).not.toThrow();
		expect(ledger.spentForRun(runId)).toBe(950);
	});

	test("abandoned reservations keep counting their reserved amount", () => {
		const { ledger, runId } = setup({
			runTokenCeiling: 1_000,
			dailyTokenCeiling: 1_000,
		});
		const { reservationId } = ledger.reserve({
			runId,
			phase: "a",
			attempt: 1,
			estimatedTokens: 400,
		});
		ledger.abandon(reservationId);

		expect(ledger.spentForRun(runId)).toBe(400);
		expect(() => ledger.settle(reservationId, 10)).toThrow();
		expect(() => ledger.abandon(reservationId)).toThrow();
	});

	test("a non-positive or non-integer estimate is rejected", () => {
		const { ledger, runId } = setup({
			runTokenCeiling: 1_000,
			dailyTokenCeiling: 1_000,
		});
		for (const estimatedTokens of [0, -5, 1.5, Number.NaN]) {
			const error = captureError(() =>
				ledger.reserve({ runId, phase: "a", attempt: 1, estimatedTokens }),
			);
			expect(error).toBeInstanceOf(Error);
			expect(error).not.toBeInstanceOf(LedgerWriteError);
		}
		expect(ledger.spentForRun(runId)).toBe(0);
	});

	test("a closed store makes reserve throw LedgerWriteError", () => {
		const { store, ledger, runId } = setup({
			runTokenCeiling: 1_000,
			dailyTokenCeiling: 1_000,
		});
		store.close();
		expect(() =>
			ledger.reserve({ runId, phase: "a", attempt: 1, estimatedTokens: 10 }),
		).toThrow(LedgerWriteError);
	});

	test("a duplicate (run, phase, attempt) reservation throws LedgerWriteError", () => {
		const { ledger, runId } = setup({
			runTokenCeiling: 1_000,
			dailyTokenCeiling: 1_000,
		});
		ledger.reserve({ runId, phase: "a", attempt: 1, estimatedTokens: 10 });
		expect(() =>
			ledger.reserve({ runId, phase: "a", attempt: 1, estimatedTokens: 10 }),
		).toThrow(LedgerWriteError);
		expect(ledger.spentForRun(runId)).toBe(10);
	});

	test("a reservation row is written before reserve returns and is visible to another ledger", () => {
		const limits: LedgerLimits = {
			runTokenCeiling: 1_000,
			dailyTokenCeiling: 1_000,
		};
		const { dbPath, ledger, runId } = setup(limits);
		const secondStore = openStore(dbPath);
		openStores.push(secondStore);
		const secondLedger = createLedger(secondStore, limits, () => START_MS);

		ledger.reserve({ runId, phase: "a", attempt: 1, estimatedTokens: 700 });

		expect(secondLedger.spentForRun(runId)).toBe(700);
		const error = captureError(() =>
			secondLedger.reserve({ runId, phase: "b", attempt: 1, estimatedTokens: 400 }),
		);
		expect(error).toBeInstanceOf(CeilingError);
		expect((error as CeilingError).reason).toBe(CEILING_RUN);
	});
});
