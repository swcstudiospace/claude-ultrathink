// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import type { UpliftResult } from "../types.ts";
import { dependencyLevels } from "./graph.ts";
import { nodeStepTitles } from "../track/plan.ts";
import { runThink } from "./pipeline.ts";
import { COT_SYSTEM_PROMPT, GRAPH_SYSTEM_PROMPT } from "./prompts.ts";
import { FALLBACK_GRAPH } from "./types.ts";

const uplift: UpliftResult = {
	xml: "<BUILD_PROMPT><ORIGINAL>add list</ORIGINAL><SCOPE>ui</SCOPE></BUILD_PROMPT>",
	original: "add list",
	root: "BUILD_PROMPT",
	source: "llm",
};

function graphJson(count = 3): string {
	return JSON.stringify({
		goal: "Ship the list page",
		nodes: Array.from({ length: count }, (_, i) => ({
			id: `n${i + 1}`,
			title: `T${i + 1}`,
			kind: i === 0 ? "understand" : i === count - 1 ? "synthesize" : "generate",
			question: `Q${i + 1}`,
			depends_on: i === 0 ? [] : [`n${i}`],
		})),
	});
}

describe("runThink", () => {
	test("calls complete once for the graph then each node in order; later call sees earlier conclusion", async () => {
		const calls: { system: string; user: string }[] = [];
		const result = await runThink({
			uplift,
			complete: async (system, user) => {
				calls.push({ system, user });
				if (calls.length === 1) return graphJson(5);
				const id = user.match(/current_node id="([^"]+)"/)?.[1] ?? `n${calls.length - 1}`;
				return `<node><thinking>think ${id}</thinking><conclusion>done ${id}</conclusion></node>`;
			},
		});

		expect(calls).toHaveLength(1 + 5);
		expect(calls[0]?.system).toBe(GRAPH_SYSTEM_PROMPT);
		expect(calls[0]?.user).toContain("add list");
		expect(calls[0]?.user).toContain("<BUILD_PROMPT>");
		expect(calls.slice(1).every((call) => call.system === COT_SYSTEM_PROMPT)).toBe(true);
		expect(calls[2]?.user).toContain("done n1");
		expect(result.graph.nodes.map((node) => node.id)).toEqual(["n1", "n2", "n3", "n4", "n5"]);
		expect(result.graph.nodes[0]?.conclusion).toBe("done n1");
		expect(result.graph.nodes[4]?.kind).toBe("synthesize");
		expect(result.source).toBe("llm");
		expect(result.xml).toContain("<BUILD_PROMPT>");
		expect(result.xml).toContain("<ORIGINAL>add list</ORIGINAL>");
		expect(result.xml).toContain("<GRAPH_OF_THOUGHT>");
		expect(result.xml).toContain("done n1");
		expect(result.xml).toContain("<WORKFLOW>");
		expect(result.xml).toContain('<WAVE n="1" parallel="false">n1</WAVE>');
		expect(result.xml.indexOf("<WORKFLOW>")).toBeLessThan(result.xml.indexOf("</GRAPH_OF_THOUGHT>"));
	});

	test("graph throw uses FALLBACK_GRAPH still fills 5 CoTs", async () => {
		let n = 0;
		const result = await runThink({
			uplift,
			complete: async () => {
				n++;
				if (n === 1) throw new Error("boom");
				return `<node><thinking>t${n}</thinking><conclusion>c${n}</conclusion></node>`;
			},
		});
		expect(n).toBe(1 + FALLBACK_GRAPH.nodes.length);
		expect(result.graph.nodes).toHaveLength(5);
		expect(result.graph.nodes.map((node) => node.id)).toEqual(FALLBACK_GRAPH.nodes.map((node) => node.id));
		expect(result.graph.nodes.every((node) => Boolean(node.conclusion))).toBe(true);
		expect(result.graph.nodes[0]?.conclusion).toBe("c2");
	});

	test("AbortError on graph complete rethrows without filling", async () => {
		const err = new Error("Aborted");
		err.name = "AbortError";
		let called = 0;
		let reached = false;
		try {
			await runThink({
				uplift,
				complete: async () => {
					called++;
					throw err;
				},
			});
		} catch (caught) {
			reached = true;
			expect(caught).toBe(err);
		}
		expect(reached).toBe(true);
		expect(called).toBe(1);
	});

	test("node throw uses the question and continues", async () => {
		const result = await runThink({
			uplift,
			complete: async (_system, user) => {
				if (user.includes("current_node id=\"n2\"")) throw new Error("node boom");
				if (!user.includes("current_node")) return graphJson(5);
				const id = user.match(/current_node id="([^"]+)"/)?.[1] ?? "n?";
				return `<node><thinking>t ${id}</thinking><conclusion>c ${id}</conclusion></node>`;
			},
		});
		expect(result.graph.nodes[1]?.thinking).toBe("Q2");
		expect(result.graph.nodes[1]?.conclusion).toBe("Q2");
		expect(result.graph.nodes[2]?.conclusion).toBe("c n3");
	});
});

