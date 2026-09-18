import { describe, expect, test } from "bun:test";
import { escapeXml, ensureOriginal, looksLikeUpliftXml, sanitizeUpliftXml, stripFences } from "./xml.ts";

describe("escapeXml", () => {
	test("escapes amp lt gt quot in order", () => {
		expect(escapeXml(`&<>"`)).toBe("&amp;&lt;&gt;&quot;");
		expect(escapeXml("a&b")).toBe("a&amp;b");
	});
});

describe("stripFences", () => {
	test("removes xml fences", () => {
		expect(stripFences("```xml\n<FOO/>\n```")).toBe("<FOO/>");
		expect(stripFences("```XML\n<FOO/>\n```")).toBe("<FOO/>");
	});

	test("removes bare fences", () => {
		expect(stripFences("```\n<BAR>x</BAR>\n```")).toBe("<BAR>x</BAR>");
	});

	test("preserves a BUILD_PROMPT document that contains an inner fence", () => {
		const xml = "<BUILD_PROMPT><ORIGINAL>x</ORIGINAL>\n```ts\nconst n = 1;\n```\n</BUILD_PROMPT>";
		expect(stripFences(xml)).toBe(xml);
		const out = sanitizeUpliftXml(xml, "orig");
		expect(out).not.toBeNull();
		expect(out!).toContain("```ts");
		expect(out!).toContain("<BUILD_PROMPT>");
	});
});

describe("looksLikeUpliftXml", () => {
	test("true when a root element exists", () => {
		expect(looksLikeUpliftXml("```xml\n<BUILD_PROMPT>x</BUILD_PROMPT>\n```")).toBe(true);
	});

	test("false for plain text", () => {
		expect(looksLikeUpliftXml("just a request")).toBe(false);
	});
});

describe("ensureOriginal", () => {
	test("injects ORIGINAL as first child when missing", () => {
		const out = ensureOriginal("<BUILD_PROMPT><SCOPE>a</SCOPE></BUILD_PROMPT>", "hello");
		expect(out.startsWith("<BUILD_PROMPT>\n<ORIGINAL>hello</ORIGINAL>")).toBe(true);
		expect(out).toContain("<SCOPE>a</SCOPE>");
	});

	test("does not duplicate an existing ORIGINAL", () => {
		const xml = "<BUILD_PROMPT><ORIGINAL>keep</ORIGINAL><SCOPE>a</SCOPE></BUILD_PROMPT>";
		expect(ensureOriginal(xml, "other")).toBe(xml);
	});
});

describe("sanitizeUpliftXml", () => {
	test("strips fences then keeps a known root", () => {
		const out = sanitizeUpliftXml("```xml\n<BUILD_PROMPT><SCOPE>a</SCOPE></BUILD_PROMPT>\n```", "orig");
		expect(out).not.toBeNull();
		expect(out!.includes("```")).toBe(false);
		expect(out!).toContain("<BUILD_PROMPT>");
		expect(out!).toContain("<ORIGINAL>orig</ORIGINAL>");
	});

	test("injects missing ORIGINAL escaped as first child", () => {
		const out = sanitizeUpliftXml("<FIX_PROMPT><SCOPE>a</SCOPE></FIX_PROMPT>", "hello <x> & \"y\"");
		expect(out).toContain(`<ORIGINAL>hello &lt;x&gt; &amp; &quot;y&quot;</ORIGINAL>`);
		expect(out).toContain("<SCOPE>a</SCOPE>");
		expect(out!.includes("<x>")).toBe(false);
	});

	test("wraps unknown roots in UPLIFTED_PROMPT and ensures ORIGINAL", () => {
		const out = sanitizeUpliftXml("<WIDGET><A>1</A></WIDGET>", "orig");
		expect(out?.startsWith("<UPLIFTED_PROMPT>")).toBe(true);
		expect(out).toContain("<ORIGINAL>orig</ORIGINAL>");
		expect(out).toContain("<WIDGET><A>1</A></WIDGET>");
		expect(out?.endsWith("</UPLIFTED_PROMPT>")).toBe(true);
	});

	test("does not wrap known extra roots uplifted/ultrathink", () => {
		expect(sanitizeUpliftXml("<uplifted><X/></uplifted>", "o")).toContain("<uplifted>");
		expect(sanitizeUpliftXml("<uplifted><X/></uplifted>", "o")?.includes("UPLIFTED_PROMPT")).toBe(false);
		expect(sanitizeUpliftXml("<ultrathink><X/></ultrathink>", "o")).toContain("<ultrathink>");
	});

	test("returns null when unusable", () => {
		expect(sanitizeUpliftXml("just text", "o")).toBeNull();
		expect(sanitizeUpliftXml("   ", "o")).toBeNull();
		expect(sanitizeUpliftXml("```xml\nno root here\n```", "o")).toBeNull();
	});

	test("preserves nested tags and does not flatten", () => {
		const inner = "<CLIENTS_LIST_PAGE><TABLE><ROW>x</ROW></TABLE></CLIENTS_LIST_PAGE>";
		const out = sanitizeUpliftXml(`<BUILD_PROMPT>${inner}</BUILD_PROMPT>`, "orig");
		expect(out).toContain(inner);
	});
});
