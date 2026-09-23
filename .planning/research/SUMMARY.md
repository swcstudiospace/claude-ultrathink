# Project Research Summary

**Project:** Ultrathink on Hermes
**Domain:** Python Hermes host bridge onto the existing Bun/TypeScript ultrathink engine, with Notion and Linear writes done by a plugin skill
**Researched:** 2026-09-24
**Confidence:** MEDIUM

## Executive Summary

This is a subsequent milestone, not a new planner. The TypeScript ultrathink pipeline stays the source of truth for decide, uplift, Graph of Thought, HITL question generation, and `TrackPlan`. Hermes does not get a second engine. A Python `pre_llm_call` hook spawns one Bun process (`hooks/engine.ts`, not `hooks/uplift.ts`), that process runs the existing `runPromptSubmit` path and writes a `SessionRecord` outside the repo, and a plugin skill — not the hook — does the Notion and Linear work that `ultrathink-kickoff` and `ultrathink-sync` already do for Claude Code. v1 is full kickoff parity plus sync, and it is fail-open: a down engine, Notion, or Linear must not block the user's prompt. Do not rewrite the engine in Python, do not keep Hermes Kanban, and do not write a GSD milestone into the working directory.

Experts build this seam the way ultrathink already splits Claude Code: the hook plans and persists a file; the agent turn writes the tracker. Hermes cannot install a TypeScript plugin, cannot replace the user bubble, and does not auto-invoke a skill the way Claude invokes a plugin skill from `additionalContext`. The bridge is stdlib `subprocess` plus one JSON object each way. The skill is registered with `ctx.register_skill` and loaded by an explicit `skill_view("prompt-uplift:ultrathink-kickoff")` in the injected context. Notion and Linear stay hosted remote MCP servers the skill calls. No HTTP sidecar, no tracker SDK, no `ctx.call_mcp` from the hook.

The main risk is a hook that "fail-opens" after it has already written something: a `.planning/` closeout, a Kanban card, a fallback graph minted as Linear issues, or a bun child that outlives the callback and writes a session file the next turn treats as a plan. Delete the cwd writer and Kanban in the same change that starts calling the TypeScript engine. Own a subprocess deadline shorter than the host cap. Keep the injected context under the default 10,000-character spill. Tracking that the model skips is an untracked turn, not a reason to call Notion from the hook.

## Key Findings

### Recommended Stack

Keep the stack ultrathink already runs. Add a thinner host adapter. Do not add a Python reasoning port, an HTTP server, a local MCP binary, or a tracker SDK. Details: [STACK.md](STACK.md).

**Core technologies:**

- Hermes plugin contract (`plugin.yaml` + `register(ctx)`): register `pre_llm_call`, `transform_tool_result`, `pre_verify`, and the two skills. A TypeScript Hermes plugin cannot be installed.
- Python `>=3.11` stdlib `subprocess` + `json`: one Bun child per kept prompt, one stdout object, process-group kill on timeout. No `httpx`, `pydantic`, `mcp`, or a Linear/Notion SDK. The bridge must not import Hermes, so pytest stays hermetic.
- Bun on `PATH` (this host `1.4.0+34cbb9a40`; npm current `1.4.2`): run `hooks/engine.ts`. Do not hardcode `/root/.local/share/reflex/bun/bin/bun`. Do not downgrade to the stale GitHub "latest" 1.3.11. Upgrade to 1.4.2 when convenient, not as a milestone gate.
- TypeScript engine `ultrathink@0.1.0`, zero runtime npm dependencies: callable entry calls `runPromptSubmit`. Do not add Zod, Hono, Elysia, or a second schema package. Do not pin `typescript@7.0.2`.
- Hosted Notion MCP `https://mcp.notion.com/mcp` and hosted Linear MCP `https://mcp.linear.app/mcp` (`auth: oauth`): skill-only. Linear is already enabled on this Hermes profile. Notion is not — connect with `hermes mcp add notion --url https://mcp.notion.com/mcp --auth oauth`, then `hermes mcp test notion`. Do not set `requires_env` for tokens; a missing key disables the whole plugin, including the hook.
- Hermes `clarify` (`questions` array, cap 5): the blocking-question tool. Claude's `AskUserQuestion` does not exist here.

**Host settings the bridge must not confuse with the contract:**

