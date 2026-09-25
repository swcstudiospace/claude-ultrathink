// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import type { ProgressEvent } from "../host/progress.ts";
import type { ThoughtGraph } from "../think/types.ts";
import { createTracking, stepKey, type CreateTrackingDeps, type ToolCaller } from "./create.ts";
import type { TrackingRefs, TrackPlan } from "./types.ts";

const GRAPH: ThoughtGraph = {
	goal: "Ship it",
	nodes: [
		{ id: "n1", title: "Understand", kind: "understand", question: "q1", dependsOn: [] },
		{ id: "n2", title: "Build", kind: "generate", question: "q2", dependsOn: ["n1"] },
		{ id: "n3", title: "Review", kind: "critique", question: "q3", dependsOn: ["n1", "n2"] },
	],
};

function makePlan(): TrackPlan {
	const graphId = "g-1";
	const nodes = GRAPH.nodes;
	return {
		graphId,
		task: { graphId, item: "Ship it", description: "d", upliftedPrompt: "u", agent: "claude", status: "Todo", linearState: "Todo" },
		issues: nodes.map((node) => ({ graphId, nodeId: node.id, item: `[${node.id}] ${node.title}`, thought: node.question })),
		subIssues: nodes.flatMap((node) =>
			[1, 2].map((step) => ({ graphId, nodeId: node.id, item: `[${node.id}] Step ${step}: s`, step, thought: "t" })),
		),
		linearIssues: nodes.map((node) => ({ nodeId: node.id, title: node.title, description: `desc ${node.id}` })),
		linearSubIssues: nodes.flatMap((node) =>
			[1, 2].map((step) => ({ nodeId: node.id, step, title: `${node.title} — Step ${step}: s`, description: "sd" })),
		),
		hitl: { blocking: [], nonBlocking: [] },
	};
}

interface Call {
	name: string;
	args: Record<string, unknown>;
}

function fakeLinear(
	opts: { throwOn?: (args: Record<string, unknown>) => boolean; listed?: () => unknown[] } = {},
): ToolCaller & { calls: Call[] } {
	const calls: Call[] = [];
	let counter = 0;
	return {
		calls,
		async call(name, args) {
			calls.push({ name, args });
			if (name === "list_issues") return { issues: opts.listed?.() ?? [] };
			if (opts.throwOn?.(args)) throw new Error("HTTP 500");
			counter++;
			const identifier = `SPE-${counter}`;
			return { issue: { id: `uuid-${counter}`, identifier, url: `https://linear.app/org/issue/${identifier}/slug` } };
		},
	};
}

function fakeNotion(opts: { rows?: unknown[] } = {}): ToolCaller & { calls: Call[] } {
	const calls: Call[] = [];
	let counter = 0;
	return {
		calls,
		async call(name, args) {
			calls.push({ name, args });
			if (name === "notion-query-data-sources") return { results: opts.rows ?? [] };
			if (name === "notion-fetch") {
				const props = Object.fromEntries(
					["Item", "Level", "Graph ID", "Parent Item", "Linear URL", "Issue ID", "Step", "Thought"].map((p) => [p, { type: "text" }]),
				);
				return `<data-source>${JSON.stringify({ schema: props })}</data-source>`;
			}
			const pages = args.pages as unknown[];
			const urls = pages.map(() => `https://www.notion.so/page-${++counter}`);
			return { pages: urls.map((url) => ({ url })) };
		},
	};
}

function deps(over: Partial<CreateTrackingDeps>): CreateTrackingDeps {
	return { linearTeam: "Acme Engineering", notionDataSource: "ds-uuid", concurrency: 3, budgetMs: 5000, now: () => 1, ...over };
}

