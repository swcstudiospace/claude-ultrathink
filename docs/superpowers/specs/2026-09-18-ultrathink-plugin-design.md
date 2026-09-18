# `ultrathink` plugin — design

**Date:** 2026-09-18
**Status:** Approved for implementation planning
**Author:** Claude (brainstormed with the repo owner)
**New repo:** `~/src/repos/claude-ultrathink` (does not exist yet — created by the implementation plan)

## Problem

This plugin (`omp-all-in-one`, this repo) already runs a Grok-4.6-driven pipeline —
**Prompt Uplift** (XML spec) → **Graph of Thought** (3–8 nodes) → **Chain of
Thought** per node → **HITL clarifications** — wired into Claude Code as a
`UserPromptSubmit`/`PostToolUse`/`Stop` hook trio (`src/uplift/`, `src/think/`,
`src/hitl/`, `hooks/*.ts`). Work is tracked locally: one Tissue markdown issue per
prompt plus one sub-issue per graph node under `issues/`, synced to a local `ktui`
Kanban board. That tracking is single-machine and invisible to anyone else.

Separately, the user already runs a real, populated Notion database — **🧩 Agent
Task Graph** (`collection://be3418f0-d2d8-411b-8677-fa8a95ee63be`, under page
`Agent Command Center`) — purpose-built for exactly this Task→Issue→Sub-Issue
shape, plus a Linear team (**Spectrum Web Co**, the only team in the
`swcstudiospace`/`swcstudio` workspace) that already backs the `github.autoPr`
org and `ktui boardName` defaults elsewhere in this repo's config. Neither is wired
to this plugin's pipeline yet.

The user wants a **new, standalone, Claude-Code-only plugin** (not an omp/pi
plugin with Claude support bolted on) that:

1. Reuses this pipeline's shape (uplift → GoT → CoT → HITL) but is engine-pluggable
   with **Claude as the default** Stage 1 engine, not Grok-only.
2. Writes every Task/Issue/Sub-Issue into the real Notion database and mirrors
   Issues/Sub-Issues as Linear issues/sub-issues, instead of local Tissue+ktui.
3. Becomes the **global** `~/.claude/CLAUDE.md` contract, so every project on this
   machine gets the same tracked workflow without per-project setup.
4. Stays a "preliminary hook and skill based plugin" — after kickoff, ordinary
   Claude Code behavior (subagents, skills, other plugins) is unchanged.

## Non-goals

- Replacing or touching this repo's own Tissue/ktui tracking, or the separate,
  already-approved **Notion PR tracking** design/plan in this repo
  (`docs/superpowers/specs/2026-09-16-notion-pr-tracking-design.md`,
  `docs/superpowers/plans/2026-09-16-notion-pr-tracking.md`). That work is scoped
  to *this* repo's own PR-creation flow, provisions its own simple "PRs" database,
  and deliberately uses a **direct Notion REST client with an integration token**
  (not MCP) because a hook subprocess cannot reach the interactive OAuth MCP
  connector. `ultrathink` is a different, standalone plugin, targeting the
  existing Agent Task Graph database, with no dependency between the two.
- Building a generic "sync any Notion/Linear workspace" capability. Defaults point
  at the specific database/team above; both are config-overridable per project,
  but the shipped default is this workspace.
- The Grok proxy / Haiku-tier rerouting (`src/grok/proxy.ts`, `src/grok/sse.ts`),
  the omp/pi TUI chrome, Live LSP, and Pod boot. None of that is Claude-Code-native
  or relevant to this plugin's purpose.
- Two-way sync (editing Notion/Linear does not write back into the session state
  or change what Claude does mid-turn).
- The plugin polling Linear as a work queue. Linear/Notion are written *to* as a
  record of what Claude is doing; they are not read back as the source of what to
  work on next.

## Key architectural constraint

**Hooks have no MCP client access.** A `UserPromptSubmit`/`PostToolUse`/`Stop`
hook is a detached subprocess reading stdin/writing stdout — it can shell out, hit
plain HTTP APIs, and read/write local files, but it cannot call `notion-*` or
Linear MCP tools; those only exist inside the agent's own tool-calling loop. This
is the same wall the existing Notion-PR-tracking plan in this repo hit (see its
"Notion auth" decision row) — that plan's answer was to give the *hook* its own
REST credentials. Because the user's requirement here is specifically "Claude Code
can then create/update Linear Issues and Sub-Issues, while also writing the
corresponding rows to Notion" **via the Notion/Linear MCP servers**, this plugin
answers the same constraint the other way: hooks only prepare state and inject
instructions; a **skill**, running inside the agent's own turn, makes the actual
MCP calls.

