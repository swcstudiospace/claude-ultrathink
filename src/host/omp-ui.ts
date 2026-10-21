// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { type GraphIssue, type GraphModel, type GraphNodeModel, NODE_STAGGER_MS, renderGraph } from "./omp-graph.ts";
import { formatElapsed, type Paint, paint, truncateToWidth, visibleWidth } from "./omp-paint.ts";
import type { ModelResolution } from "./engine.ts";
import type { ProgressEvent, StageName } from "./progress.ts";
import { type PlanView, projectResolution } from "./view.ts";

/** How long the live graph panel stays open after the plan is delivered. */
export const LINGER_MS = 2500;

type Readiness = "ready" | "login" | "none";
type Counts = [number, number];

/** Substrate status as the bar shows it: labels and counts only, never tokens. */
export interface SubstrateSegment {
	state: "checking" | "ok" | "error" | "access-denied";
	usage: "IN_USE" | "NOT_OBSERVED_IN_WINDOW" | "UNKNOWN";
	coverage: { observed: number; known: number } | null;
	planesDown: number | null;
	/** "HH:MM" local time of the last good probe, or "" when none. */
	updatedAt: string;
	reason: string | null;
}

export interface BarState {
	phase: "idle" | "planning" | "delivered" | "skipped" | "failed";
	startedAt?: number;
	finishedAt?: number;
	engine?: string;
	stages: Partial<Record<StageName, "running" | "done" | "failed">>;
	graph?: { total: number; done: number; current?: string };
	/** Only configured providers are present. */
	track?: { linear?: { nodes: Counts; steps: Counts }; notion?: { task: boolean; nodes: Counts; steps: Counts }; errors: number };
	delivery?: "inline" | "aside" | "pending";
	mcp?: { linear: Readiness; notion: Readiness; greptile: Readiness };
	last?: { root: string; nodes: number; issues: number; subIssues: number; firstIssue?: string; trackingStatus?: string; elapsedMs: number; skill?: string };
	/** Planner-side tracking will run this turn (from the `begin` event); false hides the track stage. */
	tracking?: boolean;
	note?: string;
	/** Live Graph of Thought: nodes pop up and their sub-issues drop down as events arrive. */
	model?: GraphModel;
	/** Skill the planned prompt invoked (from the `begin` event). */
	skill?: string;
	/**
	 * This planning's safe selection record (§9 path 4), projected: from `begin`, an unresolved `end` or the delivered
	 * view. Shown with its reason next to the engine; a new planning starts without it until its own `begin`.
	 */
	resolution?: ModelResolution;
	/** Substrate status from the `substrate:status` bus channel; absent until one arrives. */
	substrate?: SubstrateSegment;
	/** Measured token savings from `token-opt:savings`; absent until a valid snapshot arrives. */
	savings?: TokenSavingsSnapshot;
	/** Host session this bar is painting. When set, another session's savings are not shown. */
	liveSessionId?: string;
}

export interface BarStore {
	get(): BarState;
	begin(now: number): void;
	apply(event: ProgressEvent): void;
	delivered(how: "inline" | "aside", view: PlanView | undefined, now: number): void;
	pending(): void;
	skipped(reason: string, now: number): void;
	failed(detail: string, now: number): void;
	setMcp(mcp: NonNullable<BarState["mcp"]>): void;
	setSubstrate(substrate: SubstrateSegment | undefined): void;
	setSavings(snapshot: TokenSavingsSnapshot | undefined): void;
	setLiveSession(id: string | undefined): void;
	subscribe(listener: () => void): () => void;
	/** True while the bar or graph panel needs frame-by-frame renders. */
	animating(now: number): boolean;
}

type IssueEvent = Extract<ProgressEvent, { type: "issue" }>;

function attachIssue(model: GraphModel, event: IssueEvent): GraphModel {
	const issue: GraphIssue = { identifier: event.identifier, url: event.url, at: event.at };
	const linear = event.provider === "linear";
	return {
		nodes: model.nodes.map((node) => {
			if (node.id !== event.nodeId) return node;
			const notion = node.notion || !linear;
			if (event.step === undefined) return { ...node, notion, issue: linear || !node.issue ? issue : node.issue };
			const step = event.step;
			const existing = node.steps.find((s) => s.step === step);
			const steps = existing
				? node.steps.map((s) => (s.step === step ? { ...s, issue: linear || !s.issue ? issue : s.issue } : s))
				: [...node.steps, { step, title: `Step ${step}`, issue }].sort((a, b) => a.step - b.step);
			return { ...node, notion, steps };
		}),
	};
}

