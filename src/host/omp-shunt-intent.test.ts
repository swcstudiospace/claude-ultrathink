// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLast, readSession } from "../claude/state.ts";
import { mergeConfig, normalizeSelectorField } from "../config.ts";
import type { GroundOutcome } from "../ragflow/types.ts";
import type { TrackPlan } from "../track/types.ts";
import type { OmpPlanRequest } from "./omp.ts";
import { fakeModel, fakeRuntime, flush, isolatedPlanEnv, quietConfig, setup, tuiCtx } from "./omp-test.helpers.ts";
import { planPrompt } from "./plan.ts";
import type { PlanResponse } from "./plan.ts";
import type { ProgressEvent } from "./progress.ts";

const PROMPT = "Build a widget showing A & B inside <button> labels.";
const ORIGINAL = "<ORIGINAL>Build a widget showing A &amp; B inside &lt;button&gt; labels.</ORIGINAL>";
const EMPTY: GroundOutcome = { status: "none", chunks: [], chars: 0, ms: 0, datasets: 0 };
const PENDING = { message: expect.objectContaining({ customType: "ultrathink-pending" }) };
const CONTROL_ALIASES = [
	["leading newline", "\nSHUNT_A"],
	["trailing newline", "SHUNT_A\n"],
	["leading tab", "\tSHUNT_A"],
	["trailing carriage return", "SHUNT_A\r"],
	["leading C1", "\u0085SHUNT_A"],
	["trailing C1", "SHUNT_A\u0085"],
] as const;

type ConfigInput = "direct" | "merged";
interface PipelineRun {
	request: OmpPlanRequest;
	signal: AbortSignal;
	evidenceSignal?: AbortSignal;
	evidence: PromiseWithResolvers<GroundOutcome>;
	uplifted: PromiseWithResolvers<void>;
	completed: PromiseWithResolvers<PlanResponse>;
	delivery: PromiseWithResolvers<void>;
	events: ProgressEvent[];
	tracked: TrackPlan[];
	grokHomeReads: number;
}

interface PipelineState {
	stateDir: string;
	paths: readonly string[];
}

