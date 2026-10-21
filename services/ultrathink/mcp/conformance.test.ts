// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

/**
 * One set of assertions for the client-driven connector surface, run over every transport: the tool host through
 * handleMcpPayload, the HTTP app, and a real stdio process. A transport may only add framing; what a client sees must
 * be the same. The suites also record the static replies so a last test can compare them byte for byte.
 */

import type { Subprocess } from "bun";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAuth } from "../auth/auth.ts";
import type { UltrathinkConfig } from "../config/config.ts";
import { createLogger } from "../obs/log.ts";
import { type Store, openStore } from "../store/store.ts";
import { createApp } from "../routes/router.ts";
import { GRAPH_APP_URI } from "../ui/graph-app.ts";
import { defaultGraphResources, loadCatalogWithFallback } from "./connector-host.ts";
import { handleMcpPayload } from "./mcp.ts";
import { createToolHost } from "./tool-host.ts";

type Json = Record<string, unknown>;

interface Opened {
	/** Sends one JSON-RPC request and returns the whole response envelope. */
	rpc(method: string, params?: Json): Promise<Json>;
	close(): Promise<void>;
}

const STDIO_MAIN = join(import.meta.dir, "..", "stdio", "main.ts");
const ORIGIN = "https://ultrathink.test";
const PLAN_SESSION = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const STEP_TIMEOUT_MS = 15_000;
const EXPECTED_TOOLS = [
	"ultrathink_answer",
	"ultrathink_command",
	"ultrathink_graph",
	"ultrathink_pending",
	"ultrathink_plan",
	"ultrathink_result",
	"ultrathink_sessions",
	"ultrathink_show",
	"ultrathink_status",
];

const dirs: string[] = [];
afterAll(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tmp(): string {
	const dir = mkdtempSync(join(tmpdir(), "ultrathink-conformance-"));
	dirs.push(dir);
	return dir;
}

/** Narrows a parsed value to an object, failing the test when it is not one. */
function obj(value: unknown): Json {
	expect(typeof value === "object" && value !== null && !Array.isArray(value)).toBe(true);
	// Checked on the line above.
	const checked = value as Json;
	return checked;
}

function list(value: unknown): unknown[] {
	expect(Array.isArray(value)).toBe(true);
	// Checked on the line above.
	const checked = value as unknown[];
	return checked;
}

function str(value: unknown): string {
	expect(typeof value).toBe("string");
	return String(value);
}

function resultOf(reply: Json): Json {
	expect(reply.error).toBeUndefined();
	return obj(reply.result);
}

function errorCodeOf(reply: Json): unknown {
	expect(reply.result).toBeUndefined();
	return obj(reply.error).code;
}

/**
 * Bounds a wait on a spawned process so a hung child fails the test with a name instead of hanging the run. A real
 * timer is the only option here: the child's clock is not ours to fake.
 */
function withTimeout<T>(promise: Promise<T>, what: string, ms = STEP_TIMEOUT_MS): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error(`timed out: ${what}`)), ms);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function envelope(id: number, method: string, params?: Json): Json {
	return { jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) };
}

// -- transport 1: the tool host behind handleMcpPayload -------------------------------------------------------------

async function openDirect(): Promise<Opened> {
	const stateDir = tmp();
	const host = createToolHost({
		journalOpts: { stateDir, maxPromptChars: 8000, maxAnswerChars: 20000 },
		catalog: loadCatalogWithFallback(() => undefined),
		resources: defaultGraphResources(),
	});
	let id = 0;
	return {
		async rpc(method, params) {
			id += 1;
			const reply = await handleMcpPayload(host, envelope(id, method, params));
			expect(reply).not.toBeNull();
			return obj(reply?.body);
		},
		async close() {},
	};
}

// -- transport 2: the HTTP app --------------------------------------------------------------------------------------

const CONNECTOR_KEY = randomBytes(24).toString("hex");

interface HttpOpened extends Opened {
	post(body: unknown, headers?: Record<string, string>): Promise<Response>;
	get(headers?: Record<string, string>): Promise<Response>;
}

