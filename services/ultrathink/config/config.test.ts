// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { ConfigError, loadConfig, requirePlanningModel } from "./config.ts";

function randomSecret(): string {
	return randomBytes(24).toString("base64url");
}

function randomHash(): string {
	const salt = randomBytes(16).toString("base64url");
	const digest = randomBytes(16).toString("base64url");
	return `$argon2id$v=19$m=65536,t=2,p=1$${salt}$${digest}`;
}

function baseEnv(): Record<string, string | undefined> {
	return {
		ULTRATHINK_PUBLIC_ORIGIN: "https://ultrathink.swcstudio.space",
		ULTRATHINK_OWNER_PASSWORD_HASH: randomHash(),
		ULTRATHINK_SESSION_SECRET: randomSecret(),
	};
}

function messageOf(fn: () => unknown): string {
	try {
		fn();
	} catch (error) {
		expect(error).toBeInstanceOf(ConfigError);
		return (error as Error).message;
	}
	throw new Error("expected function to throw");
}

describe("loadConfig required variables", () => {
	test("a missing required variable throws a ConfigError naming it without its value", () => {
		const env = baseEnv();
		const hash = env.ULTRATHINK_OWNER_PASSWORD_HASH as string;
		delete env.ULTRATHINK_OWNER_PASSWORD_HASH;
		const message = messageOf(() => loadConfig(env));
		expect(message).toContain("ULTRATHINK_OWNER_PASSWORD_HASH");
		expect(message).not.toContain(hash);
	});

	test("a blank required variable counts as unset", () => {
		const env = baseEnv();
		env.ULTRATHINK_PUBLIC_ORIGIN = "   ";
		const message = messageOf(() => loadConfig(env));
		expect(message).toContain("ULTRATHINK_PUBLIC_ORIGIN");
	});
});

describe("loadConfig defaults", () => {
	test("applies documented defaults and leaves planningModel unset", () => {
		const config = loadConfig(baseEnv());
		expect(config.stateDir).toBe("/var/lib/ultrathink");
		expect(config.dbPath).toBe("/var/lib/ultrathink/ultrathink.sqlite");
		expect(config.port).toBe(8795);
		expect(config.maxInputChars).toBe(8000);
		expect(config.maxAnswerChars).toBe(20000);
		expect(config.maxBodyBytes).toBe(16384);
		expect(config.runTokenCeiling).toBe(150000);
		expect(config.dailyTokenCeiling).toBe(1000000);
		expect(config.planningModel).toBeUndefined();
	});

	test("trims values before use", () => {
		const env = baseEnv();
		env.ULTRATHINK_PORT = "  9000  ";
		expect(loadConfig(env).port).toBe(9000);
	});

	test("derives dbPath from a custom stateDir", () => {
		const env = baseEnv();
		env.ULTRATHINK_STATE_DIR = "/tmp/ut-state";
		expect(loadConfig(env).dbPath).toBe("/tmp/ut-state/ultrathink.sqlite");
	});
});

describe("planningModel", () => {
	test("requirePlanningModel throws a ConfigError naming the variable when unset", () => {
		const config = loadConfig(baseEnv());
		const message = messageOf(() => requirePlanningModel(config));
		expect(message).toContain("ULTRATHINK_PLANNING_MODEL");
	});

	test("requirePlanningModel returns the model when set", () => {
		const env = baseEnv();
		env.ULTRATHINK_PLANNING_MODEL = "vendor/model-1.0:latest";
		const config = loadConfig(env);
		expect(requirePlanningModel(config)).toBe("vendor/model-1.0:latest");
	});

	test("a model name outside the allowed pattern is rejected without echoing it", () => {
		const env = baseEnv();
		env.ULTRATHINK_PLANNING_MODEL = "bad model name!";
		const message = messageOf(() => loadConfig(env));
		expect(message).toContain("ULTRATHINK_PLANNING_MODEL");
		expect(message).not.toContain("bad model name!");
	});
});

describe("strict integers", () => {
	for (const value of ["12abc", "1.5", "-3"]) {
		test(`rejects malformed port ${JSON.stringify(value)} without echoing it`, () => {
			const env = baseEnv();
			env.ULTRATHINK_PORT = value;
			const message = messageOf(() => loadConfig(env));
			expect(message).toContain("ULTRATHINK_PORT");
			expect(message).not.toContain(value);
		});
	}

	test("rejects a port below 1024", () => {
		const env = baseEnv();
		env.ULTRATHINK_PORT = "1023";
		expect(messageOf(() => loadConfig(env))).toContain("ULTRATHINK_PORT");
	});

	test("rejects a port above 65535", () => {
		const env = baseEnv();
		env.ULTRATHINK_PORT = "65536";
		expect(messageOf(() => loadConfig(env))).toContain("ULTRATHINK_PORT");
	});

	test("rejects maxInputChars above 20000", () => {
		const env = baseEnv();
		env.ULTRATHINK_MAX_INPUT_CHARS = "20001";
		expect(messageOf(() => loadConfig(env))).toContain(
			"ULTRATHINK_MAX_INPUT_CHARS",
		);
	});

	test("rejects a zero token ceiling", () => {
		const env = baseEnv();
		env.ULTRATHINK_RUN_TOKEN_CEILING = "0";
		expect(messageOf(() => loadConfig(env))).toContain(
			"ULTRATHINK_RUN_TOKEN_CEILING",
		);
	});

	test("rejects a malformed daily token ceiling", () => {
		const env = baseEnv();
		env.ULTRATHINK_DAILY_TOKEN_CEILING = "1e6";
		expect(messageOf(() => loadConfig(env))).toContain(
			"ULTRATHINK_DAILY_TOKEN_CEILING",
		);
	});
});

describe("publicOrigin", () => {
	test("rejects a non-loopback http origin", () => {
		const env = baseEnv();
		env.ULTRATHINK_PUBLIC_ORIGIN = "http://ultrathink.swcstudio.space";
		const message = messageOf(() => loadConfig(env));
		expect(message).toContain("ULTRATHINK_PUBLIC_ORIGIN");
		expect(message).not.toContain("ultrathink.swcstudio.space");
	});

	test("accepts http for localhost and 127.0.0.1", () => {
		const env = baseEnv();
		env.ULTRATHINK_PUBLIC_ORIGIN = "http://localhost:8792";
		expect(loadConfig(env).publicOrigin).toBe("http://localhost:8792");
		env.ULTRATHINK_PUBLIC_ORIGIN = "http://127.0.0.1:8792";
		expect(loadConfig(env).publicOrigin).toBe("http://127.0.0.1:8792");
	});

	test("rejects a value that is not an absolute URL", () => {
		const env = baseEnv();
		env.ULTRATHINK_PUBLIC_ORIGIN = "ultrathink.swcstudio.space";
		expect(messageOf(() => loadConfig(env))).toContain(
			"ULTRATHINK_PUBLIC_ORIGIN",
		);
	});
});

describe("sessionSecret", () => {
	test("rejects a secret shorter than 32 characters without echoing it", () => {
		const env = baseEnv();
		const short = randomSecret().slice(0, 31);
		env.ULTRATHINK_SESSION_SECRET = short;
		const message = messageOf(() => loadConfig(env));
		expect(message).toContain("ULTRATHINK_SESSION_SECRET");
		expect(message).not.toContain(short);
	});

	test("accepts a secret of exactly 32 characters", () => {
		const env = baseEnv();
		env.ULTRATHINK_SESSION_SECRET = randomSecret().slice(0, 32);
		expect(loadConfig(env).sessionSecret).toHaveLength(32);
	});
});
