import { describe, expect, test } from "bun:test";
import { clarificationsToXml, formatHitlAddendum, formatHitlEcho, injectClarificationsXml } from "./format.ts";
import type { Clarification } from "./types.ts";

const open: Clarification = {
	id: "q1",
	question: "Use <Postgres> or \"SQLite\"?",
	header: "Database",
	why: "changes the schema & migrations",
	options: [{ label: "Postgres", description: "durable" }, { label: "SQLite" }],
	default: "Postgres",
	blocking: true,
};

const soft: Clarification = {
	id: "q2",
	question: "Add tests?",
	header: "Tests",
	why: "scope",
	options: [{ label: "Yes" }, { label: "No" }],
	default: "Yes",
	blocking: false,
};

const answered: Clarification = { ...soft, id: "q3", question: "Which color?", answer: "blue", source: "user", answeredAt: 1 };

describe("clarificationsToXml", () => {
	test("escapes text, marks only the default as recommended, and emits ANSWER only when answered", () => {
		const xml = clarificationsToXml([open, answered]);
		expect(xml.startsWith("<CLARIFICATIONS>")).toBe(true);
		expect(xml).toContain('<CLARIFICATION id="q1" header="Database" blocking="true">');
		expect(xml).toContain("<QUESTION>Use &lt;Postgres&gt; or &quot;SQLite&quot;?</QUESTION>");
		expect(xml).toContain("<WHY>changes the schema &amp; migrations</WHY>");
		expect(xml).toContain('<OPTION recommended="true">Postgres — durable</OPTION>');
		expect(xml).toContain("<OPTION>SQLite</OPTION>");
		expect(xml.match(/recommended="true"/g)).toHaveLength(2);
		expect(xml).toContain('<ANSWER source="user">blue</ANSWER>');
		expect(xml.match(/<ANSWER/g)).toHaveLength(1);
		expect(clarificationsToXml([])).toBe("");
	});
});

describe("injectClarificationsXml", () => {
	test("inserts before the root close and replaces an existing block", () => {
		const base = "<BUILD_PROMPT>\n<ORIGINAL>x</ORIGINAL>\n</BUILD_PROMPT>";
		const once = injectClarificationsXml(base, [open]);
		expect(once.endsWith("</CLARIFICATIONS>\n</BUILD_PROMPT>")).toBe(true);
		expect(once).toContain("<ORIGINAL>x</ORIGINAL>");

		const twice = injectClarificationsXml(once, [answered]);
		expect(twice.match(/<CLARIFICATIONS>/g)).toHaveLength(1);
		expect(twice).not.toContain('id="q1"');
		expect(twice).toContain('<ANSWER source="user">blue</ANSWER>');
	});

	test("empty list removes an existing block and leaves input without one unchanged", () => {
		const base = "<BUILD_PROMPT>\n<ORIGINAL>x</ORIGINAL>\n</BUILD_PROMPT>";
		expect(injectClarificationsXml(base, [])).toBe(base);
		const removed = injectClarificationsXml(injectClarificationsXml(base, [open]), []);
		expect(removed).not.toContain("<CLARIFICATIONS");
		expect(removed).toContain("<ORIGINAL>x</ORIGINAL>");
		expect(removed).toContain("</BUILD_PROMPT>");
	});

	test("appends when there is no root close", () => {
		expect(injectClarificationsXml("plain text", [soft])).toBe(`plain text\n${clarificationsToXml([soft])}`);
	});
});

describe("formatHitlAddendum", () => {
	test("is empty for [] and lists blocking, non-blocking and answered sections", () => {
		expect(formatHitlAddendum([])).toBe("");
		const out = formatHitlAddendum([open, soft, answered]);
		expect(out.startsWith("## Clarifications (HITL)")).toBe(true);
		expect(out).toContain("`AskUserQuestion` tool ONCE");
		expect(out).toContain("### Open (blocking)");
		expect(out).toContain('- [q1] Use <Postgres> or "SQLite"? — options: Postgres | SQLite (recommended: Postgres)');
		expect(out).toContain("### Open (non-blocking)");
		expect(out).toContain("- [q2] Add tests? — options: Yes | No (recommended: Yes)");
		expect(out).toContain("### Answered");
		expect(out).toContain("- [q3] Which color? → blue");
		expect(out.indexOf("### Open (blocking)")).toBeLessThan(out.indexOf("### Open (non-blocking)"));
		expect(out.indexOf("### Open (non-blocking)")).toBeLessThan(out.indexOf("### Answered"));
	});

	test("omits sections that have no items", () => {
		const out = formatHitlAddendum([soft]);
		expect(out).not.toContain("### Open (blocking)");
		expect(out).not.toContain("### Answered");
		expect(out).toContain("### Open (non-blocking)");
	});
});

describe("formatHitlEcho", () => {
	test("renders one entry per clarification with answer lines only when answered", () => {
		expect(formatHitlEcho([])).toBe("No clarifications recorded");
		const out = formatHitlEcho([open, answered]);
		expect(out).toContain('q1 [blocking] Database: Use <Postgres> or "SQLite"?\n   options: Postgres | SQLite (default: Postgres)');
		expect(out).toContain("q3 Tests: Which color?\n   options: Yes | No (default: Yes)\n   answer: blue");
		expect(out.match(/answer:/g)).toHaveLength(1);
	});
});
