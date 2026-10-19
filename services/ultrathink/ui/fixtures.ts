// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Fixtures for the graph app and its harness: the exact shapes `ultrathink_uplift` (start view) and
 * `ultrathink_result` / `ultrathink_graph` (result view) put in `structuredContent`, wrapped as the MCP
 * `CallToolResult` a host forwards to the View. Fixtures marked `conforming` obey the GraphView caps; the others
 * deliberately exceed them, because the app must survive data the engine would have cut.
 */
import type { NodeKind } from "../../../src/think/types.ts";
import type { GraphView, GraphViewNode } from "../engine/graph-view.ts";
import type { ResultView, StartView } from "../engine/headless.ts";

export interface ToolResult {
	content: { type: "text"; text: string }[];
	structuredContent: ResultView | StartView;
	isError?: boolean;
}

export interface Fixture {
	name: string;
	description: string;
	/** Every field within the GraphView caps (id 40, title 120, question 1000, step 600, 12 steps, conclusion 2000, goal 300). */
	conforming: boolean;
	/** Arguments of the tool call that mounted the view. */
	args: Record<string, unknown>;
	/** The first tool result the host delivers. */
	initial: ToolResult;
	/** Replies to the app's `ultrathink_result` polls, in order; the last one repeats. */
	polls: ToolResult[];
}

const SESSION = "0b8f2c1e-5d3a-4e7b-9a60-3f1d2c4b5a69";
const RUNNING_SESSION = "7c1d9e34-2b6f-4a85-8d10-9e4f3a2b1c07";

interface NodeSpec {
	id: string;
	title: string;
	kind: NodeKind;
	dependsOn?: string[];
	wave: number;
	steps?: number;
	question?: string;
	conclusion?: string;
	fallback?: true;
}

function stepText(id: string, index: number): string {
	return `Step ${index} for ${id}: weigh the options, note the constraint that matters most, and carry the result into the next step.`;
}

function node(spec: NodeSpec): GraphViewNode {
	const count = spec.steps ?? 5;
	const out: GraphViewNode = {
		id: spec.id,
		title: spec.title,
		kind: spec.kind,
		question: spec.question ?? `What does ${spec.id} need to settle before the plan can move on?`,
		dependsOn: spec.dependsOn ?? [],
		wave: spec.wave,
		steps: Array.from({ length: count }, (_, i) => stepText(spec.id, i + 1)),
		conclusion: spec.conclusion ?? `${spec.title}: settled, with the trade-offs written down for the nodes that depend on it.`,
	};
	if (spec.fallback) out.fallback = true;
	return out;
}

function view(goal: string, nodes: GraphViewNode[], fills: string[] = []): GraphView {
	const waveNumbers = [...new Set(nodes.map((n) => n.wave))].sort((a, b) => a - b);
	const waves = waveNumbers.map((wave) => {
		const ids = nodes.filter((n) => n.wave === wave).map((n) => n.id);
		return { wave, parallel: ids.length > 1, ids };
	});
	return {
		version: 1,
		goal,
		nodes,
		waves,
		counts: {
			nodes: nodes.length,
			edges: nodes.reduce((sum, n) => sum + n.dependsOn.length, 0),
			waves: waves.length,
			steps: nodes.reduce((sum, n) => sum + n.steps.length, 0),
		},
		degraded: { fills },
	};
}

function planned(graph: GraphView, extra: Partial<ResultView> = {}, sessionId = SESSION): ToolResult {
	const text = `# Plan\n\nGoal: ${graph.goal}\n\n${graph.nodes.length} nodes in ${graph.waves.length} waves.`;
	return {
		content: [{ type: "text", text }],
		structuredContent: { sessionId, status: "planned", mode: "server", text, graph, ...extra },
	};
}

function statusOnly(status: "failed" | "invalid" | "skipped", text: string, error: string): ToolResult {
	return {
		content: [{ type: "text", text }],
		structuredContent: { sessionId: SESSION, status, mode: "server", text, error },
	};
}

function running(): ToolResult {
	return {
		content: [{ type: "text", text: "Planning started. Call ultrathink_result with this sessionId to collect the plan." }],
		structuredContent: { sessionId: RUNNING_SESSION, status: "running", pollAfterSec: 1 },
	};
}

function runningView(): ToolResult {
	const text = "Still planning. Call ultrathink_result again.";
	return {
		content: [{ type: "text", text }],
		structuredContent: { sessionId: RUNNING_SESSION, status: "running", mode: "server", text },
	};
}

const DIAMOND_GOAL = "Design a CSV to JSON converter that streams large files in bounded memory";

