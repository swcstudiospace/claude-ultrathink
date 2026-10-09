// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Effort, Model } from "@oh-my-pi/pi-ai";
import { writeSession } from "../claude/state.ts";
import type { TrackPlan } from "../track/types.ts";
import { DEFAULT_SHIP_CONFIG, type ShipConfig } from "../ship/types.ts";
import { DEFAULT_HINDSIGHT_CONFIG } from "../hindsight/types.ts";
import { DEFAULT_TEACH_CONFIG, type CaptureMode, type TeachDigest } from "../teach/types.ts";
import type { ModelIntent, ModelResolution, SelectedEngine } from "./engine.ts";
import { createNativeEnginePlanner, createNativeEngineSelector, NO_PLAN, QUICK_USAGE } from "./omp.ts";
import type { NativeEngineDeps, OmpNativeRuntime, OmpPlan, OmpPlanRequest, ShipPrecheck } from "./omp.ts";
import { controlled, fakeModel, fakeRuntime, flush, planReply, quietConfig, recorder, reply, setup, stageAnswer, tuiCtx, userText } from "./omp-test.helpers.ts";
import type { ProgressEvent } from "./progress.ts";
import type { PlanView } from "./view.ts";

describe("omp extension", () => {
	test("fast plan is returned inline", async () => {
		const { run, sent } = setup(async () => "PLAN");
		expect(await run()).toEqual({
			message: { customType: "ultrathink-plan", content: "PLAN", display: true, attribution: "agent" },
		});
		await flush();
		expect(sent).toHaveLength(0);
	});

	test("empty fast plan injects nothing", async () => {
		const { run } = setup(async () => "");
		expect(await run()).toBeUndefined();
	});

	test("slow plan returns pending then delivers aside once", async () => {
		const gate = controlled();
		const { run, sent } = setup(gate.plan, 1);
		const result = await run();
		expect(result && typeof result.message === "object" && result.message.customType).toBe(
			"ultrathink-pending",
		);
		expect(sent).toHaveLength(0);
		gate.resolve("PLAN");
		await flush();
		expect(sent).toEqual([
			{
				message: { customType: "ultrathink-plan", content: "PLAN", display: true, attribution: "agent" },
				options: { deliverAs: "aside" },
			},
		]);
	});

	test("slow empty plan delivers NO_PLAN", async () => {
		const gate = controlled();
		const { run, sent } = setup(gate.plan, 1);
		await run();
		gate.resolve("");
		await flush();
		expect(sent).toHaveLength(1);
		expect((sent[0]!.message as { content: string }).content).toBe(NO_PLAN);
	});

	test("re-entry reuses the in-flight plan", async () => {
		const gate = controlled();
		const { run, sent } = setup(gate.plan, 1);
		await Promise.all([run(), run()]);
		await run();
		gate.resolve("PLAN");
		await flush();
		expect(gate.calls()).toBe(1);
		expect(sent.length).toBeLessThanOrEqual(1);
	});

	const PENDING_MSG = { customType: "ultrathink-pending", display: true, attribution: "agent" } as const;
	const PLAN_MSG = {
		customType: "ultrathink-plan",
		content: "PLAN",
		display: true,
		attribution: "agent",
	} as const;

	test("re-entry after pending returns pending again without inline plan", async () => {
		const gate = controlled();
		const { run, sent } = setup(gate.plan, 1);
		expect(await run()).toEqual({ message: expect.objectContaining(PENDING_MSG) });
		const second = run();
		gate.resolve("PLAN");
		expect(await second).toEqual({ message: expect.objectContaining(PENDING_MSG) });
		await flush();
		expect(gate.calls()).toBe(1);
		expect(sent).toEqual([{ message: PLAN_MSG, options: { deliverAs: "aside" } }]);
	});

	test("re-entry after inline plan returns the same plan", async () => {
		let calls = 0;
		const { run, sent } = setup(async () => {
			calls++;
			return "PLAN";
		});
		expect(await run()).toEqual({ message: PLAN_MSG });
		await flush();
		expect(await run()).toEqual({ message: PLAN_MSG });
		expect(calls).toBe(1);
		expect(sent).toHaveLength(0);
	});

	test("re-entry after aside delivery injects nothing", async () => {
		const gate = controlled();
		const { run, sent } = setup(gate.plan, 1);
		await run();
		gate.resolve("PLAN");
		await flush();
		expect(await run()).toBeUndefined();
		await flush();
		expect(gate.calls()).toBe(1);
		expect(sent).toHaveLength(1);
	});

	test("an identical resend after an inline plan is planned again", async () => {
		let calls = 0;
		const { run, emit } = setup(async () => {
			calls++;
			return "PLAN";
		});
		expect(await run()).toEqual({ message: PLAN_MSG });
		emit("turn_start");
		expect(await run()).toEqual({ message: PLAN_MSG });
		expect(calls).toBe(2);
	});

	test("an identical resend after an aside delivery is planned again", async () => {
		const first = Promise.withResolvers<string>();
		let calls = 0;
		const { run, sent, emit } = setup(() => (++calls === 1 ? first.promise : Promise.resolve("PLAN 2")), 1);
		expect(await run()).toEqual({ message: expect.objectContaining(PENDING_MSG) });
		emit("turn_start");
		first.resolve("PLAN 1");
		await flush();
		expect(sent).toEqual([{ message: { ...PLAN_MSG, content: "PLAN 1" }, options: { deliverAs: "aside" } }]);
		expect(await run()).toEqual({ message: { ...PLAN_MSG, content: "PLAN 2" } });
		expect(calls).toBe(2);
	});

	const VIEW: PlanView = {
		root: "BUILD_PROMPT",
		source: "llm",
		elapsedMs: 1200,
		nodes: [{ id: "n1", title: "Do thing", kind: "task", wave: 0, dependsOn: [], steps: [] }],
		waves: [["n1"]],
		clarifications: [],
	};

	test("tui session mounts the bar above the editor, then re-mounts once per tick after other handlers", async () => {
		const t = tuiCtx();
		const { emit, renderers } = setup(async () => "", 1_000, {}, t.ctx);
		emit("session_start");
		expect(t.widgets).toHaveLength(1);
		expect(t.widgets[0]!.key).toBe("ultrathink");
		expect(t.widgets[0]!.options).toEqual({ placement: "aboveEditor" });
		emit("agent_start");
		expect(t.widgets).toHaveLength(1);
		// The remount is a setTimeout(0) macrotask by design (after every other extension's handler); wait one.
		await Bun.sleep(1);
		expect(t.widgets).toHaveLength(2);
		expect(t.widgets[1]!.factory).toBe(t.widgets[0]!.factory);
		expect(emit("input")).toBeUndefined();
		emit("tool_execution_end");
		emit("tool_execution_start");
		emit("turn_end");
		expect(t.widgets).toHaveLength(2);
		await Bun.sleep(1);
		expect(t.widgets).toHaveLength(3);
		expect(t.widgets[2]!.factory).toBe(t.widgets[0]!.factory);
		expect(t.widgets[2]!.options).toEqual({ placement: "aboveEditor" });
		expect(renderers.sort()).toEqual(["ultrathink-pending", "ultrathink-plan", "ultrathink-ship", "ultrathink-sync"]);
	});

	test("non-tui or no-UI sessions mount no bar", async () => {
		for (const extra of [{ mode: "rpc" }, { hasUI: false }]) {
			const t = tuiCtx();
			const { emit } = setup(async () => "", 1_000, {}, { ...t.ctx, ...extra });
			emit("session_start");
			emit("agent_start");
			emit("input");
			await Bun.sleep(1);
			expect(t.widgets).toHaveLength(0);
		}
	});

	test("planner events reach the bar and inline delivery carries details", async () => {
		const t = tuiCtx();
		const stage = Promise.withResolvers<void>();
		const gate = Promise.withResolvers<OmpPlan>();
		const { run, emit } = setup(
			async (_req, _signal, onEvent) => {
				onEvent?.({ type: "begin", at: 1, sessionId: "s1", engine: "grok" });
				onEvent?.({ type: "stage", at: 2, stage: "uplift", phase: "start" });
				stage.resolve();
				return gate.promise;
			},
			1_000,
			{},
			t.ctx,
		);
		emit("session_start");
		const result = run();
		await stage.promise;
		expect(t.line()).toContain("uplift");
		gate.resolve({ context: "PLAN", view: VIEW });
		expect(await result).toEqual({ message: { ...PLAN_MSG, details: VIEW } });
		expect(t.renders()).toBeGreaterThan(0);
	});

	test("slow plan shows pending then delivers the view via aside", async () => {
		const t = tuiCtx();
		const gate = Promise.withResolvers<OmpPlan>();
		const { run, sent, emit } = setup(() => gate.promise, 1, {}, t.ctx);
		emit("session_start");
		await run();
		const pendingLine = t.line();
		gate.resolve({ context: "PLAN", view: VIEW });
		await flush();
		expect(sent).toEqual([{ message: { ...PLAN_MSG, details: VIEW }, options: { deliverAs: "aside" } }]);
		expect(t.line()).not.toBe(pendingLine);
	});

	test("a throwing setWidget does not break planning", async () => {
		const t = tuiCtx(() => {
			throw new Error("boom");
		});
		const { run, emit } = setup(async () => "PLAN", 1_000, {}, t.ctx);
		emit("session_start");
		emit("agent_start");
		expect(await run()).toEqual({ message: PLAN_MSG });
		await Bun.sleep(1);
	});

	test("the frame timer renders while animating and once more after it stops", async () => {
		const t = tuiCtx();
		let tick: (() => void) | undefined;
		let clock = 1_000;
		const gate = Promise.withResolvers<OmpPlan>();
		const ctx = { ...t.ctx, setInterval: (callback: () => void) => void (tick = callback) };
		const { run, emit } = setup(() => gate.promise, 1_000, { now: () => clock }, ctx);
		emit("session_start");
		t.line();
		const result = run();
		await flush();
		let before = t.renders();
		tick?.();
		tick?.();
		expect(t.renders() - before).toBe(2);
		gate.resolve({ context: "PLAN", view: VIEW });
		await result;
		clock += 60_000;
		before = t.renders();
		tick?.();
		tick?.();
		tick?.();
		expect(t.renders() - before).toBe(1);
	});

	test("a deferred plan that settles after a newer prompt began is dropped, not delivered", async () => {
		const t = tuiCtx();
		const flights = new Map<string, { onEvent: (event: ProgressEvent) => void; gate: PromiseWithResolvers<OmpPlan> }>();
		const { run, sent, emit } = setup(
			(req, _signal, onEvent) => {
				const gate = Promise.withResolvers<OmpPlan>();
				flights.set(req.prompt, { onEvent: onEvent!, gate });
				return gate.promise;
			},
			1,
			{ now: () => 5_000 },
			t.ctx,
		);
		emit("session_start");
		await run("A");
		const a = flights.get("A")!;
		a.onEvent({ type: "begin", at: 1, sessionId: "s1", engine: "grok" });
		emit("turn_start");
		await run("B");
		const b = flights.get("B")!;
		b.onEvent({ type: "begin", at: 2, sessionId: "s1", engine: "grok" });
		b.onEvent({ type: "stage", at: 3, stage: "uplift", phase: "start" });
		const bLine = t.line();
		expect(bLine).toContain("uplift");

		a.onEvent({ type: "stage", at: 4, stage: "think", phase: "start" });
		a.gate.resolve({ context: "PLAN A", view: VIEW });
		await flush();
		expect(sent).toEqual([]);
		expect(t.line()).toBe(bLine);

		b.onEvent({ type: "stage", at: 5, stage: "think", phase: "start" });
		expect(t.line()).toContain("think");
		b.gate.resolve({ context: "PLAN B" });
		await flush();
		expect(sent).toEqual([{ message: { ...PLAN_MSG, content: "PLAN B" }, options: { deliverAs: "aside" } }]);
	});

	test("a deferred plan still lands after its own turns start", async () => {
		const gate = controlled();
		const { run, sent, emit } = setup(gate.plan, 1);
		await run();
		emit("turn_start");
		emit("turn_start");
		gate.resolve("PLAN");
		await flush();
		expect(sent).toEqual([{ message: PLAN_MSG, options: { deliverAs: "aside" } }]);
	});

	test("the planner request carries one snapshot of the live ctx.model, which wins over current() without blending", async () => {
		const live = fakeModel("acme", "Sol-1.Opaque");
		const other = fakeModel("other", "x");
		const { runtime } = fakeRuntime([live, other], { current: () => other });
		let seen: OmpPlanRequest | undefined;
		const { run } = setup(
			async (request) => {
				seen = request;
				return "";
			},
			1_000,
			{},
			{ model: live, ...runtime },
		);
		await run("do it");
		expect(seen?.modelSource).toBe("ctx.model");
		// A copy of the whole Model (data cloned, header resolver kept), never the host-owned object.
		expect(seen?.model).not.toBe(live);
		expect(seen?.model).toEqual(live);
		expect(seen?.model?.resolveHeaders).toBe(live.resolveHeaders);
		expect(seen?.native?.modelRegistry).toBe(runtime.modelRegistry);
	});

	test("without ctx.model the planner request falls back to ctx.models.current()", async () => {
		const live = fakeModel("acme", "sol-1");
		const { runtime } = fakeRuntime([live], { current: () => live });
		let seen: OmpPlanRequest | undefined;
		const { run } = setup(
			async (request) => {
				seen = request;
				return "";
			},
			1_000,
			{},
			{ ...runtime },
		);
		await run("do it");
		expect(seen?.modelSource).toBe("ctx.models.current");
		expect(seen?.model).toEqual(live);
	});

	test("a session file is never a model source: without a live model or host runtime the request has neither", async () => {
		let seen: OmpPlanRequest | undefined;
		const { run } = setup(
			async (request) => {
				seen = request;
				return "";
			},
			1_000,
			{},
			{ sessionManager: { getSessionId: () => "s1", getSessionFile: () => "/s.jsonl" } },
		);
		await run("do it");
		expect(seen && "model" in seen).toBe(false);
		expect(seen && "native" in seen).toBe(false);
	});
});


