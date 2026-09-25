// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Omp extension. omp caps every handler at 30s and drops late results, but the
 * planner takes minutes. So `before_agent_start` races the plan: a fast plan is
 * returned inline; otherwise a pending note is injected now and the plan is
 * delivered later via `pi.sendMessage(..., { deliverAs: "aside" })`. A tool
 * result that opens a PR for a planned session gets an ultrathink-sync aside.
 * `/ultrathink-<verb>` commands toggle control state or send one unplanned message.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { Readable } from "node:stream";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readSession, type SessionRecord, sessionPath } from "../claude/state.ts";
import { claudeConfigPaths, loadConfig } from "../config.ts";
import { shipNudge } from "../ship/nudge.ts";
import { shipApplies } from "../ship/policy.ts";
import { shipPrecheck } from "../ship/precheck.ts";
import { writeShip } from "../ship/state.ts";
import type { ShipConfig } from "../ship/types.ts";
import { status as authStatus } from "../mcp/oauth.ts";
import { storePath } from "../mcp/store.ts";
import { extractPrFromOutput, isPrCreationTool } from "../track/pr-detect.ts";
import { runControl, type UltrathinkVerb } from "../uplift/commands.ts";
import { type BarState, type BarStore, createBarComponent, createBarStore } from "./omp-ui.ts";
import { PENDING_TYPE, PLAN_TYPE, registerUltrathinkRenderers, SHIP_TYPE, SYNC_TYPE } from "./omp-render.ts";
import { resolveStateDir } from "./paths.ts";
import { createLineSplitter, parseProgressLine, type ProgressEvent } from "./progress.ts";
import type { PlanView } from "./view.ts";

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
}

export interface OmpPlan {
	context: string;
	view?: PlanView;
}

export type OmpPlanner = (
	request: OmpPlanRequest,
	signal: AbortSignal,
	onEvent?: (event: ProgressEvent) => void,
) => Promise<OmpPlan>;

type McpState = NonNullable<BarState["mcp"]>;

export const PENDING =
	"Ultrathink is still planning this prompt. The plan arrives as a separate message at the next step boundary. Until then, read and investigate only: no edits and no mutating commands. If a note says planning produced nothing, proceed with the user's request as written.";

export const NO_PLAN =
	"Ultrathink planning produced no plan. Continue with the user's request as written.";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

