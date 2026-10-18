// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { accessSync, constants } from "node:fs";
import { join } from "node:path";
import pkg from "../../../package.json";
import { type Auth, clientIpFrom } from "../auth/auth.ts";
import type { UltrathinkConfig } from "../config/config.ts";
import { type Ledger, createLedger } from "../cost/ledger.ts";
import { type HeadlessPlanner, type ResultView, createHeadlessPlanner } from "../engine/headless.ts";
import { type JournalOptions, type JournalResult, answerRequest, listPendingRequests, sessionStatus, showRequest, startPlan } from "../engine/journal.ts";
import type { OpenRouterFetch } from "../engine/openrouter.ts";
import { type McpToolHost, type ToolOutcome, handleMcpPayload } from "../mcp/mcp.ts";
import { DEFAULT_ALLOWED_ORIGINS, originAllowed, resolveProtocolVersion } from "../mcp/transport.ts";
import { type Logger, createLogger, newRequestId, sanitizeRequestId } from "../obs/log.ts";
import { type Metrics, createMetrics } from "../obs/metrics.ts";
import { DEFAULT_REDIRECT_ORIGINS, createOAuth } from "../oauth/oauth.ts";
import type { PhaseRecord, Run, Store } from "../store/store.ts";
import { ROUTES, type Route, parseRouteFlag, sanitizeInput, selectRoute } from "./input.ts";

export interface RouterDeps {
	config: UltrathinkConfig;
	store: Store;
	auth: Auth;
	now?: () => number;
	/** Defaults to the server-side planner, enabled iff config.serverPlanning. */
	planner?: HeadlessPlanner;
	/** Defaults to JSON lines on stdout. */
	logger?: Logger;
	metrics?: Metrics;
	/** Defaults to a ledger over the store with the configured ceilings. Used only by the default planner. */
	ledger?: Ledger;
	/** Reaches the default planner's OpenRouter completer. */
	fetch?: OpenRouterFetch;
	/** Reaches the default planner's waits. */
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface App {
	handle(req: Request, peerIp: string): Promise<Response>;
	/** Stops accepting planner work and ends running jobs. The caller closes the store. */
	shutdown(): Promise<void>;
	planner: HeadlessPlanner;
	metrics: Metrics;
	logger: Logger;
}

type Endpoint =
	| "healthz"
	| "readyz"
	| "metrics"
	| "login"
	| "ultrathink"
	| "run"
	| "mcp"
	| "oauth_protected_resource"
	| "oauth_authorization_server"
	| "oauth_authorize"
	| "oauth_token"
	| "oauth_register"
	| "oauth_revoke";

type Target = { endpoint: Exclude<Endpoint, "run"> } | { endpoint: "run"; runId: string };

type BodyRead = { ok: true; bytes: Uint8Array } | { ok: false; reason: "too_large" | "unreadable" };

type JsonRead = { ok: true; value: unknown } | { ok: false; response: Response };

type AuthKind = "connector-key" | "bearer" | "session" | "none";

/** What one request learns about itself on the way through, for the access log. */
interface RequestCtx {
	reqId: string;
	ip: string;
	peerIp: string;
	endpoint: Endpoint | "not_found";
	authKind: AuthKind;
	rpcMethod?: string;
	tool?: string;
}

const METHODS: Record<Endpoint, readonly string[]> = {
	healthz: ["GET"],
	readyz: ["GET"],
	metrics: ["GET"],
	login: ["POST"],
	ultrathink: ["GET", "POST"],
	run: ["GET"],
	mcp: ["POST"],
	oauth_protected_resource: ["GET"],
	oauth_authorization_server: ["GET"],
	oauth_authorize: ["GET", "POST"],
	oauth_token: ["POST"],
	oauth_register: ["POST"],
	oauth_revoke: ["POST"],
};

const RUN_PATH = /^\/ultrathink\/runs\/([^/]+)$/;

const CONNECTOR_RATE_OWNER = "connector";

const LOOPBACK_PEERS: Record<string, true> = { "127.0.0.1": true, "::1": true, "::ffff:127.0.0.1": true };

/** Finished plans remembered so each is counted once; the oldest are forgotten first. */
const COUNTED_PLANS_MAX = 2000;

const LOG_VALUE_MAX = 64;

const OAUTH_STATE_FILE = "oauth.json";

const SECURITY_HEADERS: Record<string, string> = {
	"Cache-Control": "no-store",
	"X-Content-Type-Options": "nosniff",
	"Referrer-Policy": "no-referrer",
};

const USAGE = {
	usage:
		'POST /ultrathink with Content-Type: application/json and JSON {"input": "<text>", "flags": {"route": "auto"}}. The route and its reason are returned before anything runs.',
	routes: ROUTES,
	flags: { route: ["auto", ...ROUTES] },
	examples: [
		"plan the rollout of the billing migration",
		"research options for a background job queue",
		"build a CLI scaffold for the importer",
	],
};

function respond(status: number, body: unknown, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { ...SECURITY_HEADERS, "Content-Type": "application/json; charset=utf-8", ...headers },
	});
}

