// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
export type ProviderId = "notion" | "linear" | "greptile";

export interface Provider {
	id: ProviderId;
	label: string;
	url: string;
	resource: string;
	protectedResourceMetadata: string;
	apiKey: boolean;
	oauth: boolean;
	scopes: string[];
}

export const PROVIDERS: Record<ProviderId, Provider> = {
	notion: {
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

export function isProviderId(value: string): value is ProviderId {
	return Object.hasOwn(PROVIDERS, value);
}

export const USER_AGENT = "ultrathink-mcp/0.2.0";
