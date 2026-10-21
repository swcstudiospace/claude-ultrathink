// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Auth, createAuth } from "../auth/auth.ts";
import type { UltrathinkConfig } from "../config/config.ts";
import type { HeadlessPlanner } from "../engine/headless.ts";
import { type Store, openStore } from "../store/store.ts";
import { createLogger } from "../obs/log.ts";
import { createMetrics, type Metrics } from "../obs/metrics.ts";
import type { RuntimeSample } from "../obs/runtime.ts";
import { type App, SECURITY_HEADERS, createApp, createHandler } from "./router.ts";
import { getSecurityLogger } from "../security/events.ts";

/** A header the security module sets, read from the exported constant. A missing one is a broken build, not a value to compare. */
function requiredHeader(name: string): string {
	const value = SECURITY_HEADERS[name];
	if (value === undefined) throw new Error(`SECURITY_HEADERS has no ${name}`);
	return value;
}

const PERMISSIONS_POLICY = requiredHeader("Permissions-Policy");

const PUBLIC_ORIGIN = "https://ultrathink.test";
const PEER_IP = "127.0.0.1";
const OWNER_ID = "owner";
const MAX_BODY_BYTES = 1024;
const MAX_INPUT_CHARS = 200;
const silent = createLogger({ write: () => undefined });

type Handler = (req: Request, peerIp: string) => Promise<Response>;
type ToolResult = { isError: boolean; structuredContent: Record<string, unknown> };

let dir: string;
let password: string;
let config: UltrathinkConfig;
let auth: Auth;
let store: Store;
let handler: Handler;
let cookie: string;

function jsonHeaders(): Record<string, string> {
	return { "Content-Type": "application/json", Origin: PUBLIC_ORIGIN };
}

function ultrathinkPost(body: string, headers: Record<string, string> = {}): Request {
	return new Request(`${PUBLIC_ORIGIN}/ultrathink`, {
		method: "POST",
		headers: { ...jsonHeaders(), Cookie: cookie, ...headers },
		body,
	});
}

function runCount(): number {
	return store.listRunsForOwner(OWNER_ID, 1000).length;
}

beforeAll(async () => {
	dir = mkdtempSync(join(tmpdir(), "ultrathink-router-"));
	password = randomBytes(24).toString("base64url");
	const ownerPasswordHash = await Bun.password.hash(password);
	const sessionSecret = randomBytes(32).toString("hex");

	config = {
		publicOrigin: PUBLIC_ORIGIN,
		ownerPasswordHash,
		sessionSecret,
		stateDir: dir,
		dbPath: join(dir, "ultrathink.db"),
		port: 0,
		maxInputChars: MAX_INPUT_CHARS,
		maxAnswerChars: 20000,
		maxBodyBytes: MAX_BODY_BYTES,
		runTokenCeiling: 150000,
		dailyTokenCeiling: 1000000,
		planningModel: undefined,
		connectorKey: undefined,
		allowedOrigins: [],
		oauthRedirectOrigins: [],
		openRouterApiKey: undefined,
		openRouterBaseUrl: "https://openrouter.ai/api/v1",
		serverPlanning: false,
		maxConcurrentPlans: 2,
		modelTimeoutMs: 120000,
		planTimeoutMs: 600000,
		modelMaxOutputTokens: 8000,
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
		fairQueueDepth: 16,
		fairQueueWaitMs: 1500,
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
	};
	auth = createAuth({ ownerPasswordHash, sessionSecret, cookieSecure: true });
	store = openStore(config.dbPath);
	handler = createHandler({ config, store, auth, logger: silent });

	const login = await handler(
		new Request(`${PUBLIC_ORIGIN}/login`, {
			method: "POST",
			headers: jsonHeaders(),
			body: JSON.stringify({ password }),
		}),
		PEER_IP,
	);
	expect(login.status).toBe(200);
	cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
	expect(cookie.startsWith("__Host-ut_session=")).toBe(true);
});

afterAll(() => {
	store.close();
	rmSync(dir, { recursive: true, force: true });
});

