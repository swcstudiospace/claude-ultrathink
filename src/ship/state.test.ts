// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendAttempts, archiveShip, readShip, writeShip } from "./state.ts";
import { MAX_ATTEMPTS, MAX_SHIP_HISTORY } from "./types.ts";
import type { ShipAttempt, ShipState } from "./types.ts";

let dir: string;
let statePath: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ultrathink-ship-state-"));
	statePath = join(dir, "s1.json");
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

const BASE = { sessionId: "s1", at: 1, result: { xml: "<X/>", original: "x", root: "X", source: "llm" } };

function seed(extra: Record<string, unknown> = {}): void {
	writeFileSync(statePath, `${JSON.stringify({ ...BASE, ...extra }, null, 2)}\n`);
}

function saved(): Record<string, unknown> {
	return JSON.parse(readFileSync(statePath, "utf8")) as Record<string, unknown>;
}

function attempt(n: number, detail?: string): ShipAttempt {
	return { at: n, step: "review", headSha: `sha${n}`, outcome: "needs-fixes", ...(detail === undefined ? {} : { detail }) };
}

function strayFiles(): string[] {
	return readdirSync(dir).filter((name) => name.endsWith(".tmp") || name.endsWith(".lock") || name.endsWith(".stale"));
}

describe("writeShip", () => {
	test("starts a ship with defaults when the record has none, stamping updatedAt", () => {
		seed();
		const ship = writeShip(statePath, { pr: { number: 7, url: "https://example.test/pr/7", head: "feat/x", base: "main" } }, 1234);
		expect(ship).toEqual({ phase: "not-done", rounds: [], pr: { number: 7, url: "https://example.test/pr/7", head: "feat/x", base: "main" }, updatedAt: 1234 });
		expect(readShip(statePath)).toEqual(ship);
	});

	test("merges the patch over the existing ship and keeps every other field of the record", () => {
		seed({ kickedOff: true, ship: { phase: "pr-open", rounds: [], nudgedAt: 5, updatedAt: 10 } });
		const ship = writeShip(statePath, { phase: "needs-fixes" }, 99);
		expect(ship).toEqual({ phase: "needs-fixes", rounds: [], nudgedAt: 5, updatedAt: 99 });
		const record = saved();
		expect(record.kickedOff).toBe(true);
		expect(record.sessionId).toBe("s1");
		expect(record.ship).toEqual(ship as ShipState);
	});

	test("keeps the two-space JSON format with a trailing newline, owner-only, and leaves no temporary or lock file", () => {
		seed();
		writeShip(statePath, { phase: "blocked", blockedReason: "no remote" }, 1);
		const text = readFileSync(statePath, "utf8");
		expect(text).toBe(`${JSON.stringify(JSON.parse(text), null, 2)}\n`);
		if (process.platform !== "win32") expect(statSync(statePath).mode & 0o777).toBe(0o600);
		expect(strayFiles()).toEqual([]);
	});

	test("a missing or non-object state file returns undefined and creates nothing", () => {
		expect(writeShip(statePath, { phase: "ready" })).toBeUndefined();
		expect(archiveShip(statePath)).toBeUndefined();
		expect(appendAttempts(statePath, [attempt(1)])).toBeUndefined();
		expect(readdirSync(dir)).toEqual([]);
		for (const garbage of ["[1,2]", "null", "42", "{not json"]) {
			writeFileSync(statePath, garbage);
			expect(writeShip(statePath, { phase: "ready" })).toBeUndefined();
			expect(archiveShip(statePath)).toBeUndefined();
			expect(appendAttempts(statePath, [attempt(1)])).toBeUndefined();
			expect(readFileSync(statePath, "utf8")).toBe(garbage);
		}
		expect(strayFiles()).toEqual([]);
	});

	test("a state path inside a missing directory returns undefined and does not create the directory", () => {
		const missing = join(dir, "no-such-dir", "s1.json");
		expect(writeShip(missing, { phase: "ready" })).toBeUndefined();
		expect(existsSync(join(dir, "no-such-dir"))).toBe(false);
	});
});

