// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

/**
 * A01 Orchestrator graceful degradation hook (n7).
 *
 * Module: src/hooks/a01-orchestrator-hook.ts
 * Implements: Promise.race( orchestratorFn, timeout ) with ORCHESTRATOR_TIMEOUT_MS default 120s.
 * On timeout/failure: log `[gsd-autonomous][a01-orchestrator] FAILED`, append the redacted failure to
 * `<stateDir>/a01-failures.log` (host state dir, never the working tree or `.planning/`), continue (no hang).
 * Controlled by flag A01_ORCHESTRATOR_ENABLED (default true).
 * This hook does not contact Hindsight. Failures go only to the state-dir log.
 *
 * Refs: SPE-5105, UPLIFTED_PROMPT Graph n7 graceful-degradation.
 * No breaking changes to existing hooks, config, or call sites.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { resolveStateDir } from "../host/paths.ts";

export const ORCHESTRATOR_TIMEOUT_MS = 120_000;
export const A01_ORCHESTRATOR_ENABLED =
  (process.env.A01_ORCHESTRATOR_ENABLED ?? "true").toLowerCase() !== "false";

export interface A01HookOptions {
  timeoutMs?: number;
  stateDir?: string; // failure log location (defaults to the host state dir)
  logPrefix?: string;
}

export interface A01RunResult<T> {
  ok: boolean;
  result?: T;
  timedOut?: boolean;
  error?: string;
}

/** Simple redaction for logs/state (shared pattern with teachable hooks). */
export function redactForLog(input: string): string {
  let s = String(input);
  s = s.replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-REDACTED");
  s = s.replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer REDACTED");
  // Home paths outside the working tree are redacted; paths inside it stay.
  const home = process.env.HOME || "/root";
  const repo = process.cwd();
  const homeEsc = home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  s = s.replace(new RegExp(`${homeEsc}/[^\\s"']+`, "g"), (m) =>
    m.startsWith(repo) ? m : "[REDACTED_PATH_OUTSIDE_REPO]"
  );
  return s;
}

/** Maximum failure text per event: one event must never grow the log without bound. */
export const A01_LOG_MESSAGE_MAX = 500;

/** Append a redacted failure line to `<stateDir>/a01-failures.log` (dir 0700, file 0600; best effort, never throws). One event is one line, however long or broken the failure text is. */
function markA01FailureInState(logMsg: string, stateDir?: string): void {
  try {
    const base = stateDir || resolveStateDir(process.env);
    mkdirSync(base, { recursive: true, mode: 0o700 });
    const line = `${new Date().toISOString()} ${redactForLog(logMsg).replace(/\s+/g, " ").trim().slice(0, A01_LOG_MESSAGE_MAX)}\n`;
    appendFileSync(join(base, "a01-failures.log"), line, { encoding: "utf8", mode: 0o600 });
  } catch {
    // fail-open: never block caller
  }
}

/**
 * Run fn under Promise.race timeout. Returns result or {timedOut:true}.
 * Always continues; logs and records the failure in the state-dir log on timeout or rejection.
 */
export async function withA01OrchestratorTimeout<T>(
  fn: () => Promise<T>,
  opts: A01HookOptions = {}
): Promise<A01RunResult<T>> {
  if (!A01_ORCHESTRATOR_ENABLED) {
    try {
      const result = await fn();
      return { ok: true, result };
    } catch (e) {
      return { ok: false, error: redactForLog(String(e)) };
    }
  }

  const timeoutMs = opts.timeoutMs ?? ORCHESTRATOR_TIMEOUT_MS;
  const prefix = opts.logPrefix ?? "[gsd-autonomous][a01-orchestrator]";

  const { promise: timeoutP, resolve: resolveTimeout } = Promise.withResolvers<{ timedOut: true }>();
  setTimeout(() => resolveTimeout({ timedOut: true }), timeoutMs);
  try {
    const raced = await Promise.race([
      fn().then((r): A01RunResult<T> => ({ ok: true, result: r })),
      timeoutP.then((): A01RunResult<T> => ({ ok: false, timedOut: true })),
    ]);
    if (raced.timedOut) {
      const msg = `${prefix} FAILED (timeout after ${timeoutMs}ms)`;
      // eslint-disable-next-line no-console
      console.warn(msg);
      markA01FailureInState(msg, opts.stateDir);
      return { ok: false, timedOut: true };
    }
    return raced;
  } catch (err) {
    const msg = `${prefix} FAILED: ${redactForLog(err instanceof Error ? err.message : String(err))}`;
    // eslint-disable-next-line no-console
    console.warn(msg);
    markA01FailureInState(msg, opts.stateDir);
    return { ok: false, error: redactForLog(String(err)) };
  }
}

/**
 * Convenience wrapper for invoking a01-orchestrator task/brief with graceful degradation.
 * The `run` fn is expected to perform the actual spawn/task call (e.g. to a01).
 * On any failure/timeout: log, record in the state-dir failure log, return control to caller (continue flow).
 * This wrapper does not contact Hindsight. Log lines are redacted before they are stored.
 */
export async function invokeA01OrchestratorWithGraceful<T = unknown>(
  briefOrTask: string,
  run: (brief: string) => Promise<T>,
  opts: A01HookOptions = {}
): Promise<A01RunResult<T>> {
  // briefOrTask only for logging context (never secrets)
  const safeBrief = redactForLog(briefOrTask).slice(0, 200);
  return withA01OrchestratorTimeout(async () => {
    // In real, would call task({agent: "a01-orchestrator", ...}) or equiv.
    // Here we delegate to provided run (for test injection / mock).
    return run(briefOrTask);
  }, { ...opts, logPrefix: `[gsd-autonomous][a01-orchestrator] ${safeBrief ? `(${safeBrief}) ` : ""}` });
}

// For tests: expose a simple fault injector (test seam).
export function __injectFaultForTest(mode: "timeout" | "error" | "success", delayMs = 10): () => Promise<string> {
  if (mode === "timeout") {
    const { promise, reject } = Promise.withResolvers<string>();
    setTimeout(() => reject(new Error("sim-timeout")), 999999);
    return () => promise;
  }
  if (mode === "error") {
    return () => Promise.reject(new Error("sim-error-in-a01"));
  }
  const { promise, resolve } = Promise.withResolvers<string>();
  setTimeout(() => resolve("a01-ok"), delayMs);
  return () => promise;
}
export default { withA01OrchestratorTimeout, invokeA01OrchestratorWithGraceful, ORCHESTRATOR_TIMEOUT_MS, A01_ORCHESTRATOR_ENABLED };