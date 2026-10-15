// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import type { ModelResolution } from "./engine.ts";
import { paint, truncateToWidth, visibleWidth } from "./omp-paint.ts";
import { type BarState, createBarComponent, createBarStore, LINGER_MS, parseSubstrateStatus, parseTokenSavings, renderBarLine, type SubstrateSegment, type TokenSavingsSnapshot } from "./omp-ui.ts";
import type { PlanView } from "./view.ts";
import type { ProgressEvent } from "./progress.ts";

function fakeTheme(bg = "\x1b[48;5;236m") {
	return {
		fg: (color: string, text: string) => `\x1b[38;5;1m<${color}>${text}\x1b[39m`,
		bg: (_color: string, text: string) => text,
		bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
		getFgAnsi: () => "\x1b[38;5;7m",
		getBgAnsi: () => bg,
		sep: { powerlineThinLeft: "›", powerlineLeft: "▶", powerlineCapLeft: "◀", powerlineThinRight: "‹", powerlineRight: "◀", dot: "·", pipe: "|" },
		status: { success: "OK", error: "XX", warning: "WW", pending: "..", running: "RR", done: "DD" },
		getSpinnerFrames: () => ["S1", "S2"],
	};
}

const throwingTheme = {
	fg() {
		throw new Error("unknown color");
	},
	bold() {
		throw new Error("nope");
	},
	getFgAnsi() {
		throw new Error("nope");
	},
	getBgAnsi() {
		throw new Error("nope");
	},
	sep: {},
	status: {},
	getSpinnerFrames() {
		throw new Error("nope");
	},
};

const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "").replace(/<[a-zA-Z]+>/g, "");

const view: PlanView = {
	root: "BUILD_PROMPT",
	source: "llm",
	engine: "grok",
	elapsedMs: 34_000,
	nodes: [
		{ id: "n1", title: "Design", kind: "analysis", wave: 0, dependsOn: [], issue: { identifier: "ENG-12", url: "https://l/ENG-12" }, steps: [{ step: 1, title: "a", identifier: "ENG-13" }] },
		{ id: "n2", title: "Build", kind: "task", wave: 1, dependsOn: ["n1"], steps: [] },
	],
	waves: [["n1"], ["n2"]],
	clarifications: [],
	tracking: { status: "complete", errors: [], issues: 2, subIssues: 1 },
};

function planningState(): BarState {
	const store = createBarStore();
	store.begin(1_000);
	store.apply({ type: "begin", at: 1_000, sessionId: "s", engine: "grok" });
	store.apply({ type: "stage", at: 1_100, stage: "uplift", phase: "start" });
	store.apply({ type: "stage", at: 1_200, stage: "uplift", phase: "end", ok: true });
	store.apply({ type: "stage", at: 1_300, stage: "think", phase: "start" });
	store.apply({ type: "graph", at: 1_400, total: 5, nodes: [] });
	for (let i = 0; i < 3; i++) {
		store.apply({ type: "node", at: 1_500, phase: "start", id: `n${i}`, title: `Node ${i}`, kind: "task", index: i, total: 5 });
		store.apply({ type: "node", at: 1_600, phase: "done", id: `n${i}`, title: `Node ${i}`, kind: "task", index: i, total: 5 });
	}
	store.apply({ type: "node", at: 1_700, phase: "start", id: "n3", title: "Wire bar", kind: "task", index: 3, total: 5 });
	return store.get();
}

describe("bar store", () => {
	test("begin → stages → graph → track → delivered", () => {
		const store = createBarStore();
		let notified = 0;
		store.subscribe(() => notified++);
		const state = planningState();
		expect(state.phase).toBe("planning");
		expect(state.engine).toBe("grok");
		expect(state.stages).toEqual({ uplift: "done", think: "running" });
		expect(state.graph).toEqual({ total: 5, done: 3, current: "Wire bar" });

		store.begin(0);
		store.apply({ type: "track", at: 1, linear: { nodes: [2, 5], steps: [3, 9] }, notion: { task: true, nodes: [0, 5], steps: [0, 9] } });
		store.apply({ type: "track", at: 2, linear: { nodes: [5, 5], steps: [9, 9] }, notion: { task: false, nodes: [0, 5], steps: [0, 9] }, error: "boom" });
		expect(store.get().track?.linear?.nodes).toEqual([5, 5]);
		expect(store.get().track?.errors).toBe(1);
		store.pending();
		expect(store.get().delivery).toBe("pending");
		store.delivered("aside", view, 5);
		expect(store.get().phase).toBe("delivered");
		expect(store.get().last).toEqual({ root: "BUILD_PROMPT", nodes: 2, issues: 2, subIssues: 1, firstIssue: "ENG-12", trackingStatus: "complete", elapsedMs: 34_000 });
		expect(notified).toBe(5);
	});

	test("skipped and failed via lifecycle and end events", () => {
		const store = createBarStore();
		store.begin(0);
		store.apply({ type: "end", at: 3, outcome: "skipped", detail: "slash command" });
		expect(store.get()).toMatchObject({ phase: "skipped", note: "slash command", finishedAt: 3 });
		store.begin(10);
		expect(store.get().phase).toBe("planning");
		store.failed("engine crashed", 11);
		expect(store.get()).toMatchObject({ phase: "failed", note: "engine crashed" });
		store.skipped("short", 12);
		expect(store.get().phase).toBe("skipped");
	});

	test("unsubscribe stops notifications", () => {
		const store = createBarStore();
		let count = 0;
		const off = store.subscribe(() => count++);
		store.pending();
		off();
		store.pending();
		expect(count).toBe(1);
	});
});

function phaseStates(): Record<string, BarState> {
	const pending = { ...planningState(), delivery: "pending" as const };
	const delivered = createBarStore();
	delivered.setMcp({ linear: "ready", notion: "login", greptile: "none" });
	delivered.delivered("inline", view, 50_000);
	return {
		planning: planningState(),
		pending,
		delivered: delivered.get(),
		idle: { phase: "idle", stages: {}, engine: "grok" },
		skipped: { phase: "skipped", stages: {}, note: "too short" },
		failed: { phase: "failed", stages: {}, note: "engine exited 1" },
	};
}

