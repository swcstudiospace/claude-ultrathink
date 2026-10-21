// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { isAbsolute } from "node:path";
import { type AnomalyRule, parseAnomalyRules } from "../obs/anomaly.ts";

export class ConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ConfigError";
	}
}

export type ReasoningEffort = "minimal" | "low" | "medium" | "high";

/** `host:port` of the syslog audit sink. */
export interface AuditSyslogTarget {
	readonly host: string;
	readonly port: number;
}

/** Absolute paths of the mTLS listener files: server certificate, its key, and the CA that signs client certificates. */
export interface TlsFiles {
	readonly certFile: string;
	readonly keyFile: string;
	readonly clientCaFile: string;
}

export interface UltrathinkConfig {
	publicOrigin: string;
	ownerPasswordHash: string;
	sessionSecret: string;
	/** Earlier session secrets still accepted for existing cookies, so a rotation does not sign everyone out. */
	sessionSecretPrevious: string[];
	stateDir: string;
	dbPath: string;
	port: number;
	maxInputChars: number;
	maxAnswerChars: number;
	maxBodyBytes: number;
	runTokenCeiling: number;
	dailyTokenCeiling: number;
	planningModel: string | undefined;
	connectorKey: string | undefined;
	allowedOrigins: string[];
	oauthRedirectOrigins: string[];
	openRouterApiKey: string | undefined;
	openRouterBaseUrl: string;
	serverPlanning: boolean;
	maxConcurrentPlans: number;
	modelTimeoutMs: number;
	planTimeoutMs: number;
	modelMaxOutputTokens: number;
	/** Absent means the `reasoning` request parameter is not sent. */
	modelReasoningEffort?: ReasoningEffort;
	/** Failures counted within `breakerWindowMs` that open the upstream breaker; 0 disables it. */
	breakerFailures: number;
	/** Window in which upstream failures are counted. */
	breakerWindowMs: number;
	/** How long the upstream breaker stays open before it lets a trial request through. */
	breakerOpenMs: number;
	/** Upper bound on concurrent HTTP requests the router admits. */
	maxInflight: number;
	/** Share of `maxInflight` (percent, 0..90) that non-owner classes may not take, so owners always have headroom. */
	priorityReservePct: number;
	/** Lowest percentage the adaptive quota may shrink the request windows to. */
	adaptiveQuotaMinPct: number;
	/** Event-loop lag above which the process counts as under pressure and the adaptive quota shrinks. */
	lagTargetMs: number;
	/** Requests per second one replica is assumed to serve; uncalibrated until a load test sets it. */
	replicaCapacityRps: number;
	/** Failed credentials and rate-limit refusals per minute from one IP that start an abuse penalty. */
	abuseFailuresPerMinute: number;
	/** Length of an IP's first abuse penalty block. */
	penaltyBaseSec: number;
	/** Longest abuse penalty block; never below `penaltyBaseSec`. */
	penaltyMaxSec: number;
	/** Wait after shutdown begins, before the server stops, so in-flight work can finish. */
	drainMs: number;
	/** Days of finished jobs, sessions and journals to keep; 0 disables the sweep. */
	retentionDays: number;
	/** Whether the append-only audit log is written. */
	auditLog: boolean;
	/** Audit records between anchor records (hash-chain checkpoints). */
	auditAnchorEvery: number;
	/** Size at which the active audit file is sealed into a segment. */
	auditSegmentBytes: number;
	/** Days of sealed audit segments kept; 0 keeps all. */
	auditRetentionDays: number;
	/** Interval of the audit tamper watch. */
	auditWatchMs: number;
	/** Envelopes each audit sink may hold waiting before the oldest is dropped. */
	auditSinkQueue: number;
	/** Anomaly rules; absent means the built-in rules. */
	auditRules?: AnomalyRule[];
	/** HTTP audit sink endpoint: https, or http to 127.0.0.1 or localhost. */
	auditHttpUrl?: string;
	/** Token for the HTTP audit sink. Never echoed in errors. */
	auditHttpToken?: string;
	/** Syslog audit sink target. */
	auditSyslog?: AuditSyslogTarget;
	/** Kafka REST proxy endpoint; set together with auditKafkaTopic. */
	auditKafkaRestUrl?: string;
	/** Kafka topic; set together with auditKafkaRestUrl. */
	auditKafkaTopic?: string;
	/** OTLP/JSON trace collector base URL: https, or http to 127.0.0.1, localhost or [::1]. Absent disables span export. */
	otlpEndpoint?: string;
	/** mTLS listener files: absolute paths, all three or none. Absent only with the plaintext loopback opt-in. */
	tls: TlsFiles | undefined;
	/** SPIFFE trust domain that peer certificate identities must belong to. */
	spiffeTrustDomain: string;
	/** Set when the service may run without TLS: dev and local smoke only. */
	plaintextLoopback: boolean;
	/** Chaos gate (ULTRATHINK_CHAOS). Fault injection at the upstream seam is armed only when this is true. */
	chaosEnabled: boolean;
	/** ULTRATHINK_CHAOS_ENV; must be `staging` whenever chaos is enabled. */
	chaosEnv?: string;
	/** Absolute fault-plan path (ULTRATHINK_CHAOS_PLAN); required whenever chaos is enabled. */
	chaosPlanPath?: string;
}

