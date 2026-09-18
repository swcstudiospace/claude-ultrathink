import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	ensureFreshGrokAuth,
	grokAuthStatus,
	grokAuthStatusFresh,
	grokClientVersion,
	grokHeaders,
	grokHome,
	GrokAuthError,
	isGrokAuthExpired,
	readGrokAuth,
	redactSecrets,
} from "./auth.ts";
import { GROK_CLIENT_VERSION_FALLBACK } from "./types.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const TOKEN = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c2VyLTEyMyIsImV4cCI6MTk5OX0.Sflkxw_RJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c";
const EXPIRES_AT = "2026-09-16T12:00:00.000Z";

function tempHome(auth?: unknown): string {
	const home = mkdtempSync(join(tmpdir(), "aio-grok-auth-"));
	dirs.push(home);
	if (auth !== undefined) writeFileSync(join(home, "auth.json"), typeof auth === "string" ? auth : JSON.stringify(auth));
	return home;
}

function fixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		"https://auth.x.ai::client-abc": {
			key: TOKEN,
			refresh_token: "refresh-1",
			expires_at: EXPIRES_AT,
			email: "dev@example.com",
			user_id: "user-123",
			oidc_issuer: "https://auth.x.ai",
			oidc_client_id: "client-abc",
			auth_mode: "oidc",
			...overrides,
		},
	};
}

describe("grokHome", () => {
	test("explicit home wins, then GROK_HOME, then ~/.grok", () => {
		expect(grokHome("/x", { GROK_HOME: "/y" })).toBe("/x");
		expect(grokHome("", { GROK_HOME: "/y" })).toBe("/y");
		expect(grokHome(undefined, {})).toEndWith("/.grok");
	});
});

describe("readGrokAuth", () => {
	test("parses the first auth.json entry", () => {
		const auth = readGrokAuth(tempHome(fixture()));
		expect(auth).toEqual({
			token: TOKEN,
			refreshToken: "refresh-1",
			expiresAt: Date.parse(EXPIRES_AT),
			email: "dev@example.com",
			userId: "user-123",
			issuer: "https://auth.x.ai",
			clientId: "client-abc",
		});
	});

	test("expiresAt is undefined when unparsable", () => {
		expect(readGrokAuth(tempHome(fixture({ expires_at: "soon" })))?.expiresAt).toBeUndefined();
	});

	test("undefined on missing file, invalid json, or empty token", () => {
		expect(readGrokAuth(tempHome())).toBeUndefined();
		expect(readGrokAuth(tempHome("{not json"))).toBeUndefined();
		expect(readGrokAuth(tempHome(fixture({ key: "" })))).toBeUndefined();
		expect(readGrokAuth(tempHome({}))).toBeUndefined();
	});
});

describe("isGrokAuthExpired", () => {
	test("applies the skew and treats missing expiry as not expired", () => {
		const expiresAt = 1_000_000;
		expect(isGrokAuthExpired({ token: "t", expiresAt }, expiresAt - 60_001)).toBe(false);
		expect(isGrokAuthExpired({ token: "t", expiresAt }, expiresAt - 60_000)).toBe(true);
		expect(isGrokAuthExpired({ token: "t", expiresAt }, expiresAt - 10, 0)).toBe(false);
		expect(isGrokAuthExpired({ token: "t" }, Number.MAX_SAFE_INTEGER)).toBe(false);
	});
});

describe("grokAuthStatus", () => {
	test("reports login and expiry without exposing the token", () => {
		const home = tempHome(fixture());
		const status = grokAuthStatus(home, Date.parse(EXPIRES_AT) - 3_600_000);
		expect(status).toEqual({ loggedIn: true, expired: false, email: "dev@example.com", expiresAt: EXPIRES_AT, home });
		expect(JSON.stringify(status)).not.toContain(TOKEN);
		expect(grokAuthStatus(home, Date.parse(EXPIRES_AT)).expired).toBe(true);
	});

	test("reports logged out when auth.json is missing", () => {
		const home = tempHome();
		expect(grokAuthStatus(home)).toEqual({ loggedIn: false, expired: false, home });
	});
});

