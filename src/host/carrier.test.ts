// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { carrierPath, clearPlanCarrier, writePlanCarrier } from "./carrier.ts";
import { claimTurn } from "./claim.ts";

const HOOK = join(import.meta.dir, "..", "..", "hooks", "uplift.ts");

let dir: string;
let stateDir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ultrathink-carrier-"));
	stateDir = join(dir, "state");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function writeStalePlan(): string {
	const path = writePlanCarrier({ host: "grok-build", stateDir, sessionId: "s0", context: "<spec>old prompt</spec>" });
	if (!path) throw new Error("stale carrier not written");
	return path;
}

describe("clearPlanCarrier", () => {
	test("removes the carrier", () => {
		const path = writeStalePlan();
		clearPlanCarrier(stateDir);
		expect(existsSync(path)).toBe(false);
	});

	test("a missing carrier or state dir is fine", () => {
		expect(() => clearPlanCarrier(stateDir)).not.toThrow();
		mkdirSync(stateDir, { recursive: true });
		clearPlanCarrier(stateDir);
		expect(existsSync(carrierPath(stateDir))).toBe(false);
	});
});

describe("writePlanCarrier", () => {
	test("writes the carrier owner-only in a new owner-only state dir, replacing the previous one whole", () => {
		const path = writePlanCarrier({ host: "grok-build", stateDir, sessionId: "s1", specPath: "/s/s1.xml", statePath: "/s/s1.json", graphId: "ut-1", context: "first" });
		expect(path).toBe(carrierPath(stateDir));
		expect(JSON.parse(readFileSync(carrierPath(stateDir), "utf8"))).toMatchObject({ host: "grok-build", sessionId: "s1", specPath: "/s/s1.xml", graphId: "ut-1", context: "first" });
		if (process.platform !== "win32") {
			expect(statSync(carrierPath(stateDir)).mode & 0o777).toBe(0o600);
			expect(statSync(stateDir).mode & 0o777).toBe(0o700);
		}
		writePlanCarrier({ host: "grok-build", stateDir, sessionId: "s2", context: "second" });
		expect(JSON.parse(readFileSync(carrierPath(stateDir), "utf8"))).toMatchObject({ sessionId: "s2", context: "second" });
		expect(readdirSync(stateDir)).toEqual(["last-plan.json"]);
	});

	test.skipIf(process.platform === "win32")("a 0644 carrier from an older version is 0600 after the next write", () => {
		mkdirSync(stateDir, { recursive: true });
		writeFileSync(carrierPath(stateDir), "{}", { mode: 0o644 });
		writePlanCarrier({ host: "omp", stateDir, sessionId: "s1", context: "ctx" });
		expect(statSync(carrierPath(stateDir)).mode & 0o777).toBe(0o600);
	});
});

describe("uplift hook on Grok", () => {
	function runHook(envelope: Record<string, unknown>): string {
		const home = join(dir, "home");
		mkdirSync(home, { recursive: true });
		const env: Record<string, string | undefined> = {};
		for (const [key, value] of Object.entries(process.env)) {
			if (!key.startsWith("ULTRATHINK_") && !key.startsWith("GROK_") && key !== "CLAUDE_CONFIG_DIR") env[key] = value;
		}
		const proc = Bun.spawnSync([process.execPath, HOOK], {
			cwd: dir,
			env: { ...env, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), ULTRATHINK_HOST: "grok-build", ULTRATHINK_STATE_DIR: stateDir },
			stdin: Buffer.from(JSON.stringify({ hookEventName: "user_prompt_submit", cwd: dir, ...envelope })),
			stdout: "pipe",
			stderr: "pipe",
			timeout: 30_000,
		});
		expect(proc.exitCode).toBe(0);
		return proc.stdout.toString();
	}

	test("prompts that end without a plan remove the previous prompt's carrier", () => {
		for (const prompt of ["/ultrathink-quick fix the typo", "/model sonnet", "ok"]) {
			const path = writeStalePlan();
			runHook({ sessionId: "s1", promptId: prompt, userPrompt: prompt });
			expect(existsSync(path)).toBe(false);
		}
	});

	test("control commands and prompts while planning is off remove the carrier", () => {
		const path = writeStalePlan();
		expect(JSON.parse(runHook({ sessionId: "s1", promptId: "p1", userPrompt: "/ultrathink-off" }))).toMatchObject({ decision: "block" });
		expect(existsSync(path)).toBe(false);
		writeStalePlan();
		runHook({ sessionId: "s1", promptId: "p2", userPrompt: "refactor the billing module to use the new ledger api" });
		expect(existsSync(path)).toBe(false);
	});

	test("a duplicate dispatch of a claimed turn leaves the owner's carrier alone", () => {
		const path = writeStalePlan();
		expect(claimTurn(stateDir, "s1:p1")).toBe(true);
		runHook({ sessionId: "s1", promptId: "p1", userPrompt: "refactor the billing module to use the new ledger api" });
		expect(existsSync(path)).toBe(true);
	});

	test("a subagent prompt leaves the main session's carrier alone", () => {
		const path = writeStalePlan();
		runHook({ sessionId: "s1", promptId: "p2", subagentType: "explore", userPrompt: "/ultrathink-quick look around" });
		expect(existsSync(path)).toBe(true);
	});
});

