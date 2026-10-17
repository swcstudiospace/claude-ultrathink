import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { BoundedSet } from "./bounded-set.ts";
import { capFor, createSessionBudget, parseSessionBudget, type SessionBudget } from "./budget.ts";
import { DEFAULT_CAP, shrinkToolText } from "./compress.ts";
import { estimateTokens } from "./estimate.ts";
import { readFlags } from "./flags.ts";
import { clearSkimArchive, readSkimSpan, rememberSkim, skimArchiveSize, skimSource } from "./skim.ts";
import { runGraphify } from "./graph.ts";
import { GRAPH_POINTER, pointerFor } from "./pointer.ts";
import { createRemoteSink, type RemoteSink } from "./remote-sink.ts";
import { createSharedCache, type SharedCache } from "./shared-cache.ts";
import {
	createLedger,
	defaultTokenOptDir,
	isValidSessionId,
	type Ledger,
	type SavingsPoint,
	type TokenSavingsSnapshot,
} from "./ledger.ts";

const EVENT = "token-opt:savings";
const RTK_TIMEOUT_MS = 2_000;
const DEDUPE_MIN_CHARS = 200;
const GRAPH_BUDGET_DEFAULT = 2_000;
const DEDUPE_MAX_ENTRIES = 4_096;
const SHUTDOWN_TIMEOUT_MS = 3_000;

/** A tool argument as a string; any other value becomes the empty string. */
function str(value: unknown): string {
	return typeof value === "string" ? value : "";
}

/** Seen-result set. Both Set and BoundedSet satisfy it. */
interface DedupeSet {
	has(value: string): boolean;
	add(value: string): unknown;
}

interface BudgetState {
	handle: SessionBudget;
	limit: number;
}

/** Stable prefix: never inject system-prompt text, timestamps, hashes, or file counts. */
export const PREFIX_POLICY = { injectSystemPrompt: false as const };

interface TextBlock {
	type: string;
	text?: string;
}

interface ToolResultLike {
	toolName?: string;
	isError?: boolean;
	input?: { command?: unknown; path?: unknown };
	content?: TextBlock[];
}

interface UsageLike {
	input?: unknown;
	output?: unknown;
	cacheRead?: unknown;
	cacheWrite?: unknown;
	durationMs?: unknown;
	ttftMs?: unknown;
	costUsd?: unknown;
	cost?: { total?: unknown };
}

interface MessageLike {
	role?: string;
	id?: unknown;
	durationMs?: unknown;
	ttftMs?: unknown;
	usage?: UsageLike;
}

interface NotifyCtx {
	ui: { notify(message: string, type?: "info" | "warning" | "error"): void };
	compact?: (options: { mode: string }) => unknown;
	cwd?: string;
}

interface ToolCallLike {
	toolName?: string;
	cwd?: unknown;
	input?: Record<string, unknown>;
}

interface PiLike {
	setLabel(label: string): void;
	zod: {
		object(shape: Record<string, unknown>): unknown;
		string(): unknown;
		number?: () => unknown;
	};
	registerTool(tool: {
		name: string;
		label: string;
		description: string;
		parameters: unknown;
		execute: (
			toolCallId: string,
			params: Record<string, unknown>,
			signal?: AbortSignal,
			onUpdate?: unknown,
			ctx?: { cwd?: string },
		) => Promise<{ content: Array<{ type: "text"; text: string }>; isError?: boolean }>;
	}): void;
	registerCommand(name: string, options: { description?: string; handler: (args: string, ctx: NotifyCtx) => Promise<void> }): void;
	on(event: "session_start" | "session_switch", handler: (event: unknown, ctx: unknown) => unknown): void;
	on(event: "turn_start", handler: (event: unknown, ctx: unknown) => unknown): void;
	on(event: "tool_call", handler: (event: ToolCallLike, ctx: unknown) => unknown): void;
	on(event: "tool_result", handler: (event: ToolResultLike) => unknown): void;
	on(event: "before_provider_request", handler: (event: { payload?: unknown }) => unknown): void;
	on(event: "message_end", handler: (event: { message?: MessageLike }) => unknown): void;
	on(event: "session_shutdown", handler: () => unknown): void;
	on(event: "before_agent_start", handler: (event: { systemPrompt?: unknown }, ctx: { cwd?: unknown }) => unknown): void;
	events?: { emit(name: string, data: TokenSavingsSnapshot): void };
}

