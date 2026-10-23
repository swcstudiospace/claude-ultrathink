// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { randomUUID } from "node:crypto";
import { currentRequestContext } from "./context.ts";

export type LogLevel = "info" | "warn" | "error";

export interface Logger {
	info(event: string, fields?: Record<string, unknown>): void;
	warn(event: string, fields?: Record<string, unknown>): void;
	error(event: string, fields?: Record<string, unknown>): void;
}

export interface LoggerOptions {
	/** Receives one JSON object per call, without a trailing newline. Defaults to stdout. */
	write?: (line: string) => void;
	now?: () => number;
	level?: LogLevel;
}

const RANK: Record<LogLevel, number> = { info: 0, warn: 1, error: 2 };
const SECRET_KEY = /secret|password|token|authorization|api[-_]?key|cookie|connector/i;
const MAX_STRING = 512;
const MAX_DEPTH = 3;
const MAX_ARRAY = 50;
const MAX_KEYS = 50;
const REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/;

function clip(value: string): string {
	return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING - 1)}\u2026` : value;
}

function serializeError(err: Error, withStack: boolean): Record<string, unknown> {
	const out: Record<string, unknown> = { name: clip(String(err.name)), message: clip(String(err.message)) };
	if (withStack && typeof err.stack === "string") out.stack = clip(err.stack);
	return out;
}

function serialize(value: unknown, depth: number, seen: WeakSet<object>, withStack: boolean): unknown {
	switch (typeof value) {
		case "string":
			return clip(value);
		case "number":
			return Number.isFinite(value) ? value : String(value);
		case "boolean":
			return value;
		case "bigint":
			return value.toString();
		case "undefined":
			return undefined;
		case "symbol":
		case "function":
			return `[${typeof value}]`;
	}
	if (value === null) return null;
	const obj = value as object;
	if (obj instanceof Error) return serializeError(obj, withStack);
	if (obj instanceof Date) return Number.isNaN(obj.getTime()) ? "[invalid date]" : obj.toISOString();
	if (seen.has(obj)) return "[circular]";
	if (depth >= MAX_DEPTH) return "[truncated]";
	seen.add(obj);
	try {
		if (Array.isArray(obj)) {
			const out: unknown[] = [];
			for (const item of obj.slice(0, MAX_ARRAY)) out.push(serialize(item, depth + 1, seen, withStack) ?? null);
			if (obj.length > MAX_ARRAY) out.push(`[${obj.length - MAX_ARRAY} more]`);
			return out;
		}
		return serializeFields(obj as Record<string, unknown>, depth + 1, seen, withStack);
	} finally {
		seen.delete(obj);
	}
}

function serializeFields(
	fields: Record<string, unknown>,
	depth: number,
	seen: WeakSet<object>,
	withStack: boolean,
): Record<string, unknown> {
	const out: Record<string, unknown> = {};
	let kept = 0;
	for (const key of Object.keys(fields)) {
		if (SECRET_KEY.test(key)) continue;
		if (kept >= MAX_KEYS) break;
		let raw: unknown;
		try {
			raw = fields[key];
		} catch {
			raw = "[unreadable]";
		}
		const value = serialize(raw, depth, seen, withStack);
		if (value === undefined) continue;
		out[clip(key)] = value;
		kept += 1;
	}
	return out;
}

function stamp(now: () => number): string {
	try {
		return new Date(now()).toISOString();
	} catch {
		return new Date().toISOString();
	}
}

export function createLogger(opts: LoggerOptions = {}): Logger {
	const write = opts.write ?? ((line: string) => void process.stdout.write(`${line}\n`));
	const now = opts.now ?? Date.now;
	const threshold = RANK[opts.level ?? "info"];

	function emit(level: LogLevel, event: string, fields?: Record<string, unknown>): void {
		if (RANK[level] < threshold) return;
		try {
			const withStack = fields !== undefined && fields !== null && fields.stack === true;
			const body: Record<string, unknown> =
				fields !== undefined && fields !== null && typeof fields === "object"
					? serializeFields(fields, 1, new WeakSet<object>(), withStack)
					: {};
			// Request ids fill only what the caller left unset; a value the caller set always wins.
			const ctx = currentRequestContext();
			if (ctx !== undefined) {
				body.reqId ??= ctx.reqId;
				body.traceId ??= ctx.traceId;
				body.spanId ??= ctx.spanId;
			}
			// Reserved keys come last so a field can never overwrite them.
			const line = JSON.stringify({ ...body, ts: stamp(now), level, event: clip(String(event)) });
			write(line);
		} catch {
			// Logging must never take a request down.
		}
	}

	return {
		info: (event, fields) => emit("info", event, fields),
		warn: (event, fields) => emit("warn", event, fields),
		error: (event, fields) => emit("error", event, fields),
	};
}

export function sanitizeRequestId(raw: string | null): string | null {
	if (typeof raw !== "string") return null;
	return REQUEST_ID.test(raw) ? raw : null;
}

export function newRequestId(): string {
	return randomUUID();
}
