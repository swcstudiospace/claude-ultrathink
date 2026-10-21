// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { readFileSync } from "node:fs";
import type { OpenRouterFetch } from "../engine/openrouter.ts";

/**
 * Fault plans for the upstream seam. A plan is ordered steps; each call through the faulty fetch consumes one unit of
 * the current step, and after the last step calls pass through to the inner fetch. No randomness, no clock assertions:
 * latency and blackhole faults honour `init.signal`, so the caller's own timeout is the behaviour under test.
 *
 * Plan errors name the offending field path and never echo the plan's values, so a rejected plan cannot leak its
 * contents into a log line.
 */

export type Fault =
	| { kind: "pass" }
	| { kind: "status"; status: number; retryAfterSec?: number }
	| { kind: "reset" }
	| { kind: "blackhole" }
	| { kind: "latency"; ms: number };

export interface FaultStep {
	count: number | "forever";
	fault: Fault;
}

export interface FaultPlan {
	steps: FaultStep[];
}

const MAX_STEPS = 100;
const MAX_STATUS = 599;
const MIN_ERROR_STATUS = 400;
const MAX_RETRY_AFTER_SEC = 20;
const MAX_LATENCY_MS = 60_000;
const FAULT_KINDS = ["pass", "status", "reset", "blackhole", "latency"] as const;

type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

function abortError(): DOMException {
	return new DOMException("The operation was aborted.", "AbortError");
}

/** Resolves after `ms`, or early when `signal` aborts; the caller checks the signal to tell the two apart. */
function waitFor(ms: number, signal?: AbortSignal): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	if (signal?.aborted === true) {
		resolve();
		return promise;
	}
	const done = (): void => {
		clearTimeout(timer);
		signal?.removeEventListener("abort", done);
		resolve();
	};
	const timer = setTimeout(done, ms);
	signal?.addEventListener("abort", done, { once: true });
	return promise;
}

/** Never resolves; rejects with an AbortError as soon as `signal` aborts. */
function untilAborted(signal: AbortSignal): Promise<never> {
	const { promise, reject } = Promise.withResolvers<never>();
	if (signal.aborted) {
		reject(abortError());
		return promise;
	}
	signal.addEventListener("abort", () => reject(abortError()), { once: true });
	return promise;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function expectRecord(value: unknown, path: string): Record<string, unknown> {
	if (!isRecord(value)) {
		throw new TypeError(`${path} must be an object`);
	}
	return value;
}

function rejectUnknownKeys(record: Record<string, unknown>, path: string, allowed: readonly string[]): void {
	for (const key of Object.keys(record)) {
		if (!allowed.includes(key)) {
			throw new TypeError(`${path}.${key} is not a known field`);
		}
	}
}

function expectNumber(value: unknown, path: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new TypeError(`${path} must be a number`);
	}
	return value;
}

function expectInteger(value: unknown, path: string): number {
	if (typeof value !== "number" || !Number.isInteger(value)) {
		throw new TypeError(`${path} must be an integer`);
	}
	return value;
}

function expectRange(value: number, path: string, min: number, max: number): void {
	if (value < min || value > max) {
		throw new RangeError(`${path} must be between ${min} and ${max}`);
	}
}

function parseCount(value: unknown, path: string): number | "forever" {
	if (value === "forever") {
		return "forever";
	}
	const count = expectInteger(value, path);
	if (count < 1 || count > Number.MAX_SAFE_INTEGER) {
		throw new RangeError(`${path} must be a positive safe integer`);
	}
	return count;
}

function parseFault(value: unknown, path: string): Fault {
	const fault = expectRecord(value, path);
	switch (fault.kind) {
		case "pass":
		case "reset":
		case "blackhole":
			rejectUnknownKeys(fault, path, ["kind"]);
			return { kind: fault.kind };
		case "status": {
			rejectUnknownKeys(fault, path, ["kind", "status", "retryAfterSec"]);
			const status = expectInteger(fault.status, `${path}.status`);
			expectRange(status, `${path}.status`, MIN_ERROR_STATUS, MAX_STATUS);
			if (fault.retryAfterSec === undefined) {
				return { kind: "status", status };
			}
			const retryAfterSec = expectNumber(fault.retryAfterSec, `${path}.retryAfterSec`);
			expectRange(retryAfterSec, `${path}.retryAfterSec`, 0, MAX_RETRY_AFTER_SEC);
			return { kind: "status", status, retryAfterSec };
		}
		case "latency": {
			rejectUnknownKeys(fault, path, ["kind", "ms"]);
			const ms = expectNumber(fault.ms, `${path}.ms`);
			expectRange(ms, `${path}.ms`, 0, MAX_LATENCY_MS);
			return { kind: "latency", ms };
		}
		default:
			throw new TypeError(`${path}.kind must be one of ${FAULT_KINDS.join(", ")}`);
	}
}

