// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Readiness for the RAGFlow integration: kill switch, opt-in, URL policy and key lookup resolved once, in one place, so
 * the planner, the CLI and the status line can never disagree about whether RAGFlow is reachable. Pure and synchronous:
 * nothing here touches the network.
 */
import { createGatewayRagflowClient } from "../gateway/ragflow.ts";
import { gatewayStatus, resolveGateway, serviceBackend } from "../gateway/settings.ts";
import { RAGFLOW_BACKEND_ENV, type GatewayConfig } from "../gateway/types.ts";
import { checkServiceUrl } from "../net/safe-url.ts";
import { readStore, storePath as defaultStorePath } from "../mcp/store.ts";
import { createRagflowClient } from "./client.ts";
import {
	type RagflowConfig,
	type RagflowKeySource,
	type RagflowReadiness,
	type RagflowResolution,
	RAGFLOW_KEY_ENV,
	RAGFLOW_KILL_ENV,
	RAGFLOW_URL_ENV,
} from "./types.ts";

/** Stored `ragflow` api_key (trimmed, non-empty) wins; else trimmed non-empty RAGFLOW_API_KEY. Never throws. */
export function resolveRagflowKey(
	storePath: string | undefined,
	env: NodeJS.ProcessEnv,
): { key: string; source: RagflowKeySource } | undefined {
	try {
		const providers = readStore(storePath ?? defaultStorePath(env)).providers as Record<string, unknown>;
		const credential = providers.ragflow as { kind?: unknown; apiKey?: unknown } | undefined;
		const stored = credential?.kind === "api_key" && typeof credential.apiKey === "string" ? credential.apiKey.trim() : "";
		if (stored) return { key: stored, source: "store" };
	} catch {
		// unreadable store: fall back to the environment
	}
	const fromEnv = env[RAGFLOW_KEY_ENV]?.trim();
	return fromEnv ? { key: fromEnv, source: RAGFLOW_KEY_ENV } : undefined;
}

/** Kill switch, then opt-in, then URL (`config.url`, else RAGFLOW_URL), then key. A client exists only when ready. */
export function resolveRagflow(
	config: RagflowConfig,
	env: NodeJS.ProcessEnv,
	deps: { storePath?: string; fetch?: typeof fetch; signal?: AbortSignal; gateway?: GatewayConfig } = {},
): RagflowResolution {
	if (env[RAGFLOW_KILL_ENV]?.trim() === "0") return { readiness: { state: "off", reason: "killed" } };
	if (!config.enabled) return { readiness: { state: "off", reason: "disabled" } };
	if (serviceBackend(config.backend, env, RAGFLOW_BACKEND_ENV) === "gateway") {
		const gatewayConfig = deps.gateway ?? { url: "", seat: "lead", timeoutMs: config.timeoutMs };
		const resolved = resolveGateway(gatewayConfig, env, { storePath: deps.storePath });
		if (!resolved.ok) return { readiness: { state: "unready", reason: resolved.reason === "no-token" ? "no-token" : resolved.reason, detail: resolved.detail } };
		const { gateway } = resolved;
		return {
			readiness: { state: "ready", backend: "gateway", url: gateway.url, seat: gateway.seat, tokenSource: gateway.tokenSource },
			client: createGatewayRagflowClient({ ...gateway, fetch: deps.fetch, signal: deps.signal }),
		};
	}
	const raw = config.url.trim() || env[RAGFLOW_URL_ENV]?.trim() || "";
	if (raw === "") return { readiness: { state: "unready", reason: "no-url" } };
	const url = checkServiceUrl(raw);
	if (!url.ok) return { readiness: { state: "unready", reason: "bad-url", detail: url.reason } };
	const key = resolveRagflowKey(deps.storePath, env);
	if (!key) return { readiness: { state: "unready", reason: "no-key" } };
	const readiness: RagflowReadiness = { state: "ready", url: url.url, keySource: key.source };
	const client = createRagflowClient({
		url: url.url,
		apiKey: key.key,
		timeoutMs: config.timeoutMs,
		fetch: deps.fetch,
		signal: deps.signal,
	});
	return { readiness, client };
}

/** One line for `ultrathink status`; starts with "RAGFlow: ". Never contains the key. */
export function ragflowStatusLine(config: RagflowConfig, env: NodeJS.ProcessEnv, storePath?: string, gateway?: GatewayConfig): string {
	const { readiness } = resolveRagflow(config, env, { storePath, gateway });
	if (readiness.state === "ready" && "backend" in readiness) {
		return `RAGFlow: gateway · ${gatewayStatus({ ok: true, gateway: { url: readiness.url, seat: readiness.seat, token: "", tokenSource: readiness.tokenSource, timeoutMs: config.timeoutMs } })}`;
	}
	if (readiness.state === "unready" && serviceBackend(config.backend, env, RAGFLOW_BACKEND_ENV) === "gateway") {
		const resolved = resolveGateway(gateway ?? { url: "", seat: "lead", timeoutMs: config.timeoutMs }, env, { storePath });
		return `RAGFlow: gateway · ${gatewayStatus(resolved)}`;
	}
	if (readiness.state === "off") {
		return readiness.reason === "killed" ? `RAGFlow: off (${RAGFLOW_KILL_ENV}=0)` : "RAGFlow: off (opt-in: set ragflow.enabled)";
	}
	if (readiness.state === "unready") {
		if (readiness.reason === "no-url") return `RAGFlow: on · no URL (set ragflow.url or ${RAGFLOW_URL_ENV})`;
		if (readiness.reason === "bad-url") return `RAGFlow: on · bad URL (${readiness.detail ?? "refused"})`;
		return `RAGFlow: on · no key (run bin/ultrathink-mcp auth set-key ragflow --stdin, or set ${RAGFLOW_KEY_ENV})`;
	}
	const pinned = config.datasetIds.length;
	const scope = pinned > 0 ? `${pinned} dataset(s) pinned` : "all datasets";
	return `RAGFlow: on · ${new URL(readiness.url).origin} · key from ${readiness.keySource} · grounding ${config.ground ? "on" : "off"} · ${scope}`;
}
