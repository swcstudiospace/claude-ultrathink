import { describe, expect, test } from "bun:test";
import {
	dependencyLevels,
	extractJsonObject,
	extractTag,
	graphSketch,
	graphToXml,
	injectGraphXml,
	normalizeGraph,
	parseNodeFill,
	topoSort,
	workflowWaves,
} from "./graph.ts";
import { FALLBACK_GRAPH, MAX_NODES, MIN_NODES, type ThoughtNode } from "./types.ts";

describe("extractJsonObject", () => {
	test("parses fenced json and raw objects", () => {
		expect(extractJsonObject('```json\n{"goal":"g"}\n```')).toEqual({ goal: "g" });
		expect(extractJsonObject('noise {"goal":"g","nodes":[]} trailing')).toEqual({ goal: "g", nodes: [] });
		expect(extractJsonObject("not json")).toBeNull();
	});
});

describe("extractTag", () => {
	test("reads inner text case-insensitively", () => {
		expect(extractTag("<THINKING> step </THINKING>", "thinking")).toBe("step");
	});
});

describe("normalizeGraph", () => {
	test("pads with fallback when too few nodes", () => {
		const out = normalizeGraph(
			{
				goal: "x",
				nodes: [{ id: "n1", title: "A", kind: "understand", question: "q", depends_on: [] }],
			},
			"goal",
			MIN_NODES,
			MAX_NODES,
		);
		expect(out.goal).toBe(FALLBACK_GRAPH.goal);
		expect(out.nodes.map((node) => node.id)).toEqual(FALLBACK_GRAPH.nodes.map((node) => node.id));
		expect(out.nodes).not.toBe(FALLBACK_GRAPH.nodes);
		expect(out.nodes[0]).not.toBe(FALLBACK_GRAPH.nodes[0]);
		expect(out.nodes[0]?.dependsOn).not.toBe(FALLBACK_GRAPH.nodes[0]?.dependsOn);
	});

	test("clamps to maxNodes and forces last kind synthesize", () => {
		const nodes = Array.from({ length: 10 }, (_, i) => ({
			id: `n${i + 1}`,
			title: `T${i + 1}`,
			kind: i === 0 ? "understand" : "generate",
			question: `q${i + 1}`,
			depends_on: i === 0 ? [] : [`n${i}`],
		}));
		const out = normalizeGraph({ goal: "g", nodes }, "goal", 3, 6);
		expect(out.nodes).toHaveLength(6);
		expect(out.nodes.at(-1)?.kind).toBe("synthesize");
		expect(out.goal).toBe("g");
	});

	test("strips unknown and self deps", () => {
		const out = normalizeGraph(
			{
				goal: "g",
				nodes: [
					{ id: "n1", title: "A", kind: "understand", question: "q1", depends_on: ["missing", "n1"] },
					{ id: "n2", title: "B", kind: "decompose", question: "q2", dependsOn: ["n1"] },
					{ id: "n3", title: "C", kind: "generate", question: "q3", depends_on: ["n2", "ghost"] },
				],
			},
			"fb",
			3,
			8,
		);
		expect(out.nodes[0]?.dependsOn).toEqual([]);
		expect(out.nodes[1]?.dependsOn).toEqual(["n1"]);
		expect(out.nodes[2]?.dependsOn).toEqual(["n2"]);
		expect(out.nodes[2]?.kind).toBe("synthesize");
	});
});

describe("topoSort", () => {
	test("respects deps", () => {
		const nodes: ThoughtNode[] = [
			{ id: "n3", title: "C", kind: "synthesize", question: "c", dependsOn: ["n1", "n2"] },
			{ id: "n1", title: "A", kind: "understand", question: "a", dependsOn: [] },
			{ id: "n2", title: "B", kind: "decompose", question: "b", dependsOn: ["n1"] },
		];
		expect(topoSort(nodes).map((node) => node.id)).toEqual(["n1", "n2", "n3"]);
	});
});

const DIAMOND: ThoughtNode[] = [
	{ id: "n1", title: "A", kind: "understand", question: "a", dependsOn: [] },
	{ id: "n2", title: "B", kind: "generate", question: "b", dependsOn: ["n1"] },
	{ id: "n3", title: "C", kind: "critique", question: "c", dependsOn: ["n1"] },
	{ id: "n4", title: "D", kind: "synthesize", question: "d", dependsOn: ["n2", "n3"] },
];

