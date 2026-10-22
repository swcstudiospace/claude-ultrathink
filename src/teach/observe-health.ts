// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Health of the detached `teach observe` distiller. Observe runs with ignored stdio, so a distiller that fails on every
 * run (an expired login, an exhausted API balance, a missing engine) used to leave no trace at all: no lessons, no
 * Hindsight writes and nothing on the status line. This file keeps the last failure and a consecutive-failure count so
 * the status line and `teach status` can say so. Only a short redacted reason is stored: never a key, a prompt or a body.
 * Every function is fail-open and never throws.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { redactLine } from "./redact.ts";

const FILE_NAME = "observe-health.json";
const REASON_CHARS = 80;

export interface ObserveHealth {
	/** Consecutive failed distiller runs; 0 after a run that reached the distiller and got an answer. */
	failures: number;
	/** ISO time of the first failure in the current run of failures. */
	failingSince?: string;
	lastFailureAt?: string;
	/** Short, redacted reason of the last failure. */
	reason?: string;
	lastOkAt?: string;
}

function healthPath(stateDir: string): string {
	return join(stateDir, "teach", FILE_NAME);
}

function cleanReason(reason: string): string {
	try {
		return redactLine(reason, REASON_CHARS).replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, REASON_CHARS);
	} catch {
		return "unknown";
	}
}

/** The stored health, or undefined when there is none or it cannot be read. */
export function readObserveHealth(stateDir: string): ObserveHealth | undefined {
	try {
		const value: unknown = JSON.parse(readFileSync(healthPath(stateDir), "utf8"));
		if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
		const raw = value as Record<string, unknown>;
		const failures = typeof raw.failures === "number" && Number.isInteger(raw.failures) && raw.failures >= 0 ? raw.failures : 0;
		const health: ObserveHealth = { failures };
		for (const key of ["failingSince", "lastFailureAt", "lastOkAt"] as const) {
			if (typeof raw[key] === "string") health[key] = raw[key];
		}
		if (typeof raw.reason === "string") health.reason = cleanReason(raw.reason);
		return health;
	} catch {
		return undefined;
	}
}

function writeHealth(stateDir: string, health: ObserveHealth): void {
	const dir = join(stateDir, "teach");
	mkdirSync(dir, { recursive: true, mode: 0o700 });
	const path = healthPath(stateDir);
	const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(health)}\n`, { mode: 0o600 });
	try {
		chmodSync(tmp, 0o600);
	} catch {
		// mode was set at create
	}
	renameSync(tmp, path);
}

/** Records one failed run and returns the updated health (undefined when it could not be written). */
export function recordObserveFailure(stateDir: string, reason: string, at: Date): ObserveHealth | undefined {
	try {
		const prior = readObserveHealth(stateDir);
		const failures = (prior?.failures ?? 0) + 1;
		const iso = at.toISOString();
		const health: ObserveHealth = {
			failures,
			failingSince: failures > 1 && prior?.failingSince ? prior.failingSince : iso,
			lastFailureAt: iso,
			reason: cleanReason(reason),
			...(prior?.lastOkAt ? { lastOkAt: prior.lastOkAt } : {}),
		};
		writeHealth(stateDir, health);
		return health;
	} catch {
		return undefined;
	}
}

/** Clears the failure streak after a run whose distiller answered. Creates nothing when there is no health file yet. */
export function recordObserveOk(stateDir: string, at: Date): void {
	try {
		if (!existsSync(healthPath(stateDir))) return;
		writeHealth(stateDir, { failures: 0, lastOkAt: at.toISOString() });
	} catch {
		// fail-open
	}
}

/** Whether a failure should also leave an activity receipt: the first failure of a streak, then every tenth. */
export function shouldNotifyFailure(health: ObserveHealth | undefined): boolean {
	return health !== undefined && (health.failures === 1 || health.failures % 10 === 0);
}

/** `observe failing ×<n> since <minute> UTC (<reason>)`, or undefined when the distiller is healthy or unknown. */
export function observeHealthPart(stateDir: string): string | undefined {
	const health = readObserveHealth(stateDir);
	if (!health || health.failures === 0) return undefined;
	const since = health.failingSince ? ` since ${health.failingSince.slice(0, 16).replace("T", " ")} UTC` : "";
	const reason = health.reason ? ` (${health.reason})` : "";
	return `observe failing ×${health.failures}${since}${reason}`;
}
