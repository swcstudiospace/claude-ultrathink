// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Desk gateway backend. Direct Hindsight, RAGFlow and substrate clients stay the default.
 * `gateway` is opt-in: one JSON-RPC `tools/call` to `<url>/mcp/<seat>`, seat bearer token,
 * no Hindsight or RAGFlow key.
 */

/** Absent or `"direct"` keeps today's client. `"gateway"` calls the desk gateway. */
export type ServiceBackend = "direct" | "gateway";

export interface GatewayConfig {
	/** Gateway origin. User files only. Empty falls back to `DESK_GATEWAY_URL`. */
	url: string;
	/** Seat path segment. Default `lead` (`/mcp/lead`). */
	seat: string;
	/** Budget in milliseconds for one tool call. */
	timeoutMs: number;
}

export const DEFAULT_GATEWAY_CONFIG: GatewayConfig = {
	url: "",
	seat: "lead",
	timeoutMs: 8_000,
};

export const GATEWAY_URL_ENV = "DESK_GATEWAY_URL";
export const GATEWAY_SEAT_ENV = "DESK_GATEWAY_SEAT";
export const GATEWAY_TOKEN_ENV = "DESK_GATEWAY_TOKEN";
export const GATEWAY_TIMEOUT_ENV = "DESK_GATEWAY_TIMEOUT_MS";
/** `ULTRATHINK_GATEWAY=0` forces every integration back to its direct backend. */
export const GATEWAY_KILL_ENV = "ULTRATHINK_GATEWAY";

export const HINDSIGHT_BACKEND_ENV = "ULTRATHINK_HINDSIGHT_BACKEND";
export const RAGFLOW_BACKEND_ENV = "ULTRATHINK_RAGFLOW_BACKEND";
export const SUBSTRATE_BACKEND_ENV = "ULTRATHINK_SUBSTRATE_BACKEND";

/** Credential-store provider id. Not an OAuth catalog entry; the store is read as a consumer. */
export const GATEWAY_STORE_PROVIDER = "desk-gateway";

export const SEAT_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
/** `contracts/tool-rosters/_core.yaml` graph_id. */
export const GRAPH_ID_PATTERN = /^ut-[a-z0-9]+-[0-9a-f]{8}$/;

export type GatewayTokenSource = "store" | typeof GATEWAY_TOKEN_ENV;

export type GatewayFailureState = "unready" | "degraded";

export interface GatewayFailure {
	state: GatewayFailureState;
	/** One line, redacted, never the seat token. */
	reason: string;
}

export type GatewayCallResult<T> = { ok: true; value: T } | ({ ok: false } & GatewayFailure);
