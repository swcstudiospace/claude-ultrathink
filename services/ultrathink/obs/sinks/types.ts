// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

/** Which stream an envelope belongs to: the audit chain, anomaly/tamper alerts, or security events. */
export type SinkKind = "audit" | "alert" | "security";

export interface SinkEnvelope {
	readonly kind: SinkKind;
	readonly at: string;
	readonly body: Record<string, unknown>;
}

export type SendResult = { ok: true } | { ok: false; retryable: boolean; reason: string };

export interface SinkTransport {
	readonly name: string;
	send(batch: readonly SinkEnvelope[], signal: AbortSignal): Promise<SendResult>;
}