## Architecture

### Repo layout (`~/src/repos/claude-ultrathink`)

```
.claude-plugin/plugin.json         # plugin id "ultrathink"
.claude-plugin/marketplace.json    # local marketplace, mirrors this repo's pattern
package.json / tsconfig.json       # Bun + TypeScript, bun test, bun run check
hooks/
  hooks.json
  uplift.ts        # UserPromptSubmit
  answers.ts        # PostToolUse (AskUserQuestion) — HITL answer capture
  pr-sync.ts         # PostToolUse (PR-creation tools) — nudge ultrathink-sync
  stop.ts            # Stop — final nudge if a tracked Task never synced to done
skills/
  ultrathink-kickoff/SKILL.md
  ultrathink-sync/SKILL.md
src/
  engine/            # Stage 1 engine abstraction
    types.ts          # Engine interface: complete(prompt, opts) -> string
    claude.ts          # default: headless `claude -p` call
    grok.ts             # optional: ported from src/grok/{auth,complete}.ts
  uplift/             # ported from this repo's src/uplift/, engine-injected
  think/               # ported from this repo's src/think/ (graph.ts, pipeline.ts, prompts.ts)
  hitl/                # ported from this repo's src/hitl/
  track/               # NEW — Notion/Linear field mapping + call-plan builder
    types.ts            # TaskRow, IssueRow, SubIssueRow, TrackPlan
    plan.ts              # build a TrackPlan from an uplift+graph+HITL result
    state.ts             # read/write ~/.claude/ultrathink/<sessionId>/state.json
  config.ts             # layered config, mirrors this repo's src/config.ts pattern
  claude/               # hook plumbing ported from this repo's src/claude/
scripts/
  setup.ts             # apply/status/rollback — mirrors this repo's scripts/claude-setup.ts
docs/superpowers/{specs,plans}/
```

### Stage 1 engine abstraction

```ts
export interface Engine {
  complete(prompt: string, opts: { maxTokens?: number; timeoutMs?: number }): Promise<string>;
}
```

- `engine.claude.ts` (default): spawns `claude -p <prompt> --output-format json`
  (or the equivalent Agent SDK call) on a configurable model
  (`engine.claude.model`, default `sonnet`). No proxy, no OAuth session beyond the
  user's own `claude` login.
- `engine.grok.ts` (optional, `engine.default: "grok"`): ports `src/grok/auth.ts` +
  `src/grok/complete.ts` (the SuperGrok OAuth session reader + `/responses` caller)
  from this repo, dropping the local HTTP proxy (`proxy.ts`/`sse.ts`) entirely —
  that piece exists only to reroute this repo's own Haiku-tier traffic and has
  nothing to do with `ultrathink`'s job.

`src/uplift/`, `src/think/`, `src/hitl/` take an `Engine` as a constructor
argument instead of calling Grok directly, otherwise their logic, prompts, and
test shape carry over unchanged.

### Hook flow

**`hooks/uplift.ts`** (`UserPromptSubmit`) — ports `hooks/uplift.ts` +
`src/claude/hook.ts` from this repo, same skip heuristics (slash commands, trivial
acknowledgements, `raw:` prefix, already-uplifted XML, child-session env var). For
a prompt that proceeds:

