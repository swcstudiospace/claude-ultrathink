// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Credential providers. MCP providers are remote MCP servers (relay, check, OAuth login); key providers only hold an
 * API key in the same store for a non-MCP client (OpenRouter's Decisions API) and are never served or connected.
 */
export type McpProviderId = "notion" | "linear" | "greptile";
export type KeyProviderId = "openrouter";
export type ProviderId = McpProviderId | KeyProviderId;

export interface McpProvider {
	kind: "mcp";
	id: McpProviderId;
	label: string;
	url: string;
	resource: string;
	protectedResourceMetadata: string;
	apiKey: boolean;
	oauth: boolean;
	scopes: string[];
}

export interface KeyProvider {
	kind: "key";
	id: KeyProviderId;
	label: string;
	apiKey: true;
	oauth: false;
	/** Environment variable that supplies the key when none is stored. */
	envVar: string;
}

export type Provider = McpProvider | KeyProvider;

export const MCP_PROVIDERS: Record<McpProviderId, McpProvider> = {
	notion: {
		kind: "mcp",
		id: "notion",
		label: "Notion",
		url: "https://mcp.notion.com/mcp",
		resource: "https://mcp.notion.com/mcp",
		protectedResourceMetadata: "https://mcp.notion.com/.well-known/oauth-protected-resource/mcp",
		apiKey: false,
		oauth: true,
		scopes: ["default"],
	},
	linear: {
		kind: "mcp",
		id: "linear",
		label: "Linear",
		url: "https://mcp.linear.app/mcp",
		resource: "https://mcp.linear.app/mcp",
		protectedResourceMetadata: "https://mcp.linear.app/.well-known/oauth-protected-resource/mcp",
		apiKey: true,
		oauth: true,
		scopes: ["read", "write"],
	},
	greptile: {
		kind: "mcp",
		id: "greptile",
		label: "Greptile",
		url: "https://api.greptile.com/mcp",
		resource: "https://api.greptile.com/mcp",
		protectedResourceMetadata: "https://api.greptile.com/.well-known/oauth-protected-resource",
		apiKey: true,
		oauth: true,
		scopes: ["read", "write"],
	},
};

export const KEY_PROVIDERS: Record<KeyProviderId, KeyProvider> = {
	openrouter: { kind: "key", id: "openrouter", label: "OpenRouter", apiKey: true, oauth: false, envVar: "OPENROUTER_API_KEY" },
};

/** Every provider in table order: the MCP servers first, then the API-key-only providers. */
export const PROVIDERS: Record<ProviderId, Provider> = { ...MCP_PROVIDERS, ...KEY_PROVIDERS };

export const MCP_PROVIDER_IDS: readonly McpProviderId[] = ["notion", "linear", "greptile"];

export function isProviderId(value: string): value is ProviderId {
	return Object.hasOwn(PROVIDERS, value);
}

export function isMcpProviderId(value: string): value is McpProviderId {
	return Object.hasOwn(MCP_PROVIDERS, value);
}

/** Refusal for a key provider asked to act as an MCP server. */
export function notMcpServer(id: string): string {
	return `${id} is an API-key provider, not an MCP server`;
}

export const USER_AGENT = "ultrathink-mcp/0.2.0";
