// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import type { SecurityEventLogger } from "../security/events.ts";

/**
 * Progressive penalties for repeated failures per key (an IP address).
 *
 * Failures are counted in fixed windows. Exceeding the per-window threshold
 * escalates the key: its block doubles with each escalation within the decay
 * period, capped at maxSec. The decay period starts when a block ends: a quiet
 * period longer than it resets the level. Failures during an active block change
 * nothing.
 *
 * The table holds at most maxKeys keys. A new key that finds the table full
 * after pruning is reported untracked and stored nowhere: penalties fail open
 * there, while the rate windows already refuse new keys when full.
 *
 * Each escalation is also reported to the optional security logger as a suspicious-activity event.
 */

export interface PenaltyOptions {
	windowMs: number;
	failuresPerWindow: number;
	baseSec: number;
	maxSec: number;
	decayMs: number;
	maxKeys: number;
	now: () => number;
	/** Receives a suspicious-activity event at each escalation. Absent means no events. */
	security?: SecurityEventLogger;
}

export interface PenaltyLadder {
	fail(key: string): { blockedSec: number; escalated: boolean; level: number; tracked: boolean };
	/** Remaining whole seconds of the block (rounded up); 0 when not blocked. */
	blockedSec(key: string): number;
}

interface Entry {
	/** Fixed window index of the current failure count. */
	window: number;
	count: number;
	level: number;
	/** Block is active while blockedUntil > now; the decay period starts at its end. */
	blockedUntil: number;
}

function requirePositive(name: string, value: number): void {
	if (!Number.isFinite(value) || value <= 0) {
		throw new RangeError(`${name} must be a positive finite number, got ${value}`);
	}
}

function requirePositiveInteger(name: string, value: number): void {
	if (!Number.isSafeInteger(value) || value < 1) {
		throw new RangeError(`${name} must be a positive integer, got ${value}`);
	}
}

function validate(options: PenaltyOptions): void {
	requirePositive("windowMs", options.windowMs);
	requirePositiveInteger("failuresPerWindow", options.failuresPerWindow);
	requirePositive("baseSec", options.baseSec);
	requirePositive("maxSec", options.maxSec);
	requirePositive("decayMs", options.decayMs);
	requirePositiveInteger("maxKeys", options.maxKeys);
	if (options.baseSec > options.maxSec) {
		throw new RangeError(`baseSec (${options.baseSec}) must not exceed maxSec (${options.maxSec})`);
	}
	if (typeof options.now !== "function") throw new RangeError("now must be a function");
}

export function createPenaltyLadder(options: PenaltyOptions): PenaltyLadder {
	validate(options);
	const { windowMs, failuresPerWindow, baseSec, maxSec, decayMs, maxKeys, now, security } = options;
	const entries = new Map<string, Entry>();

	const windowOf = (t: number): number => Math.floor(t / windowMs);
	const secondsUntil = (blockedUntil: number, t: number): number => Math.ceil((blockedUntil - t) / 1000);

	// Drops entries that carry no live state: no active block, no decay period
	// still running, and a failure window that is no longer current.
	function prune(t: number): void {
		const currentWindow = windowOf(t);
		for (const [key, entry] of entries) {
			if (entry.blockedUntil > t) continue;
			if (entry.level > 0 && t - entry.blockedUntil <= decayMs) continue;
			if (entry.window === currentWindow) continue;
			entries.delete(key);
		}
	}

	return {
		fail(key) {
			const t = now();
			let entry = entries.get(key);
			if (entry && entry.blockedUntil > t) {
				return { blockedSec: secondsUntil(entry.blockedUntil, t), escalated: false, level: entry.level, tracked: true };
			}
			if (!entry) {
				if (entries.size >= maxKeys) {
					prune(t);
					if (entries.size >= maxKeys) return { blockedSec: 0, escalated: false, level: 0, tracked: false };
				}
				entry = { window: windowOf(t), count: 0, level: 0, blockedUntil: 0 };
				entries.set(key, entry);
			}

			const currentWindow = windowOf(t);
			if (entry.window !== currentWindow) {
				entry.window = currentWindow;
				entry.count = 0;
			}
			entry.count += 1;
			if (entry.count <= failuresPerWindow) {
				return { blockedSec: 0, escalated: false, level: entry.level, tracked: true };
			}

			// Decay runs from the end of the last block: quiet for more than decayMs after it resets the level.
			const quiet = entry.level === 0 || t - entry.blockedUntil > decayMs;
			entry.level = quiet ? 1 : entry.level + 1;
			const seconds = Math.min(maxSec, baseSec * 2 ** (entry.level - 1));
			entry.blockedUntil = t + seconds * 1000;
			entry.count = 0;
			const blockedSec = secondsUntil(entry.blockedUntil, t);
			security?.logSuspiciousActivity({ name: "abuse.penalty_escalated", ip: key, details: { level: entry.level, blockedSec } });
			return { blockedSec, escalated: true, level: entry.level, tracked: true };
		},

		blockedSec(key) {
			const entry = entries.get(key);
			if (!entry) return 0;
			const t = now();
			return entry.blockedUntil > t ? secondsUntil(entry.blockedUntil, t) : 0;
		},
	};
}