describe("createTracking", () => {
	test("full success creates every row and reports complete", async () => {
		const linear = fakeLinear();
		const notion = fakeNotion();
		const refs = await createTracking(makePlan(), GRAPH, undefined, deps({ linear, notion }));
		expect(refs.status).toBe("complete");
		expect(refs.errors).toEqual([]);
		expect(Object.keys(refs.linear.nodes).sort()).toEqual(["n1", "n2", "n3"]);
		expect(Object.keys(refs.linear.steps)).toHaveLength(6);
		expect(refs.linear.nodes.n1?.title).toBe("[n1] Understand");
		expect(String(linear.calls[0]?.args.description)).toEndWith("ultrathink graph g-1 · node n1");
		const sub = linear.calls.find((call) => call.args.title === "Build — Step 2: s");
		expect(sub?.args.parentId).toBe(refs.linear.nodes.n2?.identifier);
		expect(String(sub?.args.description)).toEndWith("ultrathink graph g-1 · node n2 · step 2");
		expect(refs.notion.taskUrl).toBeDefined();
	});

	test("progress events count up to the plan size", async () => {
		const events: ProgressEvent[] = [];
		await createTracking(makePlan(), GRAPH, undefined, deps({ linear: fakeLinear(), notion: fakeNotion(), progress: (e) => events.push(e) }));
		const track = events.flatMap((e) => (e.type === "track" ? [e] : []));
		expect(track.length).toBeGreaterThan(0);
		for (let i = 1; i < track.length; i++) {
			const [prev, cur] = [track[i - 1], track[i]] as [(typeof track)[number], (typeof track)[number]];
			expect(cur.linear!.nodes[0]).toBeGreaterThanOrEqual(prev.linear!.nodes[0]);
			expect(cur.linear!.steps[0]).toBeGreaterThanOrEqual(prev.linear!.steps[0]);
		}
		const last = track.at(-1);
		expect(last?.linear).toEqual({ nodes: [3, 3], steps: [6, 6] });
		expect(last?.notion).toEqual({ task: true, nodes: [3, 3], steps: [6, 6] });
		expect(track.every((e) => e.error === undefined)).toBe(true);
	});

	test("a failing call emits a track event with the error", async () => {
		const events: ProgressEvent[] = [];
		const linear = fakeLinear({ throwOn: (args) => args.title === "[n2] Build" });
		await createTracking(makePlan(), GRAPH, undefined, deps({ linear, notion: fakeNotion(), progress: (e) => events.push(e) }));
		const errored = events.find((e) => e.type === "track" && e.error?.includes("HTTP 500"));
		expect(errored).toBeDefined();
	});

	test("emits one linear issue event per created node and step with its identifier and url", async () => {
		const events: ProgressEvent[] = [];
		const refs = await createTracking(makePlan(), GRAPH, undefined, deps({ linear: fakeLinear(), notion: fakeNotion(), progress: (e) => events.push(e) }));
		const linear = events.filter((e) => e.type === "issue" && e.provider === "linear");
		expect(linear).toHaveLength(9);
		for (const node of GRAPH.nodes) {
			const ref = refs.linear.nodes[node.id]!;
			expect(linear).toContainEqual({ type: "issue", at: expect.any(Number), provider: "linear", nodeId: node.id, identifier: ref.identifier, url: ref.url });
			for (const step of [1, 2]) {
				const sub = refs.linear.steps[stepKey(node.id, step)]!;
				expect(linear).toContainEqual({ type: "issue", at: expect.any(Number), provider: "linear", nodeId: node.id, step, identifier: sub.identifier, url: sub.url });
			}
		}
		const notion = events.filter((e) => e.type === "issue" && e.provider === "notion");
		expect(notion).toHaveLength(9);
		expect(notion).toContainEqual({ type: "issue", at: expect.any(Number), provider: "notion", nodeId: "n2", step: 1, url: refs.notion.steps[stepKey("n2", 1)] });
		expect(notion.some((e) => e.type === "issue" && e.url === refs.notion.taskUrl)).toBe(false);
	});

	test("adoption emits issue events for adopted Linear rows", async () => {
		const listed = () => [
			{ identifier: "SPE-90", url: "https://linear.app/org/issue/SPE-90/x", title: "t", description: "d\n\nultrathink graph g-1 · node n1" },
			{ identifier: "SPE-91", url: "https://linear.app/org/issue/SPE-91/x", title: "t", description: "d\n\nultrathink graph g-1 · node n1 · step 2" },
		];
		const existing: TrackingRefs = {
			graphId: "g-1",
			status: "failed",
			linearTeam: "Acme Engineering",
			linear: { nodes: {}, steps: {} },
			notion: { nodes: {}, steps: {} },
			errors: [],
			updatedAt: 0,
		};
		const events: ProgressEvent[] = [];
		await createTracking(makePlan(), GRAPH, existing, deps({ linear: fakeLinear({ listed }), notion: fakeNotion(), progress: (e) => events.push(e) }));
		const issues = events.filter((e) => e.type === "issue" && e.provider === "linear");
		expect(issues.slice(0, 2)).toEqual([
			{ type: "issue", at: expect.any(Number), provider: "linear", nodeId: "n1", identifier: "SPE-90", url: "https://linear.app/org/issue/SPE-90/x" },
			{ type: "issue", at: expect.any(Number), provider: "linear", nodeId: "n1", step: 2, identifier: "SPE-91", url: "https://linear.app/org/issue/SPE-91/x" },
		]);
		expect(issues).toHaveLength(9);
	});

	test("a throwing progress sink does not change the refs", async () => {
		const plain = await createTracking(makePlan(), GRAPH, undefined, deps({ linear: fakeLinear(), notion: fakeNotion() }));
		const noisy = await createTracking(
			makePlan(),
			GRAPH,
			undefined,
			deps({
				linear: fakeLinear(),
				notion: fakeNotion(),
				progress: () => {
					throw new Error("sink down");
				},
			}),
		);
		expect(noisy).toEqual(plain);
	});

	test("levels run in dependency order and blockedBy carries dependency identifiers", async () => {
		const linear = fakeLinear();
		const refs = await createTracking(makePlan(), GRAPH, undefined, deps({ linear, notion: fakeNotion() }));
		const nodeCalls = linear.calls.filter((call) => call.args.parentId === undefined);
		expect(nodeCalls.map((call) => call.args.title)).toEqual(["[n1] Understand", "[n2] Build", "[n3] Review"]);
		expect(nodeCalls[0]?.args.blockedBy).toBeUndefined();
		expect(nodeCalls[1]?.args.blockedBy).toEqual([refs.linear.nodes.n1?.identifier]);
		expect(nodeCalls[2]?.args.blockedBy).toEqual([refs.linear.nodes.n1?.identifier, refs.linear.nodes.n2?.identifier]);
	});

	test("existing refs are not recreated", async () => {
		const first = await createTracking(makePlan(), GRAPH, undefined, deps({ linear: fakeLinear(), notion: fakeNotion() }));
		const partial: TrackingRefs = structuredClone(first);
		delete partial.linear.steps[stepKey("n3", 2)];
		delete partial.notion.steps[stepKey("n3", 2)];
		const linear = fakeLinear();
		const notion = fakeNotion();
		const refs = await createTracking(makePlan(), GRAPH, partial, deps({ linear, notion }));
		expect(refs.status).toBe("complete");
		const saves = linear.calls.filter((call) => call.name === "save_issue");
		expect(saves).toHaveLength(1);
		expect(saves[0]?.args.parentId).toBe(first.linear.nodes.n3?.identifier);
		expect(notion.calls.map((call) => call.name)).toEqual(["notion-query-data-sources", "notion-fetch", "notion-create-pages"]);
		expect((notion.calls[2]?.args.pages as unknown[]).length).toBe(1);
		expect(refs.linear.nodes).toEqual(first.linear.nodes);
	});

	test("a failing sub-issue call yields partial with an error naming the key", async () => {
		const linear = fakeLinear({ throwOn: (args) => args.title === "Review — Step 1: s" });
		const refs = await createTracking(makePlan(), GRAPH, undefined, deps({ linear, notion: fakeNotion() }));
		expect(refs.status).toBe("partial");
		expect(refs.linear.steps["n3.1"]).toBeUndefined();
		expect(refs.errors).toContain("linear n3.1: HTTP 500");
	});

	test("missing notion caller is partial with login error while Linear completes", async () => {
		const refs = await createTracking(makePlan(), GRAPH, undefined, deps({ linear: fakeLinear() }));
		expect(refs.status).toBe("partial");
		expect(refs.errors).toContain("notion: login required");
		expect(Object.keys(refs.linear.nodes)).toHaveLength(3);
		expect(Object.keys(refs.linear.steps)).toHaveLength(6);
	});

	test("Linear-only config makes no Notion calls, reports no Notion progress and is complete", async () => {
		const notion = fakeNotion();
		const events: ProgressEvent[] = [];
		const refs = await createTracking(makePlan(), GRAPH, undefined, deps({ linear: fakeLinear(), notion, notionDataSource: undefined, progress: (e) => events.push(e) }));
		expect(notion.calls).toEqual([]);
		expect(refs.status).toBe("complete");
		expect(refs.errors).toEqual([]);
		expect(Object.keys(refs.linear.steps)).toHaveLength(6);
		const track = events.flatMap((e) => (e.type === "track" ? [e] : []));
		expect(track.at(-1)?.linear).toEqual({ nodes: [3, 3], steps: [6, 6] });
		expect(track.some((e) => e.notion !== undefined)).toBe(false);
	});

	test("Notion-only config makes no Linear calls, records no team and is complete", async () => {
		const linear = fakeLinear();
		const existing: TrackingRefs = { graphId: "g-1", status: "failed", linear: { nodes: {}, steps: {} }, notion: { nodes: {}, steps: {} }, errors: [], updatedAt: 0 };
		const refs = await createTracking(makePlan(), GRAPH, existing, deps({ linear, notion: fakeNotion(), linearTeam: undefined }));
		expect(linear.calls).toEqual([]);
		expect(refs.status).toBe("complete");
		expect(refs.errors).toEqual([]);
		expect(refs.linearTeam).toBeUndefined();
		expect(Object.keys(refs.notion.steps)).toHaveLength(6);
	});

	test("budget exhaustion resolves promptly with partial refs", async () => {
		let count = 0;
		const linear: ToolCaller = {
			async call(_name, _args, signal) {
				count++;
				if (count === 1) return { identifier: "SPE-1", url: "https://linear.app/org/issue/SPE-1/x", id: "u1" };
				const { promise, reject } = Promise.withResolvers<unknown>();
				signal?.addEventListener("abort", () => reject(new Error("aborted")));
				return promise;
			},
		};
		const started = performance.now();
		const refs = await createTracking(makePlan(), GRAPH, undefined, deps({ linear, notion: fakeNotion(), budgetMs: 20 }));
		expect(performance.now() - started).toBeLessThan(1000);
		expect(refs.status).toBe("partial");
		expect(refs.linear.nodes.n1?.identifier).toBe("SPE-1");
		expect(refs.errors.some((error) => error.includes("budget exhausted"))).toBe(true);
	});

	test("Notion page URLs map to the right node and step keys with parent relations", async () => {
		const notion = fakeNotion();
		const refs = await createTracking(makePlan(), GRAPH, undefined, deps({ linear: fakeLinear(), notion, concurrency: 1 }));
		expect(refs.notion.taskUrl).toBe("https://www.notion.so/page-1");
		expect(refs.notion.nodes).toEqual({
			n1: "https://www.notion.so/page-2",
			n2: "https://www.notion.so/page-3",
			n3: "https://www.notion.so/page-4",
		});
		expect(refs.notion.steps["n1.1"]).toBe("https://www.notion.so/page-5");
		expect(refs.notion.steps["n3.2"]).toBe("https://www.notion.so/page-10");
		const nodePages = notion.calls[2]?.args.pages as Array<{ properties: Record<string, unknown> }>;
		expect(nodePages[1]?.properties["Parent Item"]).toBe(JSON.stringify(["https://www.notion.so/page-1"]));
		expect(nodePages[1]?.properties["Issue ID"]).toBe(refs.linear.nodes.n2?.identifier);
		expect(nodePages[1]?.properties.Agent).toBeUndefined();
		const stepPages = notion.calls[3]?.args.pages as Array<{ properties: Record<string, unknown> }>;
		expect(stepPages[5]?.properties["Parent Item"]).toBe(JSON.stringify(["https://www.notion.so/page-4"]));
		expect(stepPages[5]?.properties.Step).toBe(2);
	});

	test("re-run adopts a Linear issue created by a lost call instead of saving it again", async () => {
		const plan = makePlan();
		const first = await createTracking(plan, GRAPH, undefined, deps({ linear: fakeLinear(), notion: fakeNotion() }));
		const partial: TrackingRefs = structuredClone(first);
		const lost = partial.linear.steps["n2.1"];
		delete partial.linear.steps["n2.1"];
		const listed = () => [
			{ id: "other", identifier: "SPE-99", url: "https://linear.app/org/issue/SPE-99/x", title: "x", description: "ultrathink graph g-10 · node n2 · step 1" },
			{ id: lost?.id, identifier: lost?.identifier, url: lost?.url, title: "Build — Step 1: s", description: "sd\n\nultrathink graph g-1 · node n2 · step 1" },
		];
		const linear = fakeLinear({ listed });
		const refs = await createTracking(plan, GRAPH, partial, deps({ linear, notion: fakeNotion() }));
		expect(linear.calls.map((call) => call.name)).toEqual(["list_issues"]);
		expect(linear.calls[0]?.args).toEqual({ query: "ultrathink graph g-1", limit: 250 });
		expect(refs.linear.steps["n2.1"]?.identifier).toBe(lost?.identifier);
		expect(refs.status).toBe("complete");
	});

	test("first run skips adoption lookups", async () => {
		const linear = fakeLinear();
		const notion = fakeNotion();
		await createTracking(makePlan(), GRAPH, undefined, deps({ linear, notion }));
		expect(linear.calls.some((call) => call.name === "list_issues")).toBe(false);
		expect(notion.calls.some((call) => call.name === "notion-query-data-sources")).toBe(false);
	});

	test("re-run adopts Notion rows by Level, Item prefix and Step", async () => {
		const plan = makePlan();
		const first = await createTracking(plan, GRAPH, undefined, deps({ linear: fakeLinear(), notion: fakeNotion() }));
		const partial: TrackingRefs = structuredClone(first);
		delete partial.notion.taskUrl;
		partial.notion.nodes = {};
		partial.notion.steps = {};
		const rows = [
			{ url: "https://www.notion.so/t", Level: "Task", Item: "Ship it" },
			...GRAPH.nodes.map((node) => ({ url: `https://www.notion.so/${node.id}`, Level: "Issue", Item: `[${node.id}] ${node.title}` })),
			...GRAPH.nodes.flatMap((node) =>
				[1, 2].map((step) => ({ url: `https://www.notion.so/${node.id}-${step}`, Level: "Sub-Issue", Item: `[${node.id}] Step ${step}: s`, Step: step })),
			),
		];
		const notion = fakeNotion({ rows });
		const refs = await createTracking(plan, GRAPH, partial, deps({ linear: fakeLinear(), notion }));
		expect(notion.calls.map((call) => call.name)).toEqual(["notion-query-data-sources"]);
		const data = (notion.calls[0]?.args.data ?? {}) as Record<string, unknown>;
		expect(data.data_source_urls).toEqual(["collection://ds-uuid"]);
		expect(data.params).toEqual(["g-1"]);
		expect(refs.notion.taskUrl).toBe("https://www.notion.so/t");
		expect(refs.notion.nodes.n2).toBe("https://www.notion.so/n2");
		expect(refs.notion.steps["n3.2"]).toBe("https://www.notion.so/n3-2");
		expect(refs.status).toBe("complete");
	});

	test("create-pages sends allow_async false and maps structured urls in order", async () => {
		const notion = fakeNotion();
		const refs = await createTracking(makePlan(), GRAPH, undefined, deps({ linear: fakeLinear(), notion, concurrency: 1 }));
		const creates = notion.calls.filter((call) => call.name === "notion-create-pages");
		expect(creates.every((call) => call.args.allow_async === false)).toBe(true);
		expect(refs.notion.nodes.n3).toBe("https://www.notion.so/page-4");
	});

	test("structured page urls win over urls mentioned elsewhere in the result", async () => {
		const notion: ToolCaller = {
			async call(name, args) {
				if (name === "notion-fetch") return { schema: { Item: { type: "title" }, Level: { type: "select" } } };
				const pages = args.pages as unknown[];
				return { note: "see https://www.notion.so/unrelated", pages: pages.map((_, index) => ({ url: `https://www.notion.so/p${index}` })) };
			},
		};
		const refs = await createTracking(makePlan(), GRAPH, undefined, deps({ linear: fakeLinear(), notion }));
		expect(refs.notion.taskUrl).toBe("https://www.notion.so/p0");
		expect(refs.notion.nodes.n2).toBe("https://www.notion.so/p1");
	});

	test("a node whose dependency failed is skipped, then created with full blockedBy on re-run", async () => {
		const plan = makePlan();
		const failing = fakeLinear({ throwOn: (args) => args.title === "[n2] Build" });
		const first = await createTracking(plan, GRAPH, undefined, deps({ linear: failing, notion: fakeNotion() }));
		expect(first.errors).toContain("linear n3: dependency missing");
		expect(first.linear.nodes.n3).toBeUndefined();
		expect(failing.calls.some((call) => call.args.title === "[n3] Review")).toBe(false);
		const linear = fakeLinear();
		const refs = await createTracking(plan, GRAPH, first, deps({ linear, notion: fakeNotion() }));
		const n3 = linear.calls.find((call) => call.args.title === "[n3] Review");
		expect(n3?.args.blockedBy).toEqual([first.linear.nodes.n1?.identifier, refs.linear.nodes.n2?.identifier]);
		expect(refs.linear.nodes.n3).toBeDefined();
	});
});
