// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendActivity, readActivity } from "./activity.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function stateDir(): string {
	const root = mkdtempSync(join(tmpdir(), "ut-activity-"));
	roots.push(root);
	return root;
}

const created = {
	v: 1,
	kind: "teachable-created",
	title: "Teachable moment",
	outcome: "created",
	names: ["Retry the flaky fetch"],
	detail: "playbook · confirmed · retain retained",
};

describe("activity receipts", () => {
	test("append then read round-trips a created notice and does not store a body", () => {
		const dir = stateDir();
		appendActivity(dir, { ...created, body: "LESSON BODY MUST NOT BE STORED", documentId: "tm:secret" });
		const rows = readActivity(dir);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject(created);
		expect(rows[0]?.id).toMatch(/^[0-9a-f]{8}$/);
		const raw = readFileSync(join(dir, "teach", "activity.ndjson"), "utf8");
		expect(raw).not.toContain("LESSON BODY MUST NOT BE STORED");
		expect(raw).not.toContain("documentId");
		expect(raw).not.toContain("tm:secret");
	});

	test("a secret-shaped name is redacted before it is stored", () => {
		const dir = stateDir();
		appendActivity(dir, { ...created, names: ["sk-abcdefghijklmnopqrstuvwxyz"] });
		const raw = readFileSync(join(dir, "teach", "activity.ndjson"), "utf8");
		expect(raw).not.toContain("sk-");
		expect(readActivity(dir)[0]?.names?.[0]).toBe("[redacted]");
	});

	test("the 51st append drops the oldest line", () => {
		const dir = stateDir();
		for (let i = 0; i < 51; i++) appendActivity(dir, { ...created, detail: `line ${i}` });
		const rows = readActivity(dir);
		expect(rows).toHaveLength(50);
		expect(rows[0]?.detail).toBe("line 1");
		expect(rows.at(-1)?.detail).toBe("line 50");
	});

	test("a malformed line is skipped", () => {
		const dir = stateDir();
		appendActivity(dir, created);
		const path = join(dir, "teach", "activity.ndjson");
		writeFileSync(path, `not-json\n{"id":"abcd1234","v":1}\n${readFileSync(path, "utf8")}`);
		const rows = readActivity(dir);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.title).toBe("Teachable moment");
	});

	test("append never throws when the state directory cannot be created", () => {
		const root = stateDir();
		const blocker = join(root, "blocker");
		writeFileSync(blocker, "not a directory");
		expect(() => appendActivity(join(blocker, "child"), created)).not.toThrow();
		expect(readActivity(join(blocker, "child"))).toEqual([]);
	});
});