const DEFAULT_STATE_DIR = "/var/lib/ultrathink";
const DEFAULT_PORT = 8795;
const DEFAULT_MAX_INPUT_CHARS = 8000;
const DEFAULT_MAX_ANSWER_CHARS = 20000;
const MAX_BODY_BYTES = 65536;
// Prompts and answers travel inside a JSON request body that Bun caps at MAX_BODY_BYTES, so both
// char limits must fit it or Bun answers 413 before the app can say input_too_long/answer_too_long.
// A length counts UTF-16 code units; each encodes to at most 3 UTF-8 bytes (an astral code point is
// two units for four bytes). The rest is the allowance for the JSON-RPC envelope and JSON escaping,
// sized so the ceiling is 20000 chars: the documented maximum, and the default answer limit.
const MAX_UTF8_BYTES_PER_CHAR = 3;
const BODY_ENVELOPE_BYTES = 5536;
const MAX_BODY_CHARS = Math.floor((MAX_BODY_BYTES - BODY_ENVELOPE_BYTES) / MAX_UTF8_BYTES_PER_CHAR);
const DEFAULT_RUN_TOKEN_CEILING = 150000;
const DEFAULT_DAILY_TOKEN_CEILING = 1000000;
const MIN_SESSION_SECRET_LENGTH = 32;
const MIN_CONNECTOR_KEY_LENGTH = 32;
const MAX_PREVIOUS_SESSION_SECRETS = 4;
const INTEGER_PATTERN = /^[0-9]+$/;
const PLANNING_MODEL_PATTERN = /^[A-Za-z0-9._:\/-]{1,80}$/;
const MIN_OPENROUTER_KEY_LENGTH = 20;
const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_MAX_CONCURRENT_PLANS = 2;
const DEFAULT_MODEL_TIMEOUT_MS = 240000;
const DEFAULT_PLAN_TIMEOUT_MS = 600000;
const DEFAULT_MODEL_MAX_OUTPUT_TOKENS = 8000;
const REASONING_EFFORTS: readonly ReasoningEffort[] = ["minimal", "low", "medium", "high"];
const DEFAULT_REASONING_EFFORT: ReasoningEffort = "low";
// The formats Bun.password.verify accepts: PHC argon2 strings and modular-crypt bcrypt strings.
const OWNER_HASH_FORMAT =
	/^(?:\$argon2(?:id|i|d)\$v=\d+\$m=\d+,t=\d+,p=\d+\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+|\$2[abxy]\$\d{2}\$[./A-Za-z0-9]{53})$/;
const LOOPBACK_HOSTS: Record<string, true> = { localhost: true, "127.0.0.1": true };
const OTLP_LOOPBACK_HOSTS: Record<string, true> = { localhost: true, "127.0.0.1": true, "[::1]": true };
const DEFAULT_AUDIT_ANCHOR_EVERY = 1000;
const DEFAULT_AUDIT_SEGMENT_BYTES = 67108864;
const DEFAULT_AUDIT_RETENTION_DAYS = 365;
const DEFAULT_AUDIT_WATCH_MS = 1000;
const DEFAULT_AUDIT_SINK_QUEUE = 10000;
const MIN_AUDIT_HTTP_TOKEN_LENGTH = 16;
const DEFAULT_SPIFFE_TRUST_DOMAIN = "ultrathink.internal";
const TRUST_DOMAIN_PATTERN = /^[a-z0-9._-]{1,255}$/;
const TLS_VARIABLES = ["ULTRATHINK_TLS_CERT", "ULTRATHINK_TLS_KEY", "ULTRATHINK_TLS_CLIENT_CA"] as const;

