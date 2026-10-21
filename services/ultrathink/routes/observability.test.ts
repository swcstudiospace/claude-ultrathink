// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { afterAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAuth } from "../auth/auth.ts";
import type { UltrathinkConfig } from "../config/config.ts";
import type { OpenRouterFetch } from "../engine/openrouter.ts";
import { createLogger } from "../obs/log.ts";
import type { FinishedSpan, SpanSink } from "../obs/otel.ts";
import type { RuntimeSample } from "../obs/runtime.ts";
import { type Store, openStore } from "../store/store.ts";
import { type App, type RouterDeps, createApp } from "./router.ts";

const ORIGIN = "https://ultrathink.test";
const PEER = "127.0.0.1";
const CONNECTOR_KEY = randomBytes(24).toString("hex");
const OWNER_HASH = await Bun.password.hash(randomBytes(24).toString("base64url"));
const SESSION_SECRET = randomBytes(32).toString("hex");
const FAKE_KEY = "sk-or-fake-key-0123456789abcdef";
const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const PARENT_SPAN = "00f067aa0ba902b7";
const PROMPT = "Build a small TypeScript CLI that converts CSV files to JSON.";
/** Backoff waits are below this; the plan and model timeouts are above it and so never resolve here. */
const BACKOFF_CEILING_MS = 2000;

type LogLine = Record<string, unknown>;

const dirs: string[] = [];
const stores: Store[] = [];