function modelFromView(view: PlanView): GraphModel {
	return {
		nodes: view.nodes.map(
			(node): GraphNodeModel => ({
				id: node.id,
				title: node.title,
				kind: node.kind,
				dependsOn: node.dependsOn ?? [],
				status: "done",
				issue: node.issue ? { identifier: node.issue.identifier, url: node.issue.url } : node.notionUrl ? { url: node.notionUrl } : undefined,
				notion: node.notionUrl !== undefined || undefined,
				steps: node.steps.map((step) => ({
					step: step.step,
					title: step.title,
					issue: step.url ? { identifier: step.identifier, url: step.url } : undefined,
				})),
			}),
		),
	};
}

const SUBSTRATE_STATES = ["checking", "ok", "error", "access-denied"] as const;
const SAVINGS_SOURCES = ["provider", "compress", "graph"] as const;

export interface TokenSavingsPoint {
	at: number;
	source: "provider" | "compress" | "graph";
	baseline: number;
	current: number;
	saved: number;
}

/** Measured session savings. `saved` is always `baseline - current`; never an estimate. */
export interface TokenSavingsSnapshot {
	v: 1;
	sessionId: string;
	updatedAt: number;
	baselineTokens: number;
	currentTokens: number;
	savedTokens: number;
	points: TokenSavingsPoint[];
	/** Wall time of the last completed assistant turn. Omitted until measured. */
	lastTurnMs?: number;
	/** Session cache-hit percent, 0-100. Omitted until a provider turn exists. */
	cacheHitPct?: number;
	/** Last graphify spawn or cache-hit latency. Omitted until measured. */
	lastQueryMs?: number;
	/** RTK session delta since start. Not included in savedTokens. Omitted until measured. */
	rtkSavedTokens?: number;
	/** Last provider request payload size in characters. Omitted until measured. */
	lastPayloadChars?: number;
	/** Time to first token on the last turn. Omitted until measured. */
	ttftMs?: number;
	/** Idle time since the last turn. Not included in savedTokens. Omitted until measured. */
	lastIdleMs?: number;
	/** Session cost in cents. Not included in savedTokens. Omitted until measured. */
	costCents?: number;
	/** Provider billed input tokens. Not included in savedTokens. Omitted until measured. */
	providerInput?: number;
	/** Provider billed output tokens. Not included in savedTokens. Omitted until measured. */
	providerOutput?: number;
	/** Provider cache-read tokens. Not included in savedTokens; the hit rate stays on cacheHitPct. Omitted until measured. */
	providerCacheRead?: number;
	/** Provider cache-write tokens. Not included in savedTokens. Omitted until measured. */
	providerCacheWrite?: number;
	/** 1 when the prompt prefix moved. Not included in savedTokens. Omitted until measured. */
	prefixChanged?: 0 | 1;
	/** 1 when the tool set moved. Not included in savedTokens. Omitted until measured. */
	toolsChanged?: 0 | 1;
	/** 1 when the graph is ready. Not included in savedTokens. Omitted until measured. */
	graphReady?: 0 | 1;
}

function isSessionId(value: unknown): value is string {
	return typeof value === "string" && value.length >= 1 && value.length <= 128 && !value.includes("/");
}

function parseSavingsPoint(value: unknown): TokenSavingsPoint | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const { at, source, baseline, current, saved } = value as Record<string, unknown>;
	if (!isCount(at) || !oneOf(SAVINGS_SOURCES, source) || !isCount(baseline) || !isCount(current) || !isCount(saved)) return undefined;
	if (saved !== baseline - current) return undefined;
	return { at, source, baseline, current, saved };
}

/** Absent → undefined. Present but not a safe integer in `0..max` → null, which rejects the snapshot. */
function optionalPerf(data: Record<string, unknown>, key: string, max = Number.MAX_SAFE_INTEGER): number | undefined | null {
	if (!Object.hasOwn(data, key)) return undefined;
	const value = data[key];
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0 || value > max) return null;
	return value;
}