function sessionIdFrom(event: unknown, ctx: unknown): string {
	const candidates: unknown[] = [];
	if (event && typeof event === "object") {
		if ("sessionId" in event) candidates.push(event.sessionId);
		if ("session_id" in event) candidates.push(event.session_id);
		if ("session" in event && event.session && typeof event.session === "object" && "id" in event.session) {
			candidates.push(event.session.id);
		}
	}
	if (ctx && typeof ctx === "object" && "sessionManager" in ctx) {
		const manager = ctx.sessionManager;
		if (manager && typeof manager === "object" && "getSessionId" in manager && typeof manager.getSessionId === "function") {
			candidates.push(manager.getSessionId());
		}
	}
	for (const candidate of candidates) {
		if (typeof candidate === "string" && isValidSessionId(candidate)) return candidate;
	}
	return "default";
}

function finiteInt(value: unknown, missing: boolean): number | null {
	if (missing || value === undefined || value === null) return 0;
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return null;
	return value;
}

function safeDuration(value: unknown): number | null {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return null;
	return value;
}

function graphDelta(text: string): { baseline: number; current: number; saved: number } | null {
	const match = text.match(/(?:^|\n)graphify-tokens:\s+(\d+)\s+(\d+)\s*(?:\n|$)/);
	if (!match) return null;
	const baseline = Number(match[1]);
	const current = Number(match[2]);
	if (!Number.isSafeInteger(baseline) || !Number.isSafeInteger(current) || baseline < current) return null;
	return { baseline, current, saved: baseline - current };
}

function formatStatus(snap: TokenSavingsSnapshot): string {
	const lines = [
		`token-opt ${snap.sessionId}`,
		`baseline ${snap.baselineTokens} current ${snap.currentTokens} saved ${snap.savedTokens}`,
	];
	if (snap.cacheHitPct !== undefined) lines.push(`cache hit ${snap.cacheHitPct}%`);
	if (snap.lastTurnMs !== undefined) lines.push(`last turn ${snap.lastTurnMs}ms`);
	if (snap.lastQueryMs !== undefined) lines.push(`last query ${snap.lastQueryMs}ms`);
	if (snap.rtkSavedTokens !== undefined) lines.push(`rtk saved ${snap.rtkSavedTokens}`);
	if (snap.lastPayloadChars !== undefined) lines.push(`payload ${snap.lastPayloadChars}`);
	if (snap.ttftMs !== undefined) lines.push(`ttft ${snap.ttftMs}ms`);
	const recent = snap.points.slice(-8);
	if (recent.length === 0) {
		lines.push("no points");
	} else {
		for (const point of recent) {
			lines.push(`${point.source} at ${point.at} baseline ${point.baseline} current ${point.current} saved ${point.saved}`);
		}
	}
	lines.push(snap.prefixChanged === 1 ? "prefix moved" : "prefix stable");
	lines.push(snap.toolsChanged === 1 ? "tools moved" : "tools stable");
	return lines.join("\n");
}

function graphStatusLine(cwd: string): string {
	try {
		return existsSync(join(cwd, "graphify-out", "graph.json")) ? "graph ready" : "graph missing";
	} catch {
		return "graph missing";
	}
}

function graphReadyFlag(cwd: string | undefined): 0 | 1 {
	const roots: string[] = [];
	if (typeof cwd === "string" && cwd.length > 0) roots.push(cwd);
	const here = process.cwd();
	if (!roots.includes(here)) roots.push(here);
	for (const root of roots) {
		try {
			if (existsSync(join(root, "graphify-out", "graph.json"))) return 1;
		} catch {
			// try the other root
		}
	}
	return 0;
}