- `plugins.hook_callback_timeout: 600` is the required backstop for this profile. See the timeout ruling below. Do not set `0`.
- Do not require `hooks.output_spill.max_chars: 80000`. The injection must fit the default 10,000. Raising the cap is an operator workaround, not the design.

### Expected Features

v1 ports a contract that already exists. Do not roadmap uplift, the 3–8 node graph, session JSON, or fail-open inside the engine as features to invent. Details: [FEATURES.md](FEATURES.md).

**Must have (table stakes):**

- Callable TypeScript entry invoked from `pre_llm_call`. Append `{"context": "..."}` beside the user message. Never replace the bubble or edit the system prompt.
- Spill-safe handoff: `skill_view("prompt-uplift:ultrathink-kickoff")` and the absolute `stateFile=` survive the default spill. Full `TrackPlan` lives in the session file, not the bubble.
- Plugin-bundled skills via `ctx.register_skill`. Qualified name `prompt-uplift:<skill>`. Do not copy `SKILL.md` into `~/.hermes/skills/`.
- Kickoff parity on the Hermes tool surface: find-or-create by Graph ID, one issue per node, one sub-issue per Chain-of-Thought step, one `clarify` batch before other work, `<ISSUES>` block. Same Notion data source `collection://be3418f0-d2d8-411b-8677-fa8a95ee63be` and Linear team `Spectrum Web Co`.
- Sync of PR URL and status in v1, on PR create and on stop. Sync updates. It never creates.
- Fail-open on engine, Notion, Linear, and a skill the model skips. No Python fallback graph.
- Self-timeout on the Bun subprocess, owned by the bridge.
- Skip and loop guard: `parent_session_id`, `platform=cron`, skill preamble, slash commands, trivial acknowledgements, `raw:`, already-uplifted XML. Do not re-plan the kickoff turn or a `delegate_task` child.
- State file under `$HERMES_HOME/ultrathink/sessions/`, never cwd, never `~/.claude/ultrathink/sessions/`.
- `Agent` written as `hermes` by the skill. On/off/skip/last/status that does not ping Notion from the hook.
- Delete Python Kanban and the GSD cwd write, including `/gsd` and `/issues`. Not behind a flag.

**Should have (competitive) — defer until the seam is observed to miss them:**

- Status command that actually pings Notion and Linear, from the slash command or the skill, never from `pre_llm_call`.
- Forced sync follow-up via `ctx.inject_message`, only if instruction-plus-state-file sync is observably skipped, and only with a skip marker so the follow-up is not re-planned.
- Gateway button HITL for Telegram/Slack when typed defaults are not acceptable.
- Live node-status mirror during the turn. v1 sync is PR URL and status only.

**Defer (v2+):**

- User-facing "resume this Graph ID from the other agent" command. Cross-host lookup already falls out of Graph ID idempotency if `Agent` is honest. Do not share the session-file directory to get it.
- A third tracker or GitHub-issues export.
- Bridge-owned wave dispatch of the graph. The agent executes. Children are skipped.

### Architecture Approach

Three process boundaries, one direction of data. The hook spawns the engine. The engine writes a session file. The skill reads that file and is the only MCP writer. The only upward write is the skill patching answers, `kickedOff`, and `synced` back onto the file. The hook never reads a plan out of Notion. The engine never calls the skill. The skill never calls Bun. Details: [ARCHITECTURE.md](ARCHITECTURE.md).

**Major components:**

1. `hooks/engine.ts` — host adapter only. JSON request in, one JSON result out, exit 0 always, logs on stderr. Calls `runPromptSubmit`. Does not replace `hooks/uplift.ts`. Does not speak Claude hook JSON.
2. `hermes-plugin/prompt_uplift/bridge.py` — subprocess, timeout, stdout parse. No Hermes import.
3. `hermes-plugin/prompt_uplift/hook.py` — host skips, append the Hermes skill sentence, return `None` on failure. No Kanban, no GSD, no `ctx.llm`.
4. Plugin skills `prompt-uplift:ultrathink-kickoff` and `prompt-uplift:ultrathink-sync` — Notion, Linear, `clarify`, `<ISSUES>`. Registered, not copied.
5. Session file at `$HERMES_HOME/ultrathink/sessions/<sessionId>.json` — the only plan payload. Same `SessionRecord` Claude already writes. Directory overridden with `ULTRATHINK_STATE_DIR`.
6. Nudges, not writers: `transform_tool_result` suffixes a sync sentence on a PR tool result; `pre_verify` continues a coding turn that is about to finish unsynced; the next `pre_llm_call` reminds if `synced` is still false. None of them spawn Bun or call MCP.

