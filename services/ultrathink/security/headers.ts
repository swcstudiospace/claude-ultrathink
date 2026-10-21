// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Security Headers Middleware
 * Provides comprehensive security headers for HTTP responses
 */

export interface SecurityHeadersConfig {
	/** Enable HSTS (HTTP Strict Transport Security) */
	hsts?: boolean;
	/** HSTS max-age in seconds */
	hstsMaxAge?: number;
	/** Include subdomains in HSTS */
	hstsIncludeSubdomains?: boolean;
	/** HSTS preload directive */
	hstsPreload?: boolean;
	/** Content Security Policy */
	csp?: string;
	/** CSP report-only mode */
	cspReportOnly?: boolean;
	/** CSP report URI */
	cspReportUri?: string;
	/** X-Frame-Options value */
	frameOptions?: 'DENY' | 'SAMEORIGIN' | string;
	/** X-Content-Type-Options */
	contentTypeOptions?: boolean;
	/** Referrer-Policy */
	referrerPolicy?: string;
	/** Permissions-Policy */
	permissionsPolicy?: string;
	/** Cross-Origin-Opener-Policy */
	coop?: string;
	/** Cross-Origin-Resource-Policy */
	corp?: string;
	/** Cross-Origin-Embedder-Policy */
	coep?: string;
	/** Custom headers */
	custom?: Record<string, string>;
}

const DEFAULT_CONFIG: Required<SecurityHeadersConfig> = {
	hsts: true,
	hstsMaxAge: 31536000, // 1 year
	hstsIncludeSubdomains: true,
	hstsPreload: true,
	csp: "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
	cspReportOnly: false,
	cspReportUri: '',
	frameOptions: 'DENY',
	contentTypeOptions: true,
	referrerPolicy: 'strict-origin-when-cross-origin',
	permissionsPolicy: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
	coop: 'same-origin',
	corp: 'same-origin',
	coep: 'require-corp',
	custom: {},
};

/**
 * Builds security headers from configuration
 */
export function buildSecurityHeaders(config: SecurityHeadersConfig = {}): Record<string, string> {
	const cfg = { ...DEFAULT_CONFIG, ...config };
	const headers: Record<string, string> = {};

	// HSTS
	if (cfg.hsts) {
		let hsts = `max-age=${cfg.hstsMaxAge}`;
		if (cfg.hstsIncludeSubdomains) hsts += '; includeSubDomains';
		if (cfg.hstsPreload) hsts += '; preload';
		headers['Strict-Transport-Security'] = hsts;
	}

	// CSP
	const cspHeader = cfg.cspReportOnly ? 'Content-Security-Policy-Report-Only' : 'Content-Security-Policy';
	let csp = cfg.csp;
	if (cfg.cspReportUri) {
		csp += `; report-uri ${cfg.cspReportUri}`;
	}
	headers[cspHeader] = csp;

	// X-Frame-Options
	if (cfg.frameOptions) {
		headers['X-Frame-Options'] = cfg.frameOptions;
	}

	// X-Content-Type-Options
	if (cfg.contentTypeOptions) {
		headers['X-Content-Type-Options'] = 'nosniff';
	}

	// Referrer-Policy
	if (cfg.referrerPolicy) {
		headers['Referrer-Policy'] = cfg.referrerPolicy;
	}

	// Permissions-Policy
	if (cfg.permissionsPolicy) {
		headers['Permissions-Policy'] = cfg.permissionsPolicy;
	}

	// Cross-Origin policies
	if (cfg.coop) {
		headers['Cross-Origin-Opener-Policy'] = cfg.coop;
	}
	if (cfg.corp) {
		headers['Cross-Origin-Resource-Policy'] = cfg.corp;
	}
	if (cfg.coep) {
		headers['Cross-Origin-Embedder-Policy'] = cfg.coep;
	}

	// Custom headers
	for (const [key, value] of Object.entries(cfg.custom)) {
		headers[key] = value;
	}

	return headers;
}

/**
 * Creates a security headers middleware function
 */
export function createSecurityHeadersMiddleware(config: SecurityHeadersConfig = {}) {
	const headers = buildSecurityHeaders(config);

	return function securityHeadersMiddleware(
		_headers: Record<string, string> = {}
	): Record<string, string> {
		// Merge with existing headers, security headers take precedence for security headers
		const result = { ...headers };
		for (const [key, value] of Object.entries(_headers)) {
			// Don't override security headers with non-security headers
			const isSecurityHeader = [
				'strict-transport-security',
				'content-security-policy',
				'content-security-policy-report-only',
				'x-frame-options',
				'x-content-type-options',
				'referrer-policy',
				'permissions-policy',
				'cross-origin-opener-policy',
				'cross-origin-resource-policy',
				'cross-origin-embedder-policy',
			].includes(key.toLowerCase());

			if (!isSecurityHeader) {
				result[key] = value;
			}
		}
		return result;
	};
}

/**
 * Creates CSP with nonce for inline scripts
 */
export function createCspWithNonce(baseCsp: string, nonce: string): string {
	return baseCsp.replace("'unsafe-inline'", `'nonce-${nonce}'`);
}

/**
 * Generates a secure random nonce
 */
export function generateNonce(): string {
	const array = new Uint8Array(16);
	crypto.getRandomValues(array);
	return Array.from(array, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Default security headers configuration for the ultrathink service
 */
export const ULTRATHINK_SECURITY_HEADERS: SecurityHeadersConfig = {
	hsts: true,
	hstsMaxAge: 31536000,
	hstsIncludeSubdomains: true,
	hstsPreload: true,
	csp: "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'",
	cspReportOnly: true, // Start in report-only mode
	cspReportUri: '/csp-report',
	frameOptions: 'DENY',
	contentTypeOptions: true,
	referrerPolicy: 'strict-origin-when-cross-origin',
	permissionsPolicy: 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
	coop: 'same-origin',
	corp: 'same-origin',
	coep: 'require-corp',
};

export default {
	buildSecurityHeaders,
	createSecurityHeadersMiddleware,
	createCspWithNonce,
	generateNonce,
	ULTRATHINK_SECURITY_HEADERS,
};