// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

/**
 * Hindsight / Railway client contract.
 *
 * Module: src/integrations/hindsight-client.ts
 * Per n4 (SPE-5102): https://linear.app/swcstudio/issue/SPE-5102/n4-design-hindsightrailway-client-contract
 *
 * - Config from env HINDSIGHT_*
 * - createHindsightClient returns in-memory mock impl if !endpoint or HINDSIGHT_MOCK=true (or no auth)
 * - Mock uses per-client Map; supports write/read/relate roundtrips.
 * - NO real HTTP implementation, NO secrets, NO credentials in code.
 * - Real impl deferred until Railway/Hindsight endpoint + auth details supplied by user (see docs).
 *
 * Unknowns (flagged):
 * - Exact Hindsight API surface (REST paths, payload for write/read/relate, response shapes)
 * - Auth header format (Bearer? X-Api-Key? Railway service token?)
 * - Whether HINDSIGHT_API_TOKEN vs HINDSIGHT_AUTH_TOKEN (using *_API_TOKEN to match n4 draft)
 * - Endpoint base path (trailing slash handling etc.)
 */

export interface HindsightConfig {
  endpoint: string; // e.g. from HINDSIGHT_ENDPOINT — UNKNOWN until user supplies
  authToken: string; // from HINDSIGHT_API_TOKEN — UNKNOWN until user supplies
}

export interface HindsightRecord {
  id: string;
  content: unknown;
  relations?: { targetId: string; type: string }[];
}

export interface HindsightClient {
  write(record: Omit<HindsightRecord, "id">): Promise<HindsightRecord>;
  read(id: string): Promise<HindsightRecord | null>;
  relate(sourceId: string, targetId: string, type: string): Promise<void>;
}

export class HindsightConfigError extends Error {}

const MOCK_ENV = "HINDSIGHT_MOCK";
const ENDPOINT_ENV = "HINDSIGHT_ENDPOINT";
const TOKEN_ENV = "HINDSIGHT_API_TOKEN";

function createMockHindsightClient(): HindsightClient {
  // In-memory Map per client instance (fresh for each create call / smoke test).
  const store = new Map<string, HindsightRecord>();

  return {
    async write(record: Omit<HindsightRecord, "id">): Promise<HindsightRecord> {
      const id =
        globalThis.crypto?.randomUUID?.() ??
        `hindsight_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const full: HindsightRecord = {
        ...record,
        id,
        relations: record.relations ?? [],
      };
      store.set(id, full);
      return full;
    },

    async read(id: string): Promise<HindsightRecord | null> {
      return store.get(id) ?? null;
    },

    async relate(sourceId: string, targetId: string, type: string): Promise<void> {
      const rec = store.get(sourceId);
      if (!rec) {
        // Minimal mock: no-op if source unknown (real impl may create stub or error; keep simple)
        return;
      }
      rec.relations = rec.relations ?? [];
      const exists = rec.relations.some(
        (r) => r.targetId === targetId && r.type === type,
      );
      if (!exists) {
        rec.relations.push({ targetId, type });
      }
      store.set(sourceId, rec);
    },
  };
}

/**
 * Factory. Returns mock client (in-mem Map) when:
 * - no endpoint, or
 * - no authToken, or
 * - HINDSIGHT_MOCK=true
 *
 * Otherwise would return real client (not implemented here: see "No real HTTP").
 * Always safe to call without credentials (returns usable mock).
 */
export function createHindsightClient(
  cfg?: Partial<HindsightConfig>,
): HindsightClient {
  const endpoint = cfg?.endpoint ?? process.env[ENDPOINT_ENV];
  const authToken = cfg?.authToken ?? process.env[TOKEN_ENV];
  const forceMock = process.env[MOCK_ENV] === "true";

  if (!endpoint || !authToken || forceMock) {
    return createMockHindsightClient();
  }

  // Real fetch-based impl is out of scope for this task (no credentials provided,
  // no HTTP allowed per assignment). Fall back to mock so callers (e.g. WS3)
  // can still develop against the interface. When real details arrive, replace
  // this branch (do not commit secrets).
  // eslint-disable-next-line no-console
  console.warn(
    `[hindsight-client] HINDSIGHT_ENDPOINT and HINDSIGHT_API_TOKEN present but HINDSIGHT_MOCK!=true; real client not implemented — using in-memory mock. Refs SPE-5102`,
  );
  return createMockHindsightClient();
}

// Re-export the mock creator for direct use in tests / when forcing mock mode.
export { createMockHindsightClient };