Shared config stays `~/.claude/ultrathink.json` plus `<cwd>/.claude/ultrathink.json` (engine, data source, team). Control toggles go to `$HERMES_HOME/ultrathink/control.json` so `/uplift off` in Hermes does not disable Claude Code. Spawn Bun with the session cwd so git slug and branch resolve, but the engine must refuse to create any path under that cwd.

### Critical Pitfalls

Top failures, reconciled across [PITFALLS.md](PITFALLS.md), [ARCHITECTURE.md](ARCHITECTURE.md), and [STACK.md](STACK.md). Prevention is in the phase that first makes the failure possible, not in a later cleanup.

1. **Cwd `.planning/` write and Kanban cards beside the new bridge** — delete `write_gsd_milestone`, `<GSD_HANDOFF>`, `/gsd`, `hermes kanban create`, and `/issues` in the same change that starts calling the engine. A flag is how the clobber shipped. A regression test must run the hook with cwd on a fixture repo that already has a finished roadmap and assert git status clean.
2. **Fail-open that still commits side effects** — `try/except: return None` does not undo a file or a half-created issue tree. No injection and no tracker writes on engine failure, timeout, or `source: "fallback"`. Do not hand a fallback graph to the skill. Persist the session JSON with temp-file plus rename before any MCP call.
3. **Shelling `hooks/uplift.ts`** — empty stdout plus exit 0 is Claude's "no decision", which is also skip, crash, and missing bun. The new entry always prints one versioned envelope. Python rejects an unknown version instead of guessing. Empty stdout is failure, not success.
4. **Host timeout set wrong** — ruled below. A 30s default silently skips uplift and then suppresses the callback. `0` hangs the turn. `86400` copied from Claude's `hooks.json` is not available here and must not be the wait.
5. **Full spec injected into a 10k spill** — the model sees a 500-character head and a 500-character tail, and implements the preview. Lean injection. Instruction and `stateFile` in the head. Skill reads the file. Do not call `ctx.inject_message`. Do not word the header as "ignore the user."
6. **Notion or Linear inside the hook** — `ctx.call_mcp` is synchronous, allowlisted, and blocks `pre_llm_call`. No `mcp_allowlist`. The skill is the only writer. If MCP is down, say so and proceed with the spec.
7. **Graph ID minted per call, Linear created blindly, sync matched by branch** — persist `plan.graphId` in the session file. Skill reads it; the skill never generates one. Notion lookup is SQL `WHERE "Graph ID" = ?`, not the structured filter this data source already rejected, and not title search. Linear creates only if the stored id is absent, and writes the new id back before the next create. Sync looks up by Graph ID only, never creates, never queries by branch.

### Timeout ruling

Three files disagree. The roadmap follows a fourth claim, verified against the Hermes install this host actually runs (`/usr/local/lib/hermes-agent`).

| Claim | What it says | Verdict |
|-------|----------------|---------|
| ARCHITECTURE.md | `plugins.hook_callback_timeout` must be `0` | Reject as the v1 requirement |
| STACK.md | Raise it to `600`; kill Bun earlier (about 540s) | Adopt as the host backstop |
| PITFALLS.md | This checkout's `invoke_hook` has no wall-clock deadline; a web snippet about `hook_callback_timeout` is not a host guarantee | Reject the negative finding. Keep the subprocess-deadline warning |

**Follow this:** set `plugins.hook_callback_timeout: 600` on the profile that runs the plugin, and kill the Bun child from Python before that cap (starting shape: 540s, same signal the engine uses for `budgetMs`). Do not set `0`. Do not treat the yaml key as optional. Do not treat it as the contract — the contract is the subprocess kill.

**Why:**