function readOptional(
	env: Record<string, string | undefined>,
	name: string,
): string | undefined {
	const trimmed = env[name]?.trim();
	return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

function readRequired(
	env: Record<string, string | undefined>,
	name: string,
): string {
	const value = readOptional(env, name);
	if (value === undefined) {
		throw new ConfigError(`${name} is required`);
	}
	return value;
}

function readInteger(
	env: Record<string, string | undefined>,
	name: string,
	fallback: number,
	min: number,
	max: number,
): number {
	const raw = readOptional(env, name);
	if (raw === undefined) {
		return fallback;
	}
	const message = `${name} must be an integer between ${min} and ${max}`;
	if (!INTEGER_PATTERN.test(raw)) {
		throw new ConfigError(message);
	}
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value < min || value > max) {
		throw new ConfigError(message);
	}
	return value;
}

function readPublicOrigin(env: Record<string, string | undefined>): string {
	const raw = readRequired(env, "ULTRATHINK_PUBLIC_ORIGIN");
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new ConfigError(
			"ULTRATHINK_PUBLIC_ORIGIN must be an absolute https:// URL",
		);
	}
	if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK_HOSTS[url.hostname] === true)) {
		throw new ConfigError(
			"ULTRATHINK_PUBLIC_ORIGIN must use https:// (http:// is allowed only for localhost or 127.0.0.1)",
		);
	}
	// Consumers build "<origin>/mcp" and compare it with the browser's Origin
	// header, so only scheme, host and port may be configured; a trailing slash
	// is dropped and the host is lower-cased by url.origin.
	if (url.username !== "" || url.password !== "" || url.pathname !== "/" || raw.includes("?") || raw.includes("#")) {
		throw new ConfigError(
			"ULTRATHINK_PUBLIC_ORIGIN must be an origin only (scheme, host and optional port, with no credentials, path, query or fragment)",
		);
	}
	return url.origin;
}

function readOwnerPasswordHash(env: Record<string, string | undefined>): string {
	const hash = readRequired(env, "ULTRATHINK_OWNER_PASSWORD_HASH");
	if (!OWNER_HASH_FORMAT.test(hash)) {
		// A "$argon2id$..." value expanded by a shell or compose file loses its
		// "$name" segments; never echo the value.
		throw new ConfigError(
			"ULTRATHINK_OWNER_PASSWORD_HASH must be an argon2 or bcrypt hash as produced by Bun.password.hash (check that no '$' segment was shell-expanded)",
		);
	}
	return hash;
}

function readSessionSecret(env: Record<string, string | undefined>): string {
	const secret = readRequired(env, "ULTRATHINK_SESSION_SECRET");
	if (secret.length < MIN_SESSION_SECRET_LENGTH) {
		throw new ConfigError(
			`ULTRATHINK_SESSION_SECRET must be at least ${MIN_SESSION_SECRET_LENGTH} characters`,
		);
	}
	return secret;
}

function readPreviousSessionSecrets(env: Record<string, string | undefined>): string[] {
	const raw = readOptional(env, "ULTRATHINK_SESSION_SECRET_PREVIOUS");
	if (raw === undefined) {
		return [];
	}
	const secrets = raw
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry !== "");
	if (secrets.some((secret) => secret.length < MIN_SESSION_SECRET_LENGTH)) {
		throw new ConfigError(
			`ULTRATHINK_SESSION_SECRET_PREVIOUS entries must be at least ${MIN_SESSION_SECRET_LENGTH} characters`,
		);
	}
	if (secrets.length > MAX_PREVIOUS_SESSION_SECRETS) {
		throw new ConfigError(
			`ULTRATHINK_SESSION_SECRET_PREVIOUS may list at most ${MAX_PREVIOUS_SESSION_SECRETS} secrets`,
		);
	}
	return secrets;
}

