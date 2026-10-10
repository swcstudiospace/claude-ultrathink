// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDoctorCommand } from "./cli.ts";
import { checkPstack } from "./pstack-check.ts";
import type { DoctorDeps, Finding } from "./types.ts";

const SKILLS = ["how", "architect", "arena", "tdd", "interrogate", "no-comments"];

function deps(dir: string, env: DoctorDeps["env"] = {}): DoctorDeps {
	return {
		env: { HOME: join(dir, "home"), ...env },
		cwd: join(dir, "project"),
		now: () => 0,
		which: () => undefined,
		bunVersion: "1.2.0",
		runVersion: () => undefined,
	};
}

function byId(findings: readonly Finding[], id: string): Finding {
	const found = findings.find((finding) => finding.id === id);
	if (!found) throw new Error(`missing finding ${id}`);
	return found;
}

function plantPlugin(cursorDir: string, missing: string[] = []): string {
	const root = join(cursorDir, "plugins", "cache", "cursor-public", "pstack", "synth");
	mkdirSync(join(root, ".cursor-plugin"), { recursive: true });
	writeFileSync(join(root, ".cursor-plugin", "plugin.json"), JSON.stringify({ name: "pstack", version: "1.2.3" }));
	writeFileSync(join(root, ".cache-complete"), "");
	for (const name of SKILLS) {
		if (missing.includes(name)) continue;
		mkdirSync(join(root, "skills", name), { recursive: true });
		writeFileSync(join(root, "skills", name, "SKILL.md"), `# ${name}\n`);
	}
	return root;
}

function plantHook(cursorDir: string): void {
	const hooks = join(cursorDir, "hooks");
	mkdirSync(hooks, { recursive: true });
	writeFileSync(join(hooks, "ultrathink-cursor-pstack.js"), "// staged\n");
	writeFileSync(
		join(cursorDir, "hooks.json"),
		JSON.stringify({
			hooks: {
				beforeSubmitPrompt: [
					{ type: "command", command: "node gsd.js", "gsd-managed": true },
					{ type: "command", command: `node ${join(hooks, "ultrathink-cursor-pstack.js")}`, "ultrathink-managed": true },
				],
			},
		}),
	);
}

