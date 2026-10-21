// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createSpanExporter, encodeOtlpTraces, type FinishedSpan } from "./otel.ts";

const RESOURCE = { serviceName: "ultrathink", serviceVersion: "1.15.0" };
const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const PARENT_ID = "00f067aa0ba902b7";
const SPAN_ID = "1111111111111111";
const OTHER_SPAN_ID = "2222222222222222";
const START = 1_700_000_000_000_000_000n;
const END = 1_700_000_000_500_000_000n;

function span(name: string, overrides: Partial<FinishedSpan> = {}): FinishedSpan {
	return { traceId: TRACE_ID, spanId: SPAN_ID, name, kind: 3, startUnixNano: START, endUnixNano: END, attributes: {}, error: false, ...overrides };
}

interface OtlpSpan {
	traceId: string;
	spanId: string;
	parentSpanId?: string;
	name: string;
	kind: number;
	startTimeUnixNano: string;
	endTimeUnixNano: string;
	attributes: Array<{ key: string; value: Record<string, unknown> }>;
	status: { code: number };
}

interface OtlpBody {
	resourceSpans: Array<{
		resource: { attributes: Array<{ key: string; value: Record<string, unknown> }> };
		scopeSpans: Array<{ spans: OtlpSpan[] }>;
	}>;
}

interface Posted {
	path: string;
	contentType: string | null;
	body: OtlpBody;
}

/** Local OTLP collector on 127.0.0.1 with an ephemeral port. `state.status` sets the reply code. */
interface Collector {
	endpoint: string;
	posted: Posted[];
	state: { status: number };
	stop(): void;
}

function firstOf<T>(items: readonly T[]): T {
	const [first] = items;
	if (first === undefined) throw new Error("expected at least one item");
	return first;
}

function spansIn(body: OtlpBody): OtlpSpan[] {
	return body.resourceSpans.flatMap((resourceSpans) => resourceSpans.scopeSpans.flatMap((scopeSpans) => scopeSpans.spans));
}

function startCollector(): Collector {
	const posted: Posted[] = [];
	const state = { status: 200 };
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			if (request.method !== "POST" || url.pathname !== "/v1/traces") return new Response("not found", { status: 404 });
			posted.push({
				path: url.pathname,
				contentType: request.headers.get("content-type"),
				body: (await request.json()) as OtlpBody,
			});
			return new Response(null, { status: state.status });
		},
	});
	return { endpoint: `http://127.0.0.1:${server.port}`, posted, state, stop: () => server.stop(true) };
}

