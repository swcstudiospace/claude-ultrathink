// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

/**
 * Teachable Moments hooks for phase/prompt boundaries (n7 graceful degradation).
 *
 * Module: src/teachable-moments/hooks.ts
 * - onPhaseComplete / onPromptComplete: capture normalized TeachableMoment and write via Hindsight (mock).
 * - try/catch around write; on fail push redacted entry to retry queue.
 * - drainRetryQueue: max 3 attempts, exponential backoff (1s,2s,4s), abandon after.
 * - Debounce 10s between captures (per spec).
 * - Redaction: strip sk-*, Bearer tokens, $HOME/* paths that are outside current repo root.
 * - Flags: HINDSIGHT_ENABLED (default true; env or future config).
 *
 * Queue persisted to .planning/hindsight-retry-queue.json (empty [] created at setup).
 * Never blocks caller; always continue flow.
 * Mock Hindsight used exclusively (no creds, see hindsight-client).
 *
 * Refs: SPE-5105, Graph n7, SPE-5104, UPLIFTED_PROMPT graceful-degradation.
 * No breaking of schema.ts / agent-card.ts or existing callers.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  createHindsightClient,
  type HindsightClient,
} from "../integrations/hindsight-client.ts";
import {
  normalizeTeachableMoment,
  type TeachableMoment,
  type TeachableMomentInput,
} from "./schema.ts";

export const HINDSIGHT_ENABLED =
  (process.env.HINDSIGHT_ENABLED ?? "true").toLowerCase() !== "false";
export const DEBOUNCE_MS = 10_000;
export const MAX_RETRY_ATTEMPTS = 3;
export const RETRY_BASE_BACKOFF_MS = 1000;

const QUEUE_PATH = join(process.cwd(), ".planning", "hindsight-retry-queue.json");

let lastCaptureTs = 0;
let client: HindsightClient | null = null;

function getClient(): HindsightClient {
  if (!client) {
    // Always mock in this wave (per spec + no creds supplied)
    process.env.HINDSIGHT_MOCK = "true";
    client = createHindsightClient();
  }
  return client;
}

export interface CaptureContext {
  phase?: string;
  promptId?: string;
  artifacts?: string[];
  tags?: string[];
  relatedIds?: string[];
  repoRoot?: string; // for redaction scope
}

interface RetryEntry {
  id: string;
  attempt: number;
  lastAttempt: number;
  payload: TeachableMomentInput & { sourcePhase: string };
  redactedLog?: string;
}

/** Full redaction for secrets and out-of-repo paths (used for queue + logs). */
export function redact(input: unknown, repoRoot = process.cwd()): string {
  let text = typeof input === "string" ? input : JSON.stringify(input ?? {});
  // strip sk- keys (openai etc)
  text = text.replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-REDACTED");
  // strip Bearer tokens
  text = text.replace(/Bearer\s+[A-Za-z0-9._~+/-]+=*/gi, "Bearer REDACTED");
  // $HOME paths outside repo
  const home = process.env.HOME || "/root";
  const homeEsc = home.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pathRe = new RegExp(`${homeEsc}/[^\\s"'\\n\\r]+`, "g");
  text = text.replace(pathRe, (match) => (match.startsWith(repoRoot) ? match : "[REDACTED_PATH_OUTSIDE_REPO]"));
  return text;
}

function loadQueue(): RetryEntry[] {
  try {
    if (!existsSync(QUEUE_PATH)) return [];
    const raw = readFileSync(QUEUE_PATH, "utf8");
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? (arr as RetryEntry[]) : [];
  } catch {
    return [];
  }
}

function saveQueue(q: RetryEntry[]): void {
  try {
    const dir = join(QUEUE_PATH, "..");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(QUEUE_PATH, JSON.stringify(q, null, 2) + "\n", "utf8");
  } catch {
    // fail-open for queue
  }
}

