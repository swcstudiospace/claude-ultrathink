// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import type { Clarification } from "../hitl/types.ts";
import type { ThoughtGraph } from "../think/types.ts";
import type { UpliftResult } from "../types.ts";
import { buildTrackPlan, generateGraphId, MAX_UPLIFTED_PROMPT_CHARS, nodeStepTitles, splitRationaleSteps } from "./plan.ts";

const uplift: UpliftResult = {
	xml: "<BUILD_PROMPT><ORIGINAL>Add a widget list page</ORIGINAL></BUILD_PROMPT>",
	original: "Add a widget list page",
	root: "BUILD_PROMPT",
	source: "llm",
};

const graph: ThoughtGraph = {
	goal: "Ship the widget list page",
	nodes: [
		{
			id: "n1",
			title: "Understand",
			kind: "understand",
			question: "What is being asked?",
			dependsOn: [],
			thinking: "Read the request",
			conclusion: "Add a paginated list",
		},
		{ id: "n2", title: "Plan", kind: "synthesize", question: "What is the plan?", dependsOn: ["n1"], thinking: "", conclusion: "" },
	],
};

describe("generateGraphId", () => {
	test("prefixed with ut- and unique across calls", () => {
		const id = generateGraphId(() => 1_726_000_000_000);
		expect(id.startsWith("ut-")).toBe(true);
		expect(generateGraphId()).not.toBe(generateGraphId());
	});
});

describe("buildTrackPlan", () => {
	test("builds one Task, one Issue and one Sub-Issue per node, all sharing the graph id", () => {
		const plan = buildTrackPlan({
			uplift,
			graph,
			clarifications: [],
			repo: "acme/widgets",
			branch: "feat/list",
			graphId: "ut-fixed",
		});

		expect(plan.graphId).toBe("ut-fixed");
		expect(plan.task).toEqual({
			graphId: "ut-fixed",
			item: "Add a widget list page",
			description: "Add a widget list page",
			upliftedPrompt: uplift.xml,
			agent: "claude-code",
			status: "Planning",
			linearState: "Todo",
			repo: "acme/widgets",
			branch: "feat/list",
		});

		expect(plan.issues).toEqual([
			{ graphId: "ut-fixed", nodeId: "n1", item: "[n1] Understand", thought: "Add a paginated list" },
			{ graphId: "ut-fixed", nodeId: "n2", item: "[n2] Plan", thought: "What is the plan?" },
		]);

		// An unnumbered rationale is one step; an empty one falls back to a single step so every Issue keeps a Sub-Issue.
		expect(plan.subIssues).toHaveLength(2);
		expect(plan.subIssues[0]).toEqual({
			graphId: "ut-fixed",
			nodeId: "n1",
			item: "[n1] Step 1: Read the request",
			step: 1,
			thought: "Read the request",
		});
		expect(plan.subIssues[1]).toEqual({
			graphId: "ut-fixed",
			nodeId: "n2",
			item: "[n2] Step 1: What is the plan?",
			step: 1,
			thought: "What is the plan?",
		});

		expect(plan.linearIssues.map((i) => i.nodeId)).toEqual(["n1", "n2"]);
		expect(plan.linearSubIssues).toEqual([
			{ nodeId: "n1", step: 1, title: "Understand — Step 1: Read the request", description: "Read the request" },
			{ nodeId: "n2", step: 1, title: "Plan — Step 1: What is the plan?", description: "What is the plan?" },
		]);
	});

	test("no graph: Task only, empty Issue/Sub-Issue/Linear arrays", () => {
		const plan = buildTrackPlan({ uplift, clarifications: [], graphId: "ut-fixed" });
		expect(plan.issues).toEqual([]);
		expect(plan.subIssues).toEqual([]);
		expect(plan.linearIssues).toEqual([]);
		expect(plan.linearSubIssues).toEqual([]);
	});

	test("splits open clarifications into blocking/nonBlocking and drops already-answered ones", () => {
		const clarifications: Clarification[] = [
			{
				id: "q1",
				question: "Which database?",
				header: "DB",
				why: "w",
				options: [{ label: "Postgres" }, { label: "SQLite" }],
				default: "Postgres",
				blocking: true,
			},
			{
				id: "q2",
				question: "Keep old API?",
				header: "API",
				why: "w",
				options: [{ label: "Yes" }, { label: "No" }],
				default: "No",
				blocking: false,
			},
			{
				id: "q3",
				question: "Already answered?",
				header: "X",
				why: "w",
				options: [{ label: "A" }, { label: "B" }],
				default: "A",
				blocking: true,
				answer: "A",
				source: "user",
				answeredAt: 1,
			},
		];
		const plan = buildTrackPlan({ uplift, clarifications, graphId: "ut-fixed" });
		expect(plan.hitl.blocking.map((c) => c.id)).toEqual(["q1"]);
		expect(plan.hitl.nonBlocking.map((c) => c.id)).toEqual(["q2"]);
	});

	test("truncates a long original into a 120-char task title, keeping the full text in description", () => {
		const long = "x".repeat(200);
		const plan = buildTrackPlan({ uplift: { ...uplift, original: long }, clarifications: [], graphId: "ut-fixed" });
		expect(plan.task.item).toHaveLength(120);
		expect(plan.task.item.endsWith("...")).toBe(true);
		expect(plan.task.description).toBe(long);
	});

	test("short uplifted XML passes through unchanged", () => {
		const plan = buildTrackPlan({ uplift, clarifications: [], graphId: "ut-fixed" });
		expect(plan.task.upliftedPrompt).toBe(uplift.xml);
	});

	test("agent input labels the Task row with the planning host", () => {
		const plan = buildTrackPlan({ uplift, clarifications: [], graphId: "ut-fixed", agent: "omp" });
		expect(plan.task.agent).toBe("omp");
	});

	test("uplifted XML over the Notion rich-text cap is truncated with a marker, staying under the cap", () => {
		const longXml = `<BUILD_PROMPT><ORIGINAL>${"x".repeat(5000)}</ORIGINAL></BUILD_PROMPT>`;
		const plan = buildTrackPlan({ uplift: { ...uplift, xml: longXml }, clarifications: [], graphId: "ut-fixed" });
		expect(plan.task.upliftedPrompt.length).toBeLessThanOrEqual(MAX_UPLIFTED_PROMPT_CHARS);
		expect(plan.task.upliftedPrompt).toContain("truncated");
		expect(plan.task.upliftedPrompt.startsWith(longXml.slice(0, 100))).toBe(true);
	});
});

