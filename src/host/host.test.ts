// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import { readControl, readSession, sessionPath, writeControl } from "../claude/state.ts";
import { defaultConfig } from "../config.ts";
import type { DecisionsErrorKind } from "../decisions/types.ts";
import type { Tracker } from "../track/gateway.ts";
import { writePlanCarrier } from "./carrier.ts";
import { detectHost } from "./detect.ts";
import { type EngineSelectionContext, type ModelResolution, type NativeEngineSelector, type SelectedEngine, selectNativeEngine } from "./engine.ts";
import { isSubagentEnvelope, normalizeEnvelope, parseEnvelope } from "./envelope.ts";
import { createNativeEnginePlanner, createNativeEngineSelector } from "./omp.ts";
import { fakeModel, fakeRuntime, quietConfig, recorder, reply, stageAnswer, userText } from "./omp-test.helpers.ts";
import { isPlanningPath, resolveStateDir } from "./paths.ts";
import { planPrompt, type PlanOptions, type PlanResponse } from "./plan.ts";
import type { ProgressEvent } from "./progress.ts";
import type { GroundOutcome } from "../ragflow/types.ts";
import type { RecallOutcome } from "../teach/types.ts";

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
	});

	test("Prime Agent's kernel and its bash children are Prime Agent, below an explicit host, the Grok markers and Muse", () => {
		expect(detectHost({ PRIME_AGENT_CODING_AGENT_DIR: "/root/.prime/agent" })).toBe("prime-agent");
		expect(detectHost({ RLM_SESSION_DIR: "/root/.prime/agent/session-artifacts/s1" })).toBe("prime-agent");
		expect(detectHost({ RLM_SESSION_DIR: "/s", CLAUDE_PLUGIN_ROOT: "/p", HERMES_HOME: "/h" })).toBe("prime-agent");
		expect(detectHost({ RLM_SESSION_DIR: "/s", GROK_SESSION_ID: "g" })).toBe("grok-build");
		expect(detectHost({ RLM_SESSION_DIR: "/s", MUSE_TOOL_USE_ID: "toolu_1" })).toBe("muse");
		expect(detectHost({ RLM_SESSION_DIR: "/s", ULTRATHINK_HOST: "hermes" })).toBe("hermes");
		expect(detectHost({ PRIME_AGENT_CODING_AGENT_DIR: " ", RLM_SESSION_DIR: "" })).toBe("claude-code");
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

	test("Prime Agent state goes under PRIME_AGENT_CODING_AGENT_DIR, else ~/.prime/agent, never the Claude directory", () => {
		expect(resolveStateDir({ ULTRATHINK_HOST: "prime-agent", PRIME_AGENT_CODING_AGENT_DIR: "/prime", CLAUDE_CONFIG_DIR: "/cfg" })).toBe(join("/prime", "ultrathink"));
		expect(resolveStateDir({ RLM_SESSION_DIR: "/prime/session-artifacts/s1", CLAUDE_CONFIG_DIR: "/cfg" })).toBe(join(homedir(), ".prime", "agent", "ultrathink"));
		expect(resolveStateDir({ ULTRATHINK_HOST: "prime-agent", PRIME_AGENT_CODING_AGENT_DIR: "/prime", ULTRATHINK_STATE_DIR: "/repo/.planning/x" })).toBe(join("/prime", "ultrathink"));
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

/** The honest record an injected stub engine carries: an explicit fake wire target, never a detected model. */
const STUB_RESOLUTION: ModelResolution = {
	version: "1.0.0",
	state: "override",
	host: "claude-code",
	transport: "claude-cli",
	source: "engine-model",
	reason: "explicit-model",
	engineSelection: { engine: "auto", source: "config", nativeOptOut: false },
	modelId: "stub",
	modelKnown: true,
	label: "claude:stub [override]",
};

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
				return { label: "stub", complete: stubComplete, error: () => undefined, resolution: STUB_RESOLUTION };
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

	test("uplift, the graph, every node fill and the HITL call share the one selected engine on every host, and the plan carries its record", async () => {
		for (const host of ["claude-code", "grok-build", "hermes", "muse", "omp"] as const) {
			const { root, env, options, calls } = planHarness();
			const phases: string[] = [];
			const completers = new Set<unknown>();
			const resolution: ModelResolution = { ...STUB_RESOLUTION, host };
			options.selectEngine = async () => {
				calls.engine++;
				const complete = async (system: string, user: string) => {
					completers.add(complete);
					phases.push(user.includes("<user_request>") ? "uplift" : user.startsWith("<spec>") ? "clarify" : user.includes("current_node") ? "fill" : "graph");
					return stubComplete(system, user);
				};
				return { label: `stub:${host}`, complete, error: () => undefined, resolution };
			};
			try {
				const response = await planPrompt({ host, session_id: "s1", prompt: "add a widget", cwd: root }, { ...env, PI_CODING_AGENT_DIR: join(root, "omp") }, options);
				expect(response.skipped).toBeUndefined();
				expect(calls.engine).toBe(1);
				expect(completers.size).toBe(1);
				expect(phases).toEqual(["uplift", "graph", "fill", "fill", "fill", "fill", "fill", "clarify"]);
				expect(response.modelResolution).toEqual(resolution);
				expect(readSession(env.ULTRATHINK_STATE_DIR, "s1")?.modelResolution).toEqual(resolution);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}
	});

	test("the selector receives the flight context: host, legacy model and provider evidence, session id, signal and native selector", async () => {
		const { root, env, options } = planHarness();
		const seen: Array<EngineSelectionContext | undefined> = [];
		const inner = options.selectEngine;
		options.selectEngine = (async (...args: Parameters<NonNullable<typeof inner>>) => {
			seen.push(args[3]);
			return inner!(...args);
		}) as typeof inner;
		const native: NativeEngineSelector = async () => {
			throw new Error("an injected selectEngine stays authoritative: the native selector is only handed over");
		};
		const controller = new AbortController();
		try {
			await planPrompt(
				{ host: "hermes", session_id: " s1 ", prompt: "add a widget", cwd: root, model: "grok-4.7", provider: "xai" },
				env,
				{ ...options, native, signal: controller.signal },
			);
			expect(seen[0]).toEqual({ host: "hermes", sessionModel: "grok-4.7", provider: "xai", sessionId: "s1", signal: controller.signal, native, purpose: "planning" });
			expect(seen[0]?.signal).toBe(controller.signal);
			expect(seen[0]?.native).toBe(native);
			await planPrompt({ host: "omp", prompt: "add a widget", cwd: root }, { ...env, PI_CODING_AGENT_DIR: join(root, "omp") }, options);
			expect(seen).toHaveLength(2);
			expect(seen[1]).toEqual({ host: "omp", purpose: "planning" });
			for (const key of ["sessionModel", "provider", "sessionId", "signal", "native"] as const) expect(seen[1]?.[key]).toBeUndefined();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("an engine child prompt skips before an engine is selected", async () => {
		const { root, env, options, calls } = planHarness();
		try {
			// Shaped like the prompt a nested hook receives; the literal keeps this
			// consumer-side pin independent of the producer constant in buildMusePrompt.
			const nested = "<!-- ultrathink-child-prompt -->\n<system>\nX\n</system>\n\n<user_request>\nadd a widget\n</user_request>";
			const response = await planPrompt({ host: "omp", session_id: "s1", prompt: nested, cwd: root }, env, options);
			expect(response).toEqual({ context: "", skipped: "nested-child" });
			expect(calls.engine).toBe(0);
		} finally {
			rmSync(root, { recursive: true, force: true });
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

// ---- Jev plan gate on the host path (planPrompt: Hermes, Muse, Omp) ----

const K = "sk-or-v1-UTTESTKEY-0123456789abcdef";
const ENDPOINT = "https://openrouter.ai/api/alpha/decisions";
interface Recorded {
	url: string;
	method: string;
	headers: Record<string, string>;
	body: unknown;
}

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
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

/** Never resolves; rejects with an AbortError when its signal fires. Installed as globalThis.fetch (planPrompt has no fetch seam). */
function hangingFetch(): void {
	globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) =>
		new Promise<Response>((_resolve, reject) => {
			init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
		})) as typeof fetch;
}

const ACK = "thanks, that works now";
const NEW_WORK = "Add OAuth login with GitHub to the web app";
const NOTICE_004 = "Prompt Uplift · not planned: Jev judged this is not new multi-step work (0.04) · start with uplift: to plan it";
const PLAN_HOSTS = ["hermes", "omp"] as const;

/**
 * planHarness plus `ON`: the user layer gains `decisions` (none when undefined = FRESH) and `extra` keys, the env holds
 * K and an empty temp credential store, and progress events are collected. `configure` rewrites the user layer.
 */
function jevPlanHarness(decisions: Record<string, unknown> | undefined, extra: Record<string, unknown> = {}) {
	const h = planHarness();
	const events: ProgressEvent[] = [];
	const configPath = join(h.root, "xdg", "ultrathink", "config.json");
	const trackers = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
	const configure = (layer: Record<string, unknown> | undefined, more: Record<string, unknown> = extra): void =>
		writeFileSync(configPath, JSON.stringify({ ...trackers, ...more, ...(layer ? { decisions: layer } : {}) }));
	configure(decisions);
	const env: Record<string, string> = {
		...h.env,
		OPENROUTER_API_KEY: K,
		ULTRATHINK_MCP_STORE: join(h.root, "mcp-credentials.json"),
		PI_CODING_AGENT_DIR: join(h.root, "omp"),
	};
	const options: PlanOptions = { ...h.options, progress: (event) => events.push(event) };
	return { ...h, env, options, events, configure, sessionFile: sessionPath(h.env.ULTRATHINK_STATE_DIR!, "s1") };
}

/** The planned context with the random graph id replaced, so two planned runs compare equal. */
function plannedContext(response: PlanResponse): string {
	return response.graphId ? response.context.replaceAll(response.graphId, "GRAPH") : response.context;
}

/** Rule T6: the key and a bearer header never appear in anything the run produced. */
function expectNoKey(...outputs: unknown[]): void {
	for (const output of outputs) {
		const text = typeof output === "string" ? output : (JSON.stringify(output) ?? "");
		expect(text).not.toContain(K);
		expect(text).not.toContain("Bearer sk-or-");
	}
}

/** The 4.1–4.9 failures on the plan point and the kind each maps to. */
const PLAN_FAILURES: ReadonlyArray<{ name: string; kind: DecisionsErrorKind; respond?: () => Response }> = [
	{ name: "401", kind: "auth", respond: ERR(401) },
	{ name: "402", kind: "credits", respond: ERR(402) },
	{ name: "400", kind: "bad-request", respond: ERR(400) },
	{ name: "429 then 429", kind: "rate-limit", respond: ERR(429) },
	{ name: "503 then 503", kind: "upstream", respond: ERR(503) },
	{ name: "a hanging request", kind: "timeout" },
	{ name: "invalid JSON", kind: "invalid-response", respond: () => new Response("not json", { status: 200 }) },
	{ name: "a missing answer key", kind: "invalid-response", respond: JEV(0.97, "not_asked") },
	{ name: "noul out of range", kind: "invalid-response", respond: JEV(1.5) },
];

describe("planPrompt with the Jev plan gate", () => {
	test("a fresh install sends nothing without a key, and consults Jev with one (AC-1.2, JEV-01)", async () => {
		for (const host of ["hermes", "muse", "omp"] as const) {
			const R = recordingFetch([JEV(0.97)]);
			// FRESH: no decisions key anywhere.
			const h = jevPlanHarness(undefined);
			try {
				delete h.env.OPENROUTER_API_KEY;
				const keyless = await planPrompt({ host, session_id: "s1", prompt: NEW_WORK, cwd: h.root }, h.env, h.options);
				expect(R.calls).toHaveLength(0);
				expect(keyless.skipped).toBeUndefined();
				expect(keyless.context).not.toBe("");
				expect(keyless.summary).not.toContain("Decisions ·");

				h.env.OPENROUTER_API_KEY = K;
				const keyed = await planPrompt({ host, session_id: "s1", prompt: NEW_WORK, cwd: h.root }, h.env, h.options);
				expect(R.calls).toHaveLength(1);
				expect(keyed.skipped).toBeUndefined();
				expect(keyed.context).not.toBe("");
				expect(keyed.summary).toContain("Decisions · plan 0.97");
			} finally {
				rmSync(h.root, { recursive: true, force: true });
			}
		}
	});

	test("a Jev skip keeps the selected resolution and notice without creating a plan; a deterministic skip has no selection (AC-3.1)", async () => {
		for (const host of PLAN_HOSTS) {
			const R = recordingFetch([JEV(0.04)]);
			const h = jevPlanHarness({ enabled: true });
			try {
				const trivial = await planPrompt({ host, session_id: "s1", prompt: "thanks", cwd: h.root }, h.env, h.options);
				expect(trivial).toEqual({ context: "", skipped: "precheck-skip" });
				expect(h.calls.engine).toBe(0);
				expect(h.events).toEqual([{ type: "end", at: expect.any(Number), outcome: "skipped", detail: "precheck-skip" }]);
				h.events.length = 0;

				const response = await planPrompt({ host, session_id: "s1", prompt: ACK, cwd: h.root }, h.env, h.options);
				expect(R.calls).toHaveLength(1);
				expect(R.calls[0]?.url).toBe(ENDPOINT);
				expect(response).toEqual({ context: "", skipped: "jev-skip", summary: NOTICE_004, modelResolution: STUB_RESOLUTION });
				expect(response.modelResolution).toBe(STUB_RESOLUTION);
				expect(h.calls.engine).toBe(1);
				// The terminal skip reports the model already selected, not a new unresolved selection.
				expect(h.events).toEqual([
					{ type: "end", at: expect.any(Number), outcome: "skipped", detail: "jev-skip", modelResolution: STUB_RESOLUTION },
				]);
				expect(h.calls.track).toBe(0);
				expect(existsSync(h.sessionFile)).toBe(false);
				expect(existsSync(h.sessionFile.replace(/\.json$/, ".xml"))).toBe(false);
				expect(existsSync(join(h.env.ULTRATHINK_STATE_DIR!, "last-plan.json"))).toBe(false);
				expectNoKey(response, h.events);
			} finally {
				rmSync(h.root, { recursive: true, force: true });
			}
		}
	});

	test("with claude.echo off a Jev skip keeps selected provenance in response and progress but has no summary (AC-3.3)", async () => {
		for (const host of PLAN_HOSTS) {
			recordingFetch([JEV(0.04)]);
			const h = jevPlanHarness({ enabled: true }, { claude: { echo: false } });
			try {
				const response = await planPrompt({ host, session_id: "s1", prompt: ACK, cwd: h.root }, h.env, h.options);
				expect(response).toEqual({ context: "", skipped: "jev-skip", modelResolution: STUB_RESOLUTION });
				expect(response.modelResolution).toBe(STUB_RESOLUTION);
				expect(h.events).toEqual([
					{ type: "end", at: expect.any(Number), outcome: "skipped", detail: "jev-skip", modelResolution: STUB_RESOLUTION },
				]);
				expect(h.calls.engine).toBe(1);
				expect(h.calls.track).toBe(0);
				expect(existsSync(h.sessionFile)).toBe(false);
			} finally {
				rmSync(h.root, { recursive: true, force: true });
			}
		}
	});

	test("new work Jev plans is planned as today, with the Decisions bit and the record in the session (AC-3.4)", async () => {
		for (const host of PLAN_HOSTS) {
			const R = recordingFetch([JEV(0.97)]);
			const h = jevPlanHarness({ enabled: true });
			try {
				const off = { ...h.env, ULTRATHINK_DECISIONS: "0" };
				const base = await planPrompt({ host, session_id: "s1", prompt: NEW_WORK, cwd: h.root }, off, h.options);
				const jev = await planPrompt({ host, session_id: "s1", prompt: NEW_WORK, cwd: h.root }, h.env, h.options);
				expect(R.calls).toHaveLength(1);
				expect(plannedContext(jev)).toBe(plannedContext(base));
				expect(jev.summary).toContain("Decisions · plan 0.97");
				expect(base.summary).not.toContain("Decisions ·");
				const session = readFileSync(h.sessionFile, "utf8");
				expect((JSON.parse(session) as { decisions?: unknown[] }).decisions).toEqual([
					expect.objectContaining({ point: "plan", p: 0.97, action: "plan" }),
				]);
				expectNoKey(jev, session);
			} finally {
				rmSync(h.root, { recursive: true, force: true });
			}
		}
	});

	test("a gsd-* skill invocation plans with zero requests and keeps the skill on the record (AC-3.6)", async () => {
		for (const host of PLAN_HOSTS) {
			const R = recordingFetch([JEV(0.01)]);
			const h = jevPlanHarness({ enabled: true });
			try {
				mkdirSync(join(h.root, ".claude", "skills", "gsd-quick"), { recursive: true });
				writeFileSync(join(h.root, ".claude", "skills", "gsd-quick", "SKILL.md"), "---\nname: gsd-quick\ndescription: Quick task\n---\nDo the quick task.\n");
				const response = await planPrompt({ host, session_id: "s1", prompt: "/gsd-quick 3", cwd: h.root }, h.env, h.options);
				expect(R.calls).toHaveLength(0);
				expect(response.context).not.toBe("");
				const record = JSON.parse(readFileSync(h.sessionFile, "utf8")) as { skill?: { name: string }; plan?: { graphId: string } };
				expect(record.skill?.name).toBe("gsd-quick");
				expect(record.plan?.graphId).toBe(response.graphId ?? "missing graph id");
			} finally {
				rmSync(h.root, { recursive: true, force: true });
			}
		}
	});

	test("uplift: plans with zero requests (AC-3.7)", async () => {
		for (const host of PLAN_HOSTS) {
			const R = recordingFetch([JEV(0.01)]);
			const h = jevPlanHarness({ enabled: true });
			try {
				const response = await planPrompt({ host, session_id: "s1", prompt: "uplift: thanks", cwd: h.root }, h.env, h.options);
				expect(R.calls).toHaveLength(0);
				expect(response.context).not.toBe("");
			} finally {
				rmSync(h.root, { recursive: true, force: true });
			}
		}
	});

	test("TRIVIAL_RE acks and every other deterministic skip send nothing and match today (AC-3.8, AC-3.9)", async () => {
		for (const host of PLAN_HOSTS) {
			const R = recordingFetch([JEV(0.01)]);
			const h = jevPlanHarness({ enabled: true });
			try {
				const run = (prompt: string) => planPrompt({ host, session_id: "s1", prompt, cwd: h.root }, h.env, h.options);
				const acks = ["yes", "ok", "thanks", "go ahead", "lgtm!"];
				for (const prompt of [...acks, "raw: add a flag", "/help", "<BUILD_PROMPT>add a flag</BUILD_PROMPT>"]) {
					h.configure({ enabled: false });
					const base = await run(prompt);
					h.configure({ enabled: true });
					const jev = await run(prompt);
					expect(jev).toEqual(base);
					expect(jev.context).toBe("");
					expect(jev.skipped).toBeDefined();
					if (acks.includes(prompt)) expect(jev).toEqual({ context: "", skipped: "precheck-skip" });
				}
				// Planning turned off by control state.
				writeControl(h.env.ULTRATHINK_STATE_DIR, { enabled: false });
				h.configure({ enabled: false });
				const offBase = await run(NEW_WORK);
				h.configure({ enabled: true });
				const off = await run(NEW_WORK);
				expect(off).toEqual(offBase);
				expect(off).toEqual({ context: "", skipped: "precheck-skip" });
				expect(R.calls).toHaveLength(0);
				expect(h.calls.engine).toBe(0);
			} finally {
				rmSync(h.root, { recursive: true, force: true });
			}
		}
	});

	test("an inactive plan point sends nothing and plans as today (AC-3.10)", async () => {
		for (const host of PLAN_HOSTS) {
			for (const points of [["ship"], []]) {
				const R = recordingFetch([JEV(0.01)]);
				const h = jevPlanHarness({ enabled: true, points });
				try {
					const off = { ...h.env, ULTRATHINK_DECISIONS: "0" };
					const base = await planPrompt({ host, session_id: "s1", prompt: ACK, cwd: h.root }, off, h.options);
					const jev = await planPrompt({ host, session_id: "s1", prompt: ACK, cwd: h.root }, h.env, h.options);
					expect(R.calls).toHaveLength(0);
					expect(jev.context).not.toBe("");
					expect(plannedContext(jev)).toBe(plannedContext(base));
					expect(jev.summary).not.toContain("Decisions ·");
				} finally {
					rmSync(h.root, { recursive: true, force: true });
				}
			}
		}
	});

	test("Hermes consults Jev exactly once per prompt, through planPrompt and runPromptSubmit (AC-3.11)", async () => {
		const R = recordingFetch([JEV(0.97)]);
		const h = jevPlanHarness({ enabled: true });
		try {
			const response = await planPrompt({ host: "hermes", session_id: "s1", prompt: NEW_WORK, cwd: h.root }, h.env, h.options);
			expect(response.context).not.toBe("");
			expect(R.calls).toHaveLength(1);
		} finally {
			rmSync(h.root, { recursive: true, force: true });
		}
	});

	test(
		"every plan failure kind plans exactly as today on Hermes and Omp and reports the kind (AC-4.11)",
		async () => {
			// planPrompt has no sleep seam: the 429 and 503 retries wait the real 125–375 ms jitter, and the hanging
			// case needs the real per-attempt AbortSignal.timeout, so it gets the shortest budget that proves `timeout`.
			for (const host of PLAN_HOSTS) {
				for (const failure of PLAN_FAILURES) {
					if (failure.respond) recordingFetch([failure.respond]);
					else hangingFetch();
					const h = jevPlanHarness({ enabled: false });
					try {
						const base = await planPrompt({ host, session_id: "s1", prompt: ACK, cwd: h.root }, h.env, h.options);
						h.configure({ enabled: true, points: ["plan"], timeoutMs: failure.respond ? 3000 : 50 });
						const jev = await planPrompt({ host, session_id: "s1", prompt: ACK, cwd: h.root }, h.env, h.options);
						expect(jev.context).not.toBe("");
						expect(plannedContext(jev)).toBe(plannedContext(base));
						expect(jev.summary).toContain(`Decisions · error (${failure.kind})`);
						const session = readFileSync(h.sessionFile, "utf8");
						expect((JSON.parse(session) as { decisions?: unknown[] }).decisions).toEqual([
							expect.objectContaining({ point: "plan", outcome: "error", error: failure.kind, action: "fail-open" }),
						]);
						expectNoKey(jev, session);
					} finally {
						rmSync(h.root, { recursive: true, force: true });
					}
				}
			}
		},
		60_000,
	);
});

describe("planPrompt lessons and documents", () => {
	const recalled: RecallOutcome = {
		status: "used",
		lessons: [
			{
				id: "l1",
				name: "Run migrations first MARKER_L1",
				description: "Seeding before migrating fails",
				body: `MARKER_L1 ${"run the migration before the seed script. ".repeat(60)}`,
				kind: "pitfall",
				project: "widgets",
				host: "hermes",
				occurrences: 2,
				createdAt: "2026-01-01T00:00:00.000Z",
				source: "local",
			},
		],
		source: "local",
		chars: 2_000,
		ms: 5,
	};
	const grounded: GroundOutcome = {
		status: "used",
		chunks: [{ id: "c1", content: "MARKER_D1 widgets are stored in the widgets table", documentName: "storage.md" }],
		chars: 120,
		ms: 7,
		datasets: 1,
	};

	test("Hermes, Muse, Omp and Claude plans all carry both sections, built from the prompt alone", async () => {
		for (const host of ["hermes", "muse", "omp", "claude-code"] as const) {
			const { root, env, options } = planHarness();
			const queries: string[] = [];
			try {
				const response = await planPrompt(
					{ host, session_id: "s1", prompt: "add a widget", cwd: root },
					{ ...env, PI_CODING_AGENT_DIR: join(root, "omp") },
					{
						...options,
						recall: async ({ query }) => {
							queries.push(query);
							return recalled;
						},
						ground: async ({ query }) => {
							queries.push(query);
							return grounded;
						},
					},
				);
				expect(response.skipped).toBeUndefined();
				expect(response.context).toContain("## Lessons from earlier work");
				expect(response.context).toContain("MARKER_L1");
				expect(response.context).toContain("## Documents (RAGFlow)");
				expect(response.context).toContain("MARKER_D1");
				expect(response.summary).toContain("Lessons · 1 recalled (local)");
				expect(response.summary).toContain("Docs · 1 excerpt (RAGFlow)");
				expect(queries).toEqual(["add a widget", "add a widget"]);
				// The handoff is budgeted; the carrier and the response carry the same context.
				if (host === "hermes") expect(response.context.length).toBeLessThanOrEqual(9_000);
				const record = JSON.parse(readFileSync(response.statePath ?? "", "utf8")) as { lessons?: { count: number }; docs?: { count: number } };
				expect(record.lessons?.count).toBe(1);
				expect(record.docs?.count).toBe(1);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}
	});

	test("a prompt that is skipped before planning never reaches either lookup", async () => {
		const { root, env, options } = planHarness();
		let calls = 0;
		try {
			const count = async (): Promise<never> => {
				calls++;
				throw new Error("must not run");
			};
			for (const prompt of ["ok", "raw: add a widget", "/help"]) {
				const response = await planPrompt({ host: "hermes", session_id: "s1", prompt, cwd: root }, env, { ...options, recall: count, ground: count });
				expect(response.context).toBe("");
			}
			expect(calls).toBe(0);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("planPrompt flight context, cancellation and the resolution record", () => {
	const ompEnv = (root: string, env: Record<string, string>): Record<string, string> => ({ ...env, PI_CODING_AGENT_DIR: join(root, "omp") });

	test("Omp auto runs every stage on the one native Model and resolver its flight selected, under the caller's lifetime; no secret leaves", async () => {
		const { root, env, options } = planHarness();
		delete options.selectEngine;
		const controller = new AbortController();
		const events: ProgressEvent[] = [];
		const model = {
			provider: "acme",
			id: "sol-1",
			api: "acme-chat",
			providerType: "acme",
			baseUrl: "https://SECRET-ENDPOINT.invalid/v1",
			headers: { authorization: "Bearer SECRET-TOKEN" },
		};
		const selections: Array<AbortSignal | undefined> = [];
		const bound: Array<{ resolver: () => Promise<string> }> = [];
		const stages: Array<{ phase: string; model: unknown; resolver: unknown; signal: AbortSignal | undefined }> = [];
		options.native = (intent, signal) => {
			selections.push(signal);
			return selectNativeEngine(
				intent,
				{ live: { model, source: "ctx.model" }, check: () => "usable", resolve: async () => undefined, catalogDefault: () => undefined },
				(chosen) => {
					// One auth route per flight: the resolver is created with the bound Model, never per stage.
					const resolver = async () => "SECRET-KEY";
					bound.push({ resolver });
					return async (system, user, stageSignal) => {
						const phase = user.includes("<user_request>") ? "uplift" : user.startsWith("<spec>") ? "clarify" : user.includes("current_node") ? "fill" : "graph";
						stages.push({ phase, model: chosen, resolver, signal: stageSignal });
						return stubComplete(system, user);
					};
				},
			);
		};
		try {
			const response = await planPrompt({ host: "omp", session_id: "s1", prompt: "add a widget", cwd: root }, ompEnv(root, env), {
				...options,
				signal: controller.signal,
				progress: (event) => events.push(event),
			});
			expect(response.skipped).toBeUndefined();
			expect(selections).toEqual([controller.signal]);
			expect(bound).toHaveLength(1);
			expect(stages.map((stage) => stage.phase)).toEqual(["uplift", "graph", "fill", "fill", "fill", "fill", "fill", "clarify"]);
			for (const stage of stages) {
				expect(stage.model).toBe(model);
				expect(stage.resolver).toBe(bound[0]?.resolver);
				expect(stage.signal?.aborted).toBe(false);
			}
			// PlanOptions.signal -> HookDeps.signal: every stage signal is the planning lifetime the caller aborts.
			controller.abort();
			expect(stages.every((stage) => stage.signal?.aborted)).toBe(true);
			const record: ModelResolution = {
				version: "1.0.0",
				state: "detected",
				host: "omp",
				transport: "omp-native",
				source: "ctx.model",
				reason: "live-model",
				engineSelection: { engine: "auto", source: "config", nativeOptOut: false },
				api: "acme-chat",
				providerType: "acme",
				provider: "acme",
				modelId: "sol-1",
				modelKnown: true,
				label: "omp-native:acme/sol-1 [detected]",
			};
			expect(response.modelResolution).toEqual(record);
			const session = readFileSync(response.statePath ?? "", "utf8");
			expect(readSession(env.ULTRATHINK_STATE_DIR!, "s1")?.modelResolution).toEqual(record);
			expect(events.find((event) => event.type === "begin")).toMatchObject({ modelResolution: record });
			expect(events.at(-1)).toMatchObject({ type: "end", outcome: "planned", modelResolution: record });
			for (const output of [JSON.stringify(response), session, JSON.stringify(events)]) expect(output).not.toContain("SECRET");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("native uplift preserves an individual BUILD_PROMPT over 4096 characters through downstream calls and current spec/state, ignoring nontext blocks", async () => {
		const { root, env } = planHarness();
		const stateDir = env.ULTRATHINK_STATE_DIR!;
		const tail = "NATIVE_XML_TAIL_BEYOND_4096";
		const body = `<SPECIFICATION>${"Preserve the exact widget requirement. ".repeat(150)}<ACCEPTANCE_CRITERIA>${tail}</ACCEPTANCE_CRITERIA></SPECIFICATION>`;
		const xml = `<BUILD_PROMPT><ORIGINAL>add a widget</ORIGINAL>${body}</BUILD_PROMPT>`;
		const split = xml.indexOf(tail) - 7;
		const ignoredThought = "IGNORED_NATIVE_THINKING";
		const ignoredTool = "IGNORED_NATIVE_TOOL";
		const toolMarker = join(root, "tool-must-not-run");
		const model = fakeModel("acme", "large-xml");
		const { runtime, log } = fakeRuntime([model]);
		const phases: string[] = [];
		const rec = recorder((call) => {
			const { stage, text } = stageAnswer(userText(call));
			phases.push(stage);
			return stage === "uplift"
				? reply([
					{ type: "thinking", thinking: ignoredThought },
					{ type: "text", text: xml.slice(0, split) },
					{ type: "toolCall", id: ignoredTool, name: "bash", arguments: { command: `touch '${toolMarker}'` } },
					{ type: "text", text: xml.slice(split) },
				], { stopReason: "toolUse" })
				: reply([{ type: "text", text }]);
		});
		const planner = createNativeEnginePlanner({ completeSimple: rec.complete, providerDefaults: {}, env: ompEnv(root, env) });
		try {
			expect(xml.length).toBeGreaterThan(4096);
			expect(xml.indexOf(tail)).toBeGreaterThan(4096);
			expect(split).toBeGreaterThan(4096);
			const plan = await planner(
				{ prompt: "add a widget", cwd: root, sessionId: "large-native", model, modelSource: "ctx.model", native: runtime, config: quietConfig(), control: {}, stateDir },
				new AbortController().signal,
			);
			expect(plan.skipped).toBeUndefined();
			expect(phases).toEqual(["uplift", "graph", "fill", "fill", "fill", "fill", "fill", "clarify"]);
			// The graph and each fill consume the whole individual uplift, not a reconstructed large handoff.
			expect(userText(rec.calls[1]!)).toBe(`add a widget\n\n${xml}`);
			for (const call of rec.calls.slice(2, 7)) expect(userText(call)).toContain(xml);
			expect(userText(rec.calls[7]!)).toContain(body);
			const record = readSession(stateDir, "large-native");
			const spec = readFileSync(sessionPath(stateDir, "large-native").replace(/\.json$/, ".xml"), "utf8");
			expect(record?.result).toMatchObject({ source: "llm", root: "BUILD_PROMPT", original: "add a widget" });
			expect(record?.degraded).toBeUndefined();
			expect(record?.graph?.nodes).toHaveLength(5);
			expect(record?.result.xml).toContain(xml.slice(0, -"</BUILD_PROMPT>".length));
			expect(record?.result.xml).toContain(body);
			expect(record?.result.xml.trimEnd().endsWith("</BUILD_PROMPT>")).toBe(true);
			expect(spec).toBe(`${record?.result.xml}\n`);
			expect(plan.context).toContain(record?.result.xml ?? "missing current spec");
			expect(log.resolvers).toHaveLength(1);
			for (const output of [record!.result.xml, spec, plan.context, ...rec.calls.map(userText)]) {
				expect(output).not.toContain(ignoredThought);
				expect(output).not.toContain(ignoredTool);
				expect(output).not.toContain(toolMarker);
			}
			for (const output of [record!.result.xml, spec, plan.context]) expect(output).toContain(tail);
			expect(existsSync(toolMarker)).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	for (const { name, think, hitl, expected } of [
		{ name: "think-off", think: false, hitl: true, expected: { uplift: 1, graph: 0, fill: 0, clarify: 1 } },
		{ name: "HITL-off", think: true, hitl: false, expected: { uplift: 1, graph: 1, fill: 5, clarify: 0 } },
		{ name: "both-off", think: false, hitl: false, expected: { uplift: 1, graph: 0, fill: 0, clarify: 0 } },
	] as const) {
		test(`native ${name} makes exactly zero completion calls for each disabled stage`, async () => {
			const { root, env } = planHarness();
			const stateDir = env.ULTRATHINK_STATE_DIR!;
			const model = fakeModel("acme", "stage-counts");
			const { runtime, log } = fakeRuntime([model]);
			const counts: Record<string, number> = { uplift: 0, graph: 0, fill: 0, clarify: 0 };
			const rec = recorder((call) => {
				const { stage, text } = stageAnswer(userText(call));
				counts[stage]++;
				return reply([{ type: "text", text }]);
			});
			const config = quietConfig();
			config.think.enabled = think;
			const planner = createNativeEnginePlanner({ completeSimple: rec.complete, providerDefaults: {}, env: ompEnv(root, env) });
			try {
				const plan = await planner(
					{ prompt: "add a widget", cwd: root, sessionId: name, model, modelSource: "ctx.model", native: runtime, config, control: { hitlEnabled: hitl }, stateDir },
					new AbortController().signal,
				);
				expect(plan.skipped).toBeUndefined();
				expect(counts).toEqual(expected);
				expect(rec.calls).toHaveLength(Object.values(expected).reduce<number>((sum, count) => sum + count, 0));
				expect(log.resolvers).toHaveLength(1);
				expect(rec.calls.every((call) => call.model === model && call.options?.apiKey === log.resolvers[0]?.key)).toBe(true);
				const record = readSession(stateDir, name);
				expect(record?.result.source).toBe("llm");
				if (think) expect(record?.graph?.nodes).toHaveLength(5);
				else expect(record?.graph).toBeUndefined();
				expect(record?.clarifications).toEqual([]);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		});
	}

	test("a named engine opts out of native planning: the native selector is never called", async () => {
		const { root, env, options } = planHarness();
		delete options.selectEngine;
		const controller = new AbortController();
		let nativeCalls = 0;
		try {
			const response = await planPrompt({ host: "omp", session_id: "s1", prompt: "add a widget", cwd: root }, ompEnv(root, env), {
				...options,
				control: { engine: "claude" },
				signal: controller.signal,
				native: async () => {
					nativeCalls++;
					throw new Error("a named engine must not reach the native selector");
				},
				// Stop the flight as it begins, so the legacy route spawns no CLI child.
				progress: (event) => {
					if (event.type === "begin") controller.abort();
				},
			});
			expect(nativeCalls).toBe(0);
			expect(response.skipped).toBe("aborted");
			expect(response.modelResolution).toMatchObject({
				host: "omp",
				transport: "claude-cli",
				engineSelection: { engine: "claude", source: "control", nativeOptOut: true },
			});
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("an unresolved selection returns empty context, its stable code, the notice as summary and the record; nothing is planned", async () => {
		const { root, env, options, calls } = planHarness();
		delete options.selectEngine;
		const events: ProgressEvent[] = [];
		const record: ModelResolution = {
			version: "1.0.0",
			state: "unresolved",
			host: "omp",
			transport: "omp-native",
			source: "none",
			reason: "native-unavailable",
			engineSelection: { engine: "auto", source: "config", nativeOptOut: false },
			modelKnown: false,
			label: "omp-native:unresolved [native-unavailable]",
		};
		try {
			const response = await planPrompt({ host: "omp", session_id: "s1", prompt: "add a widget", cwd: root }, ompEnv(root, env), {
				...options,
				progress: (event) => events.push(event),
			});
			expect(response).toEqual({
				context: "",
				skipped: "native-unavailable",
				summary: "Prompt Uplift skipped · omp-native:unresolved [native-unavailable]",
				modelResolution: record,
			});
			expect(events).toEqual([{ type: "end", at: expect.any(Number), outcome: "skipped", detail: "native-unavailable", modelResolution: record }]);
			expect(calls).toEqual({ engine: 0, createTracker: 0, track: 0 });
			expect(existsSync(sessionPath(env.ULTRATHINK_STATE_DIR!, "s1"))).toBe(false);

			// A selection skip without its own notice still gets the safe generated one.
			const invalid: ModelResolution = { ...STUB_RESOLUTION, state: "unresolved", reason: "selector-invalid", modelKnown: false, label: "claude:unresolved [selector-invalid]" };
			delete invalid.modelId;
			options.selectEngine = async () => ({ skipped: "selector-invalid", resolution: invalid });
			expect(await planPrompt({ host: "claude-code", session_id: "s1", prompt: "add a widget", cwd: root }, env, options)).toEqual({
				context: "",
				skipped: "selector-invalid",
				summary: "Prompt Uplift skipped · claude:unresolved [selector-invalid]",
				modelResolution: invalid,
			});
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("an ordinary error after selection keeps the same model record in the response and terminal progress", async () => {
		const { root, env, options, calls } = planHarness();
		const events: ProgressEvent[] = [];
		const privateError = ["private", "tracker", "failure"].join("-");
		const resolution: ModelResolution = {
			...STUB_RESOLUTION,
			host: "omp",
			state: "detected",
			transport: "omp-native",
			source: "ctx.model",
			reason: "live-model",
			provider: "acme",
			modelId: "sol-1",
			label: "omp-native:acme/sol-1 [detected]",
		};
		const before = structuredClone(resolution);
		let completions = 0;
		options.selectEngine = async () => {
			calls.engine++;
			return {
				label: resolution.label,
				resolution,
				error: () => undefined,
				complete: async (system, user) => {
					completions++;
					return stubComplete(system, user);
				},
			};
		};
		options.createTracker = () => {
			calls.createTracker++;
			throw new Error(privateError);
		};
		try {
			const response = await planPrompt({ host: "omp", session_id: "s1", prompt: "add a widget", cwd: root }, ompEnv(root, env), {
				...options,
				progress: (event) => events.push(event),
			});
			expect(response).toEqual({ context: "", skipped: "engine-error", modelResolution: resolution });
			expect(response.modelResolution).toBe(resolution);
			expect(events).toEqual([{ type: "end", at: expect.any(Number), outcome: "skipped", detail: "engine-error", modelResolution: resolution }]);
			expect(resolution).toEqual(before);
			expect(JSON.stringify({ response, events })).not.toContain(privateError);
			expect(calls).toEqual({ engine: 1, createTracker: 1, track: 0 });
			expect(completions).toBe(0);
			expect(existsSync(sessionPath(env.ULTRATHINK_STATE_DIR!, "s1"))).toBe(false);
			expect(existsSync(join(env.ULTRATHINK_STATE_DIR!, "last-plan.json"))).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("an ordinary selection error invents no model record in the response or terminal progress", async () => {
		const { root, env, options, calls } = planHarness();
		const events: ProgressEvent[] = [];
		options.selectEngine = async () => {
			calls.engine++;
			throw new Error("private selector failure");
		};
		try {
			const response = await planPrompt({ host: "omp", session_id: "s1", prompt: "add a widget", cwd: root }, ompEnv(root, env), {
				...options,
				progress: (event) => events.push(event),
			});
			expect(response).toEqual({ context: "", skipped: "engine-error" });
			expect(events).toEqual([{ type: "end", at: expect.any(Number), outcome: "skipped", detail: "engine-error" }]);
			expect(calls).toEqual({ engine: 1, createTracker: 0, track: 0 });
			expect(existsSync(sessionPath(env.ULTRATHINK_STATE_DIR!, "s1"))).toBe(false);
			expect(existsSync(join(env.ULTRATHINK_STATE_DIR!, "last-plan.json"))).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("a parser-flagged unknown host is unresolved / unsupported-host: no selection, host control or plan", async () => {
		const { root, env, options, calls } = planHarness();
		const stateDir = env.ULTRATHINK_STATE_DIR!;
		const events: ProgressEvent[] = [];
		const record: ModelResolution = {
			version: "1.0.0",
			state: "unresolved",
			host: "unknown",
			source: "none",
			reason: "unsupported-host",
			engineSelection: { engine: "auto", source: "config", nativeOptOut: false },
			modelKnown: false,
			label: "unknown:unresolved [unsupported-host]",
		};
		try {
			writeControl(stateDir, { skipOnce: true });
			const response = await planPrompt({ invalidHost: true, session_id: "s1", prompt: "add a widget", cwd: root }, env, {
				...options,
				progress: (event) => events.push(event),
			});
			expect(response).toEqual({
				context: "",
				skipped: "unsupported-host",
				summary: "Prompt Uplift skipped · unknown:unresolved [unsupported-host]",
				modelResolution: record,
			});
			expect(events).toEqual([{ type: "end", at: expect.any(Number), outcome: "skipped", detail: "unsupported-host", modelResolution: record }]);
			expect(calls).toEqual({ engine: 0, createTracker: 0, track: 0 });
			// No detected host's control is read or consumed, and nothing is written.
			expect(readControl(stateDir).skipOnce).toBe(true);
			expect(existsSync(sessionPath(stateDir, "s1"))).toBe(false);
			// Stateless skips still decide first; a captured named engine is reported as the control's request.
			expect(await planPrompt({ invalidHost: true, prompt: "  ", cwd: root }, env, options)).toEqual({ context: "", skipped: "empty" });
			const named = await planPrompt({ invalidHost: true, prompt: "add a widget", cwd: root }, env, { ...options, control: { engine: "claude" } });
			expect(named.modelResolution?.engineSelection).toEqual({ engine: "claude", source: "control", nativeOptOut: false });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("a flight cancelled before selection returns the aborted boundary with no selection, record or write", async () => {
		const { root, env, options, calls } = planHarness();
		const controller = new AbortController();
		controller.abort();
		const events: ProgressEvent[] = [];
		try {
			const response = await planPrompt({ host: "hermes", session_id: "s1", prompt: "add a widget", cwd: root }, env, {
				...options,
				signal: controller.signal,
				progress: (event) => events.push(event),
			});
			expect(response).toEqual({ context: "", skipped: "aborted" });
			expect(events).toEqual([expect.objectContaining({ type: "end", outcome: "skipped", detail: "aborted" })]);
			expect(calls).toEqual({ engine: 0, createTracker: 0, track: 0 });
			expect(existsSync(sessionPath(env.ULTRATHINK_STATE_DIR!, "s1"))).toBe(false);
			// Deterministic skips still decide first.
			expect(await planPrompt({ host: "hermes", prompt: "ok", cwd: root }, env, { ...options, signal: controller.signal })).toEqual({
				context: "",
				skipped: "precheck-skip",
			});
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("a native selector cancelled mid-lookup returns the aborted boundary without a record", async () => {
		const { root, env, options, calls } = planHarness();
		delete options.selectEngine;
		const controller = new AbortController();
		try {
			const response = await planPrompt({ host: "omp", session_id: "s1", prompt: "add a widget", cwd: root }, ompEnv(root, env), {
				...options,
				signal: controller.signal,
				native: async () => {
					controller.abort();
					throw new DOMException("aborted", "AbortError");
				},
			});
			expect(response).toEqual({ context: "", skipped: "aborted" });
			expect(calls).toEqual({ engine: 0, createTracker: 0, track: 0 });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("a cancellation during a stage returns the aborted boundary with the safe record; no session, tracker or carrier", async () => {
		for (const host of ["hermes", "omp"] as const) {
			const { root, env, options, calls } = planHarness();
			const controller = new AbortController();
			options.selectEngine = async () => {
				calls.engine++;
				return {
					label: "stub",
					error: () => undefined,
					resolution: STUB_RESOLUTION,
					complete: async (system: string, user: string) => {
						if (!user.includes("current_node")) return stubComplete(system, user);
						controller.abort();
						throw new DOMException("aborted", "AbortError");
					},
				};
			};
			try {
				const response = await planPrompt({ host, session_id: "s1", prompt: "add a widget", cwd: root }, ompEnv(root, env), {
					...options,
					signal: controller.signal,
				});
				expect({ host, response }).toEqual({ host, response: { context: "", skipped: "aborted", modelResolution: STUB_RESOLUTION } });
				expect(calls.track).toBe(0);
				expect(existsSync(sessionPath(env.ULTRATHINK_STATE_DIR!, "s1"))).toBe(false);
				expect(existsSync(join(env.ULTRATHINK_STATE_DIR!, "last-plan.json"))).toBe(false);
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		}
	});

	for (const at of ["uplift", "graph", "fill", "clarify"] as const) {
		for (const failure of ["AbortError", "aborted-result", "ordinary-error"] as const) {
			test(`native ${failure} during ${at} ${failure === "ordinary-error" ? "fails open" : "returns aborted without delivery"} with a live caller signal`, async () => {
				const { root, env, options, calls } = planHarness();
				delete options.selectEngine;
				env.ULTRATHINK_DECISIONS = "0";
				const controller = new AbortController();
				const stages: string[] = [];
				const signals: Array<AbortSignal | undefined> = [];
				const events: ProgressEvent[] = [];
				// Synthetic native Model, as in the native-binding suite; catalog cost/window fields are not used.
				const model = {
					provider: "acme",
					id: "sol-1",
					api: "acme-chat",
					providerType: "acme",
					baseUrl: "https://SECRET-ENDPOINT.invalid/v1",
					headers: { authorization: "Bearer SECRET-HEADER" },
					input: ["text"],
				} as unknown as Model<Api>;
				options.native = createNativeEngineSelector(
					{
						prompt: "add a widget",
						cwd: root,
						sessionId: "s1",
						model,
						modelSource: "ctx.model",
						native: {
							models: { current: () => model, resolve: () => model },
							modelRegistry: { resolver: () => async () => "SECRET-KEY" },
						},
					},
					controller.signal,
					{
						providerDefaults: {},
						completeSimple: async (_model, context, completionOptions) => {
							const message = context.messages[0];
							const user = message?.role === "user" && typeof message.content === "string" ? message.content : "";
							const phase = user.includes("<user_request>") ? "uplift" : user.startsWith("<spec>") ? "clarify" : user.includes("current_node") ? "fill" : "graph";
							stages.push(phase);
							signals.push(completionOptions?.signal);
							if (phase === at && failure !== "aborted-result") {
								if (failure === "AbortError") throw new DOMException("SECRET-PROVIDER-ERROR", "AbortError");
								throw new Error("SECRET-PROVIDER-ERROR");
							}
							const aborted = phase === at && failure === "aborted-result";
							const text = aborted ? "SECRET-PARTIAL-TEXT" : await stubComplete("", user);
							return {
								role: "assistant",
								content: [{ type: "text", text }],
								api: "acme-chat",
								provider: "acme",
								model: "sol-1",
								usage: {},
								stopReason: aborted ? "aborted" : "stop",
							} as unknown as AssistantMessage;
						},
					},
				);
				try {
					const response = await planPrompt({ host: "omp", session_id: "s1", prompt: "add a widget", cwd: root }, ompEnv(root, env), {
						...options,
						signal: controller.signal,
						progress: (event) => events.push(event),
					});
					const stateDir = env.ULTRATHINK_STATE_DIR!;
					const expected = ["uplift", "graph", "fill", "fill", "fill", "fill", "fill", "clarify"];
					expect(controller.signal.aborted).toBe(false);
					expect(response.modelResolution).toMatchObject({ state: "detected", host: "omp", transport: "omp-native", source: "ctx.model", provider: "acme", modelId: "sol-1" });
					if (failure === "ordinary-error") {
						expect(stages).toEqual(expected);
						expect(response.skipped).toBeUndefined();
						expect(response.context).not.toBe("");
						expect(readSession(stateDir, "s1")).toBeDefined();
						expect(existsSync(response.carrierPath ?? "")).toBe(true);
						expect(calls.track).toBe(at === "uplift" ? 0 : 1);
						expect(signals.every((signal) => signal?.aborted === false)).toBe(true);
					} else {
						expect(stages).toEqual(expected.slice(0, expected.indexOf(at) + 1));
						expect(response).toEqual({ context: "", skipped: "aborted", modelResolution: response.modelResolution });
						expect(calls.track).toBe(0);
						for (const path of [sessionPath(stateDir, "s1"), sessionPath(stateDir, "s1").replace(/\.json$/, ".xml"), join(stateDir, "last.json"), join(stateDir, "last-plan.json")]) {
							expect(existsSync(path)).toBe(false);
						}
						expect(signals.every((signal) => signal?.aborted === true)).toBe(true);
						expect(events.some((event) => event.type === "stage" && ["plan", "track", "state"].includes(event.stage))).toBe(false);
						expect(events.at(-1)).toMatchObject({ type: "end", outcome: "skipped", detail: "aborted", modelResolution: response.modelResolution });
					}
					expect(JSON.stringify({ response, events })).not.toContain("SECRET");
				} finally {
					controller.abort();
					rmSync(root, { recursive: true, force: true });
				}
			});
		}
	}

	test("a selector AbortError is classified as aborted even without an external signal or resolution", async () => {
		const { root, env, options, calls } = planHarness();
		options.selectEngine = async () => {
			throw new DOMException("provider cancelled", "AbortError");
		};
		try {
			const response = await planPrompt({ host: "omp", session_id: "s1", prompt: "add a widget", cwd: root }, ompEnv(root, env), options);
			expect(response).toEqual({ context: "", skipped: "aborted" });
			expect(calls.track).toBe(0);
			expect(existsSync(sessionPath(env.ULTRATHINK_STATE_DIR!, "s1"))).toBe(false);
			expect(existsSync(join(env.ULTRATHINK_STATE_DIR!, "last-plan.json"))).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("a flight cancelled once its plan is built delivers no context and writes no carrier", async () => {
		const { root, env, options } = planHarness();
		const controller = new AbortController();
		try {
			const response = await planPrompt({ host: "omp", session_id: "s1", prompt: "add a widget", cwd: root }, ompEnv(root, env), {
				...options,
				signal: controller.signal,
				// The caller cancels as runPromptSubmit reports its finished plan, before planPrompt delivers it.
				progress: (event) => {
					if (event.type === "end" && event.outcome === "planned") controller.abort();
				},
			});
			expect(response).toEqual({ context: "", skipped: "aborted", modelResolution: STUB_RESOLUTION });
			expect(existsSync(join(env.ULTRATHINK_STATE_DIR!, "last-plan.json"))).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("captured config, control and stateDir are used as given; skip-once is still consumed into that state directory", async () => {
		const { root, env, options } = planHarness();
		const stateDir = join(root, "captured-state");
		const config = defaultConfig();
		config.think.enabled = false;
		const control = { hitlEnabled: false };
		const seen: Array<Parameters<NonNullable<PlanOptions["selectEngine"]>>> = [];
		const inner = options.selectEngine!;
		options.selectEngine = async (...args) => {
			seen.push(args);
			return inner(...args);
		};
		try {
			const response = await planPrompt({ host: "hermes", session_id: "s1", prompt: "add a widget", cwd: root }, env, { ...options, config, control, stateDir });
			expect(response.statePath).toBe(sessionPath(stateDir, "s1"));
			expect(existsSync(sessionPath(env.ULTRATHINK_STATE_DIR!, "s1"))).toBe(false);
			expect(seen[0]?.[0]).toBe(config);
			expect(seen[0]?.[1]).toBe(control);
			const record = readSession(stateDir, "s1");
			expect(record?.graph).toBeUndefined();
			expect(record?.clarifications).toEqual([]);
			// A captured control is a value, not a store: an armed skip-once is consumed and saved in the state directory.
			const skipped = await planPrompt({ host: "hermes", session_id: "s1", prompt: "add a widget", cwd: root }, env, {
				...options,
				config,
				control: { skipOnce: true },
				stateDir,
			});
			expect(skipped).toEqual({ context: "", skipped: "precheck-skip" });
			expect(readControl(stateDir).skipOnce).toBe(false);
			expect(seen).toHaveLength(1);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
