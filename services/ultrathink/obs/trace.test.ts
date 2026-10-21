// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { describe, expect, test } from "bun:test";
import { childSpan, formatTraceparent, newTraceContext, parseTraceparent, traceContextFor } from "./trace.ts";

const TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";
const SPAN = "00f067aa0ba902b7";
const VALID = `00-${TRACE}-${SPAN}-01`;
const HEX32 = /^[0-9a-f]{32}$/;
const HEX16 = /^[0-9a-f]{16}$/;

describe("parseTraceparent", () => {
	test("parses a valid sampled header", () => {
		expect(parseTraceparent(VALID)).toEqual({ traceId: TRACE, spanId: SPAN, sampled: true });
	});

	test("reads the sampled flag from bit 0 only", () => {
		expect(parseTraceparent(`00-${TRACE}-${SPAN}-00`)?.sampled).toBe(false);
		expect(parseTraceparent(`00-${TRACE}-${SPAN}-02`)?.sampled).toBe(false);
		expect(parseTraceparent(`00-${TRACE}-${SPAN}-03`)?.sampled).toBe(true);
		expect(parseTraceparent(`00-${TRACE}-${SPAN}-ff`)?.sampled).toBe(true);
	});

	test("round-trips through formatTraceparent", () => {
		const ctx = parseTraceparent(VALID);
		expect(ctx).not.toBeNull();
		expect(formatTraceparent(ctx as NonNullable<typeof ctx>)).toBe(VALID);
		const unsampled = `00-${TRACE}-${SPAN}-00`;
		expect(formatTraceparent(parseTraceparent(unsampled) as NonNullable<typeof ctx>)).toBe(unsampled);
	});

	test("returns null for missing or non-string input", () => {
		expect(parseTraceparent(null)).toBeNull();
		expect(parseTraceparent(undefined)).toBeNull();
		expect(parseTraceparent("")).toBeNull();
		expect(parseTraceparent(42 as unknown as string)).toBeNull();
	});

	test("rejects version ff", () => {
		expect(parseTraceparent(`ff-${TRACE}-${SPAN}-01`)).toBeNull();
	});

	test("accepts a future version with extra fields and ignores them", () => {
		expect(parseTraceparent(`01-${TRACE}-${SPAN}-01-extra-fields`)).toEqual({
			traceId: TRACE,
			spanId: SPAN,
			sampled: true,
		});
		expect(parseTraceparent(`cc-${TRACE}-${SPAN}-00`)?.sampled).toBe(false);
	});

	test("rejects extra fields on version 00", () => {
		expect(parseTraceparent(`${VALID}-extra`)).toBeNull();
		expect(parseTraceparent(`${VALID}-`)).toBeNull();
	});

	test("rejects too few fields", () => {
		expect(parseTraceparent(`00-${TRACE}-${SPAN}`)).toBeNull();
		expect(parseTraceparent(TRACE)).toBeNull();
	});

	test("rejects all-zero trace-id and parent-id", () => {
		expect(parseTraceparent(`00-${"0".repeat(32)}-${SPAN}-01`)).toBeNull();
		expect(parseTraceparent(`00-${TRACE}-${"0".repeat(16)}-01`)).toBeNull();
	});

	test("rejects uppercase hex in any field", () => {
		expect(parseTraceparent(`00-${TRACE.toUpperCase()}-${SPAN}-01`)).toBeNull();
		expect(parseTraceparent(`00-${TRACE}-${SPAN.toUpperCase()}-01`)).toBeNull();
		expect(parseTraceparent(`00-${TRACE}-${SPAN}-0A`)).toBeNull();
		expect(parseTraceparent(`0A-${TRACE}-${SPAN}-01`)).toBeNull();
	});

	test("rejects wrong lengths", () => {
		expect(parseTraceparent(`00-${TRACE.slice(1)}-${SPAN}-01`)).toBeNull();
		expect(parseTraceparent(`00-${TRACE}0-${SPAN}-01`)).toBeNull();
		expect(parseTraceparent(`00-${TRACE}-${SPAN.slice(1)}-01`)).toBeNull();
		expect(parseTraceparent(`00-${TRACE}-${SPAN}0-01`)).toBeNull();
		expect(parseTraceparent(`00-${TRACE}-${SPAN}-1`)).toBeNull();
		expect(parseTraceparent(`00-${TRACE}-${SPAN}-001`)).toBeNull();
		expect(parseTraceparent(`0-${TRACE}-${SPAN}-01`)).toBeNull();
		expect(parseTraceparent(`000-${TRACE}-${SPAN}-01`)).toBeNull();
	});

	test("rejects non-hex characters", () => {
		expect(parseTraceparent(`00-${TRACE.slice(0, 31)}g-${SPAN}-01`)).toBeNull();
		expect(parseTraceparent(`00-${TRACE}-${SPAN.slice(0, 15)}z-01`)).toBeNull();
		expect(parseTraceparent(`00-${TRACE}-${SPAN}-0g`)).toBeNull();
		expect(parseTraceparent(`zz-${TRACE}-${SPAN}-01`)).toBeNull();
	});

	test("rejects surrounding or embedded whitespace", () => {
		expect(parseTraceparent(` ${VALID}`)).toBeNull();
		expect(parseTraceparent(`${VALID} `)).toBeNull();
		expect(parseTraceparent(`${VALID}\n`)).toBeNull();
		expect(parseTraceparent(`00 -${TRACE}-${SPAN}-01`)).toBeNull();
		expect(parseTraceparent(`00-${TRACE}-${SPAN}- 01`)).toBeNull();
	});

	test("rejects input longer than 1024 characters", () => {
		const padded = `01-${TRACE}-${SPAN}-01-${"x".repeat(1024)}`;
		expect(padded.length).toBeGreaterThan(1024);
		expect(parseTraceparent(padded)).toBeNull();
		const atLimit = `01-${TRACE}-${SPAN}-01-${"x".repeat(1024 - VALID.length - 1)}`;
		expect(atLimit.length).toBe(1024);
		expect(parseTraceparent(atLimit)).not.toBeNull();
	});

	test("never throws on hostile input", () => {
		for (const input of ["-", "--", "---", "----", "\u0000", "00-\u0000-\u0000-\u0000", "00--".repeat(300)]) {
			expect(() => parseTraceparent(input)).not.toThrow();
			expect(parseTraceparent(input)).toBeNull();
		}
	});
});

