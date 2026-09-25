// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import { formatTrackingTodos, injectTrackingXml } from "./render.ts";
import type { TrackingRefs, TrackPlan } from "./types.ts";

const plan: TrackPlan = {
	graphId: "g1",
	task: {
		graphId: "g1",
		item: "Task",
		description: "d",
		upliftedPrompt: "p",
		agent: "claude",
		status: "Planned",
		linearState: "Todo",
	},
	issues: [
		{ graphId: "g1", nodeId: "n1", item: "[n1] Understand <A & B>", thought: "t" },
		{ graphId: "g1", nodeId: "n2", item: "[n2] Build", thought: "t" },
	],
	subIssues: [
		{ graphId: "g1", nodeId: "n1", item: "[n1] Step 2: second", step: 2, thought: "t" },
		{ graphId: "g1", nodeId: "n1", item: "[n1] Step 1: first", step: 1, thought: "t" },
		{ graphId: "g1", nodeId: "n2", item: "[n2] Step 1: only", step: 1, thought: "t" },
	],
	linearIssues: [],
	linearSubIssues: [],
	hitl: { blocking: [], nonBlocking: [] },
};

const tracking: TrackingRefs = {
	graphId: "g1",
	status: "partial",
	linear: {
		nodes: { n1: { id: "i1", identifier: "SPE-12", url: 'https://linear.app/o/issue/SPE-12/a?x=1&y="2"', title: "Understand" } },
		steps: { "n1.1": { id: "i2", identifier: "SPE-13", url: "https://linear.app/o/issue/SPE-13", title: "Step 1" } },
	},
	notion: { taskUrl: "https://www.notion.so/task", nodes: { n1: "https://www.notion.so/n1" }, steps: {} },
	errors: [],
	updatedAt: 1,
};

const graphXml = [
	"<BUILD_PROMPT>",
	"<GRAPH_OF_THOUGHT>",
	'\t<NODE id="n1" kind="decompose" title="Understand">',
	"\t</NODE>",
	'\t<NODE id="n2" kind="synthesize" title="Build">',
	"\t</NODE>",
	"</GRAPH_OF_THOUGHT>",
	"<CLARIFICATIONS/>",
	"</BUILD_PROMPT>",
].join("\n");

describe("injectTrackingXml", () => {
	test("links only NODE tags that have refs and escapes attribute values", () => {
		const out = injectTrackingXml(graphXml, plan, tracking);
		expect(out).toContain(
			'<NODE id="n1" kind="decompose" title="Understand" issue="SPE-12" issueUrl="https://linear.app/o/issue/SPE-12/a?x=1&amp;y=&quot;2&quot;" notionUrl="https://www.notion.so/n1">',
		);
		expect(out).toContain('<NODE id="n2" kind="synthesize" title="Build">');
	});

	test("places one ISSUES block after the graph with pending rows and escaped text", () => {
		const out = injectTrackingXml(graphXml, plan, tracking);
		expect(out).toContain('</GRAPH_OF_THOUGHT>\n<ISSUES graphId="g1" status="partial" notionTaskUrl="https://www.notion.so/task">');
		expect(out).toContain('<ISSUE node="n1" identifier="SPE-12"');
		expect(out).toContain(">[n1] Understand &lt;A &amp; B&gt;");
		expect(out).toContain('<SUBISSUE step="1" identifier="SPE-13" url="https://linear.app/o/issue/SPE-13">Step 1: first</SUBISSUE>');
		expect(out).toContain('<SUBISSUE step="2" status="pending">Step 2: second</SUBISSUE>');
		expect(out).toContain('<ISSUE node="n2" status="pending">[n2] Build');
		expect(out.indexOf("Step 1: first")).toBeLessThan(out.indexOf("Step 2: second"));
		expect(out.indexOf("</ISSUES>")).toBeLessThan(out.indexOf("<CLARIFICATIONS/>"));
	});

	test("re-injection replaces attributes and the block instead of duplicating them", () => {
		const once = injectTrackingXml(graphXml, plan, tracking);
		const updated: TrackingRefs = {
			...tracking,
			status: "complete",
			linear: {
				...tracking.linear,
				nodes: { ...tracking.linear.nodes, n2: { id: "i3", identifier: "SPE-14", url: "https://linear.app/o/issue/SPE-14", title: "Build" } },
			},
		};
		const twice = injectTrackingXml(once, plan, updated);
		expect(twice.match(/<ISSUES\b/g)).toHaveLength(1);
		expect(twice.match(/issue="SPE-12"/g)).toHaveLength(1);
		expect(twice).toContain('<NODE id="n2" kind="synthesize" title="Build" issue="SPE-14"');
		expect(twice).toContain('status="complete"');
		expect(injectTrackingXml(twice, plan, updated)).toBe(twice);
	});

	test("without a graph the block goes right before the root closing tag", () => {
		const out = injectTrackingXml("<BUILD_PROMPT>\n<ORIGINAL>x</ORIGINAL>\n</BUILD_PROMPT>", plan, tracking);
		expect(out.startsWith("<BUILD_PROMPT>\n<ORIGINAL>x</ORIGINAL>\n<ISSUES ")).toBe(true);
		expect(out.endsWith("</ISSUES>\n</BUILD_PROMPT>")).toBe(true);
	});

	test("user text in ORIGINAL with raw ISSUES, NODE and graph-close survives double injection", () => {
		const original = '<ORIGINAL>my <ISSUES> list, <NODE id="n1"> and </GRAPH_OF_THOUGHT> done</ORIGINAL>';
		const xml = graphXml.replace("<BUILD_PROMPT>", `<BUILD_PROMPT>\n${original}\n<SCOPE>s</SCOPE>`);
		const out = injectTrackingXml(injectTrackingXml(xml, plan, tracking), plan, tracking);
		expect(out).toContain(original);
		expect(out).toContain("<SCOPE>s</SCOPE>");
		expect(out).toContain('<NODE id="n2" kind="synthesize" title="Build">');
		expect(out).toContain('title="Understand" issue="SPE-12"');
		expect(out.match(/<ISSUES graphId=/g)).toHaveLength(1);
		expect(out.indexOf('<ISSUES graphId="g1"')).toBe(out.lastIndexOf("</GRAPH_OF_THOUGHT>") + "</GRAPH_OF_THOUGHT>\n".length);
	});
});

describe("formatTrackingTodos", () => {
	test("one line per node then indented steps, linked or pending", () => {
		expect(formatTrackingTodos(plan, tracking)).toBe(
			[
				'- [ ] n1 · [SPE-12](https://linear.app/o/issue/SPE-12/a?x=1&y="2") · Understand <A & B> · notion: https://www.notion.so/n1',
				"  - [ ] n1.1 · [SPE-13](https://linear.app/o/issue/SPE-13) · Step 1: first",
				"  - [ ] n1.2 · (pending) · Step 2: second",
				"- [ ] n2 · (pending) · Build",
				"  - [ ] n2.1 · (pending) · Step 1: only",
			].join("\n"),
		);
	});
});
