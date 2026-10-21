// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
//
// Tests for deploy/ultrathink-snapshot.sh (tick and status). Each case runs the script against a real SQLite state
// database built by makeStateDir, in a temp directory. Nothing here touches /etc, /var, a systemd unit or a production
// host. Cases that need rsync, age or flock are skipped, with a logged reason, when the tool is missing. No case sleeps:
// concurrency comes from a child process that stops when a file appears, and fixed clocks come from
// ULTRATHINK_DR_NOW_MS.
import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { hasTool, makeStateDir, ringNames, runDr } from "./dr-fixtures.ts";
import { formatStamp } from "./store/snapshots.ts";

const SCRIPT = "deploy/ultrathink-snapshot.sh";
const STORE = resolve(import.meta.dir, "store/store.ts");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
// Fixed "now" for the retention cases: 2026-10-21T12:00:00.000Z.
const NOW_MS = Date.UTC(2026, 9, 21, 12, 0, 0, 0);

const HAS_RSYNC = hasTool("rsync");
const HAS_FLOCK = hasTool("flock");
const HAS_AGE = hasTool("age") && hasTool("age-keygen");
if (!HAS_RSYNC) console.log("skip: rsync is not on PATH; the file layer and off-host cases are skipped");
if (!HAS_FLOCK) console.log("skip: flock is not on PATH; the busy-lock case is skipped");
if (!HAS_AGE) console.log("skip: age and age-keygen are not on PATH; the encrypted off-host case is skipped");

const bases: string[] = [];

afterAll(() => {
	for (const dir of bases) rmSync(dir, { recursive: true, force: true });
});

interface Fixture {
	base: string;
	state: string;
	backup: string;
	ring: string;
}

function newBase(): string {
	const base = mkdtempSync(join(tmpdir(), "dr-snapshot-"));
	bases.push(base);
	return base;
}

/** A state directory holding `runs` committed runs and `audit` audit records, plus an empty backup directory. */
function fixture(runs: number, audit = 0): Fixture {
	const base = newBase();
	const made = makeStateDir(base, { runs, audit });
	made.db.close();
	// Production state files are 0600 (the unit sets UMask=0077); the file-layer cases mirror that.
	if (audit > 0) chmodSync(join(made.dir, "audit.jsonl"), 0o600);
	const backup = join(base, "backup");
	return { base, state: made.dir, backup, ring: join(backup, "ring") };
}

function envFor(f: Fixture, extra: Record<string, string> = {}): Record<string, string> {
	return {
		ULTRATHINK_STATE_DIR: f.state,
		ULTRATHINK_BACKUP_DIR: f.backup,
		// The default floor is 1 GiB. Cases that do not test the disk guard lower it so small disks still run it.
		ULTRATHINK_SNAPSHOT_MIN_FREE_BYTES: "1",
		...extra,
	};
}

function tick(f: Fixture, extra: Record<string, string> = {}) {
	return runDr(SCRIPT, ["tick"], envFor(f, extra));
}

/** Ring snapshot files (ultrathink-<stamp>.sqlite), sorted. */
function snapshotFiles(ring: string): string[] {
	if (!existsSync(ring)) return [];
	return readdirSync(ring)
		.filter((name) => /^ultrathink-.+\.sqlite$/.test(name))
		.sort();
}

/** Tree directories (tree/ultrathink-<stamp>), sorted. */
function treeDirs(ring: string): string[] {
	const tree = join(ring, "tree");
	if (!existsSync(tree)) return [];
	return readdirSync(tree)
		.filter((name) => name.startsWith("ultrathink-"))
		.sort();
}

/** Ring and tree entries, and temporaries, that a failed tick must not leave behind. The lock file is not an entry. */
function leftovers(ring: string): string[] {
	return ringNames(ring).filter((name) => name.startsWith("ultrathink-") || name.startsWith(".tmp-"));
}

/** True when the database at `path` passes the pragma (quick_check or integrity_check). */
function passes(path: string, pragma: "quick_check" | "integrity_check"): boolean {
	const db = new Database(path);
	try {
		const rows = db.query(`PRAGMA ${pragma}`).all() as Record<string, unknown>[];
		return rows.length === 1 && Object.values(rows[0] ?? {})[0] === "ok";
	} finally {
		db.close();
	}
}

function countRuns(path: string): number {
	const db = new Database(path);
	try {
		// Our own SQL: count(*) always yields one row with an integer n, so the shape is known here.
		const row = db.query("SELECT count(*) AS n FROM runs").get() as { n: number };
		return row.n;
	} finally {
		db.close();
	}
}

/** Copies a real state database into the ring under the name a snapshot taken at `ms` would carry. */
function seedSnapshot(ring: string, ms: number, source: string): string {
	mkdirSync(ring, { recursive: true });
	const name = `ultrathink-${formatStamp(ms)}.sqlite`;
	copyFileSync(source, join(ring, name));
	return name;
}

