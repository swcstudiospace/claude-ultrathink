// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

// Behaviour of deploy/ultrathink-backup.sh: archive contents, audit-chain and checksum verification, fail-closed
// encryption, refusal of plaintext off-host pushes, and retention across the .tar.gz and .tar.gz.age suffixes. Every
// case runs the real script against a state directory built through the release's store (dr-fixtures.ts).

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { type StateDirSpec, hasTool, makeStateDir, runDr } from "./dr-fixtures.ts";

const SCRIPT = "deploy/ultrathink-backup.sh";
const AGE_AVAILABLE = hasTool("age") && hasTool("age-keygen");
const RSYNC_AVAILABLE = hasTool("rsync");
if (!AGE_AVAILABLE) console.log("dr-backup: age round trip skipped: age and age-keygen are not on PATH");
if (!RSYNC_AVAILABLE) console.log("dr-backup: rsync cases skipped: rsync is not on PATH");

const SERVICE_USER = process.env.ULTRATHINK_SERVICE_USER || "ultrathink";
const RUNS_AS_ROOT = process.getuid?.() === 0;

/**
 * A root run makes the script re-execute itself as the service user, which then reads and writes the fixture tree.
 * mkdtemp makes that tree root-owned and 0700, so the test hands it to the service user before each run. Temp files only.
 */
function handOver(path: string): void {
	if (!RUNS_AS_ROOT) return;
	const proc = Bun.spawnSync({ cmd: ["chown", "-R", `${SERVICE_USER}:${SERVICE_USER}`, path] });
	if (proc.exitCode !== 0) throw new Error(`chown ${path} failed: ${proc.stderr.toString()}`);
}

interface Scenario {
	/** State directory the backup reads. */
	state: string;
	/** Archive directory the backup writes; the script creates it, so it may not exist yet. */
	backups: string;
	/** Environment that points the script at this scenario. */
	env: Record<string, string>;
}

function entriesIn(dir: string): string[] {
	return existsSync(dir) ? readdirSync(dir).sort() : [];
}

function archivesIn(dir: string): string[] {
	return entriesIn(dir).filter((name) => /^ultrathink-.*\.tar\.gz(\.age)?$/.test(name));
}

function onlyArchive(dir: string): string {
	const archives = archivesIn(dir);
	if (archives.length !== 1) throw new Error(`expected one archive in ${dir}, found ${archives.length}`);
	return join(dir, archives[0] ?? "");
}

function listFiles(dir: string, prefix = ""): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const rel = `${prefix}${entry.name}`;
		if (entry.isDirectory()) files.push(...listFiles(join(dir, entry.name), `${rel}/`));
		else if (entry.isFile()) files.push(rel);
	}
	return files;
}

/** Writes SHA256SUMS to match the directory as it is now, as someone who edits an archive would. */
function regenerateSums(top: string): void {
	const lines = listFiles(top)
		.filter((file) => file !== "SHA256SUMS")
		.sort()
		.map((file) => `${new Bun.CryptoHasher("sha256").update(readFileSync(join(top, file))).digest("hex")}  ./${file}\n`);
	writeFileSync(join(top, "SHA256SUMS"), lines.join(""));
}