function fail(status: number, code: string, headers: Record<string, string> = {}): Response {
	return respond(status, { error: code }, headers);
}

function runView(run: Run, phases: PhaseRecord[]): Record<string, unknown> {
	return {
		id: run.id,
		route: run.route,
		status: run.status,
		currentPhase: run.currentPhase,
		reason: run.reason,
		createdAt: run.createdAt,
		updatedAt: run.updatedAt,
		elapsedMs: Date.now() - run.createdAt,
		phases: phases.map((phase) => ({ phase: phase.phase, attempt: phase.attempt, status: phase.status })),
	};
}

function keyMatches(presented: string | null, expected: string): boolean {
	if (presented === null) return false;
	const left = createHash("sha256").update(presented).digest();
	const right = createHash("sha256").update(expected).digest();
	return timingSafeEqual(left, right);
}

function bearerFrom(req: Request): string {
	const match = /^Bearer\s+(\S+)$/i.exec(req.headers.get("authorization") ?? "");
	return match?.[1] ?? "";
}

function rpcError(code: number, message: string): unknown {
	return { jsonrpc: "2.0", id: null, error: { code, message } };
}

function toOutcome(result: JournalResult<unknown>): ToolOutcome {
	if (result.ok) return { ok: true, data: result.data as Record<string, unknown> };
	return { ok: false, code: result.code, ...(result.errors !== undefined ? { errors: result.errors } : {}) };
}

function matchPath(pathname: string): Target | null {
	if (pathname === "/healthz") return { endpoint: "healthz" };
	if (pathname === "/readyz") return { endpoint: "readyz" };
	if (pathname === "/metrics") return { endpoint: "metrics" };
	if (pathname === "/.well-known/oauth-protected-resource" || pathname === "/.well-known/oauth-protected-resource/mcp") {
		return { endpoint: "oauth_protected_resource" };
	}
	if (pathname === "/.well-known/oauth-authorization-server" || pathname === "/.well-known/openid-configuration") {
		return { endpoint: "oauth_authorization_server" };
	}
	if (pathname === "/oauth/authorize") return { endpoint: "oauth_authorize" };
	if (pathname === "/oauth/token") return { endpoint: "oauth_token" };
	if (pathname === "/oauth/register") return { endpoint: "oauth_register" };
	if (pathname === "/oauth/revoke") return { endpoint: "oauth_revoke" };
	if (pathname === "/login") return { endpoint: "login" };
	if (pathname === "/ultrathink") return { endpoint: "ultrathink" };
	if (pathname === "/mcp") return { endpoint: "mcp" };
	const match = RUN_PATH.exec(pathname);
	if (match?.[1]) return { endpoint: "run", runId: match[1] };
	return null;
}

function isJsonRequest(req: Request): boolean {
	const contentType = req.headers.get("content-type");
	if (contentType === null) return false;
	return contentType.split(";")[0]?.trim().toLowerCase() === "application/json";
}

