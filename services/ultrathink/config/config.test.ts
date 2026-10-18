// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { ConfigError, loadConfig, requirePlanningModel, type ReasoningEffort } from "./config.ts";

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
		expect(config.maxBodyBytes).toBe(65536);
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

const FAKE_KEY = `sk-or-test-${"k".repeat(24)}`;

describe("server planning defaults", () => {
	test("new fields default to disabled server planning with documented limits", () => {
		const config = loadConfig(baseEnv());
		expect(config.allowedOrigins).toEqual([]);
		expect(config.oauthRedirectOrigins).toEqual([]);
		expect(config.openRouterApiKey).toBeUndefined();
		expect(config.openRouterBaseUrl).toBe("https://openrouter.ai/api/v1");
		expect(config.serverPlanning).toBe(false);
		expect(config.maxConcurrentPlans).toBe(2);
		expect(config.modelTimeoutMs).toBe(120000);
		expect(config.planTimeoutMs).toBe(600000);
		expect(config.modelMaxOutputTokens).toBe(8000);
		expect(config.serverDecisions).toBe(false);
	});

	test("maxBodyBytes defaults to 65536", () => {
		expect(loadConfig(baseEnv()).maxBodyBytes).toBe(65536);
	});

	test("explicit values are read", () => {
		const env = baseEnv();
		env.ULTRATHINK_MAX_CONCURRENT_PLANS = "4";
		env.ULTRATHINK_MODEL_TIMEOUT_MS = "30000";
		env.ULTRATHINK_PLAN_TIMEOUT_MS = "90000";
		env.ULTRATHINK_MODEL_MAX_OUTPUT_TOKENS = "4096";
		env.ULTRATHINK_SERVER_DECISIONS = "1";
		const config = loadConfig(env);
		expect(config.maxConcurrentPlans).toBe(4);
		expect(config.modelTimeoutMs).toBe(30000);
		expect(config.planTimeoutMs).toBe(90000);
		expect(config.modelMaxOutputTokens).toBe(4096);
		expect(config.serverDecisions).toBe(true);
	});
});

describe("server planning bounds", () => {
	const bounds: Array<[string, number, number]> = [
		["ULTRATHINK_MAX_CONCURRENT_PLANS", 1, 8],
		["ULTRATHINK_MODEL_TIMEOUT_MS", 5000, 600000],
		["ULTRATHINK_PLAN_TIMEOUT_MS", 30000, 1800000],
		["ULTRATHINK_MODEL_MAX_OUTPUT_TOKENS", 256, 32000],
	];
	for (const [name, min, max] of bounds) {
		test(`${name} accepts ${min} and ${max}`, () => {
			for (const value of [min, max]) {
				const env = baseEnv();
				env[name] = String(value);
				expect(() => loadConfig(env)).not.toThrow();
			}
		});

		test(`${name} rejects out-of-range and malformed values`, () => {
			for (const value of [String(min - 1), String(max + 1), "1.5", "-1", "12abc", "1e3"]) {
				const env = baseEnv();
				env[name] = value;
				expect(messageOf(() => loadConfig(env))).toContain(name);
			}
		});
	}

	test("server decisions accepts only 0 or 1", () => {
		const env = baseEnv();
		env.ULTRATHINK_SERVER_DECISIONS = "0";
		expect(loadConfig(env).serverDecisions).toBe(false);
		env.ULTRATHINK_SERVER_DECISIONS = "yes";
		expect(messageOf(() => loadConfig(env))).toContain("ULTRATHINK_SERVER_DECISIONS");
	});
});

describe("openRouterApiKey", () => {
	test("is read and trimmed", () => {
		const env = baseEnv();
		env.OPENROUTER_API_KEY = `  ${FAKE_KEY}  `;
		expect(loadConfig(env).openRouterApiKey).toBe(FAKE_KEY);
	});

	test("a blank key counts as unset", () => {
		const env = baseEnv();
		env.OPENROUTER_API_KEY = "   ";
		expect(loadConfig(env).openRouterApiKey).toBeUndefined();
	});

	test("a key shorter than 20 characters is rejected without echoing it", () => {
		const env = baseEnv();
		const short = FAKE_KEY.slice(0, 19);
		env.OPENROUTER_API_KEY = short;
		const message = messageOf(() => loadConfig(env));
		expect(message).toContain("OPENROUTER_API_KEY");
		expect(message).not.toContain(short);
	});

	test("a key of exactly 20 characters is accepted", () => {
		const env = baseEnv();
		env.OPENROUTER_API_KEY = FAKE_KEY.slice(0, 20);
		expect(loadConfig(env).openRouterApiKey).toHaveLength(20);
	});
});

