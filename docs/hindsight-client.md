# Hindsight Client (Railway)

> **Status**: Mock-only implementation (in-memory). Real HTTP client deferred.
> **Refs**: [SPE-5102/n4](https://linear.app/swcstudio/issue/SPE-5102/n4-design-hindsightrailway-client-contract) — Design Hindsight/Railway client contract.

This module provides a minimal TypeScript client for writing, reading, and relating memory records to a Hindsight self-learning memory service (hosted on Railway).

It is intended for use by autonomous flows (e.g. Teachable Moment synthesis) inside claude-ultrathink and Omp agents.

## Contract (from n4)

```ts
export interface HindsightConfig {
  endpoint: string;   // process.env.HINDSIGHT_ENDPOINT
  authToken: string;  // process.env.HINDSIGHT_API_TOKEN
}

export interface HindsightRecord {
  id: string;
  content: unknown;
  relations?: { targetId: string; type: string }[];
}

export interface HindsightClient {
  write(record: Omit<HindsightRecord, 'id'>): Promise<HindsightRecord>;
  read(id: string): Promise<HindsightRecord | null>;
  relate(sourceId: string, targetId: string, type: string): Promise<void>;
}

export function createHindsightClient(cfg?: Partial<HindsightConfig>): HindsightClient;
export class HindsightConfigError extends Error {}
export function createMockHindsightClient(): HindsightClient;
```

See the source for the exact implementation: `src/integrations/hindsight-client.ts`.

## Environment Variables

| Var                    | Required for real | Purpose                              | Default / mock behavior          |
|------------------------|-------------------|--------------------------------------|----------------------------------|
| `HINDSIGHT_ENDPOINT`   | yes (for real)    | Base URL of the Hindsight service    | If missing → use mock            |
| `HINDSIGHT_API_TOKEN`  | yes (for real)    | Auth credential                      | If missing → use mock            |
| `HINDSIGHT_MOCK`       | no                | `"true"` forces in-memory mock even if creds present | See logic below |

## Behavior

`createHindsightClient()` returns the **in-memory mock** implementation (backed by `Map`) when any of:

- `!endpoint`
- `!authToken`
- `HINDSIGHT_MOCK === "true"`

Otherwise it currently also falls back to the mock (with a console.warn) because **no real HTTP client is implemented** and **no credentials/secrets may be present**.

The mock:

- Generates stable-enough UUIDs (or timestamp fallback) for record ids on `write`.
- Stores full records + relations in an isolated `Map` per client instance.
- `relate()` appends to the source record's `relations` array (idempotent).
- Never performs network I/O.

## Running the smoke test (mock roundtrip)

```bash
cd /path/to/claude-ultrathink
bun scripts/hindsight-smoke-test.ts
```

It forces `HINDSIGHT_MOCK=true`, performs:

- two `write`s
- `read` roundtrips + assertions
- `relate` + verification
- missing-id read

Expects exit 0 + "SUCCESS" on pass.

## Switching to the real client

1. Obtain from user / Railway:
   - Exact Hindsight service endpoint URL
   - Auth mechanism + token value (do **not** commit)
   - Confirmation of env var names if different from `HINDSIGHT_*`

2. Set the env vars (e.g. in your shell, Railway vars, or `.env` that is gitignored).

3. Set `HINDSIGHT_MOCK=false` (or unset) **only after** the real implementation exists.

4. Replace the placeholder branch inside `createHindsightClient` with an actual `fetch`-based client that:
   - Uses the endpoint + appropriate `Authorization` header
   - Implements the three methods against the real Hindsight API
   - Handles errors, retries, sanitization as required by higher layers

Until the above, **real mode is not functional** — the mock is the supported path.

## Unknowns / open questions (from n4 + n6)

- Exact Railway project ID, service name, base endpoint URL (user-supplied).
- Hindsight API shape (write payload/response, read, relate endpoints or GraphQL mutations).
- Auth header ( `Bearer ${token}`, custom header, Railway private networking token?).
- Exact env var names (provisional: `HINDSIGHT_ENDPOINT` / `HINDSIGHT_API_TOKEN`).
- Whether `relate` mutates the source record or is a separate edge table on the server.
- Rate limiting, sanitization of `content`, persistence guarantees (exactly-once?).

Do not implement real client or hardcode any values until these are clarified.

## Usage example (mock safe)

```ts
import { createHindsightClient } from "./src/integrations/hindsight-client.ts";

const client = createHindsightClient(); // always safe; mock when no creds

const rec = await client.write({
  content: { name: "Learned X", body: "..." },
});
await client.relate(rec.id, otherId, "supersedes");
const back = await client.read(rec.id);
```

## Related

- Workstream 2 / 3 in the SPE-5102 uplift (Hindsight connectivity + Teachable Moments)
- `scripts/hindsight-smoke-test.ts`
- Source: `src/integrations/hindsight-client.ts`
