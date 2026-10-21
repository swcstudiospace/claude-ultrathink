// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

// Test helpers shared by the Phase 74 disaster-recovery tests. State directories are built through the release's
// `openStore` (SQLite in WAL mode) and `createAuditLog`, so every consumer test runs against real SQLite and a real
// audit chain. Nothing here mocks the store or the file system. Callers pass a temp base; nothing is written elsewhere.

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { auditPath, createAuditLog } from "./obs/audit.ts";
import { openStore, type Store } from "./store/store.ts";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const DEFAULT_AUDIT_RECORDS = 3;
const TREE_SUBDIRS = ["jobs", "sessions", "journal"] as const;

export interface StateDirSpec {
	/** Runs inserted through `store.createRun`. Default 0. */
	runs?: number;
	/** Records appended to `audit.jsonl`. `true` means 3 records; a number is the count. Default 0: no audit file. */
	audit?: number | boolean;
	/** Writes one JSON file each under `jobs/`, `sessions/` and `journal/`. Default false. */
	tree?: boolean;
	/** Writes `oauth.json` with mode 0600. Default false. */
	oauth?: boolean;
}

export interface StateDir {
	/** The state directory: holds `ultrathink.sqlite` and whatever the spec asked for. */
	dir: string;
	/** The open store. The caller closes it. */
	db: Store;
}

export interface DrResult {
	code: number;
	stdout: string;
	stderr: string;
}

export interface SystemctlStub {
	/** Executable to set as `ULTRATHINK_SYSTEMCTL`. */
	path: string;
	/** File that receives one line per invocation: the argv joined by spaces. */
	log: string;
}

let scratchHome: string | undefined;

function countOf(value: number | undefined, name: string): number {
	const n = value ?? 0;
	if (!Number.isInteger(n) || n < 0) throw new RangeError(`makeStateDir: ${name} must be a non-negative integer`);
	return n;
}

function auditCountOf(value: number | boolean | undefined): number {
	if (value === true) return DEFAULT_AUDIT_RECORDS;
	if (value === false || value === undefined) return 0;
	return countOf(value, "audit");
}

/**
 * Builds a state directory under `base` with the real store. The database is checkpointed before return, so a raw
 * copy of `ultrathink.sqlite` already holds every inserted run.
 */
export function makeStateDir(base: string, spec: StateDirSpec = {}): StateDir {
	const runCount = countOf(spec.runs, "runs");
	const auditCount = auditCountOf(spec.audit);
	mkdirSync(base, { recursive: true });
	const dir = mkdtempSync(join(base, "state-"));
	const db = openStore(join(dir, "ultrathink.sqlite"));
	try {
		for (let i = 0; i < runCount; i++) {
			db.createRun({ ownerId: "fixture-owner", request: `fixture request ${i}`, route: "fixture" });
		}
		if (auditCount > 0) {
			const log = createAuditLog({ path: auditPath(dir) });
			try {
				for (let i = 0; i < auditCount; i++) log.record("login_ok", { fixture: i });
			} finally {
				log.close();
			}
		}
		if (spec.tree) {
			for (const sub of TREE_SUBDIRS) {
				mkdirSync(join(dir, sub));
				writeFileSync(join(dir, sub, `${sub}-0001.json`), `${JSON.stringify({ fixture: sub })}\n`);
			}
		}
		if (spec.oauth) {
			writeFileSync(join(dir, "oauth.json"), `${JSON.stringify({ fixture: "oauth" }, null, 2)}\n`, { mode: 0o600 });
		}
		db.checkpoint();
	} catch (error) {
		db.close();
		throw error;
	}
	return { dir, db };
}

/** One HOME per test process, so the script never reads the developer's real home. */
function fixtureHome(): string {
	scratchHome ??= mkdtempSync(join(tmpdir(), "ultrathink-dr-home-"));
	return scratchHome;
}

/**
 * Runs `bash <repo>/<scriptRelPath> ...args` synchronously with a clean environment: `PATH`, a temp `HOME`,
 * `ULTRATHINK_ENV_FILE=/nonexistent` and `ULTRATHINK_BUN` set to this runtime. `env` overrides any of them.
 * `code` is -1 when the process ended without an exit code (killed by a signal).
 */
export function runDr(scriptRelPath: string, args: readonly string[], env: Record<string, string> = {}): DrResult {
	const proc = Bun.spawnSync({
		cmd: ["bash", join(REPO_ROOT, scriptRelPath), ...args],
		env: {
			PATH: process.env.PATH ?? "/usr/bin:/bin",
			HOME: fixtureHome(),
			ULTRATHINK_ENV_FILE: join(fixtureHome(), "ultrathink.env"),
			ULTRATHINK_BUN: process.execPath,
			...env,
		},
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	return {
		code: proc.exitCode ?? -1,
		stdout: proc.stdout.toString(),
		stderr: proc.stderr.toString(),
	};
}

/**
 * Writes `base/systemctl`: an executable that appends its argv to `base/systemctl.log` and exits 0. For
 * `is-active` it exits 0 when `active` is true and 3 otherwise. The log is truncated on every call.
 */
export function stubSystemctl(base: string, opts: { active: boolean }): SystemctlStub {
	mkdirSync(base, { recursive: true });
	const path = join(base, "systemctl");
	const log = join(base, "systemctl.log");
	writeFileSync(log, "");
	const activeExit = opts.active ? 0 : 3;
	const script = [
		"#!/bin/sh",
		`printf '%s\\n' "$*" >> '${log.replace(/'/g, "'\\''")}'`,
		`if [ "$1" = is-active ]; then exit ${activeExit}; fi`,
		"exit 0",
		"",
	].join("\n");
	writeFileSync(path, script);
	chmodSync(path, 0o755);
	return { path, log };
}

/** True when `name` resolves on PATH. */
export function hasTool(name: string): boolean {
	return Bun.which(name) !== null;
}

/**
 * Sorted, de-duplicated names in a snapshot directory and in its `tree/` subdirectory. `dir` is the snapshot
 * directory (`ULTRATHINK_SNAPSHOT_DIR`). The `tree` entry itself is excluded. Hidden entries (`.tmp-*`, `.offhost`)
 * are included so tests can assert their absence. Returns `[]` when `dir` does not exist.
 */
export function ringNames(dir: string): string[] {
	const names = new Set<string>();
	for (const listing of [dir, join(dir, "tree")]) {
		if (!existsSync(listing)) continue;
		for (const name of readdirSync(listing)) if (listing !== dir || name !== "tree") names.add(name);
	}
	return [...names].sort();
}
