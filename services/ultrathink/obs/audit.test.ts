// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as nodeFs from "node:fs";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main as cliMain } from "./audit-cli.ts";
import { AUDIT_EVENTS, type AuditFs, type AuditLog, type AuditRecord, type AuditVerification, auditPath, createAuditLog, GENESIS_HASH, verifyAuditFile } from "./audit.ts";

const START = 1_700_000_000_000;
const IS_ROOT = typeof process.getuid === "function" && process.getuid() === 0;
const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) {
		try {
			chmodSync(dir, 0o700);
		} catch {
			// Already writable or gone.
		}
		rmSync(dir, { recursive: true, force: true });
	}
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "ultrathink-audit-"));
	dirs.push(dir);
	return dir;
}

function clock(): () => number {
	let t = START;
	return () => {
		t += 1000;
		return t;
	};
}

function lines(path: string): string[] {
	return readFileSync(path, "utf8").split("\n").filter((l) => l.length > 0);
}

function records(path: string): AuditRecord[] {
	return lines(path).map((l) => JSON.parse(l) as AuditRecord);
}

function rewrite(path: string, out: string[]): void {
	writeFileSync(path, out.map((l) => `${l}\n`).join(""));
}

/** A log with `count` records in a fresh directory; returns the log, its path and the collected errors. */
function filled(count: number, now = clock()): { log: AuditLog; path: string; errors: Error[]; now: () => number } {
	const path = auditPath(tempDir());
	const errors: Error[] = [];
	const log = createAuditLog({ path, now, onError: (e) => errors.push(e) });
	for (let i = 1; i <= count; i += 1) log.record(AUDIT_EVENTS[i % AUDIT_EVENTS.length] as never, { n: i, who: `user${i}` });
	return { log, path, errors, now };
}

function expectBroken(v: AuditVerification, brokenAt: number, reason: RegExp): void {
	expect(v.ok).toBe(false);
	if (v.ok) return;
	expect(v.brokenAt).toBe(brokenAt);
	expect(v.records).toBe(brokenAt - 1);
	expect(v.reason).toMatch(reason);
}

describe("chain", () => {
	test("writes a private JSON Lines file with a sha256 chain from the genesis hash", () => {
		const { log, path } = filled(3);
		expect(statSync(path).mode & 0o777).toBe(0o600);
		const recs = records(path);
		expect(recs.map((r) => r.seq)).toEqual([1, 2, 3]);
		expect(recs[0]?.prev).toBe(GENESIS_HASH);
		expect(recs[0]?.ts).toBe(new Date(START + 1000).toISOString());
		expect(recs[1]?.prev).toBe(recs[0]?.hash);
		expect(recs[2]?.prev).toBe(recs[1]?.hash);
		for (const r of recs) {
			const canonical = JSON.stringify({ event: r.event, fields: r.fields, prev: r.prev, seq: r.seq, ts: r.ts });
			expect(r.hash).toBe(createHash("sha256").update(`${r.prev}\n${canonical}`).digest("hex"));
		}
		expect(log.verify()).toEqual({ ok: true, records: 3, lastHash: recs[2]?.hash as string });
		expect(verifyAuditFile(path)).toEqual(log.verify());
	});

	test("continues across reopen", () => {
		const { log, path, errors, now } = filled(2);
		log.close();
		const reopened = createAuditLog({ path, now, onError: (e) => errors.push(e) });
		reopened.record("logout", { session: "s1" });
		const recs = records(path);
		expect(recs.map((r) => r.seq)).toEqual([1, 2, 3]);
		expect(recs[2]?.prev).toBe(recs[1]?.hash);
		expect(reopened.verify()).toEqual({ ok: true, records: 3, lastHash: recs[2]?.hash as string });
		expect(errors).toEqual([]);
		expect(readdirSync(join(path, ".."))).toEqual(["audit.jsonl"]);
	});

	test("a missing or empty file is an intact empty chain", () => {
		const path = auditPath(tempDir());
		expect(verifyAuditFile(path)).toEqual({ ok: true, records: 0, lastHash: GENESIS_HASH });
		const log = createAuditLog({ path });
		expect(existsSync(path)).toBe(true);
		expect(log.verify()).toEqual({ ok: true, records: 0, lastHash: GENESIS_HASH });
	});

	test("the hash does not depend on field key order in the file", () => {
		const { log, path } = filled(2);
		const out = lines(path);
		const second = JSON.parse(out[1] as string) as AuditRecord;
		out[1] = JSON.stringify({ fields: { who: second.fields.who, n: second.fields.n }, hash: second.hash, prev: second.prev, event: second.event, ts: second.ts, seq: second.seq });
		rewrite(path, out);
		expect(log.verify().ok).toBe(true);
	});

	test("verifies an event name it does not know, so older files survive new events", () => {
		const path = auditPath(tempDir());
		const fields = {};
		const canonical = JSON.stringify({ event: "future_event", fields, prev: GENESIS_HASH, seq: 1, ts: "2026-01-01T00:00:00.000Z" });
		const hash = createHash("sha256").update(`${GENESIS_HASH}\n${canonical}`).digest("hex");
		rewrite(path, [JSON.stringify({ seq: 1, ts: "2026-01-01T00:00:00.000Z", event: "future_event", prev: GENESIS_HASH, hash, fields })]);
		expect(verifyAuditFile(path)).toEqual({ ok: true, records: 1, lastHash: hash });
	});
});