let http: HttpOpened | undefined;

function httpServer(): HttpOpened {
	if (http === undefined) throw new Error("the HTTP app is not running");
	return http;
}

async function openHttp(): Promise<HttpOpened> {
	const dir = tmp();
	const sessionSecret = randomBytes(32).toString("hex");
	const ownerPasswordHash = await Bun.password.hash(randomBytes(24).toString("base64url"));
	const config: UltrathinkConfig = {
		publicOrigin: ORIGIN,
		ownerPasswordHash,
		sessionSecret,
		stateDir: dir,
		dbPath: join(dir, "ultrathink.db"),
		port: 0,
		maxInputChars: 8000,
		maxAnswerChars: 20000,
		maxBodyBytes: 65536,
		runTokenCeiling: 5_000_000,
		dailyTokenCeiling: 50_000_000,
		planningModel: undefined,
		connectorKey: CONNECTOR_KEY,
		allowedOrigins: [],
		oauthRedirectOrigins: [],
		openRouterApiKey: undefined,
		openRouterBaseUrl: "https://openrouter.test/api/v1",
		serverPlanning: false,
		maxConcurrentPlans: 2,
		modelTimeoutMs: 5000,
		planTimeoutMs: 60_000,
		modelMaxOutputTokens: 1000,
		sessionSecretPrevious: [],
		breakerFailures: 5,
		breakerWindowMs: 60000,
		breakerOpenMs: 30000,
		maxInflight: 256,
		drainMs: 5000,
		retentionDays: 30,
		auditLog: true,
	};
	const store: Store = openStore(config.dbPath);
	const auth = createAuth({ ownerPasswordHash, sessionSecret, cookieSecure: true });
	const app = createApp({ config, store, auth, logger: createLogger({ write: () => undefined }) });

	function post(body: unknown, headers: Record<string, string> = { "x-connector-key": CONNECTOR_KEY }): Promise<Response> {
		return app.handle(
			new Request(`${ORIGIN}/mcp`, {
				method: "POST",
				headers: { "Content-Type": "application/json", ...headers },
				body: JSON.stringify(body),
			}),
			"127.0.0.1",
		);
	}

	let id = 0;
	const opened: HttpOpened = {
		post,
		get: (headers = { "x-connector-key": CONNECTOR_KEY }) => app.handle(new Request(`${ORIGIN}/mcp`, { method: "GET", headers }), "127.0.0.1"),
		async rpc(method, params) {
			id += 1;
			const response = await post(envelope(id, method, params));
			expect(response.status).toBe(200);
			return obj(await response.json());
		},
		async close() {
			await app.shutdown();
			store.close();
		},
	};
	return opened;
}

// -- transport 3: a spawned stdio process ---------------------------------------------------------------------------

interface StdioProcess {
	proc: Subprocess<"pipe", "pipe", "pipe">;
	/** Every complete line the process wrote to stdout so far. */
	lines: string[];
	send(line: string): void;
	nextLine(): Promise<string>;
	exited: Promise<number>;
}

let stdio: StdioProcess | undefined;

function stdioProcess(): StdioProcess {
	if (stdio === undefined) throw new Error("the stdio process is not running");
	return stdio;
}

function spawnStdio(stateDir: string): StdioProcess {
	const proc = Bun.spawn([process.execPath, STDIO_MAIN], {
		// A directory without a .env file: nothing of the repository's reaches the child.
		cwd: stateDir,
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, ULTRATHINK_STATE_DIR: stateDir, ULTRATHINK_LOG_LEVEL: "warn" },
	});
	const lines: string[] = [];
	const wakeups: Array<() => void> = [];
	const wake = (): void => {
		for (const resolve of wakeups.splice(0)) resolve();
	};

	void (async () => {
		const decoder = new TextDecoder();
		let buffer = "";
		for await (const chunk of proc.stdout) {
			buffer += decoder.decode(chunk, { stream: true });
			for (let newline = buffer.indexOf("\n"); newline !== -1; newline = buffer.indexOf("\n")) {
				lines.push(buffer.slice(0, newline));
				buffer = buffer.slice(newline + 1);
			}
			wake();
		}
		wake();
	})();
	// Drained so a chatty process can never block on a full pipe; the content is not needed.
	void new Response(proc.stderr).text();

	let consumed = 0;
	return {
		proc,
		lines,
		send(line) {
			proc.stdin.write(`${line}\n`);
			proc.stdin.flush();
		},
		async nextLine() {
			while (lines.length <= consumed) {
				await new Promise<void>((resolve) => wakeups.push(resolve));
			}
			const line = lines[consumed];
			consumed += 1;
			return line ?? "";
		},
		exited: proc.exited,
	};
}