function parseStep(value: unknown, path: string, last: boolean): FaultStep {
	const step = expectRecord(value, path);
	rejectUnknownKeys(step, path, ["count", "fault"]);
	const count = parseCount(step.count, `${path}.count`);
	if (count === "forever" && !last) {
		throw new RangeError(`${path}.count "forever" is only allowed on the last step`);
	}
	return { count, fault: parseFault(step.fault, `${path}.fault`) };
}

/**
 * Validates untrusted JSON into a FaultPlan. Wrong shapes throw `TypeError`, out-of-range values throw `RangeError`;
 * the message names the field path (for example `steps[1].fault.status`) and not the value.
 */
export function parseFaultPlan(json: unknown): FaultPlan {
	const plan = expectRecord(json, "plan");
	rejectUnknownKeys(plan, "plan", ["steps"]);
	if (!Array.isArray(plan.steps)) {
		throw new TypeError("steps must be an array");
	}
	const entries: unknown[] = plan.steps;
	if (entries.length < 1 || entries.length > MAX_STEPS) {
		throw new RangeError(`steps must hold between 1 and ${MAX_STEPS} entries`);
	}
	const steps = entries.map((entry, index) => parseStep(entry, `steps[${index}]`, index === entries.length - 1));
	return { steps };
}

function statusResponse(status: number, retryAfterSec: number | undefined): Response {
	const headers: Record<string, string> = { "content-type": "application/json" };
	if (retryAfterSec !== undefined) {
		headers["retry-after"] = String(retryAfterSec);
	}
	return new Response('{"error":"injected"}', { status, headers });
}

/**
 * Wraps `inner` so that each call consumes one unit of the plan. The plan is copied, so later mutation of the caller's
 * object has no effect. Consumption happens synchronously when the call is made, so concurrent calls take units in
 * call order.
 */
export function createFaultyFetch(plan: FaultPlan, inner: OpenRouterFetch, sleep: Sleep = waitFor): OpenRouterFetch {
	const steps: FaultStep[] = plan.steps.map((step) => ({ count: step.count, fault: step.fault }));
	let index = 0;
	let used = 0;
	const nextFault = (): Fault | undefined => {
		while (index < steps.length) {
			const step = steps[index];
			if (step === undefined) {
				break;
			}
			if (step.count === "forever") {
				return step.fault;
			}
			if (used < step.count) {
				used += 1;
				return step.fault;
			}
			index += 1;
			used = 0;
		}
		return undefined;
	};
	return async (input, init) => {
		const fault = nextFault();
		if (fault === undefined || fault.kind === "pass") {
			return inner(input, init);
		}
		const signal = init.signal ?? undefined;
		switch (fault.kind) {
			case "status":
				return statusResponse(fault.status, fault.retryAfterSec);
			case "reset":
				throw new TypeError("fetch failed: injected reset");
			case "blackhole":
				if (signal === undefined) {
					throw new Error("blackhole fault needs an abortable request: init.signal is missing");
				}
				return untilAborted(signal);
			case "latency":
				await sleep(fault.ms, signal);
				if (signal?.aborted === true) {
					throw abortError();
				}
				return inner(input, init);
		}
	};
}

function errorCode(error: unknown): string {
	if (isRecord(error) && typeof error.code === "string") {
		return error.code;
	}
	return "read failed";
}

/**
 * The chaos gate. Returns `undefined` unless `chaosEnabled` is exactly true. Otherwise reads and validates the plan at
 * `chaosPlanPath` and returns the faulty wrapper around the real global fetch. A missing or invalid plan throws an
 * Error that names the path and the reason; it never includes the plan contents (JSON syntax errors are replaced by a
 * fixed message for the same reason).
 */
export function loadChaosFetch(
	config: { chaosEnabled?: boolean; chaosPlanPath?: string },
	readText: (path: string) => string = (path) => readFileSync(path, "utf8"),
): OpenRouterFetch | undefined {
	if (config.chaosEnabled !== true) {
		return undefined;
	}
	const path = config.chaosPlanPath;
	if (path === undefined) {
		throw new Error("chaos is enabled but no fault plan path is set");
	}
	let text: string;
	try {
		text = readText(path);
	} catch (error) {
		throw new Error(`chaos fault plan ${path} cannot be read (${errorCode(error)})`);
	}
	let json: unknown;
	try {
		json = JSON.parse(text);
	} catch {
		throw new Error(`chaos fault plan ${path} is not valid JSON`);
	}
	let plan: FaultPlan;
	try {
		plan = parseFaultPlan(json);
	} catch (error) {
		throw new Error(`chaos fault plan ${path} is invalid: ${error instanceof Error ? error.message : "unknown error"}`);
	}
	return createFaultyFetch(plan, (input, init) => fetch(input, init));
}
