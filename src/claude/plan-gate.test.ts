// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDecisions, type Decisions } from "../decisions/gate.ts";
import { QUESTIONS } from "../decisions/questions.ts";
import { DEFAULT_DECISIONS_CONFIG, type DecisionsConfig } from "../decisions/types.ts";
import { type PlanGateInput, planGate } from "./plan-gate.ts";

const K = "sk-or-v1-UTTESTKEY-0123456789abcdef";
const ENDPOINT = "https://openrouter.ai/api/alpha/decisions";
interface Recorded {
	url: string;
	method: string;
	headers: Record<string, string>;
	body: unknown;
}

const realFetch = globalThis.fetch;
const dirs: string[] = [];
afterEach(() => {
	globalThis.fetch = realFetch;
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
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

/** Never resolves; rejects with an AbortError when its signal fires (as src/grok/complete.test.ts hangingFetch). */
function hangingFetch(onCall?: () => void): typeof fetch {
	return ((_input: string | URL | Request, init?: RequestInit) =>
		new Promise<Response>((_resolve, reject) => {
			init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
			onCall?.();
		})) as typeof fetch;
}

/** The Decisions runtime with `ON` defaults: key K in the injected env, an empty temp store, no real sleeps. */
function runtime(fetchImpl: typeof fetch, config: Partial<DecisionsConfig> = {}, sessionId?: string, env: Record<string, string> = { OPENROUTER_API_KEY: K }): Decisions {
	const dir = mkdtempSync(join(tmpdir(), "ut-decisions-plan-gate-"));
	dirs.push(dir);
	return createDecisions({
		config: { ...DEFAULT_DECISIONS_CONFIG, points: [...DEFAULT_DECISIONS_CONFIG.points], enabled: true, ...config },
		...(sessionId ? { sessionId } : {}),
		env,
		storePath: join(dir, "mcp-credentials.json"),
		fetch: fetchImpl,
		sleep: async () => {},
	});
}

const ACK: PlanGateInput = { prompt: "thanks, that works now", text: "thanks, that works now", history: "" };

describe("planGate", () => {
	test("planSkipBelow is a strict less-than: P 0.2 plans, P 0.19 skips (AC-3.5)", async () => {
		const R = recordingFetch([JEV(0.2), JEV(0.19)]);
		const decisions = runtime(R.fetch);
		const at = await planGate(ACK, decisions);
		expect(at).toEqual({ plan: true, record: expect.objectContaining({ point: "plan", p: 0.2, threshold: 0.2, action: "plan" }) });
		const below = await planGate(ACK, decisions);
		expect(below).toEqual({
			plan: false,
			p: 0.19,
			record: expect.objectContaining({ point: "plan", p: 0.19, threshold: 0.2, action: "skip-plan" }),
		});
		expect(R.calls).toHaveLength(2);
	});

	test("a configured planSkipBelow is the threshold used and recorded", async () => {
		const R = recordingFetch([JEV(0.3)]);
		const verdict = await planGate(ACK, runtime(R.fetch, { planSkipBelow: 0.5 }));
		expect(verdict).toMatchObject({ plan: false, p: 0.3, record: { threshold: 0.5, action: "skip-plan" } });
	});

	test("the plan request has the pinned shape: bounded state, Q-PLAN verbatim, ZDR, session and trace (AC-3.12)", async () => {
		const R = recordingFetch([JEV(0.97)]);
		const message = `${"m".repeat(9_990)}TAILOFMSG!`;
		const turn = `PROPOSAL-HEAD${"t".repeat(4_975)}PROPOSAL-END`;
		const history = `User: add a flag\n\nAssistant: ${turn}`;
		await planGate({ prompt: message, text: message, history }, runtime(R.fetch, {}, "sess-123"));
		// No transcript available (Hermes, Omp): the conversation is empty.
		await planGate({ prompt: message, text: message, history: "" }, runtime(R.fetch, {}, "sess-123"));
		await planGate({ prompt: message, text: message, history }, runtime(R.fetch, { zdr: false }, "sess-123"));
		expect(R.calls).toHaveLength(3);

		const [full, bare, open] = R.calls.map((call) => call.body as Record<string, unknown>);
		expect(R.calls.every((call) => call.url === ENDPOINT && call.method === "POST")).toBe(true);
		expect(full?.model).toBe("~typesafe/jev-latest");
		const state = full?.state as { message: string; recent_conversation: string };
		expect(Object.keys(state).sort()).toEqual(["message", "recent_conversation"]);
		expect(state.message).toBe(message.slice(0, 4000));
		expect(state.recent_conversation).toBe(`Assistant: ${turn}`.slice(-2000));
		expect(state.recent_conversation.endsWith("PROPOSAL-END")).toBe(true);
		expect(full?.questions).toEqual({ plan_worthy: QUESTIONS.plan });
		expect(full?.provider).toEqual({ zdr: true, data_collection: "deny" });
		expect(full?.session_id).toBe("sess-123");
		expect(full?.trace).toEqual({ trace_name: "ultrathink", span_name: "plan" });

		expect((bare?.state as { recent_conversation: string }).recent_conversation).toBe("");

		expect(open).not.toHaveProperty("provider");
	});

	test("a skill invocation plans with zero requests, whatever Jev would say (D9)", async () => {
		const R = recordingFetch([JEV(0.01)]);
		const verdict = await planGate(
			{ ...ACK, prompt: "3", text: "3", skill: { name: "gsd-quick", instruction: "3", source: "slash" } },
			runtime(R.fetch),
		);
		expect(verdict).toEqual({ plan: true });
		expect(R.calls).toHaveLength(0);
	});

	test("uplift: plans with zero requests", async () => {
		const R = recordingFetch([JEV(0.01)]);
		expect(await planGate({ prompt: "uplift: thanks", text: "thanks", history: "" }, runtime(R.fetch))).toEqual({ plan: true });
		expect(R.calls).toHaveLength(0);
	});

	test("inside Grok's <user_query> wrapper, uplift: and a slash command plan with zero requests; plain text still asks Jev", async () => {
		const grok = (typed: string) =>
			`<user_query>\n${typed}\n</user_query>\n<skill_information>\n<skill name="gsd-quick" args="3">\nBody.\n</skill>\n</skill_information>`;
		const R = recordingFetch([JEV(0.01)]);
		const decisions = runtime(R.fetch);
		for (const prompt of ["<user_query>\nuplift: thanks\n</user_query>", grok("/gsd-quick 3")]) {
			expect(await planGate({ prompt, text: prompt, history: "" }, decisions)).toEqual({ plan: true });
		}
		expect(R.calls).toHaveLength(0);

		const wrappedAck = `<user_query>\n${ACK.prompt}\n</user_query>`;
		const verdict = await planGate({ prompt: wrappedAck, text: wrappedAck, history: "" }, decisions);
		expect(verdict).toMatchObject({ plan: false, p: 0.01, record: { point: "plan", action: "skip-plan" } });
		expect(R.calls).toHaveLength(1);
	});

	test("an inactive point plans with zero requests and no record: killed, not listed, or no key", async () => {
		const R = recordingFetch([JEV(0.01)]);
		for (const decisions of [
			runtime(R.fetch, {}, undefined, { OPENROUTER_API_KEY: K, ULTRATHINK_DECISIONS: "0" }),
			runtime(R.fetch, { points: ["ship", "knowledge", "blocking"] }),
			runtime(R.fetch, { points: [] }),
			runtime(R.fetch, {}, undefined, {}),
		]) {
			expect(await planGate(ACK, decisions)).toEqual({ plan: true });
		}
		expect(R.calls).toHaveLength(0);
	});

	test("a failure plans (fail open) and keeps an error record without the key", async () => {
		const R = recordingFetch([ERR(402)]);
		const verdict = await planGate(ACK, runtime(R.fetch));
		expect(verdict).toEqual({
			plan: true,
			record: expect.objectContaining({ point: "plan", outcome: "error", error: "credits", action: "fail-open", threshold: 0.2, attempts: 1 }),
		});
		expect(JSON.stringify(verdict)).not.toContain(K);
		expect(JSON.stringify(verdict)).not.toContain("Bearer sk-or-");
	});

	test("a caller abort rejects with an AbortError instead of failing open", async () => {
		const controller = new AbortController();
		const fetchImpl = hangingFetch(() => queueMicrotask(() => controller.abort()));
		globalThis.fetch = fetchImpl;
		let caught: unknown;
		try {
			await planGate(ACK, runtime(fetchImpl), controller.signal);
		} catch (error) {
			caught = error;
		}
		expect((caught as Error | undefined)?.name).toBe("AbortError");
	});
});
