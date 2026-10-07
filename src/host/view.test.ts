// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import type { SessionRecord } from "../claude/state.ts";
import type { ModelResolution } from "./engine.ts";
import type { ProgressEvent } from "./progress.ts";
import { planPrompt } from "./plan.ts";
import { buildPlanView, projectResolution } from "./view.ts";

const ref = (identifier: string) => ({ id: identifier, identifier, url: `https://linear.app/x/${identifier}`, title: identifier });

function record(): SessionRecord {
	return {
		sessionId: "s1",
		at: 1,
		engine: "claude:sonnet",
		result: { xml: "<x/>", original: "add", root: "BUILD_PROMPT", source: "llm" },
		graph: {
			goal: "Ship it",
			nodes: [
				{ id: "n1", title: "Understand", kind: "understand", question: "q", dependsOn: [], conclusion: "c1" },
				{ id: "n2", title: "Left", kind: "generate", question: "q", dependsOn: ["n1"] },
				{ id: "n3", title: "Right", kind: "generate", question: "q", dependsOn: ["n1"] },
				{ id: "n4", title: "Plan", kind: "synthesize", question: "q", dependsOn: ["n2", "n3"] },
			],
		},
		clarifications: [
			{
				id: "q1",
				question: "Which db?",
				header: "DB",
				why: "w",
				options: [{ label: "Postgres" }, { label: "SQLite" }],
				default: "SQLite",
				blocking: true,
			},
		],
		plan: {
			graphId: "g1",
			task: { graphId: "g1", item: "t", description: "", upliftedPrompt: "", agent: "omp", status: "", linearState: "" },
			issues: [],
			subIssues: [
				{ graphId: "g1", nodeId: "n1", item: "[n1] Read the code", step: 1, thought: "" },
				{ graphId: "g1", nodeId: "n1", item: "[n1] Write the test", step: 2, thought: "" },
			],
			linearIssues: [],
			linearSubIssues: [],
			hitl: { blocking: [], nonBlocking: [] },
		},
		tracking: {
			graphId: "g1",
			status: "partial",
			linear: { nodes: { n1: ref("ENG-1"), n2: ref("ENG-2") }, steps: { "n1.1": ref("ENG-9") } },
			notion: { taskUrl: "https://notion.so/t", nodes: { n1: "https://notion.so/n1" }, steps: {} },
			errors: ["notion: login required"],
			updatedAt: 1,
		},
	};
}

describe("buildPlanView", () => {
	test("groups waves and attaches issue, notion and step refs per node", () => {
		const view = buildPlanView(record(), 4200);
		expect(view.waves).toEqual([["n1"], ["n2", "n3"], ["n4"]]);
		expect(view.nodes.map((n) => [n.id, n.wave])).toEqual([
			["n1", 0],
			["n2", 1],
			["n3", 1],
			["n4", 2],
		]);
		const [n1, n2, n3] = view.nodes;
		expect(n1?.issue).toEqual({ identifier: "ENG-1", url: "https://linear.app/x/ENG-1" });
		expect(n1?.notionUrl).toBe("https://notion.so/n1");
		expect(n1?.steps).toEqual([
			{ step: 1, title: "Read the code", identifier: "ENG-9", url: "https://linear.app/x/ENG-9" },
			{ step: 2, title: "Write the test" },
		]);
		expect(n2?.issue?.identifier).toBe("ENG-2");
		expect(n3?.issue).toBeUndefined();
		expect(view.clarifications).toEqual([{ id: "q1", question: "Which db?", blocking: true, recommended: "SQLite" }]);
		expect(view.tracking).toEqual({
			status: "partial",
			notionTaskUrl: "https://notion.so/t",
			errors: ["notion: login required"],
			issues: 2,
			subIssues: 1,
		});
		expect(view).toMatchObject({ root: "BUILD_PROMPT", source: "llm", graphId: "g1", goal: "Ship it", elapsedMs: 4200 });
	});

	test("an untracked record without a graph has no nodes and no tracking", () => {
		const { graph: _g, tracking: _t, plan: _p, ...rest } = record();
		const view = buildPlanView(rest, 0);
		expect(view.nodes).toEqual([]);
		expect(view.waves).toEqual([]);
		expect(view.tracking).toBeUndefined();
	});

	test("projects each node's dependencies in graph order and the invoked skill", () => {
		const view = buildPlanView({ ...record(), skill: { name: "gsd-quick", source: "omp" } }, 0);
		expect(view.nodes.map((n) => n.dependsOn)).toEqual([[], ["n1"], ["n1"], ["n2", "n3"]]);
		expect(view.skill).toBe("gsd-quick");
		expect(buildPlanView(record(), 0)).not.toHaveProperty("skill");
	});
});

