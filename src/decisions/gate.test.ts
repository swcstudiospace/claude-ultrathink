// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	buildDecisionsRequest,
	createDecisions,
	type DecisionsInput,
	formatDebugLine,
	resolveDecisionsKeys,
	resolveOpenRouterKey,
	resolveVercelKey,
	type RunDecisionOptions,
} from "./gate.ts";
import { buildPlanState, buildSkillworthyState, buildTeachableState, QUESTIONS } from "./questions.ts";
import {
	DECISION_POINTS,
	DEFAULT_DECISIONS_CONFIG,
	type DecisionsConfig,
	type DecisionsErrorKind,
	formatP,
	VERCEL_DECISIONS_URL,
} from "./types.ts";

const K = "sk-or-v1-UTTESTKEY-0123456789abcdef";
const ENDPOINT = "https://openrouter.ai/api/alpha/decisions";
interface Recorded {
	url: string;
	method: string;
	headers: Record<string, string>;
	body: unknown;
}

const dirs: string[] = [];
const realFetch = globalThis.fetch;
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

function tempStore(key?: string): string {
	const dir = mkdtempSync(join(tmpdir(), "ut-decisions-gate-"));
	dirs.push(dir);
	const path = join(dir, "mcp-credentials.json");
	if (key !== undefined) writeStoreKey(path, key);
	return path;
}

function writeStoreKey(path: string, key: string | undefined): void {
	const providers = key === undefined ? {} : { openrouter: { kind: "api_key", apiKey: key, updatedAt: 1 } };
	writeFileSync(path, JSON.stringify({ version: 1, providers }), { mode: 0o600 });
}

const ON: DecisionsConfig = { ...DEFAULT_DECISIONS_CONFIG, enabled: true, points: [...DEFAULT_DECISIONS_CONFIG.points] };
const MESSAGE = "Add OAuth login with GitHub to the web app";
const PLAN_STATE = buildPlanState({ message: MESSAGE, recentConversation: "" });
const PLAN_OPTS: RunDecisionOptions = { threshold: 0.2, action: (p) => (p < 0.2 ? "skip-plan" : "plan") };

function runtime(fetchImpl: typeof fetch, overrides: Partial<DecisionsInput> = {}) {
	const lines: string[] = [];
	const decisions = createDecisions({
		config: ON,
		env: { OPENROUTER_API_KEY: K },
		storePath: tempStore(),
		fetch: fetchImpl,
		now: () => 1000,
		sleep: async () => {},
		random: () => 0.5,
		debug: (line) => lines.push(line),
		...overrides,
	});
	return { decisions, lines };
}

describe("resolveOpenRouterKey (AC-2.8)", () => {
	test("the stored key wins over OPENROUTER_API_KEY, which is the fallback", () => {
		const path = tempStore(K);
		const env = { OPENROUTER_API_KEY: "sk-or-v1-ENVKEY" };
		expect(resolveOpenRouterKey(path, env)).toEqual({ key: K, source: "store" });
		writeStoreKey(path, undefined);
		expect(resolveOpenRouterKey(path, env)).toEqual({ key: "sk-or-v1-ENVKEY", source: "OPENROUTER_API_KEY" });
	});

	test("an empty store and an unset, empty or whitespace-only env key mean no key", () => {
		const path = tempStore(undefined);
		for (const value of [undefined, "", "   "]) expect(resolveOpenRouterKey(path, { OPENROUTER_API_KEY: value })).toBeUndefined();
		expect(resolveOpenRouterKey(path, {})).toBeUndefined();
	});

	test("keys are trimmed; a blank stored key, a missing or corrupt store fall back to the env", () => {
		const path = tempStore(`  ${K}  `);
		expect(resolveOpenRouterKey(path, {})).toEqual({ key: K, source: "store" });
		writeStoreKey(path, "   ");
		expect(resolveOpenRouterKey(path, { OPENROUTER_API_KEY: ` ${K} ` })).toEqual({ key: K, source: "OPENROUTER_API_KEY" });
		writeFileSync(path, "{corrupt");
		expect(resolveOpenRouterKey(path, { OPENROUTER_API_KEY: K })?.source).toBe("OPENROUTER_API_KEY");
		expect(resolveOpenRouterKey(join(path, "missing", "store.json"), { OPENROUTER_API_KEY: K })?.source).toBe("OPENROUTER_API_KEY");
	});
});

