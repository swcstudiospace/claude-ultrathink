// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { describe, expect, test } from "bun:test";
import { runWithRequestContext } from "./context.ts";
import { createLogger, newRequestId, sanitizeRequestId } from "./log.ts";

function capture(opts: Parameters<typeof createLogger>[0] = {}) {
	const lines: string[] = [];
	const logger = createLogger({ now: () => Date.UTC(2026, 0, 2, 3, 4, 5, 678), ...opts, write: (l) => lines.push(l) });
	const parsed = () => lines.map((l) => JSON.parse(l) as Record<string, unknown>);
	return { logger, lines, parsed };
}

describe("createLogger", () => {
	test("writes one JSON object per line with ts, level, event and fields", () => {
		const { logger, lines, parsed } = capture();
		logger.info("http.request", { status: 200, path: "/mcp", ok: true });
		logger.warn("slow", { ms: 12 });
		expect(lines).toHaveLength(2);
		for (const line of lines) expect(line.includes("\n")).toBe(false);
		expect(parsed()[0]).toEqual({
			ts: "2026-01-02T03:04:05.678Z",
			level: "info",
			event: "http.request",
			status: 200,
			path: "/mcp",
			ok: true,
		});
		expect(parsed()[1]?.level).toBe("warn");
	});

	test("works without fields", () => {
		const { logger, parsed } = capture();
		logger.error("boom");
		expect(parsed()[0]).toMatchObject({ level: "error", event: "boom" });
	});

	test("fields cannot overwrite ts, level or event", () => {
		const { logger, parsed } = capture();
		logger.info("real", { ts: "x", level: "debug", event: "fake" });
		expect(parsed()[0]).toMatchObject({ ts: "2026-01-02T03:04:05.678Z", level: "info", event: "real" });
	});

	test("drops secret-looking keys at the top level case-insensitively", () => {
		const { logger, lines, parsed } = capture();
		logger.info("auth", {
			Authorization: "Bearer fake-value",
			"x-connector-key": "fake-value",
			X_API_KEY: "fake-value",
			"api-key": "fake-value",
			apiKey: "fake-value",
			Cookie: "fake-value",
			password: "fake-value",
			clientSecret: "fake-value",
			access_token: "fake-value",
			keep: "visible",
		});
		expect(parsed()[0]).toMatchObject({ keep: "visible" });
		expect(lines[0]).not.toContain("fake-value");
		expect(Object.keys(parsed()[0] ?? {}).sort()).toEqual(["event", "keep", "level", "ts"]);
	});

	test("drops secret-looking keys one level down", () => {
		const { logger, lines, parsed } = capture();
		logger.info("req", {
			headers: { Authorization: "Bearer fake-value", "X-Connector-Key": "fake-value", accept: "text/plain" },
			list: [{ token: "fake-value", id: 1 }],
		});
		expect(lines[0]).not.toContain("fake-value");
		expect(parsed()[0]?.headers).toEqual({ accept: "text/plain" });
		expect(parsed()[0]?.list).toEqual([{ id: 1 }]);
	});

	test("truncates strings over 512 characters and keeps shorter ones intact", () => {
		const { logger, parsed } = capture();
		const exact = "a".repeat(512);
		logger.info("big", { long: "b".repeat(5000), exact, nested: { long: "c".repeat(600) } });
		const out = parsed()[0] as { long: string; exact: string; nested: { long: string } };
		expect(out.exact).toBe(exact);
		expect(out.long.length).toBeLessThanOrEqual(512);
		expect(out.long.length).toBeLessThan(5000);
		expect(out.long.startsWith("bbbb")).toBe(true);
		expect(out.nested.long.length).toBeLessThanOrEqual(512);
	});

	test("serializes Error as name and message without a stack by default", () => {
		const { logger, lines, parsed } = capture();
		const err = new TypeError("bad input");
		logger.error("fail", { err });
		expect(parsed()[0]?.err).toEqual({ name: "TypeError", message: "bad input" });
		expect(lines[0]).not.toContain("stack");
	});

	test("includes the stack only when fields.stack is explicitly true", () => {
		const { logger, parsed } = capture();
		const err = new Error("with stack");
		logger.error("fail", { err, stack: true });
		logger.error("fail", { err, stack: "yes" });
		const [withStack, without] = parsed() as Array<{ err: Record<string, unknown> }>;
		expect(typeof withStack?.err.stack).toBe("string");
		expect(without?.err.stack).toBeUndefined();
	});

	test("filters by level", () => {
		const warn = capture({ level: "warn" });
		warn.logger.info("a");
		warn.logger.warn("b");
		warn.logger.error("c");
		expect(warn.parsed().map((l) => l.event)).toEqual(["b", "c"]);

		const error = capture({ level: "error" });
		error.logger.info("a");
		error.logger.warn("b");
		error.logger.error("c");
		expect(error.parsed().map((l) => l.event)).toEqual(["c"]);

		const info = capture();
		info.logger.info("a");
		expect(info.lines).toHaveLength(1);
	});

	test("never throws on circular references, BigInt, odd values or a throwing getter", () => {
		const { logger, parsed, lines } = capture();
		const circular: Record<string, unknown> = { name: "loop" };
		circular.self = circular;
		const hostile = {
			get boom(): string {
				throw new Error("getter");
			},
			ok: 1,
		};
		expect(() =>
			logger.info("odd", {
				circular,
				big: 10n ** 30n,
				nan: Number.NaN,
				fn: () => 1,
				sym: Symbol("s"),
				hostile,
				undef: undefined,
				date: new Date(Number.NaN),
			}),
		).not.toThrow();
		expect(lines).toHaveLength(1);
		const out = parsed()[0] as Record<string, unknown>;
		expect(out.big).toBe("1000000000000000000000000000000");
		expect(out.undef).toBeUndefined();
		expect((out.circular as Record<string, unknown>).name).toBe("loop");
		expect(JSON.stringify(out.circular)).toContain("circular");
	});

	test("never throws when the writer or the clock fails", () => {
		const throwingWrite = createLogger({
			write: () => {
				throw new Error("disk full");
			},
		});
		expect(() => throwingWrite.error("x", { a: 1 })).not.toThrow();

		const lines: string[] = [];
		const badClock = createLogger({
			now: () => Number.NaN,
			write: (l) => lines.push(l),
		});
		expect(() => badClock.info("x")).not.toThrow();
		expect(typeof (JSON.parse(lines[0] ?? "{}") as { ts: string }).ts).toBe("string");
	});
});

