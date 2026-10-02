// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import { QUESTIONS } from "../decisions/questions.ts";
import { DEFAULT_DECISIONS_CONFIG, type DecisionsConfig } from "../decisions/types.ts";
import { DEFAULT_HINDSIGHT_CONFIG } from "../hindsight/types.ts";
import { DISTILL_SYSTEM, observeDigest, parseLessons } from "./observe.ts";
import {
	type CaptureFn,
	type CaptureInput,
	DEFAULT_TEACH_CONFIG,
	type DigestTurn,
	MOMENT_KINDS,
	type TeachContext,
	type TeachDigest,
	type TeachConfig,
} from "./types.ts";

const KEY = "sk-abcdefghijklmnopqrstuvwxyz0123456789ABCD";

function lessonJson(...items: Record<string, unknown>[]): string {
	return JSON.stringify({ lessons: items });
}

const GOOD = { name: "Use import type", description: "tsc rejects value imports of types", body: "Use `import type` for type-only imports.", kind: "pitfall", confidence: 0.9 };

const RECOVERY_TURNS: DigestTurn[] = [
	{ role: "user", text: "make the build pass" },
	{ role: "assistant", tool: "Bash", text: "Bash: bun run build" },
	{ role: "tool", tool: "Bash", text: "TS1484: use import type", isError: true },
	{ role: "assistant", tool: "Edit", text: "Edit: src/a.ts" },
	{ role: "tool", tool: "Edit", text: "edited" },
	{ role: "assistant", text: "Fixed." },
];

function digest(overrides: Partial<TeachDigest> = {}): TeachDigest {
	return { host: "claude-code", sessionId: "sess-1", cwd: "/work/repo", at: "2026-10-02T10:00:00.000Z", turns: RECOVERY_TURNS, toolCalls: 4, ...overrides };
}

interface Harness {
	ctx: TeachContext;
	completions: { system: string; user: string }[];
	captured: CaptureInput[];
	capture: CaptureFn;
}

function harness(options: { teach?: Partial<TeachConfig>; env?: NodeJS.ProcessEnv; reply?: string | (() => string | Promise<string>) } = {}): Harness {
	const completions: { system: string; user: string }[] = [];
	const captured: CaptureInput[] = [];
	let clock = 1_000;
	const reply = options.reply ?? lessonJson(GOOD);
	const ctx: TeachContext = {
		host: "claude-code",
		cwd: "/work/repo",
		sessionId: "sess-1",
		config: { teach: { ...DEFAULT_TEACH_CONFIG, enabled: true, capture: "observe", ...options.teach }, hindsight: DEFAULT_HINDSIGHT_CONFIG },
		env: { HOME: "/home/someone", ...options.env },
		stateDir: "/nonexistent-state",
		now: () => (clock += 5),
		complete: async (system, user) => {
			completions.push({ system, user });
			return typeof reply === "function" ? reply() : reply;
		},
	};
	const capture: CaptureFn = async (input) => {
		captured.push(input);
		return {
			moment: {
				id: `m${captured.length}`,
				name: input.name,
				description: input.description ?? "",
				body: input.body,
				sourcePhase: input.sourcePhase ?? "",
				sourceArtifacts: [],
				createdAt: "2026-10-02T10:00:00.000Z",
				tags: [],
				relatedIds: [],
				schema: 2,
				kind: input.kind ?? "pitfall",
				status: input.status ?? "candidate",
				origin: input.origin ?? "observe",
				project: "repo",
				host: "claude-code",
				confidence: input.confidence ?? 0.5,
				occurrences: 1,
				lastSeenAt: "2026-10-02T10:00:00.000Z",
				dedupeKey: "k",
				recalled: 0,
			},
			created: true,
			retain: "local-only",
		};
	};
	return { ctx, completions, captured, capture };
}