async function waitForLine(stream: ReadableStream<Uint8Array>, text: string): Promise<void> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let seen = "";
	while (!seen.includes(text)) {
		const { value, done } = await reader.read();
		if (done) throw new Error(`stream ended before "${text}"`);
		seen += decoder.decode(value, { stream: true });
	}
	reader.releaseLock();
}

/**
 * A child process that inserts runs until `stopPath` exists. It has a hard cap, so a failing case cannot run forever,
 * and the case stops it in a finally block.
 */
function startWriter(dbPath: string, stopPath: string) {
	const code = `
(async () => {
	// The writer runs in its own process, so it loads the store with require rather than a static import.
	const { openStore } = require(${JSON.stringify(STORE)});
	const { existsSync } = require("node:fs");
	const db = openStore(${JSON.stringify(dbPath)});
	try {
		for (let i = 0; i < 20000 && !existsSync(${JSON.stringify(stopPath)}); i++) {
			db.createRun({ ownerId: "writer", request: "concurrent " + i, route: "fixture" });
		}
	} finally {
		db.close();
	}
})();
`;
	return Bun.spawn({ cmd: [process.execPath, "-e", code], stdout: "ignore", stderr: "pipe" });
}

describe("tick", () => {
	test("one tick adds one ring file that passes quick_check and holds the runs committed before it", () => {
		const f = fixture(3);
		const r = tick(f);
		expect(r.code).toBe(0);
		expect(r.stdout).toMatch(/snapshot ok ultrathink-\S+\.sqlite/);
		const files = snapshotFiles(f.ring);
		expect(files.length).toBe(1);
		const path = join(f.ring, files[0]!);
		expect(passes(path, "quick_check")).toBe(true);
		expect(countRuns(path)).toBe(3);
	});

	test("runs written during three ticks: every snapshot passes integrity, names are unique, run counts never fall", async () => {
		const f = fixture(1);
		const stateDb = join(f.state, "ultrathink.sqlite");
		const stop = join(f.base, "writer.stop");
		const writer = startWriter(stateDb, stop);
		try {
			for (let i = 0; i < 3; i++) {
				expect(tick(f).code).toBe(0);
			}
		} finally {
			writeFileSync(stop, "");
			await writer.exited;
		}
		// Proves the writer committed runs at all; the snapshots must then show them in stamp order.
		expect(countRuns(stateDb)).toBeGreaterThan(1);
		const files = snapshotFiles(f.ring);
		expect(files.length).toBe(3);
		expect(new Set(files).size).toBe(files.length);
		let previous = 0;
		for (const name of files) {
			const path = join(f.ring, name);
			expect(passes(path, "integrity_check")).toBe(true);
			const runs = countRuns(path);
			expect(runs).toBeGreaterThanOrEqual(previous);
			previous = runs;
		}
	});

	test("a missing state database exits 1 and leaves no snapshot or temp entry", () => {
		const base = newBase();
		const state = join(base, "state");
		mkdirSync(state);
		const backup = join(base, "backup");
		const r = runDr(SCRIPT, ["tick"], {
			ULTRATHINK_STATE_DIR: state,
			ULTRATHINK_BACKUP_DIR: backup,
			ULTRATHINK_SNAPSHOT_MIN_FREE_BYTES: "1",
		});
		expect(r.code).toBe(1);
		expect(r.stderr).toContain("no state database");
		expect(leftovers(join(backup, "ring"))).toEqual([]);
	});

	test("a copy error exits 1 and leaves no snapshot or temp entry", () => {
		const f = fixture(1);
		writeFileSync(join(f.state, "ultrathink.sqlite"), "this is not a sqlite database\n".repeat(64));
		const r = tick(f);
		expect(r.code).toBe(1);
		expect(leftovers(f.ring)).toEqual([]);
	});

	test("the disk guard refuses a snapshot when free space is below the floor, and writes nothing", () => {
		const f = fixture(1);
		const r = tick(f, { ULTRATHINK_SNAPSHOT_MIN_FREE_BYTES: "1000000000000000" });
		expect(r.code).toBe(1);
		expect(r.stderr).toContain("disk guard");
		expect(leftovers(f.ring)).toEqual([]);
	});

	test("retention removes a three-day-old snapshot and keeps a two-hour-old one and the new newest", () => {
		const f = fixture(2);
		const source = join(f.state, "ultrathink.sqlite");
		const old = seedSnapshot(f.ring, NOW_MS - 3 * DAY, source);
		const recent = seedSnapshot(f.ring, NOW_MS - 2 * HOUR, source);
		const r = tick(f, { ULTRATHINK_DR_NOW_MS: String(NOW_MS) });
		expect(r.code).toBe(0);
		const files = snapshotFiles(f.ring);
		expect(files).not.toContain(old);
		expect(files).toContain(recent);
		expect(files).toContain(`ultrathink-${formatStamp(NOW_MS)}.sqlite`);
	});

	test("a tick never sorts before an existing name, and a future-dated entry is kept", () => {
		const f = fixture(1);
		const source = join(f.state, "ultrathink.sqlite");
		const future = seedSnapshot(f.ring, NOW_MS + 60_000, source);
		const r = tick(f, { ULTRATHINK_DR_NOW_MS: String(NOW_MS) });
		expect(r.code).toBe(0);
		// The clock reads NOW, which is earlier than the seeded name, so the new name is that name plus 1 ms.
		const created = `ultrathink-${formatStamp(NOW_MS + 60_001)}.sqlite`;
		expect(snapshotFiles(f.ring)).toEqual([future, created].sort());
	});

	test.skipIf(!HAS_RSYNC)("off-host without a recipient pushes nothing, exits 1 and keeps the local snapshot", () => {
		const f = fixture(1);
		const remote = join(f.base, "remote");
		mkdirSync(join(remote, "ring"), { recursive: true });
		const r = tick(f, { ULTRATHINK_BACKUP_RSYNC_TARGET: `${remote}/` });
		expect(r.code).toBe(1);
		expect(r.stderr).toContain("refusing plaintext off-host");
		expect(readdirSync(join(remote, "ring"))).toEqual([]);
		expect(snapshotFiles(f.ring).length).toBe(1);
	});

	test.skipIf(!HAS_RSYNC || !HAS_AGE)(
		"off-host with a recipient pushes only age ciphertext, and it decrypts to a valid snapshot",
		() => {
			const f = fixture(2);
			const identity = join(f.base, "identity.txt");
			expect(Bun.spawnSync({ cmd: ["age-keygen", "-o", identity] }).exitCode).toBe(0);
			const recipient = Bun.spawnSync({ cmd: ["age-keygen", "-y", identity] }).stdout.toString().trim();
			const remote = join(f.base, "remote");
			mkdirSync(join(remote, "ring"), { recursive: true });
			const r = tick(f, { ULTRATHINK_BACKUP_RSYNC_TARGET: `${remote}/`, ULTRATHINK_BACKUP_RECIPIENT: recipient });
			expect(r.code).toBe(0);
			const pushed = readdirSync(join(remote, "ring"));
			expect(pushed.length).toBe(1);
			for (const name of pushed) {
				expect(name.endsWith(".sqlite.age")).toBe(true);
				const head = readFileSync(join(remote, "ring", name)).subarray(0, 15).toString();
				expect(head).not.toBe("SQLite format 3");
			}
			const plain = join(f.base, "decrypted.sqlite");
			const dec = Bun.spawnSync({
				cmd: ["age", "-d", "-i", identity, "-o", plain, join(remote, "ring", pushed[0]!)],
			});
			expect(dec.exitCode).toBe(0);
			expect(passes(plain, "quick_check")).toBe(true);
			expect(countRuns(plain)).toBe(2);
		},
	);

	test.skipIf(!HAS_RSYNC)("the file layer holds audit.jsonl byte for byte as it was at tick time", () => {
		const f = fixture(1, 3);
		const before = readFileSync(join(f.state, "audit.jsonl"));
		expect(tick(f).code).toBe(0);
		const trees = treeDirs(f.ring);
		expect(trees.length).toBe(1);
		expect(readFileSync(join(f.ring, "tree", trees[0]!, "audit.jsonl"))).toEqual(before);
	});

	test.skipIf(!HAS_RSYNC)("a file that did not change is hard-linked to the previous tree", () => {
		const f = fixture(1, 3);
		expect(tick(f).code).toBe(0);
		expect(tick(f).code).toBe(0);
		const trees = treeDirs(f.ring);
		expect(trees.length).toBe(2);
		const first = statSync(join(f.ring, "tree", trees[0]!, "audit.jsonl"));
		const second = statSync(join(f.ring, "tree", trees[1]!, "audit.jsonl"));
		expect(second.ino).toBe(first.ino);
	});

	test.skipIf(!HAS_FLOCK)("a busy tick lock makes the tick exit 0 and write nothing", async () => {
		const f = fixture(1);
		mkdirSync(f.ring, { recursive: true });
		const holder = Bun.spawn({
			cmd: ["flock", join(f.ring, ".tick.lock"), "-c", "echo held; read _"],
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		});
		try {
			await waitForLine(holder.stdout, "held");
			const r = tick(f);
			expect(r.code).toBe(0);
			expect(r.stdout).toContain("skipped");
			expect(leftovers(f.ring)).toEqual([]);
		} finally {
			holder.stdin.end();
			await holder.exited;
		}
	});
});

describe("status", () => {
	test("an empty ring exits 1", () => {
		const f = fixture(1);
		const r = runDr(SCRIPT, ["status"], envFor(f));
		expect(r.code).toBe(1);
		expect(r.stdout).toContain("ring is empty");
	});

	test("after a tick, status names the newest snapshot, the count and the off-host state", () => {
		const f = fixture(1);
		expect(tick(f).code).toBe(0);
		const name = snapshotFiles(f.ring)[0]!;
		const r = runDr(SCRIPT, ["status"], envFor(f));
		expect(r.code).toBe(0);
		expect(r.stdout).toContain(`newest ${name}`);
		expect(r.stdout).toContain("snapshots 1");
		expect(r.stdout).toContain("offhost_last_epoch never");
		expect(r.stdout).toMatch(/age_seconds -?\d+/);
	});
});