describe("Decisions.active and inactive runs (AC-2.9)", () => {
	const states = {
		plan: PLAN_STATE,
		ship: { request: "r", acceptance_criteria: [], patch: "" },
		knowledge: { question: "q", answer: "a", document: "d" },
		blocking: { task: "t", question: "q", default: "d" },
		teachable: { name: "n", description: "d", body: "b", kind: "pitfall" },
		skillworthy: { name: "n", description: "d", body: "b", kind: "playbook", occurrences: 3 },
	};

	test("enabled without any key: every point is inactive and makes zero requests", async () => {
		const r = recordingFetch([JEV(0.5)]);
		const { decisions, lines } = runtime(r.fetch, { env: {} });
		for (const point of DECISION_POINTS) {
			expect(decisions.active(point)).toBe(false);
			expect(await decisions.run(point, states[point], PLAN_OPTS)).toEqual({ status: "inactive" });
		}
		expect(r.calls).toHaveLength(0);
		expect(lines).toEqual([]);
	});

	test("enabled:false no longer deactivates, but a point not listed is inactive even with a key (JEV-01)", async () => {
		const r = recordingFetch([JEV(0.5)]);
		const off = runtime(r.fetch, { config: { ...ON, enabled: false } }).decisions;
		for (const point of DECISION_POINTS) expect(off.active(point)).toBe(true);
		expect((await off.run("plan", PLAN_STATE, PLAN_OPTS)).status).toBe("ok");
		const shipOnly = runtime(r.fetch, { config: { ...ON, points: ["ship"] } }).decisions;
		expect(DECISION_POINTS.filter((point) => shipOnly.active(point))).toEqual(["ship"]);
		const none = runtime(r.fetch, { config: { ...ON, points: [] } }).decisions;
		expect(DECISION_POINTS.filter((point) => none.active(point))).toEqual([]);
		expect(r.calls).toHaveLength(1);
	});

	test("K1: ULTRATHINK_DECISIONS=0 makes every point inactive with zero requests, even enabled with a key", async () => {
		const r = recordingFetch([JEV(0.5)]);
		const { decisions, lines } = runtime(r.fetch, {
			env: { OPENROUTER_API_KEY: K, ULTRATHINK_DECISIONS: "0" },
			storePath: tempStore(K),
		});
		for (const point of DECISION_POINTS) {
			expect(decisions.active(point)).toBe(false);
			expect(await decisions.run(point, states[point], PLAN_OPTS)).toEqual({ status: "inactive" });
		}
		expect(r.calls).toHaveLength(0);
		expect(lines).toEqual([]);
		// Only the exact value "0" is the kill switch.
		expect(runtime(r.fetch, { env: { OPENROUTER_API_KEY: K, ULTRATHINK_DECISIONS: "1" } }).decisions.active("plan")).toBe(true);
	});

	test("the key is read lazily, once per runtime", () => {
		const path = tempStore(undefined);
		const { decisions } = runtime(recordingFetch([JEV(0.5)]).fetch, { env: {}, storePath: path });
		writeStoreKey(path, K);
		expect(decisions.active("plan")).toBe(true);
		writeStoreKey(path, undefined);
		expect(decisions.active("ship")).toBe(true);
	});
});

