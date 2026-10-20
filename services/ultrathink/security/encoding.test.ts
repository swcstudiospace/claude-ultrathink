// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import {
	encodeHtml,
	encodeHtmlAttribute,
	encodeJavaScript,
	encodeJson,
	encodeUrl,
	encodeFormUrl,
	encodeCss,
	quoteSqlIdentifier,
	escapeShellArg,
	escapeLdapDn,
	escapeLdapFilter,
	escapeXPath,
	encodeCsvField,
	encodeCsvRow,
	sanitizeInput,
	stripHtmlTags,
	truncateString,
	safeForLogging,
	OutputContext,
	encodeForContext,
	encodeObjectForContext,
} from "./encoding.ts";

describe("Encoding", () => {
	describe("encodeHtml", () => {
		test("encodes & to &amp;", () => {
			expect(encodeHtml("a & b")).toBe("a &amp; b");
		});

		test("encodes < to &lt;", () => {
			expect(encodeHtml("<script>")).toBe("&lt;script&gt;");
		});

		test("encodes > to &gt;", () => {
			expect(encodeHtml("a > b")).toBe("a &gt; b");
		});

		test("encodes double quote", () => {
			expect(encodeHtml('"quoted"')).toBe("&quot;quoted&quot;");
		});

		test("encodes single quote", () => {
			expect(encodeHtml("'quoted'")).toBe("&apos;quoted&apos;");
		});

		test("encodes forward slash", () => {
			expect(encodeHtml("a/b")).toBe("a&#x2F;b");
		});

		test("handles multiple special chars", () => {
			expect(encodeHtml('<script>"test"</script>')).toBe(
				"&lt;script&gt;&quot;test&quot;&lt;&#x2F;script&gt;",
			);
		});
	});

	describe("encodeHtmlAttribute", () => {
		test("encodes backtick", () => {
			expect(encodeHtmlAttribute("`template`")).toBe("&#x60;template&#x60;");
		});

		test("uses html encoding as base", () => {
			expect(encodeHtmlAttribute("<script>")).toBe("&lt;script&gt;");
		});
	});

	describe("encodeJavaScript", () => {
		test("escapes backslash", () => {
			expect(encodeJavaScript("\\")).toBe("\\\\");
		});

		test("escapes single quote", () => {
			expect(encodeJavaScript("it's")).toBe("it\\'s");
		});

		test("escapes double quote", () => {
			expect(encodeJavaScript('"quote"')).toBe('\\"quote\\"');
		});

		test("escapes newlines", () => {
			expect(encodeJavaScript("line1\nline2")).toBe("line1\\nline2");
		});

		test("escapes tabs", () => {
			expect(encodeJavaScript("tab\there")).toBe("tab\\there");
		});

		test("escapes special chars", () => {
			expect(encodeJavaScript("<>&=")).toBe("\\u003C\\u003E\\u0026\\u003D");
		});
	});

	describe("encodeJson", () => {
		test("encodes object", () => {
			expect(encodeJson({ a: 1, b: "test" })).toBe('{"a":1,"b":"test"}');
		});

		test("encodes array", () => {
			expect(encodeJson([1, 2, 3])).toBe("[1,2,3]");
		});

		test("encodes string", () => {
			expect(encodeJson("test")).toBe('"test"');
		});

		test("encodes null", () => {
			expect(encodeJson(null)).toBe("null");
		});
	});

	describe("encodeUrl", () => {
		test("encodes spaces", () => {
			expect(encodeUrl("hello world")).toBe("hello%20world");
		});

		test("encodes special chars", () => {
			expect(encodeUrl("a&b=c")).toBe("a%26b%3Dc");
		});

		test("does not encode unreserved chars", () => {
			expect(encodeUrl("abc123-_.~")).toBe("abc123-_.~");
		});
	});

	describe("encodeFormUrl", () => {
		test("encodes space as +", () => {
			expect(encodeFormUrl("hello world")).toBe("hello+world");
		});

		test("encodes other special chars", () => {
			expect(encodeFormUrl("a&b")).toBe("a%26b");
		});
	});

	describe("encodeCss", () => {
		test("encodes special chars", () => {
			const result = encodeCss("<>");
			expect(result).toContain("\\003c ");
			expect(result).toContain("\\003e ");
		});
	});

	describe("quoteSqlIdentifier", () => {
		test("quotes valid identifier", () => {
			expect(quoteSqlIdentifier("users")).toBe('"users"');
		});

		test("quotes identifier with underscore", () => {
			expect(quoteSqlIdentifier("user_id")).toBe('"user_id"');
		});

		test("rejects invalid identifier", () => {
			expect(() => quoteSqlIdentifier("123invalid")).toThrow();
			expect(() => quoteSqlIdentifier("invalid-char")).toThrow();
		});
	});

	describe("escapeShellArg", () => {
		test("quotes and escapes", () => {
			expect(escapeShellArg("hello")).toBe("'hello'");
			expect(escapeShellArg("it's")).toBe("'it'\\''s'");
		});
	});

	describe("escapeLdapDn", () => {
		test("escapes special chars", () => {
			expect(escapeLdapDn("cn=test,dc=example,dc=com")).toBe("cn=test,dc=example,dc=com");
			expect(escapeLdapDn("cn=test*")).toBe("cn=test\\2a");
		});
	});

	describe("escapeLdapFilter", () => {
		test("escapes special chars", () => {
			expect(escapeLdapFilter("test*")).toBe("test\\2a");
		});
	});

	describe("escapeXPath", () => {
		test("handles only single quotes", () => {
			expect(escapeXPath("test")).toBe("'test'");
			expect(escapeXPath("it's")).toBe('"it\'s"');
		});

		test("handles both quotes", () => {
			expect(escapeXPath(`"test'`)).toBe('concat(\'"\', \'test\', "\'")');
		});
	});

	describe("encodeCsvField", () => {
		test("quotes when needed", () => {
			expect(encodeCsvField('hello "world"')).toBe('"hello ""world"""');
			expect(encodeCsvField("hello,world")).toBe('"hello,world"');
		});

		test("no quoting when not needed", () => {
			expect(encodeCsvField("hello")).toBe("hello");
		});
	});

	describe("encodeCsvRow", () => {
		test("joins fields", () => {
			expect(encodeCsvRow(["a", "b", "c"])).toBe("a,b,c");
		});

		test("quotes fields with commas", () => {
			expect(encodeCsvRow(["a", "b,c", "d"])).toBe('a,"b,c",d');
		});
	});

	describe("sanitizeInput", () => {
		test("removes null bytes", () => {
			expect(sanitizeInput("a\0b")).toBe("ab");
		});

		test("removes control chars", () => {
			expect(sanitizeInput("a\x01b")).toBe("ab");
			expect(sanitizeInput("a\tb")).toBe("a\tb");
			expect(sanitizeInput("a\nb")).toBe("a\nb");
			expect(sanitizeInput("a\rb")).toBe("a\rb");
		});
	});

	describe("stripHtmlTags", () => {
		test("removes tags", () => {
			expect(stripHtmlTags("<b>bold</b>")).toBe("bold");
			expect(stripHtmlTags("<script>alert(1)</script>")).toBe("alert(1)");
		});

		test("an unterminated tag opener swallows the rest of the input", () => {
			expect(stripHtmlTags("before<scriptafter")).toBe("before");
		});

		test("removes nested and partial markup until no angle brackets remain", () => {
			expect(stripHtmlTags("<<script>script>")).toBe("script");
			expect(stripHtmlTags("<<script>>alert(1)<</script>>")).toBe("alert(1)");
			expect(stripHtmlTags("<scr<b>ipt>alert(1)</scr<b>ipt>")).toBe("iptalert(1)ipt");
			expect(stripHtmlTags("a<b")).toBe("a");
			expect(stripHtmlTags("a>b")).toBe("ab");
			expect(stripHtmlTags("a<b>c</b>d")).toBe("acd");
		});

		test("output never contains angle brackets", () => {
			const inputs = ["<<<>>>", "<<", ">>", "<a<b>c", "<<script>script>", "x<y>z>w<", "<\u0000<b>>"];
			for (const input of inputs) {
				const output = stripHtmlTags(input);
				expect(output).not.toContain("<");
				expect(output).not.toContain(">");
			}
		});

		test("handles 100000 repeated nested openers without leaving angle brackets", () => {
			const output = stripHtmlTags("<a".repeat(100000) + ">");
			expect(output).not.toContain("<");
			expect(output).not.toContain(">");
		});
	});

	describe("truncateString", () => {
		test("truncates long string", () => {
			expect(truncateString("hello world", 8)).toBe("hello...");
		});

		test("returns original if short", () => {
			expect(truncateString("hi", 10)).toBe("hi");
		});

		test("handles custom ellipsis", () => {
			expect(truncateString("hello", 4, "..")).toBe("he..");
		});
	});

	describe("safeForLogging", () => {
		test("escapes newlines", () => {
			expect(safeForLogging("a\nb")).toBe("a\\nb");
		});

		test("escapes tabs", () => {
			expect(safeForLogging("a\tb")).toBe("a\\tb");
		});
	});

	describe("OutputContext enum", () => {
		test("has all contexts", () => {
			expect(OutputContext.HTML as string).toBe("html");
			expect(OutputContext.JAVASCRIPT as string).toBe("javascript");
			expect(OutputContext.JSON as string).toBe("json");
			expect(OutputContext.URL as string).toBe("url");
		});
	});

	describe("encodeForContext", () => {
		test("encodes for HTML", () => {
			expect(encodeForContext("<script>", OutputContext.HTML)).toBe("&lt;script&gt;");
		});

		test("encodes for JavaScript", () => {
			expect(encodeForContext("it's", OutputContext.JAVASCRIPT)).toBe("it\\'s");
		});

		test("encodes for JSON", () => {
			expect(encodeForContext("test", OutputContext.JSON)).toBe('"test"');
		});

		test("encodes for URL", () => {
			expect(encodeForContext("hello world", OutputContext.URL)).toBe("hello%20world");
		});

		test("defaults to HTML", () => {
			expect(encodeForContext("<script>", "unknown" as OutputContext)).toBe("&lt;script&gt;");
		});
	});

	describe("encodeObjectForContext", () => {
		test("encodes object strings", () => {
			const obj = { a: "<script>", b: "safe" };
			const result = encodeObjectForContext(obj, OutputContext.HTML);
			expect(result.a).toBe("&lt;script&gt;");
			expect(result.b).toBe("safe");
		});

		test("encodes nested objects", () => {
			const obj = { a: { b: "<script>" } };
			const result = encodeObjectForContext(obj, OutputContext.HTML);
			expect(result.a.b).toBe("&lt;script&gt;");
		});

		test("encodes arrays", () => {
			const obj = { items: ["<script>", "safe"] };
			const result = encodeObjectForContext(obj, OutputContext.HTML);
			expect(result.items[0]).toBe("&lt;script&gt;");
			expect(result.items[1]).toBe("safe");
		});

		test("preserves non-strings", () => {
			const obj = { a: 123, b: true, c: null };
			const result = encodeObjectForContext(obj, OutputContext.HTML);
			expect(result.a).toBe(123);
			expect(result.b).toBe(true);
			expect(result.c).toBe(null);
		});

		test("encodes strings inside arrays of objects", () => {
			const obj = { items: [{ name: "<b>", tags: ["<i>", "ok"] }, { name: "safe" }] };
			const result = encodeObjectForContext(obj, OutputContext.HTML);
			expect(result).toEqual({
				items: [{ name: "&lt;b&gt;", tags: ["&lt;i&gt;", "ok"] }, { name: "safe" }],
			});
		});

		test("encodes strings inside nested arrays", () => {
			const obj = { grid: [["<a>", ["<b>"]]] };
			const result = encodeObjectForContext(obj, OutputContext.HTML);
			expect(result).toEqual({ grid: [["&lt;a&gt;", ["&lt;b&gt;"]]] });
		});

		test("encodes strings at any depth through mixed arrays and objects", () => {
			const obj = { a: [{ b: [{ c: "<d>" }] }] };
			const result = encodeObjectForContext(obj, OutputContext.HTML);
			expect(result).toEqual({ a: [{ b: [{ c: "&lt;d&gt;" }] }] });
		});

		test("preserves non-strings inside arrays", () => {
			const obj = { items: [1, null, true, { n: 2 }, ["x", 3]] };
			const result = encodeObjectForContext(obj, OutputContext.HTML);
			expect(result).toEqual({ items: [1, null, true, { n: 2 }, ["x", 3]] });
		});
	});
});
