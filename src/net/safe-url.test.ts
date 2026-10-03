// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import { checkServiceUrl } from "./safe-url.ts";

describe("checkServiceUrl", () => {
	test("accepts https and trims trailing slashes, keeping a path prefix", () => {
		expect(checkServiceUrl("https://hindsight.example.com/")).toEqual({ ok: true, url: "https://hindsight.example.com" });
		expect(checkServiceUrl(" https://h.example.com/ragflow// ")).toEqual({ ok: true, url: "https://h.example.com/ragflow" });
	});

	test("accepts plain http only on loopback, *.ts.net and the Tailscale CGNAT range", () => {
		for (const url of ["http://localhost:8888", "http://127.0.0.1:8888/", "http://[::1]:8888", "http://box.tail1234.ts.net:8888", "http://100.64.0.1", "http://100.127.255.254:80"]) {
			expect(checkServiceUrl(url).ok).toBe(true);
		}
		for (const url of ["http://example.com", "http://100.63.0.1", "http://100.128.0.1", "http://10.0.0.5", "http://hindsight.railway.internal:8888", "http://constructor", "http://toString"]) {
			expect(checkServiceUrl(url).ok).toBe(false);
		}
	});

	test("a public http URL is refused with the http-only reason", () => {
		expect(checkServiceUrl("http://example.com")).toEqual({
			ok: false,
			reason: "http is allowed only for localhost, *.ts.net and 100.64.0.0/10; use https",
		});
	});

	test("refuses credentials, query strings, fragments and other schemes", () => {
		expect(checkServiceUrl("https://user:pw@example.com")).toEqual({ ok: false, reason: "must not contain a user name or password" });
		expect(checkServiceUrl("https://user@example.com").ok).toBe(false);
		expect(checkServiceUrl("https://example.com/?token=x")).toEqual({ ok: false, reason: "must not contain a query or fragment" });
		expect(checkServiceUrl("https://example.com/#frag").ok).toBe(false);
		expect(checkServiceUrl("ftp://example.com").ok).toBe(false);
		expect(checkServiceUrl("file:///etc/passwd").ok).toBe(false);
	});

	test("refuses missing and malformed values", () => {
		expect(checkServiceUrl(undefined)).toEqual({ ok: false, reason: "not set" });
		expect(checkServiceUrl("  ")).toEqual({ ok: false, reason: "not set" });
		expect(checkServiceUrl(42)).toEqual({ ok: false, reason: "not set" });
		expect(checkServiceUrl("not a url")).toEqual({ ok: false, reason: "not a valid URL" });
	});
});