/** `token-opt:savings` v1, or undefined when any required check fails. A present optional perf field outside its range rejects the snapshot. */
export function parseTokenSavings(data: unknown): TokenSavingsSnapshot | undefined {
	try {
		if (typeof data !== "object" || data === null || Array.isArray(data)) return undefined;
		const record = data as Record<string, unknown>;
		const { v, sessionId, updatedAt, baselineTokens, currentTokens, savedTokens, points } = record;
		if (v !== 1 || !isSessionId(sessionId) || !isCount(updatedAt)) return undefined;
		if (!isCount(baselineTokens) || !isCount(currentTokens) || !isCount(savedTokens)) return undefined;
		if (savedTokens !== baselineTokens - currentTokens) return undefined;
		if (!Array.isArray(points) || points.length > 200) return undefined;
		const lastTurnMs = optionalPerf(record, "lastTurnMs");
		const cacheHitPct = optionalPerf(record, "cacheHitPct", 100);
		const lastQueryMs = optionalPerf(record, "lastQueryMs");
		const rtkSavedTokens = optionalPerf(record, "rtkSavedTokens");
		const lastPayloadChars = optionalPerf(record, "lastPayloadChars");
		const ttftMs = optionalPerf(record, "ttftMs");
		const lastIdleMs = optionalPerf(record, "lastIdleMs");
		const costCents = optionalPerf(record, "costCents");
		const providerInput = optionalPerf(record, "providerInput");
		const providerOutput = optionalPerf(record, "providerOutput");
		const providerCacheRead = optionalPerf(record, "providerCacheRead");
		const providerCacheWrite = optionalPerf(record, "providerCacheWrite");
		const prefixChanged = optionalPerf(record, "prefixChanged", 1);
		const toolsChanged = optionalPerf(record, "toolsChanged", 1);
		const graphReady = optionalPerf(record, "graphReady", 1);
		if (lastTurnMs === null || cacheHitPct === null || lastQueryMs === null || rtkSavedTokens === null || lastPayloadChars === null || ttftMs === null) return undefined;
		if (lastIdleMs === null || costCents === null) return undefined;
		if (providerInput === null || providerOutput === null || providerCacheRead === null || providerCacheWrite === null) return undefined;
		if (prefixChanged === null || toolsChanged === null || graphReady === null) return undefined;
		const parsed: TokenSavingsPoint[] = [];
		for (const point of points) {
			const next = parseSavingsPoint(point);
			if (!next) return undefined;
			parsed.push(next);
		}
		const snapshot: TokenSavingsSnapshot = { v: 1, sessionId, updatedAt, baselineTokens, currentTokens, savedTokens, points: parsed };
		if (lastTurnMs !== undefined) snapshot.lastTurnMs = lastTurnMs;
		if (cacheHitPct !== undefined) snapshot.cacheHitPct = cacheHitPct;
		if (lastQueryMs !== undefined) snapshot.lastQueryMs = lastQueryMs;
		// Separate measured counts. Never folded into savedTokens.
		if (rtkSavedTokens !== undefined) snapshot.rtkSavedTokens = rtkSavedTokens;
		if (lastPayloadChars !== undefined) snapshot.lastPayloadChars = lastPayloadChars;
		if (ttftMs !== undefined) snapshot.ttftMs = ttftMs;
		if (lastIdleMs !== undefined) snapshot.lastIdleMs = lastIdleMs;
		if (costCents !== undefined) snapshot.costCents = costCents;
		// Bill totals and cache-stability flags. Never folded into savedTokens.
		if (providerInput !== undefined) snapshot.providerInput = providerInput;
		if (providerOutput !== undefined) snapshot.providerOutput = providerOutput;
		if (providerCacheRead !== undefined) snapshot.providerCacheRead = providerCacheRead;
		if (providerCacheWrite !== undefined) snapshot.providerCacheWrite = providerCacheWrite;
		if (prefixChanged === 0 || prefixChanged === 1) snapshot.prefixChanged = prefixChanged;
		if (toolsChanged === 0 || toolsChanged === 1) snapshot.toolsChanged = toolsChanged;
		if (graphReady === 0 || graphReady === 1) snapshot.graphReady = graphReady;
		return snapshot;
	} catch {
		return undefined;
	}
}

