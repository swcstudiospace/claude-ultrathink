# Ultrathink on Hermes

## What This Is

The TypeScript ultrathink plugin is the single source of truth for prompt uplift, Graph of Thought, and Chain of Thought across every host the operator runs. No host reimplements that engine. `claude-ultrathink` ships as one cross-runtime plugin that Claude Code and Grok Build both load directly, and that Hermes reaches through a Python hook calling the same pipeline. In all three, an agent-side skill — never a hook — does the Notion and Linear tracking that `ultrathink-kickoff` and `ultrathink-sync` already do.

This is for the operator running Claude Code, Grok Build, and Hermes Agent against one engine instead of three forks of it. Uplift also hands off to GSD rather than stepping around it: a `/gsd-*` prompt is planned by ultrathink first, then GSD's own commands and hooks compose on top.

## Core Value

Every non-trivial prompt — on Claude Code, Grok Build, or Hermes — is planned by the TypeScript ultrathink engine, then tracked in Notion and Linear, before the agent does the work.

## Current Milestone: v1.0 Cross-runtime ultrathink — Hermes bridge, Grok Build, and GSD handoff

**Goal:** One TypeScript ultrathink engine drives prompt uplift across Claude Code, Grok Build, and Hermes, and hands off cleanly to GSD instead of skipping it.

**Target features:**
- Hermes `pre_llm_call` bridge into the TypeScript engine, injecting uplift XML and graph
- A Hermes skill with full Notion/Linear parity plus blocking HITL
- Hermes sync of PR URL and status, on pull-request creation and on stop
- Removal of the Python Kanban cards and the GSD working-directory write
- Cross-runtime hook invocation — bun-locator shims and both plugin-root variables, across all four hooks
- Grok event-name compatibility, including the events Claude has no equivalent for
- A GSD handoff so `/gsd-*` prompts are uplifted and then composed on, not skipped
- Retiring or redirecting the sibling `/root/src/repos/ultrathink` repo

## Requirements

### Validated

- ✓ A Claude Code `UserPromptSubmit` runs decide → uplift → Graph of Thought → HITL clarify → `TrackPlan`, then persists session JSON — existing
- ✓ Hooks never call MCP. `ultrathink-kickoff` and `ultrathink-sync` do the Notion and Linear writes inside the agent turn — existing
- ✓ Kickoff finds-or-creates a task row by Graph ID, one issue per graph node, and one sub-issue per Chain-of-Thought step, then returns an `ISSUES` block — existing
- ✓ Sync updates PR URL and status on the existing task row and Linear issue — existing
- ✓ The pipeline is fail-open: an engine failure, missing MCP connection, or tool error never blocks the user's prompt — existing
- ✓ Slash commands, trivial acknowledgements, already-uplifted XML, and child-session invocations are skipped — existing
- ✓ Graph of Thought is a 3–8 node DAG with per-node rationale and conclusion; rows are idempotent on Graph ID — existing
- ✓ Engines are an injectable completer. Claude is the default. Grok supports `http`, `cli`, and `shunt` — existing

### Active

- [ ] Hermes `pre_llm_call` calls the TypeScript engine and injects the uplift XML and graph before the agent works
- [ ] A Hermes skill creates the same Notion and Linear rows as `ultrathink-kickoff`: task, one issue per graph node, one sub-issue per Chain-of-Thought step
- [ ] Blocking HITL questions are asked and answered before the agent starts the work, and the answers come back in an `ISSUES` block
- [ ] The same skill syncs PR URL and status in v1, on pull-request creation and on stop
- [ ] If the TypeScript engine, Notion, or Linear is down, the Hermes prompt still proceeds
- [ ] The Python plugin no longer creates Hermes Kanban cards and no longer writes a GSD milestone into the working directory
- [ ] The plugin's hooks run under Grok Build: bun is located without relying on PATH, and the plugin root resolves from either `${CLAUDE_PLUGIN_ROOT}` or `${GROK_PLUGIN_ROOT}`
- [ ] Hook registration covers Grok's event names as well as Claude's, including the Grok-only events Claude has no equivalent for
- [ ] A `/gsd-*` prompt is uplifted rather than skipped, and emits a handoff artifact GSD's commands and hooks can consume
- [ ] `claude-ultrathink` is the only ultrathink plugin repo; the sibling Grok-only repo is retired or redirected

### Out of Scope

- A Python rewrite of the uplift, graph, HITL, or track-plan engine — TypeScript stays the source of truth
- A native TypeScript Hermes plugin host — Hermes plugins load as Python (`plugin.yaml` + `register(ctx)`)
- Hermes Kanban cards as a tracker — Notion and Linear are the only tracker
- The plugin writing `.planning/` into the current working directory — that clobber is what this redesign removes
- omp / pi TUI chrome, Tissue, ktui, AgentSwarm, and the other integrations ultrathink already stripped
- A Python or Rust reimplementation of the hooks for Grok Build — Grok loads Claude-format plugins directly, so one hook set serves both

## Context

The operator wants the Hermes prompt-uplift plugin to be as robust as `claude-ultrathink`, not a second copy of its reasoning. The current Python plugin (`/root/src/repos/hermes-plugin`, enabled at `~/.hermes/plugins/prompt-uplift`) does its own uplift, a 3–8 node graph, Hermes Kanban cards, and a GSD write into the working directory. That GSD write is the source of stray `.planning/` closeouts. Those cards and that write are being removed, not kept behind a flag.

