// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { ClaudeCompleter } from "../claude/complete.ts";
import { defaultConfig, mergeConfig, type UltrathinkConfig } from "../config.ts";
import type { ControlState } from "../claude/state.ts";
import { ROUTE_DEFAULT_MODELS } from "../route-defaults.ts";
import type { HostId } from "./types.ts";
import {
	captureFirstError,
	type EngineSelection,
	type EngineSelectionContext,
	type EngineSkip,
	engineForSessionModel,
	engineLabel,
	GROK_LOGIN_REQUIRED,
	HOST_DEFAULT_ENGINES,
	MAX_ENGINE_ERROR_CHARS,
	type ModelIntent,
	type ModelResolution,
	type NativeEngineSelector,
	type NativeModelIdentity,
	type NativeModelQuery,
	type SelectedEngine,
	selectEngine,
	selectNativeEngine,
} from "./engine.ts";

const dirs: string[] = [];
afterEach(() => {
	while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	dirs.push(dir);
	return dir;
}

function emptyHome(): string {
	return tempDir("ultrathink-engine-test-");
}

/** A Grok home holding a `grok login` session; `expired` dates it in the past with no refresh token, so nothing refreshes it. */
function grokLogin(expired = false): string {
	const home = tempDir("ultrathink-engine-grok-");
	// Built in pieces so no scanner reads a key-like literal out of this fixture.
	const key = ["fixture", "session", "value"].join("-");
	writeFileSync(join(home, "auth.json"), JSON.stringify({ default: { key, ...(expired ? { expires_at: "2020-01-01T00:00:00.000Z" } : {}) } }));
	return home;
}

/** A claude binary that only records that it ran: the Claude-spawn spy. */
function claudeSpy(): { bin: string; ran: () => boolean } {
	const dir = tempDir("ultrathink-engine-spy-");
	const marker = join(dir, "ran");
	const bin = join(dir, "claude.sh");
	writeFileSync(bin, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`);
	chmodSync(bin, 0o755);
	return { bin, ran: () => existsSync(marker) };
}

function configWith(overrides: Partial<UltrathinkConfig>): UltrathinkConfig {
	return { ...defaultConfig(), ...overrides };
}

const shunt = () => configWith({ grok: { ...defaultConfig().grok, transport: "shunt", shuntBaseUrl: "http://127.0.0.1:3001" } });

async function labelOf(config: UltrathinkConfig, state: ControlState, host: HostId, sessionModel?: unknown): Promise<string> {
	const selected = await selectEngine(config, state, "/repo", { host, sessionModel });
	return "skipped" in selected ? `skipped:${selected.skipped}` : selected.label;
}

async function resolutionOf(config: UltrathinkConfig, state: ControlState, host: HostId, context: EngineSelectionContext = {}): Promise<ModelResolution> {
	return (await selectEngine(config, state, "/repo", { host, ...context })).resolution;
}

function engineOf(selection: EngineSelection): SelectedEngine {
	if ("skipped" in selection) throw new Error(`expected an engine, got the skip ${selection.skipped}`);
	return selection;
}

function skipOf(selection: EngineSelection): EngineSkip {
	if (!("skipped" in selection)) throw new Error(`expected a skip, got ${selection.label}`);
	return selection;
}

const AUTO = { engine: "auto", source: "config", nativeOptOut: false } as const;

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

describe("route defaults (AD-1, AC-15-042)", () => {
	test("unpinned Claude Code plans on the central map's Claude entry, recorded as a route default", async () => {
		const selected = engineOf(await selectEngine(defaultConfig(), {}, "/repo", { host: "claude-code" }));
		expect(selected.label).toBe(`claude:${ROUTE_DEFAULT_MODELS.claude}`);
		expect(selected.resolution).toEqual({
			version: "1.0.0",
			state: "default",
			host: "claude-code",
			transport: "claude-cli",
			source: "route-default",
			reason: "route-default-model",
			engineSelection: AUTO,
			modelId: "sonnet",
			modelKnown: true,
			label: "claude:sonnet [route default]",
		});
	});

	test("unpinned Grok Build plans on the Grok entry over http with a login and over shunt without one", async () => {
		const http = engineOf(await selectEngine(configWith({ grok: { ...defaultConfig().grok, home: grokLogin() } }), {}, "/repo", { host: "grok-build" }));
		expect(http.label).toBe(`${ROUTE_DEFAULT_MODELS.grok}@xhigh`);
		expect(http.resolution).toEqual({
			version: "1.0.0",
			state: "default",
			host: "grok-build",
			transport: "grok-http",
			source: "route-default",
			reason: "route-default-model",
			engineSelection: AUTO,
			modelId: "grok-4.7",
			modelKnown: true,
			label: "grok:grok-4.7 [route default]",
		});
		const viaShunt = engineOf(await selectEngine(shunt(), {}, "/repo", { host: "grok-build" }));
		expect(viaShunt.resolution).toMatchObject({ state: "default", transport: "grok-shunt", source: "route-default", modelId: ROUTE_DEFAULT_MODELS.grok });
		expect(viaShunt.resolution.label).toBe("grok:grok-4.7@shunt [route default]");
	});

	test("unpinned Muse plans on the Muse entry", async () => {
		const resolution = await resolutionOf(defaultConfig(), {}, "muse");
		expect(resolution).toEqual({
			version: "1.0.0",
			state: "default",
			host: "muse",
			transport: "muse-cli",
			source: "route-default",
			reason: "route-default-model",
			engineSelection: AUTO,
			modelId: ROUTE_DEFAULT_MODELS.muse,
			modelKnown: true,
			label: "muse:muse-spark-1.3-contributor [route default]",
		});
	});

	test("a file pin is an override even when it equals the route default; so is any other configured value", async () => {
		const pinned = mergeConfig({ claude: { model: "sonnet" }, muse: { model: "muse-spark-1.3-contributor" } }, defaultConfig());
		expect(await resolutionOf(pinned, {}, "claude-code")).toMatchObject({
			state: "override",
			source: "engine-model",
			reason: "explicit-model",
			modelId: "sonnet",
			modelKnown: true,
			label: "claude:sonnet [override]",
		});
		expect(await resolutionOf(pinned, {}, "muse")).toMatchObject({ state: "override", source: "engine-model", modelId: ROUTE_DEFAULT_MODELS.muse });
		const other = configWith({ claude: { ...defaultConfig().claude, model: "opus" } });
		expect(await resolutionOf(other, {}, "claude-code")).toMatchObject({ state: "override", source: "engine-model", label: "claude:opus [override]" });
	});

	test("an explicit blank Claude or Muse model delegates to the CLI default with the model unobserved", async () => {
		const blank = mergeConfig({ claude: { model: "" }, muse: { model: "   " } }, mergeConfig({ claude: { model: "opus" } }, defaultConfig()));
		const claude = engineOf(await selectEngine(blank, {}, "/repo", { host: "claude-code" }));
		expect(claude.label).toBe("claude:session default");
		expect(claude.resolution).toEqual({
			version: "1.0.0",
			state: "default",
			host: "claude-code",
			transport: "claude-cli",
			source: "cli-default",
			reason: "cli-delegation",
			engineSelection: AUTO,
			modelKnown: false,
			label: "claude:CLI default (model unobserved)",
		});
		const muse = await resolutionOf(blank, {}, "muse");
		expect(muse).toMatchObject({ state: "default", source: "cli-default", reason: "cli-delegation", modelKnown: false, label: "muse:CLI default (model unobserved)" });
		for (const field of ["modelId", "provider", "api", "providerType"]) expect(field in muse).toBe(false);
	});

	test("blank grok.model and grok.shuntModel keep the non-empty merge: the route default, never a pin", async () => {
		const config = mergeConfig({ grok: { model: "  ", shuntModel: "", transport: "shunt", shuntBaseUrl: "http://127.0.0.1:3001" } }, defaultConfig());
		expect(await resolutionOf(config, {}, "grok-build")).toMatchObject({
			state: "default",
			source: "route-default",
			reason: "route-default-model",
			modelId: ROUTE_DEFAULT_MODELS.grok,
			label: "grok:grok-4.7@shunt [route default]",
		});
	});

	test("Hermes plans on its routed engine's route default and is never detected", async () => {
		for (const [sessionModel, transport, modelId] of [
			["claude-sonnet-4-5", "claude-cli", ROUTE_DEFAULT_MODELS.claude],
			["meta/Muse-Spark", "muse-cli", ROUTE_DEFAULT_MODELS.muse],
			["kimi-k2", "claude-cli", ROUTE_DEFAULT_MODELS.claude],
		] as const) {
			const resolution = await resolutionOf(defaultConfig(), {}, "hermes", { sessionModel });
			expect(resolution).toMatchObject({ state: "default", transport, source: "route-default", modelId, engineSelection: AUTO });
		}
	});

	test("provider defaults are never consumed on a legacy route: the eligible set is empty", async () => {
		const config = mergeConfig(
			{ models: { providerDefaults: { anthropic: "opus", xai: "grok-x", "xai-oauth": "grok-y", openai: "gpt-x", openrouter: "router-x" } } },
			shunt(),
		);
		expect(await resolutionOf(config, {}, "claude-code")).toMatchObject({ source: "route-default", modelId: ROUTE_DEFAULT_MODELS.claude });
		expect(await resolutionOf(config, {}, "grok-build")).toMatchObject({ source: "route-default", modelId: ROUTE_DEFAULT_MODELS.grok });
		expect(await resolutionOf(config, {}, "muse")).toMatchObject({ source: "route-default", modelId: ROUTE_DEFAULT_MODELS.muse });
	});
});

describe("legacy host overrides and selector validation (§5.2)", () => {
	test("a provider-less host model is the route's explicit wire selector; a shunt alias still wins on shunt", async () => {
		const config = mergeConfig({ models: { hosts: { "claude-code": { model: "opus" }, "grok-build": { model: "grok-x" } } } }, shunt());
		const claude = engineOf(await selectEngine(config, {}, "/repo", { host: "claude-code" }));
		expect(claude.label).toBe("claude:opus");
		expect(claude.resolution).toMatchObject({ state: "override", source: "host-override", reason: "explicit-model", modelId: "opus", label: "claude:opus [override]" });
		const grok = engineOf(await selectEngine(config, {}, "/repo", { host: "grok-build" }));
		expect(grok.label).toBe("grok-x@shunt");
		expect(grok.resolution).toMatchObject({ state: "override", source: "host-override", label: "grok:grok-x@shunt [override]" });
		const aliased = mergeConfig({ grok: { shuntModel: "route-alias" } }, config);
		expect(await resolutionOf(aliased, {}, "grok-build")).toMatchObject({ state: "override", source: "shunt-model", label: "grok:route-alias@shunt [override]" });
	});

	test("a host provider constraint is a visible transport-incompatible skip on every legacy route, never ignored", async () => {
		const config = mergeConfig({ models: { hosts: { "claude-code": { provider: "anthropic" }, muse: { provider: "meta", model: "muse-x" } } } }, defaultConfig());
		const claude = skipOf(await selectEngine(config, {}, "/repo", { host: "claude-code" }));
		expect(claude).toEqual({
			skipped: "transport-incompatible",
			notice: "Prompt Uplift skipped · claude:unresolved [transport-incompatible]",
			resolution: {
				version: "1.0.0",
				state: "unresolved",
				host: "claude-code",
				transport: "claude-cli",
				source: "provider-override",
				reason: "transport-incompatible",
				engineSelection: AUTO,
				modelKnown: false,
				label: "claude:unresolved [transport-incompatible]",
			},
		});
		expect(await resolutionOf(config, {}, "muse")).toMatchObject({ state: "unresolved", source: "host-override", reason: "transport-incompatible" });
	});

	test("a selector carrying a control character is selector-invalid before any auth, and never echoed", async () => {
		const nul = configWith({ claude: { ...defaultConfig().claude, model: "zz\u0000qq" } });
		const skip = skipOf(await selectEngine(nul, {}, "/repo", { host: "claude-code" }));
		expect(skip.resolution).toMatchObject({ state: "unresolved", source: "engine-model", reason: "selector-invalid", modelKnown: false });
		expect(JSON.stringify(skip)).not.toMatch(/zz|qq/);
		const provider = mergeConfig({ models: { hosts: { "claude-code": { provider: "anth\nropic" } } } }, defaultConfig());
		expect(await resolutionOf(provider, {}, "claude-code")).toMatchObject({ source: "provider-override", reason: "selector-invalid" });
		// Checked before the login lookup: an empty Grok home would otherwise be grok-unavailable.
		const grok = configWith({ grok: { ...defaultConfig().grok, model: "grok\u001b[31m", home: emptyHome() } });
		expect(await resolutionOf(grok, {}, "grok-build")).toMatchObject({ source: "engine-model", reason: "selector-invalid" });
	});

	test("a Grok route needs a concrete wire model and, on shunt, a gateway URL", async () => {
		const blank = configWith({ grok: { ...shunt().grok, model: "" } });
		expect(await resolutionOf(blank, {}, "grok-build")).toMatchObject({ state: "unresolved", source: "none", reason: "concrete-model-required" });
		const noUrl = configWith({ grok: { ...defaultConfig().grok, transport: "shunt", shuntBaseUrl: "" } });
		expect(skipOf(await selectEngine(noUrl, {}, "/repo", { host: "grok-build" })).resolution).toMatchObject({
			state: "unresolved",
			transport: "grok-shunt",
			source: "route-default",
			reason: "transport-incompatible",
		});
	});

	test("records never carry endpoints, gateway URLs or credentials", async () => {
		const grok = {
			...defaultConfig().grok,
			baseUrl: "https://proxy-secret.example/v1",
			shuntBaseUrl: "http://gateway-secret.example:3001",
			home: grokLogin(),
		};
		const viaShunt = await resolutionOf(configWith({ grok: { ...grok, transport: "shunt" } }), {}, "grok-build");
		const viaHttp = await resolutionOf(configWith({ grok }), {}, "grok-build");
		for (const record of [viaShunt, viaHttp]) expect(JSON.stringify(record)).not.toMatch(/secret|fixture-session/);
		const endpoint = configWith({ claude: { ...defaultConfig().claude, model: "https://evil.example/v1" } });
		const shown = await resolutionOf(endpoint, {}, "claude-code");
		expect(shown).toMatchObject({ state: "override", modelId: "<opaque-model>", modelKnown: true, label: "claude:<opaque-model> [override]" });
	});
});

describe("Grok availability (AD-2, AD-2a, AC-15-043)", () => {
	test("auto Grok Build with a missing or expired login skips with GROK_LOGIN_REQUIRED and zero Claude calls", async () => {
		for (const home of [emptyHome(), grokLogin(true)]) {
			const spy = claudeSpy();
			const config = configWith({ claude: { ...defaultConfig().claude, bin: spy.bin }, grok: { ...defaultConfig().grok, home } });
			const selection = await selectEngine(config, {}, "/repo", { host: "grok-build" });
			expect(selection).toEqual({
				skipped: GROK_LOGIN_REQUIRED,
				notice: GROK_LOGIN_REQUIRED,
				resolution: {
					version: "1.0.0",
					state: "unresolved",
					host: "grok-build",
					transport: "grok-http",
					source: "route-default",
					reason: "grok-unavailable",
					engineSelection: AUTO,
					modelKnown: false,
					label: "grok:unresolved [grok-unavailable]",
				},
			});
			expect("complete" in selection).toBe(false);
			expect(spy.ran()).toBe(false);
		}
	});

	test("named Grok skips the same way; the record names the attempted Grok source and transport", async () => {
		const config = mergeConfig({ grok: { model: "grok-pin", transport: "cli", home: emptyHome() } }, defaultConfig());
		const skip = skipOf(await selectEngine(config, { engine: "grok" }, "/repo", { host: "claude-code" }));
		expect(skip.skipped).toBe(GROK_LOGIN_REQUIRED);
		expect(skip.resolution).toMatchObject({
			state: "unresolved",
			transport: "grok-cli",
			source: "engine-model",
			reason: "grok-unavailable",
			engineSelection: { engine: "grok", source: "control", nativeOptOut: false },
		});
	});

	test("grok.fallbackToClaude: true runs the actual Claude route on Claude's own model, labeled a configured fallback", async () => {
		const spy = claudeSpy();
		const config = mergeConfig(
			{ claude: { bin: spy.bin }, grok: { home: emptyHome(), fallbackToClaude: true }, models: { hosts: { "grok-build": { model: "grok-x" } } } },
			defaultConfig(),
		);
		// A real cwd: the spy must be able to spawn when the fallback completer runs.
		const selected = engineOf(await selectEngine(config, {}, tempDir("ultrathink-engine-cwd-"), { host: "grok-build" }));
		expect(selected.label).toBe("claude:sonnet (grok fallback)");
		expect(selected.resolution).toEqual({
			version: "1.0.0",
			state: "default",
			host: "grok-build",
			transport: "claude-cli",
			source: "configured-fallback",
			reason: "grok-unavailable",
			engineSelection: AUTO,
			modelId: ROUTE_DEFAULT_MODELS.claude,
			modelKnown: true,
			label: "claude:sonnet [configured fallback · grok unavailable]",
		});
		await expect(selected.complete("system", "user")).rejects.toThrow();
		expect(spy.ran()).toBe(true);
	});

	test("the configured fallback takes its state from the Claude model provenance", async () => {
		const optIn = mergeConfig({ grok: { home: emptyHome(), fallbackToClaude: true } }, defaultConfig());
		const pinned = await resolutionOf(mergeConfig({ claude: { model: "opus" } }, optIn), {}, "grok-build");
		expect(pinned).toMatchObject({ state: "override", source: "configured-fallback", reason: "grok-unavailable", modelId: "opus" });
		expect(pinned.label).toBe("claude:opus [configured fallback · grok unavailable]");
		const blank = await resolutionOf(mergeConfig({ claude: { model: "" } }, optIn), {}, "grok-build");
		expect(blank).toMatchObject({ state: "default", source: "configured-fallback", modelKnown: false });
		expect("modelId" in blank).toBe(false);
		expect(blank.label).toBe("claude:CLI default (model unobserved) [configured fallback · grok unavailable]");
	});

	test("grok.enabled: false keeps the documented Claude route, recorded as a configured fallback", async () => {
		const config = configWith({ grok: { ...defaultConfig().grok, enabled: false } });
		const auto = engineOf(await selectEngine(config, {}, "/repo", { host: "grok-build" }));
		expect(auto.label).toBe("claude:sonnet");
		expect(auto.resolution).toMatchObject({ state: "default", transport: "claude-cli", source: "configured-fallback", reason: "grok-unavailable" });
		const named = await resolutionOf(config, { engine: "grok" }, "claude-code");
		expect(named).toMatchObject({ source: "configured-fallback", engineSelection: { engine: "grok", source: "control", nativeOptOut: false } });
	});

	test("an explicit think.engine claude is a deliberate route, not a configured fallback", async () => {
		const config = configWith({ think: { ...defaultConfig().think, engine: "claude" }, grok: { ...defaultConfig().grok, home: emptyHome() } });
		expect(await resolutionOf(config, {}, "grok-build")).toMatchObject({
			state: "default",
			source: "route-default",
			reason: "route-default-model",
			engineSelection: { engine: "claude", source: "config", nativeOptOut: false },
		});
	});

	test("Hermes family routing onto Grok without a login skips visibly too, never Claude", async () => {
		const config = configWith({ grok: { ...defaultConfig().grok, home: emptyHome() } });
		const skip = skipOf(await selectEngine(config, {}, "/repo", { host: "hermes", sessionModel: "xai-oauth/grok-4.6" }));
		expect(skip.skipped).toBe(GROK_LOGIN_REQUIRED);
		expect(skip.resolution).toMatchObject({ state: "unresolved", host: "hermes", transport: "grok-http", source: "route-default", reason: "grok-unavailable" });
	});

	test("provider-disabled is never used on a Grok path", async () => {
		const missing = { ...defaultConfig().grok, home: emptyHome() };
		const records = [
			await resolutionOf(configWith({ grok: missing }), {}, "grok-build"),
			await resolutionOf(configWith({ grok: missing }), { engine: "grok" }, "muse"),
			await resolutionOf(configWith({ grok: { ...missing, fallbackToClaude: true } }), {}, "grok-build"),
			await resolutionOf(configWith({ grok: { ...missing, enabled: false } }), {}, "grok-build"),
		];
		for (const record of records) expect(record.reason).not.toBe("provider-disabled");
	});
});

describe("Omp planning is native (D-06, D-09)", () => {
	test("auto planning without a native selector is unresolved native-unavailable: never Claude, never a family route", async () => {
		const spy = claudeSpy();
		const config = configWith({ claude: { ...defaultConfig().claude, bin: spy.bin } });
		for (const sessionModel of [undefined, "claude-sonnet-4-5", "xai-oauth/grok-4.6", "muse-spark-1.3-contributor", "openai-codex/gpt-6.1-sol"]) {
			expect(await selectEngine(config, {}, "/repo", { host: "omp", sessionModel })).toEqual({
				skipped: "native-unavailable",
				notice: "Prompt Uplift skipped · omp-native:unresolved [native-unavailable]",
				resolution: {
					version: "1.0.0",
					state: "unresolved",
					host: "omp",
					transport: "omp-native",
					source: "none",
					reason: "native-unavailable",
					engineSelection: AUTO,
					modelKnown: false,
					label: "omp-native:unresolved [native-unavailable]",
				},
			});
		}
		expect(spy.ran()).toBe(false);
	});

	test("the context object carries the native selector, signal and the shared intent into the native policy", async () => {
		const controller = new AbortController();
		const seen: Array<{ intent: ModelIntent; signal?: AbortSignal }> = [];
		const live = fakeModel("openai-codex", "gpt-6.1-sol");
		const native: NativeEngineSelector = async (intent, signal) => {
			seen.push({ intent, signal });
			return selectNativeEngine(intent, fakeQuery({ live: { model: live, source: "ctx.model" } }).query, binder().bind);
		};
		const config = mergeConfig({ models: { hosts: { omp: { model: " " } }, providerDefaults: { xai: "xai-fast" } } }, defaultConfig());
		const selected = engineOf(
			await selectEngine(config, {}, "/repo", { host: "omp", sessionModel: "claude-sonnet-4-5", sessionId: "s1", signal: controller.signal, native, purpose: "planning" }),
		);
		expect(seen).toHaveLength(1);
		expect(seen[0]?.signal).toBe(controller.signal);
		expect(seen[0]?.intent).toMatchObject({ host: "omp", override: { provider: "", model: "" }, engineSelection: AUTO });
		expect(seen[0]?.intent.providerDefaults.xai).toBe("xai-fast");
		expect(selected.resolution).toMatchObject({ state: "detected", source: "ctx.model", provider: "openai-codex", modelId: "gpt-6.1-sol" });
	});

	test("a named engine on Omp opts out of native auto: the native selector is never called", async () => {
		let calls = 0;
		const native: NativeEngineSelector = async () => {
			calls++;
			throw new Error("a named engine must not reach the native selector");
		};
		const named = configWith({ think: { ...defaultConfig().think, engine: "claude" } });
		for (const [config, state, source] of [
			[defaultConfig(), { engine: "claude" }, "control"],
			[named, {}, "config"],
		] as const) {
			expect(await resolutionOf(config, state, "omp", { native })).toEqual({
				version: "1.0.0",
				state: "default",
				host: "omp",
				transport: "claude-cli",
				source: "route-default",
				reason: "route-default-model",
				engineSelection: { engine: "claude", source, nativeOptOut: true },
				modelId: ROUTE_DEFAULT_MODELS.claude,
				modelKnown: true,
				label: "claude:sonnet [route default]",
			});
		}
		const blank = mergeConfig({ think: { engine: "muse" }, muse: { model: "" } }, defaultConfig());
		const delegated = await resolutionOf(blank, {}, "omp", { native });
		expect(delegated).toMatchObject({ state: "default", source: "cli-default", reason: "cli-delegation", modelKnown: false });
		expect(delegated.engineSelection).toEqual({ engine: "muse", source: "config", nativeOptOut: true });
		for (const field of ["modelId", "provider", "api", "providerType"]) expect(field in delegated).toBe(false);
		expect(calls).toBe(0);
	});

	test("auxiliary helpers on Omp keep the Claude CLI route and never inherit or forward a native target", async () => {
		let calls = 0;
		const native: NativeEngineSelector = async () => {
			calls++;
			throw new Error("an auxiliary helper must not reach the native selector");
		};
		const config = mergeConfig({ models: { hosts: { omp: { provider: "openai-codex", model: "gpt-6.1-sol" } } } }, defaultConfig());
		const selected = engineOf(await selectEngine(config, {}, "/repo", { host: "omp", purpose: "auxiliary", native }));
		expect(selected.label).toBe("claude:sonnet");
		expect(selected.resolution).toMatchObject({ state: "default", transport: "claude-cli", source: "route-default", engineSelection: AUTO });
		expect(calls).toBe(0);
	});
});

interface FakeModel extends NativeModelIdentity {
	usable: "usable" | "unavailable" | "unsupported";
}

function fakeModel(provider: string, id: string, usable: FakeModel["usable"] = "usable"): FakeModel {
	return { provider, id, api: "openai-responses", providerType: `${provider}-type`, usable };
}

/** An injected host query: `models` answers resolve by selector, `catalog` stands in for DEFAULT_MODEL_PER_PROVIDER. */
function fakeQuery(options: {
	live?: NativeModelQuery<FakeModel>["live"];
	models?: Record<string, FakeModel>;
	catalog?: Record<string, string>;
}): { query: NativeModelQuery<FakeModel>; resolved: string[] } {
	const resolved: string[] = [];
	return {
		resolved,
		query: {
			live: options.live,
			check: (model) => model.usable,
			resolve: async (selector, provider) => {
				resolved.push(`${provider ?? ""}|${selector}`);
				return options.models?.[selector];
			},
			catalogDefault: (provider) => options.catalog?.[provider],
		},
	};
}

function binder(): { bind: (model: FakeModel) => ClaudeCompleter; bound: FakeModel[] } {
	const bound: FakeModel[] = [];
	return {
		bound,
		bind: (model) => {
			bound.push(model);
			return async () => `answer from ${model.provider}/${model.id}`;
		},
	};
}

function intentWith(override: Partial<ModelIntent["override"]> = {}, providerDefaults: Record<string, string> = {}): ModelIntent {
	return { host: "omp", override: { provider: "", model: "", ...override }, providerDefaults, engineSelection: { ...AUTO } };
}

describe("selectNativeEngine native precedence (D-06, §3.2)", () => {
	test("the usable live model is detected and bound whole; nothing is resolved or listed", async () => {
		const live = fakeModel("openai-codex", "gpt-6.1-sol");
		const { query, resolved } = fakeQuery({ live: { model: live, source: "ctx.model" }, catalog: { "openai-codex": "gpt-cat" } });
		const { bind, bound } = binder();
		const selected = engineOf(await selectNativeEngine(intentWith(), query, bind));
		expect(bound).toHaveLength(1);
		expect(bound[0]).toBe(live);
		expect(resolved).toEqual([]);
		expect(selected.resolution).toEqual({
			version: "1.0.0",
			state: "detected",
			host: "omp",
			transport: "omp-native",
			source: "ctx.model",
			reason: "live-model",
			engineSelection: AUTO,
			api: "openai-responses",
			providerType: "openai-codex-type",
			provider: "openai-codex",
			modelId: "gpt-6.1-sol",
			modelKnown: true,
			label: "omp-native:openai-codex/gpt-6.1-sol [detected]",
		});
		expect(selected.label).toBe(selected.resolution.label);
		expect(await selected.complete("system", "user")).toBe("answer from openai-codex/gpt-6.1-sol");
	});

	test("ctx.models.current is the observed source when ctx.model is absent", async () => {
		const live = fakeModel("anthropic", "claude-x");
		const selected = engineOf(await selectNativeEngine(intentWith(), fakeQuery({ live: { model: live, source: "ctx.models.current" } }).query, binder().bind));
		expect(selected.resolution).toMatchObject({ state: "detected", source: "ctx.models.current", reason: "live-model" });
	});

	test("an unusable live model keeps its provider for that provider's configured default only", async () => {
		const live = fakeModel("xai", "grok-live", "unavailable");
		const fast = fakeModel("xai", "grok-fast");
		const { query, resolved } = fakeQuery({ live: { model: live, source: "ctx.model" }, models: { "xai-fast": fast } });
		const { bind, bound } = binder();
		const selected = engineOf(await selectNativeEngine(intentWith({}, { xai: "xai-fast", openai: "gpt-x" }), query, bind));
		expect(bound).toEqual([fast]);
		expect(resolved).toEqual(["xai|xai-fast"]);
		expect(selected.resolution).toMatchObject({ state: "default", source: "configured-default", reason: "active-unavailable", provider: "xai", modelId: "grok-fast" });
		expect(selected.resolution.label).toBe("omp-native:xai/grok-fast [configured default]");
		expect("defaultSource" in selected.resolution).toBe(false);
	});

	test("without a configured selector the host catalog default must match the provider and id exactly", async () => {
		const live = fakeModel("openai-codex", "gpt-live", "unsupported");
		const exact = fakeQuery({ live: { model: live, source: "ctx.model" }, catalog: { "openai-codex": "gpt-cat" }, models: { "gpt-cat": fakeModel("openai-codex", "gpt-cat") } });
		const selected = engineOf(await selectNativeEngine(intentWith(), exact.query, binder().bind));
		expect(selected.resolution).toMatchObject({ state: "default", source: "host-catalog", reason: "active-unavailable", modelId: "gpt-cat" });
		expect(selected.resolution.label).toBe("omp-native:openai-codex/gpt-cat [host-catalog default]");
		const fuzzy = fakeQuery({ live: { model: live, source: "ctx.model" }, catalog: { "openai-codex": "gpt-cat" }, models: { "gpt-cat": fakeModel("openai-codex", "gpt-cat-2") } });
		const { bind, bound } = binder();
		const skip = skipOf(await selectNativeEngine(intentWith(), fuzzy.query, bind));
		expect(bound).toEqual([]);
		expect(skip).toMatchObject({ skipped: "selector-unresolved", notice: "Prompt Uplift skipped · omp-native:unresolved [selector-unresolved]" });
		expect(skip.resolution).toMatchObject({ state: "unresolved", source: "host-catalog", reason: "selector-unresolved", provider: "openai-codex", modelKnown: false });
		expect("modelId" in skip.resolution).toBe(false);
	});

	test("a failed configured selector never falls through to the catalog; another provider is a mismatch", async () => {
		const live = fakeModel("openai-codex", "gpt-live", "unavailable");
		const catalog = { "openai-codex": "gpt-cat" };
		const models = { "gpt-cat": fakeModel("openai-codex", "gpt-cat"), "router-alias": fakeModel("openrouter", "gpt-routed") };
		const mismatch = fakeQuery({ live: { model: live, source: "ctx.model" }, catalog, models });
		const crossed = skipOf(await selectNativeEngine(intentWith({}, { "openai-codex": "router-alias" }), mismatch.query, binder().bind));
		expect(crossed.resolution).toMatchObject({ source: "configured-default", reason: "provider-mismatch" });
		expect(mismatch.resolved).toEqual(["openai-codex|router-alias"]);
		const missing = fakeQuery({ live: { model: live, source: "ctx.model" }, catalog, models });
		const failed = skipOf(await selectNativeEngine(intentWith({}, { "openai-codex": "gone" }), missing.query, binder().bind));
		expect(failed.resolution).toMatchObject({ source: "configured-default", reason: "selector-unresolved" });
		expect(missing.resolved).toEqual(["openai-codex|gone"]);
	});

	test("no live model and no provider constraint is provider-unknown: no first-available or family choice", async () => {
		const { query, resolved } = fakeQuery({ catalog: { anthropic: "claude-cat" }, models: { "claude-cat": fakeModel("anthropic", "claude-cat") } });
		const skip = skipOf(await selectNativeEngine(intentWith({}, { anthropic: "claude-cat" }), query, binder().bind));
		expect(skip.resolution).toMatchObject({ state: "unresolved", source: "none", reason: "provider-unknown" });
		expect(resolved).toEqual([]);
	});

	test("a provider without a catalog entry is mapping-missing", async () => {
		const live = fakeModel("custom-gw", "m1", "unavailable");
		const skip = skipOf(await selectNativeEngine(intentWith(), fakeQuery({ live: { model: live, source: "ctx.model" } }).query, binder().bind));
		expect(skip.resolution).toMatchObject({ source: "host-catalog", reason: "mapping-missing", provider: "custom-gw" });
	});

	test("a host model override wins over the live model; its failures are visible and never fall through", async () => {
		const live = fakeModel("openai-codex", "gpt-6.1-sol");
		const smol = fakeModel("anthropic", "claude-smol");
		const models = { smol, dead: fakeModel("anthropic", "claude-dead", "unsupported") };
		const ok = engineOf(await selectNativeEngine(intentWith({ model: "smol" }), fakeQuery({ live: { model: live, source: "ctx.model" }, models }).query, binder().bind));
		expect(ok.resolution).toMatchObject({ state: "override", source: "host-override", reason: "explicit-model", provider: "anthropic", modelId: "claude-smol" });
		expect(ok.resolution.label).toBe("omp-native:anthropic/claude-smol [override]");
		const cases: Array<[Partial<ModelIntent["override"]>, string]> = [
			[{ model: "missing" }, "selector-unresolved"],
			[{ model: "smol", provider: "openai-codex" }, "provider-mismatch"],
			[{ model: "dead" }, "unsupported-model"],
		];
		for (const [override, reason] of cases) {
			const { bind, bound } = binder();
			const skip = skipOf(await selectNativeEngine(intentWith(override), fakeQuery({ live: { model: live, source: "ctx.model" }, models }).query, bind));
			expect(skip.resolution).toMatchObject({ state: "unresolved", source: "host-override", reason });
			expect(bound).toEqual([]);
		}
	});

	test("a provider-only constraint keeps a matching usable live model detected, else selects that provider's default", async () => {
		const live = fakeModel("openai-codex", "gpt-6.1-sol");
		const models = { "claude-cat": fakeModel("anthropic", "claude-cat") };
		const catalog = { anthropic: "claude-cat" };
		const matching = engineOf(await selectNativeEngine(intentWith({ provider: "openai-codex" }), fakeQuery({ live: { model: live, source: "ctx.model" } }).query, binder().bind));
		expect(matching.resolution).toMatchObject({ state: "detected", source: "ctx.model", reason: "live-model" });
		const other = engineOf(
			await selectNativeEngine(intentWith({ provider: "anthropic" }), fakeQuery({ live: { model: live, source: "ctx.model" }, models, catalog }).query, binder().bind),
		);
		expect(other.resolution).toMatchObject({
			state: "override",
			source: "provider-override",
			reason: "explicit-provider",
			defaultSource: "host-catalog",
			provider: "anthropic",
			modelId: "claude-cat",
		});
		const failed = skipOf(await selectNativeEngine(intentWith({ provider: "anthropic" }), fakeQuery({}).query, binder().bind));
		expect(failed.resolution).toMatchObject({ state: "unresolved", source: "provider-override", reason: "mapping-missing", provider: "anthropic" });
		expect("defaultSource" in failed.resolution).toBe(false);
	});

	test("control characters in an override or a configured default are selector-invalid before any resolution", async () => {
		const live = fakeModel("xai", "grok-live", "unavailable");
		for (const [override, providerDefaults, source] of [
			[{ model: "smol\nx" }, {}, "host-override"],
			[{ provider: "xai\u0000" }, {}, "provider-override"],
			[{}, { xai: "fast\u001b[2J" }, "configured-default"],
		] as const) {
			const { query, resolved } = fakeQuery({ live: { model: live, source: "ctx.model" } });
			const skip = skipOf(await selectNativeEngine(intentWith(override, providerDefaults), query, binder().bind));
			expect(skip.resolution).toMatchObject({ state: "unresolved", source, reason: "selector-invalid" });
			expect(resolved).toEqual([]);
		}
	});

	test("unsafe provider or model identifiers are opaque in the record while the bound Model is unchanged", async () => {
		const live = fakeModel("gate way", "https://evil.example/v1?key=x");
		const { bind, bound } = binder();
		const selected = engineOf(await selectNativeEngine(intentWith(), fakeQuery({ live: { model: live, source: "ctx.model" } }).query, bind));
		expect(bound[0]?.id).toBe("https://evil.example/v1?key=x");
		expect(selected.resolution).toMatchObject({ provider: "<opaque-provider>", modelId: "<opaque-model>", modelKnown: true });
		expect(selected.resolution.label).toBe("omp-native:<opaque-provider>/<opaque-model> [detected]");
		expect(JSON.stringify(selected.resolution)).not.toContain("evil");
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
		const dir = mkdtempSync(join(tmpdir(), "ultrathink-engine-error-"));
		dirs.push(dir);
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
