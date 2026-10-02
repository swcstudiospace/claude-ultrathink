// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isValidId, openStore, storeDir } from "./store.ts";
import type { TeachableMoment } from "./types.ts";

const dirs: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "ultrathink-teach-store-"));
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function moment(id: string, overrides: Partial<TeachableMoment> = {}): TeachableMoment {
	return {
		id,
		name: `lesson ${id}`,
		description: "description",
		body: "body",
		sourcePhase: "phase-1",
		sourceArtifacts: ["a.ts"],
		createdAt: "2026-01-01T00:00:00.000Z",
		tags: ["t"],
		relatedIds: [],
		schema: 2,
		kind: "pitfall",
		status: "confirmed",
		origin: "explicit",
		project: "proj",
		host: "claude-code",
		confidence: 1,
		occurrences: 1,
		lastSeenAt: "2026-01-01T00:00:00.000Z",
		dedupeKey: `key-${id}`,
		recalled: 0,
		...overrides,
	};
}

function openTemp() {
	const root = tempDir();
	const dir = storeDir(root);
	return { root, dir, store: openStore(dir) };
}

describe("moments", () => {
	test("a moment round-trips, including retained and promoted records", () => {
		const { store } = openTemp();
		const full = moment("m1", {
			supersedes: "m0",
			retained: { at: "2026-01-02T00:00:00.000Z", bank: "ultrathink", documentId: "tm:m1" },
			promoted: { at: "2026-01-03T00:00:00.000Z", skill: "my-skill", target: "omp", path: "/x/SKILL.md" },
		});
		store.put(full);
		expect(store.get("m1")).toEqual(full);
		expect(store.findByDedupeKey("key-m1")?.id).toBe("m1");
		expect(store.findByDedupeKey("nope")).toBeUndefined();
		expect(store.get("missing")).toBeUndefined();
	});

	test("list is newest lastSeenAt first and put replaces in place", () => {
		const { store } = openTemp();
		store.put(moment("old", { lastSeenAt: "2026-01-01T00:00:00.000Z" }));
		store.put(moment("new", { lastSeenAt: "2026-03-01T00:00:00.000Z" }));
		store.put(moment("mid", { lastSeenAt: "2026-02-01T00:00:00.000Z" }));
		expect(store.list().map((m) => m.id)).toEqual(["new", "mid", "old"]);
		store.put(moment("old", { lastSeenAt: "2026-04-01T00:00:00.000Z", occurrences: 2 }));
		expect(store.list().map((m) => m.id)).toEqual(["old", "new", "mid"]);
		expect(store.get("old")?.occurrences).toBe(2);
	});

	test("findByDedupeKey prefers a live moment over a superseded one with the same key", () => {
		const { store } = openTemp();
		store.put(moment("replaced", { dedupeKey: "k", status: "superseded", lastSeenAt: "2026-05-01T00:00:00.000Z" }));
		store.put(moment("live", { dedupeKey: "k", lastSeenAt: "2026-01-01T00:00:00.000Z" }));
		expect(store.findByDedupeKey("k")?.id).toBe("live");
	});

	test("remove reports whether a file existed; bumpRecalled counts known ids once per call", () => {
		const { store } = openTemp();
		store.put(moment("m1"));
		store.bumpRecalled(["m1", "m1", "ghost"]);
		expect(store.get("m1")?.recalled).toBe(1);
		store.bumpRecalled(["m1"]);
		expect(store.get("m1")?.recalled).toBe(2);
		expect(store.remove("m1")).toBe(true);
		expect(store.remove("m1")).toBe(false);
		expect(store.get("ghost")).toBeUndefined();
	});

	test("directories are 0700, files 0600, and no temp file is left behind", () => {
		const { dir, store } = openTemp();
		store.put(moment("m1"));
		store.enqueue({ op: "retain", momentId: "m1" }, 1000);
		expect(statSync(dir).mode & 0o777).toBe(0o700);
		expect(statSync(join(dir, "moments")).mode & 0o777).toBe(0o700);
		expect(statSync(join(dir, "moments", "m1.json")).mode & 0o777).toBe(0o600);
		for (const file of readdirSync(join(dir, "outbox"))) {
			expect(file.endsWith(".json")).toBe(true);
			expect(statSync(join(dir, "outbox", file)).mode & 0o777).toBe(0o600);
		}
		expect(readdirSync(join(dir, "moments"))).toEqual(["m1.json"]);
	});
});

