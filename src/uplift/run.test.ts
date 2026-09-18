import { describe, expect, test } from "bun:test";
import { fallbackUplift } from "./fallback.ts";
import { UPLIFT_SYSTEM_PROMPT } from "./prompt.ts";
import { runUplift } from "./run.ts";

describe("runUplift", () => {
	test("llm success uses sanitized model xml", async () => {
		const original = "add a clients list page";
		let system = "";
		let user = "";
		const result = await runUplift({
			original,
			conversation: "User: earlier",
			complete: async (nextSystem, nextUser) => {
				system = nextSystem;
				user = nextUser;
				return "<BUILD_PROMPT><SCOPE>list</SCOPE></BUILD_PROMPT>";
			},
		});
		expect(system).toBe(UPLIFT_SYSTEM_PROMPT);
		expect(user).toContain(original);
		expect(user).toContain("User: earlier");
		expect(result.source).toBe("llm");
		expect(result.original).toBe(original);
		expect(result.root).toBe("BUILD_PROMPT");
		expect(result.xml).toContain("<BUILD_PROMPT>");
		expect(result.xml).toContain(`<ORIGINAL>${original}</ORIGINAL>`);
		expect(result.xml).toContain("<SCOPE>list</SCOPE>");
	});

	test("llm empty uses fallback", async () => {
		let called = 0;
		const original = "hi";
		const result = await runUplift({
			original,
			complete: async () => {
				called += 1;
				return "   ";
			},
		});
		expect(called).toBe(1);
		expect(result.source).toBe("fallback");
		expect(result.root).toBe("UPLIFTED_PROMPT");
		expect(result.xml).toBe(fallbackUplift(original));
	});

	test("unusable llm xml uses fallback", async () => {
		const original = "hi";
		const result = await runUplift({
			original,
			complete: async () => "not xml at all",
		});
		expect(result.source).toBe("fallback");
		expect(result.xml).toBe(fallbackUplift(original));
	});

	test("llm throw uses fallback", async () => {
		const original = "hi";
		const result = await runUplift({
			original,
			complete: async () => {
				throw new Error("boom");
			},
		});
		expect(result.source).toBe("fallback");
		expect(result.xml).toBe(fallbackUplift(original));
	});

	test("AbortError is rethrown", async () => {
		const err = new Error("Aborted");
		err.name = "AbortError";
		let reached = false;
		try {
			await runUplift({
				original: "hi",
				complete: async () => {
					throw err;
				},
			});
		} catch (caught) {
			reached = true;
			expect(caught).toBe(err);
		}
		expect(reached).toBe(true);
	});

	test("over maxChars uses fallback without calling complete", async () => {
		let called = 0;
		const original = "x".repeat(10);
		const result = await runUplift({
			original,
			maxChars: 5,
			complete: async () => {
				called += 1;
				return "<BUILD_PROMPT>nope</BUILD_PROMPT>";
			},
		});
		expect(called).toBe(0);
		expect(result.source).toBe("fallback");
		expect(result.xml).toBe(fallbackUplift(original));
	});

	test("equal to maxChars still calls complete", async () => {
		let called = 0;
		const original = "hello";
		const result = await runUplift({
			original,
			maxChars: original.length,
			complete: async () => {
				called += 1;
				return "<RESEARCH_PROMPT><Q>x</Q></RESEARCH_PROMPT>";
			},
		});
		expect(called).toBe(1);
		expect(result.source).toBe("llm");
		expect(result.root).toBe("RESEARCH_PROMPT");
	});
});