async function readCapped(req: Request, maxBytes: number): Promise<BodyRead> {
	const declared = req.headers.get("content-length");
	if (declared !== null && Number(declared) > maxBytes) return { ok: false, reason: "too_large" };
	if (req.body === null) return { ok: true, bytes: new Uint8Array(0) };

	const reader = req.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const result = await reader.read();
			if (result.done) break;
			total += result.value.byteLength;
			if (total > maxBytes) {
				await reader.cancel().catch(() => undefined);
				return { ok: false, reason: "too_large" };
			}
			chunks.push(result.value);
		}
	} catch {
		return { ok: false, reason: "unreadable" };
	}

	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return { ok: true, bytes };
}

async function readJson(req: Request, maxBytes: number): Promise<JsonRead> {
	const read = await readCapped(req, maxBytes);
	if (!read.ok) {
		const response = read.reason === "too_large" ? fail(413, "body_too_large") : fail(400, "invalid_json");
		return { ok: false, response };
	}
	try {
		const text = new TextDecoder("utf-8", { fatal: true }).decode(read.bytes);
		return { ok: true, value: JSON.parse(text) };
	} catch {
		return { ok: false, response: fail(400, "invalid_json") };
	}
}

/**
 * Ledger whose schema is created on first use. Building the app then never touches the database, so an
 * unavailable store shows up in /readyz and per-request 503s instead of failing startup.
 */
function lazyLedger(store: Store, config: UltrathinkConfig, now: (() => number) | undefined): Ledger {
	let real: Ledger | undefined;
	const ledger = (): Ledger => {
		real ??= createLedger(store, { runTokenCeiling: config.runTokenCeiling, dailyTokenCeiling: config.dailyTokenCeiling }, now);
		return real;
	};
	return {
		reserve: (input) => ledger().reserve(input),
		settle: (id, tokens) => ledger().settle(id, tokens),
		abandon: (id) => ledger().abandon(id),
		spentForRun: (runId) => ledger().spentForRun(runId),
		spentForDay: (day) => ledger().spentForDay(day),
	};
}

