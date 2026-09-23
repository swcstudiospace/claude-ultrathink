# Architecture Research

**Domain:** Hermes host bridge onto the existing TypeScript ultrathink engine
**Researched:** 2026-09-24
**Confidence:** HIGH

The TypeScript pipeline stays the planner. Hermes does not get a second uplift, graph, HITL, or track-plan implementation. A Python `pre_llm_call` hook spawns one Bun process, that process runs the existing `runPromptSubmit` path and writes the existing `SessionRecord`, and a plugin skill — not the hook — does Notion, Linear, and blocking questions.

Do not plan this as layers (protocol, then adapter, then skill, then trackers). The roadmap should be three end-to-end slices. Each slice crosses the process boundary and is usable on its own. Slice 2 depends on the session file slice 1 already writes. Slice 3 does not need more TypeScript.

## Standard Architecture

### System Overview

```
┌──────────────────────────────────────────────────────────────────────────┐
│ Hermes host (Python plugin, fail-open, no MCP)                          │
│                                                                          │
│  pre_llm_call          transform_tool_result         pre_verify          │
│  spawn engine once     append PR-sync nudge          coding-stop nudge   │
│  append user context   (regex only, same turn)       (read JSON, return) │
│         │                        │                          │            │
│         │ pointer only           │ pointer only             │ pointer    │
└─────────┼────────────────────────┼──────────────────────────┼────────────┘
          │ JSON stdin/stdout      │                          │
          ▼                        │                          │
┌──────────────────────────────────────────────────────────────────────────┐
│ Callable engine entry  hooks/engine.ts  (new; does not replace uplift)  │
│  select engine → runPromptSubmit → write SessionRecord → JSON result    │
│  Claude Code hooks/uplift.ts stays on its own stdin protocol             │
└─────────┬────────────────────────────────────────────────────────────────┘
          │ calls, does not reimplement
          ▼
┌──────────────┬──────────────┬──────────────┬─────────────────────────────┐
│ src/uplift/  │ src/think/   │ src/hitl/    │ src/track/plan.ts           │
│ decide · run │ graph · CoT  │ questions    │ TrackPlan (no MCP)          │
└──────────────┴──────┬───────┴──────────────┴─────────────────────────────┘
                       │ injectable Completer (claude -p | grok http/cli/shunt)
                       ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ Session files   $HERMES_HOME/ultrathink/sessions/<sessionId>.json|.xml   │
│ One record per Hermes session. This file is the only plan payload.      │
└─────────┬────────────────────────────────────────────────────────────────┘
          │ skill reads; skill writes answers, kickedOff, synced
          ▼
┌──────────────────────────────────────────────────────────────────────────┐
│ Plugin skills (agent turn, the only MCP writers)                        │
│  prompt-uplift:ultrathink-kickoff   Notion + Linear + clarify + ISSUES  │
│  prompt-uplift:ultrathink-sync      PR URL + status on existing rows    │
└──────────────────────────────────────────────────────────────────────────┘
          │
          ▼
   Notion Agent Task Graph          Linear team Spectrum Web Co
   (same data source as Claude)     (same team as Claude)
```

Data moves down that diagram. The only upward write is the skill patching the session file (answers, `kickedOff`, `synced`). The hook never reads a plan back out of Notion. The engine never calls the skill. The skill never calls the engine.

### Component Responsibilities

