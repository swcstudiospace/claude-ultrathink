// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { describe, expect, test } from "bun:test";
import { SUPPORTED_PROTOCOL_VERSIONS } from "./mcp.ts";
import { DEFAULT_ALLOWED_ORIGINS, originAllowed, resolveProtocolVersion } from "./transport.ts";

const SERVICE_ORIGIN = "https://ultrathink.example.test";
const ALLOWED = [SERVICE_ORIGIN, ...DEFAULT_ALLOWED_ORIGINS];

describe("DEFAULT_ALLOWED_ORIGINS", () => {
	test("lists the hosted client origins", () => {
		expect([...DEFAULT_ALLOWED_ORIGINS]).toEqual([
			"https://claude.ai",
			"https://claude.com",
			"https://grok.com",
			"https://console.x.ai",
		]);
	});
});

describe("originAllowed", () => {
	test("an absent or empty Origin is allowed", () => {
		expect(originAllowed(null, ALLOWED)).toBe(true);
		expect(originAllowed("", ALLOWED)).toBe(true);
		expect(originAllowed(null, [])).toBe(true);
	});

	test("every listed origin is allowed", () => {
		for (const origin of ALLOWED) expect(originAllowed(origin, ALLOWED)).toBe(true);
	});

	test("an unlisted origin is refused", () => {
		for (const origin of ["https://evil.example", "https://claude.ai.evil.example", "https://sub.claude.ai"]) {
			expect(originAllowed(origin, ALLOWED)).toBe(false);
		}
		expect(originAllowed("https://claude.ai", [])).toBe(false);
	});

	test("a trailing slash does not change the origin", () => {
		expect(originAllowed("https://claude.ai/", ALLOWED)).toBe(true);
		expect(originAllowed("https://claude.ai", ["https://claude.ai/"])).toBe(true);
	});

	test("scheme and host compare case-insensitively", () => {
		expect(originAllowed("HTTPS://Claude.AI", ALLOWED)).toBe(true);
		expect(originAllowed("https://claude.ai", ["HTTPS://CLAUDE.AI"])).toBe(true);
	});

	test("an explicit default port equals the bare origin, other ports differ", () => {
		expect(originAllowed("https://claude.ai:443", ALLOWED)).toBe(true);
		expect(originAllowed("https://claude.ai", ["https://claude.ai:443"])).toBe(true);
		expect(originAllowed("https://claude.ai:8443", ALLOWED)).toBe(false);
		expect(originAllowed("https://claude.ai:8443", ["https://claude.ai:8443"])).toBe(true);
		expect(originAllowed("https://claude.ai", ["https://claude.ai:8443"])).toBe(false);
	});

	test("the scheme is part of the origin", () => {
		expect(originAllowed("http://claude.ai", ALLOWED)).toBe(false);
		expect(originAllowed("http://127.0.0.1:8795", ["http://127.0.0.1:8795"])).toBe(true);
		expect(originAllowed("https://127.0.0.1:8795", ["http://127.0.0.1:8795"])).toBe(false);
	});

	test("the literal string null is refused even when listed", () => {
		expect(originAllowed("null", ALLOWED)).toBe(false);
		expect(originAllowed("null", ["null"])).toBe(false);
	});

	test("a value that is not an http(s) origin is refused", () => {
		const bad = [
			"claude.ai",
			"not a url",
			"file:///etc/passwd",
			"chrome-extension://abcdef",
			"https://claude.ai/path",
			"https://claude.ai?x=1",
			"https://user@claude.ai",
		];
		for (const origin of bad) expect(originAllowed(origin, ALLOWED)).toBe(false);
	});

	test("an invalid entry in the allow list matches nothing and does not throw", () => {
		expect(originAllowed("https://claude.ai", ["", "not a url", "null"])).toBe(false);
		expect(originAllowed("https://claude.ai", ["not a url", "https://claude.ai"])).toBe(true);
	});
});

describe("resolveProtocolVersion", () => {
	test("an absent header means 2025-03-26", () => {
		expect(resolveProtocolVersion(null)).toEqual({ ok: true, version: "2025-03-26" });
	});

	test("every supported version is accepted as sent", () => {
		for (const version of SUPPORTED_PROTOCOL_VERSIONS) {
			expect(resolveProtocolVersion(version)).toEqual({ ok: true, version });
		}
	});

	test("an unsupported, empty or malformed version is refused", () => {
		for (const header of ["2024-11-05", "2026-07-28", "", "latest", " 2025-06-18", "2025-06-18 ", "2025-6-18"]) {
			expect(resolveProtocolVersion(header)).toEqual({ ok: false });
		}
	});
});
