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
import { fakeModel, fakeRuntime, flush, isolatedPlanEnv, quietConfig, recorder, reply, setup, stageAnswer, tuiCtx, userText } from "./omp-test.helpers.ts";
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
});