describe("slash commands", () => {
	let stateDir: string;
	beforeEach(() => {
		stateDir = mkdtempSync(join(tmpdir(), "ut-omp-cmd-"));
	});
	afterEach(() => {
		rmSync(stateDir, { recursive: true, force: true });
	});

	const counting = () => {
		const prompts: string[] = [];
		const plan = async (request: { prompt: string }) => {
			prompts.push(request.prompt);
			return "PLAN";
		};
		return { plan, prompts };
	};

	test("registers every /ultrathink-<verb> command, with on/off completions for track", () => {
		const { commands } = setup(async () => "PLAN", 1_000, { stateDir });
		expect([...commands.keys()].sort()).toEqual(
			["ultrathink-off", "ultrathink-on", "ultrathink-quick", "ultrathink-skip", "ultrathink-status", "ultrathink-track"],
		);
		const complete = commands.get("ultrathink-track")!.getArgumentCompletions!;
		expect((complete("") as { value: string }[]).map((item) => item.value)).toEqual(["on", "off"]);
		expect((complete("of") as { value: string }[]).map((item) => item.value)).toEqual(["off"]);
	});

	test("off then status writes control state and notifies runControl's text", async () => {
		const { command, notices } = setup(async () => "PLAN", 1_000, { stateDir });
		await command("ultrathink-off");
		expect(JSON.parse(readFileSync(join(stateDir, "control.json"), "utf8")).enabled).toBe(false);
		await command("ultrathink-status");
		expect(notices).toHaveLength(2);
		expect(notices[1]).toContain("Prompt Uplift off");
	});

	test("quick sends the message unplanned; the next message plans again", async () => {
		const planner = counting();
		const { command, run, userMessages, sent } = setup(planner.plan, 1_000, { stateDir });
		await command("ultrathink-quick", "  hello  ");
		expect(userMessages).toEqual(["hello"]);
		expect(await run("hello")).toBeUndefined();
		// Omp may re-run before_agent_start for the same delivery.
		expect(await run("hello")).toBeUndefined();
		await flush();
		expect(planner.prompts).toEqual([]);
		expect(sent).toHaveLength(0);
		expect(await run("next")).toEqual({
			message: { customType: "ultrathink-plan", content: "PLAN", display: true, attribution: "agent" },
		});
		expect(planner.prompts).toEqual(["next"]);
	});

	test("a quick message drops the pending plan of an earlier prompt", async () => {
		const gate = controlled();
		const t = tuiCtx();
		const { command, run, sent, emit } = setup(gate.plan, 1, { stateDir }, t.ctx);
		emit("session_start");
		await run("A");
		emit("turn_start");
		await command("ultrathink-quick", "hello");
		expect(await run("hello")).toBeUndefined();
		gate.resolve("PLAN A");
		await flush();
		expect(sent).toEqual([]);
		expect(t.line()).toContain("superseded");
	});

	test("quick text sent again later as a normal prompt is planned", async () => {
		const planner = counting();
		const { command, run, emit } = setup(planner.plan, 1_000, { stateDir });
		await command("ultrathink-quick", "hello");
		await run("hello");
		emit("turn_start");
		await run("hello");
		expect(planner.prompts).toEqual(["hello"]);
	});

	test("a quick message that never arrives does not swallow the next prompt", async () => {
		const planner = counting();
		const { command, run } = setup(planner.plan, 1_000, { stateDir });
		await command("ultrathink-quick", "hello");
		await run("something else");
		await run("hello");
		expect(planner.prompts).toEqual(["something else", "hello"]);
	});

	test("quick without a message notifies usage and sends nothing", async () => {
		const planner = counting();
		const { command, userMessages, notices, run } = setup(planner.plan, 1_000, { stateDir });
		await command("ultrathink-quick", "   ");
		expect(userMessages).toEqual([]);
		expect(notices).toEqual([QUICK_USAGE]);
		await run("hello");
		expect(planner.prompts).toEqual(["hello"]);
	});

	test("in a subagent session a command goes to the agent as typed", async () => {
		const { command, userMessages, notices } = setup(async () => "PLAN", 1_000, { stateDir }, {
			hasUI: false,
			sessionManager: { getSessionId: () => "s1" },
		});
		await command("ultrathink-off");
		await command("ultrathink-quick", "hello");
		expect(userMessages).toEqual(["/ultrathink-off", "/ultrathink-quick hello"]);
		expect(notices).toEqual([]);
		expect(existsSync(join(stateDir, "control.json"))).toBe(false);
	});
});

