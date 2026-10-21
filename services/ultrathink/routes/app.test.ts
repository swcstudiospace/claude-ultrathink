// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { afterAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pkg from "../../../package.json";
import { type SessionRecord, writeSession } from "../../../src/claude/state.ts";
import { journalDir, stageOf, writeMeta } from "../../../src/host/grokbot.ts";
import { COT_SYSTEM_PROMPT, GRAPH_SYSTEM_PROMPT } from "../../../src/think/prompts.ts";
import { UPLIFT_SYSTEM_PROMPT } from "../../../src/uplift/prompt.ts";
import { escapeXml } from "../../../src/uplift/xml.ts";
import { type Auth, createAuth } from "../auth/auth.ts";
import type { UltrathinkConfig } from "../config/config.ts";
import type { HeadlessPlanner, ResultView } from "../engine/headless.ts";
import type { OpenRouterFetch } from "../engine/openrouter.ts";
import { auditPath, verifyAuditFile } from "../obs/audit.ts";
import { type RequestContext, currentRequestContext } from "../obs/context.ts";
import { createLogger } from "../obs/log.ts";
import type { SinkEnvelope, SinkTransport } from "../obs/sinks/types.ts";
import { type Store, openStore } from "../store/store.ts";
import { type App, type RouterDeps, createApp } from "./router.ts";

const ORIGIN = "https://ultrathink.test";
const RESOURCE = `${ORIGIN}/mcp`;
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const PEER = "127.0.0.1";
const CONNECTOR_KEY = randomBytes(24).toString("hex");
const OWNER_PASSWORD = randomBytes(24).toString("base64url");
const OWNER_HASH = await Bun.password.hash(OWNER_PASSWORD);
const SESSION_SECRET = randomBytes(32).toString("hex");
const FAKE_KEY = "sk-or-fake-key-0123456789abcdef";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

type Json = Record<string, unknown>;
type ToolResult = { content: Array<{ type: string; text: string }>; structuredContent: Json; isError: boolean };
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

function tmp(): string {
	const dir = mkdtempSync(join(tmpdir(), "ultrathink-app-"));
	dirs.push(dir);
	return dir;
}

function baseConfig(dir: string, overrides: Partial<UltrathinkConfig> = {}): UltrathinkConfig {
	return {
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
		...overrides,
	};
}

interface Harness {
	app: App;
	dir: string;
	store: Store;
	config: UltrathinkConfig;
	logs: LogLine[];
}

interface HarnessOptions {
	config?: Partial<UltrathinkConfig>;
	deps?: Partial<RouterDeps>;
	auth?: Auth;
}

function harness(options: HarnessOptions = {}): Harness {
	const dir = tmp();
	const config = baseConfig(dir, options.config);
	const store = openStore(config.dbPath);
	stores.push(store);
	const auth = options.auth ?? createAuth({ ownerPasswordHash: OWNER_HASH, sessionSecret: SESSION_SECRET, cookieSecure: true });
	const logs: LogLine[] = [];
	const logger = createLogger({ write: (line) => logs.push(JSON.parse(line) as LogLine) });
	const app = createApp({ config, store, auth, logger, ...options.deps });
	return { app, dir, store, config, logs };
}

function mcpRequest(body: unknown, headers: Record<string, string> = {}, path = "/mcp"): Request {
	return new Request(`${ORIGIN}${path}`, {
		method: "POST",
		headers: { "Content-Type": "application/json", "x-connector-key": CONNECTOR_KEY, ...headers },
		body: JSON.stringify(body),
	});
}

function rpc(h: Harness, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
	return h.app.handle(mcpRequest(body, headers), PEER);
}

async function callTool(h: Harness, name: string, args: Json): Promise<ToolResult> {
	const response = await rpc(h, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
	expect(response.status).toBe(200);
	return (await json<{ result: ToolResult }>(response)).result;
}

async function toolNames(h: Harness): Promise<string[]> {
	const response = await rpc(h, { jsonrpc: "2.0", id: 1, method: "tools/list" });
	expect(response.status).toBe(200);
	const body = await json<{ result: { tools: Array<{ name: string }> } }>(response);
	return body.result.tools.map((tool) => tool.name).sort();
}

async function json<T>(response: Response): Promise<T> {
	return (await response.json()) as T;
}

function logsOf(h: Harness, event: string): LogLine[] {
	return h.logs.filter((line) => line.event === event);
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

let ipSeq = 0;

// Registration, authorize and token calls are limited per IP, so each call gets its own peer.
function freshIp(): string {
	ipSeq += 1;
	return `198.18.${Math.floor(ipSeq / 250)}.${(ipSeq % 250) + 1}`;
}

function register(h: Harness, redirect: string): Promise<Response> {
	return h.app.handle(
		new Request(`${ORIGIN}/oauth/register`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ client_name: "Test client", redirect_uris: [redirect] }),
		}),
		freshIp(),
	);
}

async function issueAccessToken(h: Harness): Promise<{ accessToken: string; clientId: string }> {
	const registered = await register(h, REDIRECT);
	expect(registered.status).toBe(201);
	const clientId = (await json<{ client_id: string }>(registered)).client_id;
	const verifier = randomBytes(32).toString("base64url");
	const challenge = createHash("sha256").update(verifier).digest("base64url");
	const params = new URLSearchParams({
		response_type: "code",
		client_id: clientId,
		redirect_uri: REDIRECT,
		code_challenge: challenge,
		code_challenge_method: "S256",
		resource: RESOURCE,
		state: "state-1",
	});
	const consent = await h.app.handle(new Request(`${ORIGIN}/oauth/authorize?${params.toString()}`), freshIp());
	expect(consent.status).toBe(200);
	const html = await consent.text();
	const requestId = /name="req" value="([^"]+)"/.exec(html)?.[1] ?? "";
	const nonce = /name="nonce" value="([^"]+)"/.exec(html)?.[1] ?? "";
	expect(requestId).not.toBe("");
	const granted = await h.app.handle(
		new Request(`${ORIGIN}/oauth/authorize`, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({ req: requestId, nonce, password: OWNER_PASSWORD }).toString(),
		}),
		freshIp(),
	);
	const code = new URL(granted.headers.get("location") ?? "").searchParams.get("code") ?? "";
	expect(code).not.toBe("");
	const tokens = await h.app.handle(
		new Request(`${ORIGIN}/oauth/token`, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				grant_type: "authorization_code",
				code,
				code_verifier: verifier,
				client_id: clientId,
				redirect_uri: REDIRECT,
				resource: RESOURCE,
			}).toString(),
		}),
		freshIp(),
	);
	expect(tokens.status).toBe(200);
	return { accessToken: (await json<{ access_token: string }>(tokens)).access_token, clientId };
}

function bearerRequest(token: string): Request {
	return new Request(RESOURCE, {
		method: "POST",
		headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
		body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
	});
}

const PLAN_TEXT = "Request: plan the migration\n\nSpecification: a plan.";

function viewOf(sessionId: string, overrides: Partial<ResultView> = {}): ResultView {
	return {
		sessionId,
		status: "planned",
		mode: "server",
		text: PLAN_TEXT,
		questions: [{ question: "Which database?", default: "Postgres" }],
		usage: { calls: 9, inputTokens: 900, outputTokens: 450, costUsd: 0.02 },
		...overrides,
	};
}

interface StubPlanner extends HeadlessPlanner {
	starts: unknown[];
	results: unknown[];
	shutdowns: number;
	/** Session ids the stub answers `status` for, as a server job. */
	serverIds: Set<string>;
}

function stubPlanner(enabled: boolean, impl: Partial<Pick<HeadlessPlanner, "start" | "result">> = {}): StubPlanner {
	const stub: StubPlanner = {
		enabled,
		starts: [],
		results: [],
		shutdowns: 0,
		serverIds: new Set(),
		upstream: () => undefined,
		async start(input) {
			stub.starts.push(input);
			if (impl.start) return impl.start(input);
			return { ok: true, data: { sessionId: String(input.sessionId ?? randomSessionId()), status: "running", pollAfterSec: 5 } };
		},
		async result(input) {
			stub.results.push(input);
			if (impl.result) return impl.result(input);
			return { ok: true, data: viewOf(String(input.sessionId)) };
		},
		status(input) {
			const sessionId = String(input.sessionId);
			if (!stub.serverIds.has(sessionId)) return null;
			return { ok: true, data: { sessionId, status: "running", pendingCount: 0, pending: [] } };
		},
		async shutdown() {
			stub.shutdowns += 1;
		},
	};
	return stub;
}

function randomSessionId(): string {
	return crypto.randomUUID();
}