describe("buildPlanView model resolution (§9 path 3)", () => {
	const detected: ModelResolution = {
		version: "1.0.0",
		state: "detected",
		host: "omp",
		transport: "omp-native",
		source: "ctx.model",
		reason: "live-model",
		engineSelection: { engine: "auto", source: "config", nativeOptOut: false },
		api: "anthropic-messages",
		provider: "anthropic",
		modelId: "claude-x",
		modelKnown: true,
		label: "omp-native:anthropic/claude-x [detected]",
	};

	test("projects the record's safe resolution, shows its label as the engine and leaves graph and XML as recorded", () => {
		const base = record();
		const planned = { ...base, modelResolution: detected };
		const before = structuredClone(planned);
		const view = buildPlanView(planned, 4200);
		expect(view.modelResolution).toEqual(detected);
		expect(view.modelResolution).not.toBe(detected);
		expect(view.engine).toBe("omp-native:anthropic/claude-x [detected]");
		const { engine: _engine, modelResolution: _resolution, ...rest } = view;
		const { engine: _legacy, ...plain } = buildPlanView(base, 4200);
		expect(rest).toEqual(plain);
		expect(planned).toEqual(before);
	});

	test("a record without a resolution keeps its recorded engine label and carries none", () => {
		const view = buildPlanView(record(), 0);
		expect(view.engine).toBe("claude:sonnet");
		expect(view).not.toHaveProperty("modelResolution");
	});

	test("engine request stays apart from model state: a named engine with CLI omission says model unobserved and default", () => {
		const cliDefault: ModelResolution = {
			version: "1.0.0",
			state: "default",
			host: "omp",
			transport: "claude-cli",
			source: "cli-default",
			reason: "cli-delegation",
			engineSelection: { engine: "claude", source: "control", nativeOptOut: true },
			modelKnown: false,
			label: "claude:CLI default (model unobserved)",
		};
		const view = buildPlanView({ ...record(), modelResolution: cliDefault }, 0);
		expect(view.modelResolution).toEqual(cliDefault);
		expect(view.engine).toBe("claude:CLI default (model unobserved)");
		// The parser's unsupported-host diagnostic has no transport, provider or model and keeps its reason.
		const unsupported: ModelResolution = {
			version: "1.0.0",
			state: "unresolved",
			host: "unknown",
			source: "none",
			reason: "unsupported-host",
			engineSelection: { engine: "auto", source: "config", nativeOptOut: false },
			modelKnown: false,
			label: "unknown:unresolved [unsupported-host]",
		};
		expect(projectResolution(unsupported)).toEqual(unsupported);
	});

	test("the projection is allowlisted and display-safe: extra fields drop, unsafe ids and labels become opaque", () => {
		// Built in pieces so no scanner reads a credential-like literal out of this fixture.
		const sentinel = ["sentinel", "credential", "value"].join("-");
		const raw = {
			...detected,
			provider: "https://gateway.example",
			modelId: `user:${sentinel}@gateway`,
			providerType: "<script>",
			label: `omp-native:x [detected]\nBearer ${sentinel}`,
			engineSelection: { ...detected.engineSelection, credential: sentinel },
			baseUrl: "https://gateway.example/v1",
			headers: { authorization: sentinel },
			apiKey: sentinel,
			model: { id: "x", apiKey: sentinel },
		};
		expect(projectResolution(raw)).toEqual({
			version: "1.0.0",
			state: "detected",
			host: "omp",
			transport: "omp-native",
			source: "ctx.model",
			reason: "live-model",
			engineSelection: { engine: "auto", source: "config", nativeOptOut: false },
			api: "anthropic-messages",
			providerType: "<opaque-provider>",
			provider: "<opaque-provider>",
			modelId: "<opaque-model>",
			modelKnown: true,
			label: "<opaque-model>",
		});
		const view = JSON.stringify(buildPlanView({ ...record(), modelResolution: raw as unknown as ModelResolution }, 0));
		expect(view).not.toContain(sentinel);
		expect(view).not.toContain("gateway.example");
		for (const label of ["claude:x [override]\u001b[31m", "claude:</ORIGINAL> [override]", "claude:token=abc [override]", `claude:${"a".repeat(600)}`]) {
			expect(projectResolution({ ...detected, label })?.label).toBe("<opaque-model>");
		}
	});

	test("anything that is not a version 1.0.0 record projects to nothing, and the view falls back to the engine label", () => {
		for (const value of [
			undefined,
			null,
			"omp-native:x",
			42,
			[],
			{},
			{ ...detected, version: "2.0.0" },
			{ ...detected, engineSelection: null },
			{ ...detected, state: "Detected!" },
			{ ...detected, modelKnown: "yes" },
		]) {
			expect(projectResolution(value)).toBeUndefined();
		}
		const view = buildPlanView({ ...record(), modelResolution: null as unknown as ModelResolution }, 0);
		expect(view.engine).toBe("claude:sonnet");
		expect(view).not.toHaveProperty("modelResolution");
	});
});

describe("planPrompt progress", () => {
	test("an early skip emits end skipped with the reason", async () => {
		const events: ProgressEvent[] = [];
		const response = await planPrompt({ prompt: "build it" }, { ULTRATHINK_UPLIFT: "0" }, { progress: (e) => events.push(e) });
		expect(response).toEqual({ context: "", skipped: "child-or-disabled" });
		expect(events).toHaveLength(1);
		expect(events[0]).toMatchObject({ type: "end", outcome: "skipped", detail: "child-or-disabled" });
	});

	test("ultrathink's own skills and non-skill slash commands skip before any engine", async () => {
		for (const [prompt, reason] of [
			["/ultrathink-kickoff x", "ultrathink-skill"],
			["/model sonnet", "slash-command"],
		] as const) {
			const events: ProgressEvent[] = [];
			const response = await planPrompt({ prompt, cwd: "/nonexistent-ultrathink-cwd" }, {}, { progress: (e) => events.push(e) });
			expect(response).toEqual({ context: "", skipped: reason });
			expect(events).toEqual([expect.objectContaining({ type: "end", outcome: "skipped", detail: reason })]);
		}
	});
});
