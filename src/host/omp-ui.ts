// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { type GraphIssue, type GraphModel, type GraphNodeModel, NODE_STAGGER_MS, renderGraph } from "./omp-graph.ts";
import { formatElapsed, type Paint, paint, truncateToWidth, visibleWidth } from "./omp-paint.ts";
import type { ProgressEvent, StageName } from "./progress.ts";
import type { PlanView } from "./view.ts";

/** How long the live graph panel stays open after the plan is delivered. */
export const LINGER_MS = 2500;

type Readiness = "ready" | "login" | "none";
type Counts = [number, number];

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
			set({ phase: "planning", startedAt: now, stages: {}, engine: state.engine, mcp: state.mcp, last: state.last });
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
				case "end":
					if (event.outcome === "skipped") finish("skipped", event.detail ?? "skipped", event.at);
					else if (event.outcome === "failed") finish("failed", event.detail ?? "failed", event.at);
					else set({ ...state, finishedAt: event.at });
					return;
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
			set({ ...state, phase: "delivered", delivery: how, finishedAt: now, last, model, engine: view?.engine ?? state.engine });
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
	return segments;
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
	if (state.engine) segments.push(p.fg("statusLineModel", state.engine));
	return segments;
}

function segmentsFor(state: BarState, p: Paint, now: number): string[] {
	switch (state.phase) {
		case "planning":
			return planningSegments(state, p, now);
		case "skipped":
			return [
				p.fg("dim", "ultrathink"),
				p.fg("dim", `skipped · ${state.note ?? ""}`),
				...(state.last ? lastPlanSegments(state.last, p) : []),
				...readinessSegments(state, p),
			];
		case "failed":
			return [
				`${p.fg("error", p.glyph("error"))} ${p.fg("error", "ultrathink")}`,
				p.fg("error", `failed · ${state.note ?? ""}`),
				...readinessSegments(state, p),
			];
		default: {
			const name = state.phase === "delivered" && state.last ? `${p.fg("success", p.glyph("success"))} ${p.bold("ultrathink")}` : p.bold("ultrathink");
			return [name, ...(state.last ? lastPlanSegments(state.last, p) : [p.fg("dim", "idle")]), ...readinessSegments(state, p)];
		}
	}
}

export function renderBarLine(state: BarState, theme: unknown, width: number, now: number): string {
	if (width <= 0) return "";
	const p = paint(theme);
	let segments = segmentsFor(state, p, now);
	// planning keeps spinner+name and the current stage (first two); others keep the name
	const minimum = state.phase === "planning" ? 2 : 1;
	for (;;) {
		const band = p.band(segments);
		const size = segments.reduce((sum, segment) => sum + visibleWidth(segment), 0) + band.overhead(segments.length);
		if (size <= width || segments.length <= minimum) {
			return size <= width ? band.text : truncateToWidth(band.text, width);
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
