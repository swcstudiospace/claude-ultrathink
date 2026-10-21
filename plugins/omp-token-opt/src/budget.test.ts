import { describe, expect, test } from "bun:test";
import { capFor, createSessionBudget, parseSessionBudget } from "./budget.ts";

describe("parseSessionBudget", () => {
	test.each(["", "   ", "0", "-5", "1.5", "abc", "1e3", "+5", "9007199254740993"])(
		"rejects %p",
		(raw) => {
			expect(parseSessionBudget(raw)).toBeNull();
		},
	);

	test("returns null when unset", () => {
		expect(parseSessionBudget(undefined)).toBeNull();
	});

	test("parses a positive integer, ignoring surrounding whitespace", () => {
		expect(parseSessionBudget("1000")).toBe(1000);
		expect(parseSessionBudget(" 250 ")).toBe(250);
	});
});

describe("createSessionBudget", () => {
	test("rejects a limit that is not a positive safe integer", () => {
		for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(() => createSessionBudget(bad)).toThrow(RangeError);
		}
	});

	test("switches to tight at exactly 80% and minimal at exactly 100%", () => {
		const budget = createSessionBudget(1000);
		expect(budget.spend(799)).toBe("normal");
		expect(budget.spend(1)).toBe("tight");
		expect(budget.spend(199)).toBe("tight");
		expect(budget.used()).toBe(999);
		expect(budget.spend(1)).toBe("minimal");
		expect(budget.used()).toBe(1000);
	});

	test("treats non-finite and negative spend as zero", () => {
		const budget = createSessionBudget(100);
		expect(budget.spend(Number.NaN)).toBe("normal");
		expect(budget.spend(Number.POSITIVE_INFINITY)).toBe("normal");
		expect(budget.spend(-50)).toBe("normal");
		expect(budget.used()).toBe(0);
	});

	test("tier() reads the current tier without spending", () => {
		const budget = createSessionBudget(10);
		expect(budget.tier()).toBe("normal");
		budget.spend(8);
		expect(budget.tier()).toBe("tight");
		expect(budget.used()).toBe(8);
	});

	test("events record transitions once, not every spend", () => {
		const budget = createSessionBudget(100);
		budget.spend(1);
		budget.spend(84);
		budget.spend(1);
		budget.spend(1);
		budget.spend(20);
		expect(budget.events()).toEqual([
			{ tier: "tight", usedTokens: 85 },
			{ tier: "minimal", usedTokens: 107 },
		]);
	});

	test("a single spend that crosses both thresholds records one minimal event", () => {
		const budget = createSessionBudget(100);
		budget.spend(150);
		expect(budget.events()).toEqual([{ tier: "minimal", usedTokens: 150 }]);
	});

	test("events are a snapshot that callers cannot use to mutate state", () => {
		const budget = createSessionBudget(10);
		budget.spend(9);
		const snapshot = [...budget.events()];
		snapshot.length = 0;
		expect(budget.events()).toEqual([{ tier: "tight", usedTokens: 9 }]);
	});
});

describe("capFor", () => {
	test("normal returns the base cap", () => {
		expect(capFor("normal", 6000)).toBe(6000);
	});

	test("tight halves the cap with floor", () => {
		expect(capFor("tight", 1001)).toBe(500);
		expect(capFor("tight", 999)).toBe(499);
		expect(capFor("tight", 6000)).toBe(3000);
	});

	test("minimal fifths the cap with floor", () => {
		expect(capFor("minimal", 1009)).toBe(201);
		expect(capFor("minimal", 6000)).toBe(1200);
	});

	test("tight and minimal never drop below 200", () => {
		expect(capFor("tight", 300)).toBe(200);
		expect(capFor("tight", 1)).toBe(200);
		expect(capFor("minimal", 1000)).toBe(200);
		expect(capFor("minimal", 0)).toBe(200);
	});
});