describe("Decisions.run", () => {
	test("AC-3.13: an ok decision yields a content-free record with the resolved model", async () => {
		const r = recordingFetch([JEV(0.97)]);
		const { decisions, lines } = runtime(r.fetch);
		const outcome = await decisions.run("plan", PLAN_STATE, PLAN_OPTS);
		expect(outcome).toEqual({
			status: "ok",
			p: 0.97,
			record: {
				point: "plan",
				outcome: "ok",
				model: "typesafe/jev-1.13-20260917",
				id: "gen-dec-test",
				p: 0.97,
				probabilities: { plan_worthy: 0.97 },
				threshold: 0.2,
				action: "plan",
				latencyMs: 0,
				attempts: 1,
				cost: 0.000019,
				at: 1000,
			},
		});
		const serialized = JSON.stringify(outcome);
		expect(serialized).not.toContain(MESSAGE);
		expect(serialized).not.toContain(K);
		expect(r.calls).toHaveLength(1);
		expect(lines).toEqual(["decisions plan · p 0.97 · typesafe/jev-1.13-20260917 · 0ms · attempts 1 · cost 0.000019"]);
	});

	test("the ok action comes from the caller's rule", async () => {
		const { decisions } = runtime(recordingFetch([JEV(0.04)]).fetch);
		const outcome = await decisions.run("plan", PLAN_STATE, PLAN_OPTS);
		expect(outcome.status === "ok" && outcome.record.action).toBe("skip-plan");
	});

	test("AC-4.15: a failure fails open with an error record, the requested model and no key anywhere", async () => {
		const r = recordingFetch([ERR(402)]);
		const { decisions, lines } = runtime(r.fetch);
		const outcome = await decisions.run("plan", PLAN_STATE, PLAN_OPTS);
		if (outcome.status !== "error") throw new Error("expected an error outcome");
		expect(outcome.error.kind).toBe("credits");
		expect(outcome.record).toEqual({
			point: "plan",
			outcome: "error",
			model: "~typesafe/jev-latest",
			probabilities: {},
			threshold: 0.2,
			action: "fail-open",
			latencyMs: 0,
			attempts: 1,
			error: "credits",
			at: 1000,
		});
		expect(lines).toEqual(["decisions plan · error (credits) · 0ms · attempts 1"]);
		const collected = [JSON.stringify(outcome.record), outcome.error.message, ...lines].join("\n");
		expect(collected).not.toContain(K);
		expect(collected).not.toContain("Bearer sk-or-");
		expect(outcome.error.message.length).toBeLessThanOrEqual(200);
	});

	test("AC-5.1: a retried success records attempts 2", async () => {
		const r = recordingFetch([ERR(503), JEV(0.97)]);
		const outcome = await runtime(r.fetch).decisions.run("plan", PLAN_STATE, PLAN_OPTS);
		expect(outcome.status === "ok" && outcome.record.attempts).toBe(2);
		expect(r.calls).toHaveLength(2);
	});

	test("a caller abort is re-thrown with no record and no debug line", async () => {
		const controller = new AbortController();
		const { decisions, lines } = runtime(hangingFetch(() => queueMicrotask(() => controller.abort())));
		let error: { name?: string } | undefined;
		try {
			await decisions.run("plan", PLAN_STATE, { ...PLAN_OPTS, signal: controller.signal });
		} catch (caught) {
			error = caught as { name?: string };
		}
		expect(error?.name).toBe("AbortError");
		expect(lines).toEqual([]);
	});

	test("F3: an unexpected exception inside decide() still fails open with a redacted network record", async () => {
		const r = recordingFetch([ERR(503), JEV(0.97)]);
		const { decisions, lines } = runtime(r.fetch, {
			random: () => {
				throw new Error(`jitter source broke for ${K}`);
			},
		});
		const outcome = await decisions.run("plan", PLAN_STATE, PLAN_OPTS);
		if (outcome.status !== "error") throw new Error(`expected a fail-open error, got ${outcome.status}`);
		expect(outcome.error.kind).toBe("network");
		expect(outcome.error.message).toBe("decisions network: jitter source broke for [redacted]");
		expect(outcome.record).toMatchObject({ point: "plan", outcome: "error", action: "fail-open", error: "network" });
		expect(lines).toHaveLength(1);
		expect([JSON.stringify(outcome.record), ...lines].join("\n")).not.toContain(K);
	});

	test("sends the point's single question with zdr routing, session id and trace", async () => {
		const r = recordingFetch([JEV(0.5)]);
		await runtime(r.fetch, { sessionId: "sess-123" }).decisions.run("plan", PLAN_STATE, PLAN_OPTS);
		expect(r.calls[0]?.body).toEqual({
			model: "~typesafe/jev-latest",
			state: { message: MESSAGE, recent_conversation: "" },
			questions: { plan_worthy: QUESTIONS.plan },
			provider: { zdr: true, data_collection: "deny" },
			session_id: "sess-123",
			trace: { trace_name: "ultrathink", span_name: "plan" },
		});
	});

	test("requests the configured model", async () => {
		const r = recordingFetch([JEV(0.5)]);
		await runtime(r.fetch, { config: { ...ON, model: "typesafe/jev-1.13" } }).decisions.run("plan", PLAN_STATE, PLAN_OPTS);
		expect((r.calls[0]?.body as { model: string }).model).toBe("typesafe/jev-1.13");
	});
});

