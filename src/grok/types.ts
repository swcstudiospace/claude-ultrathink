/**
 * Configuration types for the optional Grok 4.6 thinking engine. Claude is
 * this plugin's default Stage-1 engine; Grok is an opt-in alternative
 * (`think.engine: "grok"`) that reuses the user's existing `grok login`
 * session.
 */

export type GrokEffort = "low" | "medium" | "high" | "xhigh";

export const GROK_EFFORTS: readonly GrokEffort[] = ["low", "medium", "high", "xhigh"];

export type GrokTransport = "http" | "cli";

export interface GrokConfig {
	enabled: boolean;
	baseUrl: string;
	model: string;
	/** "Grok 4.6 Ultra" = grok-4.6 at xhigh. */
	reasoningEffort: GrokEffort;
	transport: GrokTransport;
	bin: string;
	/** Empty → $GROK_HOME or ~/.grok. */
	home: string;
	/** Per-call timeout in ms. 0 = no timer (the host hook timeout is the backstop). */
	callTimeoutMs: number;
	/** Never silently downgrade to Claude by default. */
	fallbackToClaude: boolean;
}

export const DEFAULT_GROK_CONFIG: GrokConfig = {
	enabled: true,
	baseUrl: "https://cli-chat-proxy.grok.com/v1",
	model: "grok-4.6",
	reasoningEffort: "xhigh",
	transport: "http",
	bin: "grok",
	home: "",
	callTimeoutMs: 0,
	fallbackToClaude: false,
};

export const GROK_CLIENT_VERSION_FALLBACK = "1.0.25";
