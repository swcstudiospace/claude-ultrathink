// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import {
	buildBlockingState,
	buildKnowledgeState,
	buildPlanState,
	buildShipState,
	extractAcceptanceCriteria,
	extractDigestDocument,
	formatDefaultOption,
	LOCKFILE_PATTERNS,
	lastAssistantTurn,
	QUESTION_KEYS,
	QUESTIONS,
	buildSkillworthyState,
	buildTeachableState,
} from "./questions.ts";

describe("QUESTIONS (brief §2, verbatim)", () => {
	test("each point asks one noul question under its pinned key", () => {
		expect(QUESTION_KEYS).toEqual({
			plan: "plan_worthy",
			ship: "complete",
			knowledge: "supported",
			blocking: "risky",
			teachable: "teachable",
			skillworthy: "skillworthy",
		});
		for (const question of Object.values(QUESTIONS)) expect(question.type).toBe("noul");
	});

	test("Q-PLAN plan_worthy", () => {
		expect(QUESTIONS.plan).toEqual({
			type: "noul",
			instructions:
				"Does `message`, read together with `recent_conversation`, ask the coding agent to start new engineering work that takes several steps, files or decisions, so that writing a plan first would help?",
			criteria: {
				true: "The message asks for new work such as building a feature, fixing or investigating a bug, refactoring, migrating, or researching and writing up a design, or it approves a new multi-step proposal that the agent made in `recent_conversation`.",
				false: "The message acknowledges, thanks or greets; tells the agent to keep going with work already under way; asks a question that needs only an answer or an explanation; asks to show, run or repeat something; or asks for one small edit such as fixing a typo.",
			},
		});
	});

	test("Q-SHIP complete", () => {
		expect(QUESTIONS.ship).toEqual({
			type: "noul",
			instructions:
				"Does the change in `patch` fully deliver the work that `request` asks for, meeting every item in `acceptance_criteria`, with no part left missing, stubbed or marked TODO?",
			criteria: {
				true: "Every requirement in `request` and every item in `acceptance_criteria` is implemented by real code in `patch`.",
				false: "At least one requirement is missing, only partly done, stubbed, left as a TODO or placeholder, or `patch` changes something unrelated to `request`.",
			},
		});
	});

	test("Q-KNOWLEDGE supported", () => {
		expect(QUESTIONS.knowledge).toEqual({
			type: "noul",
			instructions: "Is `answer` a correct answer to `question` according to `document`?",
			criteria: {
				true: "`document` contains information that directly supports `answer` as the answer to `question`.",
				false: "`document` does not cover `question`, contradicts `answer`, supports a different answer, or supports only part of `answer`.",
			},
		});
	});

	test("Q-BLOCKING risky", () => {
		expect(QUESTIONS.blocking).toEqual({
			type: "noul",
			instructions:
				"If `default` turns out to be the wrong answer to `question`, would going ahead with it while doing `task` cause damage that is hard to undo?",
			criteria: {
				true: "Acting on a wrong `default` would lose or corrupt data, break callers of a public API, run a migration that cannot be reversed, or change the wrong system.",
				false: "Acting on a wrong `default` only produces code or settings that are easy to change in a later edit.",
			},
		});
	});

	test("the lesson questions ask the specified instructions about the candidate", () => {
		expect(QUESTIONS.teachable.instructions).toBe(
			"Is this candidate a reusable lesson that a future agent on this repository would otherwise have to rediscover?",
		);
		expect(QUESTIONS.skillworthy.instructions).toBe("Does this lesson describe a repeatable procedure or rule worth a standing skill?");
		expect(QUESTIONS.teachable.criteria?.true).toBeTruthy();
		expect(QUESTIONS.skillworthy.criteria?.false).toBeTruthy();
	});
});

