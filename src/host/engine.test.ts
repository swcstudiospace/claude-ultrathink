// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultConfig, type UltrathinkConfig } from "../config.ts";
import type { ControlState } from "../claude/state.ts";
import type { HostId } from "./types.ts";
import { engineForSessionModel, engineLabel, GROK_LOGIN_REQUIRED, HOST_DEFAULT_ENGINES, MAX_ENGINE_ERROR_CHARS, selectEngine } from "./engine.ts";

const dirs: string[] = [];
afterEach(() => {
	while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function emptyHome(): string {
	const dir = mkdtempSync(join(tmpdir(), "ultrathink-engine-test-"));
	dirs.push(dir);
	return dir;
}

function configWith(overrides: Partial<UltrathinkConfig>): UltrathinkConfig {
	return { ...defaultConfig(), ...overrides };
}

async function labelOf(config: UltrathinkConfig, state: ControlState, host: HostId, sessionModel?: unknown): Promise<string> {
	const selected = await selectEngine(config, state, "/repo", host, sessionModel);
	return "skipped" in selected ? `skipped:${selected.skipped}` : selected.label;
}

describe("selectEngine host defaults (think.engine auto)", () => {
	test("muse host inherits the muse engine at muse-spark-1.3-contributor", async () => {
		expect(await labelOf(configWith({}), {}, "muse")).toBe("muse:muse-spark-1.3-contributor");
	});

	test("claude-code, hermes and omp hosts inherit the Muse engine", async () => {
		for (const host of ["claude-code", "hermes", "omp"] as const) {
			expect(await labelOf(configWith({}), {}, host)).toBe("claude:sonnet");
		}
	});

	test("grok-build inherits grok at grok-4.7 when usable (shunt needs no login)", async () => {
		const config = configWith({ grok: { ...defaultConfig().grok, transport: "shunt", shuntBaseUrl: "http://127.0.0.1:3001" } });
		expect(await labelOf(config, {}, "grok-build")).toBe("grok-4.7@shunt");
	});

	test("grok-build without a grok login falls back to Muse, marked unavailable", async () => {
		const config = configWith({ grok: { ...defaultConfig().grok, home: emptyHome(), fallbackToClaude: false } });
		expect(await labelOf(config, {}, "grok-build")).toBe("claude:sonnet (grok unavailable)");
	});

	test("grok-build with grok disabled falls back to Muse silently", async () => {
		const config = configWith({ grok: { ...defaultConfig().grok, enabled: false } });
		expect(await labelOf(config, {}, "grok-build")).toBe("claude:sonnet");
	});
});

describe("selectEngine explicit pins", () => {
	test("explicit think.engine wins over every host default", async () => {
		const config = configWith({ think: { ...defaultConfig().think, engine: "muse" } });
		for (const host of ["claude-code", "grok-build", "hermes", "muse", "omp"] as const) {
			expect(await labelOf(config, {}, host)).toBe("muse:muse-spark-1.3-contributor");
		}
		const claude = configWith({ think: { ...defaultConfig().think, engine: "claude" } });
		expect(await labelOf(claude, {}, "muse")).toBe("claude:sonnet");
	});

	test("explicit model wins over the host default model", async () => {
		const config = configWith({ muse: { ...defaultConfig().muse, model: "other-model" } });
		expect(await labelOf(config, {}, "muse")).toBe("muse:other-model");
	});

	test("control state engine wins over config", async () => {
		const config = configWith({ think: { ...defaultConfig().think, engine: "claude" } });
		expect(await labelOf(config, { engine: "muse" }, "claude-code")).toBe("muse:muse-spark-1.3-contributor");
	});

	test("empty muse model inherits the CLI session default in the label", async () => {
		const config = configWith({ muse: { ...defaultConfig().muse, model: "" } });
		expect(await labelOf(config, {}, "muse")).toBe("muse:session default");
	});
});

describe("selectEngine grok login handling", () => {
	test("explicit grok without login and no fallback is a visible skip", async () => {
		const config = configWith({
			think: { ...defaultConfig().think, engine: "grok" },
			grok: { ...defaultConfig().grok, home: emptyHome(), fallbackToClaude: false },
		});
		for (const host of ["claude-code", "grok-build"] as const) {
			expect(await labelOf(config, {}, host)).toBe(`skipped:${GROK_LOGIN_REQUIRED}`);
		}
	});

	test("explicit grok without login falls back when fallbackToClaude is set", async () => {
		const config = configWith({
			think: { ...defaultConfig().think, engine: "grok" },
			grok: { ...defaultConfig().grok, home: emptyHome(), fallbackToClaude: true },
		});
		expect(await labelOf(config, {}, "claude-code")).toBe("claude:sonnet (grok fallback)");
	});
});

describe("HOST_DEFAULT_ENGINES", () => {
	test("covers every host", () => {
		expect(Object.keys(HOST_DEFAULT_ENGINES).sort()).toEqual(["claude-code", "grok-build", "hermes", "muse", "omp"]);
	});
});

describe("engineLabel", () => {
	test("mirrors selection without auth checks", () => {
		const config = defaultConfig();
		expect(engineLabel(config, {}, "muse")).toBe("muse:muse-spark-1.3-contributor");
		expect(engineLabel(config, {}, "claude-code")).toBe("claude:sonnet");
		expect(engineLabel(config, {}, "grok-build")).toBe("grok-4.7@xhigh");
		expect(engineLabel(config, { engine: "muse" }, "claude-code")).toBe("muse:muse-spark-1.3-contributor");
	});
});

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Every .ts file under `dir`, recursively. */
function tsFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...tsFiles(path));
		else if (entry.name.endsWith(".ts")) out.push(path);
	}
	return out;
}