describe("dependencyLevels", () => {
	test("groups nodes so every dependency sits in an earlier level", () => {
		expect(dependencyLevels(DIAMOND).map((level) => level.map((node) => node.id))).toEqual([
			["n1"],
			["n2", "n3"],
			["n4"],
		]);
	});
});

describe("workflowWaves", () => {
	test("diamond graph yields a parallel middle wave", () => {
		expect(workflowWaves({ goal: "g", nodes: DIAMOND })).toEqual([
			{ wave: 1, parallel: false, ids: ["n1"] },
			{ wave: 2, parallel: true, ids: ["n2", "n3"] },
			{ wave: 3, parallel: false, ids: ["n4"] },
		]);
	});

	test("orders unsorted nodes before grouping", () => {
		const shuffled = [DIAMOND[3]!, DIAMOND[2]!, DIAMOND[0]!, DIAMOND[1]!];
		expect(workflowWaves({ goal: "g", nodes: shuffled }).map((wave) => wave.ids)).toEqual([
			["n1"],
			["n3", "n2"],
			["n4"],
		]);
	});
});

describe("graphToXml", () => {
	test("ends with a WORKFLOW block of waves before the root close", () => {
		const xml = graphToXml({ goal: "g", nodes: DIAMOND });
		const workflow = [
			"	<WORKFLOW>",
			'		<WAVE n="1" parallel="false">n1</WAVE>',
			'		<WAVE n="2" parallel="true">n2, n3</WAVE>',
			'		<WAVE n="3" parallel="false">n4</WAVE>',
			"	</WORKFLOW>",
			"</GRAPH_OF_THOUGHT>",
		].join("\n");
		expect(xml.endsWith(workflow)).toBe(true);
		expect(xml.indexOf("<WORKFLOW>")).toBeGreaterThan(xml.lastIndexOf("</NODE>"));
	});
});

describe("parseNodeFill", () => {
	test("reads thinking and conclusion", () => {
		expect(parseNodeFill("<node><thinking>step 1</thinking><conclusion>do x</conclusion></node>")).toEqual({
			thinking: "step 1",
			conclusion: "do x",
		});
	});

	test("falls back to whole text", () => {
		expect(parseNodeFill("plain answer")).toEqual({ thinking: "plain answer", conclusion: "plain answer" });
	});
});

describe("injectGraphXml", () => {
	test("keeps BUILD_PROMPT root and ORIGINAL", () => {
		const xml = "<BUILD_PROMPT><ORIGINAL>add list</ORIGINAL><SCOPE>ui</SCOPE></BUILD_PROMPT>";
		const out = injectGraphXml(xml, FALLBACK_GRAPH);
		expect(out.startsWith("<BUILD_PROMPT>")).toBe(true);
		expect(out).toContain("<ORIGINAL>add list</ORIGINAL>");
		expect(out).toContain("<SCOPE>ui</SCOPE>");
		expect(out).toContain("<GRAPH_OF_THOUGHT>");
		expect(out).toContain("</GRAPH_OF_THOUGHT>");
		expect(out.endsWith("</BUILD_PROMPT>")).toBe(true);
		expect(out.indexOf("<GRAPH_OF_THOUGHT>")).toBeGreaterThan(out.indexOf("<SCOPE>"));
	});

	test("replaces existing GRAPH_OF_THOUGHT including its WORKFLOW", () => {
		const xml =
			"<BUILD_PROMPT><ORIGINAL>x</ORIGINAL><GRAPH_OF_THOUGHT><GOAL>old</GOAL>" +
			'<WORKFLOW><WAVE n="1" parallel="false">stale</WAVE></WORKFLOW></GRAPH_OF_THOUGHT></BUILD_PROMPT>';
		const out = injectGraphXml(xml, { goal: "new goal", nodes: DIAMOND });
		expect(out).toContain("<GOAL>new goal</GOAL>");
		expect(out.includes("old")).toBe(false);
		expect(out.includes("stale")).toBe(false);
		expect(out.match(/<GRAPH_OF_THOUGHT/g)?.length).toBe(1);
		expect(out.match(/<WORKFLOW>/g)?.length).toBe(1);
		expect(out).toContain('<WAVE n="2" parallel="true">n2, n3</WAVE>');
		expect(out.endsWith("</BUILD_PROMPT>")).toBe(true);
	});
});

describe("graphSketch", () => {
	test("emits compact id title kind deps lines", () => {
		const sketch = graphSketch(FALLBACK_GRAPH);
		expect(sketch).toContain("n1  Understand  understand");
		expect(sketch).toContain("n2  Decompose  decompose  deps=n1");
	});
});