describe("router", () => {
	test("healthz returns ok without auth and carries the security headers", async () => {
		const res = await handler(new Request(`${PUBLIC_ORIGIN}/healthz`), PEER_IP);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
		expect(res.headers.get("cache-control")).toBe("no-store");
		expect(res.headers.get("x-content-type-options")).toBe("nosniff");
		expect(res.headers.get("referrer-policy")).toBe("no-referrer");
	});

	test("login with a wrong password returns 401 and sets no cookie", async () => {
		const res = await handler(
			new Request(`${PUBLIC_ORIGIN}/login`, {
				method: "POST",
				headers: jsonHeaders(),
				body: JSON.stringify({ password: "not-the-owner-password" }),
			}),
			PEER_IP,
		);
		expect(res.status).toBe(401);
		expect(await res.json()).toEqual({ error: "invalid_credentials" });
		expect(res.headers.get("set-cookie")).toBeNull();
	});

	test("unauthenticated POST is refused with 401 and creates no run", async () => {
		const before = runCount();
		const res = await handler(
			new Request(`${PUBLIC_ORIGIN}/ultrathink`, {
				method: "POST",
				headers: jsonHeaders(),
				body: JSON.stringify({ input: "plan the migration" }),
			}),
			PEER_IP,
		);
		expect(res.status).toBe(401);
		expect(await res.json()).toEqual({ error: "unauthenticated" });
		expect(runCount()).toBe(before);
	});

	test("logged-in POST creates exactly one planning run with its route and reason", async () => {
		const before = runCount();
		const res = await handler(ultrathinkPost(JSON.stringify({ input: "plan the billing rollout" })), PEER_IP);
		expect(res.status).toBe(202);
		const body = (await res.json()) as {
			runId: string;
			route: string;
			routeReason: string;
			status: string;
			statusUrl: string;
		};
		expect(body.route).toBe("planning");
		expect(body.routeReason.length).toBeGreaterThan(0);
		expect(body.status).toBe("queued");
		expect(body.statusUrl).toBe(`/ultrathink/runs/${body.runId}`);
		expect(runCount()).toBe(before + 1);
	});

	test("empty input after stripping returns usage and creates no run", async () => {
		const before = runCount();
		const res = await handler(ultrathinkPost(JSON.stringify({ input: " \t \u0007 " })), PEER_IP);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { usage: string; routes: string[]; flags: { route: string[] } };
		expect(body.routes).toEqual(["planning", "research", "build-plan"]);
		expect(body.flags.route).toContain("auto");
		expect(runCount()).toBe(before);
	});

	test("oversized body is refused with 413 and creates no run", async () => {
		const before = runCount();
		const res = await handler(
			ultrathinkPost(JSON.stringify({ input: "a".repeat(MAX_BODY_BYTES * 2) })),
			PEER_IP,
		);
		expect(res.status).toBe(413);
		expect(await res.json()).toEqual({ error: "body_too_large" });
		expect(runCount()).toBe(before);
	});

	test("input longer than maxInputChars after stripping is refused with 413", async () => {
		const before = runCount();
		const res = await handler(
			ultrathinkPost(JSON.stringify({ input: `plan ${"a".repeat(MAX_INPUT_CHARS)}` })),
			PEER_IP,
		);
		expect(res.status).toBe(413);
		expect(await res.json()).toEqual({ error: "input_too_long", maxChars: MAX_INPUT_CHARS });
		expect(runCount()).toBe(before);
	});

	test("unknown flag key is refused with 400 and creates no run", async () => {
		const before = runCount();
		const res = await handler(
			ultrathinkPost(JSON.stringify({ input: "plan the rollout", flags: { admin: true } })),
			PEER_IP,
		);
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "unknown_flag" });
		expect(runCount()).toBe(before);
	});

	test("route flag outside the allowlist is refused with 400 and creates no run", async () => {
		const before = runCount();
		const res = await handler(
			ultrathinkPost(JSON.stringify({ input: "plan the rollout", flags: { route: "admin" } })),
			PEER_IP,
		);
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({ error: "invalid_value" });
		expect(runCount()).toBe(before);
	});

	test("wrong Origin is refused with 403 and creates no run", async () => {
		const before = runCount();
		const res = await handler(
			ultrathinkPost(JSON.stringify({ input: "plan the rollout" }), { Origin: "https://evil.test" }),
			PEER_IP,
		);
		expect(res.status).toBe(403);
		expect(await res.json()).toEqual({ error: "forbidden" });
		expect(runCount()).toBe(before);
	});

	test("a run owned by another owner returns the same 404 as a missing run", async () => {
		const foreign = store.createRun({ ownerId: "someone-else", request: "private text", route: "planning" });
		const foreignRes = await handler(
			new Request(`${PUBLIC_ORIGIN}/ultrathink/runs/${foreign.id}`, { headers: { Cookie: cookie } }),
			PEER_IP,
		);
		const missingRes = await handler(
			new Request(`${PUBLIC_ORIGIN}/ultrathink/runs/does-not-exist`, { headers: { Cookie: cookie } }),
			PEER_IP,
		);
		expect(foreignRes.status).toBe(404);
		expect(missingRes.status).toBe(404);
		expect(await foreignRes.text()).toBe(await missingRes.text());
	});

	test("GET returns the owner's run status and phase list but never phase output or request text", async () => {
		const run = store.createRun({ ownerId: OWNER_ID, request: "plan the rollout", route: "planning" });
		store.recordPhase({
			runId: run.id,
			phase: "discover",
			attempt: 1,
			status: "complete",
			output: "PHASE-OUTPUT-SENTINEL",
		});
		const res = await handler(
			new Request(`${PUBLIC_ORIGIN}/ultrathink/runs/${run.id}`, { headers: { Cookie: cookie } }),
			PEER_IP,
		);
		expect(res.status).toBe(200);
		const text = await res.text();
		expect(text).not.toContain("PHASE-OUTPUT-SENTINEL");
		expect(text).not.toContain("plan the rollout");
		const body = JSON.parse(text) as {
			id: string;
			route: string;
			status: string;
			phases: Array<{ phase: string; attempt: number; status: string }>;
		};
		expect(body.id).toBe(run.id);
		expect(body.route).toBe("planning");
		expect(body.phases).toEqual([{ phase: "discover", attempt: 1, status: "complete" }]);
	});

	test("known path with the wrong method returns 405 with Allow, and unknown path returns 404", async () => {
		const wrongMethod = await handler(new Request(`${PUBLIC_ORIGIN}/login`, { method: "GET" }), PEER_IP);
		expect(wrongMethod.status).toBe(405);
		expect(wrongMethod.headers.get("allow")).toBe("POST");

		const unknown = await handler(new Request(`${PUBLIC_ORIGIN}/nope`), PEER_IP);
		expect(unknown.status).toBe(404);
		expect(await unknown.json()).toEqual({ error: "not_found" });
	});

	test("HEAD is answered like the GET it stands for without a body, and refused where GET is", async () => {
		const get = await handler(new Request(`${PUBLIC_ORIGIN}/healthz`), PEER_IP);
		const head = await handler(new Request(`${PUBLIC_ORIGIN}/healthz`, { method: "HEAD" }), PEER_IP);
		expect(head.status).toBe(200);
		expect(await head.text()).toBe("");
		for (const name of ["content-type", "cache-control", "x-content-type-options", "referrer-policy", "x-frame-options", "content-security-policy", "permissions-policy"]) {
			expect({ name, value: head.headers.get(name) }).toEqual({ name, value: get.headers.get(name) });
		}

		// The GET handler sees the request headers: the session cookie still authenticates.
		const usage = await handler(new Request(`${PUBLIC_ORIGIN}/ultrathink`, { method: "HEAD", headers: { Cookie: cookie } }), PEER_IP);
		expect(usage.status).toBe(200);
		expect(await usage.text()).toBe("");
		const anonymous = await handler(new Request(`${PUBLIC_ORIGIN}/ultrathink`, { method: "HEAD" }), PEER_IP);
		expect(anonymous.status).toBe(401);
		expect(await anonymous.text()).toBe("");

		const mcp = await handler(new Request(`${PUBLIC_ORIGIN}/mcp`, { method: "HEAD" }), PEER_IP);
		expect(mcp.status).toBe(405);
		expect(mcp.headers.get("allow")).toBe("POST");
		const login = await handler(new Request(`${PUBLIC_ORIGIN}/login`, { method: "HEAD" }), PEER_IP);
		expect(login.status).toBe(405);
		expect(login.headers.get("allow")).toBe("POST");
		const post = await handler(new Request(`${PUBLIC_ORIGIN}/healthz`, { method: "POST" }), PEER_IP);
		expect(post.status).toBe(405);
		expect(post.headers.get("allow")).toBe("GET, HEAD");
	});

	test("login and POST /ultrathink check the Origin before the content type: 403 for a foreign origin, 415 for a form body", async () => {
		const FORM = "application/x-www-form-urlencoded";
		const loginForm = (headers: Record<string, string>): Request =>
			new Request(`${PUBLIC_ORIGIN}/login`, { method: "POST", headers: { "Content-Type": FORM, ...headers }, body: `password=${password}` });

		const formLogin = await handler(loginForm({ Origin: PUBLIC_ORIGIN }), PEER_IP);
		expect(formLogin.status).toBe(415);
		expect(await formLogin.json()).toEqual({ error: "unsupported_media_type" });
		expect(formLogin.headers.get("set-cookie")).toBeNull();

		const foreignLogin = await handler(loginForm({ Origin: "https://evil.test" }), PEER_IP);
		expect(foreignLogin.status).toBe(403);
		expect(await foreignLogin.json()).toEqual({ error: "forbidden" });
		const originlessLogin = await handler(loginForm({}), PEER_IP);
		expect(originlessLogin.status).toBe(403);

		const before = runCount();
		const formRun = await handler(ultrathinkPost("input=plan+the+rollout", { "Content-Type": FORM }), PEER_IP);
		expect(formRun.status).toBe(415);
		expect(await formRun.json()).toEqual({ error: "unsupported_media_type" });
		const foreignRun = await handler(ultrathinkPost("input=plan+the+rollout", { "Content-Type": FORM, Origin: "https://evil.test" }), PEER_IP);
		expect(foreignRun.status).toBe(403);
		expect(await foreignRun.json()).toEqual({ error: "forbidden" });
		expect(runCount()).toBe(before);
	});

	test("every JSON, 202 and metrics response carries the frame, CSP and permissions headers", async () => {
		const responses = [
			await handler(new Request(`${PUBLIC_ORIGIN}/healthz`), PEER_IP),
			await handler(new Request(`${PUBLIC_ORIGIN}/metrics`), PEER_IP),
			await handler(new Request(`${PUBLIC_ORIGIN}/nope`), PEER_IP),
			await handler(new Request(`${PUBLIC_ORIGIN}/login`, { method: "GET" }), PEER_IP),
			await handler(new Request(`${PUBLIC_ORIGIN}/ultrathink`), PEER_IP),
			await handler(ultrathinkPost(JSON.stringify({ input: "plan the header rollout" })), PEER_IP),
		];
		expect(responses.map((res) => res.status)).toEqual([200, 200, 404, 405, 401, 202]);
		for (const res of responses) {
			expect(res.headers.get("x-frame-options")).toBe("DENY");
			expect(res.headers.get("content-security-policy")).toBe("default-src 'none'; frame-ancestors 'none'");
			expect(res.headers.get("permissions-policy")).toBe(PERMISSIONS_POLICY);
			expect(res.headers.get("cache-control")).toBe("no-store");
		}
	});

	describe("persistence failure", () => {
		test("POST returns 503 and healthz returns 503 when the store is closed", async () => {
			const closed = openStore(join(dir, "closed.db"));
			closed.close();
			const closedHandler = createHandler({ config, store: closed, auth, logger: silent });

			const health = await closedHandler(new Request(`${PUBLIC_ORIGIN}/healthz`), PEER_IP);
			expect(health.status).toBe(503);
			const healthBody = (await health.json()) as { error: string };
			expect(healthBody.error).toBe("persistence_unavailable");

			const post = await closedHandler(ultrathinkPost(JSON.stringify({ input: "plan the rollout" })), PEER_IP);
			expect(post.status).toBe(503);
			const body = (await post.json()) as { error: string; correlationId?: string };
			expect(body.error).toBe("persistence_unavailable");
			expect(typeof body.correlationId).toBe("string");
		});
	});
});

