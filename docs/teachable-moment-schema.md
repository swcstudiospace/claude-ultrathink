# Teachable Moment schema

Schema version 2, as stored by `src/teach/types.ts`. One moment is one lesson. The local store is the source of truth; Hindsight is a copy of confirmed lessons. `teach export --a2a` prints an A2A-DRAFT Agent Card and nothing sends it.

## Record

```ts
export interface TeachableMoment {
	id: string;
	name: string;
	description: string;
	body: string;
	sourcePhase: string;
	sourceArtifacts: string[];
	createdAt: string; // ISO 8601 UTC
	tags: string[];
	relatedIds: string[];
	schema: 2;
	kind: "bug" | "pitfall" | "pattern" | "decision" | "playbook";
	status: "candidate" | "confirmed" | "promoted" | "superseded";
	origin: "explicit" | "observe" | "import";
	project: string;
	host: string;
	confidence: number; // 0..1; explicit captures are 1
	occurrences: number; // at least 1
	lastSeenAt: string;
	dedupeKey: string;
	recalled: number;
	supersedes?: string;
	retained?: { at: string; bank: string; documentId: string };
	promoted?: { at: string; skill: string; target: "hermes" | "omp" | "claude" | "drafts"; path?: string };
}
```

| Field | Required | What the code stores |
|---|---|---|
| `id` | yes | File name under the moments directory. `[A-Za-z0-9_.-]`, 1 to 80 characters, not `.` or `..`. |
| `name` | yes | One line, at most 120 characters, redacted before it is stored. |
| `description` | yes | One line, at most 300 characters. Empty is allowed. |
| `body` | yes | At most 2 400 characters. |
| `sourcePhase` | yes | Phase, graph node or issue. One line, at most 120 characters. Empty is allowed. |
| `sourceArtifacts` | yes | String array. Each item is one line, at most 300 characters. |
| `createdAt` | yes | ISO 8601 UTC of the first capture. A later capture of the same lesson does not replace it. |
| `tags` | yes | The moment's own tags, at most 40, each one line of at most 80 characters. Not the Hindsight tag list. |
| `relatedIds` | yes | Other moment ids. |
| `schema` | yes | Always `2`. A file whose `schema` is not `2`, or whose `id` is not the file name, is skipped. |
| `kind` | yes | `bug`, `pitfall`, `pattern`, `decision` or `playbook`. Capture defaults a missing kind to `pitfall`. |
| `status` | yes | `candidate` (found by `observe`, local only), `confirmed` (explicit capture, `teach confirm`, or auto mode), `promoted` (a skill was made), `superseded` (replaced). Status only moves up. |
| `origin` | yes | `explicit`, `observe` or `import`. |
| `project` | yes | Lowercase basename of the repository's primary checkout. Linked worktrees collapse onto that checkout. Outside a repository, the basename of the working directory, or `"unknown"`. |
| `host` | yes | Host that captured it first (`claude-code`, `grok-build`, `muse`, `hermes`, `omp`, or another string). |
| `confidence` | yes | `0..1`. Explicit captures are `1`. Observe defaults to `0.5` when the distiller omits it. |
| `occurrences` | yes | Times this lesson was captured under the same `dedupeKey`. At least 1. |
| `lastSeenAt` | yes | ISO 8601 UTC of the latest capture of this lesson. |
| `dedupeKey` | yes | First 32 hex characters of sha256 of `project\|kind\|normalized name`. The same key merges into one moment. |
| `recalled` | yes | Times this machine injected the lesson into a plan. The planner increments it; `teach recall` does not. |
| `supersedes` | no | Id of a moment this one replaces. |
| `retained` | no | Set once Hindsight confirmed the write: `at`, `bank`, `documentId` (`tm:<id>`). |
| `promoted` | no | Set when a skill was made: `at`, `skill`, `target`, optional `path`. |

Capture rejects an empty name or body (`TeachInputError`; the CLI exits 2). Every string is redacted before it is hashed, written or sent (`src/teach/redact.ts`).

## Local store

`openStore` (`src/teach/store.ts`) keeps one JSON file per moment at `<stateDir>/teach/moments/<id>.json`, and one JSON file per pending Hindsight write at `<stateDir>/teach/outbox/<id>.json`. `<stateDir>` is the host state directory (`resolveStateDir`), never `<cwd>/.planning` and never a repository working tree. `openStore` throws if its directory is under `.planning`.

Files are written to a temp file in the same directory and renamed, mode `0600`. The moments and outbox directories are created mode `0700`. Several processes can share the store without a lock; the worst case is one writer's update winning. A corrupt or foreign file is skipped.

A failed retain, delete or tag update is queued. Backoff starts at 1 minute and doubles, capped at 6 hours. `teach sync` drains due entries (at most 20 per call) and also retains confirmed or promoted moments that never reached Hindsight.

Skill drafts, when promotion writes one, go to `<stateDir>/teach/skill-drafts/<name>/SKILL.md` (file `0600`, directories `0700`). That file is a draft, not the moment record.

## Hindsight document

One document per moment. The id is `tm:<id>` (`documentIdFor`). Retain sends `update_mode: "replace"` and `async: false`, so the same id replaces the document. `ensureBank` sets the bank's `retain_extraction_mode` to `chunks` before the first retain. The key is sent only on `/v1/**`.

`contentFor` is `# <name>\n\n<description>\n\n<body>`, hard-capped at 3 000 characters. The description slot stays even when empty, so the text parses back. `chunks` mode stores that as one unit.

`tagsFor` always emits, after sanitizing:

- `ultrathink`
- `teachable`
- `project:<project>`
- `host:<host>`
- `kind:<kind>`
- `status:<status>`

then the moment's own tags. A tag is lowercased, characters outside `[a-z0-9:_.-]` become `-`, and it is cut at 40 characters. An own tag that starts with `project:`, `host:`, `kind:` or `status:` is dropped, so a moment cannot hide itself with `status:superseded`.

`metadataFor` is string metadata only:

| Key | Value |
|---|---|
| `tm_id` | moment id |
| `schema` | `tm/2` |
| `name`, `kind`, `status`, `origin`, `project`, `host` | those fields |
| `confidence`, `occurrences` | decimal strings |
| `created_at`, `last_seen_at` | ISO timestamps |
| `source_phase` | `sourcePhase` |
| `source_artifacts`, `related_ids` | JSON arrays |

Recall asks Hindsight for tags `ultrathink`, `teachable` and `project:<project>` (`project:*` omits the project tag), `tags_match: "all_strict"`. A hit tagged `status:superseded`, or whose metadata `status` is `superseded`, is not returned as a lesson. Candidates are not retained: they stay in the local file until confirmed.

The retain call's `context` is the fixed string `ultrathink teachable moment`.

## A2A export

Still a draft. `teach export --a2a [<id>...]` prints one Agent Card JSON (`src/teach/agent-card.ts`, `toAgentCardFromMoments`) and returns. Nothing posts it, and nothing discovers it.

With no ids, the card covers confirmed and promoted moments, newest first. Each moment becomes one `skills[]` entry: `id`, `name`, `description` set to `body`, and `tags` (the moment's own tags, or `["teachable", "a2a-draft"]` when it has none). The card's `metadata._a2aDraft` is `true`. The export passes the authoring name `ultrathink`; the card id defaults to `claude-ultrathink` inside `toAgentCard`. Empty input prints a placeholder skill `No teachable moments`.

The mapping is marked A2A-DRAFT in that module: top-level shape, whether `skills` is the right key, and which moment fields belong on the skill are not a stable protocol. Do not treat the printed card as something another system will accept.
