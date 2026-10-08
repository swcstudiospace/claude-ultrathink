// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Effort } from "@oh-my-pi/pi-ai";
import { planGate } from "../claude/plan-gate.ts";
import { readLast, readSession } from "../claude/state.ts";
import { claudeConfigPaths, defaultConfig, mergeConfig } from "../config.ts";
import type { UltrathinkConfig } from "../config.ts";
import { createDecisions } from "../decisions/gate.ts";
import { DEFAULT_GROK_CONFIG } from "../grok/types.ts";
import { storePath } from "../mcp/store.ts";
import type { GroundOutcome } from "../ragflow/types.ts";
import type { LegacyRoute } from "../route-defaults.ts";
import type { TrackPlan } from "../track/types.ts";
import { selectEngine } from "./engine.ts";
import type { ModelResolution } from "./engine.ts";
import type { OmpPlanner, OmpPlanRequest } from "./omp.ts";
import { fakeModel, flush, isolatedPlanEnv, quietConfig, setup, tuiCtx } from "./omp-test.helpers.ts";
import { planPrompt } from "./plan.ts";
import type { PlanResponse } from "./plan.ts";
import type { ProgressEvent } from "./progress.ts";

describe("named legacy flight identity (REV15-005)", () => {
	let root = "";
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "ut-omp-legacy-"));
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));

	test("shared pipeline fixtures use disposable lookup roots and the real Decisions kill switch (SEC15-DELTA-ENDPOINT-FIXTURE-AMBIENT-AUTH)", async () => {
		const env = isolatedPlanEnv(root);
		expect(env.ULTRATHINK_DECISIONS).toBe("0");
		expect(env.SUBSTRATE_DISABLED).toBe("1");
		expect(env.PI_CODING_AGENT_DIR).toBe(join(root, "agent"));
		expect(env.ULTRATHINK_STATE_DIR).toBe(join(root, "state"));
		expect(storePath(env)).toBe(join(root, "mcp-credentials.json"));
		expect(storePath({ ...env, ULTRATHINK_MCP_STORE: undefined })).toBe(join(root, "xdg", "ultrathink", "mcp-credentials.json"));
		expect(storePath({ ...env, ULTRATHINK_MCP_STORE: undefined, XDG_CONFIG_HOME: undefined })).toBe(join(root, "home", ".config", "ultrathink", "mcp-credentials.json"));
		expect(claudeConfigPaths(root, env)).toEqual([
			join(root, "xdg", "ultrathink", "config.json"),
			join(root, "claude", "ultrathink.json"),
			{ path: join(root, ".claude", "ultrathink.json"), project: true },
		]);
		const config = defaultConfig().decisions;
		expect(config.points).toContain("plan");
		expect(quietConfig().decisions).toEqual({ ...config, points: [] });
		const decisions = createDecisions({
			config, env,
			get storePath(): string { throw new Error("fixture must not resolve Decisions credentials"); },
		});
		expect(decisions.active("plan")).toBe(false);
		expect(await planGate({ prompt: "add a widget", text: "add a widget", history: "" }, decisions)).toEqual({ plan: true });
	});

	function configured(engine: LegacyRoute): UltrathinkConfig {
		return quietConfig((config) => {
			config.think.engine = engine;
			// Shunt selection needs no login. HTTP/CLI cases use a missing, isolated auth store.
			config.grok.transport = "shunt";
			config.grok.shuntBaseUrl = "http://127.0.0.1:1";
			config.grok.home = join(root, "grok");
		});
	}

	/** Exercise the real legacy selector without invoking any selected completer, subprocess or inference. */
	function selecting() {
		const resolutions: ModelResolution[] = [];
		const signals: AbortSignal[] = [];
		const plan: OmpPlanner = async (request, signal) => {
			signals.push(signal);
			const { resolution } = await selectEngine(request.config!, request.control ?? {}, request.cwd, { host: "omp" });
			resolutions.push(resolution);
			return { context: resolution.modelId ?? "", modelResolution: resolution };
		};
		return { plan, resolutions, signals };
	}

	for (const engine of ["claude", "muse", "grok"] as const) {
		test(`same-prompt reentry uses the new named ${engine} model instead of its settled plan`, async () => {
			const config = configured(engine);
			config[engine].model = "PIN_A";
			const planner = selecting();
			const { run, sent } = setup(planner.plan, 1_000, { config: () => config, stateDir: root }, { model: fakeModel("acme", "session") });
			expect(await run()).toMatchObject({ message: { content: "PIN_A" } });
			expect(await run()).toMatchObject({ message: { content: "PIN_A" } });
			expect(planner.resolutions).toHaveLength(1);
			config[engine].model = "PIN_B";
			expect(await run()).toMatchObject({ message: { content: "PIN_B" } });
			expect(await run()).toMatchObject({ message: { content: "PIN_B" } });
			expect(planner.resolutions.map((resolution) => resolution.modelId)).toEqual(["PIN_A", "PIN_B"]);
			expect(planner.signals.map((signal) => signal.aborted)).toEqual([true, false]);
			expect(sent).toEqual([]);
		});

		test(`an equal-valued ${engine} file pin invalidates route-default provenance`, async () => {
			let config = configured(engine);
			const model = config[engine].model;
			const planner = selecting();
			const { run } = setup(planner.plan, 1_000, { config: () => config, stateDir: root });
			expect(await run()).toMatchObject({ message: { content: model } });
			expect(planner.resolutions[0]).toMatchObject({ state: "default", source: "route-default", modelId: model });
			config = mergeConfig({ [engine]: { model } }, config);
			expect(await run()).toMatchObject({ message: { content: model } });
			expect(planner.resolutions).toHaveLength(2);
			expect(planner.resolutions[1]).toMatchObject({ state: "override", source: "engine-model", modelId: model });
			expect(planner.signals[0]?.aborted).toBe(true);
		});
	}

	test("a named-model change cancels a pending flight and suppresses its late old-target plan", async () => {
		const config = configured("claude");
		config.claude.model = "PIN_A";
		const planner = selecting();
		const first = Promise.withResolvers<void>();
		const { run, sent } = setup(
			async (request, signal, onEvent) => {
				const result = await planner.plan(request, signal, onEvent);
				if (result.modelResolution?.modelId === "PIN_A") await first.promise;
				return result;
			},
			1,
			{ config: () => config, stateDir: root },
		);
		expect(await run()).toMatchObject({ message: { customType: "ultrathink-pending" } });
		config.claude.model = "PIN_B";
		expect(await run()).toMatchObject({ message: { content: "PIN_B" } });
		expect(planner.resolutions.map((resolution) => resolution.modelId)).toEqual(["PIN_A", "PIN_B"]);
		expect(planner.signals[0]?.aborted).toBe(true);
		first.resolve();
		await flush();
		expect(sent).toEqual([]);
		expect(await run()).toMatchObject({ message: { content: "PIN_B" } });
		expect(planner.resolutions).toHaveLength(2);
	});

	test("a changed Grok shunt alias replans on the new wire target", async () => {
		const config = configured("grok");
		config.grok.shuntModel = "SHUNT_A";
		const planner = selecting();
		const { run } = setup(planner.plan, 1_000, { config: () => config, stateDir: root });
		expect(await run()).toMatchObject({ message: { content: "SHUNT_A" } });
		config.grok.shuntModel = "SHUNT_B";
		expect(await run()).toMatchObject({ message: { content: "SHUNT_B" } });
		expect(planner.resolutions.map((resolution) => [resolution.modelId, resolution.source])).toEqual([
			["SHUNT_A", "shunt-model"],
			["SHUNT_B", "shunt-model"],
		]);
		expect(planner.signals[0]?.aborted).toBe(true);
	});

	for (const [transport, endpoint, suffix] of [["shunt", "shuntBaseUrl", "/v1/messages"], ["http", "baseUrl", "/responses"]] as const) {
		test(`Grok ${transport} endpoint-only same-submission reentry aborts a pipeline paused on evidence after its final completion before obsolete effects (QF-RUNTIME-ENDPOINT-PIPELINE)`, async () => {
			const stateDir = join(root, "state");
			const prompt = "Build a widget showing A & B inside <button> labels.";
			const original = "<ORIGINAL>Build a widget showing A &amp; B inside &lt;button&gt; labels.</ORIGINAL>";
			const oldMarker = "OBSOLETE_ENDPOINT_SPEC";
			const currentMarker = "CURRENT_ENDPOINT_SPEC";
			const oldPath = `/obsolete${suffix}`;
			const currentPath = `/current${suffix}`;
			const calls: Array<{ path: string; model: string | undefined; user: string | undefined }> = [];
			const server = Bun.serve({
				hostname: "127.0.0.1",
				port: 0,
				async fetch(request) {
					const path = new URL(request.url).pathname;
					if (request.method !== "POST" || (path !== oldPath && path !== currentPath)) return new Response("not found", { status: 404 });
					const body = await request.json() as { model?: string; input?: string; messages?: Array<{ role: string; content: string }> };
					calls.push({ path, model: body.model, user: body.input ?? body.messages?.[0]?.content });
					// No ORIGINAL echo: the real uplift sanitizer must preserve the submitted user's words.
					const xml = `<BUILD_PROMPT><SCOPE>${path === oldPath ? oldMarker : currentMarker}</SCOPE></BUILD_PROMPT>`;
					return Response.json(transport === "shunt"
						? { type: "message", role: "assistant", content: [{ type: "text", text: xml }] }
						: { output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: xml }] }] });
				},
			});
			const config = configured("grok");
			config.think.enabled = config.hitl.enabled = false;
			config.track.enabled = true;
			config.linear.team = "Team";
			config.grok.transport = transport;
			config.grok.model = "ENDPOINT_MODEL";
			config.modelProvenance = { ...config.modelProvenance, grok: "file-pin" };
			config.grok[endpoint] = `http://127.0.0.1:${server.port}/obsolete`;
			if (transport === "http") {
				// Isolated synthetic login permits the real HTTP completer, never a user's store or live auth.
				mkdirSync(config.grok.home, { recursive: true });
				writeFileSync(join(config.grok.home, "auth.json"), JSON.stringify({ default: { key: ["fixture", "session", "value"].join("-") } }));
			}
			const empty: GroundOutcome = { status: "none", chunks: [], chars: 0, ms: 0, datasets: 0 };
			const runs: Array<{
				request: OmpPlanRequest;
				signal: AbortSignal;
				evidenceSignal?: AbortSignal;
				evidence: PromiseWithResolvers<GroundOutcome>;
				uplifted: PromiseWithResolvers<void>;
				completed: PromiseWithResolvers<PlanResponse>;
				delivery: PromiseWithResolvers<void>;
				events: ProgressEvent[];
				tracked: TrackPlan[];
			}> = [];
			const t = tuiCtx();
			const { run, emit, sent } = setup(async (request, signal, onEvent) => {
				const entry: (typeof runs)[number] = {
					request, signal,
					evidence: Promise.withResolvers<GroundOutcome>(),
					uplifted: Promise.withResolvers<void>(),
					completed: Promise.withResolvers<PlanResponse>(),
					delivery: Promise.withResolvers<void>(),
					events: [], tracked: [],
				};
				runs.push(entry);
				const endEvents: ProgressEvent[] = [];
				// No injected selector or planner result: selection, Grok fetch, runPromptSubmit and writes are real.
				const response = await planPrompt(
					{ host: "omp", session_id: request.sessionId, prompt: request.prompt, cwd: request.cwd },
					isolatedPlanEnv(root),
					{
						config: request.config!, control: request.control!, stateDir, signal,
						ground: ({ signal: evidenceSignal }) => { entry.evidenceSignal = evidenceSignal; return entry.evidence.promise; },
						createTracker: () => async ({ plan }) => { entry.tracked.push(plan); return undefined; },
						progress: (event) => {
							entry.events.push(event);
							// Deliver the actual end events and response only when released, so the obsolete callbacks
							// reach the extension after the replacement owns its UI, state, spec and carrier.
							if (event.type === "end") endEvents.push(event);
							else onEvent?.(event);
							if (event.type === "stage" && event.stage === "uplift" && event.phase === "end") entry.uplifted.resolve();
						},
					},
				);
				entry.completed.resolve(response);
				await entry.delivery.promise;
				for (const event of endEvents) onEvent?.(event);
				return response;
			}, 1, { stateDir, config: () => config, now: () => 5_000 }, { cwd: root, model: fakeModel("acme", "unchanged-session-model"), ...t.ctx });
			const pending = { message: expect.objectContaining({ customType: "ultrathink-pending" }) };
			const paths = ["sessions/s1.json", "sessions/s1.xml", "last.json", "last-plan.json"].map((path) => join(stateDir, path));
			emit("session_start");
			try {
				expect(await run(prompt)).toEqual(pending);
				const old = runs[0]!;
				await old.uplifted.promise;
				expect(calls.map((call) => [call.path, call.model])).toEqual([[oldPath, "ENDPOINT_MODEL"]]);
				expect(old.events).toContainEqual(expect.objectContaining({ type: "stage", stage: "uplift", phase: "end", ok: true }));
				expect(old.evidenceSignal?.aborted).toBe(false);
				expect(old.signal.aborted).toBe(false);
				expect(old.tracked).toEqual([]);
				expect(existsSync(stateDir)).toBe(false);

				// Same prompt/session/submission and model: no turn_start or other target/provenance mutation.
				config.grok[endpoint] = `http://127.0.0.1:${server.port}/current`;
				expect(await run(prompt)).toEqual(pending);
				expect(runs).toHaveLength(2);
				const current = runs[1]!;
				expect(current.request).toMatchObject({ prompt, sessionId: old.request.sessionId, cwd: old.request.cwd, model: old.request.model });
				expect(current.request.control).toEqual(old.request.control);
				expect(current.request.config).toEqual({
					...old.request.config!,
					grok: { ...old.request.config!.grok, [endpoint]: config.grok[endpoint] },
				});
				expect(old.signal.aborted).toBe(true);
				expect(old.evidenceSignal?.aborted).toBe(true);
				expect(old.request.isCurrent?.()).toBe(false);
				expect(current.signal.aborted).toBe(false);
				expect(current.request.isCurrent?.()).toBe(true);
				const obsolete = await old.completed.promise;
				expect(obsolete).toMatchObject({ context: "", skipped: "aborted" });
				expect(old.tracked).toEqual([]);
				expect(old.events.filter((event) => event.type === "stage" && ["think", "clarify", "plan", "track", "state"].includes(event.stage))).toEqual([]);
				expect(old.events).toContainEqual(expect.objectContaining({ type: "end", outcome: "skipped", detail: "aborted" }));
				for (const path of paths) expect(existsSync(path)).toBe(false);
				expect(sent).toEqual([]);

				await current.uplifted.promise;
				expect(calls.map((call) => [call.path, call.model])).toEqual([[oldPath, "ENDPOINT_MODEL"], [currentPath, "ENDPOINT_MODEL"]]);
				expect(calls.map((call) => call.user)).toEqual([`<user_request>\n${prompt}\n</user_request>`, `<user_request>\n${prompt}\n</user_request>`]);
				expect(current.events).toContainEqual(expect.objectContaining({ type: "stage", stage: "uplift", phase: "end", ok: true }));
				expect(current.evidenceSignal?.aborted).toBe(false);
				expect(current.tracked).toEqual([]);
				expect(t.line()).toContain("plan arrives as aside");
				expect(existsSync(stateDir)).toBe(false);
				current.evidence.resolve(empty);
				const response = await current.completed.promise;
				expect(response.skipped).toBeUndefined();
				expect(response.context).toContain(currentMarker);
				expect(response.context).toContain(original);
				expect(response.context).not.toContain(oldMarker);
				expect(response).toMatchObject({
					specPath: paths[1], statePath: paths[0], carrierPath: paths[3],
					modelResolution: { host: "omp", transport: `grok-${transport}`, modelId: "ENDPOINT_MODEL", state: "override", source: "engine-model" },
				});
				expect(response.graphId).toBeTruthy();
				expect(current.tracked).toHaveLength(1);
				expect(current.tracked[0]?.task.upliftedPrompt).toContain(currentMarker);
				expect(current.tracked[0]?.task.upliftedPrompt).toContain(original);
				for (const stage of ["track", "state"])
					expect(current.events.filter((event) => event.type === "stage" && event.stage === stage && event.phase === "start")).toHaveLength(1);
				const record = readSession(stateDir, "s1");
				expect(record?.result).toMatchObject({ original: prompt, root: "BUILD_PROMPT", source: "llm" });
				expect(record?.result.xml).toContain(currentMarker);
				expect(record?.result.xml).toContain(original);
				expect(readLast(stateDir)).toEqual(record);
				expect(JSON.parse(readFileSync(paths[3]!, "utf8"))).toMatchObject({
					host: "omp", sessionId: "s1", specPath: response.specPath, statePath: response.statePath,
					graphId: response.graphId, context: response.context,
				});
				const saved = paths.map((path) => readFileSync(path, "utf8"));
				for (const content of saved) {
					expect(content).toContain(currentMarker);
					expect(content).toContain(original);
					expect(content).not.toContain(oldMarker);
				}
				current.delivery.resolve();
				await flush();
				expect(sent).toMatchObject([{ message: { customType: "ultrathink-plan", content: response.context }, options: { deliverAs: "aside" } }]);
				expect(sent).toHaveLength(1);
				const currentLine = t.line();
				expect(currentLine).toContain("BUILD_PROMPT");
				// An evidence source may ignore abort and settle late; the old end/progress/delivery also arrive late.
				old.evidence.resolve(empty);
				old.delivery.resolve();
				await flush();
				expect(t.line()).toBe(currentLine);
				expect(paths.map((path) => readFileSync(path, "utf8"))).toEqual(saved);
				expect(old.tracked).toEqual([]);
				expect(current.tracked).toHaveLength(1);
				expect(sent).toHaveLength(1);
				expect(sent).toMatchObject([{ message: { content: response.context }, options: { deliverAs: "aside" } }]);
				expect(await run(prompt)).toBeUndefined();
				expect(runs).toHaveLength(2);
				expect(calls).toHaveLength(2);
				expect(current.signal.aborted).toBe(false);
			} finally {
				emit("session_shutdown");
				for (const entry of runs) {
					entry.evidence.resolve(empty);
					entry.delivery.resolve();
				}
				server.stop(true);
				await Promise.all(runs.map((entry) => entry.completed.promise));
				await flush();
			}
		});
	}

	for (const [transport, endpoint, unused] of [["shunt", "shuntBaseUrl", "baseUrl"], ["http", "baseUrl", "shuntBaseUrl"]] as const) {
		test(`a pending Grok ${transport} flight compares only its effective endpoint and suppresses stale delivery (REV15-005)`, async () => {
			const config = configured("grok");
			config.grok.transport = transport;
			config.grok[endpoint] = "https://SECRET-GATEWAY-A.invalid";
			const runs: Array<{ signal: AbortSignal; gate: PromiseWithResolvers<string> }> = [];
			const { run, sent } = setup((_request, signal) => {
				const gate = Promise.withResolvers<string>();
				runs.push({ signal, gate });
				return gate.promise;
			}, 1, { config: () => config, stateDir: root });
			const pending = { message: expect.objectContaining({ customType: "ultrathink-pending" }) };
			expect(await run()).toEqual(pending);
			config.grok[endpoint] = " https://SECRET-GATEWAY-A.invalid/// ";
			config.grok[unused] = "https://SECRET-UNUSED.invalid";
			expect(await run()).toEqual(pending);
			expect(runs).toHaveLength(1);
			expect(runs[0]?.signal.aborted).toBe(false);
			config.grok[endpoint] = "https://SECRET-GATEWAY-B.invalid";
			expect(await run()).toEqual(pending);
			expect(runs).toHaveLength(2);
			expect(runs.map((entry) => entry.signal.aborted)).toEqual([true, false]);
			runs[0]!.gate.resolve("OLD PLAN");
			await flush();
			expect(sent).toEqual([]);
			runs[1]!.gate.resolve("NEW PLAN");
			await flush();
			expect(sent).toMatchObject([{ message: { content: "NEW PLAN" }, options: { deliverAs: "aside" } }]);
			expect(await run()).toBeUndefined();
			expect(runs).toHaveLength(2);
		});
	}

	for (const [transport, endpoint, before] of [
		["shunt", "shuntBaseUrl", ""],
		["shunt", "shuntBaseUrl", "https://SECRET-GATEWAY-A.invalid"],
		["http", "baseUrl", "https://SECRET-GATEWAY-A.invalid"],
	] as const) {
		test(`Grok ${transport} endpoint changes invalidate a settled ${before ? "result" : "missing-gateway skip"} (REV15-005)`, async () => {
			const config = configured("grok");
			config.grok.transport = transport;
			config.grok[endpoint] = before;
			const planner = selecting();
			const { run, sent, command, notices } = setup(planner.plan, 1_000, { config: () => config, stateDir: root });
			const old = await run();
			expect(await run()).toEqual(old);
			expect(planner.resolutions).toHaveLength(1);
			if (!before) expect(planner.resolutions[0]?.reason).toBe("transport-incompatible");
			config.grok[endpoint] = "https://SECRET-GATEWAY-B.invalid";
			const result = await run();
			expect(await run()).toEqual(result);
			expect(planner.resolutions).toHaveLength(2);
			expect(planner.signals.map((signal) => signal.aborted)).toEqual([true, false]);
			if (transport === "shunt") expect(result).toMatchObject({ message: { content: config.grok.model } });
			else expect(result).toBeUndefined();
			await command("ultrathink-status");
			expect(JSON.stringify({ old, result, resolutions: planner.resolutions, sent, notices })).not.toContain("SECRET");
		});
	}

	test("the HTTP default and unused CLI or disabled Grok endpoints keep settled reentry reusable", async () => {
		for (const mode of ["default-http", "cli", "disabled"] as const) {
			const config = configured("grok");
			config.grok.transport = mode === "cli" ? "cli" : "http";
			config.grok.enabled = mode !== "disabled";
			config.grok.baseUrl = DEFAULT_GROK_CONFIG.baseUrl;
			const planner = selecting();
			const { run } = setup(planner.plan, 1_000, { config: () => config, stateDir: root });
			const result = await run();
			config.grok.baseUrl = mode === "default-http" ? " " : "https://SECRET-UNUSED.invalid";
			config.grok.shuntBaseUrl = "https://SECRET-UNUSED.invalid";
			expect(await run()).toEqual(result);
			expect(planner.resolutions).toHaveLength(1);
			expect(planner.signals[0]?.aborted).toBe(false);
		}
	});

	test("Grok transport changes invalidate both settled plans and unresolved flights", async () => {
		const config = configured("grok");
		config.grok.model = "PIN_A";
		const planner = selecting();
		const { run } = setup(planner.plan, 1_000, { config: () => config, stateDir: root });
		expect(await run()).toMatchObject({ message: { content: "PIN_A" } });
		for (const transport of ["http", "cli"] as const) {
			config.grok.transport = transport;
			expect(await run()).toBeUndefined();
			expect(planner.resolutions.at(-1)).toMatchObject({ state: "unresolved", reason: "grok-unavailable" });
		}
		expect(planner.resolutions.map((resolution) => resolution.transport)).toEqual(["grok-shunt", "grok-http", "grok-cli"]);
		expect(planner.signals.map((signal) => signal.aborted)).toEqual([true, true, false]);
	});

	for (const switchName of ["fallbackToClaude", "enabled"] as const) {
		test(`Grok ${switchName} changes and the fallback Claude model/provenance each invalidate reentry`, async () => {
			let config = configured("grok");
			config.grok.transport = "http";
			const planner = selecting();
			const { run } = setup(planner.plan, 1_000, { config: () => config, stateDir: root });
			expect(await run()).toBeUndefined();
			expect(planner.resolutions[0]).toMatchObject({ state: "unresolved", reason: "grok-unavailable" });
			config.grok[switchName] = switchName === "fallbackToClaude";
			const defaultModel = config.claude.model;
			expect(await run()).toMatchObject({ message: { content: defaultModel } });
			expect(planner.resolutions[1]).toMatchObject({ state: "default", source: "configured-fallback", transport: "claude-cli" });
			config = mergeConfig({ claude: { model: defaultModel } }, config);
			expect(await run()).toMatchObject({ message: { content: defaultModel } });
			expect(planner.resolutions[2]).toMatchObject({ state: "override", source: "configured-fallback", modelId: defaultModel });
			config = mergeConfig({ claude: { model: "FALLBACK_B" } }, config);
			expect(await run()).toMatchObject({ message: { content: "FALLBACK_B" } });
			expect(planner.resolutions[3]).toMatchObject({ state: "override", source: "configured-fallback", modelId: "FALLBACK_B" });
			expect(planner.resolutions).toHaveLength(4);
			expect(planner.signals.map((signal) => signal.aborted)).toEqual([true, true, true, false]);
		});
	}

	test("session thinking changes do not replace named legacy effort settings or invalidate their flights", async () => {
		for (const engine of ["claude", "muse", "grok"] as const) {
			const config = configured(engine);
			config.claude.thinking = true;
			const before = structuredClone(config);
			let level = "low" as Effort;
			let reads = 0;
			const planner = selecting();
			const requests: OmpPlanRequest[] = [];
			const { run } = setup(
				async (request, signal, onEvent) => {
					requests.push(request);
					return planner.plan(request, signal, onEvent);
				},
				1_000,
				{ config: () => config, stateDir: root },
				{},
				{
					getThinkingLevel: () => {
						reads++;
						return level;
					},
				},
			);
			await run();
			level = "high" as Effort;
			await run();
			expect(reads).toBe(0);
			expect(requests).toHaveLength(1);
			expect(requests[0]).not.toHaveProperty("thinkingLevel");
			expect(requests[0]?.config).toEqual(before);
			expect(planner.resolutions).toHaveLength(1);
			expect(planner.signals[0]?.aborted).toBe(false);
		}
	});

	test("unused legacy config does not invalidate native auto flights", async () => {
		const config = quietConfig();
		let calls = 0;
		const { run } = setup(async () => {
			calls++;
			return "PLAN";
		}, 1_000, { config: () => config, stateDir: root }, { model: fakeModel("acme", "session") });
		await run();
		config.claude.model = "UNUSED_CLAUDE";
		config.muse.model = "UNUSED_MUSE";
		config.grok.model = "UNUSED_GROK";
		config.grok.shuntModel = "UNUSED_SHUNT";
		config.grok.transport = "shunt";
		config.grok.baseUrl = "https://SECRET-UNUSED-HTTP.invalid";
		config.grok.shuntBaseUrl = "https://SECRET-UNUSED-SHUNT.invalid";
		config.grok.fallbackToClaude = true;
		config.modelProvenance = { claude: "file-pin", muse: "file-pin", grok: "file-pin" };
		expect(await run()).toMatchObject({ message: { content: "PLAN" } });
		expect(calls).toBe(1);
	});

	test("host and shunt overrides ignore shadowed model pins and unrelated routes", async () => {
		for (const engine of ["claude", "muse", "grok"] as const) {
			let config = configured(engine);
			if (engine === "grok") config.grok.shuntModel = "WIRE";
			else config.models.hosts.omp = { provider: "", model: "WIRE" };
			const planner = selecting();
			const { run } = setup(planner.plan, 1_000, { config: () => config, stateDir: root });
			expect(await run()).toMatchObject({ message: { content: "WIRE" } });
			config = mergeConfig({ claude: { model: "UNUSED_CLAUDE" }, muse: { model: "UNUSED_MUSE" }, grok: { model: "UNUSED_GROK" } }, config);
			expect(await run()).toMatchObject({ message: { content: "WIRE" } });
			expect(planner.resolutions).toHaveLength(1);
			expect(planner.signals[0]?.aborted).toBe(false);
		}
	});
});
