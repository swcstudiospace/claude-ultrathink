import { describe, expect, test } from "bun:test";
import type { UpliftResult } from "../types.ts";
import { dependencyLevels } from "./graph.ts";
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
				if (calls.length === 1) return graphJson(3);
				const id = user.match(/current_node id="([^"]+)"/)?.[1] ?? `n${calls.length - 1}`;
				return `<node><thinking>think ${id}</thinking><conclusion>done ${id}</conclusion></node>`;
			},
		});

		expect(calls).toHaveLength(1 + 3);
		expect(calls[0]?.system).toBe(GRAPH_SYSTEM_PROMPT);
		expect(calls[0]?.user).toContain("add list");
		expect(calls[0]?.user).toContain("<BUILD_PROMPT>");
		expect(calls.slice(1).every((call) => call.system === COT_SYSTEM_PROMPT)).toBe(true);
		expect(calls[2]?.user).toContain("done n1");
		expect(result.graph.nodes.map((node) => node.id)).toEqual(["n1", "n2", "n3"]);
		expect(result.graph.nodes[0]?.conclusion).toBe("done n1");
		expect(result.graph.nodes[2]?.kind).toBe("synthesize");
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
				if (!user.includes("current_node")) return graphJson(3);
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
