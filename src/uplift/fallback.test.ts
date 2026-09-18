import { describe, expect, test } from "bun:test";
import { fallbackUplift } from "./fallback.ts";
import { escapeXml } from "./xml.ts";

const REQUIRED_TAGS = [
	"ORIGINAL",
	"SYSTEM_ROLE",
	"CONTEXT",
	"SCOPE",
	"CONSTRAINTS",
	"ACCEPTANCE_CRITERIA",
	"OUT_OF_SCOPE",
	"ASSUMPTIONS",
] as const;

describe("fallbackUplift", () => {
	test("wraps escaped original under UPLIFTED_PROMPT with required tags", () => {
		const original = `Say "hi" & <go>`;
		const xml = fallbackUplift(original);
		expect(xml.startsWith("<UPLIFTED_PROMPT>")).toBe(true);
		expect(xml.endsWith("</UPLIFTED_PROMPT>")).toBe(true);
		expect(xml).toContain(`<ORIGINAL>${escapeXml(original)}</ORIGINAL>`);
		expect(xml.includes("<go>")).toBe(false);
		expect(xml.includes("& <")).toBe(false);
		for (const tag of REQUIRED_TAGS) {
			expect(xml).toContain(`<${tag}>`);
			expect(xml).toContain(`</${tag}>`);
		}
	});

	test("keeps a plain original verbatim inside ORIGINAL", () => {
		const original = "add a clients list page";
		expect(fallbackUplift(original)).toContain(`<ORIGINAL>${original}</ORIGINAL>`);
	});
});
