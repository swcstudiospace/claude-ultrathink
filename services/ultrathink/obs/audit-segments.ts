// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

/**
 * File layout of sealed audit segments (phase 68, CONTEXT D9). A sealed segment holds a contiguous run of chain records
 * and is named by its first and last seq: `audit-<firstSeq>-<lastSeq>.jsonl`. The active file keeps its own name.
 */

import { dirname, join } from "node:path";

const SEALED = /^audit-([1-9][0-9]*)-([1-9][0-9]*)\.jsonl$/;

export interface SealedSegment {
	/** Full path, in the same directory as the active file. */
	readonly path: string;
	readonly name: string;
	readonly first: number;
	readonly last: number;
}

/** File name of a sealed segment that holds the records `first` through `last`. */
export function sealedName(first: number, last: number): string {
	return `audit-${first}-${last}.jsonl`;
}

/**
 * Sealed segments next to the active file, sorted by first seq. Only names that `sealedName` produces for their own
 * range are listed, so `.corrupt-*` evidence and stray files are never taken for segments. A directory that cannot
 * be read has no segments.
 */
export function listSegments(activePath: string, fs: { readdirSync(path: string): readonly string[] }): SealedSegment[] {
	const dir = dirname(activePath);
	let names: readonly string[];
	try {
		names = fs.readdirSync(dir);
	} catch {
		return [];
	}
	const segments: SealedSegment[] = [];
	for (const name of names) {
		const match = SEALED.exec(name);
		if (match === null) continue;
		const first = Number(match[1]);
		const last = Number(match[2]);
		if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || last < first || sealedName(first, last) !== name) continue;
		segments.push({ path: join(dir, name), name, first, last });
	}
	return segments.sort((a, b) => a.first - b.first);
}
