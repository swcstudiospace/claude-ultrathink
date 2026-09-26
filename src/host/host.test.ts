// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { readControl, writeControl } from "../claude/state.ts";
import type { Tracker } from "../track/gateway.ts";
import { writePlanCarrier } from "./carrier.ts";
import { detectHost } from "./detect.ts";
import type { SelectedEngine } from "./engine.ts";
import { isSubagentEnvelope, normalizeEnvelope, parseEnvelope } from "./envelope.ts";
import { isPlanningPath, resolveStateDir } from "./paths.ts";
import { planPrompt, type PlanOptions } from "./plan.ts";

describe("detectHost", () => {
	test("Grok markers win over Claude aliases, and an explicit host wins over both", () => {
		expect(detectHost({})).toBe("claude-code");
		expect(detectHost({ CLAUDE_PLUGIN_ROOT: "/claude", HERMES_HOME: "/hermes" })).toBe("claude-code");
		expect(detectHost({ GROK_PLUGIN_ROOT: "/grok", CLAUDE_PLUGIN_ROOT: "/claude" })).toBe("grok-build");
		expect(detectHost({ ULTRATHINK_HOST: "muse", GROK_PLUGIN_ROOT: "/grok" })).toBe("muse");
		expect(detectHost({ ULTRATHINK_HOST: "not-a-host" })).toBe("claude-code");
	});

	test("Muse tool and plugin processes are Muse, below an explicit host and the Grok markers", () => {
		expect(detectHost({ MUSE_TOOL_USE_ID: "toolu_1", CLAUDE_PLUGIN_ROOT: "/p" })).toBe("muse");
		expect(detectHost({ MUSE_PLUGIN_ID: "ultrathink", CLAUDE_PLUGIN_ROOT: "/p" })).toBe("muse");
		expect(detectHost({ MUSE_TOOL_USE_ID: "toolu_1", GROK_SESSION_ID: "g" })).toBe("grok-build");
		expect(detectHost({ MUSE_TOOL_USE_ID: "toolu_1", ULTRATHINK_HOST: "claude-code" })).toBe("claude-code");
		expect(detectHost({ MUSE_TOOL_USE_ID: "  " })).toBe("claude-code");
		// `bin/ultrathink` run from Muse's shell tool writes Muse's control state, not Claude's.
		expect(resolveStateDir({ MUSE_TOOL_USE_ID: "toolu_1", XDG_CONFIG_HOME: "/xdg", CLAUDE_CONFIG_DIR: "/cfg" })).toBe(
			join("/xdg", "muse", "ultrathink"),
		);
	});
});

describe("normalizeEnvelope", () => {
	test("snake_case round-trips and wins when both shapes are present", () => {
		const claude = {
			session_id: "s1",
			hook_event_name: "UserPromptSubmit",
			prompt: "add a widget",
			tool_name: "Bash",
			stop_hook_active: false,
		};
		expect(normalizeEnvelope(claude)).toMatchObject(claude);
		expect(
			normalizeEnvelope({
				session_id: "snake",
				sessionId: "camel",
				tool_name: "Bash",
				toolName: "run_terminal_command",
			}).session_id,
		).toBe("snake");
	});

	test("maps a Grok camelCase envelope onto the fields the hooks already read", () => {
		expect(
			normalizeEnvelope({
				hookEventName: "user_prompt_submit",
				sessionId: "abc-123",
				workspaceRoot: "/repo",
				userPrompt: "ship it",
				toolName: "run_terminal_command",
				toolInput: { command: "npm test" },
				toolResult: "ok",
				stopHookActive: true,
			}),
		).toMatchObject({
			session_id: "abc-123",
			cwd: "/repo",
			prompt: "ship it",
			tool_name: "run_terminal_command",
			tool_input: { command: "npm test" },
			tool_response: "ok",
			stop_hook_active: true,
			hook_event_name: "UserPromptSubmit",
		});
	});

	test("malformed input normalises to an empty object", () => {
		expect(parseEnvelope("")).toEqual({});
		expect(parseEnvelope("{")).toEqual({});
		expect(normalizeEnvelope(null)).toEqual({});
		expect(normalizeEnvelope(["nope"])).toEqual({});
	});
});

