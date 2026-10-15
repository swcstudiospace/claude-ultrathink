import { describe, expect, test } from "bun:test";
import { shrinkToolText } from "./compress.ts";

describe("shrinkToolText", () => {
	test("no-op under 4000 chars", () => {
		const text = "same log line\n".repeat(100);
		expect(text.length).toBeLessThan(4000);
		const out = shrinkToolText(text);
		expect(out.text).toBe(text);
		expect(out.saved).toBe(0);
		expect(out.current).toBe(out.baseline);
	});

	test("reduces a 20k repeated-log blob", () => {
		const blob = "ERROR connection reset by peer\n".repeat(700);
		expect(blob.length).toBeGreaterThan(20_000);
		const out = shrinkToolText(blob);
		expect(out.text.length).toBeLessThan(blob.length);
		expect(out.saved).toBeGreaterThan(0);
		expect(out.saved).toBe(out.baseline - out.current);
		expect(out.text).toContain("×");
	});

	test("does not rewrite hashline source", () => {
		const body = "const value = 1;\n".repeat(2000);
		const text = `[src/index.ts#A1B2]\n${body}`;
		expect(text.length).toBeGreaterThan(6000);
		const out = shrinkToolText(text);
		expect(out.text).toBe(text);
		expect(out.saved).toBe(0);
	});
});