function readPlanningModel(
	env: Record<string, string | undefined>,
): string | undefined {
	const model = readOptional(env, "ULTRATHINK_PLANNING_MODEL");
	if (model !== undefined && !PLANNING_MODEL_PATTERN.test(model)) {
		throw new ConfigError(
			"ULTRATHINK_PLANNING_MODEL must be 1-80 characters from A-Z, a-z, 0-9, '.', '_', ':', '/', '-'",
		);
	}
	return model;
}

function readConnectorKey(env: Record<string, string | undefined>): string | undefined {
	const key = readOptional(env, "ULTRATHINK_CONNECTOR_KEY");
	if (key !== undefined && key.length < MIN_CONNECTOR_KEY_LENGTH) {
		throw new ConfigError(`ULTRATHINK_CONNECTOR_KEY must be at least ${MIN_CONNECTOR_KEY_LENGTH} characters`);
	}
	return key;
}

/** Unset means `low`: the pipeline already writes its reasoning out, so hidden reasoning only adds latency. `default` omits the parameter. */
function readReasoningEffort(env: Record<string, string | undefined>): ReasoningEffort | undefined {
	const name = "ULTRATHINK_MODEL_REASONING_EFFORT";
	const raw = readOptional(env, name);
	if (raw === undefined) {
		return DEFAULT_REASONING_EFFORT;
	}
	if (raw === "default") {
		return undefined;
	}
	if (!REASONING_EFFORTS.includes(raw as ReasoningEffort)) {
		throw new ConfigError(`${name} must be one of minimal, low, medium, high or default`);
	}
	return raw as ReasoningEffort;
}

function readFlag(
	env: Record<string, string | undefined>,
	name: string,
): boolean | undefined {
	const raw = readOptional(env, name);
	if (raw === undefined) {
		return undefined;
	}
	if (raw === "1") {
		return true;
	}
	if (raw === "0") {
		return false;
	}
	throw new ConfigError(`${name} must be 0 or 1`);
}

function readOpenRouterApiKey(env: Record<string, string | undefined>): string | undefined {
	const key = readOptional(env, "OPENROUTER_API_KEY");
	if (key !== undefined && key.length < MIN_OPENROUTER_KEY_LENGTH) {
		throw new ConfigError(`OPENROUTER_API_KEY must be at least ${MIN_OPENROUTER_KEY_LENGTH} characters`);
	}
	return key;
}

function readOpenRouterBaseUrl(env: Record<string, string | undefined>): string {
	const name = "ULTRATHINK_OPENROUTER_BASE_URL";
	const raw = readOptional(env, name);
	if (raw === undefined) {
		return DEFAULT_OPENROUTER_BASE_URL;
	}
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new ConfigError(`${name} must be an absolute https:// URL`);
	}
	if (
		url.protocol !== "https:" ||
		url.username !== "" ||
		url.password !== "" ||
		url.search !== "" ||
		url.hash !== "" ||
		raw.includes("?") ||
		raw.includes("#")
	) {
		throw new ConfigError(
			`${name} must be an https:// URL without credentials, query or fragment`,
		);
	}
	return raw.replace(/\/+$/, "");
}

function readServerPlanning(
	env: Record<string, string | undefined>,
	apiKey: string | undefined,
	planningModel: string | undefined,
): boolean {
	const flag = readFlag(env, "ULTRATHINK_SERVER_PLANNING");
	if (flag === true) {
		if (apiKey === undefined) {
			throw new ConfigError("ULTRATHINK_SERVER_PLANNING=1 requires OPENROUTER_API_KEY");
		}
		if (planningModel === undefined) {
			throw new ConfigError("ULTRATHINK_SERVER_PLANNING=1 requires ULTRATHINK_PLANNING_MODEL");
		}
	}
	return flag !== false && apiKey !== undefined && planningModel !== undefined;
}