function prefixSource(payload: object): string | null {
	if ("system" in payload && payload.system !== undefined) return JSON.stringify(payload.system);
	if ("messages" in payload && Array.isArray(payload.messages) && payload.messages.length > 0) {
		return JSON.stringify(payload.messages[0]);
	}
	return null;
}

function toolNameList(tools: unknown[]): string[] {
	const names: string[] = [];
	for (const tool of tools) {
		if (typeof tool === "string") names.push(tool);
		else if (tool && typeof tool === "object" && "name" in tool && typeof tool.name === "string") names.push(tool.name);
	}
	names.sort();
	return names;
}

function costCentsFrom(usage: UsageLike): number | null {
	const direct = usage.costUsd;
	const nested = usage.cost && typeof usage.cost === "object" ? usage.cost.total : undefined;
	const dollars = typeof direct === "number" ? direct : nested;
	if (typeof dollars !== "number" || !Number.isFinite(dollars) || dollars < 0) return null;
	const cents = Math.round(dollars * 100);
	if (!Number.isSafeInteger(cents) || cents < 0) return null;
	return cents;
}

function homeDir(): string {
	return process.env.HOME && process.env.HOME.length > 0 ? process.env.HOME : homedir();
}

function rtkExtensionPresent(cwd: string): boolean {
	try {
		if (existsSync(join(homeDir(), ".omp", "agent", "extensions", "rtk.ts"))) return true;
		if (existsSync(join(cwd, ".omp", "extensions", "rtk.ts"))) return true;
		return false;
	} catch {
		return true;
	}
}

function callCwd(event: ToolCallLike): string {
	return typeof event.cwd === "string" && event.cwd.length > 0 ? event.cwd : process.cwd();
}

async function readStream(stream: ReadableStream<Uint8Array> | null | undefined, limit: number): Promise<string> {
	if (!stream) return "";
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (total < limit) {
			const step = await reader.read();
			if (step.done) break;
			const value = step.value;
			if (!value || value.byteLength === 0) continue;
			const room = limit - total;
			if (value.byteLength > room) {
				chunks.push(value.subarray(0, room));
				total = limit;
				break;
			}
			chunks.push(value);
			total += value.byteLength;
		}
	} finally {
		try {
			await reader.cancel();
		} catch {
			// best-effort
		}
	}
	return new TextDecoder().decode(Buffer.concat(chunks));
}

async function rewriteWithRtk(command: string, cwd: string): Promise<string | null> {
	if (command.trimStart().startsWith("rtk ")) return null;
	if (rtkExtensionPresent(cwd)) return null;
	const bin = Bun.which("rtk");
	if (!bin) return null;
	const killer = new AbortController();
	const timer = setTimeout(() => killer.abort(), RTK_TIMEOUT_MS);
	try {
		const proc = Bun.spawn([bin, "rewrite", command], {
			cwd,
			stdout: "pipe",
			stderr: "ignore",
			stdin: "ignore",
			signal: killer.signal,
		});
		const stdout = await readStream(proc.stdout, 65_536);
		const exitCode = await proc.exited;
		if (exitCode !== 0) return null;
		const line = stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout;
		if (line.length === 0 || line.includes("\n") || !line.startsWith("rtk ")) return null;
		return line;
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}
function parseRtkTotalSaved(text: string): number | null {
	try {
		const parsed = JSON.parse(text) as { summary?: { total_saved?: unknown } };
		const value = parsed.summary?.total_saved;
		if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) return null;
		return value;
	} catch {
		return null;
	}
}

