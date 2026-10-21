// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import { authorize, identityFromUriSans, isEdgeIdentity, type RouteGroup } from "./identity.ts";

const TD = "ultrathink.internal";
const EDGE = "spiffe://ultrathink.internal/edge/nginx";
const PROBE = "spiffe://ultrathink.internal/ops/probe";

describe("identityFromUriSans", () => {
	test("accepts one valid SPIFFE URI and returns its ID and path", () => {
		const result = identityFromUriSans([`URI:${EDGE}`], TD);
		expect(result).toEqual({ ok: true, spiffeId: EDGE, path: "/edge/nginx" });
	});

	test("accepts a bare spiffe value without a type label", () => {
		expect(identityFromUriSans([PROBE], TD)).toEqual({ ok: true, spiffeId: PROBE, path: "/ops/probe" });
	});

	test("ignores a DNS SAN mixed with the SPIFFE URI", () => {
		const result = identityFromUriSans(["DNS:edge.ultrathink.internal", `URI:${EDGE}`, "IP Address:127.0.0.1"], TD);
		expect(result).toEqual({ ok: true, spiffeId: EDGE, path: "/edge/nginx" });
	});

	test("does not count a DNS SAN whose value looks like a SPIFFE ID", () => {
		const result = identityFromUriSans([`DNS:${PROBE}`, `URI:${EDGE}`], TD);
		expect(result).toEqual({ ok: true, spiffeId: EDGE, path: "/edge/nginx" });
	});

	test("reports absent for an empty SAN list", () => {
		expect(identityFromUriSans([], TD)).toEqual({ ok: false, reason: "absent" });
	});

	test("reports absent when only DNS, IP and non-SPIFFE URIs are present", () => {
		const result = identityFromUriSans(["DNS:app.example", "IP Address:127.0.0.1", "URI:https://example.com/edge/nginx"], TD);
		expect(result).toEqual({ ok: false, reason: "absent" });
	});

	test("refuses two valid SPIFFE URIs as ambiguous", () => {
		const result = identityFromUriSans([`URI:${EDGE}`, `URI:${PROBE}`], TD);
		expect(result).toEqual({ ok: false, reason: "ambiguous" });
	});

	test("refuses a valid SPIFFE URI plus a foreign one as ambiguous", () => {
		const result = identityFromUriSans([`URI:${EDGE}`, "URI:spiffe://evil.internal/edge/nginx"], TD);
		expect(result).toEqual({ ok: false, reason: "ambiguous" });
	});

	test("refuses the same SPIFFE URI listed twice as ambiguous", () => {
		expect(identityFromUriSans([`URI:${EDGE}`, `URI:${EDGE}`], TD)).toEqual({ ok: false, reason: "ambiguous" });
	});

	test("refuses a SPIFFE URI in another trust domain even when its path is in the policy", () => {
		expect(identityFromUriSans(["URI:spiffe://evil.internal/edge/nginx"], TD)).toEqual({
			ok: false,
			reason: "foreign_trust_domain",
		});
	});

	test("refuses trust domains that only share a prefix or suffix with the expected one", () => {
		expect(identityFromUriSans(["URI:spiffe://ultrathink.internal.evil/edge/nginx"], TD)).toEqual({
			ok: false,
			reason: "foreign_trust_domain",
		});
		expect(identityFromUriSans(["URI:spiffe://evil-ultrathink.internal/edge/nginx"], TD)).toEqual({
			ok: false,
			reason: "foreign_trust_domain",
		});
	});

	const malformed: Array<[string, string]> = [
		["query string", "spiffe://ultrathink.internal/edge/nginx?x=1"],
		["fragment", "spiffe://ultrathink.internal/edge/nginx#frag"],
		["dot-dot segment", "spiffe://ultrathink.internal/edge/../edge/nginx"],
		["single dot segment", "spiffe://ultrathink.internal/edge/./nginx"],
		["uppercase trust domain", "spiffe://Ultrathink.internal/edge/nginx"],
		["userinfo", "spiffe://user@ultrathink.internal/edge/nginx"],
		["port", "spiffe://ultrathink.internal:8443/edge/nginx"],
		["empty trust domain", "spiffe:///edge/nginx"],
		["empty path segment", "spiffe://ultrathink.internal/edge//nginx"],
		["trailing slash", "spiffe://ultrathink.internal/edge/nginx/"],
		["no path", "spiffe://ultrathink.internal"],
		["root path only", "spiffe://ultrathink.internal/"],
		["uppercase scheme", "SPIFFE://ultrathink.internal/edge/nginx"],
		["percent encoding", "spiffe://ultrathink.internal/edge%2fnginx"],
		["space in path", "spiffe://ultrathink.internal/edge/ng inx"],
		["path over 256 characters", `spiffe://ultrathink.internal/${"a".repeat(256)}`],
	];
	for (const [label, uri] of malformed) {
		test(`refuses malformed SPIFFE URI: ${label}`, () => {
			expect(identityFromUriSans([`URI:${uri}`], TD)).toEqual({ ok: false, reason: "malformed" });
		});
	}

	test("accepts a path of exactly 256 characters", () => {
		const path = `/${"a".repeat(255)}`;
		const result = identityFromUriSans([`URI:spiffe://ultrathink.internal${path}`], TD);
		expect(result).toEqual({ ok: true, spiffeId: `spiffe://ultrathink.internal${path}`, path });
	});

	test("accepts every allowed path character", () => {
		const result = identityFromUriSans(["URI:spiffe://ultrathink.internal/Ab-9._/x.y"], TD);
		expect(result.ok).toBe(true);
	});

	test("a malformed SPIFFE URI next to a DNS SAN is still malformed, not absent", () => {
		const result = identityFromUriSans(["DNS:app.example", "URI:spiffe://ultrathink.internal/edge/nginx?x=1"], TD);
		expect(result).toEqual({ ok: false, reason: "malformed" });
	});
});