describe("sanitizeRequestId", () => {
	test("accepts 1 to 64 characters of [A-Za-z0-9._-]", () => {
		expect(sanitizeRequestId("abc")).toBe("abc");
		expect(sanitizeRequestId("a.b_c-D9")).toBe("a.b_c-D9");
		expect(sanitizeRequestId("x".repeat(64))).toBe("x".repeat(64));
		expect(sanitizeRequestId("3f1c2d7e-8a49-4f6e-9b1d-0c5e7a2b4d66")).not.toBeNull();
	});

	test("rejects null, empty, too long and unsafe shapes", () => {
		expect(sanitizeRequestId(null)).toBeNull();
		expect(sanitizeRequestId("")).toBeNull();
		expect(sanitizeRequestId("x".repeat(65))).toBeNull();
		expect(sanitizeRequestId("has space")).toBeNull();
		expect(sanitizeRequestId("line\nbreak")).toBeNull();
		expect(sanitizeRequestId("trailing\n")).toBeNull();
		expect(sanitizeRequestId("a/b")).toBeNull();
		expect(sanitizeRequestId('quo"te')).toBeNull();
		expect(sanitizeRequestId("caf\u00e9")).toBeNull();
	});
});

describe("newRequestId", () => {
	test("is unique and passes sanitizeRequestId", () => {
		const ids = new Set<string>();
		for (let i = 0; i < 500; i++) {
			const id = newRequestId();
			expect(sanitizeRequestId(id)).toBe(id);
			ids.add(id);
		}
		expect(ids.size).toBe(500);
	});
});

describe("request context", () => {
	const CTX = { reqId: "req-log-1", traceId: "4bf92f3577b34da6a3ce929d0e0e4736", spanId: "00f067aa0ba902b7" };

	test("a line emitted inside a request carries its reqId and traceId", () => {
		const { logger, parsed } = capture();
		runWithRequestContext(CTX, () => logger.info("planner.start", { status: 200 }));
		expect(parsed()[0]).toMatchObject({
			event: "planner.start",
			status: 200,
			reqId: CTX.reqId,
			traceId: CTX.traceId,
		});
	});

	test("a traceId the caller supplies is not overwritten", () => {
		const { logger, parsed } = capture();
		runWithRequestContext(CTX, () => logger.info("upstream", { traceId: "caller-trace" }));
		expect(parsed()[0]).toMatchObject({ traceId: "caller-trace", reqId: CTX.reqId });
	});

	test("a reqId the caller supplies is not overwritten", () => {
		const { logger, parsed } = capture();
		runWithRequestContext(CTX, () => logger.info("upstream", { reqId: "caller-req" }));
		expect(parsed()[0]).toMatchObject({ reqId: "caller-req", traceId: CTX.traceId });
	});

	test("a line outside a request has neither key", () => {
		const { logger, parsed } = capture();
		logger.info("boot");
		expect(parsed()[0]).not.toHaveProperty("reqId");
		expect(parsed()[0]).not.toHaveProperty("traceId");
	});
});
