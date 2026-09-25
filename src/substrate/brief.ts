// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Agent Substrate client.
 *
 * Fetches the cross-agent briefing before the Graph of Thought is built, so the
 * graph is planned knowing what other agents already did in this repo.
 *
 * Every function here fails open. The substrate is an enhancement to a prompt,
 * never a precondition for one: if it is down, slow, or simply not installed,
 * the user's prompt proceeds exactly as it did before.
 */

const DEFAULT_URL = "http://127.0.0.1:7410";
const DEFAULT_TIMEOUT_MS = 1500;

export interface BriefInput {
	repo?: string;
	branch?: string;
	graphId?: string;
	surface?: string;
}

function baseUrl(env: Record<string, string | undefined>): string {
	return (env.SUBSTRATE_URL?.trim() || DEFAULT_URL).replace(/\/+$/, "");
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
 * The session brief as Markdown, or `""` when the substrate cannot answer in
 * time. An empty string is the caller's signal to carry on without it.
 */
export async function fetchBrief(
	input: BriefInput,
	env: Record<string, string | undefined> = process.env,
): Promise<string> {
	if (env.SUBSTRATE_DISABLED === "1") return "";
	try {
		const response = await fetch(`${baseUrl(env)}/brief`, {
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

/** Append an event. Returns whether it landed; callers are expected to ignore that. */
export async function emitEvent(
	input: EmitInput,
	env: Record<string, string | undefined> = process.env,
): Promise<boolean> {
	if (env.SUBSTRATE_DISABLED === "1") return false;
	try {
		const response = await fetch(`${baseUrl(env)}/events`, {
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
