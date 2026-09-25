// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import { type GraphModel, type GraphNodeModel, renderGraph, STEP_STAGGER_MS, waveLayout } from "./omp-graph.ts";
import { visibleWidth } from "./omp-paint.ts";

const FG = ["accent", "muted", "dim", "success", "warning", "error", "borderMuted", "borderAccent", "customMessageLabel", "customMessageText"];
const theme = {
	fg(color: string, text: string) {
		if (!FG.includes(color)) throw new Error(`Unknown theme color: ${color}`);
		return `\x1b[38;5;${FG.indexOf(color) + 1}m${text}\x1b[39m`;
	},
	bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
	boxRound: { topLeft: "╭", topRight: "╮", bottomLeft: "╰", bottomRight: "╯", horizontal: "─", vertical: "│" },
	status: { running: "RR", success: "OK", error: "XX", warning: "WW", pending: ".." },
	getSpinnerFrames: () => ["S0", "S1"],
};
const throwingTheme = {
	fg() {
		throw new Error("boom");
	},
	bold() {
		throw new Error("boom");
	},
};
// biome-ignore lint/suspicious/noControlCharactersInRegex: strip ANSI
const plain = (rows: string[]) => rows.join("\n").replace(/\x1b\[[0-9;]*m/g, "");

function node(id: string, dependsOn: string[], extra: Partial<GraphNodeModel> = {}): GraphNodeModel {
	return { id, title: `Title ${id}`, kind: "generate", dependsOn, status: "done", steps: [], ...extra };
}
function steps(prefix: string, count: number) {
	return Array.from({ length: count }, (_, i) => ({ step: i + 1, title: `Step ${i + 1}: do ${prefix}`, issue: { identifier: `${prefix}-${i + 1}`, url: "u" } }));
}
const diamond: GraphModel = {
	nodes: [node("n1", []), node("n2", ["n1"]), node("n3", ["n1"]), node("n4", ["n2", "n3"]), node("n5", ["n4"])],
};

describe("waveLayout", () => {
	test("diamond levels", () => {
		expect(waveLayout(diamond.nodes.slice(0, 4))).toEqual([["n1"], ["n2", "n3"], ["n4"]]);
	});
	test("unknown dep ignored", () => {
		expect(waveLayout([node("a", ["zz"]), node("b", ["a"])])).toEqual([["a"], ["b"]]);
	});
	test("cycle places every node", () => {
		const waves = waveLayout([node("r", []), node("a", ["b"]), node("b", ["a"])]);
		expect(waves).toEqual([["r"], ["a", "b"]]);
	});
});

describe("renderGraph", () => {
	test("column layout at 120", () => {
		const rows = renderGraph(diamond, theme, 120, { now: 0, steps: "all", animate: false });
		for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(120);
		const text = plain(rows);
		for (const id of ["n1", "n2", "n3", "n4", "n5"]) expect(text).toContain(id);
		expect(text).toContain("▶");
		expect(text).toContain("← n2 n3");
		expect(text).toContain("╭");
	});
	test("tree layout at 50", () => {
		const rows = renderGraph(diamond, theme, 50, { now: 0, steps: "all", animate: false });
		expect(rows.length).toBeGreaterThan(0);
		for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(50);
		expect(plain(rows)).toContain("n5");
		expect(plain(rows)).not.toContain("╭");
	});
	const stepModel: GraphModel = {
		nodes: [node("n1", [], { steps: steps("ENG", 4) }), node("n2", ["n1"], { status: "running", steps: steps("RUN", 2) })],
	};
	test("step modes", () => {
		const all = plain(renderGraph(stepModel, theme, 120, { now: 0, steps: "all", animate: false }));
		for (const id of ["ENG-1", "ENG-4", "RUN-2"]) expect(all).toContain(id);
		const none = plain(renderGraph(stepModel, theme, 120, { now: 0, steps: "none", animate: false }));
		expect(none).toContain("▸ 4 sub-issues · 4 linked");
		expect(none).not.toContain("ENG-1");
		const active = plain(renderGraph(stepModel, theme, 120, { now: 0, steps: "active", animate: false }));
		expect(active).toContain("RUN-1");
		expect(active).not.toContain("ENG-1");
		expect(active).toContain("▸ 4 sub-issues");
	});
	test("fold row counts linked sub-issues only when some are linked", () => {
		const fold = (issues: number) => {
			const model: GraphModel = { nodes: [node("n1", [], { steps: steps("ENG", 3).map((s, i) => (i < issues ? s : { ...s, issue: undefined })) })] };
			return plain(renderGraph(model, theme, 120, { now: 0, steps: "none", animate: false }));
		};
		expect(fold(0)).toContain("▸ 3 sub-issues");
		expect(fold(0)).not.toContain("linked");
		expect(fold(3)).toContain("▸ 3 sub-issues · 3 linked");
	});
	test("animation pop and step drop", () => {
		const model: GraphModel = { nodes: [node("n1", [], { appearedAt: 1000, steps: steps("A", 3).map((s) => ({ ...s, appearedAt: 1000 })) })] };
		const at = (now: number) => plain(renderGraph(model, theme, 120, { now, steps: "all", animate: true }));
		expect(at(999)).not.toContain("n1");
		expect(at(1000)).toContain("A-1");
		expect(at(1000)).not.toContain("A-2");
		expect(at(1000 + STEP_STAGGER_MS)).toContain("A-2");
		expect(at(1000 + STEP_STAGGER_MS)).not.toContain("A-3");
		expect(at(1000 + 2 * STEP_STAGGER_MS)).toContain("A-3");
		const still = plain(renderGraph(model, theme, 120, { now: 0, steps: "all", animate: false }));
		expect(still).toContain("A-3");
		const running: GraphModel = { nodes: [node("n1", [], { status: "running" })] };
		const a = plain(renderGraph(running, theme, 120, { now: 0, steps: "all", animate: false }));
		const b = plain(renderGraph(running, theme, 120, { now: 100, steps: "all", animate: false }));
		expect(a).toBe(b);
		expect(a).not.toContain("S0");
	});
	test("maxRows cap", () => {
		const model: GraphModel = { nodes: Array.from({ length: 6 }, (_, i) => node(`n${i + 1}`, i ? [`n${i}`] : [], { steps: steps(`K${i}`, 5) })) };
		for (const width of [40, 120, 200]) {
			const rows = renderGraph(model, theme, width, { now: 0, steps: "all", maxRows: 8, animate: false });
			expect(rows.length).toBeLessThanOrEqual(8);
			for (const row of rows) expect(visibleWidth(row)).toBeLessThanOrEqual(width);
			expect(plain(rows)).toContain("n1");
			if (width === 40) expect(plain(rows)).toContain("more nodes");
		}
	});
	test("plain and throwing themes", () => {
		const rows = renderGraph(diamond, {}, 120, { now: 0, steps: "all", animate: true });
		expect(rows.join("")).not.toContain("\x1b");
		expect(plain(rows)).toContain("n4");
		const thrown = renderGraph(diamond, throwingTheme, 120, { now: 0, steps: "all", animate: true });
		expect(plain(thrown)).toContain("n4");
	});
	test("empty and narrow", () => {
		expect(renderGraph({ nodes: [] }, theme, 80, { now: 0, steps: "all", animate: false })).toEqual([]);
		expect(renderGraph(diamond, theme, 9, { now: 0, steps: "all", animate: false })).toEqual([]);
	});
});
