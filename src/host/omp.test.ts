// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeSession } from "../claude/state.ts";
import type { TrackPlan } from "../track/types.ts";
import { DEFAULT_SHIP_CONFIG, type ShipConfig } from "../ship/types.ts";
import { createOmpExtension, type ExtensionAPI, NO_PLAN, type OmpPlan, type OmpPlanner, QUICK_USAGE, type ShipPrecheck } from "./omp.ts";
import type { ProgressEvent } from "./progress.ts";
import type { PlanView } from "./view.ts";

type Handler = (event: { type: "before_agent_start"; prompt: string; systemPrompt: string[] }, ctx: never) => Promise<
	| {
			message?:
				| string
				| { customType?: string; content?: string; display?: boolean; attribution?: string; details?: unknown };
	  }
	| void
>;
type AnyHandler = (event: unknown, ctx: unknown) => unknown;

const MCP = () => ({ linear: "ready", notion: "login", greptile: "none" }) as const;

// Accepts plain-string planners for brevity.
const wrap =
	(plan: (...args: Parameters<OmpPlanner>) => Promise<string | OmpPlan>): OmpPlanner =>
	async (...args) => {
		const result = await plan(...args);
		return typeof result === "string" ? { context: result } : result;
	};

function setup(
	plan: (...args: Parameters<OmpPlanner>) => Promise<string | OmpPlan>,
	raceMs = 1_000,
	extra: { reuseMs?: number; now?: () => number; exists?: (path: string) => boolean; stateDir?: string; shipPrecheck?: (cwd: string) => ShipPrecheck; shipConfig?: (cwd: string) => ShipConfig } = {},
	ctxExtra: Record<string, unknown> = {},
) {
	const handlers = new Map<string, AnyHandler>();
	const sent: { message: unknown; options: unknown }[] = [];
	const renderers: string[] = [];
	const commands = new Map<string, { description?: string; getArgumentCompletions?: (prefix: string) => unknown; handler: AnyHandler }>();
	const userMessages: string[] = [];
	const notices: string[] = [];
	const pi = {
		on: (event: string, h: AnyHandler) => {
			handlers.set(event, h);
		},
		sendMessage: (message: unknown, options: unknown) => {
			sent.push({ message, options });
		},
		sendUserMessage: (content: string) => {
			userMessages.push(content);
		},
		registerCommand: (name: string, options: { handler: AnyHandler }) => {
			commands.set(name, options);
		},
		registerMessageRenderer: (type: string) => {
			renderers.push(type);
		},
	} as unknown as ExtensionAPI;
	createOmpExtension({ plan: wrap(plan), raceMs, mcp: MCP, ...extra })(pi);
	const ctx = { cwd: "/repo", sessionManager: { getSessionId: () => "s1" }, ...ctxExtra };
	const emit = (event: string, payload: Record<string, unknown> = {}) => handlers.get(event)?.({ type: event, ...payload }, ctx);
	const run = (prompt = "do it") =>
		(handlers.get("before_agent_start") as Handler)({ type: "before_agent_start", prompt, systemPrompt: [] }, ctx as never);
	const command = (name: string, args = "") =>
		commands.get(name)?.handler(args, { ...ctx, ui: { notify: (text: string) => void notices.push(text) } });
	return { run, sent, emit, renderers, commands, command, userMessages, notices };
}

function tuiCtx(setWidget?: (key: string, factory: unknown, options: unknown) => void) {
	const widgets: { key: string; factory: unknown; options: unknown }[] = [];
	let renders = 0;
	const tui = { requestRender: () => void renders++ };
	const ui = {
		setWidget:
			setWidget ??
			((key: string, factory: unknown, options: unknown) => {
				widgets.push({ key, factory, options });
			}),
	};
	const line = (width = 200) => {
		const factory = widgets.at(-1)!.factory as (t: typeof tui, theme: unknown) => { render(w: number): readonly string[] };
		return factory(tui, {}).render(width).join("");
	};
	return { ctx: { hasUI: true, mode: "tui", ui, setInterval: () => 0 }, widgets, line, renders: () => renders };
}

function controlled() {
	const gate = Promise.withResolvers<string>();
	let calls = 0;
	const plan = () => {
		calls++;
		return gate.promise;
	};
	return { plan, resolve: gate.resolve, calls: () => calls };
}

// Lets the plan's settle callbacks (catch → then → sendMessage) run.
const flush = async () => {
	for (let i = 0; i < 5; i++) await Promise.resolve();
};

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

	test("key plans again after reuseMs expires", async () => {
		let clock = 0;
		let calls = 0;
		const { run } = setup(
			async () => {
				calls++;
				return "PLAN";
			},
			1_000,
			{ reuseMs: 100, now: () => clock },
		);
		await run();
		await flush();
		clock = 99;
		await run();
		expect(calls).toBe(1);
		clock = 100;
		expect(await run()).toEqual({ message: PLAN_MSG });
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

	test("an older deferred flight stops writing the bar once a newer prompt begins", async () => {
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
		await run("B");
		const b = flights.get("B")!;
		b.onEvent({ type: "begin", at: 2, sessionId: "s1", engine: "grok" });
		b.onEvent({ type: "stage", at: 3, stage: "uplift", phase: "start" });
		const bLine = t.line();
		expect(bLine).toContain("uplift");

		a.onEvent({ type: "stage", at: 4, stage: "think", phase: "start" });
		a.gate.resolve({ context: "PLAN A", view: VIEW });
		await flush();
		expect(sent).toEqual([
			{ message: { ...PLAN_MSG, content: "PLAN A", details: VIEW }, options: { deliverAs: "aside" } },
		]);
		expect(t.line()).toBe(bLine);

		b.onEvent({ type: "stage", at: 5, stage: "think", phase: "start" });
		expect(t.line()).toContain("think");
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
		emit("tool_result", result("mcp__aio_github_create_pull_request", { owner: "o", repo: "r" }, JSON.stringify({ number: 13, html_url: PR_13 })));
		expect(sent).toMatchObject([
			{ message: { customType: "ultrathink-sync", details: { url: PR, number: 12 } } },
			{ message: { customType: "ultrathink-sync", details: { url: PR_13, number: 13 } } },
		]);
	});
});

describe("ship nudge", () => {
	let dir = "";
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "ut-omp-ship-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	const CONFIG: ShipConfig = { ...DEFAULT_SHIP_CONFIG, skills: ["gsd-"] };
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