describe("subagent sessions", () => {
	const PARENT = "/home/u/.omp/agent/sessions/abc/2026_parent";
	const nestedOnly = (path: string) => path === `${PARENT}.jsonl`;
	const session = (manager: Record<string, unknown>) => ({ sessionManager: { getSessionId: () => "s1", ...manager } });

	test("a nested session file is not planned", async () => {
		let calls = 0;
		const { run, sent } = setup(
			async () => {
				calls++;
				return "PLAN";
			},
			1_000,
			{ exists: nestedOnly },
			{ hasUI: false, ...session({ getSessionFile: () => `${PARENT}/Worker.jsonl`, getHeader: () => ({ parentSession: `${PARENT}.jsonl` }) }) },
		);
		expect(await run()).toBeUndefined();
		await flush();
		expect(calls).toBe(0);
		expect(sent).toHaveLength(0);
	});

	test("an in-memory session without UI and with a parent is not planned", async () => {
		let calls = 0;
		const { run } = setup(
			async () => {
				calls++;
				return "PLAN";
			},
			1_000,
			{ exists: () => false },
			{ hasUI: false, ...session({ getSessionFile: () => undefined, getHeader: () => ({ parentSession: `${PARENT}.jsonl` }) }) },
		);
		expect(await run()).toBeUndefined();
		expect(calls).toBe(0);
	});

	test("a user fork with UI is planned", async () => {
		const { run } = setup(async () => "PLAN", 1_000, { exists: nestedOnly }, {
			hasUI: true,
			...session({ getSessionFile: () => "/home/u/.omp/agent/sessions/abc/2026_fork.jsonl", getHeader: () => ({ parentSession: `${PARENT}.jsonl` }) }),
		});
		expect(await run()).toMatchObject({ message: { content: "PLAN" } });
	});

	test("a top-level session without a header is planned", async () => {
		const { run } = setup(async () => "PLAN", 1_000, { exists: nestedOnly }, {
			hasUI: false,
			...session({ getSessionFile: () => `${PARENT}.jsonl`, getHeader: () => null }),
		});
		expect(await run()).toMatchObject({ message: { content: "PLAN" } });
	});

	test("a session file in a temp task lease dir is not planned", async () => {
		let calls = 0;
		const { run } = setup(
			async () => {
				calls++;
				return "PLAN";
			},
			1_000,
			{ exists: () => false },
			{ hasUI: false, ...session({ getSessionFile: () => "/tmp/omp-task-123/Worker.jsonl", getHeader: () => null }) },
		);
		expect(await run()).toBeUndefined();
		expect(calls).toBe(0);
	});

	test("a session without UI and without a session file is not planned", async () => {
		let calls = 0;
		const { run } = setup(
			async () => {
				calls++;
				return "PLAN";
			},
			1_000,
			{ exists: () => false },
			{ hasUI: false, ...session({ getSessionFile: () => undefined, getHeader: () => null }) },
		);
		expect(await run()).toBeUndefined();
		expect(calls).toBe(0);
	});

	test("a session with UI and without a session file is planned", async () => {
		const { run } = setup(async () => "PLAN", 1_000, { exists: () => false }, {
			hasUI: true,
			...session({ getSessionFile: () => undefined, getHeader: () => null }),
		});
		expect(await run()).toMatchObject({ message: { content: "PLAN" } });
	});

	test("a throwing session manager fails open and plans", async () => {
		const { run } = setup(async () => "PLAN", 1_000, { exists: () => true }, {
			hasUI: false,
			...session({
				getSessionFile: () => {
					throw new Error("boom");
				},
				getHeader: () => ({ parentSession: `${PARENT}.jsonl` }),
			}),
		});
		expect(await run()).toMatchObject({ message: { content: "PLAN" } });
	});
});