async function readRtkTotalSaved(): Promise<number | null> {
	const bin = Bun.which("rtk");
	if (!bin) return null;
	const killer = new AbortController();
	const timer = setTimeout(() => killer.abort(), RTK_TIMEOUT_MS);
	try {
		const proc = Bun.spawn([bin, "gain", "--all", "--format", "json"], {
			stdout: "pipe",
			stderr: "ignore",
			stdin: "ignore",
			signal: killer.signal,
		});
		const stdout = await readStream(proc.stdout, 65_536);
		const exitCode = await proc.exited;
		if (exitCode !== 0) return null;
		return parseRtkTotalSaved(stdout);
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

function isEmptyToolResult(text: string): boolean {
	const trimmed = text.trim();
	if (trimmed === "" || trimmed === "No matches found" || trimmed === "No matches found.") return true;
	const lines = trimmed
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !/^#{1,6}(\s|$)/.test(line));
	return lines.length === 1 && lines[0] === "No matches found";
}

function l2Key(tenant: string, key: string): string {
	const digest = createHash("sha256").update(tenant).update("\0").update(key).digest("hex");
	return `tokopt:v1:${digest}`;
}


export default function tokenOpt(pi: PiLike): void {
	pi.setLabel("Token opt");
	const flags = readFlags();
	const ledger: Ledger = createLedger(flags.asyncLedger ? { asyncWrites: true } : undefined);
	const tenant = process.env.TOKEN_OPT_TENANT || "local";
	const sink: RemoteSink | null = flags.remoteSink
		? createRemoteSink({
				url: process.env.TOKEN_OPT_TIMESCALE_URL || undefined,
				fallbackPath: join(defaultTokenOptDir(), "sink-fallback.jsonl"),
			})
		: null;
	const sharedUrl = flags.graphKeyedCache ? process.env.TOKEN_OPT_SHARED_CACHE_URL : undefined;
	const sharedCache: SharedCache | null = sharedUrl ? createSharedCache({ url: sharedUrl }) : null;
	const l2 =
		sharedCache === null
			? undefined
			: {
					get: (key: string) => sharedCache.get(l2Key(tenant, key)),
					set: (key: string, value: string) => sharedCache.set(l2Key(tenant, key), value),
					// Singleflight needs the keyed cache and a shared store; off by default.
					acquire: flags.graphSingleflight
						? (key: string, ttlMs: number) => sharedCache.acquire(l2Key(tenant, key), ttlMs)
						: undefined,
				};
	// Same grammar as the session budget: a positive safe integer. Unset or invalid uses the default.
	const graphBudget = flags.graphBudget
		? (parseSessionBudget(process.env.TOKEN_OPT_GRAPH_BUDGET) ?? GRAPH_BUDGET_DEFAULT)
		: undefined;
	const seenTiming = new Set<string>();
	const seenMessages = new Set<string>();
	const seenUnkeyed = new WeakSet<object>();
	const seenResults = new Map<string, DedupeSet>();
	let turnStartedAt: number | null = null;
	let lastMessageEndAt: number | null = null;
	let budget: BudgetState | null = null;
	let rtkBaseline: number | null = null;
	let rtkEpoch = 0;
	let rtkBaselineRead: Promise<void> = Promise.resolve();
	let prefixHash: string | null = null;
	let toolsHash: string | null = null;
	const z = pi.zod;
	function openBudget(): BudgetState | null {
		if (!flags.sessionBudget) return null;
		const limit = parseSessionBudget(process.env.TOKEN_OPT_SESSION_TOKEN_BUDGET);
		return limit === null ? null : { handle: createSessionBudget(limit), limit };
	}
	function beginSession(event: unknown, ctx: unknown): void {
		prefixHash = null;
		toolsHash = null;
		clearSkimArchive();
		budget = openBudget();
		try {
			turnStartedAt = null;
			lastMessageEndAt = null;
			const epoch = ++rtkEpoch;
			rtkBaselineRead = readRtkTotalSaved()
				.then((total) => {
					if (epoch === rtkEpoch && total !== null) rtkBaseline = total;
				})
				.catch(() => {});
			publish(ledger.load(sessionIdFrom(event, ctx)));
		} catch {
			try {
				publish(ledger.load("default"));
			} catch {
				// fail open
			}
		}
	}

	function publish(snap: TokenSavingsSnapshot): void {
		try {
			pi.events?.emit(EVENT, snap);
		} catch {
			// fail open
		}
	}

	function record(point: SavingsPoint): void {
		const snap = ledger.record(point);
		publish(snap);
		sink?.push({
			at: point.at,
			sessionId: activeSession(),
			kind: "savings",
			source: point.source,
			baseline: point.baseline,
			current: point.current,
			saved: point.saved,
		});
	}

	function spendBudget(text: string): void {
		if (budget) budget.handle.spend(estimateTokens(text));
	}

	function activeSession(): string {
		return ledger.snapshot()?.sessionId ?? "default";
	}

	async function runGraph(args: string[], signal: AbortSignal | undefined, ctx: { cwd?: string } | undefined) {
		if (args[0] === "extract") {
			return { content: [{ type: "text" as const, text: "graphify extract is not spawned" }], isError: true };
		}
		const result = await runGraphify(ctx?.cwd ?? process.cwd(), args, signal, {
			budget: graphBudget,
			keyedCache: flags.graphKeyedCache,
			l2,
		});
		const graphReady = graphReadyFlag(ctx?.cwd);
		if (Number.isSafeInteger(result.ms) && result.ms >= 0) {
			publish(ledger.notePerf({ lastQueryMs: result.ms, graphReady }));
		} else {
			publish(ledger.notePerf({ graphReady }));
		}
		const measured = graphDelta(result.text);
		const estimate = estimateTokens(result.text);
		record(
			measured
				? { at: Date.now(), source: "graph", baseline: measured.baseline, current: measured.current, saved: measured.saved }
				: { at: Date.now(), source: "graph", baseline: estimate, current: estimate, saved: 0 },
		);
		return { content: [{ type: "text" as const, text: result.text }] };
	}

	pi.registerTool({
		name: "graph_query",
		label: "Graph query",
		description: "Query the local graphify graph. Returns CLI text, not graph.json.",
		parameters: z.object({ question: z.string() }),
		async execute(_id, params, signal, _onUpdate, ctx) {
			try {
				return await runGraph(["query", str(params.question)], signal, ctx);
			} catch {
				return { content: [{ type: "text", text: "graph_query failed" }], isError: true };
			}
		},
	});

	pi.registerTool({
		name: "read_span",
		label: "Read span",
		description: "Return up to 200 archived skim lines for a path. Does not read the filesystem.",
		parameters: z.object({
			path: z.string(),
			start: typeof z.number === "function" ? z.number() : z.string(),
			end: typeof z.number === "function" ? z.number() : z.string(),
		}),
		async execute(_id, params) {
			try {
				const path = params.path;
				const start = typeof params.start === "number" ? params.start : Number(params.start);
				const end = typeof params.end === "number" ? params.end : Number(params.end);
				if (typeof path !== "string" || path.length === 0) {
					return { content: [{ type: "text", text: "token-opt: read_span rejected" }], isError: true };
				}
				if (!Number.isSafeInteger(start) || start < 1 || !Number.isSafeInteger(end) || end < start || end - start > 199) {
					return { content: [{ type: "text", text: "token-opt: read_span rejected" }], isError: true };
				}
				const text = readSkimSpan(path, start, end);
				if (text === null) {
					return { content: [{ type: "text", text: "token-opt: path not in skim archive" }], isError: true };
				}
				const capped = text.split("\n").slice(0, 200).join("\n");
				return { content: [{ type: "text", text: capped }] };
			} catch {
				return { content: [{ type: "text", text: "token-opt: read_span rejected" }], isError: true };
			}
		},
	});

	pi.registerTool({
		name: "graph_path",
		label: "Graph path",
		description: "Shortest graphify path between two nodes.",
		parameters: z.object({ from: z.string(), to: z.string() }),
		async execute(_id, params, signal, _onUpdate, ctx) {
			try {
				return await runGraph(["path", str(params.from), str(params.to)], signal, ctx);
			} catch {
				return { content: [{ type: "text", text: "graph_path failed" }], isError: true };
			}
		},
	});

	pi.registerTool({
		name: "graph_explain",
		label: "Graph explain",
		description: "Explain one graphify node.",
		parameters: z.object({ node: z.string() }),
		async execute(_id, params, signal, _onUpdate, ctx) {
			try {
				return await runGraph(["explain", str(params.node)], signal, ctx);
			} catch {
				return { content: [{ type: "text", text: "graph_explain failed" }], isError: true };
			}
		},
	});

	async function refreshRtkDelta(): Promise<void> {
		try {
			await rtkBaselineRead;
			if (rtkBaseline === null) return;
			const latest = await readRtkTotalSaved();
			if (latest === null) return;
			const rtkSavedTokens = Math.max(0, latest - rtkBaseline);
			publish(ledger.notePerf({ rtkSavedTokens }));
		} catch {
			// fail open: omit the field
		}
	}

	async function notifyStatus(ctx: NotifyCtx): Promise<void> {
		await refreshRtkDelta();
		const cwd = typeof ctx.cwd === "string" && ctx.cwd.length > 0 ? ctx.cwd : process.cwd();
		if (ledger.snapshot()) publish(ledger.notePerf({ graphReady: graphReadyFlag(cwd) }));
		const snap = ledger.snapshot();
		const base = snap ? formatStatus(snap) : "token-opt: no session";
		const budgetLine = budget ? `\nbudget ${budget.handle.tier()} used ${budget.handle.used()} limit ${budget.limit}` : "";
		ctx.ui.notify(`${base}\nskim archive ${skimArchiveSize()}\n${graphStatusLine(cwd)}${budgetLine}`, "info");
	}

	pi.registerCommand("token-status", {
		description: "Print measured session token totals and the last 8 points",
		handler: async (_args, ctx) => {
			try {
				await notifyStatus(ctx);
			} catch {
				// fail open
			}
		},
	});

	pi.registerCommand("token-opt", {
		description: "Print token status, or compact the session",
		handler: async (args, ctx) => {
			try {
				const sub = (args ?? "").trim().split(/\s+/)[0] ?? "";
				if (sub === "compact") {
					if (typeof ctx.compact !== "function") {
						ctx.ui.notify("compact unavailable", "info");
						return;
					}
					const result = await ctx.compact({ mode: "snapcompact" });
					if (typeof result === "string" && result.length > 0) {
						ctx.ui.notify(result, "info");
						return;
					}
					if (result !== undefined && result !== null) {
						ctx.ui.notify(typeof result === "string" ? result : JSON.stringify(result), "info");
						return;
					}
					ctx.ui.notify("compact unavailable", "info");
					return;
				}
				await notifyStatus(ctx);
			} catch {
				if ((args ?? "").trim().split(/\s+/)[0] === "compact") {
					try {
						ctx.ui.notify("compact unavailable", "info");
					} catch {
						// fail open
					}
				}
			}
		},
	});

	pi.on("session_start", (event, ctx) => {
		beginSession(event, ctx);
	});
	pi.on("session_switch", (event, ctx) => {
		beginSession(event, ctx);
	});

	pi.on("turn_start", () => {
		try {
			const now = Date.now();
			if (lastMessageEndAt !== null) {
				const lastIdleMs = now - lastMessageEndAt;
				if (Number.isSafeInteger(lastIdleMs) && lastIdleMs >= 0) {
					publish(ledger.notePerf({ lastIdleMs }));
				}
			}
			turnStartedAt = now;
		} catch {
			// fail open
		}
	});

	pi.on("tool_call", async (event) => {
		try {
			if (event.toolName !== "bash") return;
			const command = event.input?.command;
			if (typeof command !== "string") return;
			const rewritten = await rewriteWithRtk(command, callCwd(event));
			if (!rewritten) return;
			return { input: { ...event.input, command: rewritten } };
		} catch {
			return;
		}
	});

	pi.on("tool_result", (event) => {
		try {
			if (event.toolName === "bash") void refreshRtkDelta();
			if (event.isError) return;
			const blocks = event.content;
			if (!Array.isArray(blocks)) return;
			const texts = blocks.filter((block) => block.type === "text" && typeof block.text === "string").map((block) => block.text ?? "");
			if (texts.length === 0) return;
			const joined = texts.join("\n");
			const toolName = event.toolName ?? "tool";
			if (isEmptyToolResult(joined)) {
				const pointer = `token-opt: ${toolName} empty`;
				const baseline = estimateTokens(joined);
				const current = estimateTokens(pointer);
				if (baseline > current) {
					record({
						at: Date.now(),
						source: "compress",
						baseline,
						current,
						saved: baseline - current,
					});
				}
				spendBudget(pointer);
				return { content: [{ type: "text", text: pointer }] };
			}
			if (joined.length > DEDUPE_MIN_CHARS) {
				const sessionId = activeSession();
				let seen = seenResults.get(sessionId);
				if (!seen) {
					seen = flags.boundedDedupe ? new BoundedSet(DEDUPE_MAX_ENTRIES) : new Set<string>();
					seenResults.set(sessionId, seen);
				}
				const hash = createHash("sha256").update(sessionId).update("\0").update(toolName).update("\0").update(joined).digest("hex");
				if (seen.has(hash)) {
					const pointer = `token-opt: repeated ${toolName} result omitted (${joined.length} chars)`;
					const baseline = estimateTokens(joined);
					const current = estimateTokens(pointer);
					record({
						at: Date.now(),
						source: "compress",
						baseline,
						current,
						saved: baseline - current,
					});
					spendBudget(pointer);
					return { content: [{ type: "text", text: pointer }] };
				}
				seen.add(hash);
			}
			if (event.toolName === "bash" && String(event.input?.command ?? "").trimStart().startsWith("rtk ")) {
				spendBudget(joined);
				return;
			}
			if (event.toolName === "read" && typeof event.input?.path === "string") {
				const skimmed = skimSource(joined, event.input.path);
				if (skimmed.length < joined.length) rememberSkim(event.input.path, joined);
				const baseline = estimateTokens(joined);
				const current = estimateTokens(skimmed);
				if (baseline > current) {
					record({
						at: Date.now(),
						source: "compress",
						baseline,
						current,
						saved: baseline - current,
					});
					spendBudget(skimmed);
					return { content: [{ type: "text", text: skimmed }] };
				}
			}
			const shrunk = budget
				? shrinkToolText(joined, capFor(budget.handle.tier(), DEFAULT_CAP))
				: shrinkToolText(joined);
			if (shrunk.saved <= 0) {
				spendBudget(joined);
				return;
			}
			record({
				at: Date.now(),
				source: "compress",
				baseline: shrunk.baseline,
				current: shrunk.current,
				saved: shrunk.saved,
			});
			spendBudget(shrunk.text);
			return { content: [{ type: "text", text: shrunk.text }] };
		} catch {
			return;
		}
	});

	pi.on("message_end", (event) => {
		try {
			const message = event.message;
			if (!message || message.role !== "assistant") return;
			lastMessageEndAt = Date.now();
			const id = typeof message.id === "string" && message.id.length > 0 ? message.id : null;
			if (id === null ? seenUnkeyed.has(message) : seenMessages.has(id)) return;
			if (id !== null && !seenTiming.has(id)) {
				const stamped = safeDuration(message.durationMs) ?? safeDuration(message.usage?.durationMs);
				let wall: number | null = null;
				if (turnStartedAt !== null) {
					const ms = Date.now() - turnStartedAt;
					wall = Number.isSafeInteger(ms) && ms >= 0 ? ms : null;
				}
				const lastTurnMs = stamped ?? wall;
				const messageTtft = safeDuration(message.ttftMs);
				const ttftMs = messageTtft ?? safeDuration(message.usage?.ttftMs);
				const perf: { lastTurnMs?: number; ttftMs?: number } = {};
				if (lastTurnMs !== null) perf.lastTurnMs = lastTurnMs;
				if (ttftMs !== null) perf.ttftMs = ttftMs;
				if (perf.lastTurnMs !== undefined || perf.ttftMs !== undefined) publish(ledger.notePerf(perf));
				seenTiming.add(id);
			}
			if (!message.usage) return;
			const usage = message.usage;
			const cents = costCentsFrom(usage);
			if (cents !== null) {
				publish(ledger.notePerf({ costCents: cents }));
				sink?.push({ at: Date.now(), sessionId: activeSession(), kind: "perf", field: "costCents", value: cents });
			}
			const input = finiteInt(usage.input, !("input" in usage));
			const output = finiteInt(usage.output, !("output" in usage));
			const cacheRead = finiteInt(usage.cacheRead, !("cacheRead" in usage));
			const cacheWrite = finiteInt(usage.cacheWrite, !("cacheWrite" in usage));
			if (input === null || output === null || cacheRead === null || cacheWrite === null) return;
			publish(ledger.addProviderUsage(input, cacheRead, cacheWrite, output));
			if (id === null) seenUnkeyed.add(message);
			else seenMessages.add(id);
		} catch {
			// fail open
		}
	});
	pi.on("before_provider_request", (event) => {
		try {
			if (!event || typeof event !== "object" || !("payload" in event)) return;
			const text = JSON.stringify(event.payload);
			if (typeof text !== "string") return;
			const lastPayloadChars = text.length;
			if (!Number.isSafeInteger(lastPayloadChars) || lastPayloadChars < 0) return;
			publish(ledger.notePerf({ lastPayloadChars }));
			const payload = event.payload;
			if (!payload || typeof payload !== "object") return;
			const prefix = prefixSource(payload);
			if (prefix !== null) {
				const hash = createHash("sha256").update(prefix).digest("hex").slice(0, 16);
				if (prefixHash === null) prefixHash = hash;
				else if (hash !== prefixHash) publish(ledger.notePerf({ prefixChanged: 1 }));
			}
			if ("tools" in payload && Array.isArray(payload.tools)) {
				const names = JSON.stringify(toolNameList(payload.tools));
				const hash = createHash("sha256").update(names).digest("hex").slice(0, 16);
				if (toolsHash === null) toolsHash = hash;
				else if (hash !== toolsHash) publish(ledger.notePerf({ toolsChanged: 1 }));
			}
		} catch {
			// fail open
		}
	});

	/** Bounded shutdown: flush the ledger, then close the sink and shared cache, all within SHUTDOWN_TIMEOUT_MS. */
	async function shutdown(): Promise<void> {
		let timer: Timer | undefined;
		const deadline = new Promise<void>((resolve) => {
			timer = setTimeout(resolve, SHUTDOWN_TIMEOUT_MS);
		});
		const work = Promise.allSettled([ledger.flush(), sink?.close(), sharedCache?.close()]);
		try {
			await Promise.race([work, deadline]);
		} finally {
			clearTimeout(timer);
		}
	}
	if (flags.graphPointer) {
		pi.on("before_agent_start", (event, ctx) => {
			try {
				const cwd = ctx?.cwd;
				const systemPrompt = event?.systemPrompt;
				if (typeof cwd !== "string" || cwd.length === 0 || !Array.isArray(systemPrompt)) return;
				if (systemPrompt.some((part) => typeof part === "string" && part.includes(GRAPH_POINTER))) return;
				const pointer = pointerFor(cwd);
				if (pointer === null) return;
				return { systemPrompt: [...systemPrompt, pointer] };
			} catch {
				// fail open: keep the prompt unchanged
			}
		});
	}
	if (flags.asyncLedger || flags.remoteSink || sharedCache !== null) {
		pi.on("session_shutdown", () => shutdown());
	}
}
