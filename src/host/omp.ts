// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Omp extension. Planning runs in-process on the session's own live model: each flight snapshots the whole live Model
 * once, and every stage completes through the host's `completeSimple` with the host registry's auth resolver
 * (UT-Planning-ModelSelection 1.0.0 §7-§8). omp caps every handler at 30s and drops late results, but the planner takes
 * minutes. So `before_agent_start` races the plan: a fast plan is returned inline; otherwise a pending note is injected
 * now and the plan is delivered later via `pi.sendMessage(..., { deliverAs: "aside" })`. The race only changes delivery;
 * each flight owns its own cancellation and outer time limit. A tool result that opens a PR for a planned session gets
 * an ultrathink-sync aside. `/ultrathink-<verb>` commands toggle control state or send one unplanned message.
 */
import { existsSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Api, AssistantMessage, Context, Model, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import type { ClaudeCompleter } from "../claude/complete.ts";
import { type ControlState, readControl, readSession, type SessionRecord, sessionPath } from "../claude/state.ts";
import { claudeConfigPaths, loadConfig, type UltrathinkConfig } from "../config.ts";
import { shipNudge } from "../ship/nudge.ts";
import { shipApplies } from "../ship/policy.ts";
import { shipPrecheck } from "../ship/precheck.ts";
import { writeShip } from "../ship/state.ts";
import type { ShipConfig } from "../ship/types.ts";
import { teachContext, teachEnabled } from "../teach/context.ts";
import { digestFromAgentMessages } from "../teach/digest.ts";
import { spawnObserveDetached } from "../teach/spawn.ts";
import { status as authStatus } from "../mcp/oauth.ts";
import { storePath } from "../mcp/store.ts";
import { extractPrFromOutput, isPrCreationTool } from "../track/pr-detect.ts";
import { runControl, type UltrathinkVerb } from "../uplift/commands.ts";
import { type ModelResolution, type NativeEngineSelector, type NativeModelQuery, selectNativeEngine } from "./engine.ts";
import { type BarState, type BarStore, createBarComponent, createBarStore } from "./omp-ui.ts";
import { PENDING_TYPE, PLAN_TYPE, registerUltrathinkRenderers, SHIP_TYPE, SYNC_TYPE } from "./omp-render.ts";
import { resolveStateDir } from "./paths.ts";
import { planPrompt, type PlanResponse } from "./plan.ts";
import type { ProgressEvent } from "./progress.ts";
import { type PlanView, projectResolution } from "./view.ts";

interface BeforeAgentStartEvent {
	type: "before_agent_start";
	prompt: string;
	images?: unknown[];
	systemPrompt: string[];
}

/** Omp's `tool_result` payload, trimmed to what PR sync reads. */
interface ToolResultEvent {
	type: "tool_result";
	toolName: string;
	input: Record<string, unknown>;
	content: { type: string; text?: string }[];
	isError: boolean;
}

interface TuiLike {
	requestRender(): void;
	terminal?: { rows?: number };
}

type WidgetFactory = (tui: TuiLike, theme: unknown) => { render(width: number): readonly string[] };

interface ExtensionUI {
	setWidget?(key: string, content: WidgetFactory | undefined, options?: { placement?: "aboveEditor" | "belowEditor" }): void;
	notify?(message: string, type?: "info" | "warning" | "error"): void;
}

/**
 * The host capabilities native planning uses, in the published `ExtensionContext` shapes (`ctx.models`,
 * `ctx.modelRegistry`). In-process only: never serialized, never handed to a child process.
 */
export interface OmpNativeRuntime {
	/** `ctx.models`: `current()` reads the live session model lazily; `resolve()` resolves through authenticated availability. */
	models: { current(): Model<Api> | undefined; resolve(spec: string): Model<Api> | undefined };
	/** `ctx.modelRegistry.resolver`: the host's auth-retry policy bound to one Model and session, passed as the request key. */
	modelRegistry: { resolver(model: Model<Api>, sessionId?: string): SimpleStreamOptions["apiKey"] };
}

interface ExtensionContext {
	cwd: string;
	sessionManager: {
		getSessionId(): string;
		getSessionFile?(): string | undefined;
		getHeader?(): { parentSession?: string } | null;
	};
	hasUI?: boolean;
	mode?: string;
	ui?: ExtensionUI;
	setInterval?(callback: () => void, ms: number): unknown;
	/** The live session Model (a host getter); it wins over `models.current()` when both exist (D-01). */
	model?: Model<Api>;
	models?: OmpNativeRuntime["models"];
	modelRegistry?: OmpNativeRuntime["modelRegistry"];
}

interface CustomMessage {
	customType?: string;
	content?: string;
	display?: boolean;
	details?: unknown;
	attribution?: "user" | "agent";
}

interface BeforeAgentStartResult {
	message?: string | CustomMessage;
}

type LifecycleEvent =
	| "session_start"
	| "session_switch"
	| "session_shutdown"
	| "agent_start"
	| "agent_end"
	| "turn_start"
	| "turn_end"
	| "tool_execution_start"
	| "tool_execution_end";

export interface ExtensionAPI {
	on(
		event: "before_agent_start",
		handler: (
			event: BeforeAgentStartEvent,
			ctx: ExtensionContext,
		) => Promise<BeforeAgentStartResult | void>,
	): void;
	on(event: LifecycleEvent, handler: (event: unknown, ctx: ExtensionContext) => void): void;
	/** Returning undefined keeps the user's input unchanged. */
	on(event: "input", handler: (event: unknown, ctx: ExtensionContext) => undefined): void;
	/** Returning undefined keeps the tool result unchanged. */
	on(event: "tool_result", handler: (event: ToolResultEvent, ctx: ExtensionContext) => undefined): void;
	sendMessage(message: CustomMessage, options: { deliverAs: "aside" }): void;
	/** Starts a turn when idle; the message runs through `before_agent_start` like typed input. */
	sendUserMessage?(content: string): void;
	/** Omp matches `/name args` on the first space against registered names. */
	registerCommand?(
		name: string,
		options: {
			description?: string;
			getArgumentCompletions?: (argumentPrefix: string) => { value: string; label: string; description?: string }[] | null;
			handler: (args: string, ctx: ExtensionContext) => Promise<void>;
		},
	): void;
	registerMessageRenderer?: Parameters<typeof registerUltrathinkRenderers>[0]["registerMessageRenderer"];
}

export interface OmpPlanRequest {
	prompt: string;
	cwd: string;
	sessionId: string;
	/** The flight's one whole live Model snapshot (D-01); the target every native stage of the flight uses when detected. */
	model?: Model<Api>;
	/** Where the live Model was observed: `ctx.model`, else `ctx.models.current()`. */
	modelSource?: "ctx.model" | "ctx.models.current";
	/** In-process host capabilities; absent means native planning is unavailable, never a fabricated fallback. */
	native?: OmpNativeRuntime;
	/** This flight's captured config, control and state directory, used as given. */
	config?: UltrathinkConfig;
	control?: ControlState;
	stateDir?: string;
	/** Flight validity, checked before and after every native call; false cancels the call. Never a model chooser. */
	isCurrent?: () => boolean;
}

export interface OmpPlan {
	context: string;
	view?: PlanView;
	/** The safe selection record (§9) for display and `/ultrathink-status`; never the Model. */
	modelResolution?: ModelResolution;
	/** Stable skip code when nothing was planned, including an unresolved selection. */
	skipped?: string;
	summary?: string;
}

export type OmpPlanner = (
	request: OmpPlanRequest,
	signal: AbortSignal,
	onEvent?: (event: ProgressEvent) => void,
) => Promise<OmpPlan>;

/** `completeSimple` from `@oh-my-pi/pi-ai`, in the one call shape the native adapter makes. */
export type CompleteSimple = (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => Promise<AssistantMessage>;

/** Test seams of the native binding; production loads both lazily from the host-remapped packages. */
export interface NativeEngineDeps {
	completeSimple?: CompleteSimple;
	/** Catalog injection: provider id -> default model id, as `DEFAULT_MODEL_PER_PROVIDER`. */
	providerDefaults?: Readonly<Record<string, string>>;
	/** Flight validity, not a model chooser: false before or after a native call cancels it. */
	isCurrent?: () => boolean;
}

type McpState = NonNullable<BarState["mcp"]>;

export const PENDING =
	"Ultrathink is still planning this prompt. The plan arrives as a separate message at the next step boundary. Until then, read and investigate only: no edits and no mutating commands. If a note says planning produced nothing, proceed with the user's request as written.";

export const NO_PLAN =
	"Ultrathink planning produced no plan. Continue with the user's request as written.";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

/** A cancellation as every planning boundary classifies it (the hook's convention): name `AbortError`. */
function cancelled(): Error {
	const error = new Error("Ultrathink planning was cancelled");
	error.name = "AbortError";
	return error;
}

/** A native completion failure with a static, bounded public message; an upstream rejection stays a private, non-enumerable cause. */
function nativeFailure(message: string, cause?: unknown): Error {
	const error = cause === undefined ? new Error(message) : new Error(message, { cause });
	error.name = "NativeCompletionError";
	return error;
}

function isModel(value: unknown): value is Model<Api> {
	return typeof value === "object" && value !== null && "provider" in value && typeof value.provider === "string" && "id" in value && typeof value.id === "string";
}

/**
 * One copy of a host Model for a flight (§8): `structuredClone` of its data, as the published registry copies models,
 * with the request-time `resolveHeaders` capability reattached. Never a JSON round trip, never a mutation of the host
 * object, never persisted. A Model carrying another callable cannot be cloned and fails visibly instead of losing it.
 */
function snapshotModel(model: Model<Api>): Model<Api> {
	const { resolveHeaders, ...data } = model;
	// structuredClone keeps the data's own shape; the cast restores the Model type so the capability can be reattached.
	const snapshot = structuredClone(data) as Model<Api>;
	if (resolveHeaders) snapshot.resolveHeaders = resolveHeaders;
	return snapshot;
}

const MAX_COMPARE_DEPTH = 32;

/**
 * Private in-memory comparison of whole Model data (§8 reentry): plain data structurally, callables such as
 * `resolveHeaders` by identity, an undefined field the same as an absent one. Never logged, hashed or persisted.
 */
function sameData(a: unknown, b: unknown, depth = 0): boolean {
	if (Object.is(a, b)) return true;
	if (typeof a !== "object" || typeof b !== "object" || a === null || b === null || depth > MAX_COMPARE_DEPTH) return false;
	if (Array.isArray(a) !== Array.isArray(b)) return false;
	if (a instanceof Date || b instanceof Date) return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
	if (a instanceof Map || b instanceof Map) {
		if (!(a instanceof Map && b instanceof Map) || a.size !== b.size) return false;
		for (const [key, value] of a) if (!b.has(key) || !sameData(value, b.get(key), depth + 1)) return false;
		return true;
	}
	if (a instanceof Set || b instanceof Set) {
		if (!(a instanceof Set && b instanceof Set) || a.size !== b.size) return false;
		for (const value of a) if (!b.has(value)) return false;
		return true;
	}
	// Both are non-null, non-array-or-both objects here; their own enumerable fields are compared below.
	const left = a as Record<string, unknown>;
	const right = b as Record<string, unknown>;
	const keys = Object.keys(left).filter((key) => left[key] !== undefined);
	if (keys.length !== Object.keys(right).filter((key) => right[key] !== undefined).length) return false;
	return keys.every((key) => Object.hasOwn(right, key) && sameData(left[key], right[key], depth + 1));
}

/**
 * Whether a Model can serve native planning now. Authenticated availability comes from the query facade itself, which
 * resolves only available models: the exact `provider/id` reference must return that same provider and id.
 */
function classify(models: OmpNativeRuntime["models"], model: Model<Api>): "usable" | "unavailable" | "unsupported" {
	// Only isolated chat/text planning is supported: a role-specific runner kind (no kind means chat) or text-less input is not.
	if ((model.kind !== undefined && model.kind !== "chat") || (Array.isArray(model.input) && !model.input.includes("text"))) return "unsupported";
	try {
		const available = models.resolve(`${model.provider}/${model.id}`);
		return isModel(available) && available.provider === model.provider && available.id === model.id ? "usable" : "unavailable";
	} catch {
		return "unavailable";
	}
}

/**
 * `ctx.models.resolve` takes one spec, so a bare id is qualified to the required provider at this host boundary. Role
 * aliases (`@role`, legacy `pi/role`) and specs already qualified with that provider pass unchanged; nothing is
 * lowercased, truncated or reconstructed.
 */
function qualify(selector: string, provider: string | undefined): string {
	if (!provider || selector.startsWith("@") || selector.startsWith("pi/") || selector.startsWith(`${provider}/`)) return selector;
	return `${provider}/${selector}`;
}

/** Own-property lookup only: an inherited or non-string entry is no mapping. */
function ownString(table: Readonly<Record<string, unknown>> | undefined, key: string): string | undefined {
	const value = table && Object.hasOwn(table, key) ? table[key] : undefined;
	return typeof value === "string" ? value : undefined;
}

/**
 * The host catalog's provider defaults. A dynamic import with a literal specifier, because a static one would load the
 * host package when the extension loads and in every test run, while it exists only inside Omp (whose loader remaps the
 * literal specifier to its bundled copy, D-03) or after `bun install`.
 */
async function loadProviderDefaults(): Promise<Readonly<Record<string, unknown>> | undefined> {
	try {
		const catalog = await import("@oh-my-pi/pi-catalog/provider-models");
		const table: unknown = catalog.DEFAULT_MODEL_PER_PROVIDER;
		return typeof table === "object" && table !== null ? (table as Readonly<Record<string, unknown>>) : undefined;
	} catch {
		// A missing export disables only the catalog tier; live and configured resolution stay available.
		return undefined;
	}
}

/** Only `type: "text"` blocks, in order, with no invented separator; thinking, tool and image blocks never become plan text. */
function textOf(result: AssistantMessage): string {
	const content = Array.isArray(result?.content) ? result.content : [];
	return content.map((block) => (block?.type === "text" && typeof block.text === "string" ? block.text : "")).join("");
}

function httpStatus(result: AssistantMessage): string {
	const status = result?.errorStatus;
	return typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599 ? `, HTTP ${status}` : "";
}

/**
 * The native binding's `NativeEngineSelector` (D-01, D-02, D-06): the shared policy `selectNativeEngine` decides from the
 * flight's live Model snapshot and the host query, and the one chosen whole Model is bound once per flight. Every stage
 * then completes through `completeSimple` with one system prompt, one timestamped user message, no tools, no per-call
 * headers, the registry resolver for that snapshot and session as the key, and the flight combined with the stage
 * signal. Only text blocks become plan text; `error` is a safe classified failure and `aborted` or an aborted lifetime
 * is an `AbortError`.
 */
export function createNativeEngineSelector(request: OmpPlanRequest, flightSignal: AbortSignal, deps: NativeEngineDeps = {}): NativeEngineSelector {
	return async (intent, signal) => {
		const runtime = request.native;
		if (!runtime) throw nativeFailure("omp-native runtime unavailable");
		if (flightSignal.aborted || signal?.aborted) throw cancelled();
		const [complete, catalog] = await Promise.all([
			// A literal dynamic specifier for the same reason as the catalog (D-03); tests inject a recorder instead.
			deps.completeSimple ?? import("@oh-my-pi/pi-ai").then((ai): CompleteSimple => ai.completeSimple),
			deps.providerDefaults ?? loadProviderDefaults(),
		]);
		const sessionId = request.sessionId.trim() || undefined;
		const query: NativeModelQuery<Model<Api>> = {
			...(request.model ? { live: { model: request.model, source: request.modelSource ?? "ctx.model" } } : {}),
			check: (model) => classify(runtime.models, model),
			resolve: async (selector, provider) => {
				try {
					const model = runtime.models.resolve(qualify(selector, provider));
					return isModel(model) ? model : undefined;
				} catch {
					return undefined;
				}
			},
			catalogDefault: (provider) => ownString(catalog, provider),
		};
		const bind = (model: Model<Api>): ClaudeCompleter => {
			// The live target is already this flight's snapshot; a resolved override or default is copied once here.
			const snapshot = model === request.model ? model : snapshotModel(model);
			// One auth route per flight: the host resolver for exactly this snapshot and session, passed as the callable key.
			const apiKey = runtime.modelRegistry.resolver(snapshot, sessionId);
			return async (system, user, stageSignal) => {
				const lifetime = stageSignal && stageSignal !== flightSignal ? AbortSignal.any([flightSignal, stageSignal]) : flightSignal;
				if (lifetime.aborted || deps.isCurrent?.() === false) throw cancelled();
				const context: Context = { systemPrompt: [system], messages: [{ role: "user", content: user, timestamp: Date.now() }] };
				let result: AssistantMessage;
				try {
					result = await complete(snapshot, context, { apiKey, signal: lifetime, ...(sessionId ? { sessionId } : {}) });
				} catch (error) {
					// AbortSignal.timeout's TimeoutError is cancellation too; any other rejection stays a rejection with a safe message.
					if (lifetime.aborted || (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError"))) throw cancelled();
					throw nativeFailure("omp-native completion failed", error);
				}
				// A provider that ignores the signal and still answers never turns a cancelled flight into a plan.
				if (lifetime.aborted || deps.isCurrent?.() === false || result?.stopReason === "aborted") throw cancelled();
				if (result?.stopReason === "error") throw nativeFailure(`omp-native completion failed (provider error${httpStatus(result)})`);
				return textOf(result);
			};
		};
		return selectNativeEngine(intent, query, bind);
	};
}

/** The planner's response as the extension shows it: the context, the view and the projected safe record only. */
function toOmpPlan(response: PlanResponse): OmpPlan {
	const modelResolution = projectResolution(response.modelResolution);
	return {
		context: response.context,
		...(response.view ? { view: response.view } : {}),
		...(modelResolution ? { modelResolution } : {}),
		...(response.skipped ? { skipped: response.skipped } : {}),
		...(response.summary ? { summary: response.summary } : {}),
	};
}

/**
 * The in-process Omp planner: `planPrompt` for host `omp` with the flight's native selector, signal, progress sink and
 * captured config, control and state directory. Without a native runtime the shared selection reports
 * `native-unavailable`; no subprocess, foreign CLI login or copied credential is involved. `env` is a test seam.
 */
export function createNativeEnginePlanner(deps: Omit<NativeEngineDeps, "isCurrent"> & { env?: Record<string, string | undefined> } = {}): OmpPlanner {
	return async (request, signal, onEvent) => {
		const { env, ...native } = deps;
		const selector = request.native ? createNativeEngineSelector(request, signal, { ...native, ...(request.isCurrent ? { isCurrent: request.isCurrent } : {}) }) : undefined;
		const response = await planPrompt(
			{ host: "omp", session_id: request.sessionId, prompt: request.prompt, cwd: request.cwd },
			env ?? { ...process.env, ULTRATHINK_HOST: "omp" },
			{
				...(selector ? { native: selector } : {}),
				signal,
				...(onEvent ? { progress: onEvent } : {}),
				...(request.config ? { config: request.config } : {}),
				...(request.control ? { control: request.control } : {}),
				...(request.stateDir ? { stateDir: request.stateDir } : {}),
			},
		);
		return toOmpPlan(response);
	};
}

/** The default Omp planner: native, in-process, on the flight's live Model snapshot. */
export const nativeEnginePlanner: OmpPlanner = createNativeEnginePlanner();

/** Credential readiness from the local store only (no network). */
export function readMcpState(): McpState {
	const mcp: McpState = { linear: "none", notion: "none", greptile: "none" };
	for (const s of authStatus({ storePath: storePath() })) {
		if (s.provider in mcp) mcp[s.provider as keyof McpState] = s.ready ? "ready" : s.kind === "none" ? "none" : "login";
	}
	return mcp;
}

/** Omp's temp lease dirs for subagents of non-persisted parents: `os.tmpdir()/omp-task-<id>/<Agent>.jsonl`. */
const LEASE_DIR = /^omp-(?:task|eval-agent)-\d+$/;

/**
 * Omp also runs extensions inside task-tool subagent sessions; planning those
 * prompts would create tracker rows per subagent. Subagent when:
 * - the session file is nested, `<parent file without .jsonl>/<Agent>.jsonl`;
 * - the session file sits directly in a temp lease dir (`omp-task-<n>` or
 *   `omp-eval-agent-<n>`), used when the parent session is not persisted;
 * - there is no UI and either the header carries `parentSession` or there is no
 *   session file at all (in-memory workpool subagents; a top-level
 *   `omp -p --no-session` run is deliberately treated the same and not planned).
 * User forks carry `parentSession` too, but are not nested and keep the UI, so
 * they are still planned, as are top-level persisted sessions. Unsure -> false (plan).
 */
export function isSubagentSession(ctx: ExtensionContext | undefined, exists: (path: string) => boolean = existsSync): boolean {
	try {
		const file = ctx?.sessionManager?.getSessionFile?.();
		const hasFile = typeof file === "string" && file !== "";
		if (hasFile && (LEASE_DIR.test(basename(dirname(file))) || exists(`${dirname(file)}.jsonl`))) return true;
		if (ctx?.hasUI !== false) return false;
		if (!hasFile) return true;
		const parent = ctx.sessionManager?.getHeader?.()?.parentSession;
		return typeof parent === "string" && parent !== "";
	} catch {
		return false;
	}
}

const planMessage = (content: string, view?: PlanView): CustomMessage => ({
	customType: PLAN_TYPE,
	content,
	display: true,
	...(view ? { details: view } : {}),
	attribution: "agent",
});

const pendingMessage = (): CustomMessage => ({
	customType: PENDING_TYPE,
	content: PENDING,
	display: true,
	attribution: "agent",
});

/** Omp slash commands, registered as `ultrathink-<verb>`. */
const COMMANDS: Record<UltrathinkVerb, string> = {
	quick: "Send <message> to the agent as typed: no plan, no Graph of Thought, no Linear/Notion rows",
	skip: "Do not plan the next message",
	off: "Turn planning off for Omp on this machine until turned on",
	on: "Turn planning back on for Omp on this machine",
	track: "on|off: keep planning but start or stop creating Linear/Notion rows",
	status: "Show the current ultrathink state",
};

export const QUICK_USAGE = "Usage: /ultrathink-quick <message>. Sends the message to the agent as typed, without planning.";

const TRACK_COMPLETIONS = [
	{ value: "on", label: "on", description: "Create Linear/Notion rows for planned prompts" },
	{ value: "off", label: "off", description: "Plan without creating Linear/Notion rows" },
];

/** Local ship precheck result (see src/ship/precheck.ts). */
export interface ShipPrecheck {
	ok: boolean;
	reason: string;
	branch?: string;
	base?: string;
	ahead: number;
}

/** The observed live Model and where it came from (D-01). */
interface LiveTarget {
	model: Model<Api>;
	source: "ctx.model" | "ctx.models.current";
}

/** `ctx.model`, else `ctx.models.current()`; never blended. A throwing or non-Model value counts as absent. */
function observeLive(ctx: ExtensionContext | undefined): LiveTarget | undefined {
	try {
		const model = ctx?.model;
		if (isModel(model)) return { model, source: "ctx.model" };
	} catch {}
	try {
		const current = ctx?.models?.current?.();
		if (isModel(current)) return { model: current, source: "ctx.models.current" };
	} catch {}
	return undefined;
}

function sameLive(a: LiveTarget | undefined, b: LiveTarget | undefined): boolean {
	if (!a || !b) return a === b;
	return a.source === b.source && sameData(a.model, b.model);
}

/** The host's native capabilities when both published facades are present; otherwise native planning is unavailable. */
function nativeRuntime(ctx: ExtensionContext | undefined): OmpNativeRuntime | undefined {
	try {
		const models = ctx?.models;
		const modelRegistry = ctx?.modelRegistry;
		if (typeof models?.current !== "function" || typeof models.resolve !== "function" || typeof modelRegistry?.resolver !== "function") return undefined;
		return { models, modelRegistry };
	} catch {
		return undefined;
	}
}

/**
 * A flight's view of `ctx.models`: each selector the native policy resolves is remembered with a private copy of what
 * it returned, so a reentry can revalidate alias, role and default selectors against the current query (§8 reentry 3).
 */
interface TrackedQuery {
	models: OmpNativeRuntime["models"];
	changed(current: OmpNativeRuntime["models"]): boolean;
}

function trackQuery(models: OmpNativeRuntime["models"]): TrackedQuery {
	const seen = new Map<string, Model<Api> | undefined>();
	const copy = (model: Model<Api> | undefined): Model<Api> | undefined => {
		if (!isModel(model)) return undefined;
		try {
			return snapshotModel(model);
		} catch {
			return model;
		}
	};
	return {
		models: {
			current: () => models.current(),
			resolve: (spec) => {
				const model = models.resolve(spec);
				if (!seen.has(spec)) seen.set(spec, copy(model));
				return model;
			},
		},
		changed: (current) => {
			for (const [spec, model] of seen) {
				let now: unknown;
				try {
					now = current.resolve(spec);
				} catch {
					now = undefined;
				}
				if (!sameData(model, isModel(now) ? now : undefined)) return true;
			}
			return false;
		},
	};
}

/** What a reentry compares besides the live Model: the engine request and the native selectors, never skip-once or display state. */
interface FlightIntent {
	engine: string;
	source: "control" | "config";
	override: { provider: string; model: string };
	providerDefaults: [string, string][];
}

function intentOf(config: UltrathinkConfig, control: ControlState): FlightIntent {
	const override = config.models.hosts.omp;
	return {
		engine: control.engine ?? config.think.engine,
		source: control.engine === undefined ? "config" : "control",
		override: { provider: override?.provider ?? "", model: override?.model ?? "" },
		providerDefaults: Object.entries(config.models.providerDefaults),
	};
}

const SUPERSEDED = "superseded by a newer prompt";
const MODEL_CHANGED = "superseded: the session model changed";
const SESSION_ENDED = "cancelled: the session ended or switched";

export function createOmpExtension(
	options: {
		plan?: OmpPlanner;
		raceMs?: number;
		maxRunMs?: number;
		now?: () => number;
		ui?: boolean;
		/** MCP readiness source; defaults to the local credential store. */
		mcp?: () => McpState;
		/** File existence check for subagent detection; defaults to `existsSync`. */
		exists?: (path: string) => boolean;
		/** Ultrathink state dir holding `sessions/<id>.json`; defaults to the omp host state dir. */
		stateDir?: string;
		/** The effective config a flight captures for a session cwd; defaults to the layered config files. */
		config?: (cwd: string) => UltrathinkConfig;
		/** Local ship precheck (`git` only); defaults to `shipPrecheck`. */
		shipPrecheck?: (cwd: string) => ShipPrecheck;
		/** Teachable Moments context source; defaults to the merged config for the session cwd. */
		teachContext?: typeof teachContext;
		/** Detached `teach observe` launcher; defaults to `spawnObserveDetached`. */
		spawnObserve?: typeof spawnObserveDetached;
		/** Ship config source; defaults to the merged Claude config files for the session cwd. */
		shipConfig?: (cwd: string) => ShipConfig;
	} = {},
): (pi: ExtensionAPI) => void {
	const plan = options.plan ?? nativeEnginePlanner;
	const raceMs = options.raceMs ?? 25_000;
	const maxRunMs = options.maxRunMs ?? 600_000;
	const now = options.now ?? Date.now;
	const uiEnabled = options.ui ?? true;
	const readMcp = options.mcp ?? readMcpState;
	const exists = options.exists ?? existsSync;
	const flightConfig = options.config ?? ((cwd: string) => loadConfig(claudeConfigPaths(cwd)));
	// The host state dir for the session cwd, made absolute: planning, carriers and commands share it.
	const stateDir = (cwd: string) => resolve(cwd, options.stateDir ?? resolveStateDir({ ...process.env, ULTRATHINK_HOST: "omp" }));

	return (pi) => {
		interface Flight {
			sessionId: string;
			cwd: string;
			/** The session's `turn_start` count when planning began; with `prompt`, identifies the submission. */
			submission: number;
			prompt: string;
			/** Private target identity: the live Model snapshot and the engine request, compared at reentry. */
			live?: LiveTarget;
			intent?: FlightIntent;
			/** The flight's view of `ctx.models`, for revalidating resolved selectors at reentry. */
			selectors?: TrackedQuery;
			/** The context the flight observes the live model through at call and delivery boundaries. */
			ctx: ExtensionContext | undefined;
			/** The flight's own lifetime: superseded, switched, invalidated, ended or out of time aborts it. */
			controller: AbortController;
			result: Promise<OmpPlan>;
			/** Pending was returned; the aside is the only delivery. */
			deferred: boolean;
			/** Start order; only the latest flight writes to the bar store. */
			generation: number;
			settled: boolean;
			/** Cancelled and suppressed: delivers nothing and writes nothing more. */
			cancelled: boolean;
			/** The outer limit ended it: the current request still gets its no-plan note. */
			timedOut: boolean;
			content: string;
			view?: PlanView;
			/** Detail of the planner's `end` event, used as the skip reason. */
			endDetail?: string;
		}
		// Omp re-runs before_agent_start for one submission (agent-start policy retries, a restored
		// queued batch) and each plan creates tracker rows, so a re-run reuses the flight. The hook
		// carries no submission id, but every submission reaches the agent as a turn: a `turn_start`
		// since the last run means a new submission, even with identical text.
		const turns = new Map<string, number>();
		// The latest submission's flight per session. A replaced flight is cancelled and delivers nothing:
		// delivered later, it would steer the newer request toward the old one.
		const flights = new Map<string, Flight>();
		// The latest observed safe resolution per session, for `/ultrathink-status`; extension memory only, never persisted.
		const resolutions = new Map<string, ModelResolution>();
		// Overlapping flights share one bar; a newer prompt owns it, older flights only deliver messages.
		let latestGeneration = 0;
		const barWrite = (generation: number, fn: () => void): void => {
			if (generation === latestGeneration) guard(fn);
		};
		const store: BarStore = createBarStore();
		let ui: ExtensionUI | undefined;
		let tuiRef: TuiLike | undefined;
		let timerStarted = false;

		const guard = (fn: () => void): void => {
			try {
				fn();
			} catch {}
		};
		const refreshMcp = () => guard(() => store.setMcp(readMcp()));
		const factory: WidgetFactory = (tui, theme) => {
			tuiRef = tui;
			const rows = () => {
				try {
					return tui?.terminal?.rows ?? process.stdout.rows ?? 40;
				} catch {
					return 40;
				}
			};
			return createBarComponent(store, theme, now, rows);
		};
		const mountBar = () => guard(() => ui?.setWidget?.("ultrathink", factory, { placement: "aboveEditor" }));
		// Other extensions re-set their aboveEditor widgets inside the same handlers, which moves them
		// between ours and the status band; one deferred remount per tick puts the bar back last.
		let mountQueued = false;
		const scheduleMount = (): void => {
			if (!ui || mountQueued) return;
			mountQueued = true;
			try {
				setTimeout(() => {
					try {
						mountQueued = false;
						mountBar();
					} catch {}
				}, 0);
			} catch {
				mountQueued = false;
			}
		};

		if (uiEnabled) {
			store.subscribe(() => guard(() => tuiRef?.requestRender()));
			if (typeof pi.registerMessageRenderer === "function") guard(() => registerUltrathinkRenderers(pi as never));
		}

		/** The session's current flight, not cancelled: the only one that may write state, show progress or deliver. */
		const owns = (flight: Flight): boolean => !flight.cancelled && flights.get(flight.sessionId) === flight;
		/** Cancels and suppresses a flight: aborts its lifetime and clears its delivery eligibility (§8 reentry 5). */
		const cancel = (flight: Flight, note: string): void => {
			if (flight.cancelled) return;
			flight.cancelled = true;
			if (flights.get(flight.sessionId) === flight) flights.delete(flight.sessionId);
			guard(() => flight.controller.abort());
			if (!flight.settled) barWrite(flight.generation, () => store.skipped(note, now()));
		};
		/** Ownership plus the lazily read live model, at native call and delivery boundaries; a changed target cancels. */
		const current = (flight: Flight): boolean => {
			if (!owns(flight)) return false;
			if (sameLive(flight.live, observeLive(flight.ctx))) return true;
			cancel(flight, MODEL_CHANGED);
			return false;
		};
		const observe = (sessionId: string, record: unknown): void => {
			const projected = projectResolution(record);
			if (projected) resolutions.set(sessionId, projected);
		};
		const endFlights = (): void => {
			for (const flight of [...flights.values()]) cancel(flight, SESSION_ENDED);
			quick = undefined;
		};

		const attach = (ctx: ExtensionContext) =>
			guard(() => {
				if (!uiEnabled || !ctx?.hasUI || ctx.mode !== "tui" || typeof ctx.ui?.setWidget !== "function") return;
				ui = ctx.ui;
				refreshMcp();
				mountBar();
				if (timerStarted || typeof ctx.setInterval !== "function") return;
				timerStarted = true;
				let wasAnimating = false;
				ctx.setInterval(() => {
					guard(() => {
						const animating = store.animating(now());
						if (animating || wasAnimating) tuiRef?.requestRender();
						wasAnimating = animating;
					});
				}, 80);
			});
		pi.on("session_start", (_event, ctx) => {
			attach(ctx);
			scheduleMount();
		});
		pi.on("session_switch", (_event, ctx) => {
			// The old session's flights would deliver into the new one: cancel and suppress them.
			guard(endFlights);
			attach(ctx);
			scheduleMount();
		});
		pi.on("session_shutdown", () => {
			guard(endFlights);
		});
		for (const event of ["agent_start", "agent_end", "turn_end", "tool_execution_start", "tool_execution_end"] as const) {
			pi.on(event, scheduleMount);
		}
		pi.on("turn_start", (_event, ctx) => {
			scheduleMount();
			guard(() => {
				const sessionId = ctx?.sessionManager?.getSessionId?.() ?? "";
				turns.set(sessionId, (turns.get(sessionId) ?? 0) + 1);
			});
		});
		pi.on("input", () => {
			scheduleMount();
		});

		// PR-sync parity with hooks/pr-sync.ts: once a planned session opens a PR, nudge the agent to run
		// ultrathink-sync, once per PR URL. Omp's own `github` tool opens PRs with `op: "pr_create"`; every
		// other tool follows the shared rule. Device calls (`write xd://<tool>`) emit the inner tool's result too.
		const syncedPrs = new Set<string>();
		pi.on("tool_result", (event, ctx) => {
			guard(() => {
				if (event.isError) return;
				const input = event.input ?? {};
				const command = typeof input.command === "string" ? input.command : undefined;
				if (!((event.toolName === "github" && input.op === "pr_create") || isPrCreationTool(event.toolName, command))) return;
				const pr = extractPrFromOutput(event.content.map((part) => (part.type === "text" ? part.text : "")).join("\n"));
				if (!pr || syncedPrs.has(pr.url) || isSubagentSession(ctx, exists)) return;
				const sessionId = ctx?.sessionManager?.getSessionId?.() ?? "";
				if (!sessionId) return;
				const dir = stateDir(ctx?.cwd || process.cwd());
				const tracked = readSession(dir, sessionId)?.plan;
				if (!tracked) return;
				pi.sendMessage(
					{
						customType: SYNC_TYPE,
						content: `Ultrathink: a pull request was opened for the tracked task (${pr.url}). Invoke the ultrathink-sync skill now with stateFile=${sessionPath(dir, sessionId)} and prUrl=${pr.url} (graphId=${tracked.graphId}), so the tracked Notion Task row and Linear issues get the PR URL/number/branch and status. ultrathink-sync only updates existing rows; do not create new Notion rows or Linear issues.`,
						display: true,
						details: pr,
						attribution: "agent",
					},
					{ deliverAs: "aside" },
				);
				syncedPrs.add(pr.url);
			});
		});

		// Ship parity with hooks/stop.ts: when a planned gsd-* skill run ends with committed work on a
		// feature branch, nudge the agent once per graph to run ultrathink-ship (PR, Greptile 5/5, merge).
		const nudgedGraphs = new Set<string>();

		// Teachable Moments `observe`/`auto` capture: hand the finished run to a detached `teach observe`.
		// Shares this handler (and its guard) with the ship nudge, whose early returns must not skip it.
		const observeAgentEnd = (event: unknown, ctx: ExtensionContext): void => {
			if (isSubagentSession(ctx, exists)) return;
			const sessionId = ctx?.sessionManager?.getSessionId?.() ?? "";
			const messages = event && typeof event === "object" && "messages" in event ? event.messages : undefined;
			if (!sessionId || !Array.isArray(messages)) return;
			const lastAssistant: unknown = messages.findLast((m: unknown) => typeof m === "object" && m !== null && "role" in m && m.role === "assistant");
			if (typeof lastAssistant === "object" && lastAssistant !== null && "stopReason" in lastAssistant && lastAssistant.stopReason === "aborted") return;
			const cwd = ctx?.cwd || process.cwd();
			const env = { ...process.env, ULTRATHINK_HOST: "omp" };
			const teach = (options.teachContext ?? teachContext)({ host: "omp", cwd, env, sessionId, stateDir: stateDir(cwd) });
			if (!teachEnabled(teach) || teach.config.teach.capture === "explicit") return;
			const digest = digestFromAgentMessages(messages, { host: "omp", sessionId, cwd, outcome: "completed" });
			if (!digest) return;
			(options.spawnObserve ?? spawnObserveDetached)(digest, { repoRoot: ROOT, env, stateDir: teach.stateDir, host: "omp" });
		};
		pi.on("agent_end", (event, ctx) => {
			guard(() => observeAgentEnd(event, ctx));
			guard(() => {
				if (isSubagentSession(ctx, exists)) return;
				const sessionId = ctx?.sessionManager?.getSessionId?.() ?? "";
				if (!sessionId) return;
				const cwd = ctx?.cwd || process.cwd();
				const dir = stateDir(cwd);
				const record: SessionRecord | undefined = readSession(dir, sessionId);
				const graphId = record?.plan?.graphId;
				if (!record || !graphId || nudgedGraphs.has(graphId) || record.ship?.nudgedAt !== undefined) return;
				const config = options.shipConfig ? options.shipConfig(cwd) : loadConfig(claudeConfigPaths(cwd)).ship;
				if (!shipApplies(config, record.skill?.name)) return;
				const precheck = (options.shipPrecheck ?? shipPrecheck)(cwd);
				const statePath = sessionPath(dir, sessionId);
				const nudge = shipNudge({ record, config, precheck, statePath });
				if (!nudge) return;
				nudgedGraphs.add(graphId);
				writeShip(statePath, { nudgedAt: now() });
				pi.sendMessage(
					{
						customType: SHIP_TYPE,
						content: nudge.reason,
						display: true,
						details: { branch: precheck.branch, base: precheck.base, ahead: precheck.ahead },
						attribution: "agent",
					},
					{ deliverAs: "aside" },
				);
			});
		});

		// `/ultrathink-quick <message>` arms this for exactly that message: its submission (and Omp's
		// re-runs of it) skip planning, tracking and the bar. Any other prompt disarms it, so a quick
		// message queued as a steer never swallows the next one.
		let quick: { sessionId: string; text: string; submission?: number } | undefined;
		if (typeof pi.registerCommand === "function") {
			for (const verb of Object.keys(COMMANDS) as UltrathinkVerb[]) {
				const name = `ultrathink-${verb}`;
				guard(() =>
					pi.registerCommand?.(name, {
						description: COMMANDS[verb],
						...(verb === "track"
							? { getArgumentCompletions: (prefix: string) => TRACK_COMPLETIONS.filter((item) => item.value.startsWith(prefix.trim())) }
							: {}),
						handler: async (args, ctx) => {
							try {
								// Subagents act as before: the typed text goes to the agent unchanged.
								if (isSubagentSession(ctx, exists)) {
									pi.sendUserMessage?.(args ? `/${name} ${args}` : `/${name}`);
									return;
								}
								const text = (args ?? "").trim();
								if (verb === "quick") {
									if (!text || typeof pi.sendUserMessage !== "function") return ctx?.ui?.notify?.(QUICK_USAGE, "info");
									// Armed before sending: Omp may emit before_agent_start before sendUserMessage returns.
									quick = { sessionId: ctx?.sessionManager?.getSessionId?.() ?? "", text };
									try {
										pi.sendUserMessage(text);
									} catch {
										quick = undefined;
									}
									return;
								}
								const cwd = ctx?.cwd || process.cwd();
								// Status shows this session's latest observed resolution without any native lookup or auth.
								const observed = resolutions.get(ctx?.sessionManager?.getSessionId?.() ?? "");
								const reply = await runControl([verb, ...text.split(/\s+/).filter(Boolean)], {
									stateDir: stateDir(cwd),
									cwd,
									host: "omp",
									...(observed ? { modelResolution: observed } : {}),
								});
								ctx?.ui?.notify?.(reply, "info");
							} catch {}
						},
					}),
				);
			}
		}

		/** Delivery once the plan settles: only a still-current flight on an unchanged live model shows or sends anything. */
		const settle = (flight: Flight, result: OmpPlan): void => {
			flight.settled = true;
			flight.content = result?.context ?? "";
			flight.view = result?.view;
			if (!current(flight)) return;
			if (result?.modelResolution) observe(flight.sessionId, result.modelResolution);
			barWrite(flight.generation, () => {
				if (!flight.content) store.skipped(flight.timedOut ? "timed out" : (flight.endDetail ?? "no plan"), now());
				else if (flight.deferred) store.delivered("aside", flight.view, now());
			});
			barWrite(flight.generation, refreshMcp);
			if (!flight.deferred) return;
			guard(() => pi.sendMessage(planMessage(flight.content || NO_PLAN, flight.view), { deliverAs: "aside" }));
		};

		const start = (
			request: OmpPlanRequest,
			submission: number,
			ctx: ExtensionContext | undefined,
			identity: { live?: LiveTarget; intent?: FlightIntent; selectors?: TrackedQuery },
		): Flight => {
			const previous = flights.get(request.sessionId);
			const generation = ++latestGeneration;
			const outcome = Promise.withResolvers<OmpPlan>();
			const flight: Flight = {
				sessionId: request.sessionId,
				cwd: request.cwd,
				submission,
				prompt: request.prompt,
				...identity,
				ctx,
				controller: new AbortController(),
				result: outcome.promise,
				deferred: false,
				generation,
				settled: false,
				cancelled: false,
				timedOut: false,
				content: "",
			};
			// Registered before the planner runs, so a progress callback that fires at once already finds its flight.
			flights.set(request.sessionId, flight);
			if (previous) cancel(previous, SUPERSEDED);
			guard(() => store.begin(now()));
			const onEvent = (event: ProgressEvent) =>
				guard(() => {
					if (!owns(flight)) return;
					if ((event.type === "begin" || event.type === "end") && event.modelResolution) observe(flight.sessionId, event.modelResolution);
					barWrite(generation, () => store.apply(event));
					if (event.type === "end" && event.detail) flight.endDetail = event.detail;
				});
			// The outer limit cancels the flight; the inline race below never does.
			const timer = setTimeout(() => {
				flight.timedOut = true;
				guard(() => flight.controller.abort());
			}, maxRunMs);
			// Like the AbortSignal.timeout it replaces, the limit alone never keeps a process alive.
			timer.unref?.();
			const finish = (result: OmpPlan): void => {
				clearTimeout(timer);
				outcome.resolve(result);
			};
			void flight.result.then((result) => settle(flight, result));
			try {
				plan({ ...request, isCurrent: () => current(flight) }, flight.controller.signal, onEvent).then(finish, () => finish({ context: "" }));
			} catch {
				finish({ context: "" });
			}
			return flight;
		};

		/** A new flight on this prompt: one live Model snapshot, the captured config and control, and the host runtime. */
		const launch = (
			ctx: ExtensionContext | undefined,
			base: { prompt: string; cwd: string; sessionId: string; stateDir: string },
			submission: number,
			live: LiveTarget | undefined,
			captured: { config?: UltrathinkConfig; control?: ControlState; intent?: FlightIntent },
		): Flight => {
			let snapshot: LiveTarget | undefined;
			try {
				snapshot = live && { model: snapshotModel(live.model), source: live.source };
			} catch {
				snapshot = undefined;
			}
			const runtime = nativeRuntime(ctx);
			// A live Model that cannot be snapshotted whole is never planned on a partial copy: native is unavailable.
			const selectors = runtime && (snapshot || !live) ? trackQuery(runtime.models) : undefined;
			const request: OmpPlanRequest = {
				...base,
				...(snapshot ? { model: snapshot.model, modelSource: snapshot.source } : {}),
				...(runtime && selectors ? { native: { models: selectors.models, modelRegistry: runtime.modelRegistry } } : {}),
				...(captured.config ? { config: captured.config } : {}),
				...(captured.control ? { control: captured.control } : {}),
			};
			return start(request, submission, ctx, { live: snapshot, intent: captured.intent, selectors });
		};

		pi.on("before_agent_start", async (event, ctx) => {
			scheduleMount();
			if (isSubagentSession(ctx, exists)) return;
			try {
				const prompt = event?.prompt ?? "";
				const cwd = ctx?.cwd || process.cwd();
				const sessionId = ctx?.sessionManager?.getSessionId?.() ?? "";
				const submission = turns.get(sessionId) ?? 0;
				if (quick) {
					if (quick.sessionId === sessionId && quick.text === prompt.trim() && (quick.submission ?? submission) === submission) {
						// The quick message is now the session's latest submission; an older pending plan must not land in it.
						const older = quick.submission === undefined ? flights.get(sessionId) : undefined;
						if (older) cancel(older, SUPERSEDED);
						quick.submission = submission;
						return;
					}
					quick = undefined;
				}
				const dir = stateDir(cwd);
				let captured: { config?: UltrathinkConfig; control?: ControlState; intent?: FlightIntent } = {};
				try {
					const config = flightConfig(cwd);
					const control = readControl(dir);
					captured = { config, control, intent: intentOf(config, control) };
				} catch {
					// fail-open: the planner loads its own config and control
				}
				const live = observeLive(ctx);
				const existing = flights.get(sessionId);
				let same = existing?.submission === submission && existing.prompt === prompt && existing.cwd === cwd ? existing : undefined;
				// Reuse only an unchanged target: the whole live Model, the engine request, the native selectors and what
				// they resolve to now. Otherwise the old flight is cancelled and suppressed, and this prompt plans afresh.
				if (same) {
					const runtime = nativeRuntime(ctx);
					const unchanged =
						sameLive(same.live, live) &&
						sameData(same.intent, captured.intent) &&
						(!same.selectors || (runtime !== undefined && !same.selectors.changed(runtime.models)));
					if (!unchanged) {
						cancel(same, MODEL_CHANGED);
						same = undefined;
					}
				}
				if (same?.deferred) return same.settled ? undefined : { message: pendingMessage() };
				if (same?.settled) return same.content ? { message: planMessage(same.content, same.view) } : undefined;
				const flight = same ?? launch(ctx, { prompt, cwd, sessionId, stateDir: dir }, submission, live, captured);
				const timeout = Promise.withResolvers<null>();
				const timer = setTimeout(() => timeout.resolve(null), raceMs);
				let result: OmpPlan | null;
				try {
					result = await Promise.race([flight.result, timeout.promise]);
				} finally {
					clearTimeout(timer);
				}
				if (flight.cancelled) return;
				if (result === null) {
					// Delivery only switches to pending and aside; the flight keeps running under its own lifetime.
					flight.deferred = true;
					barWrite(flight.generation, () => store.pending());
					return { message: pendingMessage() };
				}
				if (!result.context) return;
				barWrite(flight.generation, () => store.delivered("inline", result.view, now()));
				return { message: planMessage(result.context, result.view) };
			} catch {
				return;
			}
		});
	};
}

export default createOmpExtension();
