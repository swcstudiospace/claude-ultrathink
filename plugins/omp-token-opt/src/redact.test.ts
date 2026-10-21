import { describe, expect, test } from "bun:test";
import { redactText, redactUrl } from "./redact.ts";

describe("redactUrl", () => {
	test("replaces the password with *** and keeps the rest of the URL", () => {
		const out = redactUrl("postgres://user:hunter2@db.example.com:5432/app");
		expect(out).toBe("postgres://user:***@db.example.com:5432/app");
		expect(out).not.toContain("hunter2");
	});

	test("hides a percent-encoded password", () => {
		const out = redactUrl("postgres://u:p%40ss@host/db");
		expect(out).toBe("postgres://u:***@host/db");
		expect(out).not.toContain("p%40ss");
	});

	test("leaves a URL without a password unchanged", () => {
		expect(redactUrl("https://example.com/a?b=1")).toBe("https://example.com/a?b=1");
	});

	test("returns invalid-url and never echoes unparseable input", () => {
		for (const input of ["not a url hunter2", "", "://hunter2@"]) {
			const out = redactUrl(input);
			expect(out).toBe("invalid-url");
			expect(out).not.toContain("hunter2");
		}
	});
});

describe("redactText", () => {
	test("replaces every occurrence of each secret", () => {
		expect(redactText("a hunter2 b hunter2 c", ["hunter2"])).toBe("a *** b *** c");
	});

	test("replaces longer secrets first so no partial leak remains", () => {
		expect(redactText("abcd", ["ab", "abcd"])).toBe("***");
	});

	test("ignores empty secrets and returns text unchanged when none match", () => {
		expect(redactText("plain text", ["", "absent"])).toBe("plain text");
	});
});