Ultrathink's split is the pattern to copy. Bun hooks plan and write local JSON. They cannot call MCP. The agent invokes `skills/ultrathink-kickoff/SKILL.md` and `skills/ultrathink-sync/SKILL.md` to write Notion and Linear. Hermes should do the same split: the Python hook calls the engine and injects context; a Hermes skill does the tracking and the blocking questions.

A codebase map of the TypeScript repo already exists at `.planning/codebase/` (refreshed 2026-09-22). It was kept. The previous `PROJECT.md`, `ROADMAP.md`, and `STATE.md` in this directory were a prompt-uplift closeout of an unrelated verification task. They were replaced, not resumed.

### Environment Facts

- Planning root: `/root/src/repos/claude-ultrathink` (own git, branch `fix/no-reasoning-extraction-flag` at init). Planning commits land here and must not stage the dirty product files already on that branch.
- Python host: `/root/src/repos/hermes-plugin`. Its git root is `/root/src/repos`, not its own repo. Code commits there land on the outer worktree. Do not `git init` inside it.
- Hermes plugins are Python. A TypeScript plugin cannot be installed as a Hermes plugin. The bridge is a subprocess or hook call into the TypeScript engine.
- Ultrathink config today: `~/.claude/ultrathink.json`, project override `<project>/.claude/ultrathink.json`. Notion data source `collection://be3418f0-d2d8-411b-8677-fa8a95ee63be`. Linear team `Spectrum Web Co`.
- The TypeScript pipeline is pure behind an injectable completer (`src/uplift/`, `src/think/`, `src/hitl/`, `src/track/`). Process and file I/O sit at the edges (`src/claude/`, `src/grok/`, `hooks/`).
- Test gates at the last milestone close: `bun test` and `bun run check` in this repo; `python3 -m pytest -q` in hermes-plugin.

## Constraints

- **Host**: Hermes plugins are Python — the hook and skill live in `hermes-plugin`, referenced by absolute path from this planning root
- **Source of truth**: Reasoning stays in `claude-ultrathink`. Do not port the engine to Python
- **MCP split**: Hooks do not call Notion or Linear. The skill does, same as ultrathink
- **Fail-open**: A down engine, Notion, or Linear must not block the user's prompt
- **Tracker**: Notion and Linear only. Same data source and Linear team ultrathink already uses, unless a later decision changes that
- **Git**: Planning docs commit in `claude-ultrathink`. Python edits commit in `/root/src/repos`. Do not nest a new `.git` in `hermes-plugin`
- **Dirty branch**: Do not stage unrelated in-flight TypeScript changes when committing planning files

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|---------|
| TypeScript stays the source of truth; Hermes calls it | A native TypeScript Hermes plugin is not possible. A Python port would fork the engine the operator already trusts | — Pending |
| Hermes hook returns uplift XML and graph; a Hermes skill does Notion and Linear | Matches ultrathink: hooks plan, the agent turn writes MCP | — Pending |
| v1 kickoff is full parity: task row, issue per node, sub-issue per Chain-of-Thought step, blocking HITL, `ISSUES` block | Operator asked for the robust path, not a thinner cut | — Pending |
| Sync (PR URL and status, on PR create and on stop) is in v1 | Operator included it with kickoff, not deferred | — Pending |
| Remove Python Kanban cards and the GSD cwd write | Those writes clobber repos and are not the tracker | — Pending |
| Planning root is `claude-ultrathink`; replace the stray `.planning/` closeout; keep the codebase map | The closeout was not a project. The map is | — Pending |
| Fail-open if TypeScript, Notion, or Linear is down | Stated with the picture the operator accepted | — Pending |
| Same Notion data source and Linear team as ultrathink | Stated with the picture the operator accepted | — Pending |
| One cross-runtime plugin; the sibling `/root/src/repos/ultrathink` repo is retired or redirected | Two repos means two divergent forks of one engine to hand-sync; Grok loads Claude-format plugins natively, so the split buys nothing | — Pending |
| Claude Code hook behavior is in scope (this was an Out of Scope line until v1.0) | The bun-locator shims, the dual plugin-root resolution, and the GSD handoff cannot be built without changing the hooks | — Pending |
| Hermes bridge and Grok/GSD compatibility ship as one milestone, not two | Operator scoped them together; the host-bridge research covers the seam both need | — Pending |
| Hooks are invoked through a `bin/` shim rather than a bare `bun` command | Grok runs hooks with `PATH=/usr/bin:/bin`, where `bun` is absent — a bare command exits 127 every time | — Pending |

## Evolution

This document evolves at phase transitions and milestone boundaries.

**After each phase transition** (via `/gsd-transition`):
1. Requirements invalidated? → Move to Out of Scope with reason
2. Requirements validated? → Move to Validated with phase reference
3. New requirements emerged? → Add to Active
4. Decisions to log? → Add to Key Decisions
5. "What This Is" still accurate? → Update if drifted

**After each milestone** (via `/gsd-complete-milestone`):
1. Full review of all sections
2. Core Value check — still the right priority?
3. Audit Out of Scope — reasons still valid?
4. Update Context with current state

---
*Last updated: 2026-09-23 after starting milestone v1.0*
