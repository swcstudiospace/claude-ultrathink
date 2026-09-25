// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { existsSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import type { Clarification } from "../hitl/types.ts";
import { FALLBACK_GRAPH } from "../think/types.ts";
import { formatPromptContext, formatSummary, SKILL_CONTEXT_HEADER, TRACKING_OFF_NOTE, truncateXml, UPLIFT_CONTEXT_HEADER } from "./output.ts";
import type { TrackingRefs, TrackPlan } from "../track/types.ts";

const result = { xml: "<BUILD_PROMPT>\n<ORIGINAL>x</ORIGINAL>\n</BUILD_PROMPT>", original: "x", root: "BUILD_PROMPT", source: "llm" as const };

const clarifications: Clarification[] = [
	{
		id: "q1",
		question: "Which database?",
		header: "Database",
		why: "Schema depends on it",
		options: [{ label: "Postgres" }, { label: "SQLite" }],
		default: "Postgres",
		blocking: true,
	},
	{
		id: "q2",
		question: "Keep the old API?",
		header: "Old API",
		why: "Affects removal scope",
		options: [{ label: "Yes" }, { label: "No" }],
		default: "No",
		blocking: false,
		answer: "No",
		answeredAt: 1,
		source: "user",
	},
];

describe("formatPromptContext", () => {
	test("a skill invocation swaps in the skill header; without one the plain header is unchanged", () => {
		const skilled = formatPromptContext({ result, skill: "gsd-quick" });
		expect(skilled.startsWith(SKILL_CONTEXT_HEADER("gsd-quick"))).toBe(true);
		expect(skilled).not.toContain(UPLIFT_CONTEXT_HEADER);
		expect(skilled).toContain('invoked the "gsd-quick" skill');
		expect(skilled).toContain("authoritative for HOW");
		expect(skilled).toContain(result.xml);
		expect(formatPromptContext({ result }).startsWith(UPLIFT_CONTEXT_HEADER)).toBe(true);
	});

	test("frames the spec as the user's intent, includes xml and the graph addendum", () => {
		const out = formatPromptContext({ result, graph: FALLBACK_GRAPH, specPath: "/s/x.xml" });
		expect(out.startsWith(UPLIFT_CONTEXT_HEADER)).toBe(true);
		expect(out).toContain("slash commands remain available");
		expect(out).toContain("not the end of the turn");
		expect(out).toContain("Specification file: /s/x.xml");
		expect(out).toContain(result.xml);
		expect(out).toContain("## Graph of Thought");
		expect(out).toContain("Workflow waves: 1: n1 · 2: n2 · 3: n3 · 4: n4 · 5: n5");
	});

	test("no graph, no clarifications, no state path: just the header and xml", () => {
		const out = formatPromptContext({ result });
		expect(out).not.toContain("## Graph of Thought");
		expect(out).not.toContain("## Clarifications (HITL)");
		expect(out).not.toContain("## Ultrathink tracking");
	});

	test("adds the HITL addendum after the graph addendum when clarifications exist", () => {
		const out = formatPromptContext({ result, graph: FALLBACK_GRAPH, clarifications });
		expect(out).toContain("## Clarifications (HITL)");
		expect(out.indexOf("## Graph of Thought")).toBeLessThan(out.indexOf("## Clarifications (HITL)"));
		expect(formatPromptContext({ result, clarifications: [] })).not.toContain("## Clarifications (HITL)");
	});

	test("adds the ultrathink-kickoff instruction last, naming the state file", () => {
		const out = formatPromptContext({ result, graph: FALLBACK_GRAPH, clarifications, statePath: "/s/session.json" });
		expect(out).toContain("## Ultrathink tracking");
		expect(out).toContain("invoke the ultrathink-kickoff skill with stateFile=/s/session.json");
		expect(out.indexOf("## Clarifications (HITL)")).toBeLessThan(out.indexOf("## Ultrathink tracking"));
	});

	test("truncates oversized xml at a line boundary and points at the spec file", () => {
		const big = { ...result, xml: Array.from({ length: 500 }, (_, i) => `<L${i}>${"y".repeat(100)}</L${i}>`).join("\n") };
		const out = formatPromptContext({ result: big, specPath: "/s/big.xml", maxChars: 8_000 });
		expect(out.length).toBeLessThan(8_300);
		expect(out).toContain("truncated by Prompt Uplift. Full specification: /s/big.xml");
		expect(truncateXml("short", 100)).toBe("short");
	});

	test("lists workflow waves, marking parallel waves, and keeps them past truncation", () => {
		const node = (id: string, dependsOn: string[]) => ({ id, title: id, kind: "understand" as const, question: "?", dependsOn });
		const diamond = { goal: "g", nodes: [node("n1", []), node("n2", ["n1"]), node("n3", ["n1"]), node("n4", ["n2", "n3"])] };
		expect(formatPromptContext({ result, graph: diamond })).toContain("Workflow waves: 1: n1 · 2: n2, n3 (parallel) · 3: n4");

		const big = { ...result, xml: Array.from({ length: 500 }, (_, i) => `<L${i}>${"y".repeat(100)}</L${i}>`).join("\n") };
		const out = formatPromptContext({ result: big, graph: diamond, clarifications, specPath: "/s/big.xml", maxChars: 3_000 });
		expect(out).toContain("truncated by Prompt Uplift");
		expect(out).toContain("Workflow waves: 1: n1 · 2: n2, n3 (parallel) · 3: n4");
		expect(out).toContain("## Clarifications (HITL)");
	});
});

