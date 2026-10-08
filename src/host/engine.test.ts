// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultConfig, mergeConfig } from "../config.ts";
import {
	captureFirstError,
	engineForSessionModel,
	engineLabel,
	GROK_LOGIN_REQUIRED,
	HOST_DEFAULT_ENGINES,
	type ModelResolution,
	selectEngine,
	selectNativeEngine,
} from "./engine.ts";
import { MAX_ENGINE_ERROR_CHARS } from "./display-limits.ts";
import { binder, configWith, createEngineFixtures, engineOf, fakeModel, fakeQuery, intentWith, labelOf, resolutionOf, shunt } from "./engine-test.helpers.ts";

const { tempDir, emptyHome, cleanup } = createEngineFixtures();
afterEach(cleanup);

describe("selectEngine host defaults (think.engine auto)", () => {
	test("muse host inherits the muse engine at muse-spark-1.3-contributor", async () => {
		expect(await labelOf(configWith({}), {}, "muse")).toBe("muse:muse-spark-1.3-contributor");
	});

	test("claude-code and hermes hosts route to Claude at its route default", async () => {
		for (const host of ["claude-code", "hermes"] as const) {
			expect(await labelOf(configWith({}), {}, host)).toBe("claude:sonnet");
		}
	});

	test("grok-build inherits grok at grok-4.7 when usable (shunt needs no login)", async () => {
		expect(await labelOf(shunt(), {}, "grok-build")).toBe("grok-4.7@shunt");
	});

	test("grok-build without a grok login skips visibly instead of switching to Claude (AD-2a)", async () => {
		const config = configWith({ grok: { ...defaultConfig().grok, home: emptyHome(), fallbackToClaude: false } });
		expect(await labelOf(config, {}, "grok-build")).toBe(`skipped:${GROK_LOGIN_REQUIRED}`);
	});

	test("grok-build with grok disabled keeps the documented Claude route", async () => {
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
		expect(await resolutionOf(config, {}, "muse")).toMatchObject({ state: "override", source: "engine-model", reason: "explicit-model", modelId: "other-model" });
	});

	test("control state engine wins over config", async () => {
		const config = configWith({ think: { ...defaultConfig().think, engine: "claude" } });
		expect(await labelOf(config, { engine: "muse" }, "claude-code")).toBe("muse:muse-spark-1.3-contributor");
		expect((await resolutionOf(config, { engine: "muse" }, "claude-code")).engineSelection).toEqual({ engine: "muse", source: "control", nativeOptOut: false });
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

	test("explicit grok without login falls back when fallbackToClaude is set, recorded as a configured fallback", async () => {
		const config = configWith({
			think: { ...defaultConfig().think, engine: "grok" },
			grok: { ...defaultConfig().grok, home: emptyHome(), fallbackToClaude: true },
		});
		expect(await labelOf(config, {}, "claude-code")).toBe("claude:sonnet (grok fallback)");
		expect(await resolutionOf(config, {}, "claude-code")).toEqual({
			version: "1.0.0",
			state: "default",
			host: "claude-code",
			transport: "claude-cli",
			source: "configured-fallback",
			reason: "grok-unavailable",
			engineSelection: { engine: "grok", source: "config", nativeOptOut: false },
			modelId: "sonnet",
			modelKnown: true,
			label: "claude:sonnet [configured fallback · grok unavailable]",
		});
	});
});

describe("HOST_DEFAULT_ENGINES", () => {
	test("covers every host", () => {
		expect(Object.keys(HOST_DEFAULT_ENGINES).sort()).toEqual(["claude-code", "grok-build", "hermes", "muse", "omp", "prime-agent"]);
		expect(HOST_DEFAULT_ENGINES["prime-agent"]).toBe("claude");
	});
});

describe("engineLabel", () => {
	test("mirrors selection without auth checks", () => {
		const config = defaultConfig();
		expect(engineLabel(config, {}, "muse")).toBe("muse:muse-spark-1.3-contributor");
		expect(engineLabel(config, {}, "claude-code")).toBe("claude:sonnet");
		expect(engineLabel(config, {}, "grok-build")).toBe("grok-4.7@xhigh");
		expect(engineLabel(config, { engine: "muse" }, "claude-code")).toBe("muse:muse-spark-1.3-contributor");
		// A models.hosts wire model replaces the route's engine model, as selection does; a provider constraint has no
		// legacy binding and shows unresolved; a disabled Grok route keeps Claude's own model, never the host override.
		const wire = mergeConfig({ models: { hosts: { "claude-code": { model: "wire-c" }, muse: { model: "wire-m" }, "grok-build": { model: "wire-g" } } } }, config);
		expect(engineLabel(wire, {}, "claude-code")).toBe("claude:wire-c");
		expect(engineLabel(wire, {}, "muse")).toBe("muse:wire-m");
		expect(engineLabel(wire, {}, "grok-build")).toBe("wire-g@xhigh");
		expect(engineLabel(mergeConfig({ grok: { enabled: false } }, wire), {}, "grok-build")).toBe("claude:sonnet");
		const constrained = mergeConfig({ models: { hosts: { "claude-code": { provider: "anthropic" } } } }, config);
		expect(engineLabel(constrained, {}, "claude-code")).toBe("claude:unresolved [transport-incompatible]");
	});

	test("Omp auto is native: an observed record names its model, without one the live model is not observed (§9 path 6)", () => {
		const config = defaultConfig();
		const observed: ModelResolution = {
			version: "1.0.0",
			state: "detected",
			host: "omp",
			transport: "omp-native",
			source: "ctx.model",
			reason: "live-model",
			engineSelection: { engine: "auto", source: "config", nativeOptOut: false },
			provider: "anthropic",
			modelId: "claude-x",
			modelKnown: true,
			label: "omp-native:anthropic/claude-x [detected]",
		};
		expect(engineLabel(config, {}, "omp")).toBe("omp-native:auto (live model not observed)");
		expect(engineLabel(config, {}, "omp", observed)).toBe("omp-native:anthropic/claude-x [detected]");
		expect(engineLabel(config, { engine: "auto" }, "omp", observed)).toBe("omp-native:anthropic/claude-x [detected]");
		// A record observed for another engine request or host is not the current selection: the static label stands.
		expect(engineLabel(config, { engine: "claude" }, "omp", observed)).toBe("claude:sonnet");
		expect(engineLabel(config, {}, "hermes", observed)).toBe("claude:sonnet (follows session model)");
		expect(engineLabel(config, {}, "claude-code", observed)).toBe("claude:sonnet");
		// A named Omp engine opted out of native planning; its own observed legacy record names the route and default.
		const named: ModelResolution = {
			version: "1.0.0",
			state: "default",
			host: "omp",
			transport: "claude-cli",
			source: "cli-default",
			reason: "cli-delegation",
			engineSelection: { engine: "claude", source: "control", nativeOptOut: true },
			modelKnown: false,
			label: "claude:CLI default (model unobserved)",
		};
		expect(engineLabel(config, { engine: "claude" }, "omp", named)).toBe("claude:CLI default (model unobserved)");
	});

	test("supplied observed labels are projected before direct status rendering", async () => {
		const config = defaultConfig();
		const observed = await resolutionOf(config, {}, "claude-code");
		const sentinel = "EXAMPLE_SENTINEL";
		for (const label of [
			`https://model.invalid/path?token=${sentinel}`,
			`Bearer ${sentinel}`,
			`user:${sentinel}@model.invalid`,
			`<model>${sentinel}</model>`,
			`${sentinel}\nmodel`,
			`${sentinel}\tmodel`,
			`${sentinel}\u001b[31m\nmodel`,
			`${sentinel}${"x".repeat(600)}`,
		]) {
			expect(engineLabel(config, {}, "claude-code", { ...observed, label })).toBe("<opaque-model>");
		}
	});

	test("generated route syntax and opaque markers survive observed-label projection", async () => {
		for (const model of ["namespace:model", "https://model.invalid/path"]) {
			const config = mergeConfig({ grok: { shuntModel: model } }, shunt());
			const resolution = await resolutionOf(config, {}, "grok-build");
			expect(engineLabel(config, {}, "grok-build", resolution)).toBe(resolution.label);
		}
		const live = fakeModel("gate way", "https://model.invalid/path");
		const selected = engineOf(await selectNativeEngine(intentWith(), fakeQuery({ live: { model: live, source: "ctx.model" } }).query, binder().bind));
		expect(engineLabel(defaultConfig(), {}, "omp", selected.resolution)).toBe(selected.resolution.label);
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
				grokBuild: `skipped:${GROK_LOGIN_REQUIRED}`,
				claudeCode: "claude:sonnet",
				hermes: "claude:sonnet",
				omp: "skipped:native-unavailable",
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

	test("the status label names the default honestly on session-model hosts; Omp auto never guesses a CLI route", () => {
		const config = configWith({});
		expect(engineLabel(config, {}, "hermes")).toBe("claude:sonnet (follows session model)");
		expect(engineLabel(config, {}, "omp")).toBe("omp-native:auto (live model not observed)");
		expect(engineLabel(config, { engine: "claude" }, "omp")).toBe("claude:sonnet");
		expect(engineLabel(config, { engine: "grok" }, "hermes")).toBe("grok-4.7@xhigh");
		expect(engineLabel(config, {}, "claude-code")).toBe("claude:sonnet");
	});

	test("unknown families, Kimi included, keep the host default", () => {
		for (const model of ["kimi-k2", "moonshot-v1-8k", "gpt-5", "", "  ", undefined, null, 42, {}]) {
			expect(engineForSessionModel(model)).toBeUndefined();
		}
	});
});

describe("selectEngine session-model routing (Hermes only, AD-3)", () => {
	test("hermes follows the session model family under auto", async () => {
		expect(await labelOf(shunt(), {}, "hermes", "xai-oauth/grok-4.6")).toBe("grok-4.7@shunt");
		expect(await labelOf(shunt(), {}, "hermes", "claude-sonnet-4-5")).toBe("claude:sonnet");
		expect(await labelOf(shunt(), {}, "hermes", "muse-spark-1.3-contributor")).toBe("muse:muse-spark-1.3-contributor");
	});

	test("unknown or missing models fall back to the host default", async () => {
		for (const model of ["kimi-k2", "gpt-5", "", undefined] as const) {
			expect(await labelOf(shunt(), {}, "hermes", model)).toBe("claude:sonnet");
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
});

describe("selectEngine first-error capture", () => {
	test("the recorded error is redacted, one line, and bounded", async () => {
		const dir = tempDir("ultrathink-engine-error-");
		const bin = join(dir, "fail.sh");
		// Built in pieces so no scanner reads a key-like literal out of this fixture.
		const leak = `sk-${"ant-0123456789abcdef"}`;
		writeFileSync(
			bin,
			`#!/bin/sh\nprintf '%s\\n' 'auth failed for key ${leak}' 'token Bearer abcdefgh rejected' '${"x".repeat(2000)}' >&2\nexit 1\n`,
		);
		chmodSync(bin, 0o755);
		const config = configWith({ claude: { ...defaultConfig().claude, bin } });
		const selected = await selectEngine(config, {}, dir, { host: "claude-code" });
		if ("skipped" in selected) throw new Error("expected a claude engine");
		await expect(selected.complete("system", "user")).rejects.toThrow();
		const first = selected.error();
		expect(first).toBeDefined();
		expect(first).not.toContain(leak);
		// Diagnostics are not prose: even a short Bearer [REDACTED] is masked, unlike redactLine's default.
		expect(first).not.toContain("abcdefgh");
		expect(first).toContain("[redacted]");
		expect(first).not.toContain("\n");
		expect(first!.length).toBeLessThanOrEqual(MAX_ENGINE_ERROR_CHARS);
	});

	test("the exported wrapper keeps its resolution record and only the first error", async () => {
		const resolution = await resolutionOf(defaultConfig(), {}, "claude-code");
		let call = 0;
		const wrapped = captureFirstError(
			"stub",
			async () => {
				call++;
				throw new Error(`failure ${call}`);
			},
			resolution,
		);
		expect(wrapped.resolution).toBe(resolution);
		await expect(wrapped.complete("s", "u")).rejects.toThrow("failure 1");
		await expect(wrapped.complete("s", "u")).rejects.toThrow("failure 2");
		expect(wrapped.error()).toBe("failure 1");
	});
});