describe("archiveShip", () => {
	test("moves the current ship, without its own history, to the end of history and starts a fresh one", () => {
		const earlier = { phase: "merged" as const, rounds: [], updatedAt: 1 };
		seed({ ship: { phase: "blocked", rounds: [], blockedReason: "x", history: [earlier], updatedAt: 2 } });
		const ship = archiveShip(statePath, 50);
		expect(ship).toEqual({
			phase: "not-done",
			rounds: [],
			history: [earlier, { phase: "blocked", rounds: [], blockedReason: "x", updatedAt: 2 }],
			updatedAt: 50,
		});
		expect(readShip(statePath)).toEqual(ship);
	});

	test(`keeps only the newest ${MAX_SHIP_HISTORY} finished ships`, () => {
		const history = Array.from({ length: MAX_SHIP_HISTORY }, (_, i) => ({ phase: "merged" as const, rounds: [], updatedAt: i }));
		seed({ ship: { phase: "pr-open", rounds: [], history, updatedAt: 100 } });
		const ship = archiveShip(statePath, 200);
		expect(ship?.history).toHaveLength(MAX_SHIP_HISTORY);
		expect(ship?.history?.[0]?.updatedAt).toBe(1);
		expect(ship?.history?.at(-1)).toEqual({ phase: "pr-open", rounds: [], updatedAt: 100 });
	});

	test("a record with no ship archives an empty finished ship", () => {
		seed();
		const ship = archiveShip(statePath, 3);
		expect(ship?.history).toHaveLength(1);
		expect(Object.keys(ship?.history?.[0] ?? { unexpected: true })).toEqual([]);
		expect(ship?.phase).toBe("not-done");
	});
});

describe("appendAttempts", () => {
	test("starts the log on an existing ship, keeps its other fields and appends on later calls", () => {
		seed({ ship: { phase: "needs-fixes", rounds: [], nudgedAt: 4, updatedAt: 1 } });
		const ship = appendAttempts(statePath, [attempt(1), attempt(2)], 77);
		expect(ship?.attempts).toEqual([attempt(1), attempt(2)]);
		expect(ship).toMatchObject({ phase: "needs-fixes", nudgedAt: 4, updatedAt: 77 });
		expect(readShip(statePath)).toEqual(ship);
		expect(appendAttempts(statePath, [attempt(3)], 78)?.attempts).toEqual([attempt(1), attempt(2), attempt(3)]);
	});

	test("starts from a not-done ship when the record has none", () => {
		seed();
		expect(appendAttempts(statePath, [attempt(1)], 5)).toEqual({ phase: "not-done", rounds: [], attempts: [attempt(1)], updatedAt: 5 });
	});

	test(`keeps only the newest ${MAX_ATTEMPTS} attempts`, () => {
		seed();
		appendAttempts(statePath, Array.from({ length: MAX_ATTEMPTS }, (_, i) => attempt(i)), 1);
		const ship = appendAttempts(statePath, [attempt(1000), attempt(1001)], 2);
		expect(ship?.attempts).toHaveLength(MAX_ATTEMPTS);
		expect(ship?.attempts?.[0]?.at).toBe(2);
		expect(ship?.attempts?.at(-1)?.at).toBe(1001);
	});

	test("collapses whitespace in a detail to one line and caps it at 200 characters", () => {
		seed();
		const ship = appendAttempts(statePath, [attempt(1, "  first\n\tsecond   third \n"), attempt(2, "y".repeat(500)), attempt(3)], 1);
		expect(ship?.attempts?.[0]?.detail).toBe("first second third");
		expect(ship?.attempts?.[1]?.detail).toBe("y".repeat(200));
		expect(ship?.attempts?.[2]).not.toHaveProperty("detail");
	});

	test("a ship write and an attempt append in turn both land, with one writer's fields never replacing the other's", () => {
		seed();
		appendAttempts(statePath, [attempt(1)], 1);
		writeShip(statePath, { phase: "ready", waiting: { headSha: "sha1", since: 3 } }, 2);
		appendAttempts(statePath, [attempt(2)], 3);
		expect(readShip(statePath)).toEqual({
			phase: "ready",
			rounds: [],
			waiting: { headSha: "sha1", since: 3 },
			attempts: [attempt(1), attempt(2)],
			updatedAt: 3,
		});
		expect(strayFiles()).toEqual([]);
	});
});