describe("observeDigest skips", () => {
	test.each([
		["Teachable Moments is off", { teach: { enabled: false } }, undefined],
		["the kill switch is set", {}, { ULTRATHINK_TEACH: "0" }],
		["capture mode is explicit", { teach: { capture: "explicit" as const } }, undefined],
		["running inside a child invocation", {}, { ULTRATHINK_CHILD: "1" }],
	])("when %s", async (_name, options, env) => {
		const h = harness({ ...options, env });
		const outcome = await observeDigest(digest(), h.ctx, { capture: h.capture });
		expect(outcome.skipped).toBeTruthy();
		expect(outcome.captured).toEqual([]);
		expect(h.completions).toHaveLength(0);
		expect(h.captured).toHaveLength(0);
	});

	test("when the session had fewer tool calls than observeMinToolCalls", async () => {
		const h = harness({ teach: { observeMinToolCalls: 5 } });
		const outcome = await observeDigest(digest({ toolCalls: 4 }), h.ctx, { capture: h.capture });
		expect(outcome.skipped).toBe("too few tool calls");
		expect(h.completions).toHaveLength(0);
		const enough = await observeDigest(digest({ toolCalls: 5 }), h.ctx, { capture: h.capture });
		expect(enough.skipped).toBeUndefined();
		expect(h.completions).toHaveLength(1);
	});

	test("when there is no signal", async () => {
		const h = harness();
		const quiet = digest({
			turns: [
				{ role: "user", text: "add a flag" },
				{ role: "assistant", tool: "Edit", text: "Edit: a.ts" },
				{ role: "tool", tool: "Edit", text: "ok" },
				{ role: "assistant", text: "done" },
			],
		});
		const outcome = await observeDigest(quiet, h.ctx, { capture: h.capture });
		expect(outcome.skipped).toBe("no signal");
		expect(h.completions).toHaveLength(0);
	});
});

describe("observeDigest signal detection", () => {
	const user = (text: string): DigestTurn => ({ role: "user", text });
	const assistant = (text: string): DigestTurn => ({ role: "assistant", text });
	const tool = (text: string, isError = false): DigestTurn => ({ role: "tool", tool: "Bash", text, ...(isError ? { isError } : {}) });

	test.each<[string, DigestTurn[], TeachDigest["outcome"], boolean]>([
		["a tool error followed by a success", [user("a"), tool("e", true), tool("ok"), assistant("z")], undefined, true],
		["a tool success before the error only", [user("a"), tool("ok"), tool("e", true), assistant("z")], undefined, false],
		["a tool error that is never followed by a success", [user("a"), tool("e", true), assistant("z")], "completed", false],
		["a user correction after the first prompt", [user("build it"), assistant("done"), user("No, that's wrong: use bun")], undefined, true],
		["a correction word in a later user turn (instead)", [user("build it"), assistant("done"), user("do it with fetch instead")], undefined, true],
		["a correction phrase only in the first prompt", [user("don't forget to stop the server, actually"), assistant("ok")], undefined, false],
		["a polite follow-up", [user("build it"), assistant("done"), user("thanks, now add tests")], undefined, false],
		["a failed run with tool errors", [user("a"), tool("e", true), assistant("gave up")], "failed", true],
		["an interrupted run with tool errors", [user("a"), tool("e", true), assistant("...")], "interrupted", true],
		["a failed run without tool errors", [user("a"), tool("ok"), assistant("gave up")], "failed", false],
	])("%s", async (_name, turns, outcome, expected) => {
		const h = harness();
		const result = await observeDigest(digest({ turns, outcome }), h.ctx, { capture: h.capture });
		expect(h.completions).toHaveLength(expected ? 1 : 0);
		expect(result.skipped).toBe(expected ? undefined : "no signal");
	});
});