/** Comma list of bare origins (scheme://host[:port], no path, query, fragment or credentials), normalized and de-duplicated. */
function readOriginList(
	env: Record<string, string | undefined>,
	name: string,
	protocols: readonly string[],
): string[] {
	const raw = readOptional(env, name);
	if (raw === undefined) {
		return [];
	}
	const schemes = protocols.map((protocol) => `${protocol}//`).join(" or ");
	const message = `${name} must be a comma-separated list of bare origins starting with ${schemes} (no path, query, fragment or credentials)`;
	const origins = new Set<string>();
	for (const part of raw.split(",")) {
		const entry = part.trim();
		if (entry === "") {
			continue;
		}
		let url: URL;
		try {
			url = new URL(entry);
		} catch {
			throw new ConfigError(message);
		}
		const authority = entry.slice(entry.indexOf("//") + 2);
		if (
			!protocols.includes(url.protocol) ||
			!entry.toLowerCase().startsWith(`${url.protocol}//`) ||
			authority === "" ||
			/[\/?#@\\]/.test(authority)
		) {
			throw new ConfigError(message);
		}
		origins.add(url.origin);
	}
	return [...origins];
}

/** Absolute, without trailing slashes: `dbPath` appends `/ultrathink.sqlite`. */
function readStateDir(env: Record<string, string | undefined>): string {
	const raw = readOptional(env, "ULTRATHINK_STATE_DIR");
	if (raw === undefined) {
		return DEFAULT_STATE_DIR;
	}
	if (!isAbsolute(raw)) {
		throw new ConfigError("ULTRATHINK_STATE_DIR must be an absolute path");
	}
	return raw.replace(/(?<=.)\/+$/, "");
}

/** An http:// URL is accepted only for loopback, so audit records never leave the host in plaintext. */
function readSinkUrl(env: Record<string, string | undefined>, name: string): string | undefined {
	const raw = readOptional(env, name);
	if (raw === undefined) {
		return undefined;
	}
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new ConfigError(`${name} must be an absolute URL`);
	}
	if (url.username !== "" || url.password !== "") {
		throw new ConfigError(`${name} must not contain credentials`);
	}
	if (url.protocol === "https:" || (url.protocol === "http:" && LOOPBACK_HOSTS[url.hostname] === true)) {
		return raw;
	}
	throw new ConfigError(`${name} must use https://, or http:// to 127.0.0.1 or localhost`);
}

/**
 * The span collector base URL, stored without trailing slashes ("/v1/traces" is appended by the exporter). Plaintext
 * http is accepted only for loopback. The value is never echoed: a userinfo password must not reach a log.
 */
function readOtlpEndpoint(env: Record<string, string | undefined>): string | undefined {
	const name = "ULTRATHINK_OTLP_ENDPOINT";
	const raw = readOptional(env, name);
	if (raw === undefined) {
		return undefined;
	}
	let url: URL;
	try {
		url = new URL(raw);
	} catch {
		throw new ConfigError(`${name} must be an absolute URL`);
	}
	if (url.protocol !== "https:" && !(url.protocol === "http:" && OTLP_LOOPBACK_HOSTS[url.hostname] === true)) {
		throw new ConfigError(`${name} must use https://, or http:// to 127.0.0.1, localhost or [::1]`);
	}
	if (url.username !== "" || url.password !== "" || raw.includes("?") || raw.includes("#")) {
		throw new ConfigError(`${name} must be a URL without credentials, query or fragment`);
	}
	return raw.replace(/\/+$/, "");
}

function readAuditHttpToken(env: Record<string, string | undefined>): string | undefined {
	const name = "ULTRATHINK_AUDIT_HTTP_TOKEN";
	const token = readOptional(env, name);
	if (token === undefined) {
		return undefined;
	}
	if (token.length < MIN_AUDIT_HTTP_TOKEN_LENGTH) {
		throw new ConfigError(`${name} must be at least ${MIN_AUDIT_HTTP_TOKEN_LENGTH} characters`);
	}
	if (!/^[\x21-\x7e]+$/.test(token)) {
		throw new ConfigError(`${name} must contain only printable ASCII characters without spaces`);
	}
	return token;
}

/** `host:port`: host from letters, digits, '.', '_' and '-'; port from 1 to 65535. */
function readAuditSyslog(env: Record<string, string | undefined>): AuditSyslogTarget | undefined {
	const name = "ULTRATHINK_AUDIT_SYSLOG";
	const raw = readOptional(env, name);
	if (raw === undefined) {
		return undefined;
	}
	const message = `${name} must be host:port with a port from 1 to 65535`;
	const separator = raw.lastIndexOf(":");
	if (separator <= 0) {
		throw new ConfigError(message);
	}
	const host = raw.slice(0, separator);
	const digits = raw.slice(separator + 1);
	if (!/^[A-Za-z0-9._-]+$/.test(host) || !INTEGER_PATTERN.test(digits)) {
		throw new ConfigError(message);
	}
	const port = Number(digits);
	if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
		throw new ConfigError(message);
	}
	return { host, port };
}

