# Feature Research

**Domain:** Host-bridge seam between a Hermes prompt hook and an external agent-planning tracker (Notion + Linear), with reasoning owned by the existing TypeScript ultrathink engine
**Researched:** 2026-09-24
**Confidence:** MEDIUM

Confidence is MEDIUM on purpose. Host contracts are taken from current official docs (Hermes, Claude Code, Cursor, GitHub Copilot SDK) and from this repo's plugin, then cross-checked. `classify-confidence` rates verified `websearch` as MEDIUM and `webfetch` as LOW, so none of the findings below are tagged HIGH. Competitor products that were not opened (Goose, Cline, Devin, Paperclip) are not used as evidence.

## Inherited, not new features

The Claude Code plugin already ships these. Do not put them on the roadmap as features to invent:

- Prompt uplift to XML
- A 3–8 node Graph of Thought with per-node Chain of Thought
- HITL question generation
- Session JSON / `TrackPlan`
- Notion + Linear kickoff: task row, one issue per node, one sub-issue per step, `ISSUES` block
- Sync of PR URL and status
- Fail-open inside that engine
- Skip of slash commands, trivial acknowledgements, already-uplifted XML, and child sessions

v1 is a host port of that contract, plus the deletions the operator already chose. The tables below are only what the Hermes seam must add, what similar products treat as expected, and what to refuse.

## Feature Landscape

### Table Stakes (Users Expect These)

Features the operator will treat as missing if the Hermes port "works" but the turn is untracked, stalled, or clobbering the repo. Users do not get credit for these. They penalize their absence.

