import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type EnsureFreshOptions, type GrokAuth, GrokAuthError, GrokHttpError, readGrokAuth } from "./auth.ts";
import { buildResponsesBody, createGrokCompleter, grokComplete, isGrokAuthError, parseResponsesText } from "./complete.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const TOKEN = "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c2VyLTEyMyIsImV4cCI6MTk5OX0.Sflkxw_RJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c";
const FRESH_TOKEN = "fresh.tok.en";

function tempHome(opts: { expiresAt?: string; version?: string; token?: string } = {}): string {
	const home = mkdtempSync(join(tmpdir(), "aio-grok-complete-"));
	dirs.push(home);
	writeAuth(home, opts);
	if (opts.version) writeFileSync(join(home, "version.json"), JSON.stringify({ version: opts.version }));
	return home;
}

function writeAuth(home: string, opts: { expiresAt?: string; token?: string } = {}): void {
	writeFileSync(
		join(home, "auth.json"),
		JSON.stringify({
			"https://auth.x.ai::client-abc": {
				key: opts.token ?? TOKEN,
				expires_at: opts.expiresAt ?? new Date(Date.now() + 3_600_000).toISOString(),
				email: "dev@example.com",
			},
		}),
	);
}

/** Refresh fake: on `force`, rewrites auth.json with a fresh token the way the CLI would. */
function fakeRefresh(home: string, onForce: () => void = () => writeAuth(home, { token: FRESH_TOKEN })) {
	const calls: EnsureFreshOptions[] = [];
	const refresh = async (opts: EnsureFreshOptions): Promise<GrokAuth | undefined> => {
		calls.push(opts);
		if (opts.force) onForce();
		return readGrokAuth(opts.home);
	};
	return { refresh, calls };
}

interface Captured {
	url: string;
	init: RequestInit;
}

function fakeFetch(respond: () => Response): { fetch: typeof fetch; calls: Captured[] } {
	const calls: Captured[] = [];
	const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
		calls.push({ url: String(input), init: init ?? {} });
		return respond();
	}) as typeof fetch;
	return { fetch: fetchImpl, calls };
}

/** Fake fetch that never resolves; rejects with AbortError when its signal fires. */
function hangingFetch(onCall?: () => void): typeof fetch {
	return ((_input: string | URL | Request, init?: RequestInit) =>
		new Promise<Response>((_resolve, reject) => {
			init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
			onCall?.();
		})) as typeof fetch;
}

async function rejection(promise: Promise<unknown>): Promise<Error> {
	try {
		await promise;
	} catch (error) {
		if (error instanceof Error) return error;
		throw new Error(`rejected with non-Error: ${String(error)}`);
	}
	throw new Error("expected promise to reject");
}

function responsesReply(text: string): Response {
	return Response.json({
		output: [
			{ type: "reasoning", summary: [] },
			{ type: "message", content: [{ type: "output_text", text }] },
		],
		model: "grok-4.6-build",
	});
}

describe("buildResponsesBody", () => {
	test("produces the /responses payload", () => {
		expect(buildResponsesBody("SYS", "USER", "grok-4.6", "xhigh")).toEqual({
			model: "grok-4.6",
			instructions: "SYS",
			input: "USER",
			reasoning: { effort: "xhigh" },
			stream: false,
		});
	});
});

describe("parseResponsesText", () => {
	test("joins output_text blocks from message items, skipping reasoning", () => {
		const text = parseResponsesText({
			output: [
				{ type: "reasoning", content: [{ type: "output_text", text: "ignored" }] },
				{ type: "message", content: [{ type: "output_text", text: "a" }, { type: "refusal", text: "no" }] },
				{ type: "message", content: [{ type: "output_text", text: "b" }] },
			],
		});
		expect(text).toBe("a\nb");
	});

	test("accepts a top-level output_text string", () => {
		expect(parseResponsesText({ output_text: "plain" })).toBe("plain");
	});

	test("throws when there is no text", () => {
		expect(() => parseResponsesText({ output: [{ type: "reasoning" }] })).toThrow("grok returned no text");
		expect(() => parseResponsesText(null)).toThrow("grok returned no text");
	});
});

