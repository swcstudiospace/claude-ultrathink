/** Session token budget. Tiers tighten output caps as spend approaches the limit. */

export type Tier = "normal" | "tight" | "minimal";

export interface SessionBudget {
	/** Record `tokens` of spend and return the tier after the spend. Non-finite or negative input counts as 0. */
	spend(tokens: number): Tier;
	/** Current tier without spending. */
	tier(): Tier;
	/** Total tokens spent so far. */
	used(): number;
	/** Tier transitions only, oldest first, at most 50 entries. */
	events(): ReadonlyArray<{ tier: Tier; usedTokens: number }>;
}

const MAX_EVENTS = 50;
const MIN_CAP = 200;

/**
 * Parse TOKEN_OPT_SESSION_TOKEN_BUDGET. Returns a positive safe integer, or null when the
 * value is unset, empty, zero, negative, fractional, or non-numeric.
 */
export function parseSessionBudget(raw: string | undefined): number | null {
	if (typeof raw !== "string") return null;
	const v = raw.trim();
	if (!/^\d+$/.test(v)) return null;
	const n = Number(v);
	return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function tierFor(used: number, limit: number): Tier {
	// Integer-safe comparisons: used * 5 >= limit * 4 is exactly used / limit >= 0.8.
	if (used >= limit) return "minimal";
	if (used * 5 >= limit * 4) return "tight";
	return "normal";
}

/** Create a budget for `limitTokens`. Throws RangeError unless it is a positive safe integer. */
export function createSessionBudget(limitTokens: number): SessionBudget {
	if (!Number.isSafeInteger(limitTokens) || limitTokens <= 0) {
		throw new RangeError(`session budget limit must be a positive safe integer, got ${limitTokens}`);
	}
	let used = 0;
	let current: Tier = "normal";
	const log: Array<{ tier: Tier; usedTokens: number }> = [];

	return {
		spend(tokens: number): Tier {
			const add = Number.isFinite(tokens) && tokens > 0 ? tokens : 0;
			used += add;
			const next = tierFor(used, limitTokens);
			if (next !== current) {
				current = next;
				log.push({ tier: next, usedTokens: used });
				if (log.length > MAX_EVENTS) log.shift();
			}
			return current;
		},
		tier(): Tier {
			return current;
		},
		used(): number {
			return used;
		},
		events(): ReadonlyArray<{ tier: Tier; usedTokens: number }> {
			return log.slice();
		},
	};
}

/** Output cap for a tier. Tight halves the base cap, minimal fifths it; both floor at 200. */
export function capFor(tier: Tier, baseCap: number): number {
	if (tier === "normal") return baseCap;
	if (tier === "tight") return Math.max(MIN_CAP, Math.floor(baseCap / 2));
	return Math.max(MIN_CAP, Math.floor(baseCap / 5));
}