describe("Vercel is Jev-only: engine code never references it (JEV-03)", () => {
	const PATTERN = /vercel|ai_gateway|evaluation-model/i;

	test("no engine source file mentions vercel, AI_GATEWAY or evaluation-model", () => {
		const offenders: string[] = [];
		let visited = 0;
		for (const dir of ["host", "claude", "grok", "muse", "think"]) {
			for (const file of tsFiles(join(SRC, dir))) {
				if (file.endsWith(".test.ts")) continue;
				visited++;
				if (PATTERN.test(readFileSync(file, "utf8"))) offenders.push(relative(SRC, file));
			}
		}
		expect(visited).toBeGreaterThan(0);
		expect(offenders).toEqual([]);
	});

	test("every other production reference is allowlisted: src/decisions, the vercel key provider, the config merge, the status line", () => {
		// Test files are exempt: they must name the feature to prove it (and fixtures may say "Vercel" incidentally).
		const allowed = (rel: string): boolean =>
			rel.startsWith("decisions/") ||
			rel === "mcp/providers.ts" ||
			rel === "mcp/cli.ts" ||
			rel === "config.ts" ||
			rel === "uplift/commands.ts";
		const matches: string[] = [];
		const offenders: string[] = [];
		let visited = 0;
		for (const file of tsFiles(SRC)) {
			if (file.endsWith(".test.ts")) continue;
			visited++;
			const rel = relative(SRC, file);
			if (!PATTERN.test(readFileSync(file, "utf8"))) continue;
			matches.push(rel);
			if (!allowed(rel)) offenders.push(rel);
		}
		expect(visited).toBeGreaterThan(50);
		expect(matches).toContain("decisions/vercel.ts");
		expect(matches).toContain("mcp/providers.ts");
		expect(offenders).toEqual([]);
	});
});

describe("selectEngine with only a Vercel key present (JEV-03)", () => {
	test("auto still resolves per host and no label mentions vercel or gateway", async () => {
		const saved = new Map<string, string | undefined>();
		for (const name of ["OPENROUTER_API_KEY", "AI_GATEWAY_API_KEY", "HINDSIGHT_API_KEY", "RAGFLOW_API_KEY"]) {
			saved.set(name, process.env[name]);
			delete process.env[name];
		}
		process.env.AI_GATEWAY_API_KEY = "[REDACTED]";
		try {
			const labels = {
				muse: await labelOf(configWith({}), {}, "muse"),
				grokBuild: await labelOf(
					configWith({ grok: { ...defaultConfig().grok, home: emptyHome(), fallbackToClaude: false } }),
					{},
					"grok-build",
				),
				claudeCode: await labelOf(configWith({}), {}, "claude-code"),
				hermes: await labelOf(configWith({}), {}, "hermes"),
				omp: await labelOf(configWith({}), {}, "omp"),
			};
			expect(labels).toEqual({
				muse: "muse:muse-spark-1.3-contributor",
				grokBuild: "claude:sonnet (grok unavailable)",
				claudeCode: "claude:sonnet",
				hermes: "claude:sonnet",
				omp: "claude:sonnet",
			});
			for (const label of Object.values(labels)) {
				expect(label).not.toMatch(/vercel|gateway/i);
			}
		} finally {
			for (const [name, value] of saved) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
		}
	});
});