describe("checkPstack", () => {
	test("a machine that never opted in is info only, with the default as the deciding source", () => {
		const dir = mkdtempSync(join(tmpdir(), "pstack-doctor-off-"));
		try {
			const findings = checkPstack(deps(dir));
			expect(findings.every((finding) => finding.section === "pstack")).toBe(true);
			expect(findings.some((finding) => finding.level === "warn" || finding.level === "error")).toBe(false);
			expect(byId(findings, "pstack.enabled")).toMatchObject({
				level: "info",
				title: "pstack bridge disabled",
				detail: expect.stringContaining("Deciding source: default"),
			});
			expect(byId(findings, "pstack.plugin").level).toBe("info");
			expect(byId(findings, "pstack.skills").detail).toContain("plan: architect, arena");
			expect(byId(findings, "pstack.hook").level).toBe("info");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("an enabled user file, a resolved plugin and an installed hook are ok, in text and JSON", async () => {
		const dir = mkdtempSync(join(tmpdir(), "pstack-doctor-on-"));
		try {
			const cursorDir = join(dir, "cursor");
			const root = plantPlugin(cursorDir);
			plantHook(cursorDir);
			const configDir = join(dir, "xdg", "ultrathink");
			mkdirSync(configDir, { recursive: true });
			writeFileSync(join(configDir, "config.json"), JSON.stringify({ pstack: { enabled: true } }));
			const env = { HOME: join(dir, "home"), XDG_CONFIG_HOME: join(dir, "xdg"), ULTRATHINK_PSTACK_CURSOR_DIR: cursorDir };
			const findings = checkPstack(deps(dir, env));
			expect(byId(findings, "pstack.enabled")).toMatchObject({ level: "ok", detail: `Deciding source: ${join(configDir, "config.json")}` });
			expect(byId(findings, "pstack.plugin")).toMatchObject({ level: "ok", title: "pstack 1.2.3", detail: root });
			expect(byId(findings, "pstack.skills")).toMatchObject({ level: "ok" });
			expect(byId(findings, "pstack.skills").detail).toContain(join(root, "skills", "architect", "SKILL.md"));
			expect(byId(findings, "pstack.hook").level).toBe("ok");

			const text = await runDoctorCommand([], { ...deps(dir, env), which: () => "/usr/bin/git", runVersion: () => "Python 3.12" });
			expect(text.exitCode).toBe(0);
			expect(text.output).toContain("pstack\n");
			expect(text.output).toContain("  ✓ pstack bridge enabled");
			expect(text.output).toContain("  ✓ pstack 1.2.3");
			const json = await runDoctorCommand(["--json"], { ...deps(dir, env), which: () => "/usr/bin/git", runVersion: () => "Python 3.12" });
			const report = JSON.parse(json.output) as { findings: Finding[] };
			expect(report.findings.some((finding) => finding.id === "pstack.hook" && finding.level === "ok")).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a project file cannot enable the bridge, and the first user file wins over a later one", () => {
		const dir = mkdtempSync(join(tmpdir(), "pstack-doctor-project-"));
		try {
			const home = join(dir, "home");
			mkdirSync(join(home, ".config", "ultrathink"), { recursive: true });
			writeFileSync(join(home, ".config", "ultrathink", "config.json"), JSON.stringify({ ship: { enabled: false } }));
			mkdirSync(join(home, ".claude"), { recursive: true });
			writeFileSync(join(home, ".claude", "ultrathink.json"), JSON.stringify({ pstack: { enabled: true } }));
			const project = join(dir, "project", ".claude");
			mkdirSync(project, { recursive: true });
			writeFileSync(join(project, "ultrathink.json"), JSON.stringify({ pstack: { enabled: true } }));
			const findings = checkPstack(deps(dir));
			expect(byId(findings, "pstack.enabled")).toMatchObject({ level: "info", detail: expect.stringContaining(join(home, ".config", "ultrathink", "config.json")) });
			expect(byId(findings, "pstack.project-ignored").level).toBe("info");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("an unknown mapped skill is a warning, not an error", () => {
		const dir = mkdtempSync(join(tmpdir(), "pstack-doctor-unknown-"));
		try {
			const cursorDir = join(dir, "cursor");
			plantPlugin(cursorDir);
			const home = join(dir, "home");
			mkdirSync(join(home, ".config", "ultrathink"), { recursive: true });
			writeFileSync(
				join(home, ".config", "ultrathink", "config.json"),
				JSON.stringify({ pstack: { enabled: true, mapping: { plan: ["architect", "not-a-skill"] } } }),
			);
			const findings = checkPstack(deps(dir, { ULTRATHINK_PSTACK_CURSOR_DIR: cursorDir }));
			const skills = byId(findings, "pstack.skills");
			expect(skills.level).toBe("warn");
			expect(skills.title).toContain("plan/not-a-skill");
			expect(findings.some((finding) => finding.level === "error")).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("ULTRATHINK_PSTACK=0 disables the bridge even when the user config enables it", () => {
		const dir = mkdtempSync(join(tmpdir(), "pstack-doctor-off-switch-"));
		try {
			const home = join(dir, "home");
			mkdirSync(join(home, ".config", "ultrathink"), { recursive: true });
			writeFileSync(join(home, ".config", "ultrathink", "config.json"), JSON.stringify({ pstack: { enabled: true } }));
			const findings = checkPstack(deps(dir, { ULTRATHINK_PSTACK: "0" }));
			expect(byId(findings, "pstack.enabled")).toMatchObject({
				level: "info",
				title: "pstack bridge disabled",
				detail: expect.stringContaining("ULTRATHINK_PSTACK=0"),
			});
			expect(findings.some((finding) => finding.level === "warn" || finding.level === "error")).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("a parsed non-object stops the search before a later enabling file", () => {
		const dir = mkdtempSync(join(tmpdir(), "pstack-doctor-null-"));
		try {
			const home = join(dir, "home");
			mkdirSync(join(home, ".config", "ultrathink"), { recursive: true });
			writeFileSync(join(home, ".config", "ultrathink", "config.json"), "null");
			mkdirSync(join(home, ".claude"), { recursive: true });
			writeFileSync(join(home, ".claude", "ultrathink.json"), JSON.stringify({ pstack: { enabled: true } }));
			const findings = checkPstack(deps(dir));
			const enabled = byId(findings, "pstack.enabled");
			expect(enabled.level).toBe("info");
			expect(enabled.detail).toContain(join(home, ".config", "ultrathink", "config.json"));
			expect(enabled.detail).not.toContain("ultrathink.json");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("invalid JSON is skipped so a later enabling file still wins", () => {
		const dir = mkdtempSync(join(tmpdir(), "pstack-doctor-bad-json-"));
		try {
			const home = join(dir, "home");
			mkdirSync(join(home, ".config", "ultrathink"), { recursive: true });
			writeFileSync(join(home, ".config", "ultrathink", "config.json"), "{");
			mkdirSync(join(home, ".claude"), { recursive: true });
			const claude = join(home, ".claude", "ultrathink.json");
			writeFileSync(claude, JSON.stringify({ pstack: { enabled: true } }));
			const findings = checkPstack(deps(dir));
			expect(byId(findings, "pstack.enabled")).toMatchObject({ level: "ok", detail: expect.stringContaining(claude) });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("missing skills are info while the bridge is disabled", () => {
		const dir = mkdtempSync(join(tmpdir(), "pstack-doctor-missing-off-"));
		try {
			const cursorDir = join(dir, "cursor");
			plantPlugin(cursorDir, ["architect"]);
			const findings = checkPstack(deps(dir, { ULTRATHINK_PSTACK_CURSOR_DIR: cursorDir }));
			const skills = byId(findings, "pstack.skills");
			expect(skills.level).toBe("info");
			expect(skills.title).toContain("architect");
			expect(skills.fix).toBeUndefined();
			expect(findings.some((finding) => finding.level === "warn" || finding.level === "error")).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
