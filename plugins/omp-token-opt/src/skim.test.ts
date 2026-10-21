import { describe, expect, test } from "bun:test";
import { clearSkimArchive, readSkimSpan, rememberSkim, skimArchiveSize, skimSource } from "./skim.ts";

describe("skimSource", () => {
	test("keeps an export line and drops a long body", () => {
		const body = `${"const hidden = 1;\n".repeat(400)}export function kept() {\n${"x".repeat(13_000)}\n}\n`;
		expect(body.length).toBeGreaterThan(12_000);
		const out = skimSource(body, "src/kept.ts");
		expect(out).toContain("export function kept() {");
		expect(out).not.toContain("const hidden");
		expect(out).not.toContain("x".repeat(100));
		expect(out).toMatch(/token-opt: skimmed \d+ chars$/);
		expect(out.length).toBeLessThan(body.length);
	});

	test("returns the original text when no signature lines exist", () => {
		const body = `${"const hidden = 1;\n".repeat(800)}`;
		expect(body.length).toBeGreaterThan(12_000);
		expect(skimSource(body, "src/only-const.ts")).toBe(body);
	});

	test("does not skim markdown, diffs, or hashline text", () => {
		const md = `# title\n${"y".repeat(13_000)}\n`;
		expect(skimSource(md, "README.md")).toBe(md);
		const diff = `diff --git a/src/a.ts b/src/a.ts\n${"z".repeat(13_000)}\n`;
		expect(skimSource(diff, "src/a.ts")).toBe(diff);
		const hashline = `[src/a.ts#AB12]\n${"q".repeat(13_000)}\n`;
		expect(skimSource(hashline, "src/a.ts")).toBe(hashline);
		const ranged = `export const a = 1;\n${"n".repeat(13_000)}\n`;
		expect(skimSource(ranged, "src/a.ts:1-40")).toBe(ranged);
	});

	test("keeps at most 8 original bodies and returns a bounded span", () => {
		clearSkimArchive();
		for (let i = 0; i < 9; i++) rememberSkim(`src/f${i}.ts`, `export const n${i} = 1;\n${"z".repeat(20)}\n`);
		expect(skimArchiveSize()).toBe(8);
		expect(readSkimSpan("src/f0.ts", 1, 1)).toBeNull();
		expect(readSkimSpan("src/f8.ts", 1, 1)).toBe("export const n8 = 1;");
		expect(readSkimSpan("src/f8.ts", 1, 400)?.split("\n").length).toBeLessThanOrEqual(200);
		clearSkimArchive();
	});
});