describe("openRouterBaseUrl", () => {
	test("accepts an https URL and strips trailing slashes", () => {
		const env = baseEnv();
		env.ULTRATHINK_OPENROUTER_BASE_URL = "https://router.example.test/api/v1//";
		expect(loadConfig(env).openRouterBaseUrl).toBe("https://router.example.test/api/v1");
	});

	for (const value of [
		"http://openrouter.ai/api/v1",
		"openrouter.ai/api/v1",
		"ftp://openrouter.ai/api/v1",
		"https://user:pass@openrouter.ai/api/v1",
		"https://openrouter.ai/api/v1?x=1",
		"https://openrouter.ai/api/v1#frag",
	]) {
		test(`rejects ${value}`, () => {
			const env = baseEnv();
			env.ULTRATHINK_OPENROUTER_BASE_URL = value;
			const message = messageOf(() => loadConfig(env));
			expect(message).toContain("ULTRATHINK_OPENROUTER_BASE_URL");
			expect(message).not.toContain("pass@");
		});
	}
});

describe("serverPlanning derivation", () => {
	function withPlanning(extra: Record<string, string | undefined>): Record<string, string | undefined> {
		return { ...baseEnv(), ...extra };
	}

	test("is true when the key and the planning model are set", () => {
		const config = loadConfig(
			withPlanning({ OPENROUTER_API_KEY: FAKE_KEY, ULTRATHINK_PLANNING_MODEL: "x-ai/grok-4.7" }),
		);
		expect(config.serverPlanning).toBe(true);
	});

	test("is false without the key", () => {
		expect(loadConfig(withPlanning({ ULTRATHINK_PLANNING_MODEL: "x-ai/grok-4.7" })).serverPlanning).toBe(false);
	});

	test("is false without the planning model", () => {
		expect(loadConfig(withPlanning({ OPENROUTER_API_KEY: FAKE_KEY })).serverPlanning).toBe(false);
	});

	test("ULTRATHINK_SERVER_PLANNING=0 disables it even with key and model", () => {
		const config = loadConfig(
			withPlanning({
				OPENROUTER_API_KEY: FAKE_KEY,
				ULTRATHINK_PLANNING_MODEL: "x-ai/grok-4.7",
				ULTRATHINK_SERVER_PLANNING: "0",
			}),
		);
		expect(config.serverPlanning).toBe(false);
	});

	test("ULTRATHINK_SERVER_PLANNING=1 with key and model enables it", () => {
		const config = loadConfig(
			withPlanning({
				OPENROUTER_API_KEY: FAKE_KEY,
				ULTRATHINK_PLANNING_MODEL: "x-ai/grok-4.7",
				ULTRATHINK_SERVER_PLANNING: "1",
			}),
		);
		expect(config.serverPlanning).toBe(true);
	});

	test("ULTRATHINK_SERVER_PLANNING=1 without a key throws a ConfigError", () => {
		const message = messageOf(() =>
			loadConfig(withPlanning({ ULTRATHINK_PLANNING_MODEL: "x-ai/grok-4.7", ULTRATHINK_SERVER_PLANNING: "1" })),
		);
		expect(message).toContain("OPENROUTER_API_KEY");
	});

	test("ULTRATHINK_SERVER_PLANNING=1 without a planning model throws a ConfigError", () => {
		const message = messageOf(() =>
			loadConfig(withPlanning({ OPENROUTER_API_KEY: FAKE_KEY, ULTRATHINK_SERVER_PLANNING: "1" })),
		);
		expect(message).toContain("ULTRATHINK_PLANNING_MODEL");
	});

	test("any other ULTRATHINK_SERVER_PLANNING value is rejected", () => {
		const message = messageOf(() =>
			loadConfig(withPlanning({ ULTRATHINK_SERVER_PLANNING: "true" })),
		);
		expect(message).toContain("ULTRATHINK_SERVER_PLANNING");
	});
});