describe("pr sync", () => {
	const PR = "https://github.com/o/r/pull/12";
	const PR_13 = "https://github.com/o/r/pull/13";
	let dir = "";
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "ut-omp-sync-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	const track = (plan?: TrackPlan) =>
		writeSession(dir, { sessionId: "s1", at: 1, result: { xml: "", original: "", root: "BUILD_PROMPT", source: "llm" }, plan });
	const PLAN = { graphId: "g-7" } as TrackPlan;
	const result = (toolName: string, input: Record<string, unknown>, text: string, isError = false) => ({
		toolName,
		input,
		content: [{ type: "text", text }],
		isError,
	});
	const ghPrCreate = result("bash", { command: "git push -u origin feat && gh pr create --fill" }, `Creating pull request for feat into main in o/r\n\n${PR}\n`);

	test("a gh pr create result sends one ultrathink-sync aside per PR URL", () => {
		track(PLAN);
		const { emit, sent } = setup(async () => "", 1_000, { stateDir: dir });
		expect(emit("tool_result", ghPrCreate)).toBeUndefined();
		emit("tool_result", ghPrCreate);
		expect(sent).toEqual([
			{
				message: { customType: "ultrathink-sync", content: expect.any(String), display: true, details: { url: PR, number: 12 }, attribution: "agent" },
				options: { deliverAs: "aside" },
			},
		]);
		// Bun's toMatchObject writes a matched asymmetric matcher back into the received object, so read the text once.
		const message = sent[0]?.message;
		const content = message && typeof message === "object" && "content" in message ? message.content : undefined;
		for (const fact of [PR, `stateFile=${join(dir, "sessions", "s1.json")}`, "g-7"]) expect(content).toContain(fact);
		emit("tool_result", result("bash", { command: "gh pr create --fill" }, `${PR_13}\n`));
		expect(sent).toMatchObject([{ message: { details: { url: PR } } }, { message: { details: { url: PR_13, number: 13 } } }]);
	});

	test("nothing without a tracked plan or in a subagent session", () => {
		const bare = setup(async () => "", 1_000, { stateDir: dir });
		bare.emit("tool_result", ghPrCreate);
		track();
		bare.emit("tool_result", ghPrCreate);
		expect(bare.sent).toHaveLength(0);

		track(PLAN);
		const sub = setup(async () => "", 1_000, { stateDir: dir, exists: () => false }, {
			hasUI: false,
			sessionManager: { getSessionId: () => "s1", getSessionFile: () => "/tmp/omp-task-1/Worker.jsonl" },
		});
		sub.emit("tool_result", ghPrCreate);
		expect(sub.sent).toHaveLength(0);
	});

	test("unrelated, failed, or URL-less tool results send nothing", () => {
		track(PLAN);
		const { emit, sent } = setup(async () => "", 1_000, { stateDir: dir });
		emit("tool_result", result("bash", { command: "gh pr view 12 --json url" }, PR));
		emit("tool_result", result("read", { path: "notes.md" }, PR));
		emit("tool_result", result("github", { op: "pr_checkout", pr: "12" }, PR));
		emit("tool_result", result("bash", { command: "gh pr create --fill" }, `a pull request for branch "feat" into branch "main" already exists:\n${PR}`, true));
		emit("tool_result", result("bash", { command: "gh pr create --web" }, "Opening github.com/o/r/compare/main...feat in your browser."));
		expect(sent).toHaveLength(0);
	});

	test("Omp's github pr_create and PR-creation MCP tools nudge too", () => {
		track(PLAN);
		const { emit, sent } = setup(async () => "", 1_000, { stateDir: dir });
		emit("tool_result", result("github", { op: "pr_create", title: "Feat" }, `# Created Pull Request #12: Feat\n\nURL: ${PR}`));
		emit("tool_result", result("mcp__acme_github_create_pull_request", { owner: "o", repo: "r" }, JSON.stringify({ number: 13, html_url: PR_13 })));
		expect(sent).toMatchObject([
			{ message: { customType: "ultrathink-sync", details: { url: PR, number: 12 } } },
			{ message: { customType: "ultrathink-sync", details: { url: PR_13, number: 13 } } },
		]);
	});
});

