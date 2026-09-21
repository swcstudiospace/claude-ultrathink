import { describe, expect, test } from "bun:test";
import type { Clarification } from "../hitl/types.ts";
import { FALLBACK_GRAPH } from "../think/types.ts";
import { formatPromptContext, formatSummary, truncateXml, UPLIFT_CONTEXT_HEADER } from "./output.ts";

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
