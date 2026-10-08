// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, describe, expect, test } from "bun:test";
import { defaultConfig, mergeConfig } from "../config.ts";
import { ROUTE_DEFAULT_MODELS } from "../route-defaults.ts";
import { type ModelIntent, type NativeEngineSelector, selectEngine, selectNativeEngine } from "./engine.ts";
import { AUTO, binder, configWith, createEngineFixtures, engineOf, fakeModel, fakeQuery, intentWith, resolutionOf, skipOf } from "./engine-test.helpers.ts";
import { createNativeEngineSelector } from "./omp.ts";
import { fakeModel as nativeModel, fakeRuntime, recorder, reply } from "./omp-test.helpers.ts";

const { claudeSpy, cleanup } = createEngineFixtures();
afterEach(cleanup);

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

	for (const tier of ["configured-default", "host-catalog"] as const) {
		for (const { name, extra, reason } of [
			{ name: "unsupported runner", extra: { kind: "image" }, reason: "unsupported-model" },
			{ name: "text-less", extra: { input: ["image"] }, reason: "unsupported-model" },
			{ name: "unavailable", extra: {}, reason: "selector-unresolved" },
		] as const) {
			test(`${tier} rejects a returned ${name} default without auth, completion, catalog retry or cross-provider fallback`, async () => {
				const live = nativeModel("acme", "live-image", { kind: "image" });
				const returned = nativeModel("acme", "def-1", extra);
				const catalogGood = nativeModel("acme", "catalog-good");
				const other = nativeModel("other", "other-valid");
				let exactLookups = 0;
				const { runtime, log } = fakeRuntime([catalogGood, other], {
					aliases: {
						"@planning": () => returned,
						"acme/def-1": () => {
							exactLookups++;
							// The selector can return a Model whose exact authenticated revalidation is unavailable.
							return name === "unavailable" && (tier === "configured-default" || exactLookups > 1) ? undefined : returned;
						},
					},
				});
				const catalogReads: string[] = [];
				const catalog: Record<string, string> = {
					get acme() {
						catalogReads.push("acme");
						return tier === "configured-default" ? "catalog-good" : "def-1";
					},
					get other() {
						catalogReads.push("other");
						return "other-valid";
					},
				};
				const rec = recorder(() => reply([{ type: "text", text: "an ineligible target must never complete" }]));
				const flight = new AbortController();
				const native = createNativeEngineSelector(
					{ prompt: "add a widget", cwd: "/repo", sessionId: "s1", model: live, modelSource: "ctx.model", native: runtime },
					flight.signal,
					{ completeSimple: rec.complete, providerDefaults: catalog },
				);
				const configured: Record<string, string> = tier === "configured-default" ? { acme: "@planning", other: "other-valid" } : { other: "other-valid" };
				const skipped = skipOf(await native(intentWith({}, configured), flight.signal));
				expect(skipped).toMatchObject({ skipped: reason, notice: `Prompt Uplift skipped · omp-native:unresolved [${reason}]` });
				expect(skipped.resolution).toMatchObject({ state: "unresolved", host: "omp", transport: "omp-native", source: tier, reason, provider: "acme", modelKnown: false });
				for (const field of ["modelId", "api", "providerType", "defaultSource"]) expect(field in skipped.resolution).toBe(false);
				const selectedSpec = tier === "configured-default" ? "@planning" : "acme/def-1";
				expect(log.resolves).toEqual(name === "unavailable" ? [selectedSpec, "acme/def-1"] : [selectedSpec]);
				expect(catalogReads).toEqual(tier === "configured-default" ? [] : ["acme"]);
				expect(log.resolvers).toHaveLength(0);
				expect(rec.calls).toHaveLength(0);
			});
		}
	}

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