describe("MCP transport guards", () => {
	test("a disallowed Origin gets 403 before auth, and allowed or absent origins pass", async () => {
		const h = harness({ config: { allowedOrigins: ["https://chat.example.test"] } });
		const ping = { jsonrpc: "2.0", id: 1, method: "ping" };

		const bad = await rpc(h, ping, { Origin: "https://evil.test" });
		expect(bad.status).toBe(403);
		const opaque = await rpc(h, ping, { Origin: "null" });
		expect(opaque.status).toBe(403);
		// Origin comes before authentication: a stranger is told 403, not given a challenge.
		const stranger = await h.app.handle(
			new Request(RESOURCE, { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://evil.test" }, body: JSON.stringify(ping) }),
			PEER,
		);
		expect(stranger.status).toBe(403);
		expect(stranger.headers.get("www-authenticate")).toBeNull();

		for (const origin of [ORIGIN, "https://claude.ai", "https://grok.com", "https://chat.example.test"]) {
			expect((await rpc(h, ping, { Origin: origin })).status).toBe(200);
		}
		expect((await rpc(h, ping)).status).toBe(200);
	});

	test("an unsupported MCP-Protocol-Version gets 400 and an absent or supported one is handled", async () => {
		const h = harness();
		const list = { jsonrpc: "2.0", id: 1, method: "tools/list" };
		expect((await rpc(h, list, { "MCP-Protocol-Version": "2024-11-05" })).status).toBe(400);
		expect((await rpc(h, list, { "MCP-Protocol-Version": "garbage" })).status).toBe(400);
		expect((await rpc(h, list)).status).toBe(200);
		expect((await rpc(h, list, { "MCP-Protocol-Version": "2025-11-25" })).status).toBe(200);
	});

	test("a batch is refused with 400 under 2025-06-18 and handled under 2025-03-26", async () => {
		const h = harness();
		const batch = [
			{ jsonrpc: "2.0", id: 1, method: "ping" },
			{ jsonrpc: "2.0", id: 2, method: "ping" },
		];
		const refused = await rpc(h, batch, { "MCP-Protocol-Version": "2025-06-18" });
		expect(refused.status).toBe(400);
		const handled = await rpc(h, batch, { "MCP-Protocol-Version": "2025-03-26" });
		expect(handled.status).toBe(200);
		expect(await json<unknown[]>(handled)).toHaveLength(2);
	});

	test("the challenge names invalid_token only when a bearer was presented and is not valid", async () => {
		const h = harness();
		const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
		const bare = await h.app.handle(new Request(RESOURCE, { method: "POST", headers: { "Content-Type": "application/json" }, body }), PEER);
		expect(bare.status).toBe(401);
		const bareChallenge = bare.headers.get("www-authenticate") ?? "";
		expect(bareChallenge).toContain(`${ORIGIN}/.well-known/oauth-protected-resource/mcp`);
		expect(bareChallenge).not.toContain("invalid_token");

		const wrongKey = await h.app.handle(
			new Request(RESOURCE, { method: "POST", headers: { "Content-Type": "application/json", "x-connector-key": "x".repeat(32) }, body }),
			PEER,
		);
		expect(wrongKey.status).toBe(401);
		expect(wrongKey.headers.get("www-authenticate") ?? "").not.toContain("invalid_token");

		const stale = await h.app.handle(bearerRequest("ut_at_not-a-real-token"), PEER);
		expect(stale.status).toBe(401);
		const staleChallenge = stale.headers.get("www-authenticate") ?? "";
		expect(staleChallenge).toContain('error="invalid_token"');
		expect(staleChallenge).toContain("resource_metadata=");
	});

	test("a valid OAuth bearer is accepted, and revoking it turns the next call into an invalid_token challenge", async () => {
		const h = harness({ config: { connectorKey: undefined } });
		const { accessToken, clientId } = await issueAccessToken(h);
		expect((await h.app.handle(bearerRequest(accessToken), PEER)).status).toBe(200);
		expect(logsOf(h, "request").some((line) => line.authKind === "bearer")).toBe(true);

		const revoke = await h.app.handle(
			new Request(`${ORIGIN}/oauth/revoke`, {
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({ token: accessToken, client_id: clientId }).toString(),
			}),
			freshIp(),
		);
		expect(revoke.status).toBe(200);

		const after = await h.app.handle(bearerRequest(accessToken), PEER);
		expect(after.status).toBe(401);
		expect(after.headers.get("www-authenticate") ?? "").toContain('error="invalid_token"');
	});
});

describe("OAuth routes", () => {
	test("POST /oauth/revoke is routed with the client ip: POST only, a missing token is 400, an unknown token is 200", async () => {
		const h = harness();
		const get = await h.app.handle(new Request(`${ORIGIN}/oauth/revoke`), PEER);
		expect(get.status).toBe(405);
		expect(get.headers.get("allow")).toBe("POST");

		const form = (fields: Record<string, string>): Request =>
			new Request(`${ORIGIN}/oauth/revoke`, {
				method: "POST",
				headers: { "content-type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams(fields).toString(),
			});
		expect((await h.app.handle(form({}), freshIp())).status).toBe(400);
		expect((await h.app.handle(form({ token: "ut_at_unknown" }), freshIp())).status).toBe(200);

		// The route passes the client ip on: 60 calls a minute from one address, then the limiter answers.
		const ip = freshIp();
		for (let i = 0; i < 60; i += 1) expect((await h.app.handle(form({ token: "ut_at_unknown" }), ip)).status).toBe(200);
		expect((await h.app.handle(form({ token: "ut_at_unknown" }), ip)).status).toBe(429);
	});

	test("config.oauthRedirectOrigins extends the registration allow list and nothing else does", async () => {
		const plain = harness();
		expect((await register(plain, "https://chat.example.test/callback")).status).toBe(400);
		expect((await register(plain, "https://evil.test/callback")).status).toBe(400);
		expect((await register(plain, REDIRECT)).status).toBe(201);

		const extended = harness({ config: { oauthRedirectOrigins: ["https://chat.example.test"] } });
		expect((await register(extended, "https://chat.example.test/callback")).status).toBe(201);
		const refused = await register(extended, "https://evil.test/callback");
		expect(refused.status).toBe(400);
		expect((await json<{ error: string }>(refused)).error).toBe("invalid_redirect_uri");
	});
});

describe("tool surface", () => {
	test("without server planning the list has nine tools and ultrathink_uplift does not exist", async () => {
		const h = harness();
		expect(h.app.planner.enabled).toBe(false);
		expect(await toolNames(h)).toEqual(["ultrathink_answer", "ultrathink_command", "ultrathink_graph", "ultrathink_pending", "ultrathink_plan", "ultrathink_result", "ultrathink_sessions", "ultrathink_show", "ultrathink_status"]);

		const response = await rpc(h, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ultrathink_uplift", arguments: { prompt: "plan it" } } });
		const body = await json<{ error?: { code: number } }>(response);
		expect(body.error?.code).toBe(-32602);
	});

	test("with an enabled planner the list has ten tools including ultrathink_uplift", async () => {
		const h = harness({ deps: { planner: stubPlanner(true) } });
		const names = await toolNames(h);
		expect(names).toHaveLength(10);
		expect(names).toContain("ultrathink_uplift");
		expect(h.app.planner.enabled).toBe(true);
		expect(sample(h, "ultrathink_planner_enabled")).toBe(1);
	});

	test("the default planner is enabled exactly when config.serverPlanning is", () => {
		expect(harness().app.planner.enabled).toBe(false);
		const on = harness({ config: { serverPlanning: true, planningModel: "x-ai/grok-test", openRouterApiKey: FAKE_KEY } });
		expect(on.app.planner.enabled).toBe(true);
	});

	// Claude Code hands the model structuredContent instead of content when both exist, so the plan text is in both.
	test("uplift then result: the plan text is the tool content and also structuredContent.text", async () => {
		const planner = stubPlanner(true);
		const h = harness({ deps: { planner } });
		const sessionId = randomSessionId();

		const started = await callTool(h, "ultrathink_uplift", { prompt: "plan the migration", sessionId });
		expect(started.isError).toBe(false);
		expect(started.structuredContent).toEqual({ sessionId, status: "running", pollAfterSec: 5 });
		expect(planner.starts).toEqual([{ prompt: "plan the migration", sessionId }]);

		const result = await callTool(h, "ultrathink_result", { sessionId, waitSeconds: 0, detail: "full" });
		expect(result.isError).toBe(false);
		expect(result.content).toEqual([{ type: "text", text: PLAN_TEXT }]);
		expect(result.structuredContent.sessionId).toBe(sessionId);
		expect(result.structuredContent.status).toBe("planned");
		expect(result.structuredContent.mode).toBe("server");
		expect(result.structuredContent.text).toBe(PLAN_TEXT);
		expect(result.structuredContent.questions).toEqual([{ question: "Which database?", default: "Postgres" }]);
		expect(planner.results).toEqual([{ sessionId, waitSeconds: 0, detail: "full" }]);
	});

	test("a planner failure becomes a tool error with its code and errors", async () => {
		const planner = stubPlanner(true, {
			start: async () => ({ ok: false, code: "busy" }),
			result: async () => ({ ok: false, code: "invalid_input", errors: ["waitSeconds must be a number"] }),
		});
		const h = harness({ deps: { planner } });
		const started = await callTool(h, "ultrathink_uplift", { prompt: "plan it" });
		expect(started.isError).toBe(true);
		expect(started.structuredContent).toEqual({ error: "busy" });
		const result = await callTool(h, "ultrathink_result", { sessionId: randomSessionId() });
		expect(result.isError).toBe(true);
		expect(result.structuredContent).toEqual({ error: "invalid_input", errors: ["waitSeconds must be a number"] });
		expect(sample(h, "ultrathink_mcp_tool_calls_total", { tool: "ultrathink_uplift", outcome: "error" })).toBe(1);
	});

	test("a planner that throws is an engine_error tool result and is logged by error class only, without message or stack", async () => {
		const planner = stubPlanner(true, {
			start: async () => {
				throw new Error("planner exploded");
			},
		});
		const h = harness({ deps: { planner } });
		const started = await callTool(h, "ultrathink_uplift", { prompt: "plan it" });
		expect(started.isError).toBe(true);
		expect(started.structuredContent.error).toBe("engine_error");
		const [logged] = logsOf(h, "tool_error");
		expect(logged?.tool).toBe("ultrathink_uplift");
		expect(logged?.error).toBe("Error");
		expect(logged?.stack).toBeUndefined();
		expect(JSON.stringify(h.logs)).not.toContain("planner exploded");
	});

	test("ultrathink_status asks the planner first and falls back to the journal", async () => {
		const planner = stubPlanner(true);
		const h = harness({ deps: { planner } });

		const plan = await callTool(h, "ultrathink_plan", { prompt: "plan the journal path" });
		expect(plan.isError).toBe(false);
		const journalId = String(plan.structuredContent.sessionId);

		const serverId = randomSessionId();
		planner.serverIds.add(serverId);
		const server = await callTool(h, "ultrathink_status", { sessionId: serverId });
		expect(server.structuredContent).toMatchObject({ sessionId: serverId, status: "running", pendingCount: 0 });

		const journal = await callTool(h, "ultrathink_status", { sessionId: journalId });
		expect(journal.structuredContent.status).toBe("needs-model");

		// A session the planner knows wins over a journal session with the same id.
		planner.serverIds.add(journalId);
		const shadowed = await callTool(h, "ultrathink_status", { sessionId: journalId });
		expect(shadowed.structuredContent.status).toBe("running");

		const bad = await callTool(h, "ultrathink_status", { sessionId: "../etc" });
		expect(bad.isError).toBe(true);
		expect(bad.structuredContent.error).toBe("invalid_session_id");
	});

	test("the five journal tools keep working next to the planner", async () => {
		const h = harness({ deps: { planner: stubPlanner(true) } });
		const plan = await callTool(h, "ultrathink_plan", { prompt: "plan the rollout" });
		expect(plan.isError).toBe(false);
		const sessionId = String(plan.structuredContent.sessionId);
		const pending = await callTool(h, "ultrathink_pending", { sessionId });
		expect(pending.isError).toBe(false);
		expect(Array.isArray(pending.structuredContent.pending) ? pending.structuredContent.pending.length : 0).toBeGreaterThan(0);
		expect(sample(h, "ultrathink_mcp_tool_calls_total", { tool: "ultrathink_plan", outcome: "ok" })).toBe(1);
	});
});

describe("plan metrics", () => {
	test("each finished plan is counted once, with tokens and cost, however often it is polled", async () => {
		const planner = stubPlanner(true);
		const h = harness({ deps: { planner } });
		const sessionId = randomSessionId();
		await callTool(h, "ultrathink_result", { sessionId });
		await callTool(h, "ultrathink_result", { sessionId });
		expect(sample(h, "ultrathink_plan_jobs_total", { status: "planned" })).toBe(1);
		expect(sample(h, "ultrathink_plan_tokens_total", { direction: "input" })).toBe(900);
		expect(sample(h, "ultrathink_plan_tokens_total", { direction: "output" })).toBe(450);
		expect(sample(h, "ultrathink_plan_cost_usd_total")).toBeCloseTo(0.02, 6);

		const other = randomSessionId();
		await callTool(h, "ultrathink_result", { sessionId: other });
		expect(sample(h, "ultrathink_plan_jobs_total", { status: "planned" })).toBe(2);
	});

	test("a running plan, and a plan from the client-driven loop, are not counted", async () => {
		const planner = stubPlanner(true, {
			result: async (input) => ({ ok: true, data: viewOf(String(input.sessionId), { status: "running", text: "still running" }) }),
		});
		const h = harness({ deps: { planner } });
		await callTool(h, "ultrathink_result", { sessionId: randomSessionId() });
		expect(sample(h, "ultrathink_plan_jobs_total")).toBeUndefined();

		const client = stubPlanner(true, { result: async (input) => ({ ok: true, data: viewOf(String(input.sessionId), { mode: "client", usage: undefined }) }) });
		const hc = harness({ deps: { planner: client } });
		await callTool(hc, "ultrathink_result", { sessionId: randomSessionId() });
		expect(sample(hc, "ultrathink_plan_jobs_total")).toBeUndefined();
	});

	test("a start that already finished is counted from its finished view", async () => {
		const planner = stubPlanner(true, {
			start: async (input) => ({ ok: true, data: { sessionId: String(input.sessionId), status: "planned" } }),
		});
		const h = harness({ deps: { planner } });
		const sessionId = randomSessionId();
		await callTool(h, "ultrathink_uplift", { prompt: "plan it", sessionId });
		expect(sample(h, "ultrathink_plan_jobs_total", { status: "planned" })).toBe(1);
		await callTool(h, "ultrathink_result", { sessionId });
		expect(sample(h, "ultrathink_plan_jobs_total", { status: "planned" })).toBe(1);
	});
});

describe("end to end with the real planner", () => {
	const PROMPT = "Build a small TypeScript CLI that converts CSV files to JSON with streaming support, tests and a README.";

	const UPLIFT = `<BUILD_PROMPT><ORIGINAL>${escapeXml(PROMPT)}</ORIGINAL><SYSTEM_ROLE>Senior TypeScript engineer.</SYSTEM_ROLE><APP_CONTEXT>A standalone CLI.</APP_CONTEXT><SCOPE>CSV to JSON with streaming.</SCOPE><CONSTRAINTS>Do not invent repo facts.</CONSTRAINTS><ACCEPTANCE_CRITERIA>Converts a 1 GB file in bounded memory.</ACCEPTANCE_CRITERIA><OUT_OF_SCOPE>XLSX input.</OUT_OF_SCOPE></BUILD_PROMPT>`;

	const GRAPH = JSON.stringify({
		goal: "Ship a streaming CSV to JSON CLI",
		nodes: [
			{ id: "n1", title: "Understand the request", kind: "understand", question: "What exactly must the CLI do?", depends_on: [] },
			{ id: "n2", title: "Parser design", kind: "decompose", question: "How is CSV parsed as a stream?", depends_on: ["n1"] },
			{ id: "n3", title: "CLI surface", kind: "generate", question: "What flags and outputs does the CLI expose?", depends_on: ["n1"] },
			{ id: "n4", title: "Gaps and risks", kind: "critique", question: "What is missing or ambiguous?", depends_on: ["n2", "n3"] },
			{ id: "n5", title: "Execution plan", kind: "synthesize", question: "What is the ordered wave plan?", depends_on: ["n4"] },
		],
	});

	const NODE = (id: string, kind: string): string => {
		const steps = Array.from({ length: 8 }, (_, i) => `${i + 1}. Step ${i + 1} of ${id}: a discrete, self-contained action.`).join("\n");
		let conclusion = `Answer for ${id}.`;
		if (kind === "critique") conclusion += "\nOpen questions:\n- Output as JSON lines or array? Default: array.";
		if (kind === "synthesize") conclusion += "\nWORKFLOW\nWave 1 (parallel): parser — files: src/parse.ts — done when: unit tests pass\nWave 1 (parallel): cli — files: src/cli.ts — done when: --help prints\nWave 2: docs — files: README.md — done when: README lists flags\nVerify: bun test";
		return `<node><rationale>\n${steps}\n</rationale><conclusion>${conclusion}</conclusion></node>`;
	};

	const CLARIFY = JSON.stringify({
		questions: [{ id: "q1", question: "Should output be a JSON array or JSON lines?", header: "Output", why: "Changes the writer.", options: [{ label: "JSON array", description: "Standard" }, { label: "JSON lines", description: "Streamable" }], default: "JSON array", blocking: false }],
	});

	function answerFor(system: string, user: string): string {
		if (system === UPLIFT_SYSTEM_PROMPT) return UPLIFT;
		if (system === GRAPH_SYSTEM_PROMPT) return GRAPH;
		if (system === COT_SYSTEM_PROMPT) {
			const match = user.match(/<current_node id="([^"]+)" kind="([^"]+)"/);
			return NODE(match?.[1] ?? "n?", match?.[2] ?? "generate");
		}
		if (stageOf(system) === "clarify") return CLARIFY;
		throw new Error(`unexpected request: ${system.slice(0, 40)}`);
	}

	// Waits end only when their signal aborts, so nothing really waits and no timeout can fire.
	const sleepUntilAborted = (_ms: number, signal?: AbortSignal): Promise<void> => {
		const { promise, resolve } = Promise.withResolvers<void>();
		if (signal?.aborted) resolve();
		else signal?.addEventListener("abort", () => resolve(), { once: true });
		return promise;
	};

	test("ultrathink_uplift runs the pipeline against the injected OpenRouter, and ultrathink_result returns the plan as text", async () => {
		const seen: Array<{ url: string; headers: Record<string, string> }> = [];
		const openRouter: OpenRouterFetch = async (url, init) => {
			seen.push({ url, headers: init.headers as Record<string, string> });
			const body = JSON.parse(String(init.body)) as { messages: Array<{ content: string }> };
			const content = answerFor(body.messages[0]?.content ?? "", body.messages[1]?.content ?? "");
			return new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 100, completion_tokens: 50, cost: 0.001 } }), { status: 200 });
		};
		const h = harness({
			config: { serverPlanning: true, planningModel: "x-ai/grok-test", openRouterApiKey: FAKE_KEY },
			deps: { fetch: openRouter, sleep: sleepUntilAborted },
		});
		expect(await toolNames(h)).toContain("ultrathink_uplift");

		const started = await callTool(h, "ultrathink_uplift", { prompt: PROMPT });
		expect(started.isError).toBe(false);
		expect(started.structuredContent.status).toBe("planned");
		const sessionId = String(started.structuredContent.sessionId);
		expect(sessionId).toMatch(UUID_PATTERN);

		const result = await callTool(h, "ultrathink_result", { sessionId, waitSeconds: 0 });
		expect(result.isError).toBe(false);
		expect(result.structuredContent).toMatchObject({ sessionId, status: "planned", mode: "server" });
		const text = result.content[0]?.text ?? "";
		// Claude Code shows the model structuredContent instead of content, so the plan text must be in both.
		expect(result.structuredContent.text).toBe(text);
		expect(result.structuredContent.graph).toBeDefined();
		expect(text).toContain(PROMPT);
		expect(text).toContain("Should output be a JSON array or JSON lines?");
		expect(text).not.toContain("TodoWrite");
		const questions = result.structuredContent.questions as Array<{ question: string }>;
		expect(questions.map((question) => question.question)).toContain("Should output be a JSON array or JSON lines?");

		const calls = seen.length;
		expect(calls).toBeGreaterThanOrEqual(8);
		for (const call of seen) {
			expect(call.url).toBe("https://openrouter.test/api/v1/chat/completions");
			expect(call.headers.Authorization).toBe(`Bearer ${FAKE_KEY}`);
		}
		expect(result.structuredContent.usage).toMatchObject({ calls, inputTokens: 100 * calls, outputTokens: 50 * calls });

		// The plan is counted once from the start window and not again on the poll.
		expect(sample(h, "ultrathink_plan_jobs_total", { status: "planned" })).toBe(1);
		expect(sample(h, "ultrathink_plan_tokens_total", { direction: "input" })).toBe(100 * calls);
		expect(sample(h, "ultrathink_mcp_tool_calls_total", { tool: "ultrathink_uplift", outcome: "ok" })).toBe(1);

		// Neither the key nor the prompt text reaches the logs or the metrics.
		const logText = JSON.stringify(h.logs);
		expect(logText).not.toContain(FAKE_KEY);
		expect(logText).not.toContain(PROMPT);
		expect(h.app.metrics.render()).not.toContain(FAKE_KEY);

		// One planner_call line per model call: no prompt, no text, no secret, and both metrics agree with the log.
		const callLogs = logsOf(h, "planner_call");
		expect(callLogs).toHaveLength(calls);
		for (const line of callLogs) {
			expect(line).toMatchObject({ level: "info", sessionId, model: "x-ai/grok-test", attempts: 1, usage: { input: 100, output: 50 } });
			expect(typeof line.ms).toBe("number");
			expect(typeof line.outcome).toBe("string");
			expect(Object.keys(line).sort()).toEqual(["attempts", "event", "level", "model", "ms", "outcome", "reqId", "sessionId", "spanId", "traceId", "ts", "usage"]);
		}
		const outcome = String(callLogs[0]?.outcome);
		expect(sample(h, "ultrathink_planner_calls_total", { outcome })).toBe(calls);
		expect(sample(h, "ultrathink_planner_call_duration_seconds_count", { outcome })).toBe(calls);
		expect(h.app.metrics.render()).toContain("# TYPE ultrathink_planner_call_duration_seconds histogram");

		// The same session through ultrathink_status is a server job.
		const status = await callTool(h, "ultrathink_status", { sessionId });
		expect(status.structuredContent).toMatchObject({ sessionId, status: "planned" });

		// The graph tool draws the same finished server job; reading it again does not count the plan twice.
		const graph = await callTool(h, "ultrathink_graph", { sessionId });
		expect(graph.isError).toBe(false);
		expect(graph.structuredContent).toMatchObject({ sessionId, status: "planned", mode: "server" });
		expect(graph.content[0]?.text).toContain("```mermaid");
		expect(graph.structuredContent.text).toBe(graph.content[0]?.text);
		expect(sample(h, "ultrathink_plan_jobs_total", { status: "planned" })).toBe(1);

		await h.app.shutdown();
	});
});

