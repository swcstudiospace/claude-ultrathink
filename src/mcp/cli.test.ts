// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionRecord } from "../claude/state.ts";
import { resolveOpenRouterKey } from "../decisions/gate.ts";
import { main, prepareRedirect } from "./cli.ts";
import type { McpProviderId } from "./providers.ts";
import type { Run } from "./redirect.ts";
import { readStore, writeStore } from "./store.ts";

const CLI = join(import.meta.dir, "cli.ts");

let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "ut-mcp-cli-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

/** Runs the real CLI with its config files, credential store and cwd all inside `root`; never the machine's OpenRouter key. */
function run(...args: string[]): { code: number | null; stdout: string; stderr: string } {
	return runWith({}, ...args);
}

function runWith(opts: { stdin?: string }, ...args: string[]): { code: number | null; stdout: string; stderr: string } {
	const { OPENROUTER_API_KEY: _machineKey, ...env } = process.env;
	const proc = Bun.spawnSync([process.execPath, CLI, ...args], {
		cwd: root,
		env: {
			...env,
			HOME: join(root, "home"),
			XDG_CONFIG_HOME: join(root, "xdg"),
			CLAUDE_CONFIG_DIR: join(root, "claude"),
			ULTRATHINK_MCP_STORE: join(root, "credentials.json"),
		},
		stdin: opts.stdin === undefined ? "ignore" : new TextEncoder().encode(opts.stdin),
		stdout: "pipe",
		stderr: "pipe",
	});
	return { code: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

describe("notion init", () => {
	test("without --parent is a usage error", () => {
		const { code, stderr } = run("notion", "init", "--write-config");
		expect(code).toBe(2);
		expect(stderr).toContain("notion init needs --parent <notion page url or id>");
		expect(stderr).toContain("ultrathink-mcp notion init --parent");
	});

	test("a --parent without a page id is a usage error", () => {
		const { code, stderr } = run("notion", "init", "--parent", "https://www.notion.so/acme");
		expect(code).toBe(2);
		expect(stderr).toContain("--parent is not a Notion page url or id");
	});

	test("without a Notion login fails with the login command and writes no config", () => {
		const { code, stderr } = run("notion", "init", "--parent", "0123456789abcdef0123456789abcdef", "--write-config");
		expect(code).toBe(1);
		expect(stderr).toContain("notion is not logged in: run: ultrathink-mcp auth login notion");
		expect(stderr).not.toContain("set-key");
		expect(existsSync(join(root, "xdg", "ultrathink", "config.json"))).toBe(false);
	});
});

describe("track complete", () => {
	const record: SessionRecord = {
		sessionId: "s1",
		at: 1,
		result: { xml: "<BUILD_PROMPT/>", original: "ship it", root: "/repo", source: "llm" },
		plan: {
			graphId: "ut-test",
			task: {
				graphId: "ut-test",
				item: "Ship it",
				description: "ship it",
				upliftedPrompt: "<BUILD_PROMPT/>",
				agent: "claude-code",
				status: "Planning",
				linearState: "Todo",
			},
			issues: [],
			subIssues: [],
			linearIssues: [],
			linearSubIssues: [],
			hitl: { blocking: [], nonBlocking: [] },
		},
	};

	/** A session file in <root>/state/sessions, with control.json beside sessions/ and an optional user config. */
	function session(control: Record<string, unknown> | undefined, config: Record<string, unknown> | undefined): string {
		const stateDir = join(root, "state");
		mkdirSync(join(stateDir, "sessions"), { recursive: true });
		if (control) writeFileSync(join(stateDir, "control.json"), JSON.stringify(control));
		if (config) {
			mkdirSync(join(root, "xdg", "ultrathink"), { recursive: true });
			writeFileSync(join(root, "xdg", "ultrathink", "config.json"), JSON.stringify(config));
		}
		const path = join(stateDir, "sessions", "s1.json");
		writeFileSync(path, JSON.stringify(record));
		return path;
	}

	test("tracking off (/ultrathink-track off) exits 0 without touching the session, even when configured", () => {
		const path = session({ trackEnabled: false }, { linear: { team: "Acme" } });
		const { code, stdout, stderr } = run("track", "complete", "--state", path);
		expect(code).toBe(0);
		expect(stderr).toContain("ultrathink-mcp: tracking is off (/ultrathink-track on to enable)");
		expect(stdout).toBe("");
		expect(readFileSync(path, "utf8")).toBe(JSON.stringify(record));
		expect(existsSync(path.replace(/\.json$/, ".xml"))).toBe(false);
	});

	test("no linear.team or notion.dataSourceUrl exits 0 and names the config file and notion init", () => {
		const path = session(undefined, undefined);
		const { code, stderr } = run("track", "complete", "--state", path);
		expect(code).toBe(0);
		expect(stderr).toContain(
			`ultrathink-mcp: tracking not configured: set linear.team and/or notion.dataSourceUrl in ${join(root, "xdg", "ultrathink", "config.json")}`,
		);
		expect(stderr).toContain("ultrathink-mcp notion init --parent <page>");
		expect(readFileSync(path, "utf8")).toBe(JSON.stringify(record));
	});

	test("tracking on with a configured team goes on to the tracker", () => {
		const path = session({ trackEnabled: true }, { linear: { team: "Acme" } });
		const { code, stderr } = run("track", "complete", "--state", path);
		expect(code).toBe(1);
		expect(stderr).toContain("no tracker credentials");
	});
});

describe("session mark", () => {
	const record: SessionRecord = {
		sessionId: "s1",
		at: 1,
		host: "hermes",
		result: { xml: "<BUILD_PROMPT/>", original: "ship it", root: "/repo", source: "llm" },
		skill: { name: "gsd-quick", source: "slash" },
	};

	function session(value: unknown): string {
		mkdirSync(join(root, "state", "sessions"), { recursive: true });
		const path = join(root, "state", "sessions", "s1.json");
		writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value));
		return path;
	}

	test("kicked-off sets kickedOff, keeps every other field, and prints nothing", () => {
		const path = session(record);
		const { code, stdout, stderr } = run("session", "mark", "--state", path, "kicked-off");
		expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "", stderr: "" });
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ ...record, kickedOff: true });
	});

	test("synced sets synced without clearing an earlier kickedOff, whatever the argument order", () => {
		const path = session({ ...record, kickedOff: true });
		const { code } = run("session", "mark", "synced", "--state", path);
		expect(code).toBe(0);
		expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ ...record, kickedOff: true, synced: true });
	});

	test("an unknown, missing or doubled mark is a usage error and leaves the file alone", () => {
		const path = session(record);
		for (const marks of [["kickedOff"], [], ["kicked-off", "synced"]]) {
			const { code, stderr } = run("session", "mark", "--state", path, ...marks);
			expect(code).toBe(2);
			expect(stderr).toContain("session mark needs one of kicked-off, synced");
			expect(stderr).toContain("ultrathink-mcp session mark --state");
		}
		expect(readFileSync(path, "utf8")).toBe(JSON.stringify(record));
	});

	test("a missing or unreadable session file exits 1 with one line and writes nothing", () => {
		const missing = join(root, "state", "sessions", "gone.json");
		const gone = run("session", "mark", "--state", missing, "kicked-off");
		expect(gone.code).toBe(1);
		expect(gone.stderr).toBe(`ultrathink-mcp: cannot read session record: ${missing}\n`);
		expect(existsSync(missing)).toBe(false);
		for (const garbage of ["{not json", "null", JSON.stringify({ sessionId: "s1" })]) {
			const path = session(garbage);
			const { code, stderr } = run("session", "mark", "--state", path, "kicked-off");
			expect(code).toBe(1);
			expect(stderr).toBe(`ultrathink-mcp: cannot read session record: ${path}\n`);
			expect(readFileSync(path, "utf8")).toBe(garbage);
		}
	});
});

