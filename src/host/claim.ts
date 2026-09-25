// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * One planner per turn. Grok 1.0.40 only dispatches the global hook file that
 * `scripts/setup.ts apply` installs; if a later Grok also dispatches the plugin's
 * own hooks, both would plan the same prompt and create duplicate tracking rows.
 * The first hook to create the claim file wins. Fail-open: a broken claim store
 * must never block planning.
 */
import { closeSync, mkdirSync, openSync, opendirSync, statSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

const CLAIM_TTL_MS = 24 * 60 * 60 * 1000;
const PRUNE_SCAN_LIMIT = 200;

function pruneStaleClaims(dir: string, now: number): void {
	try {
		const handle = opendirSync(dir);
		try {
			for (let scanned = 0; scanned < PRUNE_SCAN_LIMIT; scanned++) {
				const entry = handle.readSync();
				if (!entry) break;
				const path = join(dir, entry.name);
				try {
					if (now - statSync(path).mtimeMs > CLAIM_TTL_MS) unlinkSync(path);
				} catch {
					// a sibling hook may have pruned it first
				}
			}
		} finally {
			handle.closeSync();
		}
	} catch {
		// best-effort
	}
}

/** True when this process owns the turn `key`; false only when another hook already claimed it. */
export function claimTurn(stateDir: string, key: string, now = Date.now()): boolean {
	try {
		const dir = join(stateDir, "claims");
		mkdirSync(dir, { recursive: true });
		pruneStaleClaims(dir, now);
		const name = createHash("sha256").update(key).digest("hex").slice(0, 32);
		closeSync(openSync(join(dir, name), "wx"));
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException | undefined)?.code !== "EEXIST";
	}
}
