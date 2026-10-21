// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { DEFAULT_PROTOCOL_VERSION, SUPPORTED_PROTOCOL_VERSIONS } from "./mcp.ts";

/** Browser origins of the hosted clients that may call /mcp. The service's own origin is added by the router. */
export const DEFAULT_ALLOWED_ORIGINS: readonly string[] = [
	"https://claude.ai",
	"https://claude.com",
	"https://grok.com",
	"https://console.x.ai",
];

/** Lower-cased scheme, host and non-default port of an http(s) origin, or null when the value is not one. */
function normalizeOrigin(value: string): string | null {
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return null;
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") return null;
	if (url.username !== "" || url.password !== "" || url.pathname !== "/" || url.search !== "" || url.hash !== "") {
		return null;
	}
	return url.origin;
}

/**
 * DNS-rebinding guard for /mcp. A request without an Origin (native and server-side clients) is allowed;
 * a browser always sends one. The literal "null" (sandboxed or opaque origin) and any value that does not
 * normalize to an allowed origin are refused.
 */
export function originAllowed(origin: string | null, allowed: readonly string[]): boolean {
	if (origin === null || origin === "") return true;
	const normalized = normalizeOrigin(origin);
	if (normalized === null) return false;
	return allowed.some((entry) => normalizeOrigin(entry) === normalized);
}

/** The version in the MCP-Protocol-Version header. An absent header means the oldest supported version. */
export function resolveProtocolVersion(header: string | null): { ok: true; version: string } | { ok: false } {
	if (header === null) return { ok: true, version: DEFAULT_PROTOCOL_VERSION };
	const version = SUPPORTED_PROTOCOL_VERSIONS.find((supported) => supported === header);
	return version === undefined ? { ok: false } : { ok: true, version };
}