1. Call the configured engine for uplift XML + Graph of Thought + per-node Chain
   of Thought + HITL questions (identical shape to today's pipeline).
2. Build a `TrackPlan` (`src/track/plan.ts`) — the exact ordered list of
   Notion/Linear operations the kickoff skill must perform, as structured data,
   not prose (see "Notion field mapping" below).
3. Write `{ specXml, graph, hitl, trackPlan }` to
   `~/.claude/ultrathink/<sessionId>/state.json`.
4. Show the transcript card (same UX as today's `Prompt Uplift · ROOT · source`).
5. Inject `additionalContext` instructing Claude: *"Before starting work, invoke
   the `ultrathink-kickoff` skill with `stateFile=<path>`."*
6. Fail-open exactly like today: any engine failure → conservative fallback XML,
   original prompt passes through unchanged, tracking silently skipped.

**`skills/ultrathink-kickoff/SKILL.md`** — reads `stateFile`, then, in order:

1. Query the Agent Task Graph data source for an existing row whose `Graph ID`
   equals this run's work-unit id (idempotency key, generated once in
   `hooks/uplift.ts` and carried in the state file — same role as this repo's
   `<!-- aio-id: ... -->` marker, just stored as a real property instead of a
   markdown comment). If found, update in place; otherwise create.
2. Create/update the **Task** row (see field mapping).
3. For each Graph-of-Thought node: create a Linear issue (`save_issue`, team
   Spectrum Web Co) and the matching Notion **Issue** row, `Parent Item` → Task
   page, `Linear URL`/`Issue ID` filled from the Linear result.
4. For each Chain-of-Thought step under a node: create a Linear sub-issue
   (`parentId` = that node's Linear issue) and the matching Notion **Sub-Issue**
   row, `Parent Item` → Issue page, `Step` = index, `Thought` = step text.
5. HITL: non-blocking questions proceed with their recommended default (state the
   assumption in the transcript); blocking questions go through exactly one
   `AskUserQuestion` call with the given headers/options; the recorded answers are
   appended into the Task's `Uplifted Prompt` text as `<ANSWER source="user">`.
6. Set `Status` → `Planning`, `Linear State` → `Todo`, `Started` → now.
7. Emit the **final task prompt**: the uplifted XML plus an `<ISSUES>` block
   (same mechanic as this repo's already-approved `<ISSUES>` XML tag design —
   reused, not reinvented) cross-referencing every created Notion page and Linear
   issue identifier.
8. From here, Claude treats that final prompt as the actual task and proceeds
   exactly as it would for any other request — dispatching wave subagents,
   invoking other skills and plugins, nothing further is `ultrathink`-specific.

**`hooks/pr-sync.ts`** (`PostToolUse`, matcher on GitHub PR-creation tools) and
**`hooks/stop.ts`** (`Stop`, only when state shows an un-synced tracked Task) both
inject a nudge to invoke `ultrathink-sync` — they never write to Notion/Linear
themselves, same constraint as above.

**`skills/ultrathink-sync/SKILL.md`** — small, idempotent update (never a create):
given the tracked Task's `Graph ID` (or a fallback lookup by `Branch`), sets
`PR URL`, `PR #`, `Repo`, `Branch`, `Checks`, `Reviewers`, `Completed`, and moves
`Status`/`Linear State` forward (`Implementing` → `In Review` → `Done`/`Merged`),
mirroring the same transition onto the actual Linear issue state via
`save_issue`.

**`hooks/answers.ts`** (`PostToolUse` on `AskUserQuestion`) — ported as-is from
this repo: captures answers into the session state file so a re-entrant turn in
the same session never re-asks; the next `ultrathink-kickoff`/`ultrathink-sync`
invocation is what actually pushes an answer into Notion, not the hook.

### Notion field mapping

Against the real schema (`collection://be3418f0-d2d8-411b-8677-fa8a95ee63be`,
confirmed live — richer than a from-scratch design would guess, and already
shaped for exactly this Task/Issue/Sub-Issue/GoT/CoT hierarchy):

| Row level | `Level` | Key fields set |
|---|---|---|
| Task (one per uplifted prompt) | `Task` | `Item` (title), `Description`, `Uplifted Prompt` (full XML), `Agent` = `"claude-code"`, `Status`, `Linear State`, `Repo`, `Branch`, `Graph ID` (idempotency key), `Model`, `Started`/`Completed` |
| Issue (one per GoT node) | `Issue` | `Item`, `Parent Item` → Task page, `Thought` (node conclusion), `Linear URL`, `Issue ID`, `Issue Type`, `Graph ID` |
| Sub-Issue (one per CoT step) | `Sub-Issue` | `Item`, `Parent Item` → Issue page, `Step`, `Thought`, `Linear URL` |
| (sync-time, Task only) | — | `PR URL`, `PR #`, `Checks`, `Reviewers`, `PR State`, `Confidence`, `Files Touched`, `Additions`/`Deletions`, `Duration (s)`, `Tokens`, `Tool`, `Model` |

`Status` is a Notion **status** property (grouped `to_do`/`in_progress`/
`complete`) with existing options that already match this pipeline's states
(`Backlog`/`Queued` → `Planning`/`Implementing`/`Running` → `Done`/`Merged`/
`Failed`) — no new options need to be added to the database.

### Linear mapping

- Team: `Spectrum Web Co` (config `linear.team`, default this team — it is the
  only team in the workspace and already matches this repo's `github.org`/
  `ktui.boardName` defaults).
- One Linear **issue** per GoT node (title = node summary, description = node
  thinking/conclusion).
- One Linear **sub-issue** per CoT step (`parentId` = that node's issue).
- `ultrathink-sync` mirrors `Status`/`Linear State` transitions onto the Linear
  issue's workflow state.

### Root `CLAUDE.md`

`scripts/setup.ts apply` merges a marked block
(`<!-- ultrathink:start -->` … `<!-- ultrathink:end -->`, so re-running `apply`
updates in place rather than duplicating) into the **global**
`~/.claude/CLAUDE.md`. Content: the database URL/data source id, the exact
property table above, and "invoke `ultrathink-kickoff`/`ultrathink-sync`" instead
of prose — the skills *are* the workflow logic the current draft CLAUDE.md text
tried to describe by hand.

`apply` also runs, idempotently:

```bash
claude mcp add --transport http --scope user notion https://mcp.notion.com/mcp
claude mcp add --transport http --scope user linear https://mcp.linear.app/mcp
```

(Linear's endpoint confirmed as `/mcp`, streamable HTTP — its `/sse` endpoint is
being retired.) Then installs the plugin marketplace, same
backup/record-previous-state/`rollback`/`rollback --snapshot` pattern as this
repo's `scripts/claude-setup.ts`.

### Config

`~/.claude/ultrathink.json`, project override at `<project>/.claude/ultrathink.json`
(later wins) — same layered pattern as this repo's `all-in-one.json`:

```json
{
  "engine": { "default": "claude", "claude": { "model": "sonnet" }, "grok": { "enabled": false } },
  "think": { "minNodes": 3, "maxNodes": 8 },
  "hitl": { "maxQuestions": 4 },
  "notion": { "dataSourceUrl": "collection://be3418f0-d2d8-411b-8677-fa8a95ee63be" },
  "linear": { "team": "Spectrum Web Co" },
  "trigger": { "enabled": true, "skipTrivial": true }
}
```

### Idempotency

`Graph ID` (a generated work-unit id, one per uplifted prompt) is the single
dedup key, set on the Task row and echoed onto every Issue/Sub-Issue row it owns.
`ultrathink-kickoff` always queries by `Graph ID` before creating; a re-run in the
same session (or a retried turn) updates in place. This replaces this repo's
`<!-- aio-id: ... -->` markdown-comment convention with a real, queryable Notion
property — cleaner given Notion is now the source of truth instead of a local
file.

### Testing

Same convention as this repo: `*.test.ts` beside each module, `bun:test`,
injected fakes, no live network calls. `src/track/plan.test.ts` validates the
*plan* objects `ultrathink-kickoff` will act on (field mapping, idempotency key
generation, HITL default-vs-blocking split) — it cannot exercise the actual MCP
calls, since those only happen inside a running Claude Code agent turn executing
the skill, not inside `bun test`. `src/engine/`, `src/uplift/`, `src/think/`,
`src/hitl/` port this repo's existing test suites, adjusted for the `Engine`
injection point.

### Error handling

Fail-open throughout, matching this repo's stated philosophy: an engine failure,
a missing MCP connection, or any tool error inside a skill invocation must never
block the user's actual coding session — worst case, a turn proceeds untracked
(no Notion/Linear rows) with the same conservative XML fallback this repo already
uses today.

## Open items for the implementation plan

- Confirm the exact headless-`claude -p` invocation shape (flags, JSON output
  parsing) to use as the default engine — this repo's `src/grok/complete.ts` and
  `src/claude/complete.ts` are the closest existing references.
- Confirm Claude Code's current skill-invocation mechanics for "instruct the agent
  to call skill X with argument Y from hook `additionalContext`" — verify against
  current Claude Code docs at implementation time, not assumed from this design.
- Decide whether `ultrathink-kickoff`'s Notion "find existing Task by Graph ID"
  step uses `notion-query-data-sources` (SQL/rows mode) or `notion-ai-search` —
  pick whichever the target Claude Code environment's Notion MCP exposes most
  reliably; both are visible in the current session's tool list.
- Confirm the plugin marketplace/id naming (`ultrathink@ultrathink` vs. matching
  this repo's `all-in-one@aio` convention) at scaffold time.
