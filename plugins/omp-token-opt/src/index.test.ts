import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import tokenOpt, { PREFIX_POLICY } from "./index.ts";

describe("tokenOpt", () => {
	test("does not register before_agent_start, dedupes long results once, and skips rtk when the extension exists", async () => {
		const home = mkdtempSync(join(tmpdir(), "token-opt-home-"));
		const previousHome = process.env.HOME;
		process.env.HOME = home;
		try {
			const events: string[] = [];
			const handlers = new Map<string, (...args: unknown[]) => unknown>();
			let status = "";
			let statusHandler: ((args: string, ctx: { ui: { notify: (message: string) => void } }) => Promise<void>) | undefined;
			const pi = {
				setLabel() {},
				zod: {
					object() {
						return {};
					},
					string() {
						return {};
					},
				},
				registerTool() {},
				registerCommand(_name: string, options: { handler: NonNullable<typeof statusHandler> }) {
					statusHandler = options.handler;
				},
				on(event: string, handler: (...args: unknown[]) => unknown) {
					events.push(event);
					handlers.set(event, handler);
				},
				events: { emit() {} },
			};
			tokenOpt(pi);
			expect(PREFIX_POLICY.injectSystemPrompt).toBe(false);
			expect(events.includes("before_agent_start")).toBe(false);

			const toolResult = handlers.get("tool_result");
			expect(toolResult).toBeDefined();
			const text = "x".repeat(201);
			const first = toolResult?.({ toolName: "read", content: [{ type: "text", text }] });
			expect(first).toBeUndefined();
			const second = toolResult?.({ toolName: "read", content: [{ type: "text", text }] }) as {
				content?: Array<{ text?: string }>;
			};
			expect(second?.content?.[0]?.text).toBe("token-opt: repeated read result omitted (201 chars)");
			const short = "y".repeat(200);
			expect(toolResult?.({ toolName: "read", content: [{ type: "text", text: short }] })).toBeUndefined();
			const empty = toolResult?.({ toolName: "grep", content: [{ type: "text", text: "No matches found" }] }) as {
				content?: Array<{ text?: string }>;
			};
			expect(empty?.content?.[0]?.text).toBe("token-opt: grep empty");
			expect(toolResult?.({ toolName: "grep", content: [{ type: "text", text: "abc" }] })).toBeUndefined();
			expect(toolResult?.({ toolName: "read", content: [{ type: "text", text: short }] })).toBeUndefined();
			const toolCall = handlers.get("tool_call");
			expect(toolCall).toBeDefined();
			const proj = mkdtempSync(join(tmpdir(), "token-opt-proj-"));
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
			const bare = mkdtempSync(join(tmpdir(), "token-opt-bare-"));
			const skippedHome = await toolCall?.({ toolName: "bash", cwd: bare, input: { command: "ls -la" } });
			expect(skippedHome).toBeUndefined();

			handlers.get("turn_start")?.({});
			handlers.get("message_end")?.({
				message: {
					role: "assistant",
					id: "m1",
					durationMs: 7,
					usage: { input: 1, output: 0, cacheRead: 3, cacheWrite: 0 },
				},
			});
			await statusHandler?.("", {
				ui: {
					notify(message) {
						status = message;
					},
				},
			});
			expect(status.includes("last turn 7ms")).toBe(true);
			expect(status.includes("cache hit 75%")).toBe(true);
		} finally {
			process.env.HOME = previousHome;
		}
	});

	test("a 200-char result is not a repeat across session_start reload of a different id", () => {
		const home = mkdtempSync(join(tmpdir(), "token-opt-home-"));
		const previousHome = process.env.HOME;
		process.env.HOME = home;
		try {
			const handlers = new Map<string, (...args: unknown[]) => unknown>();
			const pi = {
				setLabel() {},
				zod: { object() { return {}; }, string() { return {}; } },
				registerTool() {},
				registerCommand() {},
				on(event: string, handler: (...args: unknown[]) => unknown) {
					handlers.set(event, handler);
				},
				events: { emit() {} },
			};
			tokenOpt(pi);
			const toolResult = handlers.get("tool_result");
			const start = handlers.get("session_start");
			const text = "z".repeat(200);
			start?.({ sessionId: "sess-a" }, {});
			expect(toolResult?.({ toolName: "read", content: [{ type: "text", text }] })).toBeUndefined();
			start?.({ sessionId: "sess-b" }, {});
			expect(toolResult?.({ toolName: "read", content: [{ type: "text", text }] })).toBeUndefined();
			const longer = "q".repeat(201);
			expect(toolResult?.({ toolName: "read", content: [{ type: "text", text: longer }] })).toBeUndefined();
			const repeated = toolResult?.({ toolName: "read", content: [{ type: "text", text: longer }] }) as {
				content?: Array<{ text?: string }>;
			};
			expect(repeated?.content?.[0]?.text).toBe("token-opt: repeated read result omitted (201 chars)");
			start?.({ sessionId: "sess-c" }, {});
			expect(toolResult?.({ toolName: "read", content: [{ type: "text", text: longer }] })).toBeUndefined();
		} finally {
			process.env.HOME = previousHome;
		}
	});

	test("skims a long read before shrink and reports graph readiness without spawning", async () => {
		const home = mkdtempSync(join(tmpdir(), "token-opt-home-"));
		const previousHome = process.env.HOME;
		process.env.HOME = home;
		try {
			const handlers = new Map<string, (...args: unknown[]) => unknown>();
			let status = "";
			let statusHandler: ((args: string, ctx: { cwd?: string; ui: { notify: (message: string) => void } }) => Promise<void>) | undefined;
			const pi = {
				setLabel() {},
				zod: { object() { return {}; }, string() { return {}; } },
				registerTool() {},
				registerCommand(name: string, options: { handler: NonNullable<typeof statusHandler> }) {
					if (name === "token-status") statusHandler = options.handler;
				},
				on(event: string, handler: (...args: unknown[]) => unknown) {
					handlers.set(event, handler);
				},
				events: { emit() {} },
			};
			tokenOpt(pi);
			handlers.get("session_start")?.({ sessionId: "sess-skim" }, {});
			const body = `export function kept() {\n${"x".repeat(13_000)}\n}\n`;
			const skimmed = handlers.get("tool_result")?.({
				toolName: "read",
				input: { path: "src/kept.ts" },
				content: [{ type: "text", text: body }],
			}) as { content?: Array<{ text?: string }> };
			expect(skimmed?.content?.[0]?.text).toContain("export function kept()");
			expect(skimmed?.content?.[0]?.text).toMatch(/token-opt: skimmed \d+ chars/);
			expect(skimmed?.content?.[0]?.text).not.toContain("x".repeat(100));
			const live = JSON.parse(readFileSync(join(home, ".omp", "agent", "token-opt", "live.json"), "utf8")) as {
				points: Array<{ source: string; saved: number }>;
			};
			expect(live.points.some((point) => point.source === "compress" && point.saved > 0)).toBe(true);
			const md = `# title\n${"y".repeat(13_000)}\n`;
			const markdown = handlers.get("tool_result")?.({
				toolName: "read",
				input: { path: "README.md" },
				content: [{ type: "text", text: md }],
			}) as { content?: Array<{ text?: string }> } | undefined;
			expect(markdown?.content?.[0]?.text ?? md).not.toContain("token-opt: skimmed");
			const root = mkdtempSync(join(tmpdir(), "token-opt-graph-"));
			await statusHandler?.("", { cwd: root, ui: { notify(message) { status = message; } } });
			expect(status.endsWith("graph missing")).toBe(true);
			mkdirSync(join(root, "graphify-out"), { recursive: true });
			writeFileSync(join(root, "graphify-out", "graph.json"), "{}\n");
			await statusHandler?.("", { cwd: root, ui: { notify(message) { status = message; } } });
			expect(status.endsWith("graph ready")).toBe(true);
			expect(handlers.get("cache_warming_decision")?.({ warmCost: 4 })).toBeUndefined();
			const warmed = JSON.parse(readFileSync(join(home, ".omp", "agent", "token-opt", "live.json"), "utf8")) as {
				lastWarmTokens?: number;
			};
			expect(warmed.lastWarmTokens).toBe(4);
		} finally {
			process.env.HOME = previousHome;
		}
	});

	test("message_end cache read does not increase savedTokens", async () => {
		const home = mkdtempSync(join(tmpdir(), "token-opt-home-"));
		const previousHome = process.env.HOME;
		process.env.HOME = home;
		try {
			const handlers = new Map<string, (...args: unknown[]) => unknown>();
			let status = "";
			let statusHandler: ((args: string, ctx: { ui: { notify: (message: string) => void } }) => Promise<void>) | undefined;
			tokenOpt({
				setLabel() {},
				zod: { object: () => ({}), string: () => ({}) },
				registerTool() {},
				registerCommand(_name: string, options: { handler: NonNullable<typeof statusHandler> }) {
					statusHandler = options.handler;
				},
				on(event: string, handler: (...args: unknown[]) => unknown) {
					handlers.set(event, handler);
				},
				events: { emit() {} },
			});
			handlers.get("message_end")?.({
				message: {
					role: "assistant",
					id: "m-cache",
					usage: { input: 1, output: 0, cacheRead: 3, cacheWrite: 0 },
				},
			});
			await statusHandler?.("", {
				ui: {
					notify(message) {
						status = message;
					},
				},
			});
			expect(status.includes("saved 0")).toBe(true);
			expect(status.includes("cache hit 75%")).toBe(true);
		} finally {
			process.env.HOME = previousHome;
		}
	});

	test("a later different system string sets prefixChanged without savings", async () => {
		const home = mkdtempSync(join(tmpdir(), "token-opt-home-"));
		const previousHome = process.env.HOME;
		process.env.HOME = home;
		try {
			const handlers = new Map<string, (...args: unknown[]) => unknown>();
			let status = "";
			let statusHandler: ((args: string, ctx: { ui: { notify: (message: string) => void } }) => Promise<void>) | undefined;
			tokenOpt({
				setLabel() {},
				zod: { object: () => ({}), string: () => ({}) },
				registerTool() {},
				registerCommand(_name: string, options: { handler: NonNullable<typeof statusHandler> }) {
					statusHandler = options.handler;
				},
				on(event: string, handler: (...args: unknown[]) => unknown) {
					handlers.set(event, handler);
				},
				events: { emit() {} },
			});
			const first = { system: "alpha", messages: [{ role: "user", content: "keep" }] };
			const second = { system: "beta", messages: [{ role: "user", content: "keep" }] };
			const before = JSON.stringify(first);
			handlers.get("before_provider_request")?.({ payload: first });
			handlers.get("before_provider_request")?.({ payload: second });
			expect(JSON.stringify(first)).toBe(before);
			await statusHandler?.("", {
				ui: {
					notify(message) {
						status = message;
					},
				},
			});
			expect(status.includes("prefix moved")).toBe(true);
			expect(status.includes("saved 0")).toBe(true);
		} finally {
			process.env.HOME = previousHome;
		}
	});

	test("session_start after a prefix change does not leave prefixChanged 1 on the new session", async () => {
		const home = mkdtempSync(join(tmpdir(), "token-opt-home-"));
		const previousHome = process.env.HOME;
		process.env.HOME = home;
		try {
			const handlers = new Map<string, (...args: unknown[]) => unknown>();
			let status = "";
			let statusHandler: ((args: string, ctx: { ui: { notify: (message: string) => void } }) => Promise<void>) | undefined;
			tokenOpt({
				setLabel() {},
				zod: { object: () => ({}), string: () => ({}) },
				registerTool() {},
				registerCommand(_name: string, options: { handler: NonNullable<typeof statusHandler> }) {
					if (_name === "token-status") statusHandler = options.handler;
				},
				on(event: string, handler: (...args: unknown[]) => unknown) {
					handlers.set(event, handler);
				},
				events: { emit() {} },
			});
			handlers.get("session_start")?.({ sessionId: "sess-prefix-a" }, {});
			handlers.get("before_provider_request")?.({ payload: { system: "alpha" } });
			handlers.get("before_provider_request")?.({ payload: { system: "beta" } });
			handlers.get("session_start")?.({ sessionId: "sess-prefix-b" }, {});
			await statusHandler?.("", {
				ui: {
					notify(message) {
						status = message;
					},
				},
			});
			expect(status.includes("prefix stable")).toBe(true);
			expect(status.includes("prefix moved")).toBe(false);
			expect(status.includes("skim archive 0")).toBe(true);
			const live = JSON.parse(readFileSync(join(home, ".omp", "agent", "token-opt", "live.json"), "utf8")) as {
				sessionId: string;
				prefixChanged?: number;
			};
			expect(live.sessionId).toBe("sess-prefix-b");
			expect(live.prefixChanged).not.toBe(1);
		} finally {
			process.env.HOME = previousHome;
		}
	});

	test("message_end without usage still bills a later usage event once", () => {
		const home = mkdtempSync(join(tmpdir(), "token-opt-home-"));
		const previousHome = process.env.HOME;
		process.env.HOME = home;
		try {
			const handlers = new Map<string, (...args: unknown[]) => unknown>();
			tokenOpt({
				setLabel() {},
				zod: { object: () => ({}), string: () => ({}) },
				registerTool() {},
				registerCommand() {},
				on(event: string, handler: (...args: unknown[]) => unknown) {
					handlers.set(event, handler);
				},
				events: { emit() {} },
			});
			handlers.get("session_start")?.({ sessionId: "sess-usage" }, {});
			const end = handlers.get("message_end");
			end?.({ message: { role: "assistant", id: "m-late", durationMs: 4 } });
			end?.({ message: { role: "assistant", id: "m-late", usage: { input: 7, output: 1, cacheRead: 0, cacheWrite: 0 } } });
			end?.({ message: { role: "assistant", id: "m-late", usage: { input: 7, output: 1, cacheRead: 0, cacheWrite: 0 } } });
			const live = JSON.parse(readFileSync(join(home, ".omp", "agent", "token-opt", "live.json"), "utf8")) as {
				providerInput?: number;
				lastTurnMs?: number;
			};
			expect(live.providerInput).toBe(7);
			expect(live.lastTurnMs).toBe(4);
		} finally {
			process.env.HOME = previousHome;
		}
	});

	test("read_span returns an archived export line and misses unknown paths without reading disk", async () => {
		const home = mkdtempSync(join(tmpdir(), "token-opt-home-"));
		const previousHome = process.env.HOME;
		process.env.HOME = home;
		try {
			const handlers = new Map<string, (...args: unknown[]) => unknown>();
			const tools = new Map<string, { execute: (id: string, params: Record<string, unknown>) => Promise<{ content: Array<{ text: string }> }> }>();
			tokenOpt({
				setLabel() {},
				zod: { object: () => ({}), string: () => ({}) },
				registerTool(tool) {
					tools.set(tool.name, tool);
				},
				registerCommand() {},
				on(event: string, handler: (...args: unknown[]) => unknown) {
					handlers.set(event, handler);
				},
				events: { emit() {} },
			});
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
			const root = mkdtempSync(join(tmpdir(), "token-opt-span-"));
			const secret = "SECRET_FILE_BODY_SHOULD_NOT_LEAK";
			writeFileSync(join(root, "kept.ts"), `${secret}\n`);
			const miss = await tools.get("read_span")?.execute("2", { path: join(root, "kept.ts"), start: 1, end: 1 });
			expect(miss?.content[0]?.text).not.toContain(secret);
		} finally {
			process.env.HOME = previousHome;
		}
	});
});