async function openStdio(): Promise<Opened> {
	const child = spawnStdio(tmp());
	stdio = child;
	let id = 0;
	return {
		async rpc(method, params) {
			id += 1;
			child.send(JSON.stringify(envelope(id, method, params)));
			const reply = obj(JSON.parse(await withTimeout(child.nextLine(), method)));
			expect(reply.id).toBe(id);
			return reply;
		},
		async close() {
			child.proc.kill();
			await child.exited;
		},
	};
}

/** The one line of `child`'s next reply, parsed. */
async function replyOf(child: StdioProcess, what: string): Promise<Json> {
	return obj(JSON.parse(await withTimeout(child.nextLine(), what)));
}

// -- the shared assertions ------------------------------------------------------------------------------------------

/** What each transport answered for the static requests, by transport name then request label. */
const observed = new Map<string, Map<string, string>>();

function conformance(name: string, open: () => Promise<Opened>, extras?: () => void): void {
	describe(`conformance over ${name}`, () => {
		let t: Opened;
		const seen = new Map<string, string>();
		observed.set(name, seen);
		const record = (label: string, value: unknown): void => void seen.set(label, JSON.stringify(value));

		beforeAll(async () => {
			t = await open();
		});
		afterAll(async () => {
			await t?.close();
		});

		test("initialize negotiates the requested version and announces the surface", async () => {
			const result = resultOf(await t.rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "conformance", version: "0" } }));
			expect(result.protocolVersion).toBe("2025-06-18");
			expect(Object.keys(obj(result.capabilities)).sort()).toEqual(["extensions", "prompts", "resources", "tools"]);
			expect(typeof obj(result.serverInfo).name).toBe("string");
			expect(typeof result.instructions).toBe("string");
			expect(str(result.instructions).length).toBeGreaterThan(0);
			record("initialize", result);
		});

		test("ping answers an empty result", async () => {
			expect(resultOf(await t.rpc("ping"))).toEqual({});
		});

		test("tools/list serves nine tools and no ultrathink_uplift", async () => {
			const result = resultOf(await t.rpc("tools/list"));
			const names = list(result.tools).map((tool) => obj(tool).name);
			expect([...names].sort()).toEqual(EXPECTED_TOOLS);
			expect(names).not.toContain("ultrathink_uplift");
			record("tools/list", result);
		});

		test("prompts/list serves the six supported commands", async () => {
			const result = resultOf(await t.rpc("prompts/list"));
			const names = list(result.prompts).map((prompt) => obj(prompt).name);
			expect(names).toHaveLength(6);
			expect(names).toContain("ultrathink-quick");
			record("prompts/list", result);
		});

		test("prompts/get renders ultrathink-quick with the user's text last", async () => {
			const result = resultOf(await t.rpc("prompts/get", { name: "ultrathink-quick", arguments: { message: "hello conformance" } }));
			const [message] = list(result.messages);
			const content = obj(obj(message).content);
			expect(obj(message).role).toBe("user");
			expect(str(content.text).endsWith("hello conformance")).toBe(true);
			record("prompts/get quick", result);
		});

		test("prompts/get explains an unsupported command instead of failing", async () => {
			const result = resultOf(await t.rpc("prompts/get", { name: "ultrathink-skip" }));
			expect(list(result.messages)).toHaveLength(1);
			record("prompts/get unsupported", result);
		});

		test("prompts/get refuses an unknown name and a missing argument with -32602", async () => {
			expect(errorCodeOf(await t.rpc("prompts/get", { name: "no-such-prompt" }))).toBe(-32602);
			expect(errorCodeOf(await t.rpc("prompts/get", { name: "ultrathink-quick" }))).toBe(-32602);
		});

		test("resources/list and resources/read serve the graph card", async () => {
			const listed = resultOf(await t.rpc("resources/list"));
			expect(list(listed.resources).map((resource) => obj(resource).uri)).toEqual([GRAPH_APP_URI]);
			record("resources/list", listed);

			const read = resultOf(await t.rpc("resources/read", { uri: GRAPH_APP_URI }));
			const [contents] = list(read.contents);
			expect(obj(contents).uri).toBe(GRAPH_APP_URI);
			expect(obj(contents).mimeType).toBe("text/html;profile=mcp-app");
			expect(str(obj(contents).text).length).toBeGreaterThan(0);
			record("resources/read", read);

			expect(resultOf(await t.rpc("resources/templates/list")).resourceTemplates).toEqual([]);
		});

		test("resources/read refuses a missing resource with -32002 and a malformed uri with -32602", async () => {
			expect(errorCodeOf(await t.rpc("resources/read", { uri: "ui://ultrathink/missing" }))).toBe(-32002);
			expect(errorCodeOf(await t.rpc("resources/read", { uri: "https://example.test/x" }))).toBe(-32602);
		});

		test("ultrathink_plan starts a client-driven session that needs the model", async () => {
			const result = resultOf(await t.rpc("tools/call", { name: "ultrathink_plan", arguments: { prompt: "plan the rollout of the conformance suite", sessionId: PLAN_SESSION } }));
			expect(result.isError).toBe(false);
			const structured = obj(result.structuredContent);
			expect(structured.sessionId).toBe(PLAN_SESSION);
			expect(structured.status).toBe("needs-model");
			expect(list(structured.pending).length).toBeGreaterThan(0);
		});

		test("ultrathink_sessions lists that session", async () => {
			const result = resultOf(await t.rpc("tools/call", { name: "ultrathink_sessions", arguments: {} }));
			expect(result.isError).toBe(false);
			const sessions = list(obj(result.structuredContent).sessions);
			expect(sessions.map((session) => obj(session).sessionId)).toContain(PLAN_SESSION);
		});

		test("ultrathink_command help lists the commands", async () => {
			const result = resultOf(await t.rpc("tools/call", { name: "ultrathink_command", arguments: { command: "help" } }));
			expect(result.isError).toBe(false);
			const structured = obj(result.structuredContent);
			expect(structured.command).toBe("help");
			expect(list(structured.commands).length).toBeGreaterThan(0);
			record("tools/call command help", result);
		});

		test("ultrathink_graph answers status none while no session is planned", async () => {
			const result = resultOf(await t.rpc("tools/call", { name: "ultrathink_graph", arguments: {} }));
			expect(result.isError).toBe(false);
			expect(obj(result.structuredContent).status).toBe("none");
			record("tools/call graph none", result);
		});

		test("a refused request is a tool result with isError, not a protocol error", async () => {
			const result = resultOf(await t.rpc("tools/call", { name: "ultrathink_show", arguments: { sessionId: "not-a-session", key: "k" } }));
			expect(result.isError).toBe(true);
			expect(obj(result.structuredContent).error).toBe("invalid_session_id");
			record("tools/call show invalid", result);
		});

		test("an unknown tool and ultrathink_uplift are refused with -32602", async () => {
			expect(errorCodeOf(await t.rpc("tools/call", { name: "no_such_tool", arguments: {} }))).toBe(-32602);
			expect(errorCodeOf(await t.rpc("tools/call", { name: "ultrathink_uplift", arguments: { prompt: "x" } }))).toBe(-32602);
		});

		test("an unknown method is refused with -32601", async () => {
			expect(errorCodeOf(await t.rpc("no/such/method"))).toBe(-32601);
		});

		extras?.();
	});
}