/** 999, 1.2k, 1.2M. Only for counts already checked as non-negative integers. */
function formatTokens(n: number): string {
	if (n < 1000) return String(n);
	const scale = n >= 1_000_000 ? 1_000_000 : 1_000;
	const suffix = n >= 1_000_000 ? "M" : "k";
	const rounded = Math.round((n / scale) * 10) / 10;
	return `${Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)}${suffix}`;
}
const SUBSTRATE_USAGES = ["IN_USE", "NOT_OBSERVED_IN_WINDOW", "UNKNOWN"] as const;
// biome-ignore lint/suspicious/noControlCharactersInRegex: bus text loses terminal control characters
const CONTROL_CHARS = /[\x00-\x1f\x7f-\x9f]/g;

function oneOf<T extends string>(values: readonly T[], value: unknown): value is T {
	return typeof value === "string" && (values as readonly string[]).includes(value);
}

function isCount(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function parseCoverage(value: unknown): SubstrateSegment["coverage"] | undefined {
	if (value === null) return null;
	if (typeof value !== "object" || value === null) return undefined;
	const { observed, known } = value as Record<string, unknown>;
	if (!isCount(observed) || !isCount(known) || observed > known) return undefined;
	return { observed, known };
}

/**
 * The `substrate:status` payload as the bar state holds it, or undefined for anything else. Only the fields the bar
 * shows are kept; `omp` is never read.
 */
export function parseSubstrateStatus(data: unknown): SubstrateSegment | undefined {
	try {
		if (typeof data !== "object" || data === null || Array.isArray(data)) return undefined;
		const { v, state, usage, coverage, planesDown, updatedAt, reason } = data as Record<string, unknown>;
		if (v !== 1 || !oneOf(SUBSTRATE_STATES, state) || !oneOf(SUBSTRATE_USAGES, usage)) return undefined;
		const counts = parseCoverage(coverage);
		const planes = planesDown === null ? null : isCount(planesDown) ? planesDown : undefined;
		if (counts === undefined || planes === undefined || typeof updatedAt !== "string") return undefined;
		const why = reason === null ? null : typeof reason === "string" ? Array.from(reason.replace(CONTROL_CHARS, "")).slice(0, 40).join("") : undefined;
		if (why === undefined) return undefined;
		return { state, usage, coverage: counts, planesDown: planes, updatedAt: Array.from(updatedAt.replace(CONTROL_CHARS, "")).slice(0, 8).join(""), reason: why };
	} catch {
		return undefined;
	}
}

export function createBarStore(): BarStore {
	let state: BarState = { phase: "idle", stages: {} };
	const listeners = new Set<() => void>();
	const set = (next: BarState) => {
		state = next;
		for (const listener of listeners) {
			try {
				listener();
			} catch {
				// a broken listener must never break planning
			}
		}
	};
	const finish = (phase: "skipped" | "failed", note: string, now: number) =>
		set({ ...state, phase, note, finishedAt: now, delivery: undefined });
	return {
		get: () => state,
		begin(now) {
			set({ phase: "planning", startedAt: now, stages: {}, engine: state.engine, mcp: state.mcp, last: state.last, substrate: state.substrate, savings: state.savings, liveSessionId: state.liveSessionId });
		},
		apply(event) {
			switch (event.type) {
				case "begin":
					set({
						...state,
						phase: "planning",
						engine: event.engine,
						tracking: event.track,
						skill: event.skill,
						model: undefined,
						resolution: projectResolution(event.modelResolution) ?? state.resolution,
						startedAt: state.phase === "planning" ? (state.startedAt ?? event.at) : event.at,
					});
					return;
				case "stage": {
					const status = event.phase === "start" ? "running" : event.ok === false ? "failed" : "done";
					set({ ...state, stages: { ...state.stages, [event.stage]: status } });
					return;
				}
				case "graph":
					set({
						...state,
						graph: { total: event.total, done: 0 },
						model: {
							nodes: event.nodes.map((node, i) => ({
								id: node.id,
								title: node.title,
								kind: node.kind,
								dependsOn: node.dependsOn ?? [],
								status: "pending",
								appearedAt: event.at + i * NODE_STAGGER_MS,
								steps: [],
							})),
						},
					});
					return;
				case "node": {
					const done = state.graph?.done ?? 0;
					const model: GraphModel | undefined = state.model && {
						nodes: state.model.nodes.map((node): GraphNodeModel => {
							if (node.id !== event.id) return node;
							if (event.phase === "start") return { ...node, status: "running" };
							const issues = new Map(node.steps.map((step) => [step.step, step.issue]));
							const steps = event.steps
								? event.steps.map((title, j) => ({ step: j + 1, title, appearedAt: event.at, issue: issues.get(j + 1) }))
								: node.steps;
							return { ...node, status: event.fallback ? "fallback" : "done", steps };
						}),
					};
					set({
						...state,
						model,
						graph: event.phase === "start"
							? { total: event.total, done, current: event.title }
							: { total: event.total, done: Math.min(done + 1, event.total) },
					});
					return;
				}
				case "track":
					set({
						...state,
						track: {
							...(event.linear ? { linear: event.linear } : {}),
							...(event.notion ? { notion: event.notion } : {}),
							errors: (state.track?.errors ?? 0) + (event.error ? 1 : 0),
						},
					});
					return;
				case "issue":
					if (state.model) set({ ...state, model: attachIssue(state.model, event) });
					return;
				case "end": {
					// An unresolved end carries its safe reason although no begin or inference happened.
					const resolution = projectResolution(event.modelResolution);
					if (resolution) state = { ...state, resolution };
					if (event.outcome === "skipped") finish("skipped", event.detail ?? "skipped", event.at);
					else if (event.outcome === "failed") finish("failed", event.detail ?? "failed", event.at);
					else set({ ...state, finishedAt: event.at });
					return;
				}
			}
		},
		delivered(how, view, now) {
			const last = view
				? {
						root: view.root,
						nodes: view.nodes.length,
						issues: view.tracking?.issues ?? view.nodes.filter((node) => node.issue).length,
						subIssues: view.tracking?.subIssues ?? view.nodes.reduce((sum, node) => sum + node.steps.filter((step) => step.identifier).length, 0),
						firstIssue: view.nodes.find((node) => node.issue)?.issue?.identifier,
						trackingStatus: view.tracking?.status,
						elapsedMs: view.elapsedMs,
						skill: view.skill ?? state.skill,
					}
				: state.last;
			const base = state.model?.nodes.length ? state.model : view ? modelFromView(view) : state.model;
			// a stage aborted mid-fill never emits `done`; a finished plan must not keep a spinner
			const model = base && { nodes: base.nodes.map((node): GraphNodeModel => (node.status === "running" ? { ...node, status: "fallback" } : node)) };
			const resolution = projectResolution(view?.modelResolution) ?? state.resolution;
			set({ ...state, phase: "delivered", delivery: how, finishedAt: now, last, model, engine: view?.engine ?? state.engine, resolution });
		},
		pending() {
			set({ ...state, delivery: "pending" });
		},
		skipped(reason, now) {
			finish("skipped", reason, now);
		},
		failed(detail, now) {
			finish("failed", detail, now);
		},
		setMcp(mcp) {
			set({ ...state, mcp });
		},
		setSubstrate(substrate) {
			set({ ...state, substrate });
		},
		setSavings(snapshot) {
			const savings = parseTokenSavings(snapshot);
			if (!savings) return;
			set({ ...state, savings });
		},
		setLiveSession(id) {
			if (!isSessionId(id) || state.liveSessionId === id) return;
			set({ ...state, liveSessionId: id });
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		animating(now) {
			if (state.phase === "planning") return true;
			return state.phase === "delivered" && state.finishedAt !== undefined && now - state.finishedAt < LINGER_MS;
		},
	};
}

function stageGlyph(p: Paint, status: "running" | "done" | "failed" | undefined, now: number): string {
	if (status === "running") return p.fg("accent", p.spinner(now));
	if (status === "done") return p.fg("success", p.glyph("success"));
	if (status === "failed") return p.fg("error", p.glyph("error"));
	return p.fg("dim", p.glyph("pending"));
}

function mcpSegment(p: Paint, mcp: BarState["mcp"]): string | undefined {
	if (!mcp) return undefined;
	const mark = (value: Readiness) =>
		value === "ready" ? p.fg("success", p.glyph("success")) : value === "login" ? p.fg("warning", p.glyph("warning")) : p.fg("dim", p.glyph("pending"));
	return `linear ${mark(mcp.linear)} notion ${mark(mcp.notion)} greptile ${mark(mcp.greptile)}`;
}

/** The substrate segment: every state names itself in text; color only adds emphasis. */
function substrateSegment(p: Paint, substrate: SubstrateSegment): string {
	if (substrate.state === "checking") return p.fg("dim", "substrate: checking");
	if (substrate.state === "access-denied") return p.fg("error", "substrate ACCESS_DENIED");
	if (substrate.state === "error") {
		const failed = p.fg("error", `substrate ERROR${substrate.reason ? ` (${substrate.reason})` : ""}`);
		return substrate.updatedAt ? `${failed} · ${p.fg("dim", `last good ${substrate.updatedAt}`)}` : failed;
	}
	const color = substrate.usage === "IN_USE" ? "success" : substrate.usage === "NOT_OBSERVED_IN_WINDOW" ? "warning" : "dim";
	const details: string[] = [];
	if (substrate.coverage) details.push(`${substrate.coverage.observed}/${substrate.coverage.known} observed`);
	if (substrate.planesDown === 0) details.push("planes ok");
	else if (substrate.planesDown !== null) details.push(`${substrate.planesDown} planes down`);
	return [p.fg(color, `substrate ${substrate.usage}`), ...details.map((detail) => p.fg("dim", detail))].join(" · ");
}

/** The substrate segment list: empty until a status has been published, so the bar is unchanged until then. */
function substrateSegments(state: BarState, p: Paint): string[] {
	return state.substrate ? [substrateSegment(p, state.substrate)] : [];
}
/** Savings painted on this bar. A set live session id hides another session's snapshot so the rest of the bar is unchanged. */
function shownSavings(state: BarState): TokenSavingsSnapshot | undefined {
	const savings = state.savings;
	if (!savings) return undefined;
	if (state.liveSessionId !== undefined && savings.sessionId !== state.liveSessionId) return undefined;
	return savings;
}

/** Saved stays in the name chip. Turn time and TTFT share that chip when requested. Prefix, tools and graph-ready share it only when the flag is 1. `before`/`now` follows the name, with cache, query, RTK delta, payload size, idle time, cost, bill and output on that segment. Those extras drop before planning's protected stage or saved. Provider cache tokens are never folded into savedTokens. Another session's snapshot adds neither the chip nor that segment. */
function withSavings(state: BarState, p: Paint, segments: string[], includeTurn: boolean, includeTtft = true, includeStability = true): string[] {
	const savings = shownSavings(state);
	if (!savings || segments.length === 0) return segments;
	const saved = `saved ${formatTokens(savings.savedTokens)}`;
	const chipParts = [saved];
	if (includeTurn && savings.lastTurnMs !== undefined) chipParts.push(`${savings.lastTurnMs}ms`);
	if (includeTtft && savings.ttftMs !== undefined) chipParts.push(`ttft ${savings.ttftMs}ms`);
	if (includeStability && savings.prefixChanged === 1) chipParts.push("prefix moved");
	if (includeStability && savings.toolsChanged === 1) chipParts.push("tools moved");
	if (includeStability && savings.graphReady === 1) chipParts.push("graph ready");
	const named = `${segments[0]} ${p.fg("success", chipParts.join(" · "))}`;
	let detail = `before ${formatTokens(savings.baselineTokens)} · now ${formatTokens(savings.currentTokens)}`;
	if (savings.cacheHitPct !== undefined) detail += ` · cache ${savings.cacheHitPct}%`;
	if (savings.lastQueryMs !== undefined) detail += ` · query ${savings.lastQueryMs}ms`;
	if (savings.rtkSavedTokens !== undefined) detail += ` · rtk +${formatTokens(savings.rtkSavedTokens)}`;
	if (savings.lastPayloadChars !== undefined) detail += ` · payload ${savings.lastPayloadChars}c`;
	if (savings.lastIdleMs !== undefined) detail += ` · idle ${savings.lastIdleMs}ms`;
	if (savings.costCents !== undefined) detail += ` · cost ${savings.costCents}c`;
	if (includeStability && savings.providerInput !== undefined) detail += ` · bill ${formatTokens(savings.providerInput)}`;
	if (includeStability && savings.providerOutput !== undefined) detail += ` · out ${formatTokens(savings.providerOutput)}`;
	const compare = p.fg("dim", detail);
	const rest = segments.slice(1);
	if (state.phase === "planning" && rest.length > 0) return [named, rest[0] ?? "", compare, ...rest.slice(1)];
	return [named, compare, ...rest];
}

function planningSegments(state: BarState, p: Paint, now: number): string[] {
	const name = state.skill ? `ultrathink · ${state.skill}` : "ultrathink";
	const segments = [`${p.fg("accent", p.spinner(now))} ${p.bold(name)}`];
	const current: string[] = [];
	const rest: string[] = [];
	const push = (running: boolean, text: string) => (running && current.length === 0 ? current : rest).push(text);
	push(state.stages.uplift === "running", `uplift ${stageGlyph(p, state.stages.uplift, now)}`);
	const graph = state.graph
		? `graph ${state.graph.done}/${state.graph.total}${state.graph.current ? ` · ${state.graph.current}` : ""}`
		: "graph";
	push(state.stages.think === "running", `${graph} ${stageGlyph(p, state.stages.think, now)}`);
	if (state.stages.knowledge) push(state.stages.knowledge === "running", `kb ${stageGlyph(p, state.stages.knowledge, now)}`);
	push(state.stages.clarify === "running", `clarify ${stageGlyph(p, state.stages.clarify, now)}`);
	if (state.tracking !== false) {
		let track = "track";
		if (state.track) {
			const { linear, notion } = state.track;
			const shown: string[] = [];
			if (linear) shown.push(`linear ${linear.nodes[0]}/${linear.nodes[1]} · steps ${linear.steps[0]}/${linear.steps[1]}`);
			if (notion && state.stages.track && state.stages.track !== "running" && !notion.task && notion.nodes[0] === 0 && notion.steps[0] === 0) {
				shown.push(`notion ${p.fg("error", p.glyph("error"))}`);
			} else if (notion?.task) shown.push(`notion ${notion.nodes[0]}/${notion.nodes[1]}`);
			if (shown.length > 0) track += ` ${shown.join(" · ")}`;
		}
		push(state.stages.track === "running", `${track} ${stageGlyph(p, state.stages.track, now)}`);
	}
	segments.push(...current);
	if (state.delivery === "pending") segments.push(p.fg("warning", "→ plan arrives as aside"));
	segments.push(...rest);
	if (state.startedAt !== undefined) segments.push(formatElapsed(now - state.startedAt));
	// The model this planning runs on, once its own `begin` (or unresolved `end`) named it; dropped after the substrate segment below when narrow.
	const model = state.resolution && modelText(state);
	if (model) segments.push(p.fg("statusLineModel", model));
	segments.push(...substrateSegments(state, p));
	return segments;
}

/** The planning model: the safe record's label with its reason unless the label already shows it, else the engine label. */
function modelText(state: BarState): string | undefined {
	const record = state.resolution;
	if (!record) return state.engine;
	return record.label.includes(`[${record.reason}]`) ? record.label : `${record.label} · ${record.reason}`;
}

/** Last delivered plan: root, tracker rows (or the kickoff hint when the planner tracked nothing), elapsed. */
function lastPlanSegments(last: NonNullable<BarState["last"]>, p: Paint): string[] {
	let issues = p.fg("dim", "issues via kickoff");
	if (last.trackingStatus !== undefined) {
		issues = `${last.issues} issues · ${last.subIssues} sub-issues${last.firstIssue ? ` (${last.firstIssue})` : ""}`;
		if (last.trackingStatus !== "complete") {
			issues += p.fg(last.trackingStatus === "failed" ? "error" : "warning", ` · ${last.trackingStatus}`);
		}
	}
	const root = `${last.root} · ${last.nodes} nodes`;
	const head = last.skill ? [root, p.fg("dim", `via /${last.skill}`)] : [root];
	return [...head, issues, formatElapsed(last.elapsedMs)];
}

/** MCP readiness and engine, trailing every non-planning line. */
function readinessSegments(state: BarState, p: Paint): string[] {
	const segments: string[] = [];
	const mcp = mcpSegment(p, state.mcp);
	if (mcp) segments.push(mcp);
	const model = modelText(state);
	if (model) segments.push(p.fg("statusLineModel", model));
	return segments;
}

function segmentsFor(state: BarState, p: Paint, now: number): string[] {
	switch (state.phase) {
		case "planning":
			return planningSegments(state, p, now);
		case "skipped":
			return [
				p.fg("dim", "ultrathink"),
				...substrateSegments(state, p),
				p.fg("dim", `skipped · ${state.note ?? ""}`),
				...(state.last ? lastPlanSegments(state.last, p) : []),
				...readinessSegments(state, p),
			];
		case "failed":
			return [
				`${p.fg("error", p.glyph("error"))} ${p.fg("error", "ultrathink")}`,
				...substrateSegments(state, p),
				p.fg("error", `failed · ${state.note ?? ""}`),
				...readinessSegments(state, p),
			];
		default: {
			const name = state.phase === "delivered" && state.last ? `${p.fg("success", p.glyph("success"))} ${p.bold("ultrathink")}` : p.bold("ultrathink");
			return [name, ...substrateSegments(state, p), ...(state.last ? lastPlanSegments(state.last, p) : [p.fg("dim", "idle")]), ...readinessSegments(state, p)];
		}
	}
}

/** Drop a leading spinner token so a savings chip can share a narrow planning line with the stage. */
function dropLeadingToken(segment: string): string {
	const compact = segment.replace(/^(?:\x1b\[[0-9;]*m)*(?:<[A-Za-z]+>)?\S+(?:\x1b\[[0-9;]*m)*\s+/, "");
	return compact.length > 0 && compact !== segment ? compact : segment;
}

export function renderBarLine(state: BarState, theme: unknown, width: number, now: number): string {
	if (width <= 0) return "";
	const p = paint(theme);
	const base = segmentsFor(state, p, now);
	let includeTurn = true;
	let includeTtft = true;
	let includeStability = true;
	const savings = shownSavings(state);
	let segments = withSavings(state, p, base, includeTurn, includeTtft, includeStability);
	// planning keeps spinner+name and the current stage (first two); others keep the name
	const minimum = state.phase === "planning" ? 2 : 1;
	const sizeOf = (parts: string[]) => {
		const band = p.band(parts);
		return parts.reduce((sum, segment) => sum + visibleWidth(segment), 0) + band.overhead(parts.length);
	};
	// Prefix, tools, graph-ready, bill and out drop before the stage or saved when they would overflow the protected span.
	if (includeStability && segments.length >= minimum && sizeOf(segments.slice(0, minimum)) > width) {
		includeStability = false;
		segments = withSavings(state, p, base, includeTurn, includeTtft, includeStability);
	}
	// TTFT shares the name chip unless it pushes planning's protected pair over the width. RTK, payload, idle and cost stay on before/now, never the name, so they cannot displace the stage.
	if (state.phase === "planning" && savings?.ttftMs !== undefined && segments.length >= 2 && sizeOf(segments.slice(0, 2)) > width) {
		includeTtft = false;
		segments = withSavings(state, p, base, includeTurn, includeTtft, includeStability);
	}
	// Turn milliseconds share the saved chip unless they push planning's protected pair over the width.
	if (state.phase === "planning" && savings?.lastTurnMs !== undefined && segments.length >= 2 && sizeOf(segments.slice(0, 2)) > width) {
		includeTurn = false;
		segments = withSavings(state, p, base, includeTurn, includeTtft, includeStability);
	}
	if (state.phase === "planning" && savings && segments.length >= 2 && sizeOf(segments.slice(0, 2)) > width) {
		segments = [dropLeadingToken(segments[0] ?? ""), ...segments.slice(1)];
	}
	for (;;) {
		if (sizeOf(segments) <= width || segments.length <= minimum) {
			return sizeOf(segments) <= width ? p.band(segments).text : truncateToWidth(p.band(segments).text, width);
		}
		segments = segments.slice(0, -1);
	}
}

function panelVisible(state: BarState, now: number): boolean {
	if (!state.model?.nodes.length) return false;
	if (state.phase === "planning") return true;
	return state.phase === "delivered" && state.finishedAt !== undefined && now - state.finishedAt < LINGER_MS;
}

export function createBarComponent(
	store: BarStore,
	theme: unknown,
	now: () => number = Date.now,
	rows: () => number = () => process.stdout.rows || 40,
): { render(width: number): readonly string[]; invalidate(): void; dispose(): void } {
	let cached: string[] = [];
	let valid = false;
	return {
		render(width) {
			const state = store.get();
			const at = now();
			let panel: string[] = [];
			if (panelVisible(state, at) && state.model) {
				try {
					const height = rows();
					const maxRows = Math.min(24, Math.max(6, Math.floor((Number.isFinite(height) && height > 0 ? height : 40) * 0.45)));
					panel = renderGraph(state.model, theme, width, { now: at, steps: "active", animate: true, maxRows });
				} catch {
					panel = [];
				}
			}
			const next = [...panel, renderBarLine(state, theme, width, at)];
			if (!valid || next.length !== cached.length || next.some((row, i) => row !== cached[i])) {
				cached = next;
				valid = true;
			}
			return cached;
		},
		invalidate() {
			valid = false;
		},
		dispose() {
			valid = false;
			cached = [];
		},
	};
}
