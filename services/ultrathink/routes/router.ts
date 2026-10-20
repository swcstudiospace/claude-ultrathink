// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { accessSync, constants } from "node:fs";
import { join } from "node:path";
import pkg from "../../../package.json";
import { type Auth, clientIpFrom } from "../auth/auth.ts";
import type { UltrathinkConfig } from "../config/config.ts";
import { type Ledger, createLedger } from "../cost/ledger.ts";
import { type BreakerState, createCircuitBreaker } from "../engine/breaker.ts";
import { type HeadlessPlanner, type ResultView, createHeadlessPlanner } from "../engine/headless.ts";
import type { JournalOptions } from "../engine/journal.ts";
import type { OpenRouterFetch } from "../engine/openrouter.ts";
import { createSweeper, sweepStateDir } from "../engine/retention.ts";
import { defaultGraphResources, loadCatalogWithFallback } from "../mcp/connector-host.ts";
import { type McpToolHost, type ToolOutcome, handleMcpPayload } from "../mcp/mcp.ts";
import { createToolHost } from "../mcp/tool-host.ts";
import type { PlanningInfo } from "../mcp/tools-connector.ts";
import { DEFAULT_ALLOWED_ORIGINS, originAllowed, resolveProtocolVersion } from "../mcp/transport.ts";
import { type AuditEvent, type AuditLog, auditPath, createAuditLog } from "../obs/audit.ts";
import { runWithRequestContext } from "../obs/context.ts";
import { type Logger, createLogger, newRequestId, sanitizeRequestId } from "../obs/log.ts";
import { type Metrics, createMetrics } from "../obs/metrics.ts";
import { createDrainState, createInflight, createRuntimeProbe } from "../obs/runtime.ts";
import { childSpan, formatTraceparent, traceContextFor } from "../obs/trace.ts";
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
	/** Test seam. Defaults to the state directory's audit log, which is absent when config.auditLog is off. */
	audit?: AuditLog;
}

export interface App {
	handle(req: Request, peerIp: string): Promise<Response>;
	/** Starts the runtime probe and, when retention is on, the sweep; reads store integrity. Idempotent. */
	start(): void;
	/** Fails /readyz so the load balancer stops routing here; /healthz keeps answering. Idempotent. */
	beginDrain(): void;
	/** Stops the probe and sweep, closes the audit log, then stops accepting planner work and ends running jobs. The caller closes the store. */
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
	| "logout"
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
	mcpVersion?: string;
	tool?: string;
}

/** HEAD is allowed wherever GET is and is answered as that GET without the body. */
const METHODS: Record<Endpoint, readonly string[]> = {
	healthz: ["GET", "HEAD"],
	readyz: ["GET", "HEAD"],
	metrics: ["GET", "HEAD"],
	login: ["POST"],
	logout: ["POST"],
	ultrathink: ["GET", "HEAD", "POST"],
	run: ["GET", "HEAD"],
	mcp: ["POST"],
	oauth_protected_resource: ["GET", "HEAD"],
	oauth_authorization_server: ["GET", "HEAD"],
	oauth_authorize: ["GET", "HEAD", "POST"],
	oauth_token: ["POST"],
	oauth_register: ["POST"],
	oauth_revoke: ["POST"],
};

const RUN_PATH = /^\/ultrathink\/runs\/([^/]+)$/;

const CONNECTOR_RATE_OWNER = "connector";

// Probes and scrapes are never shed: an overloaded process must still answer its orchestrator.
const UNGATED: Partial<Record<Endpoint, true>> = { healthz: true, readyz: true, metrics: true };
const BREAKER_STATES: readonly BreakerState[] = ["closed", "open", "half_open"];
const CONNECTOR_OWNER_LIMIT = 240;
const RUNTIME_SAMPLE_MS = 5000;
const RETENTION_SWEEP_MS = 60 * 60 * 1000;

const LOOPBACK_PEERS: Record<string, true> = { "127.0.0.1": true, "::1": true, "::ffff:127.0.0.1": true };

const LOG_VALUE_MAX = 64;

const OAUTH_STATE_FILE = "oauth.json";