conformance("the tool host (handleMcpPayload)", openDirect);

conformance(
	"HTTP",
	async () => {
		http = await openHttp();
		return http;
	},
	() => {
		test("refuses a request without credentials, with a wrong key and on a GET", async () => {
			const server = httpServer();
			for (const method of ["prompts/list", "resources/list", "tools/list"]) {
				const body = envelope(1, method);
				expect((await server.post(body, {})).status).toBe(401);
				expect((await server.post(body, { "x-connector-key": randomBytes(24).toString("hex") })).status).toBe(401);
			}
			const get = await server.get();
			expect(get.status).toBe(405);
			expect(get.headers.get("allow")).toContain("POST");
		});

		test("answers a notification with 202 and no body", async () => {
			const response = await httpServer().post({ jsonrpc: "2.0", method: "notifications/initialized" });
			expect(response.status).toBe(202);
			expect(await response.text()).toBe("");
		});
	},
);

conformance("stdio", openStdio, () => {
	test("answers a line that is not JSON with -32700 and id null, and keeps serving", async () => {
		const child = stdioProcess();
		child.send("this is not json");
		const reply = await replyOf(child, "parse error");
		expect(reply.id).toBeNull();
		expect(obj(reply.error).code).toBe(-32700);
		child.send(JSON.stringify(envelope(900, "ping")));
		expect((await replyOf(child, "ping")).id).toBe(900);
	});

	test("every stdout line so far is one JSON-RPC message", () => {
		const { lines } = stdioProcess();
		expect(lines.length).toBeGreaterThan(0);
		for (const line of lines) {
			const message = obj(JSON.parse(line));
			expect(message.jsonrpc).toBe("2.0");
			expect("result" in message || "error" in message).toBe(true);
		}
	});
});

