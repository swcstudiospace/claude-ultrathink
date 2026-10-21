// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

export class ConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ConfigError";
	}
}

export type ReasoningEffort = "minimal" | "low" | "medium" | "high";

export interface UltrathinkConfig {
	publicOrigin: string;
	ownerPasswordHash: string;
	sessionSecret: string;
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
	serverDecisions: boolean;
	/** Absent means the `reasoning` request parameter is not sent. */
	modelReasoningEffort?: ReasoningEffort;
}

const DEFAULT_STATE_DIR = "/var/lib/ultrathink";
const DEFAULT_PORT = 8795;
// Far above any model context. 0 means no limit; MAX_BODY_BYTES still bounds a request.
const DEFAULT_MAX_INPUT_CHARS = 4000000;
const DEFAULT_MAX_ANSWER_CHARS = 20000;
const MAX_BODY_BYTES = 1048576;
// 0 means unlimited for both token ceilings.
const DEFAULT_RUN_TOKEN_CEILING = 0;
const DEFAULT_DAILY_TOKEN_CEILING = 0;
const MIN_SESSION_SECRET_LENGTH = 32;
const MIN_CONNECTOR_KEY_LENGTH = 32;
const INTEGER_PATTERN = /^[0-9]+$/;
const PLANNING_MODEL_PATTERN = /^[A-Za-z0-9._:\/-]{1,80}$/;
const MIN_OPENROUTER_KEY_LENGTH = 20;
const DEFAULT_OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const DEFAULT_MAX_CONCURRENT_PLANS = 2;
// 0 means unlimited; a positive value is an explicit cap.
const DEFAULT_MODEL_TIMEOUT_MS = 0;
const DEFAULT_PLAN_TIMEOUT_MS = 0;
const DEFAULT_MODEL_MAX_OUTPUT_TOKENS = 0;
const REASONING_EFFORTS: readonly ReasoningEffort[] = ["minimal", "low", "medium", "high"];
const DEFAULT_REASONING_EFFORT: ReasoningEffort = "high";
const LOOPBACK_HOSTS: Record<string, true> = { localhost: true, "127.0.0.1": true };

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

/** Like readInteger, but `0` is accepted and means unlimited; any other value must lie in min..max. */
function readLimit(
	env: Record<string, string | undefined>,
	name: string,
	fallback: number,
	min: number,
	max: number,
): number {
	const raw = readOptional(env, name);
	if (raw !== undefined && INTEGER_PATTERN.test(raw) && Number(raw) === 0) {
		return 0;
	}
	return readInteger(env, name, fallback, min, max);
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
	if (url.protocol === "https:") {
		return raw;
	}
	if (url.protocol === "http:" && LOOPBACK_HOSTS[url.hostname] === true) {
		return raw;
	}
	throw new ConfigError(
		"ULTRATHINK_PUBLIC_ORIGIN must use https:// (http:// is allowed only for localhost or 127.0.0.1)",
	);
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

/** Unset means `high`, the strongest value this setting accepts; `default` omits the parameter. */
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

export function loadConfig(
	env: Record<string, string | undefined> = process.env,
): UltrathinkConfig {
	const stateDir = readOptional(env, "ULTRATHINK_STATE_DIR") ?? DEFAULT_STATE_DIR;
	const planningModel = readPlanningModel(env);
	const openRouterApiKey = readOpenRouterApiKey(env);
	return {
		publicOrigin: readPublicOrigin(env),
		ownerPasswordHash: readRequired(env, "ULTRATHINK_OWNER_PASSWORD_HASH"),
		sessionSecret: readSessionSecret(env),
		stateDir,
		dbPath: `${stateDir}/ultrathink.sqlite`,
		port: readInteger(env, "ULTRATHINK_PORT", DEFAULT_PORT, 1024, 65535),
		maxInputChars: readLimit(
			env,
			"ULTRATHINK_MAX_INPUT_CHARS",
			DEFAULT_MAX_INPUT_CHARS,
			1,
			Number.MAX_SAFE_INTEGER,
		),
		maxAnswerChars: readInteger(
			env,
			"ULTRATHINK_MAX_ANSWER_CHARS",
			DEFAULT_MAX_ANSWER_CHARS,
			1,
			200000,
		),
		maxBodyBytes: MAX_BODY_BYTES,
		runTokenCeiling: readLimit(
			env,
			"ULTRATHINK_RUN_TOKEN_CEILING",
			DEFAULT_RUN_TOKEN_CEILING,
			1,
			Number.MAX_SAFE_INTEGER,
		),
		dailyTokenCeiling: readLimit(
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
		modelTimeoutMs: readLimit(
			env,
			"ULTRATHINK_MODEL_TIMEOUT_MS",
			DEFAULT_MODEL_TIMEOUT_MS,
			5000,
			600000,
		),
		planTimeoutMs: readLimit(
			env,
			"ULTRATHINK_PLAN_TIMEOUT_MS",
			DEFAULT_PLAN_TIMEOUT_MS,
			30000,
			1800000,
		),
		modelMaxOutputTokens: readLimit(
			env,
			"ULTRATHINK_MODEL_MAX_OUTPUT_TOKENS",
			DEFAULT_MODEL_MAX_OUTPUT_TOKENS,
			256,
			32000,
		),
		serverDecisions: readFlag(env, "ULTRATHINK_SERVER_DECISIONS") === true,
		modelReasoningEffort: readReasoningEffort(env),
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