describe("tamper detection", () => {
	test("an edited middle line breaks at that line", () => {
		const { path } = filled(5);
		const out = lines(path);
		out[2] = (out[2] as string).replace('"who":"user3"', '"who":"mallory"');
		rewrite(path, out);
		expectBroken(verifyAuditFile(path), 3, /hash does not match/);
	});

	test("an edited line with a recomputed hash breaks at the next line", () => {
		const { path } = filled(5);
		const out = lines(path);
		const r = JSON.parse(out[2] as string) as AuditRecord;
		r.fields.who = "mallory";
		const canonical = JSON.stringify({ event: r.event, fields: { n: r.fields.n, who: r.fields.who }, prev: r.prev, seq: r.seq, ts: r.ts });
		r.hash = createHash("sha256").update(`${r.prev}\n${canonical}`).digest("hex");
		out[2] = JSON.stringify(r);
		rewrite(path, out);
		expectBroken(verifyAuditFile(path), 4, /prev does not match/);
	});

	test("a deleted middle line breaks at its position", () => {
		const { path } = filled(5);
		const out = lines(path);
		out.splice(1, 1);
		rewrite(path, out);
		expectBroken(verifyAuditFile(path), 2, /seq 3 where 2 was expected/);
	});

	test("reordered lines break at the first displaced one", () => {
		const { path } = filled(5);
		const out = lines(path);
		[out[2], out[3]] = [out[3] as string, out[2] as string];
		rewrite(path, out);
		expectBroken(verifyAuditFile(path), 3, /seq 4 where 3 was expected/);
	});

	test("a truncated last line breaks at the last record", () => {
		const { path } = filled(4);
		const text = readFileSync(path, "utf8");
		writeFileSync(path, text.slice(0, text.length - 10));
		expectBroken(verifyAuditFile(path), 4, /truncated last record/);
	});

	test("garbage and a swapped genesis hash are reported with their reason", () => {
		const { path } = filled(2);
		const out = lines(path);
		rewrite(path, ["not json", ...out]);
		expectBroken(verifyAuditFile(path), 1, /not valid JSON/);
		rewrite(path, [(out[0] as string).replace(GENESIS_HASH, "f".repeat(64)), out[1] as string]);
		expectBroken(verifyAuditFile(path), 1, /prev does not match/);
		rewrite(path, [...out, JSON.stringify({ seq: 3, ts: "x", event: "logout", prev: "zz", hash: "zz", fields: {} })]);
		expectBroken(verifyAuditFile(path), 3, /prev is not a sha256/);
	});

	test("an oversized line stops the scan instead of buffering it", () => {
		const { path } = filled(1);
		writeFileSync(path, `${readFileSync(path, "utf8")}{"seq":2,"pad":"${"x".repeat(1024 * 1024 + 10)}"}\n`);
		expectBroken(verifyAuditFile(path), 2, /maximum line length/);
	});

	test("a path that cannot be read is broken at record 0", () => {
		const dir = tempDir();
		const v = verifyAuditFile(dir);
		expect(v.ok).toBe(false);
		if (v.ok) return;
		expect(v.brokenAt).toBe(0);
		expect(v.records).toBe(0);
		expect(v.reason).toMatch(/^cannot (open|read): /);
	});
});

