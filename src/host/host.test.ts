// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { readControl, sessionPath, writeControl } from "../claude/state.ts";
import type { DecisionsErrorKind } from "../decisions/types.ts";
import type { Tracker } from "../track/gateway.ts";
import { writePlanCarrier } from "./carrier.ts";
import { detectHost } from "./detect.ts";
import type { SelectedEngine } from "./engine.ts";
import { isSubagentEnvelope, normalizeEnvelope, parseEnvelope } from "./envelope.ts";
import { isPlanningPath, resolveStateDir } from "./paths.ts";
import { planPrompt, type PlanOptions, type PlanResponse } from "./plan.ts";
import type { ProgressEvent } from "./progress.ts";

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
	test("a fresh install sends nothing on Hermes, Muse and Omp and plans as today (AC-1.2)", async () => {
		for (const host of ["hermes", "muse", "omp"] as const) {
			const R = recordingFetch([JEV(0.01)]);
			const h = jevPlanHarness(undefined);
			try {
				// FRESH: no decisions key anywhere, yet K is both stored and in the environment.
				writeFileSync(
					h.env.ULTRATHINK_MCP_STORE,
					JSON.stringify({ version: 1, providers: { openrouter: { kind: "api_key", apiKey: K, updatedAt: 1 } } }),
					{ mode: 0o600 },
				);
				const response = await planPrompt({ host, session_id: "s1", prompt: NEW_WORK, cwd: h.root }, h.env, h.options);
				expect(R.calls).toHaveLength(0);
				expect(response.skipped).toBeUndefined();
				expect(response.context).not.toBe("");
				expect(response.summary).not.toContain("Decisions ·");
			} finally {
				rmSync(h.root, { recursive: true, force: true });
			}
		}
	});

	test("an acknowledgement Jev skips is not planned, like a deterministic skip, with the notice as summary (AC-3.1)", async () => {
		for (const host of PLAN_HOSTS) {
			const R = recordingFetch([JEV(0.04)]);
			const h = jevPlanHarness({ enabled: true });
			try {
				const trivial = await planPrompt({ host, session_id: "s1", prompt: "thanks", cwd: h.root }, h.env, h.options);
				expect(trivial).toEqual({ context: "", skipped: "precheck-skip" });
				h.events.length = 0;

				const response = await planPrompt({ host, session_id: "s1", prompt: ACK, cwd: h.root }, h.env, h.options);
				expect(R.calls).toHaveLength(1);
				expect(R.calls[0]?.url).toBe(ENDPOINT);
				expect(response).toEqual({ context: "", skipped: "jev-skip", summary: NOTICE_004 });
				expect(Object.keys(response).filter((key) => key !== "summary")).toEqual(Object.keys(trivial));
				// The skip reaches the host's progress sink exactly as every other skip does (Omp bar: skipped · jev-skip).
				expect(h.events).toEqual([expect.objectContaining({ type: "end", outcome: "skipped", detail: "jev-skip" })]);
				expect(h.calls.track).toBe(0);
				expect(existsSync(h.sessionFile)).toBe(false);
				expectNoKey(response, h.events);
			} finally {
				rmSync(h.root, { recursive: true, force: true });
			}
		}
	});

	test("with claude.echo off a Jev skip has no summary (AC-3.3)", async () => {
		for (const host of PLAN_HOSTS) {
			recordingFetch([JEV(0.04)]);
			const h = jevPlanHarness({ enabled: true }, { claude: { echo: false } });
			try {
				const response = await planPrompt({ host, session_id: "s1", prompt: ACK, cwd: h.root }, h.env, h.options);
				expect(response).toEqual({ context: "", skipped: "jev-skip" });
			} finally {
				rmSync(h.root, { recursive: true, force: true });
			}
		}
	});

	test("new work Jev plans is planned as today, with the Decisions bit and the record in the session (AC-3.4)", async () => {
		for (const host of PLAN_HOSTS) {
			const R = recordingFetch([JEV(0.97)]);
			const h = jevPlanHarness({ enabled: false });
			try {
				const base = await planPrompt({ host, session_id: "s1", prompt: NEW_WORK, cwd: h.root }, h.env, h.options);
				h.configure({ enabled: true });
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
				const h = jevPlanHarness({ enabled: false });
				try {
					const base = await planPrompt({ host, session_id: "s1", prompt: ACK, cwd: h.root }, h.env, h.options);
					h.configure({ enabled: true, points });
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