describe("isSubagentEnvelope", () => {
	test("flags Grok subagentType and Claude agent_type/agent_id, never a main session", () => {
		const grokSub = parseEnvelope(
			JSON.stringify({ hookEventName: "user_prompt_submit", sessionId: "g1", subagentType: "explore" }),
		);
		expect(grokSub.subagent_type).toBe("explore");
		expect(isSubagentEnvelope(grokSub)).toBe(true);
		expect(isSubagentEnvelope(parseEnvelope(JSON.stringify({ session_id: "c1", agent_type: "general-purpose" })))).toBe(
			true,
		);
		expect(isSubagentEnvelope(parseEnvelope(JSON.stringify({ session_id: "c1", agent_id: "a-9" })))).toBe(true);

		expect(
			isSubagentEnvelope(
				parseEnvelope(JSON.stringify({ hookEventName: "user_prompt_submit", sessionId: "g1", userPrompt: "ship it" })),
			),
		).toBe(false);
		expect(
			isSubagentEnvelope(parseEnvelope(JSON.stringify({ session_id: "c1", hook_event_name: "UserPromptSubmit" }))),
		).toBe(false);
		expect(isSubagentEnvelope(normalizeEnvelope({ subagentType: "", agent_type: " ", agent_id: "" }))).toBe(false);
	});
});

describe("resolveStateDir", () => {
	test("keeps the Claude default and refuses a planning-tree override", () => {
		expect(resolveStateDir({ ULTRATHINK_STATE_DIR: "/x" })).toBe("/x");
		expect(resolveStateDir({ CLAUDE_CONFIG_DIR: "/cfg" })).toBe(join("/cfg", "ultrathink"));
		expect(resolveStateDir({}).endsWith(join(".claude", "ultrathink"))).toBe(true);
		expect(isPlanningPath("/repo/.planning/phases")).toBe(true);
		const refused = resolveStateDir({
			ULTRATHINK_STATE_DIR: "/repo/.planning/ultrathink",
			CLAUDE_CONFIG_DIR: "/cfg",
		});
		expect(refused).toBe(join("/cfg", "ultrathink"));
		expect(refused.includes(".planning")).toBe(false);
	});

	test("scopes Grok, Hermes, Muse, and Omp away from the Claude directory", () => {
		expect(resolveStateDir({ GROK_PLUGIN_ROOT: "/plugin", GROK_PLUGIN_DATA: "/grok-data", CLAUDE_CONFIG_DIR: "/cfg" })).toBe(
			join("/grok-data", "ultrathink"),
		);
		expect(resolveStateDir({ ULTRATHINK_HOST: "hermes", HERMES_HOME: "/hermes" })).toBe(join("/hermes", "ultrathink"));
		expect(resolveStateDir({ ULTRATHINK_HOST: "muse", XDG_CONFIG_HOME: "/xdg" })).toBe(join("/xdg", "muse", "ultrathink"));
		expect(resolveStateDir({ ULTRATHINK_HOST: "omp", PI_CODING_AGENT_DIR: "/omp" })).toBe(join("/omp", "ultrathink"));
	});

	test("Grok state goes under GROK_PLUGIN_DATA, else GROK_HOME, else ~/.grok", () => {
		const grok = { GROK_SESSION_ID: "g1" };
		const underHome = join("/grok-home", "plugin-data", "ultrathink");
		expect(resolveStateDir({ ...grok, GROK_HOME: "/grok-home" })).toBe(underHome);
		expect(resolveStateDir({ ...grok, GROK_HOME: "/grok-home", GROK_PLUGIN_DATA: "/grok-data" })).toBe(join("/grok-data", "ultrathink"));
		expect(resolveStateDir({ ...grok, GROK_HOME: "  ", GROK_PLUGIN_DATA: " " })).toBe(
			join(homedir(), ".grok", "plugin-data", "ultrathink"),
		);
		// A planning-tree override is still refused in favour of the GROK_HOME directory.
		expect(resolveStateDir({ ...grok, GROK_HOME: "/grok-home", ULTRATHINK_STATE_DIR: "/repo/.planning/ultrathink" })).toBe(underHome);
	});
});