describe("fields", () => {
	test("drops secret-looking keys, non-primitives and anything past 32 keys; clips strings and strips control characters", () => {
		const path = auditPath(tempDir());
		const log = createAuditLog({ path, now: clock() });
		const many: Record<string, unknown> = {};
		for (let i = 0; i < 40; i += 1) many[`k${i}`] = i;
		log.record("login_failed", {
			password: "hunter2",
			access_token: "abc",
			Authorization: "Bearer x",
			apiKey: "k",
			api_key: "k",
			cookie: "c",
			connector_id: "x",
			clientSecret: "s",
			ip: "203.0.113.9\u0000\u001b[31m",
			long: "a".repeat(1000),
			count: 3,
			ok: true,
			nan: Number.NaN,
			inf: Number.POSITIVE_INFINITY,
			nested: { a: 1 },
			list: [1],
			nothing: null,
			undef: undefined,
			fn: () => 1,
			big: 10n,
			"": "empty key",
			"ke\ny": "newline in key",
			...many,
		});
		const [rec] = records(path);
		const fields = rec?.fields as Record<string, unknown>;
		for (const dropped of ["password", "access_token", "Authorization", "apiKey", "api_key", "cookie", "connector_id", "clientSecret", "nan", "inf", "nested", "list", "nothing", "undef", "fn", "big", ""]) {
			expect(fields).not.toHaveProperty(dropped);
		}
		expect(fields.ip).toBe("203.0.113.9[31m");
		expect((fields.long as string).length).toBe(256);
		expect(fields.long).toBe(`${"a".repeat(255)}\u2026`);
		expect(fields.count).toBe(3);
		expect(fields.ok).toBe(true);
		expect(fields.key).toBe("newline in key");
		expect(Object.keys(fields).length).toBe(32);
		expect(fields).toHaveProperty("k26");
		expect(fields).not.toHaveProperty("k27");
		expect(log.verify().ok).toBe(true);
	});

	test("accepts a missing or non-object fields argument", () => {
		const { log, path } = filled(0);
		log.record("logout");
		log.record("logout", null as never);
		log.record("logout", "nope" as never);
		expect(records(path).map((r) => r.fields)).toEqual([{}, {}, {}]);
		expect(log.verify().ok).toBe(true);
	});
});