- On this install, `pre_llm_call` is in `_HOOK_TIMEOUT_BOUNDED_HOOKS` (`hermes_cli/plugins_dispatch.py`). The default is 30 seconds. Values above 600 are clamped (`_MAX_HOOK_CALLBACK_TIMEOUT_SECS = 600`). `timeout <= 0` skips the timeout path (`_hook_uses_callback_timeout`), so the callback runs on the caller thread with no deadline. A timed-out bounded hook fails open: the worker is abandoned without join, the injection is skipped, that callback is suppressed for 60 seconds, and a fourth abandoned worker is skipped outright. The module-level `invoke_hook` in `plugins.py` only delegates to that mixin. PITFALLS read the wrapper and concluded there was no cap. The cap is a host guarantee here.
- `0` is the hang PITFALLS described, created on purpose. ARCHITECTURE is right that a full graph can exceed 600 seconds, and right that an abandoned worker can still write `sessions/<id>.json` after the turn has proceeded unplanned. It is wrong that the fix is to disable the cap. A plan that finishes after the agent has started is the wrong plan. If a graph cannot finish under the cap, return `None` and let the original prompt proceed.
- `600` is the longest backstop the host will honor. The 30 second default is wrong because it fail-opens uplift and then suppresses the planner. The bridge must return before Hermes abandons the worker, which is why the subprocess timeout sits under 600 and why the engine writes the session file atomically and emits a failed envelope with no `statePath` on its own deadline. One budget. Do not let the engine deadline outlive the hook deadline.
- Revisit `0` only if live graphs are routinely abandoned at 600 after that subprocess kill exists. That is an operator experiment, not a slice-1 requirement. Even then, do not remove the subprocess kill.

Do not register bun as a Hermes shell hook (`hooks:` in config). Shell hooks default to 60 seconds and clamp at 300. Do not copy Claude's `86400`.

### Injection ruling

STACK wants the uplift XML plus a compact graph in the hook return, and a spill cap of 80,000. ARCHITECTURE wants the skill sentence last, so a 500-character tail preview still contains the path, and treats a raised spill cap as convenience. FEATURES and PITFALLS want a lean injection under the default 10,000, with the instruction and `stateFile` in the head.

