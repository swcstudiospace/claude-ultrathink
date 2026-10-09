// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * `ultrathink prune [--older-than <days>[d]] [--dry-run]`: removes old session records on request. The cutoff is
 * never implicit and never below one day, so a typo cannot empty the state directory. Output carries ids, sizes
 * and counts only, never prompt content.
 */
import { claudeConfigPaths, loadConfig } from "../config.ts";
import { resolveStateDir } from "../host/paths.ts";
import { type PruneResult, pruneSessions } from "./prune.ts";

export interface PruneCommandResult {
	output: string;
	exitCode: number;
}

export interface PruneCommandDeps {
	env?: Record<string, string | undefined>;
	cwd?: string;
	now?: () => number;
	/** State directory override; default `resolveStateDir(env)`. */
	stateDir?: string;
	/** Cutoff used when `--older-than` is absent; default `state.retentionDays` from the user's config files. */
	retentionDays?: number;
}

const USAGE = "Usage: ultrathink prune [--older-than <days>[d]] [--dry-run]";
const NO_CUTOFF = "no cutoff: pass --older-than <days> or set state.retentionDays";
const REFUSED = "refusing to prune everything: --older-than must be 1 to 3650 days";
const MAX_DAYS = 3650;
const LISTED_SESSIONS = 20;
const LISTED_ERRORS = 20;

type Parsed = { ok: true; olderThan: string | undefined; dryRun: boolean } | { ok: false };

function parseArgs(args: string[]): Parsed {
	let olderThan: string | undefined;
	let dryRun = false;
	for (let index = 0; index < args.length; index++) {
		const arg = args[index] ?? "";
		if (arg === "--dry-run") dryRun = true;
		else if (arg === "--older-than") {
			const value = args[index + 1];
			if (value === undefined) return { ok: false };
			olderThan = value;
			index++;
		} else if (arg.startsWith("--older-than=")) olderThan = arg.slice("--older-than=".length);
		else return { ok: false };
	}
	return { ok: true, olderThan, dryRun };
}

/** A whole number of days from 1 to 3650, optionally suffixed `d`; undefined for anything else. */
function parseDays(value: string): number | undefined {
	const match = /^(\d+)d?$/.exec(value.trim());
	if (!match) return undefined;
	const days = Number(match[1]);
	return days >= 1 && days <= MAX_DAYS ? days : undefined;
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function render(result: PruneResult, days: number, stateDir: string): string {
	const lines = [
		`${result.dryRun ? "Would prune" : "Pruned"} ${plural(result.pruned.length, "session")} (${formatBytes(
			result.pruned.reduce((sum, session) => sum + session.bytes, 0),
		)}) older than ${days} days from ${stateDir}`,
	];
	if (result.dryRun) {
		for (const session of result.pruned.slice(0, LISTED_SESSIONS)) {
			lines.push(`  ${session.id}  ${formatBytes(session.bytes)}  ${session.ageDays}d`);
		}
		if (result.pruned.length > LISTED_SESSIONS) lines.push(`  and ${result.pruned.length - LISTED_SESSIONS} more`);
	}
	lines.push(`Kept ${result.kept} (${plural(result.keptActive, "active ship")})`);
	lines.push(`${result.dryRun ? "Would remove" : "Removed"} ${plural(result.orphans.length, "leftover temporary or lock item")}`);
	for (const error of result.errors.slice(0, LISTED_ERRORS)) lines.push(`error: ${error}`);
	if (result.errors.length > LISTED_ERRORS) lines.push(`and ${result.errors.length - LISTED_ERRORS} more errors`);
	return lines.join("\n");
}

/** `ultrathink prune`. Exit 0 ok, 1 when a file could not be removed, 2 for a usage error or a refused cutoff. */
export async function runPruneCommand(args: string[], deps: PruneCommandDeps = {}): Promise<PruneCommandResult> {
	const parsed = parseArgs(args);
	if (!parsed.ok) return { output: USAGE, exitCode: 2 };
	const env = deps.env ?? process.env;
	let days: number | undefined;
	if (parsed.olderThan !== undefined) {
		days = parseDays(parsed.olderThan);
		if (days === undefined) return { output: REFUSED, exitCode: 2 };
	} else {
		const configured = deps.retentionDays ?? loadConfig(claudeConfigPaths(deps.cwd ?? process.cwd(), env)).state.retentionDays;
		if (configured > 0) days = configured;
	}
	if (days === undefined) return { output: NO_CUTOFF, exitCode: 2 };
	const stateDir = deps.stateDir ?? resolveStateDir(env);
	const result = pruneSessions({
		stateDir,
		olderThanMs: days * 86_400_000,
		dryRun: parsed.dryRun,
		now: deps.now,
	});
	return { output: render(result, days, stateDir), exitCode: result.errors.length > 0 ? 1 : 0 };
}