/** On every JSON, metrics and 202 response. OAuth HTML pages carry their own policy (oauth.ts). */
const SECURITY_HEADERS: Record<string, string> = {
	"Cache-Control": "no-store",
	"X-Content-Type-Options": "nosniff",
	"Referrer-Policy": "no-referrer",
	"X-Frame-Options": "DENY",
	"Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
	"Permissions-Policy": "camera=(), microphone=(), geolocation=()",
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
	if (pathname === "/ultrathink/logout") return { endpoint: "logout" };
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
	// Every dropped record counts; the log line is written once per distinct message until an append succeeds.
	let auditDrops = 0;
	let auditLoggedMessage: string | undefined;
	// Absent when config.auditLog is off, unless a test injects one.
	const auditLog =
		deps.audit ??
		(config.auditLog
			? createAuditLog({
					path: auditPath(config.stateDir),
					onError: (error) => {
						auditDrops += 1;
						metrics.inc("ultrathink_audit_write_failures_total");
						if (error.message === auditLoggedMessage) return;
						auditLoggedMessage = error.message;
						logger.error("audit_write_failed", { error: error.message });
					},
				})
			: undefined);
	function record(event: AuditEvent, fields: Record<string, string | number | boolean> = {}): void {
		const dropsBefore = auditDrops;
		auditLog?.record(event, fields);
		// onError runs inside record(), so no new drop means this append landed.
		if (auditDrops === dropsBefore) auditLoggedMessage = undefined;
	}
	const oauth = createOAuth({
		origin: config.publicOrigin,
		stateDir: config.stateDir,
		auth,
		now: deps.now,
		redirectOrigins: [...DEFAULT_REDIRECT_ORIGINS, ...config.oauthRedirectOrigins],
		audit: record,
	});
	const ledger = deps.ledger ?? lazyLedger(store, config, deps.now);
	// Repeated upstream failures open the breaker; a threshold of 0 turns it off.
	const breaker =
		config.breakerFailures > 0
			? createCircuitBreaker({
					failureThreshold: config.breakerFailures,
					windowMs: config.breakerWindowMs,
					openMs: config.breakerOpenMs,
					now: deps.now,
					onTransition: (from, to) => {
						publishBreakerState(to);
						logger.warn("upstream_breaker", { from, to });
					},
				})
			: undefined;
	const inflight = createInflight(config.maxInflight);
	const drain = createDrainState(deps.now);
	// Refreshed by start() and after each retention sweep; openStore already ran quick_check at startup.
	let integrityOk = true;
	const planner =
		deps.planner ??
		createHeadlessPlanner({
			config,
			store,
			ledger,
			now: deps.now,
			logger,
			...(breaker ? { breaker } : {}),
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
	if (breaker) publishBreakerState(breaker.state());
	metrics.gauge("ultrathink_build_info", 1, { version: pkg.version });

	function persistenceUnavailable(ctx: RequestCtx, error?: unknown): Response {
		const correlationId = randomUUID();
		logger.error("persistence_unavailable", { reqId: ctx.reqId, correlationId, ...(error === undefined ? {} : { error }) });
		return respond(503, { error: "persistence_unavailable", correlationId });
	}

	function rateLimited(ctx: RequestCtx, scope: string, retryAfterSec: number): Response {
		metrics.inc("ultrathink_rate_limited_total", { scope });
		logger.warn("rate_limited", { reqId: ctx.reqId, ip: ctx.ip, scope });
		record("rate_limited", { scope, ip: ctx.ip });
		return fail(429, "rate_limited", { "Retry-After": String(retryAfterSec) });
	}

	function authFailed(kind: string): void {
		metrics.inc("ultrathink_auth_failures_total", { kind });
	}

	function publishBreakerState(state: BreakerState): void {
		for (const name of BREAKER_STATES) metrics.gauge("ultrathink_upstream_breaker_state", name === state ? 1 : 0, { state: name });
	}

	function refreshIntegrity(): void {
		try {
			integrityOk = store.quickCheck().ok;
		} catch {
			integrityOk = false;
		}
	}

	async function login(req: Request, ctx: RequestCtx): Promise<Response> {
		if (req.headers.get("origin") !== config.publicOrigin) return fail(403, "forbidden");
		if (!isJsonRequest(req)) return fail(415, "unsupported_media_type");
		const parsed = await readJson(req, config.maxBodyBytes);
		if (!parsed.ok) return parsed.response;
		const password = (parsed.value as { password?: unknown } | null)?.password;
		if (typeof password !== "string") return fail(400, "invalid_input");

		const result = await auth.login({ password, clientIp: ctx.ip });
		if (result.ok) {
			record("login_ok", { ip: ctx.ip });
			return respond(200, { ok: true }, { "Set-Cookie": result.setCookie });
		}
		if (result.reason === "rate_limited") return rateLimited(ctx, "login", result.retryAfterSec ?? 60);
		authFailed("login");
		logger.warn("login_failed", { reqId: ctx.reqId, ip: ctx.ip });
		record("login_failed", { ip: ctx.ip });
		return fail(401, "invalid_credentials");
	}

	function logout(req: Request, ctx: RequestCtx): Response {
		if (req.headers.get("origin") !== config.publicOrigin) return fail(403, "forbidden");
		// Clearing the cookie needs no session; a valid session presented here is recorded as it ends.
		if (auth.sessionFor(req)) {
			ctx.authKind = "session";
			record("logout", {});
		}
		return respond(200, { ok: true }, { "Set-Cookie": auth.logoutCookie() });
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

		if (req.headers.get("origin") !== config.publicOrigin) return fail(403, "forbidden");
		if (!isJsonRequest(req)) return fail(415, "unsupported_media_type");

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
		const checks = {
			store: storeOk,
			stateDir: stateDirOk,
			oauth: oauthOk,
			planner: plannerOk,
			integrity: integrityOk,
			draining: !drain.draining,
		};
		const failed = Object.entries(checks)
			.filter(([, passed]) => !passed)
			.map(([name]) => name);
		const upstream = planner.upstream();
		const upstreamView = upstream === undefined ? {} : { upstream: { state: upstream.state } };
		if (failed.length === 0) return respond(200, { status: "ready", checks, ...upstreamView });
		logger.warn("not_ready", { reqId: ctx.reqId, failed });
		return respond(503, { error: "not_ready", failed, checks, ...upstreamView });
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

	// A release without its commands/ and skills/ directories still serves the static overlay instead of failing to start.
	const catalog = loadCatalogWithFallback((error) => logger.warn("command_catalog_fallback", { error }));
	const resources = defaultGraphResources();

	function planningInfo(): PlanningInfo {
		if (!planner.enabled) return { serverPlanning: false };
		let usedTodayTokens: number | undefined;
		try {
			usedTodayTokens = ledger.spentForDay(new Date((deps.now ?? Date.now)()).toISOString().slice(0, 10));
		} catch {
			// A ledger that cannot answer leaves the usage out instead of hiding the rest.
		}
		return {
			serverPlanning: true,
			...(config.planningModel === undefined ? {} : { model: config.planningModel }),
			maxConcurrentPlans: config.maxConcurrentPlans,
			runTokenCeiling: config.runTokenCeiling,
			dailyTokenCeiling: config.dailyTokenCeiling,
			...(usedTodayTokens === undefined ? {} : { usedTodayTokens }),
		};
	}

	/** Counts a finished server plan: the job, its tokens and its cost. The tool host calls it once per plan. */
	function recordFinished(view: ResultView): void {
		metrics.inc("ultrathink_plan_jobs_total", { status: view.status });
		const { usage } = view;
		if (!usage) return;
		if (usage.inputTokens > 0) metrics.inc("ultrathink_plan_tokens_total", { direction: "input" }, usage.inputTokens);
		if (usage.outputTokens > 0) metrics.inc("ultrathink_plan_tokens_total", { direction: "output" }, usage.outputTokens);
		if (usage.costUsd !== undefined && usage.costUsd > 0) metrics.inc("ultrathink_plan_cost_usd_total", undefined, usage.costUsd);
	}

	const toolHost = createToolHost({ journalOpts, planner, catalog, resources, planningInfo, onPlanFinished: recordFinished });

	const mcpHost: McpToolHost = {
		capabilities: toolHost.capabilities,
		resources: toolHost.resources,
		async call(name, args) {
			let outcome: ToolOutcome;
			try {
				outcome = await toolHost.call(name, args);
			} catch (error) {
				// The class only: a message may quote arguments.
				const correlationId = randomUUID();
				logger.error("tool_error", { tool: name, error: error instanceof Error ? error.name : "UnknownError", correlationId });
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
		// Logged as sent (cut to the log limit) so the operator sees which revision a hosted client probes with.
		const versionHeader = req.headers.get("mcp-protocol-version");
		if (versionHeader !== null) ctx.mcpVersion = versionHeader.slice(0, LOG_VALUE_MAX);

		// A browser always sends an Origin; native and server-side clients send none.
		if (!originAllowed(req.headers.get("origin"), allowedOrigins)) return fail(403, "forbidden_origin");

		const presented = bearerFrom(req);
		const bearer = oauth.classifyBearer(presented === "" ? null : presented);
		const expectedKey = config.connectorKey;
		const presentedKey = req.headers.get("x-connector-key");
		const keyOk = expectedKey !== undefined && keyMatches(presentedKey, expectedKey);

		let principal: string;
		if (keyOk) {
			ctx.authKind = "connector-key";
			principal = "key:connector";
		} else if (bearer === "valid") {
			ctx.authKind = "bearer";
			principal = `bearer:${createHash("sha256").update(presented).digest("hex").slice(0, 16)}`;
		} else {
			authFailed(bearer === "invalid" ? "bearer" : presentedKey !== null ? "connector_key" : "missing");
			const challenge = `Bearer resource_metadata="${oauth.resourceMetadataUrl}"${bearer === "invalid" ? ', error="invalid_token"' : ""}`;
			return fail(401, "unauthenticated", { "WWW-Authenticate": challenge });
		}

		const limit = auth.allowRequest({ clientIp: ctx.ip, ownerId: CONNECTOR_RATE_OWNER, principal, ownerLimit: CONNECTOR_OWNER_LIMIT });
		if (!limit.ok) {
			logger.warn("rate_limit_window", { reqId: ctx.reqId, window: limit.scope });
			return rateLimited(ctx, "mcp", limit.retryAfterSec);
		}

		if (!isJsonRequest(req)) return fail(415, "unsupported_media_type");
		const version = resolveProtocolVersion(versionHeader);
		if (!version.ok) {
			// Only the method name of a parseable body is kept, so the log shows what the client tried; the answer never depends on it.
			const peeked = await readJson(req, config.maxBodyBytes);
			if (peeked.ok) {
				describeRpc(peeked.value, ctx);
				ctx.tool = undefined;
			}
			return respond(400, rpcError(-32600, "unsupported MCP-Protocol-Version"));
		}
		const parsed = await readJson(req, config.maxBodyBytes);
		if (!parsed.ok) return respond(400, rpcError(-32700, "parse error"));
		describeRpc(parsed.value, ctx);

		const reply = await handleMcpPayload(mcpHost, parsed.value, { protocolVersion: version.version });
		if (reply === null) return new Response(null, { status: 202, headers: SECURITY_HEADERS });
		return respond(reply.status ?? 200, reply.body);
	}

	async function dispatch(req: Request, ctx: RequestCtx, target: Target | null): Promise<Response> {
		if (!target) return fail(404, "not_found");

		const methods = METHODS[target.endpoint];
		if (!methods.includes(req.method)) {
			return fail(405, "method_not_allowed", { Allow: methods.join(", ") });
		}
		if (req.method !== "HEAD") return await route(req, ctx, target);

		// Answered as the GET it stands for: that status and those headers, without the body.
		const response = await route(new Request(req.url, { method: "GET", headers: req.headers }), ctx, target);
		return new Response(null, { status: response.status, headers: response.headers });
	}

	async function route(req: Request, ctx: RequestCtx, target: Target): Promise<Response> {
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
			case "logout":
				return logout(req, ctx);
			case "mcp":
				return await mcpRoute(req, ctx);
			case "ultrathink":
				return req.method === "GET" ? await usageRoute(req, ctx) : await createRunRoute(req, ctx);
		}
	}

	function withHeaders(response: Response, headers: Record<string, string>): Response {
		try {
			for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
			return response;
		} catch {
			// A response with immutable headers is copied rather than left without its headers.
			const copy = new Response(response.body, response);
			for (const [name, value] of Object.entries(headers)) copy.headers.set(name, value);
			return copy;
		}
	}

	async function handle(req: Request, peerIp: string): Promise<Response> {
		const started = performance.now();
		// A valid inbound traceparent is continued under a new span; anything else starts a fresh trace.
		const inbound = traceContextFor(req.headers.get("traceparent"));
		const server = inbound.inherited ? childSpan(inbound.ctx) : inbound.ctx;
		const ctx: RequestCtx = {
			reqId: sanitizeRequestId(req.headers.get("x-request-id")) ?? newRequestId(),
			ip: clientIpFrom(req, peerIp),
			peerIp,
			endpoint: "not_found",
			authKind: "none",
		};
		return runWithRequestContext({ reqId: ctx.reqId, traceId: server.traceId, spanId: server.spanId, sampled: server.sampled }, async () => {
			let response: Response;
			let release: (() => void) | undefined;
			try {
				const target = matchPath(new URL(req.url).pathname);
				if (target) ctx.endpoint = target.endpoint;
				const ungated = target !== null && UNGATED[target.endpoint] === true;
				const slot = ungated ? undefined : inflight.enter();
				if (slot === null) {
					metrics.inc("ultrathink_overload_total");
					response = fail(503, "overloaded", { "Retry-After": "1" });
				} else {
					release = slot;
					metrics.gauge("ultrathink_http_inflight", inflight.count);
					response = await dispatch(req, ctx, target);
				}
			} catch (error) {
				const correlationId = randomUUID();
				logger.error("request_error", { reqId: ctx.reqId, correlationId, error, stack: true });
				response = respond(500, { error: "internal_error", correlationId });
			} finally {
				release?.();
				metrics.gauge("ultrathink_http_inflight", inflight.count);
			}
			response = withHeaders(response, { "X-Request-Id": ctx.reqId, traceparent: formatTraceparent(server) });

			const elapsedMs = performance.now() - started;
			metrics.inc("ultrathink_http_requests_total", { endpoint: ctx.endpoint, status_class: `${Math.floor(response.status / 100)}xx` });
			metrics.observe("ultrathink_http_request_duration_seconds", elapsedMs / 1000, { endpoint: ctx.endpoint });
			const fields = {
				reqId: ctx.reqId,
				traceId: server.traceId,
				method: req.method,
				path: new URL(req.url).pathname,
				endpoint: ctx.endpoint,
				status: response.status,
				ms: Math.round(elapsedMs),
				...(ctx.rpcMethod === undefined ? {} : { rpcMethod: ctx.rpcMethod }),
				...(ctx.mcpVersion === undefined ? {} : { mcpVersion: ctx.mcpVersion }),
				...(ctx.tool === undefined ? {} : { tool: ctx.tool }),
				authKind: ctx.authKind,
				ip: ctx.ip,
			};
			if (response.status >= 500) logger.warn("request", fields);
			else logger.info("request", fields);
			return response;
		});
	}

	let stopProbe: (() => void) | undefined;
	let stopSweeper: (() => void) | undefined;
	let lifecycleStarted = false;

	/** Starts the runtime probe and, when retention is enabled, the sweeper. Runs once; later calls change nothing. */
	function start(): void {
		if (lifecycleStarted) return;
		lifecycleStarted = true;
		stopProbe = createRuntimeProbe({
			intervalMs: RUNTIME_SAMPLE_MS,
			onSample: (sample) => {
				metrics.gauge("ultrathink_event_loop_lag_seconds", sample.eventLoopLagMs / 1000);
				metrics.gauge("ultrathink_process_rss_bytes", sample.rssBytes);
				metrics.gauge("ultrathink_process_heap_used_bytes", sample.heapUsedBytes);
				metrics.gauge("ultrathink_uptime_seconds", sample.uptimeSec);
				metrics.gauge("ultrathink_http_inflight", inflight.count);
				if (breaker) publishBreakerState(breaker.state());
			},
		}).start();
		if (config.retentionDays > 0) {
			stopSweeper = createSweeper({
				sweep: () => sweepStateDir({ stateDir: config.stateDir, retentionDays: config.retentionDays, now: deps.now }),
				intervalMs: RETENTION_SWEEP_MS,
				onResult: (result) => {
					for (const kind of ["jobs", "sessions", "journals"] as const) {
						metrics.inc("ultrathink_retention_removed_total", { kind }, result.removed[kind]);
					}
					if (result.errors > 0) logger.warn("retention_errors", { errors: result.errors });
					refreshIntegrity();
				},
				onError: (error) => logger.error("retention_failed", { error: error.message }),
			}).start();
		}
		refreshIntegrity();
	}

	return {
		handle,
		start,
		beginDrain() {
			drain.begin();
		},
		async shutdown() {
			stopProbe?.();
			stopSweeper?.();
			auditLog?.close();
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
