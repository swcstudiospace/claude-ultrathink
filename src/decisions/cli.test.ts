// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type DecisionsCommandDeps, runDecisionsCommand } from "./cli.ts";
import { QUESTIONS } from "./questions.ts";

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

const USAGE =
	"Usage: ultrathink decisions check | ultrathink decisions probe <plan|ship|knowledge|blocking|teachable|skillworthy> <cases.json>";
const NO_KEY = "no OpenRouter key (run bin/ultrathink-mcp auth set-key openrouter --stdin, or set OPENROUTER_API_KEY)";

/** Temp project, config layers and credential store; the env holds K unless overridden. */
function setup(
	r: { fetch: typeof fetch },
	opts: { config?: unknown; storeKey?: string; env?: Record<string, string | undefined> } = {},
): DecisionsCommandDeps {
	const root = mkdtempSync(join(tmpdir(), "ut-decisions-cli-"));
	dirs.push(root);
	const cwd = join(root, "project");
	mkdirSync(cwd, { recursive: true });
	const xdg = join(root, "xdg");
	if (opts.config !== undefined) {
		mkdirSync(join(xdg, "ultrathink"), { recursive: true });
		writeFileSync(join(xdg, "ultrathink", "config.json"), JSON.stringify(opts.config));
	}
	const storePath = join(root, "mcp-credentials.json");
	if (opts.storeKey !== undefined) {
		writeFileSync(storePath, JSON.stringify({ version: 1, providers: { openrouter: { kind: "api_key", apiKey: opts.storeKey, updatedAt: 1 } } }));
	}
	return {
		cwd,
		env: { XDG_CONFIG_HOME: xdg, CLAUDE_CONFIG_DIR: join(root, "claude"), HOME: join(root, "home"), OPENROUTER_API_KEY: K, ...opts.env },
		storePath,
		fetch: r.fetch,
		now: () => 5000,
		sleep: async () => {},
		random: () => 0.5,
	};
}

function writeCases(deps: DecisionsCommandDeps, cases: unknown, name = "cases.json"): string {
	writeFileSync(join(deps.cwd, name), typeof cases === "string" ? cases : JSON.stringify(cases));
	return name;
}

/** Rule T6 on every CLI output. */
function expectNoKey(text: string): void {
	expect(text).not.toContain(K);
	expect(text).not.toContain("Bearer sk-or-");
	expect(text.endsWith("\n")).toBe(false);
}

