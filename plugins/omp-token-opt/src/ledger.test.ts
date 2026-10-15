import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { createLedger, isValidSnapshot, LedgerReject, type SavingsPoint } from "./ledger.ts";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

function point(at: number, baseline: number, current: number): SavingsPoint {
	return { at, source: "compress", baseline, current, saved: baseline - current };
}

describe("ledger", () => {
	test("savedTokens is always baseline minus current", () => {
		const dir = mkdtempSync(join(tmpdir(), "token-opt-"));
		const ledger = createLedger({ dir, now: () => 10 });
		ledger.load("sess");
		ledger.record(point(1, 10, 4));
		ledger.record({ at: 2, source: "provider", baseline: 8, current: 3, saved: 5 });
		const snap = ledger.snapshot();
		expect(snap).not.toBeNull();
		expect(snap!.savedTokens).toBe(snap!.baselineTokens - snap!.currentTokens);
		expect(snap!.savedTokens).toBe(11);
		for (const row of snap!.points) {
			expect(row.saved).toBe(row.baseline - row.current);
		}
	});

	test("caps points at 200, newest last", () => {
		const dir = mkdtempSync(join(tmpdir(), "token-opt-"));
		const ledger = createLedger({ dir, now: () => 1 });
		ledger.load("sess");
		for (let i = 0; i < 201; i += 1) ledger.record(point(i, 4, 0));
		const snap = ledger.snapshot();
		expect(snap!.points.length).toBe(200);
		expect(snap!.points[0]!.at).toBe(1);
		expect(snap!.points[199]!.at).toBe(200);
		expect(snap!.savedTokens).toBe(snap!.baselineTokens - snap!.currentTokens);
		expect(snap!.baselineTokens).toBe(804);
	});

	test("rejects a bad point without writing", () => {
		const dir = mkdtempSync(join(tmpdir(), "token-opt-"));
		const ledger = createLedger({ dir, now: () => 1 });
		ledger.load("sess");
		const live = join(dir, "live.json");
		const before = readFileSync(live, "utf8");
		expect(() => ledger.record({ at: 1, source: "graph", baseline: 10, current: 3, saved: 9 })).toThrow(LedgerReject);
		expect(() => ledger.record({ at: 1.5, source: "graph", baseline: 4, current: 0, saved: 4 })).toThrow(LedgerReject);
		expect(() => ledger.record({ at: 1, source: "graph", baseline: -1, current: 0, saved: -1 })).toThrow(LedgerReject);
		expect(readFileSync(live, "utf8")).toBe(before);
		expect(ledger.snapshot()!.points).toEqual([]);
		expect(ledger.snapshot()!.savedTokens).toBe(0);
	});

	test("optional perf fields persist and a bad field is rejected", () => {
		const dir = mkdtempSync(join(tmpdir(), "token-opt-"));
		const ledger = createLedger({ dir, now: () => 10 });
		ledger.load("sess");
		ledger.notePerf({ lastTurnMs: 12, cacheHitPct: 40, lastQueryMs: 3 });
		ledger.record(point(1, 10, 4));
		const snap = ledger.snapshot()!;
		expect(snap.lastTurnMs).toBe(12);
		expect(snap.cacheHitPct).toBe(40);
		expect(snap.lastQueryMs).toBe(3);
		expect(snap.savedTokens).toBe(snap.baselineTokens - snap.currentTokens);
		expect(snap.savedTokens).toBe(6);
		const live = JSON.parse(readFileSync(join(dir, "live.json"), "utf8")) as Record<string, unknown>;
		expect(live.lastTurnMs).toBe(12);
		expect(live.cacheHitPct).toBe(40);
		expect(live.lastQueryMs).toBe(3);
		const reloaded = createLedger({ dir, now: () => 11 }).load("sess");
		expect(reloaded.lastTurnMs).toBe(12);
		expect(reloaded.cacheHitPct).toBe(40);
		expect(reloaded.lastQueryMs).toBe(3);
		expect(reloaded.savedTokens).toBe(reloaded.baselineTokens - reloaded.currentTokens);
		const bare = {
			v: 1 as const,
			sessionId: "sess",
			updatedAt: 1,
			baselineTokens: 0,
			currentTokens: 0,
			savedTokens: 0,
			points: [],
		};
		expect(isValidSnapshot(bare, "sess")).toBe(true);
		expect(isValidSnapshot({ ...bare, lastTurnMs: 0, cacheHitPct: 100, lastQueryMs: 0 }, "sess")).toBe(true);
		expect(isValidSnapshot({ ...bare, lastTurnMs: -1 }, "sess")).toBe(false);
		expect(isValidSnapshot({ ...bare, cacheHitPct: 101 }, "sess")).toBe(false);
		expect(isValidSnapshot({ ...bare, lastQueryMs: 1.5 }, "sess")).toBe(false);
		expect(isValidSnapshot({ ...bare, lastTurnMs: "12" }, "sess")).toBe(false);
		const before = readFileSync(join(dir, "live.json"), "utf8");
		expect(() => ledger.notePerf({ cacheHitPct: 101 })).toThrow(LedgerReject);
		expect(readFileSync(join(dir, "live.json"), "utf8")).toBe(before);
	});
	test("notePerf persists rtkSavedTokens without changing savedTokens", () => {
		const dir = mkdtempSync(join(tmpdir(), "token-opt-"));
		const ledger = createLedger({ dir, now: () => 10 });
		ledger.load("sess");
		ledger.record(point(1, 10, 4));
		ledger.notePerf({ rtkSavedTokens: 15 });
		const snap = ledger.snapshot()!;
		expect(snap.rtkSavedTokens).toBe(15);
		expect(snap.savedTokens).toBe(6);
		expect(snap.savedTokens).toBe(snap.baselineTokens - snap.currentTokens);
		const live = JSON.parse(readFileSync(join(dir, "live.json"), "utf8")) as { rtkSavedTokens?: number };
		expect(live.rtkSavedTokens).toBe(15);
		expect(isValidSnapshot({ ...snap, rtkSavedTokens: -1 }, "sess")).toBe(false);
		expect(isValidSnapshot({ ...snap, lastPayloadChars: 1.2 }, "sess")).toBe(false);
		expect(isValidSnapshot({ ...snap, ttftMs: -1 }, "sess")).toBe(false);
		const before = readFileSync(join(dir, "live.json"), "utf8");
		expect(() => ledger.notePerf({ rtkSavedTokens: -1 })).toThrow(LedgerReject);
		expect(readFileSync(join(dir, "live.json"), "utf8")).toBe(before);
	});

	test("costCents rejects -1 and does not rewrite live.json", () => {
		const dir = mkdtempSync(join(tmpdir(), "token-opt-"));
		const ledger = createLedger({ dir, now: () => 10 });
		ledger.load("sess");
		ledger.notePerf({ costCents: 12 });
		expect(ledger.snapshot()!.costCents).toBe(12);
		expect(ledger.snapshot()!.savedTokens).toBe(0);
		expect(isValidSnapshot({ ...ledger.snapshot()!, costCents: -1 }, "sess")).toBe(false);
		const before = readFileSync(join(dir, "live.json"), "utf8");
		expect(() => ledger.notePerf({ costCents: -1 })).toThrow(LedgerReject);
		expect(readFileSync(join(dir, "live.json"), "utf8")).toBe(before);
		expect(ledger.snapshot()!.costCents).toBe(12);
		expect(JSON.parse(before).costCents).toBe(12);
		expect("lastIdleMs" in JSON.parse(before)).toBe(false);
	});

	test("a held lock does not rewrite live.json", () => {
		const dir = mkdtempSync(join(tmpdir(), "token-opt-"));
		const ledger = createLedger({ dir, now: () => 10 });
		ledger.load("sess");
		const live = join(dir, "live.json");
		const before = readFileSync(live, "utf8");
		mkdirSync(join(dir, ".lock"));
		expect(() => ledger.notePerf({ lastQueryMs: 9 })).toThrow(LedgerReject);
		expect(readFileSync(live, "utf8")).toBe(before);
		expect(ledger.snapshot()!.lastQueryMs).toBeUndefined();
	});

	test("cache hit percent uses lifetime provider totals after the window slides", () => {
		const dir = mkdtempSync(join(tmpdir(), "token-opt-"));
		const ledger = createLedger({ dir, now: () => 1 });
		ledger.load("sess");
		for (let i = 0; i < 201; i += 1) {
			ledger.addProviderUsage(1, 1, 0);
			ledger.record(point(i, 4, 0));
		}
		const snap = ledger.snapshot()!;
		expect(snap.points.length).toBe(200);
		expect(snap.baselineTokens).toBe(804);
		expect(snap.savedTokens).toBe(snap.baselineTokens - snap.currentTokens);
		expect(snap.cacheHitPct).toBe(50);
	});

	test("addProviderUsage stores bill totals without changing savedTokens", () => {
		const dir = mkdtempSync(join(tmpdir(), "token-opt-"));
		const ledger = createLedger({ dir, now: () => 1 });
		ledger.load("sess");
		const before = ledger.snapshot()!;
		const snap = ledger.addProviderUsage(2, 1, 0, 4);
		expect(snap.providerInput).toBe(2);
		expect(snap.providerOutput).toBe(4);
		expect(snap.providerCacheRead).toBe(1);
		expect(snap.providerCacheWrite).toBe(0);
		expect(snap.savedTokens).toBe(before.savedTokens);
		expect(snap.baselineTokens).toBe(before.baselineTokens);
		expect(snap.currentTokens).toBe(before.currentTokens);
		expect(isValidSnapshot({ ...snap, providerOutput: -1 }, "sess")).toBe(false);
		expect(isValidSnapshot({ ...snap, prefixChanged: 2 }, "sess")).toBe(false);
		expect(isValidSnapshot({ ...snap, graphReady: 1 }, "sess")).toBe(true);
	});
});