describe("command surface", () => {
	const GRAPH = {
		goal: "Ship the CSV converter",
		nodes: [
			{ id: "n1", title: "Understand", kind: "understand", question: "What is asked?", dependsOn: [] as string[], thinking: "1. Read it.\n2. Restate it.", conclusion: "A converter." },
			{ id: "n2", title: "Parser", kind: "decompose", question: "How is CSV parsed?", dependsOn: ["n1"], thinking: "1. Stream rows.", conclusion: "Streaming parser." },
			{ id: "n3", title: "Plan", kind: "synthesize", question: "What is the order?", dependsOn: ["n2"], thinking: "1. Parse, then write.", conclusion: "Two waves." },
		],
	} satisfies NonNullable<SessionRecord["graph"]>;

	/** A finished client-driven session on disk, as the grok-bot adapter leaves it. */
	function seedPlanned(h: Harness): string {
		const sessionId = randomSessionId();
		writeMeta(journalDir(h.dir, sessionId), { sessionId, original: "Build the converter", status: "planned" });
		writeSession(h.dir, {
			sessionId,
			at: Date.now(),
			result: { xml: "<BUILD_PROMPT><ORIGINAL>Build the converter</ORIGINAL></BUILD_PROMPT>", original: "Build the converter", root: "BUILD_PROMPT", source: "llm" },
			graph: GRAPH,
		});
		return sessionId;
	}

	async function call<T>(h: Harness, method: string, params?: unknown): Promise<{ result?: T; error?: { code: number; message: string } }> {
		const response = await rpc(h, { jsonrpc: "2.0", id: 1, method, ...(params === undefined ? {} : { params }) });
		expect(response.status).toBe(200);
		return json(response);
	}

	test("initialize announces resources and the UI extension, and the instructions map the slash commands", async () => {
		for (const planner of [stubPlanner(true), stubPlanner(false)]) {
			const h = harness({ deps: { planner } });
			const { result } = await call<{ capabilities: Json; instructions: string }>(h, "initialize", { protocolVersion: "2025-11-25" });
			expect(result?.capabilities).toEqual({ tools: {}, prompts: {}, resources: {}, extensions: { "io.modelcontextprotocol/ui": {} } });
			const instructions = result?.instructions ?? "";
			expect(instructions.length).toBeLessThanOrEqual(3500);
			for (const phrase of ["/ultrathink-think", "ultrathink_graph", "ultrathink_sessions", "ultrathink_command", "/ultrathink-quick"]) {
				expect(instructions).toContain(phrase);
			}
			expect(instructions.includes("ultrathink_uplift")).toBe(planner.enabled);
		}
	});

	test("tools/list carries the UI resource on ultrathink_uplift and ultrathink_graph and lists the same connector tools in both modes", async () => {
		const server = harness({ deps: { planner: stubPlanner(true) } });
		const { result } = await call<{ tools: Array<{ name: string; _meta?: Json }> }>(server, "tools/list");
		const tools = result?.tools ?? [];
		expect(tools).toHaveLength(10);
		const withUi = tools.filter((tool) => tool._meta?.ui !== undefined).map((tool) => tool.name);
		expect(withUi).toEqual(["ultrathink_uplift", "ultrathink_graph"]);
		expect(tools.find((tool) => tool.name === "ultrathink_graph")?._meta).toEqual({
			ui: { resourceUri: "ui://ultrathink/graph" },
			"ui/resourceUri": "ui://ultrathink/graph",
			"anthropic/maxResultSizeChars": 200000,
		});
		const client = harness();
		expect((await toolNames(client)).filter((name) => ["ultrathink_graph", "ultrathink_sessions", "ultrathink_command"].includes(name))).toHaveLength(3);
	});

	test("prompts/list lists the supported commands and prompts/get answers all of them, unsupported ones with the reason", async () => {
		const h = harness();
		const { result } = await call<{ prompts: Array<{ name: string }> }>(h, "prompts/list");
		expect(result?.prompts.map((prompt) => prompt.name)).toEqual(["ultrathink", "ultrathink-plan", "ultrathink-think", "ultrathink-last", "ultrathink-status", "ultrathink-quick"]);

		const quick = await call<{ messages: Array<{ content: { text: string } }> }>(h, "prompts/get", { name: "ultrathink-quick", arguments: { message: "what is 2+2" } });
		expect(quick.result?.messages[0]?.content.text.endsWith("\nwhat is 2+2")).toBe(true);

		const unsupported = await call<{ messages: Array<{ content: { text: string } }> }>(h, "prompts/get", { name: "ultrathink-ship" });
		expect(unsupported.error).toBeUndefined();
		expect(unsupported.result?.messages[0]?.content.text).toContain("does not support");

		const missing = await call(h, "prompts/get", { name: "ultrathink-nope" });
		expect(missing.error?.code).toBe(-32602);
	});

	test("resources serve the graph app with the MCP Apps mime type, and an unknown uri is -32002", async () => {
		const h = harness();
		const listed = await call<{ resources: Array<{ uri: string; mimeType: string; _meta: Json }> }>(h, "resources/list");
		expect(listed.result?.resources.map((resource) => [resource.uri, resource.mimeType])).toEqual([["ui://ultrathink/graph", "text/html;profile=mcp-app"]]);

		const read = await call<{ contents: Array<{ uri: string; mimeType: string; text: string; _meta: Json }> }>(h, "resources/read", { uri: "ui://ultrathink/graph" });
		const [contents] = read.result?.contents ?? [];
		expect(contents?.mimeType).toBe("text/html;profile=mcp-app");
		expect(contents?.text).toMatch(/^<!doctype html>/i);
		expect(contents?._meta).toEqual({ ui: { csp: {}, prefersBorder: false } });

		expect((await call(h, "resources/read", { uri: "ui://ultrathink/other" })).error?.code).toBe(-32002);
		expect((await call(h, "resources/read", { uri: 5 })).error?.code).toBe(-32602);
		expect((await call<{ resourceTemplates: unknown[] }>(h, "resources/templates/list")).result?.resourceTemplates).toEqual([]);
	});

	test("prompts/list and resources/list without credentials are still 401", async () => {
		const h = harness();
		for (const method of ["prompts/list", "resources/list", "resources/read"]) {
			const response = await h.app.handle(
				new Request(RESOURCE, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { uri: "ui://ultrathink/graph" } }) }),
				PEER,
			);
			expect(response.status).toBe(401);
			expect(response.headers.get("www-authenticate")).toContain("resource_metadata=");
		}
	});

	test("ultrathink_sessions lists a client-driven session started over the wire", async () => {
		const h = harness();
		const plan = await callTool(h, "ultrathink_plan", { prompt: "plan the sessions listing" });
		const sessionId = String(plan.structuredContent.sessionId);
		const sessions = await callTool(h, "ultrathink_sessions", {});
		expect(sessions.isError).toBe(false);
		expect(sessions.structuredContent.planning).toEqual({ serverPlanning: false });
		expect(sessions.structuredContent.sessions).toMatchObject([{ sessionId, status: "running", mode: "client", hasGraph: false }]);
		expect(sessions.content[0]?.text).toContain(sessionId);
		expect(sessions.structuredContent.text).toBe(sessions.content[0]?.text);
		expect(sample(h, "ultrathink_mcp_tool_calls_total", { tool: "ultrathink_sessions", outcome: "ok" })).toBe(1);
	});

	test("ultrathink_sessions reports the server planning mode, ceilings and today's usage", async () => {
		const h = harness({ config: { planningModel: "x-ai/grok-test" }, deps: { planner: stubPlanner(true), now: () => Date.UTC(2026, 9, 19, 12) } });
		const sessions = await callTool(h, "ultrathink_sessions", { limit: 3 });
		expect(sessions.structuredContent.planning).toEqual({
			serverPlanning: true,
			model: "x-ai/grok-test",
			maxConcurrentPlans: 2,
			runTokenCeiling: 5_000_000,
			dailyTokenCeiling: 50_000_000,
			usedTodayTokens: 0,
		});
		expect(sessions.content[0]?.text).toContain("server planning");
	});

	test("ultrathink_graph draws a seeded planned session, and one node of it", async () => {
		const h = harness();
		const sessionId = seedPlanned(h);
		const graph = await callTool(h, "ultrathink_graph", {});
		expect(graph.isError).toBe(false);
		expect(graph.structuredContent).toMatchObject({ sessionId, status: "planned", mode: "client" });
		const text = graph.content[0]?.text ?? "";
		expect(text).toContain("```mermaid");
		expect(text).toContain("Wave 1");
		expect(graph.structuredContent.text).toBe(text);
		expect(graph.structuredContent.graph).toMatchObject({ version: 1, goal: "Ship the CSV converter", counts: { nodes: 3 } });

		const node = await callTool(h, "ultrathink_graph", { sessionId, node: "n2" });
		expect(node.content[0]?.text).toContain("Conclusion: Streaming parser.");

		const missing = await callTool(h, "ultrathink_graph", { sessionId, node: "n9" });
		expect(missing.isError).toBe(true);
		expect(missing.structuredContent.error).toBe("not_found");
		expect(sample(h, "ultrathink_mcp_tool_calls_total", { tool: "ultrathink_graph", outcome: "error" })).toBe(1);
	});

	test("ultrathink_command lists every command, runs think and returns the planning call", async () => {
		const h = harness();
		seedPlanned(h);
		const help = await callTool(h, "ultrathink_command", { command: "help" });
		expect(help.isError).toBe(false);
		expect(help.structuredContent.support).toBe("native");
		expect(help.content[0]?.text).toContain("/ultrathink-ship - unsupported");
		expect(help.structuredContent.text).toBe(help.content[0]?.text);

		const think = await callTool(h, "ultrathink_command", { command: "/ultrathink-think" });
		expect(think.structuredContent).toMatchObject({ command: "ultrathink-think", support: "native" });
		expect(think.content[0]?.text).toContain("```mermaid");

		const plan = await callTool(h, "ultrathink_command", { command: "ultrathink-plan", args: "plan the rollout" });
		expect(plan.structuredContent).toMatchObject({ support: "alias", next: { tool: "ultrathink_plan", arguments: { prompt: "plan the rollout" } } });

		const server = harness({ deps: { planner: stubPlanner(true) } });
		const serverPlan = await callTool(server, "ultrathink_command", { command: "ultrathink", args: "plan the rollout" });
		expect(serverPlan.structuredContent).toMatchObject({ support: "native", next: { tool: "ultrathink_uplift" } });

		const unsupported = await callTool(h, "ultrathink_command", { command: "ultrathink-ship" });
		expect(unsupported.structuredContent.support).toBe("unsupported");
		expect((await callTool(h, "ultrathink_command", { command: "nope" })).structuredContent.support).toBe("unknown");
		const refused = await callTool(h, "ultrathink_command", { command: 5 });
		expect(refused.isError).toBe(true);
		expect(refused.structuredContent.error).toBe("invalid_arguments");
		expect(refused.structuredContent.errors).toEqual([expect.stringContaining("arguments.command")]);
	});
});

