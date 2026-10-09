// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Resolves the desk gateway (URL, seat, seat token, timeout). Reads the credential store
 * provider `desk-gateway` or `DESK_GATEWAY_TOKEN`. Never reads `HINDSIGHT_API_KEY` or
 * `RAGFLOW_API_KEY`.
 */
import { readStore, storePath as defaultStorePath } from "../mcp/store.ts";
import type { Credential } from "../mcp/store.ts";
import { checkServiceUrl } from "../net/safe-url.ts";
import {
	DEFAULT_GATEWAY_CONFIG,
	GATEWAY_KILL_ENV,
	GATEWAY_SEAT_ENV,
	GATEWAY_STORE_PROVIDER,
	GATEWAY_TIMEOUT_ENV,
	GATEWAY_TOKEN_ENV,
	GATEWAY_URL_ENV,
	SEAT_PATTERN,
	type GatewayConfig,
	type GatewayTokenSource,
	type ServiceBackend,
} from "./types.ts";

export interface ResolvedGateway {
	url: string;
	seat: string;
	token: string;
	tokenSource: GatewayTokenSource;
	timeoutMs: number;
}

export type GatewayResolution = { ok: true; gateway: ResolvedGateway } | { ok: false; reason: "no-url" | "bad-url" | "no-token"; detail?: string };

/** `ULTRATHINK_GATEWAY=0` forces direct. A `direct`/`gateway` env override wins over the file. */
export function serviceBackend(configured: ServiceBackend | undefined, env: Record<string, string | undefined>, envName: string): ServiceBackend {
	if (env[GATEWAY_KILL_ENV] === "0") return "direct";
	const override = env[envName];
	if (override === "direct" || override === "gateway") return override;
	return configured === "gateway" ? "gateway" : "direct";
}

function storedToken(storePath: string | undefined, env: Record<string, string | undefined>): { token: string; source: GatewayTokenSource } | undefined {
	try {
		const providers = readStore(storePath ?? defaultStorePath(env)).providers as Partial<Record<string, Credential>>;
		const credential = providers[GATEWAY_STORE_PROVIDER];
		if (credential?.kind === "api_key") {
			const token = credential.apiKey.trim();
			if (token) return { token, source: "store" };
		}
		if (credential?.kind === "oauth" && credential.tokens?.accessToken) {
			const token = credential.tokens.accessToken.trim();
			if (token) return { token, source: "store" };
		}
	} catch {
		// unreadable store: fall back to the environment
	}
	const fromEnv = env[GATEWAY_TOKEN_ENV]?.trim();
	return fromEnv ? { token: fromEnv, source: GATEWAY_TOKEN_ENV } : undefined;
}

function timeoutMs(config: GatewayConfig, env: Record<string, string | undefined>): number {
	const raw = Number(env[GATEWAY_TIMEOUT_ENV]);
	if (Number.isInteger(raw) && raw >= 1 && raw <= 120_000) return raw;
	return config.timeoutMs;
}

/** Never throws and sends nothing. Does not read Hindsight or RAGFlow key variables. */
export function resolveGateway(config: GatewayConfig, env: Record<string, string | undefined>, deps: { storePath?: string } = {}): GatewayResolution {
	const rawUrl = env[GATEWAY_URL_ENV]?.trim() || config.url.trim();
	if (rawUrl === "") return { ok: false, reason: "no-url" };
	const url = checkServiceUrl(rawUrl);
	if (!url.ok) return { ok: false, reason: "bad-url", detail: url.reason };
	const requestedSeat = env[GATEWAY_SEAT_ENV]?.trim() || config.seat.trim() || DEFAULT_GATEWAY_CONFIG.seat;
	if (!SEAT_PATTERN.test(requestedSeat)) return { ok: false, reason: "bad-url", detail: "seat must match [a-z][a-z0-9-]{0,31}" };
	const token = storedToken(deps.storePath, env);
	if (!token) return { ok: false, reason: "no-token" };
	return {
		ok: true,
		gateway: { url: url.url, seat: requestedSeat, token: token.token, tokenSource: token.source, timeoutMs: timeoutMs(config, env) },
	};
}

/** Origin, seat and token source. Never the token or a URL path. */
export function gatewayStatus(resolution: GatewayResolution): string {
	if (!resolution.ok) {
		if (resolution.reason === "no-url") return "unready · no URL (set gateway.url or DESK_GATEWAY_URL)";
		if (resolution.reason === "bad-url") return `unready · bad URL (${resolution.detail ?? "refused"})`;
		return "unready · no token (set DESK_GATEWAY_TOKEN or store a desk-gateway credential)";
	}
	const { gateway } = resolution;
	return `ready · ${new URL(gateway.url).origin} · seat ${gateway.seat} · token from ${gateway.tokenSource}`;
}