describe("span exporter", () => {
	let collector: Collector;

	beforeEach(() => {
		collector = startCollector();
	});

	afterEach(() => {
		collector.stop();
	});

	test("flush posts one OTLP/JSON body carrying ids and decimal times; a root span has no parentSpanId key", async () => {
		const exporter = createSpanExporter({ endpoint: collector.endpoint, ...RESOURCE });
		exporter.record(span("child", { spanId: OTHER_SPAN_ID, parentSpanId: PARENT_ID }));
		exporter.record(span("root"));
		await exporter.flush();

		expect(collector.posted.length).toBe(1);
		const post = firstOf(collector.posted);
		expect(post.path).toBe("/v1/traces");
		expect(post.contentType).toBe("application/json");
		expect(firstOf(post.body.resourceSpans).resource.attributes).toEqual([
			{ key: "service.name", value: { stringValue: "ultrathink" } },
			{ key: "service.version", value: { stringValue: "1.15.0" } },
		]);

		const spans = spansIn(post.body);
		const child = firstOf(spans);
		const root = firstOf(spans.slice(1));
		expect(child).toMatchObject({
			traceId: TRACE_ID,
			spanId: OTHER_SPAN_ID,
			parentSpanId: PARENT_ID,
			name: "child",
			kind: 3,
			startTimeUnixNano: "1700000000000000000",
			endTimeUnixNano: "1700000000500000000",
		});
		expect(root.name).toBe("root");
		expect(root.spanId).toBe(SPAN_ID);
		expect("parentSpanId" in root).toBe(false);
	});

	test("maps error to status.code 2 and a clean span to 0", () => {
		const encoded = encodeOtlpTraces([span("ok"), span("bad", { error: true })], RESOURCE) as OtlpBody;
		const spans = spansIn(encoded);
		expect(firstOf(spans).status.code).toBe(0);
		expect(firstOf(spans.slice(1)).status.code).toBe(2);
	});

	test("encodes attributes by type: string, int as decimal string, other number as double, boolean", () => {
		const encoded = encodeOtlpTraces(
			[span("attrs", { attributes: { route: "/v1/plan", retries: 3, negative: -7, huge: 1e21, cost: 0.25, cached: false } })],
			RESOURCE,
		) as OtlpBody;
		expect(firstOf(spansIn(encoded)).attributes).toEqual([
			{ key: "route", value: { stringValue: "/v1/plan" } },
			{ key: "retries", value: { intValue: "3" } },
			{ key: "negative", value: { intValue: "-7" } },
			{ key: "huge", value: { intValue: "1000000000000000000000" } },
			{ key: "cost", value: { doubleValue: 0.25 } },
			{ key: "cached", value: { boolValue: false } },
		]);
	});

	test("a full queue calls onDrop for the third span; the first two are posted", async () => {
		let drops = 0;
		const exporter = createSpanExporter({
			endpoint: collector.endpoint,
			...RESOURCE,
			maxQueue: 2,
			onDrop: () => {
				drops++;
			},
		});
		exporter.record(span("first"));
		exporter.record(span("second"));
		exporter.record(span("third"));
		expect(drops).toBe(1);

		await exporter.flush();
		expect(collector.posted.length).toBe(1);
		expect(spansIn(firstOf(collector.posted).body).map((s) => s.name)).toEqual(["first", "second"]);
	});

	test("a throwing onDrop does not escape record", () => {
		const exporter = createSpanExporter({
			endpoint: collector.endpoint,
			...RESOURCE,
			maxQueue: 1,
			onDrop: () => {
				throw new Error("observer bug");
			},
		});
		exporter.record(span("kept"));
		expect(() => exporter.record(span("dropped"))).not.toThrow();
	});

	test("posts at most maxBatch spans per request", async () => {
		const exporter = createSpanExporter({ endpoint: collector.endpoint, ...RESOURCE, maxBatch: 2 });
		for (const name of ["a", "b", "c", "d", "e"]) exporter.record(span(name));
		await exporter.flush();

		expect(collector.posted.map((post) => spansIn(post.body).length)).toEqual([2, 2, 1]);
		expect(collector.posted.flatMap((post) => spansIn(post.body).map((s) => s.name))).toEqual(["a", "b", "c", "d", "e"]);
	});

	test("a fetch that throws calls onFailure once, flush resolves, and the batch is never re-sent", async () => {
		let attempts = 0;
		let failures = 0;
		const exporter = createSpanExporter({
			endpoint: collector.endpoint,
			...RESOURCE,
			fetch: async () => {
				attempts++;
				throw new Error("connection refused");
			},
			onFailure: () => {
				failures++;
			},
		});
		exporter.record(span("lost"));
		await exporter.flush();
		expect(failures).toBe(1);

		await exporter.flush();
		expect(attempts).toBe(1);
		expect(failures).toBe(1);
	});

	test("a collector reply of 503 calls onFailure once, flush resolves, and the next flush posts nothing", async () => {
		let failures = 0;
		collector.state.status = 503;
		const exporter = createSpanExporter({
			endpoint: collector.endpoint,
			...RESOURCE,
			onFailure: () => {
				failures++;
			},
		});
		exporter.record(span("rejected"));
		await exporter.flush();
		expect(failures).toBe(1);
		expect(collector.posted.length).toBe(1);

		await exporter.flush();
		expect(collector.posted.length).toBe(1);
		expect(failures).toBe(1);
	});

	test("a failed batch does not stop later batches from being sent", async () => {
		let calls = 0;
		const sent: string[] = [];
		let failures = 0;
		const exporter = createSpanExporter({
			endpoint: collector.endpoint,
			...RESOURCE,
			maxBatch: 1,
			fetch: async (_url, init) => {
				calls++;
				if (calls === 1) throw new Error("first batch lost");
				sent.push(...spansIn(JSON.parse(init.body) as OtlpBody).map((s) => s.name));
				return { ok: true, status: 200 };
			},
			onFailure: () => {
				failures++;
			},
		});
		exporter.record(span("lost"));
		exporter.record(span("kept"));
		await exporter.flush();

		expect(failures).toBe(1);
		expect(sent).toEqual(["kept"]);
	});

	test("concurrent flush calls share one in-flight promise and produce exactly one POST", async () => {
		const exporter = createSpanExporter({ endpoint: collector.endpoint, ...RESOURCE });
		exporter.record(span("only"));
		const first = exporter.flush();
		const second = exporter.flush();
		expect(second).toBe(first);
		await Promise.all([first, second]);
		expect(collector.posted.length).toBe(1);
	});

	test("shutdown posts the queued spans; a record after shutdown causes no POST", async () => {
		const exporter = createSpanExporter({ endpoint: collector.endpoint, ...RESOURCE });
		exporter.record(span("queued"));
		await exporter.shutdown();
		expect(collector.posted.length).toBe(1);
		expect(spansIn(firstOf(collector.posted).body).map((s) => s.name)).toEqual(["queued"]);

		exporter.record(span("late"));
		await exporter.flush();
		expect(collector.posted.length).toBe(1);
	});

	test("rejects a non-positive maxBatch at construction", () => {
		expect(() => createSpanExporter({ endpoint: collector.endpoint, ...RESOURCE, maxBatch: 0 })).toThrow(RangeError);
	});
});
