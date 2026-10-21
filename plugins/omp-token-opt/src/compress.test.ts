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

	describe("cap parameter", () => {
		const varied = (lines: number): string =>
			Array.from({ length: lines }, (_, i) => `row ${i} value ${(i * 7919) % 10007}`).join("\n");

		test("custom cap keeps exactly cap chars split 60/40 around the marker", () => {
			const text = varied(300);
			expect(text.length).toBeGreaterThan(4000);
			const out = shrinkToolText(text, 500);
			const omitted = text.length - 500;
			expect(out.text).toBe(`${text.slice(0, 300)}\n… omitted ${omitted} chars …\n${text.slice(-200)}`);
			expect(out.saved).toBe(out.baseline - out.current);
			expect(out.saved).toBeGreaterThan(0);
		});

		test("custom cap changes the truncation relative to the default", () => {
			const text = varied(300);
			expect(shrinkToolText(text, 500).text).not.toBe(shrinkToolText(text).text);
		});

		test("cap larger than the text leaves it unchanged", () => {
			const text = varied(300);
			const out = shrinkToolText(text, 100_000);
			expect(out.text).toBe(text);
			expect(out.saved).toBe(0);
		});

		test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53])(
			"invalid cap %p falls back to the default",
			(cap) => {
				const text = varied(300);
				expect(shrinkToolText(text, cap)).toEqual(shrinkToolText(text));
			},
		);
	});

	test("a cap below 4000 applies to results shorter than 4000 chars", () => {
		const text = Array.from({ length: 150 }, (_, i) => `row ${i} value ${(i * 7919) % 10007}`).join("\n");
		expect(text.length).toBeGreaterThan(1200);
		expect(text.length).toBeLessThan(4000);
		expect(shrinkToolText(text).saved).toBe(0);
		const out = shrinkToolText(text, 1200);
		expect(out.text).toContain("… omitted");
		expect(out.saved).toBeGreaterThan(0);
	});
});