describe("renderBarLine", () => {
	test("each phase shows its content", () => {
		const states = phaseStates();
		const line = (key: string) => plain(renderBarLine(states[key] as BarState, fakeTheme(), 300, 35_000));
		expect(line("planning")).toContain("ultrathink");
		expect(line("planning")).toContain("uplift OK");
		expect(line("planning")).toContain("graph 3/5 · Wire bar");
		expect(line("planning")).toContain("clarify ..");
		expect(line("planning")).toContain("0:34");
		expect(line("pending")).toContain("→ plan arrives as aside");
		expect(line("delivered")).toContain("BUILD_PROMPT · 2 nodes");
		expect(line("delivered")).toContain("2 issues · 1 sub-issues (ENG-12)");
		expect(line("delivered")).toContain("linear OK notion WW greptile ..");
		expect(line("delivered")).toContain("grok");
		expect(line("idle")).toContain("idle");
		expect(line("skipped")).toContain("skipped · too short");
		expect(line("failed")).toContain("failed · engine exited 1");
	});

	test("track segment shows notion failure after track ended", () => {
		const store = createBarStore();
		store.begin(0);
		store.apply({ type: "stage", at: 1, stage: "track", phase: "start" });
		store.apply({ type: "track", at: 2, linear: { nodes: [5, 5], steps: [12, 25] }, notion: { task: false, nodes: [0, 5], steps: [0, 25] }, error: "x" });
		store.apply({ type: "stage", at: 3, stage: "track", phase: "end", ok: false });
		const line = plain(renderBarLine(store.get(), fakeTheme(), 300, 10));
		expect(line).toContain("track linear 5/5 · steps 12/25 · notion XX");
	});

	test("track segment shows only the configured providers", () => {
		const render = (event: ProgressEvent) => {
			const store = createBarStore();
			store.begin(0);
			store.apply({ type: "stage", at: 1, stage: "track", phase: "start" });
			store.apply(event);
			store.apply({ type: "stage", at: 3, stage: "track", phase: "end", ok: true });
			return plain(renderBarLine(store.get(), fakeTheme(), 300, 10));
		};
		const linearOnly = render({ type: "track", at: 2, linear: { nodes: [5, 5], steps: [25, 25] } });
		expect(linearOnly).toContain("track linear 5/5 · steps 25/25 OK");
		expect(linearOnly).not.toContain("notion");
		const notionOnly = render({ type: "track", at: 2, notion: { task: true, nodes: [5, 5], steps: [25, 25] } });
		expect(notionOnly).toContain("track notion 5/5 OK");
		expect(notionOnly).not.toContain("linear");
	});

	test("width constraint holds in every phase", () => {
		for (const [name, state] of Object.entries(phaseStates())) {
			for (const width of [20, 40, 80, 200]) {
				for (const theme of [fakeTheme(), fakeTheme("\x1b[49m"), throwingTheme]) {
					const line = renderBarLine(state, theme, width, 35_000);
					expect({ name, width, ok: visibleWidth(line) <= width }).toEqual({ name, width, ok: true });
					expect(line).not.toContain("\n");
				}
			}
		}
	});

	test("narrow planning keeps spinner, name and the current stage", () => {
		const line = plain(renderBarLine(planningState(), fakeTheme(), 50, 35_000));
		expect(line).toContain("ultrathink");
		expect(line).toContain("graph 3/5");
		expect(line).not.toContain("0:34");
	});

	test("plain fallback when theme throws", () => {
		const line = renderBarLine(planningState(), throwingTheme, 200, 35_000);
		expect(line).not.toContain("\x1b");
		expect(line).toContain("● ultrathink │ graph 3/5 · Wire bar ●");
		expect(line).toContain("uplift ✓");
	});

	test("transparent bg drops caps", () => {
		const opaque = renderBarLine(phaseStates().idle as BarState, fakeTheme(), 200, 0);
		const clear = renderBarLine(phaseStates().idle as BarState, fakeTheme("\x1b[49m"), 200, 0);
		expect(plain(opaque)).toStartWith("◀");
		expect(plain(opaque)).toEndWith("▶");
		expect(plain(clear)).not.toContain("◀");
		expect(plain(clear)).not.toContain("▶");
	});

	test("planning without planner-side tracking has no track segment", () => {
		const store = createBarStore();
		store.begin(0);
		store.apply({ type: "begin", at: 0, sessionId: "s", engine: "grok", track: false });
		expect(store.get().tracking).toBe(false);
		const line = plain(renderBarLine(store.get(), fakeTheme(), 300, 10));
		expect(line).toContain("clarify");
		expect(line).not.toContain("track");
		store.begin(1);
		store.apply({ type: "begin", at: 1, sessionId: "s", engine: "grok", track: true });
		expect(plain(renderBarLine(store.get(), fakeTheme(), 300, 10))).toContain("track ..");
	});

	test("delivered summary: kickoff hint without planner rows, status suffix when tracking is incomplete", () => {
		const untracked = createBarStore();
		untracked.delivered("inline", { ...view, tracking: undefined }, 1);
		const hint = plain(renderBarLine(untracked.get(), fakeTheme(), 300, 1));
		expect(hint).toContain("BUILD_PROMPT · 2 nodes");
		expect(hint).toContain("issues via kickoff");
		expect(hint).not.toContain("sub-issues");

		const partial = createBarStore();
		partial.delivered("inline", { ...view, tracking: { status: "partial", errors: ["x"], issues: 1, subIssues: 0 } }, 1);
		const raw = renderBarLine(partial.get(), fakeTheme(), 300, 1);
		expect(plain(raw)).toContain("1 issues · 0 sub-issues (ENG-12) · partial");
		expect(raw).toContain("<warning> · partial");

		const failed = createBarStore();
		failed.delivered("inline", { ...view, tracking: { status: "failed", errors: ["x"], issues: 0, subIssues: 0 } }, 1);
		expect(renderBarLine(failed.get(), fakeTheme(), 300, 1)).toContain("<error> · failed");
	});

	test("skipped and failed keep the context: last plan (skipped only), MCP readiness and engine", () => {
		const store = createBarStore();
		store.setMcp({ linear: "ready", notion: "login", greptile: "none" });
		store.delivered("inline", view, 1);
		store.begin(2);
		store.skipped("too short", 3);
		const skipped = plain(renderBarLine(store.get(), fakeTheme(), 300, 3));
		expect(skipped).toContain("skipped · too short");
		expect(skipped).toContain("BUILD_PROMPT · 2 nodes");
		expect(skipped).toContain("linear OK");
		expect(skipped).toContain("grok");
		store.failed("engine exited 1", 4);
		const failed = plain(renderBarLine(store.get(), fakeTheme(), 300, 4));
		expect(failed).toContain("failed · engine exited 1");
		expect(failed).toContain("linear OK");
		expect(failed).toContain("grok");
		expect(failed).not.toContain("BUILD_PROMPT");
	});
});

