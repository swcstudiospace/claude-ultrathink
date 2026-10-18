// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Auth, createAuth } from "../auth/auth.ts";
import type { UltrathinkConfig } from "../config/config.ts";
import { type Store, openStore } from "../store/store.ts";
import { createLogger } from "../obs/log.ts";
import { createHandler } from "./router.ts";

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
		serverDecisions: false,
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
	expect(cookie.startsWith("ut_session=")).toBe(true);
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

	test("tools/list returns the five journal tools and ultrathink_result when server planning is off", async () => {
		const list = await mcp(rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }), PEER_IP);
		const listBody = (await list.json()) as { result: { tools: { name: string }[] } };
		expect(listBody.result.tools.map((tool) => tool.name).sort()).toEqual([
			"ultrathink_answer",
			"ultrathink_pending",
			"ultrathink_plan",
			"ultrathink_result",
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
