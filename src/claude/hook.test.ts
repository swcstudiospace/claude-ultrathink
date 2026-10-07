// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeConfigPaths, defaultConfig, loadConfig, type UltrathinkConfig } from "../config.ts";
import type { DecisionAction, DecisionRecord, DecisionsConfig, DecisionsErrorKind } from "../decisions/types.ts";
import type { Clarification } from "../hitl/types.ts";
import type { KnowledgeReader, KnowledgeResult } from "../greptile/knowledge.ts";
import type { RunClarifyOptions } from "../hitl/pipeline.ts";
import type { ProgressEvent } from "../host/progress.ts";
import { TRACKING_OFF_NOTE, UPLIFT_CONTEXT_HEADER } from "./output.ts";
import { runPromptSubmit, type HookDeps, type PromptSubmitInput, type PromptSubmitResult } from "./hook.ts";
import { readSession, type SessionRecord, sessionPath, writeSession } from "./state.ts";
import type { TrackingRefs } from "../track/types.ts";
import type { EmitInput } from "../substrate/brief.ts";
import type { GroundOutcome } from "../ragflow/types.ts";
import type { RecalledLesson, RecallOutcome } from "../teach/types.ts";

function tempStateDir(): { dir: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "ultrathink-hook-"));
	return { dir: join(dir, "ultrathink"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function graphJson(count = 3): string {
	return JSON.stringify({
		goal: "Ship it",
		nodes: Array.from({ length: count }, (_, i) => ({
			id: `n${i + 1}`,
			title: `T${i + 1}`,
			kind: i === 0 ? "understand" : i === count - 1 ? "synthesize" : "generate",
			question: `Q${i + 1}`,
			depends_on: i === 0 ? [] : [`n${i}`],
		})),
	});
}

/** Dispatches by payload content so one fake handles uplift, graph, CoT, and clarify calls correctly. */
function smartComplete(): (system: string, user: string) => Promise<string> {
	return async (_system, user) => {
		if (user.includes("<user_request>")) return "<BUILD_PROMPT><ORIGINAL>add a widget</ORIGINAL></BUILD_PROMPT>";
		if (user.startsWith("<spec>")) return JSON.stringify({ questions: [] });
		if (user.includes("current_node")) {
			const id = user.match(/current_node id="([^"]+)"/)?.[1] ?? "n?";
			const steps = Array.from({ length: 5 }, (_, i) => `${i + 1}. ${id} step ${i + 1}`).join(" ");
			return `<node><rationale>${steps}</rationale><conclusion>c ${id}</conclusion></node>`;
		}
		return graphJson(5);
	};
}

/** Both trackers configured, as a user who set up Linear and Notion would have. */
function trackedConfig(): UltrathinkConfig {
	const config = defaultConfig();
	config.linear.team = "Team";
	config.notion.dataSourceUrl = "collection://ds";
	return config;
}

function baseDeps(overrides: Partial<HookDeps> = {}): { deps: HookDeps; cleanup: () => void } {
	const { dir, cleanup } = tempStateDir();
	const deps: HookDeps = {
		config: trackedConfig(),
		control: {},
		complete: async () => "<BUILD_PROMPT><ORIGINAL>add a widget</ORIGINAL></BUILD_PROMPT>",
		engine: "claude:sonnet",
		stateDir: dir,
		git: () => ({ repo: "acme/widgets", branch: "feat/widget" }),
		brief: async () => "",
		emit: async () => true,
		now: () => 1_000,
		log: () => {},
		// Jev is always on, so tests that do not exercise the gate kill it: no ambient key, no network.
		decisionsDeps: { env: { ULTRATHINK_DECISIONS: "0" } },
		...overrides,
	};
	return { deps, cleanup };
}

const input: PromptSubmitInput = { session_id: "s1", cwd: "/repo", prompt: "add a widget" };

describe("runPromptSubmit", () => {
	test("trivial prompt is skipped before any engine call", async () => {
		let called = false;
		const { deps, cleanup } = baseDeps({
			complete: async () => {
				called = true;
				return "";
			},
		});
		try {
			const result = await runPromptSubmit({ ...input, prompt: "ok" }, deps);
			expect(result.skipped).toBe("skip");
			expect(called).toBe(false);
		} finally {
			cleanup();
		}
	});

	test("a totally failing engine still produces output via the conservative XML fallback", async () => {
		const { deps, cleanup } = baseDeps({
			complete: async () => {
				throw new Error("boom");
			},
			engineError: () => "boom",
		});
		try {
			const result = await runPromptSubmit(input, deps);
			expect(result.output).toBeDefined();
			expect(result.record?.result.source).toBe("fallback");
			// Fallback output must not pollute the shared Notion/Linear tracker with
			// generic FALLBACK_GRAPH boilerplate rows — the turn proceeds untracked.
			expect(result.record?.plan).toBeUndefined();
			// But the failure is recorded and loud: the record keeps the first engine error,
			// and the context says the spec is boilerplate instead of promising rows to come.
			expect(result.record?.engineError).toBe("boom");
			const ctx = result.output?.hookSpecificOutput.additionalContext ?? "";
			expect(ctx).toContain("## Planning degraded");
			expect(ctx).toContain("No tracker rows were created for this plan, and none will be.");
			expect(result.output?.systemMessage).toContain("Engine error · boom");
		} finally {
			cleanup();
		}
	});

	test("a real spec with a failed fill records the stage and warns without discarding the plan", async () => {
		const flaky = smartComplete();
		const { deps, cleanup } = baseDeps({
			complete: async (system, user) => {
				if (user.includes('current_node id="n2"')) throw new Error("boom");
				return flaky(system, user);
			},
			engineError: () => "boom",
		});
		try {
			const result = await runPromptSubmit(input, deps);
			expect(result.record?.result.source).toBe("llm");
			expect(result.record?.plan).toBeDefined();
			expect(result.record?.degraded).toEqual(["fill:n2"]);
			const ctx = result.output?.hookSpecificOutput.additionalContext ?? "";
			expect(ctx).toContain("## Planning degraded");
			expect(ctx).toContain("the n2 fill use fallback content");
			expect(ctx).toContain("Tracker rows are left for ultrathink-kickoff");
		} finally {
			cleanup();
		}
	});

	test("an engine that returns nothing warns without blaming a call that never threw", async () => {
		const { deps, cleanup } = baseDeps({ complete: async () => "" });
		try {
			const result = await runPromptSubmit(input, deps);
			expect(result.record?.result.source).toBe("fallback");
			expect(result.record?.engineError).toBeUndefined();
			expect(result.record?.degraded?.[0]).toBe("uplift");
			expect(result.record?.degraded).toContain("graph");
			expect(result.record?.degraded).toHaveLength(7);
			const ctx = result.output?.hookSpecificOutput.additionalContext ?? "";
			expect(ctx).toContain("## Planning degraded");
			expect(ctx).toContain("no usable model output");
		} finally {
			cleanup();
		}
	});

	test("uplift + think + track: additionalContext carries the kickoff instruction, record carries the plan", async () => {
		const { deps, cleanup } = baseDeps({ complete: smartComplete() });
		try {
			const result = await runPromptSubmit(input, deps);
			const ctx = result.output?.hookSpecificOutput.additionalContext ?? "";
			expect(ctx).toContain("## Graph of Thought");
			expect(ctx).toContain("## Ultrathink tracking");
			expect(ctx).toMatch(/invoke the ultrathink-kickoff skill with stateFile=.*s1\.json/);
			expect(result.output?.systemMessage).toContain("Tracking · ultrathink-kickoff pending");

			const plan = result.record?.plan;
			expect(plan?.task.repo).toBe("acme/widgets");
			expect(plan?.task.branch).toBe("feat/widget");
			expect(plan?.issues).toHaveLength(5);
			// 5 nodes × 5 rationale steps: one Sub-Issue (and Linear sub-issue) per step, not per node.
			expect(plan?.subIssues).toHaveLength(25);
			expect(plan?.linearSubIssues).toHaveLength(25);
			for (const id of ["n1", "n2", "n3", "n4", "n5"]) {
				expect(plan?.subIssues.filter((row) => row.nodeId === id).map((row) => row.step)).toEqual([1, 2, 3, 4, 5]);
			}

			const persisted = readSession(deps.stateDir, "s1");
			expect(persisted?.plan?.graphId).toBe(plan?.graphId);
			expect(persisted?.kickedOff).toBe(false);
			expect(persisted?.synced).toBe(false);
		} finally {
			cleanup();
		}
	});

	test("clarify failure is fail-open: no clarifications, everything else still proceeds", async () => {
		const { deps, cleanup } = baseDeps({
			complete: smartComplete(),
			clarify: async () => {
				throw new Error("clarify down");
			},
		});
		try {
			const result = await runPromptSubmit(input, deps);
			expect(result.output).toBeDefined();
			expect(result.record?.clarifications).toEqual([]);
		} finally {
			cleanup();
		}
	});

	test("previously answered clarifications carry over into the new record", async () => {
		const { deps, cleanup } = baseDeps({ complete: smartComplete(), clarify: async () => [] });
		try {
			const priorAnswer: Clarification = {
				id: "q1",
				question: "Which database?",
				header: "DB",
				why: "w",
				options: [{ label: "Postgres" }, { label: "SQLite" }],
				default: "Postgres",
				blocking: true,
				answer: "Postgres",
				answeredAt: 1,
				source: "user",
			};
			writeSession(deps.stateDir, {
				sessionId: "s1",
				at: 0,
				result: { xml: "<X/>", original: "x", root: "X", source: "llm" },
				clarifications: [priorAnswer],
			});
			const result = await runPromptSubmit(input, deps);
			expect(result.record?.clarifications).toEqual([priorAnswer]);
		} finally {
			cleanup();
		}
	});

	test("echo disabled: no systemMessage, additionalContext still returned", async () => {
		const base = defaultConfig();
		const { deps, cleanup } = baseDeps({ config: { ...base, claude: { ...base.claude, echo: false } } });
		try {
			const result = await runPromptSubmit(input, deps);
			expect(result.output?.systemMessage).toBeUndefined();
			expect(result.output?.hookSpecificOutput.additionalContext).toBeDefined();
		} finally {
			cleanup();
		}
	});

	test("no git remote detected: repo/branch stay undefined, tracking still proceeds", async () => {
		const { deps, cleanup } = baseDeps({ complete: smartComplete(), git: () => ({}) });
		try {
			const result = await runPromptSubmit(input, deps);
			expect(result.record?.plan?.task.repo).toBeUndefined();
			expect(result.record?.plan?.task.branch).toBeUndefined();
			expect(result.record?.plan?.issues).toHaveLength(5);
		} finally {
			cleanup();
		}
	});

	test("Hermes gets a handoff to the saved spec, or the inline spec when the spec file could not be written", async () => {
		const { deps, cleanup } = baseDeps({ surface: "hermes", complete: smartComplete() });
		try {
			const saved = (await runPromptSubmit(input, deps)).output?.hookSpecificOutput.additionalContext ?? "";
			expect(saved).toContain(`Specification file: ${join(deps.stateDir, "sessions", "s1.xml")}`);
			expect(saved).not.toContain("<BUILD_PROMPT>");
			// A file where the state directory should be makes every state write fail.
			rmSync(deps.stateDir, { recursive: true, force: true });
			writeFileSync(deps.stateDir, "not a directory");
			const unsaved = (await runPromptSubmit(input, deps)).output?.hookSpecificOutput.additionalContext ?? "";
			expect(unsaved).toContain("<BUILD_PROMPT>");
			expect(unsaved).not.toContain("Specification file:");
		} finally {
			cleanup();
		}
	});
});

describe("gateway tracking", () => {
	const trackCmd = "/opt/ultrathink/bin/ultrathink-mcp track complete";
	const url = "https://linear.app/acme/issue/ENG-12/understand";

	test("tracker refs land in the context, the spec file, and the session record", async () => {
		let seenSignal: AbortSignal | undefined;
		const { deps, cleanup } = baseDeps({
			complete: smartComplete(),
			trackCommand: trackCmd,
			track: async ({ plan, signal }) => {
				seenSignal = signal;
				const refs: TrackingRefs = {
					graphId: plan.graphId,
					status: "partial",
					linearTeam: "Team",
					linear: { nodes: { n1: { id: "uuid-1", identifier: "ENG-12", url, title: "T1" } }, steps: {} },
					notion: { nodes: {}, steps: {} },
					errors: ["notion: login required"],
					updatedAt: 1_000,
				};
				return refs;
			},
		});
		try {
			const result = await runPromptSubmit(input, deps);
			expect(seenSignal).toBeInstanceOf(AbortSignal);
			const ctx = result.output?.hookSpecificOutput.additionalContext ?? "";
			expect(ctx).toContain("## Linked issues");
			expect(ctx).toContain("ENG-12");
			expect(ctx).toContain(url);
			const spec = readFileSync(join(deps.stateDir, "sessions", "s1.xml"), "utf8");
			expect(spec).toContain("<ISSUES");
			expect(spec).toContain('identifier="ENG-12"');
			const persisted = readSession(deps.stateDir, "s1");
			expect(persisted?.tracking?.status).toBe("partial");
			expect(persisted?.tracking?.linear.nodes.n1?.identifier).toBe("ENG-12");
		} finally {
			cleanup();
		}
	});

	test("a throwing tracker never blocks the prompt; kickoff is told to run the track command", async () => {
		const { deps, cleanup } = baseDeps({
			complete: smartComplete(),
			trackCommand: trackCmd,
			track: async () => {
				throw new Error("gateway down");
			},
		});
		try {
			const result = await runPromptSubmit(input, deps);
			const ctx = result.output?.hookSpecificOutput.additionalContext ?? "";
			expect(ctx).toContain("## Graph of Thought");
			expect(ctx).not.toContain("## Linked issues");
			expect(ctx).toContain(trackCmd);
			expect(result.record?.plan).toBeDefined();
			expect(result.record?.tracking).toBeUndefined();
			const spec = readFileSync(join(deps.stateDir, "sessions", "s1.xml"), "utf8");
			expect(spec).not.toContain("<ISSUES");
		} finally {
			cleanup();
		}
	});

	test("tracking off: no tracker call, no kickoff or Linked issues, one note, plan still recorded", async () => {
		let called = false;
		const { deps, cleanup } = baseDeps({
			complete: smartComplete(),
			trackCommand: trackCmd,
			trackingOff: true,
			track: async () => {
				called = true;
				return undefined;
			},
		});
		try {
			const result = await runPromptSubmit(input, deps);
			const ctx = result.output?.hookSpecificOutput.additionalContext ?? "";
			expect(called).toBe(false);
			expect(ctx).toContain("## Graph of Thought");
			expect(ctx).not.toContain("## Ultrathink tracking");
			expect(ctx).not.toContain("ultrathink-kickoff");
			expect(ctx).not.toContain("## Linked issues");
			expect(ctx).not.toContain(trackCmd);
			expect(ctx).toContain(TRACKING_OFF_NOTE);
			expect(result.output?.systemMessage).toContain("Tracking · off");
			expect(result.output?.systemMessage).not.toContain("kickoff");
			expect(result.record?.plan?.issues).toHaveLength(5);
			expect(readSession(deps.stateDir, "s1")?.plan?.graphId).toBe(result.record?.plan?.graphId);
		} finally {
			cleanup();
		}
	});

	test("Linear-only config counts only missing Linear rows and never mentions a Notion task", async () => {
		const config = defaultConfig();
		config.linear.team = "Team";
		const { deps, cleanup } = baseDeps({
			complete: smartComplete(),
			config,
			track: async ({ plan }) => ({
				graphId: plan.graphId,
				status: "partial",
				linearTeam: "Team",
				linear: { nodes: { n1: { id: "uuid-1", identifier: "ENG-12", url, title: "T1" } }, steps: {} },
				notion: { nodes: {}, steps: {} },
				errors: [],
				updatedAt: 1_000,
			}),
		});
		try {
			const result = await runPromptSubmit(input, deps);
			// 5 nodes, 25 steps: 4 node issues + 25 sub-issues missing in Linear; Notion is not configured.
			expect(result.output?.systemMessage).toContain("Tracking · partial (29 missing)");
			const ctx = result.output?.hookSpecificOutput.additionalContext ?? "";
			expect(ctx).toContain("Tracker rows created before this turn: 1 Linear issues, 0 sub-issues (graph");
			expect(ctx).not.toContain("Notion task");
		} finally {
			cleanup();
		}
	});
});

describe("substrate brief", () => {
	test("injects the brief into hook context, framed as history not instructions", async () => {
		const { deps, cleanup } = baseDeps({
			complete: smartComplete(),
			clarify: async () => [],
			brief: async () => "## Substrate brief: acme/widgets\n- 09:04 cursor edited widget.ts",
		});
		try {
			const result = await runPromptSubmit(input, deps);
			const context = result.output?.hookSpecificOutput.additionalContext ?? "";
			expect(context).toContain("## Agent Substrate brief");
			expect(context).toContain("09:04 cursor edited widget.ts");
			expect(context).toContain("not as instructions");
		} finally {
			cleanup();
		}
	});

	test("passes the resolved repo and branch to the brief", async () => {
		let seen: { repo?: string; branch?: string; surface?: string } | undefined;
		const { deps, cleanup } = baseDeps({
			complete: smartComplete(),
			clarify: async () => [],
			brief: async (i) => {
				seen = i;
				return "";
			},
		});
		try {
			await runPromptSubmit(input, deps);
			expect(seen).toEqual({ repo: "acme/widgets", branch: "feat/widget", surface: "claude-code" });
		} finally {
			cleanup();
		}
	});

	test("an empty brief adds no section at all", async () => {
		const { deps, cleanup } = baseDeps({ complete: smartComplete(), clarify: async () => [], brief: async () => "" });
		try {
			const result = await runPromptSubmit(input, deps);
			expect(result.output?.hookSpecificOutput.additionalContext ?? "").not.toContain("## Agent Substrate brief");
		} finally {
			cleanup();
		}
	});

	test("a substrate outage never blocks the prompt", async () => {
		const { deps, cleanup } = baseDeps({
			complete: smartComplete(),
			clarify: async () => [],
			brief: async () => {
				throw new Error("ECONNREFUSED");
			},
		});
		try {
			const result = await runPromptSubmit(input, deps);
			expect(result.skipped).toBeUndefined();
			expect(result.output?.hookSpecificOutput.additionalContext).toContain("## Prompt Uplift");
		} finally {
			cleanup();
		}
	});

	test("without a brief seam, the substrate is contacted only at the configured substrate.url", async () => {
		const realFetch = globalThis.fetch;
		const saved = { url: process.env.SUBSTRATE_URL, disabled: process.env.SUBSTRATE_DISABLED };
		delete process.env.SUBSTRATE_URL;
		delete process.env.SUBSTRATE_DISABLED;
		const urls: string[] = [];
		globalThis.fetch = ((url: string) => {
			urls.push(String(url));
			return Promise.resolve(new Response("## Substrate brief: acme/widgets\n- earlier work"));
		}) as unknown as typeof fetch;
		const run = async (substrateUrl: string): Promise<string> => {
			const config = trackedConfig();
			config.substrate.url = substrateUrl;
			const { deps, cleanup } = baseDeps({ config, complete: smartComplete(), clarify: async () => [], brief: undefined });
			try {
				const result = await runPromptSubmit(input, deps);
				return result.output?.hookSpecificOutput.additionalContext ?? "";
			} finally {
				cleanup();
			}
		};
		try {
			expect(await run("")).not.toContain("## Agent Substrate brief");
			expect(urls).toEqual([]);
			expect(await run("https://substrate.test")).toContain("## Agent Substrate brief");
			expect(urls).toEqual(["https://substrate.test/brief"]);
		} finally {
			globalThis.fetch = realFetch;
			if (saved.url === undefined) delete process.env.SUBSTRATE_URL;
			else process.env.SUBSTRATE_URL = saved.url;
			if (saved.disabled === undefined) delete process.env.SUBSTRATE_DISABLED;
			else process.env.SUBSTRATE_DISABLED = saved.disabled;
		}
	});
});

describe("substrate plan event", () => {
	/** A seam that records every event it is given and says the substrate took it. */
	function recorder(): { emit: NonNullable<HookDeps["emit"]>; sent: EmitInput[] } {
		const sent: EmitInput[] = [];
		return {
			sent,
			emit: async (event) => {
				sent.push(event);
				return true;
			},
		};
	}

	test("a planned prompt emits one note with the Graph ID, after the session record is on disk", async () => {
		const sent: EmitInput[] = [];
		const onDisk: Array<string | undefined> = [];
		const { deps, cleanup } = baseDeps({ complete: smartComplete(), clarify: async () => [] });
		deps.emit = async (event) => {
			sent.push(event);
			onDisk.push(readSession(deps.stateDir, "s1")?.plan?.graphId);
			return true;
		};
		try {
			const result = await runPromptSubmit(input, deps);
			const graphId = result.record?.plan?.graphId ?? "missing graph id";
			expect(graphId).toMatch(/^ut-[a-z0-9]+-[0-9a-f]{8}$/);
			expect(sent).toEqual([
				{
					kind: "note",
					summary: `ultrathink planned graph ${graphId} (5 nodes)`,
					surface: "claude-code",
					sessionId: `s1:${graphId}`,
					graphId,
					repo: "acme/widgets",
					branch: "feat/widget",
					payload: { ultrathink: "plan", nodes: 5, host: "claude-code" },
				},
			]);
			expect(onDisk).toEqual([graphId]);
		} finally {
			cleanup();
		}
	});

	test("two prompts planned in one host session emit notes on different session ids, each ending in its own graph id", async () => {
		const { emit, sent } = recorder();
		const { deps, cleanup } = baseDeps({ complete: smartComplete(), clarify: async () => [], emit });
		try {
			const first = await runPromptSubmit(input, deps);
			const second = await runPromptSubmit(input, deps);
			const g1 = first.record?.plan?.graphId ?? "missing graph id 1";
			const g2 = second.record?.plan?.graphId ?? "missing graph id 2";
			expect(g1).not.toBe(g2);
			expect(sent).toHaveLength(2);
			expect(sent[0]?.sessionId).not.toBe(sent[1]?.sessionId);
			expect(sent[0]?.sessionId?.endsWith(`:${g1}`)).toBe(true);
			expect(sent[1]?.sessionId?.endsWith(`:${g2}`)).toBe(true);
		} finally {
			cleanup();
		}
	});

	test("a skill run on another host names that host and the skill, and nothing of what was asked", async () => {
		const { emit, sent } = recorder();
		const { deps, cleanup } = baseDeps({ surface: "hermes", complete: smartComplete(), clarify: async () => [], emit });
		try {
			const result = await runPromptSubmit(
				{
					...input,
					prompt: "fix the login redirect",
					skill: { name: "gsd-quick", instruction: "fix the login redirect", summary: "Fast atomic task.", source: "omp" },
				},
				deps,
			);
			expect(sent).toHaveLength(1);
			expect(sent[0]).toMatchObject({ surface: "hermes", payload: { ultrathink: "plan", nodes: 5, host: "hermes", skill: "gsd-quick" } });
			const wire = JSON.stringify(sent);
			expect(wire).toContain(result.record?.plan?.graphId ?? "missing graph id");
			expect(wire).not.toContain("login redirect");
			expect(wire).not.toContain("Fast atomic task");
		} finally {
			cleanup();
		}
	});

	test("a prompt that is not planned emits nothing: trivial, raw, planning off, and a Jev skip", async () => {
		const { emit, sent } = recorder();
		const { deps, cleanup } = baseDeps({ complete: smartComplete(), clarify: async () => [], emit });
		try {
			expect((await runPromptSubmit({ ...input, prompt: "ok" }, deps)).skipped).toBe("skip");
			expect((await runPromptSubmit({ ...input, prompt: "raw: add a widget" }, deps)).skipped).toBe("passthrough");
			expect((await runPromptSubmit(input, { ...deps, control: { enabled: false } })).skipped).toBe("skip");
			expect(sent).toEqual([]);
		} finally {
			cleanup();
		}

		const R = recordingFetch([JEV(0.04)]);
		const h = jevHarness(onConfig(), R.fetch, { emit });
		try {
			const result = await runPromptSubmit({ ...input, prompt: ACK }, h.deps);
			expect(result.skipped).toBe("jev-skip");
			expect(sent).toEqual([]);
		} finally {
			globalThis.fetch = realFetch;
			h.cleanup();
		}
	});

	test("a failed engine leaves no plan and no Graph ID, so nothing is emitted", async () => {
		const { emit, sent } = recorder();
		const { deps, cleanup } = baseDeps({
			complete: async () => {
				throw new Error("boom");
			},
			emit,
		});
		try {
			const result = await runPromptSubmit(input, deps);
			expect(result.output).toBeDefined();
			expect(result.record?.plan).toBeUndefined();
			expect(sent).toEqual([]);
		} finally {
			cleanup();
		}
	});

	test("a session record that could not be written is not announced", async () => {
		const { emit, sent } = recorder();
		const { deps, cleanup } = baseDeps({ complete: smartComplete(), clarify: async () => [], emit });
		try {
			// A file where the state directory should be makes every state write fail.
			rmSync(deps.stateDir, { recursive: true, force: true });
			writeFileSync(deps.stateDir, "not a directory");
			const result = await runPromptSubmit(input, deps);
			expect(result.record?.plan?.graphId).toBeDefined();
			expect(existsSync(sessionPath(deps.stateDir, "s1"))).toBe(false);
			expect(sent).toEqual([]);
		} finally {
			cleanup();
		}
	});

	test("a prompt with no session id is planned but not announced", async () => {
		const { emit, sent } = recorder();
		const { deps, cleanup } = baseDeps({ complete: smartComplete(), clarify: async () => [], emit });
		try {
			for (const session_id of [undefined, "  "]) {
				const result = await runPromptSubmit({ ...input, session_id }, deps);
				expect(result.record?.sessionId).toBe("unknown");
				expect(result.record?.plan?.graphId).toBeDefined();
			}
			expect(sent).toEqual([]);
		} finally {
			cleanup();
		}
	});

	test("a run whose planning budget is already spent sends no event, but still persists the record", async () => {
		const { emit, sent } = recorder();
		const { deps, cleanup } = baseDeps({
			complete: smartComplete(),
			clarify: async () => [],
			emit,
			// The tracker waits for the budget to fire, so the plan is finished only after the controller aborted.
			track: async ({ signal }) => {
				const { promise, resolve } = Promise.withResolvers<void>();
				signal?.addEventListener("abort", () => resolve());
				await promise;
				return undefined;
			},
		});
		deps.config.claude.budgetMs = 20;
		try {
			const result = await runPromptSubmit(input, deps);
			expect(result.record?.plan?.graphId).toBeDefined();
			expect(readSession(deps.stateDir, "s1")?.plan?.graphId).toBe(result.record?.plan?.graphId);
			expect(sent).toEqual([]);
		} finally {
			cleanup();
		}
	});

	test("the event is handed the planning signal, and a budget that fires mid-request ends the wait promptly", async () => {
		let seen: AbortSignal | undefined;
		const { deps, cleanup } = baseDeps({
			complete: smartComplete(),
			clarify: async () => [],
			emit: (_event, signal) => {
				const { promise, resolve } = Promise.withResolvers<boolean>();
				seen = signal;
				// A substrate that never answers: only the budget can end the wait.
				signal?.addEventListener("abort", () => resolve(false));
				return promise;
			},
		});
		deps.config.claude.budgetMs = 80;
		try {
			const started = performance.now();
			const result = await runPromptSubmit(input, deps);
			expect(performance.now() - started).toBeLessThan(1_000);
			expect(seen).toBeDefined();
			expect(seen?.aborted).toBe(true);
			expect(result.record?.plan?.graphId).toBeDefined();
			expect(result.output?.hookSpecificOutput?.additionalContext).toContain("<BUILD_PROMPT>");
		} finally {
			cleanup();
		}
	});

	test("with no budget the signal handed to the seam stays live", async () => {
		let aborted: boolean | undefined;
		const { deps, cleanup } = baseDeps({
			complete: smartComplete(),
			clarify: async () => [],
			emit: async (_event, signal) => {
				aborted = signal?.aborted;
				return true;
			},
		});
		try {
			await runPromptSubmit(input, deps);
			expect(aborted).toBe(false);
		} finally {
			cleanup();
		}
	});

	test("the summary's elapsed time includes the event attempt", async () => {
		let clock = 1_000;
		const { deps, cleanup } = baseDeps({
			complete: smartComplete(),
			clarify: async () => [],
			now: () => clock,
			emit: async () => {
				clock += 4_000;
				return true;
			},
		});
		try {
			const result = await runPromptSubmit(input, deps);
			expect(result.output?.systemMessage).toContain("4.0s");
		} finally {
			cleanup();
		}
	});

	test("the substrate's answer, a refusal or a failure never changes the plan, the record, the summary or the result", async () => {
		const events: ProgressEvent[] = [];
		const { deps, cleanup } = baseDeps({ complete: smartComplete(), clarify: async () => [], progress: (e) => events.push(e) });
		try {
			// The baseline: no emit seam and no substrate URL, so the real emitter has nothing to send to.
			const base = await runPromptSubmit(input, { ...deps, emit: undefined });
			const emitters: Array<[string, NonNullable<HookDeps["emit"]>]> = [
				["accepted", async () => true],
				["refused", async () => false],
				[
					"rejecting",
					async () => {
						throw new Error("ECONNREFUSED substrate.test:9000");
					},
				],
				[
					"throwing",
					() => {
						throw new Error("synchronous failure");
					},
				],
			];
			for (const [name, emit] of emitters) {
				events.length = 0;
				const result = await runPromptSubmit(input, { ...deps, emit });
				expect(normalized(result, result.record?.plan?.graphId), name).toEqual(normalized(base, base.record?.plan?.graphId));
				// The record was persisted before the emit, and the progress stream still ends planned.
				expect(readSession(deps.stateDir, "s1")?.plan?.graphId, name).toBe(result.record?.plan?.graphId);
				expect(events.at(-1), name).toMatchObject({ type: "end", outcome: "planned" });
			}
		} finally {
			cleanup();
		}
	});

	test("without an emit seam nothing is sent unless a substrate URL is configured, and SUBSTRATE_DISABLED=1 beats it", async () => {
		const urls: string[] = [];
		globalThis.fetch = ((url: string) => {
			urls.push(String(url));
			return Promise.resolve(new Response("{}", { status: 202 }));
		}) as unknown as typeof fetch;
		const run = async (substrateUrl: string, env: Record<string, string>): Promise<PromptSubmitResult> => {
			const config = trackedConfig();
			config.substrate.url = substrateUrl;
			const { deps, cleanup } = baseDeps({
				config,
				complete: smartComplete(),
				clarify: async () => [],
				emit: undefined,
				decisionsDeps: { env: { ULTRATHINK_DECISIONS: "0", ...env } },
			});
			try {
				return await runPromptSubmit(input, deps);
			} finally {
				cleanup();
			}
		};
		try {
			expect((await run("", {})).record?.plan?.graphId).toBeDefined();
			expect(urls).toEqual([]);
			expect((await run("https://substrate.test", { SUBSTRATE_DISABLED: "1" })).record?.plan?.graphId).toBeDefined();
			expect(urls).toEqual([]);
		} finally {
			globalThis.fetch = realFetch;
		}
	});

	test("with a configured URL the real emitter posts the event to /events, and neither the prompt nor the token is in it", async () => {
		const R = recordingFetch([() => new Response("{}", { status: 202 })]);
		const config = trackedConfig();
		config.substrate.url = "https://substrate.test/";
		const logs: string[] = [];
		const { deps, cleanup } = baseDeps({
			config,
			complete: smartComplete(),
			clarify: async () => [],
			emit: undefined,
			log: (message) => logs.push(message),
			decisionsDeps: { env: { ULTRATHINK_DECISIONS: "0", SUBSTRATE_TOKEN: "tok-secret-1234" } },
		});
		try {
			const result = await runPromptSubmit(input, deps);
			const graphId = result.record?.plan?.graphId ?? "missing graph id";
			expect(R.calls).toHaveLength(1);
			const call = R.calls[0];
			expect(call?.url).toBe("https://substrate.test/events");
			expect(call?.method).toBe("POST");
			expect(call?.headers.authorization).toBe("Bearer tok-secret-1234");
			expect(call?.body).toEqual({
				kind: "note",
				summary: `ultrathink planned graph ${graphId} (5 nodes)`,
				surface: "claude-code",
				session_id: `s1:${graphId}`,
				graph_id: graphId,
				repo: "acme/widgets",
				branch: "feat/widget",
				payload: { ultrathink: "plan", nodes: 5, host: "claude-code" },
			});
			// The prompt, the spec and the plan stay local; the token is only ever the Authorization header.
			const wire = JSON.stringify(call?.body);
			expect(wire).not.toContain("add a widget");
			expect(wire).not.toContain("BUILD_PROMPT");
			expect(JSON.stringify([wire, result, logs, sessionText(deps.stateDir)])).not.toContain("tok-secret-1234");
		} finally {
			globalThis.fetch = realFetch;
			cleanup();
		}
	});
});

describe("progress events", () => {
	const label = (e: ProgressEvent): string =>
		e.type === "stage" ? `${e.stage}:${e.phase}` : e.type === "node" ? `node:${e.phase}` : e.type;

	test("a planned prompt streams begin, ordered stages, graph and node events, then end planned", async () => {
		const events: ProgressEvent[] = [];
		const { deps, cleanup } = baseDeps({ complete: smartComplete(), progress: (e) => events.push(e) });
		try {
			await runPromptSubmit(input, deps);
			const labels = events.map(label);
			expect(labels[0]).toBe("begin");
			expect(labels.at(-1)).toBe("end");
			expect(events.at(-1)).toMatchObject({ type: "end", outcome: "planned" });
			const order = ["uplift:start", "uplift:end", "think:start", "graph", "think:end", "clarify:start", "clarify:end", "plan:start", "plan:end", "state:start", "state:end"];
			const positions = order.map((l) => labels.indexOf(l));
			expect(positions.every((p) => p >= 0)).toBe(true);
			expect([...positions].sort((a, b) => a - b)).toEqual(positions);
			expect(labels).not.toContain("track:start");
			expect(labels.filter((l) => l === "node:done")).toHaveLength(5);
			expect(events.find((e) => e.type === "graph")).toMatchObject({ total: 5 });
			expect(events.find((e) => e.type === "stage" && e.stage === "think" && e.phase === "end")).toMatchObject({ ok: true, detail: "5 nodes" });
		} finally {
			cleanup();
		}
	});

	test("begin announces whether planner-side tracking will run", async () => {
		const untracked: ProgressEvent[] = [];
		const tracked: ProgressEvent[] = [];
		const plain = baseDeps({ complete: smartComplete(), progress: (e) => untracked.push(e) });
		const withTracker = baseDeps({
			complete: smartComplete(),
			progress: (e) => tracked.push(e),
			track: async () => {
				throw new Error("gateway down");
			},
		});
		try {
			await runPromptSubmit(input, plain.deps);
			await runPromptSubmit(input, withTracker.deps);
			expect(untracked[0]).toMatchObject({ type: "begin", track: false });
			expect(tracked[0]).toMatchObject({ type: "begin", track: true });
		} finally {
			plain.cleanup();
			withTracker.cleanup();
		}
	});

	test("a throwing sink leaves the output unchanged", async () => {
		const quiet = baseDeps({ complete: smartComplete() });
		const loud = baseDeps({
			complete: smartComplete(),
			progress: () => {
				throw new Error("sink closed");
			},
		});
		try {
			const a = await runPromptSubmit(input, quiet.deps);
			const b = await runPromptSubmit(input, loud.deps);
			expect(b.output).toBeDefined();
			expect(b.output?.systemMessage).toBe(a.output?.systemMessage);
		} finally {
			quiet.cleanup();
			loud.cleanup();
		}
	});

	test("a trivial prompt emits nothing", async () => {
		const events: ProgressEvent[] = [];
		const { deps, cleanup } = baseDeps({ progress: (e) => events.push(e) });
		try {
			await runPromptSubmit({ ...input, prompt: "ok" }, deps);
			expect(events).toEqual([]);
		} finally {
			cleanup();
		}
	});
});

describe("skill invocations", () => {
	const skillInput: PromptSubmitInput = {
		...input,
		prompt: "fix the login redirect",
		skill: { name: "gsd-quick", instruction: "fix the login redirect", summary: "Fast atomic task.", source: "omp" },
	};

	test("plans the instruction under the skill: ORIGINAL, conversation line, record, begin, header and summary", async () => {
		const payloads: string[] = [];
		const events: ProgressEvent[] = [];
		const complete = smartComplete();
		const { deps, cleanup } = baseDeps({
			complete: async (system, user) => {
				payloads.push(user);
				return complete(system, user);
			},
			progress: (e) => events.push(e),
		});
		try {
			const result = await runPromptSubmit(skillInput, deps);
			const uplift = payloads.find((p) => p.includes("<user_request>")) ?? "";
			expect(uplift).toContain("<user_request>\nfix the login redirect\n</user_request>");
			expect(uplift).toContain('The user invoked the "gsd-quick" skill with this message. Skill summary: Fast atomic task.');
			expect(result.record?.skill).toEqual({ name: "gsd-quick", summary: "Fast atomic task.", source: "omp" });
			expect(readSession(deps.stateDir, "s1")?.skill?.name).toBe("gsd-quick");
			expect(events[0]).toMatchObject({ type: "begin", skill: "gsd-quick" });
			const ctx = result.output?.hookSpecificOutput.additionalContext ?? "";
			expect(ctx).toContain('invoked the "gsd-quick" skill');
			expect(ctx).not.toContain(UPLIFT_CONTEXT_HEADER);
			expect(result.output?.systemMessage).toContain("Skill · gsd-quick");
		} finally {
			cleanup();
		}
	});

	test("a plain prompt keeps the original header and no skill anywhere", async () => {
		const events: ProgressEvent[] = [];
		const { deps, cleanup } = baseDeps({ complete: smartComplete(), progress: (e) => events.push(e) });
		try {
			const result = await runPromptSubmit(input, deps);
			expect(result.output?.hookSpecificOutput.additionalContext.startsWith(UPLIFT_CONTEXT_HEADER)).toBe(true);
			expect(result.output?.systemMessage).not.toContain("Skill ·");
			expect(result.record?.skill).toBeUndefined();
			expect(events[0]).not.toHaveProperty("skill");
		} finally {
			cleanup();
		}
	});

	test("with ship enabled a gsd-* skill run asks for ultrathink-ship; other skills and plain prompts do not", async () => {
		const config = trackedConfig();
		config.ship.enabled = true;
		const { deps, cleanup } = baseDeps({ config, complete: smartComplete() });
		try {
			const gsd = await runPromptSubmit(skillInput, deps);
			expect(gsd.output?.hookSpecificOutput.additionalContext).toMatch(
				/## Ship\n\n.*invoke the ultrathink-ship skill with stateFile=.*s1\.json/,
			);
			const docx = { name: "docx", instruction: "fix the login redirect", source: "omp" as const };
			const other = await runPromptSubmit({ ...skillInput, skill: docx }, deps);
			expect(other.output?.hookSpecificOutput.additionalContext).not.toContain("## Ship");
			const plain = await runPromptSubmit(input, deps);
			expect(plain.output?.hookSpecificOutput.additionalContext).not.toContain("## Ship");
		} finally {
			cleanup();
		}
	});

	test("with the default config (ship off) a gsd-* skill run gets no Ship section", async () => {
		const { deps, cleanup } = baseDeps({ complete: smartComplete() });
		try {
			const gsd = await runPromptSubmit(skillInput, deps);
			expect(gsd.output?.hookSpecificOutput.additionalContext).not.toContain("## Ship");
		} finally {
			cleanup();
		}
	});
});

describe("Greptile knowledge base before clarify", () => {
	/** A reader whose read() resolves `result`; records start() inputs and close() calls. */
	function fakeReader(result: KnowledgeResult): { reader: KnowledgeReader; starts: Array<{ repo?: string }>; closed: () => number } {
		const starts: Array<{ repo?: string }> = [];
		let closes = 0;
		const reader: KnowledgeReader = {
			start(input) {
				starts.push({ repo: input.repo });
				return {
					read: async () => result,
					close: () => {
						closes++;
					},
				};
			},
		};
		return { reader, starts, closed: () => closes };
	}

	const open: Clarification = {
		id: "q1",
		question: "Which queue backend?",
		header: "Queue",
		why: "w",
		options: [{ label: "Redis" }, { label: "SQS" }],
		default: "Redis",
		blocking: true,
	};
	const settled: Clarification = {
		id: "k1",
		question: "Where do widgets persist?",
		header: "Storage",
		why: "w",
		options: [],
		default: "",
		blocking: false,
		answer: "In the widgets table",
		source: "knowledge",
		evidence: "docs/storage.md",
	};

	test("a used lookup reaches clarify, is recorded with its settled count, and adds the context section", async () => {
		const { reader, starts, closed } = fakeReader({
			lookup: { outcome: "used", repo: "acme/widgets", namespaceId: "ns1", docs: ["index.md", "docs/storage.md"], chars: 42, ms: 5 },
			digest: "## index.md\nwidgets persist in the widgets table",
		});
		let seen: RunClarifyOptions | undefined;
		const { deps, cleanup } = baseDeps({
			complete: smartComplete(),
			knowledge: reader,
			clarify: async (opts) => {
				seen = opts;
				return [open, settled];
			},
		});
		try {
			const result = await runPromptSubmit(input, deps);
			expect(starts).toEqual([{ repo: "acme/widgets" }]);
			expect(seen?.knowledge).toEqual({ digest: "## index.md\nwidgets persist in the widgets table", docs: ["index.md", "docs/storage.md"] });
			expect(result.record?.knowledge).toMatchObject({ outcome: "used", docs: ["index.md", "docs/storage.md"], settled: 1 });
			expect(readSession(deps.stateDir, "s1")?.knowledge).toMatchObject({ outcome: "used", settled: 1 });
			const ctx = result.output?.hookSpecificOutput.additionalContext ?? "";
			expect(ctx).toContain("## Greptile knowledge base");
			expect(ctx).toContain("for acme/widgets: index.md, docs/storage.md.");
			expect(result.output?.systemMessage).toContain("Knowledge · 2 docs · 1 settled");
			expect(closed()).toBe(1);
		} finally {
			cleanup();
		}
	});

	test("an error lookup fails open: clarify runs without knowledge, the record says error, no context section", async () => {
		const { reader } = fakeReader({
			lookup: { outcome: "error", repo: "acme/widgets", docs: [], chars: 0, ms: 20_000, reason: "timed out after 20000ms" },
			digest: "",
		});
		let seen: RunClarifyOptions | undefined;
		const { deps, cleanup } = baseDeps({
			complete: smartComplete(),
			knowledge: reader,
			clarify: async (opts) => {
				seen = opts;
				return [open];
			},
		});
		try {
			const result = await runPromptSubmit(input, deps);
			expect(seen).toBeDefined();
			expect(seen?.knowledge).toBeUndefined();
			expect(result.record?.knowledge).toMatchObject({ outcome: "error", settled: 0 });
			expect(result.record?.clarifications).toEqual([open]);
			expect(result.output?.hookSpecificOutput.additionalContext ?? "").not.toContain("## Greptile knowledge base");
			expect(result.output?.systemMessage).toContain("Knowledge · error");
		} finally {
			cleanup();
		}
	});

	test("a lookup is still recorded when clarify throws", async () => {
		const { reader } = fakeReader({
			lookup: { outcome: "none", repo: "acme/widgets", docs: [], chars: 0, ms: 3, reason: "repository not listed" },
			digest: "",
		});
		const { deps, cleanup } = baseDeps({
			complete: smartComplete(),
			knowledge: reader,
			clarify: async () => {
				throw new Error("clarify down");
			},
		});
		try {
			const result = await runPromptSubmit(input, deps);
			expect(result.record?.knowledge).toMatchObject({ outcome: "none", settled: 0 });
			expect(result.record?.clarifications).toEqual([]);
		} finally {
			cleanup();
		}
	});

	test("HITL off: the knowledge base is never read", async () => {
		const { reader, starts } = fakeReader({ lookup: { outcome: "used", docs: ["index.md"], chars: 1, ms: 1 }, digest: "x" });
		const { deps, cleanup } = baseDeps({ complete: smartComplete(), knowledge: reader, control: { hitlEnabled: false } });
		try {
			const result = await runPromptSubmit(input, deps);
			expect(starts).toEqual([]);
			expect(result.record?.knowledge).toBeUndefined();
			expect(result.output?.systemMessage).not.toContain("Knowledge");
		} finally {
			cleanup();
		}
	});

	test("the lookup topic is the request text, goal and node conclusions, without the spec's XML markup", async () => {
		const topics: string[] = [];
		const reader: KnowledgeReader = {
			start: () => ({
				read: async (topic) => {
					topics.push(topic);
					return { lookup: { outcome: "none", docs: [], chars: 0, ms: 1 }, digest: "" };
				},
				close: () => {},
			}),
		};
		const { deps, cleanup } = baseDeps({ complete: smartComplete(), knowledge: reader, clarify: async () => [] });
		try {
			await runPromptSubmit(input, deps);
			expect(topics).toHaveLength(1);
			const topic = topics[0] ?? "";
			expect(topic).toContain("add a widget");
			expect(topic).toContain("Ship it");
			expect(topic).toContain("T1: c n1");
			expect(topic).not.toContain("<");
			for (const tag of ["BUILD_PROMPT", "GRAPH_OF_THOUGHT", "ORIGINAL", "NODE"]) expect(topic).not.toContain(tag);
		} finally {
			cleanup();
		}
	});

	test("knowledge-settled answers are not carried to the next prompt; user answers are", async () => {
		const { deps, cleanup } = baseDeps({ complete: smartComplete(), clarify: async () => [] });
		try {
			const userAnswer: Clarification = { ...open, answer: "Redis", answeredAt: 1, source: "user" };
			writeSession(deps.stateDir, {
				sessionId: "s1",
				at: 0,
				result: { xml: "<X/>", original: "x", root: "X", source: "llm" },
				clarifications: [userAnswer, settled],
			});
			const result = await runPromptSubmit(input, deps);
			expect(result.record?.clarifications).toEqual([userAnswer]);
		} finally {
			cleanup();
		}
	});
});

// ---- Jev plan gate (DP-PLAN) and the prompt's decision records ----

const K = "sk-or-v1-UTTESTKEY-0123456789abcdef";
const ENDPOINT = "https://openrouter.ai/api/alpha/decisions";
interface Recorded {
	url: string;
	method: string;
	headers: Record<string, string>;
	body: unknown;
}

const realFetch = globalThis.fetch;
const jevDirs: string[] = [];
afterEach(() => {
	globalThis.fetch = realFetch;
	for (const dir of jevDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Recording fetch R: records every call, answers from a queue (last entry repeats). Installed as globalThis.fetch too. */
function recordingFetch(queue: Array<() => Response | Promise<Response>>): { fetch: typeof fetch; calls: Recorded[] } {
	const calls: Recorded[] = [];
	const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
		const headers: Record<string, string> = {};
		new Headers(init?.headers).forEach((value, key) => {
			headers[key] = value;
		});
		const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : init?.body;
		calls.push({ url: String(input), method: init?.method ?? "GET", headers, body });
		const next = queue[Math.min(calls.length, queue.length) - 1];
		if (!next) throw new Error("empty queue");
		return next();
	}) as typeof fetch;
	globalThis.fetch = fetchImpl;
	return { fetch: fetchImpl, calls };
}

const JEV =
	(p: number, key = "plan_worthy") =>
	() =>
		Response.json({
			id: "gen-dec-test",
			model: "typesafe/jev-1.13-20260917",
			provider: "TypeSafe",
			answers: { [key]: { type: "noul", noul: p } },
			usage: { input_tokens: 450, output_tokens: 0, cost: 0.000019 },
		});
const ERR = (s: number, headers?: Record<string, string>) => () =>
	Response.json({ error: { code: s, message: `upstream said no for ${K}` } }, { status: s, headers });

/** Never resolves; rejects with an AbortError when its signal fires (as src/grok/complete.test.ts hangingFetch). Installed as globalThis.fetch too. */
function hangingFetch(onCall?: () => void): typeof fetch {
	const fetchImpl = ((_input: string | URL | Request, init?: RequestInit) =>
		new Promise<Response>((_resolve, reject) => {
			init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
			onCall?.();
		})) as typeof fetch;
	globalThis.fetch = fetchImpl;
	return fetchImpl;
}

/** A credential store path in a temp dir: empty, or holding `key` for openrouter. */
function tempStore(key?: string): string {
	const dir = mkdtempSync(join(tmpdir(), "ut-decisions-hook-"));
	jevDirs.push(dir);
	const path = join(dir, "mcp-credentials.json");
	if (key !== undefined) {
		writeFileSync(path, JSON.stringify({ version: 1, providers: { openrouter: { kind: "api_key", apiKey: key, updatedAt: 1 } } }), {
			mode: 0o600,
		});
	}
	return path;
}

/** `ON`: decisions enabled with every other key at its default unless overridden; `claude.echo` on unless `echo` is false. */
function onConfig(decisions: Partial<DecisionsConfig> = {}, echo = true): UltrathinkConfig {
	const config = trackedConfig();
	config.decisions = { ...config.decisions, enabled: true, ...decisions };
	config.claude = { ...config.claude, echo };
	return config;
}

const ACK = "thanks, that works now";
const NEW_WORK = "Add OAuth login with GitHub to the web app";
const NOTICE_004 = "Prompt Uplift · not planned: Jev judged this is not new multi-step work (0.04) · start with uplift: to plan it";

interface JevHarness {
	deps: HookDeps;
	calls: { engine: number; track: number; brief: number; knowledge: number };
	events: ProgressEvent[];
	logs: string[];
	cleanup: () => void;
}

/** Hook deps that count every engine, tracker, brief and knowledge-base call, with the Decisions seams injected (key K, empty store). */
function jevHarness(config: UltrathinkConfig, fetchImpl: typeof fetch, overrides: Partial<HookDeps> = {}): JevHarness {
	const calls = { engine: 0, track: 0, brief: 0, knowledge: 0 };
	const events: ProgressEvent[] = [];
	const logs: string[] = [];
	const complete = smartComplete();
	const { deps, cleanup } = baseDeps({
		config,
		complete: async (system, user) => {
			calls.engine++;
			return complete(system, user);
		},
		brief: async () => {
			calls.brief++;
			return "";
		},
		track: async () => {
			calls.track++;
			return undefined;
		},
		knowledge: {
			start: () => {
				calls.knowledge++;
				return { read: async () => ({ lookup: { outcome: "none", docs: [], chars: 0, ms: 1 }, digest: "" }), close: () => {} };
			},
		},
		conversation: () => "User: the login page is broken\n\nAssistant: Fixed the redirect; it works now.",
		log: (message) => logs.push(message),
		progress: (event) => events.push(event),
		decisionsDeps: { env: { OPENROUTER_API_KEY: K }, storePath: tempStore(), fetch: fetchImpl, sleep: async () => {} },
		...overrides,
	});
	return { deps, calls, events, logs, cleanup };
}

/** The same run with a different config (e.g. an earlier prompt with the tracked config), sharing the state dir and counters. */
function withConfig(h: JevHarness, config: UltrathinkConfig): HookDeps {
	return { ...h.deps, config };
}

/** The same run with Jev killed (BASELINE: decisions off), sharing everything else. */
function offDeps(deps: HookDeps): HookDeps {
	const decisionsDeps = deps.decisionsDeps;
	return { ...deps, decisionsDeps: { ...decisionsDeps, env: { ...decisionsDeps?.env, ULTRATHINK_DECISIONS: "0" } } };
}

/** `value` with the random graph id replaced, so two planned runs compare equal. */
function normalized(value: unknown, graphId?: string): unknown {
	const text = JSON.stringify(value);
	if (text === undefined) return undefined;
	return JSON.parse(graphId ? text.replaceAll(graphId, "GRAPH") : text);
}

function withoutDecisions(record: SessionRecord | undefined): SessionRecord | undefined {
	if (!record) return undefined;
	const copy = { ...record };
	delete copy.decisions;
	return copy;
}

/** A planned Jev run deep-equals its BASELINE apart from the Decisions additions (records and the summary bit). */
function expectBaseline(jev: PromptSubmitResult, base: PromptSubmitResult, bit?: string): void {
	const jevGraph = jev.record?.plan?.graphId;
	const baseGraph = base.record?.plan?.graphId;
	expect(normalized(jev.output?.hookSpecificOutput, jevGraph)).toEqual(normalized(base.output?.hookSpecificOutput, baseGraph));
	expect(normalized(withoutDecisions(jev.record), jevGraph)).toEqual(normalized(base.record, baseGraph));
	const summary = jev.output?.systemMessage;
	if (bit === undefined) expect(summary).toBe(base.output?.systemMessage);
	else {
		expect(summary).toContain(` · ${bit}`);
		expect(summary?.replace(` · ${bit}`, "")).toBe(base.output?.systemMessage);
	}
}

/** Rule T6: the key and a bearer header never appear in anything the run produced. */
function expectNoKey(...outputs: unknown[]): void {
	for (const output of outputs) {
		const text = typeof output === "string" ? output : (JSON.stringify(output) ?? "");
		expect(text).not.toContain(K);
		expect(text).not.toContain("Bearer sk-or-");
	}
}

function sessionText(stateDir: string): string {
	const path = sessionPath(stateDir, "s1");
	return existsSync(path) ? readFileSync(path, "utf8") : "";
}

/** The 4.1–4.9 failures and the kind each maps to; `respond` gets the asked question key. */
const FAILURES: ReadonlyArray<{ name: string; kind: DecisionsErrorKind; respond?: (key: string) => () => Response }> = [
	{ name: "401", kind: "auth", respond: () => ERR(401) },
	{ name: "402", kind: "credits", respond: () => ERR(402) },
	{ name: "400", kind: "bad-request", respond: () => ERR(400) },
	{ name: "429 then 429", kind: "rate-limit", respond: () => ERR(429) },
	{ name: "503 then 503", kind: "upstream", respond: () => ERR(503) },
	{ name: "a hanging request", kind: "timeout" },
	{ name: "invalid JSON", kind: "invalid-response", respond: () => () => new Response("not json", { status: 200 }) },
	{ name: "a missing answer key", kind: "invalid-response", respond: () => JEV(0.97, "not_asked") },
	{ name: "noul out of range", kind: "invalid-response", respond: (key) => JEV(1.5, key) },
];

/**
 * R for one failure: a recording fetch that repeats it, or a hanging fetch. The hanging case needs a real clock: the
 * client's per-attempt budget is an AbortSignal.timeout, so it gets the shortest budget that still proves `timeout`.
 */
function failureFetch(failure: (typeof FAILURES)[number], key: string): { fetch: typeof fetch; timeoutMs: number } {
	if (!failure.respond) return { fetch: hangingFetch(), timeoutMs: 50 };
	return { fetch: recordingFetch([failure.respond(key)]).fetch, timeoutMs: 3000 };
}

describe("Jev plan gate", () => {
	test("a fresh install sends nothing without a key, and consults Jev with one (AC-1.1, JEV-01)", async () => {
		for (const surface of ["claude-code", "grok-build"]) {
			const R = recordingFetch([JEV(0.97)]);
			// FRESH: no decisions key anywhere, and no key in the environment or store.
			const h = jevHarness(trackedConfig(), R.fetch, {
				surface,
				decisionsDeps: { env: {}, storePath: tempStore(), fetch: R.fetch },
			});
			try {
				const keyless = await runPromptSubmit({ ...input, prompt: NEW_WORK }, h.deps);
				expect(R.calls).toHaveLength(0);
				expect(h.calls.engine).toBeGreaterThanOrEqual(1);
				expect(keyless.record?.plan).toBeDefined();
				expect(keyless).not.toHaveProperty("decisions");
				expect(keyless.record).not.toHaveProperty("decisions");
				expect(keyless.output?.systemMessage).not.toContain("Decisions ·");

				const keyed = await runPromptSubmit(
					{ ...input, prompt: NEW_WORK },
					{
						...h.deps,
						decisionsDeps: { env: { OPENROUTER_API_KEY: K }, storePath: tempStore(K), fetch: R.fetch },
					},
				);
				expect(R.calls).toHaveLength(1);
				expect(keyed.output?.systemMessage).toContain("Decisions · plan 0.97");
			} finally {
				h.cleanup();
			}
		}
	});

	test("an acknowledgement Jev scores below planSkipBelow is not planned and shows the notice, on Claude and Grok (AC-3.1)", async () => {
		for (const surface of ["claude-code", "grok-build"]) {
			const R = recordingFetch([JEV(0.04)]);
			const h = jevHarness(onConfig(), R.fetch, { surface });
			try {
				// An earlier planned prompt of this session: the skip must leave its record untouched (A13).
				const earlier = await runPromptSubmit({ ...input, prompt: NEW_WORK }, offDeps(withConfig(h, trackedConfig())));
				const before = sessionText(h.deps.stateDir);
				const counts = { ...h.calls };
				h.events.length = 0;

				const result = await runPromptSubmit({ ...input, prompt: ACK }, h.deps);
				expect(R.calls).toHaveLength(1);
				expect(result).toEqual({ skipped: "jev-skip", decisions: [expect.objectContaining({ point: "plan", p: 0.04 })], notice: NOTICE_004 });
				// Not planned, exactly as a deterministic skip: no engine, tracker, brief or knowledge call, no event, no write.
				expect(h.calls).toEqual(counts);
				expect(h.events).toEqual([]);
				expect(sessionText(h.deps.stateDir)).toBe(before);
				expect(readSession(h.deps.stateDir, "s1")?.plan?.graphId).toBe(earlier.record?.plan?.graphId);

				const trivial = await runPromptSubmit({ ...input, prompt: "thanks" }, h.deps);
				expect(trivial).toEqual({ skipped: "skip" });
				expect(Object.keys(result).filter((k) => k !== "decisions" && k !== "notice")).toEqual(Object.keys(trivial));
				expectNoKey(result, h.logs, sessionText(h.deps.stateDir));
			} finally {
				h.cleanup();
			}
		}
	});

	test("with claude.echo off a Jev skip carries no notice and no Decisions bit (AC-3.3)", async () => {
		const R = recordingFetch([JEV(0.04)]);
		const h = jevHarness(onConfig({}, false), R.fetch);
		try {
			const result = await runPromptSubmit({ ...input, prompt: ACK }, h.deps);
			expect(result.skipped).toBe("jev-skip");
			expect(result.output).toBeUndefined();
			expect(result).not.toHaveProperty("notice");
			expect(JSON.stringify(result)).not.toContain("Prompt Uplift · not planned");
			expect(JSON.stringify(result)).not.toContain("Decisions ·");
			expect(h.calls.engine).toBe(0);
			expectNoKey(result);
		} finally {
			h.cleanup();
		}
	});

	test("new work Jev scores at or above planSkipBelow is planned as today, with the Decisions bit (AC-3.4)", async () => {
		for (const surface of ["claude-code", "grok-build"]) {
			const R = recordingFetch([JEV(0.97)]);
			const h = jevHarness(onConfig(), R.fetch, { surface });
			try {
				const base = await runPromptSubmit({ ...input, prompt: NEW_WORK }, offDeps(h.deps));
				expect(R.calls).toHaveLength(0);
				const jev = await runPromptSubmit({ ...input, prompt: NEW_WORK }, h.deps);
				expect(R.calls).toHaveLength(1);
				expect(jev.record?.plan).toBeDefined();
				expectBaseline(jev, base, "Decisions · plan 0.97");
				expectNoKey(jev, h.logs, sessionText(h.deps.stateDir));
			} finally {
				h.cleanup();
			}
		}
	});

	test("a skill invocation (gsd-quick) bypasses the gate with zero requests and still plans with the skill (AC-3.6)", async () => {
		const R = recordingFetch([JEV(0.01)]);
		const h = jevHarness(onConfig(), R.fetch);
		try {
			const result = await runPromptSubmit(
				{ ...input, prompt: "3", skill: { name: "gsd-quick", instruction: "3", summary: "Quick task", source: "slash" } },
				h.deps,
			);
			expect(R.calls).toHaveLength(0);
			expect(result.record?.skill?.name).toBe("gsd-quick");
			expect(result.record?.plan).toBeDefined();
			expect(readSession(h.deps.stateDir, "s1")?.plan?.graphId).toBe(result.record?.plan?.graphId);
			expect(result).not.toHaveProperty("decisions");
		} finally {
			h.cleanup();
		}
	});

	test("uplift: forces a plan with zero requests (AC-3.7)", async () => {
		const R = recordingFetch([JEV(0.01)]);
		const h = jevHarness(onConfig(), R.fetch);
		try {
			const result = await runPromptSubmit({ ...input, prompt: "uplift: thanks" }, h.deps);
			expect(R.calls).toHaveLength(0);
			expect(h.calls.engine).toBeGreaterThanOrEqual(1);
			expect(result.record?.plan).toBeDefined();
		} finally {
			h.cleanup();
		}
	});

	test("on Grok, a wrapped uplift: or /gsd-quick plans with zero requests; a wrapped acknowledgement still asks Jev", async () => {
		const grok = (typed: string) =>
			`<user_query>\n${typed}\n</user_query>\n<skill_information>\n<skill name="gsd-quick" args="3">\nShip a small task fast.\n</skill>\n</skill_information>`;
		const R = recordingFetch([JEV(0.04)]);
		const h = jevHarness(onConfig(), R.fetch, { surface: "grok-build" });
		try {
			for (const prompt of ["<user_query>\nuplift: thanks\n</user_query>", grok("/gsd-quick 3")]) {
				const result = await runPromptSubmit({ ...input, prompt }, h.deps);
				expect(result.record?.plan).toBeDefined();
				expect(result).not.toHaveProperty("decisions");
			}
			expect(R.calls).toHaveLength(0);

			const ack = await runPromptSubmit({ ...input, prompt: `<user_query>\n${ACK}\n</user_query>` }, h.deps);
			expect(R.calls).toHaveLength(1);
			expect(ack.skipped).toBe("jev-skip");
		} finally {
			h.cleanup();
		}
	});

	test("TRIVIAL_RE acks are skipped as today with zero requests and no notice (AC-3.8)", async () => {
		const R = recordingFetch([JEV(0.01)]);
		const h = jevHarness(onConfig(), R.fetch);
		try {
			for (const prompt of ["yes", "ok", "thanks", "go ahead", "lgtm!"]) {
				const base = await runPromptSubmit({ ...input, prompt }, withConfig(h, onConfig({ enabled: false })));
				const jev = await runPromptSubmit({ ...input, prompt }, h.deps);
				expect(jev).toEqual(base);
				expect(jev).toEqual({ skipped: "skip" });
			}
			expect(R.calls).toHaveLength(0);
			expect(h.calls.engine).toBe(0);
		} finally {
			h.cleanup();
		}
	});

	test("every other deterministic skip sends nothing and matches today (AC-3.9)", async () => {
		const R = recordingFetch([JEV(0.01)]);
		const h = jevHarness(onConfig(), R.fetch);
		try {
			const cases: Array<[string, Partial<HookDeps>]> = [
				["raw: add a flag", {}],
				["/help", {}],
				["<BUILD_PROMPT><ORIGINAL>add a flag</ORIGINAL></BUILD_PROMPT>", {}],
				[NEW_WORK, { control: { enabled: false } }],
			];
			for (const [prompt, extra] of cases) {
				const base = await runPromptSubmit({ ...input, prompt }, { ...h.deps, ...extra, config: onConfig({ enabled: false }) });
				const jev = await runPromptSubmit({ ...input, prompt }, { ...h.deps, ...extra });
				expect(jev).toEqual(base);
				expect(jev.skipped).toBeDefined();
			}
			expect(R.calls).toHaveLength(0);
			expect(h.calls.engine).toBe(0);
		} finally {
			h.cleanup();
		}
	});

	test("an inactive plan point sends nothing and plans as today (AC-3.10)", async () => {
		for (const points of [["ship"], []] as DecisionsConfig["points"][]) {
			const R = recordingFetch([JEV(0.01)]);
			const h = jevHarness(onConfig({ points }), R.fetch);
			try {
				const base = await runPromptSubmit({ ...input, prompt: ACK }, offDeps(h.deps));
				const jev = await runPromptSubmit({ ...input, prompt: ACK }, h.deps);
				expect(R.calls).toHaveLength(0);
				expect(jev.record?.plan).toBeDefined();
				expect(jev).not.toHaveProperty("decisions");
				expectBaseline(jev, base);
			} finally {
				h.cleanup();
			}
		}
	});

	test("the record holds no content; a skip returns it unpersisted, a plan stores it in the session (AC-3.13)", async () => {
		const R = recordingFetch([JEV(0.04), JEV(0.97)]);
		const h = jevHarness(onConfig(), R.fetch);
		const expected = (p: number, action: DecisionAction): DecisionRecord => ({
			point: "plan",
			outcome: "ok",
			model: "typesafe/jev-1.13-20260917",
			id: "gen-dec-test",
			p,
			probabilities: { plan_worthy: p },
			threshold: 0.2,
			action,
			latencyMs: expect.any(Number),
			attempts: 1,
			cost: 0.000019,
			at: expect.any(Number),
		});
		try {
			const skipped = await runPromptSubmit({ ...input, prompt: ACK }, h.deps);
			expect(skipped.decisions).toEqual([expected(0.04, "skip-plan")]);
			const skipRecord = skipped.decisions?.[0];
			expect(Number.isFinite(skipRecord?.latencyMs) && (skipRecord?.latencyMs ?? -1) >= 0).toBe(true);
			expect(skipRecord).not.toHaveProperty("error");
			expect(JSON.stringify(skipRecord)).not.toContain(ACK);
			expect(readSession(h.deps.stateDir, "s1")).toBeUndefined();

			const planned = await runPromptSubmit({ ...input, prompt: NEW_WORK }, h.deps);
			expect(planned.decisions).toEqual([expected(0.97, "plan")]);
			const planRecord = planned.decisions?.[0];
			expect(planRecord).not.toHaveProperty("error");
			expect(JSON.stringify(planRecord)).not.toContain(NEW_WORK);
			expect(planned.record?.decisions).toEqual(planned.decisions);
			expect(readSession(h.deps.stateDir, "s1")?.decisions).toEqual(planned.decisions);
			expectNoKey(skipped, planned, sessionText(h.deps.stateDir));
		} finally {
			h.cleanup();
		}
	});

	test("the request carries the host session id (none for an unknown session) and only the message and last assistant turn", async () => {
		const R = recordingFetch([JEV(0.97)]);
		const h = jevHarness(onConfig({ points: ["plan"] }), R.fetch);
		try {
			await runPromptSubmit({ ...input, session_id: "sess-123", prompt: NEW_WORK }, h.deps);
			await runPromptSubmit({ cwd: "/repo", prompt: NEW_WORK }, h.deps);
			expect(R.calls).toHaveLength(2);
			expect((R.calls[0]?.body as { session_id?: string }).session_id).toBe("sess-123");
			expect(R.calls[1]?.body).not.toHaveProperty("session_id");
			expect((R.calls[0]?.body as { state: unknown }).state).toEqual({
				message: NEW_WORK,
				recent_conversation: "Assistant: Fixed the redirect; it works now.",
			});
		} finally {
			h.cleanup();
		}
	});

	test("a project layer cannot redirect the request: only the default endpoint is called (AC-2.12)", async () => {
		const root = mkdtempSync(join(tmpdir(), "ut-decisions-project-"));
		jevDirs.push(root);
		const project = join(root, "project");
		mkdirSync(join(project, ".claude"), { recursive: true });
		// Consent is the user's: a project layer can only narrow decisions, so the Claude user layer turns them on.
		mkdirSync(join(root, "claude"), { recursive: true });
		writeFileSync(join(root, "claude", "ultrathink.json"), JSON.stringify({ decisions: { enabled: true } }));
		writeFileSync(
			join(project, ".claude", "ultrathink.json"),
			JSON.stringify({ decisions: { enabled: true, url: "https://evil.example/x", endpoint: "https://evil.example/y" } }),
		);
		const config = loadConfig(claudeConfigPaths(project, { XDG_CONFIG_HOME: join(root, "xdg"), CLAUDE_CONFIG_DIR: join(root, "claude") }));
		expect(Object.keys(config.decisions).sort()).toEqual(
			["blockingAt", "enabled", "groundedAt", "model", "planSkipBelow", "points", "provider", "shipApproveAt", "shipVetoAtOrBelow", "skillworthyAt", "teachableAutoAt", "teachableBelow", "timeoutMs", "zdr"],
		);
		expect(JSON.stringify(config.decisions)).not.toContain("evil.example");
		const R = recordingFetch([JEV(0.04)]);
		const h = jevHarness(config, R.fetch);
		try {
			const result = await runPromptSubmit({ ...input, cwd: project, prompt: ACK }, h.deps);
			expect(R.calls.map((call) => call.url)).toEqual([ENDPOINT]);
			expect(R.calls.some((call) => call.url.includes("evil.example"))).toBe(false);
			expect(result.skipped).toBe("jev-skip");
		} finally {
			h.cleanup();
		}
	});

	test(
		"every plan failure kind plans exactly as today and reports the kind (AC-4.11)",
		async () => {
			for (const failure of FAILURES) {
				const { fetch: fetchImpl, timeoutMs } = failureFetch(failure, "plan_worthy");
				const h = jevHarness(onConfig({ points: ["plan"], timeoutMs }), fetchImpl);
				try {
					const base = await runPromptSubmit({ ...input, prompt: ACK }, offDeps(h.deps));
					const jev = await runPromptSubmit({ ...input, prompt: ACK }, h.deps);
					expect(jev.record?.plan).toBeDefined();
					expectBaseline(jev, base, `Decisions · error (${failure.kind})`);
					expect(jev.decisions).toEqual([
						expect.objectContaining({ point: "plan", outcome: "error", error: failure.kind, action: "fail-open", probabilities: {} }),
					]);
					expect(readSession(h.deps.stateDir, "s1")?.decisions).toEqual(jev.decisions);
					expectNoKey(jev, h.logs, sessionText(h.deps.stateDir));
				} finally {
					h.cleanup();
				}
			}
		},
		30_000,
	);

	test("a caller abort during the plan gate is re-thrown as an AbortError before anything runs (AC-5.7)", async () => {
		const controller = new AbortController();
		const fetchImpl = hangingFetch(() => queueMicrotask(() => controller.abort()));
		const h = jevHarness(onConfig(), fetchImpl, { signal: controller.signal });
		try {
			let caught: unknown;
			try {
				await runPromptSubmit({ ...input, prompt: ACK }, h.deps);
			} catch (error) {
				caught = error;
			}
			expect((caught as Error | undefined)?.name).toBe("AbortError");
			expect(h.calls).toEqual({ engine: 0, track: 0, brief: 0, knowledge: 0 });
			expect(h.events).toEqual([]);
			expect(readSession(h.deps.stateDir, "s1")).toBeUndefined();
		} finally {
			h.cleanup();
		}
	});
});

describe("Jev knowledge and blocking points through the hook", () => {
	const DOCS = ["index.md", "docs/auth.md", "docs/storage.md"];
	const DIGEST =
		"## Greptile knowledge base\n\n### index.md\n\nRouting table.\n\n### docs/auth.md\n\nSessions are JWTs signed with RS256.\n\n### docs/storage.md\n\nWidgets persist in the widgets table.";
	const usedReader: KnowledgeReader = {
		start: () => ({
			read: async () => ({
				lookup: { outcome: "used", repo: "acme/widgets", namespaceId: "ns1", docs: DOCS, chars: DIGEST.length, ms: 1 },
				digest: DIGEST,
			}),
			close: () => {},
		}),
	};
	/** Two claims the knowledge base settles. */
	const SETTLED = JSON.stringify({
		questions: [
			{ question: "How are sessions signed?", header: "Auth", why: "w", options: [], blocking: false, knowledge: { answer: "JWTs signed with RS256", source: "docs/auth.md" } },
			{ question: "Where do widgets persist?", header: "Storage", why: "w", options: [], blocking: false, knowledge: { answer: "In the widgets table", source: "docs/storage.md" } },
		],
	});
	/** Two open questions the clarifier did not mark blocking. */
	const OPEN = JSON.stringify({
		questions: [
			{ question: "Which OAuth scopes?", header: "Scopes", why: "w", options: [{ label: "read:user" }, { label: "repo" }], default: "read:user", blocking: false },
			{ question: "Where are tokens stored?", header: "Tokens", why: "w", options: [{ label: "Cookie" }, { label: "Local storage" }], default: "Cookie", blocking: false },
		],
	});
	/** smartComplete, with `reply` as the clarifier's answer. */
	function clarifying(reply: string): HookDeps["complete"] {
		const complete = smartComplete();
		return async (system, user) => (user.startsWith("<spec>") ? reply : complete(system, user));
	}

	test(
		"every knowledge failure kind keeps both claims settled and reports the kind (AC-4.13)",
		async () => {
			for (const failure of FAILURES) {
				const { fetch: fetchImpl, timeoutMs } = failureFetch(failure, "supported");
				const h = jevHarness(onConfig({ points: ["knowledge"], timeoutMs }), fetchImpl, { knowledge: usedReader });
				const deps = { ...h.deps, complete: clarifying(SETTLED) };
				try {
					const base = await runPromptSubmit({ ...input, prompt: NEW_WORK }, offDeps(deps));
					expect(base.record?.clarifications?.filter((c) => c.source === "knowledge")).toHaveLength(2);
					const jev = await runPromptSubmit({ ...input, prompt: NEW_WORK }, deps);
					expect(jev.record?.clarifications).toEqual(base.record?.clarifications);
					expectBaseline(jev, base, `Decisions · error (${failure.kind})`);
					expect(jev.decisions).toHaveLength(2);
					for (const record of jev.decisions ?? []) {
						expect(record).toMatchObject({ point: "knowledge", outcome: "error", error: failure.kind, action: "fail-open" });
					}
					expectNoKey(jev, h.logs, sessionText(h.deps.stateDir));
				} finally {
					h.cleanup();
				}
			}
		},
		30_000,
	);

	test(
		"every blocking failure kind keeps both questions non-blocking and reports the kind (AC-4.14)",
		async () => {
			for (const failure of FAILURES) {
				const { fetch: fetchImpl, timeoutMs } = failureFetch(failure, "risky");
				const h = jevHarness(onConfig({ points: ["blocking"], timeoutMs }), fetchImpl);
				const deps = { ...h.deps, complete: clarifying(OPEN) };
				try {
					const base = await runPromptSubmit({ ...input, prompt: NEW_WORK }, offDeps(deps));
					expect(base.record?.clarifications?.map((c) => c.blocking)).toEqual([false, false]);
					const jev = await runPromptSubmit({ ...input, prompt: NEW_WORK }, deps);
					expect(jev.record?.clarifications).toEqual(base.record?.clarifications);
					expectBaseline(jev, base, `Decisions · error (${failure.kind})`);
					expect(jev.decisions).toHaveLength(2);
					for (const record of jev.decisions ?? []) {
						expect(record).toMatchObject({ point: "blocking", outcome: "error", error: failure.kind, action: "fail-open" });
					}
					expectNoKey(jev, h.logs, sessionText(h.deps.stateDir));
				} finally {
					h.cleanup();
				}
			}
		},
		30_000,
	);
});

describe("lessons and RAGFlow documents in the plan", () => {
	const lesson: RecalledLesson = {
		id: "l1",
		name: "Run migrations first MARKER_L1",
		description: "Seeding before migrating fails",
		body: "MARKER_L1 run the migration before the seed script",
		kind: "pitfall",
		project: "widgets",
		host: "claude-code",
		occurrences: 2,
		createdAt: "2026-01-01T00:00:00.000Z",
		source: "local",
	};
	const recalled: RecallOutcome = { status: "used", lessons: [lesson], source: "local", chars: 200, ms: 5 };
	const grounded: GroundOutcome = {
		status: "used",
		chunks: [{ id: "c1", content: "MARKER_D1 widgets are stored in the widgets table", documentName: "storage.md" }],
		chars: 120,
		ms: 7,
		datasets: 1,
	};
	const never = (): Promise<never> => Promise.withResolvers<never>().promise;

	function echoConfig(): UltrathinkConfig {
		const config = trackedConfig();
		config.claude = { ...config.claude, echo: true };
		return config;
	}

	function contextOf(result: PromptSubmitResult): string {
		return result.output?.hookSpecificOutput.additionalContext ?? "";
	}

	/** The planned context with the random graph id replaced, so two runs on one state dir compare equal. */
	function plannedContext(result: PromptSubmitResult): unknown {
		return normalized(result.output?.hookSpecificOutput, result.record?.plan?.graphId);
	}

	test("a used lookup adds both sections after the brief and before the spec, and the record and summary say so", async () => {
		const { deps, cleanup } = baseDeps({
			config: echoConfig(),
			complete: smartComplete(),
			clarify: async () => [],
			brief: async () => "## Substrate brief: acme/widgets\n- 09:04 cursor edited widget.ts",
			recall: async () => recalled,
			ground: async () => grounded,
		});
		try {
			const result = await runPromptSubmit(input, deps);
			const context = contextOf(result);
			const at = (needle: string) => context.indexOf(needle);
			expect(at("## Agent Substrate brief")).toBeGreaterThan(-1);
			expect(at("## Agent Substrate brief")).toBeLessThan(at("## Lessons from earlier work"));
			expect(at("## Lessons from earlier work")).toBeLessThan(at("## Documents (RAGFlow)"));
			expect(at("## Documents (RAGFlow)")).toBeLessThan(at("<BUILD_PROMPT>"));
			expect(context).toContain("MARKER_L1");
			expect(context).toContain("MARKER_D1");
			expect(result.output?.systemMessage).toContain("Lessons · 1 recalled (local)");
			expect(result.output?.systemMessage).toContain("Docs · 1 excerpt (RAGFlow)");

			// The record keeps the lookups, never their text, and reads back from disk.
			expect(result.record?.lessons).toMatchObject({ outcome: "used", count: 1, ids: ["l1"], source: "local" });
			expect(result.record?.docs).toMatchObject({ status: "used", count: 1, datasets: 1 });
			const stored = readSession(deps.stateDir, "s1");
			expect(stored?.lessons).toEqual(result.record?.lessons);
			expect(stored?.docs).toEqual(result.record?.docs);
			expect(JSON.stringify(stored)).not.toContain("MARKER_L1");
			expect(JSON.stringify(stored)).not.toContain("MARKER_D1");
		} finally {
			cleanup();
		}
	});

	test("off, none and error lookups leave the planner text exactly as without them", async () => {
		const { deps, cleanup } = baseDeps({ config: echoConfig(), complete: smartComplete(), clarify: async () => [] });
		try {
			const base = await runPromptSubmit(input, deps);
			const quiet: Array<[RecallOutcome, GroundOutcome]> = [
				[
					{ status: "off", lessons: [], source: "none", chars: 0, ms: 0, reason: "disabled" },
					{ status: "off", chunks: [], chars: 0, ms: 0, datasets: 0, reason: "grounding is off" },
				],
				[
					{ status: "none", lessons: [], source: "none", chars: 0, ms: 1 },
					{ status: "none", chunks: [], chars: 0, ms: 1, datasets: 1 },
				],
				[
					{ status: "error", lessons: [], source: "none", chars: 0, ms: 1, reason: "hindsight unreachable" },
					{ status: "error", chunks: [], chars: 0, ms: 1, datasets: 0, reason: "auth" },
				],
			];
			for (const [lessons, docs] of quiet) {
				const result = await runPromptSubmit(input, { ...deps, recall: async () => lessons, ground: async () => docs });
				expect(plannedContext(result)).toEqual(plannedContext(base));
				expect(contextOf(result)).not.toContain("## Lessons from earlier work");
				expect(contextOf(result)).not.toContain("## Documents (RAGFlow)");
				const summary = result.output?.systemMessage ?? "";
				expect(summary).not.toContain("recalled");
				expect(summary).not.toContain("excerpt");
				if (lessons.status === "error") {
					expect(summary).toContain("Lessons · error (hindsight unreachable)");
					expect(summary).toContain("Docs · error (auth)");
				} else {
					expect(summary).not.toContain("Lessons");
					expect(summary).not.toContain("Docs");
				}
				expect(result.record?.lessons?.outcome).toBe(lessons.status);
				expect(result.record?.docs?.status).toBe(docs.status);
			}
		} finally {
			cleanup();
		}
	});

	test("with nothing configured nothing runs, nothing is contacted and the record is unchanged", async () => {
		const R = recordingFetch([() => new Response("")]);
		const { deps, cleanup } = baseDeps({ config: echoConfig(), complete: smartComplete(), clarify: async () => [], decisionsDeps: { env: {}, storePath: tempStore(), fetch: R.fetch } });
		try {
			const result = await runPromptSubmit(input, deps);
			expect(result.record).not.toHaveProperty("lessons");
			expect(result.record).not.toHaveProperty("docs");
			expect(contextOf(result)).not.toContain("## Lessons from earlier work");
			expect(contextOf(result)).not.toContain("## Documents (RAGFlow)");
			expect(R.calls).toHaveLength(0);
		} finally {
			cleanup();
		}
	});

	test("a throwing seam fails open: the plan is the same and the record names an error, not the message", async () => {
		const { deps, cleanup } = baseDeps({ config: echoConfig(), complete: smartComplete(), clarify: async () => [] });
		try {
			const base = await runPromptSubmit(input, deps);
			const result = await runPromptSubmit(input, {
				...deps,
				recall: async () => {
					throw new Error("add a widget: the prompt text leaked into this message");
				},
				ground: () => {
					throw new TypeError("synchronous failure with the prompt");
				},
			});
			expect(plannedContext(result)).toEqual(plannedContext(base));
			expect(result.record?.lessons).toMatchObject({ outcome: "error", count: 0, reason: "error" });
			expect(result.record?.docs).toMatchObject({ status: "error", count: 0, reason: "TypeError" });
			expect(JSON.stringify(result.record)).not.toContain("leaked");
			expect(result.output?.systemMessage).toContain("Lessons · error (error)");
			expect(result.output?.systemMessage).toContain("Docs · error (TypeError)");
		} finally {
			cleanup();
		}
	});

	test("a hanging seam is cut off by its timeout and an aborting one sees its signal fire", async () => {
		const config = echoConfig();
		config.teach.timeoutMs = 20;
		config.ragflow.timeoutMs = 20;
		const { deps, cleanup } = baseDeps({ config, complete: smartComplete(), clarify: async () => [] });
		try {
			const base = await runPromptSubmit(input, deps);
			const started = Date.now();
			const hung = await runPromptSubmit(input, { ...deps, recall: never, ground: never });
			expect(Date.now() - started).toBeLessThan(2_000);
			expect(plannedContext(hung)).toEqual(plannedContext(base));
			expect(hung.record?.lessons).toMatchObject({ outcome: "error", reason: "timeout" });
			expect(hung.record?.docs).toMatchObject({ status: "error", reason: "timeout" });

			const signals: AbortSignal[] = [];
			const abortable = (signal: AbortSignal): Promise<never> => {
				signals.push(signal);
				const { promise, reject } = Promise.withResolvers<never>();
				signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
				return promise;
			};
			const aborted = await runPromptSubmit(input, { ...deps, recall: ({ signal }) => abortable(signal), ground: ({ signal }) => abortable(signal) });
			expect(signals).toHaveLength(2);
			expect(signals.every((signal) => signal.aborted)).toBe(true);
			expect(plannedContext(aborted)).toEqual(plannedContext(base));
			expect(aborted.record?.lessons).toMatchObject({ outcome: "error", reason: "AbortError" });
			expect(aborted.record?.docs).toMatchObject({ status: "error", reason: "AbortError" });
		} finally {
			cleanup();
		}
	});

	test("both lookups start before the uplift call and see only the user's own words", async () => {
		const order: string[] = [];
		const queries: Array<{ query: string; cwd: string }> = [];
		const complete = smartComplete();
		const { deps, cleanup } = baseDeps({
			complete: async (system, user) => {
				if (user.includes("<user_request>")) {
					order.push("uplift");
					return "<BUILD_PROMPT><ORIGINAL>add a widget</ORIGINAL><NOTES>SPEC_ONLY_TOKEN</NOTES></BUILD_PROMPT>";
				}
				return complete(system, user);
			},
			clarify: async () => [],
			conversation: () => "User: PRIOR_HISTORY_TOKEN\n\nAssistant: ok",
			recall: async ({ query, cwd }) => {
				order.push("recall");
				queries.push({ query, cwd });
				return recalled;
			},
			ground: async ({ query }) => {
				order.push("ground");
				queries.push({ query, cwd: "" });
				return grounded;
			},
		});
		try {
			await runPromptSubmit(input, deps);
			expect(order.slice(0, 3).sort()).toEqual(["ground", "recall", "uplift"]);
			expect(order.indexOf("uplift")).toBe(2);
			expect(queries.map((q) => q.query)).toEqual(["add a widget", "add a widget"]);
			expect(queries[0]?.cwd).toBe("/repo");
			for (const { query } of queries) {
				expect(query).not.toContain("SPEC_ONLY_TOKEN");
				expect(query).not.toContain("PRIOR_HISTORY_TOKEN");
				expect(query).not.toContain("<BUILD_PROMPT");
			}
		} finally {
			cleanup();
		}
	});

	test("the query is cut to 1,500 characters", async () => {
		const queries: string[] = [];
		const { deps, cleanup } = baseDeps({
			complete: smartComplete(),
			clarify: async () => [],
			recall: async ({ query }) => {
				queries.push(query);
				return recalled;
			},
		});
		try {
			await runPromptSubmit({ ...input, prompt: `add a widget ${"x".repeat(3_000)}` }, deps);
			expect(queries).toHaveLength(1);
			expect(queries[0]).toHaveLength(1_500);
			expect(queries[0]?.startsWith("add a widget xxx")).toBe(true);
		} finally {
			cleanup();
		}
	});

	test("skill invocations and uplift: prompts are planned, so they get lessons and documents too", async () => {
		const queries: string[] = [];
		const { deps, cleanup } = baseDeps({
			config: echoConfig(),
			complete: smartComplete(),
			clarify: async () => [],
			recall: async ({ query }) => {
				queries.push(query);
				return recalled;
			},
			ground: async () => grounded,
		});
		try {
			const skilled = await runPromptSubmit(
				{ ...input, prompt: "fix the login redirect", skill: { name: "gsd-quick", instruction: "fix the login redirect", summary: "Fast atomic task.", source: "omp" } },
				deps,
			);
			expect(contextOf(skilled)).toContain("MARKER_L1");
			expect(contextOf(skilled)).toContain("MARKER_D1");
			const forced = await runPromptSubmit({ ...input, prompt: "uplift: thanks" }, deps);
			expect(contextOf(forced)).toContain("MARKER_L1");
			expect(queries).toEqual(["fix the login redirect", "thanks"]);
		} finally {
			cleanup();
		}
	});

	test("a prompt the plan gate or the trivial check skips never looks anything up", async () => {
		const calls = { recall: 0, ground: 0 };
		const seams = {
			recall: async () => {
				calls.recall++;
				return recalled;
			},
			ground: async () => {
				calls.ground++;
				return grounded;
			},
		};
		const R = recordingFetch([JEV(0.04)]);
		const h = jevHarness(onConfig(), R.fetch, seams);
		try {
			expect((await runPromptSubmit({ ...input, prompt: ACK }, h.deps)).skipped).toBe("jev-skip");
			expect((await runPromptSubmit({ ...input, prompt: "thanks" }, offDeps({ ...h.deps, config: trackedConfig() }))).skipped).toBe("skip");
			expect(calls).toEqual({ recall: 0, ground: 0 });
			// The same seams do run for a prompt that is planned.
			const planned = await runPromptSubmit({ ...input, prompt: NEW_WORK }, offDeps({ ...h.deps, config: trackedConfig() }));
			expect(planned.record).toBeDefined();
			expect(calls).toEqual({ recall: 1, ground: 1 });
		} finally {
			h.cleanup();
		}
	});

	test("child invocations and subagent sessions never look anything up, and still plan", async () => {
		const calls = { recall: 0, ground: 0 };
		const { deps, cleanup } = baseDeps({
			complete: smartComplete(),
			clarify: async () => [],
			recall: async () => {
				calls.recall++;
				return recalled;
			},
			ground: async () => {
				calls.ground++;
				return grounded;
			},
		});
		const saved = process.env.ULTRATHINK_CHILD;
		try {
			const subagent = { ...input, agent_id: "agent-7" };
			const sub = await runPromptSubmit(subagent, deps);
			expect(sub.record).toBeDefined();
			expect(contextOf(sub)).not.toContain("MARKER_L1");
			expect(calls).toEqual({ recall: 0, ground: 0 });

			process.env.ULTRATHINK_CHILD = "1";
			const child = await runPromptSubmit(input, deps);
			expect(child.record).toBeDefined();
			expect(contextOf(child)).not.toContain("MARKER_L1");
			expect(child.record).not.toHaveProperty("lessons");
			expect(calls).toEqual({ recall: 0, ground: 0 });
		} finally {
			if (saved === undefined) delete process.env.ULTRATHINK_CHILD;
			else process.env.ULTRATHINK_CHILD = saved;
			cleanup();
		}
	});

	test("the default wiring recalls from the local store and grounds only when configured, with no network", async () => {
		const R = recordingFetch([() => new Response("")]);
		const config = echoConfig();
		config.teach.enabled = true;
		config.ragflow.enabled = true;
		config.ragflow.ground = true;
		const { deps, cleanup } = baseDeps({ config, complete: smartComplete(), clarify: async () => [], decisionsDeps: { env: {}, storePath: tempStore(), fetch: R.fetch } });
		try {
			const result = await runPromptSubmit(input, deps);
			expect(result.record?.lessons).toMatchObject({ outcome: "none", count: 0, source: "none" });
			expect(result.record?.docs).toMatchObject({ status: "off", count: 0 });
			expect(contextOf(result)).not.toContain("## Lessons from earlier work");
			expect(R.calls).toHaveLength(0);

			// The kill switch beats the config.
			const killed = await runPromptSubmit(input, { ...deps, decisionsDeps: { env: { ULTRATHINK_TEACH: "0" }, storePath: tempStore(), fetch: R.fetch } });
			expect(killed.record?.lessons?.outcome).toBe("off");
			expect(R.calls).toHaveLength(0);
		} finally {
			cleanup();
		}
	});
});
