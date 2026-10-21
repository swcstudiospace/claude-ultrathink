// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import type { Api, ApiKeyResolver, AssistantMessage, Context, Model, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import { join } from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { defaultConfig } from "../config.ts";
import type { UltrathinkConfig } from "../config.ts";
import { createOmpExtension } from "./omp.ts";
import type { CompleteSimple, ExtensionAPI, OmpNativeRuntime, OmpPlan, OmpPlanner } from "./omp.ts";

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

type OmpOptions = NonNullable<Parameters<typeof createOmpExtension>[0]>;

/** The recorded host surface `setup` returns; consumers import this contract instead of `ReturnType`. */
export interface OmpTestHarness {
	run: (prompt?: string) => unknown;
	sent: { message: unknown; options: unknown }[];
	emit: (event: string, payload?: Record<string, unknown>, context?: Record<string, unknown>) => unknown;
	renderers: string[];
	commands: Map<
		string,
		{ description?: string; getArgumentCompletions?: (prefix: string) => unknown; handler: (event: unknown, ctx: unknown) => unknown }
	>;
	command: (name: string, args?: string) => unknown;
	userMessages: string[];
	notices: string[];
}

export function setup(
	plan: ((...args: Parameters<OmpPlanner>) => Promise<string | OmpPlan>) | undefined,
	raceMs = 1_000,
	extra: Omit<OmpOptions, "plan" | "raceMs" | "mcp"> & Partial<Pick<OmpOptions, "mcp">> = {},
	ctxExtra: Record<string, unknown> = {},
	apiExtra: Pick<ExtensionAPI, "getThinkingLevel"> = {},
	/** Test-only omission seam: a true value leaves raceMs absent at createOmpExtension, proving the real default. */
	omitRaceMs = false,
): OmpTestHarness {
	const handlers = new Map<string, AnyHandler[]>();
	const sent: { message: unknown; options: unknown }[] = [];
	const renderers: string[] = [];
	const commands = new Map<string, { description?: string; getArgumentCompletions?: (prefix: string) => unknown; handler: AnyHandler }>();
	const userMessages: string[] = [];
	const notices: string[] = [];
	const pi = {
		on: (event: string, h: AnyHandler) => {
			const listeners = handlers.get(event) ?? [];
			listeners.push(h);
			handlers.set(event, listeners);
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
		...apiExtra,
	} as unknown as ExtensionAPI;
	// Every flight captures config; a quiet one keeps the suite off the developer's own config files.
	// With omitRaceMs the race property stays absent so the flight proves the real factory default.
	createOmpExtension({ ...(plan ? { plan: wrap(plan) } : {}), ...(omitRaceMs ? {} : { raceMs }), mcp: MCP, config: () => quietConfig(), ...extra })(pi);
	const ctx = { cwd: "/repo", sessionManager: { getSessionId: () => "s1" }, ...ctxExtra };
	const emit = (event: string, payload: Record<string, unknown> = {}, context: Record<string, unknown> = ctx) => {
		let result: unknown;
		for (const handler of handlers.get(event) ?? []) result = handler({ type: event, ...payload }, context);
		return result;
	};
	const run = (prompt = "do it") =>
		(handlers.get("before_agent_start")?.[0] as Handler)({ type: "before_agent_start", prompt, systemPrompt: [] }, ctx as never);
	const command = (name: string, args = "") =>
		commands
			.get(name)
			?.handler(args, {
				...ctx,
				// Keep harness-provided host UI (e.g. a `custom` recorder) while still recording notifications.
				ui: { notify: (text: string) => void notices.push(text), ...((ctx as Record<string, unknown>).ui as Record<string, unknown> | undefined ?? {}) },
			});
	return { run, sent, emit, renderers, commands, command, userMessages, notices };
}

export function tuiCtx(setWidget?: (key: string, factory: unknown, options: unknown) => void) {
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

export function controlled() {
	const gate = Promise.withResolvers<string>();
	let calls = 0;
	const plan = () => {
		calls++;
		return gate.promise;
	};
	return { plan, resolve: gate.resolve, calls: () => calls };
}

// Lets the plan's settle callbacks (catch → then → sendMessage) run.
export const flush = async () => {
	for (let i = 0; i < 5; i++) await Promise.resolve();
};

/** Explicit pipeline controls and disposable lookup roots, without inheriting the parent environment. */
export function isolatedPlanEnv(root: string): Record<string, string> {
	return {
		HOME: join(root, "home"),
		XDG_CONFIG_HOME: join(root, "xdg"),
		CLAUDE_CONFIG_DIR: join(root, "claude"),
		PI_CODING_AGENT_DIR: join(root, "agent"),
		ULTRATHINK_STATE_DIR: join(root, "state"),
		ULTRATHINK_MCP_STORE: join(root, "mcp-credentials.json"),
		ULTRATHINK_DECISIONS: "0",
		SUBSTRATE_DISABLED: "1",
	};
}

/** No Decisions points, lessons or trackers by default; pipeline callers use isolatedPlanEnv for the real kill switch. */
export function quietConfig(patch?: (config: UltrathinkConfig) => void): UltrathinkConfig {
	const config = defaultConfig();
	config.decisions.points = [];
	config.teach.enabled = false;
	config.track.enabled = false;
	patch?.(config);
	return config;
}

/** A synthetic whole Model: opaque ids, endpoint and header sentinels, nested routing data and a header resolver. */
export function fakeModel(provider: string, id: string, extra: Record<string, unknown> = {}): Model<Api> {
	const model = {
		provider,
		id,
		name: id,
		api: "acme-chat",
		providerType: "acme-type",
		baseUrl: "https://SECRET-ENDPOINT.invalid/v1",
		headers: { "x-api-key": "SECRET-HEADER" },
		resolveHeaders: async () => ({ authorization: "Bearer SECRET-TOKEN" }),
		compat: { routing: { order: ["a", "b"] } },
		input: ["text"],
		...extra,
	};
	// Synthetic: the catalog's other required fields (identity, cost, windows) play no part in native planning.
	return model as unknown as Model<Api>;
}

interface RuntimeLog {
	resolves: string[];
	resolvers: Array<{ model: Model<Api>; sessionId: string | undefined; key: ApiKeyResolver }>;
}

/** The host's `ctx.models` and `ctx.modelRegistry` over a fixed authenticated set and role aliases; it records every use. */
export function fakeRuntime(
	available: Model<Api>[],
	options: { current?: () => Model<Api> | undefined; aliases?: Record<string, () => Model<Api> | undefined> } = {},
): { runtime: OmpNativeRuntime; log: RuntimeLog } {
	const log: RuntimeLog = { resolves: [], resolvers: [] };
	const runtime: OmpNativeRuntime = {
		models: {
			current: () => options.current?.(),
			resolve: (spec) => {
				log.resolves.push(spec);
				const alias = options.aliases?.[spec];
				return alias ? alias() : available.find((model) => `${model.provider}/${model.id}` === spec);
			},
		},
		modelRegistry: {
			resolver: (model, sessionId) => {
				const key: ApiKeyResolver = async () => "SECRET-KEY";
				log.resolvers.push({ model, sessionId, key });
				return key;
			},
		},
	};
	return { runtime, log };
}

interface NativeCall {
	model: Model<Api>;
	context: Context;
	options: SimpleStreamOptions | undefined;
}

/** A recording `completeSimple`: the deterministic suite never reaches a provider or live auth. */
export function recorder(answer: (call: NativeCall) => AssistantMessage | Promise<AssistantMessage>): { complete: CompleteSimple; calls: NativeCall[] } {
	const calls: NativeCall[] = [];
	const complete: CompleteSimple = async (model, context, options) => {
		const call = { model, context, options };
		calls.push(call);
		return answer(call);
	};
	return { complete, calls };
}

/** An AssistantMessage fixture; usage and response metadata play no part in planning. */
export const reply = (content: unknown[], extra: Record<string, unknown> = {}): AssistantMessage =>
	({ role: "assistant", content, api: "acme-chat", provider: "acme", model: "m", usage: {}, stopReason: "stop", ...extra }) as unknown as AssistantMessage;
export const planReply = () => reply([{ type: "text", text: "PLAN" }]);

/** The text of a native call's one user message. */
export function userText(call: NativeCall): string {
	const message = call.context.messages[0];
	return message?.role === "user" && typeof message.content === "string" ? message.content : "";
}

/** Answers uplift, Graph, node fill and clarify calls by payload, as the shared host suite does, and names the stage. */
export function stageAnswer(user: string): { stage: string; text: string } {
	if (user.includes("<user_request>")) return { stage: "uplift", text: "<BUILD_PROMPT><ORIGINAL>add a widget</ORIGINAL></BUILD_PROMPT>" };
	if (user.startsWith("<spec>")) return { stage: "clarify", text: JSON.stringify({ questions: [] }) };
	if (user.includes("current_node")) {
		const id = user.match(/current_node id="([^"]+)"/)?.[1] ?? "n?";
		const steps = Array.from({ length: 5 }, (_, i) => `${i + 1}. ${id} step ${i + 1}`).join(" ");
		return { stage: "fill", text: `<node><rationale>${steps}</rationale><conclusion>c ${id}</conclusion></node>` };
	}
	const nodes = Array.from({ length: 5 }, (_, i) => ({
		id: `n${i + 1}`,
		title: `T${i + 1}`,
		kind: i === 0 ? "understand" : i === 4 ? "synthesize" : "generate",
		question: `Q${i + 1}`,
		depends_on: i === 0 ? [] : [`n${i}`],
	}));
	return { stage: "graph", text: JSON.stringify({ goal: "Ship it", nodes }) };
}

/** Coincident-handoff insertion order exercised against the real host consumer. */
export type HandoffOrder = "provider-first" | "race-first";

/** Observable coincident-handoff boundary proof reported by the spawned child. */
export interface ChildHandoffProof {
	order: HandoffOrder;
	dueMs: number;
	raceDue: number;
	providerDue: number;
	raceSeq: number;
	providerSeq: number;
	firedRoles: string[];
	raceFired: boolean;
	providerFired: boolean;
	raceCleared: boolean;
	inlineContent: string | null;
	pending: boolean;
	asideContent: string | null;
	asideCustomType: string | null;
	asideDeliverAs: string | null;
}

/**
 * Elapsed-lifetime proof in a spawned child: the child imports the real extension and the real
 * native pipeline, replaces only its own setTimeout/clearTimeout with a due-time/insertion-order
 * queue, fires queued callbacks through 600001 ms, then releases the provider gate and requires
 * exactly one real plan aside. The parent suite process keeps its real clock; a watchdog kills a
 * hung child and disposable roots are removed in finally on both sides.
 */
export async function runChildLifetimeScenario(scenario: {
	maxRunMs?: number;
	cancelHung: boolean;
	handoffOrder?: HandoffOrder;
}): Promise<{ planAsides: number; nativeCalls: number; handoff?: ChildHandoffProof }> {
	const root = mkdtempSync(join(tmpdir(), "ut-omp-life-"));
	try {
		const hostDir = fileURLToPath(new URL("./", import.meta.url));
		const script = join(root, "lifetime-scenario.ts");
		writeFileSync(script, childLifetimeSource(hostDir, scenario, root));
		const proc = Bun.spawn([process.execPath, script], {
			stdout: "pipe",
			stderr: "pipe",
			stdin: "ignore",
		});
		let timedOut = false;
		const watchdog = setTimeout(() => {
			timedOut = true;
			try {
				proc.kill("SIGKILL");
			} catch {}
		}, 90_000);
		let exited = false;
		try {
			// Drain both pipes while the child runs: awaiting exit first can deadlock once a pipe fills.
			const outText = new Response(proc.stdout).text();
			const errText = new Response(proc.stderr).text();
			const code = await proc.exited;
			exited = true;
			const [out, err] = await Promise.all([outText, errText]);
			if (timedOut) throw new Error("child lifetime scenario timed out after 90 s: " + err.slice(-2000));
			if (code !== 0) throw new Error("child lifetime scenario exited " + code + ": " + err.slice(-2000));
			const line = out.split("\n").find((entry) => entry.startsWith("SCENARIO-RESULT "));
			if (!line) throw new Error("child lifetime scenario printed no result: " + err.slice(-2000));
			const parsed: unknown = JSON.parse(line.slice("SCENARIO-RESULT ".length));
			if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
				throw new Error("child lifetime scenario result malformed: " + line);
			}
			if (!("planAsides" in parsed) || !("nativeCalls" in parsed)) {
				throw new Error("child lifetime scenario result malformed: " + line);
			}
			const planAsides: unknown = parsed.planAsides;
			const nativeCalls: unknown = parsed.nativeCalls;
			if (typeof planAsides !== "number" || typeof nativeCalls !== "number") {
				throw new Error("child lifetime scenario result malformed: " + line);
			}
			if (scenario.handoffOrder === undefined) return { planAsides, nativeCalls };
			if (!("handoff" in parsed)) throw new Error("child handoff proof missing: " + line);
			const handoffValue: unknown = parsed.handoff;
			if (typeof handoffValue !== "object" || handoffValue === null || Array.isArray(handoffValue)) {
				throw new Error("child handoff proof missing: " + line);
			}
			if (
				!("order" in handoffValue) ||
				!("dueMs" in handoffValue) ||
				!("raceDue" in handoffValue) ||
				!("providerDue" in handoffValue) ||
				!("raceSeq" in handoffValue) ||
				!("providerSeq" in handoffValue) ||
				!("firedRoles" in handoffValue) ||
				!("raceFired" in handoffValue) ||
				!("providerFired" in handoffValue) ||
				!("raceCleared" in handoffValue) ||
				!("inlineContent" in handoffValue) ||
				!("pending" in handoffValue) ||
				!("asideContent" in handoffValue) ||
				!("asideCustomType" in handoffValue) ||
				!("asideDeliverAs" in handoffValue)
			) {
				throw new Error("child handoff proof malformed: " + line);
			}
			const order: unknown = handoffValue.order;
			const dueMs: unknown = handoffValue.dueMs;
			const raceDue: unknown = handoffValue.raceDue;
			const providerDue: unknown = handoffValue.providerDue;
			const raceSeq: unknown = handoffValue.raceSeq;
			const providerSeq: unknown = handoffValue.providerSeq;
			const firedRoles: unknown = handoffValue.firedRoles;
			const raceFired: unknown = handoffValue.raceFired;
			const providerFired: unknown = handoffValue.providerFired;
			const raceCleared: unknown = handoffValue.raceCleared;
			const inlineContent: unknown = handoffValue.inlineContent;
			const pending: unknown = handoffValue.pending;
			const asideContent: unknown = handoffValue.asideContent;
			const asideCustomType: unknown = handoffValue.asideCustomType;
			const asideDeliverAs: unknown = handoffValue.asideDeliverAs;
			if ((order !== "provider-first" && order !== "race-first") || order !== scenario.handoffOrder) {
				throw new Error("child handoff proof order mismatch: " + line);
			}
			if (
				typeof dueMs !== "number" ||
				typeof raceDue !== "number" ||
				typeof providerDue !== "number" ||
				typeof raceSeq !== "number" ||
				typeof providerSeq !== "number" ||
				!Array.isArray(firedRoles) ||
				!firedRoles.every((entry: unknown) => typeof entry === "string") ||
				typeof raceFired !== "boolean" ||
				typeof providerFired !== "boolean" ||
				typeof raceCleared !== "boolean" ||
				(inlineContent !== null && typeof inlineContent !== "string") ||
				typeof pending !== "boolean" ||
				(asideContent !== null && typeof asideContent !== "string") ||
				(asideCustomType !== null && typeof asideCustomType !== "string") ||
				(asideDeliverAs !== null && typeof asideDeliverAs !== "string")
			) {
				throw new Error("child handoff proof malformed: " + line);
			}
			return {
				planAsides,
				nativeCalls,
				handoff: {
					order,
					dueMs,
					raceDue,
					providerDue,
					raceSeq,
					providerSeq,
					firedRoles,
					raceFired,
					providerFired,
					raceCleared,
					inlineContent,
					pending,
					asideContent,
					asideCustomType,
					asideDeliverAs,
				},
			};
		} finally {
			clearTimeout(watchdog);
			// A throw above must not leave the child running or the watchdog armed.
			if (!exited) {
				try {
					proc.kill("SIGKILL");
				} catch {}
			}
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

/**
 * The child program behind runChildLifetimeScenario, built from static author-time imports of the
 * real extension, the real native pipeline, and the shared test recorders. Its only fixture is a
 * child-local timer queue with due-time/insertion-order firing, clear support, unref handles, and
 * microtask drains between callbacks; I/O and delivery use real started/completed/delivered
 * barriers, never the parent process clock. No paid provider, no live auth, disposable roots only.
 */
function childLifetimeSource(hostDir: string, scenario: { maxRunMs?: number; cancelHung: boolean; handoffOrder?: HandoffOrder }, parentRoot: string): string {
	const ompPath = JSON.stringify(join(hostDir, "omp.ts"));
	const helpersPath = JSON.stringify(join(hostDir, "omp-test.helpers.ts"));
	const planPath = JSON.stringify(join(hostDir, "plan.ts"));
	const configPath = JSON.stringify(join(hostDir, "..", "config.ts"));
	const progressPath = JSON.stringify(join(hostDir, "progress.ts"));
	const maxRunMs = JSON.stringify(scenario.maxRunMs);
	const cancelHung = JSON.stringify(scenario.cancelHung);
	const handoffOrder = JSON.stringify(scenario.handoffOrder ?? null);
	const parentRootPath = JSON.stringify(parentRoot);
	return [
		"import { createNativeEngineSelector } from " + ompPath + ";",
		"import { fakeModel, fakeRuntime, isolatedPlanEnv, quietConfig, recorder, reply, setup, stageAnswer, userText } from " + helpersPath + ";",
		"import { planPrompt } from " + planPath + ";",
		"import type { UltrathinkConfig } from " + configPath + ";",
		"import type { OmpPlanner } from " + ompPath + ";",
		"import type { PlanResponse } from " + planPath + ";",
		"import type { ProgressEvent } from " + progressPath + ";",
		"import { existsSync, mkdtempSync, rmSync } from 'node:fs';",
		"import { join } from 'node:path';",
		"const PARENT_ROOT: string = " + parentRootPath + ";",
		"",
		"const SCENARIO_MAX_RUN_MS: number | undefined = " + maxRunMs + ";",
		"const SCENARIO_CANCEL_HUNG: boolean = " + cancelHung + ";",
		"const SCENARIO_HANDOFF_ORDER: string | null = " + handoffOrder + ";",
		"",
		"const realSetTimeout: typeof setTimeout = globalThis.setTimeout;",
		"const realClearTimeout: typeof clearTimeout = globalThis.clearTimeout;",
		"",
		"interface QueueEntry {",
		"	due: number;",
		"	seq: number;",
		"	callback: (...args: unknown[]) => void;",
		"	args: unknown[];",
		"	cleared: boolean;",
		"	handle: unknown;",
		"}",
		"",
		"let virtualNow = 0;",
		"let insertion = 0;",
		"const queue: QueueEntry[] = [];",
		"const handleToEntry = new Map<unknown, QueueEntry>();",
		"interface QueueMark { due: number; seq: number; handle: unknown; }",
		"const scheduledLog: QueueMark[] = [];",
		"const firedLog: QueueMark[] = [];",
		"const clearedLog: unknown[] = [];",
		"",
		"function virtualSetTimeout(callback: (...args: unknown[]) => void, delay?: unknown, ...args: unknown[]): unknown {",
		"	const ms = typeof delay === 'number' && Number.isFinite(delay) && delay > 0 ? delay : 0;",
		"	const entry: QueueEntry = { due: virtualNow + ms, seq: insertion++, callback, args, cleared: false, handle: undefined };",
		"	const handle = {",
		"		unref(): unknown { return handle; },",
		"		ref(): unknown { return handle; },",
		"		hasRef(): boolean { return false; },",
		"	};",
		"	entry.handle = handle;",
		"	queue.push(entry);",
		"	handleToEntry.set(handle, entry);",
		"	scheduledLog.push({ due: entry.due, seq: entry.seq, handle });",
		"	return handle;",
		"}",
		"",
		"function virtualClearTimeout(handle: unknown): void {",
		"	const entry = handleToEntry.get(handle);",
		"	if (entry !== undefined) {",
		"		entry.cleared = true;",
		"		clearedLog.push(handle);",
		"		handleToEntry.delete(handle);",
		"	}",
		"}",
		"",
		"async function tick(rounds: number): Promise<void> {",
		"	for (let i = 0; i < rounds; i++) await Promise.resolve();",
		"}",
		"",
		"async function fireThrough(limit: number): Promise<void> {",
		"	for (;;) {",
		"		let pick: QueueEntry | undefined = undefined;",
		"		for (const entry of queue) {",
		"			if (entry.cleared || entry.due > limit) continue;",
		"			if (pick === undefined || entry.due < pick.due || (entry.due === pick.due && entry.seq < pick.seq)) pick = entry;",
		"		}",
		"		if (pick === undefined) break;",
		"		pick.cleared = true;",
		"		queue.splice(queue.indexOf(pick), 1);",
		"		handleToEntry.delete(pick.handle);",
		"		virtualNow = pick.due;",
		"		firedLog.push({ due: pick.due, seq: pick.seq, handle: pick.handle });",
		"		pick.callback(...pick.args);",
		"		await tick(25);",
		"	}",
		"	virtualNow = Math.max(virtualNow, limit);",
		"	await tick(25);",
		"}",
		"",
		"function fail(message: string): never {",
		"	throw new Error(message);",
		"}",
		"",
		"function check(cond: unknown, message: string): void {",
		"	if (!cond) fail(message);",
		"}",
		"",
		"function isObject(value: unknown): value is Record<string, unknown> {",
		"	return typeof value === 'object' && value !== null;",
		"}",
		"",
		"function messageOf(value: unknown): Record<string, unknown> | undefined {",
		"	if (!isObject(value)) return undefined;",
		"	const message = value.message;",
		"	return isObject(message) ? message : undefined;",
		"}",
		"",
		"function customTypeOf(value: unknown): string | undefined {",
		"	const message = messageOf(value);",
		"	if (message === undefined) return undefined;",
		"	return typeof message.customType === 'string' ? message.customType : undefined;",
		"}",
		"",
		"function contentOf(value: unknown): unknown {",
		"	return messageOf(value)?.content;",
		"}",
		"",
		"function deliverAsOf(value: unknown): unknown {",
		"	if (!isObject(value)) return undefined;",
		"	const options = value.options;",
		"	return isObject(options) ? options.deliverAs : undefined;",
		"}",
		"",
		"function displayOnlyCard(value: unknown): boolean {",
		"	if (customTypeOf(value) !== 'ultrathink-activity') return false;",
		"	const options = isObject(value) ? value.options : undefined;",
		"	return isObject(options) && options.deliverAs === 'nextTurn' && options.triggerTurn === false;",
		"}",
		"",
		"async function runScenario(root: string): Promise<{ planAsides: number; nativeCalls: number }> {",
		"	const live = fakeModel('acme', 'sol-1');",
		"	const holder = fakeRuntime([live], { current: () => live });",
		"	const runtime = holder.runtime;",
		"	const log = holder.log;",
		"	const config = quietConfig((value: UltrathinkConfig) => {",
		"		value.track.enabled = true;",
		"		value.linear.team = 'Team';",
		"	});",
		"	const stateDir = join(root, 'state');",
		"	let nativeCalls = 0;",
		"	const stages: string[] = [];",
		"	const events: ProgressEvent[] = [];",
		"	let tracks = 0;",
		"	let providerStarted = false;",
		"	let startResolve: () => void = () => {};",
		"	const startedGate = new Promise<void>((resolve) => { startResolve = resolve; });",
		"	let gateReleased = false;",
		"	let releaseProvider: () => void = () => {};",
		"	const providerGate = new Promise<void>((resolve) => { releaseProvider = resolve; });",
		"	let planResolve: (value: PlanResponse) => void = () => {};",
		"	const planDone = new Promise<PlanResponse>((resolve) => { planResolve = resolve; });",
		"	let successorResolve: () => void = () => {};",
		"	const successorStarted = new Promise<void>((resolve) => { successorResolve = resolve; });",
		"	let successorDoneResolve: (value: unknown) => void = () => {};",
		"	const successorDone = new Promise<unknown>((resolve) => { successorDoneResolve = resolve; });",
		"	let releaseSuccessor: () => void = () => {};",
		"	const successorGate = new Promise<void>((resolve) => { releaseSuccessor = resolve; });",
		"	let successorIsCurrent: (() => boolean) | undefined = undefined;",
		"	let successorSignal: AbortSignal | undefined = undefined;",
		"	let capturedIsCurrent: (() => boolean) | undefined = undefined;",
		"	let capturedSignal: AbortSignal | undefined = undefined;",
		"	const rec = recorder((call) => {",
		"		nativeCalls++;",
		"		if (nativeCalls === 1 && !providerStarted) {",
		"			providerStarted = true;",
		"			startResolve();",
		"		}",
		"		const figured = stageAnswer(userText(call));",
		"		stages.push(figured.stage);",
		"		const answer = () => reply([{ type: 'thinking', thinking: 'SECRET-THOUGHT' }, { type: 'text', text: figured.text }]);",
		"		if (nativeCalls === 1 && !gateReleased) return providerGate.then(answer);",
		"		return answer();",
		"	});",
		"	const emptyGround = { status: 'none', chunks: [], chars: 0, ms: 0, datasets: 0 };",
		"	const planner: OmpPlanner = async (request, signal, onEvent) => {",
		"		if (request.prompt === 'add a different widget') {",
		"			successorIsCurrent = request.isCurrent;",
		"			successorSignal = signal;",
		"			successorResolve();",
		"			await successorGate;",
		"			const inline = { context: 'PLAN B' };",
		"			successorDoneResolve(inline);",
		"			return inline;",
		"		}",
		"		capturedIsCurrent = request.isCurrent;",
		"		capturedSignal = signal;",
		"		const response = await planPrompt(",
		"			{ host: 'omp', session_id: request.sessionId, prompt: request.prompt, cwd: request.cwd },",
		"			isolatedPlanEnv(root),",
		"			{",
		"				config: request.config,",
		"				control: request.control,",
		"				stateDir,",
		"				signal,",
		"				native: createNativeEngineSelector(request, signal, { completeSimple: rec.complete, providerDefaults: {}, isCurrent: request.isCurrent }),",
		"				ground: () => Promise.resolve(emptyGround),",
		"				createTracker: () => async () => { tracks++; return undefined; },",
		"				progress: (entry: ProgressEvent) => {",
		"					events.push(entry);",
		"					if (onEvent) onEvent(entry);",
		"				},",
		"			},",
		"		);",
		"		planResolve(response);",
		"		return response;",
		"	};",
		"	const extra: Record<string, unknown> = { stateDir, config: () => config };",
		"	if (SCENARIO_MAX_RUN_MS !== undefined) extra['maxRunMs'] = SCENARIO_MAX_RUN_MS;",
		"	// The session thinking level every native stage must keep across the cutoff; never the unset default.",
		"	const h = setup(planner, 1000, extra, { cwd: root, model: live, ...runtime }, { getThinkingLevel: () => 'low' }, true);",
		"	let sentinel = false;",
		"	const childSetTimeout = globalThis.setTimeout as unknown as (callback: () => void, ms: number) => unknown; // child-local virtual timer handle is opaque to the host clock",
		"	childSetTimeout(() => { sentinel = true; }, 600000);",
		"	const pendingPromise: unknown = h.run('add a widget');",
		"	await startedGate;",
		"	await tick(25);",
		"	check(capturedSignal !== undefined && !capturedSignal.aborted, 'flight aborted before the race');",
		"	check(capturedIsCurrent !== undefined && capturedIsCurrent(), 'flight not current before the race');",
		"	await fireThrough(25000);",
		"	const pending: unknown = await pendingPromise;",
		"	check(customTypeOf(pending) === 'ultrathink-pending', 'expected the real pending handoff at 25000ms');",
		"	check(nativeCalls === 1, 'expected one pending native call at handoff, saw ' + nativeCalls);",
		"	check(capturedSignal !== undefined && !capturedSignal.aborted, 'flight aborted at the handoff');",
		"	await fireThrough(600001);",
		"	check(sentinel, 'cutoff sentinel never fired: virtual clock did not cross 600000ms');",
		"	check(capturedSignal !== undefined && !capturedSignal.aborted, 'unbounded flight aborted beyond the former cutoff');",
		"	check(capturedIsCurrent !== undefined && capturedIsCurrent(), 'unbounded flight lost currentness beyond the former cutoff');",
		"	check(h.sent.length === 0, 'unexpected delivery beyond the cutoff');",
		"	check(nativeCalls === 1, 'pipeline retried beyond the cutoff: ' + nativeCalls + ' native calls');",
		"	check(log.resolvers.length === 1, 'resolver rebound beyond the cutoff');",
		"	if (SCENARIO_CANCEL_HUNG) {",
		"		h.emit('turn_start');",
		"		const inlinePromise: unknown = h.run('add a different widget');",
		"		// The successor resolves in microtasks: prove it started before reading the race, never by firing the clock first.",
		"		await successorStarted;",
		"		await tick(25);",
		"		check(!gateReleased, 'provider gate released before the successor admitted');",
		"		check(nativeCalls === 1, 'provider advanced while the successor was pending: ' + nativeCalls + ' native calls');",
		"		check(capturedSignal !== undefined && capturedSignal.aborted, 'cancelled flight lifetime still running');",
		"		check(capturedIsCurrent !== undefined && !capturedIsCurrent(), 'cancelled flight still current');",
		"		check(successorSignal !== undefined && !successorSignal.aborted, 'successor aborted while pending');",
		"		check(successorIsCurrent !== undefined && successorIsCurrent(), 'successor not current while pending');",
		"		releaseSuccessor();",
		"		const inline: unknown = await inlinePromise;",
		"		const inlineDelivered = customTypeOf(inline) !== 'ultrathink-pending';",
		"		if (inlineDelivered) {",
		"			check(contentOf(inline) === 'PLAN B', 'successor did not deliver its inline plan');",
		"		} else {",
		"			await successorDone;",
		"			for (let round = 0; round < 200 && h.sent.length === 0; round++) await Promise.resolve();",
		"			check(h.sent.length === 1, 'successor pending never delivered its aside');",
		"			check(contentOf(h.sent[0]) === 'PLAN B', 'successor aside lost its plan content');",
		"		}",
		"		check(h.sent.length === (inlineDelivered ? 0 : 1), 'unexpected aside before the hung provider released');",
		"		check(capturedSignal !== undefined && capturedSignal.aborted, 'cancelled flight lifetime still running');",
		"		check(successorSignal !== undefined && !successorSignal.aborted, 'successor aborted at delivery');",
		"		check(successorIsCurrent !== undefined && !successorIsCurrent(), 'successor still current after settlement');",
		"		check(rec.calls.every((call) => call.options !== undefined && call.options.reasoning === 'low'), 'a native call left the captured thinking effort');",
		"		globalThis.setTimeout = realSetTimeout;",
		"		globalThis.clearTimeout = realClearTimeout;",
		"		gateReleased = true;",
		"		releaseProvider();",
		"		await planDone;",
		"		await new Promise<void>((resolve) => realSetTimeout(resolve, 50));",
		"		check(h.sent.length === (inlineDelivered ? 0 : 1), 'cancelled flight delivered late');",
		"		check(tracks === 0, 'cancelled flight admitted tracker rows');",
		"		for (const path of ['sessions/s1.json', 'sessions/s1.xml', 'last.json', 'last-plan.json']) {",
		"			check(!existsSync(join(stateDir, path)), 'cancelled flight wrote ' + path);",
		"		}",
		"		return { planAsides: inlineDelivered ? 0 : 1, nativeCalls };",
		"	}",
		"	globalThis.setTimeout = realSetTimeout;",
		"	globalThis.clearTimeout = realClearTimeout;",
		"	gateReleased = true;",
		"	releaseProvider();",
		"	const response: PlanResponse = await planDone;",
		"	const asideCount = (): number => h.sent.filter((entry) => deliverAsOf(entry) === 'aside').length;",
		"	for (let round = 0; round < 200 && asideCount() === 0; round++) await Promise.resolve();",
		"	check(asideCount() === 1, 'expected exactly one plan aside, saw ' + asideCount());",
		"	check(h.sent.every((entry) => deliverAsOf(entry) === 'aside' || displayOnlyCard(entry)), 'a non-aside delivery is not a display-only activity card');",
		"	const delivered = h.sent.length;",
		"	const aside: unknown = h.sent.find((entry) => deliverAsOf(entry) === 'aside');",
		"	check(deliverAsOf(aside) === 'aside', 'aside missing deliverAs');",
		"	check(customTypeOf(aside) === 'ultrathink-plan', 'aside missing plan customType');",
		"	const asideContent: unknown = contentOf(aside);",
		"	check(typeof asideContent === 'string' && asideContent.indexOf('<BUILD_PROMPT>') !== -1, 'aside missing real plan content');",
		"	check(asideContent === response.context, 'aside content differs from the pipeline response');",
		"	check(JSON.stringify(stages) === JSON.stringify(['uplift', 'graph', 'fill', 'fill', 'fill', 'fill', 'fill', 'clarify']), 'unexpected stage sequence ' + JSON.stringify(stages));",
		"	check(response.modelResolution && response.modelResolution.state === 'detected', 'model resolution not detected');",
		"	check(response.modelResolution.source === 'ctx.model', 'model resolution lost its source');",
		"	check(response.modelResolution.label === 'omp-native:acme/sol-1 [detected]', 'unexpected resolution label');",
		"	check(nativeCalls === 8, 'expected eight native completions, saw ' + nativeCalls);",
		"	check(log.resolvers.length === 1, 'resolver rebound across the cutoff');",
		"	const snapshot = log.resolvers[0]?.model;",
		"	check(rec.calls.every((call) => call.model === snapshot), 'a native call left the captured Model snapshot');",
		"	check(rec.calls.every((call) => call.options && call.options.sessionId === 's1'), 'a native call left the captured session');",
		"	check(rec.calls.every((call) => call.options && call.options.apiKey === log.resolvers[0]?.key), 'a native call left the captured auth route');",
		"	check(rec.calls.every((call) => call.options !== undefined && call.options.reasoning === 'low'), 'a native call left the captured thinking effort');",
		"	check(rec.calls.every((call) => call.options === undefined || call.options.disableReasoning !== true), 'a native call disabled the captured thinking effort');",
		"	check(JSON.stringify(response).indexOf('SECRET') === -1, 'secret material escaped into the plan response');",
		"	check(JSON.stringify(events).indexOf('SECRET') === -1, 'secret material escaped into progress events');",
		"	check(tracks === 1, 'expected one tracker admission, saw ' + tracks);",
		"	for (const path of ['sessions/s1.json', 'sessions/s1.xml', 'last.json', 'last-plan.json']) {",
		"		check(existsSync(join(stateDir, path)), 'successful pipeline missing ' + path);",
		"	}",
		"	const again: unknown = await h.run('add a widget');",
		"	check(again === undefined, 'settled reentry planned again');",
		"	check(nativeCalls === 8, 'reentry issued a second pipeline');",
		"	check(h.sent.length === delivered, 'reentry duplicated delivery');",
		"	await new Promise<void>((resolve) => realSetTimeout(resolve, 25));",
		"	check(capturedSignal !== undefined && !capturedSignal.aborted, 'successful flight aborted late');",
		"	check(h.sent.length === delivered, 'late duplicate delivery');",
		"	check(capturedIsCurrent !== undefined && !capturedIsCurrent(), 'settled flight still current');",
		"	return { planAsides: 1, nativeCalls };",
		"}",
		"interface HandoffProof {",
		"	order: string;",
		"	dueMs: number;",
		"	raceDue: number;",
		"	providerDue: number;",
		"	raceSeq: number;",
		"	providerSeq: number;",
		"	firedRoles: string[];",
		"	raceFired: boolean;",
		"	providerFired: boolean;",
		"	raceCleared: boolean;",
		"	inlineContent: string | null;",
		"	pending: boolean;",
		"	asideContent: string | null;",
		"	asideCustomType: string | null;",
		"	asideDeliverAs: string | null;",
		"}",
		"",
		"async function runHandoffScenario(root: string, order: string): Promise<{ planAsides: number; nativeCalls: number; handoff: HandoffProof }> {",
		"	check(order === 'provider-first' || order === 'race-first', 'unknown handoff order ' + order);",
		"	const config = quietConfig((value: UltrathinkConfig) => {",
		"		value.track.enabled = true;",
		"		value.linear.team = 'Team';",
		"	});",
		"	const stateDir = join(root, 'state');",
		"	let plannerCalls = 0;",
		"	let capturedSignal: AbortSignal | undefined = undefined;",
		"	let capturedIsCurrent: (() => boolean) | undefined = undefined;",
		"	let startResolve: () => void = () => {};",
		"	const startedGate = new Promise<void>((resolve) => { startResolve = resolve; });",
		"	let releaseProvider: () => void = () => {};",
		"	const providerGate = new Promise<void>((resolve) => { releaseProvider = resolve; });",
		"	const planner: OmpPlanner = async (request, signal) => {",
		"		plannerCalls++;",
		"		check(plannerCalls === 1, 'new planner on same-submission reentry');",
		"		capturedSignal = signal;",
		"		capturedIsCurrent = request.isCurrent;",
		"		startResolve();",
		"		await providerGate;",
		"		check(!signal.aborted, 'flight aborted at coincident handoff');",
		"		return { context: 'PLAN' };",
		"	};",
		"	const extra: Record<string, unknown> = { stateDir, config: () => config };",
		"	const h = setup(planner, 1000, extra, { cwd: root }, { getThinkingLevel: () => 'low' }, true);",
		"	let providerHandle: unknown = undefined;",
		"	let raceHandle: unknown = undefined;",
		"	let providerDue = -1;",
		"	let providerSeq = -1;",
		"	let raceDue = -1;",
		"	let raceSeq = -1;",
		"	const markOf = (handle: unknown): QueueMark | undefined => {",
		"		for (const mark of scheduledLog) {",
		"			if (mark.handle === handle) return mark;",
		"		}",
		"		return undefined;",
		"	};",
		"	const findCoincident = (knownDue: number, knownHandle: unknown): QueueMark => {",
		"		let found: QueueMark | undefined = undefined;",
		"		for (const mark of scheduledLog) {",
		"			if (mark.due !== knownDue || mark.handle === knownHandle) continue;",
		"			if (found !== undefined) fail('more than one coincident timer at due ' + knownDue);",
		"			found = mark;",
		"		}",
		"		if (found === undefined) fail('coincident race timer missing at due ' + knownDue);",
		"		return found;",
		"	};",
		"	let consumerPromise: unknown = undefined;",
		"	if (order === 'provider-first') {",
		"		providerHandle = globalThis.setTimeout(() => { releaseProvider(); }, 25000);",
		"		const providerMark = markOf(providerHandle);",
		"		check(providerMark !== undefined, 'provider timer missing from child queue');",
		"		if (providerMark === undefined) fail('provider timer missing from child queue');",
		"		providerDue = providerMark.due;",
		"		providerSeq = providerMark.seq;",
		"		check(providerDue === 25000, 'provider timer missed the real 25s default, due ' + providerDue);",
		"		consumerPromise = h.run('coincident plan');",
		"		await startedGate;",
		"		await tick(25);",
		"		const raceMark = findCoincident(providerDue, providerHandle);",
		"		raceHandle = raceMark.handle;",
		"		raceDue = raceMark.due;",
		"		raceSeq = raceMark.seq;",
		"		check(raceDue === providerDue, 'race and provider missed the same due');",
		"		check(providerSeq < raceSeq, 'provider-first insertion order not observed');",
		"	} else {",
		"		consumerPromise = h.run('coincident plan');",
		"		await startedGate;",
		"		await tick(25);",
		"		let raceFound: QueueMark | undefined = undefined;",
		"		for (const mark of scheduledLog) {",
		"			if (mark.due !== 25000) continue;",
		"			if (raceFound !== undefined) fail('more than one race timer before provider');",
		"			raceFound = mark;",
		"		}",
		"		check(raceFound !== undefined, 'race timer missing from child queue');",
		"		if (raceFound === undefined) fail('race timer missing from child queue');",
		"		raceHandle = raceFound.handle;",
		"		raceDue = raceFound.due;",
		"		raceSeq = raceFound.seq;",
		"		const remaining = raceDue - virtualNow;",
		"		check(remaining >= 0, 'race due already passed');",
		"		providerHandle = globalThis.setTimeout(() => { releaseProvider(); }, remaining);",
		"		const providerMark = markOf(providerHandle);",
		"		check(providerMark !== undefined, 'provider timer missing from child queue');",
		"		if (providerMark === undefined) fail('provider timer missing from child queue');",
		"		providerDue = providerMark.due;",
		"		providerSeq = providerMark.seq;",
		"		check(providerDue === raceDue, 'race and provider missed the same due');",
		"		check(raceSeq < providerSeq, 'race-first insertion order not observed');",
		"	}",
		"	check(capturedSignal !== undefined && !capturedSignal.aborted, 'flight aborted before coincident fire');",
		"	check(capturedIsCurrent !== undefined && capturedIsCurrent(), 'flight not current before coincident fire');",
		"	check(plannerCalls === 1, 'planner not admitted before coincident fire');",
		"	await fireThrough(25000);",
		"	await tick(25);",
		"	const firedRoles: string[] = [];",
		"	for (const mark of firedLog) {",
		"		if (mark.handle === providerHandle) firedRoles.push('provider');",
		"		else if (mark.handle === raceHandle) firedRoles.push('race');",
		"	}",
		"	let raceFired = false;",
		"	let providerFired = false;",
		"	for (const role of firedRoles) {",
		"		if (role === 'race') raceFired = true;",
		"		if (role === 'provider') providerFired = true;",
		"	}",
		"	let raceCleared = false;",
		"	for (const handle of clearedLog) {",
		"		if (handle === raceHandle) raceCleared = true;",
		"	}",
		"	check(providerFired, 'provider gate never fired at the coincident due');",
		"	if (order === 'provider-first') {",
		"		check(raceCleared, 'provider-first race timeout was not cleared after inline completion');",
		"		check(!raceFired, 'provider-first race callback fired instead of clearing');",
		"	} else {",
		"		check(raceFired, 'race-first race callback never dispatched before provider');",
		"		const raceIndex = firedRoles.indexOf('race');",
		"		const providerIndex = firedRoles.indexOf('provider');",
		"		check(raceIndex !== -1 && providerIndex !== -1 && raceIndex < providerIndex, 'race-first fire order not observed');",
		"	}",
		"	const outcome: unknown = await consumerPromise;",
		"	const outcomeType = customTypeOf(outcome);",
		"	const outcomeContent: unknown = contentOf(outcome);",
		"	let inlineContent: string | null = null;",
		"	let pending = false;",
		"	if (outcomeType === 'ultrathink-pending') {",
		"		pending = true;",
		"		check(order === 'race-first', 'pending arrived on provider-first insertion');",
		"	} else {",
		"		check(order === 'provider-first', 'inline arrived on race-first insertion');",
		"		check(outcomeType === 'ultrathink-plan', 'inline missing plan customType');",
		"		check(outcomeContent === 'PLAN', 'inline lost opaque plan bytes');",
		"		if (typeof outcomeContent === 'string') inlineContent = outcomeContent;",
		"	}",
		"	let asideContent: string | null = null;",
		"	let asideCustomType: string | null = null;",
		"	let asideDeliverAs: string | null = null;",
		"	if (pending) {",
		"		for (let round = 0; round < 200 && h.sent.length === 0; round++) await Promise.resolve();",
		"		check(h.sent.length === 1, 'pending never delivered its aside');",
		"		const aside: unknown = h.sent[0];",
		"		check(deliverAsOf(aside) === 'aside', 'aside missing deliverAs');",
		"		check(customTypeOf(aside) === 'ultrathink-plan', 'aside missing plan customType');",
		"		const body: unknown = contentOf(aside);",
		"		check(body === 'PLAN', 'aside lost opaque plan bytes');",
		"		if (typeof body === 'string') asideContent = body;",
		"		const kind: unknown = customTypeOf(aside);",
		"		if (typeof kind === 'string') asideCustomType = kind;",
		"		const how: unknown = deliverAsOf(aside);",
		"		if (typeof how === 'string') asideDeliverAs = how;",
		"		check(asideContent === 'PLAN', 'aside content differs from opaque plan');",
		"	} else {",
		"		check(h.sent.length === 0, 'inline plan sent an aside');",
		"	}",
		"	check(capturedSignal !== undefined && !capturedSignal.aborted, 'flight aborted at coincident settlement');",
		"	check(plannerCalls === 1, 'coincident flight admitted a second planner');",
		"	const reentry: unknown = await h.run('coincident plan');",
		"	check(plannerCalls === 1, 'same-submission reentry admitted a new planner');",
		"	if (pending) {",
		"		check(reentry === undefined, 'settled pending reentry planned again');",
		"	} else {",
		"		check(customTypeOf(reentry) === 'ultrathink-plan', 'settled inline reentry lost its plan');",
		"		check(contentOf(reentry) === 'PLAN', 'settled inline reentry lost opaque bytes');",
		"	}",
		"	check(h.sent.length === (pending ? 1 : 0), 'reentry duplicated delivery');",
		"	await fireThrough(50000);",
		"	await tick(25);",
		"	for (let round = 0; round < 200; round++) await Promise.resolve();",
		"	check(h.sent.length === (pending ? 1 : 0), 'late second delivery after advancement');",
		"	check(capturedSignal !== undefined && !capturedSignal.aborted, 'flight aborted late');",
		"	check(capturedIsCurrent !== undefined && !capturedIsCurrent(), 'settled flight still current');",
		"	const dueMs = raceDue;",
		"	check(dueMs === 25000, 'coincident due missed the real 25s default, saw ' + dueMs);",
		"	check(raceDue === providerDue, 'scheduled same-due proof missing');",
		"	const handoff: HandoffProof = { order, dueMs, raceDue, providerDue, raceSeq, providerSeq, firedRoles, raceFired, providerFired, raceCleared, inlineContent, pending, asideContent, asideCustomType, asideDeliverAs };",
		"	console.log('HANDOFF-PROOF ' + order + ' due=' + dueMs + ' scheduled=race:' + raceDue + '#' + raceSeq + ',provider:' + providerDue + '#' + providerSeq + ' fired=' + firedRoles.join('+') + ' inline=' + inlineContent + ' pending=' + pending + ' asides=' + h.sent.length);",
		"	return { planAsides: h.sent.length, nativeCalls: 0, handoff };",
		"}",
		"",
		"async function main(): Promise<void> {",
		"	const stashSetTimeout = globalThis.setTimeout;",
		"	const stashClearTimeout = globalThis.clearTimeout;",
		"	globalThis.setTimeout = virtualSetTimeout as typeof setTimeout;",
		"	globalThis.clearTimeout = virtualClearTimeout as typeof clearTimeout;",
		"	const root = mkdtempSync(join(PARENT_ROOT, 'child-'));",
		"	try {",
		"		if (SCENARIO_HANDOFF_ORDER !== null) {",
		"			check(SCENARIO_HANDOFF_ORDER === 'provider-first' || SCENARIO_HANDOFF_ORDER === 'race-first', 'unknown handoff order');",
		"			const result = await runHandoffScenario(root, SCENARIO_HANDOFF_ORDER);",
		"			console.log('SCENARIO-RESULT ' + JSON.stringify(result));",
		"			process.exitCode = 0;",
		"		} else {",
		"			const result = await runScenario(root);",
		"			console.log('SCENARIO-RESULT ' + JSON.stringify(result));",
		"			process.exitCode = 0;",
		"		}",
		"	} finally {",
		"		globalThis.setTimeout = stashSetTimeout;",
		"		globalThis.clearTimeout = stashClearTimeout;",
		"		rmSync(root, { recursive: true, force: true });",
		"	}",
		"}",
		"",
		"main().then(",
		"	() => {},",
		"	(error: unknown) => {",
		"		console.error('SCENARIO-FAIL ' + (error instanceof Error ? error.stack || error.message : String(error)));",
		"		realSetTimeout(() => process.exit(1), 100);",
		"	},",
		");",
	].join("\n");
}