describe("auth login redirect", () => {
	const DNS = "vps.example.ts.net";
	const sshEnv = { SSH_CONNECTION: "198.51.100.4 51234 203.0.113.7 22", USER: "alice" };
	const SERVE = ["tailscale", "serve", "--bg", "--https=443", "--set-path=/ultrathink-oauth", "http://127.0.0.1:8765"];

	/** A host where Tailscale is running with HTTPS certificates; `serveExit` is what `tailscale serve` returns. */
	function tailnetHost(serveExit = 0): { run: Run; calls: string[][] } {
		const calls: string[][] = [];
		const status = JSON.stringify({ BackendState: "Running", Self: { DNSName: `${DNS}.` }, CertDomains: [DNS] });
		return {
			calls,
			run: (argv) => {
				calls.push(argv);
				return argv[1] === "status" ? { exitCode: 0, stdout: status } : { exitCode: serveExit, stdout: "" };
			},
		};
	}

	test("over SSH on a tailnet host without the opt-in, no tailscale command runs and the loopback route is used", () => {
		const { run, calls } = tailnetHost();
		const { plan, mount } = prepareRedirect({ args: [], env: sshEnv, port: 8765, run });
		expect(calls).toEqual([]);
		expect(mount).toBeUndefined();
		expect(plan).toMatchObject({ mode: "loopback", redirectUri: "http://127.0.0.1:8765/callback", remote: true });
		const hint = plan.hint.join("\n");
		expect(hint).toContain("ssh -L 8765:127.0.0.1:8765 alice@203.0.113.7");
		expect(hint).toContain("pasting the redirected URL");
		expect(hint).toContain("--tailscale");
	});

	test("--tailscale or ULTRATHINK_OAUTH_TAILSCALE=1 mounts the tailscale serve route", () => {
		const cases: [string[], Record<string, string>][] = [
			[["--tailscale"], sshEnv],
			[[], { ...sshEnv, ULTRATHINK_OAUTH_TAILSCALE: "1" }],
		];
		for (const [args, env] of cases) {
			const { run, calls } = tailnetHost();
			const { plan, mount } = prepareRedirect({ args, env, port: 8765, run });
			expect(calls).toEqual([["tailscale", "status", "--json"], SERVE]);
			expect(mount).toEqual({ https: 443, path: "/ultrathink-oauth", target: "http://127.0.0.1:8765" });
			expect(plan).toMatchObject({ mode: "tailscale", redirectUri: `https://${DNS}/ultrathink-oauth/callback` });
		}
	});

	test("ULTRATHINK_OAUTH_TAILSCALE other than 1 is not an opt-in", () => {
		const { run, calls } = tailnetHost();
		const { plan } = prepareRedirect({ args: [], env: { ...sshEnv, ULTRATHINK_OAUTH_TAILSCALE: "0" }, port: 8765, run });
		expect(calls).toEqual([]);
		expect(plan.mode).toBe("loopback");
	});

	test("an explicit redirect wins over --tailscale and runs no tailscale command", () => {
		const { run, calls } = tailnetHost();
		const { plan, mount } = prepareRedirect({
			args: ["--tailscale", "--redirect", "https://auth.example.com/cb"],
			env: sshEnv,
			port: 8765,
			run,
		});
		expect(calls).toEqual([]);
		expect(mount).toBeUndefined();
		expect(plan).toMatchObject({ mode: "override", redirectUri: "https://auth.example.com/cb" });
	});

	test("a failed tailscale serve falls back to the loopback route and reports why", () => {
		const { run, calls } = tailnetHost(1);
		const { plan, mount } = prepareRedirect({ args: ["--tailscale"], env: sshEnv, port: 8765, run });
		expect(calls).toEqual([["tailscale", "status", "--json"], SERVE]);
		expect(mount).toBeUndefined();
		expect(plan).toMatchObject({ mode: "loopback", redirectUri: "http://127.0.0.1:8765/callback" });
		expect(plan.mount).toBeUndefined();
		expect(plan.hint[0]).toContain("could not be set up");
		expect(plan.hint.join("\n")).toContain("ssh -L 8765:127.0.0.1:8765 alice@203.0.113.7");
	});

	test("the usage text lists --tailscale for auth login", () => {
		const { code, stderr } = run("auth", "login");
		expect(code).toBe(2);
		expect(stderr).toContain("auth login <provider> [--port <n>] [--redirect <url>] [--tailscale] [--no-listen]");
	});
});