describe("uplift hook with a Jev plan skip", () => {
	const K = "sk-or-v1-UTTESTKEY-0123456789abcdef";
	const ACK = "thanks, that works now";
	const NOTICE_004 = "Prompt Uplift · not planned: Jev judged this is not new multi-step work (0.04) · start with uplift: to plan it";

	/** A loopback Decisions endpoint that always answers JEV(p) and records each request body. */
	function fakeJev(p: number): { url: string; requests: Array<Record<string, unknown>>; stop: () => void } {
		const requests: Array<Record<string, unknown>> = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			async fetch(request) {
				requests.push((await request.json()) as Record<string, unknown>);
				return Response.json({
					id: "gen-dec-test",
					model: "typesafe/jev-1.13-20260917",
					provider: "TypeSafe",
					answers: { plan_worthy: { type: "noul", noul: p } },
					usage: { input_tokens: 450, output_tokens: 0, cost: 0.000019 },
				});
			},
		});
		return { url: `http://127.0.0.1:${server.port}/decisions`, requests, stop: () => server.stop(true) };
	}

	/**
	 * Runs hooks/uplift.ts as `host` with `ON` (user layer `config`, K in the env, an empty temp store) pointed at the
	 * loopback endpoint. Async spawn: a blocking spawn would starve the fake server's event loop. `claude.bin` names a
	 * missing binary so a run that wrongly plans can never reach a real engine.
	 */
	async function runJevHook(
		host: "claude-code" | "grok-build",
		envelope: Record<string, unknown>,
		jevUrl: string,
		config: Record<string, unknown>,
	): Promise<{ stdout: string; stderr: string }> {
		const home = join(dir, "home");
		mkdirSync(join(home, ".config", "ultrathink"), { recursive: true });
		writeFileSync(join(home, ".config", "ultrathink", "config.json"), JSON.stringify({ ...config, claude: { bin: join(dir, "no-claude"), ...(config.claude as object | undefined) } }));
		const env: Record<string, string | undefined> = {};
		for (const [key, value] of Object.entries(process.env)) {
			if (!key.startsWith("ULTRATHINK_") && !key.startsWith("GROK_") && key !== "CLAUDE_CONFIG_DIR" && key !== "OPENROUTER_API_KEY") env[key] = value;
		}
		const proc = Bun.spawn([process.execPath, HOOK], {
			cwd: dir,
			env: {
				...env,
				HOME: home,
				XDG_CONFIG_HOME: join(home, ".config"),
				ULTRATHINK_HOST: host,
				ULTRATHINK_STATE_DIR: stateDir,
				ULTRATHINK_MCP_STORE: join(dir, "mcp-credentials.json"),
				ULTRATHINK_DECISIONS_URL: jevUrl,
				OPENROUTER_API_KEY: K,
				SUBSTRATE_DISABLED: "1",
			},
			stdin: new Blob([JSON.stringify({ cwd: dir, ...envelope })]),
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
		expect(await proc.exited).toBe(0);
		expect(`${stdout}${stderr}`).not.toContain(K);
		expect(`${stdout}${stderr}`).not.toContain("Bearer sk-or-");
		return { stdout, stderr };
	}

	test(
		"on Claude a Jev skip prints only the notice, and nothing with echo off, like a deterministic skip (AC-3.1, AC-3.3)",
		async () => {
			const jev = fakeJev(0.04);
			try {
				const claude = (prompt: string) => ({ hook_event_name: "UserPromptSubmit", session_id: "s1", prompt });
				const trivial = await runJevHook("claude-code", claude("thanks"), jev.url, { decisions: { enabled: true } });
				expect(trivial.stdout).toBe("");
				expect(jev.requests).toHaveLength(0);

				const skipped = await runJevHook("claude-code", claude(ACK), jev.url, { decisions: { enabled: true } });
				expect(jev.requests).toHaveLength(1);
				expect(jev.requests[0]?.session_id).toBe("s1");
				// No hookSpecificOutput: the prompt reaches the model unchanged.
				expect(JSON.parse(skipped.stdout)).toEqual({ systemMessage: NOTICE_004 });
				expect(existsSync(join(stateDir, "sessions", "s1.json"))).toBe(false);

				const quiet = await runJevHook("claude-code", claude(ACK), jev.url, { decisions: { enabled: true }, claude: { echo: false } });
				expect(jev.requests).toHaveLength(2);
				expect(quiet.stdout).toBe("");
				expect(existsSync(join(stateDir, "sessions", "s1.json"))).toBe(false);
			} finally {
				jev.stop();
			}
		},
		30_000,
	);

	test(
		"on Grok a Jev skip leaves last-plan.json exactly as a deterministic TRIVIAL_RE skip does (AC-3.2)",
		async () => {
			const jev = fakeJev(0.04);
			const path = carrierPath(stateDir);
			try {
				writeStalePlan();
				// shunt has no Grok login check, so selection reaches the Jev gate without a login (AD-2a removed the auto Claude switch).
				const grokShunt = { transport: "shunt", shuntBaseUrl: "http://127.0.0.1:9" };
				await runJevHook("grok-build", { sessionId: "s1", promptId: "p1", userPrompt: "thanks" }, jev.url, { decisions: { enabled: true }, grok: grokShunt });
				const afterTrivial = existsSync(path) ? readFileSync(path, "utf8") : null;
				expect(jev.requests).toHaveLength(0);

				writeStalePlan();
				await runJevHook("grok-build", { sessionId: "s1", promptId: "p2", userPrompt: ACK }, jev.url, { decisions: { enabled: true }, grok: grokShunt });
				expect(jev.requests).toHaveLength(1);
				expect(existsSync(path) ? readFileSync(path, "utf8") : null).toEqual(afterTrivial);
				expect(afterTrivial).toBeNull();
			} finally {
				jev.stop();
			}
		},
		30_000,
	);
});
