import { describe, expect, test } from "bun:test";
import type { Clarification } from "../hitl/types.ts";
import type { ThoughtGraph } from "../think/types.ts";
import type { UpliftResult } from "../types.ts";
import { buildTrackPlan, generateGraphId } from "./plan.ts";

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

		expect(plan.subIssues).toHaveLength(2);
		expect(plan.subIssues[0]).toEqual({
			graphId: "ut-fixed",
			nodeId: "n1",
			item: "[n1] Chain of Thought",
			step: 1,
			thought: "THINKING: Read the request\nCONCLUSION: Add a paginated list",
		});
		expect(plan.subIssues[1]?.thought).toBe("What is the plan?");

		expect(plan.linearIssues.map((i) => i.nodeId)).toEqual(["n1", "n2"]);
		expect(plan.linearSubIssues.map((i) => i.nodeId)).toEqual(["n1", "n2"]);
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
});
