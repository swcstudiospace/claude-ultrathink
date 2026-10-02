// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Resolves whether Hindsight is usable: the opt-in flag, the `ULTRATHINK_HINDSIGHT=0` kill switch, the service URL
 * (through the URL policy in src/net/safe-url.ts) and the API key (credential store first, then the environment). Pure
 * and synchronous apart from reading the credential file; no request is made here, so callers can ask any time.
 */
import { readStore, storePath as defaultStorePath } from "../mcp/store.ts";
import { checkServiceUrl } from "../net/safe-url.ts";
import { createHindsightClient } from "./client.ts";
import {
	DEFAULT_HINDSIGHT_CONFIG,
	HINDSIGHT_KEY_ENVS,
	HINDSIGHT_KILL_ENV,
	HINDSIGHT_URL_ENV,
	type HindsightConfig,
	type HindsightKeySource,
	type HindsightResolution,
} from "./types.ts";

/** The credential-store provider id; `bin/ultrathink-mcp auth set-key hindsight --stdin` writes it. */
const PROVIDER = "hindsight";

/** Stored `hindsight` api_key (trimmed, non-empty) wins; then HINDSIGHT_API_KEY, then HINDSIGHT_API_TOKEN. Never throws. */
export function resolveHindsightKey(
	storePath: string | undefined,
	env: NodeJS.ProcessEnv,
): { key: string; source: HindsightKeySource } | undefined {
	try {
		const providers = readStore(storePath ?? defaultStorePath(env)).providers as Record<string, unknown>;
		const credential = providers[PROVIDER] as { kind?: unknown; apiKey?: unknown } | undefined;
		const stored = credential?.kind === "api_key" && typeof credential.apiKey === "string" ? credential.apiKey.trim() : "";
		if (stored) return { key: stored, source: "store" };
	} catch {
		// unreadable store: fall back to the environment
	}
	for (const name of HINDSIGHT_KEY_ENVS) {
		const value = env[name]?.trim();
		if (value) return { key: value, source: name };
	}
	return undefined;
}

/** Never throws and sends nothing. `client` is present only when the readiness is "ready". */
export function resolveHindsight(
	config: HindsightConfig,
	env: NodeJS.ProcessEnv,
	deps: { storePath?: string; fetch?: typeof fetch; signal?: AbortSignal } = {},
): HindsightResolution {
	if (env[HINDSIGHT_KILL_ENV] === "0") return { readiness: { state: "off", reason: "killed" } };
	if (!config.enabled) return { readiness: { state: "off", reason: "disabled" } };
	const rawUrl = config.url.trim() || env[HINDSIGHT_URL_ENV]?.trim() || "";
	if (rawUrl === "") return { readiness: { state: "unready", reason: "no-url" } };
	const url = checkServiceUrl(rawUrl);
	if (!url.ok) return { readiness: { state: "unready", reason: "bad-url", detail: url.reason } };
	const key = resolveHindsightKey(deps.storePath, env);
	if (!key) return { readiness: { state: "unready", reason: "no-key" } };
	const bank = config.bank.trim() || DEFAULT_HINDSIGHT_CONFIG.bank;
	const client = createHindsightClient({
		url: url.url,
		apiKey: key.key,
		bank,
		timeoutMs: config.timeoutMs,
		retainTimeoutMs: config.retainTimeoutMs,
		fetch: deps.fetch,
		signal: deps.signal,
	});
	return { readiness: { state: "ready", url: url.url, bank, keySource: key.source }, client };
}

/** One line for `status` output; names the origin, bank and key source, never the key or a URL path. */
export function hindsightStatusLine(config: HindsightConfig, env: NodeJS.ProcessEnv, storePath?: string): string {
	const { readiness } = resolveHindsight(config, env, { storePath });
	if (readiness.state === "off") {
		return readiness.reason === "killed"
			? `Hindsight: off (${HINDSIGHT_KILL_ENV}=0)`
			: "Hindsight: off (opt-in: set hindsight.enabled)";
	}
	if (readiness.state === "unready") {
		if (readiness.reason === "no-url") return `Hindsight: on · no URL (set hindsight.url or ${HINDSIGHT_URL_ENV})`;
		if (readiness.reason === "bad-url") return `Hindsight: on · bad URL (${readiness.detail ?? "refused"})`;
		return "Hindsight: on · no key (run bin/ultrathink-mcp auth set-key hindsight --stdin, or set HINDSIGHT_API_KEY)";
	}
	return `Hindsight: on · ${new URL(readiness.url).origin} · bank ${readiness.bank} · key from ${readiness.keySource}`;
}
