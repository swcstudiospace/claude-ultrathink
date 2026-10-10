# Commands

ultrathink plans every non-trivial prompt by default. The commands on this page let you skip planning for one message, turn planning or Linear/Notion tracking off and on, and inspect state. They have the same names on all five hosts.

- [Skip and control commands](#skip-and-control-commands)
- [Per-host notes](#per-host-notes)
- [Prompt prefixes and automatic skips](#prompt-prefixes-and-automatic-skips)
- [Environment switches](#environment-switches)
- [CLI reference](#cli-reference)

## Skip and control commands

| Command | Effect |
|---|---|
| `/ultrathink-quick <message>` | Only this message goes to the agent. No planning, no Graph of Thought, no Linear/Notion rows. |
| `/ultrathink-skip` | The next message is not planned. |
| `/ultrathink-off` | Planning off for this host until you turn it back on. |
| `/ultrathink-on` | Planning back on for this host. |
| `/ultrathink-track off` | Planning continues, but no Linear/Notion rows are created. |
| `/ultrathink-track on` | Row creation back on. `/ultrathink-track` with no argument (or `status`) shows the tracking state. `on` and `off` are per-host settings that beat `track.enabled` in the config until you change them again. |
| `/ultrathink-status` | Shows planning, engine, Graph of Thought, HITL and tracking state, the configured Notion data source and Linear team, the Agent Substrate, ship, knowledge-base and Jev Decisions state, the Hindsight, RAGFlow and Teachable Moments lines, and the state directory. The output is the same as [`bin/ultrathink status`](#binultrathink). |

Some details:

- Nothing changes unless you use a command. Planning stays on by default.
- The state is per host. Each host has its own state directory (see [State directories](configuration.md#state-directories)), so `/ultrathink-off` in Omp leaves Claude Code planning. Within a host the setting applies to every session and project on the machine.
- `/ultrathink-skip` sets a one-shot flag. The next message that reaches the planner uses it up, even a trivial one such as `ok` or a skill invocation. Built-in slash commands and `raw:` messages do not use it up. `/ultrathink-status` shows `(skipping next prompt)` while it is armed.
- `/ultrathink-track off` stops every row: the planner creates none, and `ultrathink-kickoff` and `bin/ultrathink-mcp track complete` create none either. If neither `notion.dataSourceUrl` nor `linear.team` is configured, no rows are created whatever this setting says. See [Tracking](tracking.md).
- Commands are case-insensitive, and unknown verbs are not treated as commands.

### How control commands are answered

Every command except `quick` is answered by the prompt hook before any model turn runs:

| Host | Interactive | Headless |
|---|---|---|
| Claude Code | The `UserPromptSubmit` hook (`hooks/uplift.ts`) runs the command and returns `{"decision":"block","reason":"<reply>"}`. Claude Code blocks the prompt and shows the reply. | `claude -p` prints `UserPromptSubmit operation blocked by hook:` followed by the reply. |
| Grok Build | The same hook, run from the global hook file. Grok blocks the prompt and shows the reply. | `grok -p` prints nothing for a blocked command. |
| Muse Code | The same hook, run by `hooks/muse-prompt`. Muse blocks the prompt and shows the reply. | `muse exec` ends the run as `Cancelled`. |
| Omp | The extension registers the commands. The reply appears as an Omp notification. | `omp -p` shows no notifications, and it exits before a `/ultrathink-quick` message runs. Use the interactive UI. |
| Hermes Agent | The plugin registers the commands. The command dispatcher replies inline. | Same. |

In every case no model turn runs, and the command takes effect even when nothing is printed. From scripts, call [`bin/ultrathink`](#binultrathink) directly.

On Claude Code, Grok and Muse, each command also ships as a command file in `commands/`. If the hook did not run, for example because hooks are not approved or not installed, the host expands that file instead. The file tells the model to run `"${CLAUDE_PLUGIN_ROOT}/bin/ultrathink" <verb>` with its shell tool and reply with the output, so the command still works, just with a model turn. When `CLAUDE_PLUGIN_ROOT` is not set in that shell, the model does not search for or run any other `bin/ultrathink`: it asks you for the directory where you installed ultrathink (the one holding both `bin/ultrathink` and `hooks/hooks.json`), then runs `"<that directory>/bin/ultrathink" <verb>`.

`/ultrathink-quick` works differently. The hook recognizes it and plans nothing, and no plan is written. The host's command template (`commands/ultrathink-quick.md`) or host adapter then delivers your message to the agent as typed.

## Per-host notes

### Claude Code

- Plugin commands are also listed under the plugin namespace, as `/ultrathink:ultrathink-quick`, `/ultrathink:ultrathink-status` and so on. Both the short and the namespaced forms work.
- The older typed forms `/ultrathink:<verb>` (for example `/ultrathink:off`) and `/ultrathink <verb>` are still recognized.
- `quick` expands `commands/ultrathink-quick.md`: the model receives your message with a note that planning and tracking were skipped for it.
- `claude -p` prints a control command's reply as `UserPromptSubmit operation blocked by hook:` followed by the reply.

### Grok Build

- Grok does not dispatch plugin hooks, so the commands only get a no-model-turn answer after `bun scripts/setup.ts apply` has installed the global hook file `~/.grok/hooks/ultrathink.json` (`$GROK_HOME/hooks/ultrathink.json` when `GROK_HOME` is set; see [Install](install.md) and [`scripts/setup.ts`](#scriptssetupts)). Without that file, Grok still loads the command files from the plugin directory, and the model runs `bin/ultrathink` itself.
- With the hook file installed, the hook returns a block decision for a control command. Grok blocks the prompt and shows the reply in the interactive UI. `grok -p` prints nothing for a blocked command.
- `/ultrathink-quick` and the control commands delete the plan carrier `last-plan.json`, as every prompt that isn't planned does, so the model never picks up the previous prompt's plan for them.
- Grok wraps what you typed in a `<user_query>` element before hooks see it. Commands are parsed inside that wrapper.

### Muse Code

- The commands are the capability ids declared in `.muse-plugin/plugin.json`: `ultrathink-quick`, `ultrathink-skip`, `ultrathink-off`, `ultrathink-on`, `ultrathink-track` and `ultrathink-status`.
- Muse activates skills and commands as soon as the plugin is enabled, but hooks only run after review: `muse plugins approve ultrathink`. The hook ids are `plugin:ultrathink:hook:user-prompt-submit`, `plugin:ultrathink:hook:post-tool-use` and `plugin:ultrathink:hook:stop`. Until they are approved, commands fall back to the model running `bin/ultrathink`, and nothing is planned.
- Muse speaks the Claude hook protocol. `hooks/muse-prompt` runs the same `hooks/uplift.ts` with `ULTRATHINK_HOST=muse`, so a control command gets the same block-and-reply as in Claude Code. In the interactive UI the reply is shown. `muse exec` ends the run as `Cancelled`.

### Omp

- The extension (`src/host/omp.ts`) registers `/ultrathink-quick`, `/ultrathink-skip`, `/ultrathink-off`, `/ultrathink-on`, `/ultrathink-track` (with `on`/`off` completions), `/ultrathink-status`, `/ultrathink-ui` (with `overview`/`jev`/`moments`/`skills`/`card` completions) and `/ultrathink-swarm`.
- Control commands reply with an Omp notification. No model turn runs. `omp -p` shows no notifications and exits before a quick message runs, so use the interactive UI for these commands.
- `/ultrathink-quick <message>` sends the message to the agent as a normal user message and skips planning, tracking and the status bar for exactly that message. Without a message it shows a usage notification.
- In a task-subagent session the commands do nothing special: the typed text goes to the agent unchanged.

#### `/ultrathink-swarm` swarm teams

`/ultrathink-swarm <brief>|<brief>|…` fans out one AgentSwarm orchestrator lane per brief from a single command, and `/ultrathink-swarm status` reports every lane's task counts. Each lane is a detached `python3 <swarm root>/hooks/autonomous_run.py --runtime omp --cwd <repo> --brief <brief>` process, so lanes keep running when the session ends.

- **Lanes and limits.** Briefs are separated by `|` and trimmed; empty segments are dropped. The default limit is 3 lanes per command; `ULTRATHINK_SWARM_MAX_LANES` raises it, capped at 6. More briefs than the limit is a usage reply, never a partial spawn.
- **Isolation.** Each lane runs with its own `SWARM_DIR` (`<state dir>/swarm/<sha8 of brief>-<lane index>`), so the per-lane Task Store (SQLite plus `kickoffs/` locks) and the runner's own logs never contend across concurrent lanes. `status` finds lanes by scanning those directories, and works in child sessions like the other commands.
- **Logs.** A lane's `stdout` and `stderr` are appended to `<lane state dir>/run.log`; the spawn reply lists every lane's state directory and log path, and `N/M spawned` counts lanes that actually started (a lane that fails to start is one error line, never a failed command).
- **Status.** `status` probes each lane's Task Store with `orch_status.py --json --repo <repo>` (10s cap per lane) and prints one line per lane: total tasks, per-state counts, and how many are done (`DONE`, `APPROVED` or `CANCELLED`). In the Omp TUI, spawn and status replies publish a native `ultrathink-swarm` card instead of plain text when a card renderer is registered: compact cards lead with counts and show up to six lane rows, expanded cards wrap each lane's identity, brief, state directory, log path and worker pid within a 24-row budget; a counted omission notice points to `/ultrathink-swarm status` for the full list, malformed card data renders a safe fallback, and hosts without a card surface keep the plain-text replies.
- **Environment.** `ULTRATHINK_SWARM_ROOT` must point at an absolute agent-swarm checkout containing `hooks/autonomous_run.py`; without it the command refuses with the reason. `SWARM_AUTONOMOUS_RUN_CAP_S` is passed through to each lane's runner when set.
- **pstack.** When a pstack plugin cache resolves for the user, the mapped `orchestrate` skills block is appended to each lane's brief; if it does not resolve, the block is dropped silently and the lanes still run.

#### `/ultrathink-ui` native dashboard

`/ultrathink-ui [overview|jev|moments|skills|card]` opens a native keyboard-driven dashboard in the Omp TUI (default `overview`); `card` publishes a captured summary card instead of opening the dashboard. It is native-only: no browser, no React, no extra runtime, and the shipped Vercel Jev rail is unchanged. Nothing opens on its own — no dashboard or card appears per turn, capture or promotion.

- **Panels.** `overview` shows the latest recorded decision summary (or its no-history state), project lesson lifecycle counts and effective autonomy status. `jev` lists the saved decisions of the latest saved plan for the current session, newest first, with details (outcome, model label, recorded question probabilities, threshold, action, latency, attempts, settled time; cost only when recorded). `moments` lists current-project lessons with lifecycle, occurrences and details; `skills` shows effective capture/recall/auto-promotion status with eligible and promoted rows.
- **What the data means.** Jev history is the latest saved plan for the active session, not a complete history. Teaching/skillworthy verdicts and detached-worker outcomes are not recorded and are never inferred. `Eligible by saved lesson rules` is a deterministic saved-lesson rule outcome, not a new Jev verdict. A recorded promotion is a promotion receipt, never proof that a skill file is currently installed or loaded.
- **Keys.** `Tab`/`Shift+Tab` move focus (tabs, list, details, actions); `←`/`→` choose panel or action; `↑`/`↓` move the list cursor or scroll details; `Enter` opens details or runs the focused named action; `r` reloads the local snapshot (in preview it discards the draft and returns to refreshed details; disabled while confirming); `Esc` steps back without mutating, or closes the dashboard at the panel root; `PageUp`/`PageDown` page the focused viewport where supported. Confirmation screens start focused on the non-mutating choice (`Keep candidate`, `Keep preview`), and the Enter that opens them never activates the affirmative choice.
- **Reading and focus.** Opening shows a local loading indicator. Lesson bodies and the complete draft preserve indentation and repeated spaces; long provenance and draft text remain reachable by scrolling. Partial snapshots and read limits qualify every affected panel. Teaching-off controls are labeled unavailable. Preview focus cycles only between its text and actions; `Back to lesson` restores the selected detail, and closing preserves the composer draft.
- **Pending operations and receipts.** Busy controls stay unavailable with an in-progress reason. Successful command receipts retain their complete bounded destination/promotion-time text through the follow-up refresh. Populated Overview includes the recorded Jev threshold and latest-saved-plan qualifier; that historical threshold is distinct from the current promotion policy.
- **Guarded actions.** A `candidate` lesson offers `Confirm candidate` (explicit confirmation through the existing teaching command; existing retention may retain remotely, queue, stay local-only or report an error). An eligible confirmed lesson offers `Preview skill draft`: a complete deterministic draft shown `Preview only — not installed`. `Install into Omp` opens a separate confirmation and, on a fresh affirmative Enter, revalidates session, project, lesson revision, eligibility and draft fingerprint before running the existing installer for the Omp target only. The installer stays authoritative: authored, foreign, symlinked or conflicting slots are refused, and a stale preview (lesson, content, config or session changed) refuses and requires a new preview. Cancellation stops owned UI work before dispatch; it never rolls back a write already begun.
- **Limits.** Browsing, refresh, detail views and preview are passive and local: no store creation, recall-count bump, credential lookup, network, model or Jev call. Below 24 columns or 8 rows, mutation is unavailable (resize guidance is shown; browsing and `Esc` still work). In a task-subagent session, with `createOmpExtension({ ui: false })`, or outside the TUI (`omp -p`, RPC, headless), the command answers with bounded read-only text instead of the interactive dashboard; guarded actions need the Omp TUI. Switching session or shutting down closes the dashboard and suppresses stale refresh/action completions for the old selection.
- **Headless summaries.** Plain-text fallback reports displayed versus snapshot lesson counts and explicitly identifies lessons omitted by its 24-row budget. Those snapshot counts are not a complete project inventory when the read model reports a partial scan.
- **Host failures and Jev off.** A current native custom-UI mounting failure degrades to the same bounded read-only snapshot without starting a model turn; a stale or aborted mount emits nothing. `ULTRATHINK_DECISIONS=0` marks current Jev policy off in the dashboard and expanded captured card, but does not hide saved decisions or resolve credentials.
- **Cards.** Compact cards show scope, latest-decision, lesson-lifecycle and autonomy summaries plus a limitation line (at most 6 content rows), including capture omissions when lesson summaries exceed the 24-per-collection card bound. Expanded cards reflow recorded Jev metadata to terminal cell width, add up to 3 lesson and 3 eligible/promoted summaries, and reserve space for effective policy, counts and actionable limitations (at most 24 physical content rows). Additional detail lines are explicitly omitted with an `N more — open /ultrathink-ui` notice. Every card is labeled `captured — not live` with its snapshot time: expanding an old card never re-reads state or proves current installation.

### Prime Agent

- Prime Agent has no command hook, so the `/ultrathink-*` names are instructions the agent carries out through the `ultrathink` kernel skill: `ultrathink.ctl("status")`, `ctl("off")`, `ctl("on")`, `ctl("skip")`, `ctl("track", "off"|"on")`, and `ctl("think", ...)`, `ctl("hitl", ...)`, `ctl("grok", "engine", ...)` for the verbs the other hosts leave to `bin/ultrathink`. Each call runs `bin/ultrathink` against the Prime Agent state directory and returns its text.
- `/ultrathink-quick <message>`: the agent answers the message without calling the planner. `raw:` and `uplift:` prefixes work as everywhere; `await ultrathink(text, raw=True)` and `force=True` add them.
- `ultrathink.status()` returns the clone, state directory, session id and the status text; `ultrathink.last()` the carrier of the last plan; `ultrathink.spec()` its XML.
- The shell form `ultrathink "<request>" --force` is the same call from a `bash()` cell.

### Hermes Agent

- The plugin (`hosts/hermes/__init__.py`) registers `ultrathink-quick`, `ultrathink-skip`, `ultrathink-off`, `ultrathink-on`, `ultrathink-track` and `ultrathink-status`. Control commands run `bin/ultrathink` against the Hermes state directory, and the command dispatcher replies inline. A command that gets no answer within 20 seconds reports that instead.
- `/ultrathink-quick <message>` hands the message to Hermes through `inject_message` as the next user turn, which `pre_llm_call` then leaves unplanned. This works in the Hermes CLI.
- In gateways (Telegram, Discord, Slack and so on), `inject_message` needs `plugins.entries.ultrathink.allow_gateway_injection: true` in the Hermes config. Without it, or wherever Hermes cannot inject (the TUI, an older Hermes), `quick` arms a skip for your next message and replies: `Ultrathink will not plan your next message. Send it now (or prefix any message with raw:).` `/ultrathink-quick` with no message does the same.
- The names use hyphens, not colons. Chat command menus accept only a restricted character set, and a single colon name stops Discord from listing the plugin commands that follow it. Telegram menus show the commands with underscores: `ultrathink_status`, `ultrathink_quick` and so on.
- `/ultrathink-learn <note>` saves the note as a `pattern` lesson (the name is its first sentence). It does nothing useful while `teach.enabled` is off. `/ultrathink-lessons` with no argument lists lessons. `recall <query>`, `promote <id>` and `status` are the other verbs. `promote` stages a draft through Hermes `skill_manage`; ultrathink does not write `~/.hermes/skills`. See [Teachable Moments on Hermes](how-to/teachable-moments-on-hermes.md) (`docs/how-to/teachable-moments-on-hermes.md`).
- In a shared multi-user gateway session, Hermes puts a sender tag such as `[Alice] ` in front of each message. The plugin strips a leading tag that names the current sender before its checks (a label you type, such as `[backend]`, stays), so the tag stops neither a `quick` message from matching nor the `raw:` prefix and the [automatic skips](#prompt-prefixes-and-automatic-skips) from applying, and the engine plans the untagged text.

## Prompt prefixes and automatic skips

| Input | Effect |
|---|---|
| `raw: <message>` | Not planned and not tracked. The agent gets the message as you sent it. |
| `uplift: <message>` | Planned even when planning is off and even when the message is trivial. |

The prefixes are case-insensitive. A one-shot `/ultrathink-skip` still wins over `uplift:`.

These prompts are skipped automatically, with no command needed:

- Trivial acknowledgements: `yes`, `y`, `no`, `n`, `ok`, `okay`, `k`, `continue`, `go`, `go ahead`, `do it`, `please`, `thanks`, `thank you`, `sure`, `yep`, `nope`, `lgtm`, optionally followed by punctuation. Set `uplift.skipTrivial: false` to plan them (see [Configuration](configuration.md)).
- Slash commands that are built in or unknown, such as `/model` or `/clear`. A slash command that resolves to a skill or command file is planned: ultrathink plans the text you typed after the skill, or the skill's own objective when you typed nothing. The skill's instructions stay authoritative for how the work is done.
- ultrathink's own skills (`ultrathink-kickoff`, `ultrathink-sync`, `ultrathink-plan`, `ultrathink-ship`) and commands, so they never re-plan.
- Prompts that already are an uplifted spec (they start with the spec's root XML element).
- Subagent sessions, and child processes that ultrathink itself started.
- On Hermes, cron runs and sessions with a parent session. On Omp, task-subagent sessions.

## Environment switches

Set these in the environment of the host process. They override config and the control commands.

| Variable | Effect |
|---|---|
| `ULTRATHINK_UPLIFT=0` | No planning at all for this process. Useful for automation and `claude -p` runners. |
| `ULTRATHINK_TRACK=0` | The planner creates no Linear/Notion rows. Planning continues, and `ultrathink-kickoff` creates the rows in the agent's turn instead. With a tracker configured, `/ultrathink-status` shows `Tracking: kickoff`. `track.enabled: false` in config does the same, unless `/ultrathink-track on` was run on that host (the per-host setting beats `track.enabled`; this variable beats both). |
| `ULTRATHINK_SHIP=0` | No ship nudge and no `## Ship` section in the plan, even with `ship.enabled: true`. See [Ship](ship.md). |
| `ULTRATHINK_DECISIONS=0` | No Jev decision at any point, whatever the config says: no request, no decision record, no plan-skip notice. It is the only off switch. `/ultrathink-status` shows `Decisions: off (ULTRATHINK_DECISIONS=0)`, and `bin/ultrathink decisions check` and `decisions probe` refuse with exit 1. See [Use Jev decisions](how-to/use-jev-decisions.md#turn-it-off-again). |
| `ULTRATHINK_HINDSIGHT=0` | No Hindsight request, even with `hindsight.enabled: true`. `/ultrathink-status` shows `Hindsight: off (ULTRATHINK_HINDSIGHT=0)`. |
| `ULTRATHINK_RAGFLOW=0` | No RAGFlow request, even with `ragflow.enabled: true`. `/ultrathink-status` shows `RAGFlow: off (ULTRATHINK_RAGFLOW=0)`. |
| `ULTRATHINK_TEACH=0` | No lesson capture, recall or promote while Teachable Moments would otherwise be on. See [Configuration](configuration.md#teach-teachable-moments). |
| `ULTRATHINK_DEBUG=1` | `hooks/uplift.ts` (Claude Code, Grok, Muse) logs every skip reason and failure to stderr as `[ultrathink] …`. With Jev decisions on, every decision also logs one `[ultrathink] decisions <point> · …` line (P or the error kind, model, latency, attempts, cost; never the message or the key). |
| `ULTRATHINK_HOST` | Forces the host id: `claude-code`, `grok-build`, `hermes`, `muse` or `omp`. This selects the state directory, which matters for `bin/ultrathink` run from a plain terminal. |
| `ULTRATHINK_STATE_DIR` | Overrides the state directory. Use an absolute path (a relative one resolves differently per host; see [Configuration](configuration.md#environment-variables)). It is ignored if it points into a `.planning/` directory. |

The other variables (credential store, OAuth callback and Tailscale opt-in, Hermes timeout, Agent Substrate, Jev keys and Decisions endpoint, GSD tools, Bun) are listed in [Configuration: Environment variables](configuration.md#environment-variables).

## CLI reference

The three CLIs `bin/ultrathink`, `bin/ultrathink-mcp` and `bin/ultrathink-ship` are POSIX shell wrappers that follow symlinks to the checkout and run through `bin/run-bun`, which finds `bun` even when it is not on `PATH` (see [Finding Bun](configuration.md#finding-bun)). Without Bun they print `ultrathink: bun not found. Install Bun 1.2 or later (https://bun.sh) or set BUN=/path/to/bun` and exit 127.

The two setup scripts, [`scripts/setup.ts`](#scriptssetupts) and [`scripts/mcp-register.ts`](#scriptsmcp-registerts), are run with `bun` from the checkout.

### `bin/ultrathink`

Planner controls. It uses the same code (`src/uplift/commands.ts`) as the slash commands.

```text
Usage: ultrathink <command>
  status                 planning, tracking and engine state
  off | on               planning off/on for this host until changed
  skip                   do not plan the next message
  track off|on|status    keep planning; stop/start creating Linear/Notion rows
  last                   the last uplifted spec
  think on|off|last      Graph of Thought
  hitl on|off|last       HITL clarifications
  grok [engine auto|claude|grok|muse]
  decisions check        one live Jev decision: resolved model, latency, cost
  decisions probe <plan|ship|knowledge|blocking|teachable|skillworthy> <cases.json>
  hindsight check        Hindsight memory server: readiness, health, optional round trip
  ragflow check|datasets|search "<query>"   RAGFlow document search
  teach status|list|show|capture|recall|confirm|forget|sync|observe|promote|export   Teachable Moments
In an agent: /ultrathink-status, /ultrathink-off, /ultrathink-on, /ultrathink-skip, /ultrathink-track off|on,
and /ultrathink-quick <message> sends one message as typed (no planning, no Linear/Notion rows).
  doctor [--json]        check config files, credentials, state and environment
  prune [--older-than <days>] [--dry-run]   remove session records older than that many days (nothing is removed by default)
```

The top-level help and the `decisions` subcommand both list all six probe points. A bad `decisions` argument prints the decisions usage and exits 2. `hindsight`, `ragflow`, `teach`, `doctor` and `prune` have their own usage text, also exit 2. See the sections below.

| Verb | Effect |
|---|---|
| `status` (also the default with no verb) | Full state, one line per item. See the example below. |
| `off`, `on`, `skip` | As the slash commands. |
| `track on`, `track off`, `track status` | As `/ultrathink-track`. |
| `last` | Root element and source (`llm` or `fallback`) of the last uplift, then its XML. |
| `think on`, `think off`, `think status` | Graph of Thought on or off for this host. With it off, the prompt is still uplifted and clarified. |
| `think last` | Goal and node sketch of the last graph. |
| `hitl on`, `hitl off`, `hitl status` | HITL clarifications on or off for this host. |
| `hitl last` | The clarifications of the last plan, with answers. |
| `grok` or `grok status` | Engine label, Grok model, effort and transport, and Grok login state. |
| `grok engine auto`, `grok engine claude`, `grok engine grok`, `grok engine muse` | Switches the planning engine for this host (`auto` follows `think.engine`). |
| `decisions check` | One live Jev decision to prove the integration end to end. See [`bin/ultrathink decisions`](#binultrathink-decisions). |
| `decisions probe <plan\|ship\|knowledge\|blocking\|teachable\|skillworthy> <cases.json>` | Runs your own cases through one decision point and prints P and the action under the current thresholds. See [`bin/ultrathink decisions`](#binultrathink-decisions). |
| `hindsight check [--roundtrip] [--json]` | Readiness, `/health` and `/version`, and an optional throwaway-bank round trip. Exit 0, 1 or 2. See [`bin/ultrathink hindsight`](#binultrathink-hindsight). |
| `ragflow check\|datasets\|search` | Dataset probe, dataset list, or a search. Exit 0, 1 or 2. See [`bin/ultrathink ragflow`](#binultrathink-ragflow). |
| `teach …` | Teachable Moments. Exit 0, 1 or 2. See [`bin/ultrathink teach`](#binultrathink-teach). |
| `doctor [--json]` | Static, offline check of the config files, credentials, state directory and runtime. Exit 0, 1 or 2. See [`bin/ultrathink doctor`](#binultrathink-doctor). |
| `prune [--older-than <days>] [--dry-run]` | Removes session records older than the cutoff. Nothing is removed by default, and `--dry-run` deletes nothing. Exit 0, 1 or 2. See [`bin/ultrathink prune`](#binultrathink-prune). |

The state directory comes from `ULTRATHINK_HOST`, or else from the detected host. A plain terminal is detected as Claude Code. To change another host's state from a terminal, set the host explicitly:

```sh
ULTRATHINK_HOST=omp <clone>/bin/ultrathink off
ULTRATHINK_HOST=grok-build <clone>/bin/ultrathink status
```

`bun hooks/uplift.ts --ctl <verb> [args]` is the older spelling of the same commands. An unknown verb prints the usage text.

Example `status` output on a fresh install (the state path is shortened):

```text
Prompt Uplift on
Engine: claude:sonnet
Grok: grok-4.7 @ xhigh · transport http
SuperGrok OAuth: not logged in (run grok login)
Graph of Thought on
HITL clarifications on · max 4
Tracking: on (not configured: set notion.dataSourceUrl / linear.team)
Notion: not configured
Linear team: not configured
Substrate: off (optional: set substrate.url or SUBSTRATE_URL)
Ship: off (opt-in: set ship.enabled)
Knowledge base: off (opt-in: set hitl.knowledgeBase)
Decisions: on · no Jev key (Vercel: bin/ultrathink-mcp auth set-key vercel --stdin or AI_GATEWAY_API_KEY; OpenRouter: bin/ultrathink-mcp auth set-key openrouter --stdin or OPENROUTER_API_KEY)
Hindsight: off (opt-in: set hindsight.enabled)
RAGFlow: off (opt-in: set ragflow.enabled)
Teach: on · capture auto · recall on · 0 confirmed, 0 candidate · Hindsight off · outbox 0
Engine request: auto (config) · concurrency 3
State: ~/.claude/ultrathink
```

What the lines can say:

| Line | Values |
|---|---|
| `Prompt Uplift` | `on` or `off`, plus `(skipping next prompt)` while a `/ultrathink-skip` is armed. |
| `Engine` | The current engine label: `claude:<model>` (`claude:session default` when `claude.model` is `""`), the Grok label (`<model>@<effort>`, or `<model>@shunt`), or `muse:<model>`. On a CLI route, a provider set in `models.hosts.<host>.provider` shows `<engine>:unresolved [transport-incompatible]`. On Omp with `auto` it is the planning model the session last used, for example `omp-native:<provider>/<model> [detected]`, or `omp-native:auto (live model not observed)` before the first plan and from a shell. |
| `Grok` | Model, effort and transport. With `transport: "shunt"` it adds `<shuntBaseUrl>/v1/messages`, or `shunt gateway not configured (set grok.shuntBaseUrl)`, then the wire model and `max_tokens`. |
| `SuperGrok OAuth` | The `grok login` state: the account and expiry, `not logged in (run grok login)`, `expired (run grok login)`, or `not used (shunt gateway owns upstream auth)`. |
| `Tracking` | `on (Linear/Notion rows)`, `off (Linear/Notion rows)` after `/ultrathink-track off`, `on (not configured: …)` when neither tracker is set, or `kickoff (…)` when only the planner's own row creation is off. |
| `Notion`, `Linear team` | The configured value or `not configured`. |
| `Substrate` | `off (optional: set substrate.url or SUBSTRATE_URL)`, `off (SUBSTRATE_DISABLED=1)`, or `<url> (SUBSTRATE_URL)` / `<url> (config)` showing where the URL came from. |
| `Ship` | `off (opt-in: set ship.enabled)`, `off (ULTRATHINK_SHIP=0)`, or `on · auto-merge on\|off · delete branch on\|off`. |
| `Knowledge base` | The Greptile knowledge-base read before the clarifying questions (see [`hitl.knowledgeBase`](configuration.md#hitl-clarifying-questions)): `off (opt-in: set hitl.knowledgeBase)`; `on · not read while HITL is off`; `on · no Greptile credential (run bin/ultrathink-mcp auth login greptile)`; or `on · Greptile` (`on · Greptile · organization <org>` when `ship.greptileOrganization` is set). |
| `Decisions` | Jev decisions over OpenRouter or Vercel (see [`decisions`](configuration.md#decisions-jev-decisions-openrouter-decisions-api)): `off (ULTRATHINK_DECISIONS=0)` when that variable is set, whatever the config says; `on · no Jev key (…)` when there is no key for the resolved rail; or `on · <model> · <points> · provider <vercel\|openrouter> · key from <source> · zdr on\|off`, where `<points>` is the `decisions.points` list joined by `, ` (or `no points`), `<source>` is `store`, `AI_GATEWAY_API_KEY` or `OPENROUTER_API_KEY` (never the key), and, on the OpenRouter rail only, ` · url <url>` (origin and path only) is added while `ULTRATHINK_DECISIONS_URL` is in effect, or ` · ULTRATHINK_DECISIONS_URL ignored (must be https://openrouter.ai/… or a loopback URL)` when it is set but not accepted. |
| `Engine request` | The engine asked for, where the request comes from (`config`, or `control` after `bin/ultrathink grok engine …`), `native opt-out` when a named engine replaces Omp's native planning, and `claude.concurrency`. For example `Engine request: auto (config) · concurrency 3`. |
| `State` | The state directory in use. |
| `Hindsight` | Starts with `Hindsight: `. `off (ULTRATHINK_HINDSIGHT=0)`; `off (opt-in: set hindsight.enabled)`; `on · no URL (set hindsight.url or HINDSIGHT_API_URL)`; `on · bad URL (<reason>)`; `on · no key (run bin/ultrathink-mcp auth set-key hindsight --stdin, or set HINDSIGHT_API_KEY)`; or `on · <origin> · bank <bank> · key from <store|HINDSIGHT_API_KEY|HINDSIGHT_API_TOKEN>`. Never the key, never a URL path. |
| `RAGFlow` | Starts with `RAGFlow: `. `off (ULTRATHINK_RAGFLOW=0)`; `off (opt-in: set ragflow.enabled)`; `on · no URL (set ragflow.url or RAGFLOW_URL)`; `on · bad URL (<reason>)`; `on · no key (run bin/ultrathink-mcp auth set-key ragflow --stdin, or set RAGFLOW_API_KEY)`; or `on · <origin> · key from <store|RAGFLOW_API_KEY> · grounding on|off · <n> dataset(s) pinned` (or `all datasets`). |
| `Teach` | Starts with `Teach: `. `off (opt-in: set teach.enabled)` while `teach.enabled` is false, even if `ULTRATHINK_TEACH=0` is set; `off (ULTRATHINK_TEACH=0)` when enabled and that variable is `0`; or `on · capture <mode> · recall on|off · <n> confirmed, <m> candidate · Hindsight <ready|off|no URL|bad URL|no key> · outbox <k>`. |
| `Last` | Only after a plan: root element, source (`llm` or `fallback`) and node count of the last plan. |
| `Last planned resolution` | Only after a plan that recorded its model: the model line of the last plan, for example `claude:sonnet [route default] · reason route-default-model · engine auto (config)`. It is what planned last time, not a live check. See [Planning model states](how-to/choose-engine.md#planning-model-states). |

The `Decisions:` line in full, in its three forms:

- `Decisions: off (ULTRATHINK_DECISIONS=0)`: `ULTRATHINK_DECISIONS=0` is set in the environment. It is the only off switch, and no point sends a request.
- `Decisions: on · no Jev key (Vercel: bin/ultrathink-mcp auth set-key vercel --stdin or AI_GATEWAY_API_KEY; OpenRouter: bin/ultrathink-mcp auth set-key openrouter --stdin or OPENROUTER_API_KEY)`: no key for the resolved rail, so no point sends a request.
- `Decisions: on · ~typesafe/jev-latest · plan, ship, knowledge, blocking, teachable, skillworthy · provider vercel · key from store · zdr on`: ready with the defaults and a stored key. With no stored key and the key in the environment it reads `… provider vercel · key from AI_GATEWAY_API_KEY · zdr on`, and on the OpenRouter rail `… provider openrouter · key from store · zdr on`.

On the OpenRouter rail, the ready form ends with ` · url <url>` while an accepted `ULTRATHINK_DECISIONS_URL` is in effect, showing only its origin and path, or with ` · ULTRATHINK_DECISIONS_URL ignored (must be https://openrouter.ai/… or a loopback URL)` when it is set but not accepted; requests then go to the default endpoint. The Vercel rail never shows it. See [Configuration: Environment variables](configuration.md#environment-variables).

#### `bin/ultrathink decisions`

Operator tools for [Jev decisions](how-to/use-jev-decisions.md). Both read the `decisions` config for the current directory (`provider`, `model`, `zdr`, `timeoutMs` and the thresholds) and ignore `decisions.enabled` and `decisions.points`. `ULTRATHINK_DECISIONS=0` still applies: with it set, both refuse without a request. Both need a Jev key for the resolved rail (stored with `bin/ultrathink-mcp auth set-key vercel --stdin` or `bin/ultrathink-mcp auth set-key openrouter --stdin`, or `AI_GATEWAY_API_KEY` / `OPENROUTER_API_KEY`) and send real requests to that rail; one OpenRouter decision costs about $0.000019.

```text
Usage: ultrathink decisions check | ultrathink decisions probe <plan|ship|knowledge|blocking|teachable|skillworthy> <cases.json>
```

Any other arguments print that usage line and exit 2.

`decisions check` sends one plan-gate decision about a fixed test message (`Add a --verbose flag to the export command`, no session id) and prints one line, for example:

```text
Decisions check: ok · typesafe/jev-1.13-20260917 (requested ~typesafe/jev-latest) · 512 ms · attempts 1 · cost 0.000019 · provider openrouter · zdr on · key from store
```

| Result | Output | Exit |
|---|---|---|
| Answered | `Decisions check: ok · <resolved model> (requested <decisions.model>) · <ms> ms · attempts <n> · cost <cost> · provider <vercel\|openrouter> · zdr on\|off · key from <store\|AI_GATEWAY_API_KEY\|OPENROUTER_API_KEY>`. `<cost>` is `n/a` when the rail reports none (Vercel always reports none). | 0 |
| Failed | `Decisions check: error (<kind>) · <message> · <ms> ms · attempts <n> · provider <vercel\|openrouter> · zdr on\|off · key from <source>`. `<message>` is the redacted one-line error, for example `decisions auth: HTTP 401: User not found.` See [Troubleshooting: Decisions](troubleshooting.md#decisions) for every `<kind>`. | 1 |
| Turned off | `Decisions check: off (ULTRATHINK_DECISIONS=0)`, with `ULTRATHINK_DECISIONS=0` set; no request is sent | 1 |
| No key | `Decisions check: no Jev key (Vercel: bin/ultrathink-mcp auth set-key vercel --stdin or AI_GATEWAY_API_KEY; OpenRouter: bin/ultrathink-mcp auth set-key openrouter --stdin or OPENROUTER_API_KEY)` | 1 |

On the OpenRouter rail, while `ULTRATHINK_DECISIONS_URL` is in effect, the ok and error lines end with ` · url <url>`, its origin and path only. When it is set but not accepted, they end with ` · ULTRATHINK_DECISIONS_URL ignored (must be https://openrouter.ai/… or a loopback URL)` instead, and the check used the default endpoint. The Vercel rail never shows it. The key is never printed.

`decisions probe <plan|ship|knowledge|blocking|teachable|skillworthy> <cases.json>` runs your own cases through one decision point, one request after another, and shows what that point would do with each under the current thresholds. `<cases.json>` is resolved against the current directory and holds a JSON array of 1 to 200 case objects. Each case has the state fields of its point, plus an optional `label`: `true` when the right answer is yes, `false` when it is no. For `teachable` and `skillworthy`, yes means the candidate should stand.

| Point | Fields | Actions printed |
|---|---|---|
| `plan` | `message` (non-empty string), `recent_conversation` (string, optional) | `skip-plan` when P is below `planSkipBelow`, else `plan` |
| `ship` | `request` (non-empty string), `acceptance_criteria` (array of strings, optional), `patch` (string) | `veto` when P is at or below `shipVetoAtOrBelow`, `approve` when P is at or above `shipApproveAt`, else `pass` |
| `knowledge` | `question`, `answer`, `document` (non-empty strings) | `reject-claim` when P is below `groundedAt`, else `keep` |
| `blocking` | `task`, `question`, `default` (non-empty strings) | `promote` when P is at or above `blockingAt`, else `keep` |
| `teachable` | `candidate` object with non-empty `name`, `description`, `body` and `kind`, plus optional `label` | `drop` when P is below `teachableBelow`, `auto-confirm` when P is at or above `teachableAutoAt`, else `keep` |
| `skillworthy` | the same `candidate`, plus `occurrences` (integer of at least 1) | `skip` when P is below `skillworthyAt`, else `keep` |

The fields go through the same caps as the live points (see [Privacy: Jev decisions](privacy.md#jev-decisions-openrouter)). Every case is checked before the first request. For example, `plan-cases.json`:

```json
[
  { "message": "thanks, that works now", "label": false },
  { "message": "Add OAuth login with GitHub to the web app", "label": true }
]
```

`bin/ultrathink decisions probe plan plan-cases.json` then prints one line per case and a summary:

```text
#1 P 0.03 · skip-plan · label false · agree
#2 P 0.97 · plan · label true · agree
Decisions probe: plan · typesafe/jev-1.13-20260917 · cases 2 · labelled 2 · agree 2/2 · errors 0
```

- A case line is `#<n> P <P> · <action>`, plus ` · label <true|false> · agree` (or `DISAGREE`) when the case has a label. P is printed with two decimals, cut rather than rounded, so a printed value never crosses a threshold. A case whose decision failed prints `#<n> error (<kind>)`.
- For `plan`, `knowledge` and `blocking`, a case agrees when `label: true` meets `plan`, `keep` or `promote` and `label: false` meets the other action. For `ship`, `label: true` agrees unless the action is `veto`, and `label: false` agrees unless it is `approve`. For `skillworthy`, `label: true` agrees with `keep` and `label: false` agrees with `skip`. For `teachable`, the label agrees unless the action is `drop`: `keep` and `auto-confirm` both count as yes.
- The summary is `Decisions probe: <point> · <model> · cases <n> · labelled <m> · agree <a>/<m> · errors <e>`, with the resolved model of the first answered case.
- Exit 0 when every case was answered, 1 when any case failed, when `ULTRATHINK_DECISIONS=0` is set (`Decisions probe: off (ULTRATHINK_DECISIONS=0)`, printed once the file is checked; no request is sent) or when there is no key for the resolved rail (`Decisions probe: no Jev key (Vercel: bin/ultrathink-mcp auth set-key vercel --stdin or AI_GATEWAY_API_KEY; OpenRouter: bin/ultrathink-mcp auth set-key openrouter --stdin or OPENROUTER_API_KEY)`). An unreadable or invalid file exits 2 before any request, with `Decisions probe: <reason>`, for example `Decisions probe: case #3: "message" must be a non-empty string` or `Decisions probe: plan-cases.json is not a JSON array of 1 to 200 cases`.

### `bin/ultrathink hindsight`

Operator probe for the Hindsight server. It reads the merged `hindsight` config for the current directory. See [Connect Hindsight](how-to/connect-hindsight.md) (`docs/how-to/connect-hindsight.md`).

```text
Usage: ultrathink hindsight check [--roundtrip] [--json]
```

Any other arguments print that line and exit 2. Exit 0 is ok. Exit 1 is not ready or a runtime failure. The key is never printed.

| Result | Output | Exit |
|---|---|---|
| Not ready | `Hindsight check: <reason>`, where `<reason>` is the status line without the `Hindsight: ` prefix (for example `off (opt-in: set hindsight.enabled)` or `on · no key (run bin/ultrathink-mcp auth set-key hindsight --stdin, or set HINDSIGHT_API_KEY)`). `--json` prints `{"ok":false,"state":"<off|unready>","reason":"<reason>"}`. No request is made. | 1 |
| Health failed | `Hindsight check: error (<kind>) · <message>`. `--json` includes `ok`, `state`, `origin`, `bank`, `error` and `ms`. | 1 |
| Ok | `Hindsight check: ok · Hindsight <version> · database connected · bank <bank> · <ms> ms`, then `Features: <name> on|off · …` (or `Features: none reported`). Version is `unknown` when the server reports none. | 0 |
| Round trip failed | The ok lines, then `Hindsight roundtrip: failed · throwaway bank ultrathink-smoke-<hex>`, then one line per step. | 1 |
| Round trip ok | The ok lines, then `Hindsight roundtrip: ok · throwaway bank ultrathink-smoke-<hex>`, then one line per step. | 0 |

`--roundtrip` retains, recalls and deletes a probe in a throwaway `ultrathink-smoke-*` bank. It does not read or write the configured bank. Steps, in order, are `ensure bank`, `retain`, `recall`, `delete document` and `delete bank`. A step line is `  <name>: ok · <ms> ms`, `  <name>: failed (<kind>) · <message> · <ms> ms`, `  <name>: failed · <note> · <ms> ms` when a passed step's verification fails (recall found no nonce), or `  <name>: skipped`. Cleanup runs even when an earlier step failed. The client sets the throwaway bank to `chunks` extraction mode; do not enable verbatim or reflect on a server that has no LLM.

`check` without `--roundtrip` asks `/health` and `/version`. Those two routes need no key, but the command uses the same readiness check as the status line, so it does not call them while the integration is off, the URL is missing or refused, or the key is missing.

### `bin/ultrathink ragflow`

Operator tools for RAGFlow. They honor the kill switch, `ragflow.enabled`, the URL policy and the key lookup, and they ignore `ragflow.ground`, so the connection can be proven before grounding is on. See [Connect RAGFlow](how-to/connect-ragflow.md) (`docs/how-to/connect-ragflow.md`).

```text
Usage: ultrathink ragflow check [--json] | datasets [--json] | search "<question>" [--dataset <id>]... [--limit N] [--json]
```

Any other arguments print that line and exit 2. `search` needs exactly one non-empty question. `--limit` is an integer from 1 to 100; omitted, it uses `ragflow.topK`. `--dataset` may be repeated; omitted, the command uses `ragflow.datasetIds`, or every dataset the key can see when that list is empty. Exit 0 is ok, including no datasets and no matches. Exit 1 is not ready or a runtime failure. The key is never printed.

Health is `GET /api/v1/datasets?page=1&page_size=1`. Do not probe `/system/healthz`, `/v1/system/healthz` or `/api/v1/system/healthz`: that route can block the API worker while object storage is down.

| Result | Output | Exit |
|---|---|---|
| Not ready | `RAGFlow <check|datasets|search>: <reason>`, where `<reason>` is the status line without the `RAGFlow: ` prefix. `--json` is `{"ok":false,"error":{"kind":"not-ready","message":"<reason>"}}`. No request is made. | 1 |
| Request failed | `RAGFlow <command>: error (<kind>) · <message>`. `--json` is `{"ok":false,"error":{"kind","message"}}`. | 1 |
| `check` ok | `RAGFlow check: ok · <n> dataset(s) · <ms> ms`. `--json`: `{"ok":true,"datasets":<n>,"ms":<ms>}`. | 0 |
| `datasets` empty | `RAGFlow datasets: none visible to this key` | 0 |
| `datasets` ok | A padded table with columns `id`, `name`, `documents`, `chunks`. `--json`: `{"ok":true,"datasets":[...]}`. | 0 |
| `search` empty | `RAGFlow search: no matches` | 0 |
| `search` ok | One line per chunk: `<similarity>  <document>: <excerpt>`. Similarity is two decimals, or `n/a `. `--json`: `{"ok":true,"count":<n>,"chunks":[...]}`. | 0 |
| `search`, no datasets | `RAGFlow search: no datasets to search` | 1 |

### `bin/ultrathink teach`

Teachable Moments. State is `<stateDir>/teach/`, from `ULTRATHINK_HOST` and `ULTRATHINK_STATE_DIR`, never `<cwd>/.planning`. See [Use Teachable Moments](how-to/use-teachable-moments.md) (`docs/how-to/use-teachable-moments.md`).

```text
usage:
  teach status [--json]
  teach list [--status S] [--project P] [--json]
  teach show <id> [--json]
  teach capture (--stdin | --name N --body B [--description D] [--kind K] [--tag T]... [--phase P] [--artifact A]...) [--json]
  teach recall "<query>" [--limit N] [--project P|*] [--json]
  teach confirm <id> [--json]
  teach forget <id> [--json]
  teach sync [--json]
  teach observe (--stdin | --file <path>) [--json]
  teach promote --due [--json]
  teach promote <id>... [--target hermes|omp|claude|drafts] [--install] [--json]
  teach promote <id>... --mark-promoted --skill <name> --target <t> [--path P] [--json]
  teach export --a2a [<id>...]
```

`teach help`, `teach --help` and `teach -h` print that text and exit 0. Bare `teach` is a usage error and exits 2 (`teach: missing subcommand (...)`). A usage error or invalid input exits 2, as `teach: <reason>` (with `--json`, `{"ok":false,"error":"teach: <reason>"}`). A missing moment, a refused install, or Teachable Moments being off for a command that changes state exits 1. Exit 0 is ok.

While Teachable Moments is off, `capture`, `confirm`, `forget`, `sync` and `promote` print `Teachable Moments is off (opt-in: set teach.enabled)` or `Teachable Moments is off (ULTRATHINK_TEACH=0)` and exit 1. `status`, `list`, `show`, `recall` and `export` still run. `observe` exits 1 with the same off message.

| Subcommand | What it prints |
|---|---|
| `status` | The `Teach: ` line, then `Moments: <n> candidate, <n> confirmed, <n> promoted, <n> superseded · outbox <n>`. `--json`: `{"enabled","capture","recall","hindsight":"ready|off|unready","moments":{"candidate","confirmed","promoted","superseded"},"outbox"}`. |
| `list` | One line per moment, newest first: `<id prefix> <status> <kind> x<occurrences> <project> <name>`, or `No moments.`. `--status` is `candidate`, `confirmed`, `promoted` or `superseded`. |
| `show <id>` | The moment. `<id>` may be a unique prefix of at least four characters. Unknown id exits 1: `no moment <id>`. |
| `capture` | `Captured <id> (created|merged) · retain <retained|queued|local-only|off>`. `--kind` is `bug`, `pitfall`, `pattern`, `decision` or `playbook`. `--stdin` is one JSON object and cannot be combined with the flags. Invalid input exits 2. |
| `recall "<query>"` | `<source> · <n> lesson(s)`, and the `## Lessons from earlier work` section when lessons were used. `--limit` is 1 to 10. `--project *` drops the project tag. A lookup error exits 1; off exits 0 with `status` `off`. |
| `confirm <id>` | `Confirmed <id> · retain <state>`. Unknown id exits 1. |
| `forget <id>` | `Forgot <id> · remote <deleted|queued|none>`. Removes the local file and deletes, or queues the delete of, the Hindsight document. |
| `sync` | `Sync: <done> done · <pending> pending`. Exits 1 when a reason is set and work is still pending. `--json`: `{"done","pending","reason"?}`. |
| `observe` | One of `--stdin` or `--file <path>`, not both. `--file` must be an existing file under `<stateDir>/teach/inbox/`; it is deleted afterwards, and only then. A skipped turn prints `Observe skipped: <reason>`. Otherwise `Observed · <n> captured`, plus `· <n> dropped by Jev` when `teachable` dropped candidates. |
| `promote --due` | Lists moments that are due (confirmed, not promoted, and `occurrences` at least `teach.promoteAfter`, or kind `playbook`). With Decisions on, a moment whose P(`skillworthy`) is below `skillworthyAt` is left out, and the last line is `Jev skipped <n> moment(s): not worth a standing skill.`. `--due` takes no ids and no other promote flags. |
| `promote <id>…` | Renders a `SKILL.md` draft and prints it. `--target` is `hermes`, `omp`, `claude` or `drafts`; omitted, the target follows the host (`omp` to `omp`, `claude-code` and `grok-build` to `claude`, `hermes` to `hermes`, anything else to `drafts`). |
| `promote <id>… --install` | Writes the draft for `omp` (`<omp agent dir>/managed-skills`) or `claude` (`~/.claude/skills`, or `$CLAUDE_CONFIG_DIR/skills`). `hermes` and `drafts` only write `<stateDir>/teach/skill-drafts/<name>/SKILL.md`. Hermes prints `install through Hermes skill_manage so skills.write_approval applies; ultrathink never writes ~/.hermes/skills`. A refused install (name taken by a skill ultrathink did not write, or a symlink) exits 1 and marks nothing. A created or updated skill marks the moments promoted. |
| `promote <id>… --mark-promoted --skill <name> --target <t> [--path P]` | Marks the moments promoted after Hermes staged the skill through `skill_manage`. `--skill` must match `[a-z0-9][a-z0-9-]{0,63}`. Cannot be combined with `--install`. |
| `export --a2a [<id>…]` | Prints an A2A-DRAFT Agent Card JSON for the given moments, or for confirmed and promoted moments when no id is given. Nothing is sent. |

### `bin/ultrathink doctor`

A static diagnosis that sends nothing anywhere: no network request, no `gh` and no `curl`. It reads the three config files for the current directory, the credential store and the host state directory. See [Diagnose with doctor](how-to/diagnose-with-doctor.md) (`docs/how-to/diagnose-with-doctor.md`).

```text
Usage: ultrathink doctor [--json]
```

Any other argument prints that line and exits 2. The report has five sections, `runtime`, `config`, `credentials`, `state` and `pstack`, with one line per finding marked `✓` (ok), `i` (info), `!` (warning) or `✗` (error), and ends with `<n> errors, <n> warnings`. `--json` prints one object, `{"ok","summary","findings"}`, instead.

| What it reports | Findings |
|---|---|
| `runtime` | Bun 1.2 or later, `git`, `gh` (a warning only when `ship.enabled` is on), whether a GitHub token variable or a gh hosts file exists (not verified), Python 3.10 or later (info only), the detected host. |
| `config` | Per file: not found (info), invalid JSON or not an object (error), unknown section or key with a `Did you mean …?`, a wrong type, a value the merge ignores or adjusts with the effective value, and a key a project file may not set (info, by design). |
| `credentials` | Present or missing, by provider name only, for the features that are switched on, with the command that stores a missing one. |
| `state` | Missing or unwritable directory, session count, size and oldest age (a warning above 500 sessions or 100 MB, with the hint `ultrathink prune --older-than 30 --dry-run`), session and carrier files that group or others can read, and `*.tmp` and `*.lock` files in `sessions/` older than one hour. |
| `pstack` | Enabled or disabled, with the user file that decided it (a project file cannot enable it); the resolved plugin path and version; each stage's skills, with a warning for a mapped name that has no `SKILL.md`; whether the Cursor `beforeSubmitPrompt` hook is installed. Warnings only matter once the bridge is enabled. See [Run pstack skills beside GSD in Cursor](how-to/use-pstack-with-cursor.md). |

Exit 0 means no error finding; warnings still exit 0. Exit 1 means at least one error finding. A credential value, a prefix of one and its length are never printed, and session records are never read.

### `bin/ultrathink prune`

Removes aged session records and their paired spec files from the current host's state directory. It never prints prompt text. See [Session retention](configuration.md#state-session-retention).

```text
Usage: ultrathink prune [--older-than <days>] [--dry-run]
```

`--older-than` is a whole number of days from 1 to 3650 (a trailing `d` is allowed). Below 1, above 3650, or not a whole number exits 2 and deletes nothing. Without `--older-than`, the cutoff is `state.retentionDays`; if that is also unset or 0, the command exits 2 and deletes nothing. `--dry-run` lists what would go and deletes nothing. A session with an open pull request, and the session the plan carrier points to, are kept. Orphaned `*.tmp` and `*.lock` files older than one hour are removed on a real run.

Exit 0 when the prune finishes. Exit 1 when a file could not be removed (the report still says what succeeded). Exit 2 on a usage error.

### `bin/ultrathink-mcp`

The shared MCP gateway for Notion, Linear and Greptile: one local stdio MCP server per provider that adds your stored credentials and relays to the provider's hosted MCP endpoint. See [Tracking](tracking.md) and [Register the MCP gateway](how-to/register-mcp-gateway.md). It also keeps API keys for OpenRouter, Hindsight and RAGFlow in the same credential store. `openrouter`, `hindsight` and `ragflow` are API-key providers, not MCP servers, so they are never served, checked or registered.

```text
usage:
  ultrathink-mcp serve <notion|linear|greptile>
  ultrathink-mcp auth status
  ultrathink-mcp auth set-key <provider> (--stdin | --env-file <path> --var <NAME>)
  (openrouter, hindsight and ragflow are API-key only: set-key, status and logout; never serve, check or login)
  ultrathink-mcp auth login <provider> [--port <n>] [--redirect <url>] [--tailscale] [--no-listen]
  ultrathink-mcp auth logout <provider>
  ultrathink-mcp check [provider...]
  ultrathink-mcp track complete --state <sessions/<id>.json>
  ultrathink-mcp session mark --state <sessions/<id>.json> <kicked-off|synced>
  ultrathink-mcp notion init --parent <notion page url or id> [--title <title>] [--write-config]
```

| Command | Effect |
|---|---|
| `serve <provider>` | Stdio MCP server that relays to the hosted provider and adds credentials from the store. Hosts run this; `bun scripts/mcp-register.ts` registers it. `ULTRATHINK_MCP_DEBUG=1` logs relay events to stderr. When a credential is missing, the error says how to add one: for Notion `ultrathink-mcp auth login notion`; for Linear and Greptile either `auth login <provider>` (OAuth) or `auth set-key <provider> --stdin` (an API key from that account's settings). |
| `auth status` | One line per provider (kind, ready or not ready, detail), then the store path. A key-provider row reads `<id>  api_key  ready  api key set (<n> chars)` or `<id>  none  not ready  not configured`. The key itself is never printed. |
| `auth set-key <provider>` | Stores an API key for `linear`, `greptile`, `openrouter`, `vercel`, `hindsight` or `ragflow`, read from stdin (`--stdin`) or from a `NAME=value` line in an env file (`--env-file <path> --var <NAME>`). Surrounding quotes and a leading `export` are stripped. It prints only the key's length, for example `hindsight: api key stored (<n> chars)`. Notion has no API-key route. A stored key wins over the provider's environment variable (`OPENROUTER_API_KEY`, `AI_GATEWAY_API_KEY`, `HINDSIGHT_API_KEY`, `RAGFLOW_API_KEY`). |
| `auth login <provider>` | OAuth login (Notion needs it; Linear and Greptile can use it instead of a key). See [OAuth login options](#oauth-login-options). |
| `auth logout <provider>` | Removes that provider's credentials. |
| `check [provider...]` | Runs `initialize` and `tools/list` against each MCP provider (`notion`, `linear` and `greptile` by default; never `openrouter`, `hindsight` or `ragflow`) and prints `OK <n> tools` or `FAIL <reason>`. Exits 1 if any provider fails. |
| `track complete --state <file>` | Creates the rows still missing for a planned session, rewrites its spec and state file, and prints the linked TODO lines. `ultrathink-kickoff` runs this. Run it from the project directory: it reads the config files, including `<project>/.claude/ultrathink.json`, from the current directory. Does nothing (exit 0) when `/ultrathink-track off` is set or no tracker is configured. Exits 1 when the record cannot be read, has no plan, there are no tracker credentials, or tracking failed. |
| `session mark --state <file> <kicked-off\|synced>` | Sets `kickedOff` or `synced` to `true` in the session record and prints nothing. `ultrathink-kickoff` runs it with `kicked-off` as its last step. The marks describe the plan now in the record: the session's next planned prompt writes a new graph with both back at `false`. A missing or unreadable record exits 1 and is left untouched. |
| `notion init --parent <page>` | Creates the Agent Task Graph database under a Notion page. `--title` sets its name. `--write-config` saves `notion.dataSourceUrl` to `~/.config/ultrathink/config.json` (under `$XDG_CONFIG_HOME` when set). Exits 1 when Notion is not logged in, or when the database was created but its `Parent Item` self-relation could not be added. |

`serve`, `check` and `auth login` for `openrouter`, `hindsight` or `ragflow` exit 2 without any network call, printing `ultrathink-mcp: <id> is an API-key provider, not an MCP server: store its key with ultrathink-mcp auth set-key <id> --stdin` and then the usage text to stderr. `auth logout <id>` removes the stored key. A missing Hindsight or RAGFlow key is named by the status line: `bin/ultrathink-mcp auth set-key hindsight --stdin` or `bin/ultrathink-mcp auth set-key ragflow --stdin`.

#### OAuth login options

`auth login <provider>` prints an authorization URL. Open it in any browser and approve. The login finishes when the browser is sent back to the callback URL, or when you paste the URL of the page you were sent back to (it may fail to load) into the terminal and press Enter.

| Option | Effect |
|---|---|
| (none) | Callback `http://127.0.0.1:8765/callback`, served by a listener on `127.0.0.1`. On a remote session (`SSH_CONNECTION`, `SSH_CLIENT` or `SSH_TTY` set), the output tells you to forward the port first (it prints an `ssh -L 8765:127.0.0.1:8765 <user>@<host>` line when it can) or to paste the redirected URL. |
| `--port <n>` | Listener port, 1 to 65535. Default `8765`. |
| `--no-listen` | Start no listener; only the pasted URL is accepted. |
| `--redirect <url>` | Use this callback URL instead. It must be https, or http on `127.0.0.1`, `localhost` or `[::1]`, and it must reach the listener on `127.0.0.1:<port>`. `ULTRATHINK_OAUTH_REDIRECT` does the same; the flag wins. It also wins over `--tailscale`. |
| `--tailscale` | Opt-in, for remote sessions on a machine in a [Tailscale](https://tailscale.com) network. ultrathink reads the machine's tailnet name from `tailscale status --json`, runs `tailscale serve --bg --https=443 --set-path=/ultrathink-oauth http://127.0.0.1:<port>` and uses `https://<tailnet name>/ultrathink-oauth/callback` as the callback, so a browser on another device in the same tailnet finishes the login by itself. The route is removed when the login ends. When Tailscale is not running or has no HTTPS certificate for that name, the default callback is used; when `tailscale serve` fails, the login falls back to the default callback and says so. `ULTRATHINK_OAUTH_TAILSCALE=1` does the same as the flag. Without either, ultrathink never runs `tailscale`. On a local (non-SSH) session the option has no effect. |

See [Logging in from a remote machine](tracking.md#logging-in-from-a-remote-machine) for a walk-through, and [Troubleshooting](troubleshooting.md) for failed logins.

### `bin/ultrathink-ship`

Drives the [ship flow](ship.md). The `ultrathink-ship` skill calls it, and you rarely need it by hand.

```text
usage: ultrathink-ship assess|pr|review|merge|run|status --state <sessions/<id>.json> [--cwd <dir>] [--ignore-gsd]
```

| Subcommand | Effect |
|---|---|
| `assess` | Collects git, GSD and diff signals and asks the engine to judge whether the task is done. A GSD roadmap whose `gsd-tools.cjs` cannot be found is reported as a gap (see [GSD tools lookup](configuration.md#gsd-tools-lookup)). When `.planning/phases` has no verification, the latest archived milestone's (`.planning/milestones/<version>-phases/`) verifications must all be `passed` (a phase without one counts as `missing`), and its audit goes to the judge as evidence. With `ship.judge: "advisory"` only the deterministic rules decide `done`; the judge's verdict is recorded and shown in the PR body. `--ignore-gsd` leaves the GSD roadmap out; use it only when that roadmap is separate work (see [Ship](ship.md)). |
| `pr` | Pushes the branch and opens a PR into the repository's default branch, or reuses the open one. |
| `review` | One Greptile review round. Returns `status: "pending"` within `ship.waitMs` while Greptile is still working, and running it again resumes the same review. A failed review (Greptile FAILED/ERROR/SKIPPED, no score, CLI failure) or one pending past `ship.reviewTimeoutMs` is re-triggered on the next `review` call, up to `ship.reviewRetries` (3) times per head commit, then the ship blocks with a PR comment; these never count toward `ship.maxRounds`, which counts only completed reviews below 5/5 or with open threads. The output's `passed` says whether this review of the head passed the gate. Returns `status: "blocked"` without counting a round when Greptile is not set up (no stored Greptile credential and no signed-in `greptile` CLI) or when your Greptile account needs `ship.greptileOrganization`; the reason says what to do. |
| `merge` | Checks the merge gate and merges. Refuses with `autoMerge disabled` unless `ship.autoMerge` is `true`. After the head's review passed, it keeps retrying within the call, up to `ship.waitMs`, through pending CI, mergeability not computed, unreadable PR state or threads and transient GitHub errors; when the call's time runs out it returns `waiting: true` and `next: "run merge again: …"`, and the agent runs `merge` again. Past `ship.mergeTimeoutMs` (60 minutes) on one head commit, or on a terminal GitHub refusal (missing permission, requested changes, a closed PR; a branch-protection hold such as a missing approval is retried until the bound instead), the ship blocks and the PR comment lists the attempt history. Conflicts, failing CI, a moved head or a review below 5/5 go back to the agent (`next`), never merge. Deletes the remote and local branch and fast-forwards the base branch only when `ship.deleteBranch` is `true`. |
| `run` | `assess`, `pr`, `review` and `merge` in one go. When the review passed and `ship.autoMerge` is on, it merges within its own `ship.waitMs` budget, and `next` is the merge's `next` (`run merge again: …` while waiting). Fixing findings stays with the agent. |
| `status` | Prints the stored ship state, including `attempts`: every review result and merge outcome (newest 50). |

`--state` is the session state file (`<state dir>/sessions/<id>.json`). `--cwd` is the repository working tree and defaults to the current directory. Every subcommand prints one JSON object. `bin/ultrathink-ship` works when you run it by hand even with `ship.enabled: false`; that key only controls whether the agent is told to run it. `merge` is the only way the ship flow merges: agents must never merge any other way (no `gh pr merge`, no web UI), and a PR merged outside the flow without a passing review of its head is reported blocked, never recorded as a ship merge.

With `ship` in `decisions.points` and a Jev key for the resolved rail, `assess` also asks Jev whether the patch fully delivers the request, alongside the engine judge, after the rule checks pass. Its JSON then gains `decision`: `{"p": <P>, "model": "<resolved model>", "action": "<action>"}`, or `{"action": "fail-open", "error": "<kind>"}` when Jev could not answer. It gains `"source": "jev"` only when Jev gave the verdict because there was no usable engine verdict, which happens only in gate mode with `ship.autoMerge` off. With Decisions off, the JSON is unchanged. See [Ship: Jev decision](ship.md#jev-decision).

### `scripts/setup.ts`

Installs the Claude Code and Grok Build parts. Run it from the checkout:

```sh
bun scripts/setup.ts apply     # install or update
bun scripts/setup.ts status    # report what is installed (also the default, and what any other verb does)
bun scripts/setup.ts rollback  # undo what apply did
```

`apply` does the following. Re-running it updates in place.

1. Grok Build, always: merges the ultrathink rule into `~/.grok/rules/ultrathink.md` (between marker comments, so your own text in that file stays) and writes the hook file `~/.grok/hooks/ultrathink.json`. Both are under `$GROK_HOME` when it is set. Re-run `apply` after updating ultrathink so both files match the new version. It does not enable the Grok plugin itself; run `grok plugin enable ultrathink` for that (see [Install](install.md)).
2. Claude Code, only when the `claude` CLI is installed:
   - adds the Notion and Linear hosted MCP servers at user scope (`claude mcp add --transport http --scope user notion https://mcp.notion.com/mcp`, and the same for `linear` with `https://mcp.linear.app/mcp`), unless a server with exactly that name already exists;
   - adds the checkout as a plugin marketplace and runs `claude plugin install ultrathink@ultrathink`;
   - merges a short "Ultrathink task tracking" block between `<!-- ultrathink:start -->` and `<!-- ultrathink:end -->` into `~/.claude/CLAUDE.md` (`$CLAUDE_CONFIG_DIR/CLAUDE.md` when set). The block says the plugin *can* track work and applies only when tracking is configured;
   - records which MCP servers it added in `ultrathink-setup-state.json` next to that `CLAUDE.md`. A re-run keeps servers recorded by earlier runs, so `rollback` still removes them.
3. Prints the remaining steps for the other hosts: the Hermes symlink into `$HERMES_HOME/plugins/ultrathink` (`~/.hermes` when unset) and the `hermes config set plugins.hook_callback_timeout 600` command (see [Install](install.md)), `muse plugins install <clone> --scope user && muse plugins approve ultrathink`, and `omp plugin link <clone>`. It does not run them.

`apply` never changes `~/.claude/settings.json` or any Hermes setting.

`status` prints one line each for the Notion MCP server, the Linear MCP server and the `CLAUDE.md` block (or `Claude Code: claude CLI not found`), then the Grok rule and hook file, with the command that fixes anything missing.

`rollback` removes the `CLAUDE.md` block, the setup state file, the Grok rule block (and the rule file, if nothing else is left in it) and the Grok hook file. For each MCP server that `apply` recorded as added, it first runs `claude mcp get <name>` and removes the server only while it is still setup's own entry: user scope, HTTP, with the hosted URL. A server you replaced since, for example with the gateway through `mcp-register --replace`, is left in place (`left in place: <name> was changed since setup added it`) and dropped from the state; a server that no longer exists is reported `already removed`. When the `claude` check or removal fails, it prints the error and the manual `claude mcp remove --scope user <name>` command, and keeps that server in the setup state file so a second `rollback` retries. It prints, but does not run, the plugin uninstall: `claude plugin uninstall ultrathink@ultrathink && claude plugin marketplace remove ultrathink`.

### `scripts/mcp-register.ts`

Registers the MCP gateway (`<clone>/bin/ultrathink-mcp serve <provider>`) as the `notion`, `linear` and `greptile` MCP servers in each host's user config.

```text
Usage: bun scripts/mcp-register.ts [--hosts claude,grok,hermes,muse,omp] [--providers notion,linear,greptile] [--replace | --remove] [--dry-run]
```

| Flag | Effect |
|---|---|
| `--hosts <list>` | Comma-separated hosts to change: `claude`, `grok`, `hermes`, `muse`, `omp`. Default: all. |
| `--providers <list>` | Comma-separated providers to register or remove: `notion`, `linear`, `greptile`. Default: all. |
| `--replace` | Also overwrite same-named entries that are not ultrathink's. Without it they are kept. |
| `--remove` | Delete ultrathink's entries (command ending in `/bin/ultrathink-mcp`) and keep all others. Cannot be combined with `--replace`. |
| `--dry-run` | Print what would change without writing a file or changing a host. The hosts' read-only list and get commands (`claude mcp get`, `grok mcp list --json`, `hermes mcp list`) still run to see what is registered. |
| `--help`, `-h` | Print the usage text. |

Where each host keeps the entries:

| Host | How it is changed |
|---|---|
| `claude` | `claude mcp add\|remove --scope user`. The file backed up is `~/.claude.json` (`$CLAUDE_CONFIG_DIR/.claude.json` when set). |
| `grok` | `grok mcp add\|remove --scope user`. The file backed up is `~/.grok/config.toml` (`$GROK_HOME/config.toml` when set). |
| `hermes` | `hermes mcp add\|remove`. The file backed up is the `config.yaml` of the active Hermes profile: `~/.hermes/config.yaml` (`$HERMES_HOME/config.yaml` when set), or `<Hermes home>/profiles/<name>/config.yaml` when a profile other than `default` is active or `HERMES_HOME` points at a profile directory. When the active profile cannot be resolved, nothing is backed up and a line says so (check `hermes profile list`). |
| `muse` | Written directly to `~/.config/muse/settings.json` (`$XDG_CONFIG_HOME/muse/settings.json` when set). |
| `omp` | Written directly to `~/.omp/agent/mcp.json` (`$PI_CODING_AGENT_DIR/mcp.json` when set). |

A host whose CLI (`claude`, `grok` or `hermes`) is not on `PATH` is skipped. Every file it changes is first backed up as `<file>.bak-ultrathink-mcp-<timestamp>`. An entry counts as ultrathink's when its command ends with `/bin/ultrathink-mcp`, from any clone. Only user-scope entries count, because that is the scope `mcp-register` adds to and removes from. For Claude Code it reads the `Scope:` line of `claude mcp get <name>`, and when another scope wins it reads the top-level `mcpServers` of `~/.claude.json`; for Grok it uses the `grok mcp list --json` entries with scope `user` or no scope. A same-named entry in another scope (project or local) neither blocks registration nor is touched; the output notes `<scope> entry with this name is left alone`.

It prints one line per host and provider, `<host>: <provider> <action>`, where the action is one of `added`, `replaced` (an ultrathink entry from another clone, or any entry with `--replace`), `re-enabled`, `unchanged`, `kept` (someone else's entry, left in place; rerun with `--replace` to overwrite it), `removed`, `not registered`, `saved disabled` (Hermes saved the entry but reports it not authenticated yet) or `FAILED` (with the host command's error). When the checkout path contains `/plugins/cache/`, it warns that the next plugin update will replace that directory and asks you to register from a stable clone instead.

## Exit codes

| Program | Exit codes |
|---|---|
| `bin/ultrathink` | 0 for planner verbs, including unknown verbs (which print the usage text). `decisions check` and `decisions probe`: 0 on success, 1 on a failed decision, a missing OpenRouter key or `ULTRATHINK_DECISIONS=0`, 2 on a usage error or an invalid cases file. `hindsight` and `ragflow`: 0 ok, 1 not ready or a runtime failure, 2 usage. `teach`: 0 ok (including `help`), 1 a runtime failure or not ready, 2 usage or invalid input. `doctor`: 0 no error finding (warnings allowed), 1 any error finding, 2 usage. `prune`: 0 done, 1 a file could not be removed, 2 usage or a cutoff that would delete everything. |
| `bin/ultrathink-mcp` | 0 on success, 1 on failure, 2 on a usage error (the usage text is printed to stderr). During an `auth login` that set up a Tailscale route, Ctrl-C removes the route and exits 130 (143 on `SIGTERM`). |
| `bin/ultrathink-ship` | 0, even when a step refuses (`ok: false` with a `reason`); 2 on a usage error. |
| All three CLIs above | 127 when Bun is not found. When Bun is found but cannot start, the shell's own status (for example 126). |
| Hooks (`hooks/*`, run by the hosts) | 0 when Bun is missing, so a prompt is never blocked by ultrathink. |
| `scripts/setup.ts` | 0; 1 on an unexpected error. |
| `scripts/mcp-register.ts` | 0 on success, 1 when any host change `FAILED`, 2 on an argument error (unknown host or provider, `--replace` with `--remove`). |
