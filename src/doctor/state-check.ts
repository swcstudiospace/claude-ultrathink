// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Report on the host state directory from file metadata alone: existence, writability, how many session records there
 * are and how large, which files other users can read, and leftovers of a crashed write. Session records hold the user's
 * prompts, so this module only `stat`s them: it never opens, reads or prints one, and it prints no file name from them.
 */
import { accessSync, constants, lstatSync, readdirSync, statSync, type Stats } from "node:fs";
import { join } from "node:path";
import { defaultStateDir } from "../claude/state.ts";
import type { DoctorDeps, Finding } from "./types.ts";

const MAX_SESSIONS = 500;
const MAX_SESSION_BYTES = 100 * 1024 * 1024;
const ORPHAN_AGE_MS = 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
/** Group- or other-readable permission bits. */
const LOOSE_MODE = 0o044;
/** State and control files written next to `sessions/`. */
const CARRIER_FILES = ["last.json", "last-plan.json", "control.json"] as const;

function statOrUndefined(path: string): Stats | undefined {
	try {
		return lstatSync(path);
	} catch {
		return undefined;
	}
}

/**
 * The root state directory follows links: a symlinked state dir is a working setup, so `statSync` tests the target.
 * Session entries keep `lstatSync` above so a link inside `sessions/` is never counted as a record.
 */
function statFollowOrUndefined(path: string): Stats | undefined {
	try {
		return statSync(path);
	} catch {
		return undefined;
	}
}

function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatAge(ms: number): string {
	if (ms < HOUR_MS) return "under an hour";
	if (ms < 2 * DAY_MS) return `${Math.floor(ms / HOUR_MS)} hours`;
	return `${Math.floor(ms / DAY_MS)} days`;
}