describe("grokComplete (http)", () => {
	test("posts to {baseUrl}/responses with login headers and returns the text", async () => {
		const { fetch, calls } = fakeFetch(() => responsesReply("<UPLIFT/>"));
		const text = await grokComplete("SYS", "USER", {
			home: tempHome({ version: "1.0.30" }),
			baseUrl: "https://proxy.test/v1/",
			model: "grok-4.6",
			reasoningEffort: "xhigh",
			fetch,
		});
		expect(text).toBe("<UPLIFT/>");
		expect(calls).toHaveLength(1);
		const call = calls[0]!;
		expect(call.url).toBe("https://proxy.test/v1/responses");
		expect(call.init.method).toBe("POST");
		const headers = new Headers(call.init.headers);
		expect(headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
		expect(headers.get("x-xai-token-auth")).toBe("xai-grok-cli");
		expect(headers.get("x-grok-model-override")).toBe("grok-4.6");
		expect(headers.get("x-grok-client-version")).toBe("1.0.30");
		expect(headers.get("content-type")).toBe("application/json");
		const body = JSON.parse(String(call.init.body));
		expect(body).toEqual({ model: "grok-4.6", instructions: "SYS", input: "USER", reasoning: { effort: "xhigh" }, stream: false });
	});

	test("defaults to grok-4.6 at xhigh via createGrokCompleter", async () => {
		const { fetch, calls } = fakeFetch(() => responsesReply("ok"));
		const complete = createGrokCompleter({ home: tempHome(), fetch });
		await complete("S", "U");
		const body = JSON.parse(String(calls[0]!.init.body));
		expect(body.model).toBe("grok-4.6");
		expect(body.reasoning).toEqual({ effort: "xhigh" });
		expect(calls[0]!.url).toBe("https://cli-chat-proxy.grok.com/v1/responses");
	});

	test("401 becomes a GrokAuthError pointing at grok login", async () => {
		const { fetch } = fakeFetch(() => new Response("unauthorized", { status: 401 }));
		const error = await rejection(grokComplete("S", "U", { home: tempHome(), fetch }));
		expect(error).toBeInstanceOf(GrokAuthError);
		expect(isGrokAuthError(error)).toBe(true);
		expect(error.message).toContain("HTTP 401");
		expect(error.message).toEndWith("run `grok login`");
	});

	test("retries once with the refreshed token after a 401", async () => {
		const home = tempHome();
		const { refresh, calls: refreshCalls } = fakeRefresh(home);
		const { fetch, calls } = fakeFetch(() =>
			calls.length === 1 ? new Response("unauthorized", { status: 401 }) : responsesReply("after refresh"),
		);
		expect(await grokComplete("S", "U", { home, fetch, refresh })).toBe("after refresh");
		expect(calls).toHaveLength(2);
		expect(new Headers(calls[0]!.init.headers).get("authorization")).toBe(`Bearer ${TOKEN}`);
		expect(new Headers(calls[1]!.init.headers).get("authorization")).toBe(`Bearer ${FRESH_TOKEN}`);
		expect(refreshCalls).toEqual([
			{ home, bin: undefined, timeoutMs: 20_000 },
			{ home, bin: undefined, timeoutMs: 20_000, force: true },
		]);
	});

	test("a second 401 after the refresh is a GrokAuthError", async () => {
		const home = tempHome();
		const { refresh } = fakeRefresh(home);
		const { fetch, calls } = fakeFetch(() => new Response("unauthorized", { status: 401 }));
		const error = await rejection(grokComplete("S", "U", { home, fetch, refresh }));
		expect(error).toBeInstanceOf(GrokAuthError);
		expect(calls).toHaveLength(2);
	});

	test("does not retry when the forced refresh yields nothing usable", async () => {
		const home = tempHome();
		const { refresh } = fakeRefresh(home, () => writeAuth(home, { expiresAt: new Date(Date.now() - 1_000).toISOString() }));
		const { fetch, calls } = fakeFetch(() => new Response("unauthorized", { status: 401 }));
		const error = await rejection(grokComplete("S", "U", { home, fetch, refresh }));
		expect(error).toBeInstanceOf(GrokAuthError);
		expect(calls).toHaveLength(1);
	});

	test("500 becomes a GrokHttpError with a redacted body", async () => {
		const { fetch } = fakeFetch(() => new Response(`upstream failed for Bearer ${TOKEN}`, { status: 500 }));
		const error = await rejection(grokComplete("S", "U", { home: tempHome(), fetch }));
		expect(error).toBeInstanceOf(GrokHttpError);
		if (!(error instanceof GrokHttpError)) return;
		expect(error.status).toBe(500);
		expect(error.body).toBe("upstream failed for [redacted]");
		expect(error.message).not.toContain(TOKEN);
		expect(isGrokAuthError(error)).toBe(false);
	});

	test("expired login fails before any request", async () => {
		const { fetch, calls } = fakeFetch(() => responsesReply("never"));
		const home = tempHome({ expiresAt: new Date(Date.now() - 1000).toISOString() });
		const error = await rejection(grokComplete("S", "U", { home, fetch }));
		expect(error).toBeInstanceOf(GrokAuthError);
		expect(error.message).toBe("Grok login expired: run `grok login`");
		expect(calls).toHaveLength(0);
	});

	test("missing login fails before any request", async () => {
		const { fetch, calls } = fakeFetch(() => responsesReply("never"));
		const home = mkdtempSync(join(tmpdir(), "aio-grok-empty-"));
		dirs.push(home);
		const error = await rejection(grokComplete("S", "U", { home, fetch }));
		expect(error).toBeInstanceOf(GrokAuthError);
		expect(error.message).toBe("Grok login missing: run `grok login`");
		expect(calls).toHaveLength(0);
	});

	test("already-aborted signal throws AbortError without fetching", async () => {
		const { fetch, calls } = fakeFetch(() => responsesReply("never"));
		const controller = new AbortController();
		controller.abort();
		const error = await rejection(grokComplete("S", "U", { home: tempHome(), fetch, signal: controller.signal }));
		expect(error.name).toBe("AbortError");
		expect(calls).toHaveLength(0);
	});

	test("abort during the request surfaces as AbortError", async () => {
		const controller = new AbortController();
		const fetch = hangingFetch(() => controller.abort());
		const error = await rejection(grokComplete("S", "U", { home: tempHome(), fetch, signal: controller.signal }));
		expect(error.name).toBe("AbortError");
	});

	test("timeout surfaces as a timed-out error", async () => {
		const error = await rejection(grokComplete("S", "U", { home: tempHome(), fetch: hangingFetch(), timeoutMs: 20 }));
		expect(error.message).toBe("grok timed out after 20ms");
	});
});

describe("grokComplete (cli)", () => {
	/** Writes a fake `grok` binary that records argv/env/cwd and prints `reply(prompt)` as its JSON output. */
	function fakeGrok(replyJs: string): { bin: string; argsPath: string } {
		const dir = mkdtempSync(join(tmpdir(), "aio-grok-cli-"));
		dirs.push(dir);
		const bin = join(dir, "grok");
		const argsPath = join(dir, "args.json");
		writeFileSync(
			bin,
			`#!${process.execPath}\nconst args = process.argv.slice(2);\nconst prompt = await Bun.file(args[args.indexOf("--prompt-file") + 1]).text();\nawait Bun.write(${JSON.stringify(argsPath)}, JSON.stringify({ args, prompt, cwd: process.cwd(), env: { GROK_HOME: process.env.GROK_HOME, GROK_SUBAGENTS: process.env.GROK_SUBAGENTS, GROK_MEMORY: process.env.GROK_MEMORY, GROK_WEB_FETCH: process.env.GROK_WEB_FETCH } }));\nconsole.log(JSON.stringify(${replyJs}));\n`,
			{ mode: 0o755 },
		);
		return { bin, argsPath };
	}

	test("spawns the grok CLI tool-free in a scratch cwd and parses .text", async () => {
		const { bin, argsPath } = fakeGrok('{ text: "<X>" + prompt + "</X>", stopReason: "end_turn" }');
		const home = tempHome();
		const text = await grokComplete("SYS", "USER TEXT", { transport: "cli", bin, home, model: "grok-4.6", reasoningEffort: "high", cwd: "/nonexistent" });
		expect(text).toBe("<X>USER TEXT</X>");
		const seen = JSON.parse(await Bun.file(argsPath).text()) as {
			args: string[];
			prompt: string;
			cwd: string;
			env: Record<string, string | undefined>;
		};
		expect(seen.prompt).toBe("USER TEXT");
		expect(seen.env).toEqual({ GROK_HOME: home, GROK_SUBAGENTS: "0", GROK_MEMORY: "0", GROK_WEB_FETCH: "0" });
		expect(seen.cwd).toBe(join(tmpdir(), "aio-grok-scratch"));
		expect(seen.args.slice(0, 4)).toEqual(["-m", "grok-4.6", "--reasoning-effort", "high"]);
		const after = (flag: string) => seen.args[seen.args.indexOf(flag) + 1];
		expect(after("--tools")).toBe("none");
		expect(seen.args).not.toContain("");
		expect(after("--permission-mode")).toBe("plan");
		expect(after("--max-turns")).toBe("1");
		expect(after("--disallowed-tools")).toContain("run_terminal_cmd");
		const denied = seen.args.flatMap((arg, i) => (arg === "--deny" ? [seen.args[i + 1]] : []));
		expect(denied).toEqual(["Bash", "Edit", "Write"]);
		for (const flag of ["--no-plan", "--no-subagents", "--disable-web-search", "--verbatim"]) expect(seen.args).toContain(flag);
		expect(after("--system-prompt-override")).toBe("SYS");
	});

	test("a non-end_turn stopReason is an error even when partial text is present", async () => {
		const { bin } = fakeGrok('{ text: "partial", stopReason: "cancelled" }');
		const error = await rejection(grokComplete("SYS", "USER", { transport: "cli", bin, home: tempHome() }));
		expect(error.message).toBe("grok cli stopped: cancelled");
	});

	test("output without stopReason (older CLI) is still accepted", async () => {
		const { bin } = fakeGrok('{ text: "ok" }');
		expect(await grokComplete("SYS", "USER", { transport: "cli", bin, home: tempHome() })).toBe("ok");
	});
});

describe("isGrokAuthError", () => {
	test("matches by class or by name", () => {
		expect(isGrokAuthError(new GrokAuthError("x: run `grok login`"))).toBe(true);
		expect(isGrokAuthError({ name: "GrokAuthError" })).toBe(true);
		expect(isGrokAuthError(new Error("x"))).toBe(false);
		expect(isGrokAuthError(null)).toBe(false);
	});
});
