// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import { buildSecurityHeaders, createSecurityHeadersMiddleware, generateNonce, createCspWithNonce, ULTRATHINK_SECURITY_HEADERS } from "./headers.ts";

describe("Security Headers", () => {
	describe("buildSecurityHeaders", () => {
		test("builds default headers", () => {
			const headers = buildSecurityHeaders();
			expect(headers["Strict-Transport-Security"]).toContain("max-age=31536000");
			expect(headers["Strict-Transport-Security"]).toContain("includeSubDomains");
			expect(headers["Strict-Transport-Security"]).toContain("preload");
			expect(headers["Content-Security-Policy"]).toContain("default-src 'self'");
			expect(headers["X-Frame-Options"]).toBe("DENY");
			expect(headers["X-Content-Type-Options"]).toBe("nosniff");
			expect(headers["Referrer-Policy"]).toBe("strict-origin-when-cross-origin");
			expect(headers["Permissions-Policy"]).toContain("camera=()");
			expect(headers["Cross-Origin-Opener-Policy"]).toBe("same-origin");
			expect(headers["Cross-Origin-Resource-Policy"]).toBe("same-origin");
			expect(headers["Cross-Origin-Embedder-Policy"]).toBe("require-corp");
		});

		test("builds headers with custom config", () => {
			const headers = buildSecurityHeaders({
				hsts: false,
				csp: "default-src 'none'",
				cspReportOnly: false,
				frameOptions: "SAMEORIGIN",
				referrerPolicy: "no-referrer",
			});
			expect(headers["Strict-Transport-Security"]).toBeUndefined();
			expect(headers["Content-Security-Policy"]).toBe("default-src 'none'");
			expect(headers["X-Frame-Options"]).toBe("SAMEORIGIN");
			expect(headers["Referrer-Policy"]).toBe("no-referrer");
		});

		test("includes custom headers", () => {
			const headers = buildSecurityHeaders({
				custom: { "X-Custom-Header": "custom-value" },
			});
			expect(headers["X-Custom-Header"]).toBe("custom-value");
		});

		test("uses enforce mode when reportOnly is false", () => {
			const headers = buildSecurityHeaders({
				csp: "default-src 'self'",
				cspReportOnly: false,
			});
			expect(headers["Content-Security-Policy"]).toBe("default-src 'self'");
			expect(headers["Content-Security-Policy-Report-Only"]).toBeUndefined();
		});

		test("includes report-uri when provided", () => {
			const headers = buildSecurityHeaders({
				csp: "default-src 'self'",
				cspReportUri: "/csp-report",
			});
			expect(headers["Content-Security-Policy"]).toContain("report-uri /csp-report");
		});
	});

	describe("createSecurityHeadersMiddleware", () => {
		test("returns headers object", () => {
			const middleware = createSecurityHeadersMiddleware({ hsts: true });
			const result = middleware({});
			expect(result["Strict-Transport-Security"]).toContain("max-age=31536000");
		});

		test("preserves non-security headers", () => {
			const middleware = createSecurityHeadersMiddleware({});
			const result = middleware({ "X-Custom": "value" });
			expect(result["X-Custom"]).toBe("value");
		});

		test("security headers take precedence", () => {
			const middleware = createSecurityHeadersMiddleware({});
			const result = middleware({ "X-Frame-Options": "ALLOWALL" });
			expect(result["X-Frame-Options"]).toBe("DENY");
		});
	});

	describe("generateNonce", () => {
		test("generates 32 character hex string", () => {
			const nonce = generateNonce();
			expect(nonce).toMatch(/^[0-9a-f]{32}$/);
		});

		test("generates unique nonces", () => {
			const nonce1 = generateNonce();
			const nonce2 = generateNonce();
			expect(nonce1).not.toBe(nonce2);
		});
	});

	describe("createCspWithNonce", () => {
		test("replaces unsafe-inline with nonce", () => {
			const csp = "script-src 'self' 'unsafe-inline'";
			const nonce = "abcdef123456";
			const result = createCspWithNonce(csp, nonce);
			expect(result).toContain(`'nonce-${nonce}'`);
			expect(result).not.toContain("'unsafe-inline'");
		});
	});

	describe("ULTRATHINK_SECURITY_HEADERS", () => {
		test("has correct default configuration", () => {
			expect(ULTRATHINK_SECURITY_HEADERS.hsts).toBe(true);
			expect(ULTRATHINK_SECURITY_HEADERS.cspReportOnly).toBe(true);
			expect(ULTRATHINK_SECURITY_HEADERS.frameOptions).toBe("DENY");
		});
	});
});