describe("observability", () => {
	test("a request id is echoed, a hostile one is replaced, and the access log carries it", async () => {
		const h = harness();
		const echoed = await h.app.handle(new Request(`${ORIGIN}/healthz`, { headers: { "X-Request-Id": "client-id_1.2" } }), PEER);
		expect(echoed.headers.get("x-request-id")).toBe("client-id_1.2");

		const hostile = await h.app.handle(new Request(`${ORIGIN}/healthz`, { headers: { "X-Request-Id": "bad id\twith spaces" } }), PEER);
		const replaced = hostile.headers.get("x-request-id") ?? "";
		expect(replaced).not.toBe("bad id\twith spaces");
		expect(replaced).toMatch(/^[A-Za-z0-9._-]{1,64}$/);

		const generated = await h.app.handle(new Request(`${ORIGIN}/nope`), PEER);
		expect(generated.status).toBe(404);
		expect(generated.headers.get("x-request-id")).toMatch(/^[A-Za-z0-9._-]{1,64}$/);

		expect(logsOf(h, "request").map((line) => line.reqId)).toEqual(["client-id_1.2", replaced, generated.headers.get("x-request-id")]);
	});

	test("the access log has the documented shape and leaks neither the query string nor a secret", async () => {
		const h = harness();
		const response = await h.app.handle(
			mcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ultrathink_status", arguments: { sessionId: randomSessionId() } } }, { "X-Real-IP": "203.0.113.9" }, "/mcp?code=supersecretcode&state=abc"),
			PEER,
		);
		expect(response.status).toBe(200);
		const [line] = logsOf(h, "request");
		expect(line).toMatchObject({
			level: "info",
			event: "request",
			method: "POST",
			path: "/mcp",
			endpoint: "mcp",
			status: 200,
			rpcMethod: "tools/call",
			tool: "ultrathink_status",
			authKind: "connector-key",
			ip: "203.0.113.9",
		});
		expect(typeof line?.ms).toBe("number");
		expect(typeof line?.reqId).toBe("string");
		const text = JSON.stringify(h.logs);
		expect(text).not.toContain("supersecretcode");
		expect(text).not.toContain(CONNECTOR_KEY);
	});

	test("auth kinds in the log: none for an anonymous request, session for a logged-in owner", async () => {
		const h = harness();
		await h.app.handle(new Request(`${ORIGIN}/ultrathink`), PEER);
		const login = await h.app.handle(
			new Request(`${ORIGIN}/login`, { method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN }, body: JSON.stringify({ password: OWNER_PASSWORD }) }),
			PEER,
		);
		expect(login.status).toBe(200);
		const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
		const usage = await h.app.handle(new Request(`${ORIGIN}/ultrathink`, { headers: { Cookie: cookie } }), PEER);
		expect(usage.status).toBe(200);
		expect(logsOf(h, "request").map((line) => line.authKind)).toEqual(["none", "none", "session"]);
		expect(sample(h, "ultrathink_auth_failures_total", { kind: "session" })).toBe(1);
	});

	test("a failed login logs login_failed with the ip and counts an auth failure", async () => {
		const h = harness();
		const response = await h.app.handle(
			new Request(`${ORIGIN}/login`, { method: "POST", headers: { "Content-Type": "application/json", Origin: ORIGIN }, body: JSON.stringify({ password: "not-the-owner-password" }) }),
			"203.0.113.7",
		);
		expect(response.status).toBe(401);
		const [failed] = logsOf(h, "login_failed");
		expect(failed).toMatchObject({ level: "warn", ip: "203.0.113.7" });
		expect(JSON.stringify(h.logs)).not.toContain("not-the-owner-password");
		expect(sample(h, "ultrathink_auth_failures_total", { kind: "login" })).toBe(1);
	});

	test("the MCP rate limit answers 429, logs rate_limited with the ip and counts it", async () => {
		const h = harness();
		const ping = { jsonrpc: "2.0", id: 1, method: "ping" };
		for (let i = 0; i < 60; i += 1) expect((await rpc(h, ping)).status).toBe(200);
		const limited = await rpc(h, ping);
		expect(limited.status).toBe(429);
		expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
		const [line] = logsOf(h, "rate_limited");
		expect(line).toMatchObject({ ip: PEER, scope: "mcp" });
		expect(sample(h, "ultrathink_rate_limited_total", { scope: "mcp" })).toBe(1);
	});

	test("an unexpected error is a 500 with a correlationId, logged with the cause and a stack", async () => {
		const base = createAuth({ ownerPasswordHash: OWNER_HASH, sessionSecret: SESSION_SECRET, cookieSecure: true });
		const broken: Auth = {
			...base,
			sessionFor() {
				throw new Error("session store exploded");
			},
		};
		const h = harness({ auth: broken });
		const response = await h.app.handle(new Request(`${ORIGIN}/ultrathink`), PEER);
		expect(response.status).toBe(500);
		const body = await json<{ error: string; correlationId: string }>(response);
		expect(body.error).toBe("internal_error");
		const [logged] = logsOf(h, "request_error");
		expect(logged?.correlationId).toBe(body.correlationId);
		expect(logged?.reqId).toBe(response.headers.get("x-request-id"));
		const error = logged?.error as { name: string; message: string; stack?: string };
		expect(error.name).toBe("Error");
		expect(error.message).toBe("session store exploded");
		expect(typeof error.stack).toBe("string");
		expect(logsOf(h, "request")[0]).toMatchObject({ status: 500, level: "warn" });
		expect(sample(h, "ultrathink_http_requests_total", { endpoint: "ultrathink", status_class: "5xx" })).toBe(1);
	});

	test("a persistence failure is a 503 whose correlationId is in the log", async () => {
		const h = harness();
		h.store.close();
		const response = await h.app.handle(new Request(`${ORIGIN}/healthz`), PEER);
		expect(response.status).toBe(503);
		const body = await json<{ error: string; correlationId: string }>(response);
		expect(body.error).toBe("persistence_unavailable");
		expect(logsOf(h, "persistence_unavailable")[0]?.correlationId).toBe(body.correlationId);
	});

	test("a tool that throws is answered with engine_error and logged as tool_error with the error class and a correlationId, never the message", async () => {
		const planner = stubPlanner(true, {
			start: async (input) => {
				throw new Error(String(input.prompt));
			},
		});
		const h = harness({ deps: { planner } });
		const result = await callTool(h, "ultrathink_uplift", { prompt: "SECRET-PROMPT" });
		expect(result.isError).toBe(true);
		expect(result.structuredContent.error).toBe("engine_error");
		const [line] = logsOf(h, "tool_error");
		expect(line).toMatchObject({ level: "error", tool: "ultrathink_uplift", error: "Error" });
		expect(line?.correlationId).toMatch(UUID_PATTERN);
		expect(line?.stack).toBeUndefined();
		expect(JSON.stringify(h.logs)).not.toContain("SECRET-PROMPT");
		expect(sample(h, "ultrathink_mcp_tool_calls_total", { tool: "ultrathink_uplift", outcome: "error" })).toBe(1);
	});
});

