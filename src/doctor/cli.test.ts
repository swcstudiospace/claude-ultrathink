// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { writeStore } from "../mcp/store.ts";
import { runDoctorCommand } from "./cli.ts";
import type { DoctorDeps, DoctorReport } from "./types.ts";

const FAKE_KEY = "sk-test-not-a-real-key-4242424242";
const USAGE = "Usage: ultrathink doctor [--json]";

describe("runDoctorCommand", () => {
	let dir: string;
	let deps: Partial<DoctorDeps>;

	function projectConfig(content: string): void {
		const path = join(dir, "project", ".claude", "ultrathink.json");
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, content);
	}

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "ut-doctor-cli-"));
		mkdirSync(join(dir, "project"));
		deps = {
			env: {
				HOME: join(dir, "home"),
				XDG_CONFIG_HOME: join(dir, "xdg"),
				CLAUDE_CONFIG_DIR: join(dir, "claude"),
				ULTRATHINK_STATE_DIR: join(dir, "state"),
				ULTRATHINK_MCP_STORE: join(dir, "mcp-credentials.json"),
				GH_CONFIG_DIR: join(dir, "gh"),
			},
			cwd: join(dir, "project"),
			now: () => 1_800_000_000_000,
			which: (command) => (["git", "gh", "python3"].includes(command) ? `/usr/bin/${command}` : undefined),
			bunVersion: "1.2.0",
			runVersion: () => "Python 3.12.1",
		};
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("a healthy machine exits 0 and the text report has the four sections and a summary", async () => {
		const { output, exitCode } = await runDoctorCommand([], deps);
		expect(exitCode).toBe(0);
		const lines = output.split("\n");
		expect(lines[0]).toBe("ultrathink doctor");
		expect(lines.filter((line) => /^[a-z]+$/.test(line))).toEqual(["runtime", "config", "credentials", "state"]);
		expect(lines.at(-1)).toBe("0 errors, 0 warnings");
		expect(output).not.toEndWith("\n");
	});

	test("the text output is identical across runs with a fixed clock", async () => {
		const first = await runDoctorCommand([], deps);
		const second = await runDoctorCommand([], deps);
		expect(second).toEqual(first);
	});

	test("a warning alone keeps exit 0 and is counted", async () => {
		projectConfig(`{"ship":{"autoMerg":true}}`);
		const { output, exitCode } = await runDoctorCommand([], deps);
		expect(exitCode).toBe(0);
		expect(output).toContain("  ! project config: unknown key ship.autoMerg");
		expect(output).toContain("      fix: Did you mean ship.autoMerge?");
		expect(output.split("\n").at(-1)).toBe("0 errors, 1 warning");
	});

	test("an error finding exits 1", async () => {
		projectConfig("{ not json");
		const { output, exitCode } = await runDoctorCommand([], deps);
		expect(exitCode).toBe(1);
		expect(output).toContain("  ✗ project config: not valid JSON; every key in it is ignored");
		expect(output.split("\n").at(-1)).toBe("1 error, 0 warnings");
	});

	test("a missing git is an error too", async () => {
		const { exitCode, output } = await runDoctorCommand([], { ...deps, which: () => undefined });
		expect(exitCode).toBe(1);
		expect(output).toContain("git not found on PATH");
	});

	const BAD_ARGUMENTS: string[][] = [["--bogus"], ["check"], ["--json", "extra"], ["-j"]];
	for (const args of BAD_ARGUMENTS) {
		test(`${args.join(" ")} is a usage error`, async () => {
			expect(await runDoctorCommand(args, deps)).toEqual({ output: USAGE, exitCode: 2 });
		});
	}

	test("--json prints one stable object whose ok matches the exit code", async () => {
		projectConfig(`{"shipp":{}}`);
		const { output, exitCode } = await runDoctorCommand(["--json"], deps);
		expect(exitCode).toBe(0);
		const report: DoctorReport = JSON.parse(output);
		expect(Object.keys(report)).toEqual(["ok", "summary", "findings"]);
		expect(report.ok).toBe(true);
		expect(report.summary).toMatchObject({ error: 0, warn: 1 });
		expect(report.findings.map((finding) => finding.section)).toEqual(
			[...report.findings.map((finding) => finding.section)].sort(
				(a, b) => ["runtime", "config", "credentials", "state"].indexOf(a) - ["runtime", "config", "credentials", "state"].indexOf(b),
			),
		);
		const typo = report.findings.find((finding) => finding.id === "config.project.unknown-section.shipp");
		expect(typo).toMatchObject({ section: "config", level: "warn", fix: "Did you mean ship?" });

		projectConfig("[");
		const failing = await runDoctorCommand(["--json"], deps);
		expect(failing.exitCode).toBe(1);
		expect(JSON.parse(failing.output)).toMatchObject({ ok: false });
	});

	test("fake keys in the environment and the credential store never appear in text or JSON", async () => {
		writeStore(join(dir, "mcp-credentials.json"), {
			version: 1,
			providers: { greptile: { kind: "api_key", apiKey: FAKE_KEY, updatedAt: 0 }, ragflow: { kind: "api_key", apiKey: FAKE_KEY, updatedAt: 0 } },
		});
		mkdirSync(join(dir, "xdg", "ultrathink"), { recursive: true });
		writeFileSync(
			join(dir, "xdg", "ultrathink", "config.json"),
			JSON.stringify({ ship: { enabled: true }, hitl: { knowledgeBase: true }, ragflow: { enabled: true }, hindsight: { enabled: true } }),
		);
		const env = { ...deps.env, OPENROUTER_API_KEY: FAKE_KEY, HINDSIGHT_API_KEY: FAKE_KEY, GH_TOKEN: FAKE_KEY, AI_GATEWAY_API_KEY: FAKE_KEY };
		for (const args of [[], ["--json"]]) {
			const { output } = await runDoctorCommand(args, { ...deps, env });
			expect(output).not.toContain(FAKE_KEY);
			expect(output).not.toContain("sk-test");
			expect(output).not.toMatch(new RegExp(`\\b${FAKE_KEY.length}\\b`));
			expect(output).toContain("Greptile: credential present (credential store)");
			expect(output).toContain("RAGFlow: credential present (credential store)");
			expect(output).toContain("Hindsight: credential present (HINDSIGHT_API_KEY)");
		}
	});

	test("a check that throws becomes an error finding and the other sections still print", async () => {
		const { output, exitCode } = await runDoctorCommand([], {
			...deps,
			which: () => {
				throw new Error("PATH lookup failed");
			},
		});
		expect(exitCode).toBe(1);
		expect(output).toContain("  ✗ the runtime check failed to run");
		expect(output).toContain("PATH lookup failed");
		expect(output).toContain("  i user config: not found (optional)");
	});

	test("it opens no network connection", async () => {
		const original = globalThis.fetch;
		const calls: unknown[] = [];
		globalThis.fetch = ((...args: unknown[]) => {
			calls.push(args);
			throw new Error("network is off in this test");
		}) as unknown as typeof fetch;
		try {
			await runDoctorCommand(["--json"], deps);
		} finally {
			globalThis.fetch = original;
		}
		expect(calls).toEqual([]);
	});
});
