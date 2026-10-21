// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { accessSync, constants, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import pkg from "../../../package.json";
import { type Auth, clientIpFrom } from "../auth/auth.ts";
import { createPenaltyLadder } from "../auth/penalty.ts";
import type { UltrathinkConfig } from "../config/config.ts";
import { type Ledger, createLedger } from "../cost/ledger.ts";
import { type BreakerState, createCircuitBreaker } from "../engine/breaker.ts";
import { type HeadlessPlanner, type ResultView, createHeadlessPlanner } from "../engine/headless.ts";
import type { JournalOptions } from "../engine/journal.ts";
import type { OpenRouterFetch } from "../engine/openrouter.ts";
import { type SweepResult, createSweeper, sweepStateDir } from "../engine/retention.ts";
import { defaultGraphResources, loadCatalogWithFallback } from "../mcp/connector-host.ts";
import { type McpToolHost, type ToolOutcome, handleMcpPayload } from "../mcp/mcp.ts";
import { createToolHost } from "../mcp/tool-host.ts";
import type { PlanningInfo } from "../mcp/tools-connector.ts";
import { DEFAULT_ALLOWED_ORIGINS, originAllowed, resolveProtocolVersion } from "../mcp/transport.ts";
import { type AnomalyAlert, DEFAULT_ANOMALY_RULES, createAnomalyDetector } from "../obs/anomaly.ts";
import { type Fingerprint, createAuditWatch } from "../obs/audit-watch.ts";
import { chainIdentity, createAuditVerifier } from "../obs/audit-verify.ts";
import { type AuditEvent, type AuditLog, auditPath, createAuditLog } from "../obs/audit.ts";
import { currentRequestContext, runWithRequestContext } from "../obs/context.ts";
import { type Admission, createFairShare } from "../obs/fair-share.ts";
import { type LoadHistory, createLoadHistory, loadLoadHistory, recommendedReplicas } from "../obs/forecast.ts";
import { type Logger, createLogger, newRequestId, sanitizeRequestId } from "../obs/log.ts";
import { type Metrics, createMetrics } from "../obs/metrics.ts";
import { type SpanSink, createSpanExporter } from "../obs/otel.ts";
import { createAdaptiveQuota } from "../obs/quota.ts";
import { type RuntimeSample, createDrainState, createInflight, createRuntimeProbe } from "../obs/runtime.ts";
import { createAnomalyDetector as createSignalDetector } from "../obs/signal-anomaly.ts";
import { createAuditStreams } from "../obs/sinks/fanout.ts";
import { createHttpTransport, createKafkaRestTransport } from "../obs/sinks/http.ts";
import type { SinkEvent } from "../obs/sinks/queue.ts";
import { createSyslogTransport } from "../obs/sinks/syslog.ts";
import type { SinkTransport } from "../obs/sinks/types.ts";
import { createSloTracker } from "../obs/slo.ts";
import { childSpan, formatTraceparent, traceContextFor } from "../obs/trace.ts";
import { DEFAULT_REDIRECT_ORIGINS, createOAuth } from "../oauth/oauth.ts";
import { type RouteGroup, authorize, isEdgeIdentity } from "../security/identity.ts";
import {
	ObjectValidator,
	SecurityEventType,
	type SecurityHeadersConfig,
	StreamingSecurityEventLogger,
	StringValidator,
	type Validator,
	buildSecurityHeaders,
	createSecurityEvent,
	readBodyPrefix,
	setSecurityLogger,
} from "../security/index.ts";
import type { PhaseRecord, Run, Store } from "../store/store.ts";
import { createWalCheckpointer } from "../store/checkpoint.ts";
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
	/** Test seam for the tamper watch and the prune sweep. Defaults to the real timers. */
	timers?: {
		setInterval: (run: () => void, intervalMs: number) => object;
		clearInterval: (handle: object) => void;
	};
	/** Test seam. Replaces the sink transports that config builds (HTTP, Kafka REST and syslog). */
	auditTransports?: SinkTransport[];
	/** Test seam. Receives the SERVER and client spans; absent means the OTLP exporter when ULTRATHINK_OTLP_ENDPOINT is set. */
	spans?: SpanSink;
}

