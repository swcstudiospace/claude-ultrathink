// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
//
// Tests for deploy/ultrathink-restore.sh (restore, promote, drill). Every case works in a temp directory with real
// SQLite files written through the store and real tar archives. systemctl is a stub that logs its arguments, the
// readiness probe is a file:// URL or a stub curl that records its TLS arguments, and the off-host leg uses a stub age that copies its input (it exercises the
// drill's plumbing, not encryption). Nothing touches /etc, /var, a service, a timer or a production host; no test sleeps.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
	chmodSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	truncateSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { hasTool, makeStateDir, runDr, type StateDirSpec, type SystemctlStub } from "./dr-fixtures.ts";
import { createAuditLog, verifyAuditFile } from "./obs/audit.ts";
import { formatStamp } from "./store/snapshots.ts";
import { openStore } from "./store/store.ts";

const SCRIPT = "deploy/ultrathink-restore.sh";
const NOW = Date.parse("2026-10-20T12:00:00Z");
const T1 = Date.parse("2026-10-20T10:00:00Z");
const T2 = Date.parse("2026-10-20T11:00:00Z");
// Account that does not exist, so the service-user branch (compat as that user, chown) is never taken in tests.
const ABSENT_USER = "ultrathink-test-absent";
const SLOW = 30_000;

let work = "";

beforeAll(() => {
	work = mkdtempSync(join(tmpdir(), "dr-restore-test-"));
});

afterAll(() => {
	if (work) rmSync(work, { recursive: true, force: true });
});

interface Scenario {
	base: string;
	state: string;
	ring: string;
	backup: string;
	tmp: string;
	systemctl: SystemctlStub;
}

const DEFAULT_TIMERS = ["ultrathink-snapshot.timer", "ultrathink-maintenance.timer"];

/** A fresh case: a state directory from the real store (database closed), a stub systemctl and empty ring and backup. */
function scenario(spec: StateDirSpec = {}, opts: { webActive?: boolean; timers?: string[] } = {}): Scenario {
	const base = mkdtempSync(join(work, "case-"));
	const { dir, db } = makeStateDir(base, spec);
	db.close();
	const tmp = join(base, "tmp");
	mkdirSync(tmp);
	const active = [...(opts.webActive ? ["ultrathink-web"] : []), ...(opts.timers ?? DEFAULT_TIMERS)];
	return {
		base,
		state: dir,
		ring: join(base, "ring"),
		backup: join(base, "backup"),
		tmp,
		systemctl: systemctlWith(join(base, "bin"), active),
	};
}

/**
 * systemctl stub: `is-active` exits 0 only for the units in `active`; every call is appended to the log. The unit is the
 * third argument (`is-active --quiet <unit>`).
 */
function systemctlWith(base: string, active: string[]): SystemctlStub {
	mkdirSync(base, { recursive: true });
	const path = join(base, "systemctl");
	const log = join(base, "systemctl.log");
	writeFileSync(log, "");
	const script = [
		"#!/bin/sh",
		`printf '%s\\n' "$*" >> '${log}'`,
		'if [ "$1" = is-active ]; then',
		`  case " ${active.join(" ")} " in *" $3 "*) exit 0 ;; esac`,
		"  exit 3",
		"fi",
		"exit 0",
		"",
	].join("\n");
	writeFileSync(path, script);
	chmodSync(path, 0o755);
	return { path, log };
}

/** curl stub for the readiness probe: writes each argument on its own line to the log and exits 0. */
function curlStub(base: string): { dir: string; log: string } {
	const dir = join(base, "curl-bin");
	mkdirSync(dir, { recursive: true });
	const log = join(base, "curl.log");
	const path = join(dir, "curl");
	writeFileSync(path, ["#!/bin/sh", `for a in "$@"; do printf '%s\\n' "$a" >> '${log}'; done`, "exit 0", ""].join("\n"));
	chmodSync(path, 0o755);
	return { dir, log };
}

