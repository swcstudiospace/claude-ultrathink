// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createFrontier, EMPTY_ROOT, type FrontierPeak, type FrontierState, leafHash, nodeHash, seedFrontier } from "./audit-merkle.ts";

const hashOf = (label: string): string => createHash("sha256").update(label).digest("hex");

const leavesOf = (count: number): string[] => Array.from({ length: count }, (_, index) => hashOf(`leaf-${index}`));

function rootOf(hashes: readonly string[]): string {
	const frontier = createFrontier();
	for (const hash of hashes) frontier.push(hash);
	return frontier.root();
}

describe("createFrontier", () => {
	test("two independent frontiers fed the same 37 hashes give the same root", () => {
		const hashes = leavesOf(37);
		const first = createFrontier();
		const second = createFrontier();
		// Interleave the pushes so any state shared between frontiers would show up as a different root.
		for (const hash of hashes) {
			first.push(hash);
			second.push(hash);
		}
		expect(first.size).toBe(37);
		expect(second.size).toBe(37);
		expect(first.root()).toBe(second.root());
		expect(first.root()).toBe(rootOf(hashes));
	});

	test("flipping any one of 37 leaves changes the root", () => {
		const hashes = leavesOf(37);
		const base = rootOf(hashes);
		for (let index = 0; index < hashes.length; index++) {
			const mutated = [...hashes];
			mutated[index] = hashOf(`flipped-${index}`);
			expect(rootOf(mutated)).not.toBe(base);
		}
	});

	test("the root depends on order and on count", () => {
		const [a, b, c] = leavesOf(3);
		if (a === undefined || b === undefined || c === undefined) throw new Error("fixture");
		expect(rootOf([a, b, c])).not.toBe(rootOf([a, b, c, c]));
		expect(rootOf([a, b])).not.toBe(rootOf([b, a]));
		expect(rootOf([a])).not.toBe(rootOf([a, a]));
	});

	test("size 0 gives EMPTY_ROOT and size 1 gives leafHash of the single record", () => {
		const [a] = leavesOf(1);
		if (a === undefined) throw new Error("fixture");
		const frontier = createFrontier();
		expect(EMPTY_ROOT).toBe("0".repeat(64));
		expect(frontier.size).toBe(0);
		expect(frontier.root()).toBe(EMPTY_ROOT);
		frontier.push(a);
		expect(frontier.size).toBe(1);
		expect(frontier.root()).toBe(leafHash(a));
	});

	test("small sizes bag their peaks as the RFC 6962 structure dictates", () => {
		const [a, b, c, d, e] = leavesOf(5);
		if (a === undefined || b === undefined || c === undefined || d === undefined || e === undefined) {
			throw new Error("fixture");
		}
		const [la, lb, lc, ld, le] = [a, b, c, d, e].map(leafHash) as [string, string, string, string, string];
		const ab = nodeHash(la, lb);
		const cd = nodeHash(lc, ld);
		expect(rootOf([a, b])).toBe(ab);
		expect(rootOf([a, b, c])).toBe(nodeHash(ab, lc));
		expect(rootOf([a, b, c, d])).toBe(nodeHash(ab, cd));
		expect(rootOf([a, b, c, d, e])).toBe(nodeHash(nodeHash(ab, cd), le));
	});

	test("uppercase, short, non-hex and non-string hashes throw TypeError and leave the frontier unchanged", () => {
		const valid = hashOf("valid");
		const bad = [
			valid.toUpperCase(),
			valid.slice(0, 63),
			`${valid}0`,
			"z".repeat(64),
			"",
			123 as unknown as string,
		];
		const frontier = createFrontier();
		frontier.push(valid);
		const rootBefore = frontier.root();
		for (const value of bad) {
			expect(() => frontier.push(value)).toThrow(TypeError);
		}
		expect(frontier.size).toBe(1);
		expect(frontier.root()).toBe(rootBefore);
	});

	test("leafHash and nodeHash apply the same hash validation", () => {
		const valid = hashOf("valid");
		expect(() => leafHash(valid.toUpperCase())).toThrow(TypeError);
		expect(() => leafHash("nope")).toThrow(TypeError);
		expect(() => nodeHash(valid, valid.toUpperCase())).toThrow(TypeError);
		expect(() => nodeHash("nope", valid)).toThrow(TypeError);
	});
});

