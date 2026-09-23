# Pitfalls Research

**Domain:** Host bridge from a Python Hermes plugin hook to the existing TypeScript/Bun ultrathink engine, with Notion and Linear writes done by an agent skill
**Researched:** 2026-09-24
**Confidence:** HIGH

This file is for the subsequent milestone only: a Python `pre_llm_call` hook shells out to the TypeScript pipeline, injects the uplift XML and graph, and a Hermes skill does the Notion/Linear work that `ultrathink-kickoff` and `ultrathink-sync` already do. It is not a general software-risk list.

There is no roadmap yet. The previous `.planning/ROADMAP.md` in this repo was a stray closeout, not a plan for this bridge. The phase names below are the ones the roadmap should create, in this order. Later phases reintroduce earlier failures if they land first.

| Phase | Owns | Why this order |
|-------|------|----------------|
| Phase 1: Remove the cwd writer | Delete the GSD milestone write and Hermes Kanban cards, including slash commands that can still fire them | The plugin is enabled and writes on every uplift. A new bridge beside that writer keeps clobbering repos. |
| Phase 2: Callable engine entry | A Bun entry that is not `hooks/uplift.ts`, with a versioned JSON envelope, stderr-only logs, an absolute state dir, and a child-env guard | The hook must not invent a protocol or pretend the Claude hook script is a library. |
| Phase 3: Hermes hook bridge | `pre_llm_call` subprocess, skip gates, fail-open, lean injection, no MCP, no repo writes | Depends on the entry from Phase 2. Must not run until Phase 1 has removed the cwd writer. |
| Phase 4: Kickoff skill | Find-or-create by Graph ID, blocking HITL, `ISSUES` block, agent `hermes` | Reads the session file Phase 3 persists. Must not create rows for a fallback plan. |
| Phase 5: Sync skill | PR URL and status on PR create and on stop; never creates | A sync that creates rows races Phase 4 and duplicates the tracker. |

## Critical Pitfalls

### Pitfall 1: The hook writes a GSD milestone into whatever repo is the cwd