describe("engineForSessionModel", () => {
	test("maps model families case-insensitively, provider segment included", () => {
		for (const [model, engine] of [
			["claude-sonnet-4-5", "claude"],
			["Anthropic/claude-opus", "claude"],
			["xai-oauth/grok-4.6", "grok"],
			["grok-4.7", "grok"],
			["GROK-4.7-XHIGH", "grok"],
			["muse-spark-1.3-contributor", "muse"],
			["meta/Muse-Spark", "muse"],
			["anthropic/grok-4.7", "grok"],
			["openrouter/anthropic/claude-sonnet", "claude"],
			["xai-oauth/custom-alias", "grok"],
		] as const) {
			expect(engineForSessionModel(model)).toBe(engine);
		}
	});

	test("the status label names the default honestly on session-model hosts", () => {
		const config = configWith({});
		expect(engineLabel(config, {}, "hermes")).toBe("claude:sonnet (follows session model)");
		expect(engineLabel(config, {}, "omp")).toBe("claude:sonnet (follows session model)");
		expect(engineLabel(config, { engine: "grok" }, "hermes")).toBe("grok-4.7@xhigh");
		expect(engineLabel(config, {}, "claude-code")).toBe("claude:sonnet");
	});

	test("unknown families, Kimi included, keep the host default", () => {
		for (const model of ["kimi-k2", "moonshot-v1-8k", "gpt-5", "", "  ", undefined, null, 42, {}]) {
			expect(engineForSessionModel(model)).toBeUndefined();
		}
	});
});

describe("selectEngine session-model detection (hermes/omp)", () => {
	const shunt = () => configWith({ grok: { ...defaultConfig().grok, transport: "shunt", shuntBaseUrl: "http://127.0.0.1:3001" } });

	test("hermes and omp follow the session model under auto", async () => {
		for (const host of ["hermes", "omp"] as const) {
			expect(await labelOf(shunt(), {}, host, "xai-oauth/grok-4.6")).toBe("grok-4.7@shunt");
			expect(await labelOf(shunt(), {}, host, "claude-sonnet-4-5")).toBe("claude:sonnet");
			expect(await labelOf(shunt(), {}, host, "muse-spark-1.3-contributor")).toBe("muse:muse-spark-1.3-contributor");
		}
	});

	test("unknown or missing models fall back to the host default", async () => {
		for (const host of ["hermes", "omp"] as const) {
			for (const model of ["kimi-k2", "gpt-5", "", undefined] as const) {
				expect(await labelOf(shunt(), {}, host, model)).toBe("claude:sonnet");
			}
		}
	});

	test("an explicit engine pin wins over the session model", async () => {
		const config = configWith({ ...shunt(), think: { ...defaultConfig().think, engine: "claude" } });
		expect(await labelOf(config, {}, "hermes", "xai-oauth/grok-4.6")).toBe("claude:sonnet");
	});

	test("other hosts ignore the session model", async () => {
		expect(await labelOf(shunt(), {}, "claude-code", "xai-oauth/grok-4.6")).toBe("claude:sonnet");
		expect(await labelOf(shunt(), {}, "muse", "xai-oauth/grok-4.6")).toBe("muse:muse-spark-1.3-contributor");
	});

	test("a detected grok without a login fails over to Claude, never skips", async () => {
		const config = configWith({ grok: { ...defaultConfig().grok, home: emptyHome(), fallbackToClaude: false } });
		expect(await labelOf(config, {}, "omp", "grok-4.7")).toBe("claude:sonnet (grok unavailable)");
	});
});

describe("selectEngine first-error capture", () => {
	test("the recorded error is redacted, one line, and bounded", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ultrathink-engine-error-"));
		dirs.push(dir);
		const bin = join(dir, "fail.sh");
		// Built in pieces so no scanner reads a key-like literal out of this fixture.
		const leak = `sk-${"ant-0123456789abcdef"}`;
		writeFileSync(bin, `#!/bin/sh\nprintf '%s\\n' 'auth failed for key ${leak}' 'second line' '${"x".repeat(2000)}' >&2\nexit 1\n`);
		chmodSync(bin, 0o755);
		const config = configWith({ claude: { ...defaultConfig().claude, bin } });
		const selected = await selectEngine(config, {}, dir, "claude-code");
		if ("skipped" in selected) throw new Error("expected a claude engine");
		await expect(selected.complete("system", "user")).rejects.toThrow();
		const first = selected.error();
		expect(first).toBeDefined();
		expect(first).not.toContain(leak);
		expect(first).toContain("[redacted]");
		expect(first).not.toContain("\n");
		expect(first!.length).toBeLessThanOrEqual(MAX_ENGINE_ERROR_CHARS);
	});
});