describe("splitRationaleSteps", () => {
	test("splits inline numbered steps in sequence order", () => {
		expect(splitRationaleSteps("1. Read the file. 2. Find the loop. 3. Fix it.")).toEqual([
			"Read the file.",
			"Find the loop.",
			"Fix it.",
		]);
	});

	test("splits line-start steps with either '.' or ')' markers", () => {
		expect(splitRationaleSteps("1) alpha\n2) beta\n3. gamma")).toEqual(["alpha", "beta", "gamma"]);
	});

	test("ignores numbers that do not continue the sequence (nested lists, counts, versions)", () => {
		const text = "1. Check 5-8 nodes and v2. of the API. 2. Then run 1. lint 2. tests. 3. Ship.";
		expect(splitRationaleSteps(text)).toEqual([
			"Check 5-8 nodes and v2. of the API.",
			"Then run 1. lint 2. tests.",
			"Ship.",
		]);
	});

	test("folds a preamble before step 1 into the first step", () => {
		expect(splitRationaleSteps("Plan: 1. one 2. two")).toEqual(["Plan: one", "two"]);
	});

	test("line-start lists split on every marker even when numbering is skipped, repeated, bold, or 'Step N'", () => {
		expect(splitRationaleSteps("1. a\n2. b\n4. c\n4. d")).toEqual(["a", "b", "c", "d"]);
		expect(splitRationaleSteps("**1.** a\n**2.** b")).toEqual(["a", "b"]);
		expect(splitRationaleSteps("Step 1: a\nStep 2 - b\nstep 3. c")).toEqual(["a", "b", "c"]);
		// Indented list lines (as the CoT prompt's template shows them) still split per line.
		expect(splitRationaleSteps("1. a\n    2. b has 3. inside\n    3. c")).toEqual(["a", "b has 3. inside", "c"]);
	});

	test("unnumbered text is a single step; empty text is no steps", () => {
		expect(splitRationaleSteps("Just reasoning with 1 idea.")).toEqual(["Just reasoning with 1 idea."]);
		expect(splitRationaleSteps("   ")).toEqual([]);
		expect(splitRationaleSteps("1. only one step")).toEqual(["only one step"]);
	});
});