describe("corruption tolerance", () => {
	test("corrupt, foreign, mismatched and stray files are skipped, never thrown", () => {
		const { dir, store } = openTemp();
		store.put(moment("good"));
		const moments = join(dir, "moments");
		writeFileSync(join(moments, "garbage.json"), "{not json");
		writeFileSync(join(moments, "foreign.json"), JSON.stringify({ hello: "world" }));
		writeFileSync(join(moments, "array.json"), "[]");
		writeFileSync(join(moments, "wrong-id.json"), JSON.stringify(moment("another")));
		writeFileSync(join(moments, "old-schema.json"), JSON.stringify({ ...moment("old-schema"), schema: 1 }));
		writeFileSync(join(moments, "bad-kind.json"), JSON.stringify({ ...moment("bad-kind"), kind: "weird" }));
		writeFileSync(join(moments, "notes.txt"), "text");
		writeFileSync(join(moments, ".good.1.abcd.tmp"), "partial");
		expect(store.list().map((m) => m.id)).toEqual(["good"]);
		expect(store.get("garbage")).toBeUndefined();
		expect(store.get("wrong-id")).toBeUndefined();
		expect(store.findByDedupeKey("key-another")).toBeUndefined();
	});

	test("corrupt outbox entries are skipped and a missing store directory lists as empty", () => {
		const { dir, store } = openTemp();
		const entry = store.enqueue({ op: "delete", documentId: "tm:x" }, 5);
		mkdirSync(join(dir, "outbox"), { recursive: true });
		writeFileSync(join(dir, "outbox", "bad.json"), "nope");
		writeFileSync(join(dir, "outbox", "unknown-op.json"), JSON.stringify({ id: "unknown-op", op: { op: "explode" }, attempts: 0, nextAt: 0, enqueuedAt: 0 }));
		expect(store.outbox().map((e) => e.id)).toEqual([entry.id]);
		const empty = openStore(join(tempDir(), "never-created"));
		expect(empty.list()).toEqual([]);
		expect(empty.outbox()).toEqual([]);
	});

	test("a moment with missing optional fields reads back with safe defaults", () => {
		const { dir, store } = openTemp();
		mkdirSync(join(dir, "moments"), { recursive: true });
		const minimal = {
			id: "min",
			schema: 2,
			name: "n",
			body: "b",
			kind: "bug",
			status: "candidate",
			origin: "observe",
			dedupeKey: "k",
			createdAt: "2026-01-01T00:00:00.000Z",
			lastSeenAt: "2026-01-01T00:00:00.000Z",
			tags: ["ok", 5],
		};
		writeFileSync(join(dir, "moments", "min.json"), JSON.stringify(minimal));
		const read = store.get("min");
		expect(read?.tags).toEqual(["ok"]);
		expect(read).toMatchObject({ description: "", project: "unknown", host: "unknown", occurrences: 1, recalled: 0, confidence: 1, relatedIds: [] });
	});
});

