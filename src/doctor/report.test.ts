// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import { buildReport, formatReport, reportJson } from "./report.ts";
import type { DoctorReport, Finding } from "./types.ts";

const FINDINGS: Finding[] = [
	{ id: "state.dir", section: "state", level: "ok", title: "State directory is writable: /s" },
	{ id: "config.user.missing", section: "config", level: "info", title: "user config: not found (optional)", detail: "File: /c.json" },
	{ id: "runtime.git", section: "runtime", level: "ok", title: "git found on PATH" },
	{
		id: "config.user.unknown-key.ship.autoMerg",
		section: "config",
		level: "warn",
		title: "user config: unknown key ship.autoMerg",
		detail: "Ignored by the merge.\nFile: /c.json",
		fix: "Did you mean ship.autoMerge?",
	},
	{ id: "credentials.greptile", section: "credentials", level: "warn", title: "Greptile: no credential" },
	{ id: "runtime.bun", section: "runtime", level: "error", title: "Bun 1.1.0 is older than 1.2" },
];

describe("buildReport", () => {
	test("orders findings by section, keeps order inside a section, and counts every level", () => {
		const report = buildReport(FINDINGS);
		expect(report.findings.map((finding) => finding.id)).toEqual([
			"runtime.git",
			"runtime.bun",
			"config.user.missing",
			"config.user.unknown-key.ship.autoMerg",
			"credentials.greptile",
			"state.dir",
		]);
		expect(report.summary).toEqual({ error: 1, warn: 2, info: 1, ok: 2 });
		expect(report.ok).toBe(false);
	});

	test("ok is true with warnings but no error, and for an empty list", () => {
		expect(buildReport(FINDINGS.filter((finding) => finding.level !== "error")).ok).toBe(true);
		expect(buildReport([])).toEqual({ ok: true, summary: { error: 0, warn: 0, info: 0, ok: 0 }, findings: [] });
	});
});

describe("formatReport", () => {
	test("prints the four sections in order with markers, indented detail and fix lines, and a summary", () => {
		expect(formatReport(buildReport(FINDINGS))).toBe(
			[
				"ultrathink doctor",
				"runtime",
				"  ✓ git found on PATH",
				"  ✗ Bun 1.1.0 is older than 1.2",
				"config",
				"  i user config: not found (optional)",
				"      File: /c.json",
				"  ! user config: unknown key ship.autoMerg",
				"      Ignored by the merge.",
				"      File: /c.json",
				"      fix: Did you mean ship.autoMerge?",
				"credentials",
				"  ! Greptile: no credential",
				"state",
				"  ✓ State directory is writable: /s",
				"1 error, 2 warnings",
			].join("\n"),
		);
	});

	test("an empty report still lists the sections and a zero summary", () => {
		expect(formatReport(buildReport([]))).toBe("ultrathink doctor\nruntime\nconfig\ncredentials\nstate\n0 errors, 0 warnings");
	});

	test("a bearer token or JWT that reached a finding is masked", () => {
		const jwt = `${"a".repeat(24)}.${"b".repeat(24)}.${"c".repeat(12)}`;
		const text = formatReport(
			buildReport([
				{ id: "runtime.x", section: "runtime", level: "warn", title: "sent Bearer sk-test-not-a-real-key upstream", detail: jwt, fix: `use ${jwt}` },
			]),
		);
		expect(text).not.toContain("sk-test-not-a-real-key");
		expect(text).not.toContain(jwt);
		expect(text).toContain("[redacted]");
	});
});

describe("reportJson", () => {
	test("is one object with a fixed key order and optional keys only when present", () => {
		const parsed: DoctorReport = JSON.parse(reportJson(buildReport(FINDINGS)));
		expect(Object.keys(parsed)).toEqual(["ok", "summary", "findings"]);
		expect(Object.keys(parsed.summary)).toEqual(["error", "warn", "info", "ok"]);
		expect(parsed.ok).toBe(false);
		expect(Object.keys(parsed.findings[0] ?? {})).toEqual(["id", "section", "level", "title"]);
		expect(Object.keys(parsed.findings[3] ?? {})).toEqual(["id", "section", "level", "title", "detail", "fix"]);
		expect(parsed.findings[3]?.detail).toBe("Ignored by the merge.\nFile: /c.json");
	});

	test("is a single line and stays valid JSON when a masked value contained quotes", () => {
		const json = reportJson(
			buildReport([{ id: "runtime.x", section: "runtime", level: "warn", title: 'Bearer tok"en end', detail: "line one\nline two" }]),
		);
		expect(json).not.toContain("\n");
		const parsed: DoctorReport = JSON.parse(json);
		expect(parsed.findings[0]?.title).not.toContain("tok");
	});
});
