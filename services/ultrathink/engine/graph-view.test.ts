// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import type { SessionRecord } from "../../../src/claude/state.ts";
import { workflowWaves } from "../../../src/think/graph.ts";
import { FALLBACK_GRAPH, NODE_KINDS, type NodeKind, type ThoughtGraph, type ThoughtNode } from "../../../src/think/types.ts";
import { nodeStepTitles } from "../../../src/track/plan.ts";
import { buildGraphView, type GraphView, renderGraphBlock, renderMermaid, renderTree } from "./graph-view.ts";

function node(id: string, kind: NodeKind, dependsOn: string[], extra: Partial<ThoughtNode> = {}): ThoughtNode {
	return { id, title: `Title ${id}`, kind, question: `Question ${id}?`, dependsOn, thinking: "1. First.\n2. Second.", conclusion: `Conclusion ${id}.`, ...extra };
}

function record(graph: unknown, degraded?: string[]): SessionRecord {
	return {
		sessionId: "11111111-2222-4333-8444-555555555555",
		at: 1,
		result: { xml: "<BUILD_PROMPT/>", original: "Build it.", root: "BUILD_PROMPT", source: "llm" },
		graph: graph as ThoughtGraph,
		...(degraded ? { degraded } : {}),
	};
}

const SMALL: ThoughtGraph = {
	goal: "Design the converter",
	nodes: [
		node("n1", "understand", [], { title: "Understand" }),
		node("n2", "decompose", ["n1"], { title: "Parser" }),
		node("n3", "generate", ["n1"], { title: "Writer" }),
		node("n4", "synthesize", ["n2", "n3"], { title: "Synthesize" }),
	],
};

function view(graph: unknown, degraded?: string[]): GraphView {
	const built = buildGraphView(record(graph, degraded));
	if (!built) throw new Error("expected a view");
	return built;
}

/** Each dependency sits in an earlier wave than its dependant and ids are unique. */
function expectSound(built: GraphView): void {
	const ids = built.nodes.map((n) => n.id);
	expect(new Set(ids).size).toBe(ids.length);
	const index = new Map(ids.map((id, i) => [id, i] as const));
	for (const [i, n] of built.nodes.entries()) {
		for (const dep of n.dependsOn) {
			expect(index.has(dep)).toBe(true);
			expect(index.get(dep)!).toBeLessThan(i);
			expect(built.nodes[index.get(dep)!]!.wave).toBeLessThan(n.wave);
		}
	}
	expect(built.waves.flatMap((w) => w.ids)).toEqual(ids);
	expect(built.counts.nodes).toBe(ids.length);
}