describe("MCP endpoint", () => {
	const CONNECTOR_KEY = randomBytes(24).toString("hex");
	const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
	let mcp: Handler;
	let planSessionId = "";
	let planKey = "";

	beforeAll(() => {
		mcp = createHandler({ config: { ...config, connectorKey: CONNECTOR_KEY }, store, auth, logger: silent });
	});

	function rpc(body: unknown, headers: Record<string, string> = {}): Request {
		return new Request(`${PUBLIC_ORIGIN}/mcp`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "x-connector-key": CONNECTOR_KEY, ...headers },
			body: JSON.stringify(body),
		});
	}

	async function callTool(name: string, args: Record<string, unknown>): Promise<ToolResult> {
		const response = await mcp(
			rpc({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
			PEER_IP,
		);
		expect(response.status).toBe(200);
		const body = (await response.json()) as { result: ToolResult };
		return body.result;
	}

	test("challenges with OAuth metadata when no connector key is configured", async () => {
		const response = await handler(rpc({ jsonrpc: "2.0", id: 1, method: "ping" }), PEER_IP);
		expect(response.status).toBe(401);
		expect(response.headers.get("www-authenticate")).toContain(`${PUBLIC_ORIGIN}/.well-known/oauth-protected-resource/mcp`);
	});

	test("refuses a missing or wrong connector key", async () => {
		const missing = await mcp(
			new Request(`${PUBLIC_ORIGIN}/mcp`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
			}),
			PEER_IP,
		);
		expect(missing.status).toBe(401);
		const wrong = await mcp(rpc({ jsonrpc: "2.0", id: 1, method: "ping" }, { "x-connector-key": "x".repeat(32) }), PEER_IP);
		expect(wrong.status).toBe(401);
	});

	test("GET is refused and advertises POST", async () => {
		const response = await mcp(
			new Request(`${PUBLIC_ORIGIN}/mcp`, { method: "GET", headers: { "x-connector-key": CONNECTOR_KEY } }),
			PEER_IP,
		);
		expect(response.status).toBe(405);
		expect(response.headers.get("allow")).toBe("POST");
	});

	test("initialize answers with protocol version 2025-06-18 when requested", async () => {
		const init = await mcp(
			rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }),
			PEER_IP,
		);
		expect(init.status).toBe(200);
		const initBody = (await init.json()) as { result: { protocolVersion: string } };
		expect(initBody.result.protocolVersion).toBe("2025-06-18");
	});

	test("a notification returns 202 with no body", async () => {
		const response = await mcp(rpc({ jsonrpc: "2.0", method: "notifications/initialized" }), PEER_IP);
		expect(response.status).toBe(202);
		expect(await response.text()).toBe("");
	});

	test("the 202 notification answer carries the security headers", async () => {
		const response = await mcp(rpc({ jsonrpc: "2.0", method: "notifications/initialized" }), PEER_IP);
		expect(response.status).toBe(202);
		expect(response.headers.get("x-frame-options")).toBe("DENY");
		expect(response.headers.get("content-security-policy")).toBe("default-src 'none'; frame-ancestors 'none'");
		expect(response.headers.get("permissions-policy")).toBe(PERMISSIONS_POLICY);
		expect(response.headers.get("x-content-type-options")).toBe("nosniff");
	});

	test("tools/list returns the six journal tools and the three connector tools when server planning is off", async () => {
		const list = await mcp(rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }), PEER_IP);
		const listBody = (await list.json()) as { result: { tools: { name: string }[] } };
		expect(listBody.result.tools.map((tool) => tool.name).sort()).toEqual([
			"ultrathink_answer",
			"ultrathink_command",
			"ultrathink_graph",
			"ultrathink_pending",
			"ultrathink_plan",
			"ultrathink_result",
			"ultrathink_sessions",
			"ultrathink_show",
			"ultrathink_status",
		]);
	});

	test("ultrathink_plan without a sessionId starts a journal session on disk", async () => {
		const result = await callTool("ultrathink_plan", { prompt: "plan the mcp rollout" });
		expect(result.isError).toBe(false);
		planSessionId = String(result.structuredContent.sessionId);
		expect(planSessionId).toMatch(UUID);
		expect(result.structuredContent.status).toBe("needs-model");
		const pending = result.structuredContent.pending as { key: string }[];
		const [first] = pending;
		expect(first).toBeDefined();
		planKey = first?.key ?? "";
		expect(planKey).not.toBe("");
		expect(existsSync(join(dir, "journal", planSessionId, "meta.json"))).toBe(true);
	});

	test("ultrathink_plan creates no SQLite run", async () => {
		const before = runCount();
		const result = await callTool("ultrathink_plan", { prompt: "plan without a run record" });
		expect(result.isError).toBe(false);
		expect(runCount()).toBe(before);
	});

	test("ultrathink_status reports the planning session", async () => {
		const result = await callTool("ultrathink_status", { sessionId: planSessionId });
		expect(result.isError).toBe(false);
		expect(result.structuredContent.status).toBe("needs-model");
	});

	test("ultrathink_plan refuses a path-like sessionId", async () => {
		const result = await callTool("ultrathink_plan", { prompt: "plan escape", sessionId: "../etc" });
		expect(result.isError).toBe(true);
		expect(result.structuredContent.error).toBe("invalid_session_id");
	});

	test("ultrathink_show refuses an unknown key", async () => {
		const result = await callTool("ultrathink_show", { sessionId: planSessionId, key: "no-such-key" });
		expect(result.isError).toBe(true);
		expect(result.structuredContent.error).toBe("not_found");
	});

	test("ultrathink_answer refuses an invalid answer and keeps the prompt pending", async () => {
		const answer = await callTool("ultrathink_answer", { sessionId: planSessionId, key: planKey, answer: "not an answer" });
		expect(answer.isError).toBe(true);
		expect(answer.structuredContent.error).toBe("invalid_answer");

		const pending = await callTool("ultrathink_pending", { sessionId: planSessionId });
		expect(pending.isError).toBe(false);
		expect(pending.structuredContent).toEqual(
			expect.objectContaining({ pending: expect.arrayContaining([expect.objectContaining({ key: planKey })]) }),
		);
	});

	test("ultrathink_plan refuses a prompt over the input limit", async () => {
		const result = await callTool("ultrathink_plan", { prompt: "x".repeat(MAX_INPUT_CHARS + 1) });
		expect(result.isError).toBe(true);
		expect(result.structuredContent.error).toBe("invalid_input");
	});
});

