// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

/**
 * Checks an OpenRouter API key before it is stored: the format locally, then one
 * non-destructive GET to OpenRouter's key endpoint. A rejected key is never stored.
 *
 * Messages never contain the key. Transient failures (network errors, 5xx) are
 * retried with backoff; a 401 or 403 is final.
 */

export const OPENROUTER_KEY_PATTERN = /^sk-or-[A-Za-z0-9_-]{16,256}$/;
export const OPENROUTER_KEY_URL = "https://openrouter.ai/api/v1/auth/key";
export const VERIFY_TIMEOUT_MS = 10_000;
/** Delays before the second and third attempt. Three attempts in total. */
export const RETRY_BACKOFF_MS = [500, 1000] as const;

export type KeyCheck =
	| { ok: true }
	| { ok: false; reason: "format" | "rejected" | "unreachable"; message: string };

export interface VerifyDeps {
	fetch?: typeof fetch;
	sleep?: (ms: number) => Promise<void>;
}

export function checkOpenRouterKeyFormat(key: string): KeyCheck {
	if (!OPENROUTER_KEY_PATTERN.test(key)) {
		return {
			ok: false,
			reason: "format",
			message: "an OpenRouter key starts with sk-or- and holds only letters, digits, '-' and '_'",
		};
	}
	return { ok: true };
}

const UNREACHABLE =
	"could not verify the OpenRouter key after 3 attempts; retry later, or store it unverified with --no-verify";

export async function verifyOpenRouterKey(key: string, deps: VerifyDeps = {}): Promise<KeyCheck> {
	const format = checkOpenRouterKeyFormat(key);
	if (!format.ok) return format;
	const fetchImpl = deps.fetch ?? fetch;
	const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms));
	for (let attempt = 0; attempt < RETRY_BACKOFF_MS.length + 1; attempt++) {
		if (attempt > 0) await sleep(RETRY_BACKOFF_MS[attempt - 1] ?? 0);
		let response: Response;
		try {
			response = await fetchImpl(OPENROUTER_KEY_URL, {
				headers: { Authorization: `Bearer ${key}` },
				signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS),
			});
		} catch {
			continue;
		}
		if (response.status === 401 || response.status === 403) {
			return { ok: false, reason: "rejected", message: `OpenRouter rejected the key (HTTP ${response.status})` };
		}
		if (response.ok) return { ok: true };
		if (response.status < 500) {
			return { ok: false, reason: "unreachable", message: `OpenRouter answered HTTP ${response.status} while verifying the key` };
		}
	}
	return { ok: false, reason: "unreachable", message: UNREACHABLE };
}