describe("origin lists", () => {
	test("trims, skips empty entries, normalizes and de-duplicates", () => {
		const env = baseEnv();
		env.ULTRATHINK_ALLOWED_ORIGINS =
			" https://a.example.test , http://b.example.test:8080,, HTTPS://A.EXAMPLE.TEST ,https://a.example.test ";
		expect(loadConfig(env).allowedOrigins).toEqual([
			"https://a.example.test",
			"http://b.example.test:8080",
		]);
	});

	test("a blank list is empty", () => {
		const env = baseEnv();
		env.ULTRATHINK_ALLOWED_ORIGINS = "  ";
		expect(loadConfig(env).allowedOrigins).toEqual([]);
	});

	test("oauth redirect origins accept https and parse like allowed origins", () => {
		const env = baseEnv();
		env.ULTRATHINK_OAUTH_REDIRECT_ORIGINS = "https://app.example.test, https://app.example.test,https://c.example.test:8443";
		expect(loadConfig(env).oauthRedirectOrigins).toEqual([
			"https://app.example.test",
			"https://c.example.test:8443",
		]);
	});

	test("oauth redirect origins reject http", () => {
		const env = baseEnv();
		env.ULTRATHINK_OAUTH_REDIRECT_ORIGINS = "http://app.example.test";
		expect(messageOf(() => loadConfig(env))).toContain("ULTRATHINK_OAUTH_REDIRECT_ORIGINS");
	});

	const notBare = [
		"https://a.example.test/",
		"https://a.example.test/path",
		"https://a.example.test?x=1",
		"https://a.example.test#frag",
		"https://user:secret@a.example.test",
		"https://user@a.example.test",
		"ftp://a.example.test",
		"a.example.test",
		"//a.example.test",
		"javascript:alert(1)",
		"https://",
		"*",
	];
	for (const value of notBare) {
		test(`allowed origins reject ${value}`, () => {
			const env = baseEnv();
			env.ULTRATHINK_ALLOWED_ORIGINS = `https://ok.example.test,${value}`;
			const message = messageOf(() => loadConfig(env));
			expect(message).toContain("ULTRATHINK_ALLOWED_ORIGINS");
			expect(message).not.toContain("secret");
		});
	}

	test("a bad entry in the oauth list names that variable", () => {
		const env = baseEnv();
		env.ULTRATHINK_OAUTH_REDIRECT_ORIGINS = "https://app.example.test/callback";
		expect(messageOf(() => loadConfig(env))).toContain("ULTRATHINK_OAUTH_REDIRECT_ORIGINS");
	});
});

describe("modelReasoningEffort", () => {
	test("unset defaults to low", () => {
		expect(loadConfig(baseEnv()).modelReasoningEffort).toBe("low");
	});

	for (const value of ["minimal", "low", "medium", "high"]) {
		test(`accepts ${value}`, () => {
			const env = baseEnv();
			env.ULTRATHINK_MODEL_REASONING_EFFORT = ` ${value} `;
			expect(loadConfig(env).modelReasoningEffort).toBe(value as ReasoningEffort);
		});
	}

	test("default leaves the parameter undefined", () => {
		const env = baseEnv();
		env.ULTRATHINK_MODEL_REASONING_EFFORT = "default";
		expect(loadConfig(env).modelReasoningEffort).toBeUndefined();
	});

	test("a blank value counts as unset", () => {
		const env = baseEnv();
		env.ULTRATHINK_MODEL_REASONING_EFFORT = "  ";
		expect(loadConfig(env).modelReasoningEffort).toBe("low");
	});

	for (const value of ["extreme", "LOW", "none", "1"]) {
		test(`rejects ${value} naming the variable without echoing it`, () => {
			const env = baseEnv();
			env.ULTRATHINK_MODEL_REASONING_EFFORT = value;
			const message = messageOf(() => loadConfig(env));
			expect(message).toContain("ULTRATHINK_MODEL_REASONING_EFFORT");
			expect(message).not.toContain(value);
		});
	}
});
