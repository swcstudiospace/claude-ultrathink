// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { ConfigError, loadConfig, requirePlanningModel, type ReasoningEffort } from "./config.ts";

function randomSecret(): string {
	return randomBytes(24).toString("base64url");
}

function randomHash(): string {
	// PHC strings use standard base64 without padding, as Bun.password.hash writes them.
	const salt = randomBytes(16).toString("base64").replace(/=+$/, "");
	const digest = randomBytes(16).toString("base64").replace(/=+$/, "");
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

	test("strips trailing slashes from stateDir before building dbPath", () => {
		const env = baseEnv();
		env.ULTRATHINK_STATE_DIR = "/var/x/";
		const config = loadConfig(env);
		expect(config.stateDir).toBe("/var/x");
		expect(config.dbPath).toBe("/var/x/ultrathink.sqlite");
	});

	test("rejects a relative stateDir naming the variable", () => {
		for (const value of ["relative/dir/", "./state", "state"]) {
			const env = baseEnv();
			env.ULTRATHINK_STATE_DIR = value;
			const message = messageOf(() => loadConfig(env));
			expect(message).toContain("ULTRATHINK_STATE_DIR");
			expect(message).toContain("absolute");
		}
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

	test("rejects maxAnswerChars the 65536-byte body cap cannot carry, naming the variable", () => {
		for (const value of ["20001", "200000"]) {
			const env = baseEnv();
			env.ULTRATHINK_MAX_ANSWER_CHARS = value;
			const message = messageOf(() => loadConfig(env));
			expect(message).toContain("ULTRATHINK_MAX_ANSWER_CHARS");
			expect(message).toContain("20000");
		}
	});

	test("accepts input and answer limits up to 20000: 3 UTF-8 bytes per char plus the envelope fit the body cap", () => {
		const env = baseEnv();
		env.ULTRATHINK_MAX_INPUT_CHARS = "20000";
		env.ULTRATHINK_MAX_ANSWER_CHARS = "20000";
		const config = loadConfig(env);
		expect(config.maxInputChars).toBe(20000);
		expect(config.maxAnswerChars).toBe(20000);
		expect(20000 * 3).toBeLessThanOrEqual(config.maxBodyBytes - 4096);
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

describe("publicOrigin normalization", () => {
	test("drops a trailing slash and lower-cases the host", () => {
		const env = baseEnv();
		env.ULTRATHINK_PUBLIC_ORIGIN = "https://Ultrathink.SWCStudio.space/";
		expect(loadConfig(env).publicOrigin).toBe("https://ultrathink.swcstudio.space");
	});

	test("keeps an explicit non-default port", () => {
		const env = baseEnv();
		env.ULTRATHINK_PUBLIC_ORIGIN = "https://ultrathink.swcstudio.space:8443";
		expect(loadConfig(env).publicOrigin).toBe("https://ultrathink.swcstudio.space:8443");
	});

	test("rejects a path, a query, a fragment and credentials without echoing the value", () => {
		for (const value of [
			"https://ultrathink.swcstudio.space/some/path",
			"https://ultrathink.swcstudio.space/?a=1",
			"https://ultrathink.swcstudio.space/#frag",
			"https://owner:secret@ultrathink.swcstudio.space",
		]) {
			const env = baseEnv();
			env.ULTRATHINK_PUBLIC_ORIGIN = value;
			const message = messageOf(() => loadConfig(env));
			expect(message).toContain("ULTRATHINK_PUBLIC_ORIGIN");
			expect(message).not.toContain("swcstudio.space");
			expect(message).not.toContain("secret");
		}
	});
});

describe("ownerPasswordHash", () => {
	test("accepts the argon2id and bcrypt hashes Bun.password produces", () => {
		const env = baseEnv();
		const argon = Bun.password.hashSync("pw", "argon2id");
		env.ULTRATHINK_OWNER_PASSWORD_HASH = argon;
		expect(loadConfig(env).ownerPasswordHash).toBe(argon);
		const bcrypt = Bun.password.hashSync("pw", { algorithm: "bcrypt", cost: 4 });
		env.ULTRATHINK_OWNER_PASSWORD_HASH = bcrypt;
		expect(loadConfig(env).ownerPasswordHash).toBe(bcrypt);
	});

	test("rejects a plaintext value and a shell-expanded hash without echoing either", () => {
		const expanded = Bun.password.hashSync("pw", "argon2id").replace("$argon2id", "");
		for (const value of ["plaintext-not-a-hash", expanded, "$argon2id$truncated"]) {
			const env = baseEnv();
			env.ULTRATHINK_OWNER_PASSWORD_HASH = value;
			const message = messageOf(() => loadConfig(env));
			expect(message).toContain("ULTRATHINK_OWNER_PASSWORD_HASH");
			expect(message).not.toContain(value);
		}
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
		expect(config.modelTimeoutMs).toBe(240000);
		expect(config.planTimeoutMs).toBe(600000);
		expect(config.modelMaxOutputTokens).toBe(8000);
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
		const config = loadConfig(env);
		expect(config.maxConcurrentPlans).toBe(4);
		expect(config.modelTimeoutMs).toBe(30000);
		expect(config.planTimeoutMs).toBe(90000);
		expect(config.modelMaxOutputTokens).toBe(4096);
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

describe("previous session secrets", () => {
	test("is empty when unset", () => {
		expect(loadConfig(baseEnv()).sessionSecretPrevious).toEqual([]);
	});

	test("parses a comma list, trimming entries and dropping empty ones", () => {
		const env = baseEnv();
		const older = randomSecret();
		const oldest = randomSecret();
		env.ULTRATHINK_SESSION_SECRET_PREVIOUS = ` ${older} ,, ${oldest} , `;
		expect(loadConfig(env).sessionSecretPrevious).toEqual([older, oldest]);
	});

	test("accepts up to four entries and rejects a fifth", () => {
		const env = baseEnv();
		const four = Array.from({ length: 4 }, () => randomSecret());
		env.ULTRATHINK_SESSION_SECRET_PREVIOUS = four.join(",");
		expect(loadConfig(env).sessionSecretPrevious).toEqual(four);
		env.ULTRATHINK_SESSION_SECRET_PREVIOUS = [...four, randomSecret()].join(",");
		expect(messageOf(() => loadConfig(env))).toContain("ULTRATHINK_SESSION_SECRET_PREVIOUS");
	});

	test("rejects a previous secret shorter than 32 characters without echoing it", () => {
		const env = baseEnv();
		const short = randomSecret().slice(0, 31);
		env.ULTRATHINK_SESSION_SECRET_PREVIOUS = `${randomSecret()},${short}`;
		const message = messageOf(() => loadConfig(env));
		expect(message).toContain("ULTRATHINK_SESSION_SECRET_PREVIOUS");
		expect(message).not.toContain(short);
	});
});

describe("operations settings", () => {
	test("apply documented defaults", () => {
		const config = loadConfig(baseEnv());
		expect(config.breakerFailures).toBe(5);
		expect(config.breakerWindowMs).toBe(60000);
		expect(config.breakerOpenMs).toBe(30000);
		expect(config.maxInflight).toBe(256);
		expect(config.drainMs).toBe(5000);
		expect(config.retentionDays).toBe(30);
		expect(config.auditLog).toBe(true);
	});

	test("zero is valid for the breaker, drain and retention settings where documented", () => {
		const env = baseEnv();
		env.ULTRATHINK_BREAKER_FAILURES = "0";
		env.ULTRATHINK_DRAIN_MS = "0";
		env.ULTRATHINK_RETENTION_DAYS = "0";
		const config = loadConfig(env);
		expect(config.breakerFailures).toBe(0);
		expect(config.drainMs).toBe(0);
		expect(config.retentionDays).toBe(0);
	});

	const ranges = [
		{ name: "ULTRATHINK_BREAKER_FAILURES", field: "breakerFailures", min: "0", max: "100" },
		{ name: "ULTRATHINK_BREAKER_WINDOW_MS", field: "breakerWindowMs", min: "1000", max: "3600000" },
		{ name: "ULTRATHINK_BREAKER_OPEN_MS", field: "breakerOpenMs", min: "1000", max: "600000" },
		{ name: "ULTRATHINK_MAX_INFLIGHT", field: "maxInflight", min: "1", max: "10000" },
		{ name: "ULTRATHINK_DRAIN_MS", field: "drainMs", min: "0", max: "60000" },
		{ name: "ULTRATHINK_RETENTION_DAYS", field: "retentionDays", min: "0", max: "3650" },
	] as const;

	for (const range of ranges) {
		test(`${range.name} accepts its bounds`, () => {
			for (const value of [range.min, range.max]) {
				const env = baseEnv();
				env[range.name] = value;
				expect(loadConfig(env)[range.field]).toBe(Number(value));
			}
		});

		test(`${range.name} rejects values outside its bounds, naming the variable`, () => {
			for (const value of [String(Number(range.max) + 1), "-1", "1.5"]) {
				const env = baseEnv();
				env[range.name] = value;
				const message = messageOf(() => loadConfig(env));
				expect(message).toContain(range.name);
				expect(message).not.toContain(value);
			}
		});
	}

	test("ULTRATHINK_AUDIT_LOG=0 turns the audit log off and 1 turns it on", () => {
		const env = baseEnv();
		env.ULTRATHINK_AUDIT_LOG = "0";
		expect(loadConfig(env).auditLog).toBe(false);
		env.ULTRATHINK_AUDIT_LOG = "1";
		expect(loadConfig(env).auditLog).toBe(true);
	});

	test("ULTRATHINK_AUDIT_LOG accepts only 0 or 1", () => {
		const env = baseEnv();
		env.ULTRATHINK_AUDIT_LOG = "true";
		expect(messageOf(() => loadConfig(env))).toContain("ULTRATHINK_AUDIT_LOG");
	});
});

describe("audit sink configuration", () => {
	test("defaults with no audit variables set match the documented table", () => {
		const config = loadConfig(baseEnv());
		expect(config.auditAnchorEvery).toBe(1000);
		expect(config.auditSegmentBytes).toBe(67108864);
		expect(config.auditRetentionDays).toBe(365);
		expect(config.auditWatchMs).toBe(1000);
		expect(config.auditSinkQueue).toBe(10000);
		expect(config.auditRules).toBeUndefined();
		expect(config.auditHttpUrl).toBeUndefined();
		expect(config.auditHttpToken).toBeUndefined();
		expect(config.auditSyslog).toBeUndefined();
		expect(config.auditKafkaRestUrl).toBeUndefined();
		expect(config.auditKafkaTopic).toBeUndefined();
	});

	const integerFields = [
		{ name: "ULTRATHINK_AUDIT_ANCHOR_EVERY", field: "auditAnchorEvery", min: 1, max: 1000000 },
		{ name: "ULTRATHINK_AUDIT_SEGMENT_BYTES", field: "auditSegmentBytes", min: 1048576, max: 4294967296 },
		{ name: "ULTRATHINK_AUDIT_RETENTION_DAYS", field: "auditRetentionDays", min: 0, max: 36500 },
		{ name: "ULTRATHINK_AUDIT_WATCH_MS", field: "auditWatchMs", min: 100, max: 1000 },
		{ name: "ULTRATHINK_AUDIT_SINK_QUEUE", field: "auditSinkQueue", min: 1, max: 1000000 },
	] as const;

	for (const spec of integerFields) {
		test(`${spec.name} accepts its lowest and highest value`, () => {
			expect(loadConfig({ ...baseEnv(), [spec.name]: String(spec.min) })[spec.field]).toBe(spec.min);
			expect(loadConfig({ ...baseEnv(), [spec.name]: String(spec.max) })[spec.field]).toBe(spec.max);
		});

		test(`${spec.name} rejects out-of-range or malformed values, naming the variable`, () => {
			for (const value of [String(spec.min - 1), String(spec.max + 1), "1e3", "abc"]) {
				expect(messageOf(() => loadConfig({ ...baseEnv(), [spec.name]: value }))).toContain(spec.name);
			}
		});
	}

	test("ULTRATHINK_AUDIT_WATCH_MS rejects 1001 and 99 by name", () => {
		expect(messageOf(() => loadConfig({ ...baseEnv(), ULTRATHINK_AUDIT_WATCH_MS: "1001" }))).toContain("ULTRATHINK_AUDIT_WATCH_MS");
		expect(messageOf(() => loadConfig({ ...baseEnv(), ULTRATHINK_AUDIT_WATCH_MS: "99" }))).toContain("ULTRATHINK_AUDIT_WATCH_MS");
	});

	test("ULTRATHINK_AUDIT_RULES returns the parsed rules for a valid array", () => {
		const rules = [{ name: "login-burst", event: "login_failed", count: 5, windowSec: 60 }];
		expect(loadConfig({ ...baseEnv(), ULTRATHINK_AUDIT_RULES: JSON.stringify(rules) }).auditRules).toEqual(rules);
	});

	test("ULTRATHINK_AUDIT_RULES rejects malformed JSON, non-array values and invalid rules, naming the variable", () => {
		for (const value of ["[", '{"name":"login-burst"}', '[{"name":"login-burst"}]']) {
			expect(messageOf(() => loadConfig({ ...baseEnv(), ULTRATHINK_AUDIT_RULES: value }))).toContain("ULTRATHINK_AUDIT_RULES");
		}
	});

	test("ULTRATHINK_AUDIT_HTTP_URL accepts https and loopback http", () => {
		expect(loadConfig({ ...baseEnv(), ULTRATHINK_AUDIT_HTTP_URL: "https://siem.example.com/ingest" }).auditHttpUrl).toBe(
			"https://siem.example.com/ingest",
		);
		expect(loadConfig({ ...baseEnv(), ULTRATHINK_AUDIT_HTTP_URL: "http://127.0.0.1:9" }).auditHttpUrl).toBe("http://127.0.0.1:9");
	});

	test("ULTRATHINK_AUDIT_HTTP_URL rejects plaintext, non-loopback, credentialed and malformed URLs", () => {
		for (const value of [
			"http://example.com",
			"ftp://siem.example.com",
			"https://user:secret@siem.example.com",
			"http://user@127.0.0.1:9",
			"not a url",
		]) {
			const message = messageOf(() => loadConfig({ ...baseEnv(), ULTRATHINK_AUDIT_HTTP_URL: value }));
			expect(message).toContain("ULTRATHINK_AUDIT_HTTP_URL");
			expect(message).not.toContain("secret");
		}
	});

	test("ULTRATHINK_AUDIT_HTTP_TOKEN accepts a printable token of 16 characters or more", () => {
		expect(loadConfig({ ...baseEnv(), ULTRATHINK_AUDIT_HTTP_TOKEN: "abcdefghijklmnop" }).auditHttpToken).toBe("abcdefghijklmnop");
	});

	test("ULTRATHINK_AUDIT_HTTP_TOKEN rejects short or malformed tokens without echoing them", () => {
		for (const token of ["short-token", "has space inside this token"]) {
			const message = messageOf(() => loadConfig({ ...baseEnv(), ULTRATHINK_AUDIT_HTTP_TOKEN: token }));
			expect(message).toContain("ULTRATHINK_AUDIT_HTTP_TOKEN");
			expect(message).not.toContain(token);
		}
	});

	test("ULTRATHINK_AUDIT_SYSLOG parses host and port", () => {
		expect(loadConfig({ ...baseEnv(), ULTRATHINK_AUDIT_SYSLOG: "siem.example.com:514" }).auditSyslog).toEqual({
			host: "siem.example.com",
			port: 514,
		});
	});

	test("ULTRATHINK_AUDIT_SYSLOG rejects ports outside 1..65535 and malformed targets, naming the variable", () => {
		for (const value of [
			"siem.example.com:0",
			"siem.example.com:70000",
			"siem.example.com",
			":514",
			"siem.example.com:",
			"siem.example.com:5x",
			"bad host:514",
		]) {
			expect(messageOf(() => loadConfig({ ...baseEnv(), ULTRATHINK_AUDIT_SYSLOG: value }))).toContain("ULTRATHINK_AUDIT_SYSLOG");
		}
	});

	test("the Kafka REST sink needs its URL and its topic together", () => {
		const config = loadConfig({
			...baseEnv(),
			ULTRATHINK_AUDIT_KAFKA_REST_URL: "https://kafka-rest.example.com",
			ULTRATHINK_AUDIT_KAFKA_TOPIC: "audit",
		});
		expect(config.auditKafkaRestUrl).toBe("https://kafka-rest.example.com");
		expect(config.auditKafkaTopic).toBe("audit");

		const urlOnly = messageOf(() =>
			loadConfig({ ...baseEnv(), ULTRATHINK_AUDIT_KAFKA_REST_URL: "https://kafka-rest.example.com" }),
		);
		expect(urlOnly).toContain("ULTRATHINK_AUDIT_KAFKA_TOPIC");

		const topicOnly = messageOf(() => loadConfig({ ...baseEnv(), ULTRATHINK_AUDIT_KAFKA_TOPIC: "audit" }));
		expect(topicOnly).toContain("ULTRATHINK_AUDIT_KAFKA_REST_URL");
	});

	test("ULTRATHINK_AUDIT_KAFKA_REST_URL follows the HTTP URL rule", () => {
		const message = messageOf(() =>
			loadConfig({
				...baseEnv(),
				ULTRATHINK_AUDIT_KAFKA_REST_URL: "http://example.com",
				ULTRATHINK_AUDIT_KAFKA_TOPIC: "audit",
			}),
		);
		expect(message).toContain("ULTRATHINK_AUDIT_KAFKA_REST_URL");
	});
});

describe("rate limiting settings", () => {
	test("apply the phase 70 defaults with an empty env", () => {
		const config = loadConfig(baseEnv());
		expect(config.priorityReservePct).toBe(25);
		expect(config.adaptiveQuotaMinPct).toBe(50);
		expect(config.lagTargetMs).toBe(100);
		expect(config.replicaCapacityRps).toBe(20);
		expect(config.abuseFailuresPerMinute).toBe(20);
		expect(config.penaltyBaseSec).toBe(60);
		expect(config.penaltyMaxSec).toBe(3600);
	});

	test("each variable overrides its default", () => {
		const env = baseEnv();
		env.ULTRATHINK_PRIORITY_RESERVE_PCT = "40";
		env.ULTRATHINK_ADAPTIVE_QUOTA_MIN_PCT = "30";
		env.ULTRATHINK_LAG_TARGET_MS = "250";
		env.ULTRATHINK_REPLICA_CAPACITY_RPS = "75";
		env.ULTRATHINK_ABUSE_FAILURES_PER_MINUTE = "5";
		env.ULTRATHINK_PENALTY_BASE_SEC = "120";
		env.ULTRATHINK_PENALTY_MAX_SEC = "1800";
		const config = loadConfig(env);
		expect(config.priorityReservePct).toBe(40);
		expect(config.adaptiveQuotaMinPct).toBe(30);
		expect(config.lagTargetMs).toBe(250);
		expect(config.replicaCapacityRps).toBe(75);
		expect(config.abuseFailuresPerMinute).toBe(5);
		expect(config.penaltyBaseSec).toBe(120);
		expect(config.penaltyMaxSec).toBe(1800);
	});

	const ranges = [
		{ name: "ULTRATHINK_PRIORITY_RESERVE_PCT", field: "priorityReservePct", min: "0", max: "90" },
		{ name: "ULTRATHINK_ADAPTIVE_QUOTA_MIN_PCT", field: "adaptiveQuotaMinPct", min: "10", max: "100" },
		{ name: "ULTRATHINK_LAG_TARGET_MS", field: "lagTargetMs", min: "10", max: "5000" },
		{ name: "ULTRATHINK_REPLICA_CAPACITY_RPS", field: "replicaCapacityRps", min: "1", max: "100000" },
		{ name: "ULTRATHINK_ABUSE_FAILURES_PER_MINUTE", field: "abuseFailuresPerMinute", min: "1", max: "10000" },
	] as const;

	for (const range of ranges) {
		test(`${range.name} accepts its bounds`, () => {
			for (const value of [range.min, range.max]) {
				const env = baseEnv();
				env[range.name] = value;
				expect(loadConfig(env)[range.field]).toBe(Number(value));
			}
		});

		test(`${range.name} rejects values outside its bounds, naming the variable`, () => {
			for (const value of [String(Number(range.max) + 1), "-1", "1.5"]) {
				const env = baseEnv();
				env[range.name] = value;
				const message = messageOf(() => loadConfig(env));
				expect(message).toContain(range.name);
				expect(message).not.toContain(value);
			}
		});
	}

	test("penalty base accepts 1 and 86400 when the cap allows it", () => {
		const low = baseEnv();
		low.ULTRATHINK_PENALTY_BASE_SEC = "1";
		expect(loadConfig(low).penaltyBaseSec).toBe(1);
		const high = baseEnv();
		high.ULTRATHINK_PENALTY_BASE_SEC = "86400";
		high.ULTRATHINK_PENALTY_MAX_SEC = "86400";
		expect(loadConfig(high).penaltyBaseSec).toBe(86400);
	});

	test("penalty base and max reject values outside 1..86400, naming the variable", () => {
		for (const name of ["ULTRATHINK_PENALTY_BASE_SEC", "ULTRATHINK_PENALTY_MAX_SEC"]) {
			for (const value of ["0", "86401", "-1", "1.5"]) {
				const env = baseEnv();
				env[name] = value;
				expect(messageOf(() => loadConfig(env))).toContain(name);
			}
		}
	});

	test("a penalty max below the penalty base throws a ConfigError naming both variables", () => {
		const env = baseEnv();
		env.ULTRATHINK_PENALTY_BASE_SEC = "600";
		env.ULTRATHINK_PENALTY_MAX_SEC = "300";
		const message = messageOf(() => loadConfig(env));
		expect(message).toContain("ULTRATHINK_PENALTY_MAX_SEC");
		expect(message).toContain("ULTRATHINK_PENALTY_BASE_SEC");
	});

	test("a penalty max equal to the penalty base is accepted", () => {
		const env = baseEnv();
		env.ULTRATHINK_PENALTY_BASE_SEC = "300";
		env.ULTRATHINK_PENALTY_MAX_SEC = "300";
		const config = loadConfig(env);
		expect(config.penaltyBaseSec).toBe(300);
		expect(config.penaltyMaxSec).toBe(300);
	});
});

describe("ULTRATHINK_OTLP_ENDPOINT", () => {
	test("unset and empty both give undefined", () => {
		expect(loadConfig(baseEnv()).otlpEndpoint).toBeUndefined();
		expect(loadConfig({ ...baseEnv(), ULTRATHINK_OTLP_ENDPOINT: "" }).otlpEndpoint).toBeUndefined();
	});

	test("a trailing slash is removed from the stored endpoint", () => {
		expect(loadConfig({ ...baseEnv(), ULTRATHINK_OTLP_ENDPOINT: "https://collector.example/otel/" }).otlpEndpoint).toBe(
			"https://collector.example/otel",
		);
	});

	test("plaintext http is refused for a non-loopback host", () => {
		const message = messageOf(() => loadConfig({ ...baseEnv(), ULTRATHINK_OTLP_ENDPOINT: "http://collector.example:4318" }));
		expect(message).toContain("ULTRATHINK_OTLP_ENDPOINT");
	});

	test("http is accepted for 127.0.0.1, localhost and [::1]", () => {
		for (const value of ["http://127.0.0.1:4318", "http://localhost:4318", "http://[::1]:4318"]) {
			expect(loadConfig({ ...baseEnv(), ULTRATHINK_OTLP_ENDPOINT: value }).otlpEndpoint).toBe(value);
		}
	});

	test("credentials, a query or a fragment are refused, and the message echoes neither the secret nor the query", () => {
		for (const value of ["https://user:secret@collector.example", "https://collector.example/?key=1", "https://collector.example/#key=1"]) {
			const message = messageOf(() => loadConfig({ ...baseEnv(), ULTRATHINK_OTLP_ENDPOINT: value }));
			expect(message).toContain("ULTRATHINK_OTLP_ENDPOINT");
			expect(message).not.toContain("secret");
			expect(message).not.toContain("key=1");
		}
	});
});