describe("failure handling", () => {
	function failingFs(): AuditFs & { failing: boolean } {
		const fs: AuditFs & { failing: boolean } = {
			...nodeFs,
			failing: false,
			openSync: ((path: nodeFs.PathLike, flags: nodeFs.OpenMode, mode?: nodeFs.Mode | null) => {
				if (fs.failing && flags === "a") {
					const error = new Error("EACCES: permission denied, open") as NodeJS.ErrnoException;
					error.code = "EACCES";
					throw error;
				}
				return nodeFs.openSync(path, flags, mode);
			}) as typeof nodeFs.openSync,
		};
		return fs;
	}

	test("a write failure drops the record and reports every drop; the chain resumes after a recovery", () => {
		const path = auditPath(tempDir());
		const errors: Error[] = [];
		const fs = failingFs();
		const log = createAuditLog({ path, now: clock(), fs, onError: (e) => errors.push(e) });
		log.record("login_ok", { n: 1 });
		fs.failing = true;
		log.record("login_ok", { n: 2 });
		log.record("login_ok", { n: 3 });
		expect(errors.length).toBe(2);
		expect(errors[0]?.message).toMatch(/record dropped: EACCES/);
		fs.failing = false;
		log.record("login_ok", { n: 4 });
		expect(records(path).map((r) => [r.seq, r.fields.n])).toEqual([
			[1, 1],
			[2, 4],
		]);
		expect(log.verify().ok).toBe(true);
		fs.failing = true;
		log.record("login_ok", { n: 5 });
		expect(errors.length).toBe(3);
	});

	test("a failed fsync rolls the record back, and the next record continues the chain", () => {
		const path = auditPath(tempDir());
		const errors: Error[] = [];
		let failNextSync = false;
		const fs: AuditFs = {
			...nodeFs,
			fsyncSync: ((fd: number) => {
				if (failNextSync) {
					failNextSync = false;
					throw Object.assign(new Error("EIO: fsync"), { code: "EIO" });
				}
				return nodeFs.fsyncSync(fd);
			}) as typeof nodeFs.fsyncSync,
		};
		const log = createAuditLog({ path, now: clock(), fs, onError: (e) => errors.push(e) });
		log.record("login_ok", { n: 1 });
		failNextSync = true;
		log.record("login_ok", { n: 2 });
		log.record("login_ok", { n: 3 });
		expect(errors).toHaveLength(1);
		expect(errors[0]?.message).toMatch(/record dropped: EIO/);
		expect(records(path).map((r) => [r.seq, r.fields.n])).toEqual([
			[1, 1],
			[2, 3],
		]);
		expect(log.verify().ok).toBe(true);
	});

	test("a file removed between appends is started again from genesis", () => {
		const path = auditPath(tempDir());
		const errors: Error[] = [];
		const notices: string[] = [];
		const log = createAuditLog({ path, now: clock(), onError: (e) => errors.push(e), onNotice: (m) => notices.push(m) });
		log.record("login_ok", { n: 1 });
		rmSync(path);
		log.record("login_ok", { n: 2 });
		expect(records(path).map((r) => [r.seq, r.fields.n])).toEqual([[1, 2]]);
		expect(log.verify().ok).toBe(true);
		expect(notices.some((m) => /changed outside the service/.test(m))).toBe(true);
		expect(errors).toEqual([]);
	});

	test.skipIf(IS_ROOT)("a read-only directory reports every dropped record and the process keeps going", () => {
		const dir = tempDir();
		const path = auditPath(dir);
		const errors: Error[] = [];
		const log = createAuditLog({ path, now: clock(), onError: (e) => errors.push(e) });
		log.record("login_ok", { n: 1 });
		rmSync(path);
		chmodSync(dir, 0o500);
		log.record("login_ok", { n: 2 });
		log.record("login_ok", { n: 3 });
		expect(errors.map((e) => e.message.includes("record dropped"))).toEqual([false, true, true]);
		chmodSync(dir, 0o700);
		log.record("login_ok", { n: 4 });
		expect(errors.length).toBe(3);
		expect(existsSync(path)).toBe(true);
	});

	test("a throwing onError is contained", () => {
		const path = auditPath(tempDir());
		const fs = failingFs();
		const log = createAuditLog({
			path,
			fs,
			onError: () => {
				throw new Error("sink exploded");
			},
		});
		fs.failing = true;
		expect(() => log.record("logout")).not.toThrow();
	});

	test("records after close are dropped and each one is reported", () => {
		const { log, path, errors } = filled(1);
		log.close();
		log.close();
		log.record("logout");
		log.record("logout");
		expect(records(path).length).toBe(1);
		expect(errors.map((e) => e.message)).toEqual(["audit log: record after close dropped", "audit log: record after close dropped"]);
	});

	test("a missing directory and invalid options fail at construction", () => {
		const dir = tempDir();
		expect(() => createAuditLog({ path: join(dir, "missing", "audit.jsonl") })).toThrow(/cannot open/);
		expect(() => createAuditLog({ path: "" })).toThrow(/path/);
		expect(() => createAuditLog({ path: auditPath(dir), now: 5 as never })).toThrow(/now/);
		expect(() => createAuditLog({ path: auditPath(dir), onError: "x" as never })).toThrow(/onError/);
		expect(() => createAuditLog(null as never)).toThrow(/options/);
	});

	test.skipIf(IS_ROOT)("a read-only directory fails at construction", () => {
		const dir = tempDir();
		chmodSync(dir, 0o500);
		expect(() => createAuditLog({ path: auditPath(dir) })).toThrow(/cannot open/);
	});
});