describe("ULTRATHINK_DECISIONS_URL (AC-2.13)", () => {
	test("only openrouter.ai or loopback overrides are used, without query or hash; the rest fall back to the endpoint", async () => {
		const r = recordingFetch([JEV(0.5)]);
		for (const url of [
			"http://127.0.0.1:9999/decisions?token=x#h",
			"https://gw.example/d",
			"http://gw.example/d",
			"https://user:pw@openrouter.ai/api/alpha/decisions",
			"ftp://127.0.0.1/x",
			"not a url",
		]) {
			await runtime(r.fetch, { env: { OPENROUTER_API_KEY: K, ULTRATHINK_DECISIONS_URL: url } }).decisions.run("plan", PLAN_STATE, PLAN_OPTS);
		}
		expect(r.calls.map((call) => call.url)).toEqual(["http://127.0.0.1:9999/decisions", ...Array(5).fill(ENDPOINT)]);
		for (const call of r.calls) {
			expect(call.method).toBe("POST");
			expect(call.headers.authorization).toBe(`Bearer ${K}`);
		}
	});
});

describe("debug line (AC-3.14, §5.8)", () => {
	async function stderrOf(env: Record<string, string | undefined>, respond: () => Response): Promise<string> {
		const written: string[] = [];
		const original = process.stderr.write;
		process.stderr.write = ((chunk: string | Uint8Array) => {
			written.push(String(chunk));
			return true;
		}) as typeof process.stderr.write;
		try {
			const decisions = createDecisions({
				config: ON,
				env,
				storePath: tempStore(),
				fetch: recordingFetch([respond]).fetch,
				now: () => 1000,
				sleep: async () => {},
			});
			await decisions.run("plan", PLAN_STATE, PLAN_OPTS);
		} finally {
			process.stderr.write = original;
		}
		return written.filter((line) => line.includes("decisions ")).join("");
	}

	test("ULTRATHINK_DEBUG=1 writes exactly one line per decision, without the message or the key", async () => {
		const out = await stderrOf({ OPENROUTER_API_KEY: K, ULTRATHINK_DEBUG: "1" }, JEV(0.97));
		expect(out).toBe("[ultrathink] decisions plan · p 0.97 · typesafe/jev-1.13-20260917 · 0ms · attempts 1 · cost 0.000019\n");
		expect(out).not.toContain(MESSAGE);
		expect(out).not.toContain(K);
	});

	test("an error writes the kind only", async () => {
		const out = await stderrOf({ OPENROUTER_API_KEY: K, ULTRATHINK_DEBUG: "1" }, ERR(401));
		expect(out).toBe("[ultrathink] decisions plan · error (auth) · 0ms · attempts 1\n");
		expect(out).not.toContain("upstream said no");
	});

	test("without ULTRATHINK_DEBUG=1 nothing is written", async () => {
		expect(await stderrOf({ OPENROUTER_API_KEY: K }, JEV(0.97))).toBe("");
		expect(await stderrOf({ OPENROUTER_API_KEY: K, ULTRATHINK_DEBUG: "0" }, JEV(0.97))).toBe("");
	});

	test("formatDebugLine rounds latency and omits an absent cost", () => {
		const line = formatDebugLine({
			point: "knowledge",
			outcome: "ok",
			model: "typesafe/jev-1.13-20260917",
			p: 0.199,
			probabilities: { supported: 0.199 },
			threshold: 0.8,
			action: "reject-claim",
			latencyMs: 512.6,
			attempts: 2,
			at: 1,
		});
		expect(line).toBe("decisions knowledge · p 0.19 · typesafe/jev-1.13-20260917 · 513ms · attempts 2");
	});
});