describe("ensureFreshGrokAuth", () => {
	const FUTURE = "2030-06-01T00:00:00.000Z";
	const PAST = "2020-01-01T00:00:00.000Z";

	/** Spawn fake standing in for `grok models`: rewrites auth.json like the CLI would after a refresh. */
	function fakeSpawn(home: string, next: Record<string, unknown> = fixture({ key: `${TOKEN}x`, expires_at: FUTURE })) {
		const calls: { cmd: string[]; env: Record<string, string | undefined> }[] = [];
		const spawn = async (cmd: string[], env: Record<string, string | undefined>) => {
			calls.push({ cmd, env });
			writeFileSync(join(home, "auth.json"), JSON.stringify(next));
			return 0;
		};
		return { spawn, calls };
	}

	test("runs the CLI for an expired session with a refresh token and returns the rewritten auth", async () => {
		const home = tempHome(fixture({ expires_at: PAST }));
		const { spawn, calls } = fakeSpawn(home);
		const auth = await ensureFreshGrokAuth({ home, spawn });
		expect(calls).toEqual([{ cmd: ["grok", "models"], env: expect.objectContaining({ GROK_HOME: home }) }]);
		expect(auth?.token).toBe(`${TOKEN}x`);
		expect(auth && isGrokAuthExpired(auth)).toBe(false);
	});

	test("honours bin and leaves a fresh session alone", async () => {
		const home = tempHome(fixture());
		const { spawn, calls } = fakeSpawn(home);
		const auth = await ensureFreshGrokAuth({ home, spawn, bin: "/opt/grok", now: Date.parse(EXPIRES_AT) - 3_600_000 });
		expect(calls).toHaveLength(0);
		expect(auth?.token).toBe(TOKEN);
	});

	test("force runs the CLI even when the session is fresh", async () => {
		const home = tempHome(fixture());
		const { spawn, calls } = fakeSpawn(home);
		const auth = await ensureFreshGrokAuth({ home, spawn, bin: "/opt/grok", force: true, now: Date.parse(EXPIRES_AT) - 3_600_000 });
		expect(calls.map((c) => c.cmd)).toEqual([["/opt/grok", "models"]]);
		expect(auth?.token).toBe(`${TOKEN}x`);
	});

	test("cannot refresh without a refresh token: returns the expired session untouched", async () => {
		const home = tempHome(fixture({ expires_at: PAST, refresh_token: undefined }));
		const { spawn, calls } = fakeSpawn(home);
		const auth = await ensureFreshGrokAuth({ home, spawn });
		expect(calls).toHaveLength(0);
		expect(auth?.token).toBe(TOKEN);
		expect(auth && isGrokAuthExpired(auth)).toBe(true);
	});

	test("a failing CLI is swallowed and the re-read session is returned", async () => {
		const home = tempHome(fixture({ expires_at: PAST }));
		const auth = await ensureFreshGrokAuth({
			home,
			spawn: async () => {
				throw new Error("ENOENT");
			},
		});
		expect(auth?.token).toBe(TOKEN);
		expect(auth && isGrokAuthExpired(auth)).toBe(true);
	});

	test("returns undefined when there is no session", async () => {
		const { spawn, calls } = fakeSpawn(tempHome());
		expect(await ensureFreshGrokAuth({ home: tempHome(), spawn })).toBeUndefined();
		expect(calls).toHaveLength(0);
	});

	test("grokAuthStatusFresh reports the refreshed session without the token", async () => {
		const home = tempHome(fixture({ expires_at: PAST }));
		const { spawn } = fakeSpawn(home);
		const status = await grokAuthStatusFresh({ home, spawn });
		expect(status).toEqual({ loggedIn: true, expired: false, email: "dev@example.com", expiresAt: FUTURE, home });
		expect(JSON.stringify(status)).not.toContain(TOKEN);
	});
});

describe("grokClientVersion", () => {
	test("reads version.json and falls back when missing or malformed", () => {
		const home = tempHome();
		expect(grokClientVersion(home)).toBe(GROK_CLIENT_VERSION_FALLBACK);
		writeFileSync(join(home, "version.json"), JSON.stringify({ version: "1.0.30" }));
		expect(grokClientVersion(home)).toBe("1.0.30");
		writeFileSync(join(home, "version.json"), JSON.stringify({ version: 7 }));
		expect(grokClientVersion(home)).toBe(GROK_CLIENT_VERSION_FALLBACK);
	});
});

describe("grokHeaders", () => {
	test("produces exactly the proxy headers", () => {
		expect(grokHeaders({ token: "abc" }, "grok-4.6", "1.0.25")).toEqual({
			Authorization: "Bearer abc",
			"X-XAI-Token-Auth": "xai-grok-cli",
			"x-grok-model-override": "grok-4.6",
			"x-grok-client-version": "1.0.25",
		});
	});
});

describe("redactSecrets", () => {
	test("masks bearer credentials and JWT-like strings", () => {
		const out = redactSecrets(`auth failed for Bearer ${TOKEN} and token=${TOKEN} ok`);
		expect(out).not.toContain(TOKEN);
		expect(out).toBe("auth failed for [redacted] and token=[redacted] ok");
		expect(redactSecrets("Bearer short-token here")).toBe("[redacted] here");
	});
});

describe("GrokAuthError", () => {
	test("keeps its name for cross-realm checks", () => {
		const error = new GrokAuthError("Grok login missing: run `grok login`");
		expect(error.name).toBe("GrokAuthError");
		expect(error.message).toEndWith("run `grok login`");
	});
});
