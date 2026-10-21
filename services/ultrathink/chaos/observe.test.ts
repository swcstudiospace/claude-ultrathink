// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { describe, expect, test } from "bun:test";
import { type HttpFetch, httpTarget, parsePrometheusValue } from "./observe.ts";

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
		const target = httpTarget("http://127.0.0.1:9/prefix", fake);
		const response = await target.request("POST", "/x", { a: 1 });
		expect(response.status).toBe(201);
		expect(response.text).toBe("ok");
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe("http://127.0.0.1:9/prefix/x");
		expect(calls[0]?.init.method).toBe("POST");
		expect(calls[0]?.init.body).toBe('{"a":1}');
	});

	test("close resolves without a request", async () => {
		const target = httpTarget("http://127.0.0.1:9", async () => new Response(""));
		await expect(target.close()).resolves.toBeUndefined();
	});
});