describe("terminal width", () => {
	const cjk = "\x1b[1m計画を立てる\x1b[22m ultrathink 漢字テスト 🚀 done";

	test("visibleWidth counts wide chars as two columns", () => {
		expect(visibleWidth("漢")).toBe(2);
		expect(visibleWidth("\x1b[38;5;1ma漢\x1b[39m")).toBe(3);
	});

	test("truncateToWidth never overflows on wide chars", () => {
		for (const width of [5, 11, 40]) {
			const out = truncateToWidth(cjk, width);
			expect({ width, ok: visibleWidth(out) <= width }).toEqual({ width, ok: true });
		}
		expect(truncateToWidth("漢字漢字", 4)).toBe("漢…");
		// multi-code-point graphemes (VS16, keycap, ZWJ family) are measured as one cluster
		for (const text of ["❤️❤️❤️❤️", "1️⃣1️⃣1️⃣1️⃣", "👨‍👩‍👧👨‍👩‍👧👨‍👩‍👧"]) {
			for (const width of [3, 4, 5]) {
				const out = truncateToWidth(text, width);
				expect({ text, width, ok: visibleWidth(out) <= width }).toEqual({ text, width, ok: true });
			}
		}
		expect(truncateToWidth("❤️❤️❤️❤️", 4)).toBe("❤️…");
	});
});

describe("paint box and icon", () => {
	test("uses theme box chars only when all are strings, else the rounded fallback", () => {
		const fallback = { topLeft: "╭", topRight: "╮", bottomLeft: "╰", bottomRight: "╯", horizontal: "─", vertical: "│" };
		const full = { topLeft: "┌", topRight: "┐", bottomLeft: "└", bottomRight: "┘", horizontal: "-", vertical: "|" };
		expect(paint({ boxRound: full }).boxChars()).toEqual(full);
		expect(paint({ boxRound: { ...full, vertical: 1 } }).boxChars()).toEqual(fallback);
		expect(paint(throwingTheme).boxChars()).toEqual(fallback);
		expect(paint({ icon: { package: "📦" } }).icon("package")).toBe("📦");
		expect(paint(throwingTheme).icon("package")).toBe("");
	});
});

describe("createBarComponent", () => {
	test("same array while unchanged, new after a store change", () => {
		const store = createBarStore();
		const component = createBarComponent(store, fakeTheme(), () => 0);
		const first = component.render(80);
		expect(component.render(80)).toBe(first);
		store.begin(0);
		const second = component.render(80);
		expect(second).not.toBe(first);
		expect(second).toHaveLength(1);
		expect(component.render(80)).toBe(second);
	});
});

