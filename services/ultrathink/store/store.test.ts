// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DuplicatePhaseError, openStore, type Store } from "./store.ts";

const tempDirs: string[] = [];

function tempDbPath(): string {
	const dir = mkdtempSync(join(tmpdir(), "ultrathink-store-"));
	tempDirs.push(dir);
	return join(dir, "nested", "ultrathink.sqlite");
}

afterAll(() => {
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe("ultrathink store", () => {
	test("migrations applied twice cleanly", () => {
		const path = tempDbPath();
		const first = openStore(path);
		const run = first.createRun({ ownerId: "owner", request: "plan it", route: "default" });
		first.close();

		const second = openStore(path);
		try {
			expect(second.getRunForOwner(run.id, "owner")?.id).toBe(run.id);
			const tables = second.db
				.query<{ name: string }, []>(
					"SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
				)
				.all()
				.map((row) => row.name);
			expect(tables).toContain("runs");
			expect(tables).toContain("phases");
			const fk = second.db.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get();
			expect(fk?.foreign_keys).toBe(1);
		} finally {
			second.close();
		}
	});

	test("duplicate phase key throws DuplicatePhaseError while next attempt succeeds", () => {
		const store: Store = openStore(tempDbPath());
		try {
			const run = store.createRun({ ownerId: "owner", request: "r", route: "default" });
			store.recordPhase({
				runId: run.id,
				phase: "discover",
				attempt: 1,
				status: "complete",
				output: "ok",
			});
			expect(() =>
				store.recordPhase({
					runId: run.id,
					phase: "discover",
					attempt: 1,
					status: "failed",
					output: null,
				}),
			).toThrow(DuplicatePhaseError);

			expect(() =>
				store.recordPhase({
					runId: run.id,
					phase: "discover",
					attempt: 2,
					status: "complete",
					output: "retry",
				}),
			).not.toThrow();

			expect(store.getPhase(run.id, "discover", 1)?.output).toBe("ok");
			expect(store.getPhase(run.id, "discover", 2)?.output).toBe("retry");
			expect(store.listPhases(run.id).map((phase) => phase.attempt)).toEqual([1, 2]);
		} finally {
			store.close();
		}
	});

	test("getRunForOwner returns null for a foreign owner", () => {
		const store = openStore(tempDbPath());
		try {
			const run = store.createRun({ ownerId: "owner-a", request: "r", route: "default" });
			expect(run.status).toBe("queued");
			expect(store.getRunForOwner(run.id, "owner-b")).toBeNull();
			expect(store.getRunForOwner("missing", "owner-a")).toBeNull();
			expect(store.getRunForOwner(run.id, "owner-a")?.id).toBe(run.id);
		} finally {
			store.close();
		}
	});

	test("updateRun changes status and advances updatedAt", () => {
		const clock = spyOn(Date, "now").mockReturnValue(1_000);
		const store = openStore(tempDbPath());
		try {
			const run = store.createRun({ ownerId: "owner", request: "r", route: "default" });
			expect(run.updatedAt).toBe(1_000);

			clock.mockReturnValue(2_000);
			store.updateRun(run.id, { status: "discovering", currentPhase: "discover" });
			const updated = store.getRunForOwner(run.id, "owner");
			expect(updated?.status).toBe("discovering");
			expect(updated?.currentPhase).toBe("discover");
			expect(updated?.reason).toBeNull();
			expect(updated?.createdAt).toBe(run.createdAt);
			expect(updated?.updatedAt).toBe(2_000);
		} finally {
			clock.mockRestore();
			store.close();
		}
	});

	test("listRunsForOwner returns newest first and clamps the limit", () => {
		const store = openStore(tempDbPath());
		try {
			store.createRun({ ownerId: "owner", request: "first", route: "default" });
			store.createRun({ ownerId: "owner", request: "second", route: "default" });
			const last = store.createRun({ ownerId: "owner", request: "third", route: "default" });
			store.createRun({ ownerId: "other", request: "foreign", route: "default" });

			const runs = store.listRunsForOwner("owner", 0);
			expect(runs).toHaveLength(1);
			expect(runs[0]?.id).toBe(last.id);
			expect(store.listRunsForOwner("owner", 1000)).toHaveLength(3);
		} finally {
			store.close();
		}
	});

	test("ping is true on an open store", () => {
		const store = openStore(tempDbPath());
		try {
			expect(store.ping()).toBe(true);
		} finally {
			store.close();
		}
	});
});