function envFor(s: Scenario, extra: Record<string, string> = {}): Record<string, string> {
	return {
		ULTRATHINK_STATE_DIR: s.state,
		ULTRATHINK_BACKUP_DIR: s.backup,
		ULTRATHINK_SNAPSHOT_DIR: s.ring,
		ULTRATHINK_SNAPSHOT_TREE: "0",
		ULTRATHINK_SYSTEMCTL: s.systemctl.path,
		ULTRATHINK_SERVICE_USER: ABSENT_USER,
		ULTRATHINK_DR_NOW_MS: String(NOW),
		TMPDIR: s.tmp,
		...extra,
	};
}

function restore(s: Scenario, args: string[], extra: Record<string, string> = {}) {
	return runDr(SCRIPT, ["restore", ...args], envFor(s, extra));
}

function vacuumInto(from: string, to: string): void {
	const db = new Database(from);
	try {
		db.run(`VACUUM INTO '${to.replaceAll("'", "''")}'`);
	} finally {
		db.close();
	}
}

/** Writes a ring snapshot for `ms` from the live database; with `tree`, the file layer beside it. Returns its name. */
function snapshot(s: Scenario, ms: number, opts: { tree?: boolean } = {}): string {
	mkdirSync(s.ring, { recursive: true });
	const stamp = formatStamp(ms);
	const name = `ultrathink-${stamp}.sqlite`;
	vacuumInto(join(s.state, "ultrathink.sqlite"), join(s.ring, name));
	if (opts.tree) {
		const tree = join(s.ring, "tree", `ultrathink-${stamp}`);
		mkdirSync(tree, { recursive: true });
		for (const file of ["oauth.json", "audit.jsonl"]) {
			if (existsSync(join(s.state, file))) cpSync(join(s.state, file), join(tree, file));
		}
		for (const dir of ["jobs", "sessions", "journal"]) {
			if (existsSync(join(s.state, dir))) cpSync(join(s.state, dir), join(tree, dir), { recursive: true });
		}
	}
	return name;
}

/** A ring file with a `runs` table that lacks owner_id: a real schema conflict for the release's openStore. */
function legacySnapshot(s: Scenario, ms: number): string {
	mkdirSync(s.ring, { recursive: true });
	const name = `ultrathink-${formatStamp(ms)}.sqlite`;
	const db = new Database(join(s.ring, name), { create: true });
	try {
		db.exec(
			"CREATE TABLE runs (id TEXT PRIMARY KEY, request TEXT NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL DEFAULT 0)",
		);
	} finally {
		db.close();
	}
	return name;
}

function addRuns(dbPath: string, count: number): void {
	const db = openStore(dbPath);
	try {
		for (let i = 0; i < count; i++) {
			db.createRun({ ownerId: "fixture-owner", request: `extra ${i}`, route: "fixture" });
		}
		db.checkpoint();
	} finally {
		db.close();
	}
}

function runCount(dbPath: string): number {
	const db = new Database(dbPath);
	try {
		const row = db.query<{ n: number }, []>("SELECT count(*) AS n FROM runs").get();
		if (!row) throw new Error("runs table returned no count row");
		return row.n;
	} finally {
		db.close();
	}
}

/** SHA-256 of every regular file under root, keyed by relative path. Directories are not listed. */
function fileSums(root: string): Record<string, string> {
	const out: Record<string, string> = {};
	if (!existsSync(root)) return out;
	const walk = (dir: string): void => {
		for (const name of readdirSync(dir).sort()) {
			const path = join(dir, name);
			if (statSync(path).isDirectory()) walk(path);
			else out[relative(root, path)] = createHash("sha256").update(readFileSync(path)).digest("hex");
		}
	};
	walk(root);
	return out;
}

function systemctlLog(s: Scenario): string[] {
	return readFileSync(s.systemctl.log, "utf8").split("\n").filter(Boolean);
}

function preRestoreDir(s: Scenario): string {
	const dirs = readdirSync(s.state).filter((name) => name.startsWith(".pre-restore-"));
	expect(dirs).toHaveLength(1);
	return join(s.state, dirs[0]!);
}

