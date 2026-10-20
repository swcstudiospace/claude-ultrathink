// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test, mock, afterEach } from "bun:test";
import { ConsoleSecurityEventLogger, SecurityEventType } from "./events.ts";

describe("Security events", () => {
	afterEach(() => {
		mock.restore();
	});

	test("logs auth failure with structured fields", () => {
		const spy = mock(() => {});
		const original = console.log;
		console.log = spy;

		const logger = new ConsoleSecurityEventLogger();
		logger.logAuthFailure({ ip: "203.0.113.1", resource: "/login" });

		expect(spy).toHaveBeenCalled();
		const logged = (spy.mock.calls as unknown as unknown[][])[0]?.[0];
		expect(logged).toBeDefined();
		const payload = JSON.parse(String(logged));
		expect(payload.type).toBe(SecurityEventType.AUTH_FAILURE);
		expect(payload.ip).toBe("203.0.113.1");
		expect(payload.correlationId).toMatch(/^[0-9a-f]{32}$/);

		console.log = original;
	});

	test("filters events below minimum severity", () => {
		const spy = mock(() => {});
		const original = console.log;
		console.log = spy;

		const logger = new ConsoleSecurityEventLogger();
		logger.setMinSeverity("critical");
		logger.logValidationFailure({ ip: "127.0.0.1" });

		expect(spy).not.toHaveBeenCalled();

		console.log = original;
	});
});