**What goes wrong:**
`write_gsd_milestone(Path.cwd(), …)` creates or overwrites `.planning/PROJECT.md`, `ROADMAP.md`, and `STATE.md` in the directory Hermes was started from. The only hard refuse is `SKIP_PACKAGE_ROOT` (the plugin's own package tree). A repo with no `.planning/` gets a new milestone. A repo whose roadmap has no unchecked `- [ ] **Phase` lines is overwritten, not skipped. Open-phase skip does not protect unrelated repos. `/gsd write` calls the same writer. This has already landed stray closeouts in repos that were not the planning root, including this one.

**Why it happens:**
The writer treats "current working directory" as "the project this prompt is about" and treats fail-open as "log the exception." The files are already on disk before the `except` in `run_gsd_write` runs. A flag (`gsd.enabled`, default on) feels like a safety switch. It is not. The package-root guard was added after a pytest run clobbered the plugin tree; it does not cover any other repo.

**How to avoid:**
Delete the writer, the `<GSD_HANDOFF>` addendum, `/gsd` (including `write`), and the tests that assert a milestone appears in cwd. Do not keep the write behind a flag. State for the new bridge goes to an absolute directory (`$ULTRATHINK_STATE_DIR` or `$HERMES_HOME/ultrathink`), never `Path.cwd()` and never `<repo>/.planning/`. A regression test must run the hook with cwd set to a fixture repo that already has a finished roadmap and assert zero files changed.

**Warning signs:**
- `last_gsd.root` equals `Path.cwd()` in session state or `/gsd status`.
- A prompt in repo A creates `.planning/` in repo A, or overwrites a roadmap that has no open `- [ ] **Phase` lines.
- Tests need an autouse `chdir` because the hook writes relative to cwd.
- The package-root guard is described as the fix.

**Phase to address:**
Phase 1: Remove the cwd writer. Nothing in Phases 2–5 may write a planning file into the session cwd.

---

### Pitfall 2: Fail-open still commits tracker and filesystem side effects

**What goes wrong:**
The hook catches exceptions and returns `None`, so the user's prompt proceeds. That does not undo a `.planning/` write, a Kanban card, or a half-created Notion/Linear tree. The next retry sees "nothing in the session record" and creates a second set. Ultrathink already refuses to build a `TrackPlan` when `result.source === "fallback"` specifically so an engine outage does not fill the shared Notion/Linear board with `FALLBACK_GRAPH` boilerplate. A bridge that tracks the fallback, or that writes before the plan is durable, repeats that outage as duplicate rows.

**Why it happens:**
"Fail-open" gets implemented as `try/except: return None` around the whole hook. Side effects inside the `try` are treated as harmless because the user was not blocked. Hermes `PluginManager.invoke_hook` isolates callback exceptions the same way: the turn survives, the partial write remains.

**How to avoid:**
Fail-open means no injection and no tracker writes, not "best effort writes." Phase 1 removes Kanban and the GSD write entirely. Phase 3 returns `None` on engine failure, timeout, or `source: "fallback"`, and does not hand a fallback graph to the skill. Phase 4's skill, if `plan` is missing, emits the spec and stops — it does not create rows and it does not block the turn. Persist the session JSON (Graph ID included) with temp-file plus rename before any MCP call. On retry, resume from that file.

**Warning signs:**
- `session["last_issue"]` or `last_gsd` is set on a turn whose injection was `None`.
- Notion gains a Task whose Graph ID is not in the session file.
- An engine outage produces five generic graph nodes as Linear issues.
- The only fail-open test is "hook does not raise." Cwd and tracker are not asserted unchanged.

**Phase to address:**
Phase 1 for the cwd and Kanban side effects. Phase 3 for not promoting fallback output into a plan. Phase 4 for not creating rows when `plan` is absent, and for writing the session file before MCP.

---

### Pitfall 3: Shelling `hooks/uplift.ts` and treating its stdout as the engine API

**What goes wrong:**
`hooks/uplift.ts` is a Claude Code command hook. It reads hook JSON on stdin, returns immediately unless `hook_event_name` is `UserPromptSubmit`, writes one JSON object to stdout only when there is context, and on fatal error logs and `process.exit(0)` with empty stdout. Empty stdout plus exit 0 is also the skip path (slash command, `ULTRATHINK_CHILD=1`, uplift disabled). A Python bridge that spawns that script gets silence for "skipped", "wrong event", "crashed", and "bun not on PATH" alike, and treats silence as a successful no-op. If bun or a dependency writes a log line to stdout, the JSON parse fails the same way `parseClaudeJson` already special-cases log lines before the Claude JSON object.

**Why it happens:**
The hook script is the only executable entry today, so it looks like the callable. Claude's protocol is "no decision means exit 0 and say nothing." A host bridge needs the opposite: a structured envelope on every invocation, including failure.

**How to avoid:**
Phase 2 adds a dedicated entry (not `hooks/uplift.ts`, not `--ctl`). Contract:

- stdin: one JSON request (prompt, session id, cwd for git context only, absolute state dir, engine selection)
- stdout: exactly one JSON object, no other bytes (`{ status: "ok"|"skipped"|"failed", reason?, statePath?, context? }`)
- logs on stderr only
- exit 0 even on failure, so a non-zero exit is reserved for "the process did not speak the protocol" (missing bun, killed by signal)
- schema version field; the Python side rejects an unknown version instead of guessing

A contract test feeds the entry a slash command, a crash in the completer, and a completer that prints to stdout, and asserts the envelope.

**Warning signs:**
- The Python command line contains `hooks/uplift.ts`.
- The hook treats empty stdout as success.
- `console.log` or `process.stdout.write` exists on the engine path outside the final envelope write.
- A missing `bun` binary is logged as a generic `Exception` with no `reason`.

**Phase to address:**
Phase 2: Callable engine entry. Phase 3 consumes that entry and must not grow a second parser for Claude hook JSON.

---

### Pitfall 4: The engine inherits the agent cwd, env, and a nested agent

**What goes wrong:**
`Bun.spawn` and `subprocess` default to the parent cwd and a copy of the parent environment. Git repo/branch for the TrackPlan should come from the session cwd. Everything else must not. Inheriting cwd makes config load and any relative write land in the repo (Pitfall 1's mechanism, reached through the engine). Inheriting env forwards Hermes credentials into bun, and forwards `ULTRATHINK_CHILD` unset. The Claude completer only sets `ULTRATHINK_CHILD=1` inside `claudeComplete`, together with `--tools ""`, `--no-session-persistence`, and `--strict-mcp-config`. A Hermes-side completer that shells `hermes chat` or `claude -p` without that guard is a new process: `parent_session_id` is empty (that field is set for `delegate_task` children, not for subprocesses), so the plugin plans again. That is the recursion loop. It runs until the timeout in Pitfall 5.

**Why it happens:**
The pure pipeline is injectable (`Completer`). The edges are not. It is easy to pass `cwd=None` and `env=os.environ` and to reuse `claude -p` because that is how the Claude plugin gets a model. Hermes already has `ctx.llm.complete` for host-owned one-shot calls. Spawning another agent to get a completion re-enters the hook.

**How to avoid:**
Phase 2: the entry takes `--cwd` for git slug/branch only, and `--state-dir` as an absolute path. It refuses to create `.planning/` or any path under `--cwd`. It does not spawn `hermes` or `claude` unless the child env is set and tools/MCP/session persistence are off — same flags `buildClaudeArgs` already uses. Prefer the injectable completer calling the model API or the shunt, not an agent CLI. Phase 3: build a scrubbed env (PATH, the completer's credential, `ULTRATHINK_CHILD=1` if a child agent is unavoidable). Do not pass the full Hermes environment. Keep the existing skip for non-empty `parent_session_id`, `platform=cron`, and the Hermes skill-invocation preamble. Add a test where the fake completer records `os.environ` and cwd and asserts it cannot see a planted secret and cannot write under the fixture repo.

**Warning signs:**
- Engine process cwd is the user's repo and the state path is relative.
- A single prompt produces two session files or two Graph IDs.
- `hermes` or `claude` appears in the subprocess tree under the hook.
- `parent_session_id` skip tests pass while the engine still shells an agent.

**Phase to address:**
Phase 2 for the entry's cwd/env/child-env contract. Phase 3 for the skip gates and the scrubbed subprocess env. Both are required; either one alone still recurses.

---

### Pitfall 5: Copying Claude's hook timeout, or copying Hermes's shell-hook timeout

**What goes wrong:**
Claude Code's default command-hook timeout is 600 seconds, lowered to 30 seconds on `UserPromptSubmit`. Ultrathink sets `timeout: 86400` on that event because uplift plus a 3–8 node graph plus per-node Chain-of-Thought plus HITL does not fit in 30 seconds. Hermes is a different host. In this checkout, `PluginManager.invoke_hook` runs `pre_llm_call` on the caller thread with no wall-clock cap: a bun subprocess without its own deadline freezes the turn until it exits. Hermes shell hooks are the other trap: default 60 seconds, clamped at 300, and a timeout on `pre_llm_call` fails open by discarding stdout. `ctx.call_mcp` is 30 seconds by default, clamped to 1–600, and is the wrong place for tracking (Pitfall 7). HITL cannot live in any of these budgets. There is no AskUserQuestion inside `pre_llm_call`.

**Why it happens:**
The Claude `hooks.json` number looks like the requirement ("planning is slow, set a huge timeout"). The Hermes shell-hook block looks like the integration ("just point `hooks.pre_llm_call` at bun"). Neither matches this bridge. A huge timeout makes a down engine a hung prompt. A 30–300 second cap kills the process mid-graph and, if the session file was not atomic, leaves a partial JSON the skill may treat as a plan.

**How to avoid:**
Do not register a shell hook for this. Phase 3 uses the Python plugin hook and a subprocess timeout it owns (process group kill, not a hope that bun exits). On expiry, return `None`, log a distinct `reason: timeout`, and do not read a partial state file. Phase 2 writes the session file atomically and, on its own internal deadline, emits `{ status: "failed", reason: "timeout" }` with no `statePath`. Node fills stay per-level parallel, as `runThink` already does, so the budget is one wave at a time rather than 3–8 sequential CoT calls plus 5–8 steps each. Blocking questions stay in the Phase 4 skill. Do not put a 86400-second wait on the Hermes turn.

**Warning signs:**
- `hooks:` in `config.yaml` points at bun.
- The bridge copies `86400` from `hooks/hooks.json`.
- A killed bun leaves `sessions/<id>.json` truncated and the next turn parses it.
- The hook tries to ask the user a question before returning.
- A timeout and a slash-command skip look identical in the log.

**Phase to address:**
Phase 2 for the atomic write and the failed-envelope-on-deadline. Phase 3 for the subprocess deadline and for not using a shell hook. Phase 4 for HITL, which must not move back into the hook to "make questions blocking."

---

### Pitfall 6: Injecting the full spec the way Claude does, into a 10k Hermes spill

**What goes wrong:**
Claude's `formatPromptContext` puts the spec in `additionalContext` with a 90k budget, elides `<RATIONALE>` first, and puts the "invoke ultrathink-kickoff … Do not start coding before it returns" line in the tail so truncation keeps it. Hermes `pre_llm_call` context is appended to the user message, then `spill_if_oversized` replaces anything over `hooks.output_spill.max_chars` (default 10,000) with a 500-character head, a 500-character tail, and a path under `$HERMES_HOME/hook_outputs`. A graph XML plus addenda exceeds 10k. The model then sees the header, not the spec, and the kickoff line only if it happens to fall in the last 500 characters. The current plugin README's fix is `hermes config set hooks.output_spill.max_chars 40000`. That is an operator workaround. It also inflates every tool-loop iteration of the turn, because the injection sits on the user message for the rest of the turn. Hermes will not let the hook replace the user bubble or edit the system prompt; `ctx.inject_message` starts or interrupts a turn and can re-enter the hook.

**Why it happens:**
The Claude output formatter is the thing being ported. The spill cap is invisible until a real graph is injected. Raising the cap makes the demo look fixed.

**How to avoid:**
Phase 3 injection must stay under the default 10k cap without a config change. In-prompt text is a short header (reuse the Ultrathink wording that frames the spec as the user's elaborated intent — do not write "ignore the user"), the absolute `stateFile=` path, and the kickoff instruction. That instruction goes in the head of the injection, not only in the tail. The full XML and graph live in the session file the skill reads. If the injection would still spill, that is a bug, not a cue to raise `max_chars`. Do not call `ctx.inject_message`. Do not touch the system prompt.

**Warning signs:**
- Hook output contains `<GRAPH_OF_THOUGHT>` and is longer than 10,000 characters.
- The agent executes a 500-character preview, or says it cannot find the spec.
- Docs tell the operator to raise `hooks.output_spill.max_chars`.
- The only copy of "invoke the kickoff skill" is after the XML.

**Phase to address:**
Phase 3: Hermes hook bridge. Phase 4's skill must read `stateFile` rather than expect the full XML in the prompt. Verify with the default spill config, not a raised cap.

---

### Pitfall 7: Doing Notion and Linear inside the hook because Hermes can call MCP

**What goes wrong:**
Claude command hooks have no MCP client. A `type: "mcp_tool"` hook can call one already-connected tool; if the server is down, Claude logs a non-blocking error and continues. That is why ultrathink splits planning (hook) from tracking (skill): kickoff is a find-or-create across a Task, one issue per node, and one sub-issue per Chain-of-Thought step, then one `AskUserQuestion`, then an `ISSUES` block. That is not one MCP call, and it does not fit a 30-second `UserPromptSubmit` default. Hermes is the trap on the other side. `ctx.call_mcp` exists, is allowlist-gated, defaults to 30 seconds, and runs inside `pre_llm_call` on the caller thread. Using it from the hook blocks the prompt, cannot ask blocking HITL, and a mid-fan-out failure leaves a Task with no issues and no `ISSUES` block. Granting `plugins.entries.prompt-uplift.mcp_allowlist` gives the in-process plugin the same write access as the model, with no skill transcript of what was created.

**Why it happens:**
The split looks like a Claude limitation to route around. Once the host can call MCP, "the skill is unnecessary" feels like a simplification. It deletes the only place HITL and the `ISSUES` block can happen.

**How to avoid:**
Phase 3 does not import Notion or Linear clients and does not set `mcp_allowlist`. The hook's only tracking output is `stateFile=` in the injection. Phase 4 is a Hermes skill that follows the kickoff contract: SQL lookup by Graph ID first (the structured filter mode already rejected an equivalent filter against this data source — do not switch modes), one issue per node, one sub-issue per rationale step, batched creates per node, blocking questions via one question call before any engineering tool, then the `ISSUES` block. If MCP is down, say so and proceed with the spec. Do not block the turn.

**Warning signs:**
- `ctx.call_mcp("notion"` or `ctx.call_mcp("linear"` in the plugin.
- `mcp_allowlist` includes the Notion or Linear server.
- A turn creates Linear issues and never emits `<ISSUES>`.
- Blocking questions appear after the first file edit.
- The skill creates rows when `plan` is missing.

**Phase to address:**
Phase 3 forbids hook MCP. Phase 4 is the only phase that writes Notion and Linear for kickoff.

---

### Pitfall 8: Graph ID minted per call, Linear created blindly, Notion looked up the wrong way

**What goes wrong:**
`generateGraphId()` is `ut-<base36 time>-<uuid8>`, new on every `buildTrackPlan` unless a `graphId` is passed in. The kickoff skill's idempotency key is that string on the Notion `Graph ID` property, plus `nodeId`, plus `step` for sub-issues. Linear create in the current skill text is unconditional: if Linear succeeds and the Notion row fails, the retry creates a second Linear issue. A Hermes skill that searches Notion with the structured filter (already observed to reject the filter this data source needs) misses the existing Task and creates another. Title search is worse: two prompts with the same first 120 characters collide, and a retry of one prompt does not. `plan.task.agent` is hardcoded `"claude-code"`. Rows written for Hermes will be indistinguishable from Claude Code rows, and a later sync can update the wrong host's task if lookup gets sloppy. Hermes 0.20.0 has no `ctx.state`. An in-memory fallback loses the Graph ID on restart, so the next kickoff mints a new one.

**Why it happens:**
The id is generated at plan-build time because the Claude hook and the skill share a file that survives the turn. A port that keeps the id only in `ctx.state`, or that lets the skill invent ids, breaks the contract. Linear has no idempotency key in the skill; Notion does. People copy the Notion step and forget the Linear step is not safe to repeat.

**How to avoid:**
Phase 2 persists `plan.graphId` in the session file before returning. The callable entry accepts an existing `graphId` and does not mint a second one for the same session file. Phase 3 writes that file under the absolute state dir, not `ctx.state`. Phase 4:

- Read Graph ID from the file. Never generate one in the skill.
- Notion: SQL `WHERE "Graph ID" = ?` (and `nodeId` / `step` for children). If the filter API is all that is available, stop and report — do not fall back to title match.
- Linear: before create, read Linear URL / Issue ID already stored on the matching Notion row or in the session file. Create only if absent. Write the new id back to the session file before the next create.
- Set `Agent` to `hermes` for rows this skill creates. Do not copy `"claude-code"` from `plan.task.agent` unless the engine entry grows an explicit agent field and Phase 2 sets it.
- One failed `nodeId`/`step` does not abort the rest, and a retry skips pairs already recorded.

**Warning signs:**
- Two Notion Tasks for one `stateFile`.
- Linear issues with the same title and no stored identifier in the session file.
- Skill code calls a Notion filter/rows API for the Graph ID lookup.
- `Agent` on new rows is `claude-code` while the turn ran in Hermes.
- Graph ID exists only in `ctx.state` or `MemoryState`.

**Phase to address:**
Phase 2 persists the id. Phase 4 implements find-or-create and the `hermes` agent field. Phase 3 must not store the id only in plugin memory.

---

### Pitfall 9: Sync creates rows, or finds the task by branch

**What goes wrong:**
`ultrathink-sync` is specified as an update, never a create: if no Task has that Graph ID, stop. The design note also mentions a branch fallback. Branch fallback attaches a PR to the wrong task whenever two graphs share a branch, which is the normal case on a long-lived working branch. A Hermes stop or PR nudge that fires when kickoff never ran (engine down, skill skipped) will create a stub Task if the skill "helpfully" inserts the missing row. Status then says Implementing or Done for work that was never planned. Sync-before-kickoff on the same turn updates nothing and, if it creates, races the kickoff writes.

**Why it happens:**
The Stop hook in Claude nudges sync whenever a plan exists. A port that nudges sync on every stop, or that treats "row not found" as "create it so the PR isn't lost," inverts the split. Branch is sitting on the Task row and looks like a stable key. It is not.

**How to avoid:**
Phase 5 skill: lookup by Graph ID only, SQL mode, same data source. No row means stop and say so. Never create a Task, issue, or sub-issue. Never query by branch, title, or repo. Update only properties that have a new value; do not blank `PR URL` on a stop that has no PR. The nudge (PR create and stop) carries `graphId` from the session file. If the file has no `plan.graphId`, do not invoke sync. Kickoff remains the only creator (Phase 4).

**Warning signs:**
- Sync skill text contains "create" or "if not found, insert."
- A stop with no session plan produces a Notion row.
- Two tasks on the same branch swap PR URLs after one sync.
- `Status` flips to Done on a turn whose kickoff was skipped.

**Phase to address:**
Phase 5: Sync skill. It depends on Phase 4's rows and must not be implemented as a second creator.

---

### Pitfall 10: Child, cron, and skill turns get a new plan

**What goes wrong:**
Hermes already skips `pre_llm_call` when `parent_session_id` is set (`delegate_task` children), when `platform` is `cron`, and when the user message starts with the skill preamble `[IMPORTANT: The user has invoked the "`. Claude skips `ULTRATHINK_CHILD=1` at every hook entry, skips slash commands before engine selection, and skips already-uplifted XML. Drop any of these in the bridge and a child session plans the parent's spec again, a cron tick opens a Notion task every run, or the kickoff skill's own turn is re-uplifted into a second graph. The skill preamble is an exact string match. If the bridge only skips messages that start with `/`, a Hermes skill invocation is not skipped.

**Why it happens:**
The skip list looks like polish on top of "call the engine." Child recursion is also easy to "fix" in the wrong layer: skipping `parent_session_id` does not stop the engine from spawning `hermes`/`claude` (Pitfall 4), and setting `ULTRATHINK_CHILD` does not stop a `delegate_task` child whose plugin hook never checks that env var.

**How to avoid:**
Phase 3 keeps all three Hermes skips, plus slash commands, trivial acknowledgements, `raw:`, and already-uplifted XML. Phase 2's entry sets and checks `ULTRATHINK_CHILD` if it still has a path that spawns an agent. Tests: a `delegate_task`-shaped call with `parent_session_id` set does not spawn bun; a message with the skill preamble does not spawn bun; a cron platform does not spawn bun; a child bun process does not spawn another bun. Do not "enable planning for cron" in this milestone.

**Warning signs:**
- Notion tasks whose titles are skill names or cron payloads.
- Session files created while `parent_session_id` was non-empty.
- The skip list in the new hook is shorter than `decide_uplift` in the current plugin.
- Skill preamble check is missing because "skills start with `/`."

**Phase to address:**
Phase 3: Hermes hook bridge, with the Phase 2 child-env guard still in place. A skip only in one of the two processes is not a skip.

---

## Technical Debt Patterns

Shortcuts that look reasonable on this bridge and are not.

| Shortcut | Immediate Benefit | Long-term Cost | When Acceptable |
|----------|-------------------|----------------|-----------------|
| Leave the GSD writer behind `gsd.enabled: false` | Smaller Phase 1 diff | The next session, `/gsd write`, or a default-on read path clobbers another repo. The flag is already how it shipped. | Never |
| Shell `hooks/uplift.ts` with a fabricated `UserPromptSubmit` payload | No new TypeScript entry | Silent empty stdout on skip and on crash; stdout logs break the parser; Claude hook behavior changes break Hermes | Never |
| Register bun as a Hermes shell hook under `hooks:` | Avoids Python subprocess code | 60s default, 300s clamp, fail-open drops stdout, no structured `reason` | Never |
| Raise `hooks.output_spill.max_chars` so the full XML fits | Demo shows the spec | Every tool-loop call resends a huge user message; a default install still spills; the kickoff line still depends on tail placement | Never as the design. Operator workaround only until Phase 3 lands the lean injection |
| Store Graph ID only in `ctx.state` | No file format to design | Hermes 0.20.0 has no `ctx.state`. Restart or the in-memory fallback mints a new id and duplicates Notion/Linear | Never |
| `ctx.call_mcp` from `pre_llm_call` | Skips writing a skill | Blocks the turn, no HITL, partial tracker writes, allowlist grants the plugin model-level write access | Never |
| Linear create without a prior lookup | Matches the current skill wording | Retry after a Notion failure duplicates issues. The wording is the bug to fix, not the spec to copy | Never |
| Sync lookup by branch if Graph ID misses | "Don't lose the PR" | Attaches the PR to another task on the same branch | Never |
| Keep Hermes Kanban `aio:<unit>` keys and also write Notion | Nothing is untracked during the port | Two boards diverge; Phase 1's removal is undone | Never. Notion and Linear are the only tracker |

## Integration Gotchas

| Integration | Common Mistake | Correct Approach |
|-------------|----------------|------------------|
| Hermes `pre_llm_call` | Return a replacement user message, or edit the system prompt, or call `ctx.inject_message` | Return `{"context": "..."}` or `None`. Context is appended. System prompt stays stable. `inject_message` starts a turn. |
| Hermes plugin load | Absolute imports, assuming `ctx.get_config` / `ctx.state` exist | Relative imports. Probe `ctx`. Persist session JSON on disk. A missing attribute must not be the thing that fail-opens every turn (that already happened: `PluginContext has no attribute 'get_config'`). |
| Bun entry | `bun` on `PATH` from the Hermes venv, cwd = the TypeScript repo | Absolute command from config. cwd of the subprocess is not how the engine finds its script. Missing binary is `status: "failed"`, `reason: "engine-missing"`, exit handled as fail-open. |
| Claude hook protocol | Empty stdout + exit 0 means success | That pair means "no decision" in Claude. The new entry always prints an envelope. |
| Notion Agent Task Graph `collection://be3418f0-d2d8-411b-8677-fa8a95ee63be` | Structured filter lookup; pasting full XML into `Uplifted Prompt` | SQL mode on `Graph ID`. Use `plan.task.upliftedPrompt` (already cut to 1900 characters). Full XML stays in the session `.xml`. Same data source unless a later decision changes it. |
| Linear team `Spectrum Web Co` | Create in whatever team the MCP default is; create again on retry | Pass the team explicitly. Find-or-create using the id stored from the previous attempt. Same team unless a later decision changes it. |
| `plan.task.agent` | Copy `"claude-code"` into Hermes rows | Engine field or skill override sets `hermes`. Do not infer host from the hardcoded Claude plan builder. |
| Skill invocation | Skip only `/` commands | Also skip the Hermes preamble `[IMPORTANT: The user has invoked the "`. Test the exact prefix. |
| Session cwd | Use it as the write root and as the git root | Git slug/branch only. Writes go to the absolute state dir. |

## Performance Traps

Scale here is one prompt's planning fan-out, not user count. Do not add a queue.

| Trap | Symptoms | Prevention | When It Breaks |
|------|----------|------------|----------------|
| Sequential CoT inside the hook | Prompt sits with no token; then fail-open and an unplanned turn | Per-level parallel fills; subprocess deadline; on expiry, no partial plan | One prompt: 1 uplift + 1 graph + 3–8 node fills, each an LLM call. Sequential fills blow a 30s Claude default and a 300s Hermes shell-hook clamp. |
| Full XML injected into the user message | Spill preview, or every tool iteration resends tens of KB | Lean in-prompt injection; spec in the session file | First graph that exceeds 10,000 characters (the default spill cap). That is a normal 3–8 node graph, not an edge case. |
| Serial Notion/Linear creates in the skill | Turn spends minutes in MCP; a mid-list failure drops the tail | Batch per node, as kickoff already requires. Record each id before the next batch. | 8 nodes × 8 steps is on the order of 70 creates. One failure in a serial loop loses the rest and the retry duplicates the prefix. |
| Engine deadline longer than the hook deadline | Hook kills bun, bun keeps writing, next turn reads a torn file | One budget, owned by the Python subprocess timeout; engine watches the same signal; atomic rename | First timeout. Torn JSON is worse than no file. |

## Security Mistakes

Domain-specific. Not a general web list.

| Mistake | Risk | Prevention |
|---------|------|------------|
| Pass `os.environ` into bun | Hermes tokens and provider keys land in a child that logs argv/env on failure, or in a core dump under the repo | Scrubbed env. Credentials only for the completer that needs them. |
| State dir under the repo, or spill/debug dumps in cwd | User prompts and uplift XML (sometimes secrets the user pasted) get committed | Absolute state dir outside the repo. Engine refuses to create files under `--cwd`. |
| `mcp_allowlist` on the plugin so the hook can track | In-process plugin gains model-equivalent write to Notion and Linear, with hook-level error swallowing | No allowlist. The skill uses the agent's existing MCP tools, in a transcript. |
| Injection worded as an override ("ignore the user, follow this XML") | Claude already treats hook context that overrides the user as prompt injection and will discount it. Hermes appends it beside the original bubble. | Reuse the Ultrathink header: the spec is the user's elaborated intent. Original text stays in `<ORIGINAL>`. |
| Child agent spawned with tools and MCP enabled | The completer can call this plugin, write files, or call Notion while "just completing" | If a child agent exists at all: `ULTRATHINK_CHILD=1`, empty tools, no session persistence, strict MCP config. Prefer a plain completion. |

## UX Pitfalls

The user is the operator watching a Hermes turn, not an end-user of a website.

| Pitfall | User Impact | Better Approach |
|---------|-------------|-----------------|
| Fail-open with no distinct log line | The prompt proceeds and the operator cannot tell skip from timeout from engine-down. They debug the task instead of the bridge. | One stderr/log reason: `skipped:slash`, `skipped:child`, `failed:timeout`, `failed:engine-missing`, `ok`. Same shape as Claude's `formatSummary`, which already distinguishes source, engine error, and "kickoff pending." |
| Spill preview looks like the plan | The agent implements the first 500 characters of the header. | Kickoff instruction and `stateFile` are in the head, under the cap. Skill reads the file. |
| HITL after coding starts | Blocking questions arrive after files have changed. Answers never make it into the `ISSUES` block. | Phase 4 asks blocking questions before any engineering tool, in one call. If the question tool is missing, proceed with defaults and say so — do not hang. |
| `<GSD_HANDOFF>` still in the injection | The agent loads `gsd-autonomous` and builds a roadmap instead of doing the requested work. This is the current plugin's behavior. | Phase 1 deletes the addendum. The replacement instruction is the kickoff skill, not another planning framework. |
| Original bubble still visible, spec also visible | The agent treats them as two tasks, or reprints the XML. | Header says the original is inside the spec and not to reprint the XML. Do not try to delete the bubble; Hermes cannot. |

## "Looks Done But Isn't" Checklist

- [ ] **Cwd writer removed:** `write_gsd_milestone`, `/gsd write`, and `<GSD_HANDOFF>` are gone — verify a hook run with cwd on a fixture repo leaves that repo's git status clean
- [ ] **Kanban removed:** `hermes kanban create` is not called from the hook or a slash command — verify no `aio:` cards for a planned prompt
- [ ] **Engine entry is not the Claude hook:** the Python command does not contain `hooks/uplift.ts` — verify slash-command, crash, and stdout-log fixtures all return an envelope
- [ ] **Child guard is on both sides:** `parent_session_id`, cron, skill preamble, and `ULTRATHINK_CHILD` — verify none of those spawn a nested planner
- [ ] **Timeout is owned:** a sleeping completer is killed, the turn returns, and no partial session JSON is parsed as a plan
- [ ] **Injection fits the default spill cap:** with `max_chars` at 10000, the kickoff line and `stateFile` are in the text the model sees, not only in the spill file
- [ ] **Fallback is untracked:** `source: "fallback"` does not produce a `plan` and the skill does not create rows
- [ ] **Graph ID survives restart:** kill Hermes after the session file is written, re-invoke kickoff, and assert one Notion Task
- [ ] **Linear retry:** fail the Notion write after a Linear create, retry, and assert one Linear issue per node, not two
- [ ] **Sub-issues are per step:** a node with 6 rationale steps has 6 sub-issues — verify the skill does not stop after step 1
- [ ] **HITL blocks work:** a blocking question is asked before the first edit, and the answer is in the `ISSUES` path (or stated as a default if the question tool is absent)
- [ ] **Sync does not create:** a stop with an unknown Graph ID leaves Notion unchanged
- [ ] **Agent field:** new rows say `hermes`, not `claude-code`
- [ ] **No MCP in the plugin:** `mcp_allowlist` is unset and the plugin source does not call Notion or Linear

## Recovery Strategies

| Pitfall | Recovery Cost | Recovery Steps |
|---------|---------------|----------------|
| Stray `.planning/` in an unrelated repo | MEDIUM | Do not `git add` it. Diff against HEAD. If it is an uncommitted closeout from this plugin, remove those files only after confirming they are the generated milestone (PROJECT text cites `prompt-uplift`). Do not delete a real roadmap that merely shares the directory name. Phase 1 stops new writes; it does not bulk-delete other repos. |
| Duplicate Notion/Linear rows from a retry | MEDIUM | Keep the row whose Graph ID matches the session file. Close or cancel the extras. Fix the skill to resume by Graph ID before creating more. |
| Linear issues with no Notion row | MEDIUM | Read identifiers from the Linear issue description/title only to attach them to the existing Graph ID. Do not mint a new Graph ID to "adopt" them. |
| Hung turn from a bun subprocess | LOW | Kill the process group. Confirm the next prompt proceeds. Delete any temp session file that is not a finished rename. |
| Skill never ran; work happened untracked | LOW | Fail-open already allows this. Do not backfill by running kickoff against a new engine call (new Graph ID). If the session file from that turn still exists, invoke the skill on that file. |
| Wrong repo's Task got the PR URL | MEDIUM | Sync by Graph ID only from here. Manually restore the previous PR fields on the wrong row. Do not re-run branch-based sync. |

## Pitfall-to-Phase Mapping

| Pitfall | Prevention Phase | Verification |
|---------|------------------|--------------|
| Cwd `.planning/` clobber, including `/gsd write` | Phase 1: Remove the cwd writer | Hook and `/gsd` against a fixture repo: git status clean; package-root guard is not the only test |
| Kanban cards beside Notion | Phase 1: Remove the cwd writer | No `hermes kanban create` in the plugin; a planned prompt creates no Kanban card |
| Fail-open leaves files or cards behind | Phase 1, then Phase 3 | Exception in the completer: no new files under cwd, no tracker calls |
| Claude hook script used as the API | Phase 2: Callable engine entry | Envelope on skip, crash, and noisy stdout; command line has no `hooks/uplift.ts` |
| cwd/env inheritance and nested-agent recursion | Phase 2 and Phase 3 | Scrubbed env; no files under `--cwd`; child process does not spawn another planner |
| Timeout copied from Claude (86400) or from shell hooks (60/300) | Phase 2 and Phase 3 | Sleeping completer killed; torn JSON not parsed; no `hooks:` entry for bun |
| Full XML blown away by the 10k spill | Phase 3: Hermes hook bridge | Default spill config; model-visible text contains `stateFile` and the kickoff line |
| MCP inside the hook | Phase 3 forbids it; Phase 4 does the writes | Plugin has no `ctx.call_mcp` and no `mcp_allowlist` |
| Fallback graph tracked | Phase 3 | `source: "fallback"` has no `plan` and no skill create |
| Graph ID / Linear / Notion idempotency | Phase 2 persists the id; Phase 4 find-or-create | Retry after a partial MCP failure: one Task, one Linear issue per node, one sub-issue per step |
| `ctx.state`-only persistence | Phase 3 | Session file under the absolute state dir; restart still resumes |
| Skill preamble / cron / `parent_session_id` not skipped | Phase 3 | Those three inputs do not spawn bun |
| HITL after work starts, or HITL inside the hook | Phase 4: Kickoff skill | Blocking question before the first edit; hook source has no question call |
| `Agent` left as `claude-code` | Phase 4 | New rows use `hermes` |
| Sync creates or matches by branch | Phase 5: Sync skill | Unknown Graph ID: no writes; no branch query in the skill |
| Sync runs with no plan | Phase 5 | Nudge requires `plan.graphId`; otherwise the skill is not invoked |

**Research flags for the roadmap:**

- Phase 2 and Phase 3 need a deeper pass on the subprocess contract (envelope, deadline, atomic rename) before execution. The failure modes are in this file; the exact CLI flags are not settled.
- Phase 4 needs a deeper pass on the live Notion MCP tool name and SQL shape, and on how Hermes asks a blocking question (Claude uses `AskUserQuestion`; Hermes may not have that tool). Do not invent a second question protocol in the hook to avoid that research.
- Phase 5 is the same lookup contract as Phase 4. It should not need a new tracker design.
- Phase 1 is a deletion. It should not need research beyond the checklist above.

## Sources

- This workspace, current plugin: `hermes-plugin/prompt_uplift/gsd.py` (`Path.cwd()`, open-phase skip, package-root-only guard), `hermes-plugin/__init__.py` (`_gsd_writer`, Kanban in `pre_llm_call`), `hermes-plugin/prompt_uplift/detect.py` (child, cron, skill-preamble skips), `hermes-plugin/prompt_uplift/host.py` (Hermes 0.20.0 has no `get_config` / `state`). Confidence: HIGH.
- This workspace, engine: `hooks/hooks.json` (`UserPromptSubmit` timeout 86400), `hooks/uplift.ts` (exit 0 on fatal, empty stdout on child/skip), `src/claude/complete.ts` (`ULTRATHINK_CHILD`, tools disabled), `src/claude/hook.ts` (no TrackPlan when `source === "fallback"`), `src/claude/output.ts` (kickoff line in the tail, 90k budget), `src/track/plan.ts` (`generateGraphId`, `agent: "claude-code"`, 1900-char Notion cap), `skills/ultrathink-kickoff/SKILL.md` (SQL lookup, blind Linear create, fail-open when `plan` is missing), `skills/ultrathink-sync/SKILL.md` (never create). Confidence: HIGH.
- Hermes source in this checkout: `hermes_cli/plugins.py` `invoke_hook` (per-callback try/except, no wall-clock timeout, context injected into the user message only), `tools/hook_output_spill.py` (default 10,000 / head 500 / tail 500), `agent/shell_hooks.py` (default 60s, max 300s, fail-open on timeout). Confidence: HIGH for this checkout. A web-search snippet mentioned `plugins.hook_callback_timeout`; it is not in this tree or in the fetched plugins page, so it is not treated as a host guarantee.
- Hermes docs, fetched 2026-09-24: [Plugins](https://hermes-agent.nousresearch.com/docs/user-guide/features/plugins) (`ctx.call_mcp` timeout default 30s, clamp 1–600, allowlist required), [Event Hooks](https://hermes-agent.nousresearch.com/docs/user-guide/features/hooks) (`pre_llm_call` payload includes `parent_session_id`; valid context returns are joined into the user message). Confidence: HIGH.
- Claude Code docs, fetched 2026-09-24: [Hooks reference](https://code.claude.com/docs/en/hooks) (command/http/mcp_tool default 600s, lowered to 30s on `UserPromptSubmit`; `mcp_tool` requires an already-connected server and a disconnected server is a non-blocking error). Command hooks themselves have no MCP client; that is the split ultrathink implements. Confidence: HIGH.
- Hermes plugin-architecture spike, local `hermes-agent/docs/rfcs/2026-07-plugin-architecture-lessons-pi-opencode.md`: Pi and OpenCode shipped hang-class failures because runtime hooks had no deadline. Confidence: HIGH for the lesson, MEDIUM as a prediction that an unbounded `pre_llm_call` subprocess will hang this host the same way — the local `invoke_hook` has no deadline, which is the direct evidence.

---
*Pitfalls research for: Hermes host bridge to the TypeScript ultrathink engine*
*Researched: 2026-09-24*