afterAll(() => {
	for (const store of stores.splice(0)) {
		try {
			store.close();
		} catch {
			// already closed
		}
	}
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Harness {
	app: App;
	logs: LogLine[];
}

function harness(configOverrides: Partial<UltrathinkConfig> = {}, deps: Partial<RouterDeps> = {}): Harness {
	const dir = mkdtempSync(join(tmpdir(), "ultrathink-obs-"));
	dirs.push(dir);
	const config: UltrathinkConfig = {
		publicOrigin: ORIGIN,
		ownerPasswordHash: OWNER_HASH,
		sessionSecret: SESSION_SECRET,
		stateDir: dir,
		dbPath: join(dir, "ultrathink.db"),
		port: 0,
		maxInputChars: 8000,
		maxAnswerChars: 20000,
		maxBodyBytes: 65536,
		runTokenCeiling: 5_000_000,
		dailyTokenCeiling: 50_000_000,
		planningModel: undefined,
		connectorKey: CONNECTOR_KEY,
		allowedOrigins: [],
		oauthRedirectOrigins: [],
		openRouterApiKey: undefined,
		openRouterBaseUrl: "https://openrouter.test/api/v1",
		serverPlanning: false,
		maxConcurrentPlans: 2,
		modelTimeoutMs: 5000,
		planTimeoutMs: 60_000,
		modelMaxOutputTokens: 1000,
		sessionSecretPrevious: [],
		breakerFailures: 5,
		breakerWindowMs: 60000,
		breakerOpenMs: 30000,
		maxInflight: 256,
		drainMs: 5000,
		retentionDays: 30,
		auditLog: true,
		auditAnchorEvery: 1000,
		auditSegmentBytes: 67108864,
		auditRetentionDays: 365,
		auditWatchMs: 1000,
		auditSinkQueue: 10000,
		priorityReservePct: 25,
		adaptiveQuotaMinPct: 50,
		lagTargetMs: 100,
		replicaCapacityRps: 20,
		abuseFailuresPerMinute: 20,
		penaltyBaseSec: 60,
		penaltyMaxSec: 3600,
		tls: undefined,
		spiffeTrustDomain: "ultrathink.internal",
		plaintextLoopback: true,
		chaosEnabled: false,
		...configOverrides,
	};
	const store = openStore(config.dbPath);
	stores.push(store);
	const auth = createAuth({ ownerPasswordHash: OWNER_HASH, sessionSecret: SESSION_SECRET, cookieSecure: true });
	const logs: LogLine[] = [];
	const logger = createLogger({ write: (line) => logs.push(JSON.parse(line) as LogLine) });
	const app = createApp({ config, store, auth, logger, ...deps });
	return { app, logs };
}

/** A sink that keeps what it is given and counts its flushes and shutdowns. */
interface RecordingSink extends SpanSink {
	recorded: FinishedSpan[];
	flushes: number;
	shutdowns: number;
}

function recordingSink(): RecordingSink {
	const sink: RecordingSink = {
		recorded: [],
		flushes: 0,
		shutdowns: 0,
		record(span) {
			sink.recorded.push(span);
		},
		async flush() {
			sink.flushes += 1;
		},
		async shutdown() {
			sink.shutdowns += 1;
		},
	};
	return sink;
}

/** Retry backoff resolves at once. Anything longer (the plan and model timeouts) waits for its abort, so no timer fires. */
function instantBackoff(ms: number, signal?: AbortSignal): Promise<void> {
	if (ms < BACKOFF_CEILING_MS) return Promise.resolve();
	const { promise, resolve } = Promise.withResolvers<void>();
	if (signal?.aborted) resolve();
	else signal?.addEventListener("abort", () => resolve(), { once: true });
	return promise;
}

function runtime(eventLoopLagMs: number): RuntimeSample {
	return { eventLoopLagMs, rssBytes: 150_000_000, heapUsedBytes: 60_000_000, uptimeSec: 10 };
}

/** The value of one metric sample, matched on the given labels; undefined when there is none. */
function sample(h: Harness, name: string, labels: Record<string, string> = {}): number | undefined {
	const wanted = Object.entries(labels);
	for (const line of h.app.metrics.render().split("\n")) {
		if (!line.startsWith(name)) continue;
		const rest = line.slice(name.length);
		const labeled = rest.startsWith("{");
		// A longer metric name that merely starts with this one is not a sample of it.
		if (!labeled && !rest.startsWith(" ")) continue;
		if (labeled && wanted.length === 0) continue;
		if (!wanted.every(([key, value]) => rest.includes(`${key}="${value}"`))) continue;
		return Number(line.slice(line.lastIndexOf(" ") + 1));
	}
	return undefined;
}

function logsOf(h: Harness, event: string): LogLine[] {
	return h.logs.filter((line) => line.event === event);
}

describe("request spans and correlation", () => {
	test("a sampled inbound traceparent is continued: the response shares the trace, echoes no tracestate, and the SERVER span links to the response parent-id", async () => {
		const sink = recordingSink();
		const h = harness({}, { spans: sink });
		const response = await h.app.handle(
			new Request(`${ORIGIN}/healthz`, { headers: { traceparent: `00-${TRACE_ID}-${PARENT_SPAN}-01`, tracestate: "vendor=x" } }),
			PEER,
		);
		const echoed = response.headers.get("traceparent") ?? "";
		expect(echoed).toMatch(new RegExp(`^00-${TRACE_ID}-[0-9a-f]{16}-01$`));
		expect(response.headers.get("tracestate")).toBeNull();

		expect(sink.recorded).toHaveLength(1);
		expect(sink.recorded[0]).toMatchObject({
			traceId: TRACE_ID,
			parentSpanId: PARENT_SPAN,
			spanId: echoed.split("-")[2],
			name: "GET healthz",
			kind: 2,
			error: false,
			attributes: { "http.request.method": "GET", "http.response.status_code": 200, "ultrathink.endpoint": "healthz" },
		});
	});

	test("the request log line carries the reqId, traceId and spanId that the response headers carry", async () => {
		const h = harness();
		const response = await h.app.handle(new Request(`${ORIGIN}/healthz`, { headers: { traceparent: `00-${TRACE_ID}-${PARENT_SPAN}-01` } }), PEER);
		const reqId = response.headers.get("x-request-id");
		const line = logsOf(h, "request").find((entry) => entry.reqId === reqId);
		expect(line).toBeDefined();
		expect(line).toMatchObject({ traceId: TRACE_ID, spanId: response.headers.get("traceparent")?.split("-")[2], status: 200 });
	});

	test("an unsampled inbound traceparent records no span and answers with flags 00", async () => {
		const sink = recordingSink();
		const h = harness({}, { spans: sink });
		const response = await h.app.handle(new Request(`${ORIGIN}/healthz`, { headers: { traceparent: `00-${TRACE_ID}-${PARENT_SPAN}-00` } }), PEER);
		expect(response.headers.get("traceparent")).toMatch(new RegExp(`^00-${TRACE_ID}-[0-9a-f]{16}-00$`));
		expect(sink.recorded).toHaveLength(0);
	});

	test("no span attribute or name carries the bearer token or the peer IP", async () => {
		const sink = recordingSink();
		const h = harness({}, { spans: sink });
		const token = `bt_${randomBytes(16).toString("hex")}`;
		const peerIp = "203.0.113.77";
		const response = await h.app.handle(new Request(`${ORIGIN}/ultrathink`, { headers: { Authorization: `Bearer ${token}` } }), peerIp);
		expect(response.status).toBe(401);

		expect(sink.recorded).toHaveLength(1);
		// Span times are bigints, which JSON cannot encode; they are written out as decimal strings for the search.
		const exported = JSON.stringify(sink.recorded, (_key, value: unknown) => (typeof value === "bigint" ? value.toString() : value));
		expect(exported).not.toContain(token);
		expect(exported).not.toContain(peerIp);
	});
});

describe("runtime-fed signals", () => {
	test("upstream failures past breakerFailures are counted as one closed-to-open transition on /metrics", async () => {
		const failing: OpenRouterFetch = async () => new Response("upstream down", { status: 500 });
		const h = harness(
			{ serverPlanning: true, planningModel: "x-ai/grok-test", openRouterApiKey: FAKE_KEY, breakerFailures: 3 },
			{ fetch: failing, sleep: instantBackoff },
		);
		await h.app.handle(
			new Request(`${ORIGIN}/mcp`, {
				method: "POST",
				headers: { "Content-Type": "application/json", "x-connector-key": CONNECTOR_KEY },
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method: "tools/call",
					params: { name: "ultrathink_uplift", arguments: { prompt: PROMPT, sessionId: crypto.randomUUID() } },
				}),
			}),
			PEER,
		);

		const scrape = await h.app.handle(new Request(`${ORIGIN}/metrics`), PEER);
		expect(scrape.status).toBe(200);
		expect(sample(h, "ultrathink_upstream_breaker_transitions_total", { from: "closed", to: "open" })).toBe(1);
		expect(sample(h, "ultrathink_upstream_breaker_state", { state: "open" })).toBe(1);
		await h.app.shutdown();
	});

	test("observeRuntime feeds the signal detectors: a sustained 3x event-loop-lag step activates it once and logs it once", () => {
		const h = harness();
		for (let i = 0; i < 40; i += 1) h.app.observeRuntime(runtime(10));
		expect(sample(h, "ultrathink_anomaly_active", { signal: "event_loop_lag" })).toBe(0);

		for (let i = 0; i < 5; i += 1) h.app.observeRuntime(runtime(30));
		expect(sample(h, "ultrathink_anomaly_active", { signal: "event_loop_lag" })).toBe(1);
		expect(sample(h, "ultrathink_anomaly_transitions_total", { signal: "event_loop_lag", to: "raised" })).toBe(1);

		const lines = logsOf(h, "anomaly");
		expect(lines).toHaveLength(1);
		expect(lines[0]).toMatchObject({ level: "warn", signal: "event_loop_lag", to: "raised" });
	});

	test("observeRuntime publishes SLO budget and burn-rate gauges from the request counters", async () => {
		let now = Date.UTC(2026, 9, 21, 12);
		const h = harness({}, { now: () => now });
		await h.app.handle(new Request(`${ORIGIN}/healthz`), PEER);
		await h.app.handle(new Request(`${ORIGIN}/healthz`), PEER);
		h.app.beginDrain();
		expect((await h.app.handle(new Request(`${ORIGIN}/readyz`), PEER)).status).toBe(503);

		h.app.observeRuntime(runtime(10));
		now += 5000;
		h.app.observeRuntime(runtime(10));

		// Three requests so far, one of them 5xx: the bad share is 1/3 against a 1 % allowance.
		const badShare = 1 / 3;
		expect(sample(h, "ultrathink_slo_error_budget_remaining_ratio", { slo: "http_availability" })).toBeCloseTo(1 - badShare / 0.01, 4);
		expect(sample(h, "ultrathink_slo_burn_rate", { slo: "http_availability", window: "5m" })).toBeCloseTo(badShare / 0.01, 4);
		expect(sample(h, "ultrathink_slo_observed_seconds", { slo: "http_availability" })).toBeDefined();
	});
});

