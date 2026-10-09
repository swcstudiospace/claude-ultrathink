// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildReport, formatReport, reportJson } from "./report.ts";
import { checkState } from "./state-check.ts";
import type { DoctorDeps, Finding } from "./types.ts";

const NOW = 1_800_000_000_000;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const PROMPT = "TOP-SECRET-PROMPT-TEXT";
const RUNNING_AS_ROOT = process.getuid?.() === 0;

describe("checkState", () => {
	let dir: string;
	let stateDir: string;
	let deps: DoctorDeps;

	function ids(findings: Finding[]): string[] {
		return findings.map((finding) => finding.id);
	}

	function byId(findings: Finding[], id: string): Finding {
		const found = findings.find((finding) => finding.id === id);
		if (!found) throw new Error(`no finding ${id} in ${ids(findings).join(", ")}`);
		return found;
	}

	/** A file under the state directory with an explicit mode, size and age; content is a fake prompt padded to `size`. */
	function put(relative: string, options: { size?: number; mode?: number; ageMs?: number } = {}): string {
		const path = join(stateDir, relative);
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, JSON.stringify({ prompt: PROMPT }).padEnd(options.size ?? 40, " "));
		chmodSync(path, options.mode ?? 0o600);
		const when = (NOW - (options.ageMs ?? 0)) / 1000;
		utimesSync(path, when, when);
		return path;
	}

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "ut-doctor-state-"));
		stateDir = join(dir, "state");
		deps = {
			env: { HOME: join(dir, "home"), ULTRATHINK_STATE_DIR: stateDir },
			cwd: join(dir, "project"),
			now: () => NOW,
			which: () => undefined,
			bunVersion: "1.2.0",
			runVersion: () => undefined,
		};
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("a state directory that does not exist yet is info", () => {
		const findings = checkState(deps);
		expect(findings).toHaveLength(1);
		expect(findings[0]).toMatchObject({ id: "state.dir", level: "info", section: "state" });
		expect(findings[0]?.title).toContain(stateDir);
		expect(findings[0]?.detail).toBe("It is created on the first planned prompt.");
	});

	test("an empty writable directory is ok and has no sessions", () => {
		mkdirSync(stateDir);
		const findings = checkState(deps);
		expect(byId(findings, "state.dir")).toMatchObject({ level: "ok", title: `State directory is writable: ${stateDir}` });
		expect(byId(findings, "state.sessions")).toMatchObject({ level: "info", title: "No session records yet" });
		expect(ids(findings)).toEqual(["state.dir", "state.sessions"]);
	});

	test("a state path that is a file is an error", () => {
		writeFileSync(stateDir, "");
		expect(byId(checkState(deps), "state.dir")).toMatchObject({ level: "error", title: `State path is not a directory: ${stateDir}` });
	});

	test("a symlinked state directory is followed", () => {
		const target = join(dir, "real-state");
		mkdirSync(target);
		symlinkSync(target, stateDir);
		put("sessions/a.json", { size: 100 });
		const findings = checkState(deps);
		expect(byId(findings, "state.dir")).toMatchObject({ level: "ok", title: `State directory is writable: ${stateDir}` });
		expect(byId(findings, "state.sessions").title).toBe("1 session record, 100 B, oldest under an hour old");
	});

	test("a sessions path that is a file is an error with no healthy summary", () => {
		mkdirSync(stateDir);
		const sessionsDir = join(stateDir, "sessions");
		writeFileSync(sessionsDir, "not a directory");
		const findings = checkState(deps);
		expect(byId(findings, "state.dir")).toMatchObject({ level: "ok" });
		expect(byId(findings, "state.sessions")).toMatchObject({
			level: "error",
			title: `Sessions path is not a directory: ${sessionsDir}`,
		});
		expect(findings.filter((finding) => finding.id === "state.sessions")).toHaveLength(1);
	});

	test.skipIf(RUNNING_AS_ROOT)("a sessions directory the user cannot write to is an error", () => {
		const sessionsDir = join(stateDir, "sessions");
		mkdirSync(sessionsDir, { recursive: true });
		chmodSync(sessionsDir, 0o500);
		try {
			const finding = byId(checkState(deps), "state.sessions");
			expect(finding.level).toBe("error");
			expect(finding.title).toBe(`Sessions directory is not writable: ${sessionsDir}`);
			expect(finding.fix).toBe(`chmod u+rwx ${sessionsDir}`);
		} finally {
			chmodSync(sessionsDir, 0o700);
		}
	});

	test.skipIf(RUNNING_AS_ROOT)("a sessions directory that cannot be listed is an error", () => {
		const sessionsDir = join(stateDir, "sessions");
		mkdirSync(sessionsDir, { recursive: true });
		chmodSync(sessionsDir, 0o300);
		try {
			const finding = byId(checkState(deps), "state.sessions");
			expect(finding.level).toBe("error");
			expect(finding.title).toBe(`Sessions directory cannot be listed: ${sessionsDir}`);
		} finally {
			chmodSync(sessionsDir, 0o700);
		}
	});

	test.skipIf(RUNNING_AS_ROOT)("a directory the user cannot write to is an error", () => {
		mkdirSync(stateDir);
		chmodSync(stateDir, 0o500);
		try {
			const finding = byId(checkState(deps), "state.dir");
			expect(finding.level).toBe("error");
			expect(finding.title).toBe(`State directory is not writable: ${stateDir}`);
			expect(finding.fix).toBe(`chmod u+rwx ${stateDir}`);
		} finally {
			chmodSync(stateDir, 0o700);
		}
	});

	test("session count, total size and the oldest age come from file metadata", () => {
		put("sessions/a.json", { size: 1000, ageMs: 2 * DAY });
		put("sessions/b.json", { size: 2000, ageMs: 5 * DAY });
		put("sessions/c.json", { size: 3000, ageMs: HOUR });
		put("sessions/a.xml", { size: 9999, ageMs: 30 * DAY });
		const finding = byId(checkState(deps), "state.sessions");
		expect(finding).toMatchObject({ level: "info", title: "3 session records, 5.9 KB, oldest 5 days old" });
	});

	test("one fresh session is singular and ages under two days are in hours", () => {
		put("sessions/a.json", { size: 100, ageMs: 3 * HOUR });
		expect(byId(checkState(deps), "state.sessions").title).toBe("1 session record, 100 B, oldest 3 hours old");
		put("sessions/a.json", { size: 100, ageMs: 10 * 60 * 1000 });
		expect(byId(checkState(deps), "state.sessions").title).toBe("1 session record, 100 B, oldest under an hour old");
	});

	test("more than 500 sessions is a warning with the prune hint; 500 is not", () => {
		for (let index = 0; index < 500; index++) put(`sessions/s${index}.json`, { size: 10 });
		expect(byId(checkState(deps), "state.sessions").level).toBe("info");
		put("sessions/s500.json", { size: 10 });
		const finding = byId(checkState(deps), "state.sessions");
		expect(finding.level).toBe("warn");
		expect(finding.title).toContain("501 session records");
		expect(finding.title).toContain("above 500 sessions or 100 MB");
		expect(finding.fix).toContain("`ultrathink prune --older-than 30 --dry-run`");
	});

	test("more than 100 MB of sessions is a warning", () => {
		const path = put("sessions/big.json");
		truncateSync(path, 101 * 1024 * 1024);
		const finding = byId(checkState(deps), "state.sessions");
		expect(finding.level).toBe("warn");
		expect(finding.title).toContain("101.0 MB");
		expect(finding.fix).toContain("`ultrathink prune --older-than 30 --dry-run`");
	});

	test("both prune hints carry an explicit cutoff that works on the default config", () => {
		for (let index = 0; index < 501; index++) put(`sessions/hint${index}.json`, { size: 10 });
		put("sessions/stale.json.tmp", { ageMs: 2 * HOUR });
		const findings = checkState(deps);
		expect(byId(findings, "state.sessions").fix).toBe(
			"Run `ultrathink prune --older-than 30 --dry-run` to see what would be removed.",
		);
		expect(byId(findings, "state.orphans").fix).toBe(
			"Delete them when no ultrathink process is running, or run `ultrathink prune --older-than 30 --dry-run`.",
		);
	});

	test("session and carrier files readable by group or others are counted with the chmod fix", () => {
		put("sessions/loose.json", { mode: 0o644 });
		put("sessions/loose.xml", { mode: 0o640 });
		put("sessions/other.json", { mode: 0o604 });
		put("sessions/private.json", { mode: 0o600 });
		put("sessions/private.xml", { mode: 0o600 });
		put("last-plan.json", { mode: 0o644 });
		put("last.json", { mode: 0o600 });
		put("control.json", { mode: 0o644 });
		put("sessions/stale.tmp", { mode: 0o644 });
		const finding = byId(checkState(deps), "state.permissions");
		expect(finding).toMatchObject({
			level: "warn",
			title: "4 session or carrier files readable by group or others",
			fix: `chmod -R go-rwx ${stateDir}`,
		});
		expect(finding.detail).toContain("0600");
	});

	test("owner-only files raise no permission finding", () => {
		put("sessions/a.json");
		put("sessions/a.xml");
		put("last.json");
		put("last-plan.json");
		expect(ids(checkState(deps))).not.toContain("state.permissions");
	});

	test("temp and lock files older than one hour are orphans; younger ones and session files are not", () => {
		put("sessions/a.json.tmp", { ageMs: 2 * HOUR });
		put("sessions/b.json.lock", { ageMs: 90 * 60 * 1000 });
		mkdirSync(join(stateDir, "sessions", "c.lock"));
		utimesSync(join(stateDir, "sessions", "c.lock"), (NOW - 3 * HOUR) / 1000, (NOW - 3 * HOUR) / 1000);
		put("sessions/d.json.tmp", { ageMs: 10 * 60 * 1000 });
		put("sessions/e.json", { ageMs: 5 * HOUR });
		const findings = checkState(deps);
		expect(byId(findings, "state.orphans")).toMatchObject({
			level: "warn",
			title: "3 leftover .tmp or .lock files older than one hour in sessions/",
		});
		expect(byId(findings, "state.sessions").title).toStartWith("1 session record,");
	});

	test("no orphan finding when nothing is stale", () => {
		put("sessions/a.json.tmp", { ageMs: 5 * 60 * 1000 });
		expect(ids(checkState(deps))).not.toContain("state.orphans");
	});

	test("session content and session names never reach the report", () => {
		put("sessions/secret-session-name.json", { mode: 0o644 });
		put("sessions/secret-session-name.xml", { mode: 0o644 });
		put("sessions/secret-session-name.json.tmp", { ageMs: 5 * HOUR });
		const report = buildReport(checkState(deps));
		for (const output of [formatReport(report), reportJson(report)]) {
			expect(output).not.toContain(PROMPT);
			expect(output).not.toContain("secret-session-name");
		}
		expect(report.summary.warn).toBe(2);
	});
});