| Component | Responsibility | Typical implementation |
|-----------|----------------|------------------------|
| Hermes plugin entry | Register hooks and the two skills. Own slash toggles. Fail-open around every callback. | `hermes-plugin/__init__.py` `register(ctx)` only |
| Host skip gate | Skip before paying for Bun: `parent_session_id` set, `platform=cron`, empty/non-text user message. Do not reimplement slash/trivial/already-uplifted detection. | Small function in `prompt_uplift/hook.py` |
| Bridge spawner | One Bun subprocess per kept prompt. Kill it on the hook budget. Parse one JSON object from stdout. Return `{"context": ...}` or `None`. | `prompt_uplift/bridge.py`. No Hermes imports, so pytest stays hermetic |
| Engine entry | Host adapter only. Map a JSON request onto `runPromptSubmit`. Select the existing Claude or Grok completer. Write session files. Print a JSON result. Always exit 0. | New `hooks/engine.ts`. Does not speak Claude Code hook JSON |
| Existing pipeline | decide → uplift → think → clarify → `buildTrackPlan` → persist. Unchanged. | `src/claude/hook.ts` and `src/{uplift,think,hitl,track}/` |
| Completer | The only LLM seam. Hermes `ctx.llm` is not a completer for this bridge. | `createClaudeCompleter` / `createGrokCompleter`, chosen once in the entry |
| Session file | Contract between the entry and the skills. Same `SessionRecord` Claude already writes. | `src/claude/state.ts`. Directory overridden with `ULTRATHINK_STATE_DIR` |
| Kickoff skill | Find-or-create by Graph ID. One Linear issue and Notion Issue per node. One sub-issue per Chain-of-Thought step. One `clarify` batch for blocking questions. Emit `<ISSUES>`. Fail-open if MCP is down. | `hermes-plugin/skills/ultrathink-kickoff/SKILL.md`, registered, not copied into `~/.hermes/skills/` |
| Sync skill | Update PR URL and status on the existing task row and Linear issue. Never create rows. | `hermes-plugin/skills/ultrathink-sync/SKILL.md` |
| PR nudge | Same-turn stand-in for Claude `hooks/pr-sync.ts`. Append a sync instruction to a tool result. Never call MCP. | `transform_tool_result`, Python port of the two `src/track/pr-detect.ts` regexes |
| Stop nudge | Same-turn stand-in for Claude `hooks/stop.ts` on coding turns, plus a next-turn reminder if `synced` is still false. | `pre_verify` when a plan exists; next `pre_llm_call` reads the same file |
| Control file | Host toggles (`enabled`, `skipOnce`, `thinkEnabled`, `hitlEnabled`). Same schema as Claude, different directory, so the two hosts do not fight. | `$HERMES_HOME/ultrathink/control.json` |
| Shared config | Engine, Notion data source, Linear team. Read-only from the Hermes side. | `~/.claude/ultrathink.json` plus `<cwd>/.claude/ultrathink.json`, already loaded by `loadConfig` |

What each side must not own:

- The hook does not call Notion, Linear, `hermes kanban`, or write `.planning/`.
- The pipeline does not learn Hermes types, skill names, or MCP tool names.
- The skill does not rebuild a graph, split rationale steps, or call Bun.
- Python uplift / Graph-of-Thought / `ctx.llm.complete` is not a fallback. A down engine means the prompt proceeds unplanned.

## Recommended Project Structure

```
claude-ultrathink/                      # planning root; TypeScript product commits land here
├── hooks/uplift.ts                     # unchanged Claude Code UserPromptSubmit entry
├── hooks/engine.ts                     # new Hermes callable entry (stdin JSON, stdout JSON, exit 0)
├── src/claude/hook.ts                  # runPromptSubmit — called, not rewritten
├── src/claude/state.ts                 # SessionRecord + ULTRATHINK_STATE_DIR
└── skills/ultrathink-*/SKILL.md        # Claude Code skills stay; Hermes does not import them

hermes-plugin/                          # Python product commits; git root is /root/src/repos
├── plugin.yaml                         # declare pre_llm_call, transform_tool_result, pre_verify
├── __init__.py                         # register(ctx), skill registration, slash commands
├── prompt_uplift/bridge.py             # subprocess + timeout + stdout parse
├── prompt_uplift/hook.py               # host skips; calls bridge; no kanban, no gsd, no ctx.llm
└── skills/
    ├── ultrathink-kickoff/SKILL.md     # ctx.register_skill("ultrathink-kickoff", ...)
    └── ultrathink-sync/SKILL.md
```

Delete from the hot path in the first slice, not behind a flag: `hermes_kanban_create`, `write_gsd_milestone`, the `/gsd` command, the `/issues` Kanban command, and the `ctx.llm` uplift/think completers. Leaving them callable means the next prompt can still clobber a repo.

### Structure Rationale

- **`hooks/engine.ts` next to `hooks/uplift.ts`:** Both are host edges. The pipeline stays in `src/`. A `src/hermes/` package that imported stages would invert the dependency DAG (`src/types.ts` ← uplift ← think ← hitl ← track ← `src/claude/` ← hooks).
- **Skill text lives in `hermes-plugin/skills/`, not in the TypeScript repo and not in `~/.hermes/skills/`:** Hermes loads plugin skills only through `ctx.register_skill`. They resolve as `prompt-uplift:ultrathink-kickoff`. Copying into `~/.hermes/skills/` collides with a bare name and is the legacy path the plugin guide tells you not to use.
- **`bridge.py` has no Hermes import:** Same rule the current plugin already uses so pytest can call the hook without a live agent.
- **Two git roots, one process boundary:** Planning docs commit in `claude-ultrathink`. Python edits commit in `/root/src/repos`. The JSON stdin/stdout contract is what lets those land separately after slice 1. Do not `git init` inside `hermes-plugin`.

## Architectural Patterns

### Pattern 1: One-shot engine process, existing orchestrator

