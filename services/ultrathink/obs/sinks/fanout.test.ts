// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { describe, expect, test } from "bun:test";
import { type SecurityEvent, SecurityEventType } from "../../security/events.ts";
import type { AuditRecord } from "../audit.ts";
import { type AuditStreams, createAuditStreams } from "./fanout.ts";
import type { SinkEvent } from "./queue.ts";
import type { SendResult, SinkEnvelope, SinkTransport } from "./types.ts";

const ZERO_HASH = "0".repeat(64);

function auditRecord(seq: number): AuditRecord {
	return {
		seq,
		ts: `2026-01-01T00:00:${String(seq).padStart(2, "0")}.000Z`,
		event: "login_ok",
		prev: ZERO_HASH,
		hash: "a".repeat(64),
		fields: { user: "alice" },
	};
}

interface Collector {
	readonly transport: SinkTransport;
	readonly delivered: SinkEnvelope[];
	/** Resolves once the collector has received at least the expected number of envelopes. */
	readonly reached: Promise<void>;
}

function collector(name: string, expected: number): Collector {
	const delivered: SinkEnvelope[] = [];
	const { promise, resolve } = Promise.withResolvers<void>();
	const transport: SinkTransport = {
		name,
		async send(batch: readonly SinkEnvelope[]): Promise<SendResult> {
			delivered.push(...batch);
			if (delivered.length >= expected) resolve();
			return { ok: true };
		},
	};
	return { transport, delivered, reached: promise };
}

function alwaysRetryableTransport(name: string): SinkTransport {
	return {
		name,
		async send(): Promise<SendResult> {
			return { ok: false, retryable: true, reason: "unavailable" };
		},
	};
}

function streamsFor(transports: SinkTransport[], onEvent: (event: SinkEvent) => void = () => undefined): AuditStreams {
	return createAuditStreams({ transports, capacity: 1000, onEvent });
}

describe("createAuditStreams delivery", () => {
	test("a sink that always fails retryably does not hold back a healthy sink", async () => {
		const healthy = collector("up", 20);
		const streams = streamsFor([alwaysRetryableTransport("down"), healthy.transport]);
		for (let seq = 1; seq <= 20; seq++) streams.audit(auditRecord(seq));

		await healthy.reached;
		expect(healthy.delivered.map((env) => env.body.seq)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
		streams.close();
	});

	test("two healthy sinks each receive every audit record in enqueue order", async () => {
		const first = collector("first", 250);
		const second = collector("second", 250);
		const streams = streamsFor([first.transport, second.transport]);
		for (let seq = 1; seq <= 250; seq++) streams.audit(auditRecord(seq));

		expect(await streams.flush(2000)).toBe(true);
		const expected = Array.from({ length: 250 }, (_, i) => i + 1);
		expect(first.delivered.map((env) => env.body.seq)).toEqual(expected);
		expect(second.delivered.map((env) => env.body.seq)).toEqual(expected);
		expect(first.delivered.every((env) => env.kind === "audit" && env.at === env.body.ts)).toBe(true);
		streams.close();
	});

	test("flush resolves true only after the batch has been delivered", async () => {
		const gate = Promise.withResolvers<void>();
		const delivered: SinkEnvelope[] = [];
		const gated: SinkTransport = {
			name: "gated",
			async send(batch: readonly SinkEnvelope[]): Promise<SendResult> {
				await gate.promise;
				delivered.push(...batch);
				return { ok: true };
			},
		};
		const streams = streamsFor([gated]);
		streams.audit(auditRecord(1));
		const flushed = streams.flush(2000);
		expect(delivered.length).toBe(0);

		gate.resolve();
		expect(await flushed).toBe(true);
		expect(delivered.map((env) => env.body.seq)).toEqual([1]);
		streams.close();
	});

	test("delivery events carry the sink name", async () => {
		const events: SinkEvent[] = [];
		const up = collector("up", 1);
		const streams = streamsFor([up.transport], (event) => events.push(event));
		streams.audit(auditRecord(1));

		expect(await streams.flush(2000)).toBe(true);
		expect(events).toContainEqual({ type: "sent", sink: "up", count: 1 });
		streams.close();
	});
});

describe("createAuditStreams envelopes", () => {
	test("security events keep only allowlisted top-level fields and never carry details or userAgent", async () => {
		const up = collector("up", 1);
		const streams = streamsFor([up.transport]);
		const event: SecurityEvent = {
			type: SecurityEventType.AUTH_FAILURE,
			name: "auth.login_failed",
			timestamp: 1767225600000,
			severity: "high",
			source: "login",
			ip: "10.0.0.1",
			userId: "alice",
			userAgent: "Mozilla/5.0 leaked-agent",
			resource: "/login",
			action: "POST",
			correlationId: "c0ffee",
			details: { password: "hunter2-secret", reason: "bad password" },
		};
		streams.security(event);

		expect(await streams.flush(2000)).toBe(true);
		expect(up.delivered).toHaveLength(1);
		const [envelope] = up.delivered;
		expect(envelope?.kind).toBe("security");
		expect(Object.keys(envelope?.body ?? {}).sort()).toEqual(
			[
				"type",
				"name",
				"severity",
				"source",
				"ip",
				"userId",
				"resource",
				"action",
				"correlationId",
				"timestamp",
			].sort(),
		);
		const serialized = JSON.stringify(up.delivered);
		expect(serialized).not.toContain("hunter2-secret");
		expect(serialized).not.toContain("leaked-agent");
		expect(serialized).not.toContain("details");
		expect(serialized).not.toContain("userAgent");
		streams.close();
	});

	test("alert envelopes have kind alert and keep the alert kind in the body", async () => {
		const up = collector("up", 2);
		const streams = streamsFor([up.transport]);
		streams.alert("anomaly_detected", { rule: "login-burst", key: "alice", count: 5 });
		streams.alert("audit_tamper_detected", { reason: "chain_broken" });

		expect(await streams.flush(2000)).toBe(true);
		expect(up.delivered.map((env) => env.kind)).toEqual(["alert", "alert"]);
		expect(up.delivered.map((env) => env.body.event)).toEqual(["anomaly_detected", "audit_tamper_detected"]);
		expect(up.delivered[0]?.body.rule).toBe("login-burst");
		streams.close();
	});
});

describe("createAuditStreams shutdown", () => {
	test("after close, later calls drop without throwing", async () => {
		const events: SinkEvent[] = [];
		const up = collector("up", 1);
		const streams = streamsFor([up.transport], (event) => events.push(event));
		streams.close();

		expect(() => streams.audit(auditRecord(1))).not.toThrow();
		expect(() => streams.alert("anomaly_detected", { rule: "late" })).not.toThrow();
		expect(() =>
			streams.security({
				type: SecurityEventType.AUTH_FAILURE,
				timestamp: 1767225600000,
				severity: "low",
				source: "login",
				details: {},
			}),
		).not.toThrow();
		expect(await streams.flush(50)).toBe(false);
		expect(up.delivered).toHaveLength(0);
		expect(events.some((event) => event.type === "dropped" && event.reason === "closed")).toBe(true);
	});

	test("close does not throw when called twice", () => {
		const streams = streamsFor([alwaysRetryableTransport("down")]);
		streams.audit(auditRecord(1));
		expect(() => {
			streams.close();
			streams.close();
		}).not.toThrow();
	});
});
