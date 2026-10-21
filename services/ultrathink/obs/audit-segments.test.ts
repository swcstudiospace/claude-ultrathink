// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import * as nodeFs from "node:fs";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AuditFs, type AuditNotice, type AuditRecord, auditPath, createAuditLog, verifyAuditFile } from "./audit.ts";
import { listSegments, sealedName } from "./audit-segments.ts";
import { createFrontier } from "./audit-merkle.ts";

const START = 1_700_000_000_000;
const MIB = 1024 * 1024;
const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "ultrathink-audit-seg-"));
	dirs.push(dir);
	return dir;
}

/** Each record advances the clock one second, so a record's ts identifies it. */
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

/** Recomputes a record's hash after an edit, so the chain link is valid and only the edited content is wrong. */
function rehash(r: AuditRecord): AuditRecord {
	const fields = Object.fromEntries(Object.entries(r.fields).sort(([a], [b]) => (a < b ? -1 : 1)));
	const canonical = JSON.stringify({ event: r.event, fields, prev: r.prev, seq: r.seq, ts: r.ts });
	return { ...r, hash: createHash("sha256").update(`${r.prev}\n${canonical}`).digest("hex") };
}

/** About 8 KB of primitives per record (32 keys, 250 characters each), so a 1 MiB segment holds about 125 records. */
function bulk(i: number): Record<string, string | number> {
	const fields: Record<string, string | number> = { n: i };
	for (let k = 0; k < 31; k += 1) fields[`k${k}`] = "x".repeat(250);
	return fields;
}

function fill(log: { record(event: "login_ok", fields: Record<string, unknown>): void }, from: number, to: number): void {
	for (let i = from; i <= to; i += 1) log.record("login_ok", bulk(i));
}

/** Sealed segment file names in the directory, oldest first. */
function sealedIn(dir: string): string[] {
	return readdirSync(dir)
		.filter((n) => /^audit-\d+-\d+\.jsonl$/.test(n))
		.sort((a, b) => Number(a.split("-")[1]) - Number(b.split("-")[1]));
}

/** Every record of the chain in `dir`: the sealed segments oldest first, then the active file. */
function chainOf(dir: string, active: string): AuditRecord[] {
	return [...sealedIn(dir).flatMap((name) => records(join(dir, name))), ...records(active)];
}

