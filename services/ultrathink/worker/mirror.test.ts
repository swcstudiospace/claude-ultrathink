// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openStore, type Store } from "../store/store.ts";
import { mirrorAllRuns, writeRunState } from "./mirror.ts";

const DECISIONS_DDL = `
CREATE TABLE IF NOT EXISTS decisions (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	run_id TEXT NOT NULL REFERENCES runs(id),
	phase TEXT NOT NULL,
	attempt INTEGER NOT NULL,
	question TEXT NOT NULL,
	options TEXT NOT NULL,
	default_option TEXT,
	answer TEXT,
	created_at INTEGER NOT NULL,
	UNIQUE(run_id, phase, attempt)
);
`;

const REQUEST_TEXT = "PRIVATE-REQUEST-TEXT-7f3a";
const PHASE_OUTPUT = "PRIVATE-PHASE-OUTPUT-9c1d";

let dir: string;
let artifactDir: string;
let store: Store;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "mirror-test-"));
	artifactDir = join(dir, "artifacts");
	store = openStore(join(dir, "store.sqlite"));
});

afterEach(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

function statePath(runId: string): string {
	return join(artifactDir, runId, "STATE.md");
}

function readState(runId: string): string {
	return readFileSync(statePath(runId), "utf8");
}

describe("writeRunState", () => {
	test("writes status and route lines", () => {
		const run = store.createRun({ ownerId: "owner-a", request: REQUEST_TEXT, route: "deep" });
		store.updateRun(run.id, { status: "planning", currentPhase: "plan", reason: "waiting on model" });

		writeRunState({ store, runId: run.id, artifactDir });

		const content = readState(run.id);
		expect(content).toContain(`# Run ${run.id}`);
		expect(content).toContain("- Status: planning");
		expect(content).toContain("- Route: deep");
		expect(content).toContain("- Current phase: plan");
		expect(content).toContain("- Reason: waiting on model");
		expect(content).toContain("- Created: ");
		expect(content).toContain("- Updated: ");
	});

	test("lists complete phases with an artifact link and omits the link for incomplete phases", () => {
		const run = store.createRun({ ownerId: "owner-a", request: REQUEST_TEXT, route: "deep" });
		store.recordPhase({ runId: run.id, phase: "discover", attempt: 1, status: "complete", output: PHASE_OUTPUT });
		store.recordPhase({ runId: run.id, phase: "plan", attempt: 1, status: "failed", output: null });

		writeRunState({ store, runId: run.id, artifactDir });

		const content = readState(run.id);
		expect(content).toContain("## Phases");
		expect(content).toContain("| discover | 1 | complete | [artifact](discover.md) |");
		expect(content).toContain("| plan | 1 | failed |  |");
		expect(content).not.toContain("[artifact](plan.md)");
	});

	test("shows a pending decision with options, trade-offs and default", () => {
		const run = store.createRun({ ownerId: "owner-a", request: REQUEST_TEXT, route: "deep" });
		store.db.exec(DECISIONS_DDL);
		store.db
			.query(
				`INSERT INTO decisions (run_id, phase, attempt, question, options, default_option, answer, created_at)
				 VALUES (?, 'discuss', 1, ?, ?, ?, NULL, ?)`,
			)
			.run(
				run.id,
				"Which storage backend?",
				JSON.stringify([
					{ label: "sqlite", tradeoff: "simple, single file" },
					{ label: "postgres", tradeoff: "scales out, more ops" },
				]),
				"sqlite",
				Date.now(),
			);

		writeRunState({ store, runId: run.id, artifactDir });

		const content = readState(run.id);
		expect(content).toContain("## Pending decision");
		expect(content).toContain("Question: Which storage backend?");
		expect(content).toContain("- sqlite: simple, single file");
		expect(content).toContain("- postgres: scales out, more ops");
		expect(content).toContain("Default: sqlite");
		expect(content).not.toContain("None.");
	});

	test("says None. when no decision row exists", () => {
		const run = store.createRun({ ownerId: "owner-a", request: REQUEST_TEXT, route: "deep" });
		store.db.exec(DECISIONS_DDL);

		writeRunState({ store, runId: run.id, artifactDir });

		const content = readState(run.id);
		expect(content).toContain("## Pending decision");
		expect(content).toContain("None.");
	});

	test("says None. when the decisions table does not exist yet", () => {
		const run = store.createRun({ ownerId: "owner-a", request: REQUEST_TEXT, route: "deep" });

		writeRunState({ store, runId: run.id, artifactDir });

		expect(readState(run.id)).toContain("None.");
	});

	test("does not write the request text or phase output", () => {
		const run = store.createRun({ ownerId: "owner-a", request: REQUEST_TEXT, route: "deep" });
		store.recordPhase({ runId: run.id, phase: "discover", attempt: 1, status: "complete", output: PHASE_OUTPUT });

		writeRunState({ store, runId: run.id, artifactDir });

		const content = readState(run.id);
		expect(content).not.toContain(REQUEST_TEXT);
		expect(content).not.toContain(PHASE_OUTPUT);
	});

	test("writes STATE.md with mode 0o600", () => {
		const run = store.createRun({ ownerId: "owner-a", request: REQUEST_TEXT, route: "deep" });

		writeRunState({ store, runId: run.id, artifactDir });

		expect(statSync(statePath(run.id)).mode & 0o777).toBe(0o600);
	});

	test("leaves no temp files behind", () => {
		const run = store.createRun({ ownerId: "owner-a", request: REQUEST_TEXT, route: "deep" });

		writeRunState({ store, runId: run.id, artifactDir });

		const entries = Array.from(new Bun.Glob("*").scanSync({ cwd: join(artifactDir, run.id), dot: true }));
		expect(entries).toEqual(["STATE.md"]);
	});

	test("throws a plain error for an unknown run without leaking details", () => {
		expect(() => writeRunState({ store, runId: "missing-run", artifactDir })).toThrow("run not found");
		expect(existsSync(join(artifactDir, "missing-run", "STATE.md"))).toBe(false);
	});
});

describe("mirrorAllRuns", () => {
	test("writes every run for the owner and returns the count", () => {
		const first = store.createRun({ ownerId: "owner-a", request: REQUEST_TEXT, route: "deep" });
		const second = store.createRun({ ownerId: "owner-a", request: REQUEST_TEXT, route: "quick" });
		const other = store.createRun({ ownerId: "owner-b", request: REQUEST_TEXT, route: "deep" });

		const written = mirrorAllRuns({ store, artifactDir, ownerId: "owner-a" });

		expect(written).toBe(2);
		expect(existsSync(statePath(first.id))).toBe(true);
		expect(existsSync(statePath(second.id))).toBe(true);
		expect(existsSync(statePath(other.id))).toBe(false);
	});

	test("returns zero when the owner has no runs", () => {
		expect(mirrorAllRuns({ store, artifactDir, ownerId: "nobody" })).toBe(0);
	});
});