describe("plan state", () => {
	test("keeps the message head (4000) and the conversation tail (2000)", () => {
		const message = `${"m".repeat(3999)}HEAD-END${"z".repeat(6000)}`;
		const conversation = `${"c".repeat(3000)}TAIL${"t".repeat(1996)}`;
		const state = buildPlanState({ message, recentConversation: conversation });
		expect(Object.keys(state).sort()).toEqual(["message", "recent_conversation"]);
		expect(state.message).toBe(message.slice(0, 4000));
		expect(state.recent_conversation).toBe(`TAIL${"t".repeat(1996)}`);
		expect(buildPlanState({ message: "hi", recentConversation: "" })).toEqual({ message: "hi", recent_conversation: "" });
	});

	test("lastAssistantTurn returns the last assistant chunk up to the next user chunk", () => {
		const history = "User: plan it\n\nAssistant: first idea\n\nUser: better?\n\nAssistant: Proposal: split into 3 services.\nStep 1.\n\nUser: yes please";
		expect(lastAssistantTurn(history)).toBe("Assistant: Proposal: split into 3 services.\nStep 1.");
		expect(lastAssistantTurn("Assistant: only turn  ")).toBe("Assistant: only turn");
		expect(lastAssistantTurn("User: hello")).toBe("");
		expect(lastAssistantTurn("User: I said Assistant: not a turn")).toBe("");
		expect(lastAssistantTurn("")).toBe("");
	});
});