describe("ship", () => {
	test("the Ship section appears only with ship + statePath, last, and survives truncation", () => {
		const big = { ...result, xml: `<BUILD_PROMPT>${"x".repeat(10_000)}</BUILD_PROMPT>` };
		const out = formatPromptContext({ result: big, skill: "gsd-quick", statePath: "/s/x.json", ship: true, maxChars: 3_000 });
		expect(out).toContain("## Ship");
		expect(out).toContain("invoke the ultrathink-ship skill with stateFile=/s/x.json");
		expect(out.indexOf("## Ultrathink tracking")).toBeLessThan(out.indexOf("## Ship"));
		expect(formatPromptContext({ result, skill: "gsd-quick", statePath: "/s/x.json" })).not.toContain("## Ship");
		expect(formatPromptContext({ result, skill: "gsd-quick", ship: true })).not.toContain("## Ship");
	});
});

describe("truncateXml", () => {
	const node = (id: string, thinking: number) =>
		`\t<NODE id="${id}">\n\t\t<RATIONALE>${"t".repeat(thinking)}</RATIONALE>\n\t\t<CONCLUSION>done ${id}</CONCLUSION>\n\t</NODE>`;
	const tail = [
		"\t<WORKFLOW>",
		'\t\t<WAVE n="1" parallel="true">n1, n2</WAVE>',
		"\t</WORKFLOW>",
		"</GRAPH_OF_THOUGHT>",
		"<CLARIFICATIONS>",
		'\t<CLARIFICATION id="q1" header="Auth" blocking="true"><QUESTION>Which auth?</QUESTION></CLARIFICATION>',
		"</CLARIFICATIONS>",
		"</BUILD_PROMPT>",
	].join("\n");
	const spec = (thinking: number, nodes = 3) =>
		["<BUILD_PROMPT>", "<ORIGINAL>x</ORIGINAL>", "<GRAPH_OF_THOUGHT>", ...Array.from({ length: nodes }, (_, i) => node(`n${i + 1}`, thinking)), tail].join("\n");

	test("small xml is returned untouched", () => {
		const xml = spec(50);
		expect(truncateXml(xml, 10_000)).toBe(xml);
		expect(truncateXml("short", 100)).toBe("short");
	});

	test("over budget, RATIONALE bodies are elided first and the WORKFLOW + CLARIFICATIONS tail survives", () => {
		const out = truncateXml(spec(5_000), 4_000, "/s/x.xml");
		expect(out.length).toBeLessThanOrEqual(4_000);
		expect(out).not.toContain("ttttt");
		expect(out.match(/<RATIONALE>\(omitted — full text in the specification file\)<\/RATIONALE>/g)).toHaveLength(3);
		expect(out).toContain("done n3");
		expect(out).toContain('<WAVE n="1" parallel="true">n1, n2</WAVE>');
		expect(out).toContain("<CLARIFICATIONS>");
		expect(out).toContain("Which auth?");
		expect(out.endsWith("</BUILD_PROMPT>")).toBe(true);
		expect(out).not.toContain("truncated by Prompt Uplift");
	});

	test("still over budget after eliding, the tail is cut at a line boundary with the marker", () => {
		const out = truncateXml(spec(5_000, 40), 2_000, "/s/x.xml");
		expect(out.length).toBeLessThan(2_100);
		expect(out).not.toContain("ttttt");
		expect(out).toContain("(omitted — full text in the specification file)");
		expect(out.endsWith("<!-- truncated by Prompt Uplift. Full specification: /s/x.xml -->")).toBe(true);
		expect(out).not.toContain("<CLARIFICATIONS>");
	});
});

