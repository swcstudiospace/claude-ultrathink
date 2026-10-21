import { describe, expect, test } from "bun:test";
import { estimateTokens, formatTokens } from "./estimate.ts";

describe("estimateTokens", () => {
	test("empty is 0", () => {
		expect(estimateTokens("")).toBe(0);
	});

	test("ceil chars/4", () => {
		expect(estimateTokens("a")).toBe(1);
		expect(estimateTokens("abcd")).toBe(1);
		expect(estimateTokens("abcde")).toBe(2);
	});
});

describe("formatTokens", () => {
	test("999, 1.2k, 1.2M and never negative", () => {
		expect(formatTokens(999)).toBe("999");
		expect(formatTokens(1200)).toBe("1.2k");
		expect(formatTokens(1_200_000)).toBe("1.2M");
		expect(formatTokens(-40)).toBe("0");
		expect(formatTokens(Number.NaN)).toBe("0");
	});
});
