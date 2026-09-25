// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import { shipApplies } from "./policy.ts";
import { shipPrecheck } from "./precheck.ts";
import { DEFAULT_SHIP_CONFIG, type Run } from "./types.ts";

describe("shipApplies", () => {
	const config = DEFAULT_SHIP_CONFIG;
	test("matches gsd- prefix only", () => {
		expect(shipApplies(config, "gsd-autonomous", {})).toBe(true);
		expect(shipApplies(config, "ultrathink-plan", {})).toBe(false);
		expect(shipApplies(config, undefined, {})).toBe(false);
	});
	test("disabled or env opt-out wins", () => {
		expect(shipApplies({ ...config, enabled: false }, "gsd-autonomous", {})).toBe(false);
		expect(shipApplies(config, "gsd-autonomous", { ULTRATHINK_SHIP: "0" })).toBe(false);
	});
	test("empty skills list applies to every run", () => {
		expect(shipApplies({ ...config, skills: [] }, undefined, {})).toBe(true);
	});
});

function fakeGit(responses: Record<string, { exitCode?: number; stdout?: string }>): Run {
	return (argv) => {
		const r = responses[argv.slice(1).join(" ")];
		return { exitCode: r ? (r.exitCode ?? 0) : 1, stdout: r?.stdout ?? "", stderr: "" };
	};
}

describe("shipPrecheck", () => {
	const originHead = { "symbolic-ref --short refs/remotes/origin/HEAD": { stdout: "origin/master\n" } };
	test("on base branch is not ok", () => {
		const run = fakeGit({ "rev-parse --abbrev-ref HEAD": { stdout: "master\n" }, ...originHead });
		expect(shipPrecheck("/x", run)).toMatchObject({ ok: false, base: "master" });
	});
	test("detached HEAD is not ok", () => {
		expect(shipPrecheck("/x", fakeGit({ "rev-parse --abbrev-ref HEAD": { stdout: "HEAD\n" } })).ok).toBe(false);
	});
	test("zero commits ahead is not ok", () => {
		const run = fakeGit({
			"rev-parse --abbrev-ref HEAD": { stdout: "feat\n" },
			...originHead,
			"rev-list --count origin/master..HEAD": { stdout: "0\n" },
		});
		expect(shipPrecheck("/x", run)).toMatchObject({ ok: false, ahead: 0 });
	});
	test("feature branch ahead uses origin/HEAD base", () => {
		const run = fakeGit({
			"rev-parse --abbrev-ref HEAD": { stdout: "feat\n" },
			"symbolic-ref --short refs/remotes/origin/HEAD": { stdout: "origin/trunk\n" },
			"rev-list --count origin/trunk..HEAD": { stdout: "3\n" },
		});
		expect(shipPrecheck("/x", run)).toMatchObject({ ok: true, branch: "feat", base: "trunk", ahead: 3 });
	});
	test("missing origin/HEAD falls back to existing origin/master", () => {
		const run = fakeGit({
			"rev-parse --abbrev-ref HEAD": { stdout: "feat\n" },
			"rev-parse --verify --quiet refs/remotes/origin/master": { stdout: "abc\n" },
			"rev-list --count origin/master..HEAD": { stdout: "2\n" },
		});
		expect(shipPrecheck("/x", run)).toMatchObject({ ok: true, base: "master", ahead: 2 });
	});
});