describe("live graph", () => {
	const graphNodes = [
		{ id: "a", title: "Design the schema", kind: "analysis", dependsOn: [] },
		{ id: "b", title: "Build the API", kind: "task", dependsOn: ["a"] },
		{ id: "c", title: "Write tests", kind: "task" },
	];

	function liveStore() {
		const store = createBarStore();
		store.begin(1_000);
		store.apply({ type: "begin", at: 1_000, sessionId: "s", engine: "grok", skill: "gsd-quick" });
		store.apply({ type: "graph", at: 2_000, total: 3, nodes: graphNodes });
		return store;
	}

	test("graph event staggers node pop-ups in event order", () => {
		const model = liveStore().get().model;
		expect(model?.nodes.map((node) => [node.id, node.appearedAt, node.status])).toEqual([
			["a", 2_000, "pending"],
			["b", 2_090, "pending"],
			["c", 2_180, "pending"],
		]);
		expect(model?.nodes[2]?.dependsOn).toEqual([]);
		expect(model?.nodes[1]?.dependsOn).toEqual(["a"]);
	});

	test("node start runs, done fills steps and merges issues attached earlier", () => {
		const store = liveStore();
		store.apply({ type: "node", at: 2_500, phase: "start", id: "a", title: "Design the schema", kind: "analysis", index: 0, total: 3 });
		expect(store.get().model?.nodes[0]?.status).toBe("running");
		store.apply({ type: "issue", at: 2_600, provider: "linear", nodeId: "a", step: 2, identifier: "ENG-2", url: "https://l/2" });
		expect(store.get().model?.nodes[0]?.steps).toEqual([{ step: 2, title: "Step 2", issue: { identifier: "ENG-2", url: "https://l/2", at: 2_600 } }]);
		store.apply({ type: "node", at: 3_000, phase: "done", id: "a", title: "Design the schema", kind: "analysis", index: 0, total: 3, steps: ["Step 1: x", "Step 2: y"] });
		const node = store.get().model?.nodes[0];
		expect(node?.status).toBe("done");
		expect(node?.steps).toEqual([
			{ step: 1, title: "Step 1: x", appearedAt: 3_000, issue: undefined },
			{ step: 2, title: "Step 2: y", appearedAt: 3_000, issue: { identifier: "ENG-2", url: "https://l/2", at: 2_600 } },
		]);
		store.apply({ type: "node", at: 3_100, phase: "done", id: "b", title: "Build the API", kind: "task", index: 1, total: 3, fallback: true });
		expect(store.get().model?.nodes[1]?.status).toBe("fallback");
	});

	test("notion refs mark the node and never replace a linear ref", () => {
		const store = liveStore();
		store.apply({ type: "issue", at: 2_100, provider: "linear", nodeId: "a", identifier: "ENG-1", url: "https://l/1" });
		store.apply({ type: "issue", at: 2_200, provider: "notion", nodeId: "a", url: "https://n/1" });
		store.apply({ type: "issue", at: 2_300, provider: "notion", nodeId: "b", url: "https://n/2" });
		const [a, b] = store.get().model?.nodes ?? [];
		expect(a?.notion).toBe(true);
		expect(a?.issue?.identifier).toBe("ENG-1");
		expect(b?.issue?.url).toBe("https://n/2");
		store.apply({ type: "issue", at: 2_400, provider: "linear", nodeId: "b", identifier: "ENG-3", url: "https://l/3" });
		expect(store.get().model?.nodes[1]?.issue?.identifier).toBe("ENG-3");
	});

	test("delivered without events builds a settled model from the view", () => {
		const store = createBarStore();
		store.begin(1_000);
		store.delivered("inline", view, 5_000);
		const model = store.get().model;
		expect(model?.nodes.map((node) => [node.id, node.status, node.appearedAt, node.dependsOn])).toEqual([
			["n1", "done", undefined, []],
			["n2", "done", undefined, ["n1"]],
		]);
		expect(model?.nodes[0]?.issue).toEqual({ identifier: "ENG-12", url: "https://l/ENG-12" });
	});

	test("delivery settles a node aborted mid-fill and stops animating after the linger window", () => {
		const store = liveStore();
		store.apply({ type: "node", at: 2_500, phase: "start", id: "a", title: "Design the schema", kind: "analysis", index: 0, total: 3 });
		store.delivered("inline", view, 6_000);
		expect(store.get().model?.nodes.map((node) => node.status)).toEqual(["fallback", "pending", "pending"]);
		expect(store.animating(6_000 + LINGER_MS - 1)).toBe(true);
		expect(store.animating(6_000 + LINGER_MS + 1)).toBe(false);
	});

	test("begin resets the previous model", () => {
		const store = liveStore();
		store.begin(9_000);
		expect(store.get().model).toBeUndefined();
	});

	test("panel shows above the bar while planning and collapses after the linger window", () => {
		const store = liveStore();
		let clock = 5_000;
		const component = createBarComponent(store, fakeTheme(), () => clock, () => 40);
		const planning = component.render(80);
		expect(planning.length).toBeGreaterThan(1);
		expect(plain(planning[planning.length - 1] ?? "")).toContain("ultrathink · gsd-quick");
		store.delivered("inline", view, 6_000);
		clock = 6_000 + LINGER_MS - 1;
		expect(component.render(80).length).toBeGreaterThan(1);
		clock = 6_000 + LINGER_MS;
		const collapsed = component.render(80);
		expect(collapsed).toHaveLength(1);
		expect(plain(collapsed[0] ?? "")).toContain("via /gsd-quick");
		expect(store.animating(clock + 10_000)).toBe(false);
	});

	test("only the bar shows before the first node pops up", () => {
		const store = createBarStore();
		store.begin(1_000);
		store.apply({ type: "graph", at: 10_000, total: 1, nodes: [graphNodes[0] ?? { id: "x", title: "x", kind: "task" }] });
		const rows = createBarComponent(store, fakeTheme(), () => 5_000, () => 40).render(80);
		expect(rows.filter((row) => plain(row).includes("Design the schema"))).toHaveLength(0);
		expect(plain(rows[rows.length - 1] ?? "")).toContain("ultrathink");
	});

	test("skipped shows only the bar", () => {
		const store = liveStore();
		store.skipped("trivial", 3_000);
		expect(createBarComponent(store, fakeTheme(), () => 3_000, () => 40).render(80)).toHaveLength(1);
		expect(store.animating(3_000)).toBe(false);
	});

	test("row count respects the terminal-derived cap", () => {
		const store = createBarStore();
		store.begin(1_000);
		const many = Array.from({ length: 30 }, (_, i) => ({ id: `n${i}`, title: `Node ${i}`, kind: "task", dependsOn: [] }));
		store.apply({ type: "graph", at: 0, total: many.length, nodes: many });
		for (const node of many) {
			store.apply({ type: "node", at: 1, phase: "done", id: node.id, title: node.title, kind: "task", index: 0, total: 30, steps: ["Step 1: a", "Step 2: b"] });
		}
		const rows = createBarComponent(store, fakeTheme(), () => 2, () => 20).render(80);
		expect(rows.length).toBeLessThanOrEqual(Math.max(6, Math.floor(20 * 0.45)) + 1);
	});

	test("returns the same array while nothing changes", () => {
		const store = liveStore();
		const component = createBarComponent(store, fakeTheme(), () => 60_000, () => 40);
		const first = component.render(80);
		expect(component.render(80)).toBe(first);
	});
});