/** Unset means the built-in rules. The JSON is parsed by the same validator the anomaly detector uses. */
function readAuditRules(env: Record<string, string | undefined>): AnomalyRule[] | undefined {
	const name = "ULTRATHINK_AUDIT_RULES";
	const raw = readOptional(env, name);
	if (raw === undefined) {
		return undefined;
	}
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		throw new ConfigError(`${name} must be a JSON array of anomaly rules`);
	}
	try {
		return parseAnomalyRules(value);
	} catch (error) {
		const reason = error instanceof Error ? error.message : "invalid rule";
		throw new ConfigError(`${name} is invalid: ${reason}`);
	}
}

/** The Kafka REST sink needs both its URL and its topic, or neither. */
function readKafkaSink(env: Record<string, string | undefined>): {
	auditKafkaRestUrl: string | undefined;
	auditKafkaTopic: string | undefined;
} {
	const auditKafkaRestUrl = readSinkUrl(env, "ULTRATHINK_AUDIT_KAFKA_REST_URL");
	const auditKafkaTopic = readOptional(env, "ULTRATHINK_AUDIT_KAFKA_TOPIC");
	if ((auditKafkaRestUrl === undefined) !== (auditKafkaTopic === undefined)) {
		throw new ConfigError(
			"ULTRATHINK_AUDIT_KAFKA_REST_URL and ULTRATHINK_AUDIT_KAFKA_TOPIC must be set together",
		);
	}
	return { auditKafkaRestUrl, auditKafkaTopic };
}

/** Penalty blocks: the cap may not sit below the first block, or every escalation would be capped from the start. */
function readPenaltyBlocks(env: Record<string, string | undefined>): {
	penaltyBaseSec: number;
	penaltyMaxSec: number;
} {
	const penaltyBaseSec = readInteger(env, "ULTRATHINK_PENALTY_BASE_SEC", 60, 1, 86400);
	const penaltyMaxSec = readInteger(env, "ULTRATHINK_PENALTY_MAX_SEC", 3600, 1, 86400);
	if (penaltyMaxSec < penaltyBaseSec) {
		throw new ConfigError(
			"ULTRATHINK_PENALTY_MAX_SEC must be greater than or equal to ULTRATHINK_PENALTY_BASE_SEC",
		);
	}
	return { penaltyBaseSec, penaltyMaxSec };
}

/** Absolute path from a variable that must be set; errors name the variable, never the path. */
function readAbsoluteFile(env: Record<string, string | undefined>, name: string): string {
	const path = readRequired(env, name);
	if (!isAbsolute(path)) {
		throw new ConfigError(`${name} must be an absolute path`);
	}
	return path;
}

/**
 * The three mTLS files are one set. Unset is allowed only with the plaintext loopback opt-in, the single way to run
 * without TLS; a partial set is refused even with it.
 */
function readTlsFiles(
	env: Record<string, string | undefined>,
	plaintextLoopback: boolean,
): TlsFiles | undefined {
	const present = TLS_VARIABLES.filter((name) => readOptional(env, name) !== undefined);
	if (present.length === 0) {
		if (plaintextLoopback) {
			return undefined;
		}
		throw new ConfigError(
			`${TLS_VARIABLES.join(", ")} must be set to absolute paths; ULTRATHINK_PLAINTEXT_LOOPBACK=1 allows plaintext for dev and local smoke only`,
		);
	}
	const missing = TLS_VARIABLES.filter((name) => !present.includes(name));
	if (missing.length > 0) {
		throw new ConfigError(`${TLS_VARIABLES.join(", ")} must be set together; missing ${missing.join(", ")}`);
	}
	return {
		certFile: readAbsoluteFile(env, "ULTRATHINK_TLS_CERT"),
		keyFile: readAbsoluteFile(env, "ULTRATHINK_TLS_KEY"),
		clientCaFile: readAbsoluteFile(env, "ULTRATHINK_TLS_CLIENT_CA"),
	};
}

function readSpiffeTrustDomain(env: Record<string, string | undefined>): string {
	const domain = readOptional(env, "ULTRATHINK_SPIFFE_TRUST_DOMAIN") ?? DEFAULT_SPIFFE_TRUST_DOMAIN;
	if (!TRUST_DOMAIN_PATTERN.test(domain)) {
		throw new ConfigError("ULTRATHINK_SPIFFE_TRUST_DOMAIN must be 1-255 characters from a-z, 0-9, '.', '_' and '-'");
	}
	return domain;
}