describe("openrouter API-key provider", () => {
	const K = "sk-or-v1-UTTESTKEY-0123456789abcdef";
	const REFUSAL =
		"ultrathink-mcp: openrouter is an API-key provider, not an MCP server: store its key with ultrathink-mcp auth set-key openrouter --stdin";
	const store = (): string => join(root, "credentials.json");
	const storeKey = (): void =>
		writeStore(store(), { version: 1, providers: { openrouter: { kind: "api_key", apiKey: K, updatedAt: 1 } } });
	const noLeak = (...outputs: string[]): void => {
		for (const output of outputs) {
			expect(output).not.toContain(K);
			expect(output).not.toContain("Bearer sk-or-");
		}
	};

	test("set-key --stdin stores the key 0600 and prints only its length", () => {
		const { code, stdout, stderr } = runWith({ stdin: `${K}\n` }, "auth", "set-key", "openrouter", "--stdin");
		expect(code).toBe(0);
		expect(stdout).toBe("openrouter: api key stored (35 chars)\n");
		noLeak(stdout, stderr);
		expect(statSync(store()).mode & 0o777).toBe(0o600);
		expect(resolveOpenRouterKey(store(), {})).toEqual({ key: K, source: "store" });
	});

	test("set-key --env-file --var stores the key from an env file", () => {
		const file = join(root, "openrouter.env");
		writeFileSync(file, `# keys\nOPENROUTER_API_KEY=${K}\n`);
		const { code, stdout, stderr } = run("auth", "set-key", "openrouter", "--env-file", file, "--var", "OPENROUTER_API_KEY");
		expect(code).toBe(0);
		expect(stdout).toBe("openrouter: api key stored (35 chars)\n");
		noLeak(stdout, stderr);
		expect(statSync(store()).mode & 0o777).toBe(0o600);
		expect(resolveOpenRouterKey(store(), {})).toEqual({ key: K, source: "store" });
	});

	test("auth status lists openrouter by key length, or as not configured, never the key", () => {
		const empty = run("auth", "status");
		expect(empty.code).toBe(0);
		expect(empty.stdout.split("\n")).toContain("openrouter  none  not ready  not configured");
		storeKey();
		const stored = run("auth", "status");
		expect(stored.code).toBe(0);
		expect(stored.stdout.split("\n")).toContain("openrouter  api_key  ready  api key set (35 chars)");
		noLeak(stored.stdout, stored.stderr);
	});

	test("auth logout openrouter removes only its key", () => {
		writeStore(store(), {
			version: 1,
			providers: {
				openrouter: { kind: "api_key", apiKey: K, updatedAt: 1 },
				linear: { kind: "api_key", apiKey: "lin_api_x", updatedAt: 1 },
			},
		});
		const { code, stdout } = run("auth", "logout", "openrouter");
		expect(code).toBe(0);
		expect(stdout).toBe("openrouter: logged out\n");
		expect(Object.keys(readStore(store()).providers)).toEqual(["linear"]);
	});

	test.each<string[]>([
		["serve", "openrouter"],
		["check", "openrouter"],
		["auth", "login", "openrouter"],
	])("%s … openrouter is a usage error that names set-key, with no relay, connection or login", (...args) => {
		storeKey();
		const before = readFileSync(store(), "utf8");
		const { code, stdout, stderr } = run(...args);
		expect(code).toBe(2);
		expect(stderr.split("\n")[0]).toBe(REFUSAL);
		expect(stderr).toContain("usage:\n");
		expect(stdout).toBe("");
		noLeak(stdout, stderr);
		expect(readFileSync(store(), "utf8")).toBe(before);
	});

	test("the usage text says openrouter, vercel, hindsight and ragflow are API-key only", () => {
		const { stderr } = run("auth", "set-key");
		expect(stderr).toContain(
			"  ultrathink-mcp auth set-key <provider> (--stdin | --env-file <path> --var <NAME>)\n  (openrouter, vercel, hindsight and ragflow are API-key only: set-key, status and logout; never serve, check or login)\n",
		);
	});

	describe("check in process", () => {
		let savedStore: string | undefined;
		beforeEach(() => {
			savedStore = process.env.ULTRATHINK_MCP_STORE;
			process.env.ULTRATHINK_MCP_STORE = store();
			storeKey();
		});
		afterEach(() => {
			if (savedStore === undefined) delete process.env.ULTRATHINK_MCP_STORE;
			else process.env.ULTRATHINK_MCP_STORE = savedStore;
		});

		/** main() with stdout/stderr captured and every provider check recorded instead of connecting. */
		async function check(argv: string[]): Promise<{ code: number; stdout: string; stderr: string; attempted: McpProviderId[] }> {
			const attempted: McpProviderId[] = [];
			const stdout: string[] = [];
			const stderr: string[] = [];
			const writes = { out: process.stdout.write, err: process.stderr.write };
			process.stdout.write = ((chunk: string | Uint8Array) => stdout.push(String(chunk)) > 0) as unknown as typeof process.stdout.write;
			process.stderr.write = ((chunk: string | Uint8Array) => stderr.push(String(chunk)) > 0) as unknown as typeof process.stderr.write;
			let code: number;
			try {
				code = await main(argv, {
					checkOne: async (id) => {
						attempted.push(id);
						return 3;
					},
				});
			} finally {
				process.stdout.write = writes.out;
				process.stderr.write = writes.err;
			}
			return { code, stdout: stdout.join(""), stderr: stderr.join(""), attempted };
		}

		test("check with no ids connects to the MCP servers only, never openrouter", async () => {
			const result = await check(["check"]);
			expect(result.code).toBe(0);
			expect(result.attempted).toEqual(["notion", "linear", "greptile"]);
			expect(result.stdout).toBe("notion: OK 3 tools\nlinear: OK 3 tools\ngreptile: OK 3 tools\n");
			expect(result.stdout).not.toContain("openrouter");
			noLeak(result.stdout, result.stderr);
		});

		test("check openrouter, alone or among MCP ids, fails before any connection attempt", async () => {
			for (const argv of [["check", "openrouter"], ["check", "linear", "openrouter"]]) {
				const result = await check(argv);
				expect(result.code).toBe(2);
				expect(result.attempted).toEqual([]);
				expect(result.stderr.split("\n")[0]).toBe(REFUSAL);
				noLeak(result.stdout, result.stderr);
			}
		});
	});
});