describe("ids", () => {
	test("only [A-Za-z0-9_.-]{1,80} ids are valid", () => {
		for (const id of ["a", "tm_1.2-3", "A".repeat(80), "0f8fad5b-d9cb-469f-a165-70867728950e"]) expect(isValidId(id)).toBe(true);
		for (const id of ["", "../x", "a/b", "a\\b", "a b", ".", "..", "A".repeat(81), "tm:1", "a\0b", 7, undefined]) expect(isValidId(id)).toBe(false);
	});

	test("a hostile id cannot read, write, remove or ack outside the store", () => {
		const { root, store } = openTemp();
		const victim = join(root, "victim.json");
		writeFileSync(victim, JSON.stringify(moment("victim")));
		expect(store.get("../../victim")).toBeUndefined();
		expect(store.remove("../../victim")).toBe(false);
		store.ack("../../victim");
		store.bumpRecalled(["../../victim"]);
		expect(() => store.put(moment("../evil"))).toThrow();
		expect(existsSync(victim)).toBe(true);
		expect(readdirSync(root).sort()).toEqual(["victim.json"]);
	});

	test("a store under a .planning directory is refused", () => {
		const root = tempDir();
		expect(() => openStore(join(root, ".planning", "teach"))).toThrow();
	});
});

describe("outbox", () => {
	test("entries come back oldest first and ack removes them", () => {
		const { store } = openTemp();
		const second = store.enqueue({ op: "retain", momentId: "b" }, 2000);
		const first = store.enqueue({ op: "retain", momentId: "a" }, 1000);
		expect(store.outbox().map((e) => e.id)).toEqual([first.id, second.id]);
		expect(first).toMatchObject({ attempts: 0, nextAt: 1000, enqueuedAt: 1000 });
		store.ack(first.id);
		expect(store.outbox().map((e) => e.id)).toEqual([second.id]);
		store.ack(first.id);
		expect(store.outbox()).toHaveLength(1);
	});

	test("an identical pending op coalesces into the existing entry", () => {
		const { store } = openTemp();
		const a = store.enqueue({ op: "retain", momentId: "m1" }, 1000);
		const b = store.enqueue({ op: "retain", momentId: "m1" }, 9000);
		expect(b.id).toBe(a.id);
		expect(b.enqueuedAt).toBe(1000);
		store.enqueue({ op: "tags", documentId: "tm:m1", tags: ["x"] }, 1000);
		store.enqueue({ op: "tags", documentId: "tm:m1", tags: ["x"] }, 1000);
		store.enqueue({ op: "tags", documentId: "tm:m1", tags: ["y"] }, 1000);
		store.enqueue({ op: "delete", documentId: "tm:m1" }, 1000);
		expect(store.outbox()).toHaveLength(4);
		store.ack(a.id);
		const again = store.enqueue({ op: "retain", momentId: "m1" }, 3000);
		expect(again.id).not.toBe(a.id);
	});

	test("fail doubles the delay from one minute and caps it at six hours", () => {
		const { store } = openTemp();
		const entry = store.enqueue({ op: "retain", momentId: "m1" }, 0);
		const now = 1_000_000;
		const delays: number[] = [];
		for (let attempt = 1; attempt <= 11; attempt++) {
			store.fail(entry.id, "boom", now);
			const current = store.outbox()[0];
			expect(current?.attempts).toBe(attempt);
			delays.push((current?.nextAt ?? 0) - now);
		}
		const minute = 60_000;
		expect(delays.slice(0, 5)).toEqual([minute, 2 * minute, 4 * minute, 8 * minute, 16 * minute]);
		expect(delays[8]).toBe(256 * minute);
		expect(delays[9]).toBe(6 * 60 * minute);
		expect(delays[10]).toBe(6 * 60 * minute);
	});

	test("fail keeps a redacted one-line lastError and ignores unknown or invalid ids", () => {
		const { store } = openTemp();
		const entry = store.enqueue({ op: "delete", documentId: "tm:m1" }, 0);
		store.fail(entry.id, "retain failed\n(auth): Bearer abc123def456 rejected", 10);
		const failed = store.outbox()[0];
		expect(failed?.lastError).toBe("retain failed (auth): [redacted] rejected");
		store.fail("ghost", "x", 10);
		store.fail("../../x", "x", 10);
		expect(store.outbox()).toHaveLength(1);
	});
});
