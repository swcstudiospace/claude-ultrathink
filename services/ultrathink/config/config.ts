// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

export class ConfigError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ConfigError";
	}
}

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
}

const DEFAULT_STATE_DIR = "/var/lib/ultrathink";
const DEFAULT_PORT = 8795;
const DEFAULT_MAX_INPUT_CHARS = 8000;
const DEFAULT_MAX_ANSWER_CHARS = 20000;
const MAX_BODY_BYTES = 16384;
const DEFAULT_RUN_TOKEN_CEILING = 150000;
const DEFAULT_DAILY_TOKEN_CEILING = 1000000;
const MIN_SESSION_SECRET_LENGTH = 32;
const MIN_CONNECTOR_KEY_LENGTH = 32;
const INTEGER_PATTERN = /^[0-9]+$/;
const PLANNING_MODEL_PATTERN = /^[A-Za-z0-9._:\/-]{1,80}$/;
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

export function loadConfig(
	env: Record<string, string | undefined> = process.env,
): UltrathinkConfig {
	const stateDir = readOptional(env, "ULTRATHINK_STATE_DIR") ?? DEFAULT_STATE_DIR;
	return {
		publicOrigin: readPublicOrigin(env),
		ownerPasswordHash: readRequired(env, "ULTRATHINK_OWNER_PASSWORD_HASH"),
		sessionSecret: readSessionSecret(env),
		stateDir,
		dbPath: `${stateDir}/ultrathink.sqlite`,
		port: readInteger(env, "ULTRATHINK_PORT", DEFAULT_PORT, 1024, 65535),
		maxInputChars: readInteger(
			env,
			"ULTRATHINK_MAX_INPUT_CHARS",
			DEFAULT_MAX_INPUT_CHARS,
			1,
			20000,
		),
		maxAnswerChars: readInteger(
			env,
			"ULTRATHINK_MAX_ANSWER_CHARS",
			DEFAULT_MAX_ANSWER_CHARS,
			1,
			200000,
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
		planningModel: readPlanningModel(env),
		connectorKey: readConnectorKey(env),
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