/** Ends a spawned process and waits for it, so no child outlives its test or holds its temp directory. */
async function stop(child: StdioProcess): Promise<void> {
	child.proc.kill();
	await child.exited;
}

describe("stdio process lifecycle", () => {
	test("closing stdin ends the process with exit code 0 after the pending reply", async () => {
		const child = spawnStdio(tmp());
		try {
			child.send(JSON.stringify(envelope(1, "ping")));
			child.proc.stdin.end();
			expect((await replyOf(child, "ping")).id).toBe(1);
			expect(await withTimeout(child.exited, "exit after stdin close")).toBe(0);
		} finally {
			await stop(child);
		}
	});

	test.skipIf(process.platform === "win32")("SIGTERM ends the process with exit code 0", async () => {
		const child = spawnStdio(tmp());
		try {
			child.send(JSON.stringify(envelope(1, "ping")));
			// The reply proves the handlers are installed and the loop is waiting for input.
			await replyOf(child, "ping");
			child.proc.kill("SIGTERM");
			expect(await withTimeout(child.exited, "exit after SIGTERM", 5000)).toBe(0);
		} finally {
			await stop(child);
		}
	});

	test("a line over 1 MiB is refused with -32600 and the process keeps serving", async () => {
		const child = spawnStdio(tmp());
		try {
			child.send(`{"pad":"${"x".repeat(1024 * 1024 + 16)}"}`);
			expect(obj((await replyOf(child, "oversized line")).error).code).toBe(-32600);
			child.send(JSON.stringify(envelope(2, "ping")));
			expect((await replyOf(child, "ping")).id).toBe(2);
		} finally {
			await stop(child);
		}
	});
});

describe("the transports agree", () => {
	test("the static replies are identical over every transport", () => {
		const reference = observed.get("the tool host (handleMcpPayload)");
		expect(reference?.size).toBeGreaterThan(0);
		for (const name of ["HTTP", "stdio"]) {
			const other = observed.get(name);
			expect(other?.size).toBe(reference?.size);
			for (const [label, value] of reference ?? []) expect([name, label, other?.get(label)]).toEqual([name, label, value]);
		}
	});
});