describe("runThink concurrency", () => {
	test("fills independent nodes together but never before their predecessors", async () => {
		const graph = {
			goal: "g",
			nodes: [
				{ id: "n1", title: "A", kind: "understand", question: "q", depends_on: [] },
				{ id: "n2", title: "B", kind: "generate", question: "q", depends_on: ["n1"] },
				{ id: "n3", title: "C", kind: "critique", question: "q", depends_on: ["n1"] },
				{ id: "n4", title: "D", kind: "synthesize", question: "q", depends_on: ["n2", "n3"] },
			],
		};
		let active = 0;
		let peak = 0;
		const order: string[] = [];
		const result = await runThink({
			uplift,
			concurrency: 4,
			minNodes: 4,
			complete: async (_system, user) => {
				if (order.length === 0 && !user.includes("current_node")) return JSON.stringify(graph);
				const id = user.match(/current_node id="([^"]+)"/)?.[1] ?? "?";
				active++;
				peak = Math.max(peak, active);
				await new Promise((resolve) => setTimeout(resolve, 5));
				order.push(id);
				active--;
				return `<node><thinking>t</thinking><conclusion>done ${id}</conclusion></node>`;
			},
		});
		expect(peak).toBe(2);
		expect(order[0]).toBe("n1");
		expect(order[3]).toBe("n4");
		expect(new Set(order.slice(1, 3))).toEqual(new Set(["n2", "n3"]));
		expect(dependencyLevels(result.graph.nodes).map((level) => level.map((node) => node.id))).toEqual([
			["n1"],
			["n2", "n3"],
			["n4"],
		]);
	});
});

describe("runThink onEvent", () => {
	const fillFor = async (_system: string, user: string): Promise<string> => {
		if (!user.includes("current_node")) return graphJson(5);
		if (user.includes("current_node id=\"n3\"")) throw new Error("node boom");
		return "<node><thinking>t</thinking><conclusion>c</conclusion></node>";
	};
	for (const concurrency of [1, 3]) {
		test(`graph once then start/done per node (concurrency ${concurrency})`, async () => {
			const events: Array<Record<string, unknown>> = [];
			await runThink({ uplift, concurrency, complete: fillFor, onEvent: (event) => events.push(event) });
			expect(events[0]).toMatchObject({ type: "graph", total: 5 });
			expect(events[0]?.nodes).toHaveLength(5);
			expect(events.filter((event) => event.type === "graph")).toHaveLength(1);
			const nodes = events.slice(1);
			expect(nodes).toHaveLength(10);
			for (let index = 0; index < 5; index++) {
				const id = `n${index + 1}`;
				const start = nodes.findIndex((event) => event.id === id && event.phase === "start");
				const done = nodes.findIndex((event) => event.id === id && event.phase === "done");
				expect(start).toBeGreaterThanOrEqual(0);
				expect(done).toBeGreaterThan(start);
				expect(nodes[start]).toMatchObject({ type: "node", index, total: 5 });
				expect(nodes[done]?.fallback).toBe(id === "n3" ? true : undefined);
			}
		});
	}

	test("graph nodes carry dependsOn; every done event carries the node's step titles, fallback included", async () => {
		const events: Array<Record<string, unknown>> = [];
		const complete = async (_system: string, user: string): Promise<string> => {
			if (!user.includes("current_node")) return graphJson(5);
			if (user.includes('current_node id="n2"')) throw new Error("node boom");
			return "<node><thinking>1. read it 2. write it</thinking><conclusion>c</conclusion></node>";
		};
		const result = await runThink({ uplift, complete, onEvent: (event) => events.push(event) });
		expect(events[0]?.nodes).toEqual([
			{ id: "n1", title: "T1", kind: "understand", dependsOn: [] },
			{ id: "n2", title: "T2", kind: "generate", dependsOn: ["n1"] },
			{ id: "n3", title: "T3", kind: "generate", dependsOn: ["n2"] },
			{ id: "n4", title: "T4", kind: "generate", dependsOn: ["n3"] },
			{ id: "n5", title: "T5", kind: "synthesize", dependsOn: ["n4"] },
		]);
		const done = events.filter((event) => event.phase === "done");
		expect(done).toHaveLength(5);
		for (const event of done) {
			const node = result.graph.nodes.find((candidate) => candidate.id === event.id)!;
			expect(event.steps).toEqual(nodeStepTitles(node));
		}
		expect(done.find((event) => event.id === "n1")?.steps).toEqual(["Step 1: read it", "Step 2: write it"]);
		expect(done.find((event) => event.id === "n2")).toMatchObject({ fallback: true, steps: ["Step 1: Q2"] });
		expect(events.filter((event) => event.phase === "start").every((event) => event.steps === undefined)).toBe(true);
	});
});
