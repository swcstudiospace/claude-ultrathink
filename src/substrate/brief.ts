// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Agent Substrate client — an optional integration.
 *
 * Fetches the cross-agent briefing before the Graph of Thought is built, so the
 * graph is planned knowing what other agents already did in this repo, and
 * reports the plan back once it exists: `emitEvent` appends one `note` event
 * carrying the Graph ID, which the substrate adopts unchanged as its
 * correlation key (the caller is `runPromptSubmit`).
 *
 * Opt-in: nothing is contacted unless a server URL is set, either through the
 * `SUBSTRATE_URL` environment variable or `substrate.url` in the ultrathink
 * config (the environment wins). `SUBSTRATE_DISABLED=1` turns both off.
 *
 * Every function here fails open. The substrate is an enhancement to a prompt,
 * never a precondition for one: if it is unset, down, slow, or simply not
 * installed, the user's prompt proceeds exactly as it did before.
 */

import { gatewayBrief, gatewayEmit } from "../gateway/substrate.ts";
import { resolveGateway, serviceBackend } from "../gateway/settings.ts";
import { SUBSTRATE_BACKEND_ENV, type GatewayConfig } from "../gateway/types.ts";

const DEFAULT_TIMEOUT_MS = 1500;

/** Passed by callers that have the merged config. Absent keeps the direct substrate client. */
export interface SubstrateGatewayBinding {
	backend?: "direct" | "gateway";
	gateway: GatewayConfig;
	storePath?: string;
	fetch?: typeof fetch;
}

export interface BriefInput {
	repo?: string;
	branch?: string;
	graphId?: string;
	surface?: string;
	/** The caller's planning lifetime, combined with the request timeout: an abort ends the request and the brief is "". */
	signal?: AbortSignal;
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
 * The session brief as Markdown, or `""` when no substrate is configured, it
 * cannot answer in time, or `input.signal` aborts. An empty string is the
 * caller's signal to carry on without it. Never rejects. `url` is the
 * configured `substrate.url`; `SUBSTRATE_URL` wins.
 */
export async function fetchBrief(
	input: BriefInput,
	env: Record<string, string | undefined> = process.env,
	url = "",
	binding?: SubstrateGatewayBinding,
): Promise<string> {
	if (binding && serviceBackend(binding.backend, env, SUBSTRATE_BACKEND_ENV) === "gateway") {
		if (env.SUBSTRATE_DISABLED === "1") return "";
		const resolved = resolveGateway(binding.gateway, env, { storePath: binding.storePath });
		if (!resolved.ok) return "";
		return gatewayBrief(resolved.gateway, input, binding.fetch);
	}
	const target = resolveSubstrate(env, url);
	if (!target) return "";
	// A cancelled caller sends nothing; the brief is optional, so cancellation reads as "no brief".
	if (input.signal?.aborted) return "";
	const timeout = AbortSignal.timeout(timeoutMs(env));
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
			signal: input.signal ? AbortSignal.any([input.signal, timeout]) : timeout,
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
 * Same opt-in rule as {@link fetchBrief}: no URL, no request. The optional `signal` (the caller's own budget) cuts the
 * request short, or skips it when already aborted, on top of the substrate timeout.
 */
export async function emitEvent(
	input: EmitInput,
	env: Record<string, string | undefined> = process.env,
	url = "",
	signal?: AbortSignal,
	binding?: SubstrateGatewayBinding,
): Promise<boolean> {
	if (binding && serviceBackend(binding.backend, env, SUBSTRATE_BACKEND_ENV) === "gateway") {
		if (env.SUBSTRATE_DISABLED === "1") return false;
		const resolved = resolveGateway(binding.gateway, env, { storePath: binding.storePath });
		if (!resolved.ok) return false;
		return gatewayEmit(resolved.gateway, input, binding.fetch, signal);
	}
	const target = resolveSubstrate(env, url);
	if (!target || signal?.aborted) return false;
	try {
		const timeout = AbortSignal.timeout(timeoutMs(env));
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
			signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
		});
		return response.ok;
	} catch {
		return false;
	}
}
