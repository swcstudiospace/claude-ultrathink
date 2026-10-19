import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import tokenOpt, { PREFIX_POLICY } from "./index.ts";
import { setGraphifyBinForTests } from "./graph.ts";

type Handler = (...args: unknown[]) => unknown;
type Tool = { execute: (...args: unknown[]) => Promise<{ content: Array<{ text: string }>; isError?: boolean }> };
type Command = (args: string, ctx: unknown) => Promise<void>;
type TextOut = { content?: Array<{ type?: string; text?: string }> };

const cleanups: Array<() => void> = [];

afterEach(() => {
	for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function tempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

/** Point HOME at a fresh directory for the test. An unset HOME is deleted on restore, never set to "undefined". */
function useHome(): string {
	const home = tempDir("token-opt-home-");
	const previous = process.env.HOME;
	process.env.HOME = home;
	cleanups.push(() => {
		if (previous === undefined) delete process.env.HOME;
		else process.env.HOME = previous;
	});
	return home;
}

function mount() {
	const handlers = new Map<string, Handler>();
	const tools = new Map<string, Tool>();
	const commands = new Map<string, Command>();
	const events: string[] = [];
	const pi = {
		setLabel() {},
		zod: { object: () => ({}), string: () => ({}) },
		registerTool(tool: { name: string } & Tool) {
			tools.set(tool.name, tool);
		},
		registerCommand(name: string, options: { handler: Command }) {
			commands.set(name, options.handler);
		},
		on(event: string, handler: Handler) {
			events.push(event);
			handlers.set(event, handler);
		},
		events: { emit() {} },
	};
	tokenOpt(pi as unknown as Parameters<typeof tokenOpt>[0]);
	return { handlers, tools, commands, events };
}

function liveOf(home: string): Record<string, unknown> {
	return JSON.parse(readFileSync(join(home, ".omp", "agent", "token-opt", "live.json"), "utf8")) as Record<string, unknown>;
}

async function statusOf(commands: Map<string, Command>, ctx: { cwd?: string } = {}): Promise<string> {
	let status = "";
	await commands.get("token-status")?.("", {
		...ctx,
		ui: {
			notify(message: string) {
				status = message;
			},
		},
	});
	return status;
}

describe("tokenOpt", () => {
	test("does not register before_agent_start, dedupes long results once, and skips rtk when the extension exists", async () => {
		const home = useHome();
		const { handlers, commands, events } = mount();
		expect(PREFIX_POLICY.injectSystemPrompt).toBe(false);
		expect(events.includes("before_agent_start")).toBe(false);

		const toolResult = handlers.get("tool_result");
		expect(toolResult).toBeDefined();
		const text = "x".repeat(201);
		const first = toolResult?.({ toolName: "read", content: [{ type: "text", text }] });
		expect(first).toBeUndefined();
		const second = toolResult?.({ toolName: "read", content: [{ type: "text", text }] }) as TextOut;
		expect(second?.content?.[0]?.text).toBe("token-opt: repeated read result omitted (201 chars)");
		const short = "y".repeat(200);
		expect(toolResult?.({ toolName: "read", content: [{ type: "text", text: short }] })).toBeUndefined();
		const empty = toolResult?.({ toolName: "grep", content: [{ type: "text", text: "No matches found" }] }) as TextOut;
		expect(empty?.content?.[0]?.text).toBe("token-opt: grep empty");
		expect(toolResult?.({ toolName: "grep", content: [{ type: "text", text: "abc" }] })).toBeUndefined();
		expect(toolResult?.({ toolName: "read", content: [{ type: "text", text: short }] })).toBeUndefined();
		const toolCall = handlers.get("tool_call");
		expect(toolCall).toBeDefined();
		const proj = tempDir("token-opt-proj-");
		mkdirSync(join(proj, ".omp", "extensions"), { recursive: true });
		writeFileSync(join(proj, ".omp", "extensions", "rtk.ts"), "export {};\n");
		const skippedCwd = await toolCall?.({
			toolName: "bash",
			cwd: proj,
			input: { command: "git status", extra: 1 },
		});
		expect(skippedCwd).toBeUndefined();

		const homeExt = join(home, ".omp", "agent", "extensions");
		mkdirSync(homeExt, { recursive: true });
		writeFileSync(join(homeExt, "rtk.ts"), "export {};\n");
		const bare = tempDir("token-opt-bare-");
		const skippedHome = await toolCall?.({ toolName: "bash", cwd: bare, input: { command: "ls -la" } });
		expect(skippedHome).toBeUndefined();

		handlers.get("turn_start")?.({});
		// Real omp assistant messages carry `duration` and `ttft` (ms) and a `responseId`, not `id` or `durationMs`.
		handlers.get("message_end")?.({
			message: {
				role: "assistant",
				responseId: "resp-1",
				duration: 7,
				ttft: 3,
				usage: { input: 1, output: 0, cacheRead: 3, cacheWrite: 0 },
			},
		});
		const status = await statusOf(commands);
		expect(status.includes("last turn 7ms")).toBe(true);
		expect(status.includes("ttft 3ms")).toBe(true);
		expect(status.includes("cache hit 75%")).toBe(true);
	});

	test("a 200-char result is not a repeat across session_start reload of a different id", () => {
		useHome();
		const { handlers } = mount();
		const toolResult = handlers.get("tool_result");
		const start = handlers.get("session_start");
		const text = "z".repeat(200);
		start?.({ sessionId: "sess-a" }, {});
		expect(toolResult?.({ toolName: "read", content: [{ type: "text", text }] })).toBeUndefined();
		start?.({ sessionId: "sess-b" }, {});
		expect(toolResult?.({ toolName: "read", content: [{ type: "text", text }] })).toBeUndefined();
		const longer = "q".repeat(201);
		expect(toolResult?.({ toolName: "read", content: [{ type: "text", text: longer }] })).toBeUndefined();
		const repeated = toolResult?.({ toolName: "read", content: [{ type: "text", text: longer }] }) as TextOut;
		expect(repeated?.content?.[0]?.text).toBe("token-opt: repeated read result omitted (201 chars)");
		start?.({ sessionId: "sess-c" }, {});
		expect(toolResult?.({ toolName: "read", content: [{ type: "text", text: longer }] })).toBeUndefined();
	});

	test("a repeat pointer names the call, and compaction resets the dedupe so the content can be read again", () => {
		useHome();
		const { handlers } = mount();
		handlers.get("session_start")?.({ sessionId: "sess-compact" }, {});
		const toolResult = handlers.get("tool_result");
		const text = "w".repeat(300);
		const event = { toolName: "grep", input: { command: "find the thing" }, content: [{ type: "text", text }] };
		expect(toolResult?.(event)).toBeUndefined();
		const repeated = toolResult?.(event) as TextOut;
		expect(repeated?.content?.[0]?.text).toBe("token-opt: repeated grep result omitted (300 chars) for find the thing");
		expect(handlers.has("session_compact")).toBe(true);
		handlers.get("session_compact")?.({});
		expect(toolResult?.(event)).toBeUndefined();
	});

	test("a text rewrite keeps image blocks", () => {
		useHome();
		const { handlers } = mount();
		const toolResult = handlers.get("tool_result");
		const image = { type: "image", data: "AAAA", mimeType: "image/png" };
		const empty = toolResult?.({
			toolName: "screenshot",
			content: [image, { type: "text", text: "" }, { type: "text", text: "No matches found" }],
		}) as { content: unknown[] };
		expect(empty.content).toEqual([{ type: "text", text: "token-opt: screenshot empty" }, image]);
		const text = "v".repeat(300);
		expect(toolResult?.({ toolName: "screenshot", content: [{ type: "text", text }, image] })).toBeUndefined();
		const repeated = toolResult?.({ toolName: "screenshot", content: [{ type: "text", text }, image] }) as { content: unknown[] };
		expect(repeated.content).toHaveLength(2);
		expect(repeated.content[1]).toEqual(image);
	});

	test("skims a long read before shrink and reports graph readiness without spawning", async () => {
		const home = useHome();
		const { handlers, commands } = mount();
		handlers.get("session_start")?.({ sessionId: "sess-skim" }, {});
		const body = `export function kept() {\n${"x".repeat(13_000)}\n}\n`;
		const skimmed = handlers.get("tool_result")?.({
			toolName: "read",
			input: { path: "src/kept.ts" },
			content: [{ type: "text", text: body }],
		}) as TextOut;
		expect(skimmed?.content?.[0]?.text).toContain("export function kept()");
		expect(skimmed?.content?.[0]?.text).toMatch(/token-opt: skimmed \d+ chars/);
		expect(skimmed?.content?.[0]?.text).not.toContain("x".repeat(100));
		const live = liveOf(home) as { points: Array<{ source: string; saved: number }> };
		expect(live.points.some((point) => point.source === "compress" && point.saved > 0)).toBe(true);
		const md = `# title\n${"y".repeat(13_000)}\n`;
		const markdown = handlers.get("tool_result")?.({
			toolName: "read",
			input: { path: "README.md" },
			content: [{ type: "text", text: md }],
		}) as TextOut | undefined;
		expect(markdown?.content?.[0]?.text ?? md).not.toContain("token-opt: skimmed");
		const root = tempDir("token-opt-graph-");
		expect((await statusOf(commands, { cwd: root })).endsWith("graph missing")).toBe(true);
		mkdirSync(join(root, "graphify-out"), { recursive: true });
		writeFileSync(join(root, "graphify-out", "graph.json"), "{}\n");
		expect((await statusOf(commands, { cwd: root })).endsWith("graph ready")).toBe(true);
	});

	test("message_end cache read does not increase savedTokens", async () => {
		useHome();
		const { handlers, commands } = mount();
		handlers.get("message_end")?.({
			message: {
				role: "assistant",
				responseId: "resp-cache",
				usage: { input: 1, output: 0, cacheRead: 3, cacheWrite: 0 },
			},
		});
		const status = await statusOf(commands);
		expect(status.includes("saved 0")).toBe(true);
		expect(status.includes("cache hit 75%")).toBe(true);
	});

	test("costCents is the session cost: sub-cent messages add up instead of rounding to zero each", () => {
		const home = useHome();
		const { handlers } = mount();
		handlers.get("session_start")?.({ sessionId: "sess-cost" }, {});
		const end = handlers.get("message_end");
		for (let i = 0; i < 3; i++) {
			end?.({ message: { role: "assistant", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.004 } } } });
		}
		// 3 x $0.004 = 1.2 cents; per-message rounding would have published 0.
		expect(liveOf(home).costCents).toBe(1);
		for (let i = 0; i < 2; i++) {
			end?.({ message: { role: "assistant", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.004 } } } });
		}
		expect(liveOf(home).costCents).toBe(2);
		// The same response reported twice is billed once.
		const dup = { role: "assistant", responseId: "resp-dup", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.1 } } };
		end?.({ message: dup });
		end?.({ message: dup });
		expect(liveOf(home).costCents).toBe(12);
	});

	test("switching to another session and back does not drop the fractions of a cent", () => {
		const home = useHome();
		const { handlers } = mount();
		const end = handlers.get("message_end");
		const message = () => ({ message: { role: "assistant", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.0049 } } } });
		handlers.get("session_start")?.({ sessionId: "sess-a" }, {});
		end?.(message());
		handlers.get("session_switch")?.({ sessionId: "sess-b" }, {});
		handlers.get("session_switch")?.({ sessionId: "sess-a" }, {});
		end?.(message());
		// 2 x $0.0049 = 0.98 cents. Resuming from the persisted, rounded 0 cents would have published 0 again.
		expect(liveOf(home).costCents).toBe(1);
	});

	test("a later different system string sets prefixChanged without savings", async () => {
		useHome();
		const { handlers, commands } = mount();
		const first = { system: "alpha", messages: [{ role: "user", content: "keep" }] };
		const second = { system: "beta", messages: [{ role: "user", content: "keep" }] };
		const before = JSON.stringify(first);
		handlers.get("before_provider_request")?.({ payload: first });
		handlers.get("before_provider_request")?.({ payload: second });
		expect(JSON.stringify(first)).toBe(before);
		const status = await statusOf(commands);
		expect(status.includes("prefix moved")).toBe(true);
		expect(status.includes("saved 0")).toBe(true);
	});

	test("session_start after a prefix change does not leave prefixChanged 1 on the new session", async () => {
		const home = useHome();
		const { handlers, commands } = mount();
		handlers.get("session_start")?.({ sessionId: "sess-prefix-a" }, {});
		handlers.get("before_provider_request")?.({ payload: { system: "alpha" } });
		handlers.get("before_provider_request")?.({ payload: { system: "beta" } });
		handlers.get("session_start")?.({ sessionId: "sess-prefix-b" }, {});
		const status = await statusOf(commands);
		expect(status.includes("prefix stable")).toBe(true);
		expect(status.includes("prefix moved")).toBe(false);
		expect(status.includes("skim archive 0")).toBe(true);
		const live = liveOf(home);
		expect(live.sessionId).toBe("sess-prefix-b");
		expect(live.prefixChanged).not.toBe(1);
	});

	test("message_end without usage still bills a later usage event once", () => {
		const home = useHome();
		const { handlers } = mount();
		handlers.get("session_start")?.({ sessionId: "sess-usage" }, {});
		const end = handlers.get("message_end");
		end?.({ message: { role: "assistant", responseId: "m-late", duration: 4 } });
		end?.({ message: { role: "assistant", responseId: "m-late", usage: { input: 7, output: 1, cacheRead: 0, cacheWrite: 0 } } });
		end?.({ message: { role: "assistant", responseId: "m-late", usage: { input: 7, output: 1, cacheRead: 0, cacheWrite: 0 } } });
		const live = liveOf(home);
		expect(live.providerInput).toBe(7);
		expect(live.lastTurnMs).toBe(4);
	});

	test("read_span returns an archived export line and misses unknown paths without reading disk", async () => {
		useHome();
		const { handlers, tools } = mount();
		handlers.get("session_start")?.({ sessionId: "sess-span" }, {});
		const body = `export function kept() {\n${"x".repeat(13_000)}\n}\n`;
		handlers.get("tool_result")?.({
			toolName: "read",
			input: { path: "src/kept.ts" },
			content: [{ type: "text", text: body }],
		});
		const span = await tools.get("read_span")?.execute("1", { path: "src/kept.ts", start: 1, end: 1 });
		expect(span?.content[0]?.text).toContain("export function kept()");
		expect(span?.content[0]?.text).not.toContain("x".repeat(100));
		const root = tempDir("token-opt-span-");
		const secret = "SECRET_FILE_BODY_SHOULD_NOT_LEAK";
		writeFileSync(join(root, "kept.ts"), `${secret}\n`);
		const miss = await tools.get("read_span")?.execute("2", { path: join(root, "kept.ts"), start: 1, end: 1 });
		expect(miss?.content[0]?.text).not.toContain(secret);
	});
});