export function createApp(deps: RouterDeps): App {
	const { config, store, auth } = deps;
	const logger = deps.logger ?? createLogger();
	const metrics = deps.metrics ?? createMetrics();
	const oauth = createOAuth({
		origin: config.publicOrigin,
		stateDir: config.stateDir,
		auth,
		now: deps.now,
		redirectOrigins: [...DEFAULT_REDIRECT_ORIGINS, ...config.oauthRedirectOrigins],
	});
	const planner =
		deps.planner ??
		createHeadlessPlanner({
			config,
			store,
			ledger: deps.ledger ?? lazyLedger(store, config, deps.now),
			now: deps.now,
			...(deps.fetch ? { fetch: deps.fetch } : {}),
			...(deps.sleep ? { sleep: deps.sleep } : {}),
			onCall: (call) => {
				metrics.inc("ultrathink_planner_calls_total", { outcome: call.outcome });
				metrics.observe("ultrathink_planner_call_duration_seconds", call.ms / 1000, { outcome: call.outcome });
				// The logger drops every key containing "token", so the counts travel under `usage`.
				logger.info("planner_call", {
					sessionId: call.sessionId,
					model: call.model,
					ms: call.ms,
					outcome: call.outcome,
					attempts: call.attempts,
					usage: { input: call.inputTokens, output: call.outputTokens, ...(call.costUsd === undefined ? {} : { costUsd: call.costUsd }) },
				});
			},
		});
	const allowedOrigins = [config.publicOrigin, ...DEFAULT_ALLOWED_ORIGINS, ...config.allowedOrigins];

	metrics.gauge("ultrathink_planner_enabled", planner.enabled ? 1 : 0);
	metrics.gauge("ultrathink_build_info", 1, { version: pkg.version });

	function persistenceUnavailable(ctx: RequestCtx, error?: unknown): Response {
		const correlationId = randomUUID();
		logger.error("persistence_unavailable", { reqId: ctx.reqId, correlationId, ...(error === undefined ? {} : { error }) });
		return respond(503, { error: "persistence_unavailable", correlationId });
	}

	function rateLimited(ctx: RequestCtx, scope: string, retryAfterSec: number): Response {
		metrics.inc("ultrathink_rate_limited_total", { scope });
		logger.warn("rate_limited", { reqId: ctx.reqId, ip: ctx.ip, scope });
		return fail(429, "rate_limited", { "Retry-After": String(retryAfterSec) });
	}

	function authFailed(kind: string): void {
		metrics.inc("ultrathink_auth_failures_total", { kind });
	}

	async function login(req: Request, ctx: RequestCtx): Promise<Response> {
		if (!isJsonRequest(req) || req.headers.get("origin") !== config.publicOrigin) {
			return fail(403, "forbidden");
		}
		const parsed = await readJson(req, config.maxBodyBytes);
		if (!parsed.ok) return parsed.response;
		const password = (parsed.value as { password?: unknown } | null)?.password;
		if (typeof password !== "string") return fail(400, "invalid_input");

		const result = await auth.login({ password, clientIp: ctx.ip });
		if (result.ok) return respond(200, { ok: true }, { "Set-Cookie": result.setCookie });
		if (result.reason === "rate_limited") return rateLimited(ctx, "login", result.retryAfterSec ?? 60);
		authFailed("login");
		logger.warn("login_failed", { reqId: ctx.reqId, ip: ctx.ip });
		return fail(401, "invalid_credentials");
	}

	function sessionFor(req: Request, ctx: RequestCtx): { ownerId: "owner" } | null {
		const session = auth.sessionFor(req);
		if (session) {
			ctx.authKind = "session";
			return session;
		}
		authFailed("session");
		return null;
	}

	async function usageRoute(req: Request, ctx: RequestCtx): Promise<Response> {
		if (!sessionFor(req, ctx)) return fail(401, "unauthenticated");
		return respond(200, USAGE);
	}

	async function createRunRoute(req: Request, ctx: RequestCtx): Promise<Response> {
		const session = sessionFor(req, ctx);
		if (!session) return fail(401, "unauthenticated");

		const limit = auth.allowRequest({ clientIp: ctx.ip, ownerId: session.ownerId });
		if (!limit.ok) return rateLimited(ctx, "run", limit.retryAfterSec);

		if (!isJsonRequest(req) || req.headers.get("origin") !== config.publicOrigin) {
			return fail(403, "forbidden");
		}

		const parsed = await readJson(req, config.maxBodyBytes);
		if (!parsed.ok) return parsed.response;
		if (typeof parsed.value !== "object" || parsed.value === null || Array.isArray(parsed.value)) {
			return fail(400, "invalid_input");
		}
		const body = parsed.value as { input?: unknown; flags?: unknown };

		const input = sanitizeInput(body.input, config.maxInputChars);
		if (!input.ok) {
			if (input.code === "empty") return respond(200, USAGE);
			if (input.code === "too_long") {
				return respond(413, { error: "input_too_long", maxChars: config.maxInputChars });
			}
			return fail(400, "invalid_input");
		}

		let explicitRoute: Route | undefined;
		if (body.flags !== undefined) {
			if (typeof body.flags !== "object" || body.flags === null || Array.isArray(body.flags)) {
				return fail(400, "invalid_input");
			}
			const flags = body.flags as { route?: unknown };
			if (Object.keys(flags).some((key) => key !== "route")) return fail(400, "unknown_flag");
			const flag = parseRouteFlag(flags.route);
			if (!flag.ok) return fail(400, flag.code);
			explicitRoute = flag.route;
		}
		const choice =
			explicitRoute !== undefined
				? { route: explicitRoute, reason: "route set by flag" }
				: selectRoute(input.text);

		let run: Run;
		try {
			run = store.createRun({ ownerId: session.ownerId, request: input.text, route: choice.route });
		} catch (error) {
			return persistenceUnavailable(ctx, error);
		}

		return respond(202, {
			runId: run.id,
			route: run.route,
			routeReason: choice.reason,
			status: run.status,
			statusUrl: `/ultrathink/runs/${run.id}`,
		});
	}

	async function getRunRoute(req: Request, ctx: RequestCtx, runId: string): Promise<Response> {
		const session = sessionFor(req, ctx);
		if (!session) return fail(401, "unauthenticated");

		let found: { run: Run; phases: PhaseRecord[] } | null;
		try {
			const run = store.getRunForOwner(runId, session.ownerId);
			found = run ? { run, phases: store.listPhases(run.id) } : null;
		} catch (error) {
			return persistenceUnavailable(ctx, error);
		}
		if (!found) return fail(404, "not_found");

		const { run, phases } = found;
		return respond(200, runView(run, phases));
	}

	function readyz(ctx: RequestCtx): Response {
		let storeOk = false;
		try {
			storeOk = store.ping();
		} catch {
			storeOk = false;
		}
		let stateDirOk = true;
		try {
			accessSync(config.stateDir, constants.W_OK | constants.X_OK);
		} catch {
			stateDirOk = false;
		}
		// A missing file is a fresh install; a file that exists must be readable.
		let oauthOk = true;
		try {
			accessSync(join(config.stateDir, OAUTH_STATE_FILE), constants.R_OK);
		} catch (error) {
			const code = error instanceof Error && "code" in error ? error.code : undefined;
			oauthOk = code === "ENOENT" && stateDirOk;
		}
		const plannerOk = !planner.enabled || (config.openRouterApiKey !== undefined && config.planningModel !== undefined);
		const checks = { store: storeOk, stateDir: stateDirOk, oauth: oauthOk, planner: plannerOk };
		const failed = Object.entries(checks)
			.filter(([, passed]) => !passed)
			.map(([name]) => name);
		if (failed.length === 0) return respond(200, { status: "ready", checks });
		logger.warn("not_ready", { reqId: ctx.reqId, failed });
		return respond(503, { error: "not_ready", failed, checks });
	}

	function metricsRoute(req: Request, ctx: RequestCtx): Response {
		// Loopback only, and never when a proxy has put a client address on the request.
		if (LOOPBACK_PEERS[ctx.peerIp] !== true || req.headers.has("x-forwarded-for") || req.headers.has("x-real-ip")) {
			return fail(404, "not_found");
		}
		return new Response(metrics.render(), {
			status: 200,
			headers: { ...SECURITY_HEADERS, "Content-Type": "text/plain; version=0.0.4; charset=utf-8" },
		});
	}

	const journalOpts: JournalOptions = {
		stateDir: config.stateDir,
		maxPromptChars: config.maxInputChars,
		maxAnswerChars: config.maxAnswerChars,
	};

	const countedPlans = new Set<string>();

	/** Counts a finished server plan once: the job, its tokens and its cost. */
	function recordFinished(view: ResultView): void {
		if (view.mode !== "server" || view.status === "running" || countedPlans.has(view.sessionId)) return;
		countedPlans.add(view.sessionId);
		if (countedPlans.size > COUNTED_PLANS_MAX) {
			const oldest = countedPlans.values().next().value;
			if (oldest !== undefined) countedPlans.delete(oldest);
		}
		metrics.inc("ultrathink_plan_jobs_total", { status: view.status });
		const { usage } = view;
		if (!usage) return;
		if (usage.inputTokens > 0) metrics.inc("ultrathink_plan_tokens_total", { direction: "input" }, usage.inputTokens);
		if (usage.outputTokens > 0) metrics.inc("ultrathink_plan_tokens_total", { direction: "output" }, usage.outputTokens);
		if (usage.costUsd !== undefined && usage.costUsd > 0) metrics.inc("ultrathink_plan_cost_usd_total", undefined, usage.costUsd);
	}

	async function runTool(name: string, args: Record<string, unknown>): Promise<ToolOutcome> {
		switch (name) {
			case "ultrathink_plan":
				return toOutcome(await startPlan(journalOpts, { prompt: args.prompt, sessionId: args.sessionId }));
			case "ultrathink_pending": {
				const pending = listPendingRequests(journalOpts, { sessionId: args.sessionId });
				return toOutcome(pending.ok ? { ok: true, data: { pending: pending.data } } : pending);
			}
			case "ultrathink_show":
				return toOutcome(showRequest(journalOpts, { sessionId: args.sessionId, key: args.key, part: args.part }));
			case "ultrathink_answer":
				return toOutcome(answerRequest(journalOpts, { sessionId: args.sessionId, key: args.key, answer: args.answer }));
			case "ultrathink_status": {
				const server = planner.status({ sessionId: args.sessionId });
				return toOutcome(server ?? sessionStatus(journalOpts, { sessionId: args.sessionId }));
			}
			case "ultrathink_uplift": {
				const started = await planner.start({ prompt: args.prompt, sessionId: args.sessionId });
				if (started.ok && started.data.status !== "running") {
					// The start view carries no usage; the finished view does.
					const finished = await planner.result({ sessionId: started.data.sessionId, waitSeconds: 0 });
					if (finished.ok) recordFinished(finished.data);
				}
				return toOutcome(started);
			}
			case "ultrathink_result": {
				const result = await planner.result({ sessionId: args.sessionId, waitSeconds: args.waitSeconds, detail: args.detail });
				if (!result.ok) return toOutcome(result);
				recordFinished(result.data);
				const { text, ...data } = result.data;
				return { ok: true, data, text };
			}
			default:
				return { ok: false, code: "unknown_tool" };
		}
	}

	const mcpHost: McpToolHost = {
		capabilities: () => ({ serverPlanning: planner.enabled }),
		async call(name, args) {
			let outcome: ToolOutcome;
			try {
				outcome = await runTool(name, args);
			} catch (error) {
				logger.error("tool_error", { tool: name, error });
				outcome = { ok: false, code: "engine_error" };
			}
			metrics.inc("ultrathink_mcp_tool_calls_total", { tool: name, outcome: outcome.ok ? "ok" : "error" });
			return outcome;
		},
	};

	function describeRpc(payload: unknown, ctx: RequestCtx): void {
		if (Array.isArray(payload)) {
			ctx.rpcMethod = "batch";
			return;
		}
		if (typeof payload !== "object" || payload === null) return;
		// Read for its log fields only; every field is checked before use and handleMcpPayload validates the message itself.
		const message = payload as { method?: unknown; params?: { name?: unknown } | null };
		if (typeof message.method !== "string") return;
		ctx.rpcMethod = message.method.slice(0, LOG_VALUE_MAX);
		if (message.method === "tools/call" && typeof message.params?.name === "string") {
			ctx.tool = message.params.name.slice(0, LOG_VALUE_MAX);
		}
	}

	async function mcpRoute(req: Request, ctx: RequestCtx): Promise<Response> {
		// A browser always sends an Origin; native and server-side clients send none.
		if (!originAllowed(req.headers.get("origin"), allowedOrigins)) return fail(403, "forbidden_origin");

		const presented = bearerFrom(req);
		const bearer = oauth.classifyBearer(presented === "" ? null : presented);
		const expectedKey = config.connectorKey;
		const presentedKey = req.headers.get("x-connector-key");
		const keyOk = expectedKey !== undefined && keyMatches(presentedKey, expectedKey);
		if (keyOk) ctx.authKind = "connector-key";
		else if (bearer === "valid") ctx.authKind = "bearer";
		else {
			authFailed(bearer === "invalid" ? "bearer" : presentedKey !== null ? "connector_key" : "missing");
			const challenge = `Bearer resource_metadata="${oauth.resourceMetadataUrl}"${bearer === "invalid" ? ', error="invalid_token"' : ""}`;
			return fail(401, "unauthenticated", { "WWW-Authenticate": challenge });
		}

		const limit = auth.allowRequest({ clientIp: ctx.ip, ownerId: CONNECTOR_RATE_OWNER });
		if (!limit.ok) return rateLimited(ctx, "mcp", limit.retryAfterSec);

		if (!isJsonRequest(req)) return fail(415, "unsupported_media_type");
		const version = resolveProtocolVersion(req.headers.get("mcp-protocol-version"));
		if (!version.ok) return respond(400, rpcError(-32600, "unsupported MCP-Protocol-Version"));
		const parsed = await readJson(req, config.maxBodyBytes);
		if (!parsed.ok) return respond(400, rpcError(-32700, "parse error"));
		describeRpc(parsed.value, ctx);

		const reply = await handleMcpPayload(mcpHost, parsed.value, { protocolVersion: version.version });
		if (reply === null) return new Response(null, { status: 202, headers: SECURITY_HEADERS });
		return respond(reply.status ?? 200, reply.body);
	}

	async function dispatch(req: Request, ctx: RequestCtx): Promise<Response> {
		const target = matchPath(new URL(req.url).pathname);
		if (!target) return fail(404, "not_found");
		ctx.endpoint = target.endpoint;

		const methods = METHODS[target.endpoint];
		if (!methods.includes(req.method)) {
			return fail(405, "method_not_allowed", { Allow: methods.join(", ") });
		}

		switch (target.endpoint) {
			case "run":
				return await getRunRoute(req, ctx, target.runId);
			case "oauth_protected_resource":
				return oauth.protectedResourceMetadata();
			case "oauth_authorization_server":
				return oauth.authorizationServerMetadata();
			case "oauth_register":
				return await oauth.register(req, ctx.ip);
			case "oauth_authorize":
				return await oauth.authorize(req, ctx.ip);
			case "oauth_token":
				return await oauth.token(req, ctx.ip);
			case "oauth_revoke":
				return await oauth.revoke(req, ctx.ip);
			case "healthz":
				return store.ping() ? respond(200, { ok: true }) : persistenceUnavailable(ctx);
			case "readyz":
				return readyz(ctx);
			case "metrics":
				return metricsRoute(req, ctx);
			case "login":
				return await login(req, ctx);
			case "mcp":
				return await mcpRoute(req, ctx);
			case "ultrathink":
				return req.method === "GET" ? await usageRoute(req, ctx) : await createRunRoute(req, ctx);
		}
	}

	function withRequestId(response: Response, reqId: string): Response {
		try {
			response.headers.set("X-Request-Id", reqId);
			return response;
		} catch {
			// A response with immutable headers is copied rather than left without an id.
			const copy = new Response(response.body, response);
			copy.headers.set("X-Request-Id", reqId);
			return copy;
		}
	}

	async function handle(req: Request, peerIp: string): Promise<Response> {
		const started = performance.now();
		const ctx: RequestCtx = {
			reqId: sanitizeRequestId(req.headers.get("x-request-id")) ?? newRequestId(),
			ip: clientIpFrom(req, peerIp),
			peerIp,
			endpoint: "not_found",
			authKind: "none",
		};
		let response: Response;
		try {
			response = await dispatch(req, ctx);
		} catch (error) {
			const correlationId = randomUUID();
			logger.error("request_error", { reqId: ctx.reqId, correlationId, error, stack: true });
			response = respond(500, { error: "internal_error", correlationId });
		}
		response = withRequestId(response, ctx.reqId);

		const elapsedMs = performance.now() - started;
		metrics.inc("ultrathink_http_requests_total", { endpoint: ctx.endpoint, status_class: `${Math.floor(response.status / 100)}xx` });
		metrics.observe("ultrathink_http_request_duration_seconds", elapsedMs / 1000, { endpoint: ctx.endpoint });
		const fields = {
			reqId: ctx.reqId,
			method: req.method,
			path: new URL(req.url).pathname,
			endpoint: ctx.endpoint,
			status: response.status,
			ms: Math.round(elapsedMs),
			...(ctx.rpcMethod === undefined ? {} : { rpcMethod: ctx.rpcMethod }),
			...(ctx.tool === undefined ? {} : { tool: ctx.tool }),
			authKind: ctx.authKind,
			ip: ctx.ip,
		};
		if (response.status >= 500) logger.warn("request", fields);
		else logger.info("request", fields);
		return response;
	}

	return {
		handle,
		async shutdown() {
			await planner.shutdown();
		},
		planner,
		metrics,
		logger,
	};
}

export function createHandler(deps: RouterDeps): (req: Request, peerIp: string) => Promise<Response> {
	return createApp(deps).handle;
}