describe("newTraceContext", () => {
	test("generates lowercase hex ids of the right lengths that are not zero", () => {
		for (let i = 0; i < 50; i++) {
			const ctx = newTraceContext();
			expect(ctx.traceId).toMatch(HEX32);
			expect(ctx.spanId).toMatch(HEX16);
			expect(ctx.traceId).not.toBe("0".repeat(32));
			expect(ctx.spanId).not.toBe("0".repeat(16));
		}
	});

	test("defaults to sampled and honours an explicit flag", () => {
		expect(newTraceContext().sampled).toBe(true);
		expect(newTraceContext(true).sampled).toBe(true);
		expect(newTraceContext(false).sampled).toBe(false);
	});

	test("produces distinct ids across calls", () => {
		const a = newTraceContext();
		const b = newTraceContext();
		expect(a.traceId).not.toBe(b.traceId);
		expect(a.spanId).not.toBe(b.spanId);
	});

	test("generated contexts parse back from their own header", () => {
		const ctx = newTraceContext(false);
		expect(parseTraceparent(formatTraceparent(ctx))).toEqual(ctx);
	});
});

describe("childSpan", () => {
	test("keeps traceId and sampled, replaces spanId, does not mutate the parent", () => {
		const parent = { traceId: TRACE, spanId: SPAN, sampled: true };
		const snapshot = { ...parent };
		const child = childSpan(parent);
		expect(child.traceId).toBe(TRACE);
		expect(child.sampled).toBe(true);
		expect(child.spanId).toMatch(HEX16);
		expect(child.spanId).not.toBe(SPAN);
		expect(child).not.toBe(parent);
		expect(parent).toEqual(snapshot);
	});

	test("preserves an unsampled flag", () => {
		expect(childSpan({ traceId: TRACE, spanId: SPAN, sampled: false }).sampled).toBe(false);
	});
});

describe("formatTraceparent", () => {
	test("renders version 00 with the sampled flag as 01 or 00", () => {
		expect(formatTraceparent({ traceId: TRACE, spanId: SPAN, sampled: true })).toBe(VALID);
		expect(formatTraceparent({ traceId: TRACE, spanId: SPAN, sampled: false })).toBe(`00-${TRACE}-${SPAN}-00`);
	});
});

describe("traceContextFor", () => {
	test("inherits a valid inbound header verbatim", () => {
		const { ctx, inherited } = traceContextFor(VALID);
		expect(inherited).toBe(true);
		expect(ctx).toEqual({ traceId: TRACE, spanId: SPAN, sampled: true });
	});

	test("inherits an unsampled header without flipping the flag", () => {
		const { ctx, inherited } = traceContextFor(`00-${TRACE}-${SPAN}-00`);
		expect(inherited).toBe(true);
		expect(ctx.sampled).toBe(false);
	});

	test("starts a fresh sampled trace when the header is missing", () => {
		for (const header of [null, undefined, ""]) {
			const { ctx, inherited } = traceContextFor(header);
			expect(inherited).toBe(false);
			expect(ctx.traceId).toMatch(HEX32);
			expect(ctx.spanId).toMatch(HEX16);
			expect(ctx.sampled).toBe(true);
		}
	});

	test("starts a fresh trace when the header is malformed", () => {
		const { ctx, inherited } = traceContextFor(`00-${TRACE.toUpperCase()}-${SPAN}-01`);
		expect(inherited).toBe(false);
		expect(ctx.traceId).not.toBe(TRACE.toLowerCase());
		expect(ctx.traceId).toMatch(HEX32);
	});
});