**What:** Hermes does not call `hooks/uplift.ts`. That entry expects Claude Code hook JSON, a JSONL `transcript_path`, and it writes `{ hookSpecificOutput.additionalContext, systemMessage }`. Hermes has `conversation_history`, no transcript file, and no `systemMessage` channel. A sibling entry reads a small request, calls `runPromptSubmit`, and prints a host-neutral result.

**When to use:** The first slice. This is the callable engine entry the milestone is allowed to add. It is not a redesign of decide / uplift / think / clarify / plan.

**Trade-offs:** One extra file and a stable stdout schema. In return the Claude hook protocol stays untouched, and Hermes conversation text is passed through the existing `HookDeps.conversation` seam (a function that ignores `transcript_path` and returns the clipped Hermes history). Cost is process spawn plus the pipeline's own LLM time. That cost is the point: the trusted completer runs, not `ctx.llm`.

**Request (stdin, one JSON object):**

```json
{
  "session_id": "<hermes session_id>",
  "prompt": "<text extracted from user_message>",
  "cwd": "<session cwd>",
  "conversation": "<clipped conversation_history text>"
}
```

**Result (stdout, one JSON object, logs on stderr only, exit 0 always):**

```json
{
  "skipped": null,
  "context": "<spec XML and addenda, no Claude skill sentence>",
  "summary": "Prompt Uplift · BUILD_PROMPT · llm · Graph of Thought · 5 nodes",
  "statePath": "<abs sessions/<id>.json>",
  "specPath": "<abs sessions/<id>.xml>",
  "graphId": "ut-…",
  "source": "llm",
  "hasPlan": true
}
```

`context` comes from `formatPromptContext` **without** `statePath`, so the hardcoded Claude sentence ("invoke the ultrathink-kickoff skill") is not copied. Python appends the Hermes sentence. The entry sets `stateDir` from `ULTRATHINK_STATE_DIR` (the spawner exports `$HERMES_HOME/ultrathink`) and does not read `~/.claude/ultrathink/control.json`.

Spawn with the session cwd, not the plugin directory, so `resolveRepoSlug` / `resolveBranch` see the repo the user is in. Set `ULTRATHINK_CHILD` is already done inside `createClaudeCompleter`; do not also skip the engine entry on that variable or a Hermes-spawned Bun would no-op. The child guard stays on the Claude hook only.

### Pattern 2: Session file is the payload; context is a pointer

**What:** The plan the skill needs is already `SessionRecord` (`src/claude/state.ts`). The hook injects a path and an instruction. It does not copy the `TrackPlan` into `ctx.state`, and it does not make the skill parse the uplift XML.

**When to use:** Every kept prompt that produced a non-fallback plan. Fallback runs (`source: "fallback"`) still inject spec XML if the engine produced it, but `hasPlan` is false and Python must not append a kickoff instruction. That preserves the existing guard in `runPromptSubmit`: no `TrackPlan` from fallback output, so a down engine does not mint generic Issue rows.

**Trade-offs:** The agent must `read_file` the state path. That is more reliable than hoping a 90k spec survives Hermes injection. `pre_llm_call` context spills at `hooks.output_spill.max_chars` (default 10_000) to `$HERMES_HOME/hook_outputs/...` and the model sees a head/tail preview (default 500 + 500). Graph XML usually exceeds 10k. Put the skill instruction last so the tail preview still contains the path. Also raise the spill cap when enabling the plugin — convenience, not the contract. The contract is the file.

Hermes tracking tail, appended by Python only when `hasPlan` is true, and always the last block:

```text
## Ultrathink tracking

Before any other work, call skill_view(name="prompt-uplift:ultrathink-kickoff") and follow it with stateFile=<statePath>. It records the Task, one Issue per graph node, and one Sub-Issue per Chain-of-Thought step, asks blocking questions with clarify, and returns an ISSUES block. Do not start the work before it returns. If the skill, Notion, or Linear is unavailable, proceed with the specification anyway.
```

Plugin skills are not in the system-prompt `<available_skills>` index (`PluginContext.register_skill` docstring, and the plugin guide). A bare "invoke ultrathink-kickoff" will not load. The injected text must name `skill_view` and the qualified name `prompt-uplift:<skill>`. Do not register a system-prompt section for this: sections freeze at session start, cap at 4_000 characters, and cannot carry the current `stateFile`.

### Pattern 3: Skill writes MCP; hooks only nudge

**What:** Same split Claude already has. `hooks/pr-sync.ts` and `hooks/stop.ts` emit a nudge and never call Notion. Hermes has no `systemMessage` and `post_tool_call` / `post_llm_call` / `on_session_end` ignore return values, so the nudge channels are different. The write still happens only inside the skill, on the agent turn, where MCP tools exist.

**When to use:** Slice 2 (kickoff) and slice 3 (sync).