describe("ship nudge", () => {
	let dir = "";
	let shipFlag: string | undefined;
	beforeEach(() => {
		shipFlag = process.env.ULTRATHINK_SHIP;
		delete process.env.ULTRATHINK_SHIP;
		dir = mkdtempSync(join(tmpdir(), "ut-omp-ship-"));
	});
	afterEach(() => {
		if (shipFlag === undefined) delete process.env.ULTRATHINK_SHIP;
		else process.env.ULTRATHINK_SHIP = shipFlag;
		rmSync(dir, { recursive: true, force: true });
	});

	const CONFIG: ShipConfig = { ...DEFAULT_SHIP_CONFIG, enabled: true, skills: ["gsd-"] };
	const OK: ShipPrecheck = { ok: true, reason: "ok", branch: "feat/x", base: "master", ahead: 2 };
	const record = (extra: Record<string, unknown> = {}) =>
		writeSession(dir, {
			sessionId: "s1",
			at: 1,
			result: { xml: "", original: "", root: "BUILD_PROMPT", source: "llm" },
			plan: { graphId: "g-9" } as TrackPlan,
			skill: { name: "gsd-execute-phase", source: "omp" },
			...extra,
		} as unknown as Parameters<typeof writeSession>[1]);
	const ship = (precheck: ShipPrecheck = OK, ctxExtra: Record<string, unknown> = {}, exists: (path: string) => boolean = () => true) =>
		setup(async () => "", 1_000, { stateDir: dir, now: () => 777, exists, shipConfig: () => CONFIG, shipPrecheck: () => precheck }, ctxExtra);
	const statePath = () => join(dir, "sessions", "s1.json");

	test("agent_end sends one ultrathink-ship aside and records nudgedAt", () => {
		record();
		const { emit, sent } = ship();
		emit("agent_end");
		emit("agent_end");
		expect(sent).toEqual([
			{
				message: { customType: "ultrathink-ship", content: expect.any(String), display: true, details: { branch: "feat/x", base: "master", ahead: 2 }, attribution: "agent" },
				options: { deliverAs: "aside" },
			},
		]);
		const message = sent[0]?.message;
		const content = message && typeof message === "object" && "content" in message ? message.content : undefined;
		for (const fact of ["ultrathink-ship", `stateFile=${statePath()}`, "gsd-execute-phase", "feat/x", "master"]) expect(content).toContain(fact);
		expect(JSON.parse(readFileSync(statePath(), "utf8")).ship.nudgedAt).toBe(777);
	});

	test("a later extension instance does not nudge again once nudgedAt is recorded", () => {
		record();
		ship().emit("agent_end");
		const again = ship();
		again.emit("agent_end");
		expect(again.sent).toHaveLength(0);
	});

	test("nothing without a plan, for other skills, after merge/block, when already nudged, or when precheck fails", () => {
		const cases: [Record<string, unknown>, ShipPrecheck?][] = [
			[{ plan: undefined }],
			[{ skill: { name: "review", source: "omp" } }],
			[{ skill: undefined }],
			[{ ship: { phase: "merged", rounds: [], updatedAt: 1 } }],
			[{ ship: { phase: "blocked", rounds: [], updatedAt: 1 } }],
			[{ ship: { phase: "not-done", rounds: [], nudgedAt: 5, updatedAt: 1 } }],
			[{}, { ok: false, reason: "on base", ahead: 0, branch: "master", base: "master" }],
		];
		for (const [extra, precheck] of cases) {
			record(extra);
			const { emit, sent } = ship(precheck);
			emit("agent_end");
			expect(sent).toHaveLength(0);
		}
	});

	test("nothing in a subagent session", () => {
		record();
		const { emit, sent } = ship(OK, { hasUI: false, sessionManager: { getSessionId: () => "s1", getSessionFile: () => "/tmp/omp-task-1/Worker.jsonl" } }, () => false);
		emit("agent_end");
		expect(sent).toHaveLength(0);
	});
});

describe("teach capture", () => {
	let dir = "";
	let shipFlag: string | undefined;
	beforeEach(() => {
		shipFlag = process.env.ULTRATHINK_SHIP;
		delete process.env.ULTRATHINK_SHIP;
		dir = mkdtempSync(join(tmpdir(), "ut-omp-teach-"));
	});
	afterEach(() => {
		if (shipFlag === undefined) delete process.env.ULTRATHINK_SHIP;
		else process.env.ULTRATHINK_SHIP = shipFlag;
		rmSync(dir, { recursive: true, force: true });
	});

	const MESSAGES = [
		{ role: "user", content: [{ type: "text", text: "fix the failing build" }] },
		{
			role: "assistant",
			content: [
				{ type: "text", text: "Running the build." },
				{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "bun run build" } },
			],
			stopReason: "toolUse",
		},
		{ role: "toolResult", toolCallId: "t1", toolName: "bash", isError: true, content: [{ type: "text", text: "error TS2307" }] },
		{ role: "assistant", content: [{ type: "text", text: "Fixed the import." }], stopReason: "stop" },
	];
	const ABORTED = [...MESSAGES.slice(0, -1), { role: "assistant", content: [{ type: "text", text: "stopp" }], stopReason: "aborted" }];

	const teach = (enabled: boolean, capture: CaptureMode, ctxExtra: Record<string, unknown> = {}) => {
		const spawned: { digest: TeachDigest; options: { repoRoot: string; stateDir: string; host: string; env: NodeJS.ProcessEnv } }[] = [];
		const contexts: unknown[] = [];
		const harness = setup(
			async () => "",
			1_000,
			{
				stateDir: dir,
				exists: () => false,
				teachContext: (options) => {
					contexts.push({ host: options.host, cwd: options.cwd, sessionId: options.sessionId, stateDir: options.stateDir });
					return {
						host: "omp",
						cwd: options.cwd ?? "",
						env: options.env ?? {},
						stateDir: join(dir, "teach-state"),
						config: { teach: { ...DEFAULT_TEACH_CONFIG, enabled, capture }, hindsight: DEFAULT_HINDSIGHT_CONFIG },
					};
				},
				spawnObserve: (digest, options) => {
					spawned.push({ digest, options });
					return { spawned: true };
				},
			},
			ctxExtra,
		);
		return { ...harness, spawned, contexts };
	};

	test.each<CaptureMode>(["observe", "auto"])("agent_end spawns one detached observe in %s mode", (capture) => {
		const { emit, spawned, contexts, sent } = teach(true, capture);
		emit("agent_end", { messages: MESSAGES });
		expect(spawned).toHaveLength(1);
		const spawnedOnce = spawned[0];
		if (!spawnedOnce) throw new Error("expected one observe");
		const { digest, options } = spawnedOnce;
		expect(digest).toMatchObject({ host: "omp", sessionId: "s1", cwd: "/repo", outcome: "completed" });
		expect(options).toMatchObject({ stateDir: join(dir, "teach-state"), host: "omp" });
		expect(options.env.ULTRATHINK_HOST).toBe("omp");
		expect(contexts).toEqual([{ host: "omp", cwd: "/repo", sessionId: "s1", stateDir: dir }]);
		expect(sent).toHaveLength(0);
	});

	test.each<[string, boolean, CaptureMode, Record<string, unknown>]>([
		["explicit mode", true, "explicit", {}],
		["Teachable Moments disabled", false, "auto", {}],
		["a subagent session", true, "observe", { hasUI: false, sessionManager: { getSessionId: () => "s1", getSessionFile: () => "/tmp/omp-task-1/Worker.jsonl" } }],
	])("agent_end does not spawn for %s", (_name, enabled, capture, ctxExtra) => {
		const { emit, spawned } = teach(enabled, capture, ctxExtra);
		emit("agent_end", { messages: MESSAGES });
		expect(spawned).toHaveLength(0);
	});

	test("agent_end does not spawn for an aborted run, without messages, or without a session id", () => {
		const { emit, spawned } = teach(true, "observe");
		emit("agent_end", { messages: ABORTED });
		emit("agent_end");
		expect(spawned).toHaveLength(0);
		const anonymous = teach(true, "observe", { sessionManager: { getSessionId: () => "" } });
		anonymous.emit("agent_end", { messages: MESSAGES });
		expect(anonymous.spawned).toHaveLength(0);
	});

	test("a failing capture does not stop the ship nudge", () => {
		writeSession(dir, {
			sessionId: "s1",
			at: 1,
			result: { xml: "", original: "", root: "BUILD_PROMPT", source: "llm" },
			plan: { graphId: "g-9" } as TrackPlan,
			skill: { name: "gsd-execute-phase", source: "omp" },
		} as unknown as Parameters<typeof writeSession>[1]);
		const { emit, sent } = setup(
			async () => "",
			1_000,
			{
				stateDir: dir,
				now: () => 777,
				exists: () => false,
				shipConfig: () => ({ ...DEFAULT_SHIP_CONFIG, enabled: true, skills: ["gsd-"] }),
				shipPrecheck: () => ({ ok: true, reason: "ok", branch: "feat/x", base: "master", ahead: 2 }),
				teachContext: () => {
					throw new Error("boom");
				},
			},
		);
		emit("agent_end", { messages: MESSAGES });
		expect(sent).toHaveLength(1);
		expect(sent[0]?.message).toMatchObject({ customType: "ultrathink-ship" });
	});
});