describe("quarantine on open", () => {
	test("a broken file is moved aside, reported, and a fresh chain starts", () => {
		const { log, path, errors, now } = filled(3);
		log.close();
		const out = lines(path);
		out.splice(1, 1);
		rewrite(path, out);
		const notices: string[] = [];
		const reopened = createAuditLog({ path, now, onError: (e) => errors.push(e), onNotice: (m) => notices.push(m) });
		expect(errors).toEqual([]);
		expect(notices.length).toBe(1);
		expect(notices[0]).toMatch(/broken at record 2 \(seq 3 where 2 was expected\); moved to .*audit\.jsonl\.corrupt-/);
		const names = readdirSync(join(path, "..")).sort();
		expect(names.length).toBe(2);
		expect(names.some((n) => n.startsWith("audit.jsonl.corrupt-"))).toBe(true);
		expect(readFileSync(join(path, "..", names.find((n) => n.includes("corrupt")) as string), "utf8")).toBe(out.map((l) => `${l}\n`).join(""));
		expect(statSync(path).mode & 0o777).toBe(0o600);
		expect(reopened.verify()).toEqual({ ok: true, records: 0, lastHash: GENESIS_HASH });
		reopened.record("login_ok", { n: 1 });
		const recs = records(path);
		expect(recs.map((r) => [r.seq, r.prev])).toEqual([[1, GENESIS_HASH]]);
		expect(reopened.verify()).toEqual({ ok: true, records: 1, lastHash: recs[0]?.hash as string });
	});

	test("a crash-truncated last line is quarantined, not silently continued", () => {
		const { log, path, errors, now } = filled(2);
		log.close();
		const text = readFileSync(path, "utf8");
		writeFileSync(path, text.slice(0, text.length - 3));
		const notices: string[] = [];
		const reopened = createAuditLog({ path, now, onError: (e) => errors.push(e), onNotice: (m) => notices.push(m) });
		expect(errors).toEqual([]);
		expect(notices[0]).toMatch(/broken at record 2 \(truncated last record/);
		reopened.record("logout");
		expect(records(path).map((r) => r.seq)).toEqual([1]);
		expect(reopened.verify().ok).toBe(true);
	});

	test("an existing file is tightened to 0600", () => {
		const { log, path } = filled(1);
		log.close();
		chmodSync(path, 0o644);
		createAuditLog({ path });
		expect(statSync(path).mode & 0o777).toBe(0o600);
	});

	test("an existing file that cannot be read fails at construction instead of being quarantined", () => {
		const { log, path, now } = filled(2);
		log.close();
		const fs: AuditFs = {
			...nodeFs,
			readSync: () => {
				throw new Error("EIO: input/output error");
			},
		};
		expect(() => createAuditLog({ path, now, fs })).toThrow(/cannot verify .*audit\.jsonl: cannot read: EIO/);
		expect(readdirSync(join(path, ".."))).toEqual(["audit.jsonl"]);
	});

	test("a broken file that cannot be quarantined fails at construction", () => {
		const { log, path, now } = filled(2);
		log.close();
		rewrite(path, ["garbage"]);
		const fs: AuditFs = {
			...nodeFs,
			renameSync: () => {
				throw new Error("EROFS: read-only file system");
			},
		};
		expect(() => createAuditLog({ path, now, fs })).toThrow(/cannot be quarantined: EROFS/);
	});
});

describe("audit-cli", () => {
	function run(argv: string[], env: Record<string, string | undefined> = {}): { code: number; out: string[]; err: string[] } {
		const out: string[] = [];
		const err: string[] = [];
		const code = cliMain(argv, env, { out: (l) => out.push(l), err: (l) => err.push(l) });
		return { code, out, err };
	}

	test("verify prints one ok line for an intact file", () => {
		const { log, path } = filled(3);
		const v = log.verify();
		const r = run(["verify", path]);
		expect(r.code).toBe(0);
		expect(r.err).toEqual([]);
		expect(r.out).toEqual([`audit ok: 3 records, last ${v.ok ? v.lastHash : ""}`]);
	});

	test("verify prints one BROKEN line and exits 1", () => {
		const { path } = filled(3);
		const out = lines(path);
		out.splice(0, 1);
		rewrite(path, out);
		const r = run(["verify", path]);
		expect(r.code).toBe(1);
		expect(r.out).toEqual(["audit BROKEN at record 1: seq 2 where 1 was expected"]);
	});

	test("the default path comes from ULTRATHINK_STATE_DIR", () => {
		const dir = tempDir();
		const { path } = filled(1);
		const stateDir = join(path, "..");
		expect(run(["verify"], { ULTRATHINK_STATE_DIR: stateDir }).out[0]).toMatch(/^audit ok: 1 records/);
		expect(run(["verify"], { ULTRATHINK_STATE_DIR: dir }).out[0]).toBe(`audit ok: 0 records, last ${GENESIS_HASH}`);
	});

	test("usage and help", () => {
		expect(run(["--help"]).code).toBe(0);
		expect(run(["--help"]).out[0]).toMatch(/^usage: bun services\/ultrathink\/obs\/audit-cli\.ts verify/);
		expect(run([]).code).toBe(2);
		expect(run(["frobnicate"]).code).toBe(2);
		expect(run(["verify", "a", "b"]).code).toBe(2);
		expect(run(["verify", "--bogus"]).code).toBe(2);
		expect(run(["frobnicate"]).err[0]).toMatch(/^usage:/);
	});
});
