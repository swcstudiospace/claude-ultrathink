// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { describe, expect, test } from "bun:test";
import { createMetrics, DEFAULT_BUCKETS } from "./metrics.ts";

function linesOf(text: string): string[] {
	return text.split("\n").filter((l) => l.length > 0);
}

describe("counter", () => {
	test("renders a TYPE line and accumulates per label set", () => {
		const m = createMetrics();
		m.inc("ultrathink_requests_total", { status: "200" });
		m.inc("ultrathink_requests_total", { status: "200" }, 2);
		m.inc("ultrathink_requests_total", { status: "500" });
		m.inc("ultrathink_plain_total");
		const out = linesOf(m.render());
		expect(out).toContain("# TYPE ultrathink_requests_total counter");
		expect(out).toContain('ultrathink_requests_total{status="200"} 3');
		expect(out).toContain('ultrathink_requests_total{status="500"} 1');
		expect(out).toContain("ultrathink_plain_total 1");
	});

	test("ignores negative and non-finite increments", () => {
		const m = createMetrics();
		m.inc("c_total", undefined, 2);
		m.inc("c_total", undefined, -1);
		m.inc("c_total", undefined, Number.NaN);
		m.inc("c_total", undefined, Number.POSITIVE_INFINITY);
		expect(linesOf(m.render())).toContain("c_total 2");
	});

	test("label order in the call does not create a new series", () => {
		const m = createMetrics();
		m.inc("c_total", { a: "1", b: "2" });
		m.inc("c_total", { b: "2", a: "1" });
		expect(linesOf(m.render())).toContain('c_total{a="1",b="2"} 2');
	});
});

describe("gauge", () => {
	test("keeps the last value and renders a gauge TYPE line", () => {
		const m = createMetrics();
		m.gauge("ultrathink_jobs_running", 3);
		m.gauge("ultrathink_jobs_running", 1);
		m.gauge("ultrathink_temp", -2.5, { zone: "a" });
		const out = linesOf(m.render());
		expect(out).toContain("# TYPE ultrathink_jobs_running gauge");
		expect(out).toContain("ultrathink_jobs_running 1");
		expect(out).toContain('ultrathink_temp{zone="a"} -2.5');
	});
});

describe("histogram", () => {
	test("renders cumulative buckets, +Inf, sum and count", () => {
		const m = createMetrics();
		m.observe("ultrathink_duration_seconds", 0.25, { route: "/mcp" });
		m.observe("ultrathink_duration_seconds", 0.5, { route: "/mcp" });
		m.observe("ultrathink_duration_seconds", 0.5, { route: "/mcp" });
		m.observe("ultrathink_duration_seconds", 100, { route: "/mcp" });
		const out = linesOf(m.render());
		expect(out).toContain("# TYPE ultrathink_duration_seconds histogram");
		const bucket = (le: string) => out.find((l) => l.startsWith(`ultrathink_duration_seconds_bucket{route="/mcp",le="${le}"}`));
		expect(bucket("0.1")?.endsWith(" 0")).toBe(true);
		expect(bucket("0.25")?.endsWith(" 1")).toBe(true);
		expect(bucket("0.5")?.endsWith(" 3")).toBe(true);
		expect(bucket("60")?.endsWith(" 3")).toBe(true);
		expect(bucket("+Inf")?.endsWith(" 4")).toBe(true);
		expect(out).toContain('ultrathink_duration_seconds_count{route="/mcp"} 4');
		expect(out).toContain('ultrathink_duration_seconds_sum{route="/mcp"} 101.25');
	});

	test("bucket counts never decrease and finish at the count; a value on a bound lands in that bucket", () => {
		const m = createMetrics();
		for (const v of [0.005, 0.3, 0.3, 7, 59.9, 60, 61]) m.observe("h", v);
		const out = linesOf(m.render());
		const counts = out.filter((l) => l.startsWith("h_bucket")).map((l) => Number(l.split(" ")[1]));
		expect(counts).toHaveLength(DEFAULT_BUCKETS.length + 1);
		for (let i = 1; i < counts.length; i++) expect(counts[i] ?? 0).toBeGreaterThanOrEqual(counts[i - 1] ?? 0);
		expect(counts[0]).toBe(1);
		expect(counts.at(-1)).toBe(7);
		expect(out).toContain("h_count 7");
	});

	test("without labels the le label stands alone, and a caller label named le is ignored", () => {
		const m = createMetrics();
		m.observe("h", 1);
		m.observe("g", 1, { le: "bogus", x: "y" });
		const out = linesOf(m.render());
		expect(out).toContain('h_bucket{le="1"} 1');
		expect(out).toContain('g_bucket{x="y",le="1"} 1');
		expect(out.some((l) => l.includes("bogus"))).toBe(false);
	});

	test("ignores non-finite observations", () => {
		const m = createMetrics();
		m.observe("h", Number.NaN);
		m.observe("h", Number.POSITIVE_INFINITY);
		expect(m.render()).not.toContain("h_count");
	});
});