describe("retention sweep, planner correlation and shutdown", () => {
	test("runSweepNow times one sweep on an empty state directory", () => {
		const h = harness();
		h.app.runSweepNow();
		expect(sample(h, "ultrathink_retention_sweep_duration_seconds_count")).toBe(1);
	});

	test("a plan started by a request logs its planner_call line under that request's reqId", async () => {
		const rejected: OpenRouterFetch = async () => new Response("bad request", { status: 400 });
		const h = harness(
			{ serverPlanning: true, planningModel: "x-ai/grok-test", openRouterApiKey: FAKE_KEY },
			{ fetch: rejected, sleep: instantBackoff },
		);
		const started = await h.app.handle(
			new Request(`${ORIGIN}/mcp`, {
				method: "POST",
				headers: { "Content-Type": "application/json", "x-connector-key": CONNECTOR_KEY, "x-request-id": "req-plan-0001" },
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method: "tools/call",
					params: { name: "ultrathink_uplift", arguments: { prompt: PROMPT, sessionId: crypto.randomUUID() } },
				}),
			}),
			PEER,
		);
		expect(started.status).toBe(200);

		const calls = logsOf(h, "planner_call");
		expect(calls.length).toBeGreaterThan(0);
		expect(calls[0]).toMatchObject({ reqId: "req-plan-0001" });
		await h.app.shutdown();
	});

	test("app.shutdown flushes the injected sink before it resolves, then shuts it down", async () => {
		const sink = recordingSink();
		const h = harness({}, { spans: sink });
		await h.app.handle(new Request(`${ORIGIN}/healthz`), PEER);
		expect(sink.recorded).toHaveLength(1);
		expect(sink.flushes).toBe(0);

		await h.app.shutdown();
		expect(sink.flushes).toBeGreaterThan(0);
		expect(sink.shutdowns).toBe(1);
	});
});
