// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Peer identity from a verified client certificate.
 *
 * The identity is the SPIFFE ID carried in the certificate's URI SAN, read only after the TLS
 * layer verified the chain. A header never supplies an identity. Route policy is declared here,
 * in code, so a bad entry fails the type check instead of the runtime.
 *
 * Fail-closed rules:
 * - exactly one SPIFFE URI may be present; two or more are `ambiguous`, so a caller can never
 *   pick one of several claims;
 * - the SPIFFE ID must be canonical: no query, fragment, userinfo, port, empty or dot segments,
 *   and an exact lowercase trust domain.
 */

const SPIFFE_PREFIX = "spiffe://";
const SPIFFE_SCHEME = "spiffe:";
const URI_SAN_LABEL = "URI:";
const MAX_PATH_LENGTH = 256;
const PATH_GRAMMAR = /^\/[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
const TRUST_DOMAIN_GRAMMAR = /^[a-z0-9._-]+$/;

export const EDGE_PATH = "/edge/nginx";
export const PROBE_PATH = "/ops/probe";

export const ROUTE_GROUPS = ["proxied", "health", "metrics"] as const;
export type RouteGroup = (typeof ROUTE_GROUPS)[number];

/** Path of the verified identity to the route groups it may reach. Unlisted identities reach nothing. */
const ROUTE_POLICY = {
	[EDGE_PATH]: ["proxied", "health"],
	[PROBE_PATH]: ["health", "metrics"],
} as const satisfies Readonly<Record<string, readonly RouteGroup[]>>;

export type IdentityRejectionReason = "absent" | "ambiguous" | "malformed" | "foreign_trust_domain";

export type IdentityResult =
	| { ok: true; spiffeId: string; path: string }
	| { ok: false; reason: IdentityRejectionReason };

type SpiffeParse = { ok: true; path: string } | { ok: false; reason: "malformed" | "foreign_trust_domain" };

/**
 * Returns the SPIFFE candidates among the SAN entries. An entry is a candidate when, after an
 * optional `URI:` type label is removed, it starts with `spiffe:` (any case). Other SAN types such
 * as `DNS:` or `IP Address:` never count, and neither do non-SPIFFE URIs.
 */
function spiffeCandidates(sans: readonly string[]): string[] {
	const candidates: string[] = [];
	for (const san of sans) {
		const value = san.startsWith(URI_SAN_LABEL) ? san.slice(URI_SAN_LABEL.length) : san;
		if (value.slice(0, SPIFFE_SCHEME.length).toLowerCase() === SPIFFE_SCHEME) candidates.push(value);
	}
	return candidates;
}

/** Parses one candidate and checks it is canonical and in `trustDomain`. Returns the path on success. */
function parseSpiffeId(spiffeId: string, trustDomain: string): SpiffeParse {
	if (!spiffeId.startsWith(SPIFFE_PREFIX)) return { ok: false, reason: "malformed" };
	const rest = spiffeId.slice(SPIFFE_PREFIX.length);
	if (rest.includes("?") || rest.includes("#")) return { ok: false, reason: "malformed" };

	const slash = rest.indexOf("/");
	const authority = slash === -1 ? rest : rest.slice(0, slash);
	const path = slash === -1 ? "" : rest.slice(slash);

	// Covers empty authority, userinfo, port and uppercase characters.
	if (!TRUST_DOMAIN_GRAMMAR.test(authority)) return { ok: false, reason: "malformed" };
	if (authority !== trustDomain) return { ok: false, reason: "foreign_trust_domain" };

	if (path.length > MAX_PATH_LENGTH || !PATH_GRAMMAR.test(path)) return { ok: false, reason: "malformed" };
	const segments = path.slice(1).split("/");
	if (segments.some((segment) => segment === "." || segment === "..")) return { ok: false, reason: "malformed" };

	return { ok: true, path };
}

/**
 * Extracts the caller's SPIFFE identity from a verified certificate's SAN entries.
 * Accepts exactly one SPIFFE URI in `trustDomain`.
 */
export function identityFromUriSans(sans: readonly string[], trustDomain: string): IdentityResult {
	const candidates = spiffeCandidates(sans);
	if (candidates.length === 0) return { ok: false, reason: "absent" };
	if (candidates.length > 1) return { ok: false, reason: "ambiguous" };

	const spiffeId = candidates[0] ?? "";
	const parsed = parseSpiffeId(spiffeId, trustDomain);
	if (!parsed.ok) return { ok: false, reason: parsed.reason };
	return { ok: true, spiffeId, path: parsed.path };
}

/** Path of a canonical SPIFFE ID in `trustDomain`, or undefined when it is null or not acceptable. */
function identityPath(spiffeId: string | null, trustDomain: string): string | undefined {
	if (spiffeId === null) return undefined;
	const parsed = parseSpiffeId(spiffeId, trustDomain);
	return parsed.ok ? parsed.path : undefined;
}

/** True only when `spiffeId` is in `trustDomain` and its path lists `group` in the policy table. */
export function authorize(spiffeId: string | null, group: RouteGroup, trustDomain: string): boolean {
	const path = identityPath(spiffeId, trustDomain);
	if (path === undefined || !Object.hasOwn(ROUTE_POLICY, path)) return false;
	const groups: readonly RouteGroup[] = ROUTE_POLICY[path as keyof typeof ROUTE_POLICY];
	return groups.includes(group);
}

/** True only for the nginx edge identity in `trustDomain`. */
export function isEdgeIdentity(spiffeId: string | null, trustDomain: string): boolean {
	return identityPath(spiffeId, trustDomain) === EDGE_PATH;
}
