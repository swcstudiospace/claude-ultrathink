// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { type HttpFetch, type HttpRequestInit, httpTarget, parsePrometheusValue } from "./observe.ts";

const METRICS = [
	"# HELP ultrathink_planner_calls_total Planner calls",
	"# TYPE ultrathink_planner_calls_total counter",
	'ultrathink_planner_calls_total{outcome="ok"} 4',
	'ultrathink_planner_calls_total{outcome="timeout"} 2',
	'ultrathink_upstream_breaker_state{state="open"} 1',
	"ultrathink_overload_total 7",
	'ultrathink_path{path="/a b}c",note="say \\"hi\\""} 3',
	"",
].join("\n");

describe("parsePrometheusValue", () => {
	test("matches the exact label set", () => {
		expect(parsePrometheusValue(METRICS, "ultrathink_planner_calls_total", { outcome: "timeout" })).toBe(2);
		expect(parsePrometheusValue(METRICS, "ultrathink_planner_calls_total", { outcome: "ok" })).toBe(4);
	});

	test("does not match a subset or superset of the labels", () => {
		expect(parsePrometheusValue(METRICS, "ultrathink_planner_calls_total")).toBeUndefined();
		expect(parsePrometheusValue(METRICS, "ultrathink_planner_calls_total", { outcome: "timeout", extra: "x" })).toBeUndefined();
		expect(parsePrometheusValue(METRICS, "ultrathink_upstream_breaker_state")).toBeUndefined();
	});

	test("reads an unlabelled series when no labels are asked for", () => {
		expect(parsePrometheusValue(METRICS, "ultrathink_overload_total")).toBe(7);
	});

	test("ignores comment lines and does not match on a name prefix", () => {
		const text = "# ultrathink_overload_total 99\nultrathink_overload_total_extra 9\nultrathink_overload_total 7";
		expect(parsePrometheusValue(text, "ultrathink_overload_total")).toBe(7);
		expect(parsePrometheusValue("# ultrathink_overload_total 99", "ultrathink_overload_total")).toBeUndefined();
	});

	test("an absent series is undefined, never zero", () => {
		expect(parsePrometheusValue(METRICS, "ultrathink_missing_total")).toBeUndefined();
	});

	test("parses label values containing braces, spaces and escaped quotes", () => {
		expect(parsePrometheusValue(METRICS, "ultrathink_path", { path: "/a b}c", note: 'say "hi"' })).toBe(3);
	});

	test("skips malformed sample lines instead of guessing", () => {
		expect(parsePrometheusValue('ultrathink_overload_total{outcome="x" 5', "ultrathink_overload_total", { outcome: "x" })).toBeUndefined();
		expect(parsePrometheusValue("ultrathink_overload_total not-a-number", "ultrathink_overload_total")).toBeUndefined();
	});
});

