// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
//
// Tests for policy/compliance-report.ts. Each case runs the real CLI in a child process. The failure cases build a temp
// tree from the real evidence paths, so the removed file is the only difference from the repository.
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "..");
const SCRIPT = resolve(import.meta.dir, "compliance-report.ts");
const CONTROLS = resolve(import.meta.dir, "controls.json");

interface ControlSpec {
	id: string;
	evidence: string[];
	pending?: string;
}

const CONTROL_SPECS: ControlSpec[] = JSON.parse(readFileSync(CONTROLS, "utf8"));

const tempRoots: string[] = [];

afterEach(() => {
	for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempRoots.push(dir);
	return dir;
}

async function runReport(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
	const proc = Bun.spawn({ cmd: [process.execPath, SCRIPT, ...args], stdout: "pipe", stderr: "pipe" });
	const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
	return { code: await proc.exited, stdout, stderr };
}

/** The summary-table row for one control, or undefined when the control is not listed. */
function statusRow(output: string, id: string): string | undefined {
	return output.split("\n").find((line) => line.startsWith(`| \`${id}\` |`));
}

test("real repo: exit 0, CRYPTO-BACKUP PENDING, RETENTION finding listed, every evidence sha256 matches the file", async () => {
	const { code, stdout, stderr } = await runReport(["--root", REPO]);
	expect(stderr).toBe("");
	expect(code).toBe(0);
	expect(statusRow(stdout, "CRYPTO-BACKUP")).toContain("| PENDING |");
	expect(stdout).toContain("**RET-D7**");
	for (const spec of CONTROL_SPECS) {
		if (spec.pending === undefined) expect(statusRow(stdout, spec.id)).toContain("| PASS |");
		for (const path of spec.evidence) {
			const digest = createHash("sha256").update(readFileSync(join(REPO, path))).digest("hex");
			const line = stdout.split("\n").find((text) => text.startsWith(`  - \`${path}\` sha256 `));
			expect(line).toBe(`  - \`${path}\` sha256 \`${digest}\``);
		}
	}
});

test("a tree with one evidence file removed: that control FAILs and the exit code is 1", async () => {
	const root = tempDir("ultrathink-compliance-");
	for (const spec of CONTROL_SPECS) {
		for (const path of spec.evidence) {
			mkdirSync(dirname(join(root, path)), { recursive: true });
			copyFileSync(join(REPO, path), join(root, path));
		}
	}
	const removed = "services/ultrathink/auth/auth.ts";
	rmSync(join(root, removed));

	const { code, stdout } = await runReport(["--root", root]);
	expect(code).toBe(1);
	expect(statusRow(stdout, "ACCESS")).toContain("| FAIL |");
	expect(stdout).toContain(`\`${removed}\` **MISSING**`);
	for (const spec of CONTROL_SPECS) {
		if (spec.id !== "ACCESS") expect(statusRow(stdout, spec.id)).not.toContain("| FAIL |");
	}
	expect(statusRow(stdout, "CRYPTO-BACKUP")).toContain("| PENDING |");
});

test("a control with no evidence and no pending reason is a schema error: exit 2, and no report is written", async () => {
	const dir = tempDir("ultrathink-compliance-schema-");
	const controls = join(dir, "controls.json");
	const empty = { id: "EMPTY", title: "No evidence", refs: { soc2: [], iso27001: [], gdpr: [] }, evidence: [] };
	writeFileSync(controls, JSON.stringify([empty]));

	const { code, stdout, stderr } = await runReport(["--root", REPO, "--controls", controls]);
	expect(code).toBe(2);
	expect(stdout).toBe("");
	expect(stderr).toContain("EMPTY");
});

test("--out writes the Markdown report to the file and leaves stdout empty", async () => {
	const dir = tempDir("ultrathink-compliance-out-");
	const out = join(dir, "report.md");

	const { code, stdout } = await runReport(["--root", REPO, "--out", out]);
	expect(code).toBe(0);
	expect(stdout).toBe("");
	expect(readFileSync(out, "utf8")).toContain("# Compliance evidence report");
});