describe("native binding (D-01, D-02, §7)", () => {
	const INTENT: ModelIntent = {
		host: "omp",
		override: { provider: "", model: "" },
		providerDefaults: {},
		engineSelection: { engine: "auto", source: "config", nativeOptOut: false },
	};
	const flightOf = (model: Model<Api>, runtime: OmpNativeRuntime): OmpPlanRequest => ({
		prompt: "p",
		cwd: "/repo",
		sessionId: "s1",
		model,
		modelSource: "ctx.model",
		native: runtime,
	});
	const engineFor = async (request: OmpPlanRequest, deps: NativeEngineDeps, intent = INTENT, flight = new AbortController()): Promise<SelectedEngine> => {
		const selection = await createNativeEngineSelector(request, flight.signal, deps)(intent, flight.signal);
		if ("skipped" in selection) throw new Error(`unexpected skip: ${selection.skipped}`);
		return selection;
	};
	/** How a completion settled: "resolved" or the rejection's error name. */
	const outcome = (promise: Promise<string>) =>
		promise.then(
			() => "resolved",
			(error: unknown) => (error instanceof Error ? error.name : "non-error"),
		);

	test("every call runs on the flight's one snapshot through one host resolver: one system prompt, one timestamped user message, no tools, no per-call headers", async () => {
		const live = fakeModel("acme", "Sol-1.Opaque");
		const { runtime, log } = fakeRuntime([live]);
		const rec = recorder(planReply);
		const flight = new AbortController();
		const engine = await engineFor(flightOf(live, runtime), { completeSimple: rec.complete, providerDefaults: {} }, INTENT, flight);
		expect(engine.resolution).toMatchObject({ state: "detected", source: "ctx.model", reason: "live-model", provider: "acme", modelId: "Sol-1.Opaque" });
		const stage = new AbortController();
		expect(await engine.complete("SYSTEM 1", "USER 1", stage.signal)).toBe("PLAN");
		expect(await engine.complete("SYSTEM 2", "USER 2", stage.signal)).toBe("PLAN");
		expect(log.resolvers).toHaveLength(1);
		expect(log.resolvers[0]?.model).toBe(live);
		expect(log.resolvers[0]?.sessionId).toBe("s1");
		for (const [index, call] of rec.calls.entries()) {
			expect(call.model).toBe(live);
			expect(Object.keys(call.context).sort()).toEqual(["messages", "systemPrompt"]);
			expect(call.context.systemPrompt).toEqual([`SYSTEM ${index + 1}`]);
			expect(call.context.messages).toEqual([{ role: "user", content: `USER ${index + 1}`, timestamp: expect.any(Number) }]);
			// The resolver callable itself is the key, never an extracted bearer; headers stay the Model's own chain.
			expect(call.options?.apiKey).toBe(log.resolvers[0]?.key);
			expect(call.options?.sessionId).toBe("s1");
			expect(call.options && "headers" in call.options).toBe(false);
			expect(call.options?.signal?.aborted).toBe(false);
		}
		flight.abort();
		expect(rec.calls.every((call) => call.options?.signal?.aborted)).toBe(true);
	});

	test("only text blocks become plan text, in order and without a separator; returned tool calls are never executed", async () => {
		const live = fakeModel("acme", "sol-1");
		const { runtime } = fakeRuntime([live]);
		const rec = recorder(() =>
			reply(
				[
					{ type: "thinking", thinking: "SECRET-THOUGHT" },
					{ type: "text", text: "A" },
					{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "rm -rf /" } },
					{ type: "text", text: "B" },
				],
				{ stopReason: "toolUse" },
			),
		);
		const engine = await engineFor(flightOf(live, runtime), { completeSimple: rec.complete, providerDefaults: {} });
		expect(await engine.complete("s", "u")).toBe("AB");
	});

	test("an error stop reason is a safe classified failure: no partial text, provider message or payload", async () => {
		const live = fakeModel("acme", "sol-1");
		const { runtime } = fakeRuntime([live]);
		const rec = recorder(() => reply([{ type: "text", text: "PARTIAL" }], { stopReason: "error", errorMessage: "SECRET-PROVIDER-BODY", errorStatus: 429 }));
		const engine = await engineFor(flightOf(live, runtime), { completeSimple: rec.complete, providerDefaults: {} });
		const error = await engine.complete("s", "u").catch((caught: unknown) => caught);
		expect(error).toMatchObject({ name: "NativeCompletionError", message: "omp-native completion failed (provider error, HTTP 429)" });
		expect(engine.error()).toBe("omp-native completion failed (provider error, HTTP 429)");
	});

	test("a genuine rejection stays a rejection with a static message; the upstream error stays a private cause", async () => {
		const live = fakeModel("acme", "sol-1");
		const { runtime } = fakeRuntime([live]);
		const upstream = new Error("SECRET-TRANSPORT-DETAIL");
		const rec = recorder(() => {
			throw upstream;
		});
		const engine = await engineFor(flightOf(live, runtime), { completeSimple: rec.complete, providerDefaults: {} });
		const error = await engine.complete("s", "u").catch((caught: unknown) => caught);
		expect(error).toMatchObject({ name: "NativeCompletionError", message: "omp-native completion failed" });
		expect(error).toHaveProperty("cause", upstream);
		expect(error).toBeInstanceOf(Error);
		if (error instanceof Error) expect(Object.keys(error)).not.toContain("cause");
		expect(JSON.stringify(error)).not.toContain("SECRET");
		expect(engine.error()).toBe("omp-native completion failed");
	});

	test("an aborted result, an aborted lifetime and a timeout reject as AbortError; a provider ignoring cancellation never yields a plan", async () => {
		const live = fakeModel("acme", "sol-1");
		const { runtime } = fakeRuntime([live]);
		const aborted = await engineFor(flightOf(live, runtime), {
			completeSimple: recorder(() => reply([{ type: "text", text: "PARTIAL" }], { stopReason: "aborted" })).complete,
			providerDefaults: {},
		});
		expect(await outcome(aborted.complete("s", "u"))).toBe("AbortError");
		const timeout = await engineFor(flightOf(live, runtime), {
			completeSimple: recorder(() => {
				const error = new Error("timed out");
				error.name = "TimeoutError";
				throw error;
			}).complete,
			providerDefaults: {},
		});
		expect(await outcome(timeout.complete("s", "u"))).toBe("AbortError");
		const flight = new AbortController();
		const idle = recorder(planReply);
		const cancelled = await engineFor(flightOf(live, runtime), { completeSimple: idle.complete, providerDefaults: {} }, INTENT, flight);
		flight.abort();
		expect(await outcome(cancelled.complete("s", "u"))).toBe("AbortError");
		expect(idle.calls).toHaveLength(0);
		const late = new AbortController();
		const stubborn = recorder(() => {
			late.abort();
			return reply([{ type: "text", text: "LATE PLAN" }]);
		});
		const ignoring = await engineFor(flightOf(live, runtime), { completeSimple: stubborn.complete, providerDefaults: {} }, INTENT, late);
		expect(await outcome(ignoring.complete("s", "u"))).toBe("AbortError");
	});

	test("flight validity is checked before dispatch and after the answer", async () => {
		const live = fakeModel("acme", "sol-1");
		const { runtime } = fakeRuntime([live]);
		let valid = false;
		const rec = recorder(() => {
			valid = false;
			return reply([{ type: "text", text: "PLAN" }]);
		});
		const engine = await engineFor(flightOf(live, runtime), { completeSimple: rec.complete, providerDefaults: {}, isCurrent: () => valid });
		expect(await outcome(engine.complete("s", "u"))).toBe("AbortError");
		expect(rec.calls).toHaveLength(0);
		valid = true;
		expect(await outcome(engine.complete("s", "u"))).toBe("AbortError");
		expect(rec.calls).toHaveLength(1);
	});

	test("a resolved default is copied once per flight: the host Model is never mutated and later host changes never reach the bound copy", async () => {
		// An unsupported live kind leaves the same provider's catalog default (injected here, never the installed catalog).
		const live = fakeModel("acme", "sol-1", { kind: "image" });
		const fallback = fakeModel("acme", "def-1");
		const before = JSON.stringify(fallback);
		const { runtime, log } = fakeRuntime([fallback]);
		const rec = recorder(planReply);
		const engine = await engineFor(flightOf(live, runtime), { completeSimple: rec.complete, providerDefaults: { acme: "def-1" } });
		expect(engine.resolution).toMatchObject({ state: "default", source: "host-catalog", reason: "active-unavailable", provider: "acme", modelId: "def-1" });
		expect(log.resolves).toContain("acme/def-1");
		await engine.complete("s", "u");
		const bound = rec.calls[0]?.model;
		expect(bound).not.toBe(fallback);
		expect(bound).toEqual(fallback);
		expect(bound?.resolveHeaders).toBe(fallback.resolveHeaders);
		expect(log.resolvers).toHaveLength(1);
		expect(log.resolvers[0]?.model).toBe(bound);
		expect(JSON.stringify(fallback)).toBe(before);
		Object.assign(fallback, { baseUrl: "https://SECRET-MOVED.invalid" });
		await engine.complete("s", "u");
		expect(rec.calls[1]?.model).toBe(bound);
		expect(bound?.baseUrl).toBe("https://SECRET-ENDPOINT.invalid/v1");
	});

	test("an override's bare id is qualified to its provider; a role alias resolves as written", async () => {
		const live = fakeModel("acme", "sol-1");
		const opus = fakeModel("anthropic", "Opus-X");
		const slow = fakeModel("anthropic", "slow-1");
		const { runtime, log } = fakeRuntime([live, opus, slow], { aliases: { "@slow": () => slow } });
		const deps: NativeEngineDeps = { completeSimple: recorder(planReply).complete, providerDefaults: {} };
		const qualified = await engineFor(flightOf(live, runtime), deps, { ...INTENT, override: { provider: "anthropic", model: "Opus-X" } });
		expect(qualified.resolution).toMatchObject({ state: "override", source: "host-override", provider: "anthropic", modelId: "Opus-X" });
		expect(log.resolves).toContain("anthropic/Opus-X");
		const alias = await engineFor(flightOf(live, runtime), deps, { ...INTENT, override: { provider: "", model: "@slow" } });
		expect(alias.resolution).toMatchObject({ state: "override", provider: "anthropic", modelId: "slow-1" });
		expect(log.resolves).toContain("@slow");
	});
});