describe("readiness and metrics endpoints", () => {
	test("/readyz is 200 with every check true and no paths", async () => {
		const h = harness();
		const response = await h.app.handle(new Request(`${ORIGIN}/readyz`), PEER);
		expect(response.status).toBe(200);
		const text = await response.text();
		expect(JSON.parse(text)).toEqual({
			status: "ready",
			checks: { store: true, stateDir: true, oauth: true, planner: true, integrity: true, draining: true },
			upstream: { state: "closed" },
		});
		expect(text).not.toContain(h.dir);
	});

	test("/readyz is 503 and names the failed check when the store, the state directory or the planner is unavailable", async () => {
		const closed = harness();
		closed.store.close();
		const storeDown = await closed.app.handle(new Request(`${ORIGIN}/readyz`), PEER);
		expect(storeDown.status).toBe(503);
		expect((await json<{ failed: string[] }>(storeDown)).failed).toEqual(["store"]);
		expect((await closed.app.handle(new Request(`${ORIGIN}/healthz`), PEER)).status).toBe(503);

		const stateDir = join(tmp(), "state");
		mkdirSync(stateDir);
		const missing = harness({ config: { stateDir, dbPath: join(tmp(), "ultrathink.db") } });
		rmSync(stateDir, { recursive: true, force: true });
		const dirDown = await missing.app.handle(new Request(`${ORIGIN}/readyz`), PEER);
		expect(dirDown.status).toBe(503);
		const dirText = await dirDown.text();
		const dirBody: { failed: string[] } = JSON.parse(dirText);
		expect(dirBody.failed).toContain("stateDir");
		expect(dirText).not.toContain(stateDir);

		// An enabled planner without its model or key cannot do work.
		const unconfigured = harness({ deps: { planner: stubPlanner(true) } });
		const plannerDown = await unconfigured.app.handle(new Request(`${ORIGIN}/readyz`), PEER);
		expect(plannerDown.status).toBe(503);
		expect((await json<{ failed: string[] }>(plannerDown)).failed).toEqual(["planner"]);
	});

	test("/metrics answers a loopback peer with Prometheus text and refuses everything else with 404", async () => {
		const h = harness();
		await h.app.handle(new Request(`${ORIGIN}/healthz`), PEER);
		await h.app.handle(new Request(`${ORIGIN}/nope`), PEER);

		const ok = await h.app.handle(new Request(`${ORIGIN}/metrics`), PEER);
		expect(ok.status).toBe(200);
		expect(ok.headers.get("content-type") ?? "").toContain("text/plain; version=0.0.4");
		const text = await ok.text();
		expect(text).toContain("# TYPE ultrathink_http_requests_total counter");
		expect(text).toContain("# TYPE ultrathink_http_request_duration_seconds histogram");
		expect(sample(h, "ultrathink_http_requests_total", { endpoint: "healthz", status_class: "2xx" })).toBe(1);
		expect(sample(h, "ultrathink_http_requests_total", { endpoint: "not_found", status_class: "4xx" })).toBe(1);
		expect(sample(h, "ultrathink_planner_enabled")).toBe(0);
		expect(sample(h, "ultrathink_build_info", { version: pkg.version })).toBe(1);

		for (const peer of ["203.0.113.5", "10.0.0.1"]) {
			expect((await h.app.handle(new Request(`${ORIGIN}/metrics`), peer)).status).toBe(404);
		}
		for (const header of ["X-Forwarded-For", "X-Real-IP"]) {
			const proxied = await h.app.handle(new Request(`${ORIGIN}/metrics`, { headers: { [header]: "203.0.113.5" } }), PEER);
			expect(proxied.status).toBe(404);
		}
		expect((await h.app.handle(new Request(`${ORIGIN}/metrics`, { method: "POST" }), PEER)).status).toBe(405);
	});
});

