import { describe, expect, test } from "bun:test";
import { extractPrFromOutput, isGhPrCreateCommand } from "./pr-detect.ts";

describe("isGhPrCreateCommand", () => {
	test("matches gh pr create in various forms", () => {
		expect(isGhPrCreateCommand("gh pr create --title x --body y")).toBe(true);
		expect(isGhPrCreateCommand("  gh   pr   create")).toBe(true);
		expect(isGhPrCreateCommand("cd repo && gh pr create --fill")).toBe(true);
	});

	test("does not match unrelated gh pr subcommands", () => {
		expect(isGhPrCreateCommand("gh pr list")).toBe(false);
		expect(isGhPrCreateCommand("gh pr view 5")).toBe(false);
		expect(isGhPrCreateCommand("gh issue create")).toBe(false);
		expect(isGhPrCreateCommand("")).toBe(false);
	});

	test("is a simple substring heuristic on the command text — a command that merely mentions the phrase elsewhere (e.g. inside a commit message) also matches; accepted false-positive, since it only costs an unnecessary nudge, never a missed one", () => {
		expect(isGhPrCreateCommand("git commit -m 'wip: will gh pr create later'")).toBe(true);
	});
});

describe("extractPrFromOutput", () => {
	test("extracts the PR URL and number from gh pr create's stdout", () => {
		const output = "Creating pull request for feat/widget into main in acme/widgets\n\nhttps://github.com/acme/widgets/pull/42\n";
		expect(extractPrFromOutput(output)).toEqual({ url: "https://github.com/acme/widgets/pull/42", number: 42 });
	});

	test("extracts from a JSON-stringified MCP tool response too", () => {
		const output = JSON.stringify({ number: 7, htmlUrl: "https://github.com/acme/widgets/pull/7" });
		expect(extractPrFromOutput(output)).toEqual({ url: "https://github.com/acme/widgets/pull/7", number: 7 });
	});

	test("undefined when no PR URL is present", () => {
		expect(extractPrFromOutput("no url here")).toBeUndefined();
		expect(extractPrFromOutput("")).toBeUndefined();
	});

	test("finds the first match when multiple URLs are present", () => {
		const output = "See https://github.com/acme/widgets/pull/1 (superseded by https://github.com/acme/widgets/pull/2)";
		expect(extractPrFromOutput(output)).toEqual({ url: "https://github.com/acme/widgets/pull/1", number: 1 });
	});
});
