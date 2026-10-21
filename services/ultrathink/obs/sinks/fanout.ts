// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

/**
 * Fan-out of audit, alert and security envelopes to every configured sink transport (phase 68, CONTEXT D5).
 *
 * One {@link createSinkQueue} per transport, so a slow or failing sink fills and retries only its own queue. Every
 * `audit`, `alert` and `security` call enqueues on all queues and never throws. Security events leave the process
 * with only an allowlisted set of top-level fields, so `details` (which may hold secrets) and `userAgent` never reach
 * a SIEM.
 */

import type { SecurityEvent } from "../../security/events.ts";
import type { AuditRecord } from "../audit.ts";
import { type SinkEvent, type SinkQueue, createSinkQueue } from "./queue.ts";
import type { SinkEnvelope, SinkTransport } from "./types.ts";

export type AlertKind = "audit_tamper_detected" | "anomaly_detected";

export interface AuditStreamsOptions {
	readonly transports: readonly SinkTransport[];
	/** Envelopes each sink may hold waiting; overflow drops that sink's oldest one. */
	readonly capacity: number;
	/** Receives delivery events from every sink; each event carries its sink name. */
	readonly onEvent: (event: SinkEvent) => void;
	readonly now?: () => Date;
}

export interface AuditStreams {
	audit(record: AuditRecord): void;
	alert(kind: AlertKind, body: Record<string, unknown>): void;
	security(event: SecurityEvent): void;
	/** Resolves true once every sink has delivered what it holds, false if `timeoutMs` passes or a queue is closed. */
	flush(timeoutMs: number): Promise<boolean>;
	close(): void;
}

const MAX_BATCH = 100;
const MAX_ATTEMPTS = 5;
const REQUEST_TIMEOUT_MS = 10_000;
const BACKOFF_BASE_MS = 500;
const BACKOFF_CAP_MS = 30_000;

/** The only top-level security fields that may leave the process. `details` and `userAgent` are deliberately absent. */
const SECURITY_FIELDS = [
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
] as const satisfies readonly (keyof SecurityEvent)[];

export function createAuditStreams(options: AuditStreamsOptions): AuditStreams {
	const now = options.now ?? (() => new Date());
	const queues: SinkQueue[] = options.transports.map((transport) =>
		createSinkQueue({
			transport,
			capacity: options.capacity,
			maxBatch: MAX_BATCH,
			maxAttempts: MAX_ATTEMPTS,
			backoffMs: (attempt) => Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1)),
			requestTimeoutMs: REQUEST_TIMEOUT_MS,
			onEvent: options.onEvent,
		}),
	);

	const fanOut = (envelope: SinkEnvelope): void => {
		for (const queue of queues) queue.enqueue(envelope);
	};

	return {
		audit(record: AuditRecord): void {
			fanOut({ kind: "audit", at: record.ts, body: { ...record } });
		},
		alert(kind: AlertKind, body: Record<string, unknown>): void {
			// The envelope kind is always "alert"; `event` keeps tamper and anomaly alerts distinguishable downstream.
			fanOut({ kind: "alert", at: now().toISOString(), body: { ...body, event: kind } });
		},
		security(event: SecurityEvent): void {
			const body: Record<string, unknown> = {};
			for (const field of SECURITY_FIELDS) {
				const value = event[field];
				if (value !== undefined) body[field] = value;
			}
			fanOut({ kind: "security", at: now().toISOString(), body });
		},
		async flush(timeoutMs: number): Promise<boolean> {
			const idle = await Promise.all(queues.map((queue) => queue.flush(timeoutMs)));
			return idle.every(Boolean);
		},
		close(): void {
			for (const queue of queues) queue.close();
		},
	};
}