describe("HEAD requests", () => {
	test("HEAD answers with the GET status and headers and no body on every GET endpoint, and 405 elsewhere", async () => {
		const h = harness();
		const paths = [
			"/healthz",
			"/readyz",
			"/metrics",
			"/ultrathink",
			"/ultrathink/runs/no-such-run",
			"/.well-known/oauth-protected-resource",
			"/.well-known/oauth-authorization-server",
			"/oauth/authorize",
		];
		for (const path of paths) {
			const get = await h.app.handle(new Request(`${ORIGIN}${path}`), PEER);
			const head = await h.app.handle(new Request(`${ORIGIN}${path}`, { method: "HEAD" }), PEER);
			expect({ path, status: head.status }).toEqual({ path, status: get.status });
			expect({ path, type: head.headers.get("content-type") }).toEqual({ path, type: get.headers.get("content-type") });
			expect({ path, body: await head.text() }).toEqual({ path, body: "" });
		}
		expect(logsOf(h, "request").filter((line) => line.method === "HEAD")).toHaveLength(paths.length);

		for (const path of ["/login", "/mcp", "/oauth/token", "/oauth/register", "/oauth/revoke"]) {
			const refused = await h.app.handle(new Request(`${ORIGIN}${path}`, { method: "HEAD" }), PEER);
			expect({ path, status: refused.status }).toEqual({ path, status: 405 });
			expect(refused.headers.get("allow")).toBe("POST");
		}
		const post = await h.app.handle(new Request(`${ORIGIN}/readyz`, { method: "POST" }), PEER);
		expect(post.status).toBe(405);
		expect(post.headers.get("allow")).toBe("GET, HEAD");
	});
});

