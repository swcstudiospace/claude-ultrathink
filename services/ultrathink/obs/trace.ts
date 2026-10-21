// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

// W3C Trace Context (Level 2) propagation for the `traceparent` header.
// Spec: https://www.w3.org/TR/trace-context-2/
//
// Only `traceparent` is handled. `tracestate` (vendor-specific key/value
// pairs, spec section "tracestate Header") is intentionally not parsed or
// propagated: this service never emits vendor state of its own and must not
// forward opaque third-party state to upstreams it calls on the client's behalf.

import { randomBytes } from "node:crypto";

/** A parsed or generated trace context (spec section "traceparent Header Field Values"). */
export interface TraceContext {
	/** 32 lowercase hex chars, never all zeros (spec "trace-id"). */
	traceId: string;
	/** 16 lowercase hex chars, never all zeros; the id of the current span (spec "parent-id"). */
	spanId: string;
	/** Sampled flag, bit 0 of `trace-flags` (spec "Sampled flag"). */
	sampled: boolean;
}

/** Maximum header length we will attempt to parse; longer input is rejected outright. */
const MAX_HEADER_LENGTH = 1024;
const TRACE_ID_LENGTH = 32;
const SPAN_ID_LENGTH = 16;
const FLAG_SAMPLED = 0x01;
const VERSION_INVALID = "ff";
const VERSION_CURRENT = "00";

const ZERO_TRACE_ID = "0".repeat(TRACE_ID_LENGTH);
const ZERO_SPAN_ID = "0".repeat(SPAN_ID_LENGTH);

/** Strict lowercase hex of an exact length (spec requires lowercase; uppercase is invalid). */
function isLowerHex(value: string, length: number): boolean {
	if (value.length !== length) return false;
	for (let i = 0; i < length; i++) {
		const c = value.charCodeAt(i);
		const digit = c >= 0x30 && c <= 0x39;
		const lower = c >= 0x61 && c <= 0x66;
		if (!digit && !lower) return false;
	}
	return true;
}

/**
 * Parse a `traceparent` header (spec section "traceparent Header").
 *
 * Accepts `version-trace-id-parent-id-trace-flags` where version is two hex
 * chars. Version `00` must have exactly four fields. A future version (anything
 * other than `00` and `ff`) is accepted when the first four fields parse, and
 * any additional `-`-separated fields are ignored (spec "Versioning of
 * traceparent"). Version `ff` is forbidden by the spec and rejected.
 *
 * Returns `null` for anything invalid: wrong field count, uppercase or
 * non-hex characters, wrong lengths, all-zero trace-id or parent-id,
 * surrounding whitespace, or input longer than 1024 characters. Never throws;
 * non-string input is treated as absent.
 */
export function parseTraceparent(header: string | null | undefined): TraceContext | null {
	if (typeof header !== "string") return null;
	if (header.length === 0 || header.length > MAX_HEADER_LENGTH) return null;

	const parts = header.split("-");
	if (parts.length < 4) return null;
	const [version, traceId, spanId, flags] = parts as [string, string, string, string];

	if (!isLowerHex(version, 2) || version === VERSION_INVALID) return null;
	if (version === VERSION_CURRENT && parts.length !== 4) return null;

	if (!isLowerHex(traceId, TRACE_ID_LENGTH) || traceId === ZERO_TRACE_ID) return null;
	if (!isLowerHex(spanId, SPAN_ID_LENGTH) || spanId === ZERO_SPAN_ID) return null;
	if (!isLowerHex(flags, 2)) return null;

	const sampled = (Number.parseInt(flags, 16) & FLAG_SAMPLED) === FLAG_SAMPLED;
	return { traceId, spanId, sampled };
}

/** Random lowercase hex of `bytes` bytes, retried in the (astronomically unlikely) all-zero case. */
function randomHex(bytes: number): string {
	for (;;) {
		const hex = randomBytes(bytes).toString("hex");
		if (hex !== ZERO_TRACE_ID && hex !== ZERO_SPAN_ID) return hex;
	}
}

/**
 * Start a brand-new trace: a random 16-byte trace-id and 8-byte span-id from
 * `crypto.randomBytes` (spec "Considerations for trace-id field generation"
 * recommends random ids). `sampled` defaults to `true` so the service's own
 * requests are recorded by downstream collectors.
 */
export function newTraceContext(sampled = true): TraceContext {
	return { traceId: randomHex(TRACE_ID_LENGTH / 2), spanId: randomHex(SPAN_ID_LENGTH / 2), sampled };
}

/**
 * Derive a child span: same trace-id and sampled flag, fresh random span-id
 * (spec "Mutating the traceparent Field" — a participant that starts a new
 * span updates parent-id and keeps trace-id). Does not mutate `ctx`.
 */
export function childSpan(ctx: TraceContext): TraceContext {
	return { traceId: ctx.traceId, spanId: randomHex(SPAN_ID_LENGTH / 2), sampled: ctx.sampled };
}

/**
 * Render a context as a version-`00` `traceparent` value:
 * `00-<traceId>-<spanId>-01` when sampled, `-00` otherwise. Any flag bits other
 * than sampled are dropped (spec: unknown flags must not be forwarded as set).
 * Assumes `ctx` came from this module; it does not re-validate the ids.
 */
export function formatTraceparent(ctx: TraceContext): string {
	return `${VERSION_CURRENT}-${ctx.traceId}-${ctx.spanId}-${ctx.sampled ? "01" : "00"}`;
}

/**
 * Resolve the trace context for an inbound request: the caller's context
 * exactly as sent when `traceparent` is valid (`inherited: true`), else a new
 * sampled trace (`inherited: false`). An invalid header is treated the same as
 * a missing one (spec "Processing Model for Working with Trace Context":
 * restart the trace on invalid input). The returned context is the *parent*;
 * call `childSpan` before forwarding `traceparent` upstream so the service's
 * own work gets its own span-id. Never throws.
 */
export function traceContextFor(header: string | null | undefined): { ctx: TraceContext; inherited: boolean } {
	const parent = parseTraceparent(header);
	if (parent === null) return { ctx: newTraceContext(true), inherited: false };
	return { ctx: parent, inherited: true };
}