/** Real extension, selector, shunt fetch and shared pipeline; only evidence, tracker I/O and delivery are held. */
function pipeline(alias: string, input: ConfigInput) {
	const root = mkdtempSync(join(tmpdir(), "ut-omp-shunt-intent-"));
	const env = isolatedPlanEnv(root);
	const stateDir = join(root, "state");
	const paths = ["sessions/s1.json", "sessions/s1.xml", "last.json", "last-plan.json"].map((path) => join(stateDir, path));
	const calls: Array<{ path: string; model?: string; user?: string }> = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const path = new URL(request.url).pathname;
			if (request.method !== "POST" || path !== "/v1/messages") return new Response("not found", { status: 404 });
			const body = await request.json() as { model?: string; messages?: Array<{ role: string; content: string }> };
			calls.push({ path, model: body.model, user: body.messages?.[0]?.content });
			return Response.json({ type: "message", role: "assistant", content: [
				{ type: "text", text: `<BUILD_PROMPT><SCOPE>SHUNT_VALID_SPEC_${calls.length}</SCOPE></BUILD_PROMPT>` },
			] });
		},
	});
	let config = quietConfig((value) => {
		value.think.engine = "grok";
		value.think.enabled = value.hitl.enabled = false;
		value.track.enabled = true;
		value.linear.team = "Team";
		value.grok.transport = "shunt";
		value.grok.shuntBaseUrl = `http://127.0.0.1:${server.port}`;
		value.grok.home = join(root, "grok");
		value.grok.model = "ENGINE_PIN";
		value.modelProvenance = { ...value.modelProvenance, grok: "file-pin" };
	});
	const setAlias = (value: string) => {
		// Replace rather than mutate a captured config: the old pipeline keeps its original target.
		config = input === "merged" ? mergeConfig({ grok: { shuntModel: value } }, config)
			: { ...config, grok: { ...config.grok, shuntModel: value } };
	};
	setAlias(alias);
	const runs: PipelineRun[] = [];
	const t = tuiCtx();
	const live = fakeModel("acme", "unchanged-session-model");
	const { runtime, log } = fakeRuntime([live], { current: () => live });
	const harness = setup(async (request, signal, onEvent) => {
		const entry: PipelineRun = {
			request, signal,
			evidence: Promise.withResolvers<GroundOutcome>(),
			uplifted: Promise.withResolvers<void>(),
			completed: Promise.withResolvers<PlanResponse>(),
			delivery: Promise.withResolvers<void>(),
			events: [], tracked: [], grokHomeReads: 0,
		};
		runs.push(entry);
		const captured = request.config!;
		const selectionConfig = { ...captured, grok: { ...captured.grok } };
		Object.defineProperty(selectionConfig.grok, "home", { get: () => {
			entry.grokHomeReads++;
			return captured.grok.home;
		} });
		const endEvents: ProgressEvent[] = [];
		const response = await planPrompt(
			{ host: "omp", session_id: request.sessionId, prompt: request.prompt, cwd: request.cwd },
			env,
			{
				config: selectionConfig, control: request.control!, stateDir, signal,
				ground: ({ signal: evidenceSignal }) => { entry.evidenceSignal = evidenceSignal; return entry.evidence.promise; },
				createTracker: () => async ({ plan }) => { entry.tracked.push(plan); return undefined; },
				progress: (event) => {
					entry.events.push(event);
					if (event.type === "end") endEvents.push(event);
					else onEvent?.(event);
					if (event.type === "stage" && event.stage === "uplift" && event.phase === "end") entry.uplifted.resolve();
				},
			},
		);
		entry.completed.resolve(response);
		// An invalid selector settles normally; aborted/valid flights can deliver their real end callbacks late.
		if (response.skipped !== "selector-invalid") await entry.delivery.promise;
		for (const event of endEvents) onEvent?.(event);
		return response;
	}, 1, { stateDir, config: () => config, now: () => 5_000 }, { cwd: root, model: live, ...runtime, ...t.ctx });
	harness.emit("session_start");
	return {
		...harness, runs, calls, paths, stateDir, setAlias, log,
		run: () => harness.run(PROMPT),
		line: () => t.line(500),
		expectNoAuth: () => {
			expect(log.resolvers).toEqual([]);
			expect(existsSync(join(root, "grok", "auth.json"))).toBe(false);
			expect(existsSync(env.ULTRATHINK_MCP_STORE!)).toBe(false);
		},
		close: async () => {
			harness.emit("session_shutdown");
			for (const entry of runs) {
				entry.evidence.resolve(EMPTY);
				entry.delivery.resolve();
			}
			try {
				server.stop(true);
				await Promise.all(runs.map((entry) => entry.completed.promise));
				await flush();
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		},
	};
}

function expectInvalid(entry: PipelineRun, response: PlanResponse): void {
	expect(response).toMatchObject({ context: "", skipped: "selector-invalid", modelResolution: {
		host: "omp", transport: "grok-shunt", state: "unresolved", source: "shunt-model", reason: "selector-invalid", modelKnown: false,
	} });
	expect(response.modelResolution).not.toHaveProperty("modelId");
	for (const field of ["specPath", "statePath", "carrierPath", "graphId"]) expect(response).not.toHaveProperty(field);
	expect(entry.grokHomeReads).toBe(0);
	expect(entry.evidenceSignal).toBeUndefined();
	expect(entry.tracked).toEqual([]);
	expect(entry.events.filter((event) => event.type === "stage")).toEqual([]);
	expect(entry.events).toContainEqual(expect.objectContaining({ type: "end", outcome: "skipped", detail: "selector-invalid" }));
	expect(JSON.stringify(response)).not.toContain("SHUNT_A");
}

