// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpToolHost } from "../mcp/mcp.ts";
import { createLogger } from "../obs/log.ts";
import { createStdioHost, logLevelFrom, resolveConnectorStateDir } from "./main.ts";
import { serveStdio } from "./server.ts";

type Json = Record<string, unknown>;
type Chunk = string | Uint8Array;

const dirs: string[] = [];
afterAll(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tmp(): string {
	const dir = mkdtempSync(join(tmpdir(), "ultrathink-stdio-"));
	dirs.push(dir);
	return dir;
}

const encoder = new TextEncoder();

async function* chunked(items: readonly Chunk[]): AsyncGenerator<Chunk> {
	for (const item of items) yield item;
}

const silent = createLogger({ write: () => undefined });

function realHost(): McpToolHost {
	return createStdioHost(tmp(), silent);
}

/** Feeds `items` to the loop and returns the lines it wrote, each checked to be one JSON document. */
async function run(host: McpToolHost, items: readonly Chunk[], maxLineBytes?: number): Promise<Json[]> {
	const lines: string[] = [];
	await serveStdio({
		host,
		input: chunked(items),
		write: (line) => {
			lines.push(line);
		},
		...(maxLineBytes === undefined ? {} : { maxLineBytes }),
	});
	return lines.map((line) => {
		expect(line).not.toContain("\n");
		return JSON.parse(line);
	});
}

function request(id: number, method: string, params?: Json): string {
	return JSON.stringify({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
}

/** `value[keys[0]][keys[1]]...`, undefined where the path breaks off. */
function at(value: unknown, ...keys: string[]): unknown {
	return keys.reduce((current, key) => (current === undefined || current === null ? undefined : Reflect.get(Object(current), key)), value);
}

function errorOf(reply: Json | undefined): { code: unknown } {
	return { code: at(reply, "error", "code") };
}

describe("framing", () => {
	test("answers each line in order, one line per reply, and nothing for a notification", async () => {
		const replies = await run(realHost(), [
			`${request(1, "ping")}\n`,
			`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
			`${request(2, "ping")}\n`,
		]);
		expect(replies.map((reply) => reply.id)).toEqual([1, 2]);
		expect(replies[0]).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
	});

	test("tolerates CRLF and blank lines", async () => {
		const replies = await run(realHost(), [`\r\n${request(1, "ping")}\r\n\n  \n${request(2, "ping")}\r\n`]);
		expect(replies.map((reply) => reply.id)).toEqual([1, 2]);
	});

	test("joins a line split across chunks and a multi-byte character split inside a chunk boundary", async () => {
		const bytes = encoder.encode(`${request(1, "tools/call", { name: "ultrathink_status", arguments: { sessionId: "é" } })}\n`);
		const cut = bytes.indexOf(0xc3) + 1;
		const replies = await run(realHost(), [bytes.subarray(0, 10), bytes.subarray(10, cut), bytes.subarray(cut)]);
		expect(replies).toHaveLength(1);
		expect(replies[0]?.id).toBe(1);
		expect(replies[0]?.error).toBeUndefined();
	});

	test("handles several lines in one chunk and a final line without a newline", async () => {
		const replies = await run(realHost(), [`${request(1, "ping")}\n${request(2, "ping")}\n${request(3, "ping")}`]);
		expect(replies.map((reply) => reply.id)).toEqual([1, 2, 3]);
	});

	test("answers a line that is not JSON with -32700 and id null, then keeps serving", async () => {
		const replies = await run(realHost(), ["not json\n", `${request(1, "ping")}\n`]);
		expect(replies[0]).toMatchObject({ jsonrpc: "2.0", id: null });
		expect(errorOf(replies[0]).code).toBe(-32700);
		expect(replies[1]?.id).toBe(1);
	});

	test("answers an unknown method with -32601", async () => {
		const [reply] = await run(realHost(), [`${request(1, "nope/never")}\n`]);
		expect(errorOf(reply).code).toBe(-32601);
	});
});

describe("line guard", () => {
	test("refuses a line over the limit with -32600 and discards the rest of it", async () => {
		const huge = `${request(1, "ping")}${" ".repeat(200)}`;
		const replies = await run(realHost(), [`${huge}\n${request(2, "ping")}\n`], 64);
		expect(replies).toHaveLength(2);
		expect(errorOf(replies[0]).code).toBe(-32600);
		expect(replies[0]?.id).toBeNull();
		expect(replies[1]?.id).toBe(2);
	});

	test("refuses a line that grows over the limit across chunks, once, and resumes after its newline", async () => {
		const replies = await run(realHost(), ["a".repeat(40), "b".repeat(40), "c".repeat(40), `\n${request(2, "ping")}\n`], 64);
		expect(replies.map((reply) => (reply.error === undefined ? "ok" : errorOf(reply).code))).toEqual([-32600, "ok"]);
		expect(replies[1]?.id).toBe(2);
	});

	test("accepts a line exactly at the limit", async () => {
		const line = request(1, "ping");
		const replies = await run(realHost(), [`${line}\n`], encoder.encode(line).length);
		expect(replies[0]?.id).toBe(1);
		expect(replies[0]?.error).toBeUndefined();
	});

	test("the limit counts bytes, not characters", async () => {
		const padded = `${request(1, "ping")}${"é".repeat(40)}`;
		const replies = await run(realHost(), [`${padded}\n`], padded.length + 10);
		expect(errorOf(replies[0]).code).toBe(-32600);
	});
});

describe("protocol version", () => {
	const batch = JSON.stringify([JSON.parse(request(10, "ping")), JSON.parse(request(11, "ping"))]);

	test("a batch is handled before any initialize", async () => {
		const replies = await run(realHost(), [`${batch}\n`]);
		expect(Array.isArray(replies[0])).toBe(true);
	});

	test("the version initialize settled on is applied to later messages", async () => {
		const modern = await run(realHost(), [`${request(1, "initialize", { protocolVersion: "2025-06-18" })}\n`, `${batch}\n`]);
		expect(at(modern[0], "result", "protocolVersion")).toBe("2025-06-18");
		expect(errorOf(modern[1]).code).toBe(-32600);

		const legacy = await run(realHost(), [`${request(1, "initialize", { protocolVersion: "2025-03-26" })}\n`, `${batch}\n`]);
		expect(Array.isArray(legacy[1])).toBe(true);
	});

	test("an unsupported requested version negotiates the newest and remembers that", async () => {
		const replies = await run(realHost(), [`${request(1, "initialize", { protocolVersion: "1999-01-01" })}\n`, `${batch}\n`]);
		const settled = at(replies[0], "result", "protocolVersion");
		expect(settled).toBe("2025-11-25");
		expect(errorOf(replies[1]).code).toBe(-32600);
	});
});

describe("failures", () => {
	test("a throwing handler becomes -32603 with the request id and without the thrown message", async () => {
		const host: McpToolHost = {
			call() {
				throw new Error("boom-secret-detail");
			},
		};
		const lines: string[] = [];
		await serveStdio({
			host,
			input: chunked([`${request(7, "tools/call", { name: "ultrathink_status", arguments: {} })}\n`, `${request(8, "ping")}\n`]),
			write: (line) => {
				lines.push(line);
			},
		});
		expect(lines.join("\n")).not.toContain("boom-secret-detail");
		const replies = lines.map((line) => JSON.parse(line) as Json);
		expect(replies[0]?.id).toBe(7);
		expect(errorOf(replies[0]).code).toBe(-32603);
		expect(replies[1]?.id).toBe(8);
	});

	test("a failing writer's error reaches the caller", async () => {
		await expect(
			serveStdio({
				host: realHost(),
				input: chunked([`${request(1, "ping")}\n`]),
				write: () => Promise.reject(new Error("closed")),
			}),
		).rejects.toThrow("closed");
	});

	test("never logs a request body", async () => {
		const logged: string[] = [];
		const logger = createLogger({ write: (line) => logged.push(line), level: "info" });
		const host = createStdioHost(tmp(), logger);
		await serveStdio({
			host,
			logger,
			input: chunked(["{not json with a secret-marker\n", `${request(1, "tools/call", { name: "ultrathink_answer", arguments: { sessionId: "secret-marker", key: "k", answer: "secret-marker answer" } })}\n`]),
			write: () => undefined,
		});
		expect(logged.length).toBeGreaterThan(0);
		expect(logged.join("\n")).not.toContain("secret-marker");
	});
});

describe("shutdown", () => {
	test("ending the input finishes the loop", async () => {
		await expect(run(realHost(), [])).resolves.toEqual([]);
	});

	test("an abort stops a loop that is waiting for input", async () => {
		const controller = new AbortController();
		const silentInput: AsyncIterable<Chunk> = {
			[Symbol.asyncIterator]: () => ({ next: () => new Promise<IteratorResult<Chunk>>(() => undefined) }),
		};
		const done = serveStdio({ host: realHost(), input: silentInput, write: () => undefined, signal: controller.signal });
		controller.abort();
		await done;
	});

	test("an abort lets the message being handled finish and stops before the next", async () => {
		const controller = new AbortController();
		const lines: string[] = [];
		await serveStdio({
			host: realHost(),
			input: chunked([`${request(1, "ping")}\n${request(2, "ping")}\n`]),
			write: (line) => {
				lines.push(line);
				controller.abort();
			},
			signal: controller.signal,
		});
		expect(lines).toHaveLength(1);
	});
});

describe("the stdio host", () => {
	test("serves the client-driven surface: nine tools, no ultrathink_uplift", async () => {
		const [reply] = await run(realHost(), [`${request(1, "tools/list")}\n`]);
		const names = Array.from(Object(at(reply, "result", "tools")), (tool) => at(tool, "name"));
		expect(names).toHaveLength(9);
		expect(names).not.toContain("ultrathink_uplift");
	});

	test("refuses ultrathink_uplift when called, at the protocol and at the host", async () => {
		const [reply] = await run(realHost(), [`${request(1, "tools/call", { name: "ultrathink_uplift", arguments: { prompt: "x" } })}\n`]);
		expect(errorOf(reply).code).toBe(-32602);
		expect(await realHost().call("ultrathink_uplift", { prompt: "x" })).toEqual({ ok: false, code: "disabled" });
	});

	test("announces no server planning", () => {
		expect(realHost().capabilities?.()).toEqual({ serverPlanning: false });
	});
});

describe("environment", () => {
	test("ULTRATHINK_STATE_DIR wins unless it points into a planning tree", () => {
		const base = { CLAUDE_CONFIG_DIR: join("cfg", "claude") };
		expect(resolveConnectorStateDir({ ...base, ULTRATHINK_STATE_DIR: join("work", "state") })).toBe(join("work", "state"));
		const fallback = join("cfg", "claude", "ultrathink", "connector");
		expect(resolveConnectorStateDir(base)).toBe(fallback);
		expect(resolveConnectorStateDir({ ...base, ULTRATHINK_STATE_DIR: "  " })).toBe(fallback);
		expect(resolveConnectorStateDir({ ...base, ULTRATHINK_STATE_DIR: "/repo/.planning/state" })).toBe(fallback);
	});

	test("the log level defaults to warn and accepts info, warn and error", () => {
		expect(logLevelFrom({})).toBe("warn");
		expect(logLevelFrom({ ULTRATHINK_LOG_LEVEL: "INFO" })).toBe("info");
		expect(logLevelFrom({ ULTRATHINK_LOG_LEVEL: "error" })).toBe("error");
		expect(logLevelFrom({ ULTRATHINK_LOG_LEVEL: "verbose" })).toBe("warn");
	});
});
