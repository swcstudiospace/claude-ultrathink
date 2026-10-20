// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
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
});