describe("snapshot and seedFrontier", () => {
	test("snapshot reports the leaf count and the peak heights, highest first", () => {
		const frontier = createFrontier();
		for (const hash of leavesOf(37)) frontier.push(hash);
		const state = frontier.snapshot();
		expect(state.leafCount).toBe(37);
		expect(state.peaks.map((peak) => peak.height)).toEqual([5, 2, 0]);
	});

	test("export and seed round-trip at every split point 0..20, and the later roots match", () => {
		const hashes = leavesOf(37);
		const full = rootOf(hashes);
		for (let split = 0; split <= 20; split++) {
			const original = createFrontier();
			for (const hash of hashes.slice(0, split)) original.push(hash);
			// Through JSON so the state is proven to be plain serialisable data.
			const state: FrontierState = JSON.parse(JSON.stringify(original.snapshot()));
			const seeded = seedFrontier(state);
			expect(seeded.size).toBe(split);
			expect(seeded.root()).toBe(original.root());
			for (const hash of hashes.slice(split)) {
				original.push(hash);
				seeded.push(hash);
				expect(seeded.root()).toBe(original.root());
			}
			expect(seeded.size).toBe(37);
			expect(seeded.root()).toBe(full);
		}
	});

	test("a seeded frontier shares no state with the frontier it was exported from", () => {
		const frontier = createFrontier();
		for (const hash of leavesOf(5)) frontier.push(hash);
		const before = frontier.root();
		const seeded = seedFrontier(frontier.snapshot());
		seeded.push(hashOf("extra"));
		expect(seeded.size).toBe(6);
		expect(frontier.size).toBe(5);
		expect(frontier.root()).toBe(before);
	});

	test("invalid seeds throw TypeError", () => {
		const frontier = createFrontier();
		for (const hash of leavesOf(3)) frontier.push(hash);
		const good = frontier.snapshot();
		const p0 = good.peaks[0];
		const p1 = good.peaks[1];
		if (p0 === undefined || p1 === undefined) throw new Error("fixture");
		const bad: unknown[] = [
			null,
			"state",
			{ leafCount: -1, peaks: [] },
			{ leafCount: 1.5, peaks: [] },
			{ leafCount: Number.NaN, peaks: [] },
			{ leafCount: "3", peaks: [p0, p1] },
			{ leafCount: 0, peaks: null },
			{ leafCount: 3, peaks: [null, p1] },
			{ leafCount: 3, peaks: [{ height: "1", hash: p0.hash }, p1] },
			{ leafCount: 3, peaks: [{ height: 1, hash: p0.hash.toUpperCase() }, p1] },
			{ leafCount: 3, peaks: [{ height: 1, hash: p0.hash.slice(0, 63) }, p1] },
			{ leafCount: 3, peaks: [{ height: 1, hash: 123 }, p1] },
			{ leafCount: 3, peaks: [p1, p0] },
			{ leafCount: 3, peaks: [p0, p0] },
			{ leafCount: 3, peaks: [p0] },
			{ leafCount: 3, peaks: [p0, p1, p1] },
			{ leafCount: 2, peaks: [p1] },
		];
		for (const state of bad) {
			expect(() => seedFrontier(state as FrontierState)).toThrow(TypeError);
		}
	});

	test("a valid seed built by hand is accepted and matches the frontier it describes", () => {
		const hashes = leavesOf(6);
		const reference = rootOf(hashes);
		const [a, b, c, d, e, f] = hashes;
		if (a === undefined || b === undefined || c === undefined || d === undefined || e === undefined || f === undefined) {
			throw new Error("fixture");
		}
		const ab = nodeHash(leafHash(a), leafHash(b));
		const cd = nodeHash(leafHash(c), leafHash(d));
		const ef = nodeHash(leafHash(e), leafHash(f));
		const peaks: FrontierPeak[] = [
			{ height: 2, hash: nodeHash(ab, cd) },
			{ height: 1, hash: ef },
		];
		const seeded = seedFrontier({ leafCount: 6, peaks });
		expect(seeded.size).toBe(6);
		expect(seeded.root()).toBe(reference);
	});
});
