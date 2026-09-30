// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

/**
 * A01 Orchestrator graceful degradation hook (n7).
 *
 * Module: src/hooks/a01-orchestrator-hook.ts
 * Implements: Promise.race( orchestratorFn, timeout ) with ORCHESTRATOR_TIMEOUT_MS default 120s.
 * On timeout/failure: log `[gsd-autonomous][a01-orchestrator] FAILED`, mark STATE, continue (no hang).
 * Controlled by flag A01_ORCHESTRATOR_ENABLED (default true).
 * Hindsight usage is mocked (no real creds, per spec).
 *
 * Refs: SPE-5105, UPLIFTED_PROMPT Graph n7 graceful-degradation.
 * No breaking changes to existing hooks, config, or call sites.
 */

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const ORCHESTRATOR_TIMEOUT_MS = 120_000;
export const A01_ORCHESTRATOR_ENABLED =
  (process.env.A01_ORCHESTRATOR_ENABLED ?? "true").toLowerCase() !== "false";

export interface A01HookOptions {
  timeoutMs?: number;
  stateDir?: string; // for marking STATE (defaults to .planning or cwd)
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
  // $HOME paths outside repo get redacted (see teachable-moments/hooks.ts for full)
  const home = process.env.HOME || "/root";
  const repo = process.cwd();
  const homeEsc = home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  s = s.replace(new RegExp(`${homeEsc}/[^\\s"']+`, "g"), (m) =>
    m.startsWith(repo) ? m : "[REDACTED_PATH_OUTSIDE_REPO]"
  );
  return s;
}

/** Mark failure in STATE (append to .planning/STATE.md if present, or create marker; fail-open). */
function markA01FailureInState(logMsg: string, stateDir?: string): void {
  try {
    const base = stateDir || join(process.cwd(), ".planning");
    const stateMd = join(base, "STATE.md");
    const marker = `\n\n<!-- a01-hook-failure ${new Date().toISOString()} -->\n[gsd-autonomous][a01-orchestrator] FAILED: ${redactForLog(logMsg)}\n`;
    if (existsSync(stateMd)) {
      appendFileSync(stateMd, marker, "utf8");
    } else {
      mkdirSync(base, { recursive: true });
      // Do not overwrite full STATE; append note or write minimal if absent
      writeFileSync(stateMd, `# STATE (graceful a01 marker)\n${marker}`, "utf8");
    }
  } catch {
    // fail-open: never block caller
  }
}

/**
 * Run fn under Promise.race timeout. Returns result or {timedOut:true}.
 * Always continues; logs and marks STATE on timeout or rejection.
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
 * On any failure/timeout: log, mark STATE, return control to caller (continue flow).
 * Mock Hindsight: no persistence side-effect here; redaction applied to logs/state.
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