describe("observeDigest redaction", () => {
	test("a planted secret never reaches the completer or the captured lesson", async () => {
		const h = harness({ reply: lessonJson({ ...GOOD, body: `Set the key ${KEY} before running.`, name: `Key ${KEY}`, description: `uses ${KEY}` }) });
		const turns: DigestTurn[] = [
			{ role: "user", text: `use ${KEY} to call the api` },
			{ role: "assistant", tool: "Bash", text: `Bash: curl -H "Authorization: Bearer ${KEY}" https://x` },
			{ role: "tool", tool: "Bash", text: `401 for key ${KEY}`, isError: true },
			{ role: "tool", tool: "Bash", text: "200" },
		];
		await observeDigest(digest({ turns }), h.ctx, { capture: h.capture });
		expect(h.completions).toHaveLength(1);
		expect(h.completions[0]?.user).not.toContain(KEY);
		expect(h.completions[0]?.system).not.toContain(KEY);
		expect(h.completions[0]?.user).toContain("[tool Bash ERROR]");
		expect(JSON.stringify(h.captured)).not.toContain(KEY);
		expect(h.captured).toHaveLength(1);
	});

	test("the transcript is presented as untrusted data and the system prompt demands JSON with the lesson kinds", async () => {
		const h = harness();
		await observeDigest(digest(), h.ctx, { capture: h.capture });
		expect(h.completions[0]?.user).toContain("<session>");
		expect(h.completions[0]?.system).toBe(DISTILL_SYSTEM);
		expect(DISTILL_SYSTEM).toContain('{"lessons":[]}');
		for (const kind of MOMENT_KINDS) expect(DISTILL_SYSTEM).toContain(kind);
	});
});

describe("parseLessons", () => {
	test("parses valid lessons", () => {
		expect(parseLessons(lessonJson(GOOD))).toEqual([{ name: GOOD.name, description: GOOD.description, body: GOOD.body, kind: "pitfall", confidence: 0.9 }]);
	});

	test("finds the JSON object inside prose and code fences", () => {
		const text = `Sure! Here you go:\n\`\`\`json\n${lessonJson(GOOD)}\n\`\`\`\nHope that helps {not json}.`;
		expect(parseLessons(text)).toHaveLength(1);
	});

	test("skips an unparseable brace span and balanced braces inside strings", () => {
		const tricky = lessonJson({ ...GOOD, body: 'Escape "{" and \\"}" carefully: {x}' });
		expect(parseLessons(`{oops not json} then ${tricky}`)[0]?.body).toBe('Escape "{" and \\"}" carefully: {x}');
	});

	test("drops invalid items, keeps the rest", () => {
		const items = [
			{ ...GOOD, kind: "rumor" },
			{ ...GOOD, name: "   " },
			{ ...GOOD, body: "" },
			{ ...GOOD, name: 5 },
			{ ...GOOD, description: 7 },
			{ ...GOOD, confidence: "high" },
			{ ...GOOD, confidence: null },
			"nope",
			null,
			{ ...GOOD, name: "Valid one", kind: "playbook" },
		];
		const lessons = parseLessons(lessonJson(...(items as Record<string, unknown>[])));
		expect(lessons.map((l) => l.name)).toEqual(["Valid one"]);
		expect(lessons[0]?.kind).toBe("playbook");
	});

	test("keeps at most three, in order", () => {
		const lessons = parseLessons(lessonJson(...[1, 2, 3, 4, 5].map((n) => ({ ...GOOD, name: `lesson ${n}` }))));
		expect(lessons.map((l) => l.name)).toEqual(["lesson 1", "lesson 2", "lesson 3"]);
	});

	test("clamps confidence and defaults a missing one", () => {
		const { confidence: _drop, ...noConfidence } = GOOD;
		const lessons = parseLessons(lessonJson({ ...GOOD, confidence: 7 }, { ...GOOD, confidence: -2 }, noConfidence));
		expect(lessons.map((l) => l.confidence)).toEqual([1, 0, 0.5]);
	});

	test("clips name, description and body to their limits", () => {
		const [lesson] = parseLessons(lessonJson({ ...GOOD, name: "n".repeat(500), description: "d".repeat(900), body: "b".repeat(5000) }));
		expect(lesson?.name.length).toBe(120);
		expect(lesson?.description.length).toBe(300);
		expect(lesson?.body.length).toBe(1200);
	});

	test("derives a missing description from the body", () => {
		const { description: _drop, ...noDescription } = GOOD;
		expect(parseLessons(lessonJson(noDescription))[0]?.description).toBe(GOOD.body);
	});

	test.each([
		["empty", ""],
		["prose", "I could not find any lessons."],
		["empty lessons", '{"lessons":[]}'],
		["lessons not an array", '{"lessons":"many"}'],
		["no lessons key", '{"items":[1]}'],
		["a list without a lessons object", "[1,2]"],
		["truncated JSON", '{"lessons":[{"name":"x"'],
	])("returns nothing for %s", (_name, text) => {
		expect(parseLessons(text)).toEqual([]);
	});
});