describe("httpTarget", () => {
	test("rejects any scheme other than http and https", () => {
		expect(() => httpTarget("file:///etc/passwd")).toThrow(TypeError);
		expect(() => httpTarget("ftp://127.0.0.1:9")).toThrow(TypeError);
	});

	test("joins request paths onto the base URL, keeping its path prefix", async () => {
		const calls: Array<{ url: string; init: RequestInit }> = [];
		const fake: HttpFetch = async (url, init) => {
			calls.push({ url, init });
			return new Response("ok", { status: 201 });
		};
		const target = httpTarget("http://127.0.0.1:9/prefix", { fetch: fake });
		const response = await target.request("POST", "/x", { a: 1 });
		expect(response.status).toBe(201);
		expect(response.text).toBe("ok");
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe("http://127.0.0.1:9/prefix/x");
		expect(calls[0]?.init.method).toBe("POST");
		expect(calls[0]?.init.body).toBe('{"a":1}');
	});

	test("hands the CA and client identity to fetch as the only TLS options", async () => {
		const seen: HttpRequestInit[] = [];
		const fake: HttpFetch = async (_url, init) => {
			seen.push(init);
			return new Response("ok");
		};
		const target = httpTarget("https://127.0.0.1:9", { fetch: fake, tls: { ca: "CA-PEM", cert: "CERT-PEM", key: "KEY-PEM" } });
		await target.request("GET", "/readyz");
		expect(seen[0]?.tls).toEqual({ ca: "CA-PEM", cert: "CERT-PEM", key: "KEY-PEM" });
	});

	test("a response that never arrives fails at the request deadline", async () => {
		const stalled: HttpFetch = () => new Promise<Response>(() => {});
		const target = httpTarget("http://127.0.0.1:9", { fetch: stalled, timeoutMs: 30 });
		await expect(target.request("GET", "/readyz")).rejects.toThrow("GET /readyz got no complete response within 30 ms");
	});

	test("a body that never finishes fails at the same deadline", async () => {
		const stalledBody: HttpFetch = async () => new Response(new ReadableStream({ start() {} }));
		const target = httpTarget("http://127.0.0.1:9", { fetch: stalledBody, timeoutMs: 30 });
		await expect(target.request("GET", "/metrics")).rejects.toThrow("GET /metrics got no complete response within 30 ms");
	});

	test("close resolves without a request", async () => {
		const target = httpTarget("http://127.0.0.1:9", { fetch: async () => new Response("") });
		await expect(target.close()).resolves.toBeUndefined();
	});

	describe("against a live server that stalls", () => {
		let stalled: Server<undefined> | undefined;
		beforeAll(() => {
			stalled = Bun.serve({
				port: 0,
				hostname: "127.0.0.1",
				fetch(req) {
					if (new URL(req.url).pathname === "/headers") return new Promise<Response>(() => {});
					return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("partial")); } }));
				},
			});
		});
		afterAll(() => {
			stalled?.stop(true);
		});

		test("a stalled header or body fails the request at the deadline", async () => {
			const target = httpTarget(`http://127.0.0.1:${stalled?.port}`, { timeoutMs: 200 });
			const started = Date.now();
			await expect(target.request("GET", "/headers")).rejects.toThrow("no complete response within 200 ms");
			await expect(target.request("GET", "/body")).rejects.toThrow("no complete response within 200 ms");
			expect(Date.now() - started).toBeLessThan(5000);
		});
	});

	describe("against an mTLS listener", () => {
		const SERVER_EXT = "subjectAltName=IP:127.0.0.1\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature\nextendedKeyUsage=serverAuth\n";
		const CLIENT_EXT = "basicConstraints=CA:FALSE\nkeyUsage=digitalSignature\nextendedKeyUsage=clientAuth\n";
		let dir = "";
		let ca = "";
		let server = { cert: "", key: "" };
		let probe = { cert: "", key: "" };
		let intruder = { cert: "", key: "" };
		let listener: Server<undefined> | undefined;

		beforeAll(() => {
			dir = mkdtempSync(join(tmpdir(), "chaos-observe-"));
			ca = makeCa(dir, "ca");
			makeCa(dir, "foreign-ca");
			server = issueLeaf(dir, "server", "ca", SERVER_EXT);
			probe = issueLeaf(dir, "probe", "ca", CLIENT_EXT);
			intruder = issueLeaf(dir, "intruder", "foreign-ca", CLIENT_EXT);
			listener = Bun.serve({
				port: 0,
				hostname: "127.0.0.1",
				tls: { cert: server.cert, key: server.key, ca, requestCert: true, rejectUnauthorized: true },
				fetch: () => new Response("ready"),
			});
		});
		afterAll(() => {
			listener?.stop(true);
			rmSync(dir, { recursive: true, force: true });
		});

		test("a probe presenting the CA-signed identity reads the readiness endpoint", async () => {
			const target = httpTarget(`https://127.0.0.1:${listener?.port}`, { tls: { ca, cert: probe.cert, key: probe.key } });
			const response = await target.request("GET", "/readyz");
			expect(response.status).toBe(200);
			expect(response.text).toBe("ready");
		});

		test("a probe with no client identity is refused at the handshake", async () => {
			const target = httpTarget(`https://127.0.0.1:${listener?.port}`, { tls: { ca } });
			await expect(target.request("GET", "/readyz")).rejects.toThrow();
		});

		test("a client certificate from another CA is refused", async () => {
			const target = httpTarget(`https://127.0.0.1:${listener?.port}`, { tls: { ca, cert: intruder.cert, key: intruder.key } });
			await expect(target.request("GET", "/readyz")).rejects.toThrow();
		});

		test("a probe that does not pin the CA refuses the server certificate", async () => {
			const target = httpTarget(`https://127.0.0.1:${listener?.port}`, { tls: { cert: probe.cert, key: probe.key } });
			await expect(target.request("GET", "/readyz")).rejects.toThrow();
		});
	});
});

function openssl(dir: string, args: string[]): void {
	execFileSync("openssl", args, { cwd: dir, stdio: "pipe" });
}

function makeCa(dir: string, name: string): string {
	openssl(dir, ["req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", `${name}.key`, "-out", `${name}.pem`, "-days", "2", "-subj", `/CN=${name}`, "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign"]);
	return readFileSync(join(dir, `${name}.pem`), "utf8");
}

function issueLeaf(dir: string, name: string, signer: string, extensions: string): { cert: string; key: string } {
	writeFileSync(join(dir, `${name}.ext`), extensions);
	openssl(dir, ["req", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:P-256", "-nodes", "-keyout", `${name}.key`, "-out", `${name}.csr`, "-subj", `/CN=${name}`]);
	openssl(dir, ["x509", "-req", "-in", `${name}.csr`, "-CA", `${signer}.pem`, "-CAkey", `${signer}.key`, "-CAcreateserial", "-out", `${name}.pem`, "-days", "2", "-extfile", `${name}.ext`]);
	return { cert: readFileSync(join(dir, `${name}.pem`), "utf8"), key: readFileSync(join(dir, `${name}.key`), "utf8") };
}