describe("model resolution on the bar (§9 path 4)", () => {
	const record = (fields: Partial<ModelResolution>): ModelResolution => ({
		version: "1.0.0",
		state: "detected",
		host: "omp",
		transport: "omp-native",
		source: "ctx.model",
		reason: "live-model",
		engineSelection: { engine: "auto", source: "config", nativeOptOut: false },
		modelKnown: true,
		label: "",
		...fields,
	});
	const DETECTED = record({ provider: "acme", modelId: "sol-1", label: "omp-native:acme/sol-1 [detected]" });
	const DEFAULTED = record({
		state: "default",
		source: "host-catalog",
		reason: "active-unavailable",
		provider: "acme",
		modelId: "def-1",
		label: "omp-native:acme/def-1 [host-catalog default]",
	});
	const OVERRIDE = record({ state: "override", source: "host-override", reason: "explicit-model", provider: "anthropic", modelId: "opus", label: "omp-native:anthropic/opus [override]" });
	const UNRESOLVED = record({ state: "unresolved", source: "none", reason: "provider-unknown", modelKnown: false, label: "omp-native:unresolved [provider-unknown]" });
	const line = (state: BarState) => plain(renderBarLine(state, fakeTheme(), 400, 2_000));

	test("begin names the planning model with its reason while planning; delivery keeps it", () => {
		const store = createBarStore();
		store.begin(1_000);
		store.apply({ type: "begin", at: 1_000, sessionId: "s", engine: DETECTED.label, modelResolution: DETECTED });
		expect(store.get().resolution).toEqual(DETECTED);
		expect(line(store.get())).toContain("omp-native:acme/sol-1 [detected] · live-model");
		store.delivered("inline", view, 1_500);
		expect(line(store.get())).toContain("omp-native:acme/sol-1 [detected] · live-model");
	});

	test("default and override show their labels and reasons; an unresolved end needs no begin and shows its reason once", () => {
		for (const [resolution, text] of [
			[DEFAULTED, "omp-native:acme/def-1 [host-catalog default] · active-unavailable"],
			[OVERRIDE, "omp-native:anthropic/opus [override] · explicit-model"],
		] as const) {
			const store = createBarStore();
			store.begin(0);
			store.apply({ type: "begin", at: 0, sessionId: "s", engine: resolution.label, modelResolution: resolution });
			store.delivered("aside", view, 1);
			expect(line(store.get())).toContain(text);
		}
		const store = createBarStore();
		store.begin(0);
		store.apply({ type: "end", at: 1, outcome: "skipped", detail: "provider-unknown", modelResolution: UNRESOLVED });
		const skipped = line(store.get());
		expect(skipped).toContain("skipped · provider-unknown");
		expect(skipped).toContain("omp-native:unresolved [provider-unknown]");
		expect(skipped).not.toContain("[provider-unknown] · provider-unknown");
	});

	test("an unsafe record never reaches the bar: its label shows the opaque marker", () => {
		const store = createBarStore();
		store.begin(0);
		store.apply({ type: "begin", at: 0, sessionId: "s", engine: "x", modelResolution: { ...DETECTED, label: "omp-native:https://SECRET.invalid/model [detected]" } });
		const text = line(store.get());
		expect(text).toContain("<opaque-model> · live-model");
		expect(text).not.toContain("SECRET");
	});

	test("a new planning drops the previous record until its own begin names one", () => {
		const store = createBarStore();
		store.apply({ type: "begin", at: 0, sessionId: "s", engine: DETECTED.label, modelResolution: DETECTED });
		store.delivered("inline", view, 1);
		store.begin(2);
		expect(store.get().resolution).toBeUndefined();
		expect(line(store.get())).not.toContain("[detected]");
	});

	test("width holds with a resolution in every phase and theme", () => {
		const planning = createBarStore();
		planning.begin(0);
		planning.apply({ type: "begin", at: 0, sessionId: "s", engine: OVERRIDE.label, modelResolution: OVERRIDE });
		const delivered = createBarStore();
		delivered.apply({ type: "begin", at: 0, sessionId: "s", engine: DEFAULTED.label, modelResolution: DEFAULTED });
		delivered.delivered("inline", view, 1);
		const skipped = createBarStore();
		skipped.apply({ type: "end", at: 1, outcome: "skipped", detail: "provider-unknown", modelResolution: UNRESOLVED });
		for (const state of [planning.get(), delivered.get(), skipped.get()]) {
			for (const width of [20, 40, 80, 200]) {
				for (const theme of [fakeTheme(), throwingTheme]) {
					expect(visibleWidth(renderBarLine(state, theme, width, 1_000))).toBeLessThanOrEqual(width);
				}
			}
		}
	});
});

describe("substrate segment", () => {
	const ok: SubstrateSegment = { state: "ok", usage: "IN_USE", coverage: { observed: 6, known: 10 }, planesDown: 0, updatedAt: "10:42", reason: null };
	const payload = { v: 1, state: "ok", usage: "IN_USE", omp: { req: 3, emit: 4, tool: 5 }, coverage: { observed: 6, known: 10 }, planesDown: 0, updatedAt: "10:42", reason: null };
	const quiet: Omit<SubstrateSegment, "state"> = { usage: "UNKNOWN", coverage: null, planesDown: null, updatedAt: "", reason: null };
	const render = (substrate: SubstrateSegment | undefined, width = 300) => {
		const store = createBarStore();
		store.setSubstrate(substrate);
		return plain(renderBarLine(store.get(), fakeTheme(), width, 0));
	};

	test("parseSubstrateStatus accepts a valid ok payload", () => {
		expect(parseSubstrateStatus(payload)).toEqual(ok);
	});

	test("parseSubstrateStatus rejects other versions, states, shapes and counts", () => {
		expect(parseSubstrateStatus({ ...payload, v: 2 })).toBeUndefined();
		expect(parseSubstrateStatus({ ...payload, state: "weird" })).toBeUndefined();
		expect(parseSubstrateStatus({ ...payload, usage: "MAYBE" })).toBeUndefined();
		expect(parseSubstrateStatus({ ...payload, coverage: { observed: 11, known: 10 } })).toBeUndefined();
		expect(parseSubstrateStatus({ ...payload, coverage: { observed: 1.5, known: 10 } })).toBeUndefined();
		expect(parseSubstrateStatus({ ...payload, planesDown: -1 })).toBeUndefined();
		expect(parseSubstrateStatus({ ...payload, updatedAt: 1020 })).toBeUndefined();
		for (const value of ["ok", 42, null, undefined, [payload]]) expect(parseSubstrateStatus(value)).toBeUndefined();
	});

	test("parseSubstrateStatus strips ESC and BEL, then caps reason at 40 and updatedAt at 8", () => {
		const parsed = parseSubstrateStatus({ ...payload, state: "error", reason: `\x1bdown\x07 ${"x".repeat(60)}`, updatedAt: "10:42:00:99" });
		expect(parsed?.reason).toBe(`down ${"x".repeat(35)}`);
		expect(parsed?.updatedAt).toBe("10:42:00");
	});

	test("ok IN_USE shows usage, coverage and planes", () => {
		const line = render(ok);
		expect(line).toContain("substrate IN_USE");
		expect(line).toContain("6/10 observed");
		expect(line).toContain("planes ok");
	});

	test("every state names itself in text", () => {
		expect(render({ ...quiet, state: "checking" })).toContain("substrate: checking");
		expect(render({ ...quiet, state: "access-denied" })).toContain("substrate ACCESS_DENIED");
		expect(render({ ...quiet, state: "error", reason: "timeout", updatedAt: "10:42" })).toContain("substrate ERROR (timeout) · last good 10:42");
		expect(render({ ...quiet, state: "error", reason: null })).toContain("substrate ERROR");
		expect(render({ ...quiet, state: "error", reason: null })).not.toContain("ERROR (");
		expect(render({ ...ok, usage: "NOT_OBSERVED_IN_WINDOW", coverage: { observed: 0, known: 10 }, planesDown: 2 })).toContain(
			"substrate NOT_OBSERVED_IN_WINDOW · 0/10 observed · 2 planes down",
		);
	});

	test("the label survives a width that drops the readiness segments", () => {
		const store = createBarStore();
		store.setMcp({ linear: "ready", notion: "login", greptile: "none" });
		store.delivered("inline", view, 1);
		store.setSubstrate(ok);
		const narrow = plain(renderBarLine(store.get(), fakeTheme(), 100, 1));
		expect(narrow).toContain("substrate IN_USE · 6/10 observed");
		expect(narrow).not.toContain("linear");
	});

	test("substrate follows the name when skipped and comes last while planning", () => {
		const skipped = createBarStore();
		skipped.setSubstrate(ok);
		skipped.skipped("too short", 3);
		const skippedLine = plain(renderBarLine(skipped.get(), fakeTheme(), 300, 3));
		expect(skippedLine.indexOf("ultrathink")).toBeLessThan(skippedLine.indexOf("substrate"));
		expect(skippedLine.indexOf("substrate")).toBeLessThan(skippedLine.indexOf("skipped ·"));
		const planning: BarState = { ...planningState(), substrate: ok };
		const planningLine = plain(renderBarLine(planning, fakeTheme(), 300, 35_000));
		expect(planningLine.indexOf("0:34")).toBeLessThan(planningLine.indexOf("substrate"));
	});

	test("without a substrate status the bar renders as before", () => {
		for (const state of Object.values(phaseStates())) {
			for (const width of [40, 200]) {
				expect(renderBarLine({ ...state, substrate: undefined }, fakeTheme(), width, 35_000)).toBe(renderBarLine(state, fakeTheme(), width, 35_000));
			}
		}
	});

	test("width holds with a substrate status in every phase and theme", () => {
		for (const state of Object.values(phaseStates())) {
			for (const width of [20, 40, 80, 200]) {
				for (const theme of [fakeTheme(), fakeTheme("\x1b[49m"), throwingTheme]) {
					expect(visibleWidth(renderBarLine({ ...state, substrate: ok }, theme, width, 35_000))).toBeLessThanOrEqual(width);
				}
			}
		}
	});

	test("setSubstrate sets the state, notifies listeners and survives a new planning", () => {
		const store = createBarStore();
		let notified = 0;
		store.subscribe(() => notified++);
		store.setSubstrate(ok);
		expect(store.get().substrate).toEqual(ok);
		store.begin(1);
		expect(store.get().substrate).toEqual(ok);
		store.setSubstrate(undefined);
		expect(store.get().substrate).toBeUndefined();
		expect(notified).toBe(3);
	});
});