describe("ship state", () => {
	test("extractAcceptanceCriteria reads one item per child element, unescaping entities and dropping tags", () => {
		const spec = `<SPEC><ACCEPTANCE_CRITERIA kind="list">
			<CRITERION>Flag <code>--verbose</code> prints   &lt;debug&gt; lines</CRITERION>
			<CRITERION>Quotes &quot;ok&quot; &amp; &apos;fine&apos; &#39;too&#39;</CRITERION>
			<CRITERION>   </CRITERION>
		</ACCEPTANCE_CRITERIA></SPEC>`;
		expect(extractAcceptanceCriteria(spec)).toEqual(["Flag --verbose prints <debug> lines", `Quotes "ok" & 'fine' 'too'`]);
	});

	test("extractAcceptanceCriteria reads one item per non-empty line without its bullet", () => {
		const spec = "<acceptance_criteria>\n- first\n* second\n\n1. third\n2) fourth\n• fifth\nplain sixth\n</acceptance_criteria>";
		expect(extractAcceptanceCriteria(spec)).toEqual(["first", "second", "third", "fourth", "fifth", "plain sixth"]);
	});

	test("extractAcceptanceCriteria returns [] without the element", () => {
		expect(extractAcceptanceCriteria("<SPEC><GOAL>x</GOAL></SPEC>")).toEqual([]);
	});

	test("buildShipState caps criteria at 20 items of 500 chars and keeps the request", () => {
		const criteria = Array.from({ length: 25 }, (_, i) => `${i}`.padEnd(800, "a"));
		const request = "r".repeat(9000);
		const { state, truncated } = buildShipState({ request, acceptanceCriteria: criteria, patch: "" });
		expect(Object.keys(state).sort()).toEqual(["acceptance_criteria", "patch", "request"]);
		expect(state.request).toBe(request);
		expect(state.acceptance_criteria).toHaveLength(20);
		for (const item of state.acceptance_criteria) expect(item.length).toBeLessThanOrEqual(500);
		expect(state.acceptance_criteria[19]).toBe("19".padEnd(500, "a"));
		expect(truncated).toBe(false);
	});

	test("buildShipState removes lockfile sections like the judge's git diff", () => {
		const section = (path: string, body: string) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n+${body}\n`;
		const patch = [
			section("src/app.ts", "APP"),
			section("bun.lock", "LOCK1"),
			section("web/package-lock.json", "LOCK2"),
			section("pnpm-lock.yaml", "LOCK3"),
			section("bun.lockb", "LOCK4"),
			section("src/lock.ts", "NOT-A-LOCKFILE"),
		].join("");
		const { state, truncated } = buildShipState({ request: "r", acceptanceCriteria: [], patch });
		expect(state.patch).toBe(section("src/app.ts", "APP") + section("src/lock.ts", "NOT-A-LOCKFILE"));
		expect(truncated).toBe(false);
	});

	test("buildShipState cuts the patch at 24,000 chars and reports truncation", () => {
		const patch = `diff --git a/bun.lock b/bun.lock\n+${"l".repeat(5000)}\ndiff --git a/src/a.ts b/src/a.ts\n+${"s".repeat(30_000)}\n`;
		const { state, truncated } = buildShipState({ request: "r", acceptanceCriteria: [], patch });
		expect(state.patch).toHaveLength(24_000);
		expect(state.patch.startsWith("diff --git a/src/a.ts")).toBe(true);
		expect(state.patch).not.toContain("bun.lock");
		expect(truncated).toBe(true);
	});

	test("buildShipState keeps an upstream truncation flag", () => {
		expect(buildShipState({ request: "r", acceptanceCriteria: [], patch: "small", patchTruncated: true }).truncated).toBe(true);
		expect(buildShipState({ request: "r", acceptanceCriteria: [], patch: "small", patchTruncated: false }).truncated).toBe(false);
	});

	test("LOCKFILE_PATTERNS match the judge's excluded lockfiles only", () => {
		const matches = (path: string) => LOCKFILE_PATTERNS.some((pattern) => pattern.test(path));
		for (const path of ["bun.lock", "a/yarn.lock", "bun.lockb", "package-lock.json", "web/pnpm-lock.yaml"]) expect(matches(path)).toBe(true);
		for (const path of ["src/lock.ts", "package.json", "my-package-lock.json"]) expect(matches(path)).toBe(false);
	});
});

describe("knowledge state", () => {
	const docs = ["docs/auth.md", "docs/db.md"];
	const digest = "Untrusted evidence.\n\n### docs/auth.md\n\nTokens last 1 hour.\n\n### Not a doc heading\n\nstill auth\n\n### docs/db.md\n\nPostgres 16.";

	test("extractDigestDocument returns the cited section up to the next listed document", () => {
		expect(extractDigestDocument(digest, "docs/auth.md", docs)).toBe("Tokens last 1 hour.\n\n### Not a doc heading\n\nstill auth");
		expect(extractDigestDocument(digest, "docs/db.md", docs)).toBe("Postgres 16.");
		expect(extractDigestDocument(digest, "docs/missing.md", docs)).toBe("");
	});

	test("buildKnowledgeState caps the document at 12,000 chars", () => {
		const state = buildKnowledgeState({ question: "q", answer: "a", document: "d".repeat(20_000) });
		expect(Object.keys(state).sort()).toEqual(["answer", "document", "question"]);
		expect(state.document).toHaveLength(12_000);
		expect(state.question).toBe("q");
		expect(state.answer).toBe("a");
	});
});

describe("blocking state", () => {
	const options = [
		{ label: "Keep the column", description: "no schema change" },
		{ label: "Drop the column", description: "removes legacy_email" },
		{ label: "Ask later" },
	];

	test("formatDefaultOption names the default option's label and description", () => {
		expect(formatDefaultOption("Drop the column", options)).toBe("Drop the column: removes legacy_email");
		expect(formatDefaultOption("Ask later", options)).toBe("Ask later");
		expect(formatDefaultOption("Unknown", options)).toBe("Keep the column: no schema change");
		expect(formatDefaultOption(undefined, options)).toBe("Keep the column: no schema change");
		expect(formatDefaultOption("Bare", [])).toBe("Bare");
		expect(formatDefaultOption(undefined, [])).toBe("");
	});

	test("buildBlockingState caps the task at 4000 chars", () => {
		const state = buildBlockingState({ task: "t".repeat(10_000), question: "Drop it?", defaultText: "Drop the column: removes legacy_email" });
		expect(state).toEqual({ task: "t".repeat(4000), question: "Drop it?", default: "Drop the column: removes legacy_email" });
	});
});

describe("lesson states", () => {
	const lesson = { name: "Use import type", description: "tsc rejects value imports of types", body: "b".repeat(2000), kind: "pitfall" };

	test("buildTeachableState sends name, description, kind and the body cut to 800 chars, nothing else", () => {
		expect(buildTeachableState({ ...lesson, extra: "x" } as typeof lesson)).toEqual({
			name: lesson.name,
			description: lesson.description,
			body: "b".repeat(800),
			kind: "pitfall",
		});
		expect(buildTeachableState({ ...lesson, body: "short" }).body).toBe("short");
	});

	test("buildSkillworthyState adds the occurrence count", () => {
		expect(buildSkillworthyState({ ...lesson, occurrences: 4 })).toEqual({
			name: lesson.name,
			description: lesson.description,
			body: "b".repeat(800),
			kind: "pitfall",
			occurrences: 4,
		});
	});
});
