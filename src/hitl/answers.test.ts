import { describe, expect, test } from "bun:test";
import { applyAnswers } from "./answers.ts";
import type { Clarification } from "./types.ts";

function item(id: string, question: string, extra: Partial<Clarification> = {}): Clarification {
	return {
		id,
		question,
		header: "H",
		why: "w",
		options: [{ label: "A" }, { label: "B" }],
		default: "A",
		blocking: false,
		...extra,
	};
}

const base: Clarification[] = [item("q1", "Which database should we use?"), item("q2", "Add tests?")];

describe("applyAnswers", () => {
	test("matches exact and fuzzy question keys, returns matched, and does not mutate the input", () => {
		const snapshot = JSON.stringify(base);
		const { list, matched } = applyAnswers(
			base,
			{ questions: [{ question: "Which database should we use?", header: "DB", options: [] }] },
			{ answers: { "which database should we use": "Postgres", "add tests": "Yes" } },
			123,
		);
		expect(JSON.stringify(base)).toBe(snapshot);
		expect(list).toHaveLength(2);
		expect(list[0]).toMatchObject({ id: "q1", answer: "Postgres", answeredAt: 123, source: "user" });
		expect(list[1]).toMatchObject({ id: "q2", answer: "Yes", answeredAt: 123, source: "user" });
		expect(matched.map((entry) => entry.id)).toEqual(["q1", "q2"]);
	});

	test("matches by containment when the agent rephrased the question", () => {
		const { list, matched } = applyAnswers(base, undefined, { answers: { "Database should we use": "SQLite" } }, 1);
		expect(matched).toHaveLength(1);
		expect(list[0]?.answer).toBe("SQLite");
		expect(list[1]?.answer).toBeUndefined();
	});

	test("appends unknown asked questions with input header and options", () => {
		const { list, matched } = applyAnswers(
			base,
			{
				questions: [
					{ question: "Which color scheme?", header: "Theme", options: [{ label: "Dark", description: "default" }, { label: "Light" }] },
				],
			},
			{ answers: { "Which color scheme?": "Dark" } },
			5,
		);
		expect(list).toHaveLength(3);
		expect(list[2]).toEqual({
			id: "q3",
			question: "Which color scheme?",
			header: "Theme",
			why: "Asked by the agent during execution",
			options: [{ label: "Dark", description: "default" }, { label: "Light" }],
			blocking: false,
			answer: "Dark",
			answeredAt: 5,
			source: "user",
		});
		expect(matched).toEqual([list[2]!]);
	});

	test("appends answer keys that were not in the input either, with the Asked header", () => {
		const { list } = applyAnswers([], undefined, { answers: { "Deploy where?": "Vercel" } }, 1);
		expect(list).toHaveLength(1);
		expect(list[0]).toMatchObject({ id: "q1", question: "Deploy where?", header: "Asked", options: [], answer: "Vercel" });
	});

	test("attaches freeform response to the first matched item lacking an answer, else appends", () => {
		const asked = { questions: [{ question: "Which database should we use?" }, { question: "Add tests?" }] };
		const first = applyAnswers(base, asked, { answers: { "Add tests?": "No" }, response: "use whatever is cheapest" }, 9);
		expect(first.list[0]?.answer).toBe("use whatever is cheapest");
		expect(first.list[1]?.answer).toBe("No");
		expect(first.matched.map((entry) => entry.id).sort()).toEqual(["q1", "q2"]);

		const second = applyAnswers(base, undefined, { response: "just a note" }, 9);
		expect(second.list).toHaveLength(3);
		expect(second.list[2]).toMatchObject({ question: "Free-form response", answer: "just a note", header: "Asked" });
		expect(second.matched).toHaveLength(1);
	});

	test("string response attaches to the single unanswered asked question, else appends a free-form item", () => {
		const one = applyAnswers(base, { questions: [{ question: "Add tests?" }] }, "yes please", 2);
		expect(one.list[1]?.answer).toBe("yes please");
		expect(one.matched.map((entry) => entry.id)).toEqual(["q2"]);

		const many = applyAnswers(base, { questions: [{ question: "Add tests?" }, { question: "Which database should we use?" }] }, "hmm", 2);
		expect(many.list).toHaveLength(3);
		expect(many.list[2]?.question).toBe("Free-form response");
	});

	test("ignores empty responses and blank answers", () => {
		expect(applyAnswers(base, undefined, undefined, 1).matched).toEqual([]);
		expect(applyAnswers(base, undefined, { answers: { "Add tests?": "   " } }, 1).matched).toEqual([]);
		expect(applyAnswers(base, undefined, "  ", 1).list).toHaveLength(2);
	});
});