describe("app lifecycle", () => {
	test("shutdown stops the planner, and createHandler-style use needs no planner of its own", async () => {
		const planner = stubPlanner(true);
		const h = harness({ deps: { planner } });
		await h.app.shutdown();
		expect(planner.shutdowns).toBe(1);
		expect(h.app.planner).toBe(planner);

		const own = harness();
		await own.app.shutdown();
	});
});

describe("hardening wiring", () => {
	const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
	const PARENT_SPAN = "00f067aa0ba902b7";
	const TRACEPARENT = /^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/;

	function loginRequest(password: string): Request {
		return new Request(`${ORIGIN}/login`, {
			method: "POST",
			headers: { "Content-Type": "application/json", Origin: ORIGIN },
			body: JSON.stringify({ password }),
		});
	}

	function auditRecords(dir: string): Array<{ event: string; fields: Record<string, unknown> }> {
		return readFileSync(auditPath(dir), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
	}

	test("POST /ultrathink/logout needs the publicOrigin, clears the cookie with or without a session, and records a presented session", async () => {
		const h = harness();
		const login = await h.app.handle(loginRequest(OWNER_PASSWORD), PEER);
		expect(login.status).toBe(200);
		const session = (login.headers.get("set-cookie") ?? "").split(";")[0] ?? "";

		const foreign = await h.app.handle(
			new Request(`${ORIGIN}/ultrathink/logout`, { method: "POST", headers: { Origin: "https://evil.test", Cookie: session } }),
			PEER,
		);
		expect(foreign.status).toBe(403);
		expect(await json<Json>(foreign)).toEqual({ error: "forbidden" });

		const out = await h.app.handle(new Request(`${ORIGIN}/ultrathink/logout`, { method: "POST", headers: { Origin: ORIGIN, Cookie: session } }), PEER);
		expect(out.status).toBe(200);
		expect(await json<Json>(out)).toEqual({ ok: true });
		const cleared = out.headers.get("set-cookie") ?? "";
		expect(cleared.startsWith("__Host-ut_session=;")).toBe(true);
		expect(cleared).toContain("Max-Age=0");

		const bare = await h.app.handle(new Request(`${ORIGIN}/ultrathink/logout`, { method: "POST", headers: { Origin: ORIGIN } }), PEER);
		expect(bare.status).toBe(200);
		expect(bare.headers.get("set-cookie") ?? "").toContain("Max-Age=0");
		// The old path is not routed; nginx only forwards /ultrathink, so /logout is an unknown path.
		expect((await h.app.handle(new Request(`${ORIGIN}/logout`, { method: "POST", headers: { Origin: ORIGIN } }), PEER)).status).toBe(404);
		expect(auditRecords(h.dir).map((record) => record.event)).toEqual(["login_ok", "logout"]);
	});

	test("every dropped audit record is counted, and the failure is logged once per distinct message", async () => {
		const h = harness();
		// Closing the audit log makes every later record a drop.
		await h.app.shutdown();
		for (let attempt = 0; attempt < 3; attempt += 1) {
			expect((await h.app.handle(loginRequest("wrong-password"), PEER)).status).toBe(401);
		}
		expect(sample(h, "ultrathink_audit_write_failures_total")).toBe(3);
		expect(logsOf(h, "audit_write_failed")).toHaveLength(1);
	});

	test("an unsampled inbound traceparent stays unsampled: echoed as -00 and seen by the request context", async () => {
		const seen: Array<RequestContext | undefined> = [];
		const planner = stubPlanner(true, {
			result: async (input) => {
				seen.push(currentRequestContext());
				return { ok: true, data: viewOf(String(input.sessionId)) };
			},
		});
		const h = harness({ deps: { planner } });
		const resultCall = {
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name: "ultrathink_result", arguments: { sessionId: randomSessionId(), waitSeconds: 0, detail: "full" } },
		};

		const unsampled = await rpc(h, resultCall, { traceparent: `00-${TRACE_ID}-${PARENT_SPAN}-00` });
		expect(unsampled.status).toBe(200);
		expect(unsampled.headers.get("traceparent")).toMatch(new RegExp(`^00-${TRACE_ID}-[0-9a-f]{16}-00$`));
		expect(seen[0]).toMatchObject({ traceId: TRACE_ID, sampled: false });

		const fresh = await rpc(h, resultCall);
		expect(fresh.headers.get("traceparent")).toMatch(/-01$/);
		expect(seen[1]).toMatchObject({ sampled: true });
	});

	test("a failed login is written to the audit log, which verifies, and auditLog off writes no file", async () => {
		const h = harness();
		const res = await h.app.handle(loginRequest("wrong-password"), PEER);
		expect(res.status).toBe(401);
		expect(verifyAuditFile(auditPath(h.dir))).toMatchObject({ ok: true, records: 1 });
		expect(auditRecords(h.dir)).toEqual([expect.objectContaining({ event: "login_failed", fields: { ip: PEER } })]);
		expect(readFileSync(auditPath(h.dir), "utf8")).not.toContain("wrong-password");

		const quiet = harness({ config: { auditLog: false } });
		expect((await quiet.app.handle(loginRequest("wrong-password"), PEER)).status).toBe(401);
		expect(existsSync(auditPath(quiet.dir))).toBe(false);
	});

	/**
	 * A sink that keeps every envelope it is handed. With `hold`, each send waits until `release()`, so a test can keep
	 * the tail queued while shutdown starts.
	 */
	function loopback(hold = false): { transport: SinkTransport; envelopes: SinkEnvelope[]; release: () => void } {
		const envelopes: SinkEnvelope[] = [];
		const gate = Promise.withResolvers<void>();
		if (!hold) gate.resolve();
		return {
			envelopes,
			release: () => gate.resolve(),
			transport: {
				name: "loopback",
				async send(batch) {
					await gate.promise;
					envelopes.push(...batch);
					return { ok: true };
				},
			},
		};
	}

	/** Timers the test fires by hand. The watch and the sweep register here instead of on the real clock. */
	function manualTimers(): { timers: NonNullable<RouterDeps["timers"]>; ticks: Array<{ ms: number; run: () => void }> } {
		const ticks: Array<{ ms: number; run: () => void }> = [];
		return {
			ticks,
			timers: {
				setInterval: (run, ms) => {
					ticks.push({ ms, run });
					return {};
				},
				clearInterval: () => undefined,
			},
		};
	}

	test("a burst of failed logins raises one anomaly record and one alert envelope, in that order", async () => {
		const sink = loopback();
		const h = harness({
			config: { auditRules: [{ name: "burst", event: "login_failed", count: 3, windowSec: 300, groupBy: "ip" }] },
			deps: { auditTransports: [sink.transport] },
		});
		for (let attempt = 0; attempt < 3; attempt += 1) {
			expect((await h.app.handle(loginRequest("wrong-password"), PEER)).status).toBe(401);
		}
		await h.app.shutdown();

		expect(auditRecords(h.dir).map((record) => record.event)).toEqual(["login_failed", "login_failed", "login_failed", "anomaly_detected"]);
		expect(auditRecords(h.dir)[3]).toMatchObject({ fields: { rule: "burst", key: PEER, count: 3, windowSec: 300 } });
		const audited = sink.envelopes.filter((envelope) => envelope.kind === "audit").map((envelope) => envelope.body.event);
		expect(audited).toEqual(["login_failed", "login_failed", "login_failed", "anomaly_detected"]);
		const alerts = sink.envelopes.filter((envelope) => envelope.kind === "alert");
		expect(alerts).toEqual([expect.objectContaining({ body: expect.objectContaining({ event: "anomaly_detected", rule: "burst", key: PEER }) })]);
	});

	test("truncating the audit file raises a tamper alert on the next watch tick", async () => {
		const sink = loopback();
		const clock = manualTimers();
		const h = harness({ deps: { auditTransports: [sink.transport], timers: clock.timers } });
		h.app.start();
		await h.app.handle(loginRequest("wrong-password"), PEER);
		await h.app.handle(loginRequest("wrong-password"), PEER);
		const [first] = readFileSync(auditPath(h.dir), "utf8").split("\n");
		writeFileSync(auditPath(h.dir), `${first}\n`);

		const watch = clock.ticks.find((tick) => tick.ms === h.config.auditWatchMs);
		expect(watch).toBeDefined();
		watch?.run();
		await h.app.shutdown();

		const alerts = sink.envelopes.filter((envelope) => envelope.kind === "alert");
		expect(alerts).toEqual([expect.objectContaining({ body: expect.objectContaining({ event: "audit_tamper_detected" }) })]);
	});

	test("a login failure reaches the security stream, and the envelope carries no details", async () => {
		const sink = loopback();
		const h = harness({ deps: { auditTransports: [sink.transport] } });
		expect((await h.app.handle(loginRequest("wrong-password"), PEER)).status).toBe(401);
		await h.app.shutdown();

		const security = sink.envelopes.filter((envelope) => envelope.kind === "security");
		expect(security).toEqual([expect.objectContaining({ body: expect.objectContaining({ type: "auth_failure", name: "auth.login_failed", ip: PEER }) })]);
		expect(security[0]?.body).not.toHaveProperty("details");
	});

	test("records still queued when shutdown starts are delivered before shutdown returns", async () => {
		const sink = loopback(true);
		const h = harness({ deps: { auditTransports: [sink.transport] } });
		expect((await h.app.handle(loginRequest("wrong-password"), PEER)).status).toBe(401);
		expect((await h.app.handle(loginRequest("wrong-password"), PEER)).status).toBe(401);
		const closing = h.app.shutdown();
		sink.release();
		await closing;

		expect(sink.envelopes.filter((envelope) => envelope.kind === "audit")).toHaveLength(2);
		expect(sink.envelopes.filter((envelope) => envelope.kind === "security")).toHaveLength(2);
	});

	test("with auditLog off no audit file is written, and the security stream still runs", async () => {
		const sink = loopback();
		const h = harness({ config: { auditLog: false }, deps: { auditTransports: [sink.transport] } });
		h.app.start();
		expect((await h.app.handle(loginRequest("wrong-password"), PEER)).status).toBe(401);
		await h.app.shutdown();

		expect(existsSync(auditPath(h.dir))).toBe(false);
		expect(sink.envelopes.map((envelope) => envelope.kind)).toEqual(["security"]);
	});

	test("past maxInflight a request is refused with 503 and Retry-After, while /healthz still answers", async () => {
		const reached = Promise.withResolvers<void>();
		const planner = stubPlanner(true, {
			result: () => {
				reached.resolve();
				return new Promise<never>(() => undefined);
			},
		});
		const h = harness({ config: { maxInflight: 1 }, deps: { planner } });
		// Never settles, so it holds the only slot.
		void rpc(h, {
			jsonrpc: "2.0",
			id: 1,
			method: "tools/call",
			params: { name: "ultrathink_result", arguments: { sessionId: randomSessionId(), waitSeconds: 0, detail: "full" } },
		});
		// The held request reads its body under the slot, then reaches the planner. Wait for that, so the refusal below
		// happens while the slot is still held.
		await reached.promise;

		const refused = await h.app.handle(mcpRequest({ jsonrpc: "2.0", id: 2, method: "tools/list" }), PEER);
		expect(refused.status).toBe(503);
		expect(refused.headers.get("retry-after")).toBe("1");
		expect(await json<Json>(refused)).toEqual({ error: "overloaded" });
		expect(planner.results).toHaveLength(1);

		expect((await h.app.handle(new Request(`${ORIGIN}/healthz`), PEER)).status).toBe(200);
		expect(sample(h, "ultrathink_overload_total")).toBe(1);
		expect(sample(h, "ultrathink_http_inflight")).toBe(1);
	});

	test("beginDrain fails /readyz with draining while /healthz keeps answering", async () => {
		const h = harness();
		expect((await h.app.handle(new Request(`${ORIGIN}/readyz`), PEER)).status).toBe(200);
		h.app.beginDrain();
		h.app.beginDrain();
		const readyz = await h.app.handle(new Request(`${ORIGIN}/readyz`), PEER);
		expect(readyz.status).toBe(503);
		expect((await json<{ failed: string[] }>(readyz)).failed).toEqual(["draining"]);
		expect((await h.app.handle(new Request(`${ORIGIN}/healthz`), PEER)).status).toBe(200);
	});

	test("the breaker state is published as a gauge and reported by /readyz, and breakerFailures 0 omits it", async () => {
		const h = harness();
		expect(sample(h, "ultrathink_upstream_breaker_state", { state: "closed" })).toBe(1);
		expect(sample(h, "ultrathink_upstream_breaker_state", { state: "open" })).toBe(0);

		const off = harness({ config: { breakerFailures: 0 } });
		const body = await json<Json>(await off.app.handle(new Request(`${ORIGIN}/readyz`), PEER));
		expect(body).not.toHaveProperty("upstream");
	});

	test("an inbound traceparent is continued under a new span, and an invalid one starts a fresh trace", async () => {
		const h = harness();
		const inbound = `00-${TRACE_ID}-${PARENT_SPAN}-01`;
		const continued = await h.app.handle(new Request(`${ORIGIN}/healthz`, { headers: { traceparent: inbound } }), PEER);
		const echoed = continued.headers.get("traceparent") ?? "";
		expect(echoed).toMatch(TRACEPARENT);
		expect(echoed.split("-")[1]).toBe(TRACE_ID);
		expect(echoed.split("-")[2]).not.toBe(PARENT_SPAN);
		expect(logsOf(h, "request").at(-1)).toMatchObject({ traceId: TRACE_ID });

		const fresh = await h.app.handle(new Request(`${ORIGIN}/healthz`, { headers: { traceparent: "not-a-traceparent" } }), PEER);
		const started = fresh.headers.get("traceparent") ?? "";
		expect(started).toMatch(TRACEPARENT);
		expect(started.split("-")[1]).not.toBe(TRACE_ID);
	});

	test("start is idempotent and shutdown stops the probe and sweeper, so the process exits cleanly", async () => {
		const h = harness({ config: { retentionDays: 1 } });
		h.app.start();
		h.app.start();
		await h.app.shutdown();
		await h.app.shutdown();
	});
});