describe("native planner end to end (D-01, D-02)", () => {
	let root = "";
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "ut-omp-native-"));
	});
	afterEach(() => rmSync(root, { recursive: true, force: true }));
	// No real agent dir, config home or substrate: the planner's env is isolated like the shared host suite's.
	const isolated = () => ({ PI_CODING_AGENT_DIR: join(root, "agent"), XDG_CONFIG_HOME: join(root, "xdg"), CLAUDE_CONFIG_DIR: join(root, "claude"), SUBSTRATE_DISABLED: "1" });
	const request = (extra: Partial<OmpPlanRequest> = {}): OmpPlanRequest => ({
		prompt: "add a widget",
		cwd: root,
		sessionId: "s1",
		config: quietConfig(),
		control: {},
		stateDir: join(root, "state"),
		...extra,
	});

	test("one captured Model and one auth route serve uplift, Graph, every Chain fill and HITL; only the safe record leaves", async () => {
		const live = fakeModel("acme", "sol-1");
		const { runtime, log } = fakeRuntime([live]);
		const stages: string[] = [];
		const rec = recorder((call) => {
			const { stage, text } = stageAnswer(userText(call));
			stages.push(stage);
			return reply([{ type: "thinking", thinking: "SECRET-THOUGHT" }, { type: "text", text }]);
		});
		const events: ProgressEvent[] = [];
		const planner = createNativeEnginePlanner({ completeSimple: rec.complete, providerDefaults: {}, env: isolated() });
		const plan = await planner(request({ model: live, modelSource: "ctx.model", native: runtime }), new AbortController().signal, (event) => events.push(event));
		expect(plan.skipped).toBeUndefined();
		expect(plan.context).not.toBe("");
		expect(stages).toEqual(["uplift", "graph", "fill", "fill", "fill", "fill", "fill", "clarify"]);
		expect(rec.calls.every((call) => call.model === live && call.options?.sessionId === "s1")).toBe(true);
		expect(log.resolvers.map((entry) => [entry.model, entry.sessionId])).toEqual([[live, "s1"]]);
		expect(rec.calls.every((call) => call.options?.apiKey === log.resolvers[0]?.key)).toBe(true);
		expect(plan.modelResolution).toMatchObject({ state: "detected", source: "ctx.model", label: "omp-native:acme/sol-1 [detected]" });
		expect(plan.view?.modelResolution?.label).toBe("omp-native:acme/sol-1 [detected]");
		expect(events.find((event) => event.type === "begin")).toMatchObject({ modelResolution: { state: "detected" } });
		for (const output of [JSON.stringify(plan), JSON.stringify(events)]) expect(output).not.toContain("SECRET");
	});

	for (const { name, level, capability } of [
		{ name: "low", level: "low" as Effort, capability: true },
		{ name: "high", level: "high" as Effort, capability: true },
		{ name: "off", level: "off", capability: true },
		{ name: "inherit", level: "inherit", capability: true },
		{ name: "undefined", level: undefined, capability: true },
		{ name: "absent capability", level: undefined, capability: false },
	] as const) {
		test(`session thinking ${name} is captured once across uplift, Graph, every Chain fill and HITL`, async () => {
			const live = fakeModel("acme", "sol-1");
			const { runtime, log } = fakeRuntime([live]);
			const stages: string[] = [];
			let currentLevel: OmpPlanRequest["thinkingLevel"] = level;
			let reads = 0;
			const rec = recorder((call) => {
				const { stage, text } = stageAnswer(userText(call));
				stages.push(stage);
				// No reentry observation: stages keep the original snapshot rather than drifting to this value.
				currentLevel = "max" as Effort;
				return reply([{ type: "text", text }]);
			});
			const planner = createNativeEnginePlanner({ completeSimple: rec.complete, providerDefaults: {}, env: isolated() });
			const { run, sent } = setup(
				planner,
				1_000,
				{ stateDir: join(root, "state") },
				{ cwd: root, model: live, ...runtime },
				capability
					? {
						getThinkingLevel: () => {
							reads++;
							return currentLevel;
						},
					}
					: {},
			);
			const result = await run("add a widget");
			expect(result).toMatchObject({ message: { customType: "ultrathink-plan" } });
			expect(sent).toEqual([]);
			expect(stages).toEqual(["uplift", "graph", "fill", "fill", "fill", "fill", "fill", "clarify"]);
			expect(reads).toBe(capability ? 1 : 0);
			expect(log.resolvers).toHaveLength(1);
			const resolved = log.resolvers[0];
			if (!resolved) throw new Error("expected a resolver");
			for (const call of rec.calls) {
				expect(call.model).toBe(resolved.model);
				expect(call.options?.apiKey).toBe(resolved.key);
				if (level === "off") {
					expect(call.options?.disableReasoning).toBe(true);
					expect(call.options).not.toHaveProperty("reasoning");
				} else if (level === undefined || level === "inherit") {
					expect(call.options).not.toHaveProperty("reasoning");
					expect(call.options).not.toHaveProperty("disableReasoning");
				} else {
					expect(call.options?.reasoning).toBe(level);
					expect(call.options).not.toHaveProperty("disableReasoning");
				}
				expect(call.options).not.toHaveProperty("forceReasoningOff");
			}
		});
	}

	test("without a live model or override the plan is unresolved with its reason: no completion and no auth", async () => {
		const { runtime, log } = fakeRuntime([]);
		const rec = recorder(planReply);
		const planner = createNativeEnginePlanner({ completeSimple: rec.complete, providerDefaults: {}, env: isolated() });
		const plan = await planner(request({ native: runtime }), new AbortController().signal);
		expect(plan).toMatchObject({ context: "", skipped: "provider-unknown", modelResolution: { state: "unresolved", label: "omp-native:unresolved [provider-unknown]" } });
		expect(rec.calls).toHaveLength(0);
		expect(log.resolvers).toHaveLength(0);
	});

	test("without the host runtime native planning is unavailable, never a guessed route", async () => {
		const rec = recorder(planReply);
		const planner = createNativeEnginePlanner({ completeSimple: rec.complete, providerDefaults: {}, env: isolated() });
		const plan = await planner(request({ model: fakeModel("acme", "sol-1"), modelSource: "ctx.model" }), new AbortController().signal);
		expect(plan).toMatchObject({ context: "", skipped: "native-unavailable", modelResolution: { reason: "native-unavailable" } });
		expect(rec.calls).toHaveLength(0);
	});

	test("a flight cancelled mid-stage returns aborted: no plan text and no further stage", async () => {
		const live = fakeModel("acme", "sol-1");
		const { runtime } = fakeRuntime([live]);
		const flight = new AbortController();
		const rec = recorder((call) => {
			flight.abort();
			return reply([{ type: "text", text: stageAnswer(userText(call)).text }]);
		});
		const planner = createNativeEnginePlanner({ completeSimple: rec.complete, providerDefaults: {}, env: isolated() });
		const plan = await planner(request({ model: live, modelSource: "ctx.model", native: runtime }), flight.signal);
		expect(plan).toMatchObject({ context: "", skipped: "aborted" });
		expect(rec.calls).toHaveLength(1);
	});
});