// The script calls sha256sum, which the stock macOS runner does not have (it has only shasum), so these cases run on Linux.
describe.skipIf(process.platform !== "linux")("ultrathink-backup.sh", () => {
	let base = "";

	beforeAll(() => {
		base = mkdtempSync(join(tmpdir(), "dr-backup-"));
	});

	afterAll(() => {
		rmSync(base, { recursive: true, force: true });
	});

	function scenario(name: string, spec: StateDirSpec): Scenario {
		const root = join(base, name);
		const { dir, db } = makeStateDir(root, spec);
		db.close();
		const backups = join(root, "backups");
		handOver(base);
		// ENV_FILE must name a path that is not a directory: on some hosts /nonexistent is one, and file_value reads it.
		const envFile = join(base, "no-env-file");
		return {
			state: dir,
			backups,
			env: {
				ULTRATHINK_STATE_DIR: dir,
				ULTRATHINK_BACKUP_DIR: backups,
				ULTRATHINK_ENV_FILE: envFile,
				ULTRATHINK_SERVICE_USER: SERVICE_USER,
			},
		};
	}

	/** Unpacks an archive into a fresh directory and returns its single top-level directory. */
	function unpack(archive: string): string {
		const root = mkdtempSync(join(base, "unpack-"));
		const proc = Bun.spawnSync({ cmd: ["tar", "-xzf", archive, "-C", root] });
		expect(proc.exitCode).toBe(0);
		const top = readdirSync(root)[0];
		if (top === undefined) throw new Error(`archive has no top-level entry: ${archive}`);
		return join(root, top);
	}

	/** Packs a directory returned by unpack() into a new .tar.gz. */
	function repack(top: string, out: string): void {
		const proc = Bun.spawnSync({ cmd: ["tar", "-czf", out, "-C", dirname(top), basename(top)] });
		expect(proc.exitCode).toBe(0);
	}

	test("backup of a fixture with audit and oauth: the archive holds audit.jsonl and BACKUP_INFO lists it in files=", () => {
		const s = scenario("audit-archive", { runs: 2, audit: true, oauth: true });
		const result = runDr(SCRIPT, ["backup"], s.env);
		expect(result.code).toBe(0);
		const top = unpack(onlyArchive(s.backups));
		expect(existsSync(join(top, "audit.jsonl"))).toBe(true);
		expect(readFileSync(join(top, "BACKUP_INFO"), "utf8")).toMatch(/^files=audit\.jsonl$/m);
	});

	test("a tampered audit chain fails verify even when SHA256SUMS is regenerated to match", () => {
		const s = scenario("audit-tamper", { runs: 1, audit: true, oauth: true });
		expect(runDr(SCRIPT, ["backup"], s.env).code).toBe(0);
		const top = unpack(onlyArchive(s.backups));
		const auditFile = join(top, "audit.jsonl");
		const lines = readFileSync(auditFile, "utf8").trimEnd().split("\n");
		const first = JSON.parse(lines[0] ?? "") as { fields: { fixture: number } };
		first.fields.fixture = 99;
		lines[0] = JSON.stringify(first);
		writeFileSync(auditFile, `${lines.join("\n")}\n`);
		regenerateSums(top);
		const tampered = join(base, "audit-tamper", "tampered.tar.gz");
		repack(top, tampered);
		const result = runDr(SCRIPT, ["verify", tampered], s.env);
		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain("audit chain");
	});

	test("a checksum mismatch fails verify", () => {
		const s = scenario("checksum-mismatch", { runs: 1, audit: true, oauth: true });
		expect(runDr(SCRIPT, ["backup"], s.env).code).toBe(0);
		const top = unpack(onlyArchive(s.backups));
		writeFileSync(join(top, "oauth.json"), '{"fixture":"edited"}\n');
		const edited = join(base, "checksum-mismatch", "edited.tar.gz");
		repack(top, edited);
		const result = runDr(SCRIPT, ["verify", edited], s.env);
		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain("checksum mismatch");
	});

	test("fail-closed encryption: a recipient with no age binary exits 2 and writes no archive", () => {
		const s = scenario("fail-closed", { runs: 1, oauth: true });
		const result = runDr(SCRIPT, ["backup"], {
			...s.env,
			ULTRATHINK_BACKUP_RECIPIENT: "age1fixture-recipient",
			ULTRATHINK_AGE: "/nonexistent",
		});
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("age binary not found");
		expect(entriesIn(s.backups)).toEqual([]);
	});

	test.skipIf(!AGE_AVAILABLE)(
		"age round trip: only .tar.gz.age is written, it decrypts to an archive that verifies",
		() => {
			const s = scenario("age-round-trip", { runs: 2, audit: true, oauth: true });
			const identity = join(base, "age-round-trip", "identity.txt");
			const keygen = Bun.spawnSync({ cmd: ["age-keygen", "-o", identity] });
			expect(keygen.exitCode).toBe(0);
			const recipient = /^# public key: (age1\S+)$/m.exec(readFileSync(identity, "utf8"))?.[1];
			if (recipient === undefined) throw new Error("age-keygen wrote no public key");
			const result = runDr(SCRIPT, ["backup"], { ...s.env, ULTRATHINK_BACKUP_RECIPIENT: recipient });
			expect(result.code).toBe(0);
			const entries = entriesIn(s.backups);
			expect(entries).toHaveLength(1);
			expect(entries[0]).toMatch(/\.tar\.gz\.age$/);
			const encrypted = join(s.backups, entries[0] ?? "");
			const plain = join(base, "age-round-trip", "decrypted.tar.gz");
			const decrypt = Bun.spawnSync({ cmd: ["age", "--decrypt", "-i", identity, "-o", plain, encrypted] });
			expect(decrypt.exitCode).toBe(0);
			expect(runDr(SCRIPT, ["verify", plain], s.env).code).toBe(0);
			expect(runDr(SCRIPT, ["verify", encrypted], { ...s.env, ULTRATHINK_AGE_IDENTITY: identity }).code).toBe(0);
		},
	);

	test.skipIf(!RSYNC_AVAILABLE)(
		"rsync without a recipient pushes nothing, keeps the local archive and exits nonzero",
		() => {
			const s = scenario("rsync-plaintext", { runs: 1, oauth: true });
			const remote = join(base, "rsync-plaintext", "remote");
			mkdirSync(remote, { recursive: true });
			const result = runDr(SCRIPT, ["backup"], { ...s.env, ULTRATHINK_BACKUP_RSYNC_TARGET: `${remote}/` });
			expect(result.code).not.toBe(0);
			expect(result.stderr).toContain("refusing plaintext off-host");
			expect(entriesIn(remote)).toEqual([]);
			expect(archivesIn(s.backups)).toHaveLength(1);
		},
	);

	test("retention counts .tar.gz and .tar.gz.age together and keeps the KEEP newest", () => {
		const s = scenario("retention", { runs: 1, oauth: true });
		mkdirSync(s.backups, { recursive: true });
		writeFileSync(join(s.backups, "ultrathink-20200101T000000Z.tar.gz"), "seed");
		writeFileSync(join(s.backups, "ultrathink-20200102T000000Z.tar.gz.age"), "seed");
		handOver(s.backups);
		const result = runDr(SCRIPT, ["backup"], { ...s.env, ULTRATHINK_BACKUP_KEEP: "2" });
		expect(result.code).toBe(0);
		const remaining = archivesIn(s.backups);
		expect(remaining).toHaveLength(2);
		expect(remaining).toContain("ultrathink-20200102T000000Z.tar.gz.age");
		expect(remaining).not.toContain("ultrathink-20200101T000000Z.tar.gz");
		const fresh = remaining.filter((name) => !name.startsWith("ultrathink-2020"));
		expect(fresh).toHaveLength(1);
		expect(fresh[0]).toMatch(/^ultrathink-\d{8}T\d{6}Z\.tar\.gz$/);
	});
});