/** Sealed audit segment names, as the release writes them: audit-<first>-<last>.jsonl. */
const SEALED_RE = /^audit-[1-9]\d*-[1-9]\d*\.jsonl$/;

/**
 * Writes a real audit chain into `dir`, replacing audit.jsonl, with at least one sealed segment. Strings are capped at
 * 256 characters, so a record is about 500 bytes; 2500 records pass the 1 MiB segment minimum once.
 */
function sealedAuditChain(dir: string): void {
	rmSync(join(dir, "audit.jsonl"), { force: true });
	const log = createAuditLog({ path: join(dir, "audit.jsonl"), segmentBytes: 1_048_576 });
	try {
		const pad = "x".repeat(250);
		for (let i = 0; i < 2500; i++) log.record("login_ok", { fixture: i, pad });
	} finally {
		log.close();
	}
	if (!readdirSync(dir).some((name) => SEALED_RE.test(name))) throw new Error("no sealed segment was written");
}

/** Writes an archive in the layout W1-B produces under s.backup and returns its path. */
function archive(s: Scenario, ms: number, opts: { tamperAudit?: boolean } = {}): string {
	const stamp = formatStamp(ms);
	const name = `ultrathink-${stamp}`;
	const stageRoot = mkdtempSync(join(work, "stage-"));
	const stage = join(stageRoot, name);
	mkdirSync(stage);
	vacuumInto(join(s.state, "ultrathink.sqlite"), join(stage, "ultrathink.sqlite"));
	const sealed = readdirSync(s.state).filter((name) => SEALED_RE.test(name));
	for (const file of ["oauth.json", "audit.jsonl", ...sealed]) {
		if (existsSync(join(s.state, file))) cpSync(join(s.state, file), join(stage, file));
	}
	const dirs = ["jobs", "sessions", "journal"].filter((dir) => existsSync(join(s.state, dir)));
	for (const dir of dirs) cpSync(join(s.state, dir), join(stage, dir), { recursive: true });
	if (opts.tamperAudit) {
		const path = join(stage, "audit.jsonl");
		const lines = readFileSync(path, "utf8").split("\n");
		const edited = lines[1]!.replace(/"fixture":(\d+)/, '"fixture":4242');
		if (edited === lines[1]) throw new Error("tamper helper found no fixture field to change");
		lines[1] = edited;
		writeFileSync(path, lines.join("\n"));
	}
	writeFileSync(
		join(stage, "BACKUP_INFO"),
		`created_utc=${stamp}\nstate_dir=${s.state}\ndirs=${dirs.join(" ")}\nfiles=${["audit.jsonl", ...sealed].filter((file) => existsSync(join(stage, file))).join(" ")}\nrevision=unknown\n`,
	);
	const sums = Object.entries(fileSums(stage))
		.map(([rel, hash]) => `${hash}  ./${rel}`)
		.join("\n");
	writeFileSync(join(stage, "SHA256SUMS"), `${sums}\n`);
	mkdirSync(s.backup, { recursive: true });
	const out = join(s.backup, `${name}.tar.gz`);
	const tar = Bun.spawnSync({ cmd: ["tar", "-czf", out, "-C", stageRoot, name] });
	if (tar.exitCode !== 0) throw new Error(`tar failed: ${tar.stderr.toString()}`);
	return out;
}

/** Test stand-in for age: copies IN to OUT. It exercises the drill's off-host plumbing, not encryption. */
function stubAge(base: string): string {
	const path = join(base, "age-stub");
	writeFileSync(
		path,
		[
			"#!/bin/sh",
			"out=''; in=''",
			"while [ $# -gt 0 ]; do",
			'  case "$1" in',
			"    -o) out=\"$2\"; shift 2 ;;",
			"    -i|-r|-R) shift 2 ;;",
			"    --decrypt|--encrypt) shift ;;",
			'    *) in="$1"; shift ;;',
			"  esac",
			"done",
			'cp "$in" "$out"',
			"",
		].join("\n"),
	);
	chmodSync(path, 0o755);
	return path;
}