**Trade-offs:** Tracking depends on the model actually loading the skill. The Claude plugin has the same dependency, plus hook nudges. Hermes compensates with an explicit `skill_view` call in the user-message tail, a same-turn tool-result suffix on PR create, and a `pre_verify` continue-message when a coding turn is about to finish with an unsynced plan. That is as close as the hook catalog gets. It is not a guarantee. MCP failure must not block the prompt — the Hermes skill diverges from the Claude kickoff line "writes must actually happen" and instead matches the milestone fail-open rule.

Host mapping, do not paper over:

| Claude | Hermes | Direction |
|--------|--------|-----------|
| `UserPromptSubmit` additionalContext | `pre_llm_call` return `{"context": ...}` appended to the user message | hook → model, once per turn |
| `AskUserQuestion` (one batched call) | `clarify` tool `questions=[...]` (batch cap 5; blocking set is already ≤ 4) | skill → user, during the turn |
| `PostToolUse` systemMessage on `gh pr create` | `transform_tool_result` appends a sync sentence; original result kept as the prefix | tool result → model, same turn |
| `Stop` systemMessage | `pre_verify` `{"action":"continue","message":...}` when code was edited and a plan exists; plus next `pre_llm_call` if `synced` is still false | nudge → model |
| answers hook folds `AskUserQuestion` into the session file | skill writes `clarifications[].answer` into the same file before it finishes | skill → session file → next engine read |

`pre_verify` fires only when the agent edited code and is about to verify or finish (`VALID_HOOKS` comment in `hermes_cli/plugins.py`). A research turn that never edits code will not get that nudge. The next-turn `pre_llm_call` reminder covers continuation. A session that ends without another message cannot be synced from `on_session_end` without the hook calling MCP, which is locked out. Accept that gap. Do not "fix" it by writing Notion from the hook.

`transform_tool_result` and `pre_verify` are timeout-bounded hot-path hooks. They read the session file and return. They do not spawn Bun.

PR detection matches Hermes tool names, not Claude's `Bash`. Append the nudge when the tool arguments contain `gh pr create` or the result text contains `https://github.com/<owner>/<repo>/pull/<n>`. A false positive only nudges. Port the two regexes; do not shell out to `src/track/pr-detect.ts` on the tool path.

### Pattern 4: Fail-open at the host edge, including the timeout

**What:** Every Python callback is `try/except → log → None` (or, for a transform, the original string). The engine entry ends in `main().catch(() => process.exit(0))`, matching the Claude hooks. A missing `bun`, a missing `engine_root`, invalid stdout, a non-zero spawn, or a skip all return `None` from `pre_llm_call`. The user message still runs.

**When to use:** Always. This is a milestone constraint, not an error-handling preference.