describe("decisions check", () => {
	test("AC-9.3: prints the resolved model, latency, cost, zdr and key source, exit 0, one request", async () => {
		const r = recordingFetch([JEV(0.9)]);
		const out = await runDecisionsCommand(["check"], setup(r));
		expect(out).toEqual({
			code: 0,
			text: "Decisions check: ok · typesafe/jev-1.13-20260917 (requested ~typesafe/jev-latest) · 0 ms · attempts 1 · cost 0.000019 · zdr on · key from OPENROUTER_API_KEY",
		});
		expectNoKey(out.text);
		expect(r.calls).toHaveLength(1);
		expect(r.calls[0]?.url).toBe(ENDPOINT);
		expect(r.calls[0]?.body).toEqual({
			model: "~typesafe/jev-latest",
			state: { message: "Add a --verbose flag to the export command", recent_conversation: "" },
			questions: { plan_worthy: QUESTIONS.plan },
			provider: { zdr: true, data_collection: "deny" },
			trace: { trace_name: "ultrathink", span_name: "check" },
		});
	});

	test("AC-9.4: an auth failure prints the kind and the redacted message, exit 1, never the key", async () => {
		const r = recordingFetch([ERR(401)]);
		const out = await runDecisionsCommand(["check"], setup(r));
		expect(out).toEqual({
			code: 1,
			text: "Decisions check: error (auth) · decisions auth: HTTP 401: upstream said no for [redacted] · 0 ms · attempts 1 · zdr on · key from OPENROUTER_API_KEY",
		});
		expectNoKey(out.text);
	});

	test("reports a stored key and the URL override as origin + path only (query and hash never sent or printed)", async () => {
		const noCost = () =>
			Response.json({ model: "typesafe/jev-1.13-20260917", answers: { plan_worthy: { type: "noul", noul: 0.9 } }, usage: { input_tokens: 1, output_tokens: 0 } });
		const r = recordingFetch([noCost]);
		const deps = setup(r, {
			storeKey: K,
			env: { OPENROUTER_API_KEY: undefined, ULTRATHINK_DECISIONS_URL: "http://127.0.0.1:9999/decisions?token=secret#frag" },
		});
		const out = await runDecisionsCommand(["check"], deps);
		expect(out.text).toBe(
			"Decisions check: ok · typesafe/jev-1.13-20260917 (requested ~typesafe/jev-latest) · 0 ms · attempts 1 · cost n/a · zdr on · key from store · url http://127.0.0.1:9999/decisions",
		);
		expect(r.calls.map((call) => call.url)).toEqual(["http://127.0.0.1:9999/decisions"]);
		expect(r.calls[0]?.headers.authorization).toBe(`Bearer ${K}`);
	});

	test("K2: a rejected URL override is never contacted or printed; the default endpoint is used and the override flagged ignored", async () => {
		for (const [override, reply] of [
			["https://user:hunter2@gw.example/d", JEV(0.9)],
			["http://gw.example/d", ERR(401)],
		] as const) {
			const r = recordingFetch([reply]);
			const out = await runDecisionsCommand(["check"], setup(r, { env: { ULTRATHINK_DECISIONS_URL: override } }));
			expect(out.text.endsWith(" · key from OPENROUTER_API_KEY · ULTRATHINK_DECISIONS_URL ignored (must be https://openrouter.ai/… or a loopback URL)")).toBe(true);
			expect(out.text).not.toContain("gw.example");
			expect(out.text).not.toContain("hunter2");
			expect(r.calls.map((call) => call.url)).toEqual([ENDPOINT]);
		}
	});

	test("K1: ULTRATHINK_DECISIONS=0 refuses even with a key, exit 1, zero requests", async () => {
		const r = recordingFetch([JEV(0.9)]);
		const out = await runDecisionsCommand(["check"], setup(r, { storeKey: K, env: { ULTRATHINK_DECISIONS: "0" } }));
		expect(out).toEqual({ code: 1, text: "Decisions check: off (ULTRATHINK_DECISIONS=0)" });
		expect(r.calls).toHaveLength(0);
	});

	test("uses the configured model and zdr but ignores enabled and points", async () => {
		const r = recordingFetch([JEV(0.9)]);
		const deps = setup(r, { config: { decisions: { enabled: false, points: [], model: "typesafe/jev-1.13", zdr: false } } });
		const out = await runDecisionsCommand(["check"], deps);
		expect(out.code).toBe(0);
		expect(out.text).toContain("(requested typesafe/jev-1.13)");
		expect(out.text).toContain("· zdr off ·");
		expect(r.calls).toHaveLength(1);
		expect(r.calls[0]?.body).not.toHaveProperty("provider");
		expect((r.calls[0]?.body as { model: string }).model).toBe("typesafe/jev-1.13");
	});

	test("without a key prints how to add one, exit 1, zero requests", async () => {
		const r = recordingFetch([JEV(0.9)]);
		const out = await runDecisionsCommand(["check"], setup(r, { env: { OPENROUTER_API_KEY: undefined } }));
		expect(out).toEqual({ code: 1, text: `Decisions check: ${NO_KEY}` });
		expect(r.calls).toHaveLength(0);
	});
});

describe("decisions usage", () => {
	test.each([[[]], [["check", "extra"]], [["bogus"]], [["probe", "plan"]], [["probe", "nope", "cases.json"]], [["probe", "plan", "a", "b"]]])(
		"%j prints the usage with exit 2 and makes no request",
		async (argv) => {
			const r = recordingFetch([JEV(0.9)]);
			expect(await runDecisionsCommand(argv, setup(r))).toEqual({ code: 2, text: USAGE });
			expect(r.calls).toHaveLength(0);
		},
	);
});

