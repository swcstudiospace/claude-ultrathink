// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import { paint, truncateToWidth, visibleWidth } from "./omp-paint.ts";
import { type BarState, createBarComponent, createBarStore, LINGER_MS, renderBarLine } from "./omp-ui.ts";
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
		{ id: "n1", title: "Design", kind: "analysis", wave: 0, dependsOn: [], issue: { identifier: "SPE-12", url: "https://l/SPE-12" }, steps: [{ step: 1, title: "a", identifier: "SPE-13" }] },
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
		expect(store.get().last).toEqual({ root: "BUILD_PROMPT", nodes: 2, issues: 2, subIssues: 1, firstIssue: "SPE-12", trackingStatus: "complete", elapsedMs: 34_000 });
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
		expect(line("delivered")).toContain("2 issues · 1 sub-issues (SPE-12)");
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
		expect(plain(raw)).toContain("1 issues · 0 sub-issues (SPE-12) · partial");
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
		store.apply({ type: "issue", at: 2_600, provider: "linear", nodeId: "a", step: 2, identifier: "SPE-2", url: "https://l/2" });
		expect(store.get().model?.nodes[0]?.steps).toEqual([{ step: 2, title: "Step 2", issue: { identifier: "SPE-2", url: "https://l/2", at: 2_600 } }]);
		store.apply({ type: "node", at: 3_000, phase: "done", id: "a", title: "Design the schema", kind: "analysis", index: 0, total: 3, steps: ["Step 1: x", "Step 2: y"] });
		const node = store.get().model?.nodes[0];
		expect(node?.status).toBe("done");
		expect(node?.steps).toEqual([
			{ step: 1, title: "Step 1: x", appearedAt: 3_000, issue: undefined },
			{ step: 2, title: "Step 2: y", appearedAt: 3_000, issue: { identifier: "SPE-2", url: "https://l/2", at: 2_600 } },
		]);
		store.apply({ type: "node", at: 3_100, phase: "done", id: "b", title: "Build the API", kind: "task", index: 1, total: 3, fallback: true });
		expect(store.get().model?.nodes[1]?.status).toBe("fallback");
	});

	test("notion refs mark the node and never replace a linear ref", () => {
		const store = liveStore();
		store.apply({ type: "issue", at: 2_100, provider: "linear", nodeId: "a", identifier: "SPE-1", url: "https://l/1" });
		store.apply({ type: "issue", at: 2_200, provider: "notion", nodeId: "a", url: "https://n/1" });
		store.apply({ type: "issue", at: 2_300, provider: "notion", nodeId: "b", url: "https://n/2" });
		const [a, b] = store.get().model?.nodes ?? [];
		expect(a?.notion).toBe(true);
		expect(a?.issue?.identifier).toBe("SPE-1");
		expect(b?.issue?.url).toBe("https://n/2");
		store.apply({ type: "issue", at: 2_400, provider: "linear", nodeId: "b", identifier: "SPE-3", url: "https://l/3" });
		expect(store.get().model?.nodes[1]?.issue?.identifier).toBe("SPE-3");
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
		expect(model?.nodes[0]?.issue).toEqual({ identifier: "SPE-12", url: "https://l/SPE-12" });
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
