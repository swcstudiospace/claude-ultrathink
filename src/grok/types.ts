// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Configuration types for the optional Grok 4.7 thinking engine. Claude is
 * this plugin's default Stage-1 engine; Grok is an opt-in alternative
 * (`think.engine: "grok"`) that reuses the user's existing `grok login`
 * session (`http`/`cli` transports) or a shunt gateway you run.
 */

export type GrokEffort = "low" | "medium" | "high" | "xhigh";

export const GROK_EFFORTS: readonly GrokEffort[] = ["low", "medium", "high", "xhigh"];

/**
 * `http`: Grok CLI chat proxy `/responses` with the `grok login` token.
 * `cli`: shell out to the Grok Build CLI.
 * `shunt`: a shunt gateway you run (Anthropic Messages `/v1/messages`, no auth).
 */
export type GrokTransport = "http" | "cli" | "shunt";

export const GROK_TRANSPORTS: readonly GrokTransport[] = ["http", "cli", "shunt"];

export interface GrokConfig {
	enabled: boolean;
	baseUrl: string;
	model: string;
	/** "Grok 4.7 Extra High" = grok-4.7 at xhigh. */
	reasoningEffort: GrokEffort;
	transport: GrokTransport;
	bin: string;
	/** Empty → $GROK_HOME or ~/.grok. */
	home: string;
	/** Per-call timeout in ms. 0 = no timer (the host hook timeout is the backstop). */
	callTimeoutMs: number;
	/** Never silently downgrade to Claude by default. */
	fallbackToClaude: boolean;
	/** Base URL of your shunt gateway; `/v1/messages` is appended. "" = not configured (required for `transport: "shunt"`). */
	shuntBaseUrl: string;
	/** Wire model sent to shunt; the gateway route pins the effort, so the alias carries it. "" = send `model`. */
	shuntModel: string;
	/** Anthropic Messages `max_tokens` for shunt calls. */
	shuntMaxTokens: number;
}

export const DEFAULT_GROK_CONFIG: GrokConfig = {
	enabled: true,
	baseUrl: "https://cli-chat-proxy.grok.com/v1",
	model: "grok-4.7",
	reasoningEffort: "xhigh",
	transport: "http",
	bin: "grok",
	home: "",
	callTimeoutMs: 0,
	fallbackToClaude: false,
	shuntBaseUrl: "",
	shuntModel: "",
	shuntMaxTokens: 8192,
};

export const GROK_CLIENT_VERSION_FALLBACK = "1.0.25";
