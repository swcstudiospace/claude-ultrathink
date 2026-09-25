// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writePlanCarrier } from "./carrier.ts";
import { detectHost } from "./detect.ts";
import { isSubagentEnvelope, normalizeEnvelope, parseEnvelope } from "./envelope.ts";
import { isPlanningPath, resolveStateDir } from "./paths.ts";

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