function expectSaved(fixture: PipelineState, entry: PipelineRun, response: PlanResponse, marker: string): string[] {
	expect(response.skipped).toBeUndefined();
	expect(response.context).toContain(marker);
	expect(response.context).toContain(ORIGINAL);
	expect(response).toMatchObject({ specPath: fixture.paths[1], statePath: fixture.paths[0], carrierPath: fixture.paths[3] });
	expect(response.graphId).toBeTruthy();
	expect(entry.tracked).toHaveLength(1);
	expect(entry.tracked[0]?.task.upliftedPrompt).toContain(marker);
	expect(entry.tracked[0]?.task.upliftedPrompt).toContain(ORIGINAL);
	for (const stage of ["track", "state"])
		expect(entry.events.filter((event) => event.type === "stage" && event.stage === stage && event.phase === "start")).toHaveLength(1);
	const record = readSession(fixture.stateDir, "s1");
	expect(record?.result).toMatchObject({ original: PROMPT, root: "BUILD_PROMPT", source: "llm" });
	expect(record?.result.xml).toContain(marker);
	expect(readLast(fixture.stateDir)).toEqual(record);
	expect(JSON.parse(readFileSync(fixture.paths[3]!, "utf8"))).toMatchObject({
		host: "omp", sessionId: "s1", specPath: response.specPath, statePath: response.statePath,
		graphId: response.graphId, context: response.context,
	});
	const saved = fixture.paths.map((path) => readFileSync(path, "utf8"));
	for (const content of saved) {
		expect(content).toContain(marker);
		expect(content).toContain(ORIGINAL);
	}
	return saved;
}