export interface App {
	/** `peer` carries the verified mTLS identity; it is absent in plaintext mode, where the identity gate is off. */
	handle(req: Request, peerIp: string, peer?: { spiffeId: string | null }): Promise<Response>;
	/** Starts the runtime probe and, when retention is on, the sweep; reads store integrity. Idempotent. */
	start(): void;
	/** Fails /readyz so the load balancer stops routing here; /healthz keeps answering. Idempotent. */
	beginDrain(): void;
	/** Stops the probe and sweep, closes the audit log, then stops accepting planner work and ends running jobs. The caller closes the store. */
	shutdown(): Promise<void>;
	/** Feeds one runtime sample to the adaptive quota and refreshes the load gauges. The runtime probe calls it on every sample. */
	observeRuntime(sample: RuntimeSample): void;
	/** Runs one retention sweep now, timed and handled as the sweeper handles its runs. A test hook. */
	runSweepNow(): void;
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
/** The WAL is folded into the main file this often, so a busy host does not grow it between sweeps. */
const WAL_CHECKPOINT_MS = 10 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** How long shutdown lets queued audit and security envelopes reach their sinks. */
const AUDIT_FLUSH_MS = 2000;
/** Penalty window, decay period and key cap; fixed in code (Phase 70, CONTEXT decision 7). */
const PENALTY_WINDOW_MS = 60 * 1000;
const PENALTY_DECAY_MS = 15 * 60 * 1000;
const PENALTY_KEYS = 10_000;
/** The load history is saved this often, and once more on shutdown. */
const HISTORY_SAVE_MS = 5 * 60 * 1000;
/** The one SLO: the share of requests that are not 5xx, over a 6 h in-process window (phase 71, CONTEXT D7). */
const SLO_NAME = "http_availability";
const SLO_OBJECTIVE = 0.99;
const SLO_WINDOW_MS = 6 * 60 * 60 * 1000;
const SLO_BURN_WINDOWS: ReadonlyArray<{ label: string; ms: number }> = [
	{ label: "5m", ms: 5 * 60 * 1000 },
	{ label: "30m", ms: 30 * 60 * 1000 },
	{ label: "1h", ms: 60 * 60 * 1000 },
	{ label: "6h", ms: SLO_WINDOW_MS },
];
/** Samples the ring needs to cover the SLO window at the runtime sample interval, plus two spare. */
const SLO_MAX_SAMPLES = Math.ceil(SLO_WINDOW_MS / RUNTIME_SAMPLE_MS) + 2;
const NS_PER_MS = 1_000_000n;

const LOOPBACK_PEERS: Record<string, true> = { "127.0.0.1": true, "::1": true, "::ffff:127.0.0.1": true };

const LOG_VALUE_MAX = 64;

const OAUTH_STATE_FILE = "oauth.json";
const LOAD_HISTORY_FILE = "load-history.json";

// Any string reaches the authenticator, an empty one included, as before; the authenticator refuses it.
const LOGIN_BODY: Record<string, Validator<unknown>> = { password: new StringValidator({ allowEmpty: true }) };

/**
 * The headers on every JSON, metrics and 202 response, built by the security module. OAuth HTML pages keep their own
 * policy (oauth.ts). coop, corp and coep are off: the JSON API never sent them. nginx falls back to these same values
 * only where a response carries none (deploy/nginx-ultrathink.swcstudio.space.conf).
 */
const API_HEADER_CONFIG: SecurityHeadersConfig = {
	hsts: true,
	hstsMaxAge: 31536000,
	hstsIncludeSubdomains: true,
	hstsPreload: false,
	csp: "default-src 'none'; frame-ancestors 'none'",
	cspReportOnly: false,
	cspReportUri: "",
	frameOptions: "DENY",
	contentTypeOptions: true,
	referrerPolicy: "no-referrer",
	permissionsPolicy: "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
	coop: "",
	corp: "",
	coep: "",
};
export const SECURITY_HEADERS: Record<string, string> = { "Cache-Control": "no-store", ...buildSecurityHeaders(API_HEADER_CONFIG) };

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

/** Policy group a request is judged by: probes are health or metrics; every other path, known or not, is proxied. */
function routeGroupOf(target: Target | null): RouteGroup {
	if (target === null) return "proxied";
	switch (target.endpoint) {
		case "healthz":
		case "readyz":
			return "health";
		case "metrics":
			return "metrics";
		default:
			return "proxied";
	}
}

function isJsonRequest(req: Request): boolean {
	const contentType = req.headers.get("content-type");
	if (contentType === null) return false;
	return contentType.split(";")[0]?.trim().toLowerCase() === "application/json";
}

/**
 * A JSON body, read through the security body reader: at most maxBytes, and the read stops when the request aborts.
 * A declared length over the cap is refused before anything is read.
 */
async function readJson(req: Request, maxBytes: number): Promise<JsonRead> {
	const declared = req.headers.get("content-length");
	if (declared !== null && Number(declared) > maxBytes) return { ok: false, response: fail(413, "body_too_large") };

	const utf8 = utf8Checked(req.body);
	let read: { text: string; complete: boolean };
	try {
		read = await readBodyPrefix(new Response(utf8.body), maxBytes, req.signal);
	} catch {
		return { ok: false, response: fail(400, "invalid_json") };
	}
	if (!read.complete) return { ok: false, response: fail(413, "body_too_large") };
	if (!utf8.valid()) return { ok: false, response: fail(400, "invalid_json") };
	try {
		return { ok: true, value: JSON.parse(read.text) };
	} catch {
		return { ok: false, response: fail(400, "invalid_json") };
	}
}

/**
 * Passes a body through unchanged and records whether its bytes are valid UTF-8. The body reader decodes leniently;
 * this keeps the strict decoding, so an invalid body is still refused with invalid_json.
 */
function utf8Checked(body: ReadableStream<Uint8Array> | null): { body: ReadableStream<Uint8Array> | null; valid: () => boolean } {
	if (body === null) return { body, valid: () => true };
	const decoder = new TextDecoder("utf-8", { fatal: true });
	let valid = true;
	const check = new TransformStream<Uint8Array, Uint8Array>({
		transform(chunk, controller) {
			if (valid) {
				try {
					decoder.decode(chunk, { stream: true });
				} catch {
					valid = false;
				}
			}
			controller.enqueue(chunk);
		},
		flush() {
			if (!valid) return;
			try {
				decoder.decode();
			} catch {
				valid = false;
			}
		},
	});
	return { body: body.pipeThrough(check), valid: () => valid };
}

/** The parsed body as an object whose schema fields pass; unknown fields are allowed. Null when the shape is wrong. */
function validateBody(value: unknown, schema: Record<string, Validator<unknown>>): Record<string, unknown> | null {
	const result = new ObjectValidator<Record<string, unknown>>(schema, { allowExtraKeys: true, strict: true }).validate(value);
	return result.valid && result.value !== undefined ? result.value : null;
}

/** The OAuth error code of a refused response (invalid_grant and the like). Anything else is "unknown"; the body is never logged. */
async function oauthErrorCode(response: Response): Promise<string> {
	const body: unknown = await response.clone().json().catch(() => null);
	const code = typeof body === "object" && body !== null && "error" in body ? body.error : undefined;
	return typeof code === "string" && /^[a-z_]{1,64}$/.test(code) ? code : "unknown";
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

/** Builds the sink transports that the config enables. The config has already validated every URL, token and port. */
function transportsFromConfig(config: UltrathinkConfig): SinkTransport[] {
	const transports: SinkTransport[] = [];
	if (config.auditHttpUrl !== undefined) {
		transports.push(createHttpTransport({ url: config.auditHttpUrl, ...(config.auditHttpToken === undefined ? {} : { token: config.auditHttpToken }) }));
	}
	if (config.auditKafkaRestUrl !== undefined && config.auditKafkaTopic !== undefined) {
		transports.push(createKafkaRestTransport({ baseUrl: config.auditKafkaRestUrl, topic: config.auditKafkaTopic }));
	}
	if (config.auditSyslog !== undefined) {
		transports.push(createSyslogTransport({ host: config.auditSyslog.host, port: config.auditSyslog.port, hostname: hostname(), appName: "ultrathink" }));
	}
	return transports;
}

/** Resolves when `wait` settles or after `ms`, whichever is first; never rejects, and `onFailure` sees a rejection. */
function waitUpTo(wait: Promise<void>, ms: number, onFailure: (error: unknown) => void): Promise<void> {
	return new Promise<void>((resolve) => {
		const timer = setTimeout(resolve, ms);
		wait.then(
			() => {
				clearTimeout(timer);
				resolve();
			},
			(error: unknown) => {
				clearTimeout(timer);
				onFailure(error);
				resolve();
			},
		);
	});
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** The audit file's identity on disk, read the way the log reads it, so the watch sees a change made outside the service. */
function diskFingerprint(path: string): Fingerprint | undefined {
	try {
		const stat = statSync(path);
		return { size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino };
	} catch {
		return undefined;
	}
}

/**
 * The saved load history. A missing file is a fresh start. A file that cannot be read starts empty and is logged.
 * A file this service wrote always round-trips through toJSON exactly; any other text is logged as malformed.
 */
function restoreHistory(path: string, logger: Logger): LoadHistory {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return createLoadHistory();
		logger.warn("load_history_unreadable", { error: error instanceof Error ? error.name : "UnknownError" });
		return createLoadHistory();
	}
	const restored = loadLoadHistory(text);
	if (restored.toJSON() !== text) logger.warn("load_history_malformed", {});
	return restored;
}

/** Saves through a temporary file beside the target, then renames it into place. Never throws; a failed save is logged. */
function saveHistory(history: LoadHistory, path: string, logger: Logger): void {
	const temp = `${path}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temp, history.toJSON(), { mode: 0o600 });
		renameSync(temp, path);
	} catch (error) {
		logger.warn("load_history_save_failed", { error: error instanceof Error ? error.name : "UnknownError" });
		try {
			rmSync(temp, { force: true });
		} catch {
			// The temporary file stays; the next save writes under a new name.
		}
	}
}

export function createApp(deps: RouterDeps): App {
	const { config, store, auth } = deps;
	const logger = deps.logger ?? createLogger();
	const metrics = deps.metrics ?? createMetrics();
	const timers = deps.timers;
	// Test seam for the tamper watch and the prune sweep; absent means the real timers.
	const timerSeams =
		timers === undefined
			? {}
			: {
					setTimer: (run: () => void, intervalMs: number) => timers.setInterval(run, intervalMs),
					clearTimer: (handle: object) => timers.clearInterval(handle),
				};
	// Set while a sink is failing, so each distinct failure is logged once until that sink delivers again.
	let sinkFailureLogged: string | undefined;
	const streams = createAuditStreams({
		transports: deps.auditTransports ?? transportsFromConfig(config),
		capacity: config.auditSinkQueue,
		onEvent: (event) => onSinkEvent(event),
	});
	const securityEvents = new StreamingSecurityEventLogger(logger, (event) => streams.security(event));
	// Installed process-wide so the validation modules and every other caller reach the same SIEM-backed sink (phase 67 gap 3).
	setSecurityLogger(securityEvents);
	// Anomaly alerts raised while a record is being appended wait here until that record has returned.
	const detector = createAnomalyDetector({ rules: config.auditRules ?? DEFAULT_ANOMALY_RULES, now: deps.now });
	const pendingAlerts: AnomalyAlert[] = [];
	let appending = 0;
	let raising = false;
	// Every dropped record counts; the log line is written once per distinct message until an append succeeds.
	let auditDrops = 0;
	let auditLoggedMessage: string | undefined;
	// Absent when config.auditLog is off, unless a test injects one.
	const auditLog =
		deps.audit ??
		(config.auditLog
			? createAuditLog({
					path: auditPath(config.stateDir),
					anchorEvery: config.auditAnchorEvery,
					segmentBytes: config.auditSegmentBytes,
					onError: (error) => {
						auditDrops += 1;
						metrics.inc("ultrathink_audit_write_failures_total");
						if (error.message === auditLoggedMessage) return;
						auditLoggedMessage = error.message;
						logger.error("audit_write_failed", { error: error.message });
					},
					onNotice: (notice) => {
						logger.info("audit_chain_notice", { kind: notice.kind, message: notice.message });
						metrics.inc("ultrathink_audit_chain_notices_total");
						switch (notice.kind) {
							case "changed_outside":
							case "moved_to":
								raiseTamper(notice.message);
								break;
							case "pruned":
								// Routine retention: the info line above is the whole record; it is not tamper.
								break;
						}
					},
					onAppend: (appended) => {
						streams.audit(appended);
						for (const alert of detector.observe(appended.event, appended.fields)) pendingAlerts.push(alert);
					},
				})
			: undefined);
	function record(event: AuditEvent, fields: Record<string, string | number | boolean> = {}): void {
		const dropsBefore = auditDrops;
		appending += 1;
		try {
			auditLog?.record(event, fields);
		} finally {
			appending -= 1;
		}
		// onError runs inside record(), so no new drop means this append landed.
		if (auditDrops === dropsBefore) auditLoggedMessage = undefined;
		raiseAnomalies();
	}

	function onSinkEvent(event: SinkEvent): void {
		metrics.inc("ultrathink_audit_sink_events_total", { sink: event.sink, outcome: event.type }, event.count);
		if (event.type === "sent") {
			sinkFailureLogged = undefined;
			return;
		}
		const key = `${event.sink}:${event.type}:${event.reason ?? ""}`;
		if (key === sinkFailureLogged) return;
		sinkFailureLogged = key;
		logger.warn("audit_sink_failed", { sink: event.sink, outcome: event.type, count: event.count, reason: event.reason ?? "unknown" });
	}

	/** Raises every anomaly that arrived with the record just returned, in arrival order. Re-entry is a no-op. */
	function raiseAnomalies(): void {
		if (appending > 0 || raising) return;
		raising = true;
		try {
			for (let alert = pendingAlerts.shift(); alert !== undefined; alert = pendingAlerts.shift()) {
				const fields = { rule: alert.rule, key: alert.key, count: alert.count, windowSec: alert.windowSec };
				record("anomaly_detected", fields);
				metrics.inc("ultrathink_audit_anomalies_total", { rule: alert.rule });
				streams.alert("anomaly_detected", fields);
			}
		} finally {
			raising = false;
		}
	}

	function raiseTamper(reason: string): void {
		logger.error("audit_tamper_detected", { reason });
		metrics.inc("ultrathink_audit_tamper_alerts_total");
		streams.alert("audit_tamper_detected", { reason });
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
						metrics.inc("ultrathink_upstream_breaker_transitions_total", { from, to });
						logger.warn("upstream_breaker", { from, to });
					},
				})
			: undefined;
	const inflight = createInflight(config.maxInflight);
	// The HTTP pool admits, queues over-budget work within a bound, or refuses; owner work stays ahead of connector and bearer work (CONTEXT decision 5).
	const httpShare = createFairShare({
		capacity: config.maxInflight,
		reserve: Math.floor((config.maxInflight * config.priorityReservePct) / 100),
		perPrincipalMax: Math.ceil(config.maxInflight / 2),
		queue: { depth: config.fairQueueDepth, waitMs: config.fairQueueWaitMs },
		security: securityEvents,
	});
	const quota = createAdaptiveQuota({ minFactor: config.adaptiveQuotaMinPct / 100, lagTargetMs: config.lagTargetMs });
	const clock = deps.now ?? Date.now;
	const penalty = createPenaltyLadder({
		windowMs: PENALTY_WINDOW_MS,
		failuresPerWindow: config.abuseFailuresPerMinute,
		baseSec: config.penaltyBaseSec,
		maxSec: config.penaltyMaxSec,
		decayMs: PENALTY_DECAY_MS,
		maxKeys: PENALTY_KEYS,
		now: clock,
		security: securityEvents,
	});
	const historyPath = join(config.stateDir, LOAD_HISTORY_FILE);
	const history = restoreHistory(historyPath, logger);
	const drain = createDrainState(deps.now);
	// Refreshed by start() and after each retention sweep; openStore already ran quick_check at startup.
	let integrityOk = true;
	// One detector per runtime signal, and the in-process SLO tracker; both live as long as this app.
	const signalDetectors = {
		event_loop_lag: createSignalDetector(),
		rss: createSignalDetector(),
		heap_used: createSignalDetector(),
	};
	const sloTracker = createSloTracker({ name: SLO_NAME, objective: SLO_OBJECTIVE, windowMs: SLO_WINDOW_MS }, { maxSamples: SLO_MAX_SAMPLES });
	// Spans are exported only when a collector is configured; a caller may inject a sink instead.
	const spans: SpanSink | undefined =
		deps.spans ??
		(config.otlpEndpoint === undefined
			? undefined
			: createSpanExporter({
					endpoint: config.otlpEndpoint,
					serviceName: "ultrathink",
					serviceVersion: pkg.version,
					onDrop: () => metrics.inc("ultrathink_otel_spans_dropped_total", { reason: "queue_full" }),
					onFailure: () => metrics.inc("ultrathink_otel_export_failures_total"),
				}));
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
			...(spans === undefined ? {} : { spans }),
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
		countAbuse(ctx);
		return fail(429, "rate_limited", { "Retry-After": String(retryAfterSec) });
	}

	/**
	 * Counts one failed credential or refused rate limit against the caller's IP. An escalation is audited and counted;
	 * a key the table could not track is counted apart, so the gap shows.
	 */
	function countAbuse(ctx: RequestCtx): void {
		const outcome = penalty.fail(ctx.ip);
		if (outcome.escalated) {
			record("abuse_penalty", { ip: ctx.ip, level: outcome.level, blockedSec: outcome.blockedSec });
			metrics.inc("ultrathink_abuse_penalty_total");
		}
		if (!outcome.tracked) metrics.inc("ultrathink_abuse_untracked_total");
	}

	/**
	 * Runs `work` while holding one HTTP pool slot for `admission`. An over-budget request waits in the pool queue until
	 * a slot frees, its wait expires, or `signal` aborts. A refused or expired request answers 429 with a one-second retry
	 * and runs nothing. While `work` runs, the admission sits on the request context, so planner work it starts takes a
	 * plan slot under the same class and principal.
	 */
	async function admitted(admission: Admission, signal: AbortSignal, work: () => Promise<Response>): Promise<Response> {
		const slot = await httpShare.admit(admission, { signal });
		if (!slot.ok) {
			if ("reason" in slot) metrics.inc("ultrathink_fair_share_refused_total", { class: admission.class, reason: slot.reason });
			return fail(429, "rate_limited", { "Retry-After": "1" });
		}
		const context = currentRequestContext();
		if (context) context.admission = admission;
		try {
			return await work();
		} finally {
			if (context) context.admission = undefined;
			slot.release();
		}
	}

	function authFailed(kind: string): void {
		metrics.inc("ultrathink_auth_failures_total", { kind });
	}

	/** One line per refused credential: the endpoint, status and reason. Never the token, cookie or password. */
	function tokenRejected(ctx: RequestCtx, kind: string, status: number, reason: string): void {
		securityEvents.log(
			createSecurityEvent(SecurityEventType.AUTH_FAILURE, {
				name: "oauth.token_rejected",
				source: "auth",
				severity: "medium",
				ip: ctx.ip,
				resource: ctx.endpoint,
				action: kind,
				details: { reqId: ctx.reqId, status, reason },
			}),
		);
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
		const password = validateBody(parsed.value, LOGIN_BODY)?.password;
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
		securityEvents.log(createSecurityEvent(SecurityEventType.AUTH_FAILURE, { name: "auth.login_failed", source: "auth", severity: "medium", ip: ctx.ip, resource: ctx.endpoint, details: { reqId: ctx.reqId } }));
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
		countAbuse(ctx);
		return null;
	}

	async function usageRoute(req: Request, ctx: RequestCtx): Promise<Response> {
		if (!sessionFor(req, ctx)) return fail(401, "unauthenticated");
		return respond(200, USAGE);
	}

	async function createRunRoute(req: Request, ctx: RequestCtx): Promise<Response> {
		const session = sessionFor(req, ctx);
		if (!session) return fail(401, "unauthenticated");

		const limit = auth.allowRequest({ clientIp: ctx.ip, ownerId: session.ownerId, scale: quota.factor() });
		if (!limit.ok) return rateLimited(ctx, "run", limit.retryAfterSec);

		return await admitted({ principal: "owner", class: "owner" }, req.signal, () => startRun(req, ctx, session));
	}

	/** Origin, envelope, input and flags, then the run is queued. Runs only while the owner holds a pool slot. */
	async function startRun(req: Request, ctx: RequestCtx, session: { ownerId: "owner" }): Promise<Response> {
		if (req.headers.get("origin") !== config.publicOrigin) return fail(403, "forbidden");
		if (!isJsonRequest(req)) return fail(415, "unsupported_media_type");

		const parsed = await readJson(req, config.maxBodyBytes);
		if (!parsed.ok) return parsed.response;
		// Only the envelope is checked here; input and flags are checked below.
		const body = validateBody(parsed.value, {});
		if (body === null) return fail(400, "invalid_input");

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
			if (bearer === "invalid") tokenRejected(ctx, "bearer", 401, "invalid_token");
			else if (presentedKey !== null) tokenRejected(ctx, "connector_key", 401, "invalid_key");
			const challenge = `Bearer resource_metadata="${oauth.resourceMetadataUrl}"${bearer === "invalid" ? ', error="invalid_token"' : ""}`;
			countAbuse(ctx);
			return fail(401, "unauthenticated", { "WWW-Authenticate": challenge });
		}

		const limit = auth.allowRequest({ clientIp: ctx.ip, ownerId: CONNECTOR_RATE_OWNER, principal, ownerLimit: CONNECTOR_OWNER_LIMIT, scale: quota.factor() });
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

		const answer = async (): Promise<Response> => {
			const reply = await handleMcpPayload(mcpHost, parsed.value, { protocolVersion: version.version });
			if (reply === null) return new Response(null, { status: 202, headers: SECURITY_HEADERS });
			return respond(reply.status ?? 200, reply.body);
		};
		// Discovery and initialize are not pooled; a tool call or a batch holds one slot while it runs.
		if (ctx.rpcMethod !== "tools/call" && ctx.rpcMethod !== "batch") return await answer();
		return await admitted({ principal, class: ctx.authKind === "connector-key" ? "connector" : "bearer" }, req.signal, answer);
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
			case "oauth_token": {
				const response = await oauth.token(req, ctx.ip);
				if (response.status >= 400) tokenRejected(ctx, "oauth_token", response.status, await oauthErrorCode(response));
				return response;
			}
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

	async function handle(req: Request, peerIp: string, peer?: { spiffeId: string | null }): Promise<Response> {
		const started = performance.now();
		const startedWall = Date.now();
		// Only the edge identity may vouch for X-Real-IP. Without TLS there is no identity, so undefined keeps the loopback rule.
		const spiffeId = peer?.spiffeId ?? null;
		const trustForwarded = config.tls === undefined ? undefined : isEdgeIdentity(spiffeId, config.spiffeTrustDomain);
		// A valid inbound traceparent is continued under a new span; anything else starts a fresh trace.
		const inbound = traceContextFor(req.headers.get("traceparent"));
		const server = inbound.inherited ? childSpan(inbound.ctx) : inbound.ctx;
		const ctx: RequestCtx = {
			reqId: sanitizeRequestId(req.headers.get("x-request-id")) ?? newRequestId(),
			ip: clientIpFrom(req, peerIp, trustForwarded),
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
				const blockedSec = ungated ? 0 : penalty.blockedSec(ctx.ip);
				const group = routeGroupOf(target);
				if (config.tls !== undefined && !authorize(spiffeId, group, config.spiffeTrustDomain)) {
					logger.warn("identity_denied", { reqId: ctx.reqId, group, reason: spiffeId === null ? "absent" : "not_authorized" });
					response = fail(403, "forbidden_identity");
				} else if (blockedSec > 0) {
					metrics.inc("ultrathink_rate_limited_total", { scope: "penalty" });
					response = fail(429, "rate_limited", { "Retry-After": String(blockedSec) });
				} else {
					const slot = ungated ? undefined : inflight.enter();
					if (slot === null) {
						metrics.inc("ultrathink_overload_total");
						response = fail(503, "overloaded", { "Retry-After": "1" });
					} else {
						release = slot;
						if (!ungated) history.record(clock());
						metrics.gauge("ultrathink_http_inflight", inflight.count);
						response = await dispatch(req, ctx, target);
					}
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
			if (server.sampled && spans !== undefined) {
				// Method, status and endpoint only: never the path, query, headers, peer IP or any credential.
				const startUnixNano = BigInt(startedWall) * NS_PER_MS;
				spans.record({
					traceId: server.traceId,
					spanId: server.spanId,
					...(inbound.inherited ? { parentSpanId: inbound.ctx.spanId } : {}),
					name: `${req.method} ${ctx.endpoint}`,
					kind: 2,
					startUnixNano,
					endUnixNano: startUnixNano + BigInt(Math.round(elapsedMs * 1_000_000)),
					attributes: {
						"http.request.method": req.method,
						"http.response.status_code": response.status,
						"ultrathink.endpoint": ctx.endpoint,
						"ultrathink.req_id": ctx.reqId,
					},
					error: response.status >= 500,
				});
			}
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

	/**
	 * One runtime sample: one AIMD step on the adaptive quota, then the factor, the forecast and the replica
	 * recommendation as gauges. The probe calls it on every sample; tests call it directly.
	 */
	function observeRuntime(sample: RuntimeSample): void {
		quota.observe({ lagMs: sample.eventLoopLagMs, utilisation: inflight.count / inflight.max });
		const { rps } = history.forecast(clock());
		metrics.gauge("ultrathink_adaptive_quota_factor", quota.factor());
		metrics.gauge("ultrathink_load_forecast_rps", rps);
		metrics.gauge("ultrathink_recommended_replicas", recommendedReplicas(rps, config.replicaCapacityRps));
		observeSignals(sample);
		observeSlo(clock());
		// Flush is single-flight and the sink never rejects, so the runtime sample does not wait for the export.
		spans?.flush?.()?.catch(() => undefined);
	}

	/** Feeds the three runtime signals to their detectors and publishes activity; each transition is counted and logged once. */
	function observeSignals(sample: RuntimeSample): void {
		const readings: Array<[keyof typeof signalDetectors, number]> = [
			["event_loop_lag", sample.eventLoopLagMs / 1000],
			["rss", sample.rssBytes],
			["heap_used", sample.heapUsedBytes],
		];
		for (const [signal, value] of readings) {
			const state = signalDetectors[signal].observe(value);
			metrics.gauge("ultrathink_anomaly_active", state.active ? 1 : 0, { signal });
			if (state.transition !== undefined) {
				metrics.inc("ultrathink_anomaly_transitions_total", { signal, to: state.transition });
				logger.warn("anomaly", { signal, to: state.transition });
			}
		}
	}

	/** Feeds one cumulative sample of the request counters to the SLO tracker, then publishes its budget and burn-rate gauges. */
	function observeSlo(now: number): void {
		const total = metrics.sum("ultrathink_http_requests_total");
		const bad = metrics.sum("ultrathink_http_requests_total", { status_class: "5xx" });
		sloTracker.observe({ at: now, good: total - bad, total });
		const budget = sloTracker.budget(now);
		if (budget.errorBudgetRemaining !== undefined) {
			metrics.gauge("ultrathink_slo_error_budget_remaining_ratio", budget.errorBudgetRemaining, { slo: SLO_NAME });
		}
		metrics.gauge("ultrathink_slo_observed_seconds", budget.observedMs / 1000, { slo: SLO_NAME });
		for (const burnWindow of SLO_BURN_WINDOWS) {
			const burnRate = sloTracker.budget(now, burnWindow.ms).burnRate;
			if (burnRate !== undefined) metrics.gauge("ultrathink_slo_burn_rate", burnRate, { slo: SLO_NAME, window: burnWindow.label });
		}
	}

	/** One retention sweep, timed. The sweeper and runSweepNow both run it. */
	function sweepTimed(): SweepResult {
		const began = performance.now();
		try {
			return sweepStateDir({ stateDir: config.stateDir, retentionDays: config.retentionDays, now: deps.now });
		} finally {
			metrics.observe("ultrathink_retention_sweep_duration_seconds", (performance.now() - began) / 1000);
		}
	}

	function onSweepResult(result: SweepResult): void {
		for (const kind of ["jobs", "sessions", "journals"] as const) {
			metrics.inc("ultrathink_retention_removed_total", { kind }, result.removed[kind]);
		}
		if (result.errors > 0) {
			metrics.inc("ultrathink_retention_errors_total", undefined, result.errors);
			logger.warn("retention_errors", { errors: result.errors });
		}
		refreshIntegrity();
	}

	function onSweepError(error: Error): void {
		metrics.inc("ultrathink_retention_errors_total");
		logger.error("retention_failed", { error: error.message });
	}

	/** Runs one retention sweep now, timed and handled as the sweeper handles its runs. A test hook. */
	function runSweepNow(): void {
		try {
			onSweepResult(sweepTimed());
		} catch (error) {
			onSweepError(error instanceof Error ? error : new Error(String(error)));
		}
	}

	let stopProbe: (() => void) | undefined;
	let stopSweeper: (() => void) | undefined;
	let stopCheckpoint: (() => void) | undefined;
	let stopWatch: (() => void) | undefined;
	let watchIdle: (() => Promise<void>) | undefined;
	let closeVerifier: (() => void) | undefined;
	let stopPrune: (() => void) | undefined;
	let stopHistorySave: (() => void) | undefined;
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
				observeRuntime(sample);
			},
		}).start();
		if (config.retentionDays > 0) {
			stopSweeper = createSweeper({
				sweep: sweepTimed,
				intervalMs: RETENTION_SWEEP_MS,
				onResult: onSweepResult,
				onError: onSweepError,
			}).start();
		}
		stopCheckpoint = createWalCheckpointer({
			checkpoint: () => store.checkpoint(),
			intervalMs: WAL_CHECKPOINT_MS,
			onBlocked: () => logger.warn("wal_checkpoint_blocked", {}),
		}).start();
		stopHistorySave = createSweeper({
			sweep: () => saveHistory(history, historyPath, logger),
			intervalMs: HISTORY_SAVE_MS,
			...timerSeams,
		}).start();
		const log = auditLog;
		if (log !== undefined) {
			// The full chain scan runs in a worker thread, so retained history never holds the request path.
			const verifier = createAuditVerifier();
			const watch = createAuditWatch({
				intervalMs: config.auditWatchMs,
				stat: () => diskFingerprint(log.path),
				acknowledged: () => {
					const head = log.head();
					return { fingerprint: log.fingerprint(), seq: head.seq, hash: head.hash };
				},
				// Called from the watch's tick, in the same synchronous step as `stat`, so the identity and the bytes describe one moment.
				scan: (observed) => verifier.verify({ path: log.path, activeBytes: observed.size, activeIno: observed.ino, identity: chainIdentity(log.path) }),
				onAlert: (alert) => raiseTamper(alert.reason),
				onRecover: () => logger.info("audit_tamper_cleared", {}),
				onError: (error) => logger.error("audit_watch_failed", { error: errorMessage(error) }),
				...timerSeams,
			});
			stopWatch = watch.start();
			watchIdle = () => watch.idle();
			closeVerifier = () => verifier.close();
			if (config.auditRetentionDays > 0) {
				const now = deps.now ?? Date.now;
				stopPrune = createSweeper({
					sweep: () => log.prune(now() - config.auditRetentionDays * DAY_MS),
					intervalMs: RETENTION_SWEEP_MS,
					onResult: (result) => {
						if (result.segments > 0) logger.info("audit_segments_pruned", { segments: result.segments });
					},
					onError: (error) => logger.error("audit_prune_failed", { error: error.message }),
					...timerSeams,
				}).start();
			}
		}
		refreshIntegrity();
	}

	return {
		handle,
		start,
		observeRuntime,
		runSweepNow,
		beginDrain() {
			drain.begin();
		},
		async shutdown() {
			stopProbe?.();
			stopSweeper?.();
			stopCheckpoint?.();
			stopWatch?.();
			// Waits at most the flush window for a scan in flight. A verdict that lands in that window is judged and its alert is
			// queued before the sinks flush. A scan still running after it is abandoned unjudged; the next start checks the chain
			// again and reports a broken file through a moved_to notice.
			await waitUpTo(watchIdle?.() ?? Promise.resolve(), AUDIT_FLUSH_MS, (error) => logger.error("audit_watch_wait_failed", { error: errorMessage(error) }));
			closeVerifier?.();
			stopPrune?.();
			stopHistorySave?.();
			saveHistory(history, historyPath, logger);
			auditLog?.close();
			// Queued envelopes get a bounded chance to reach the sinks; anything still queued after that is dropped.
			if (!(await streams.flush(AUDIT_FLUSH_MS))) logger.warn("audit_sink_flush_incomplete", {});
			streams.close();
			await planner.shutdown();
			// Spans are flushed, then the exporter is closed; a sink without either method is simply skipped.
			await spans?.flush?.();
			await spans?.shutdown?.();
		},
		planner,
		metrics,
		logger,
	};
}

export function createHandler(deps: RouterDeps): (req: Request, peerIp: string) => Promise<Response> {
	return createApp(deps).handle;
}
