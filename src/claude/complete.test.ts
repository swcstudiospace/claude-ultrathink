import { describe, expect, test } from "bun:test";
import { buildClaudeArgs, CHILD_ENV, isChildInvocation, parseClaudeJson } from "./complete.ts";

describe("buildClaudeArgs", () => {
	test("disables tools and settings, asks for json, passes system prompt", () => {
		const args = buildClaudeArgs("SYS");
		expect(args).toEqual([
			"-p",
			"--tools",
			"",
			"--setting-sources",
			"",
			"--no-session-persistence",
			"--strict-mcp-config",
			"--exclude-dynamic-system-prompt-sections",
			"--output-format",
			"json",
			"--system-prompt",
			"SYS",
		]);
	});

	test("adds model and custom setting sources when given", () => {
		const args = buildClaudeArgs("SYS", { model: " sonnet ", settingSources: "user" });
		expect(args).toContain("--model");
		expect(args[args.indexOf("--model") + 1]).toBe("sonnet");
		expect(args[args.indexOf("--setting-sources") + 1]).toBe("user");
	});
});

describe("parseClaudeJson", () => {
	test("returns result text", () => {
		expect(parseClaudeJson('{"type":"result","is_error":false,"result":"<X/>"}')).toBe("<X/>");
	});

	test("throws on is_error with the result message", () => {
		expect(() => parseClaudeJson('{"is_error":true,"result":"Not logged in"}')).toThrow("Not logged in");
	});

	test("throws on empty or non-json output", () => {
		expect(() => parseClaudeJson("")).toThrow();
		expect(() => parseClaudeJson("nope")).toThrow();
	});

	test("tolerates log lines before the JSON object", () => {
		expect(parseClaudeJson('warn: something\n{"result":"ok","is_error":false}')).toBe("ok");
	});
});

describe("isChildInvocation", () => {
	test("true only when the marker is 1", () => {
		expect(isChildInvocation({ [CHILD_ENV]: "1" })).toBe(true);
		expect(isChildInvocation({ [CHILD_ENV]: "0" })).toBe(false);
		expect(isChildInvocation({})).toBe(false);
	});
});
