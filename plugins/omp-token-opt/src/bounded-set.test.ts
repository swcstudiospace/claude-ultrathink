import { describe, expect, test } from "bun:test";
import { BoundedSet } from "./bounded-set.ts";

describe("BoundedSet", () => {
	test("evicts the least recently inserted value first", () => {
		const set = new BoundedSet(3);
		set.add("a");
		set.add("b");
		set.add("c");
		set.add("d");
		expect(set.size).toBe(3);
		expect(set.has("a")).toBe(false);
		expect(set.has("b")).toBe(true);
		expect(set.has("c")).toBe(true);
		expect(set.has("d")).toBe(true);
	});

	test("has() refreshes recency so the value survives the next eviction", () => {
		const set = new BoundedSet(3);
		set.add("a");
		set.add("b");
		set.add("c");
		// Order after has("a"): b, c, a. Next eviction must hit b.
		expect(set.has("a")).toBe(true);
		set.add("d");
		expect(set.has("b")).toBe(false);
		expect(set.has("a")).toBe(true);
	});

	test("has() on a missing value does not change recency or size", () => {
		const set = new BoundedSet(2);
		set.add("a");
		set.add("b");
		expect(set.has("zzz")).toBe(false);
		expect(set.size).toBe(2);
		set.add("c");
		expect(set.has("a")).toBe(false);
	});

	test("add() of an existing value refreshes recency without growing", () => {
		const set = new BoundedSet(2);
		set.add("a");
		set.add("b");
		// Order after re-adding a: b, a. Next eviction must hit b.
		set.add("a");
		expect(set.size).toBe(2);
		set.add("c");
		expect(set.size).toBe(2);
		expect(set.has("b")).toBe(false);
		expect(set.has("a")).toBe(true);
		expect(set.has("c")).toBe(true);
	});

	test("size counts distinct values only", () => {
		const set = new BoundedSet(5);
		set.add("x");
		set.add("x");
		set.add("y");
		expect(set.size).toBe(2);
	});

	test("never exceeds max over a long insertion run", () => {
		const set = new BoundedSet(4);
		for (let i = 0; i < 100; i += 1) set.add(`v${i}`);
		expect(set.size).toBe(4);
		expect(set.has("v95")).toBe(false);
		expect(set.has("v96")).toBe(true);
		expect(set.has("v99")).toBe(true);
		expect(set.has("v94")).toBe(false);
	});

	test("max of 1 keeps only the most recent value", () => {
		const set = new BoundedSet(1);
		set.add("a");
		set.add("b");
		expect(set.size).toBe(1);
		expect(set.has("a")).toBe(false);
		expect(set.has("b")).toBe(true);
	});

	test.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 1_000_001, 2 ** 53])(
		"throws RangeError for max %p",
		(max) => {
			expect(() => new BoundedSet(max)).toThrow(RangeError);
		},
	);

	test("accepts the boundary values 1 and 1000000", () => {
		expect(() => new BoundedSet(1)).not.toThrow();
		expect(() => new BoundedSet(1_000_000)).not.toThrow();
	});
});