describe("authorize", () => {
	type Case = [string | null, RouteGroup, boolean];
	const cases: Case[] = [
		[EDGE, "proxied", true],
		[EDGE, "health", true],
		[EDGE, "metrics", false],
		[PROBE, "proxied", false],
		[PROBE, "health", true],
		[PROBE, "metrics", true],
		["spiffe://ultrathink.internal/edge/other", "proxied", false],
		["spiffe://ultrathink.internal/edge/other", "health", false],
		["spiffe://ultrathink.internal/edge/other", "metrics", false],
		["spiffe://ultrathink.internal/ops", "health", false],
		["spiffe://ultrathink.internal/ops/probe/extra", "metrics", false],
		[null, "proxied", false],
		[null, "health", false],
		[null, "metrics", false],
		["spiffe://evil.internal/edge/nginx", "proxied", false],
		["spiffe://evil.internal/ops/probe", "metrics", false],
		["spiffe://ultrathink.internal/edge/nginx?x=1", "proxied", false],
		["", "proxied", false],
	];
	for (const [id, group, expected] of cases) {
		test(`authorize(${id ?? "null"}, ${group}) is ${expected}`, () => {
			expect(authorize(id, group, TD)).toBe(expected);
		});
	}

	test("rejects an identity whose trust domain differs from the configured one", () => {
		expect(authorize(EDGE, "proxied", "other.internal")).toBe(false);
	});

	test("rejects an unknown route group at compile time and at runtime", () => {
		// @ts-expect-error "admin" is not a RouteGroup
		expect(authorize(EDGE, "admin", TD)).toBe(false);
	});
});

describe("isEdgeIdentity", () => {
	test("is true only for the nginx edge identity in the trust domain", () => {
		expect(isEdgeIdentity(EDGE, TD)).toBe(true);
	});

	test("is false for the probe identity, unknown paths, null and malformed IDs", () => {
		expect(isEdgeIdentity(PROBE, TD)).toBe(false);
		expect(isEdgeIdentity("spiffe://ultrathink.internal/edge/other", TD)).toBe(false);
		expect(isEdgeIdentity(null, TD)).toBe(false);
		expect(isEdgeIdentity("spiffe://ultrathink.internal/edge/nginx?x=1", TD)).toBe(false);
	});

	test("is false for the edge path in another trust domain", () => {
		expect(isEdgeIdentity("spiffe://evil.internal/edge/nginx", TD)).toBe(false);
	});
});