**Trade-offs:** The operator sometimes gets an unplanned turn. That is better than a blocked prompt. Do not inject a synthetic plan to hide the miss. Log the one-line `summary` (Hermes has nowhere to put Claude's `systemMessage`). A Grok-login-required skip may inject a single sentence so the miss is visible; it must not include a kickoff instruction.

Timeout is the sharp edge. `plugins.hook_callback_timeout` defaults to 30 seconds, clamps above 600, and `0` disables it (`hermes_cli/config_defaults.py`, `web_server_config.py`). `pre_llm_call` is on the bounded-hook allowlist (`hermes_cli/plugins_dispatch.py`). A callback that exceeds the cap is abandoned without joining, the injection is skipped, that callback is suppressed for 60 seconds, and a fourth abandoned worker is skipped outright. A full graph fill (uplift + graph + per-node CoT + clarify, each a `claude -p` or Grok call) will blow past 30 seconds and can blow past 600.

**Required host setting:** `plugins.hook_callback_timeout: 0` on the Hermes profile that runs this plugin. 600 is not enough and still trips suppression. The cap is process-wide, not per plugin — say that in the slice 1 notes so nobody "fixes" a slow turn by lowering it. The spawner still kills its own child if it wants a local budget (`config.claude.budgetMs` already aborts `runPromptSubmit`). Killing the child is what stops an abandoned worker from writing `sessions/<id>.json` after the agent has started the turn without a plan. If Hermes abandons the callback anyway, the late file is an orphan: the next turn must not scan for it and must not inject it. Key the file by `session_id` only, same as Claude (one `SessionRecord` per session, latest prompt wins).

## Data Flow

### Request flow

```
User message
    ↓
pre_llm_call
    ↓ host skips?  → return None (child session, cron, no text)
    ↓
Bun hooks/engine.ts                         # one direction: request in, result out
    ↓
decideUplift → runUplift → runThink → runClarify → buildTrackPlan
    ↓                         ↓
    ↓                    Completer (claude | grok)   # engine → model, not Hermes ctx.llm
    ↓
write sessions/<id>.json + .xml + last.json          # engine → disk
    ↓
stdout { context, statePath, hasPlan, graphId, summary }
    ↓
Python appends skill_view tail iff hasPlan
    ↓
Hermes appends context to this turn's user message   # not the system prompt, not persisted as the user bubble
    ↓
Agent calls skill_view("prompt-uplift:ultrathink-kickoff")
    ↓
Skill reads stateFile                                # disk → skill
    ↓
Notion + Linear MCP writes                           # skill → trackers, keyed by Graph ID
    ↓
clarify(questions=blocking)                          # skill → user; defaults if the tool is missing
    ↓
Skill writes answers + kickedOff=true back to stateFile
    ↓
Skill emits uplifted prompt + <ISSUES>
    ↓
Agent does the work
    ↓
PR tool result → transform_tool_result appends sync nudge
    ↓
skill_view("prompt-uplift:ultrathink-sync") → updates existing rows → synced=true on the file
```

### State management

```
$HERMES_HOME/ultrathink/control.json     slash commands ↔ engine entry (toggles only)
$HERMES_HOME/ultrathink/sessions/<id>.json
        ↑ written by engine entry (full SessionRecord, kickedOff=false, synced=false)
        ↑ patched by kickoff skill (clarifications[].answer, kickedOff)
        ↑ patched by sync skill (synced)
        ↓ read by kickoff, sync, pre_verify, next pre_llm_call reminder

~/.claude/ultrathink/                    not used by Hermes
ctx.state                                not the plan store; do not mirror TrackPlan here
```

One session id, one JSON file, overwritten on the next non-skipped prompt. Sync always targets `plan.graphId` in that file, which is the latest plan. Earlier graphs in the same Hermes session remain in Notion under their own Graph IDs; this bridge does not keep a history index. That matches Claude. Do not add per-turn files in v1.

`kickedOff` is not a "skip the next prompt" flag. The next real prompt overwrites the record with `kickedOff: false`. Graph ID idempotency inside the skill is what makes a retried kickoff of the same plan safe.

Answers must be written back by the skill. Hermes has no `PostToolUse` answers hook. The next `runPromptSubmit` already keeps answered clarifications from `readSession` and will re-ask anything left unanswered.

### Key data flows

1. **Plan flow (down only):** user text → engine entry → pipeline → `SessionRecord` on disk → path in injected context → skill reads file → MCP creates rows. The skill does no string splitting; `plan.issues`, `plan.subIssues`, `plan.linearIssues`, and `plan.linearSubIssues` are the rows.
2. **Pointer flow (down only):** engine stdout `statePath` / `graphId` → Python tail → model. If spill hides the XML, the path in the tail is sufficient.
3. **Answer flow (skill back to disk, then engine reads next turn):** `clarify` results → `clarifications[].answer` on the session file. Not via a Hermes hook.
4. **Sync flow (nudge down, write only in the skill):** PR result or `pre_verify` or next-turn reminder carries `graphId` → sync skill → Notion/Linear update → `synced: true`. Hooks do not observe the MCP result.
5. **Toggle flow (shared file, not Claude's file):** `/uplift` and `/think` write `$HERMES_HOME/ultrathink/control.json`. The engine entry `readControl`s that directory because `ULTRATHINK_STATE_DIR` points there. `skipOnce` clears inside `runPromptSubmit` as it does today.
6. **Config flow (read-only, shared with Claude):** `loadConfig(claudeConfigPaths(cwd))` inside the engine entry. Hermes does not keep a second copy of the Notion data source or Linear team. Override still works via `<cwd>/.claude/ultrathink.json`.

## Build order

Three slices. Each is a vertical cut the operator can run. Do not insert a "schema phase", a "Python engine phase", or a "MCP client phase". The schema is `SessionRecord`. The MCP client is the agent's existing Notion and Linear tools.

### Slice 1 — Planned prompt, clobber gone

**Cross-repo.** Lands `hooks/engine.ts` in `claude-ultrathink` and the spawner in `hermes-plugin` together. The Python hook is useless without the entry; the entry is unused without the hook.

**Done when:**

- A non-trivial Hermes prompt is planned by `runPromptSubmit` (uplift XML + graph in the injected context, or a logged skip).
- `bun` missing, engine throw, or timeout returns `None` and the prompt still runs.
- Child sessions (`parent_session_id`) and `platform=cron` do not spawn Bun.
- No Hermes Kanban card is created. No `.planning/` write happens in the cwd. `/gsd` and `/issues` are gone, not hidden behind a flag.
- `ctx.llm.complete` is not on this path.
- State lands in `$HERMES_HOME/ultrathink/`, not `~/.claude/ultrathink/`.
- `plugins.hook_callback_timeout: 0` is documented as required for this profile.

**Does not** tell the agent to load a skill. `hasPlan` may already be in the JSON result so slice 2 only adds the tail and the skill. No kickoff sentence until the skill exists.

### Slice 2 — Kickoff parity

**Depends on slice 1's session file.** Mostly the skill plus the Python tail. No pipeline change. The only TypeScript touch allowed here is a bugfix in the entry's JSON fields if slice 1 omitted `statePath` or `hasPlan`.

**Done when:**

- Injected tail names `skill_view(name="prompt-uplift:ultrathink-kickoff")` and `stateFile=`.
- The skill creates or updates one Task row by Graph ID, one Issue per graph node, one Sub-Issue per rationale step, on the existing Notion data source and Linear team.
- Blocking questions go out as one `clarify` `questions` batch before other work. Missing `clarify` or a timeout uses defaults and says so.
- The turn produces an `<ISSUES>` block. If `plan` is missing, the skill skips tracking and continues with `result.xml`.
- MCP errors do not block the prompt.
- The skill writes answers and `kickedOff: true` back to the session file.
- Notion `Agent` is set to `hermes` only when that select value is accepted. `plan.task.agent` is hardcoded `"claude-code"` in `src/track/plan.ts`. Do not change that constant — it would relabel Claude Code rows. If the select rejects `hermes`, omit `Agent` rather than fail the create.

### Slice 3 — Sync on PR and on stop

**Python-only if slice 1 already persists `plan.graphId`.** No new engine work.

**Done when:**

- `prompt-uplift:ultrathink-sync` updates PR URL, PR number, and status on the existing Task row and Linear issue, and never creates a row.
- A `gh pr create` or a `github.com/.../pull/N` tool result in the same turn is suffixed with a sync nudge naming `graphId`.
- A coding turn that is about to finish with an unsynced plan gets one `pre_verify` continue-message (bounded by `agent.max_verify_nudges` — do not loop).
- The next `pre_llm_call` injects a sync reminder when the session file has a plan and `synced` is not true, unless this turn is itself a new uplift (new plan replaces the reminder; the new tail is kickoff, not sync).
- A down Notion or Linear during sync does not block the turn that created the PR.

**Phase ordering rationale:** Slice 1 removes the clobber and proves the process boundary before any tracker write exists, so a half-finished slice cannot double-track (Kanban plus Notion). Slice 2 is the core value (planned, then tracked, then work). Slice 3 needs rows to update, so it follows kickoff. Sync does not block kickoff, and kickoff does not block "the prompt still runs".

**Research flags:**

- Slice 1: standard. The timeout cap is already verified in Hermes source; do not re-research the pipeline.
- Slice 2: the Notion `Agent` select values are not in this repo. Confirm once against the live data source before hard-coding `hermes`. Tool names for Notion query and Linear create stay "inspect the tools you have", same as the Claude skill — Hermes MCP names are environment-specific.
- Slice 3: standard nudge wiring. Do not research a new stop hook; the catalog has no injection-capable session-end event.

## Scaling Considerations

This is one operator, one local Hermes profile, one Bun child per kept prompt. Do not split services.

| Scale | Architecture adjustments |
|-------|--------------------------|
| One operator, a few sessions | This design. The monolith is the TypeScript process plus a skill. |
| Many prompts per hour | First cost is LLM calls inside the engine, not the JSON file. Skip rules (trivial, slash, child, cron) are the only lever that belongs in v1. |
| Many parallel Hermes sessions | Separate `session_id` files. No lock manager. Two hooks for the same session id can overwrite one file — Hermes already serializes a session's turns. |

### Scaling priorities

1. **First bottleneck:** `pre_llm_call` wall clock versus `plugins.hook_callback_timeout`. Fix is `0` (disable) plus the engine's own `budgetMs`, not a queue, not a background plan that arrives next turn. A late plan is a wrong plan.
2. **Second bottleneck:** kickoff MCP volume. One task + 3–8 issues + 5–8 sub-issues per node is dozens of Notion/Linear calls. The skill may batch creates per node, as the Claude skill already says. Do not move that fan-out into the hook to "make it faster". If MCP is slow, the prompt still proceeds.

## Anti-Patterns

### Anti-Pattern 1: Calling `hooks/uplift.ts` with fake Claude JSON

**What people do:** Pipe a made-up `UserPromptSubmit` payload, invent a `transcript_path`, and scrape `additionalContext` out of stdout.

**Why it's wrong:** The Claude entry writes a Claude-shaped hook result, skips on `hook_event_name`, and reads conversation from a JSONL transcript Hermes does not have. The kickoff sentence it embeds names a skill Hermes will not resolve. The next Claude protocol tweak breaks Hermes.

**Do this instead:** `hooks/engine.ts` calls `runPromptSubmit` directly and returns host-neutral JSON. Python adds the Hermes skill sentence.

### Anti-Pattern 2: Planning with `ctx.llm` when Bun fails

**What people do:** Keep the current Python uplift and Graph of Thought as a fallback so a missing `bun` still "plans".

**Why it's wrong:** That is the second engine this milestone exists to remove. Two planners means two graphs and two notions of Graph ID. Fail-open means an unplanned prompt, not a worse plan.

**Do this instead:** Return `None`. Log the summary. The user's words stand.

### Anti-Pattern 3: Hooks calling Notion, Linear, or Kanban

**What people do:** The subprocess returns a `TrackPlan`, and Python creates the rows before `pre_llm_call` returns, because that feels more reliable than a skill.

**Why it's wrong:** Locked. Hooks have no MCP session. Direct API calls need a second credential set and a second field mapping. Kanban cards and `.planning/` writes are the clobber being removed, not a degraded mode.

**Do this instead:** Inject the path. The skill writes. If the model skips the skill, the next-turn reminder can ask again. Do not paper over a skipped skill with a hook-side write.

### Anti-Pattern 4: Sharing `~/.claude/ultrathink`

**What people do:** Leave `ULTRATHINK_STATE_DIR` unset so Hermes writes `~/.claude/ultrathink/sessions/<id>.json` and `control.json`.

**Why it's wrong:** `/uplift off` in Hermes would disable Claude Code, and the reverse. Session ids are opaque and not guaranteed unique across hosts. `last.json` would flap between products.

**Do this instead:** `$HERMES_HOME/ultrathink` for state and control. Keep sharing `~/.claude/ultrathink.json` for engine and tracker ids.

### Anti-Pattern 5: Putting the skill where the index cannot see it, then hoping

**What people do:** Copy `SKILL.md` into `~/.hermes/skills/ultrathink-kickoff/` and inject "invoke ultrathink-kickoff" the way Claude does.

**Why it's wrong:** Plugin skills are the supported bundle (`ctx.register_skill`). A copied skill collides on the bare name and is editable runtime state, not plugin source. Either way, Hermes does not auto-invoke a skill the way Claude Code invokes a plugin skill from additionalContext. The system prompt index does not list plugin skills.

**Do this instead:** Register both skills. The tail calls `skill_view` with the qualified name.

### Anti-Pattern 6: Blocking the tool path on the engine

**What people do:** `transform_tool_result` or `pre_verify` spawns Bun to "refresh the plan" before nudging sync.

**Why it's wrong:** Both hooks are timeout-bounded. A slow callback is abandoned, and a timed-out `pre_llm_call` suppresses the planner for 60 seconds. Sync only needs `graphId` from the file the entry already wrote.

**Do this instead:** Regex plus `readSession`. Return immediately.

### Anti-Pattern 7: Changing `plan.task.agent` in shared TypeScript

**What people do:** Set `agent: "hermes"` in `src/track/plan.ts` so Notion rows look right.

**Why it's wrong:** Claude Code kickoff writes that field. One constant serves both hosts today. Changing it relabels every Claude task.

**Do this instead:** The Hermes skill overrides `Agent` at write time, and bails to "omit the property" if the select rejects the value.

### Anti-Pattern 8: Horizontal phases

**What people do:** Phase 1 defines the JSON schema, phase 2 extracts `selectEngine`, phase 3 writes the skill, phase 4 deletes Kanban, phase 5 wires sync.

**Why it's wrong:** Schema-only and delete-only phases are not user-visible, and leaving Kanban alive until a later phase means the first real Hermes prompts still clobber cwd and double-track.

**Do this instead:** The three slices above. Kanban and GSD leave in slice 1, the same change that starts calling the TypeScript engine.

## Integration Points

### External services

| Service | Integration pattern | Notes |
|---------|---------------------|-------|
| TypeScript engine | `bun <engine_root>/hooks/engine.ts`, JSON stdin/stdout, exit 0 | `engine_root` is a plugin setting, absolute path to the `claude-ultrathink` checkout. Do not hardcode `/root/src/repos/...` in a skill. `bun` on `PATH` or `bun_bin` setting. |
| Claude / Grok completer | Existing `selectEngine` inside the entry | Needs `claude` logged in, or Grok `http` / `cli` / `shunt` as `~/.claude/ultrathink.json` already configures. Hermes provider auth is not used. A missing login fail-opens. |
| Notion | Agent MCP tools, skill only | Data source `collection://be3418f0-d2d8-411b-8677-fa8a95ee63be` unless config overrides it. Hermes must have the Notion MCP server configured; Claude's `scripts/setup.ts` does not install it into Hermes. |
| Linear | Agent MCP tools, skill only | Team `Spectrum Web Co` unless config overrides it. Same prerequisite: MCP in the Hermes profile. |
| `clarify` | Agent tool, skill only | Batch via `questions` (cap 5). Not `AskUserQuestion`. Unavailable → defaults, stated in the turn. |
| Git | Engine subprocess cwd | `src/track/git.ts` resolves repo slug and branch. Spawn in the session cwd. |

### Internal boundaries

| Boundary | Communication | Notes |
|----------|---------------|-------|
| Python hook → engine entry | One-shot subprocess, JSON on stdin/stdout, logs on stderr | No shared memory, no socket, no completion shuttle back to `ctx.llm`. |
| Engine entry → pipeline | In-process `runPromptSubmit(input, deps)` | Only this entry and `hooks/uplift.ts` construct completers. |
| Engine entry → skill | Session file path inside injected context | Skill never imports TypeScript. Any `SessionRecord` field change must be mirrored in the Hermes skill's inline type block the same way the Claude skill mirrors it. |
| Skill → engine (next turn) | Skill patches the session file; next `readSession` sees answers | No callback into Python. |
| PR nudge → sync skill | Suffix on the tool result string | Must include the original result. A transform that returns only the nudge destroys the PR URL. |
| Claude host ↔ Hermes host | Shared config file, separate state directory | No shared `control.json`, no shared `last.json`. |
| Plugin manifest ↔ callbacks | `plugin.yaml` `hooks:` lists `pre_llm_call`, `transform_tool_result`, `pre_verify` | Registration is still `ctx.register_hook`. The manifest list is the catalog contract (`provides_hooks` / `hooks` both accepted). |

## Sources

- TypeScript architecture map, refreshed 2026-09-22: `.planning/codebase/ARCHITECTURE.md` (hook/skill split, fail-open, injectable completer, session file contract). HIGH — matches current `hooks/uplift.ts`, `src/claude/hook.ts`, `src/claude/output.ts`, `src/claude/state.ts`.
- Claude skills and nudges: `skills/ultrathink-kickoff/SKILL.md`, `skills/ultrathink-sync/SKILL.md`, `hooks/stop.ts`, `hooks/pr-sync.ts`, `src/track/pr-detect.ts`, `src/track/plan.ts` (`agent: "claude-code"`). HIGH — read in tree.
- Hermes plugin hook catalog and `pre_llm_call` injection: `/usr/local/lib/hermes-agent/website/docs/developer-guide/plugins/index.md` (context injection, spill at 10_000, bundled skills) and `website/docs/user-guide/features/hooks.md`. HIGH — official docs in the installed tree.
- Timeout behavior, cross-checked in source: `hermes_cli/config_defaults.py` (`hook_callback_timeout` default 30), `hermes_cli/web_server_config.py` (0 disables, values above 600 clamped), `hermes_cli/plugins_dispatch.py` (`pre_llm_call` bounded, abandon without join, 60s suppression, max 3 abandoned workers). HIGH.
- Plugin skill loading, cross-checked: plugin guide "not listed in `<available_skills>`" and `PluginContext.register_skill` docstring in `hermes_cli/plugins.py` (qualified name, `skills_list` yes, system-prompt index no). HIGH.
- `clarify` batch: `tools/clarify_tool.py` (`questions` up to 5) and `VALID_HOOKS` comment that `pre_verify` fires when edited code is about to verify or finish. HIGH for the tool contract; MEDIUM for how often `pre_verify` runs on non-coding stops (source says it does not).
- Current Python plugin to remove from the hot path: `hermes-plugin/__init__.py` (`pre_llm_call` calls `handle_pre_llm_call` with `hermes_kanban_create` and `gsd_write`). HIGH.

### Gaps

- Notion `Agent` select options were not queried live. Slice 2 confirms `hermes` once; omit the property on rejection.
- Whether a given Hermes profile already has Notion and Linear MCP is an environment fact, not a code fact. The skill cannot install them. Slice 2 should treat a missing tool as fail-open, not as a new MCP client.
- Model compliance (actually calling `skill_view` before coding) is behavioral. The architecture makes the instruction explicit and last in the tail. It does not add a hook-side tracker write to force it. MEDIUM confidence that the tail is sufficient; the mitigation if it is not is a stronger tail, not MCP-in-the-hook.

---
*Architecture research for: Hermes host bridge onto the TypeScript ultrathink engine*
*Researched: 2026-09-24*