describe("formatSummary", () => {
	test("reports root, source, nodes, tracking pending, and elapsed time", () => {
		expect(formatSummary({ result, graph: FALLBACK_GRAPH, tracked: true, elapsedMs: 12_345 })).toBe(
			"Prompt Uplift · BUILD_PROMPT · llm · Graph of Thought · 5 nodes · Tracking · ultrathink-kickoff pending · 12.3s",
		);
		expect(formatSummary({ result })).toBe("Prompt Uplift · BUILD_PROMPT · llm");
	});

	test("names the invoked skill right after the engine", () => {
		expect(formatSummary({ result, engine: "claude:sonnet", skill: "gsd-quick" })).toBe(
			"Prompt Uplift · BUILD_PROMPT · llm · claude:sonnet · Skill · gsd-quick",
		);
	});

	test("adds engine, open HITL count and engine error bits only when provided", () => {
		expect(
			formatSummary({
				result,
				engine: "claude:sonnet",
				graph: FALLBACK_GRAPH,
				clarifications,
				engineError: "claude timed out after 5ms",
				elapsedMs: 1_000,
			}),
		).toBe(
			"Prompt Uplift · BUILD_PROMPT · llm · claude:sonnet · Graph of Thought · 5 nodes · HITL · 1 question(s) · Engine error · claude timed out after 5ms · 1.0s",
		);
		expect(formatSummary({ result, clarifications: [] })).toBe("Prompt Uplift · BUILD_PROMPT · llm");
	});
});

const plan: TrackPlan = {
	graphId: "g1",
	task: { graphId: "g1", item: "Task", description: "d", upliftedPrompt: "p", agent: "claude", status: "Planned", linearState: "Todo" },
	issues: [
		{ graphId: "g1", nodeId: "n1", item: "[n1] Understand", thought: "t" },
		{ graphId: "g1", nodeId: "n2", item: "[n2] Build", thought: "t" },
	],
	subIssues: [{ graphId: "g1", nodeId: "n1", item: "[n1] Step 1: read", step: 1, thought: "t" }],
	linearIssues: [],
	linearSubIssues: [],
	hitl: { blocking: [], nonBlocking: [] },
};
const ref = (identifier: string) => ({ id: identifier, identifier, url: `https://linear.app/o/issue/${identifier}`, title: identifier });
const complete: TrackingRefs = {
	graphId: "g1",
	status: "complete",
	linear: { nodes: { n1: ref("SPE-1"), n2: ref("SPE-2") }, steps: { "n1.1": ref("SPE-3") } },
	notion: { taskUrl: "https://www.notion.so/t", nodes: { n1: "https://www.notion.so/1", n2: "https://www.notion.so/2" }, steps: { "n1.1": "https://www.notion.so/3" } },
	errors: [],
	updatedAt: 1,
};
const partial: TrackingRefs = {
	...complete,
	status: "partial",
	linear: { nodes: { n1: ref("SPE-1") }, steps: {} },
	notion: { nodes: {}, steps: {} },
	errors: ["notion: login required"],
};

