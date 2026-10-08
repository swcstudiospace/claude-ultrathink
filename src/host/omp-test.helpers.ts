// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import type { Api, ApiKeyResolver, AssistantMessage, Context, Model, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import { join } from "node:path";
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

export function setup(
	plan: ((...args: Parameters<OmpPlanner>) => Promise<string | OmpPlan>) | undefined,
	raceMs = 1_000,
	extra: Omit<OmpOptions, "plan" | "raceMs" | "mcp"> = {},
	ctxExtra: Record<string, unknown> = {},
	apiExtra: Pick<ExtensionAPI, "getThinkingLevel"> = {},
) {
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
	createOmpExtension({ ...(plan ? { plan: wrap(plan) } : {}), raceMs, mcp: MCP, config: () => quietConfig(), ...extra })(pi);
	const ctx = { cwd: "/repo", sessionManager: { getSessionId: () => "s1" }, ...ctxExtra };
	const emit = (event: string, payload: Record<string, unknown> = {}, context: Record<string, unknown> = ctx) => {
		let result: unknown;
		for (const handler of handlers.get(event) ?? []) result = handler({ type: event, ...payload }, context);
		return result;
	};
	const run = (prompt = "do it") =>
		(handlers.get("before_agent_start")?.[0] as Handler)({ type: "before_agent_start", prompt, systemPrompt: [] }, ctx as never);
	const command = (name: string, args = "") =>
		commands.get(name)?.handler(args, { ...ctx, ui: { notify: (text: string) => void notices.push(text) } });
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