/** A readiness URL that answers: curl reads a file:// URL with -f, so the probe needs no server (spawnSync blocks one). */
function readyProbe(s: Scenario): string {
	const path = join(s.base, "ready");
	writeFileSync(path, "ready\n");
	return `file://${path}`;
}

// The restore, drill and timer suites run the host script, which needs GNU tools and systemd. They run on Linux only, as the backup and snapshot suites do.
describe.skipIf(process.platform !== "linux")("restore", () => {
	test(
		"refuses while ultrathink-web is active: exit 1, nothing moved, timers untouched",
		() => {
			const s = scenario({ runs: 2, oauth: true }, { webActive: true });
			snapshot(s, T1);
			const before = fileSums(s.state);

			const r = restore(s, ["--db-only", "--no-start"]);

			expect(r.code).toBe(1);
			expect(r.stderr).toContain("ultrathink-web is active");
			expect(fileSums(s.state)).toEqual(before);
			expect(systemctlLog(s).some((line) => line.startsWith("stop "))).toBe(false);
		},
		SLOW,
	);

	test(
		"--at picks the newest snapshot at or before the target",
		() => {
			const s = scenario({ runs: 2 });
			const older = snapshot(s, T1);
			addRuns(join(s.state, "ultrathink.sqlite"), 3);
			snapshot(s, T2);

			const r = restore(s, ["--at", "2026-10-20T10:30:00Z", "--db-only", "--no-start"]);

			expect(r.code).toBe(0);
			expect(r.stdout).toContain(`source ${older}`);
			expect(runCount(join(s.state, "ultrathink.sqlite"))).toBe(2);
		},
		SLOW,
	);

	test(
		"--at before the first snapshot exits 1 and changes nothing",
		() => {
			const s = scenario({ runs: 2 });
			snapshot(s, T1);
			const before = fileSums(s.state);

			const r = restore(s, ["--at", "2026-10-20T09:00:00Z", "--db-only", "--no-start"]);

			expect(r.code).toBe(1);
			expect(r.stderr).toContain("no snapshot at or before");
			expect(fileSums(s.state)).toEqual(before);
		},
		SLOW,
	);

	test(
		"--at with an out-of-range time (12:60) is refused: exit 1, nothing changed",
		() => {
			const s = scenario({ runs: 2 });
			snapshot(s, T1);
			const before = fileSums(s.state);

			const r = restore(s, ["--at", "2026-10-20T12:60:00Z", "--db-only", "--no-start"]);

			expect(r.code).toBe(1);
			expect(r.stderr).toContain("cannot read --at");
			expect(fileSums(s.state)).toEqual(before);
		},
		SLOW,
	);

	test(
		"an archive with audit.jsonl and sealed segments restores all of them, and stale host segments are moved aside",
		() => {
			const s = scenario({ runs: 2 });
			sealedAuditChain(s.state);
			const chain = readdirSync(s.state).filter((name) => name === "audit.jsonl" || SEALED_RE.test(name));
			expect(chain.some((name) => SEALED_RE.test(name))).toBe(true);
			const expected = chain.map((name) => ({ name, text: readFileSync(join(s.state, name), "utf8") }));
			const arch = archive(s, T1);
			// A stale host segment the archive does not hold: restore moves it aside with the rest of the chain.
			writeFileSync(join(s.state, "audit-1-2.jsonl"), "stale host segment");

			const r = restore(s, ["--archive", arch, "--no-start"]);

			expect(r.code).toBe(0);
			for (const { name, text } of expected) {
				expect(readFileSync(join(s.state, name), "utf8")).toBe(text);
			}
			for (const { name } of expected.filter(({ name }) => SEALED_RE.test(name))) {
				expect(statSync(join(s.state, name)).mode & 0o777).toBe(0o400);
			}
			expect(existsSync(join(s.state, "audit-1-2.jsonl"))).toBe(false);
			expect(readFileSync(join(preRestoreDir(s), "audit-1-2.jsonl"), "utf8")).toBe("stale host segment");
			expect(verifyAuditFile(join(s.state, "audit.jsonl")).ok).toBe(true);
		},
		SLOW,
	);

	test(
		"stale -wal and -shm files are moved to .pre-restore and are gone from the state directory",
		() => {
			const s = scenario({ runs: 2 });
			snapshot(s, T1);
			writeFileSync(join(s.state, "ultrathink.sqlite-wal"), "stale wal frames");
			writeFileSync(join(s.state, "ultrathink.sqlite-shm"), "stale shm");

			const r = restore(s, ["--db-only", "--no-start"]);

			expect(r.code).toBe(0);
			expect(existsSync(join(s.state, "ultrathink.sqlite-wal"))).toBe(false);
			expect(existsSync(join(s.state, "ultrathink.sqlite-shm"))).toBe(false);
			const pre = preRestoreDir(s);
			expect(readFileSync(join(pre, "ultrathink.sqlite-wal"), "utf8")).toBe("stale wal frames");
			expect(readFileSync(join(pre, "ultrathink.sqlite-shm"), "utf8")).toBe("stale shm");
		},
		SLOW,
	);

	test(
		"a full restore places the snapshot and its files with modes, keeps the previous state byte for byte, and prints timings",
		() => {
			const s = scenario({ runs: 2, audit: 3, oauth: true, tree: true });
			const originalOauth = readFileSync(join(s.state, "oauth.json"));
			snapshot(s, T1, { tree: true });
			// The live state moves on after the snapshot was taken.
			writeFileSync(join(s.state, "oauth.json"), '{"live":true}\n');
			writeFileSync(join(s.state, "jobs", "extra.json"), "{}\n");
			const before = fileSums(s.state);

			const r = restore(s, ["--no-start"], { ULTRATHINK_SNAPSHOT_TREE: "1" });

			expect(r.code).toBe(0);
			expect(r.stdout).toMatch(/^step verify \d+ms$/m);
			expect(r.stdout).toMatch(/^step place \d+ms$/m);
			expect(r.stdout).toMatch(/^step total \d+ms$/m);
			expect(readFileSync(join(s.state, "oauth.json"))).toEqual(originalOauth);
			expect(existsSync(join(s.state, "jobs", "extra.json"))).toBe(false);
			expect(statSync(join(s.state, "oauth.json")).mode & 0o777).toBe(0o600);
			expect(statSync(join(s.state, "jobs")).mode & 0o777).toBe(0o700);
			expect(runCount(join(s.state, "ultrathink.sqlite"))).toBe(2);
			expect(fileSums(preRestoreDir(s))).toEqual(before);
			const log = systemctlLog(s);
			expect(log).toContain("start ultrathink-snapshot.timer");
			expect(log).toContain("start ultrathink-maintenance.timer");
			expect(log.some((line) => line.startsWith("start ultrathink-web"))).toBe(false);
		},
		SLOW,
	);

	test(
		"a schema conflict fails the compat check and leaves the state byte-identical",
		() => {
			const s = scenario({ runs: 2, oauth: true });
			legacySnapshot(s, T1);
			const before = fileSums(s.state);

			const r = restore(s, ["--db-only", "--no-start"]);

			expect(r.code).toBe(1);
			expect(r.stderr).toContain("owner_id");
			expect(fileSums(s.state)).toEqual(before);
			expect(readdirSync(s.state).some((name) => name.startsWith(".pre-restore-"))).toBe(false);
			const log = systemctlLog(s);
			expect(log).toContain("stop ultrathink-snapshot.timer");
			expect(log).toContain("start ultrathink-snapshot.timer");
		},
		SLOW,
	);

	test(
		"a broken audit chain in the source exits 1 and leaves state untouched, even with regenerated checksums",
		() => {
			const src = scenario({ runs: 2, audit: 3, oauth: true, tree: true });
			const tampered = archive(src, T1, { tamperAudit: true });
			const s = scenario({ runs: 1, audit: 3 });
			const before = fileSums(s.state);

			const r = restore(s, ["--archive", tampered, "--no-start"]);

			expect(r.code).toBe(1);
			expect(`${r.stdout}${r.stderr}`).toContain("audit");
			expect(fileSums(s.state)).toEqual(before);
		},
		SLOW,
	);

	test(
		"promote without --origin-fenced exits 2 and changes nothing",
		() => {
			const s = scenario({ runs: 2 });
			snapshot(s, T1);
			const before = fileSums(s.state);

			const r = runDr(SCRIPT, ["promote", "--db-only"], envFor(s));

			expect(r.code).toBe(2);
			expect(r.stderr).toContain("--origin-fenced");
			expect(fileSums(s.state)).toEqual(before);
			expect(systemctlLog(s)).toEqual([]);
		},
		SLOW,
	);

	test(
		"a restore from a plaintext archive restores the runs the archive holds",
		() => {
			const src = scenario({ runs: 4, audit: 3, oauth: true, tree: true });
			const path = archive(src, T1);
			const s = scenario({ runs: 1 });

			const r = restore(s, ["--archive", path, "--no-start"]);

			expect(r.code).toBe(0);
			expect(r.stdout).toContain("source ultrathink-");
			expect(runCount(join(s.state, "ultrathink.sqlite"))).toBe(4);
			expect(existsSync(join(s.state, "audit.jsonl"))).toBe(true);
		},
		SLOW,
	);

	test.skipIf(!hasTool("curl"))(
		"without --no-start the web unit is started and probed before the restore reports ok",
		() => {
			const s = scenario({ runs: 2 });
			snapshot(s, T1);
			const probeUrl = readyProbe(s);
			const r = restore(s, ["--db-only"], { ULTRATHINK_PROBE_URL: probeUrl });

			expect(r.code).toBe(0);
			expect(r.stdout).toMatch(/^step probe \d+ms$/m);
			expect(systemctlLog(s)).toContain("start ultrathink-web");
		},
		SLOW,
	);

	test.skipIf(!hasTool("curl"))(
		"promote with --origin-fenced restores, starts and probes the web unit, and writes a promotion marker",
		() => {
			const s = scenario({ runs: 2 });
			const name = snapshot(s, T1);
			const probeUrl = readyProbe(s);
			const r = runDr(
				SCRIPT,
				["promote", "--origin-fenced", "--db-only", "--snapshot", name],
				envFor(s, { ULTRATHINK_PROBE_URL: probeUrl }),
			);

			expect(r.code).toBe(0);
			const markers = readdirSync(s.state).filter((entry) => entry.startsWith(".promoted-"));
			expect(markers).toHaveLength(1);
			expect(readFileSync(join(s.state, markers[0]!), "utf8")).toContain(`source=${name}`);
			expect(systemctlLog(s)).toContain("start ultrathink-web");
		},
		SLOW,
	);
});