describe("status and the default planner (§9 paths 5-6)", () => {
	let stateDir = "";
	beforeEach(() => {
		stateDir = mkdtempSync(join(tmpdir(), "ut-omp-status-"));
	});
	afterEach(() => rmSync(stateDir, { recursive: true, force: true }));
	const DETECTED: ModelResolution = {
		version: "1.0.0",
		state: "detected",
		host: "omp",
		transport: "omp-native",
		source: "ctx.model",
		reason: "live-model",
		engineSelection: { engine: "auto", source: "config", nativeOptOut: false },
		api: "acme-chat",
		provider: "acme",
		modelId: "sol-1",
		modelKnown: true,
		label: "omp-native:acme/sol-1 [detected]",
	};

	test("status runs for host omp: before any plan it says the live model is not observed", async () => {
		const { command, notices } = setup(async () => "PLAN", 1_000, { stateDir });
		await command("ultrathink-status");
		expect(notices.at(-1)).toContain("Engine: omp-native:auto (live model not observed)");
	});

	test("status shows this session's latest observed resolution from the planner's events and plan, without any lookup", async () => {
		const { run, command, notices } = setup(
			async (_request, _signal, onEvent) => {
				onEvent?.({ type: "begin", at: 1, sessionId: "s1", engine: DETECTED.label, modelResolution: DETECTED });
				return { context: "PLAN", modelResolution: DETECTED };
			},
			1_000,
			{ stateDir },
		);
		await run();
		await command("ultrathink-status");
		expect(notices.at(-1)).toContain(`Engine: ${DETECTED.label}`);
	});

	test("the default planner is native and in-process: without the host's model runtime it reports native-unavailable, which status shows", async () => {
		const saved = process.env.PI_CODING_AGENT_DIR;
		// The in-process planner's subagent guard reads the agent dir; point it at an empty one.
		process.env.PI_CODING_AGENT_DIR = join(stateDir, "agent");
		try {
			const { run, command, notices, sent } = setup(undefined, 5_000, { stateDir });
			expect(await run("add a widget")).toBeUndefined();
			await flush();
			expect(sent).toHaveLength(0);
			await command("ultrathink-status");
			expect(notices.at(-1)).toContain("Engine: omp-native:unresolved [native-unavailable]");
		} finally {
			if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = saved;
		}
	});
});