/** A runtime sample with only the event-loop lag set; the router reads nothing else from it. */
function sample(eventLoopLagMs: number): RuntimeSample {
	return { eventLoopLagMs, rssBytes: 0, heapUsedBytes: 0, uptimeSec: 0 };
}

/** The value of one unlabelled gauge as the metrics render it. */
function gaugeValue(metrics: Metrics, name: string): number {
	const line = metrics.render().split("\n").find((text) => text.startsWith(`${name} `));
	if (line === undefined) throw new Error(`${name} is not rendered`);
	return Number(line.slice(name.length + 1));
}

describe("penalties, pool shares, pressure scaling and load history", () => {
	const ATTACKER = "203.0.113.10";
	const OTHER_CLIENT = "203.0.113.11";
	const OWNER_IP = "198.51.100.5";
	const CONNECTOR_KEY = randomBytes(24).toString("hex");
	/** A minute boundary, so every fixed window and minute bucket here starts whole. */
	const START_MS = 100_000 * 60_000;
	let root: string;
	let clock: { ms: number };
	let logLines: string[];

	beforeAll(() => {
		root = mkdtempSync(join(tmpdir(), "ultrathink-limits-"));
	});

	afterAll(() => {
		rmSync(root, { recursive: true, force: true });
	});

	beforeEach(() => {
		clock = { ms: START_MS };
		logLines = [];
	});

	/** A fresh app over its own state directory: its own penalty table, pools, load history and auth windows. */
	function build(overrides: Partial<UltrathinkConfig> = {}, extras: { stateDir?: string; planner?: HeadlessPlanner } = {}): { app: App; metrics: Metrics } {
		const metrics = createMetrics();
		const auth = createAuth({ ownerPasswordHash: config.ownerPasswordHash, sessionSecret: config.sessionSecret, cookieSecure: true });
		const app = createApp({
			config: { ...config, stateDir: extras.stateDir ?? mkdtempSync(join(root, "app-")), ...overrides },
			store,
			auth,
			logger: createLogger({ write: (line) => logLines.push(line) }),
			metrics,
			now: () => clock.ms,
			...(extras.planner === undefined ? {} : { planner: extras.planner }),
		});
		return { app, metrics };
	}

	/** A bearer token the router refuses: a 401 that counts against the caller's IP. */
	function badBearer(): Request {
		return new Request(`${PUBLIC_ORIGIN}/mcp`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Authorization: "Bearer not-a-real-token" },
			body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
		});
	}

	async function failCredentials(app: App, ip: string, times: number): Promise<void> {
		for (let i = 0; i < times; i++) expect((await app.handle(badBearer(), ip)).status).toBe(401);
	}

	async function ownerCookie(app: App): Promise<string> {
		const login = await app.handle(
			new Request(`${PUBLIC_ORIGIN}/login`, { method: "POST", headers: jsonHeaders(), body: JSON.stringify({ password }) }),
			OWNER_IP,
		);
		expect(login.status).toBe(200);
		return (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
	}

	function ownerRun(app: App, cookie: string, origin: string = PUBLIC_ORIGIN): Promise<Response> {
		return app.handle(
			new Request(`${PUBLIC_ORIGIN}/ultrathink`, {
				method: "POST",
				headers: { "Content-Type": "application/json", Origin: origin, Cookie: cookie },
				body: JSON.stringify({ input: "plan the rollout" }),
			}),
			OWNER_IP,
		);
	}

	/** A connector `tools/call` that the stub planner holds open until it is released. */
	function connectorUplift(id: number): Request {
		return new Request(`${PUBLIC_ORIGIN}/mcp`, {
			method: "POST",
			headers: { "Content-Type": "application/json", "x-connector-key": CONNECTOR_KEY },
			body: JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "ultrathink_uplift", arguments: { prompt: "plan it" } } }),
		});
	}

	test("20 failed credentials pass, the 21st escalates, the 22nd is blocked; health stays up; the block ends", async () => {
		const { app, metrics } = build();
		await failCredentials(app, ATTACKER, 20);
		expect((await app.handle(badBearer(), ATTACKER)).status).toBe(401);
		expect(metrics.render()).toContain("ultrathink_abuse_penalty_total 1");

		const blocked = await app.handle(badBearer(), ATTACKER);
		expect(blocked.status).toBe(429);
		expect(blocked.headers.get("retry-after")).toBe("60");
		expect(await blocked.json()).toEqual({ error: "rate_limited" });
		expect(metrics.render()).toContain('ultrathink_rate_limited_total{scope="penalty"} 1');
		expect((await app.handle(new Request(`${PUBLIC_ORIGIN}/healthz`), ATTACKER)).status).toBe(200);

		clock.ms += 60_000;
		expect((await app.handle(badBearer(), ATTACKER)).status).toBe(401);
	});

	test("a repeat offence inside the decay period doubles the block, and never exceeds penaltyMaxSec", async () => {
		const { app } = build();
		await failCredentials(app, ATTACKER, 21);
		clock.ms += 60_000;
		await failCredentials(app, ATTACKER, 21);
		const second = await app.handle(badBearer(), ATTACKER);
		expect(second.status).toBe(429);
		expect(second.headers.get("retry-after")).toBe("120");

		const capped = build({ penaltyMaxSec: 90 }).app;
		await failCredentials(capped, OTHER_CLIENT, 21);
		clock.ms += 60_000;
		await failCredentials(capped, OTHER_CLIENT, 21);
		expect((await capped.handle(badBearer(), OTHER_CLIENT)).headers.get("retry-after")).toBe("90");
	});

	test("a blocked IP does not affect another IP", async () => {
		const { app } = build();
		await failCredentials(app, ATTACKER, 21);
		expect((await app.handle(badBearer(), ATTACKER)).status).toBe(429);
		expect((await app.handle(badBearer(), OTHER_CLIENT)).status).toBe(401);
	});

	test("under pressure the owner window is halved: 30 requests pass the window, the 31st is rate limited", async () => {
		const pressured = build().app;
		const cookie = await ownerCookie(pressured);
		// One lag sample above the 100 ms target steps the factor to its 0.5 floor.
		pressured.observeRuntime(sample(1000));
		for (let i = 0; i < 30; i++) expect((await ownerRun(pressured, cookie, "https://evil.test")).status).toBe(403);
		const limited = await ownerRun(pressured, cookie, "https://evil.test");
		expect(limited.status).toBe(429);
		expect(await limited.json()).toEqual({ error: "rate_limited" });

		const calm = build().app;
		const calmCookie = await ownerCookie(calm);
		for (let i = 0; i < 60; i++) expect((await ownerRun(calm, calmCookie, "https://evil.test")).status).toBe(403);
		expect((await ownerRun(calm, calmCookie, "https://evil.test")).status).toBe(429);
	});

	test("a connector holds at most capacity minus reserve; the owner is still admitted into the reserve", async () => {
		const gate = Promise.withResolvers<void>();
		const reached = Promise.withResolvers<void>();
		let entered = 0;
		const planner: HeadlessPlanner = {
			enabled: true,
			async start(input) {
				entered += 1;
				if (entered === 2) reached.resolve();
				await gate.promise;
				return { ok: true, data: { sessionId: String(input.sessionId ?? "held"), status: "running", pollAfterSec: 5 } };
			},
			async result() {
				throw new Error("the stub planner is not asked for results in this test");
			},
			status: () => null,
			async shutdown() {},
			upstream: () => undefined,
		};
		// maxInflight 4 with a 50 % reserve: the reserve is 2, so non-owner classes may hold 2 slots.
		const { app, metrics } = build({ connectorKey: CONNECTOR_KEY, maxInflight: 4, priorityReservePct: 50, fairQueueDepth: 0 }, { planner });
		const cookie = await ownerCookie(app);

		const holdA = app.handle(connectorUplift(1), "198.51.100.1");
		const holdB = app.handle(connectorUplift(2), "198.51.100.2");
		await reached.promise;

		const refused = await app.handle(connectorUplift(3), "198.51.100.3");
		expect(refused.status).toBe(429);
		expect(refused.headers.get("retry-after")).toBe("1");
		expect(await refused.json()).toEqual({ error: "rate_limited" });
		expect(metrics.render()).toContain('ultrathink_fair_share_refused_total{class="connector",reason="reserved"} 1');

		expect((await ownerRun(app, cookie)).status).toBe(202);

		gate.resolve();
		expect((await holdA).status).toBe(200);
		expect((await holdB).status).toBe(200);
		// Both holds have released their slots, so a connector is admitted again.
		expect((await app.handle(connectorUplift(4), "198.51.100.3")).status).toBe(200);
	});

	test("the security logger the app installs writes fair-share refusals to the app's writer", async () => {
		const gate = Promise.withResolvers<void>();
		const reached = Promise.withResolvers<void>();
		let entered = 0;
		const planner: HeadlessPlanner = {
			enabled: true,
			async start(input) {
				entered += 1;
				if (entered === 2) reached.resolve();
				await gate.promise;
				return { ok: true, data: { sessionId: String(input.sessionId ?? "held"), status: "running", pollAfterSec: 5 } };
			},
			async result() {
				throw new Error("the stub planner is not asked for results in this test");
			},
			status: () => null,
			async shutdown() {},
			upstream: () => undefined,
		};
		// maxInflight 4 with a 50 % reserve, and no queue: the third connector is refused at once.
		const { app } = build({ connectorKey: CONNECTOR_KEY, maxInflight: 4, priorityReservePct: 50, fairQueueDepth: 0 }, { planner });
		const eventNames = () =>
			logLines.map((line) => {
				const parsed: unknown = JSON.parse(line);
				return typeof parsed === "object" && parsed !== null && "event" in parsed ? parsed.event : undefined;
			});

		getSecurityLogger().logRateLimitExceeded({ name: "test.installed", details: {} });
		expect(eventNames()).toContain("test.installed");

		const holdA = app.handle(connectorUplift(1), "198.51.100.1");
		const holdB = app.handle(connectorUplift(2), "198.51.100.2");
		await reached.promise;
		expect((await app.handle(connectorUplift(3), "198.51.100.3")).status).toBe(429);
		expect(eventNames()).toContain("rate_limit.fair_share_refused");

		gate.resolve();
		expect((await holdA).status).toBe(200);
		expect((await holdB).status).toBe(200);
	});

	test("a corrupt load-history.json starts the app empty and is logged; readiness and metrics still answer", async () => {
		const stateDir = mkdtempSync(join(root, "corrupt-"));
		writeFileSync(join(stateDir, "load-history.json"), "not json");
		const { app, metrics } = build({}, { stateDir });
		app.start();
		try {
			expect(logLines.some((line) => line.includes("load_history_malformed"))).toBe(true);
			expect((await app.handle(new Request(`${PUBLIC_ORIGIN}/readyz`), "127.0.0.1")).status).toBe(200);
			expect((await app.handle(new Request(`${PUBLIC_ORIGIN}/metrics`), "127.0.0.1")).status).toBe(200);
			app.observeRuntime(sample(0));
			expect(gaugeValue(metrics, "ultrathink_load_forecast_rps")).toBe(0);
		} finally {
			await app.shutdown();
		}
	});

	test("the load history survives a restart: the forecast of a new app equals the one before shutdown", async () => {
		const stateDir = mkdtempSync(join(root, "history-"));
		const first = build({}, { stateDir });
		first.app.start();
		for (let i = 0; i < 30; i++) {
			expect((await first.app.handle(new Request(`${PUBLIC_ORIGIN}/.well-known/oauth-protected-resource`), "127.0.0.1")).status).toBe(200);
		}
		first.app.observeRuntime(sample(0));
		// Thirty requests in the current minute, fewer than five minutes recorded: the cold forecast is 30 / 60.
		const before = gaugeValue(first.metrics, "ultrathink_load_forecast_rps");
		expect(before).toBe(0.5);
		await first.app.shutdown();
		expect(statSync(join(stateDir, "load-history.json")).mode & 0o777).toBe(0o600);

		logLines = [];
		const second = build({}, { stateDir });
		second.app.observeRuntime(sample(0));
		expect(gaugeValue(second.metrics, "ultrathink_load_forecast_rps")).toBe(before);
		expect(logLines.some((line) => line.includes("load_history"))).toBe(false);
		await second.app.shutdown();
	});
});