describe("tracking", () => {
	test("Linked issues sit after the workflow waves and before the HITL addendum", () => {
		const out = formatPromptContext({ result, graph: FALLBACK_GRAPH, clarifications, plan, tracking: complete, statePath: "/s/x.json" });
		expect(out).toContain(
			"Tracker rows created before this turn: 2 Linear issues, 1 sub-issues, Notion task https://www.notion.so/t (graph g1, status complete).",
		);
		expect(out).toContain("- [ ] n1 · [SPE-1](https://linear.app/o/issue/SPE-1) · Understand · notion: https://www.notion.so/1");
		expect(out).toContain("`Refs SPE-12`");
		expect(out.indexOf("Workflow waves:")).toBeLessThan(out.indexOf("## Linked issues"));
		expect(out.indexOf("## Linked issues")).toBeLessThan(out.indexOf("## Clarifications (HITL)"));
	});

	test("the Linked issues section survives a tiny budget", () => {
		const big = { ...result, xml: `<BUILD_PROMPT>\n${"<X>filler</X>\n".repeat(2_000)}</BUILD_PROMPT>` };
		const out = formatPromptContext({ result: big, plan, tracking: partial, maxChars: 500 });
		expect(out).toContain("  - [ ] n1.1 · (pending) · Step 1: read");
		expect(out).toContain("Notion task pending (graph g1, status partial)");
		expect(out).toContain("This list is provisional — use the lines printed by kickoff's `track complete` run");
		expect(formatPromptContext({ result, plan, tracking: complete })).not.toContain("provisional");
	});

	test("complete tracking: kickoff only resolves clarifications and must not create rows", () => {
		const out = formatPromptContext({ result, plan, tracking: complete, statePath: "/s/x.json", trackCommand: "/r/bin/ultrathink-mcp track complete" });
		expect(out).toContain("stateFile=/s/x.json only to resolve any blocking clarifications and set the Task to Implementing; it must not create rows");
		expect(out).not.toContain("/r/bin/ultrathink-mcp");
	});

	test("partial or absent tracking: kickoff runs the track command first when known", () => {
		const withCmd = formatPromptContext({ result, plan, tracking: partial, statePath: "/s/x.json", trackCommand: "/r/bin/ultrathink-mcp track complete" });
		expect(withCmd).toContain("stateFile=/s/x.json, which first runs `/r/bin/ultrathink-mcp track complete --state /s/x.json` to finish the missing");
		const without = formatPromptContext({ result, statePath: "/s/x.json" });
		expect(without).toContain("stateFile=/s/x.json, which first finishes the missing");
		expect(without).not.toContain("--state");
		expect(without).not.toContain("## Linked issues");
	});

	test("skill hints: a host that does not list plugin skills gets each skill's load call and an existing SKILL.md path", () => {
		const out = formatPromptContext({ result, statePath: "/s/x.json", trackCommand: "/r/bin/ultrathink-mcp track complete", ship: true, skillHints: true });
		for (const name of ["ultrathink-kickoff", "ultrathink-ship"]) {
			expect(out).toContain(`skill_view name="ultrathink:${name}"`);
			const path = new RegExp(`read (/\\S+/skills/${name}/SKILL\\.md)\\)`).exec(out)?.[1];
			expect(path && existsSync(path)).toBe(true);
		}
		expect(out).toContain("stateFile=/s/x.json, which first runs `/r/bin/ultrathink-mcp track complete --state /s/x.json`");
		expect(out).not.toContain("if your host does not list that skill");
		const plain = formatPromptContext({ result, statePath: "/s/x.json", ship: true });
		expect(plain).not.toContain("skill_view");
		expect(plain).toContain("invoke the ultrathink-kickoff skill with stateFile=/s/x.json");
	});

	test("truncation keeps the ISSUES block and re-appends it before the root close", () => {
		const issues = '<ISSUES graphId="g1" status="complete">\n\t<ISSUE node="n1" identifier="SPE-1">[n1] A</ISSUE>\n</ISSUES>';
		const xml = ["<BUILD_PROMPT>", "<GRAPH_OF_THOUGHT>", "<N>x</N>\n".repeat(500), "</GRAPH_OF_THOUGHT>", issues, "<Z>tail</Z>\n".repeat(500), "</BUILD_PROMPT>"].join("\n");
		const out = truncateXml(xml, 600, "/s/spec.xml");
		expect(out.length).toBeLessThanOrEqual(600);
		expect(out).toContain(issues);
		expect(out).toContain("<!-- truncated by Prompt Uplift. Full specification: /s/spec.xml -->");
		expect(out.endsWith(`${issues}\n</BUILD_PROMPT>`)).toBe(true);
		expect(out.match(/<ISSUES\b/g)).toHaveLength(1);
	});

	test("a raw <ISSUES> in the user's ORIGINAL is not mistaken for the plugin block", () => {
		const xml = ["<BUILD_PROMPT>", "<ORIGINAL>see <ISSUES> in my notes</ORIGINAL>", "<Z>tail</Z>\n".repeat(500), "<SCOPE>s</SCOPE>", "</ISSUES> end", "</BUILD_PROMPT>"].join("\n");
		const out = truncateXml(xml, 600, "/s/spec.xml");
		expect(out.length).toBeLessThanOrEqual(600);
		expect(out).toContain("<ORIGINAL>see <ISSUES> in my notes</ORIGINAL>");
	});

	test("summary reports linked counts or missing rows, else keeps the pending note", () => {
		expect(formatSummary({ result, tracked: true, tracking: complete })).toBe(
			"Prompt Uplift · BUILD_PROMPT · llm · Tracking · 2 issues · 1 sub-issues linked",
		);
		// missing: Linear n2 + n1.1, Notion task + n1 + n2 + n1.1
		expect(formatSummary({ result, tracked: true, tracking: partial, plan })).toBe(
			"Prompt Uplift · BUILD_PROMPT · llm · Tracking · partial (6 missing) · kickoff will finish",
		);
		expect(formatSummary({ result, tracked: true })).toBe("Prompt Uplift · BUILD_PROMPT · llm · Tracking · ultrathink-kickoff pending");
	});

	test("missing rows and linked counts cover only the configured providers", () => {
		// Linear only: n2 + n1.1 missing; Notion rows are never created, so never missing.
		expect(formatSummary({ result, tracking: partial, plan, providers: { linear: true, notion: false } })).toContain("partial (2 missing)");
		// Notion only: task + n1 + n2 + n1.1 missing.
		expect(formatSummary({ result, tracking: partial, plan, providers: { linear: false, notion: true } })).toContain("partial (4 missing)");
		expect(formatSummary({ result, tracking: complete, providers: { linear: false, notion: true } })).toContain("Tracking · 2 issues · 1 sub-issues linked");
		const linearOnly = formatPromptContext({ result, plan, tracking: complete, statePath: "/s/x.json", providers: { linear: true, notion: false } });
		expect(linearOnly).toContain("Tracker rows created before this turn: 2 Linear issues, 1 sub-issues (graph g1, status complete).");
		expect(linearOnly).toContain("already exist in Linear (see Linked issues)");
		const notionOnly = formatPromptContext({ result, plan, tracking: complete, providers: { linear: false, notion: true } });
		expect(notionOnly).toContain("Tracker rows created before this turn: Notion task https://www.notion.so/t (graph g1, status complete).");
	});

	test("tracking off drops kickoff, Linked issues and the provisional list for one short note", () => {
		const out = formatPromptContext({ result, plan, tracking: partial, statePath: "/s/x.json", trackCommand: "/r/bin/ultrathink-mcp track complete", trackingOff: true, ship: true, skill: "gsd-quick" });
		expect(out).not.toContain("## Ultrathink tracking");
		expect(out).not.toContain("ultrathink-kickoff");
		expect(out).not.toContain("## Linked issues");
		expect(out).not.toContain("provisional");
		expect(out).toContain(TRACKING_OFF_NOTE);
		expect(out).toContain("invoke the ultrathink-ship skill with stateFile=/s/x.json");
		expect(formatSummary({ result, tracked: false, trackingOff: true })).toBe("Prompt Uplift · BUILD_PROMPT · llm · Tracking · off");
	});
});