const DIAMOND = view(DIAMOND_GOAL, [
	node({ id: "n1", title: "Understand the request", kind: "understand", wave: 1, steps: 4 }),
	node({ id: "n2", title: "Decompose the pipeline", kind: "decompose", dependsOn: ["n1"], wave: 2, steps: 5 }),
	node({ id: "n3", title: "Generate parser options", kind: "generate", dependsOn: ["n1"], wave: 2, steps: 6 }),
	node({ id: "n4", title: "Critique memory limits", kind: "critique", dependsOn: ["n1"], wave: 2, steps: 5 }),
	node({ id: "n5", title: "Compare writer designs", kind: "compare", dependsOn: ["n1"], wave: 2, steps: 4 }),
	node({
		id: "n6",
		title: "Synthesize the plan",
		kind: "synthesize",
		dependsOn: ["n2", "n3", "n4", "n5"],
		wave: 3,
		steps: 7,
		conclusion: "Stream rows through a bounded queue, parse with the chosen options, flush the writer per chunk.\n\nKeep the memory ceiling in the acceptance criteria and test it with a one gigabyte file.",
	}),
]);

const EIGHT = view("Migrate the billing service to the new payment provider without downtime", [
	node({ id: "n1", title: "Understand current billing flows", kind: "understand", wave: 1 }),
	node({ id: "n2", title: "Understand the new provider API", kind: "understand", wave: 1 }),
	node({ id: "n3", title: "Decompose the cutover", kind: "decompose", dependsOn: ["n1"], wave: 2 }),
	node({ id: "n4", title: "Compare dual-write strategies", kind: "compare", dependsOn: ["n1", "n2"], wave: 2 }),
	node({ id: "n5", title: "Generate the webhook mapping", kind: "generate", dependsOn: ["n2"], wave: 2 }),
	node({ id: "n6", title: "Critique rollback paths", kind: "critique", dependsOn: ["n3", "n4"], wave: 3 }),
	node({ id: "n7", title: "Refine the test plan", kind: "refine", dependsOn: ["n4", "n5"], wave: 3 }),
	node({ id: "n8", title: "Synthesize the migration plan", kind: "synthesize", dependsOn: ["n6", "n7"], wave: 4 }),
]);

// Unbroken strings at the caps: the layout must clamp them, not grow around them.
const LONG_ID = "i".repeat(40);
const LONG_TITLE = "T".repeat(120);
const SPACED_TITLE = "A very long title that keeps going and going so that the two line clamp on the card has to cut it off somewhere sensible ok";

const LONG = view("G".repeat(300), [
	node({ id: LONG_ID, title: LONG_TITLE, kind: "understand", wave: 1, question: "Q".repeat(1000), steps: 12, conclusion: "C".repeat(2000) }),
	node({ id: "n2", title: SPACED_TITLE.slice(0, 120), kind: "decompose", dependsOn: [LONG_ID], wave: 2 }),
	node({ id: "n3", title: LONG_TITLE, kind: "generate", dependsOn: [LONG_ID], wave: 2 }),
	node({ id: "n4", title: SPACED_TITLE.slice(0, 120), kind: "critique", dependsOn: ["n2", "n3"], wave: 3 }),
	node({ id: "n5", title: "Synthesize", kind: "synthesize", dependsOn: ["n4"], wave: 4 }),
]);
for (const n of LONG.nodes) n.steps = n.steps.map((s, i) => (n.id === LONG_ID && i === 0 ? "S".repeat(600) : s.slice(0, 600)));

// Beyond the caps: what a hostile or buggy producer could send.
const OVERSIZE = view("Z".repeat(2000), [
	node({ id: "n1", title: `${"Six hundred characters of title text. ".repeat(17)}`.slice(0, 600), kind: "understand", wave: 1 }),
	node({ id: "n2", title: "w".repeat(5000), kind: "decompose", dependsOn: ["n1"], wave: 2, question: "q ".repeat(3000), conclusion: "c ".repeat(6000) }),
	node({ id: "n3", title: `${"Another long title. ".repeat(30)}`, kind: "synthesize", dependsOn: ["n2"], wave: 3 }),
]);