describe("buildGraphView", () => {
	test("is null without a graph, without nodes, for the boilerplate fallback and for malformed graphs", () => {
		const fallback: ThoughtGraph = { goal: FALLBACK_GRAPH.goal, nodes: FALLBACK_GRAPH.nodes.map((n) => ({ ...n, dependsOn: [...n.dependsOn] })) };
		for (const graph of [undefined, null, { goal: "g", nodes: [] }, fallback, { goal: "g" }, { goal: "g", nodes: "nope" }, { goal: "g", nodes: [null, 3, "x"] }]) {
			expect(buildGraphView(record(graph))).toBeNull();
		}
	});

	test("derives waves, edges, steps and counts from the graph", () => {
		const built = view(SMALL);
		expect(built.version).toBe(1);
		expect(built.goal).toBe("Design the converter");
		expect(built.nodes.map((n) => [n.id, n.wave])).toEqual([["n1", 1], ["n2", 2], ["n3", 2], ["n4", 3]]);
		expect(built.waves).toEqual([
			{ wave: 1, parallel: false, ids: ["n1"] },
			{ wave: 2, parallel: true, ids: ["n2", "n3"] },
			{ wave: 3, parallel: false, ids: ["n4"] },
		]);
		expect(built.waves).toEqual(workflowWaves(SMALL));
		expect(built.nodes[3]).toEqual({
			id: "n4",
			title: "Synthesize",
			kind: "synthesize",
			question: "Question n4?",
			dependsOn: ["n2", "n3"],
			wave: 3,
			steps: ["First.", "Second."],
			conclusion: "Conclusion n4.",
		});
		expect(built.counts).toEqual({ nodes: 4, edges: 4, waves: 3, steps: 8 });
		expect(built.degraded).toEqual({ fills: [] });
		expect(built.truncated).toBeUndefined();
		expectSound(built);
	});

	test("marks nodes whose fill was boilerplate", () => {
		const built = view(SMALL, ["fill:n2", "fill:n4", "fill:gone", "uplift"]);
		expect(built.degraded).toEqual({ fills: ["n2", "n4"] });
		expect(built.nodes.filter((n) => n.fallback).map((n) => n.id)).toEqual(["n2", "n4"]);
		expect(built.nodes[0]!.fallback).toBeUndefined();
	});

	test("is JSON-serializable and does not alias the record", () => {
		const graph = structuredClone(SMALL);
		const built = view(graph);
		expect(JSON.parse(JSON.stringify(built))).toEqual(built);
		built.nodes[3]!.dependsOn.push("zzz");
		expect(graph.nodes[3]!.dependsOn).toEqual(["n2", "n3"]);
	});

	test("orders nodes topologically when the input is not", () => {
		const built = view({ goal: "g", nodes: [node("n3", "refine", ["n2"]), node("n2", "compare", ["n1"]), node("n1", "understand", [])] });
		expect(built.nodes.map((n) => n.id)).toEqual(["n1", "n2", "n3"]);
		expect(built.nodes.map((n) => n.wave)).toEqual([1, 2, 3]);
		expectSound(built);
	});

	test("repairs duplicate ids, unknown, self and repeated dependencies, and cycles", () => {
		const built = view({
			goal: "g",
			nodes: [
				node("a", "understand", ["a", "ghost", "b"]),
				node("a", "decompose", []),
				node("b", "generate", ["a", "a"]),
				node("", "critique", ["b"]),
				node("c", "aggregate", ["d"]),
				node("d", "refine", ["c"]),
			],
		});
		expect(built.nodes).toHaveLength(6);
		expectSound(built);
		const byId = new Map(built.nodes.map((n) => [n.id, n] as const));
		// The first "a" keeps its id; the duplicate and the empty id get generated ones.
		expect(byId.get("a")!.question).toBe("Question a?");
		expect(byId.get("a")!.dependsOn).toEqual([]);
		expect(byId.get("b")!.dependsOn).toEqual(["a"]);
		expect(built.nodes.filter((n) => n.kind === "decompose" || n.kind === "critique").every((n) => /^n\d/.test(n.id))).toBe(true);
		// A two-node cycle keeps one edge only.
		expect(byId.get("c")!.dependsOn.length + byId.get("d")!.dependsOn.length).toBe(1);
	});

	test("two different long ids that collide once cut stay two nodes", () => {
		const long = "x".repeat(60);
		const built = view({ goal: "g", nodes: [node(`${long}1`, "understand", []), node(`${long}2`, "decompose", [`${long}1`])] });
		expect(built.nodes).toHaveLength(2);
		expect(built.nodes[0]!.id).toHaveLength(40);
		expect(built.nodes[0]!.id.endsWith("…")).toBe(true);
		expect(built.nodes[1]!.id).not.toBe(built.nodes[0]!.id);
		expect(built.nodes[1]!.dependsOn).toEqual([built.nodes[0]!.id]);
		expect(built.truncated).toBe(true);
		expectSound(built);
	});

	test("caps every field and flags the cut", () => {
		const steps = Array.from({ length: 20 }, (_, i) => `${i + 1}. ${"s".repeat(700)}`).join("\n");
		const built = view({
			goal: `${"g".repeat(400)}\nsecond line`,
			nodes: [
				node("x".repeat(100), "understand", [], {
					title: "a".repeat(5000),
					question: "q ".repeat(2000),
					thinking: steps,
					conclusion: "c".repeat(5000),
				}),
			],
		});
		const only = built.nodes[0]!;
		expect(built.goal).toHaveLength(300);
		expect(built.goal.endsWith("…")).toBe(true);
		expect(only.id).toHaveLength(40);
		expect(only.title).toHaveLength(120);
		expect(only.question.length).toBeLessThanOrEqual(1000);
		expect(only.question).not.toContain("\n");
		expect(only.steps).toHaveLength(12);
		for (const step of only.steps) expect(step.length).toBeLessThanOrEqual(600);
		expect(only.conclusion).toHaveLength(2000);
		expect(built.truncated).toBe(true);
	});

	test("draws at most 24 nodes", () => {
		const nodes = Array.from({ length: 30 }, (_, i) => node(`n${i + 1}`, "generate", i === 0 ? [] : [`n${i}`]));
		const built = view({ goal: "g", nodes });
		expect(built.nodes).toHaveLength(24);
		expect(built.counts).toMatchObject({ nodes: 24, edges: 23, waves: 24 });
		expect(built.truncated).toBe(true);
		expectSound(built);
		expect(renderMermaid(built).split("\n").filter((line) => /^\s+N\d+\[/.test(line))).toHaveLength(24);
	});

	test("one-line fields never carry line breaks or control characters", () => {
		const built = view({
			goal: "g",
			nodes: [node("n\n1\u0007", "understand", [], { title: "t\r\nu\u202Ev\u0000w", question: "a\n\nb", conclusion: "x\r\ny\u0000\n\n\n\nz" })],
		});
		const only = built.nodes[0]!;
		expect(only.id).toBe("n 1");
		expect(only.title).toBe("t u v w");
		expect(only.question).toBe("a b");
		expect(only.conclusion).toBe("x\ny\n\nz");
	});

	test("an unknown kind is coerced and malformed nodes do not throw", () => {
		const built = view({
			goal: 7,
			nodes: [{ id: 5, title: null, kind: "wizardry", question: {}, dependsOn: "n1", thinking: 3, conclusion: [] }, { id: "ok", dependsOn: [null, 4, "ok"] }],
		});
		expect(built.nodes).toHaveLength(2);
		expect(built.nodes.every((n) => (NODE_KINDS as readonly string[]).includes(n.kind))).toBe(true);
		expect(built.goal).toBe("");
		expectSound(built);
		expect(() => renderMermaid(built)).not.toThrow();
		expect(() => renderTree(built)).not.toThrow();
	});

	test("a node with no rationale still has one step, like the tracker plan", () => {
		const built = view({ goal: "g", nodes: [node("n1", "understand", [], { thinking: "", conclusion: "Only the answer." }), node("n2", "decompose", ["n1"], { thinking: undefined, conclusion: undefined })] });
		expect(built.nodes[0]!.steps).toEqual(["Only the answer."]);
		expect(built.nodes[1]!.steps).toEqual(["Question n2?"]);
	});

	test("step counts and order match the tracker plan on shared fixtures", () => {
		const thinkings = [
			"1. Read the request.\n2. Note streaming.\n3. Decide.",
			"1) one\n2) two\n3) three\n4) four\n5) five",
			"**1.** bold first\n**2.** bold second",
			"Step 1: alpha\nStep 2: beta\nStep 3: gamma",
			"Preamble sentence. 1. first inline 2. second inline 3. third inline",
			"1. first\nwrapped continuation\n2. second\n2. repeated number\n7. skipped number",
			"No numbering here, just prose.",
			"",
			"   \n  ",
			`1. ${"long ".repeat(40)}\n2. short`,
		];
		for (const thinking of thinkings) {
			const source = node("n1", "understand", [], { thinking, conclusion: "Fallback conclusion." });
			const built = view({ goal: "g", nodes: [source] });
			const titles = nodeStepTitles(source);
			const steps = built.nodes[0]!.steps;
			expect(steps).toHaveLength(titles.length);
			for (const [i, title] of titles.entries()) {
				const snippet = title.replace(/^Step \d+: /, "");
				expect(title.startsWith(`Step ${i + 1}: `)).toBe(true);
				if (snippet.endsWith("…")) expect(steps[i]!.startsWith(snippet.slice(0, -1))).toBe(true);
				else expect(steps[i]).toBe(snippet);
			}
		}
	});
});

/** Text that tries to break out of a label, add nodes or directives, or close a fence. */
const HOSTILE_TITLES = [
	'quote " inside',
	"brackets [x] and (y) and {z}",
	"pipe | and <b>html</b> and <br/>",
	"back`tick``s```",
	"<script>alert(1)</script>",
	"%%{init: {'theme':'dark'}}%%",
	"line one\nclick N1 call evil()\nstyle N1 fill:red\nlinkStyle 0 stroke:red",
	'x"] --> N9["injected',
	"semi; colon: hash # amp & back\\slash",
	"T".repeat(5000),
	"",
	"   ",
	"ünïcödé 日本語 émoji 🙂 text",
	"end",
	"N1",
];

describe("renderMermaid", () => {
	test("renders the expected diagram for a small graph", () => {
		expect(renderMermaid(view(SMALL))).toBe(
			[
				"flowchart TD",
				'  subgraph W1["Wave 1"]',
				'    N1["n1: Understand"]',
				"  end",
				'  subgraph W2["Wave 2 - parallel"]',
				'    N2["n2: Parser"]',
				'    N3["n3: Writer"]',
				"  end",
				'  subgraph W3["Wave 3"]',
				'    N4["n4: Synthesize"]',
				"  end",
				"  N1 --> N2",
				"  N1 --> N3",
				"  N2 --> N4",
				"  N3 --> N4",
				"  classDef understand fill:#dbeafe,stroke:#1d4ed8,color:#0f172a",
				"  class N1 understand",
				"  classDef decompose fill:#e0e7ff,stroke:#4338ca,color:#0f172a",
				"  class N2 decompose",
				"  classDef generate fill:#dcfce7,stroke:#15803d,color:#0f172a",
				"  class N3 generate",
				"  classDef synthesize fill:#ccfbf1,stroke:#0f766e,color:#0f172a",
				"  class N4 synthesize",
			].join("\n"),
		);
	});

	test("uses the fixed palette for every kind and groups class statements", () => {
		const kinds = [...NODE_KINDS];
		const nodes = kinds.map((kind, i) => node(`k${i}`, kind, []));
		const text = renderMermaid(view({ goal: "g", nodes: [...nodes, node("extra", "understand", [])] }));
		const expected: Record<string, [string, string]> = {
			understand: ["#dbeafe", "#1d4ed8"],
			decompose: ["#e0e7ff", "#4338ca"],
			generate: ["#dcfce7", "#15803d"],
			compare: ["#fef9c3", "#a16207"],
			critique: ["#fee2e2", "#b91c1c"],
			aggregate: ["#ede9fe", "#6d28d9"],
			refine: ["#ffedd5", "#c2410c"],
			synthesize: ["#ccfbf1", "#0f766e"],
		};
		for (const kind of kinds) {
			const [fill, stroke] = expected[kind]!;
			expect(text).toContain(`  classDef ${kind} fill:${fill},stroke:${stroke},color:#0f172a\n`);
		}
		expect(text).toMatch(/^ {2}class N1,N9 understand$/m);
	});

	test("hostile model text stays inside quoted, whitelisted labels and adds no nodes, edges or directives", () => {
		const nodes: ThoughtNode[] = HOSTILE_TITLES.map((title, i) => node(`id${i}`, NODE_KINDS[i % NODE_KINDS.length]!, i === 0 ? [] : [`id${i - 1}`, "ghost", `id${i}`], { title }));
		// Hostile ids too, a cycle, and a duplicate.
		nodes.push(node('bad"id]', "critique", ["id3"], { title: "t" }), node("id3", "refine", ["bad\"id]"], { title: "dup" }), node("cyc1", "compare", ["cyc2"]), node("cyc2", "compare", ["cyc1"]));
		const built = view({ goal: 'goal "] %%{init}%% <script>', nodes });
		const text = renderMermaid(built);
		const drawn = built.nodes.length;
		const allowed = [
			/^flowchart TD$/,
			/^ {2}subgraph W\d+\["Wave \d+( - parallel)?"\]$/,
			/^ {2}end$/,
			/^ {4}N\d+\["[\p{L}\p{N} .,:+_\/'…-]*"\]$/u,
			/^ {2}N\d+ --> N\d+$/,
			/^ {2}classDef (understand|decompose|generate|compare|critique|aggregate|refine|synthesize) fill:#[0-9a-f]{6},stroke:#[0-9a-f]{6},color:#0f172a$/,
			/^ {2}class N\d+(,N\d+)* (understand|decompose|generate|compare|critique|aggregate|refine|synthesize)$/,
		];
		for (const line of text.split("\n")) {
			expect(allowed.some((re) => re.test(line))).toBe(true);
		}
		expect(text.split("\n").filter((line) => /^ {4}N\d+\[/.test(line))).toHaveLength(drawn);
		expect(text.split("\n").filter((line) => line.startsWith("  subgraph "))).toHaveLength(built.waves.length);
		for (const line of text.split("\n")) {
			const label = line.match(/^ {4}N\d+\["(.*)"\]$/u)?.[1];
			if (label !== undefined) expect([...label].length).toBeLessThanOrEqual(44);
		}
		expect(text).not.toMatch(/%%|<|`|^\s*(click|style|linkStyle)\b/m);
		const edges = text.split("\n").filter((line) => line.includes("-->"));
		expect(new Set(edges).size).toBe(edges.length);
		expect(edges.length).toBe(built.counts.edges);
		// Every edge points from an earlier to a later node: the cycle cannot loop the diagram.
		for (const edge of edges) {
			const [from, to] = edge.match(/\d+/g)!.map(Number);
			expect(from!).toBeLessThan(to!);
		}
	});

	test("an empty title falls back to the id, and an empty id-less label to a placeholder", () => {
		const text = renderMermaid(view({ goal: "g", nodes: [node("n1", "understand", [], { title: "" }), node("%%%", "decompose", [], { title: "###" })] }));
		expect(text).toContain('N1["n1"]');
		expect(text).toContain('N2["node 2"]');
	});

	test("a long label is cut at 44 characters with an ellipsis", () => {
		const text = renderMermaid(view({ goal: "g", nodes: [node("n1", "understand", [], { title: "word ".repeat(40) })] }));
		const label = text.match(/N1\["(.*)"\]/u)![1]!;
		expect([...label]).toHaveLength(44);
		expect(label.endsWith("…")).toBe(true);
	});
});

describe("renderTree", () => {
	test("renders aligned one-line rows per wave", () => {
		expect(renderTree(view(SMALL))).toBe(
			[
				"Goal: Design the converter",
				"Wave 1",
				"  n1  Understand  [understand]  2 steps",
				"Wave 2 (parallel)",
				"  n2  Parser      [decompose]   2 steps  after n1",
				"  n3  Writer      [generate]    2 steps  after n1",
				"Wave 3",
				"  n4  Synthesize  [synthesize]  2 steps  after n2, n3",
			].join("\n"),
		);
	});

	test("model text is collapsed to one line and capped; a single step reads singular", () => {
		const built = view({
			goal: `${"goal ".repeat(100)}\nmore`,
			nodes: [node("n1", "understand", [], { title: `multi\nline ${"w".repeat(200)}`, thinking: "just one step" })],
		});
		const lines = renderTree(built).split("\n");
		expect(lines).toHaveLength(3);
		expect(lines[0]!.length).toBeLessThanOrEqual("Goal: ".length + 160);
		expect(lines[0]!.endsWith("…")).toBe(true);
		expect(lines[2]).toMatch(/^ {2}n1 {2}multi line w+… {2}\[understand\] {2}1 step$/);
	});

	test("an empty title is shown as untitled", () => {
		expect(renderTree(view({ goal: "g", nodes: [node("n1", "understand", [], { title: "" })] }))).toContain("(untitled)");
	});
});

describe("renderGraphBlock", () => {
	test("is a heading, one instruction paragraph, a text fence with the tree and a mermaid fence", () => {
		const built = view(SMALL);
		const text = renderGraphBlock(built);
		const [heading, instruction, tree, mermaid] = text.split("\n\n");
		expect(heading).toBe("## Graph of Thought x Chain of Thought");
		expect(instruction).toBe(
			"Show the user the wave tree below first, unchanged, in a code block. If your interface renders Mermaid, also show the diagram after it as a mermaid code block.",
		);
		expect(instruction!.match(/[.!?](\s|$)/g)).toHaveLength(2);
		expect(tree).toBe(`\`\`\`text\n${renderTree(built)}\n\`\`\``);
		expect(mermaid).toBe(`\`\`\`mermaid\n${renderMermaid(built)}\n\`\`\``);
	});

	test("the tree fence is longer than any backtick run in model text", () => {
		const built = view({ goal: "goal ````````` end", nodes: [node("n1", "understand", [], { title: "``` x" })] });
		const text = renderGraphBlock(built);
		const fence = "`".repeat(10);
		const lines = text.split("\n");
		// The tree comes first: it opens with the long fence and closes with it exactly once; the diagram follows in a short fence.
		expect(lines.some((line) => line === `${fence}text`)).toBe(true);
		expect(lines.filter((line) => line === fence)).toHaveLength(1);
		expect(lines.indexOf(fence)).toBeLessThan(lines.indexOf("```mermaid"));
		expect(lines.at(-1)).toBe("```");
	});
});