/**
 * Chaos gate. Fault injection is off unless ULTRATHINK_CHAOS=1. It is armed only with ULTRATHINK_CHAOS_ENV=staging and
 * an absolute ULTRATHINK_CHAOS_PLAN. A plan path without the flag is refused, so a stray variable cannot arm it.
 */
function readChaosGate(env: Record<string, string | undefined>): {
	chaosEnabled: boolean;
	chaosEnv: string | undefined;
	chaosPlanPath: string | undefined;
} {
	const chaosEnabled = readFlag(env, "ULTRATHINK_CHAOS") ?? false;
	const chaosEnv = readOptional(env, "ULTRATHINK_CHAOS_ENV");
	const chaosPlanPath = readOptional(env, "ULTRATHINK_CHAOS_PLAN");
	if (!chaosEnabled) {
		if (chaosPlanPath !== undefined) {
			throw new ConfigError("ULTRATHINK_CHAOS_PLAN requires ULTRATHINK_CHAOS=1");
		}
		return { chaosEnabled, chaosEnv, chaosPlanPath };
	}
	if (chaosEnv !== "staging") {
		throw new ConfigError("ULTRATHINK_CHAOS=1 requires ULTRATHINK_CHAOS_ENV=staging; chaos never runs outside staging");
	}
	if (chaosPlanPath === undefined) {
		throw new ConfigError("ULTRATHINK_CHAOS=1 requires ULTRATHINK_CHAOS_PLAN to be set");
	}
	if (!isAbsolute(chaosPlanPath)) {
		throw new ConfigError("ULTRATHINK_CHAOS_PLAN must be an absolute path");
	}
	return { chaosEnabled, chaosEnv, chaosPlanPath };
}