| Feature | Why Expected | Complexity | Notes |
|---------|--------------|------------|-------|
| Callable TypeScript engine entry, invoked from Hermes `pre_llm_call` | Hermes plugins are Python. The engine stays in `claude-ultrathink`. Without a subprocess (or equivalent) entry, the hook either reimplements reasoning or does nothing. | MEDIUM | Contract: prompt in, plan JSON out, non-zero or timeout means "no plan". Do not shell the engine with an unbounded wait. |
| Append context beside the user message; do not replace it | Hermes injects `pre_llm_call` context into the user message, never the system prompt, so the prompt cache stays stable. Claude `UserPromptSubmit` likewise adds `additionalContext` and cannot replace the prompt. Copilot *can* replace the prompt; that is the wrong model here. | LOW | Return `{"context": "..."}` or a string. `None` means no injection. |
| Spill-safe handoff: skill instruction and state-file path survive truncation | The current Hermes plugin already documents that graph XML is large enough to be cut to a hook-output preview (`hooks.output_spill.max_chars`). If the "invoke the skill" line is the part that gets cut, kickoff never runs and the turn looks untracked. | LOW | Put the skill instruction and absolute state path first. Keep the injected graph short. The full `TrackPlan` lives in the state file, not in the bubble. |
| Plugin-bundled skill, loaded by explicit `skill_view` | Hermes does not auto-run a skill because a hook mentioned its name. Skills load via `skill_view` or a slash command. `ctx.register_skill` namespaces them as `plugin:skill`. A loose markdown file under `~/.hermes/skills/` can be opted out or deleted. | MEDIUM | Injection must name `skill_view("plugin:<name>")`, not a Claude-style "invoke ultrathink-kickoff" sentence and not the un-namespaced `gsd-autonomous` handoff the current plugin uses. |
| Kickoff parity on the Hermes tool surface | Operator chose full parity: task, issue per node, sub-issue per step, blocking questions, `ISSUES` block. The row shape already exists. What is new is doing those writes with Hermes MCP tools, not Claude's. | HIGH | Find-or-create on Graph ID before any create. One failed sub-issue must not drop the rest. Same Notion data source and Linear team unless a later decision changes that. |
| Hermes-native HITL with a non-interactive default | Blocking questions before work are in v1. Hermes has no `AskUserQuestion`. Cron, gateway, and headless turns cannot wait on a Claude-only tool. | MEDIUM | Ask on the host's question or approval surface if that turn actually has one. Otherwise state the defaults and continue. Do not block the hook on stdin. |
| Sync of PR URL and status, triggered the Hermes way | Operator included sync in v1. Claude nudges via `PostToolUse` on `gh pr create` and a `Stop` hook that can start another turn. Hermes `post_tool_call` and `on_session_end` returns are ignored, so they cannot inject "now sync". | MEDIUM | v1: the kickoff injection tells the agent to run the sync skill on PR create and at a natural stop, and `post_tool_call` records a detected PR URL into the state file so the skill is not parsing memory. Do not spawn a new turn to force it. |
| Fail-open on engine, Notion, Linear, and a skill the model skips | Hermes isolates hook callback errors so they do not crash the agent. Claude's `UserPromptSubmit` timeout (default 30s) discards `additionalContext` and the prompt still proceeds. A down tracker must not eat the user's request. | LOW | If the engine binary is missing or times out, inject nothing and proceed with the original prompt. Do not synthesize a Python fallback graph. If the skill cannot write, say so and continue. |
| Self-timeout on the engine subprocess | `plugins.hook_callback_timeout` (default 30s) is documented for timeout-bounded observers and `pre_tool_call`. `pre_llm_call` runs before the model call. A hung `bun` process stalls the turn even if some other callbacks are capped. | LOW | Cap the subprocess (on the order of Claude's 30s `UserPromptSubmit` budget, tighter if the engine is local). Timeout returns no context. |
| Skip and loop guard for Hermes turn shapes | Re-planning the kickoff turn, a `delegate_task` child, a cron turn, or an already-injected XML block creates a second graph and a second pile of Linear issues. The current plugin already skips these; the port must keep that behavior when the engine moves. | LOW | Use `parent_session_id`, `platform`, slash-command wrappers, and the skill-invocation preamble. Decide from the new user message, not from history that already contains the graph. |
| State file outside the working tree, path embedded in the injection | Claude persists `~/.claude/ultrathink/sessions/<id>.json`. Hermes `session:compress` can rotate `session_id`. Inferring the plan from the live session id after compact loses sync. Writing `.planning/` into the cwd is the bug this milestone removes. | LOW | Write under the Hermes profile (for example `~/.hermes/ultrathink/sessions/`), never into Claude's session dir and never into the repo. The injection carries the absolute path. |
| Idempotent external rows | Re-running kickoff on a retried turn must update, not duplicate. Spec Kit's community Linear preset treats update-in-place as non-negotiable for the same reason. | MEDIUM | Depends on the existing Graph ID. The Hermes skill must query before create. Do not key rows on Hermes `task_id` from the hook payload — that field is a host kanban id, not the graph id. |
| Agent identity `hermes` on the shared board | The Notion `Agent` field is `claude-code` today. Same data source means a Hermes row labeled as Claude is a lie the operator will trust. | LOW | Set `Agent` from the host. Do not copy the Claude string. |
| Operator controls: on / off / skip / last / status | The current plugin already has `/uplift`, `/think`, `/issues`, `/gsd`. Removing the tracker slices without a status command makes a silent failure look like "it is off". Claude's `--ctl status` is the same expectation. | LOW | Keep enable, skip-once, and last-plan. Replace `/issues` and `/gsd` with a status that reports engine reachable and last kickoff outcome. Do not ping Notion from the hook. |
| Same Notion data source and Linear team, read from config the hook can see | Operator accepted the existing collection and Spectrum Web Co team. A second database is a second product. | LOW | Read targets from the existing ultrathink config (user, then project override). Hermes plugin settings own enable/skip/timeout only. No write into the cwd to store that config. |

### Differentiators (Competitive Advantage)

Valuable, not required to prove the seam. Do not spend v1 on these.

| Feature | Value Proposition | Complexity | Notes |
|---------|-------------------|------------|-------|
| Live node-status mirror during the turn | Cursor's Linear integration shows thoughts, tools, and to-dos as the agent works, and writes progress back. A board that only updates at PR time is coarser. | HIGH | v1 sync is PR URL and status, on PR create and on stop. Per-node "started / done" during the turn is a later slice. Depends on kickoff having created the issue ids. |
| Forced sync turn when the model forgets | Claude's `Stop` hook can continue the turn. Hermes end hooks cannot. `ctx.inject_message` could enqueue a follow-up. | HIGH | Real gap versus Claude. Also a loop and cost hazard. Ship the instruction-plus-state-file path first; add a forced turn only if sync is observably skipped. |
| Gateway button HITL | Hermes runs on Telegram, Discord, Slack, and WhatsApp, not only the CLI. Tappable options beat "state the assumption" on a phone. | HIGH | Depends on a real question transport for that platform. v1 states defaults when no question tool is in the turn. |
| Status command that actually pings Notion and Linear | "Config present" is not "MCP connected". A preflight saves a turn that looks planned and is not tracked. | MEDIUM | Do this from the slash command or the skill, never from `pre_llm_call`. `ctx.call_mcp` is synchronous and stalls the hook. |
| Cross-host resume of one Graph ID | A Hermes retry can find a row Claude already created, and the reverse, because both use the same data source. | LOW | Not a new schema. It falls out of Graph ID lookup if ids do not collide and `Agent` is honest. Do not share the session-file directory to get this. |

### Anti-Features (Commonly Requested, Often Problematic)

| Feature | Why Requested | Why Problematic | Alternative |
|---------|---------------|-----------------|-------------|
| Python rewrite of uplift, graph, HITL, or `TrackPlan` | "Then Hermes does not need a subprocess." | Forks the engine the operator already trusts. Two graphs for one prompt. | Callable TypeScript entry. Python is the host adapter only. |
| Hermes Kanban cards, even behind a flag | The current plugin already creates them. Flags feel like a safe migration. | Operator said remove, not gate. Cards are single-machine and are not the tracker. A flag will be left on. | Delete the kanban write. Notion and Linear are the only tracker. |
| GSD milestone write into the working directory | Spec Kit and GSD do this on purpose: the plan survives the chat. | This plugin's cwd write is the source of stray `.planning/` closeouts. Spec Kit's own Linear preset exists because local specs are the wrong store when an external tracker is the product. | State file outside the repo. Skill writes Notion and Linear. |
| Hook calls Notion or Linear | `ctx.call_mcp` makes it possible, and it would make tracking independent of the model obeying the skill. | MCP from a hook is synchronous, allowlist-gated, and can stall `pre_llm_call` for the call timeout (default 30s, clamp 1–600). Ultrathink's split exists because hooks must not hold tracker writes. A down MCP server then blocks the prompt, which violates fail-open. | Hook writes a local state file and injects a skill instruction. The skill writes. |
| Replace the user message with the uplifted XML | Copilot's hook can do this. It looks cleaner in the transcript. | Hermes cannot do it without fighting the cache (context is appended). Replacement hides the operator's words, breaks `raw:` on the next turn, and makes skip detection see the plan instead of the request. | Append. The skill reprints the XML once, in the `ISSUES` handoff, which is the one place it belongs. |
| Block the prompt until Notion and Linear succeed | Planning products (Spec Kit, GSD) refuse to implement until artifacts exist. That feels rigorous. | This product's contract is fail-open. A 429 from Linear should not eat a coding request. Cursor's `beforeSubmitPrompt` can block; that hook is a policy gate, not a planner. | Proceed untracked, say so, leave a state file so a later `/sync` can catch up. |
| `inject_message` or gateway injection on every session end to force sync | Closes the gap with Claude's `Stop` hook. | End hooks are observers. Auto-injecting a user turn on every stop double-charges the turn and can loop if the follow-up is itself planned. Gateway injection is a separate consent grant and is off by default. | Skill instruction plus PR facts in the state file. Forced follow-up is a differentiator, not v1. |
| Second tracker (GitHub issues, Tissue, local markdown, Hermes Kanban) | Spec Kit's `taskstoissues` and Cursor-Linear make "also file it on GitHub" sound free. | Two boards diverge. Operator named Notion and Linear only. | One Graph ID, two mirrors of the same rows (Notion hierarchy + Linear issues), which kickoff already does. |
| Dump the full `TrackPlan` into the injected context | Avoids a state file the skill must read. | Blows the spill limit, drops the skill instruction, and the next child turn can re-plan the dump. | Pointer plus a short graph. Skill reads the file. |
| Bridge owns subagent dispatch | Claude's kickoff text tells the agent to fan the graph out as `Task` subagents. Copying that into the Hermes bridge looks like parity. | Execution policy is the agent's. Hermes children also receive `pre_llm_call`. A bridge that spawns them will re-enter unless every child is skipped, and the skip is a footgun if the bridge is the one creating them. | Inject the plan. The agent executes. Children are skipped. |
| HITL inside the hook, before the model turn | Guarantees the question is asked before any tool call. | `pre_llm_call` has no question UI. Blocking it stalls CLI and hangs gateway turns. | Questions run in the skill, after the plan exists, before coding tools. |
| Write Hermes session JSON into `~/.claude/ultrathink/sessions` | One directory, one schema, less code. | Claude kickoff will read a Hermes session as its own, or the reverse, and re-ask or double-write. | Same `TrackPlan` schema, separate directory, shared Notion Graph ID space. |
| Keep `/gsd write` as a manual escape hatch | Useful when the automatic write is refused. | It is the clobber, invoked by hand. | No cwd planning write, including the manual command. |

## Feature Dependencies

```
Callable engine entry
    └──requires──> Append injection (context, not a replaced prompt)
                       └──requires──> Spill-safe skill instruction + state path
                                          └──requires──> Plugin-bundled skill (skill_view)
                                                             └──requires──> Kickoff parity (Graph ID find-or-create)
                                                                                └──requires──> ISSUES block
                                                                                                   └──enhances──> Sync (PR URL + status)
                       └──requires──> Self-timeout + fail-open (no Python fallback graph)

Skip / loop guard ──conflicts──> Planning the kickoff turn or delegate_task children

State file outside cwd ──conflicts──> GSD milestone write into the working tree
Hook does not call MCP ──conflicts──> Hook-side Notion/Linear writes
Remove Kanban ──conflicts──> Kanban behind a flag
Agent = hermes ──enhances──> Shared Notion data source (same rows, honest host)

Hermes HITL surface ──requires──> Kickoff skill running inside the agent turn
                                 └──conflicts──> HITL inside pre_llm_call

post_tool_call PR capture ──enhances──> Sync
Forced sync turn (inject_message) ──conflicts──> Fail-open + skip guard (loop risk)
```

### Dependency Notes

- **Injection requires the engine entry:** The hook has nothing honest to inject until the TypeScript process returns a plan. A Python graph is not a substitute.
- **Kickoff requires a bundled skill and a path that survived spill:** Hermes will not discover an unregistered skill from prose, and a truncated injection that loses the path makes the state file useless.
- **Sync requires kickoff's issue ids:** Sync updates existing rows. It must not create them. PR capture in `post_tool_call` only helps if the state file already has the Graph ID.
- **HITL requires the skill turn:** The hook cannot ask. Non-interactive turns use defaults; that is part of fail-open, not a missing feature.
- **Skip guard conflicts with child dispatch and with planning the skill turn:** The kickoff invocation, cron, and `parent_session_id != ""` must return no context.
- **Cwd GSD write conflicts with the state-file design:** They are not two stores. The cwd write is what this milestone exists to stop.
- **Hook MCP conflicts with fail-open:** A stalled `call_mcp` blocks the prompt. The skill path can fail and the prompt still runs.
- **Forced sync turn conflicts with the skip guard:** A synthetic user message that looks like a new request will be planned again unless it is specially skipped. Do not ship both in v1.

## MVP Definition

### Launch With (v1)

Minimum to validate "Hermes plans with the TypeScript engine, then tracks in Notion and Linear, and never clobbers the repo."

- [ ] Callable engine entry plus `pre_llm_call` injection of XML and a short graph — the operator's chosen picture
- [ ] Plugin-bundled skill with full kickoff parity (task, issue per node, sub-issue per step, `ISSUES` block) and sync of PR URL and status — parity, not a new tracker design
- [ ] Blocking questions on the Hermes question surface when one exists; defaults stated when it does not
- [ ] Fail-open if the engine, Notion, or Linear is down, including a self-timeout so the hook cannot hang the turn
- [ ] Skip guard so the skill turn, children, cron, slash commands, and already-injected XML are not re-planned
- [ ] State file outside the repo; skill instruction placed where spill cannot eat it
- [ ] Remove Python Kanban and the GSD cwd write, including `/gsd write`
- [ ] `Agent = hermes`, same Notion data source and Linear team, on/off/skip/last/status

### Add After Validation (v1.x)

- [ ] Status command that pings Notion and Linear from the skill or slash command, not the hook — add when a turn is silently untracked and "config present" was not enough
- [ ] Forced sync follow-up — add only if instruction-plus-state-file sync is observably skipped, and only with a skip marker so the follow-up is not re-planned
- [ ] Gateway button HITL — add when the operator runs this from Telegram or Slack and typed defaults are not acceptable
- [ ] Live node-status mirror — add when PR-time status is too coarse to trust the board during a long turn

### Future Consideration (v2+)

- [ ] Cross-host "resume this Graph ID from the other agent" as a user-facing command — lookup already falls out of idempotency; a command is extra product
- [ ] A third tracker or GitHub-issues export — conflicts with the one-board decision
- [ ] Bridge-owned wave dispatch of the graph — execution policy, not this seam

## Feature Prioritization Matrix

| Feature | User Value | Implementation Cost | Priority |
|---------|------------|---------------------|----------|
| Engine subprocess + append injection | HIGH | MEDIUM | P1 |
| Spill-safe skill pointer + bundled skill | HIGH | MEDIUM | P1 |
| Kickoff parity on Hermes MCP tools | HIGH | HIGH | P1 |
| Sync instruction + PR capture in state file | HIGH | MEDIUM | P1 |
| Fail-open + subprocess timeout | HIGH | LOW | P1 |
| Skip / loop guard | HIGH | LOW | P1 |
| State file outside cwd | HIGH | LOW | P1 |
| Remove Kanban and GSD cwd write | HIGH | LOW | P1 |
| Hermes HITL with default fallback | HIGH | MEDIUM | P1 |
| Agent identity + shared tracker config | MEDIUM | LOW | P1 |
| Operator on/off/skip/last/status | MEDIUM | LOW | P1 |
| Live MCP health ping | MEDIUM | MEDIUM | P2 |
| Forced sync turn | MEDIUM | HIGH | P2 |
| Gateway button HITL | MEDIUM | HIGH | P2 |
| Live node-status mirror | MEDIUM | HIGH | P3 |
| Python engine, Kanban, cwd GSD, hook MCP, prompt replacement | — | — | Do not build |

**Priority key:**

- P1: Must have for launch
- P2: Should have, add when the v1 seam is observed to miss it
- P3: Nice to have, future consideration

## Competitor Feature Analysis

| Feature | Claude Code + ultrathink | Hermes plugin today | Cursor + Linear | Spec Kit | Copilot SDK hooks | Our v1 |
|---------|--------------------------|---------------------|-----------------|----------|-------------------|--------|
| Pre-prompt plan injection | `UserPromptSubmit` adds `additionalContext`; cannot replace the prompt; 30s timeout discards context and the prompt still runs | `pre_llm_call` appends XML and graph to the user message | `beforeSubmitPrompt` can only continue or block. Context injection is `sessionStart` or `postToolUse` `additional_context`, not a per-prompt planner | No hook. The user runs `/speckit.plan` | `onUserPromptSubmitted` can replace the prompt or add context. Docs say preserve intent | Append a pointer and a short graph. Never replace the prompt. Self-timeout, then proceed raw |
| Who writes the tracker | Hook cannot call MCP. Skill writes Notion and Linear | Hook writes Hermes Kanban and `.planning/` in the cwd | Linear assigns an existing issue to the agent; the agent updates that issue and opens a PR | Commands write markdown into the repo; `taskstoissues` creates GitHub issues. A community Linear preset wants no local specs dir and idempotent update | Hook does not own a tracker | Skill writes Notion and Linear. Hook writes only a state file outside the repo |
| Idempotent rows | Graph ID find-or-create | Kanban `--idempotency-key` | The issue already exists; the agent does not invent the tree | Community preset treats update-in-place as non-negotiable because re-runs duplicate | Not a planning product | Keep Graph ID find-or-create. Do not key on Hermes `task_id` |
| HITL before work | One `AskUserQuestion` call; defaults if the tool is missing | Not ported | Human assigns and reviews in Linear; trust is "open the IDE and check" | `/speckit.clarify` is a separate command, not a gate on every prompt | Not in the hook | Ask on the Hermes surface if present; otherwise defaults. Never ask inside the hook |
| Stop / PR sync | `PostToolUse` on `gh pr create` plus `Stop` can nudge another turn | No PR sync | Agent updates the assigned Linear issue and links the PR | Converge is another slash command | Not in the hook | Skill sync, plus `post_tool_call` recording the PR URL. No forced follow-up turn in v1 |
| Fail-open | Engine, MCP, or tool failure never blocks the prompt | Hook exceptions are swallowed; GSD write refusal is reported and the agent continues | `beforeSubmitPrompt` fail-closed is a policy choice, not the default for planning | Workflow stops until artifacts exist | Hook can suppress output; that is the wrong default here | Down engine, Notion, or Linear: original prompt proceeds |
| Plan stored in the repo | No. Session JSON under `~/.claude` | Yes. `.planning/` in the cwd. This is the defect | No. Linear is the store | Yes, by default | No | No cwd planning files |
| Child / cloud skip | Child-session invocations skipped | `parent_session_id`, cron, skill wrappers skipped | Cloud agents do not run user-home hooks; `sessionStart` is deferred while the VM is read-only | N/A | N/A | Keep the Hermes skip list. Do not assume a user-level hook runs for every child |

**Opinion:** Copy Claude's split (hook plans, skill writes), not Spec Kit's repo artifacts and not Cursor's "the ticket already exists" direction. Cursor-Linear is the inverse product: the board creates the work. This seam creates the board rows from the plan, then syncs the PR back. Do not invert v1 into "wait to be assigned."

## Sources

- Hermes Event Hooks, official: https://hermes-agent.nousresearch.com/docs/user-guide/features/hooks — `pre_llm_call` payload (`parent_session_id`, `platform`, `task_id`, full user message and history); context appended to the user message; hook errors isolated; `post_tool_call` and `on_session_end` returns ignored; `subagent_stop` is an observer. Confidence MEDIUM (official page, `webfetch` tier LOW even when verified).
- Hermes Plugins, official: https://hermes-agent.nousresearch.com/docs/user-guide/features/plugins — `ctx.register_skill` → `skill_view("plugin:skill")`; `ctx.call_mcp` allowlisted, synchronous, default 30s; `hook_callback_timeout` documented for timeout-bounded observers and `pre_tool_call`; `ctx.inject_message` and gateway injection are separate, consent-gated. Confidence MEDIUM.
- Claude Code hooks reference: https://code.claude.com/docs/en/hooks — `UserPromptSubmit` cannot replace the prompt; default 30s timeout discards `additionalContext` and the prompt still proceeds; `Stop` can continue a turn. Confidence MEDIUM.
- GitHub Copilot SDK, user prompt submitted: https://docs.github.com/en/copilot/how-tos/copilot-sdk/hooks/user-prompt-submitted — `modifiedPrompt` or `additionalContext`; preserve user intent. Confidence MEDIUM.
- Cursor hooks: https://cursor.com/docs/hooks — `beforeSubmitPrompt` is continue/block only; `postToolUse` has `additional_context`; cloud agents do not load `~/.cursor/hooks.json`. Confidence MEDIUM.
- Cursor × Linear: https://linear.app/now/how-cursor-integrated-with-linear-for-agents (2025-08-21) — assign an existing issue, show progress, open a PR, update Linear. Inverse of this seam. Confidence MEDIUM.
- GitHub Spec Kit: https://github.com/github/spec-kit — spec, plan, tasks, and implement as slash commands; artifacts in the repo; `taskstoissues` for GitHub issues. Confidence MEDIUM.
- Spec Kit Linear extension request: https://github.com/github/spec-kit/issues/2603 — no local `specs/` directory, idempotent update-in-place, bounded retry. Community proposal, not shipped core. Confidence LOW as a product fact, useful as a stated preference.
- This repo: `skills/ultrathink-kickoff/SKILL.md`, `skills/ultrathink-sync/SKILL.md`, `README.md` — the contract being ported, not new scope.
- Current Hermes plugin: `/root/src/repos/hermes-plugin/README.md` — Kanban, cwd GSD write, skip list, `hooks.output_spill.max_chars`, `skill_view` handoff. Local source.

### Gaps

- No verified Hermes equivalent of `AskUserQuestion` was found in the hooks or plugins docs fetched here. v1 should detect a question tool in the turn rather than hard-code a name. Phase planning should confirm the tool before specifying the call.
- Whether `pre_llm_call` itself is covered by `hook_callback_timeout` was not a dedicated official sentence in the pages read. Treat a plugin-side subprocess timeout as required either way.
- Goose, Cline, Devin, and Paperclip were not used. A later phase can add them if the seam grows past Notion and Linear.

---
*Feature research for: Hermes host-bridge to the TypeScript ultrathink engine and the Notion/Linear tracker*
*Researched: 2026-09-24*