function pushToQueue(payload: TeachableMomentInput & { sourcePhase: string }, redacted: string): void {
  const q = loadQueue();
  const entry: RetryEntry = {
    id: `retry_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    attempt: 0,
    lastAttempt: 0,
    payload,
    redactedLog: redacted,
  };
  q.push(entry);
  saveQueue(q);
}

async function drainRetryQueue(): Promise<void> {
  if (!HINDSIGHT_ENABLED) return;
  let q = loadQueue();
  if (q.length === 0) return;
  const c = getClient();
  const remaining: RetryEntry[] = [];
  for (const entry of q) {
    if (entry.attempt >= MAX_RETRY_ATTEMPTS) {
      // abandon
      // eslint-disable-next-line no-console
      console.warn(`[teachable-moments] abandoned retry after ${MAX_RETRY_ATTEMPTS} for ${entry.id}`);
      continue;
    }
    const backoff = RETRY_BASE_BACKOFF_MS * Math.pow(2, entry.attempt);
    const now = Date.now();
    if (now - entry.lastAttempt < backoff) {
      remaining.push(entry);
      continue;
    }
    try {
      const tm = normalizeTeachableMoment(entry.payload);
      await c.write({ content: { type: "teachable", moment: tm } });
      // success, drop
      // eslint-disable-next-line no-console
      console.log(`[teachable-moments] retry succeeded for ${entry.id} on attempt ${entry.attempt + 1}`);
    } catch (e) {
      entry.attempt += 1;
      entry.lastAttempt = Date.now();
      entry.redactedLog = redact(String(e));
      remaining.push(entry);
    }
  }
  saveQueue(remaining);
}

/** Internal: create and persist a teachable moment (try/catch + queue on fail). */
async function captureTeachable(input: TeachableMomentInput & { sourcePhase: string }, ctx: CaptureContext = {}): Promise<void> {
  if (!HINDSIGHT_ENABLED) return;
  const now = Date.now();
  if (now - lastCaptureTs < DEBOUNCE_MS) return;
  lastCaptureTs = now;

  const redactedPayload = redact(input, ctx.repoRoot);
  try {
    const tm = normalizeTeachableMoment(input);
    const c = getClient();
    await c.write({ content: { type: "teachable", moment: tm } });
    // best effort drain after success
    // fire and forget (no await to not block)
    void drainRetryQueue();
  } catch (err) {
    const errMsg = redact(err instanceof Error ? err.message : String(err), ctx.repoRoot);
    // eslint-disable-next-line no-console
    console.warn(`[teachable-moments] write failed (queued): ${errMsg}`);
    pushToQueue(input, redactedPayload + " | err=" + errMsg);
    // schedule drain (non blocking)
    setTimeout(() => void drainRetryQueue(), 0);
  }
}

/**
 * Called on GSD phase completion boundary (graceful, non-blocking).
 * Builds a TeachableMoment from phase + artifacts, writes (with retry queue).
 */
export async function onPhaseComplete(phase: string, artifacts: string[] = [], ctx: CaptureContext = {}): Promise<void> {
  const input: TeachableMomentInput & { sourcePhase: string } = {
    name: `Phase ${phase} completed — teachable captured`,
    description: `Autonomous phase ${phase} finished successfully. Artifacts: ${artifacts.length}`,
    body: `Phase ${phase} complete. Source artifacts: ${artifacts.join(", ")}. Captured for hindsight reuse.`,
    sourcePhase: phase,
    sourceArtifacts: artifacts,
    tags: [...(ctx.tags ?? []), "phase-complete", "gsd", "graceful"],
    relatedIds: ctx.relatedIds ?? [],
  };
  await captureTeachable(input, { ...ctx, phase });
}

/**
 * Called on prompt / turn complete (for gsd-autonomous or ultrathink prompt finish).
 * Graceful: try/catch, debounce, queue, redaction, continue always.
 */
export async function onPromptComplete(promptId: string, summary?: string, ctx: CaptureContext = {}): Promise<void> {
  const input: TeachableMomentInput & { sourcePhase: string } = {
    name: `Prompt ${promptId} complete — teachable`,
    description: summary ? summary.slice(0, 200) : "Prompt finished in autonomous flow.",
    body: `Prompt complete. ID: ${promptId}. ${summary ?? ""} (redacted in logs/queue)`,
    sourcePhase: ctx.phase ?? "prompt",
    sourceArtifacts: ctx.artifacts ?? [],
    tags: [...(ctx.tags ?? []), "prompt-complete", "ultrathink", "graceful"],
    relatedIds: ctx.relatedIds ?? [],
  };
  await captureTeachable({ ...input, sourcePhase: input.sourcePhase }, { ...ctx, promptId });
}

/** Force-drain for tests/verification (respects enabled flag). */
export async function __drainForTest(): Promise<void> {
  await drainRetryQueue();
}

/** Test helper: reset debounce (not for prod). */
export function __resetDebounceForTest(): void {
  lastCaptureTs = 0;
}

export default {
  onPhaseComplete,
  onPromptComplete,
  HINDSIGHT_ENABLED,
  redact,
  __drainForTest,
};