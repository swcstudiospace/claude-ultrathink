import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../config.ts";
import type { Clarification } from "../hitl/types.ts";
import { runPromptSubmit, type HookDeps, type PromptSubmitInput } from "./hook.ts";
import { readSession, writeSession } from "./state.ts";

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
		return graphJson(3);
	};
}

function baseDeps(overrides: Partial<HookDeps> = {}): { deps: HookDeps; cleanup: () => void } {
	const { dir, cleanup } = tempStateDir();
	const deps: HookDeps = {
		config: defaultConfig(),
		control: {},
		complete: async () => "<BUILD_PROMPT><ORIGINAL>add a widget</ORIGINAL></BUILD_PROMPT>",
		engine: "claude:sonnet",
		stateDir: dir,
		git: () => ({ repo: "acme/widgets", branch: "feat/widget" }),
		brief: async () => "",
		now: () => 1_000,
		log: () => {},
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
		});
		try {
			const result = await runPromptSubmit(input, deps);
			expect(result.output).toBeDefined();
			expect(result.record?.result.source).toBe("fallback");
			// Fallback output must not pollute the shared Notion/Linear tracker with
			// generic FALLBACK_GRAPH boilerplate rows — the turn proceeds untracked.
			expect(result.record?.plan).toBeUndefined();
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
			expect(plan?.issues).toHaveLength(3);
			// 3 nodes × 5 rationale steps: one Sub-Issue (and Linear sub-issue) per step, not per node.
			expect(plan?.subIssues).toHaveLength(15);
			expect(plan?.linearSubIssues).toHaveLength(15);
			for (const id of ["n1", "n2", "n3"]) {
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
			expect(result.record?.plan?.issues).toHaveLength(3);
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
});