**Follow FEATURES and PITFALLS.** The session file is the payload. In-prompt text is a short header (the spec is the user's elaborated intent; original text stays in `<ORIGINAL>`), the absolute `stateFile=`, and the `skill_view` instruction, and the whole injection stays under 10,000 characters with the default spill config. Put that instruction and path in the head, not only after the XML, so a future spill's 500-character head still has them. A compact graph id and title is allowed only if the injection still fits. Full XML and the filled graph stay in the session file. Do not document `hooks.output_spill.max_chars: 80000` as required. Verify against the default cap.

Fallback output (`hasPlan` false / `source: "fallback"`) may inject spec XML the engine already produced. It must not append a kickoff instruction and must not create rows.

### Envelope ruling

Merge the two schemas. Do not ship either file's JSON alone.

- Always exactly one JSON object on stdout. Schema version field. Exit 0 even on failure. Non-zero means the process did not speak the protocol (missing bun, killed by signal). Logs on stderr only.
- PITFALLS fields, required: `status` of `ok` | `skipped` | `failed`, and a distinct `reason` (`skipped:slash`, `skipped:child`, `failed:timeout`, `failed:engine-missing`). Empty stdout is not success.
- ARCHITECTURE fields, required when `status` is `ok`: `hasPlan`, `statePath`, `graphId`, `context`, `source`, `summary`. Python appends the Hermes skill sentence only when `hasPlan` is true. `context` from the engine must not contain the Claude "invoke ultrathink-kickoff" sentence.

## Implications for Roadmap

Build three end-to-end user capabilities. Each slice crosses the process boundary and is usable on its own. This is the order to put on the roadmap, including when the operator later picks a vertical MVP. Do not expand these into a horizontal list (JSON schema, then engine entry, then hook, then skill, then sync) and do not present PITFALLS.md's five phases as the roadmap. Those five names are hazard constraints. They are folded into the slices below. A delete-only phase, a schema-only phase, and an MCP-client phase are not user-visible, and leaving Kanban alive until a later phase means the first real Hermes prompts still clobber cwd and double-track.

PITFALLS.md's ordering constraint still holds inside slice 1: the cwd writer and Kanban must be gone before the new bridge runs. That is the same change, not a prior phase. Slice 2 depends on the session file slice 1 writes. Slice 3 does not need more TypeScript if slice 1 already persists `plan.graphId`.

### Phase 1: A Hermes prompt is planned, and the repo is untouched

**Rationale:** Core value starts at the process boundary. A half-finished bridge that still writes `.planning/` or Kanban cards is worse than no bridge. Proving the engine call and removing the clobber are one user-visible outcome: the prompt is planned by TypeScript, and the working tree is clean.
**Delivers:** A non-trivial Hermes prompt is planned by `runPromptSubmit`. Uplift XML and the graph land in `$HERMES_HOME/ultrathink/sessions/<id>.json` (and the `.xml` beside it). The hook returns `None` if bun is missing, the engine throws, stdout is not one envelope, or the subprocess deadline fires, and the original prompt still runs. Child sessions and cron do not spawn Bun. No Kanban card. No `.planning/` write. `/gsd` and `/issues` are gone. `ctx.llm.complete` is not on this path. `plugins.hook_callback_timeout: 600` is documented as required; the subprocess kill is shorter than that cap. No kickoff sentence yet — the skill does not exist, and a sentence that names it will be followed.
**Addresses:** Callable engine entry, append injection, self-timeout, fail-open, skip guard, state file outside cwd, remove Kanban and GSD cwd write (FEATURES table stakes). Uses Bun + stdlib subprocess. Implements `hooks/engine.ts` and `prompt_uplift/bridge.py`.
**Avoids:** Pitfalls 1–5 and 10 (cwd clobber, fail-open side effects, Claude hook script as the API, cwd/env inheritance and nested-agent recursion, wrong timeout, child/cron/skill re-plan). Also anti-pattern: Python uplift as a fallback when Bun fails.
**Cross-repo:** Lands `hooks/engine.ts` in `claude-ultrathink` and the spawner in `hermes-plugin` together. Planning commits stay in this repo and must not stage the in-flight TypeScript changes already on `fix/no-reasoning-extraction-flag`. Python commits land in `/root/src/repos`. Do not `git init` inside `hermes-plugin`.

### Phase 2: The plan is tracked before the agent works

**Rationale:** This is the operator's core value: planned, then tracked in Notion and Linear, then work. It cannot precede the session file, and it must not be split into "write the skill text" and "wire MCP" — neither half is a capability.
**Delivers:** Injected tail (in the head of a lean injection) names `skill_view(name="prompt-uplift:ultrathink-kickoff")` and `stateFile=`. The skill creates or updates one Task by Graph ID, one Issue per graph node, one Sub-Issue per rationale step, on the existing data source and Linear team. Blocking questions go out as one `clarify` `questions` batch before other work. Missing `clarify` uses defaults and says so. The turn produces an `<ISSUES>` block. If `plan` is missing, the skill emits the spec and does not create rows. MCP errors do not block the prompt. The skill writes answers and `kickedOff: true` back to the session file. Notion `Agent` is `hermes` only when that select value is accepted; otherwise omit the property. Do not change `plan.task.agent` in `src/track/plan.ts` — that constant is `"claude-code"` and Claude Code kickoff writes it.
**Addresses:** Kickoff parity, Hermes HITL with a non-interactive default, idempotent rows, `Agent = hermes`, spill-safe skill pointer (FEATURES). Implements the kickoff skill. Uses hosted Notion and Linear MCP and `clarify`.
**Avoids:** Pitfalls 6–8 (spill, hook MCP, Graph ID / blind Linear create / wrong Notion lookup) and HITL-inside-the-hook. Also: do not copy the current kickoff skill's unconditional Linear create. That wording is the bug.

### Phase 3: PR URL and status land on the existing rows

**Rationale:** Sync updates rows kickoff created. Shipping it before kickoff either no-ops or, if it "helpfully" inserts, becomes a second creator and races the real writes. The operator locked sync into v1, so it is a phase, not a deferral.
**Delivers:** `prompt-uplift:ultrathink-sync` updates PR URL, PR number, and status on the existing Task row and Linear issue, and never creates a row. A `gh pr create` or a `github.com/.../pull/N` tool result in the same turn is suffixed, via `transform_tool_result`, with a sync nudge that names `graphId` and keeps the original result as the prefix. A coding turn about to finish with an unsynced plan gets one `pre_verify` continue-message, bounded by `agent.max_verify_nudges`. The next `pre_llm_call` injects a sync reminder when the file has a plan and `synced` is not true, unless this turn is a new uplift (new plan replaces the reminder; the new instruction is kickoff, not sync). A down Notion or Linear during sync does not block the turn that created the PR. Lookup is Graph ID only. No row means stop and say so. Do not blank `PR URL` on a stop that has no PR.
**Addresses:** Sync of PR URL and status (FEATURES table stakes, operator lock). Uses `transform_tool_result` and `pre_verify`. No new engine work.
**Avoids:** Pitfall 9 (sync creates, or finds the task by branch). Do not use `post_tool_call` or `on_session_end` to inject "now sync" — those returns are ignored. A session that ends with no further message cannot be synced without hook MCP. Accept that gap. Do not close it with `ctx.inject_message` in v1.

### Phase Ordering Rationale

- Slice 1 removes the clobber and proves the process boundary before any tracker write exists, so a half-finished slice cannot double-track (Kanban plus Notion).
- Slice 2 is the core value and needs the session file. It does not need a pipeline change.
- Slice 3 needs rows to update, so it follows kickoff. Sync does not block kickoff, and kickoff does not block "the prompt still runs."
- Horizontal alternatives were rejected on purpose. PITFALLS.md's "Phase 1: Remove the cwd writer" then "Phase 2: Callable engine entry" then "Phase 3: Hermes hook bridge" is a hazard order, not a roadmap. Fold the deletion, the entry, and the hook into the first user-visible slice. Do not insert a schema phase, a Python engine phase, or an MCP client phase. The schema is `SessionRecord`. The MCP client is the agent's existing Notion and Linear tools.
- If a later vertical-MVP pass re-slices the milestone, keep these three capabilities intact. Do not unfold them back into contract, then bots, then voice — or protocol, then adapter, then skill, then trackers.

### Research Flags

Phases likely needing deeper research during planning:

- **Phase 1:** Short spike on the subprocess contract only — exact envelope fields, process-group kill, atomic rename, scrubbed env. The failure modes are already in PITFALLS.md. Do not re-research the TypeScript pipeline. Do not re-research whether `hook_callback_timeout` exists; that is settled above. Do measure, once, whether a real graph finishes under the 540s/600s pair. If it does not, fail-open. Do not flip the setting to `0` inside planning without that measurement and without the subprocess kill already in the design.
- **Phase 2:** Confirm the Notion `Agent` select accepts `hermes` against the live data source before hard-coding it. Confirm SQL lookup against `collection://be3418f0-d2d8-411b-8677-fa8a95ee63be` (do not switch to rows-mode filters until a live call succeeds). Read the live Linear tool schema for the parent-issue argument; do not hardcode a field name from docs. Notion OAuth is not connected on this profile yet — `hermes mcp test notion` is an environment step, not a new client. `clarify` is verified in this install; do not spend the phase hunting for `AskUserQuestion`.

Phases with standard patterns (skip research-phase):

- **Phase 3:** Nudge wiring. The hook catalog has no injection-capable session-end event. Do not research a new stop hook. The lookup contract is the same SQL-by-Graph-ID lookup as phase 2.

## Confidence Assessment

| Area | Confidence | Notes |
|------|------------|-------|
| Stack | HIGH | Technologies match this install and official Notion/Linear MCP docs. The 600-vs-0 choice is a judgment on verified host source, not a missing package. Notion OAuth for this workspace is untested. Linear parent-field name is unpublished. |
| Features | MEDIUM | Host contracts are official docs plus this repo. FEATURES.md rated itself MEDIUM because its fetch tier was not HIGH. The "no Hermes question tool" gap in that file is closed: `clarify` is in this install. Competitor products that were not opened (Goose, Cline, Devin, Paperclip) stay out of evidence. |
| Architecture | HIGH | Component boundaries match the TypeScript map and the installed plugin catalog. The `hook_callback_timeout: 0` recommendation in that file is rejected; the rest of the slice design stands. Model compliance (actually calling `skill_view`) is behavioral, not architectural. |
| Pitfalls | HIGH | Failure modes are read from the current plugin and the engine. The "no wall-clock deadline" claim is wrong for this install and is not a roadmap input. The subprocess-deadline, atomic-write, and no-hook-MCP warnings still stand. |

**Overall confidence:** MEDIUM

The seam shape is settled. What is not settled is environment, not design: whether this Notion OAuth user can see the locked data source, whether the `Agent` select accepts `hermes`, the live Linear parent-field name, and whether a real graph finishes under 600 seconds. None of those justify a Python engine, a second tracker, or disabling the host cap.

### Gaps to Address

- **Notion not connected on this Hermes profile:** Phase 2 treats a missing tool as fail-open. Connect with `hermes mcp add` before expecting rows. Do not build a client.
- **`Agent` select values unknown:** Confirm once. On rejection, omit the property. Do not fail the create and do not write `claude-code`.
- **Linear create schema unpublished:** Read the connected server's tool list in phase 2. Hermes exposes hyphenated official names with underscores (`mcp__notion__notion_query_data_sources`). Skill text should name the official tool and tell the agent to use the connected server's tool, not a Claude Code name.
- **Graph duration vs 600s unmeasured:** Design for fail-open under the cap. Do not block the roadmap on a benchmark, and do not pre-adopt `timeout: 0`.
- **Skill skipped by the model:** Mitigation is a stronger tail and the next-turn reminder, not MCP in the hook. Forced `inject_message` is a later slice, with a skip marker.
- **Stop with no following message:** Unsynced. Accepted. Do not close it in v1.

## Sources

### Primary (HIGH confidence)

- Installed Hermes source, verified during synthesis: `/usr/local/lib/hermes-agent/hermes_cli/plugins_dispatch.py` (`pre_llm_call` bounded, max 600, `timeout <= 0` disables the timeout path, abandon-without-join, 60s suppression) and `hermes_cli/plugins.py` `_resolve_hook_callback_timeout`. This is the ruling source for the timeout disagreement.
- Installed Hermes plugin and hooks docs, cited by STACK.md and ARCHITECTURE.md: `pre_llm_call` context injection, spill at 10,000, `ctx.register_skill`, fail-open on hook exceptions.
- This repo: `hooks/uplift.ts`, `src/claude/hook.ts`, `src/claude/state.ts`, `src/track/plan.ts` (`agent: "claude-code"`, `generateGraphId`), `skills/ultrathink-kickoff/SKILL.md`, `skills/ultrathink-sync/SKILL.md`, `.planning/codebase/ARCHITECTURE.md`.
- Current plugin to remove from the hot path: `/root/src/repos/hermes-plugin` (`write_gsd_milestone`, Kanban in `pre_llm_call`, skip list).
- Notion hosted MCP: https://developers.notion.com/guides/mcp/get-started-with-mcp and https://developers.notion.com/guides/mcp/mcp-supported-tools — `https://mcp.notion.com/mcp`, SQL query, `collection://` fetch.
- Linear MCP: https://linear.app/docs/mcp — `https://mcp.linear.app/mcp`, OAuth, SSE deprecated.
- Claude Code hooks: https://code.claude.com/docs/en/hooks — `UserPromptSubmit` cannot replace the prompt; default 30s discards `additionalContext` and the prompt still proceeds.

### Secondary (MEDIUM confidence)

- STACK.md version pins: host Bun `1.4.0+34cbb9a40`, npm `bun@1.4.2`, `@types/bun@1.4.2`. Safe to stay on 1.4.x. Do not install 1.3.11.
- FEATURES.md competitor framing: Cursor-Linear is the inverse product (the board creates the work). Spec Kit writes repo artifacts. Copy Claude's split, not either of those.
- Linear parent-issue field name is described by official prompts, not a frozen schema.
- `pre_verify` fires when edited code is about to verify or finish. A research turn that never edits code will not get that nudge. The next-turn reminder covers continuation.

### Tertiary (LOW confidence)

- PITFALLS.md claim that `plugins.hook_callback_timeout` is not in this tree and is not a host guarantee. Superseded by the installed source above. Do not carry it into the roadmap.
- Spec Kit Linear extension request (https://github.com/github/spec-kit/issues/2603) — community preference for no local specs dir and idempotent update, not shipped core. Useful only as agreement with "do not write `.planning/`."
- Whether a typical 3–8 node graph finishes under 600 seconds. Unmeasured. Fail-open is the response until a live turn says otherwise.

---
*Research completed: 2026-09-24*
*Ready for roadmap: yes*