export const spawnEnginePlanner: OmpPlanner = (request, signal, onEvent) => {
	const { promise, resolve } = Promise.withResolvers<OmpPlan>();
	const empty = (): void => resolve({ context: "" });
	try {
		const child = spawn(join(ROOT, "bin/run-bun"), [join(ROOT, "hooks/engine.ts")], {
			cwd: request.cwd || ROOT,
			env: { ...process.env, ULTRATHINK_HOST: "omp", ULTRATHINK_PROGRESS_FD: "3" },
			stdio: ["pipe", "pipe", "ignore", "pipe"],
		});
		let stdout = "";
		const onAbort = () => {
			child.kill();
			empty();
		};
		if (signal.aborted) onAbort();
		else signal.addEventListener("abort", onAbort, { once: true });
		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			stdout += chunk;
		});
		// Always drain fd 3 so the child never blocks on a full pipe.
		const splitter = createLineSplitter((line) => {
			try {
				const event = parseProgressLine(line);
				if (event) onEvent?.(event);
			} catch {}
		});
		const progress = child.stdio[3] as Readable | null | undefined;
		if (progress) {
			progress.setEncoding("utf8");
			progress.on("data", (chunk: string) => {
				try {
					splitter.push(chunk);
				} catch {}
			});
			progress.on("error", () => {});
		}
		child.on("error", empty);
		child.on("close", () => {
			signal.removeEventListener("abort", onAbort);
			try {
				splitter.end();
			} catch {}
			try {
				const parsed = JSON.parse(stdout) as { context?: unknown; view?: unknown };
				const context = typeof parsed.context === "string" ? parsed.context : "";
				const view = parsed.view && typeof parsed.view === "object" ? (parsed.view as PlanView) : undefined;
				resolve(view ? { context, view } : { context });
			} catch {
				empty();
			}
		});
		child.stdin?.on("error", () => {});
		child.stdin?.end(
			JSON.stringify({
				host: "omp",
				prompt: request.prompt,
				cwd: request.cwd,
				session_id: request.sessionId,
			}),
		);
	} catch {
		empty();
	}
	return promise;
};

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
		/** Local ship precheck (`git` only); defaults to `shipPrecheck`. */
		shipPrecheck?: (cwd: string) => ShipPrecheck;
		/** Ship config source; defaults to the merged Claude config files for the session cwd. */
		shipConfig?: (cwd: string) => ShipConfig;
	} = {},
): (pi: ExtensionAPI) => void {
	const plan = options.plan ?? spawnEnginePlanner;
	const raceMs = options.raceMs ?? 25_000;
	const maxRunMs = options.maxRunMs ?? 600_000;
	const now = options.now ?? Date.now;
	const uiEnabled = options.ui ?? true;
	const readMcp = options.mcp ?? readMcpState;
	const exists = options.exists ?? existsSync;
	// Same dir the engine child writes (it runs in the session cwd), made absolute.
	const stateDir = (cwd: string) => resolve(cwd, options.stateDir ?? resolveStateDir({ ...process.env, ULTRATHINK_HOST: "omp" }));

	return (pi) => {
		interface Flight {
			result: Promise<OmpPlan>;
			/** The session's `turn_start` count when planning began; with `prompt`, identifies the submission. */
			submission: number;
			prompt: string;
			/** Pending was returned; the aside is the only delivery. */
			deferred: boolean;
			/** Start order; only the latest flight writes to the bar store. */
			generation: number;
			settled: boolean;
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
		// The latest submission's flight per session. A deferred plan whose flight was replaced is
		// dropped: delivered later, it would steer the newer request toward the old one.
		const flights = new Map<string, Flight>();
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
			attach(ctx);
			scheduleMount();
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
		pi.on("agent_end", (_event, ctx) => {
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
								const reply = await runControl([verb, ...text.split(/\s+/).filter(Boolean)], { stateDir: stateDir(cwd), cwd });
								ctx?.ui?.notify?.(reply, "info");
							} catch {}
						},
					}),
				);
			}
		}

		const start = (request: OmpPlanRequest, submission: number): Flight => {
			const generation = ++latestGeneration;
			guard(() => store.begin(now()));
			const onEvent = (event: ProgressEvent) =>
				guard(() => {
					barWrite(generation, () => store.apply(event));
					if (event.type === "end" && event.detail) flight.endDetail = event.detail;
				});
			const flight: Flight = {
				result: plan(request, AbortSignal.timeout(maxRunMs), onEvent).catch(() => ({ context: "" })),
				submission,
				prompt: request.prompt,
				deferred: false,
				generation,
				settled: false,
				content: "",
			};
			flights.set(request.sessionId, flight);
			void flight.result.then((result) => {
				flight.settled = true;
				flight.content = result?.context ?? "";
				flight.view = result?.view;
				if (flight.deferred && flights.get(request.sessionId) !== flight) {
					barWrite(generation, () => store.skipped("superseded by a newer prompt", now()));
					return;
				}
				barWrite(generation, () => {
					if (!flight.content) store.skipped(flight.endDetail ?? "no plan", now());
					else if (flight.deferred) store.delivered("aside", flight.view, now());
				});
				barWrite(generation, refreshMcp);
				if (!flight.deferred) return;
				guard(() =>
					pi.sendMessage(planMessage(flight.content || NO_PLAN, flight.view), { deliverAs: "aside" }),
				);
			});
			return flight;
		};

		pi.on("before_agent_start", async (event, ctx) => {
			scheduleMount();
			if (isSubagentSession(ctx, exists)) return;
			try {
				const request: OmpPlanRequest = {
					prompt: event?.prompt ?? "",
					cwd: ctx?.cwd || process.cwd(),
					sessionId: ctx?.sessionManager?.getSessionId?.() ?? "",
				};
				const submission = turns.get(request.sessionId) ?? 0;
				if (quick) {
					if (quick.sessionId === request.sessionId && quick.text === request.prompt.trim() && (quick.submission ?? submission) === submission) {
						// The quick message is now the session's latest submission; an older pending plan must not land in it.
						if (quick.submission === undefined) flights.delete(request.sessionId);
						quick.submission = submission;
						return;
					}
					quick = undefined;
				}
				const existing = flights.get(request.sessionId);
				const same = existing?.submission === submission && existing.prompt === request.prompt ? existing : undefined;
				if (same?.deferred) return same.settled ? undefined : { message: pendingMessage() };
				if (same?.settled) return same.content ? { message: planMessage(same.content, same.view) } : undefined;
				const flight = same ?? start(request, submission);
				const timeout = Promise.withResolvers<null>();
				const timer = setTimeout(() => timeout.resolve(null), raceMs);
				const result = await Promise.race([flight.result, timeout.promise]);
				clearTimeout(timer);
				if (result === null) {
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