describe("writePlanCarrier", () => {
	test("writes a subordinate pointer and refuses an unknown session id", () => {
		const dir = mkdtempSync(join(tmpdir(), "ultrathink-carrier-"));
		try {
			expect(writePlanCarrier({ host: "grok-build", stateDir: dir, sessionId: "unknown", specPath: "/s.xml" })).toBeUndefined();
			const path = writePlanCarrier({
				host: "grok-build",
				stateDir: dir,
				sessionId: "s1",
				specPath: "/tmp/s1.xml",
				context: "<BUILD_PROMPT/>",
				graphId: "ut-1",
			});
			expect(path).toBe(join(dir, "last-plan.json"));
			const body = JSON.parse(readFileSync(path!, "utf8")) as { instruction: string; graphId: string };
			expect(body.graphId).toBe("ut-1");
			expect(body.instruction).not.toMatch(/execute it/i);
			expect(body.instruction).toContain("ultrathink-kickoff");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

/** Dispatches by payload so one fake answers the uplift, graph, node, and clarify calls. */
async function stubComplete(_system: string, user: string): Promise<string> {
	if (user.includes("<user_request>")) return "<BUILD_PROMPT><ORIGINAL>add a widget</ORIGINAL></BUILD_PROMPT>";
	if (user.startsWith("<spec>")) return JSON.stringify({ questions: [] });
	if (user.includes("current_node")) {
		const id = user.match(/current_node id="([^"]+)"/)?.[1] ?? "n?";
		const steps = Array.from({ length: 5 }, (_, i) => `${i + 1}. ${id} step ${i + 1}`).join(" ");
		return `<node><rationale>${steps}</rationale><conclusion>c ${id}</conclusion></node>`;
	}
	return JSON.stringify({
		goal: "Ship it",
		nodes: Array.from({ length: 5 }, (_, i) => ({
			id: `n${i + 1}`,
			title: `T${i + 1}`,
			kind: i === 0 ? "understand" : i === 4 ? "synthesize" : "generate",
			question: `Q${i + 1}`,
			depends_on: i === 0 ? [] : [`n${i}`],
		})),
	});
}

/** An isolated home with Linear and Notion configured, and seams that count engine and tracker use. */
function planHarness(): {
	root: string;
	env: Record<string, string>;
	options: PlanOptions;
	calls: { engine: number; createTracker: number; track: number };
} {
	const root = mkdtempSync(join(tmpdir(), "ultrathink-plan-"));
	mkdirSync(join(root, "xdg", "ultrathink"), { recursive: true });
	writeFileSync(
		join(root, "xdg", "ultrathink", "config.json"),
		JSON.stringify({ linear: { team: "Team" }, notion: { dataSourceUrl: "collection://ds" } }),
	);
	const calls = { engine: 0, createTracker: 0, track: 0 };
	const track: Tracker = async () => {
		calls.track++;
		return undefined;
	};
	return {
		root,
		env: {
			XDG_CONFIG_HOME: join(root, "xdg"),
			CLAUDE_CONFIG_DIR: join(root, "claude"),
			ULTRATHINK_STATE_DIR: join(root, "state"),
			SUBSTRATE_DISABLED: "1",
		},
		options: {
			selectEngine: async (): Promise<SelectedEngine> => {
				calls.engine++;
				return { label: "stub", complete: stubComplete, error: () => undefined };
			},
			createTracker: () => {
				calls.createTracker++;
				return track;
			},
		},
		calls,
	};
}

const HERMES_SKILL =
	'[IMPORTANT: The user has invoked the "gsd-quick" skill, indicating they want you to follow its instructions. The full skill content is loaded below.]\n\n---\nname: gsd-quick\ndescription: Quick task\n---\nDo the quick task.';

describe("planPrompt", () => {
	test("Hermes plans without a hook-side tracker; other hosts still track", async () => {
		for (const [host, tracked] of [
			["hermes", 0],
			["claude-code", 1],
		] as const) {
			const { root, env, options, calls } = planHarness();
			try {
				const response = await planPrompt({ host, session_id: "s1", prompt: "add a widget", cwd: root }, env, options);
				expect(response.skipped).toBeUndefined();
				// Hermes gets a handoff that points at the spec file; the planned prompt lives there on every host.
				expect(response.specPath && readFileSync(response.specPath, "utf8")).toContain("add a widget");
				expect(response.context).toContain(response.specPath ?? "missing spec path");
				expect(calls).toEqual({ engine: 1, createTracker: tracked, track: tracked });
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}
	});

	test("stateless skips return before an engine is selected", async () => {
		const { root, env, options, calls } = planHarness();
		try {
			for (const [prompt, reason] of [
				["ok", "precheck-skip"],
				["raw: add a widget", "precheck-passthrough"],
				["<BUILD_PROMPT>add a widget</BUILD_PROMPT>", "precheck-skip"],
				["Implement node n2 of graph ut-mughkkc0-1a2b3c4d.", "precheck-skip"],
			] as const) {
				expect(await planPrompt({ host: "hermes", prompt, cwd: root }, env, options)).toEqual({ context: "", skipped: reason });
			}
			expect(calls.engine).toBe(0);
			const forced = await planPrompt(
				{ host: "hermes", prompt: "uplift: Implement node n2 of graph ut-mughkkc0-1a2b3c4d.", cwd: root },
				env,
				options,
			);
			expect(forced.skipped).toBeUndefined();
			expect(calls.engine).toBe(1);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("a Hermes skill preamble plans only when it carries a task", async () => {
		const { root, env, options, calls } = planHarness();
		try {
			const instructed = (instruction: string) =>
				`${HERMES_SKILL}\n\nThe user has provided the following instruction alongside the skill invocation: ${instruction}`;
			for (const prompt of [HERMES_SKILL, instructed("ok")]) {
				expect(await planPrompt({ host: "hermes", prompt, cwd: root }, env, options)).toEqual({
					context: "",
					skipped: "skill-preamble",
				});
			}
			expect(calls.engine).toBe(0);
			const planned = await planPrompt({ host: "hermes", prompt: instructed("add a widget"), cwd: root }, env, options);
			expect(planned.skipped).toBeUndefined();
			expect(calls.engine).toBe(1);
			// Other hosts keep planning a bare skill from its objective.
			const claude = await planPrompt({ host: "claude-code", prompt: HERMES_SKILL, cwd: root }, env, options);
			expect(claude.skipped).toBeUndefined();
			expect(calls.engine).toBe(2);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("an armed /ultrathink-skip is consumed before engine selection by a trivial or bare-preamble prompt on Hermes and Omp", async () => {
		for (const host of ["hermes", "omp"] as const) {
			const { root, env, options, calls } = planHarness();
			const stateDir = env.ULTRATHINK_STATE_DIR!;
			const hostEnv = { ...env, PI_CODING_AGENT_DIR: join(root, "omp") };
			try {
				for (const prompt of ["ok", HERMES_SKILL]) {
					writeControl(stateDir, { skipOnce: true });
					expect(await planPrompt({ host, prompt, cwd: root }, hostEnv, options)).toEqual({ context: "", skipped: "precheck-skip" });
					expect(readControl(stateDir).skipOnce).toBe(false);
				}
				// Consumed before engine selection, so an engine that is unavailable (e.g. a Grok login) cannot leave it armed.
				expect(calls.engine).toBe(0);
				// Stateless skips that never consume the skip on Claude leave it armed here too.
				writeControl(stateDir, { skipOnce: true });
				expect(await planPrompt({ host, prompt: "<BUILD_PROMPT>x</BUILD_PROMPT>", cwd: root }, hostEnv, options)).toEqual({
					context: "",
					skipped: "precheck-skip",
				});
				expect(readControl(stateDir).skipOnce).toBe(true);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}
	});
});
