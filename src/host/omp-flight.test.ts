// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage, Effort } from "@oh-my-pi/pi-ai";
import { readSession } from "../claude/state.ts";
import type { GroundOutcome } from "../ragflow/types.ts";
import { createNativeEngineSelector, NO_PLAN } from "./omp.ts";
import type { OmpPlan, OmpPlanRequest } from "./omp.ts";
import type { ModelResolution } from "./engine.ts";
import { fakeModel, fakeRuntime, flush, isolatedPlanEnv, quietConfig, recorder, reply, runChildLifetimeScenario, setup, stageAnswer, tuiCtx, userText } from "./omp-test.helpers.ts";
import type { OmpTestHarness } from "./omp-test.helpers.ts";
import { planPrompt } from "./plan.ts";
import type { PlanResponse } from "./plan.ts";
import type { ProgressEvent } from "./progress.ts";

describe("flight lifecycle (D-12)", () => {
	const PENDING_RESULT = { message: expect.objectContaining({ customType: "ultrathink-pending" }) };
	const aside = (content: string) => ({ message: { customType: "ultrathink-plan", content, display: true, attribution: "agent" }, options: { deliverAs: "aside" } });

	/** A planner whose every flight waits on its own gate and keeps its request and lifetime. */
	function gated() {
		const runs: Array<{ request: OmpPlanRequest; signal: AbortSignal; gate: PromiseWithResolvers<string> }> = [];
		const plan = (request: OmpPlanRequest, signal: AbortSignal) => {
			const gate = Promise.withResolvers<string>();
			runs.push({ request, signal, gate });
			return gate.promise;
		};
		return { plan, runs };
	}

	test("the inline race only defers delivery: the flight keeps running and its plan lands as an aside", async () => {
		const planner = gated();
		const { run, sent } = setup(planner.plan, 1);
		expect(await run()).toEqual(PENDING_RESULT);
		expect(planner.runs[0]?.signal.aborted).toBe(false);
		planner.runs[0]?.gate.resolve("PLAN");
		await flush();
		expect(sent).toEqual([aside("PLAN")]);
		expect(planner.runs[0]?.signal.aborted).toBe(false);
	});

	test("the deadline releases a deferred prompt even when the native completer never settles", async () => {
		const live = fakeModel("acme", "sol-1");
		const { runtime } = fakeRuntime([live]);
		const never = Promise.withResolvers<AssistantMessage>();
		const rec = recorder(() => never.promise);
		const stopped = Promise.withResolvers<void>();
		let request: OmpPlanRequest | undefined;
		let signal: AbortSignal | undefined;
		const { run, sent } = setup(
			async (flightRequest, flightSignal) => {
				request = flightRequest;
				signal = flightSignal;
				flightSignal.addEventListener("abort", () => stopped.resolve(), { once: true });
				const selected = await createNativeEngineSelector(flightRequest, flightSignal, {
					completeSimple: rec.complete,
					providerDefaults: {},
					...(flightRequest.isCurrent ? { isCurrent: flightRequest.isCurrent } : {}),
				})({
					host: "omp",
					override: { provider: "", model: "" },
					providerDefaults: {},
					engineSelection: { engine: "auto", source: "config", nativeOptOut: false },
				}, flightSignal);
				if ("skipped" in selected) throw new Error(`unexpected skip: ${selected.skipped}`);
				return { context: await selected.complete("SYSTEM", "USER", flightSignal) };
			},
			1,
			{ maxRunMs: 20 },
			{ model: live, ...runtime },
		);
		expect(await run()).toEqual(PENDING_RESULT);
		expect(rec.calls).toHaveLength(1);
		await stopped.promise;
		await flush();
		expect(signal?.aborted).toBe(true);
		expect(request?.isCurrent?.()).toBe(false);
		expect(sent).toEqual([aside(NO_PLAN)]);
		expect(await run()).toBeUndefined();
		expect(rec.calls).toHaveLength(1);
		expect(sent).toEqual([aside(NO_PLAN)]);
	}, 1_000);

	test("deadline delivery and timeout state ignore synchronous abort progress, late progress and a late plan", async () => {
		const t = tuiCtx();
		const gate = Promise.withResolvers<OmpPlan>();
		const stopped = Promise.withResolvers<void>();
		let progress: ((event: ProgressEvent) => void) | undefined;
		const { run, sent, emit } = setup(
			(_request, signal, onEvent) => {
				progress = onEvent;
				onEvent?.({ type: "begin", at: 1, sessionId: "s1", engine: "initial" });
				signal.addEventListener("abort", () => {
					onEvent?.({ type: "end", at: 2, outcome: "planned" });
					stopped.resolve();
				}, { once: true });
				return gate.promise;
			},
			1,
			{ maxRunMs: 20, now: () => 5_000 },
			t.ctx,
		);
		emit("session_start");
		expect(await run()).toEqual(PENDING_RESULT);
		const pendingLine = t.line();
		await stopped.promise;
		await flush();
		expect(sent).toEqual([aside(NO_PLAN)]);
		const timeoutLine = t.line();
		expect(timeoutLine).not.toBe(pendingLine);
		progress?.({ type: "begin", at: 3, sessionId: "s1", engine: "late" });
		progress?.({ type: "stage", at: 4, stage: "think", phase: "start" });
		progress?.({ type: "end", at: 5, outcome: "planned" });
		gate.resolve({ context: "LATE PLAN" });
		await flush();
		expect(t.line()).toBe(timeoutLine);
		expect(sent).toEqual([aside(NO_PLAN)]);
		expect(await run()).toBeUndefined();
	}, 1_000);

	test("a deadline before the inline race returns one no-plan result without waiting for the planner", async () => {
		const planner = gated();
		const { run, sent } = setup(planner.plan, 500, { maxRunMs: 5 });
		expect(await run()).toEqual({ message: aside(NO_PLAN).message });
		expect(planner.runs[0]?.signal.aborted).toBe(true);
		expect(planner.runs[0]?.request.isCurrent?.()).toBe(false);
		expect(await run()).toBeUndefined();
		planner.runs[0]?.gate.resolve("LATE PLAN");
		await flush();
		expect(sent).toEqual([]);
		expect(planner.runs).toHaveLength(1);
	}, 1_000);

	test("a superseded noncooperative flight cannot send a no-plan note at its deadline", async () => {
		const planner = gated();
		const { run, sent } = setup(planner.plan, 1, { maxRunMs: 20 });
		expect(await run("A")).toEqual(PENDING_RESULT);
		expect(await run("B")).toEqual(PENDING_RESULT);
		expect(planner.runs[0]?.signal.aborted).toBe(true);
		const current = planner.runs[1]!;
		// The newer flight's deadline follows the old one, without a sleep or polling loop.
		if (!current.signal.aborted) await new Promise<void>((resolve) => current.signal.addEventListener("abort", () => resolve(), { once: true }));
		await flush();
		expect(sent).toEqual([aside(NO_PLAN)]);
		for (const entry of planner.runs) entry.gate.resolve(`LATE ${entry.request.prompt}`);
		await flush();
		expect(sent).toEqual([aside(NO_PLAN)]);
	}, 1_000);

	test("a newer prompt cancels the superseded flight; its late plan is dropped", async () => {
		const planner = gated();
		const { run, sent, emit } = setup(planner.plan, 1);
		await run("A");
		emit("turn_start");
		await run("B");
		expect(planner.runs.map((entry) => [entry.request.prompt, entry.signal.aborted])).toEqual([
			["A", true],
			["B", false],
		]);
		planner.runs[0]?.gate.resolve("PLAN A");
		await flush();
		expect(sent).toEqual([]);
		planner.runs[1]?.gate.resolve("PLAN B");
		await flush();
		expect(sent).toEqual([aside("PLAN B")]);
	});

	test("same-prompt reentry on an unchanged target reuses the one flight, even through a fresh but equal Model object", async () => {
		let live = fakeModel("acme", "sol-1");
		const { runtime } = fakeRuntime([live], { current: () => live });
		const planner = gated();
		const { run } = setup(planner.plan, 1, {}, { ...runtime });
		expect(await run()).toEqual(PENDING_RESULT);
		live = { ...live };
		expect(await run()).toEqual(PENDING_RESULT);
		expect(planner.runs).toHaveLength(1);
		expect(planner.runs[0]?.signal.aborted).toBe(false);
	});

	for (const [before, after] of [["low" as Effort, "high" as Effort], ["off", undefined], [undefined, "low" as Effort]] as const) {
		test(`thinking-level reentry ${before} to ${after} cancels and suppresses the old flight`, async () => {
			let level: OmpPlanRequest["thinkingLevel"] = before;
			const planner = gated();
			const { run, sent } = setup(planner.plan, 1, {}, {}, { getThinkingLevel: () => level });
			expect(await run()).toEqual(PENDING_RESULT);
			expect(await run()).toEqual(PENDING_RESULT);
			expect(planner.runs).toHaveLength(1);
			expect(planner.runs[0]?.request.thinkingLevel).toBe(before);
			level = after;
			expect(await run()).toEqual(PENDING_RESULT);
			expect(planner.runs).toHaveLength(2);
			expect(planner.runs[0]?.request.thinkingLevel).toBe(before);
			expect(planner.runs[0]?.signal.aborted).toBe(true);
			expect(planner.runs[0]?.request.isCurrent?.()).toBe(false);
			expect(planner.runs[1]?.request.thinkingLevel).toBe(after);
			expect(planner.runs[1]?.signal.aborted).toBe(false);
			planner.runs[0]?.gate.resolve("OLD EFFORT PLAN");
			await flush();
			expect(sent).toEqual([]);
			planner.runs[1]?.gate.resolve("NEW EFFORT PLAN");
			await flush();
			expect(sent).toEqual([aside("NEW EFFORT PLAN")]);
		});
	}

	test("a changed thinking level invalidates a settled inline plan", async () => {
		let level = "low" as Effort;
		const requests: OmpPlanRequest[] = [];
		const { run, sent } = setup(
			async (request) => {
				requests.push(request);
				return `PLAN ${request.thinkingLevel}`;
			},
			1_000,
			{},
			{},
			{ getThinkingLevel: () => level },
		);
		expect(await run()).toMatchObject({ message: { content: "PLAN low" } });
		expect(await run()).toMatchObject({ message: { content: "PLAN low" } });
		level = "high" as Effort;
		expect(await run()).toMatchObject({ message: { content: "PLAN high" } });
		expect(requests.map((request) => request.thinkingLevel)).toEqual(["low" as Effort, "high" as Effort]);
		expect(sent).toEqual([]);
	});

	test("same-prompt reentry after a model switch cancels and suppresses the old flight and plans on the new model", async () => {
		let live = fakeModel("acme", "sol-1");
		const { runtime } = fakeRuntime([], { current: () => live });
		const planner = gated();
		const { run, sent } = setup(planner.plan, 1, {}, { ...runtime });
		await run();
		live = fakeModel("anthropic", "opus-x");
		expect(await run()).toEqual(PENDING_RESULT);
		expect(planner.runs.map((entry) => [entry.request.model?.provider, entry.signal.aborted])).toEqual([
			["acme", true],
			["anthropic", false],
		]);
		planner.runs[0]?.gate.resolve("OLD PLAN");
		await flush();
		expect(sent).toEqual([]);
		planner.runs[1]?.gate.resolve("NEW PLAN");
		await flush();
		expect(sent).toEqual([aside("NEW PLAN")]);
	});

	test("the whole Model counts: the same id behind another endpoint or header resolver is another target", async () => {
		let live = fakeModel("acme", "sol-1");
		const { runtime } = fakeRuntime([], { current: () => live });
		const planner = gated();
		const { run } = setup(planner.plan, 1, {}, { ...runtime });
		await run();
		live = { ...live, baseUrl: "https://SECRET-OTHER.invalid/v1" };
		await run();
		expect(planner.runs).toHaveLength(2);
		live = { ...live, resolveHeaders: async () => ({}) };
		await run();
		expect(planner.runs).toHaveLength(3);
		expect(planner.runs.map((entry) => entry.signal.aborted)).toEqual([true, true, false]);
	});

	test("a model switch seen at delivery suppresses both the plan and the no-plan note", async () => {
		for (const answer of ["PLAN", ""]) {
			let live = fakeModel("acme", "sol-1");
			const { runtime } = fakeRuntime([], { current: () => live });
			const planner = gated();
			const { run, sent } = setup(planner.plan, 1, {}, { ...runtime });
			await run();
			live = fakeModel("acme", "sol-2");
			planner.runs[0]?.gate.resolve(answer);
			await flush();
			expect(sent).toEqual([]);
			expect(planner.runs[0]?.signal.aborted).toBe(true);
		}
	});

	test("a changed native override replans the same prompt", async () => {
		let override = { provider: "", model: "" };
		const planner = gated();
		const { run } = setup(planner.plan, 1, {
			config: () =>
				quietConfig((config) => {
					config.models.hosts.omp = override;
				}),
		});
		await run();
		await run();
		expect(planner.runs).toHaveLength(1);
		override = { provider: "acme", model: "opus" };
		await run();
		expect(planner.runs).toHaveLength(2);
		expect(planner.runs[0]?.signal.aborted).toBe(true);
		expect(planner.runs[1]?.request.config?.models.hosts.omp).toEqual(override);
	});

	test("an alias the flight resolved is revalidated at reentry: a new target replans", async () => {
		const live = fakeModel("acme", "sol-1");
		let slow = fakeModel("acme", "slow-1");
		const { runtime } = fakeRuntime([live], { current: () => live, aliases: { "@slow": () => slow } });
		const signals: AbortSignal[] = [];
		const gate = Promise.withResolvers<string>();
		const { run } = setup(
			(request, signal) => {
				request.native?.models.resolve("@slow");
				signals.push(signal);
				return gate.promise;
			},
			1,
			{},
			{ ...runtime },
		);
		await run();
		await run();
		expect(signals).toHaveLength(1);
		slow = fakeModel("acme", "slow-2");
		await run();
		expect(signals).toHaveLength(2);
		expect(signals[0]?.aborted).toBe(true);
	});

	test("session switch and shutdown cancel the in-flight flight; nothing is delivered", async () => {
		for (const event of ["session_switch", "session_shutdown"]) {
			const planner = gated();
			const { run, sent, emit } = setup(planner.plan, 1);
			await run();
			emit(event);
			expect(planner.runs[0]?.signal.aborted).toBe(true);
			planner.runs[0]?.gate.resolve("PLAN");
			await flush();
			expect(sent).toEqual([]);
		}
	});

	test("the flight is registered before the planner's first callback", async () => {
		const t = tuiCtx();
		const { run, emit } = setup(
			async (_request, _signal, onEvent) => {
				onEvent?.({ type: "end", at: 1, outcome: "skipped", detail: "sync-detail" });
				return "";
			},
			1_000,
			{},
			t.ctx,
		);
		emit("session_start");
		expect(await run()).toBeUndefined();
		await flush();
		expect(t.line()).toContain("skipped · sync-detail");
	});

	test("isCurrent is the flight's validity: false once its live model changes or a newer prompt replaces it", async () => {
		let live = fakeModel("acme", "sol-1");
		const { runtime } = fakeRuntime([], { current: () => live });
		const planner = gated();
		const { run, emit } = setup(planner.plan, 1, {}, { ...runtime });
		await run("A");
		const first = planner.runs[0]?.request.isCurrent;
		expect(first?.()).toBe(true);
		live = fakeModel("acme", "sol-2");
		expect(first?.()).toBe(false);
		expect(planner.runs[0]?.signal.aborted).toBe(true);
		emit("turn_start");
		await run("B");
		const second = planner.runs[1]?.request.isCurrent;
		expect(second?.()).toBe(true);
		emit("turn_start");
		await run("C");
		expect(second?.()).toBe(false);
	});

	for (const event of ["agent_start", "agent_end", "turn_start", "turn_end", "tool_execution_start", "tool_execution_end"] as const) {
		for (const change of ["model", "session", "unchanged"] as const) {
			test(`${event} observes ${change} during an uplift-only flight paused on evidence after its final completion (REV15-006)`, async () => {
				const root = mkdtempSync(join(tmpdir(), "ut-omp-observe-"));
				const stateDir = join(root, "state");
				const live = fakeModel("acme", "sol-1");
				const { runtime } = fakeRuntime([live], { current: () => live });
				const config = quietConfig((value) => {
					value.think.enabled = value.hitl.enabled = false;
					value.track.enabled = true;
					value.linear.team = "Team";
				});
				const lookup = Promise.withResolvers<GroundOutcome>();
				const uplifted = Promise.withResolvers<void>();
				const completed = Promise.withResolvers<PlanResponse>();
				const empty: GroundOutcome = { status: "none", chunks: [], chars: 0, ms: 0, datasets: 0 };
				const rec = recorder((call) => reply([{ type: "text", text: stageAnswer(userText(call)).text }]));
				let lifetime: AbortSignal | undefined;
				let lookupSignal: AbortSignal | undefined;
				let tracks = 0;
				let level = "low" as Effort;
				let levelReads = 0;
				const events: ProgressEvent[] = [];
				const { run, emit, sent } = setup(async (request, signal, onEvent) => {
					lifetime = signal;
					const response = await planPrompt(
						{ host: "omp", session_id: request.sessionId, prompt: request.prompt, cwd: request.cwd },
						isolatedPlanEnv(root),
						{
							config: request.config!, control: request.control!, stateDir, signal,
							native: createNativeEngineSelector(request, signal, { completeSimple: rec.complete, providerDefaults: {}, isCurrent: request.isCurrent! }),
							ground: ({ signal: evidenceSignal }) => { lookupSignal = evidenceSignal; return lookup.promise; },
							createTracker: () => async () => { tracks++; return undefined; },
							progress: (entry) => {
								events.push(entry);
								onEvent?.(entry);
								if (entry.type === "stage" && entry.stage === "uplift" && entry.phase === "end") uplifted.resolve();
							},
						},
					);
					completed.resolve(response);
					return response;
				}, 1, { stateDir, config: () => config }, { cwd: root, model: live, ...runtime }, {
					getThinkingLevel: () => { levelReads++; return level; },
				});
				try {
					expect(await run("add a widget")).toEqual(PENDING_RESULT);
					await uplifted.promise;
					expect(rec.calls).toHaveLength(1);
					expect(lookupSignal?.aborted).toBe(false);
					expect(tracks).toBe(0);
					expect(existsSync(stateDir)).toBe(false);
					// A real lifecycle observation has a fresh context; its Model beats the older runtime.current().
					// Thinking is intentionally changed too: AD-5 observes that setting only at reentry.
					level = "high" as Effort;
					emit(event, {}, {
						cwd: root, ...runtime,
						model: change === "model" ? fakeModel("acme", "sol-2") : { ...live },
						sessionManager: { getSessionId: () => change === "session" ? "s2" : "s1" },
					});
					const abortedAtObservation = lifetime?.aborted;
					const lookupAbortedAtObservation = lookupSignal?.aborted;
					lookup.resolve(empty);
					const response = await completed.promise;
					await flush();
					const invalid = change !== "unchanged";
					expect(tracks).toBe(invalid ? 0 : 1);
					expect(abortedAtObservation).toBe(invalid);
					expect(lookupAbortedAtObservation).toBe(invalid);
					expect(levelReads).toBe(1);
					expect(rec.calls).toHaveLength(1);
					for (const path of ["sessions/s1.json", "sessions/s1.xml", "last.json", "last-plan.json"])
						expect(existsSync(join(stateDir, path))).toBe(!invalid);
					if (invalid) {
						expect(response).toMatchObject({ context: "", skipped: "aborted" });
						expect(events.filter((entry) => entry.type === "stage" && (entry.stage === "track" || entry.stage === "state"))).toEqual([]);
						expect(sent).toEqual([]);
					} else {
						expect(response.skipped).toBeUndefined();
						expect(response.context).toContain("<BUILD_PROMPT>");
						expect(readSession(stateDir, "s1")?.modelResolution?.modelId).toBe("sol-1");
						expect(sent).toMatchObject([{ message: { content: response.context, customType: "ultrathink-plan" }, options: { deliverAs: "aside" } }]);
					}
				} finally {
					lookup.resolve(empty);
					emit("session_shutdown");
					rmSync(root, { recursive: true, force: true });
				}
			});
		}
	}
	// Phase 27: unbounded default lifetime. The elapsed proof lives in the child scenario; the matrix
	// here pins cancellation release, handoff ordering, and positive-deadline compatibility.

	/** A stale-but-wellformed selection record for late-resolution delivery suppression. */
	const STALE_RESOLUTION: ModelResolution = {
		version: "1.0.0",
		state: "detected",
		host: "omp",
		transport: "omp-native",
		source: "ctx.model",
		reason: "live-model",
		engineSelection: { engine: "auto", source: "config", nativeOptOut: false },
		api: "acme-chat",
		provider: "acme",
		modelId: "stale-9",
		modelKnown: true,
		label: "omp-native:acme/stale-9 [detected]",
	};

	/** Drains microtasks until the gated planner records its first run. */
	async function untilStarted(planner: { runs: unknown[] }): Promise<void> {
		for (let i = 0; i < 200 && planner.runs.length === 0; i++) await Promise.resolve();
		expect(planner.runs.length).toBeGreaterThan(0);
	}

	test("unbounded omitted outer survives fired 600001ms with one real plan aside", async () => {
		expect(await runChildLifetimeScenario({ cancelHung: false })).toEqual({ planAsides: 1, nativeCalls: 8 });
	}, 120_000);
	const OUTER_CASES: Array<{ name: string; extra: { maxRunMs?: number } }> = [
		{ name: "omitted", extra: {} },
		{ name: "zero", extra: { maxRunMs: 0 } },
	];

	for (const outer of OUTER_CASES) {
		test(`cancel-matrix pre-handoff triggers release silently (${outer.name} outer)`, async () => {
			// Newer prompt as a new turn.
			{
				const planner = gated();
				const h = setup(planner.plan, 1_000, outer.extra, {}, {}, true);
				const startedAt = Date.now();
				const oldPromise = h.run("A");
				await untilStarted(planner);
				let oldGateSettled = false;
				void planner.runs[0]?.gate.promise.then(() => { oldGateSettled = true; });
				h.emit("turn_start");
				const nextPromise = h.run("B");
				expect(await oldPromise).toBeUndefined();
				expect(Date.now() - startedAt).toBeLessThan(10_000);
				expect(oldGateSettled).toBe(false);
				expect(planner.runs[0]?.signal.aborted).toBe(true);
				expect(planner.runs[0]?.request.isCurrent?.()).toBe(false);
				expect(planner.runs.map((entry) => entry.request.prompt)).toEqual(["A", "B"]);
				expect(planner.runs[1]?.signal.aborted).toBe(false);
				expect(h.sent).toEqual([]);
				h.emit("session_shutdown");
				expect(await nextPromise).toBeUndefined();
				await flush();
			}
			// Identical resend as a new turn still supersedes.
			{
				const planner = gated();
				const h = setup(planner.plan, 1_000, outer.extra, {}, {}, true);
				const oldPromise = h.run("A");
				await untilStarted(planner);
				let oldGateSettled = false;
				void planner.runs[0]?.gate.promise.then(() => { oldGateSettled = true; });
				h.emit("turn_start");
				const nextPromise = h.run("A");
				expect(await oldPromise).toBeUndefined();
				expect(oldGateSettled).toBe(false);
				expect(planner.runs).toHaveLength(2);
				expect(planner.runs[0]?.signal.aborted).toBe(true);
				expect(planner.runs[1]?.signal.aborted).toBe(false);
				expect(h.sent).toEqual([]);
				h.emit("session_shutdown");
				expect(await nextPromise).toBeUndefined();
				await flush();
			}
			// Accepted quick message: arming alone cancels nothing, the matching run does.
			{
				const planner = gated();
				const h = setup(planner.plan, 1_000, outer.extra, {}, {}, true);
				const oldPromise = h.run("hello");
				await untilStarted(planner);
				let oldGateSettled = false;
				void planner.runs[0]?.gate.promise.then(() => { oldGateSettled = true; });
				h.command("ultrathink-quick", "hello");
				expect(h.userMessages).toEqual(["hello"]);
				expect(planner.runs[0]?.signal.aborted).toBe(false);
				h.emit("turn_start");
				expect(await h.run("hello")).toBeUndefined();
				expect(planner.runs[0]?.signal.aborted).toBe(true);
				expect(await oldPromise).toBeUndefined();
				expect(oldGateSettled).toBe(false);
				expect(h.sent).toEqual([]);
				h.emit("session_shutdown");
				await flush();
			}
			// Whole-model, endpoint, and header-resolver identity changes.
			for (const label of ["whole-model", "endpoint", "header-resolver"] as const) {
				let live = fakeModel("acme", "sol-1");
				const { runtime } = fakeRuntime([], { current: () => live });
				const planner = gated();
				const h = setup(planner.plan, 1_000, outer.extra, { ...runtime }, {}, true);
				const oldPromise = h.run();
				await untilStarted(planner);
				let oldGateSettled = false;
				void planner.runs[0]?.gate.promise.then(() => { oldGateSettled = true; });
				live = label === "whole-model" ? fakeModel("acme", "sol-2") : { ...live, baseUrl: "https://SECRET-OTHER.invalid/v1" };
				if (label === "header-resolver") live = { ...live, resolveHeaders: async () => ({}) };
				const nextPromise = h.run();
				expect(await oldPromise).toBeUndefined();
				expect(oldGateSettled).toBe(false);
				expect(planner.runs[0]?.signal.aborted).toBe(true);
				expect(planner.runs).toHaveLength(2);
				expect(planner.runs[1]?.signal.aborted).toBe(false);
				expect(h.sent).toEqual([]);
				h.emit("session_shutdown");
				expect(await nextPromise).toBeUndefined();
				await flush();
			}
			// Thinking-level change.
			{
			let level: OmpPlanRequest["thinkingLevel"] = "low" as Effort;
				const planner = gated();
				const h = setup(planner.plan, 1_000, outer.extra, {}, { getThinkingLevel: () => level }, true);
				const oldPromise = h.run();
				await untilStarted(planner);
				let oldGateSettled = false;
				void planner.runs[0]?.gate.promise.then(() => { oldGateSettled = true; });
				level = "high" as Effort;
				const nextPromise = h.run();
				expect(await oldPromise).toBeUndefined();
				expect(oldGateSettled).toBe(false);
				expect(planner.runs).toHaveLength(2);
				expect(planner.runs[0]?.signal.aborted).toBe(true);
				expect(h.sent).toEqual([]);
				h.emit("session_shutdown");
				expect(await nextPromise).toBeUndefined();
				await flush();
			}
			// Native override change.
			{
				let override = { provider: "", model: "" };
				const planner = gated();
				const h = setup(planner.plan, 1_000, { ...outer.extra, config: () => quietConfig((config) => { config.models.hosts.omp = override; }) }, {}, {}, true);
				const oldPromise = h.run();
				await untilStarted(planner);
				let oldGateSettled = false;
				void planner.runs[0]?.gate.promise.then(() => { oldGateSettled = true; });
				override = { provider: "acme", model: "opus" };
				const nextPromise = h.run();
				expect(await oldPromise).toBeUndefined();
				expect(oldGateSettled).toBe(false);
				expect(planner.runs).toHaveLength(2);
				expect(planner.runs[0]?.signal.aborted).toBe(true);
				expect(planner.runs[1]?.request.config?.models.hosts.omp).toEqual(override);
				expect(h.sent).toEqual([]);
				h.emit("session_shutdown");
				expect(await nextPromise).toBeUndefined();
				await flush();
			}
			// Effective engine intent change from auto to a named engine.
			{
				let engine: "auto" | "claude" = "auto";
				const planner = gated();
				const h = setup(planner.plan, 1_000, { ...outer.extra, config: () => quietConfig((config) => { config.think.engine = engine; }) }, {}, {}, true);
				const oldPromise = h.run();
				await untilStarted(planner);
				let oldGateSettled = false;
				void planner.runs[0]?.gate.promise.then(() => { oldGateSettled = true; });
				engine = "claude";
				const nextPromise = h.run();
				expect(await oldPromise).toBeUndefined();
				expect(oldGateSettled).toBe(false);
				expect(planner.runs).toHaveLength(2);
				expect(planner.runs[0]?.signal.aborted).toBe(true);
				expect(h.sent).toEqual([]);
				h.emit("session_shutdown");
				expect(await nextPromise).toBeUndefined();
				await flush();
			}
			// Named legacy target change under a named engine.
			{
				let model = "m1";
				const planner = gated();
				const h = setup(planner.plan, 1_000, { ...outer.extra, config: () => quietConfig((config) => { config.think.engine = "claude"; config.claude.model = model; }) }, {}, {}, true);
				const oldPromise = h.run();
				await untilStarted(planner);
				let oldGateSettled = false;
				void planner.runs[0]?.gate.promise.then(() => { oldGateSettled = true; });
				model = "m2";
				const nextPromise = h.run();
				expect(await oldPromise).toBeUndefined();
				expect(oldGateSettled).toBe(false);
				expect(planner.runs).toHaveLength(2);
				expect(planner.runs[0]?.signal.aborted).toBe(true);
				expect(h.sent).toEqual([]);
				h.emit("session_shutdown");
				expect(await nextPromise).toBeUndefined();
				await flush();
			}
			// Resolved alias target change.
			{
				const live = fakeModel("acme", "sol-1");
				let slow = fakeModel("acme", "slow-1");
				const { runtime } = fakeRuntime([live], { current: () => live, aliases: { "@slow": () => slow } });
				const signals: AbortSignal[] = [];
				let calls = 0;
				const gate = Promise.withResolvers<string>();
				const h = setup((request, signal) => {
					signals.push(signal);
					calls++;
					request.native?.models.resolve("@slow");
					return gate.promise;
				}, 1_000, outer.extra, { ...runtime }, {}, true);
				const oldPromise = h.run();
				for (let i = 0; i < 200 && calls === 0; i++) await Promise.resolve();
				expect(calls).toBe(1);
				let oldGateSettled = false;
				void gate.promise.then(() => { oldGateSettled = true; });
				slow = fakeModel("acme", "slow-2");
				const nextPromise = h.run();
				expect(await oldPromise).toBeUndefined();
				expect(oldGateSettled).toBe(false);
				expect(calls).toBe(2);
				expect(signals[0]?.aborted).toBe(true);
				expect(signals[1]?.aborted).toBe(false);
				expect(h.sent).toEqual([]);
				h.emit("session_shutdown");
				expect(await nextPromise).toBeUndefined();
				await flush();
			}
			// Session switch and shutdown.
			for (const event of ["session_switch", "session_shutdown"] as const) {
				const planner = gated();
				const h = setup(planner.plan, 1_000, outer.extra, {}, {}, true);
				const oldPromise = h.run();
				await untilStarted(planner);
				let oldGateSettled = false;
				void planner.runs[0]?.gate.promise.then(() => { oldGateSettled = true; });
				h.emit(event);
				expect(await oldPromise).toBeUndefined();
				expect(oldGateSettled).toBe(false);
				expect(planner.runs[0]?.signal.aborted).toBe(true);
				expect(h.sent).toEqual([]);
				await flush();
			}
		}, 10_000);
	}
	for (const outer of OUTER_CASES) {
		test(`cancel-matrix post-handoff triggers suppress late effects (${outer.name} outer)`, async () => {
			// Newer prompt: the old pending flight stays silent while the successor delivers once.
			{
				const planner = gated();
				const h = setup(planner.plan, 10, outer.extra);
				expect(await h.run("A")).toEqual(PENDING_RESULT);
				expect(h.sent).toEqual([]);
				h.emit("turn_start");
				const nextPromise = h.run("B");
				await flush();
				expect(planner.runs[0]?.signal.aborted).toBe(true);
				planner.runs[0]?.gate.resolve("LATE A");
				await flush();
				expect(h.sent).toEqual([]);
				expect(await nextPromise).toEqual(PENDING_RESULT);
				planner.runs[1]?.gate.resolve("PLAN B");
				await flush();
				expect(h.sent).toEqual([aside("PLAN B")]);
				await flush();
				expect(h.sent).toEqual([aside("PLAN B")]);
				h.emit("session_shutdown");
				await flush();
			}
			// Accepted quick message after pending cancels the old flight with no delivery.
			{
				const planner = gated();
				const h = setup(planner.plan, 10, outer.extra);
				expect(await h.run("takeoff")).toEqual(PENDING_RESULT);
				h.command("ultrathink-quick", "takeoff");
				h.emit("turn_start");
				expect(await h.run("takeoff")).toBeUndefined();
				expect(planner.runs[0]?.signal.aborted).toBe(true);
				planner.runs[0]?.gate.resolve("LATE TAKEOFF");
				await flush();
				expect(h.sent).toEqual([]);
				h.emit("session_shutdown");
				await flush();
			}
			// Live-model switch after pending: late progress and the late plan stay silent while the successor delivers once.
			{
				let live = fakeModel("acme", "sol-1");
				const { runtime } = fakeRuntime([], { current: () => live });
				const seen: Array<((event: ProgressEvent) => void) | undefined> = [];
				const planner = gated();
				const h = setup((request, signal, onEvent) => { seen.push(onEvent); return planner.plan(request, signal); }, 10, outer.extra, { ...runtime });
				expect(await h.run()).toEqual(PENDING_RESULT);
				live = fakeModel("acme", "sol-2");
				const nextPromise = h.run();
				await flush();
				expect(planner.runs[0]?.signal.aborted).toBe(true);
				expect(seen).toHaveLength(2);
				seen[0]?.({ type: "begin", at: 3, sessionId: "s1", engine: "late", modelResolution: STALE_RESOLUTION });
				seen[0]?.({ type: "stage", at: 4, stage: "think", phase: "start" });
				seen[0]?.({ type: "end", at: 5, outcome: "planned", modelResolution: STALE_RESOLUTION });
				planner.runs[0]?.gate.resolve("LATE PLAN");
				await flush();
				expect(await nextPromise).toEqual(PENDING_RESULT);
				planner.runs[1]?.gate.resolve("PLAN B");
				await flush();
				expect(h.sent).toEqual([aside("PLAN B")]);
				h.emit("session_shutdown");
				await flush();
			}
			// Double cancel: two supersessions still deliver only the latest plan.
			{
				const planner = gated();
				const h = setup(planner.plan, 10, outer.extra);
				expect(await h.run("A")).toEqual(PENDING_RESULT);
				h.emit("turn_start");
				const runB = h.run("B");
				await flush();
				h.emit("turn_start");
				const runC = h.run("C");
				await flush();
				expect(planner.runs.map((entry) => entry.signal.aborted)).toEqual([true, true, false]);
				expect(await runB).toBeUndefined();
				planner.runs[0]?.gate.resolve("LATE A");
				planner.runs[1]?.gate.resolve("LATE B");
				await flush();
				expect(h.sent).toEqual([]);
				expect(await runC).toEqual(PENDING_RESULT);
				planner.runs[2]?.gate.resolve("PLAN C");
				await flush();
				expect(h.sent).toEqual([aside("PLAN C")]);
				h.emit("session_shutdown");
				await flush();
			}
			// Shutdown after pending: a late rejection settles nothing and sends nothing.
			{
				const gate = Promise.withResolvers<string>();
				let progress: ((event: ProgressEvent) => void) | undefined;
				const h = setup((_request, _signal, onEvent) => { progress = onEvent; return gate.promise; }, 10, outer.extra);
				expect(await h.run()).toEqual(PENDING_RESULT);
				h.emit("session_shutdown");
				progress?.({ type: "stage", at: 9, stage: "think", phase: "start" });
				gate.reject(new Error("late boom"));
				await flush();
				expect(h.sent).toEqual([]);
			}
		}, 10_000);
	}
	test("cancel-matrix post-handoff late progress, results, and rejections stay silent while the successor delivers once", async () => {
		const t = tuiCtx();
		const planner = gated();
		const seen: Array<((event: ProgressEvent) => void) | undefined> = [];
		const h = setup((request, signal, onEvent) => { seen.push(onEvent); return planner.plan(request, signal); }, 10, {}, t.ctx);
		h.emit("session_start");
		expect(await h.run("A")).toEqual(PENDING_RESULT);
		h.emit("turn_start");
		const nextPromise = h.run("B");
		expect(await nextPromise).toEqual(PENDING_RESULT);
		const successorLine = t.line();
		expect(planner.runs[0]?.signal.aborted).toBe(true);
		expect(seen).toHaveLength(2);
		seen[0]?.({ type: "begin", at: 3, sessionId: "s1", engine: "late", modelResolution: STALE_RESOLUTION });
		seen[0]?.({ type: "stage", at: 4, stage: "think", phase: "start" });
		seen[0]?.({ type: "end", at: 5, outcome: "planned", modelResolution: STALE_RESOLUTION });
		planner.runs[0]?.gate.resolve("LATE A");
		await flush();
		expect(t.line()).toBe(successorLine);
		expect(h.sent).toEqual([]);
		planner.runs[1]?.gate.resolve("PLAN B");
		await flush();
		expect(h.sent).toEqual([aside("PLAN B")]);
		h.emit("session_shutdown");
		await flush();
	}, 10_000);

	test("cancel-matrix reentrant abort events admit no new planner and schedule no later no-plan", async () => {
		const planner = gated();
		const h = setup((request, signal, onEvent) => {
			if (request.prompt === "A") {
				// Noncooperative old flight: its abort listener synchronously replays its own
				// begin/stage/end through its own sink while its provider gate never settles.
				signal.addEventListener("abort", () => {
					onEvent?.({ type: "begin", at: 1, sessionId: "s1", engine: "old" });
					onEvent?.({ type: "stage", at: 2, stage: "think", phase: "start" });
					onEvent?.({ type: "end", at: 3, outcome: "planned" });
				}, { once: true });
			}
			return planner.plan(request, signal);
		}, 5, { maxRunMs: 40 });
		const oldPromise = h.run("A");
		await untilStarted(planner);
		h.emit("turn_start");
		const nextPromise = h.run("B");
		expect(planner.runs[1]?.request.isCurrent?.()).toBe(true);
		planner.runs[1]?.gate.resolve("PLAN B");
		expect(await nextPromise).toMatchObject({ message: { content: "PLAN B" } });
		expect(planner.runs).toHaveLength(2);
		expect(planner.runs[0]?.signal.aborted).toBe(true);
		expect(planner.runs[1]?.signal.aborted).toBe(false);
		expect(planner.runs[1]?.request.isCurrent?.()).toBe(false);
		planner.runs[0]?.gate.resolve("LATE A");
		// Real delay: both flights carry the product deadline as a real timer, so only wall-clock
		// time proves no stray timer admits a new planner or delivers a later no-plan note.
		await Bun.sleep(100);
		await flush();
		expect(await oldPromise).toBeUndefined();
		expect(h.sent).toEqual([]);
		expect(planner.runs).toHaveLength(2);
		expect(planner.runs[1]?.signal.aborted).toBe(false);
		h.emit("session_shutdown");
		await flush();
	}, 10_000);

	test("cancel-matrix reentrant host cancel during startup admits no planner and schedules no later no-plan", async () => {
		for (const event of ["session_switch", "session_shutdown"] as const) {
			let h!: OmpTestHarness;
			const planner = gated();
			h = setup((request, signal) => {
				if (request.prompt === "A") {
					// Reentrant startup guard (G2): cancelling A runs this listener synchronously
					// inside B's start, so the host cancel below hits B before its planner/timer.
					signal.addEventListener("abort", () => {
						h.emit(event);
					}, { once: true });
				}
				return planner.plan(request, signal);
			}, 5, { maxRunMs: 40 });
			const oldPromise = h.run("A");
			await untilStarted(planner);
			let oldGateSettled = false;
			void planner.runs[0]?.gate.promise.then(() => { oldGateSettled = true; });
			h.emit("turn_start");
			const nextPromise = h.run("B");
			expect(await oldPromise).toBeUndefined();
			expect(await nextPromise).toBeUndefined();
			expect(oldGateSettled).toBe(false);
			expect(planner.runs[0]?.signal.aborted).toBe(true);
			expect(planner.runs[0]?.request.isCurrent?.()).toBe(false);
			expect(planner.runs).toHaveLength(1);
			// Real delay: the product deadline is a real timer, so only wall-clock time proves
			// the cancelled new flight scheduled no timer that admits a planner or delivers NO_PLAN.
			await Bun.sleep(100);
			await flush();
			expect(planner.runs).toHaveLength(1);
			expect(h.sent).toEqual([]);
			h.emit("session_shutdown");
			await flush();
		}
	}, 10_000);

	test("cancel-matrix cancelled-then-resumed work writes no tracker, state, or carrier rows", async () => {
		const root = mkdtempSync(join(tmpdir(), "ut-omp-cancel-fx-"));
		try {
			const stateDir = join(root, "state");
			const live = fakeModel("acme", "sol-1");
			const { runtime } = fakeRuntime([live], { current: () => live });
			const config = quietConfig((value) => {
				value.think.enabled = value.hitl.enabled = false;
				value.track.enabled = true;
				value.linear.team = "Team";
			});
			const lookup = Promise.withResolvers<GroundOutcome>();
			const empty: GroundOutcome = { status: "none", chunks: [], chars: 0, ms: 0, datasets: 0 };
			const firstCall = Promise.withResolvers<void>();
			const rec = recorder((call) => {
				firstCall.resolve();
				return reply([{ type: "text", text: stageAnswer(userText(call)).text }]);
			});
			let tracks = 0;
			const events: ProgressEvent[] = [];
			const oldCompleted = Promise.withResolvers<PlanResponse>();
			const h = setup(async (request, signal, onEvent) => {
				if (request.prompt === "add a widget immediately") return { context: "PLAN B" };
				const response = await planPrompt(
					{ host: "omp", session_id: request.sessionId, prompt: request.prompt, cwd: request.cwd },
					isolatedPlanEnv(root),
					{
						config: request.config!,
						control: request.control!,
						stateDir,
						signal,
						native: createNativeEngineSelector(request, signal, { completeSimple: rec.complete, providerDefaults: {}, isCurrent: request.isCurrent! }),
						ground: () => lookup.promise,
						createTracker: () => async () => { tracks++; return undefined; },
						progress: (entry) => {
							events.push(entry);
							onEvent?.(entry);
						},
					},
				);
				oldCompleted.resolve(response);
				return response;
			}, 10, { stateDir, config: () => config }, { cwd: root, model: live, ...runtime });
			const oldPromise = h.run("add a widget");
			// The planner reaches its first model call only after a real event-loop turn on Bun 1.2, so await that call itself.
			await firstCall.promise;
			expect(rec.calls).toHaveLength(1);
			h.emit("turn_start");
			const nextPromise = h.run("add a widget immediately");
			expect(await nextPromise).toMatchObject({ message: { content: "PLAN B" } });
			lookup.resolve(empty);
			expect(await oldCompleted.promise).toMatchObject({ context: "", skipped: "aborted" });
			expect(await oldPromise).toBeUndefined();
			await flush();
			expect(tracks).toBe(0);
			expect(events.filter((entry) => entry.type === "stage" && (entry.stage === "track" || entry.stage === "state"))).toEqual([]);
			for (const path of ["sessions/s1.json", "sessions/s1.xml", "last.json", "last-plan.json"]) expect(existsSync(join(stateDir, path))).toBe(false);
			expect(h.sent).toEqual([]);
			h.emit("session_shutdown");
			await flush();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	}, 10_000);

	test("cancel-matrix empty results stay quiet before the handoff and send one no-plan aside after", async () => {
		{
			let calls = 0;
			const h = setup(async () => { calls++; return ""; }, 50, {});
			expect(await h.run()).toBeUndefined();
			expect(calls).toBe(1);
			expect(h.sent).toEqual([]);
			h.emit("session_shutdown");
			await flush();
		}
		{
			const planner = gated();
			const h = setup(planner.plan, 1, {});
			expect(await h.run()).toEqual(PENDING_RESULT);
			planner.runs[0]?.gate.resolve("");
			await flush();
			expect(h.sent).toEqual([aside(NO_PLAN)]);
			expect(await h.run()).toBeUndefined();
			expect(planner.runs).toHaveLength(1);
			await flush();
			expect(h.sent).toEqual([aside(NO_PLAN)]);
			h.emit("session_shutdown");
			await flush();
		}
		{
			const planner = gated();
			const h = setup(planner.plan, 1, {});
			const oldPromise = h.run("A");
			await untilStarted(planner);
			h.emit("turn_start");
			const nextPromise = h.run("B");
			planner.runs[1]?.gate.resolve("PLAN B");
			expect(await nextPromise).toMatchObject({ message: { content: "PLAN B" } });
			planner.runs[0]?.gate.resolve("");
			await flush();
			expect(await oldPromise).toBeUndefined();
			expect(h.sent).toEqual([]);
			h.emit("session_shutdown");
			await flush();
		}
	}, 10_000);
	test("handoff-ordering completion before the race returns one inline plan with no aside", async () => {
		const planner = gated();
		const h = setup(planner.plan, 50, {});
		const promise = h.run();
		await untilStarted(planner);
		planner.runs[0]?.gate.resolve("PLAN");
		expect(await promise).toMatchObject({ message: { content: "PLAN" } });
		expect(planner.runs[0]?.signal.aborted).toBe(false);
		expect(h.sent).toEqual([]);
		h.emit("session_shutdown");
		await flush();
	}, 10_000);

	test("handoff-ordering coincident provider-first clears race and returns inline with no aside", async () => {
		const result = await runChildLifetimeScenario({ cancelHung: false, handoffOrder: "provider-first" });
		expect(result.planAsides).toBe(0);
		expect(result.nativeCalls).toBe(0);
		const handoff = result.handoff;
		expect(handoff?.order).toBe("provider-first");
		expect(handoff?.dueMs).toBe(25_000);
		expect(handoff?.raceDue).toBe(25_000);
		expect(handoff?.providerDue).toBe(25_000);
		expect(handoff?.raceDue).toBe(handoff?.providerDue);
		expect(handoff?.providerSeq).toBeLessThan(handoff?.raceSeq ?? Number.POSITIVE_INFINITY);
		expect(handoff?.providerFired).toBe(true);
		expect(handoff?.raceFired).toBe(false);
		expect(handoff?.raceCleared).toBe(true);
		expect(handoff?.firedRoles).toEqual(["provider"]);
		expect(handoff?.pending).toBe(false);
		expect(handoff?.inlineContent).toBe("PLAN");
		expect(handoff?.asideContent).toBeNull();
		expect(handoff?.asideCustomType).toBeNull();
		expect(handoff?.asideDeliverAs).toBeNull();
	}, 120_000);

	test("handoff-ordering coincident race-first dispatches race then delivers one aside", async () => {
		const result = await runChildLifetimeScenario({ cancelHung: false, handoffOrder: "race-first" });
		expect(result.planAsides).toBe(1);
		expect(result.nativeCalls).toBe(0);
		const handoff = result.handoff;
		expect(handoff?.order).toBe("race-first");
		expect(handoff?.dueMs).toBe(25_000);
		expect(handoff?.raceDue).toBe(25_000);
		expect(handoff?.providerDue).toBe(25_000);
		expect(handoff?.raceDue).toBe(handoff?.providerDue);
		expect(handoff?.raceSeq).toBeLessThan(handoff?.providerSeq ?? Number.POSITIVE_INFINITY);
		expect(handoff?.raceFired).toBe(true);
		expect(handoff?.providerFired).toBe(true);
		expect(handoff?.raceCleared).toBe(false);
		expect(handoff?.firedRoles).toEqual(["race", "provider"]);
		expect(handoff?.pending).toBe(true);
		expect(handoff?.inlineContent).toBeNull();
		expect(handoff?.asideContent).toBe("PLAN");
		expect(handoff?.asideCustomType).toBe("ultrathink-plan");
		expect(handoff?.asideDeliverAs).toBe("aside");
	}, 120_000);

	test("handoff-ordering completion after pending delivers exactly one aside", async () => {
		const planner = gated();
		const h = setup(planner.plan, 1, {});
		expect(await h.run()).toEqual(PENDING_RESULT);
		planner.runs[0]?.gate.resolve("PLAN");
		await flush();
		expect(h.sent).toEqual([aside("PLAN")]);
		expect(await h.run()).toBeUndefined();
		expect(planner.runs).toHaveLength(1);
		await flush();
		expect(h.sent).toEqual([aside("PLAN")]);
		h.emit("session_shutdown");
		await flush();
	}, 10_000);

	test("handoff-ordering resolve-then-reenter in the same tick after pending keeps one aside", async () => {
		const planner = gated();
		const h = setup(planner.plan, 1, {});
		expect(await h.run()).toEqual(PENDING_RESULT);
		planner.runs[0]?.gate.resolve("PLAN");
		expect(await h.run()).toEqual(PENDING_RESULT);
		expect(planner.runs).toHaveLength(1);
		await flush();
		expect(h.sent).toEqual([aside("PLAN")]);
		await flush();
		expect(h.sent).toEqual([aside("PLAN")]);
		h.emit("session_shutdown");
		await flush();
	}, 10_000);
	test("positive deadline early completion survives advancement unchanged", async () => {
		const t = tuiCtx();
		let calls = 0;
		let signal: AbortSignal | undefined;
		const h = setup((_request, captured) => { calls++; signal = captured; return Promise.resolve("PLAN"); }, 5, { maxRunMs: 40 }, t.ctx);
		h.emit("session_start");
		expect(await h.run()).toMatchObject({ message: { content: "PLAN" } });
		expect(calls).toBe(1);
		const line = t.line();
		// Real delay: the product deadline is a real timer, so only wall-clock time proves it was cleaned up.
		await Bun.sleep(100);
		await flush();
		expect(t.line()).toBe(line);
		expect(h.sent).toEqual([]);
		expect(signal?.aborted).toBe(false);
		expect(await h.run()).toMatchObject({ message: { content: "PLAN" } });
		expect(calls).toBe(1);
		h.emit("session_shutdown");
		await flush();
	}, 10_000);

	test("positive deadline early failure survives advancement unchanged", async () => {
		const t = tuiCtx();
		let calls = 0;
		let signal: AbortSignal | undefined;
		const h = setup((_request, captured) => {
			calls++;
			signal = captured;
			return Promise.reject(new Error("boom"));
		}, 5, { maxRunMs: 40 }, t.ctx);
		h.emit("session_start");
		expect(await h.run()).toBeUndefined();
		expect(calls).toBe(1);
		const line = t.line();
		// Real delay: the product deadline is a real timer, so only wall-clock time proves it was cleaned up.
		await Bun.sleep(100);
		await flush();
		expect(t.line()).toBe(line);
		expect(h.sent).toEqual([]);
		expect(signal?.aborted).toBe(false);
		expect(await h.run()).toBeUndefined();
		expect(calls).toBe(1);
		h.emit("session_shutdown");
		await flush();
	}, 10_000);

	test("positive deadline early cancellation survives advancement unchanged", async () => {
		const planner = gated();
		const h = setup(planner.plan, 5, { maxRunMs: 40 });
		const oldPromise = h.run("A");
		await untilStarted(planner);
		h.emit("turn_start");
		const nextPromise = h.run("B");
		planner.runs[1]?.gate.resolve("PLAN B");
		expect(await nextPromise).toMatchObject({ message: { content: "PLAN B" } });
		// Real delay: the superseded flight's product deadline is real, so wall-clock time proves it stays silent.
		await Bun.sleep(100);
		planner.runs[0]?.gate.resolve("LATE A");
		await flush();
		expect(await oldPromise).toBeUndefined();
		expect(planner.runs[0]?.signal.aborted).toBe(true);
		expect(planner.runs[1]?.signal.aborted).toBe(false);
		expect(h.sent).toEqual([]);
		h.emit("session_shutdown");
		await flush();
	}, 10_000);

	test("positive deadline provider winning before expiry delivers once with no late no-plan", async () => {
		const planner = gated();
		const h = setup(planner.plan, 1_000, { maxRunMs: 60 });
		const promise = h.run();
		await untilStarted(planner);
		planner.runs[0]?.gate.resolve("PLAN");
		expect(await promise).toMatchObject({ message: { content: "PLAN" } });
		expect(planner.runs[0]?.signal.aborted).toBe(false);
		// Real delay: the product deadline is a real timer, so only wall-clock time proves it was cleaned up.
		await Bun.sleep(120);
		await flush();
		expect(h.sent).toEqual([]);
		expect(planner.runs[0]?.signal.aborted).toBe(false);
		expect(planner.runs).toHaveLength(1);
		expect(await h.run()).toMatchObject({ message: { content: "PLAN" } });
		h.emit("session_shutdown");
		await flush();
	}, 10_000);

	test("explicit zero mirrors omitted beyond cutoff", async () => {
		expect(await runChildLifetimeScenario({ maxRunMs: 0, cancelHung: false })).toEqual({ planAsides: 1, nativeCalls: 8 });
	}, 120_000);

	test("local native lifetime smoke", async () => {
		expect(await runChildLifetimeScenario({ cancelHung: false })).toEqual({ planAsides: 1, nativeCalls: 8 });
		expect(await runChildLifetimeScenario({ cancelHung: true })).toEqual({ planAsides: 0, nativeCalls: 1 });
	}, 180_000);
});