describe("sealed segments", () => {
	test("rotation at the byte limit seals a read-only file named by its seq range and the chain verifies across it", () => {
		const dir = tempDir();
		const path = auditPath(dir);
		const log = createAuditLog({ path, now: clock(), segmentBytes: MIB });
		fill(log, 1, 200);
		const sealed = sealedIn(dir);
		expect(sealed.length).toBe(1);
		const name = sealed[0] as string;
		const last = Number(/^audit-1-(\d+)\.jsonl$/.exec(name)?.[1]);
		expect(last).toBeGreaterThan(0);
		expect(statSync(join(dir, name)).mode & 0o777).toBe(0o400);
		const sealedRecs = records(join(dir, name));
		const active = records(path);
		expect(sealedRecs.map((r) => r.seq)).toEqual(Array.from({ length: last }, (_, i) => i + 1));
		expect(active[0]?.seq).toBe(last + 1);
		expect(active[0]?.prev).toBe(sealedRecs[last - 1]?.hash);
		expect(verifyAuditFile(path)).toEqual({ ok: true, records: 200, lastHash: active.at(-1)?.hash as string });
		expect(log.head()).toEqual({ seq: 200, hash: active.at(-1)?.hash as string });
	});

	test("a rename that fails is reported and the records keep landing in the active file", () => {
		const dir = tempDir();
		const path = auditPath(dir);
		const errors: Error[] = [];
		const fs: AuditFs = {
			...nodeFs,
			renameSync: () => {
				throw new Error("EXDEV: cross-device link");
			},
		};
		const log = createAuditLog({ path, now: clock(), fs, segmentBytes: MIB, onError: (e) => errors.push(e) });
		fill(log, 1, 140);
		expect(sealedIn(dir)).toEqual([]);
		expect(records(path).length).toBe(140);
		expect(errors.length).toBeGreaterThan(0);
		expect(errors.every((e) => /cannot seal .* EXDEV/.test(e.message))).toBe(true);
		expect(verifyAuditFile(path).ok).toBe(true);
	});

	test("editing a line in a sealed file breaks the chain at that line's global seq", () => {
		const dir = tempDir();
		const path = auditPath(dir);
		const log = createAuditLog({ path, now: clock(), segmentBytes: MIB });
		fill(log, 1, 200);
		const sealedPath = join(dir, sealedIn(dir)[0] as string);
		chmodSync(sealedPath, 0o600);
		const out = lines(sealedPath);
		out[4] = (out[4] as string).replace("xxxx", "yyyy");
		rewrite(sealedPath, out);
		const v = verifyAuditFile(path);
		expect(v.ok).toBe(false);
		if (v.ok) return;
		expect(v.brokenAt).toBe(5);
		expect(v.records).toBe(4);
		expect(v.reason).toMatch(/hash does not match/);
	});

	test("a broken sealed segment makes the log refuse to start and moves nothing aside", () => {
		const dir = tempDir();
		const path = auditPath(dir);
		const log = createAuditLog({ path, now: clock(), segmentBytes: MIB });
		fill(log, 1, 200);
		log.close();
		const sealedPath = join(dir, sealedIn(dir)[0] as string);
		chmodSync(sealedPath, 0o600);
		const out = lines(sealedPath);
		out[4] = (out[4] as string).replace("xxxx", "yyyy");
		rewrite(sealedPath, out);
		const before = readdirSync(dir).sort();
		expect(() => createAuditLog({ path, now: clock(), segmentBytes: MIB })).toThrow(/sealed segment .* is broken at record 5/);
		expect(readdirSync(dir).sort()).toEqual(before);
	});

	test("reopening after rotation continues the global seq and the chain", () => {
		const dir = tempDir();
		const path = auditPath(dir);
		const now = clock();
		const first = createAuditLog({ path, now, segmentBytes: MIB });
		fill(first, 1, 200);
		const beforeLast = records(path).at(-1)?.hash as string;
		first.close();
		const second = createAuditLog({ path, now, segmentBytes: MIB });
		expect(second.head().seq).toBe(200);
		second.record("logout", { n: 201 });
		const active = records(path);
		expect(active.at(-1)?.seq).toBe(201);
		expect(active.at(-1)?.prev).toBe(beforeLast);
		expect(verifyAuditFile(path)).toEqual({ ok: true, records: 201, lastHash: active.at(-1)?.hash as string });
		expect(sealedIn(dir).length).toBe(1);
	});

	test("the segment helpers list only validated sealed names, sorted by first seq", () => {
		const dir = tempDir();
		for (const name of ["audit-3-5.jsonl", "audit-1-2.jsonl", "audit-01-2.jsonl", "audit-2-1.jsonl", "audit.jsonl.corrupt-x", "audit-6-6.jsonl", "notes.txt"]) {
			writeFileSync(join(dir, name), "");
		}
		expect(listSegments(auditPath(dir), nodeFs).map((s) => s.name)).toEqual(["audit-1-2.jsonl", "audit-3-5.jsonl", "audit-6-6.jsonl"]);
		expect(listSegments(join(dir, "missing", "audit.jsonl"), nodeFs)).toEqual([]);
		expect(sealedName(1, 2)).toBe("audit-1-2.jsonl");
	});

	test("segmentBytes below 1 MiB is rejected", () => {
		const dir = tempDir();
		expect(() => createAuditLog({ path: auditPath(dir), segmentBytes: MIB - 1 })).toThrow(/segmentBytes/);
		expect(() => createAuditLog({ path: auditPath(dir), segmentBytes: MIB + 0.5 })).toThrow(/segmentBytes/);
	});
});

