// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { claudeConfigPaths, loadConfig } from "../../../src/config.ts";
import { journalDir, listPending, stageOf } from "../../../src/host/grokbot.ts";
import { planPrompt } from "../../../src/host/plan.ts";
import { COT_SYSTEM_PROMPT, GRAPH_SYSTEM_PROMPT } from "../../../src/think/prompts.ts";
import { UPLIFT_SYSTEM_PROMPT } from "../../../src/uplift/prompt.ts";
import { escapeXml } from "../../../src/uplift/xml.ts";
import { type JournalOptions, type PlanView, answerRequest, listPendingRequests, sessionStatus, showRequest, startPlan } from "./journal.ts";

const PROMPT = "Build a small TypeScript CLI that converts CSV files to JSON with streaming support, tests and a README.";
const dirs: string[] = [];
const tmp = (): string => {
	const dir = mkdtempSync(join(tmpdir(), "ut-journal-"));
	dirs.push(dir);
	return dir;
};
afterAll(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const opts = (stateDir: string): JournalOptions => ({ stateDir, maxPromptChars: 4000, maxAnswerChars: 200_000 });
const newState = (): string => join(tmp(), "state");

const UPLIFT = (original: string) =>
	`<BUILD_PROMPT><ORIGINAL>${escapeXml(original)}</ORIGINAL><SYSTEM_ROLE>Senior TypeScript engineer.</SYSTEM_ROLE><APP_CONTEXT>A standalone CLI.</APP_CONTEXT><SCOPE>CSV to JSON with streaming.</SCOPE><CONSTRAINTS>Do not invent repo facts.</CONSTRAINTS><ACCEPTANCE_CRITERIA>Converts a 1 GB file in bounded memory.</ACCEPTANCE_CRITERIA><OUT_OF_SCOPE>XLSX input.</OUT_OF_SCOPE></BUILD_PROMPT>`;

const GRAPH = JSON.stringify({
	goal: "Ship a streaming CSV to JSON CLI",
	nodes: [
		{ id: "n1", title: "Understand the request", kind: "understand", question: "What exactly must the CLI do?", depends_on: [] },
		{ id: "n2", title: "Parser design", kind: "decompose", question: "How is CSV parsed as a stream?", depends_on: ["n1"] },
		{ id: "n3", title: "CLI surface", kind: "generate", question: "What flags and outputs does the CLI expose?", depends_on: ["n1"] },
		{ id: "n4", title: "Gaps and risks", kind: "critique", question: "What is missing or ambiguous?", depends_on: ["n2", "n3"] },
		{ id: "n5", title: "Execution plan", kind: "synthesize", question: "What is the ordered wave plan?", depends_on: ["n4"] },
	],
});

const steps = (n: number, id: string) => Array.from({ length: n }, (_, i) => `${i + 1}. Step ${i + 1} of ${id}: a discrete, self-contained action.`).join("\n");

const NODE = (id: string, kind: string, n: number) => {
	let conclusion = `Answer for ${id}.`;
	if (kind === "critique") conclusion += "\nOpen questions:\n- Output as JSON lines or array? Default: array.";
	if (kind === "synthesize") conclusion += "\nWORKFLOW\nWave 1 (parallel): parser — files: src/parse.ts — done when: unit tests pass\nWave 1 (parallel): cli — files: src/cli.ts — done when: --help prints\nWave 2: docs — files: README.md — done when: README lists flags\nVerify: bun test";
	return `<node><rationale>\n${steps(n, id)}\n</rationale><conclusion>${conclusion}</conclusion></node>`;
};

const CLARIFY = JSON.stringify({
	questions: [{ id: "q1", question: "Should output be a JSON array or JSON lines?", header: "Output", why: "Changes the writer.", options: [{ label: "JSON array", description: "Standard" }, { label: "JSON lines", description: "Streamable" }], default: "JSON array", blocking: false }],
});

/** The scripted host model: answers each plugin request by its system prompt. */
function hostModel(stepsPerNode = 8) {
	return (system: string, user: string): string => {
		if (system === UPLIFT_SYSTEM_PROMPT) return UPLIFT(PROMPT);
		if (system === GRAPH_SYSTEM_PROMPT) return GRAPH;
		if (system === COT_SYSTEM_PROMPT) {
			const match = user.match(/<current_node id="([^"]+)" kind="([^"]+)"/);
			return NODE(match?.[1] ?? "n?", match?.[2] ?? "generate", stepsPerNode);
		}
		if (stageOf(system) === "clarify") return CLARIFY;
		throw new Error(`unexpected request: ${system.slice(0, 40)}`);
	};
}

/** Drives startPlan / listPendingRequests / showRequest / answerRequest until planned, recording every result in `log`. */
async function drivePlan(o: JournalOptions, sessionId: string, log: unknown[] = []): Promise<PlanView> {
	const model = hostModel(8);
	let plan = await startPlan(o, { prompt: PROMPT, sessionId });
	log.push(plan);
	for (let pass = 0; pass < 12; pass++) {
		if (!plan.ok) throw new Error(`startPlan failed: ${plan.code}`);
		if (plan.data.status !== "needs-model") return plan.data;
		const listed = listPendingRequests(o, { sessionId });
		log.push(listed);
		if (!listed.ok) throw new Error(`list failed: ${listed.code}`);
		for (const entry of listed.data) {
			const system = showRequest(o, { sessionId, key: entry.key, part: "system" });
			const user = showRequest(o, { sessionId, key: entry.key, part: "user" });
			log.push(system, user);
			if (!system.ok || !user.ok) throw new Error("showRequest failed");
			const answered = answerRequest(o, { sessionId, key: entry.key, answer: model(system.data.system ?? "", user.data.user ?? "") });
			log.push(answered);
			expect(answered).toEqual({ ok: true, data: { accepted: true } });
		}
		plan = await startPlan(o, { prompt: PROMPT, sessionId });
		log.push(plan);
	}
	throw new Error("plan did not converge");
}

/** Key of the first pending request in a session; fails the test when none is pending. */
function firstKey(o: JournalOptions, sessionId: string): string {
	const listed = listPendingRequests(o, { sessionId });
	if (!listed.ok) throw new Error(`list failed: ${listed.code}`);
	const key = listed.data[0]?.key;
	if (key === undefined) throw new Error("no pending request");
	return key;
}

/** The real plugin entry point behind a gate: every call waits until `open()` before planning; `calls()` counts them. */
function gatedPlan(): { plan: typeof planPrompt; open: () => void; calls: () => number } {
	let open = (): void => undefined;
	const gate = new Promise<void>((resolve) => {
		open = resolve;
	});
	let calls = 0;
	return {
		plan: async (request, env, options) => {
			calls++;
			await gate;
			return planPrompt(request, env, options);
		},
		open: () => open(),
		calls: () => calls,
	};
}

describe("grok-bot journal service", () => {
	test("drives a plan to planned through the journal API and leaves the cwd empty", async () => {
		const stateDir = newState();
		const sessionId = randomUUID();
		const plan = await drivePlan(opts(stateDir), sessionId);
		expect(plan.status).toBe("planned");
		expect(plan.pending).toEqual([]);
		expect(plan.sessionId).toBe(sessionId);
		expect(readdirSync(join(stateDir, "cwd"))).toEqual([]);
		expect(sessionStatus(opts(stateDir), { sessionId })).toEqual({
			ok: true,
			data: { sessionId, status: "planned", pendingCount: 0, pending: [] },
		});
	});

	test("makes zero outbound fetch calls across the whole loop", async () => {
		const realFetch = globalThis.fetch;
		const urls: string[] = [];
		globalThis.fetch = ((input: string | URL | Request) => {
			urls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
			return Promise.reject(new Error("offline"));
		}) as unknown as typeof fetch;
		try {
			const plan = await drivePlan(opts(newState()), randomUUID());
			expect(plan.status).toBe("planned");
		} finally {
			globalThis.fetch = realFetch;
		}
		expect(urls.join(" | ")).toBe("");
	});

	test("a concurrent start for the same session joins the first plan instead of racing it", async () => {
		const real = globalThis.fetch;
		const stateDir = newState();
		const sessionId = randomUUID();
		const { plan, open, calls } = gatedPlan();
		const o = { ...opts(stateDir), plan };
		const first = startPlan(o, { prompt: PROMPT, sessionId });
		const second = startPlan(o, { prompt: PROMPT, sessionId });
		const other = await startPlan(o, { prompt: `${PROMPT} Also a changelog.`, sessionId });
		expect(other).toEqual({ ok: false, code: "session_conflict" });
		open();
		const [a, b] = await Promise.all([first, second]);
		expect(calls()).toBe(1);
		expect(a).toMatchObject({ ok: true, data: { sessionId, status: "needs-model" } });
		expect(b).toEqual(a);
		if (!a.ok) throw new Error("unexpected failure");
		const keys = a.data.pending.map((entry) => entry.key);
		expect(keys.length).toBeGreaterThan(0);
		expect(listPending(journalDir(stateDir, sessionId)).map((entry) => entry.key)).toEqual(keys);
		expect(globalThis.fetch).toBe(real);
		expect((await startPlan(o, { prompt: PROMPT, sessionId })).ok).toBe(true);
		expect(calls()).toBe(2);
	});

	test("concurrent starts for different sessions both complete and leave the global fetch restored", async () => {
		const real = globalThis.fetch;
		const stateDir = newState();
		const ids = [randomUUID(), randomUUID()];
		const { plan, open, calls } = gatedPlan();
		const o = { ...opts(stateDir), plan };
		const runs = ids.map((sessionId) => startPlan(o, { prompt: PROMPT, sessionId }));
		open();
		const results = await Promise.all(runs);
		expect(calls()).toBe(2);
		for (const [i, sessionId] of ids.entries()) {
			expect(results[i]).toMatchObject({ ok: true, data: { sessionId, status: "needs-model" } });
			expect(listPending(journalDir(stateDir, sessionId)).length).toBeGreaterThan(0);
		}
		expect(globalThis.fetch).toBe(real);
	});

	test("rejects a bad answer with invalid_answer and keeps the pending request", async () => {
		const o = opts(newState());
		const sessionId = randomUUID();
		expect((await startPlan(o, { prompt: PROMPT, sessionId })).ok).toBe(true);
		const key = firstKey(o, sessionId);
		const answered = answerRequest(o, { sessionId, key, answer: "not an answer" });
		expect(answered).toMatchObject({ ok: false, code: "invalid_answer" });
		if (answered.ok) throw new Error("unexpected success");
		expect(answered.errors?.length ?? 0).toBeGreaterThan(0);
		expect(listPendingRequests(o, { sessionId })).toEqual({
			ok: true,
			data: [expect.objectContaining({ key })],
		});
	});

	test("rejects an answer longer than maxAnswerChars with answer_too_long and stores nothing", async () => {
		const stateDir = newState();
		const o = opts(stateDir);
		const sessionId = randomUUID();
		expect((await startPlan(o, { prompt: PROMPT, sessionId })).ok).toBe(true);
		const key = firstKey(o, sessionId);
		const tight = { ...o, maxAnswerChars: 16 };
		expect(answerRequest(tight, { sessionId, key, answer: UPLIFT(PROMPT) })).toEqual({ ok: false, code: "answer_too_long" });
		expect(firstKey(o, sessionId)).toBe(key);
		const answers = join(journalDir(stateDir, sessionId), "answers");
		expect(existsSync(answers) ? readdirSync(answers) : []).toEqual([]);
	});

	test("rejects malformed session ids from every entry point", async () => {
		const stateDir = newState();
		const o = opts(stateDir);
		const bad: unknown[] = ["../etc", "7F3A9C2E-1B4D-4E8A-9C3F-2A1B0C9D8E7F", 42];
		for (const sessionId of bad) {
			expect(await startPlan(o, { prompt: PROMPT, sessionId })).toEqual({ ok: false, code: "invalid_session_id" });
			expect(listPendingRequests(o, { sessionId })).toEqual({ ok: false, code: "invalid_session_id" });
			expect(showRequest(o, { sessionId, key: "0".repeat(32) })).toEqual({ ok: false, code: "invalid_session_id" });
			expect(answerRequest(o, { sessionId, key: "0".repeat(32), answer: "x" })).toEqual({ ok: false, code: "invalid_session_id" });
			expect(sessionStatus(o, { sessionId })).toEqual({ ok: false, code: "invalid_session_id" });
		}
		// Omitted ids are invalid for every entry point except startPlan, which generates one.
		expect(listPendingRequests(o, { sessionId: undefined })).toEqual({ ok: false, code: "invalid_session_id" });
		expect(sessionStatus(o, { sessionId: undefined })).toEqual({ ok: false, code: "invalid_session_id" });
		expect(existsSync(join(stateDir, "cwd"))).toBe(false);
	});

	test("returns session_conflict when a session id is reused with a different prompt", async () => {
		const o = opts(newState());
		const sessionId = randomUUID();
		expect((await startPlan(o, { prompt: PROMPT, sessionId })).ok).toBe(true);
		expect(await startPlan(o, { prompt: "A different prompt entirely.", sessionId })).toEqual({ ok: false, code: "session_conflict" });
	});

	test("replays a planned session idempotently with no new pending entries", async () => {
		const o = opts(newState());
		const sessionId = randomUUID();
		await drivePlan(o, sessionId);
		const replay = await startPlan(o, { prompt: `\n  ${PROMPT}  \u0007`, sessionId });
		expect(replay).toEqual({ ok: true, data: { sessionId, status: "planned", pending: [] } });
	});

	test("returns not_found from every read entry point for an unknown session", async () => {
		const o = opts(newState());
		const sessionId = randomUUID();
		const key = "0".repeat(32);
		expect(listPendingRequests(o, { sessionId })).toEqual({ ok: false, code: "not_found" });
		expect(showRequest(o, { sessionId, key })).toEqual({ ok: false, code: "not_found" });
		expect(answerRequest(o, { sessionId, key, answer: "x" })).toEqual({ ok: false, code: "not_found" });
		expect(sessionStatus(o, { sessionId })).toEqual({ ok: false, code: "not_found" });
	});

	test("never returns the state directory path in any result", async () => {
		const stateDir = newState();
		const o = opts(stateDir);
		const log: unknown[] = [];
		await drivePlan(o, randomUUID(), log);
		const sessionId = randomUUID();
		log.push(await startPlan(o, { prompt: PROMPT, sessionId }));
		log.push(answerRequest(o, { sessionId, key: firstKey(o, sessionId), answer: "not an answer" }));
		log.push(sessionStatus(o, { sessionId }));
		expect(JSON.stringify(log)).not.toContain(stateDir);
	});

	test("returns invalid_input for an unknown show part", async () => {
		const o = opts(newState());
		const sessionId = randomUUID();
		expect((await startPlan(o, { prompt: PROMPT, sessionId })).ok).toBe(true);
		const key = firstKey(o, sessionId);
		expect(showRequest(o, { sessionId, key, part: "nonsense" })).toEqual({ ok: false, code: "invalid_input" });
	});

	test("validates prompts: non-string, empty after cleaning, and oversized inputs are invalid_input", async () => {
		const o = opts(newState());
		expect(await startPlan(o, { prompt: 42 })).toEqual({ ok: false, code: "invalid_input" });
		expect(await startPlan(o, { prompt: " \u0001\n\t " })).toEqual({ ok: false, code: "invalid_input" });
		expect(await startPlan(o, { prompt: "x".repeat(4001) })).toEqual({ ok: false, code: "invalid_input" });
		const cleaned = await startPlan(o, { prompt: "\u0007Build a CLI\u0000 now" });
		expect(cleaned).toMatchObject({ ok: true, data: { status: "needs-model" } });
	});
});

describe("journal config isolation", () => {
	test("ignores a hostile operator config reachable through HOME, XDG_CONFIG_HOME and CLAUDE_CONFIG_DIR", async () => {
		const hostile = tmp();
		const body = JSON.stringify({ uplift: { enabled: false } });
		for (const file of [
			join(hostile, "xdg", "ultrathink", "config.json"),
			join(hostile, "claude", "ultrathink.json"),
			join(hostile, "home", ".config", "ultrathink", "config.json"),
		]) {
			mkdirSync(dirname(file), { recursive: true });
			writeFileSync(file, body);
		}
		const keys = ["HOME", "XDG_CONFIG_HOME", "CLAUDE_CONFIG_DIR"] as const;
		const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
		process.env.HOME = join(hostile, "home");
		process.env.XDG_CONFIG_HOME = join(hostile, "xdg");
		process.env.CLAUDE_CONFIG_DIR = join(hostile, "claude");
		try {
			// The fixture is hostile: read the way the plugin reads it, it switches planning off.
			expect(loadConfig(claudeConfigPaths(join(hostile, "cwd"))).uplift.enabled).toBe(false);
			const stateDir = newState();
			const plan = await startPlan(opts(stateDir), { prompt: PROMPT });
			expect(plan).toMatchObject({ ok: true, data: { status: "needs-model" } });
		} finally {
			for (const key of keys) {
				if (saved[key] === undefined) delete process.env[key];
				else process.env[key] = saved[key];
			}
		}
	});
});