// Everything a script injection or a markup break would try; all of it must show up as plain text.
const HOSTILE_TEXT = "<img src=x onerror=alert(1)>";
const HOSTILE = view("</script><script>alert(1)</script> \"quoted\" `tick` 'single'", [
	{
		id: "n1",
		title: HOSTILE_TEXT,
		kind: "understand",
		question: `${HOSTILE_TEXT} </script> "q" 'q' \`q\``,
		dependsOn: [],
		wave: 1,
		steps: [HOSTILE_TEXT, "</script><script>alert(2)</script>", '"double" and \'single\' and `backtick`', "&lt;b&gt;entities&lt;/b&gt; &amp; <b>bold</b>", "javascript:alert(3)"],
		conclusion: `${HOSTILE_TEXT}\n</script>\n\`\`\`\n"quotes"`,
	},
	node({ id: "n2", title: '"><svg onload=alert(1)>', kind: "decompose", dependsOn: ["n1"], wave: 2 }),
	node({ id: "n3", title: "`${alert(1)}` {{7*7}}", kind: "generate", dependsOn: ["n1"], wave: 2 }),
	node({ id: "n4", title: "</style><style>*{display:none}</style>", kind: "critique", dependsOn: ["n2", "n3"], wave: 3 }),
	node({ id: "n5", title: "<script>alert(5)</script>", kind: "synthesize", dependsOn: ["n4"], wave: 4 }),
]);

const DEGRADED = view(
	DIAMOND_GOAL,
	DIAMOND.nodes.map((n) => (n.id === "n3" || n.id === "n5" ? { ...n, fallback: true as const } : n)),
	["n3", "n5"],
);

const QUESTIONS = [
	{ question: "Which input encoding do the CSV files use?", default: "UTF-8", blocking: true },
	{ question: "Should malformed rows abort the run or be skipped and reported?", default: "Skip and report", blocking: false },
	{ question: "Is there a memory ceiling for the converter?" },
];

const FALLBACK_TEXT = "Planning failed (engine_error). Tell the user, and offer to try again with a new sessionId.";

function build(): Record<string, Fixture> {
	const list: Fixture[] = [
		{
			name: "diamond",
			description: "Six nodes, three waves, the middle wave parallel (acceptance 1)",
			conforming: true,
			args: { prompt: "Design a CSV to JSON converter" },
			initial: planned(DIAMOND),
			polls: [],
		},
		{
			name: "eight",
			description: "Eight nodes in four waves (acceptance 2)",
			conforming: true,
			args: { prompt: "Migrate billing" },
			initial: planned(EIGHT),
			polls: [],
		},
		{
			name: "longtitles",
			description: "Ids, titles, questions, steps and conclusions at the caps, unbroken strings (acceptance 2)",
			conforming: true,
			args: {},
			initial: planned(LONG),
			polls: [],
		},
		{
			name: "oversize",
			description: "600 and 5000 character titles, past every cap (acceptance 2)",
			conforming: false,
			args: {},
			initial: planned(OVERSIZE),
			polls: [],
		},
		{
			name: "hostile",
			description: "Markup, script and template injection strings in every text field (acceptance 7)",
			conforming: true,
			args: {},
			initial: planned(HOSTILE),
			polls: [],
		},
		{
			name: "degraded",
			description: "Two placeholder (fallback) nodes and the degraded notice",
			conforming: true,
			args: {},
			initial: planned(DEGRADED),
			polls: [],
		},
		{
			name: "questions",
			description: "Diamond plus clarifying questions and the Use all defaults button",
			conforming: true,
			args: {},
			initial: planned(DIAMOND, { questions: QUESTIONS }),
			polls: [],
		},
		{
			name: "running",
			description: "Start view, two running polls, then the diamond plan (acceptance 3)",
			conforming: true,
			args: { prompt: "Design a CSV to JSON converter" },
			initial: running(),
			polls: [runningView(), runningView(), planned(DIAMOND, {}, RUNNING_SESSION)],
		},
		{
			name: "failed",
			description: "A failed job: status chip and one line (acceptance 4)",
			conforming: true,
			args: {},
			initial: statusOnly("failed", FALLBACK_TEXT, "engine_error"),
			polls: [],
		},
		{
			name: "invalid",
			description: "An invalid session",
			conforming: true,
			args: {},
			initial: statusOnly("invalid", "The stored session is invalid (invalid_session).", "invalid_session"),
			polls: [],
		},
		{
			name: "skipped",
			description: "A skipped job",
			conforming: true,
			args: {},
			initial: statusOnly("skipped", "Planning was skipped (skipped). Rephrase the request as a plain description of the task.", "skipped"),
			polls: [],
		},
		{
			name: "nograph",
			description: "Planned result without a graph: text fallback and the no-graph note",
			conforming: true,
			args: {},
			initial: {
				content: [{ type: "text", text: `# Plan\n\n${"Step by step plan text without any structured graph. ".repeat(20)}` }],
				structuredContent: {
					sessionId: SESSION,
					status: "planned",
					mode: "client",
					text: `# Plan\n\n${"Step by step plan text without any structured graph. ".repeat(20)}`,
				},
			},
			polls: [],
		},
	];
	return Object.fromEntries(list.map((f) => [f.name, f]));
}

export const FIXTURES: Record<string, Fixture> = build();
export const FIXTURE_NAMES: string[] = Object.keys(FIXTURES);