describe("observeDigest capture", () => {
	test("observe mode captures every lesson as a candidate", async () => {
		const h = harness({ reply: lessonJson(GOOD, { ...GOOD, name: "Second", kind: "bug", confidence: 0.3 }) });
		const outcome = await observeDigest(digest(), h.ctx, { capture: h.capture });
		expect(outcome.skipped).toBeUndefined();
		expect(outcome.captured).toHaveLength(2);
		expect(outcome.ms).toBeGreaterThan(0);
		expect(h.captured.map((c) => c.status)).toEqual(["candidate", "candidate"]);
		expect(h.captured[0]).toMatchObject({ name: GOOD.name, kind: "pitfall", origin: "observe", confidence: 0.9, sourcePhase: "session:sess-1" });
		expect(h.captured[1]).toMatchObject({ name: "Second", kind: "bug", confidence: 0.3 });
	});

	test("auto mode confirms lessons at 0.8 and above, and leaves the rest candidates", async () => {
		const h = harness({
			teach: { capture: "auto" },
			reply: lessonJson({ ...GOOD, name: "high", confidence: 0.95 }, { ...GOOD, name: "edge", confidence: 0.8 }, { ...GOOD, name: "low", confidence: 0.79 }),
		});
		await observeDigest(digest(), h.ctx, { capture: h.capture });
		expect(h.captured.map((c) => [c.name, c.status])).toEqual([
			["high", "confirmed"],
			["edge", "confirmed"],
			["low", "candidate"],
		]);
	});

	test("an empty lessons answer captures nothing and is not a skip", async () => {
		const h = harness({ reply: '{"lessons":[]}' });
		const outcome = await observeDigest(digest(), h.ctx, { capture: h.capture });
		expect(outcome).toMatchObject({ captured: [] });
		expect(outcome.skipped).toBeUndefined();
	});

	test("a failing capture does not stop the other lessons", async () => {
		const h = harness({ reply: lessonJson({ ...GOOD, name: "first" }, { ...GOOD, name: "second" }) });
		let calls = 0;
		const flaky: CaptureFn = async (input, ctx) => {
			if (++calls === 1) throw new Error("disk full");
			return h.capture(input, ctx);
		};
		const outcome = await observeDigest(digest(), h.ctx, { capture: flaky });
		expect(outcome.captured.map((c) => c.moment.name)).toEqual(["second"]);
	});
});