describe("buildDecisionsRequest", () => {
	test("zdr off sends no provider key at all (A12)", () => {
		const request = buildDecisionsRequest("plan", PLAN_STATE, { model: "m", zdr: false });
		expect(request).not.toHaveProperty("provider");
		expect(request).not.toHaveProperty("session_id");
	});

	test("session ids are trimmed, capped at 256 chars and omitted when empty or unknown", () => {
		const input = { model: "m", zdr: true };
		expect(buildDecisionsRequest("plan", PLAN_STATE, { ...input, sessionId: " sess-1 " }).session_id).toBe("sess-1");
		expect(buildDecisionsRequest("plan", PLAN_STATE, { ...input, sessionId: "s".repeat(300) }).session_id).toBe("s".repeat(256));
		for (const sessionId of ["", "   ", "unknown", undefined]) {
			expect(buildDecisionsRequest("plan", PLAN_STATE, { ...input, sessionId })).not.toHaveProperty("session_id");
		}
	});

	test("each point asks its own question; the span defaults to the point", () => {
		const ship = buildDecisionsRequest("ship", { request: "r", acceptance_criteria: [], patch: "" }, { model: "m", zdr: true });
		expect(ship.questions).toEqual({ complete: QUESTIONS.ship });
		expect(ship.trace).toEqual({ trace_name: "ultrathink", span_name: "ship" });
		const check = buildDecisionsRequest("plan", PLAN_STATE, { model: "m", zdr: true, spanName: "check" });
		expect(check.trace).toEqual({ trace_name: "ultrathink", span_name: "check" });
	});
});

describe("teachable and skillworthy points", () => {
	const LESSON = { name: "Run bun test per file", description: "The whole suite hides the failing file", body: "b".repeat(2000), kind: "pitfall" };
	const TEACHABLE_OPTS: RunDecisionOptions = { threshold: 0.3, action: (p) => (p < 0.3 ? "drop" : "keep") };

	test("teachable sends its state, its question and the span name under the key `teachable`", async () => {
		const r = recordingFetch([JEV(0.9, "teachable")]);
		const outcome = await runtime(r.fetch).decisions.run("teachable", buildTeachableState(LESSON), TEACHABLE_OPTS);
		expect(r.calls[0]?.body).toEqual({
			model: "~typesafe/jev-latest",
			state: { name: LESSON.name, description: LESSON.description, body: "b".repeat(800), kind: "pitfall" },
			questions: { teachable: QUESTIONS.teachable },
			provider: { zdr: true, data_collection: "deny" },
			trace: { trace_name: "ultrathink", span_name: "teachable" },
		});
		expect(outcome.status === "ok" && outcome.record).toMatchObject({ point: "teachable", p: 0.9, action: "keep", threshold: 0.3 });
	});

	test("skillworthy sends the occurrence count and its own question", async () => {
		const r = recordingFetch([JEV(0.2, "skillworthy")]);
		const opts: RunDecisionOptions = { threshold: 0.5, action: (p) => (p < 0.5 ? "skip" : "keep") };
		const outcome = await runtime(r.fetch).decisions.run("skillworthy", buildSkillworthyState({ ...LESSON, occurrences: 4 }), opts);
		const body = r.calls[0]?.body as { state: Record<string, unknown>; questions: Record<string, unknown> };
		expect(body.state).toEqual({ ...LESSON, body: "b".repeat(800), occurrences: 4 });
		expect(body.questions).toEqual({ skillworthy: QUESTIONS.skillworthy });
		expect(outcome.status === "ok" && outcome.record).toMatchObject({ point: "skillworthy", p: 0.2, action: "skip", probabilities: { skillworthy: 0.2 } });
	});

	test("each is active only when listed, and the default list names both", () => {
		expect(DEFAULT_DECISIONS_CONFIG.points).toEqual(["plan", "ship", "knowledge", "blocking", "teachable", "skillworthy"]);
		const r = recordingFetch([JEV(0.5)]);
		const onlyTeachable = runtime(r.fetch, { config: { ...ON, points: ["teachable"] } }).decisions;
		expect(DECISION_POINTS.filter((point) => onlyTeachable.active(point))).toEqual(["teachable"]);
		const planOnly = runtime(r.fetch, { config: { ...ON, points: ["plan"] } }).decisions;
		expect(planOnly.active("teachable")).toBe(false);
		expect(planOnly.active("skillworthy")).toBe(false);
	});

	test("the kill switch makes both inactive without a request", async () => {
		const r = recordingFetch([JEV(0.5, "teachable")]);
		const { decisions } = runtime(r.fetch, { env: { OPENROUTER_API_KEY: K, ULTRATHINK_DECISIONS: "0" } });
		expect(await decisions.run("teachable", buildTeachableState(LESSON), TEACHABLE_OPTS)).toEqual({ status: "inactive" });
		expect(await decisions.run("skillworthy", buildSkillworthyState({ ...LESSON, occurrences: 1 }), TEACHABLE_OPTS)).toEqual({ status: "inactive" });
		expect(r.calls).toHaveLength(0);
	});

	test("every failure kind returns a fail-open error record", async () => {
		const invalid = () => Response.json({ model: "m", answers: { teachable: { type: "noul", noul: 7 } }, usage: { input_tokens: 1, output_tokens: 0 } });
		const throwing = (async () => {
			throw new Error("connection refused");
		}) as unknown as typeof fetch;
		const cases: Array<[DecisionsErrorKind, typeof fetch]> = [
			["auth", recordingFetch([ERR(401)]).fetch],
			["credits", recordingFetch([ERR(402)]).fetch],
			["bad-request", recordingFetch([ERR(400)]).fetch],
			["too-large", recordingFetch([ERR(413)]).fetch],
			["rate-limit", recordingFetch([ERR(429)]).fetch],
			["upstream", recordingFetch([ERR(500)]).fetch],
			["timeout", recordingFetch([ERR(408)]).fetch],
			["invalid-response", recordingFetch([invalid]).fetch],
			["network", throwing],
		];
		for (const [kind, fetchImpl] of cases) {
			const outcome = await runtime(fetchImpl).decisions.run("teachable", buildTeachableState(LESSON), TEACHABLE_OPTS);
			if (outcome.status !== "error") throw new Error(`expected an error for ${kind}`);
			expect(outcome.error.kind).toBe(kind);
			expect(outcome.record).toMatchObject({ point: "teachable", action: "fail-open", error: kind });
		}
	});
});

