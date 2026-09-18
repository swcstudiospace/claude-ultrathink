export const MIN_NODES = 3;
export const MAX_NODES = 8;

export type NodeKind =
	| "understand"
	| "decompose"
	| "generate"
	| "compare"
	| "critique"
	| "aggregate"
	| "refine"
	| "synthesize";

export const NODE_KINDS: readonly NodeKind[] = [
	"understand",
	"decompose",
	"generate",
	"compare",
	"critique",
	"aggregate",
	"refine",
	"synthesize",
] as const;

export interface ThoughtNode {
	id: string;
	title: string;
	kind: NodeKind;
	question: string;
	dependsOn: string[];
	thinking?: string;
	conclusion?: string;
}

export interface ThoughtGraph {
	goal: string;
	nodes: ThoughtNode[];
}

export interface ThinkConfig {
	enabled: boolean;
	minNodes: number;
	maxNodes: number;
	engine: "grok" | "claude";
}

export const FALLBACK_GRAPH: ThoughtGraph = {
	goal: "Understand the request, decompose it, weigh approaches, and produce an execution plan",
	nodes: [
		{
			id: "n1",
			title: "Understand",
			kind: "understand",
			question: "What is the user actually asking for, including implicit goals and quality bar?",
			dependsOn: [],
		},
		{
			id: "n2",
			title: "Decompose",
			kind: "decompose",
			question: "What subproblems must be solved, in what order, and what does each depend on?",
			dependsOn: ["n1"],
		},
		{
			id: "n3",
			title: "Approaches",
			kind: "generate",
			question: "What are 2-3 viable approaches and the tradeoffs of each for this specific task?",
			dependsOn: ["n2"],
		},
		{
			id: "n4",
			title: "Risks",
			kind: "critique",
			question: "What could go wrong: missing constraints, edge cases, regressions, or over-scoping?",
			dependsOn: ["n3"],
		},
		{
			id: "n5",
			title: "Plan",
			kind: "synthesize",
			question: "What is the concrete execution plan for the coding agent, in order?",
			dependsOn: ["n4"],
		},
	],
};