describe("exposition", () => {
	test("escapes backslash, quote and newline in label values", () => {
		const m = createMetrics();
		m.inc("c_total", { path: 'a\\b"c\nd' });
		const line = linesOf(m.render()).find((l) => l.startsWith("c_total{"));
		expect(line).toBe('c_total{path="a\\\\b\\"c\\nd"} 1');
		expect(m.render().split("\n").filter((l) => l.startsWith("c_total{"))).toHaveLength(1);
	});

	test("orders metrics and series deterministically regardless of insertion order", () => {
		const build = (order: Array<[string, string]>) => {
			const m = createMetrics();
			for (const [name, status] of order) m.inc(name, { status });
			return m.render();
		};
		const a = build([
			["zeta_total", "b"],
			["alpha_total", "z"],
			["alpha_total", "a"],
			["zeta_total", "a"],
		]);
		const b = build([
			["alpha_total", "a"],
			["zeta_total", "a"],
			["zeta_total", "b"],
			["alpha_total", "z"],
		]);
		expect(a).toBe(b);
		const names = linesOf(a)
			.filter((l) => l.startsWith("# TYPE"))
			.map((l) => l.split(" ")[2]);
		expect(names).toEqual(["alpha_total", "zeta_total"]);
	});

	test("ends with a newline and renders empty text when nothing was recorded", () => {
		const m = createMetrics();
		expect(m.render()).toBe("");
		m.inc("c_total");
		expect(m.render().endsWith("\n")).toBe(true);
	});

	test("sanitizes invalid metric and label names", () => {
		const m = createMetrics();
		m.inc("bad name-total", { "bad-label": "v" });
		expect(linesOf(m.render())).toContain('bad_name_total{bad_label="v"} 1');
	});

	test("a metric name reused with another type is rejected and counted, not mixed", () => {
		const m = createMetrics();
		m.inc("x_total");
		m.gauge("x_total", 5);
		const out = linesOf(m.render());
		expect(out).toContain("x_total 1");
		expect(out).toContain('ultrathink_metrics_dropped_total{metric="x_total"} 1');
	});
});

describe("series cap", () => {
	test("drops series beyond the cap and counts them in ultrathink_metrics_dropped_total", () => {
		const m = createMetrics({ maxSeriesPerMetric: 3 });
		for (let i = 0; i < 10; i++) m.inc("c_total", { id: String(i) });
		const out = linesOf(m.render());
		expect(out.filter((l) => l.startsWith("c_total{"))).toHaveLength(3);
		expect(out).toContain("# TYPE ultrathink_metrics_dropped_total counter");
		expect(out).toContain('ultrathink_metrics_dropped_total{metric="c_total"} 7');
	});

	test("existing series keep updating once the cap is hit, and other metrics have their own budget", () => {
		const m = createMetrics({ maxSeriesPerMetric: 2 });
		m.inc("c_total", { id: "1" });
		m.inc("c_total", { id: "2" });
		m.inc("c_total", { id: "3" });
		m.inc("c_total", { id: "1" });
		m.inc("other_total", { id: "3" });
		const out = linesOf(m.render());
		expect(out).toContain('c_total{id="1"} 2');
		expect(out.some((l) => l.startsWith('c_total{id="3"}'))).toBe(false);
		expect(out).toContain('other_total{id="3"} 1');
	});

	test("applies to gauges and histograms and defaults to 200 series", () => {
		const m = createMetrics({ maxSeriesPerMetric: 1 });
		m.gauge("g", 1, { id: "a" });
		m.gauge("g", 2, { id: "b" });
		m.observe("h", 1, { id: "a" });
		m.observe("h", 1, { id: "b" });
		const out = linesOf(m.render());
		expect(out.filter((l) => l.startsWith("g{"))).toHaveLength(1);
		expect(out.filter((l) => l.startsWith("h_count"))).toHaveLength(1);
		expect(out).toContain('ultrathink_metrics_dropped_total{metric="g"} 1');
		expect(out).toContain('ultrathink_metrics_dropped_total{metric="h"} 1');

		const d = createMetrics();
		for (let i = 0; i < 205; i++) d.inc("c_total", { id: String(i) });
		const dout = linesOf(d.render());
		expect(dout.filter((l) => l.startsWith("c_total{"))).toHaveLength(200);
		expect(dout).toContain('ultrathink_metrics_dropped_total{metric="c_total"} 5');
	});
});