function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** Existence, writability, session count and size, loose permissions and orphaned temp or lock files. Never throws. */
export function checkState(deps: DoctorDeps): Finding[] {
	const dir = defaultStateDir(deps.env);
	const findings: Finding[] = [];
	const add = (finding: Omit<Finding, "section">): void => {
		findings.push({ section: "state", ...finding });
	};

	const dirStat = statFollowOrUndefined(dir);
	if (!dirStat) {
		add({
			id: "state.dir",
			level: "info",
			title: `State directory does not exist yet: ${dir}`,
			detail: "It is created on the first planned prompt.",
		});
		return findings;
	}
	if (!dirStat.isDirectory()) {
		add({ id: "state.dir", level: "error", title: `State path is not a directory: ${dir}`, fix: "Remove it or point ULTRATHINK_STATE_DIR elsewhere." });
		return findings;
	}
	try {
		accessSync(dir, constants.W_OK | constants.X_OK);
		add({ id: "state.dir", level: "ok", title: `State directory is writable: ${dir}` });
	} catch {
		add({
			id: "state.dir",
			level: "error",
			title: `State directory is not writable: ${dir}`,
			detail: "No plan, control change or session record can be saved.",
			fix: `chmod u+rwx ${dir}`,
		});
	}

	const sessionsDir = join(dir, "sessions");
	let names: string[] = [];
	let sessionsUsable = true;
	const sessionsEntry = statOrUndefined(sessionsDir);
	const sessionsStat = sessionsEntry === undefined ? undefined : statFollowOrUndefined(sessionsDir);
	if (sessionsStat === undefined && sessionsEntry?.isSymbolicLink()) {
		add({
			id: "state.sessions",
			level: "error",
			title: `Sessions directory is a broken symlink: ${sessionsDir}`,
			detail: "No session record can be saved.",
			fix: `Remove ${sessionsDir} or point it at an existing directory.`,
		});
		sessionsUsable = false;
	} else if (sessionsStat !== undefined) {
		if (!sessionsStat.isDirectory()) {
			add({
				id: "state.sessions",
				level: "error",
				title: `Sessions path is not a directory: ${sessionsDir}`,
				detail: "No session record can be saved.",
				fix: `Remove ${sessionsDir} so it can be recreated as a directory.`,
			});
			sessionsUsable = false;
		} else {
			try {
				accessSync(sessionsDir, constants.W_OK | constants.X_OK);
			} catch {
				add({
					id: "state.sessions",
					level: "error",
					title: `Sessions directory is not writable: ${sessionsDir}`,
					detail: "No session record can be saved.",
					fix: `chmod u+rwx ${sessionsDir}`,
				});
				sessionsUsable = false;
			}
			if (sessionsUsable) {
				try {
					names = readdirSync(sessionsDir);
				} catch (error) {
					// A missing sessions directory is healthy and empty; any other listing failure means planning
					// cannot save records, so it is an error.
					const code =
						typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
							? error.code
							: undefined;
					if (code !== "ENOENT") {
						add({
							id: "state.sessions",
							level: "error",
							title: `Sessions directory cannot be listed: ${sessionsDir}`,
							detail: error instanceof Error ? error.message : String(error),
							fix: `chmod u+rwx ${sessionsDir}`,
						});
						sessionsUsable = false;
					}
				}
			}
		}
	}
	const now = deps.now();
	let sessions = 0;
	let bytes = 0;
	let oldest: number | undefined;
	let loose = 0;
	let orphans = 0;
	for (const name of names) {
		const stats = statOrUndefined(join(sessionsDir, name));
		if (!stats?.isFile()) continue;
		if (/\.(tmp|lock)$/.test(name)) {
			if (now - stats.mtimeMs > ORPHAN_AGE_MS) orphans++;
			continue;
		}
		if (name.endsWith(".json")) {
			sessions++;
			bytes += stats.size;
			oldest = oldest === undefined ? stats.mtimeMs : Math.min(oldest, stats.mtimeMs);
		}
		if ((name.endsWith(".json") || name.endsWith(".xml")) && stats.mode & LOOSE_MODE) loose++;
	}
	for (const name of CARRIER_FILES) {
		const stats = statOrUndefined(join(dir, name));
		if (stats?.isFile() && stats.mode & LOOSE_MODE) loose++;
	}
	try {
		for (const name of readdirSync(dir)) {
			if (!/\.(tmp|lock)$/.test(name)) continue;
			const stats = statOrUndefined(join(dir, name));
			if (stats?.isFile() && now - stats.mtimeMs > ORPHAN_AGE_MS) orphans++;
		}
	} catch {
		// Metadata-only diagnosis stays best-effort when the state root cannot be listed.
	}

	// When the sessions directory itself is broken an error above already explains why nothing could be counted.
	if (sessionsUsable && sessions === 0) {
		add({ id: "state.sessions", level: "info", title: "No session records yet" });
	} else if (sessionsUsable) {
		const age = oldest === undefined ? "" : `, oldest ${formatAge(now - oldest)} old`;
		const summary = `${plural(sessions, "session record")}, ${formatSize(bytes)}${age}`;
		if (sessions > MAX_SESSIONS || bytes > MAX_SESSION_BYTES) {
			add({
				id: "state.sessions",
				level: "warn",
				title: `${summary}: above ${MAX_SESSIONS} sessions or 100 MB`,
				detail: "Session records are kept until you remove them.",
				fix: "Run `ultrathink prune --older-than 30 --dry-run` to see what would be removed.",
			});
		} else {
			add({ id: "state.sessions", level: "info", title: summary });
		}
	}

	if (loose > 0) {
		add({
			id: "state.permissions",
			level: "warn",
			title: `${plural(loose, "session, carrier or control file")} readable by group or others`,
			detail: "They hold your prompts, plans and control settings. New files are written with mode 0600.",
			fix: `chmod -R go-rwx ${dir}`,
		});
	}
	if (orphans > 0) {
		add({
			id: "state.orphans",
			level: "warn",
			title: `${plural(orphans, "leftover .tmp or .lock file")} older than one hour in the state root or sessions/`,
			detail: "Leftovers of a write that crashed before it finished.",
			fix: "Delete them when no ultrathink process is running, or run `ultrathink prune --older-than 30 --dry-run`.",
		});
	}
	return findings;
}