export function loadConfig(
	env: Record<string, string | undefined> = process.env,
): UltrathinkConfig {
	const stateDir = readStateDir(env);
	const planningModel = readPlanningModel(env);
	const openRouterApiKey = readOpenRouterApiKey(env);
	const plaintextLoopback = readFlag(env, "ULTRATHINK_PLAINTEXT_LOOPBACK") === true;
	return {
		publicOrigin: readPublicOrigin(env),
		ownerPasswordHash: readOwnerPasswordHash(env),
		sessionSecret: readSessionSecret(env),
		sessionSecretPrevious: readPreviousSessionSecrets(env),
		stateDir,
		dbPath: `${stateDir}/ultrathink.sqlite`,
		port: readInteger(env, "ULTRATHINK_PORT", DEFAULT_PORT, 1024, 65535),
		maxInputChars: readInteger(
			env,
			"ULTRATHINK_MAX_INPUT_CHARS",
			DEFAULT_MAX_INPUT_CHARS,
			1,
			MAX_BODY_CHARS,
		),
		maxAnswerChars: readInteger(
			env,
			"ULTRATHINK_MAX_ANSWER_CHARS",
			DEFAULT_MAX_ANSWER_CHARS,
			1,
			MAX_BODY_CHARS,
		),
		maxBodyBytes: MAX_BODY_BYTES,
		runTokenCeiling: readInteger(
			env,
			"ULTRATHINK_RUN_TOKEN_CEILING",
			DEFAULT_RUN_TOKEN_CEILING,
			1,
			Number.MAX_SAFE_INTEGER,
		),
		dailyTokenCeiling: readInteger(
			env,
			"ULTRATHINK_DAILY_TOKEN_CEILING",
			DEFAULT_DAILY_TOKEN_CEILING,
			1,
			Number.MAX_SAFE_INTEGER,
		),
		planningModel,
		connectorKey: readConnectorKey(env),
		allowedOrigins: readOriginList(env, "ULTRATHINK_ALLOWED_ORIGINS", ["https:", "http:"]),
		oauthRedirectOrigins: readOriginList(env, "ULTRATHINK_OAUTH_REDIRECT_ORIGINS", ["https:"]),
		openRouterApiKey,
		openRouterBaseUrl: readOpenRouterBaseUrl(env),
		serverPlanning: readServerPlanning(env, openRouterApiKey, planningModel),
		maxConcurrentPlans: readInteger(
			env,
			"ULTRATHINK_MAX_CONCURRENT_PLANS",
			DEFAULT_MAX_CONCURRENT_PLANS,
			1,
			8,
		),
		modelTimeoutMs: readInteger(
			env,
			"ULTRATHINK_MODEL_TIMEOUT_MS",
			DEFAULT_MODEL_TIMEOUT_MS,
			5000,
			600000,
		),
		planTimeoutMs: readInteger(
			env,
			"ULTRATHINK_PLAN_TIMEOUT_MS",
			DEFAULT_PLAN_TIMEOUT_MS,
			30000,
			1800000,
		),
		modelMaxOutputTokens: readInteger(
			env,
			"ULTRATHINK_MODEL_MAX_OUTPUT_TOKENS",
			DEFAULT_MODEL_MAX_OUTPUT_TOKENS,
			256,
			32000,
		),
		modelReasoningEffort: readReasoningEffort(env),
		breakerFailures: readInteger(env, "ULTRATHINK_BREAKER_FAILURES", 5, 0, 100),
		breakerWindowMs: readInteger(env, "ULTRATHINK_BREAKER_WINDOW_MS", 60000, 1000, 3600000),
		breakerOpenMs: readInteger(env, "ULTRATHINK_BREAKER_OPEN_MS", 30000, 1000, 600000),
		maxInflight: readInteger(env, "ULTRATHINK_MAX_INFLIGHT", 256, 1, 10000),
		priorityReservePct: readInteger(env, "ULTRATHINK_PRIORITY_RESERVE_PCT", 25, 0, 90),
		adaptiveQuotaMinPct: readInteger(env, "ULTRATHINK_ADAPTIVE_QUOTA_MIN_PCT", 50, 10, 100),
		lagTargetMs: readInteger(env, "ULTRATHINK_LAG_TARGET_MS", 100, 10, 5000),
		replicaCapacityRps: readInteger(env, "ULTRATHINK_REPLICA_CAPACITY_RPS", 20, 1, 100000),
		abuseFailuresPerMinute: readInteger(env, "ULTRATHINK_ABUSE_FAILURES_PER_MINUTE", 20, 1, 10000),
		...readPenaltyBlocks(env),
		drainMs: readInteger(env, "ULTRATHINK_DRAIN_MS", 5000, 0, 60000),
		retentionDays: readInteger(env, "ULTRATHINK_RETENTION_DAYS", 30, 0, 3650),
		auditLog: readFlag(env, "ULTRATHINK_AUDIT_LOG") ?? true,
		auditAnchorEvery: readInteger(env, "ULTRATHINK_AUDIT_ANCHOR_EVERY", DEFAULT_AUDIT_ANCHOR_EVERY, 1, 1000000),
		auditSegmentBytes: readInteger(
			env,
			"ULTRATHINK_AUDIT_SEGMENT_BYTES",
			DEFAULT_AUDIT_SEGMENT_BYTES,
			1048576,
			4294967296,
		),
		auditRetentionDays: readInteger(env, "ULTRATHINK_AUDIT_RETENTION_DAYS", DEFAULT_AUDIT_RETENTION_DAYS, 0, 36500),
		auditWatchMs: readInteger(env, "ULTRATHINK_AUDIT_WATCH_MS", DEFAULT_AUDIT_WATCH_MS, 100, 1000),
		auditSinkQueue: readInteger(env, "ULTRATHINK_AUDIT_SINK_QUEUE", DEFAULT_AUDIT_SINK_QUEUE, 1, 1000000),
		auditRules: readAuditRules(env),
		auditHttpUrl: readSinkUrl(env, "ULTRATHINK_AUDIT_HTTP_URL"),
		auditHttpToken: readAuditHttpToken(env),
		auditSyslog: readAuditSyslog(env),
		otlpEndpoint: readOtlpEndpoint(env),
		tls: readTlsFiles(env, plaintextLoopback),
		spiffeTrustDomain: readSpiffeTrustDomain(env),
		plaintextLoopback,
		...readChaosGate(env),
		...readKafkaSink(env),
	};
}

export function requirePlanningModel(config: UltrathinkConfig): string {
	if (config.planningModel === undefined) {
		throw new ConfigError(
			"ULTRATHINK_PLANNING_MODEL is required before planning can run",
		);
	}
	return config.planningModel;
}