describe("decisions probe (A11, §5.7)", () => {
	test("plan: one line per case with P, action and label agreement, then the totals; disagreement exits 0", async () => {
		const r = recordingFetch([JEV(0.97), JEV(0.04), JEV(0.19)]);
		const deps = setup(r);
		const file = writeCases(deps, [
			{ message: "Add OAuth login with GitHub to the web app", label: true },
			{ message: "thanks, that works now", recent_conversation: "Assistant: done", label: true },
			{ message: "rename two files" },
		]);
		const out = await runDecisionsCommand(["probe", "plan", file], deps);
		expect(out).toEqual({
			code: 0,
			text: [
				"#1 P 0.97 · plan · label true · agree",
				"#2 P 0.04 · skip-plan · label true · DISAGREE",
				"#3 P 0.19 · skip-plan",
				"Decisions probe: plan · typesafe/jev-1.13-20260917 · cases 3 · labelled 2 · agree 1/2 · errors 0",
			].join("\n"),
		});
		expectNoKey(out.text);
		expect(r.calls).toHaveLength(3);
		for (const call of r.calls) {
			expect(call.body).toMatchObject({ trace: { trace_name: "ultrathink", span_name: "plan" } });
			expect(call.body).not.toHaveProperty("session_id");
		}
		expect((r.calls[1]?.body as { state: unknown }).state).toEqual({ message: "thanks, that works now", recent_conversation: "Assistant: done" });
	});

	test("ship: veto, pass and approve under the thresholds; agreement follows the ship rule", async () => {
		const r = recordingFetch([JEV(0.1, "complete"), JEV(0.5, "complete"), JEV(0.8, "complete")]);
		const deps = setup(r);
		const patch = "diff --git a/bun.lock b/bun.lock\n+lock\ndiff --git a/src/a.ts b/src/a.ts\n+code\n";
		const file = writeCases(deps, [
			{ request: "add a flag", patch, label: false },
			{ request: "add a flag", acceptance_criteria: ["flag works"], patch, label: true },
			{ request: "add a flag", patch, label: false },
		]);
		const out = await runDecisionsCommand(["probe", "ship", file], deps);
		expect(out.text.split("\n")).toEqual([
			"#1 P 0.10 · veto · label false · agree",
			"#2 P 0.50 · pass · label true · agree",
			"#3 P 0.80 · approve · label false · DISAGREE",
			"Decisions probe: ship · typesafe/jev-1.13-20260917 · cases 3 · labelled 3 · agree 2/3 · errors 0",
		]);
		expect(out.code).toBe(0);
		expect((r.calls[0]?.body as { state: unknown }).state).toEqual({
			request: "add a flag",
			acceptance_criteria: [],
			patch: "diff --git a/src/a.ts b/src/a.ts\n+code\n",
		});
		expect((r.calls[0]?.body as { questions: unknown }).questions).toEqual({ complete: QUESTIONS.ship });
	});

	test("teachable and skillworthy: the candidate is the whole state, actions follow the thresholds, labels agree by the veto rule", async () => {
		const teachable = recordingFetch([JEV(0.1, "teachable"), JEV(0.5, "teachable"), JEV(0.9, "teachable")]);
		const tDeps = setup(teachable);
		const candidate = { name: "Use import type", description: "tsc rejects value imports", body: "b".repeat(2000), kind: "pitfall" };
		const tFile = writeCases(tDeps, [
			{ candidate, label: false },
			{ candidate, label: true },
			{ candidate, label: false },
		]);
		const tOut = await runDecisionsCommand(["probe", "teachable", tFile], tDeps);
		expect(tOut.text.split("\n")).toEqual([
			"#1 P 0.10 · drop · label false · agree",
			"#2 P 0.50 · keep · label true · agree",
			"#3 P 0.90 · auto-confirm · label false · DISAGREE",
			"Decisions probe: teachable · typesafe/jev-1.13-20260917 · cases 3 · labelled 3 · agree 2/3 · errors 0",
		]);
		expect(teachable.calls[0]?.body).toMatchObject({
			state: { ...candidate, body: "b".repeat(800) },
			questions: { teachable: QUESTIONS.teachable },
			trace: { span_name: "teachable" },
		});

		const skill = recordingFetch([JEV(0.49, "skillworthy"), JEV(0.5, "skillworthy")]);
		const sDeps = setup(skill);
		const sFile = writeCases(sDeps, [
			{ candidate: { ...candidate, occurrences: 3 }, label: false },
			{ candidate: { ...candidate, occurrences: 3 }, label: true },
		]);
		const sOut = await runDecisionsCommand(["probe", "skillworthy", sFile], sDeps);
		expect(sOut.text.split("\n").slice(0, 2)).toEqual(["#1 P 0.49 · skip · label false · agree", "#2 P 0.50 · keep · label true · agree"]);
		expect(skill.calls[0]?.body).toMatchObject({ state: { ...candidate, body: "b".repeat(800), occurrences: 3 }, questions: { skillworthy: QUESTIONS.skillworthy } });
		expectNoKey(tOut.text);
	});

	test("knowledge and blocking use their thresholds and positive actions", async () => {
		const knowledge = recordingFetch([JEV(0.95, "supported"), JEV(0.79, "supported")]);
		const kDeps = setup(knowledge);
		const kFile = writeCases(kDeps, [
			{ question: "Token lifetime?", answer: "1 hour", document: "Tokens last 1 hour.", label: true },
			{ question: "Token lifetime?", answer: "1 day", document: "d".repeat(20_000), label: true },
		]);
		const kOut = await runDecisionsCommand(["probe", "knowledge", kFile], kDeps);
		expect(kOut.text.split("\n")).toEqual([
			"#1 P 0.95 · keep · label true · agree",
			"#2 P 0.79 · reject-claim · label true · DISAGREE",
			"Decisions probe: knowledge · typesafe/jev-1.13-20260917 · cases 2 · labelled 2 · agree 1/2 · errors 0",
		]);
		expect(((knowledge.calls[1]?.body as { state: { document: string } }).state.document).length).toBe(12_000);

		const blocking = recordingFetch([JEV(0.68, "risky"), JEV(0.07, "risky")]);
		const bDeps = setup(blocking);
		const bFile = writeCases(bDeps, [
			{ task: "t".repeat(5000), question: "Drop legacy_email?", default: "Drop the column: removes legacy_email", label: true },
			{ task: "Pick an icon set", question: "Which icons?", default: "Lucide", label: false },
		]);
		const bOut = await runDecisionsCommand(["probe", "blocking", bFile], bDeps);
		expect(bOut.text.split("\n")).toEqual([
			"#1 P 0.68 · promote · label true · agree",
			"#2 P 0.07 · keep · label false · agree",
			"Decisions probe: blocking · typesafe/jev-1.13-20260917 · cases 2 · labelled 2 · agree 2/2 · errors 0",
		]);
		expect((blocking.calls[0]?.body as { state: unknown }).state).toEqual({
			task: "t".repeat(4000),
			question: "Drop legacy_email?",
			default: "Drop the column: removes legacy_email",
		});
	});

	test("thresholds come from the config", async () => {
		const r = recordingFetch([JEV(0.4)]);
		const deps = setup(r, { config: { decisions: { planSkipBelow: 0.5 } } });
		const out = await runDecisionsCommand(["probe", "plan", writeCases(deps, [{ message: "do it" }])], deps);
		expect(out.text.split("\n")[0]).toBe("#1 P 0.40 · skip-plan");
	});

	test("a failed case prints its kind and the run exits 1", async () => {
		const r = recordingFetch([JEV(0.9), ERR(402)]);
		const deps = setup(r);
		const out = await runDecisionsCommand(["probe", "plan", writeCases(deps, [{ message: "a" }, { message: "b", label: true }])], deps);
		expect(out).toEqual({
			code: 1,
			text: [
				"#1 P 0.90 · plan",
				"#2 error (credits)",
				"Decisions probe: plan · typesafe/jev-1.13-20260917 · cases 2 · labelled 1 · agree 0/1 · errors 1",
			].join("\n"),
		});
		expectNoKey(out.text);
	});

	test("when every case fails the totals name the requested model", async () => {
		const r = recordingFetch([ERR(401)]);
		const deps = setup(r);
		const out = await runDecisionsCommand(["probe", "plan", writeCases(deps, [{ message: "a" }])], deps);
		expect(out.code).toBe(1);
		expect(out.text.split("\n").at(-1)).toBe("Decisions probe: plan · ~typesafe/jev-latest · cases 1 · labelled 0 · agree 0/0 · errors 1");
	});

	test.each([
		["a missing field", [{ message: "a" }, { message: "b" }, { recent_conversation: "x" }], `case #3: "message" must be a non-empty string`],
		["a blank field", [{ message: "   " }], `case #1: "message" must be a non-empty string`],
		["a label that is not boolean", [{ message: "a", label: "yes" }], `case #1: "label" must be true or false`],
		["a case that is not an object", ["message"], "case #1: must be a JSON object"],
		["an empty array", [], "cases.json is not a JSON array of 1 to 200 cases"],
		["an object", { message: "a" }, "cases.json is not a JSON array of 1 to 200 cases"],
		["201 cases", Array.from({ length: 201 }, () => ({ message: "a" })), "cases.json is not a JSON array of 1 to 200 cases"],
		["invalid JSON", "[{", "cases.json is not a JSON array of 1 to 200 cases"],
	])("an invalid plan file (%s) exits 2 before any request", async (_name, cases, reason) => {
		const r = recordingFetch([JEV(0.9)]);
		const deps = setup(r);
		const out = await runDecisionsCommand(["probe", "plan", writeCases(deps, cases)], deps);
		expect(out).toEqual({ code: 2, text: `Decisions probe: ${reason}` });
		expect(r.calls).toHaveLength(0);
	});

	test.each([
		["ship", [{ request: "r" }], `case #1: "patch" must be a string`],
		["ship", [{ request: "r", patch: "", acceptance_criteria: [1] }], `case #1: "acceptance_criteria" must be an array of strings`],
		["knowledge", [{ question: "q", answer: "a" }], `case #1: "document" must be a non-empty string`],
		["blocking", [{ task: "t", question: "q", default: "" }], `case #1: "default" must be a non-empty string`],
		["teachable", [{ label: true }], `case #1: "candidate" must be a JSON object`],
		["teachable", [{ candidate: ["x"] }], `case #1: "candidate" must be a JSON object`],
		["teachable", [{ candidate: { name: "n", description: "d", body: " ", kind: "bug" } }], `case #1: "candidate.body" must be a non-empty string`],
		["teachable", [{ candidate: { name: "n", description: "d", body: "b" } }], `case #1: "candidate.kind" must be a non-empty string`],
		["skillworthy", [{ candidate: { name: "n", description: "d", body: "b", kind: "bug" } }], `case #1: "candidate.occurrences" must be an integer of at least 1`],
		["skillworthy", [{ candidate: { name: "n", description: "d", body: "b", kind: "bug", occurrences: 0 } }], `case #1: "candidate.occurrences" must be an integer of at least 1`],
	])("an invalid %s case exits 2 before any request", async (point, cases, reason) => {
		const r = recordingFetch([JEV(0.9)]);
		const deps = setup(r);
		const out = await runDecisionsCommand(["probe", point, writeCases(deps, cases)], deps);
		expect(out).toEqual({ code: 2, text: `Decisions probe: ${reason}` });
		expect(r.calls).toHaveLength(0);
	});

	test("an unreadable file exits 2", async () => {
		const r = recordingFetch([JEV(0.9)]);
		expect(await runDecisionsCommand(["probe", "plan", "missing.json"], setup(r))).toEqual({
			code: 2,
			text: "Decisions probe: cannot read missing.json",
		});
		expect(r.calls).toHaveLength(0);
	});

	test("relative paths resolve against cwd for an injected reader", async () => {
		const r = recordingFetch([JEV(0.9)]);
		const deps = setup(r);
		const read: string[] = [];
		const out = await runDecisionsCommand(["probe", "plan", "cases.json"], {
			...deps,
			readFile: (path) => {
				read.push(path);
				return JSON.stringify([{ message: "a" }]);
			},
		});
		expect(out.code).toBe(0);
		expect(read).toEqual([join(deps.cwd, "cases.json")]);
	});

	test("without a key prints how to add one, exit 1, zero requests", async () => {
		const r = recordingFetch([JEV(0.9)]);
		const deps = setup(r, { env: { OPENROUTER_API_KEY: undefined } });
		const out = await runDecisionsCommand(["probe", "plan", writeCases(deps, [{ message: "a" }])], deps);
		expect(out).toEqual({ code: 1, text: `Decisions probe: ${NO_KEY}` });
		expect(r.calls).toHaveLength(0);
	});

	test("K1: ULTRATHINK_DECISIONS=0 refuses after validating the file, exit 1, zero requests", async () => {
		const r = recordingFetch([JEV(0.9)]);
		const deps = setup(r, { env: { ULTRATHINK_DECISIONS: "0" } });
		const out = await runDecisionsCommand(["probe", "plan", writeCases(deps, [{ message: "a" }])], deps);
		expect(out).toEqual({ code: 1, text: "Decisions probe: off (ULTRATHINK_DECISIONS=0)" });
		expect((await runDecisionsCommand(["probe", "plan", writeCases(deps, "[]")], deps)).code).toBe(2);
		expect(r.calls).toHaveLength(0);
	});
});
