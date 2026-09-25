// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Agent Substrate client — an optional integration.
 *
 * Fetches the cross-agent briefing before the Graph of Thought is built, so the
 * graph is planned knowing what other agents already did in this repo.
 *
 * Opt-in: nothing is contacted unless a server URL is set, either through the
 * `SUBSTRATE_URL` environment variable or `substrate.url` in the ultrathink
 * config (the environment wins). `SUBSTRATE_DISABLED=1` turns both off.
 *
 * Every function here fails open. The substrate is an enhancement to a prompt,
 * never a precondition for one: if it is unset, down, slow, or simply not
 * installed, the user's prompt proceeds exactly as it did before.
 */

const DEFAULT_TIMEOUT_MS = 1500;

export interface BriefInput {
	repo?: string;
	branch?: string;
	graphId?: string;
	surface?: string;
}

export interface SubstrateTarget {
	url: string;
	/** Where the URL came from; the environment wins over the config file. */
	source: "SUBSTRATE_URL" | "config";
}

/**
 * The server to talk to, or undefined when the integration is off: no URL in
 * `SUBSTRATE_URL` or `substrate.url`, or `SUBSTRATE_DISABLED=1`.
 */
export function resolveSubstrate(
	env: Record<string, string | undefined>,
	configuredUrl: string,
): SubstrateTarget | undefined {
	if (env.SUBSTRATE_DISABLED === "1") return undefined;
	const fromEnv = env.SUBSTRATE_URL?.trim().replace(/\/+$/, "");
	if (fromEnv) return { url: fromEnv, source: "SUBSTRATE_URL" };
	const fromConfig = configuredUrl.trim().replace(/\/+$/, "");
	return fromConfig ? { url: fromConfig, source: "config" } : undefined;
}

function authHeaders(env: Record<string, string | undefined>): Record<string, string> {
	const token = env.SUBSTRATE_TOKEN?.trim();
	return token ? { authorization: `Bearer ${token}` } : {};
}

function timeoutMs(env: Record<string, string | undefined>): number {
	const raw = Number(env.SUBSTRATE_TIMEOUT_MS);
	return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TIMEOUT_MS;
}

/**
 * The session brief as Markdown, or `""` when no substrate is configured or it
 * cannot answer in time. An empty string is the caller's signal to carry on
 * without it. `url` is the configured `substrate.url`; `SUBSTRATE_URL` wins.
 */
export async function fetchBrief(
	input: BriefInput,
	env: Record<string, string | undefined> = process.env,
	url = "",
): Promise<string> {
	const target = resolveSubstrate(env, url);
	if (!target) return "";
	try {
		const response = await fetch(`${target.url}/brief`, {
			method: "POST",
			headers: { "content-type": "application/json", ...authHeaders(env) },
			body: JSON.stringify({
				repo: input.repo,
				branch: input.branch,
				graph_id: input.graphId,
				surface: input.surface ?? "claude-code",
			}),
			signal: AbortSignal.timeout(timeoutMs(env)),
		});
		if (!response.ok) return "";
		return (await response.text()).trim();
	} catch {
		return ""; // fail-open: a missing substrate never blocks a prompt
	}
}

export interface EmitInput {
	kind: string;
	summary: string;
	surface?: string;
	sessionId?: string;
	graphId?: string;
	nodeId?: string;
	repo?: string;
	branch?: string;
	payload?: Record<string, unknown>;
}

/**
 * Append an event. Returns whether it landed; callers are expected to ignore that.
 * Same opt-in rule as {@link fetchBrief}: no URL, no request.
 */
export async function emitEvent(
	input: EmitInput,
	env: Record<string, string | undefined> = process.env,
	url = "",
): Promise<boolean> {
	const target = resolveSubstrate(env, url);
	if (!target) return false;
	try {
		const response = await fetch(`${target.url}/events`, {
			method: "POST",
			headers: { "content-type": "application/json", ...authHeaders(env) },
			body: JSON.stringify({
				kind: input.kind,
				summary: input.summary,
				surface: input.surface ?? "claude-code",
				session_id: input.sessionId,
				graph_id: input.graphId,
				node_id: input.nodeId,
				repo: input.repo,
				branch: input.branch,
				payload: input.payload,
			}),
			signal: AbortSignal.timeout(timeoutMs(env)),
		});
		return response.ok;
	} catch {
		return false;
	}
}
