// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * URL policy for operator-configured service endpoints (Hindsight, RAGFlow). A bearer key only ever travels to an
 * `https:` URL, or to an `http:` URL that never leaves this machine or the operator's tailnet: loopback, a Tailscale
 * MagicDNS name (`*.ts.net`) or a Tailscale CGNAT address (100.64.0.0/10). Anything else, including a URL that carries
 * a user name, a password, a query or a fragment, is refused, so a typo or a hostile config cannot send the key in clear.
 * Imports nothing.
 */

export type UrlCheck = { ok: true; url: string } | { ok: false; reason: string };

const LOOPBACK_HOSTS: Record<string, true> = { localhost: true, "127.0.0.1": true, "[::1]": true };

function isCgnat(host: string): boolean {
	const match = /^100\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(host);
	if (!match) return false;
	const second = Number(match[1]);
	return second >= 64 && second <= 127;
}

/** Validates `raw` and returns it as `origin + pathname` without a trailing slash, or the reason it was refused. */
export function checkServiceUrl(raw: unknown): UrlCheck {
	if (typeof raw !== "string" || raw.trim() === "") return { ok: false, reason: "not set" };
	let parsed: URL;
	try {
		parsed = new URL(raw.trim());
	} catch {
		return { ok: false, reason: "not a valid URL" };
	}
	if (parsed.username !== "" || parsed.password !== "") return { ok: false, reason: "must not contain a user name or password" };
	if (parsed.search !== "" || parsed.hash !== "") return { ok: false, reason: "must not contain a query or fragment" };
	if (parsed.protocol === "http:") {
		const host = parsed.hostname;
		if (!Object.hasOwn(LOOPBACK_HOSTS, host) && !host.endsWith(".ts.net") && !isCgnat(host)) {
			return { ok: false, reason: "http is allowed only for localhost, *.ts.net and 100.64.0.0/10; use https" };
		}
	} else if (parsed.protocol !== "https:") {
		return { ok: false, reason: "must be an http(s) URL" };
	}
	const path = parsed.pathname.replace(/\/+$/, "");
	return { ok: true, url: `${parsed.origin}${path}` };
}