describe("token savings", () => {
	const snapshot: TokenSavingsSnapshot = {
		v: 1,
		sessionId: "sess-1",
		updatedAt: 1_700_000_000_000,
		baselineTokens: 1_200_000,
		currentTokens: 1_200,
		savedTokens: 1_198_800,
		points: [{ at: 1, source: "compress", baseline: 1_200_000, current: 1_200, saved: 1_198_800 }],
	};

	test("a wide line shows saved and before/now", () => {
		const store = createBarStore();
		store.setSavings(snapshot);
		const line = plain(renderBarLine(store.get(), fakeTheme(), 300, 0));
		expect(line).toContain("saved 1.2M");
		expect(line).toContain("before 1.2M");
		expect(line).toContain("now 1.2k");
	});

	test("a 50-column planning line keeps the current stage and saved", () => {
		const state: BarState = { ...planningState(), savings: { ...snapshot, baselineTokens: 20, currentTokens: 8, savedTokens: 12, points: [] } };
		const line = plain(renderBarLine(state, fakeTheme(), 50, 35_000));
		expect(line).toContain("graph 3/5");
		expect(line).toContain("saved 12");
	});

	test("a snapshot whose saved is not baseline minus current is ignored", () => {
		const store = createBarStore();
		store.setSavings(snapshot);
		const before = renderBarLine(store.get(), fakeTheme(), 300, 0);
		store.setSavings({ ...snapshot, savedTokens: snapshot.savedTokens - 1 });
		expect(store.get().savings).toEqual(snapshot);
		expect(renderBarLine(store.get(), fakeTheme(), 300, 0)).toBe(before);
	});

	test("parseTokenSavings rejects negatives and accepts a minimal valid object", () => {
		const minimal = { v: 1, sessionId: "s", updatedAt: 1, baselineTokens: 0, currentTokens: 0, savedTokens: 0, points: [] };
		expect(parseTokenSavings(minimal)).toEqual(minimal);
		expect(parseTokenSavings({ ...minimal, savedTokens: -1 })).toBeUndefined();
		expect(parseTokenSavings({ ...minimal, baselineTokens: -1, savedTokens: -1 })).toBeUndefined();
		expect(parseTokenSavings({ ...minimal, currentTokens: -1 })).toBeUndefined();
		expect(parseTokenSavings({ ...snapshot, points: [{ at: -1, source: "graph", baseline: 1, current: 0, saved: 1 }] })).toBeUndefined();
	});

	test("idle, skipped, failed and delivered lines keep the saved chip", () => {
		for (const key of ["idle", "skipped", "failed", "delivered"] as const) {
			const line = plain(renderBarLine({ ...phaseStates()[key]!, savings: snapshot }, fakeTheme(), 300, 35_000));
			expect(line).toContain("saved 1.2M");
			expect(line).toContain("before 1.2M");
			expect(line).toContain("now 1.2k");
		}
	});

	test("a wide line shows turn milliseconds and cache percent", () => {
		const store = createBarStore();
		store.setSavings({ ...snapshot, lastTurnMs: 840, cacheHitPct: 72, lastQueryMs: 15 });
		const line = plain(renderBarLine(store.get(), fakeTheme(), 300, 0));
		expect(line).toContain("840ms");
		expect(line).toContain("saved 1.2M · 840ms");
		expect(line).toContain("cache 72%");
		expect(line).toContain("query 15ms");
		expect(line).toContain("before 1.2M");
		expect(line).toContain("now 1.2k");
	});

	test("a narrow planning line keeps the stage and saved when turn time does not fit", () => {
		const state: BarState = {
			...planningState(),
			savings: { ...snapshot, baselineTokens: 20, currentTokens: 8, savedTokens: 12, points: [], lastTurnMs: 840, cacheHitPct: 72, lastQueryMs: 15 },
		};
		const line = plain(renderBarLine(state, fakeTheme(), 50, 35_000));
		expect(line).toContain("graph 3/5");
		expect(line).toContain("saved 12");
		expect(line).not.toContain("840ms");
	});

	test("parseTokenSavings rejects lastTurnMs below zero and copies valid perf fields", () => {
		const minimal = { v: 1, sessionId: "s", updatedAt: 1, baselineTokens: 0, currentTokens: 0, savedTokens: 0, points: [] };
		expect(parseTokenSavings({ ...minimal, lastTurnMs: -1 })).toBeUndefined();
		expect(parseTokenSavings({ ...minimal, lastTurnMs: 840, cacheHitPct: -1 })).toBeUndefined();
		expect(parseTokenSavings({ ...minimal, cacheHitPct: 101 })).toBeUndefined();
		expect(parseTokenSavings({ ...minimal, lastQueryMs: -1 })).toBeUndefined();
		expect(parseTokenSavings({ ...minimal, lastTurnMs: 1.5 })).toBeUndefined();
		expect(parseTokenSavings({ ...minimal, cacheHitPct: "72" })).toBeUndefined();
		expect(parseTokenSavings({ ...minimal, lastQueryMs: Number.MAX_SAFE_INTEGER + 1 })).toBeUndefined();
		expect(parseTokenSavings({ ...minimal, lastTurnMs: 840, cacheHitPct: 72, lastQueryMs: 15 })).toEqual({
			...minimal,
			lastTurnMs: 840,
			cacheHitPct: 72,
			lastQueryMs: 15,
		});
		expect(parseTokenSavings({ ...minimal, lastTurnMs: 0, cacheHitPct: 100, lastQueryMs: 0 })).toEqual({
			...minimal,
			lastTurnMs: 0,
			cacheHitPct: 100,
			lastQueryMs: 0,
		});
		expect(parseTokenSavings({ ...minimal, cacheHitPct: 72 })).toEqual({ ...minimal, cacheHitPct: 72 });
	});

	test("a snapshot without perf fields still renders saved and before/now", () => {
		const parsed = parseTokenSavings(snapshot);
		expect(parsed).toEqual(snapshot);
		expect(parsed !== undefined && Object.hasOwn(parsed, "lastTurnMs")).toBe(false);
		expect(parsed !== undefined && Object.hasOwn(parsed, "cacheHitPct")).toBe(false);
		expect(parsed !== undefined && Object.hasOwn(parsed, "lastQueryMs")).toBe(false);
		const line = plain(renderBarLine({ phase: "idle", stages: {}, savings: parsed }, fakeTheme(), 300, 0));
		expect(line).toContain("saved 1.2M");
		expect(line).toContain("before 1.2M");
		expect(line).toContain("now 1.2k");
		expect(line).not.toContain("cache ");
		expect(line).not.toContain("ms");
	});

	test("rtkSavedTokens 10 renders rtk +10 at width 300", () => {
		const store = createBarStore();
		store.setSavings({ ...snapshot, rtkSavedTokens: 10, lastPayloadChars: 4096, ttftMs: 120 });
		const line = plain(renderBarLine(store.get(), fakeTheme(), 300, 0));
		expect(line).toContain("rtk +10");
		expect(line).toContain("payload 4096c");
		expect(line).toContain("ttft 120ms");
		expect(line).toContain("saved 1.2M");
		expect(line).toContain("before 1.2M");
		expect(line).toContain("now 1.2k");
		expect(store.get().savings?.savedTokens).toBe(snapshot.savedTokens);
		const savedAt = line.indexOf("saved 1.2M");
		const ttftAt = line.indexOf("ttft 120ms");
		const beforeAt = line.indexOf("before 1.2M");
		const rtkAt = line.indexOf("rtk +10");
		const payloadAt = line.indexOf("payload 4096c");
		expect(ttftAt).toBeGreaterThan(savedAt);
		expect(beforeAt).toBeGreaterThan(ttftAt);
		expect(rtkAt).toBeGreaterThan(beforeAt);
		expect(payloadAt).toBeGreaterThan(rtkAt);
	});

	test("ttftMs -1 rejects the snapshot", () => {
		const minimal = { v: 1, sessionId: "s", updatedAt: 1, baselineTokens: 0, currentTokens: 0, savedTokens: 0, points: [] };
		expect(parseTokenSavings({ ...minimal, ttftMs: -1 })).toBeUndefined();
		expect(parseTokenSavings({ ...minimal, rtkSavedTokens: -1 })).toBeUndefined();
		expect(parseTokenSavings({ ...minimal, lastPayloadChars: -1 })).toBeUndefined();
		expect(parseTokenSavings({ ...minimal, ttftMs: 1.5 })).toBeUndefined();
		expect(parseTokenSavings({ ...minimal, rtkSavedTokens: "10" })).toBeUndefined();
		expect(parseTokenSavings({ ...minimal, lastPayloadChars: Number.MAX_SAFE_INTEGER + 1 })).toBeUndefined();
		expect(parseTokenSavings({ ...minimal, ttftMs: -1, rtkSavedTokens: 10, lastPayloadChars: 4 })).toBeUndefined();
		const copied = parseTokenSavings({ ...minimal, rtkSavedTokens: 10, lastPayloadChars: 4096, ttftMs: 120 });
		expect(copied).toEqual({ ...minimal, rtkSavedTokens: 10, lastPayloadChars: 4096, ttftMs: 120 });
		expect(copied?.savedTokens).toBe(0);
		expect(parseTokenSavings({ ...minimal, rtkSavedTokens: 0, lastPayloadChars: 0, ttftMs: 0 })).toEqual({
			...minimal,
			rtkSavedTokens: 0,
			lastPayloadChars: 0,
			ttftMs: 0,
		});
		const store = createBarStore();
		store.setSavings(snapshot);
		store.setSavings({ ...snapshot, ttftMs: -1 });
		expect(store.get().savings).toEqual(snapshot);
	});

	test("a snapshot without the new fields still renders saved and before/now", () => {
		const parsed = parseTokenSavings(snapshot);
		expect(parsed).toEqual(snapshot);
		expect(parsed !== undefined && Object.hasOwn(parsed, "rtkSavedTokens")).toBe(false);
		expect(parsed !== undefined && Object.hasOwn(parsed, "lastPayloadChars")).toBe(false);
		expect(parsed !== undefined && Object.hasOwn(parsed, "ttftMs")).toBe(false);
		const line = plain(renderBarLine({ phase: "idle", stages: {}, savings: parsed }, fakeTheme(), 300, 0));
		expect(line).toContain("saved 1.2M");
		expect(line).toContain("before 1.2M");
		expect(line).toContain("now 1.2k");
		expect(line).not.toContain("rtk ");
		expect(line).not.toContain("payload ");
		expect(line).not.toContain("ttft ");
	});

	test("width 50 planning with the new fields keeps graph and saved", () => {
		const state: BarState = {
			...planningState(),
			savings: {
				...snapshot,
				baselineTokens: 20,
				currentTokens: 8,
				savedTokens: 12,
				points: [],
				rtkSavedTokens: 10,
				lastPayloadChars: 4096,
				ttftMs: 123456789,
			},
		};
		const line = plain(renderBarLine(state, fakeTheme(), 50, 35_000));
		expect(line).toContain("graph 3/5");
		expect(line).toContain("saved");
	});

	test("a matching live session still shows saved", () => {
		const store = createBarStore();
		store.setLiveSession(snapshot.sessionId);
		store.setSavings(snapshot);
		const line = plain(renderBarLine(store.get(), fakeTheme(), 300, 0));
		expect(line).toContain("saved 1.2M");
		expect(line).toContain("before 1.2M");
		expect(line).toContain("now 1.2k");
	});

	test("a mismatched live session hides saved and before", () => {
		const bare = { phase: "idle" as const, stages: {} };
		const mismatched: BarState = { ...bare, liveSessionId: "other-session", savings: snapshot };
		const line = plain(renderBarLine(mismatched, fakeTheme(), 300, 0));
		expect(line).not.toContain("saved");
		expect(line).not.toContain("before");
		expect(line).toBe(plain(renderBarLine(bare, fakeTheme(), 300, 0)));
		const store = createBarStore();
		store.setLiveSession("other-session");
		store.setSavings(snapshot);
		const wide = plain(renderBarLine(store.get(), fakeTheme(), 300, 0));
		expect(wide).not.toContain("saved");
		expect(wide).not.toContain("before");
	});

	test("setLiveSession stores a safe id and ignores anything else", () => {
		const store = createBarStore();
		store.setLiveSession("sess-1");
		expect(store.get().liveSessionId).toBe("sess-1");
		store.begin(1);
		expect(store.get().liveSessionId).toBe("sess-1");
		store.setLiveSession(undefined);
		expect(store.get().liveSessionId).toBe("sess-1");
		store.setLiveSession("");
		expect(store.get().liveSessionId).toBe("sess-1");
		store.setLiveSession("a/b");
		expect(store.get().liveSessionId).toBe("sess-1");
		store.setLiveSession("x".repeat(129));
		expect(store.get().liveSessionId).toBe("sess-1");
		store.setLiveSession("x".repeat(128));
		expect(store.get().liveSessionId).toBe("x".repeat(128));
	});

	test("a wide line shows idle milliseconds and cost cents", () => {
		const store = createBarStore();
		store.setLiveSession(snapshot.sessionId);
		store.setSavings({ ...snapshot, lastIdleMs: 40, costCents: 3 });
		const line = plain(renderBarLine(store.get(), fakeTheme(), 300, 0));
		expect(line).toContain("idle 40ms");
		expect(line).toContain("cost 3c");
		expect(line).toContain("saved 1.2M");
		expect(line).toContain("before 1.2M");
		expect(store.get().savings?.savedTokens).toBe(snapshot.savedTokens);
		const beforeAt = line.indexOf("before 1.2M");
		expect(line.indexOf("idle 40ms")).toBeGreaterThan(beforeAt);
		expect(line.indexOf("cost 3c")).toBeGreaterThan(line.indexOf("idle 40ms"));
	});

	test("lastIdleMs -1 rejects the snapshot", () => {
		const minimal = { v: 1, sessionId: "s", updatedAt: 1, baselineTokens: 0, currentTokens: 0, savedTokens: 0, points: [] };
		expect(parseTokenSavings({ ...minimal, lastIdleMs: -1 })).toBeUndefined();
		expect(parseTokenSavings({ ...minimal, costCents: -1 })).toBeUndefined();
		expect(parseTokenSavings({ ...minimal, lastIdleMs: 1.5 })).toBeUndefined();
		expect(parseTokenSavings({ ...minimal, costCents: "3" })).toBeUndefined();
		expect(parseTokenSavings({ ...minimal, lastIdleMs: Number.MAX_SAFE_INTEGER + 1 })).toBeUndefined();
		expect(parseTokenSavings({ ...minimal, costCents: Number.MAX_SAFE_INTEGER + 1 })).toBeUndefined();
		expect(parseTokenSavings({ ...minimal, lastIdleMs: -1, costCents: 3 })).toBeUndefined();
		const copied = parseTokenSavings({ ...minimal, lastIdleMs: 40, costCents: 3 });
		expect(copied).toEqual({ ...minimal, lastIdleMs: 40, costCents: 3 });
		expect(copied?.savedTokens).toBe(0);
		expect(Object.hasOwn(copied ?? {}, "lastIdleMs")).toBe(true);
		expect(parseTokenSavings({ ...minimal, lastIdleMs: 0, costCents: 0 })).toEqual({
			...minimal,
			lastIdleMs: 0,
			costCents: 0,
		});
		const absent = parseTokenSavings(minimal);
		expect(absent).toEqual(minimal);
		expect(absent !== undefined && Object.hasOwn(absent, "lastIdleMs")).toBe(false);
		expect(absent !== undefined && Object.hasOwn(absent, "costCents")).toBe(false);
		const store = createBarStore();
		store.setSavings(snapshot);
		store.setSavings({ ...snapshot, lastIdleMs: -1 });
		expect(store.get().savings).toEqual(snapshot);
		store.setSavings({ ...snapshot, costCents: -1 });
		expect(store.get().savings).toEqual(snapshot);
	});

	test("width 50 matching session still contains graph 3/5 and saved", () => {
		const state: BarState = {
			...planningState(),
			liveSessionId: snapshot.sessionId,
			savings: {
				...snapshot,
				baselineTokens: 20,
				currentTokens: 8,
				savedTokens: 12,
				points: [],
				lastIdleMs: 999_999,
				costCents: 999_999,
			},
		};
		const line = plain(renderBarLine(state, fakeTheme(), 50, 35_000));
		expect(line).toContain("graph 3/5");
		expect(line).toContain("saved");
	});
});