describe("control-aware shunt flight identity (SEC15-DELTA-SHUNT-INTENT-CONTROLS)", () => {
	for (const input of ["direct", "merged"] as const) {
		test.each(CONTROL_ALIASES)(`${input} %s invalidates a pending final-completion/evidence flight before stale UI, aside, tracker, state and carrier`, async (_name, alias) => {
			const fixture = pipeline("SHUNT_A", input);
			try {
				expect(await fixture.run()).toEqual(PENDING);
				const old = fixture.runs[0]!;
				await old.uplifted.promise;
				expect(fixture.calls).toEqual([{ path: "/v1/messages", model: "SHUNT_A", user: `<user_request>\n${PROMPT}\n</user_request>` }]);
				expect(old.events).toContainEqual(expect.objectContaining({ type: "stage", stage: "uplift", phase: "end", ok: true }));
				expect(old.signal.aborted).toBe(false);
				expect(old.evidenceSignal?.aborted).toBe(false);
				expect(old.tracked).toEqual([]);
				expect(existsSync(fixture.stateDir)).toBe(false);

				// No lifecycle/model/prompt change: validity alone must change the captured intent.
				fixture.setAlias(alias);
				expect(await fixture.run()).toBeUndefined();
				expect(fixture.runs).toHaveLength(2);
				const invalid = fixture.runs[1]!;
				expect(invalid.request).toMatchObject({ prompt: old.request.prompt, sessionId: old.request.sessionId, cwd: old.request.cwd, model: old.request.model });
				expect(invalid.request.control).toEqual(old.request.control);
				expect(invalid.request.config).toEqual({ ...old.request.config!, grok: { ...old.request.config!.grok, shuntModel: alias } });
				expectInvalid(invalid, await invalid.completed.promise);
				expect(old.signal.aborted).toBe(true);
				expect(old.evidenceSignal?.aborted).toBe(true);
				expect(old.request.isCurrent?.()).toBe(false);
				expect(await old.completed.promise).toMatchObject({ context: "", skipped: "aborted" });
				expect(old.events.filter((event) => event.type === "stage" && ["think", "clarify", "plan", "track", "state"].includes(event.stage))).toEqual([]);
				expect(old.tracked).toEqual([]);
				expect(fixture.calls).toHaveLength(1);
				for (const path of fixture.paths) expect(existsSync(path)).toBe(false);
				expect(fixture.sent).toEqual([]);
				expect(fixture.line()).toContain("selector-invalid");
				fixture.expectNoAuth();

				// Recover on the same submission, then release the obsolete evidence/end/delivery after every new sink exists.
				fixture.setAlias("SHUNT_A");
				expect(await fixture.run()).toEqual(PENDING);
				expect(fixture.runs).toHaveLength(3);
				const current = fixture.runs[2]!;
				await current.uplifted.promise;
				expect(current.signal.aborted).toBe(false);
				expect(current.request.isCurrent?.()).toBe(true);
				expect(fixture.calls.map((call) => call.model)).toEqual(["SHUNT_A", "SHUNT_A"]);
				current.evidence.resolve(EMPTY);
				const response = await current.completed.promise;
				const saved = expectSaved(fixture, current, response, "SHUNT_VALID_SPEC_2");
				for (const content of saved) expect(content).not.toContain("SHUNT_VALID_SPEC_1");
				current.delivery.resolve();
				await flush();
				expect(fixture.sent).toHaveLength(1);
				expect(fixture.sent).toMatchObject([{ message: { customType: "ultrathink-plan", content: response.context }, options: { deliverAs: "aside" } }]);
				const line = fixture.line();
				expect(line).toContain("BUILD_PROMPT");
				old.evidence.resolve(EMPTY);
				old.delivery.resolve();
				await flush();
				expect(fixture.line()).toBe(line);
				expect(fixture.paths.map((path) => readFileSync(path, "utf8"))).toEqual(saved);
				expect(old.tracked).toEqual([]);
				expect(current.tracked).toHaveLength(1);
				expect(fixture.sent).toHaveLength(1);
				expect(await fixture.run()).toBeUndefined();
				expect(fixture.runs).toHaveLength(3);
				expect(fixture.calls).toHaveLength(2);
				fixture.expectNoAuth();
			} finally {
				await fixture.close();
			}
		});

		test.each(CONTROL_ALIASES)(`${input} %s replaces a settled valid flight with selector-invalid without auth, inference or new writes`, async (_name, alias) => {
			const fixture = pipeline("SHUNT_A", input);
			try {
				expect(await fixture.run()).toEqual(PENDING);
				const valid = fixture.runs[0]!;
				await valid.uplifted.promise;
				valid.evidence.resolve(EMPTY);
				const response = await valid.completed.promise;
				const saved = expectSaved(fixture, valid, response, "SHUNT_VALID_SPEC_1");
				valid.delivery.resolve();
				await flush();
				expect(fixture.sent).toHaveLength(1);
				expect(await fixture.run()).toBeUndefined();
				expect(fixture.runs).toHaveLength(1);
				fixture.setAlias(alias);
				expect(await fixture.run()).toBeUndefined();
				expect(fixture.runs).toHaveLength(2);
				expectInvalid(fixture.runs[1]!, await fixture.runs[1]!.completed.promise);
				expect(valid.signal.aborted).toBe(true);
				expect(fixture.line()).toContain("selector-invalid");
				expect(fixture.paths.map((path) => readFileSync(path, "utf8"))).toEqual(saved);
				expect(fixture.calls.map((call) => call.model)).toEqual(["SHUNT_A"]);
				expect(fixture.sent).toHaveLength(1);
				expect(await fixture.run()).toBeUndefined();
				expect(fixture.runs).toHaveLength(2);
				fixture.expectNoAuth();
			} finally {
				await fixture.close();
			}
		});

		test.each(CONTROL_ALIASES)(`${input} %s recovers a settled invalid skip into the valid shared pipeline instead of reusing it`, async (_name, alias) => {
			const fixture = pipeline(alias, input);
			try {
				expect(await fixture.run()).toBeUndefined();
				const invalid = fixture.runs[0]!;
				expectInvalid(invalid, await invalid.completed.promise);
				expect(fixture.calls).toEqual([]);
				expect(existsSync(fixture.stateDir)).toBe(false);
				expect(fixture.line()).toContain("selector-invalid");
				expect(await fixture.run()).toBeUndefined();
				expect(fixture.runs).toHaveLength(1);
				fixture.expectNoAuth();
				fixture.setAlias("SHUNT_A");
				expect(await fixture.run()).toEqual(PENDING);
				expect(fixture.runs).toHaveLength(2);
				const current = fixture.runs[1]!;
				expect(invalid.signal.aborted).toBe(true);
				await current.uplifted.promise;
				expect(fixture.calls.map((call) => call.model)).toEqual(["SHUNT_A"]);
				expect(current.signal.aborted).toBe(false);
				current.evidence.resolve(EMPTY);
				const response = await current.completed.promise;
				expectSaved(fixture, current, response, "SHUNT_VALID_SPEC_1");
				expect(response.modelResolution).toMatchObject({ state: "override", source: "shunt-model", modelId: "SHUNT_A", reason: "explicit-model" });
				current.delivery.resolve();
				await flush();
				expect(fixture.sent).toHaveLength(1);
				expect(fixture.sent).toMatchObject([{ message: { content: response.context }, options: { deliverAs: "aside" } }]);
				expect(fixture.line()).toContain("BUILD_PROMPT");
				expect(fixture.line()).not.toContain("selector-invalid");
				expect(await fixture.run()).toBeUndefined();
				expect(fixture.runs).toHaveLength(2);
				fixture.expectNoAuth();
			} finally {
				await fixture.close();
			}
		});

		for (const [name, initial, aliases, wire, source] of [
			["plain surrounding spaces", "SHUNT_A", [" SHUNT_A", "SHUNT_A ", "  SHUNT_A  "], "SHUNT_A", "shunt-model"],
			["whitespace-only absence", "", [" ", "\t \r\n\v\f", "\u00a0"], "ENGINE_PIN", "engine-model"],
		] as const) {
			test(`${input} ${name} stays equivalent for pending and settled reentry`, async () => {
				const fixture = pipeline(initial, input);
				try {
					expect(await fixture.run()).toEqual(PENDING);
					const current = fixture.runs[0]!;
					await current.uplifted.promise;
					for (const alias of aliases) {
						fixture.setAlias(alias);
						expect(await fixture.run()).toEqual(PENDING);
					}
					expect(fixture.runs).toHaveLength(1);
					expect(current.signal.aborted).toBe(false);
					expect(fixture.calls.map((call) => call.model)).toEqual([wire]);
					current.evidence.resolve(EMPTY);
					const response = await current.completed.promise;
					expectSaved(fixture, current, response, "SHUNT_VALID_SPEC_1");
					expect(response.modelResolution).toMatchObject({ source, modelId: wire });
					current.delivery.resolve();
					await flush();
					for (const alias of aliases) {
						fixture.setAlias(alias);
						expect(await fixture.run()).toBeUndefined();
					}
					expect(fixture.runs).toHaveLength(1);
					expect(fixture.calls).toHaveLength(1);
					expect(fixture.sent).toHaveLength(1);
					fixture.expectNoAuth();
				} finally {
					await fixture.close();
				}
			});
		}
	}

	test("shared selector normalization retains control-invalid strings, unknown-type guards, blank clears and lower Grok pins (AD-1)", () => {
		const lower = mergeConfig({
			claude: { model: "ClaudePin" }, muse: { model: "MusePin" }, grok: { model: "GrokPin", shuntModel: "ShuntPin" },
			models: { hosts: { omp: { provider: "ProviderPin", model: "HostPin" } }, providerDefaults: { xai: "ProviderDefaultPin" } },
		}, quietConfig());
		for (const [, alias] of CONTROL_ALIASES) {
			expect(normalizeSelectorField(alias)).toBe(alias);
			expect(mergeConfig({ grok: { shuntModel: alias } }, lower).grok.shuntModel).toBe(alias);
		}
		expect(normalizeSelectorField(" SHUNT_A ")).toBe("SHUNT_A");
		for (const model of ["", "  ", "\t \r\n\v\f", "\u00a0"]) {
			expect(normalizeSelectorField(model)).toBe("");
			const config = mergeConfig({ claude: { model }, muse: { model }, grok: { model, shuntModel: model },
				models: { hosts: { omp: { provider: model, model } }, providerDefaults: { xai: model } },
			}, lower);
			expect([config.claude.model, config.muse.model, config.grok.model, config.grok.shuntModel]).toEqual(["", "", "GrokPin", "ShuntPin"]);
			expect(config.modelProvenance).toEqual({ claude: "explicit-blank", muse: "explicit-blank", grok: "file-pin" });
			expect(config.models.hosts.omp).toEqual({ provider: "", model: "" });
			expect(Object.hasOwn(config.models.providerDefaults, "xai")).toBe(false);
		}
		for (const model of [undefined, null, 7, false, {}, []]) {
			const config = mergeConfig({ claude: { model }, muse: { model }, grok: { model, shuntModel: model },
				models: { hosts: { omp: { provider: model, model } }, providerDefaults: { xai: model } },
			}, lower);
			expect([config.claude.model, config.muse.model, config.grok.model, config.grok.shuntModel]).toEqual(["ClaudePin", "MusePin", "GrokPin", "ShuntPin"]);
			expect(config.modelProvenance).toEqual(lower.modelProvenance);
			expect(config.models).toEqual(lower.models);
		}
	});
});
