// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { describe, expect, test } from "bun:test";
import { parseRouteFlag, sanitizeInput, selectRoute } from "./input.ts";

describe("sanitizeInput", () => {
	test("strips C0, DEL and C1 control characters", () => {
		const raw = "a\u0000b\u0001c\u0008d\u000Be\u001Ff\u007Fg\u0080h\u009Fi";
		expect(sanitizeInput(raw, 100)).toEqual({ ok: true, text: "abcdefghi" });
	});

	test("keeps newline and tab", () => {
		const raw = "line one\n\tline two";
		expect(sanitizeInput(raw, 100)).toEqual({ ok: true, text: "line one\n\tline two" });
	});

	test("empty string gives empty", () => {
		expect(sanitizeInput("", 100)).toEqual({ ok: false, code: "empty" });
	});

	test("whitespace-only gives empty", () => {
		expect(sanitizeInput("  \n\t  ", 100)).toEqual({ ok: false, code: "empty" });
	});

	test("control-only input gives empty", () => {
		expect(sanitizeInput("\u0001\u0002\u007F", 100)).toEqual({ ok: false, code: "empty" });
	});

	test("non-string gives not_string", () => {
		expect(sanitizeInput(42, 100)).toEqual({ ok: false, code: "not_string" });
		expect(sanitizeInput(null, 100)).toEqual({ ok: false, code: "not_string" });
		expect(sanitizeInput(["x"], 100)).toEqual({ ok: false, code: "not_string" });
		expect(sanitizeInput(undefined, 100)).toEqual({ ok: false, code: "not_string" });
	});

	test("length is checked after stripping", () => {
		// Three characters before stripping, but only "a" remains.
		expect(sanitizeInput("a\u0001\u0002", 1)).toEqual({ ok: true, text: "a" });
	});

	test("length over maxChars gives too_long", () => {
		expect(sanitizeInput("abc", 2)).toEqual({ ok: false, code: "too_long" });
	});

	test("length equal to maxChars is accepted", () => {
		expect(sanitizeInput("abc", 3)).toEqual({ ok: true, text: "abc" });
	});

	test("surrounding whitespace is trimmed", () => {
		expect(sanitizeInput("  hello  ", 100)).toEqual({ ok: true, text: "hello" });
	});
});

describe("selectRoute", () => {
	test("planning keyword selects planning", () => {
		const result = selectRoute("make a roadmap for the launch");
		expect(result.route).toBe("planning");
		expect(result.reason).toBe("matched planning terms");
	});

	test("research keyword selects research", () => {
		const result = selectRoute("compare two vector databases");
		expect(result.route).toBe("research");
		expect(result.reason).toBe("matched research terms");
	});

	test("build-plan keyword selects build-plan", () => {
		const result = selectRoute("implement the login endpoint");
		expect(result.route).toBe("build-plan");
		expect(result.reason).toBe("matched build-plan terms");
	});

	test("planning is checked before build-plan", () => {
		expect(selectRoute("plan how to build the frontend").route).toBe("planning");
	});

	test("research is checked before build-plan", () => {
		expect(selectRoute("research how to build a parser").route).toBe("research");
	});

	test("no keywords defaults to planning", () => {
		expect(selectRoute("hello there").route).toBe("planning");
	});

	test("selection is deterministic", () => {
		const text = "investigate the cache layer";
		expect(selectRoute(text)).toEqual(selectRoute(text));
	});
});

describe("parseRouteFlag", () => {
	test("undefined and auto mean automatic selection", () => {
		expect(parseRouteFlag(undefined)).toEqual({ ok: true, route: undefined });
		expect(parseRouteFlag("auto")).toEqual({ ok: true, route: undefined });
	});

	test("each allowed route is accepted", () => {
		expect(parseRouteFlag("planning")).toEqual({ ok: true, route: "planning" });
		expect(parseRouteFlag("research")).toEqual({ ok: true, route: "research" });
		expect(parseRouteFlag("build-plan")).toEqual({ ok: true, route: "build-plan" });
	});

	test("unknown values are rejected as invalid_value", () => {
		expect(parseRouteFlag("admin")).toEqual({ ok: false, code: "invalid_value" });
		expect(parseRouteFlag("")).toEqual({ ok: false, code: "invalid_value" });
		expect(parseRouteFlag(7)).toEqual({ ok: false, code: "invalid_value" });
		expect(parseRouteFlag(null)).toEqual({ ok: false, code: "invalid_value" });
	});
});