describe("prune", () => {
	test("prune removes only old sealed segments, keeps the active file, and the chain still verifies", () => {
		const dir = tempDir();
		const path = auditPath(dir);
		const log = createAuditLog({ path, now: clock(), segmentBytes: MIB });
		fill(log, 1, 200);
		const sealedName0 = sealedIn(dir)[0] as string;
		const lastSealed = Number(/-(\d+)\.jsonl$/.exec(sealedName0)?.[1]);
		const sealedRecs = records(join(dir, sealedName0));
		const cutoff = Date.parse((sealedRecs[lastSealed - 1] as AuditRecord).ts) + 1;
		expect(log.prune(cutoff)).toEqual({ segments: 1 });
		expect(existsSync(join(dir, sealedName0))).toBe(false);
		expect(existsSync(path)).toBe(true);
		const active = records(path);
		expect(active.at(-1)?.event).toBe("audit_retention_pruned");
		expect(active.at(-1)?.fields).toEqual({ segments: 1, fromSeq: 1, throughSeq: lastSealed, throughHash: sealedRecs[lastSealed - 1]?.hash as string, frontier: expect.any(String) });
		expect(verifyAuditFile(path)).toEqual({ ok: true, records: active.length, lastHash: active.at(-1)?.hash as string });
		expect(log.verify().ok).toBe(true);
	});

	test("a prune reports one pruned notice and no tamper kind", () => {
		const dir = tempDir();
		const path = auditPath(dir);
		const notices: AuditNotice[] = [];
		const log = createAuditLog({ path, now: clock(), segmentBytes: MIB, onNotice: (notice) => notices.push(notice) });
		fill(log, 1, 200);
		const sealedName0 = sealedIn(dir)[0] as string;
		const lastSealed = Number(/-(\d+)\.jsonl$/.exec(sealedName0)?.[1]);
		const cutoff = Date.parse((records(join(dir, sealedName0))[lastSealed - 1] as AuditRecord).ts) + 1;
		expect(log.prune(cutoff)).toEqual({ segments: 1 });
		expect(notices).toEqual([expect.objectContaining({ kind: "pruned", message: expect.stringContaining("pruned 1 sealed segment(s)") })]);
	});

	test("prune with nothing eligible returns zero and writes nothing", () => {
		const dir = tempDir();
		const path = auditPath(dir);
		const log = createAuditLog({ path, now: clock(), segmentBytes: MIB });
		fill(log, 1, 200);
		const sealedRecs = records(join(dir, sealedIn(dir)[0] as string));
		const newest = sealedRecs.at(-1) as AuditRecord;
		const before = readFileSync(path, "utf8");
		expect(log.prune(Date.parse(newest.ts))).toEqual({ segments: 0 });
		expect(log.prune(0)).toEqual({ segments: 0 });
		expect(readFileSync(path, "utf8")).toBe(before);
		expect(sealedIn(dir).length).toBe(1);
	});

	test("a forged throughHash in the boundary record makes verification fail", () => {
		const dir = tempDir();
		const path = auditPath(dir);
		const log = createAuditLog({ path, now: clock(), segmentBytes: MIB });
		fill(log, 1, 200);
		const lastSealed = Number(/-(\d+)\.jsonl$/.exec(sealedIn(dir)[0] as string)?.[1]);
		const cutoff = Date.parse(records(join(dir, sealedIn(dir)[0] as string))[lastSealed - 1]?.ts as string) + 1;
		log.prune(cutoff);
		const out = lines(path);
		const retention = JSON.parse(out.at(-1) as string) as AuditRecord;
		out[out.length - 1] = JSON.stringify(rehash({ ...retention, fields: { ...retention.fields, throughHash: "f".repeat(64) } }));
		rewrite(path, out);
		const v = verifyAuditFile(path);
		expect(v.ok).toBe(false);
		if (v.ok) return;
		expect(v.reason).toMatch(/where 1 was expected/);
	});

	test("corrupt evidence files are never removed by prune", () => {
		const dir = tempDir();
		const path = auditPath(dir);
		const log = createAuditLog({ path, now: clock(), segmentBytes: MIB });
		fill(log, 1, 200);
		const evidence = join(dir, "audit.jsonl.corrupt-2026-01-01T00-00-00-000Z");
		writeFileSync(evidence, "kept\n");
		log.prune(Number.MAX_SAFE_INTEGER);
		expect(existsSync(evidence)).toBe(true);
		expect(readFileSync(evidence, "utf8")).toBe("kept\n");
	});

	test("after a prune the retained chain with anchors still verifies, and anchors resume after it", () => {
		const dir = tempDir();
		const path = auditPath(dir);
		const log = createAuditLog({ path, now: clock(), segmentBytes: MIB, anchorEvery: 2 });
		fill(log, 1, 200);
		expect(records(path).some((r) => r.event === "audit_anchor")).toBe(true);
		const sealedName0 = sealedIn(dir)[0] as string;
		const lastSealed = Number(/-(\d+)\.jsonl$/.exec(sealedName0)?.[1]);
		const cutoff = Date.parse(records(join(dir, sealedName0))[lastSealed - 1]?.ts as string) + 1;
		expect(log.prune(cutoff)).toEqual({ segments: 1 });
		const retentionAt = records(path).length;
		log.record("login_ok", { n: 1 });
		log.record("login_ok", { n: 2 });
		log.record("login_ok", { n: 3 });
		const after = records(path).slice(retentionAt);
		expect(after.map((r) => r.event)).toEqual(["login_ok", "audit_anchor", "login_ok", "login_ok", "audit_anchor"]);
		expect(verifyAuditFile(path).ok).toBe(true);
	});

	test("the next anchor after a prune has the root a never-pruned log gives for the same records", () => {
		const dirA = tempDir();
		const dirB = tempDir();
		const pathA = auditPath(dirA);
		const pathB = auditPath(dirB);
		const whole = createAuditLog({ path: pathA, now: clock(), segmentBytes: MIB, anchorEvery: 2 });
		const pruned = createAuditLog({ path: pathB, now: clock(), segmentBytes: MIB, anchorEvery: 2 });
		fill(whole, 1, 200);
		fill(pruned, 1, 200);
		const wholeChain = chainOf(dirA, pathA);
		const total = wholeChain.length;
		const sealed = sealedIn(dirB)[0] as string;
		const lastSealed = Number(/-(\d+)\.jsonl$/.exec(sealed)?.[1]);
		const cutoff = Date.parse(records(join(dirB, sealed))[lastSealed - 1]?.ts as string) + 1;
		expect(pruned.prune(cutoff)).toEqual({ segments: 1 });
		for (let n = 1; n <= 4; n += 1) pruned.record("login_ok", { n });
		const prunedChain = chainOf(dirB, pathB);
		expect(prunedChain.find((r) => r.seq === total)?.hash).toBe(wholeChain.at(-1)?.hash);
		expect(prunedChain.some((r) => r.event === "audit_anchor" && r.seq > total)).toBe(true);
		// The never-pruned records followed by the pruned log's later records form a never-pruned chain. Its anchors must
		// verify, so every anchor the pruned log wrote carries the root a never-pruned log gives.
		const dirC = tempDir();
		const pathC = auditPath(dirC);
		rewrite(pathC, [...wholeChain, ...prunedChain.filter((r) => r.seq > total)].map((r) => JSON.stringify(r)));
		expect(verifyAuditFile(pathC).ok).toBe(true);
	});

	test("a pruned directory verifies, and a reopened log continues its chain and its anchors", () => {
		const dir = tempDir();
		const path = auditPath(dir);
		const log = createAuditLog({ path, now: clock(), segmentBytes: MIB, anchorEvery: 2 });
		fill(log, 1, 200);
		const sealed = sealedIn(dir)[0] as string;
		const lastSealed = Number(/-(\d+)\.jsonl$/.exec(sealed)?.[1]);
		const cutoff = Date.parse(records(join(dir, sealed))[lastSealed - 1]?.ts as string) + 1;
		expect(log.prune(cutoff)).toEqual({ segments: 1 });
		expect(verifyAuditFile(path).ok).toBe(true);
		expect(log.verify().ok).toBe(true);
		const head = log.head();
		log.close();
		const reopened = createAuditLog({ path, now: clock(), segmentBytes: MIB, anchorEvery: 2 });
		expect(reopened.verify().ok).toBe(true);
		expect(reopened.head()).toEqual(head);
		reopened.record("login_ok", { n: 9 });
		expect(verifyAuditFile(path).ok).toBe(true);
	});

	test("tampering a retained record after the boundary breaks the chain at the anchor that covers it", () => {
		const dir = tempDir();
		const path = auditPath(dir);
		const log = createAuditLog({ path, now: clock(), segmentBytes: MIB, anchorEvery: 2 });
		fill(log, 1, 200);
		const sealed = sealedIn(dir)[0] as string;
		const lastSealed = Number(/-(\d+)\.jsonl$/.exec(sealed)?.[1]);
		const cutoff = Date.parse(records(join(dir, sealed))[lastSealed - 1]?.ts as string) + 1;
		expect(log.prune(cutoff)).toEqual({ segments: 1 });
		log.close();
		// Edit one retained login and recompute every later link and hash, so only the anchors can expose the edit.
		const out = records(path);
		const at = out.findIndex((r, i) => i > 0 && r.event === "login_ok");
		let prev = (out[at - 1] as AuditRecord).hash;
		for (let i = at; i < out.length; i += 1) {
			const record = out[i] as AuditRecord;
			const edited = i === at ? { ...record, fields: { ...record.fields, n: -1 } } : record;
			out[i] = rehash({ ...edited, prev });
			prev = (out[i] as AuditRecord).hash;
		}
		rewrite(path, out.map((r) => JSON.stringify(r)));
		const v = verifyAuditFile(path);
		expect(v.ok).toBe(false);
		if (v.ok) return;
		expect(v.reason).toMatch(/anchor root does not match/);
	});

	test("a retained audit_retention_pruned record without a valid frontier fails closed", () => {
		for (const bad of [undefined, "{}", "not json"]) {
			const dir = tempDir();
			const path = auditPath(dir);
			const log = createAuditLog({ path, now: clock(), segmentBytes: MIB });
			fill(log, 1, 200);
			const sealed = sealedIn(dir)[0] as string;
			const lastSealed = Number(/-(\d+)\.jsonl$/.exec(sealed)?.[1]);
			const cutoff = Date.parse(records(join(dir, sealed))[lastSealed - 1]?.ts as string) + 1;
			expect(log.prune(cutoff)).toEqual({ segments: 1 });
			log.close();
			const out = records(path);
			const retention = out.at(-1) as AuditRecord;
			const fields: Record<string, string | number | boolean> = { ...retention.fields };
			if (bad === undefined) delete fields.frontier;
			else fields.frontier = bad;
			out[out.length - 1] = rehash({ ...retention, fields });
			rewrite(path, out.map((r) => JSON.stringify(r)));
			const v = verifyAuditFile(path);
			expect(v.ok).toBe(false);
			if (v.ok) return;
			expect(v.brokenAt).toBe(0);
			expect(v.reason).toMatch(/no valid frontier/);
			expect(existsSync(path)).toBe(true);
			expect(() => createAuditLog({ path, now: clock() })).toThrow(/cannot verify/);
		}
	});

	test("a boundary record that cannot be written removes no segment, and the chain still verifies", () => {
		const dir = tempDir();
		const path = auditPath(dir);
		const errors: Error[] = [];
		let failWrites = false;
		const fs: AuditFs = {
			...nodeFs,
			writeSync: ((fd: number, data: Buffer, offset: number, length: number) => {
				if (failWrites) throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
				return nodeFs.writeSync(fd, data, offset, length);
			}) as typeof nodeFs.writeSync,
		};
		const log = createAuditLog({ path, now: clock(), fs, segmentBytes: MIB, onError: (e) => errors.push(e) });
		fill(log, 1, 200);
		const sealedBefore = sealedIn(dir);
		failWrites = true;
		expect(log.prune(Number.MAX_SAFE_INTEGER)).toEqual({ segments: 0 });
		failWrites = false;
		expect(sealedIn(dir)).toEqual(sealedBefore);
		expect(errors).toHaveLength(1);
		expect(errors[0]?.message).toMatch(/retention record dropped: ENOSPC/);
		expect(verifyAuditFile(path).ok).toBe(true);
		expect(log.prune(Number.MAX_SAFE_INTEGER)).toEqual({ segments: sealedBefore.length });
		expect(sealedIn(dir)).toEqual([]);
		expect(verifyAuditFile(path).ok).toBe(true);
	});

	test("a segment that cannot be deleted after the boundary is written leaves a chain that verifies", () => {
		const dir = tempDir();
		const path = auditPath(dir);
		const errors: Error[] = [];
		let unlinks = 0;
		const fs: AuditFs = {
			...nodeFs,
			unlinkSync: ((target: nodeFs.PathLike) => {
				unlinks += 1;
				if (unlinks === 2) throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY" });
				nodeFs.unlinkSync(target);
			}) as typeof nodeFs.unlinkSync,
		};
		const log = createAuditLog({ path, now: clock(), fs, segmentBytes: MIB, onError: (e) => errors.push(e) });
		fill(log, 1, 400);
		const sealed = sealedIn(dir);
		expect(sealed.length).toBeGreaterThanOrEqual(2);
		expect(log.prune(Number.MAX_SAFE_INTEGER)).toEqual({ segments: 1 });
		expect(errors.map((e) => e.message)).toEqual([expect.stringMatching(/prune stopped at/)]);
		expect(sealedIn(dir)).toEqual(sealed.slice(1));
		expect(verifyAuditFile(path).ok).toBe(true);
		expect(records(path).at(-1)?.event).toBe("audit_retention_pruned");
		log.record("login_ok", { n: 999 });
		expect(verifyAuditFile(path).ok).toBe(true);
	});

	test("a boundary frontier over a different number of records fails closed", () => {
		const dir = tempDir();
		const path = auditPath(dir);
		const log = createAuditLog({ path, now: clock(), segmentBytes: MIB });
		fill(log, 1, 200);
		const sealed = sealedIn(dir)[0] as string;
		const lastSealed = Number(/-(\d+)\.jsonl$/.exec(sealed)?.[1]);
		const cutoff = Date.parse(records(join(dir, sealed))[lastSealed - 1]?.ts as string) + 1;
		expect(log.prune(cutoff)).toEqual({ segments: 1 });
		log.close();
		// A frontier that is valid on its own but covers one record, not the records before the boundary.
		const wrong = createFrontier();
		wrong.push("a".repeat(64));
		const out = lines(path);
		const retention = JSON.parse(out.at(-1) as string) as AuditRecord;
		out[out.length - 1] = JSON.stringify(rehash({ ...retention, fields: { ...retention.fields, frontier: JSON.stringify(wrong.snapshot()) } }));
		rewrite(path, out);
		const v = verifyAuditFile(path);
		expect(v.ok).toBe(false);
		if (v.ok) return;
		expect(v.brokenAt).toBe(0);
		expect(v.reason).toMatch(/carries a frontier over 1 records/);
		expect(() => createAuditLog({ path, now: clock() })).toThrow(/cannot verify/);
	});
});