describe.skipIf(process.platform !== "linux")("drill", () => {
	test(
		"a good ring snapshot passes the local leg, reports the off-host leg as SKIPPED, and removes its scratch",
		() => {
			const s = scenario({ runs: 3 });
			snapshot(s, T1);
			const before = fileSums(s.state);

			const r = runDr(SCRIPT, ["drill"], envFor(s));

			expect(r.code).toBe(0);
			expect(r.stdout).toContain("drill: local PASS, offhost SKIPPED");
			expect(fileSums(s.state)).toEqual(before);
			expect(readdirSync(s.tmp)).toEqual([]);
		},
		SLOW,
	);

	test(
		"a truncated newest ring snapshot fails the local leg",
		() => {
			const s = scenario({ runs: 3 });
			snapshot(s, T1);
			const newest = snapshot(s, T2);
			const path = join(s.ring, newest);
			truncateSync(path, Math.floor(statSync(path).size / 2));

			const r = runDr(SCRIPT, ["drill"], envFor(s));

			expect(r.code).toBe(1);
			expect(r.stdout).toContain("drill: local FAIL, offhost SKIPPED");
			expect(readdirSync(s.tmp)).toEqual([]);
		},
		SLOW,
	);

	test(
		"with an identity, a good off-host copy passes and a damaged newer copy fails the off-host leg",
		() => {
			const s = scenario({ runs: 3 });
			const local = snapshot(s, T1);
			const age = stubAge(s.base);
			const identity = join(s.base, "identity.txt");
			writeFileSync(identity, "test identity, not a key\n");
			const offhost = join(s.ring, ".offhost");
			mkdirSync(offhost, { recursive: true });
			const good = `ultrathink-${formatStamp(T1)}.sqlite.age`;
			cpSync(join(s.ring, local), join(offhost, good));
			const env = envFor(s, { ULTRATHINK_AGE: age, ULTRATHINK_AGE_IDENTITY: identity });

			const pass = runDr(SCRIPT, ["drill"], env);
			expect(pass.code).toBe(0);
			expect(pass.stdout).toContain("drill: local PASS, offhost PASS");

			const newer = `ultrathink-${formatStamp(T2)}.sqlite.age`;
			cpSync(join(offhost, good), join(offhost, newer));
			truncateSync(join(offhost, newer), Math.floor(statSync(join(offhost, newer)).size / 2));

			const fail = runDr(SCRIPT, ["drill"], env);
			expect(fail.code).toBe(1);
			expect(fail.stdout).toContain("drill: local PASS, offhost FAIL");
			expect(readdirSync(s.tmp)).toEqual([]);
		},
		SLOW,
	);
});

