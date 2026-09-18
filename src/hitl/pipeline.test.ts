import { describe, expect, test } from "bun:test";
import type { UpliftResult } from "../types.ts";
import { normalizeClarifications, runClarify } from "./pipeline.ts";
import { clarifySystemPrompt } from "./prompts.ts";

const uplift: UpliftResult = {
	xml: "<BUILD_PROMPT><ORIGINAL>add list</ORIGINAL><SCOPE>ui</SCOPE></BUILD_PROMPT>",
	original: "add list",
	root: "BUILD_PROMPT",
	source: "llm",
};

const twoOptions = [{ label: "Postgres", description: "durable" }, { label: "SQLite" }];

describe("normalizeClarifications", () => {
	test("drops items with fewer than two options and accepts a bare array", () => {
		const list = normalizeClarifications(
			[
				{ question: "Which db", options: [{ label: "only one" }] },
				{ question: "Which db", options: twoOptions },
			],
			4,
		);
		expect(list).toHaveLength(1);
		expect(list[0]?.question).toBe("Which db?");
		expect(list[0]?.options.map((option) => option.label)).toEqual(["Postgres", "SQLite"]);
	});

	test("caps header at 12 chars, falls back to Qn, and reassigns ids", () => {
		const list = normalizeClarifications(
			{
				questions: [
					{ id: "zzz", question: "A?", header: "This header is far too long", options: twoOptions },
					{ id: "zzz", question: "B?", options: twoOptions },
				],
			},
			4,
		);
		expect(list.map((item) => item.id)).toEqual(["q1", "q2"]);
		expect(list[0]?.header).toBe("This header");
		expect(list[0]?.header.length).toBeLessThanOrEqual(12);
		expect(list[1]?.header).toBe("Q2");
	});

	test("dedupes by normalized question and caps to maxQuestions", () => {
		const list = normalizeClarifications(
			{
				questions: [
					{ question: "Which  DB should we use?", options: twoOptions },
					{ question: "which db should we use", options: twoOptions },
					{ question: "Second?", options: twoOptions },
					{ question: "Third?", options: twoOptions },
				],
			},
			2,
		);
		expect(list.map((item) => item.question)).toEqual(["Which DB should we use?", "Second?"]);
	});

	test("default falls back to the first option when it names no option; blocking is coerced", () => {
		const list = normalizeClarifications(
			{
				questions: [
					{ question: "A?", options: twoOptions, default: "MySQL", blocking: "yes" },
					{ question: "B?", options: twoOptions, default: "sqlite", blocking: true },
				],
			},
			4,
		);
		expect(list[0]?.default).toBe("Postgres");
		expect(list[0]?.blocking).toBe(false);
		expect(list[1]?.default).toBe("SQLite");
		expect(list[1]?.blocking).toBe(true);
	});

	test("accepts string options, dedupes labels, and keeps at most four", () => {
		const list = normalizeClarifications(
			{ questions: [{ question: "A?", options: ["x", "x", "y", "z", "w", "v"] }] },
			4,
		);
		expect(list[0]?.options.map((option) => option.label)).toEqual(["x", "y", "z", "w"]);
	});

	test("returns [] for garbage", () => {
		expect(normalizeClarifications(null, 4)).toEqual([]);
		expect(normalizeClarifications("nope", 4)).toEqual([]);
		expect(normalizeClarifications({ questions: "nope" }, 4)).toEqual([]);
	});
});

describe("runClarify", () => {
	test("parses fenced JSON from the completer and passes spec, answered, and max to the model", async () => {
		const calls: { system: string; user: string }[] = [];
		const list = await runClarify({
			uplift,
			answered: [
				{ id: "q9", question: "Old one?", header: "Old", why: "", options: twoOptions, blocking: false, answer: "SQLite" },
			],
			graph: {
				goal: "g",
				nodes: [{ id: "n1", title: "Understand", kind: "understand", question: "?", dependsOn: [], conclusion: "use ui" }],
			},
			maxQuestions: 3,
			complete: async (system, user) => {
				calls.push({ system, user });
				return `Here you go:\n\`\`\`json\n${JSON.stringify({
					questions: [{ question: "Which db?", header: "Database", why: "schema", options: twoOptions, default: "SQLite", blocking: true }],
				})}\n\`\`\``;
			},
		});
		expect(list).toHaveLength(1);
		expect(list[0]).toMatchObject({ id: "q1", header: "Database", default: "SQLite", blocking: true });
		expect(calls[0]?.system).toBe(clarifySystemPrompt(3));
		expect(calls[0]?.system).toContain("At most 3 questions");
		expect(calls[0]?.user).toContain("<spec>");
		expect(calls[0]?.user).toContain("<BUILD_PROMPT>");
		expect(calls[0]?.user).toContain("[n1] Understand\nuse ui");
		expect(calls[0]?.user).toContain("Old one? → SQLite");
		expect(calls[0]?.user).toContain("<max_questions>3</max_questions>");
	});

	test("returns [] on garbage output or a thrown error and reports the failure via onProgress", async () => {
		const progress: string[] = [];
		expect(await runClarify({ uplift, complete: async () => "not json at all", onProgress: (m) => progress.push(m) })).toEqual([]);
		expect(progress[0]).toBe("Clarifications…");
		expect(progress.some((m) => m.startsWith("clarify failed: "))).toBe(true);
		expect(
			await runClarify({
				uplift,
				complete: async () => {
					throw new Error("boom");
				},
				onProgress: (m) => progress.push(m),
			}),
		).toEqual([]);
		expect(progress.at(-1)).toBe("clarify failed: boom");
	});

	test("reports the question count via onProgress on success", async () => {
		const progress: string[] = [];
		const list = await runClarify({
			uplift,
			complete: async () =>
				JSON.stringify({
					questions: [
						{ question: "Which database?", header: "DB", options: twoOptions },
						{ question: "Which auth?", header: "Auth", options: twoOptions },
					],
				}),
			onProgress: (m) => progress.push(m),
		});
		expect(list).toHaveLength(2);
		expect(progress.at(-1)).toBe("Clarifications → 2");
	});

	test("rethrows AbortError", async () => {
		const abort = new Error("aborted");
		abort.name = "AbortError";
		await expect(
			runClarify({
				uplift,
				complete: async () => {
					throw abort;
				},
			}),
		).rejects.toBe(abort);
	});
});
