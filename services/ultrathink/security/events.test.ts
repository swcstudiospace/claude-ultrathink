// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { createLogger } from "../obs/log.ts";
import { ConsoleSecurityEventLogger, SecurityEventType, createSecurityEvent } from "./events.ts";

describe("Security events", () => {
	test("writes an auth failure through the structured logger", () => {
		const lines: string[] = [];
		const logger = new ConsoleSecurityEventLogger(createLogger({ write: (line) => lines.push(line) }));
		logger.logAuthFailure({ ip: "203.0.113.1", resource: "/login" });

		expect(lines).toHaveLength(1);
		const payload = JSON.parse(lines[0] ?? "");
		expect(payload).toMatchObject({ level: "warn", event: "security.auth_failure", type: SecurityEventType.AUTH_FAILURE, ip: "203.0.113.1" });
		expect(payload.correlationId).toMatch(/^[0-9a-f]{32}$/);
	});

	test("a named event keeps its name and drops secret-named fields", () => {
		const lines: string[] = [];
		const logger = new ConsoleSecurityEventLogger(createLogger({ write: (line) => lines.push(line) }));
		logger.log(createSecurityEvent(SecurityEventType.AUTH_FAILURE, { name: "auth.login_failed", source: "auth", severity: "medium", ip: "203.0.113.2", details: { reqId: "r1", password: "hunter2" } }));

		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0] ?? "")).toMatchObject({ event: "auth.login_failed", level: "warn", details: { reqId: "r1" } });
		expect(lines[0] ?? "").not.toContain("hunter2");
	});

	test("filters events below minimum severity", () => {
		const lines: string[] = [];
		const logger = new ConsoleSecurityEventLogger(createLogger({ write: (line) => lines.push(line) }));
		logger.setMinSeverity("critical");
		logger.logValidationFailure({ ip: "127.0.0.1" });

		expect(lines).toHaveLength(0);
	});

	test("the default writer sends each line to stderr and nothing to stdout", async () => {
		// A process that installs no writer gets the default one. Stdout carries protocol traffic in the stdio modes.
		const eventsPath = fileURLToPath(new URL("./events.ts", import.meta.url));
		// The child process loads events.ts by absolute path at run time, which a static import cannot express. That is the module-loading boundary under test.
		const probe = `(async () => {
  const { ConsoleSecurityEventLogger } = await import(${JSON.stringify(eventsPath)});
  new ConsoleSecurityEventLogger().logValidationFailure({ source: "probe", resource: "/probe", details: { field: "field", code: "PROBE" } });
})();`;
		const child = Bun.spawn([process.execPath, "-e", probe], { stdout: "pipe", stderr: "pipe" });
		const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);

		expect(exitCode).toBe(0);
		expect(stdout).toBe("");
		const lines = stderr.split("\n").filter((line) => line.startsWith("{"));
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0] ?? "")).toMatchObject({ level: "info", event: "security.validation_failure", source: "probe", details: { field: "field", code: "PROBE" } });
	}, 15_000);
});