describe("observeDigest never throws", () => {
	test("a completer that throws, rejects or hangs yields a skip", async () => {
		for (const complete of [
			(): Promise<string> => {
				throw new Error("boom");
			},
			async (): Promise<string> => {
				throw new Error("rejected");
			},
			(): Promise<string> => new Promise(() => {}),
		]) {
			const h = harness();
			h.ctx.complete = complete;
			const outcome = await observeDigest(digest(), h.ctx, { capture: h.capture, timeoutMs: 20 });
			expect(outcome.skipped).toBe("distiller failed");
			expect(h.captured).toHaveLength(0);
		}
	});

	test("a malformed digest yields a skip, not an exception", async () => {
		const h = harness();
		const outcome = await observeDigest({} as unknown as TeachDigest, h.ctx, { capture: h.capture });
		expect(outcome.skipped).toBe("error");
		expect(outcome.captured).toEqual([]);
	});

	test("the caller's abort signal stops the distiller", async () => {
		const h = harness();
		const controller = new AbortController();
		h.ctx.signal = controller.signal;
		h.ctx.complete = () => new Promise(() => {});
		const pending = observeDigest(digest(), h.ctx, { capture: h.capture });
		controller.abort();
		expect((await pending).skipped).toBe("distiller failed");
	});
});

