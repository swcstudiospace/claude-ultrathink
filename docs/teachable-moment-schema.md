# Teachable Moment Schema

> **Status**: New (A2A-DRAFT). Schema and A2A mapping defined; no runtime hooks/wiring yet.
> **Refs**: Graph of Thought node n5 (UPLIFTED_PROMPT spec); [SPE-5104](https://linear.app/swcstudio/issue/SPE-5104) + subissues.
> **Related**: Hindsight client (mock) — `src/integrations/hindsight-client.ts`, `docs/hindsight-client.md`

Teachable Moments capture reusable "lessons" or bug patterns discovered during autonomous agent runs (e.g. Claude-Ultrathink / OMP phases). They are designed to be:

- Stored via Hindsight (content type `teachable`).
- Mapped to A2A Agent Cards for cross-agent / cross-system sharing.
- Queryable for future "teach" moments without re-deriving the same insight.

## Schema (exact per n5 conclusion)

```ts
export interface TeachableMoment {
	id: string;
	name: string; // teachable e.g. "Claude-Ultrathink has 2 Bugs when integrating Jev"
	description: string;
	body: string;
	sourcePhase: string;
	sourceArtifacts: string[];
	createdAt: string; // ISO 8601
	tags: string[];
	relatedIds: string[];
}

export type TeachableMomentType = TeachableMoment;

export interface TeachableMomentInput { /* ... */ }

export function normalizeTeachableMoment(input: ...): TeachableMoment;
```

### Field Details

| Field            | Type     | Required | Notes / Example |
|------------------|----------|----------|-----------------|
| `id`             | string   | yes      | Stable identifier (UUID or hindsight record id) |
| `name`           | string   | yes      | Human title. Teachable form: "Claude-Ultrathink has 2 Bugs when integrating Jev" |
| `description`    | string   | yes      | Short summary (1-2 sentences) |
| `body`           | string   | yes      | Full detail, reproduction, root cause, fix guidance. This becomes the A2A `description` in skills entry. |
| `sourcePhase`    | string   | yes      | Originating node/phase e.g. `"n5"`, `"SPE-5104/n3"` |
| `sourceArtifacts`| string[] | no       | Files, issues, transcripts that contributed evidence. e.g. `["claude-ultrathink/src/integrations/hindsight-client.ts", "issues/xxx.md"]` |
| `createdAt`      | string   | yes      | ISO timestamp of capture |
| `tags`           | string[] | no       | e.g. `["bug", "integration", "jev", "hindsight"]` |
| `relatedIds`     | string[] | no       | Other teachable ids or hindsight record ids for graph edges |

See `normalizeTeachableMoment` for defaults and sanitization (trims, array guards, id/createdAt synthesis).

### Hindsight Content Shape (A2A-DRAFT)

When writing via Hindsight:

```ts
{
  type: "teachable",
  moment: TeachableMoment
}
```

(See smoke test usage pattern in `scripts/hindsight-smoke-test.ts` which used `{ type: "teachable", name, detail }` — this schema supersedes the ad-hoc shape.)

## A2A Agent Card Mapping (A2A-DRAFT)

Per n5:

> wrap as skills[] entry `{id, name, description: body, tags}`; top-level card for authoring agent.

```ts
export function toAgentCard(
	tm: TeachableMoment,
	authoringAgent?: { id?: string; name?: string }
): A2AAgentCard;

export interface A2AAgentCard {
	id: string;
	name: string;
	// ...
	skills?: Array<{
		id: string;
		name: string;
		description: string; // = TeachableMoment.body
		tags: string[];
	}>;
	metadata?: { sourcePhase, createdAt, ... };
}
```

- One moment → one skill entry.
- Multiple moments → multiple skills in one card.
- Top level `id`/`name` identify the authoring agent (default `"claude-ultrathink"`).
- All A2A fields and extensions are **A2A-DRAFT**.

**A2A-DRAFT ambiguities flagged** (do not treat as stable):

- Is `skills` the correct top-level key, or `teachables`, `memories`, `capabilities`?
- Should `body` be under `description` or a nested `content` / `markdown`?
- Are `sourcePhase`, `relatedIds`, `sourceArtifacts` projected into the skill object, the card metadata, or omitted until confirmed?
- Versioning / card schema version field?
- How relations (via `relate()`) translate to A2A edges?
- Does the card wrap a single teachable or always represent the full agent profile?
- Exact serialization for transport (JSON, with frontmatter, etc.)?

Until the A2A spec lands, all mappings carry `// A2A-DRAFT` and `metadata._a2aDraft: true`.

## Example (Jev bug)

```ts
import { normalizeTeachableMoment } from "./src/teachable-moments/schema.ts";
import { toAgentCard } from "./src/teachable-moments/agent-card.ts";

const moment = normalizeTeachableMoment({
	name: "Claude-Ultrathink has 2 Bugs when integrating Jev",
	description: "Two distinct integration bugs surfaced when wiring Jev into Ultrathink flows.",
	body: "Bug 1: ... (detail). Bug 2: ... Root cause was missing ... in the mock path. See hindsight record X.",
	sourcePhase: "n5",
	sourceArtifacts: ["claude-ultrathink/src/integrations/hindsight-client.ts", "issues/mtdr51sm-[n5].md"],
	tags: ["bug", "integration", "jev", "ultrathink", "a2a-draft"],
	relatedIds: [],
});

const card = toAgentCard(moment, { name: "claude-ultrathink" });
// card.skills[0].description === moment.body
// card.metadata._a2aDraft === true
```

After normalize + write to (mock) Hindsight the record id can be stored in `relatedIds` of later moments or used for `client.relate()`.

## Usage (current, mock-only)

```ts
import { createMockHindsightClient } from "../src/integrations/hindsight-client.ts";
import { normalizeTeachableMoment } from "./schema.ts";
// (future: import { retainTeachableMoment } or similar — not wired yet)

const client = createMockHindsightClient();
const tm = normalizeTeachableMoment({ name: "...", ... });
const rec = await client.write({ content: { type: "teachable", moment: tm } });
```

## Open / Ambiguous (A2A-DRAFT + SPE-5104)

- Exact persistence contract between TeachableMoment and HindsightRecord.content (currently opaque `unknown`).
- Whether `normalize` should also validate (e.g. non-empty body) or stay permissive.
- How teachables participate in recall/reflect vs. being a distinct memory type.
- Cross-agent card exchange format and discovery (A2A protocol surface).
- Lifecycle: mutable? supersede via relate? TTL?
- UI / inspection surface for moments (future wave).

See also:
- `src/teachable-moments/schema.ts`
- `src/teachable-moments/agent-card.ts`
- hindsight-client docs and smoke test (uses mock exclusively for now)
- SPE-5104 workstream for full integration plan

**Do not implement wiring, real client, or production usage of A2A cards until ambiguities are resolved.**
