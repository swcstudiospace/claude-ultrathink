// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type SessionRecord, writeSession } from "../../../src/claude/state.ts";
import { journalDir, writeMeta } from "../../../src/host/grokbot.ts";
import type { ThoughtGraph } from "../../../src/think/types.ts";
import { buildGraphView } from "../engine/graph-view.ts";
import type { HeadlessPlanner, ResultView } from "../engine/headless.ts";
import type { JournalOptions } from "../engine/journal.ts";
import type { ToolOutcome } from "./mcp.ts";
import { createResourceRegistry } from "./resources.ts";
import { type ToolHostDeps, createToolHost, toOutcome } from "./tool-host.ts";
import { catalogFromOverlay } from "./tools-connector.ts";

const dirs: string[] = [];
const tmp = (): string => {
	const dir = mkdtempSync(join(tmpdir(), "ut-tool-host-"));
	dirs.push(dir);
	return dir;
};
afterAll(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const GRAPH: ThoughtGraph = {
	goal: "Ship it",
	nodes: [
		{ id: "n1", title: "Understand", kind: "understand", question: "What?", dependsOn: [], thinking: "1. Read.", conclusion: "Done." },
		{ id: "n2", title: "Plan", kind: "synthesize", question: "How?", dependsOn: ["n1"], thinking: "1. Order.", conclusion: "Ordered." },
	],
};

const PLAN_TEXT = "# Ultrathink plan\n\nRequest: ship it";

function journalOptions(stateDir: string): JournalOptions {
	return { stateDir, maxPromptChars: 8000, maxAnswerChars: 20000 };
}

function record(sessionId: string): SessionRecord {
	return { sessionId, at: 1, result: { xml: "<BUILD_PROMPT/>", original: "Ship it", root: "BUILD_PROMPT", source: "llm" }, graph: GRAPH };
}

function serverView(sessionId: string, overrides: Partial<ResultView> = {}): ResultView {
	return {
		sessionId,
		status: "planned",
		mode: "server",
		text: PLAN_TEXT,
		questions: [{ question: "Which database?", default: "Postgres" }],
		graph: buildGraphView(record(sessionId)) ?? undefined,
		usage: { calls: 3, inputTokens: 10, outputTokens: 5 },
		...overrides,
	};
}

interface StubPlanner extends HeadlessPlanner {
	starts: unknown[];
	results: unknown[];
	serverIds: Set<string>;
}

function stubPlanner(enabled: boolean, view: (sessionId: string) => ResultView = serverView): StubPlanner {
	const stub: StubPlanner = {
		enabled,
		starts: [],
		results: [],
		serverIds: new Set(),
		async start(input) {
			stub.starts.push(input);
			return { ok: true, data: { sessionId: String(input.sessionId), status: "planned" } };
		},
		async result(input) {
			stub.results.push(input);
			return { ok: true, data: view(String(input.sessionId)) };
		},
		status(input) {
			const sessionId = String(input.sessionId);
			if (!stub.serverIds.has(sessionId)) return null;
			return { ok: true, data: { sessionId, status: "running", pendingCount: 0, pending: [] } };
		},
		async shutdown() {},
	};
	return stub;
}

function setup(options: Partial<ToolHostDeps> = {}) {
	const stateDir = tmp();
	const finished: ResultView[] = [];
	const host = createToolHost({
		journalOpts: journalOptions(stateDir),
		catalog: catalogFromOverlay(),
		onPlanFinished: (view) => finished.push(view),
		...options,
	});
	return { stateDir, host, finished };
}

function okOf(outcome: ToolOutcome): { data: Record<string, unknown>; text?: string } {
	if (!outcome.ok) throw new Error(`expected ok, got ${outcome.code}`);
	return outcome.text === undefined ? { data: outcome.data } : { data: outcome.data, text: outcome.text };
}

describe("capabilities", () => {
	test("serverPlanning follows the planner and is false without one", () => {
		expect(setup().host.capabilities()).toEqual({ serverPlanning: false });
		expect(setup({ planner: stubPlanner(false) }).host.capabilities()).toEqual({ serverPlanning: false });
		expect(setup({ planner: stubPlanner(true) }).host.capabilities()).toEqual({ serverPlanning: true });
	});

	test("resources are exposed only when a registry is given", () => {
		expect(setup().host.resources).toBeUndefined();
		const registry = createResourceRegistry([]);
		expect(setup({ resources: registry }).host.resources).toBe(registry);
	});
});

describe("toOutcome", () => {
	test("maps a journal result to a tool outcome and keeps errors only when present", () => {
		expect(toOutcome({ ok: true, data: { a: 1 } })).toEqual({ ok: true, data: { a: 1 } });
		expect(toOutcome({ ok: false, code: "not_found" })).toEqual({ ok: false, code: "not_found" });
		expect(toOutcome({ ok: false, code: "invalid_answer", errors: ["x"] })).toEqual({ ok: false, code: "invalid_answer", errors: ["x"] });
	});
});

describe("the original tools", () => {
	test("an unknown tool name is unknown_tool", async () => {
		expect(await setup().host.call("ultrathink_delete", {})).toEqual({ ok: false, code: "unknown_tool" });
	});

	test("ultrathink_plan starts a journal session on disk and ultrathink_status reports it", async () => {
		const { host } = setup();
		const started = okOf(await host.call("ultrathink_plan", { prompt: "plan the rollout" }));
		expect(started.data.status).toBe("needs-model");
		const sessionId = String(started.data.sessionId);
		const pending = okOf(await host.call("ultrathink_pending", { sessionId }));
		expect(Array.isArray(pending.data.pending) ? pending.data.pending.length : 0).toBeGreaterThan(0);
		expect(okOf(await host.call("ultrathink_status", { sessionId })).data).toMatchObject({ sessionId, status: "needs-model" });
	});

	test("ultrathink_status asks the planner first and falls back to the journal", async () => {
		const planner = stubPlanner(true);
		const { host } = setup({ planner });
		const serverId = randomUUID();
		planner.serverIds.add(serverId);
		expect(okOf(await host.call("ultrathink_status", { sessionId: serverId })).data).toMatchObject({ sessionId: serverId, status: "running" });
		expect(await host.call("ultrathink_status", { sessionId: "../etc" })).toEqual({ ok: false, code: "invalid_session_id" });
	});

	test("ultrathink_uplift needs a planner", async () => {
		expect(await setup().host.call("ultrathink_uplift", { prompt: "plan it" })).toEqual({ ok: false, code: "disabled" });
	});

	test("ultrathink_uplift counts a start that already finished, from its finished view", async () => {
		const planner = stubPlanner(true);
		const { host, finished } = setup({ planner });
		const sessionId = randomUUID();
		const started = okOf(await host.call("ultrathink_uplift", { prompt: "plan it", sessionId }));
		expect(started.data).toEqual({ sessionId, status: "planned" });
		expect(started.text).toBeUndefined();
		expect(planner.starts).toEqual([{ prompt: "plan it", sessionId }]);
		expect(planner.results).toEqual([{ sessionId, waitSeconds: 0 }]);
		expect(finished.map((view) => view.sessionId)).toEqual([sessionId]);
	});

	test("ultrathink_uplift does not count a running start", async () => {
		const planner = stubPlanner(true);
		planner.start = async (input) => ({ ok: true, data: { sessionId: String(input.sessionId), status: "running", pollAfterSec: 5 } });
		const { host, finished } = setup({ planner });
		await host.call("ultrathink_uplift", { prompt: "plan it", sessionId: randomUUID() });
		expect(planner.results).toEqual([]);
		expect(finished).toEqual([]);
	});
});

describe("ultrathink_result", () => {
	test("the plan text is the content and also stays in the structured data, next to every other field", async () => {
		const planner = stubPlanner(true);
		const { host } = setup({ planner });
		const sessionId = randomUUID();
		const { data, text } = okOf(await host.call("ultrathink_result", { sessionId, waitSeconds: 0, detail: "full" }));
		expect(text).toBe(PLAN_TEXT);
		expect(data.text).toBe(PLAN_TEXT);
		expect(data).toMatchObject({ sessionId, status: "planned", mode: "server", questions: [{ question: "Which database?", default: "Postgres" }] });
		expect(data.graph).toEqual(buildGraphView(record(sessionId)));
		expect(planner.results).toEqual([{ sessionId, waitSeconds: 0, detail: "full" }]);
	});

	test("each finished server plan is reported once, however often it is read and through either tool", async () => {
		const planner = stubPlanner(true);
		const { host, finished } = setup({ planner });
		const sessionId = randomUUID();
		await host.call("ultrathink_result", { sessionId });
		await host.call("ultrathink_result", { sessionId });
		await host.call("ultrathink_graph", { sessionId });
		expect(finished).toHaveLength(1);
		await host.call("ultrathink_graph", { sessionId: randomUUID() });
		expect(finished).toHaveLength(2);
	});

	test("a running plan and a client-driven plan are not reported", async () => {
		const running = setup({ planner: stubPlanner(true, (sessionId) => serverView(sessionId, { status: "running", text: "still preparing" })) });
		await running.host.call("ultrathink_result", { sessionId: randomUUID() });
		expect(running.finished).toEqual([]);
		const client = setup({ planner: stubPlanner(false, (sessionId) => serverView(sessionId, { mode: "client" })) });
		await client.host.call("ultrathink_result", { sessionId: randomUUID() });
		expect(client.finished).toEqual([]);
	});

	test("a planner refusal is a refusal", async () => {
		const planner = stubPlanner(true);
		planner.result = async () => ({ ok: false, code: "invalid_input", errors: ["waitSeconds must be a number"] });
		const { host } = setup({ planner });
		expect(await host.call("ultrathink_result", { sessionId: randomUUID() })).toEqual({ ok: false, code: "invalid_input", errors: ["waitSeconds must be a number"] });
	});

	test("without a planner it reads client-driven sessions and validates its arguments", async () => {
		const { host, stateDir } = setup();
		expect(await host.call("ultrathink_result", { sessionId: "../etc" })).toEqual({ ok: false, code: "invalid_session_id" });
		expect(await host.call("ultrathink_result", { sessionId: randomUUID(), detail: "x" })).toEqual({ ok: false, code: "invalid_input" });
		expect(await host.call("ultrathink_result", { sessionId: randomUUID() })).toEqual({ ok: false, code: "not_found" });

		const sessionId = randomUUID();
		writeMeta(journalDir(stateDir, sessionId), { sessionId, original: "Ship it", status: "planned" });
		writeSession(stateDir, record(sessionId));
		const { data, text } = okOf(await host.call("ultrathink_result", { sessionId }));
		expect(data).toMatchObject({ sessionId, status: "planned", mode: "client" });
		expect(text).toContain("Ship it");
		expect(data.text).toBe(text);
		expect(data.graph).toEqual(buildGraphView(record(sessionId)));
	});

	test("without a planner a malformed waitSeconds is refused and a number is accepted and ignored", async () => {
		const { host, stateDir } = setup();
		const sessionId = randomUUID();
		writeMeta(journalDir(stateDir, sessionId), { sessionId, original: "Ship it", status: "planned" });
		writeSession(stateDir, record(sessionId));
		for (const waitSeconds of ["5", Number.NaN, null, {}]) {
			expect(await host.call("ultrathink_result", { sessionId, waitSeconds })).toEqual({ ok: false, code: "invalid_input" });
		}
		for (const waitSeconds of [0, 45, 1000, -3]) {
			const { data } = okOf(await host.call("ultrathink_result", { sessionId, waitSeconds }));
			expect(data).toMatchObject({ sessionId, status: "planned", mode: "client" });
		}
	});
});

describe("the connector tools", () => {
	test("are dispatched with the host's own state, planner and catalog", async () => {
		const { host, stateDir } = setup({ planningInfo: () => ({ serverPlanning: false }) });
		const sessionId = randomUUID();
		writeMeta(journalDir(stateDir, sessionId), { sessionId, original: "Ship it", status: "planned" });
		writeSession(stateDir, record(sessionId));

		const graph = okOf(await host.call("ultrathink_graph", {}));
		expect(graph.data.sessionId).toBe(sessionId);
		expect(graph.data.text).toBe(graph.text);

		const sessions = okOf(await host.call("ultrathink_sessions", {}));
		expect(sessions.data.planning).toEqual({ serverPlanning: false });
		expect(sessions.text).toContain(sessionId);

		const help = okOf(await host.call("ultrathink_command", { command: "help" }));
		expect(help.data.support).toBe("native");
		expect(help.data.text).toBe(help.text);
	});
});
