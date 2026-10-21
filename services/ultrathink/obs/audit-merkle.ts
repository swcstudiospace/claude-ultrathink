// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

/**
 * Merkle Mountain Range frontier for the audit chain's anchors (phase 68, CONTEXT D1).
 *
 * The frontier keeps only the peaks, O(log n) hashes, so an anchor can cover every record without loading the file.
 * Hashing uses RFC 6962 domain separation: leaf = SHA-256(0x00 || h), node = SHA-256(0x01 || left || right). No last
 * leaf is ever duplicated, so [a, b, c] and [a, b, c, c] have different roots.
 */

import { createHash } from "node:crypto";

const HEX_64 = /^[0-9a-f]{64}$/;
const LEAF_PREFIX = Buffer.from([0x00]);
const NODE_PREFIX = Buffer.from([0x01]);

/** Root of an empty frontier: 64 zero hex digits. */
export const EMPTY_ROOT = "0".repeat(64);

/** One peak of a frontier: the root of a perfect subtree of 2^height leaves. */
export interface FrontierPeak {
	readonly height: number;
	readonly hash: string;
}

/** Plain JSON-serialisable frontier state. `peaks` run from the highest (leftmost) to the lowest (rightmost). */
export interface FrontierState {
	readonly leafCount: number;
	readonly peaks: readonly FrontierPeak[];
}

export interface MerkleFrontier {
	/** Adds one record hash (64 lowercase hex characters) as the newest leaf. Throws `TypeError` on any other input. */
	push(recordHash: string): void;
	/** Root over every pushed leaf in push order. An empty frontier returns {@link EMPTY_ROOT}. */
	root(): string;
	/** Number of leaves pushed so far. */
	readonly size: number;
	/** Copy of the peaks and leaf count. {@link seedFrontier} restores an equal frontier from it. */
	snapshot(): FrontierState;
}

function assertHash(value: unknown): asserts value is string {
	if (typeof value !== "string" || !HEX_64.test(value)) {
		throw new TypeError("hash must be 64 lowercase hex characters");
	}
}

/** RFC 6962 leaf hash of one record hash: SHA-256(0x00 || h), hex encoded. */
export function leafHash(recordHash: string): string {
	assertHash(recordHash);
	return createHash("sha256").update(LEAF_PREFIX).update(Buffer.from(recordHash, "hex")).digest("hex");
}

/** RFC 6962 interior node hash: SHA-256(0x01 || left || right), hex encoded. */
export function nodeHash(left: string, right: string): string {
	assertHash(left);
	assertHash(right);
	return createHash("sha256")
		.update(NODE_PREFIX)
		.update(Buffer.from(left, "hex"))
		.update(Buffer.from(right, "hex"))
		.digest("hex");
}

/** Creates an independent frontier. Frontiers share no state. */
export function createFrontier(): MerkleFrontier {
	return makeFrontier([], 0);
}

/**
 * Creates a frontier that continues from a state produced by {@link MerkleFrontier.snapshot}. The state is validated
 * first: `leafCount` must be a non-negative safe integer, every hash must be 64 lowercase hex characters, the peak
 * heights must be strictly decreasing, and they must be exactly the set bits of `leafCount`, high to low. Anything
 * else throws `TypeError`. The seeded frontier copies the state, so the two frontiers share no state.
 */
export function seedFrontier(state: FrontierState): MerkleFrontier {
	if (typeof state !== "object" || state === null) throw new TypeError("frontier state must be an object");
	const { leafCount, peaks } = state;
	if (typeof leafCount !== "number" || !Number.isSafeInteger(leafCount) || leafCount < 0) {
		throw new TypeError("leafCount must be a non-negative safe integer");
	}
	if (!Array.isArray(peaks)) throw new TypeError("peaks must be an array");
	const heights = peakHeightsOf(leafCount);
	if (peaks.length !== heights.length) {
		throw new TypeError(`leafCount ${leafCount} needs ${heights.length} peaks, got ${peaks.length}`);
	}
	const restored: FrontierPeak[] = [];
	let previous = Number.POSITIVE_INFINITY;
	for (let index = 0; index < heights.length; index++) {
		const peak: unknown = peaks[index];
		if (typeof peak !== "object" || peak === null) throw new TypeError(`peak ${index} must be an object`);
		const { height, hash } = peak as Partial<FrontierPeak>;
		if (typeof height !== "number" || !Number.isSafeInteger(height) || height < 0) {
			throw new TypeError(`peak ${index} height must be a non-negative safe integer`);
		}
		assertHash(hash);
		if (height >= previous) throw new TypeError(`peak ${index} height ${height} is not strictly decreasing`);
		if (height !== heights[index]) {
			throw new TypeError(`peak ${index} height ${height} must be ${heights[index]} for leafCount ${leafCount}`);
		}
		previous = height;
		restored.push({ height, hash });
	}
	return makeFrontier(restored, leafCount);
}

/** Peak heights of a frontier with `leafCount` leaves: the set bits of the count, highest first. */
function peakHeightsOf(leafCount: number): number[] {
	const heights: number[] = [];
	let rest = leafCount;
	for (let height = 0; rest > 0; height++) {
		if (rest % 2 === 1) heights.push(height);
		rest = Math.floor(rest / 2);
	}
	return heights.reverse();
}

function makeFrontier(peaks: FrontierPeak[], initialSize: number): MerkleFrontier {
	let size = initialSize;

	return {
		push(recordHash: string): void {
			let hash = leafHash(recordHash);
			let height = 0;
			for (;;) {
				const top = peaks.at(-1);
				if (top === undefined || top.height !== height) break;
				peaks.pop();
				hash = nodeHash(top.hash, hash);
				height++;
			}
			peaks.push({ hash, height });
			size++;
		},
		root(): string {
			const last = peaks.at(-1);
			if (last === undefined) return EMPTY_ROOT;
			let acc = last.hash;
			for (const peak of peaks.slice(0, -1).reverse()) {
				acc = nodeHash(peak.hash, acc);
			}
			return acc;
		},
		get size(): number {
			return size;
		},
		snapshot(): FrontierState {
			return { leafCount: size, peaks: peaks.map(({ height, hash }) => ({ height, hash })) };
		},
	};
}