describe.skipIf(process.platform !== "linux")("restore timers and readiness probe", () => {
	test(
		"a host where the snapshot timer was inactive leaves it inactive: never started, stopped or enabled",
		() => {
			const s = scenario({ runs: 2 }, { timers: ["ultrathink-maintenance.timer"] });
			snapshot(s, T1);

			const r = restore(s, ["--db-only", "--no-start"]);

			expect(r.code).toBe(0);
			const log = systemctlLog(s);
			expect(log).not.toContain("start ultrathink-snapshot.timer");
			expect(log.some((line) => line.startsWith("stop ultrathink-snapshot"))).toBe(false);
			expect(log.some((line) => line.startsWith("enable"))).toBe(false);
			expect(log).toContain("start ultrathink-maintenance.timer");
		},
		SLOW,
	);

	test(
		"the readiness probe is https with the ops identity from the TLS directory and never runs insecure",
		() => {
			const s = scenario({ runs: 2 });
			snapshot(s, T1);
			const tls = join(s.base, "tls");
			mkdirSync(join(tls, "ops"), { recursive: true });
			for (const file of ["ca.pem", "ops/cert.pem", "ops/key.pem"]) writeFileSync(join(tls, file), "fixture\n");
			const curl = curlStub(s.base);

			const r = restore(s, ["--db-only"], {
				PATH: `${curl.dir}:${process.env.PATH ?? "/usr/bin:/bin"}`,
				ULTRATHINK_TLS_DIR: tls,
				ULTRATHINK_PORT: "8795",
			});

			expect(r.code).toBe(0);
			expect(r.stdout).toMatch(/^step probe \d+ms$/m);
			const args = readFileSync(curl.log, "utf8").split("\n").filter(Boolean);
			const valueOf = (flag: string) => args[args.indexOf(flag) + 1];
			expect(valueOf("--cacert")).toBe(join(tls, "ca.pem"));
			expect(valueOf("--cert")).toBe(join(tls, "ops", "cert.pem"));
			expect(valueOf("--key")).toBe(join(tls, "ops", "key.pem"));
			expect(args).not.toContain("-k");
			expect(args).not.toContain("--insecure");
			expect(args.at(-1)).toBe("https://127.0.0.1:8795/readyz");
		},
		SLOW,
	);
});
