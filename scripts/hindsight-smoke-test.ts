#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

/**
 * scripts/hindsight-smoke-test.ts
 *
 * Runs a mock-only roundtrip against the Hindsight client.
 * Forces mock mode (no credentials, no HTTP).
 *
 * Usage:
 *   bun scripts/hindsight-smoke-test.ts
 *
 * Refs: SPE-5102 n4 (Hindsight/Railway client contract)
 * See docs/hindsight-client.md
 */

import {
  createHindsightClient,
  type HindsightClient,
  type HindsightRecord,
} from "../src/integrations/hindsight-client.ts";

async function smoke(client: HindsightClient): Promise<void> {
  console.log("[hindsight-smoke] starting mock roundtrip...");

  // Write 1
  const r1 = await client.write({
    content: { type: "teachable", name: "smoke-1", detail: "first record" },
  });
  console.log("[hindsight-smoke] wrote r1:", r1.id);

  // Write 2
  const r2 = await client.write({
    content: { type: "teachable", name: "smoke-2", detail: "second record" },
  });
  console.log("[hindsight-smoke] wrote r2:", r2.id);

  // Read roundtrip
  const got1 = await client.read(r1.id);
  const c1 = (got1?.content ?? {}) as Record<string, unknown>;
  if (!got1 || c1.detail !== "first record") {
    throw new Error("read roundtrip failed for r1");
  }
  console.log("[hindsight-smoke] read r1 OK:", c1.name);

  const got2 = await client.read(r2.id);
  if (!got2) throw new Error("read roundtrip failed for r2");
  console.log("[hindsight-smoke] read r2 OK");

  // Relate
  await client.relate(r1.id, r2.id, "depends-on");
  const got1After = await client.read(r1.id);
  const rels = got1After?.relations ?? [];
  if (!rels.some((r) => r.targetId === r2.id && r.type === "depends-on")) {
    throw new Error("relate did not persist on source");
  }
  console.log("[hindsight-smoke] relate OK (r1 -> r2 'depends-on')");

  // Read non-existent
  const missing = await client.read("does-not-exist-xyz");
  if (missing !== null) throw new Error("expected null for missing id");
  console.log("[hindsight-smoke] read-missing OK");

  console.log("[hindsight-smoke] SUCCESS: mock roundtrip complete");
}

async function main(): Promise<void> {
  // Force mock (no real endpoint or token needed, and no HTTP)
  process.env.HINDSIGHT_MOCK = "true";
  // Clear any accidental creds for the test
  delete process.env.HINDSIGHT_ENDPOINT;
  delete process.env.HINDSIGHT_API_TOKEN;

  const client = createHindsightClient();
  await smoke(client);
}

if (import.meta.main) {
  main().catch((err) => {
    console.error("[hindsight-smoke] FAILED:", err);
    process.exit(1);
  });
}