describe("tokenOpt compact command", () => {
	test("reports the outcome through omp's callbacks instead of the awaited value", async () => {
		useHome();
		const { commands } = mount();
		const messages: string[] = [];
		const ctx = {
			ui: {
				notify(message: string) {
					messages.push(message);
				},
			},
			compact: async (options: { mode: string; onComplete?: (result: unknown) => void; onError?: (error: Error) => void }) => {
				expect(options.mode).toBe("snapcompact");
				options.onComplete?.({});
			},
		};
		await commands.get("token-opt")?.("compact", ctx);
		expect(messages).toEqual(["compacted"]);

		messages.length = 0;
		await commands.get("token-opt")?.("compact", {
			...ctx,
			compact: async (options: { onError?: (error: Error) => void }) => {
				options.onError?.(new Error("model offline"));
			},
		});
		expect(messages).toEqual(["compact failed: model offline"]);

		messages.length = 0;
		await commands.get("token-opt")?.("compact", {
			...ctx,
			compact: async () => {
				throw new Error("boom");
			},
		});
		expect(messages).toEqual(["compact failed: boom"]);

		messages.length = 0;
		await commands.get("token-opt")?.("compact", { ui: ctx.ui });
		expect(messages).toEqual(["compact unavailable"]);
	});
});

describe("tokenOpt gap fixes", () => {
	test("bills an assistant message without an id once per message object", async () => {
		const home = useHome();
		const { handlers, commands } = mount();
		const message = { role: "assistant", usage: { input: 1, output: 0, cacheRead: 3, cacheWrite: 0 } };
		handlers.get("message_end")?.({ message });
		handlers.get("message_end")?.({ message });
		await statusOf(commands);
		const live = liveOf(home);
		expect(live.providerInput).toBe(1);
		expect(live.providerCacheRead).toBe(3);
	});

	test("fails open to the original bash command when rtk is not on PATH", async () => {
		const home = tempDir("token-opt-home-");
		const empty = tempDir("token-opt-empty-");
		const cwd = tempDir("token-opt-bare-");
		expect(await toolCallInChild({ home, path: empty, cwd, command: "git status" })).toBeNull();
	});

	test("rewrites a bash command through rtk when the extension is absent and rtk is on PATH", async () => {
		const home = tempDir("token-opt-home-");
		const bin = tempDir("token-opt-bin-");
		writeFileSync(
			join(bin, "rtk"),
			["#!/bin/sh", 'if [ "$1" = rewrite ]; then', '  printf "rtk fake %s\\n" "$2"', "fi", ""].join("\n"),
			{ mode: 0o755 },
		);
		const cwd = tempDir("token-opt-bare-");
		const rewritten = (await toolCallInChild({ home, path: bin, cwd, command: "git status" })) as {
			input: { command: string };
		} | null;
		expect(rewritten?.input.command).toBe("rtk fake git status");
	});

	// Bun.which reads PATH once at process start, so the rtk lookup is exercised in a child process with its own PATH.
	async function toolCallInChild(opts: { home: string; path: string; cwd: string; command: string }): Promise<unknown> {
		const indexPath = new URL("./index.ts", import.meta.url).pathname;
		const script = [
			`import tokenOpt from ${JSON.stringify(indexPath)};`,
			"(async () => {",
			"  const handlers = new Map();",
			"  tokenOpt({",
			"    setLabel() {}, zod: { object: () => ({}), string: () => ({}) }, registerTool() {}, registerCommand() {},",
			"    on(event, handler) { handlers.set(event, handler); }, events: { emit() {} },",
			"  });",
			`  const result = await handlers.get("tool_call")({ toolName: "bash", cwd: ${JSON.stringify(opts.cwd)}, input: { command: ${JSON.stringify(opts.command)} } });`,
			"  console.log(JSON.stringify(result ?? null));",
			"})();",
		].join("\n");
		const proc = Bun.spawn([process.execPath, "-e", script], {
			env: { ...process.env, HOME: opts.home, PATH: opts.path },
			stdout: "pipe",
			stderr: "pipe",
		});
		const [out, err, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		if (code !== 0) throw new Error(`child exited ${code}: ${err}`);
		return JSON.parse(out.trim());
	}
});

describe("tokenOpt graph tools", () => {
	test("a cache hit does not record a second graph saving", async () => {
		useHome();
		const root = tempDir("token-opt-graph-");
		const bin = join(root, "graphify");
		writeFileSync(bin, "#!/bin/sh\nprintf 'graphify-tokens: 100 40\\nanswer\\n'\n", { mode: 0o755 });
		setGraphifyBinForTests(bin);
		cleanups.push(() => setGraphifyBinForTests(null));
		const { tools, commands } = mount();
		const graphQuery = tools.get("graph_query");
		const ctx = { cwd: root };
		await graphQuery?.execute("first", { question: "what" }, undefined, undefined, ctx);
		await graphQuery?.execute("second", { question: "what" }, undefined, undefined, ctx);
		const status = await statusOf(commands, { cwd: root });
		expect(status.includes("saved 60")).toBe(true);
	});

	test("a failed graph query is an error result and is not booked as a savings point", async () => {
		const home = useHome();
		// Either "no graph.json" (exit 2) or "command not found" (exit 127): both are failures, never an answer.
		const root = tempDir("token-opt-nograph-");
		const { tools } = mount();
		const result = await tools.get("graph_query")?.execute("1", { question: "what" }, undefined, undefined, { cwd: root });
		expect(result?.isError).toBe(true);
		expect(result?.content[0]?.text).toContain("graphify:");
		const live = liveOf(home) as { points: unknown[]; baselineTokens: number; currentTokens: number; lastQueryMs?: number };
		expect(live.points).toEqual([]);
		expect(live.baselineTokens).toBe(0);
		expect(live.currentTokens).toBe(0);
		expect(live.lastQueryMs).toBeUndefined();
	});

	test("a ledger fault does not replace a good graph answer", async () => {
		const home = useHome();
		// A regular file where the ledger directory should be makes every ledger write fail.
		mkdirSync(join(home, ".omp", "agent"), { recursive: true });
		writeFileSync(join(home, ".omp", "agent", "token-opt"), "not a directory");
		const root = tempDir("token-opt-graph-");
		const bin = join(root, "graphify");
		writeFileSync(bin, "#!/bin/sh\nprintf 'graphify-tokens: 100 40\\nanswer\\n'\n", { mode: 0o755 });
		setGraphifyBinForTests(bin);
		cleanups.push(() => setGraphifyBinForTests(null));
		const { tools } = mount();
		const result = await tools.get("graph_query")?.execute("1", { question: "what" }, undefined, undefined, { cwd: root });
		expect(result?.isError).toBeUndefined();
		expect(result?.content[0]?.text).toContain("answer");
	});
});