describe("handoff", () => {
	const bigXml = `<BUILD_PROMPT>\n<ORIGINAL>x</ORIGINAL>\n<GRAPH_OF_THOUGHT>\n${"<N>node rationale</N>\n".repeat(3_000)}</GRAPH_OF_THOUGHT>\n</BUILD_PROMPT>`;
	const spec = { result: { ...result, xml: bigXml }, specPath: "/s/spec.xml", statePath: "/s/x.json", trackCommand: "/r/bin/ultrathink-mcp track complete", handoff: true };

	test("points at the spec, state file and Graph ID instead of carrying the XML, and names each skill's load call and SKILL.md", () => {
		const out = formatPromptContext({ ...spec, graph: FALLBACK_GRAPH, plan, ship: true });
		expect(out).toContain("Specification file: /s/spec.xml");
		expect(out).toContain("State file: /s/x.json");
		expect(out).toContain("Graph ID: g1");
		expect(out).toContain("Read that file in full before starting");
		for (const tag of ["<UPLIFTED_PROMPT", "<BUILD_PROMPT", "<GRAPH_OF_THOUGHT", "<ORIGINAL>"]) expect(out).not.toContain(tag);
		for (const name of ["ultrathink-kickoff", "ultrathink-ship"]) {
			expect(out).toContain(`skill_view name="ultrathink:${name}"`);
			const path = new RegExp(`read (/\\S+/skills/${name}/SKILL\\.md)\\)`).exec(out)?.[1];
			expect(path && existsSync(path)).toBe(true);
		}
		expect(out).not.toContain("if your host does not list that skill");
		expect(out).toContain("Workflow waves:");
		expect(out.indexOf("## Ultrathink tracking")).toBeLessThan(out.indexOf("## Ship"));
	});

	test("Graph ID falls back to the tracking refs and is omitted when neither is known", () => {
		expect(formatPromptContext({ ...spec, tracking: { ...complete, graphId: "g9" } })).toContain("Graph ID: g9");
		expect(formatPromptContext({ ...spec, plan, tracking: { ...complete, graphId: "g9" } })).toContain("Graph ID: g1");
		expect(formatPromptContext({ ...spec })).not.toContain("Graph ID:");
	});

	test("a skill invocation keeps the skill framing and still sends the model to the spec file", () => {
		const out = formatPromptContext({ ...spec, skill: "gsd-quick" });
		expect(out).toContain('invoked the "gsd-quick" skill');
		expect(out).toContain("authoritative for HOW");
		expect(out).toContain("Read that file in full before starting");
		expect(out).not.toContain("<BUILD_PROMPT");
	});

	test("an 8-node graph with 4 blocking clarifications stays under 6,000 characters", () => {
		const graph = {
			goal: "g",
			nodes: Array.from({ length: 8 }, (_, i) => ({
				id: `n${i + 1}`,
				title: `Node ${i + 1}`,
				kind: "decompose" as const,
				question: "q".repeat(200),
				dependsOn: i === 0 ? [] : [`n${Math.ceil(i / 2)}`],
				thinking: "t".repeat(2_000),
				conclusion: "c".repeat(1_200),
			})),
		};
		const blocking: Clarification[] = Array.from({ length: 4 }, (_, i) => ({
			...clarifications[0],
			id: `q${i}`,
			question: `Which database should the new service layer use, question ${i}?`,
			why: "Schema, migrations and the deployment topology all depend on it",
			options: [{ label: "Postgres" }, { label: "SQLite" }, { label: "MySQL" }, { label: "DynamoDB" }],
		}));
		const out = formatPromptContext({ ...spec, graph, clarifications: blocking, plan, skill: "gsd-quick", ship: true });
		expect(out).toContain("## Clarifications (HITL)");
		expect(out.length).toBeLessThan(6_000);
	});
});