describe("formatP (A2)", () => {
	test("prints two decimals, truncated so a value never crosses its threshold", () => {
		expect([0.199, 0.2, 0.97, 0.03, 0.29, 0.3, 1, 0, 0.04].map(formatP)).toEqual([
			"0.19",
			"0.20",
			"0.97",
			"0.03",
			"0.29",
			"0.30",
			"1.00",
			"0.00",
			"0.04",
		]);
	});
});

describe("provider routing (JEV-02)", () => {
	const V = "vck_test_key_do_not_use";
	const VEV = (p: number) => () =>
		Response.json({
			answers: { plan_worthy: { type: "boolean", probability: p } },
			usage: { inputTokens: 100, outputTokens: 5 },
		});

	function storeWith(providers: Record<string, unknown>): string {
		const dir = mkdtempSync(join(tmpdir(), "ut-decisions-rail-"));
		dirs.push(dir);
		const path = join(dir, "mcp-credentials.json");
		writeFileSync(path, JSON.stringify({ version: 1, providers }), { mode: 0o600 });
		return path;
	}
	const stored = (key: string) => ({ kind: "api_key", apiKey: key, updatedAt: 1 });

	test("resolveVercelKey: the stored key wins over AI_GATEWAY_API_KEY, which is the fallback", () => {
		const path = storeWith({ vercel: stored(V) });
		expect(resolveVercelKey(path, { AI_GATEWAY_API_KEY: "other" })).toEqual({ key: V, source: "store" });
		expect(resolveVercelKey(storeWith({}), { AI_GATEWAY_API_KEY: ` ${V} ` })).toEqual({ key: V, source: "AI_GATEWAY_API_KEY" });
		expect(resolveVercelKey(storeWith({}), {})).toBeUndefined();
	});

	test("auto picks vercel iff its key is present; explicit pins either rail", () => {
		const auto = { ...ON, provider: "auto" as const };
		expect(resolveDecisionsKeys(auto, storeWith({}), { AI_GATEWAY_API_KEY: V }).provider).toBe("vercel");
		expect(resolveDecisionsKeys(auto, storeWith({ vercel: stored(V) }), {}).provider).toBe("vercel");
		expect(resolveDecisionsKeys(auto, storeWith({}), { OPENROUTER_API_KEY: K }).provider).toBe("openrouter");
		expect(resolveDecisionsKeys(auto, storeWith({}), {}).provider).toBe("openrouter");
		expect(resolveDecisionsKeys(auto, storeWith({}), {}).key).toBeUndefined();
		const pinned = (provider: "openrouter" | "vercel") => ({ ...ON, provider });
		const both = { AI_GATEWAY_API_KEY: V, OPENROUTER_API_KEY: K };
		expect(resolveDecisionsKeys(pinned("openrouter"), storeWith({}), both)).toEqual({
			provider: "openrouter",
			key: { key: K, source: "OPENROUTER_API_KEY" },
		});
		expect(resolveDecisionsKeys(pinned("vercel"), storeWith({}), both)).toEqual({
			provider: "vercel",
			key: { key: V, source: "AI_GATEWAY_API_KEY" },
		});
		expect(resolveDecisionsKeys(pinned("vercel"), storeWith({}), { OPENROUTER_API_KEY: K }).key).toBeUndefined();
	});

	test("run() on the vercel rail posts the v4 endpoint and records the gateway model", async () => {
		const r = recordingFetch([VEV(0.97)]);
		const { decisions } = runtime(r.fetch, {
			config: { ...ON, provider: "vercel" },
			env: { AI_GATEWAY_API_KEY: V },
		});
		expect(decisions.active("plan")).toBe(true);
		const outcome = await decisions.run("plan", PLAN_STATE, PLAN_OPTS);
		expect(outcome.status).toBe("ok");
		expect(r.calls).toHaveLength(1);
		const call = r.calls[0];
		if (!call) throw new Error("expected a decisions call");
		expect(call.url).toBe(VERCEL_DECISIONS_URL);
		expect(call.headers["ai-model-id"]).toBe("typesafe-ai/jev");
		expect(call.body).toMatchObject({ questions: { plan_worthy: { type: "boolean" } } });
		if (outcome.status !== "ok") throw new Error("expected ok");
		expect(outcome.p).toBe(0.97);
		expect(outcome.record).toMatchObject({ point: "plan", outcome: "ok", model: "typesafe-ai/jev", action: "plan" });
	});

	test("run() on auto with both keys uses vercel; explicit openrouter stays on OpenRouter", async () => {
		const both = { AI_GATEWAY_API_KEY: V, OPENROUTER_API_KEY: K };
		const r = recordingFetch([VEV(0.5)]);
		const auto = runtime(r.fetch, { config: { ...ON, provider: "auto" }, env: both }).decisions;
		await auto.run("plan", PLAN_STATE, PLAN_OPTS);
		expect(r.calls[0]?.url).toBe(VERCEL_DECISIONS_URL);
		const queued = recordingFetch([JEV(0.5)]);
		const pinned = runtime(queued.fetch, { config: { ...ON, provider: "openrouter" }, env: both }).decisions;
		expect(pinned.active("plan")).toBe(true);
		await pinned.run("plan", PLAN_STATE, PLAN_OPTS);
		expect(queued.calls[0]?.url).toBe(ENDPOINT);
	});

	test("the kill switch offs the vercel rail too, with zero requests", async () => {
		const r = recordingFetch([VEV(0.5)]);
		const { decisions } = runtime(r.fetch, {
			config: { ...ON, provider: "vercel" },
			env: { AI_GATEWAY_API_KEY: V, ULTRATHINK_DECISIONS: "0" },
		});
		expect(decisions.active("plan")).toBe(false);
		expect(await decisions.run("plan", PLAN_STATE, PLAN_OPTS)).toEqual({ status: "inactive" });
		expect(r.calls).toHaveLength(0);
	});
});