describe("buildTrackPlan per-step Sub-Issues", () => {
	function stepped(count: number, id: string): string {
		return Array.from({ length: count }, (_, i) => `${i + 1}. ${id} step ${i + 1} body`).join(" ");
	}

	function graphWith(counts: Record<string, number>): ThoughtGraph {
		const ids = Object.keys(counts);
		return {
			goal: "g",
			nodes: ids.map((id, index) => ({
				id,
				title: `Title ${id}`,
				kind: index === ids.length - 1 ? "synthesize" : "generate",
				question: `Q ${id}`,
				dependsOn: index === 0 ? [] : [ids[index - 1]!],
				thinking: stepped(counts[id]!, id),
				conclusion: `C ${id}`,
			})),
		};
	}

	test("one Sub-Issue and one Linear sub-issue per numbered step, at the 5 and 8 boundaries", () => {
		const plan = buildTrackPlan({ uplift, graph: graphWith({ n1: 5, n2: 8 }), clarifications: [], graphId: "ut-fixed" });

		expect(plan.issues).toHaveLength(2);
		expect(plan.subIssues).toHaveLength(13);
		expect(plan.linearSubIssues).toHaveLength(13);

		const n1 = plan.subIssues.filter((row) => row.nodeId === "n1");
		const n2 = plan.subIssues.filter((row) => row.nodeId === "n2");
		expect(n1.map((row) => row.step)).toEqual([1, 2, 3, 4, 5]);
		expect(n2.map((row) => row.step)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
		expect(n1[2]).toEqual({
			graphId: "ut-fixed",
			nodeId: "n1",
			item: "[n1] Step 3: n1 step 3 body",
			step: 3,
			thought: "n1 step 3 body",
		});

		const linearN2 = plan.linearSubIssues.filter((row) => row.nodeId === "n2");
		expect(linearN2[7]).toEqual({
			nodeId: "n2",
			step: 8,
			title: "Title n2 — Step 8: n2 step 8 body",
			description: "n2 step 8 body",
		});
		// Every row still carries the graph id and stays grouped under its own node.
		expect(plan.subIssues.every((row) => row.graphId === "ut-fixed")).toBe(true);
		expect(plan.subIssues.map((row) => row.nodeId)).toEqual([...Array(5).fill("n1"), ...Array(8).fill("n2")]);
	});

	test("nodeStepTitles are exactly the step titles inside the node's Linear sub-issues", () => {
		const stepped = graphWith({ n1: 3, n2: 1 });
		stepped.nodes[1]!.thinking = "";
		const plan = buildTrackPlan({ uplift, graph: stepped, clarifications: [], graphId: "ut-fixed" });
		for (const node of stepped.nodes) {
			const titles = plan.linearSubIssues.filter((row) => row.nodeId === node.id).map((row) => row.title.slice(`${node.title} — `.length));
			expect(nodeStepTitles(node)).toEqual(titles);
		}
		expect(nodeStepTitles(stepped.nodes[1]!)).toEqual(["Step 1: C n2"]);
	});

	test("Issue rows are unchanged by the split: still one per node carrying the conclusion", () => {
		const plan = buildTrackPlan({ uplift, graph: graphWith({ n1: 6 }), clarifications: [], graphId: "ut-fixed" });
		expect(plan.issues).toEqual([{ graphId: "ut-fixed", nodeId: "n1", item: "[n1] Title n1", thought: "C n1" }]);
		expect(plan.linearIssues).toEqual([{ nodeId: "n1", title: "Title n1", description: "C n1" }]);
	});

	test("long step text is shortened in titles but kept whole in the thought/description", () => {
		const long = `1. ${"x".repeat(200)} 2. short`;
		const graph: ThoughtGraph = {
			goal: "g",
			nodes: [{ id: "n1", title: "T", kind: "synthesize", question: "Q", dependsOn: [], thinking: long, conclusion: "C" }],
		};
		const plan = buildTrackPlan({ uplift, graph, clarifications: [], graphId: "ut-fixed" });
		expect(plan.subIssues[0]?.thought).toBe("x".repeat(200));
		expect(plan.subIssues[0]?.item.length).toBeLessThan(120);
		expect(plan.subIssues[0]?.item.endsWith("…")).toBe(true);
		expect(plan.linearSubIssues[0]?.title.length).toBeLessThan(120);
	});
});