describe.each([
	{ id: "hindsight", envVar: "HINDSIGHT_API_KEY", key: "hs-UTTESTKEY-0123456789abcdef" },
	{ id: "ragflow", envVar: "RAGFLOW_API_KEY", key: "ragflow-UTTESTKEY-0123456789abcdef" },
] as const)("$id API-key provider", ({ id, envVar, key }) => {
	const refusal = `ultrathink-mcp: ${id} is an API-key provider, not an MCP server: store its key with ultrathink-mcp auth set-key ${id} --stdin`;
	const store = (): string => join(root, "credentials.json");
	const storeKey = (): void => writeStore(store(), { version: 1, providers: { [id]: { kind: "api_key", apiKey: key, updatedAt: 1 } } });
	const noLeak = (...outputs: string[]): void => {
		for (const output of outputs) expect(output).not.toContain(key);
	};

	test("set-key --stdin stores the key 0600 and prints only its length", () => {
		const { code, stdout, stderr } = runWith({ stdin: `${key}\n` }, "auth", "set-key", id, "--stdin");
		expect(code).toBe(0);
		expect(stdout).toBe(`${id}: api key stored (${key.length} chars)\n`);
		noLeak(stdout, stderr);
		expect(statSync(store()).mode & 0o777).toBe(0o600);
		expect(readStore(store()).providers[id]).toMatchObject({ kind: "api_key", apiKey: key });
	});

	test("set-key --env-file --var stores the key from an env file", () => {
		const file = join(root, `${id}.env`);
		writeFileSync(file, `# keys\nexport ${envVar}="${key}"\n`);
		const { code, stdout, stderr } = run("auth", "set-key", id, "--env-file", file, "--var", envVar);
		expect(code).toBe(0);
		expect(stdout).toBe(`${id}: api key stored (${key.length} chars)\n`);
		noLeak(stdout, stderr);
		expect(readStore(store()).providers[id]).toMatchObject({ kind: "api_key", apiKey: key });
	});

	test("auth status lists it by key length, or as not configured, never the key", () => {
		const empty = run("auth", "status");
		expect(empty.code).toBe(0);
		expect(empty.stdout.split("\n")).toContain(`${id}  none  not ready  not configured`);
		storeKey();
		const stored = run("auth", "status");
		expect(stored.code).toBe(0);
		expect(stored.stdout.split("\n")).toContain(`${id}  api_key  ready  api key set (${key.length} chars)`);
		noLeak(stored.stdout, stored.stderr);
	});

	test("auth logout removes only its key", () => {
		writeStore(store(), {
			version: 1,
			providers: {
				[id]: { kind: "api_key", apiKey: key, updatedAt: 1 },
				linear: { kind: "api_key", apiKey: "lin_api_x", updatedAt: 1 },
			},
		});
		const { code, stdout } = run("auth", "logout", id);
		expect(code).toBe(0);
		expect(stdout).toBe(`${id}: logged out\n`);
		expect(Object.keys(readStore(store()).providers)).toEqual(["linear"]);
	});

	test.each<string[]>([["serve"], ["check"], ["auth", "login"]])("%s is a usage error that names set-key, with no relay, connection or login", (...head) => {
		storeKey();
		const before = readFileSync(store(), "utf8");
		const args = head.length === 1 ? [head[0] as string, id] : [...head, id];
		const { code, stdout, stderr } = run(...args);
		expect(code).toBe(2);
		expect(stderr.split("\n")[0]).toBe(refusal);
		expect(stderr).toContain("usage:\n");
		expect(stdout).toBe("");
		noLeak(stdout, stderr);
		expect(readFileSync(store(), "utf8")).toBe(before);
	});
});