describe("observeDigest with the Jev teachable point", () => {
	const JEV_KEY = "sk-or-v1-UTTESTKEY-0123456789abcdef";

	/** A fake Decisions endpoint: each request is answered with the next P (the last repeats), a Response, or a thrown error. */
	function jev(h: Harness, answers: Array<number | Response | Error>, config: Partial<DecisionsConfig> = {}) {
		const bodies: { state: Record<string, unknown>; questions: Record<string, unknown> }[] = [];
		h.ctx.config = {
			...h.ctx.config,
			decisions: { ...DEFAULT_DECISIONS_CONFIG, enabled: true, points: ["teachable"], ...config },
		};
		h.ctx.env = { ...h.ctx.env, OPENROUTER_API_KEY: JEV_KEY };
		h.ctx.storePath = "/nonexistent-state/credentials.json";
		h.ctx.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
			bodies.push(JSON.parse(String(init?.body)));
			const next = answers[Math.min(bodies.length, answers.length) - 1];
			if (next instanceof Error) throw next;
			if (next instanceof Response) return next.clone();
			return Response.json({
				model: "typesafe/jev-1.13-20260917",
				answers: { teachable: { type: "noul", noul: next } },
				usage: { input_tokens: 10, output_tokens: 0 },
			});
		}) as typeof fetch;
		return bodies;
	}

	test("asks the teachable question with the redacted candidate and drops a lesson below teachableBelow before it is stored", async () => {
		const secret = { ...GOOD, name: "keep", body: `token ${KEY} then ${"x".repeat(1000)}` };
		const h = harness({ reply: lessonJson({ ...GOOD, name: "noise" }, secret) });
		const bodies = jev(h, [0.29, 0.31]);
		const outcome = await observeDigest(digest(), h.ctx, { capture: h.capture });
		expect(h.captured.map((c) => c.name)).toEqual(["keep"]);
		expect(outcome.dropped).toBe(1);
		expect(outcome.decisions).toEqual([
			{ point: "teachable", p: 0.29, action: "drop" },
			{ point: "teachable", p: 0.31, action: "keep" },
		]);
		expect(bodies[0]?.questions).toEqual({ teachable: QUESTIONS.teachable });
		const state = bodies[1]?.state as { body: string };
		expect(state).toMatchObject({ name: "keep", description: GOOD.description, kind: "pitfall" });
		expect(state.body.length).toBe(800);
		expect(state.body.startsWith("token ")).toBe(true);
		expect(JSON.stringify(bodies)).not.toContain(KEY);
		expect(JSON.stringify(outcome.decisions)).not.toContain(GOOD.description);
	});

	test("the threshold is exclusive: P equal to teachableBelow keeps the lesson", async () => {
		const h = harness();
		jev(h, [0.5], { teachableBelow: 0.5 });
		const outcome = await observeDigest(digest(), h.ctx, { capture: h.capture });
		expect(outcome.dropped).toBe(0);
		expect(h.captured).toHaveLength(1);
	});

	test("auto mode confirms only when confidence >= 0.8 and P >= teachableAutoAt; Jev only holds a lesson back", async () => {
		const h = harness({
			teach: { capture: "auto" },
			reply: lessonJson(
				{ ...GOOD, name: "sure", confidence: 0.95 },
				{ ...GOOD, name: "unsure", confidence: 0.95 },
				{ ...GOOD, name: "lowbar", confidence: 0.5 },
			),
		});
		jev(h, [0.8, 0.79, 0.99]);
		const outcome = await observeDigest(digest(), h.ctx, { capture: h.capture });
		expect(h.captured.map((c) => [c.name, c.status])).toEqual([
			["sure", "confirmed"],
			["unsure", "candidate"],
			["lowbar", "candidate"],
		]);
		expect(outcome.decisions.map((d) => d.action)).toEqual(["auto-confirm", "hold", "keep"]);
	});

	test("in observe mode a high P never confirms", async () => {
		const h = harness();
		jev(h, [0.99]);
		await observeDigest(digest(), h.ctx, { capture: h.capture });
		expect(h.captured.map((c) => c.status)).toEqual(["candidate"]);
	});

	test.each([
		["a network error", new Error("connection refused")],
		["a 402", Response.json({ error: { message: "no credits" } }, { status: 402 })],
		["a 401", Response.json({ error: { message: "bad key" } }, { status: 401 })],
		["a 500", Response.json({ error: { message: "down" } }, { status: 500 })],
		["an invalid answer", Response.json({ model: "m", answers: { teachable: { type: "noul", noul: 3 } }, usage: {} })],
		["a non-JSON body", new Response("<html>")],
	])("%s behaves exactly like Decisions off (auto mode still confirms)", async (_name, answer) => {
		const off = harness({ teach: { capture: "auto" } });
		await observeDigest(digest(), off.ctx, { capture: off.capture });

		const h = harness({ teach: { capture: "auto" } });
		jev(h, [answer]);
		const outcome = await observeDigest(digest(), h.ctx, { capture: h.capture });
		expect(h.captured).toEqual(off.captured);
		expect(outcome.dropped).toBe(0);
		expect(outcome.decisions).toEqual([{ point: "teachable", action: "fail-open" }]);
	});

	test("a timeout fails open", async () => {
		const h = harness({ teach: { capture: "auto" } });
		jev(h, [0.0], { timeoutMs: 20 });
		h.ctx.fetch = ((_url: string | URL | Request, init?: RequestInit) =>
			new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
			})) as typeof fetch;
		const outcome = await observeDigest(digest(), h.ctx, { capture: h.capture });
		expect(h.captured.map((c) => c.status)).toEqual(["confirmed"]);
		expect(outcome.decisions).toEqual([{ point: "teachable", action: "fail-open" }]);
	});

	test("no key, a disabled point, the kill switch or no decisions section make no request", async () => {
		for (const setup of [
			(h: Harness) => {
				h.ctx.env = { HOME: "/home/someone" };
			},
			(h: Harness) => {
				h.ctx.config = { ...h.ctx.config, decisions: { ...DEFAULT_DECISIONS_CONFIG, enabled: true, points: ["plan"] } };
			},
			(h: Harness) => {
				h.ctx.config = { ...h.ctx.config, decisions: { ...DEFAULT_DECISIONS_CONFIG, enabled: false } };
			},
			(h: Harness) => {
				h.ctx.env = { ...h.ctx.env, ULTRATHINK_DECISIONS: "0" };
			},
			(h: Harness) => {
				delete h.ctx.config.decisions;
			},
		]) {
			const h = harness();
			const bodies = jev(h, [0.0]);
			setup(h);
			const outcome = await observeDigest(digest(), h.ctx, { capture: h.capture });
			expect(bodies).toHaveLength(0);
			expect(h.captured).toHaveLength(1);
			expect(outcome).toMatchObject({ dropped: 0, decisions: [] });
		}
	});
});
