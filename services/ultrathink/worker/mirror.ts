// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { join } from "node:path";
import type { PhaseRecord, Run, Store } from "../store/store.ts";
import { writeAtomic } from "./atomic.ts";

const STATE_FILE = "STATE.md";
const MIRROR_RUN_LIMIT = 100;
const PENDING_DECISION_SQL =
	"SELECT question, options, default_option FROM decisions WHERE run_id = ? AND answer IS NULL ORDER BY id DESC LIMIT 1";

interface DecisionOption {
	label: string;
	tradeoff: string;
}

interface PendingDecision {
	question: string;
	options: DecisionOption[];
	default: string;
}

interface DecisionRow {
	question: string;
	options: string;
	default_option: string | null;
}

function oneLine(value: string): string {
	return value.replace(/\s+/g, " ").trim();
}

function isDecisionOption(value: unknown): value is DecisionOption {
	if (typeof value !== "object" || value === null) return false;
	const { label, tradeoff } = value as Record<string, unknown>;
	return typeof label === "string" && typeof tradeoff === "string";
}

function parseOptions(raw: string): DecisionOption[] {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		return [];
	}
	return Array.isArray(value) ? value.filter(isDecisionOption) : [];
}

/** Returns the newest unanswered decision, or null. A missing decisions table means none exists yet. */
function readPendingDecision(store: Store, runId: string): PendingDecision | null {
	let row: DecisionRow | null;
	try {
		row = store.db.query<DecisionRow, [string]>(PENDING_DECISION_SQL).get(runId);
	} catch (error) {
		if (error instanceof Error && error.message.includes("no such table")) return null;
		throw error;
	}
	if (!row) return null;
	return {
		question: row.question,
		options: parseOptions(row.options),
		default: row.default_option ?? "none",
	};
}

function renderPhaseRow(phase: PhaseRecord): string {
	const artifact =
		phase.status === "complete" ? `[artifact](${encodeURIComponent(phase.phase)}.md)` : "";
	return `| ${oneLine(phase.phase).replace(/\|/g, "\\|")} | ${phase.attempt} | ${phase.status} | ${artifact} |`;
}

function renderDecision(decision: PendingDecision | null): string[] {
	if (!decision) return ["None."];
	const lines = [`Question: ${oneLine(decision.question)}`, "", "Options:"];
	for (const option of decision.options) {
		lines.push(`- ${oneLine(option.label)}: ${oneLine(option.tradeoff)}`);
	}
	lines.push("", `Default: ${oneLine(decision.default)}`);
	return lines;
}

function renderState(run: Run, phases: PhaseRecord[], decision: PendingDecision | null): string {
	const lines = [
		`# Run ${run.id}`,
		"",
		`- Status: ${run.status}`,
		`- Route: ${oneLine(run.route)}`,
		`- Current phase: ${run.currentPhase ? oneLine(run.currentPhase) : "none"}`,
		`- Reason: ${run.reason ? oneLine(run.reason) : "none"}`,
		`- Created: ${new Date(run.createdAt).toISOString()}`,
		`- Updated: ${new Date(run.updatedAt).toISOString()}`,
		"",
		"## Phases",
		"",
		"| phase | attempt | status | artifact |",
		"| --- | --- | --- | --- |",
		...phases.map(renderPhaseRow),
		"",
		"## Pending decision",
		"",
		...renderDecision(decision),
		"",
	];
	return lines.join("\n");
}

/** Mirrors one run's status (never its request text or phase output) to `${artifactDir}/${runId}/STATE.md`. */
export function writeRunState(input: { store: Store; runId: string; artifactDir: string }): void {
	const { store, runId, artifactDir } = input;
	const owner = store.db
		.query<{ owner_id: string }, [string]>("SELECT owner_id FROM runs WHERE id = ?")
		.get(runId);
	const run = owner ? store.getRunForOwner(runId, owner.owner_id) : null;
	if (!run) throw new Error("run not found");

	const phases = store.listPhases(runId);
	const decision = readPendingDecision(store, runId);
	writeAtomic(join(artifactDir, runId), STATE_FILE, renderState(run, phases, decision));
}

/** Mirrors every run owned by `ownerId` (newest first, capped) and returns how many were written. */
export function mirrorAllRuns(input: { store: Store; artifactDir: string; ownerId: string }): number {
	const { store, artifactDir, ownerId } = input;
	const runs = store.listRunsForOwner(ownerId, MIRROR_RUN_LIMIT);
	for (const run of runs) {
		writeRunState({ store, runId: run.id, artifactDir });
	}
	return runs.length;
}
