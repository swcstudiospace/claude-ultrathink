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
| `/ultrathink-track on` | Row creation back on. `/ultrathink-track` with no argument (or `status`) shows the tracking state. |
| `/ultrathink-status` | Shows planning, engine, Graph of Thought, HITL and tracking state, the configured Notion data source and Linear team, and the state directory. |

Some details:

- Nothing changes unless you use a command. Planning stays on by default.
- The state is per host. Each host has its own state directory (see [Architecture](architecture.md#state)), so `/ultrathink-off` in Omp leaves Claude Code planning. Within a host the setting applies to every session and project on the machine.
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

On Claude Code, Grok and Muse, each command also ships as a command file in `commands/`. If the hook did not run, for example because hooks are not approved or not installed, the host expands that file instead. The file tells the model to run `bin/ultrathink <verb>` with its shell tool and reply with the output, so the command still works, just with a model turn.

`/ultrathink-quick` works differently. The hook recognizes it and plans nothing, and no plan is written. The host's command template (`commands/ultrathink-quick.md`) or host adapter then delivers your message to the agent as typed.

## Per-host notes

### Claude Code

- Plugin commands are also listed under the plugin namespace, as `/ultrathink:ultrathink-quick`, `/ultrathink:ultrathink-status` and so on. Both the short and the namespaced forms work.
- The older typed forms `/ultrathink:<verb>` (for example `/ultrathink:off`) and `/ultrathink <verb>` are still recognized.
- `quick` expands `commands/ultrathink-quick.md`: the model receives your message with a note that planning and tracking were skipped for it.
- `claude -p` prints a control command's reply as `UserPromptSubmit operation blocked by hook:` followed by the reply.

### Grok Build

- Grok does not dispatch plugin hooks, so the commands only get a no-model-turn answer after `bun scripts/setup.ts apply` has installed the global hook file `~/.grok/hooks/ultrathink.json` (see [Install](install.md)). Without that file, Grok still loads the command files from the plugin directory, and the model runs `bin/ultrathink` itself.
- With the hook file installed, the hook returns a block decision for a control command. Grok blocks the prompt and shows the reply in the interactive UI. `grok -p` prints nothing for a blocked command.
- `/ultrathink-quick` and the control commands delete the plan carrier `last-plan.json`, as every prompt that isn't planned does, so the model never picks up the previous prompt's plan for them.
- Grok wraps what you typed in a `<user_query>` element before hooks see it. Commands are parsed inside that wrapper.

### Muse Code

- The commands are the capability ids declared in `.muse-plugin/plugin.json`: `ultrathink-quick`, `ultrathink-skip`, `ultrathink-off`, `ultrathink-on`, `ultrathink-track` and `ultrathink-status`.
- Muse activates skills and commands as soon as the plugin is enabled, but hooks only run after review: `muse plugins approve ultrathink`. The hook ids are `plugin:ultrathink:hook:user-prompt-submit`, `plugin:ultrathink:hook:post-tool-use` and `plugin:ultrathink:hook:stop`. Until they are approved, commands fall back to the model running `bin/ultrathink`, and nothing is planned.
- Muse speaks the Claude hook protocol. `hooks/muse-prompt` runs the same `hooks/uplift.ts` with `ULTRATHINK_HOST=muse`, so a control command gets the same block-and-reply as in Claude Code. In the interactive UI the reply is shown. `muse exec` ends the run as `Cancelled`.

### Omp

- The extension (`src/host/omp.ts`) registers `/ultrathink-quick`, `/ultrathink-skip`, `/ultrathink-off`, `/ultrathink-on`, `/ultrathink-track` (with `on`/`off` completions) and `/ultrathink-status`.
- Control commands reply with an Omp notification. No model turn runs. `omp -p` shows no notifications and exits before a quick message runs, so use the interactive UI for these commands.
- `/ultrathink-quick <message>` sends the message to the agent as a normal user message and skips planning, tracking and the status bar for exactly that message. Without a message it shows a usage notification.
- In a task-subagent session the commands do nothing special: the typed text goes to the agent unchanged.

### Hermes Agent

- The plugin (`hosts/hermes/__init__.py`) registers `ultrathink-quick`, `ultrathink-skip`, `ultrathink-off`, `ultrathink-on`, `ultrathink-track` and `ultrathink-status`. Control commands run `bin/ultrathink` against the Hermes state directory, and the command dispatcher replies inline. A command that gets no answer within 20 seconds reports that instead.
- `/ultrathink-quick <message>` hands the message to Hermes through `inject_message` as the next user turn, which `pre_llm_call` then leaves unplanned. This works in the Hermes CLI.
- In gateways (Telegram, Discord, Slack and so on), `inject_message` needs `plugins.entries.ultrathink.allow_gateway_injection: true` in the Hermes config. Without it, or wherever Hermes cannot inject (the TUI, an older Hermes), `quick` arms a skip for your next message and replies: `Ultrathink will not plan your next message. Send it now (or prefix any message with raw:).` `/ultrathink-quick` with no message does the same.
- The names use hyphens, not colons. Chat command menus accept only a restricted character set, and a single colon name stops Discord from listing the plugin commands that follow it. Telegram menus show the commands with underscores: `ultrathink_status`, `ultrathink_quick` and so on.
- In a shared multi-user gateway session, a sender tag such as `[Alice] ` in front of the message does not stop a `quick` message from matching.

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
| `ULTRATHINK_TRACK=0` | The planner creates no Linear/Notion rows. Planning continues, and `ultrathink-kickoff` creates the rows in the agent's turn instead. With a tracker configured, `/ultrathink-status` shows `Tracking: kickoff`. `track.enabled: false` in config does the same. |
| `ULTRATHINK_SHIP=0` | No ship nudge and no `## Ship` section in the plan. See [Ship](ship.md). |
| `ULTRATHINK_DEBUG=1` | `hooks/uplift.ts` (Claude Code, Grok, Muse) logs every skip reason and failure to stderr as `[ultrathink] …`. |
| `ULTRATHINK_HOST` | Forces the host id: `claude-code`, `grok-build`, `hermes`, `muse` or `omp`. This selects the state directory, which matters for `bin/ultrathink` run from a plain terminal. |
| `ULTRATHINK_STATE_DIR` | Overrides the state directory. It is ignored if it points into a `.planning/` directory. |

The credential store, OAuth, Hermes timeout and substrate variables are listed in [Configuration](configuration.md).

## CLI reference

All three CLIs are POSIX shell wrappers that follow symlinks to the checkout and run through `bin/run-bun`, which finds `bun` even when it is not on `PATH`.

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
  grok [engine grok|claude]
```

| Verb | Effect |
|---|---|
| `status` (also the default with no verb) | Full state, one line per item. |
| `off`, `on`, `skip` | As the slash commands. |
| `track on`, `track off`, `track status` | As `/ultrathink-track`. |
| `last` | Root element and source (`llm` or `fallback`) of the last uplift, then its XML. |
| `think on`, `think off`, `think status` | Graph of Thought on or off for this host. With it off, the prompt is still uplifted and clarified. |
| `think last` | Goal and node sketch of the last graph. |
| `hitl on`, `hitl off`, `hitl status` | HITL clarifications on or off for this host. |
| `hitl last` | The clarifications of the last plan, with answers. |
| `grok` or `grok status` | Engine label, Grok model, effort and transport, and Grok login state. |
| `grok engine grok`, `grok engine claude` | Switches the planning engine for this host. |

The state directory comes from `ULTRATHINK_HOST`, or else from the detected host. A plain terminal is detected as Claude Code. To change another host's state from a terminal, set the host explicitly:

```sh
ULTRATHINK_HOST=omp <clone>/bin/ultrathink off
ULTRATHINK_HOST=grok-build <clone>/bin/ultrathink status
```

`bun hooks/uplift.ts --ctl <verb> [args]` is the older spelling of the same commands.

### `bin/ultrathink-mcp`

The shared MCP gateway for Notion, Linear and Greptile. See [Tracking](tracking.md) and [Architecture](architecture.md#mcp-gateway).

```text
usage:
  ultrathink-mcp serve <notion|linear|greptile>
  ultrathink-mcp auth status
  ultrathink-mcp auth set-key <provider> (--stdin | --env-file <path> --var <NAME>)
  ultrathink-mcp auth login <provider> [--port <n>] [--redirect <url>] [--no-listen]
  ultrathink-mcp auth logout <provider>
  ultrathink-mcp check [provider...]
  ultrathink-mcp track complete --state <sessions/<id>.json>
  ultrathink-mcp session mark --state <sessions/<id>.json> <kicked-off|synced>
  ultrathink-mcp notion init --parent <notion page url or id> [--title <title>] [--write-config]
```

| Command | Effect |
|---|---|
| `serve <provider>` | Stdio MCP server that relays to the hosted provider and adds credentials from the store. Hosts run this; `bun scripts/mcp-register.ts` registers it. `ULTRATHINK_MCP_DEBUG=1` logs relay events to stderr. |
| `auth status` | One line per provider (kind, ready or not ready, detail), then the store path. |
| `auth set-key <provider>` | Stores an API key for `linear` or `greptile`, read from stdin (`--stdin`) or from a `NAME=value` line in an env file (`--env-file <path> --var <NAME>`). Surrounding quotes and a leading `export` are stripped. |
| `auth login <provider>` | OAuth login (Notion needs it). Prints an authorization URL, listens on `127.0.0.1:<port>` (default 8765) for the callback, and also accepts the redirected URL pasted on stdin. `--no-listen` only accepts the pasted URL. `--redirect <url>` sets the callback URL. For remote and SSH sessions, see [Troubleshooting](troubleshooting.md#notion-oauth-over-ssh). |
| `auth logout <provider>` | Removes that provider's credentials. |
| `check [provider...]` | Runs `initialize` and `tools/list` against each provider (all three by default) and prints `OK <n> tools` or `FAIL <reason>`. Exits 1 if any provider fails. |
| `track complete --state <file>` | Creates the rows still missing for a planned session, rewrites its spec and state file, and prints the linked TODO lines. `ultrathink-kickoff` runs this. Does nothing when `/ultrathink-track off` is set or no tracker is configured. |
| `session mark --state <file> <kicked-off\|synced>` | Sets `kickedOff` or `synced` to `true` in the session record and prints nothing. `ultrathink-kickoff` runs it with `kicked-off` as its last step. A missing or unreadable record exits 1 and is left untouched. |
| `notion init --parent <page>` | Creates the Agent Task Graph database under a Notion page. `--title` sets its name. `--write-config` saves `notion.dataSourceUrl` to `~/.config/ultrathink/config.json`. |

Exit codes: 0 on success, 1 on failure, 2 on a usage error (the usage text is printed to stderr).

### `bin/ultrathink-ship`

Drives the [ship flow](ship.md). The `ultrathink-ship` skill calls it, and you rarely need it by hand.

```text
usage: ultrathink-ship assess|pr|review|merge|run|status --state <sessions/<id>.json> [--cwd <dir>] [--ignore-gsd]
```

| Subcommand | Effect |
|---|---|
| `assess` | Collects git, GSD and diff signals and asks the engine to judge whether the task is done. `--ignore-gsd` leaves the GSD roadmap out; use it only when that roadmap is separate work ([ship.md](ship.md#done-assessment)). |
| `pr` | Pushes the branch and opens a PR into the repository's default branch, or reuses the open one. |
| `review` | One Greptile review round. Returns `status: "pending"` within `ship.waitMs` while Greptile is still working, and running it again resumes the same review. |
| `merge` | Checks the merge gate, merges, and cleans up the branch. |
| `run` | `assess`, `pr`, `review` and `merge` in one go. Fixing findings stays with the agent. |
| `status` | Prints the stored ship state. |

`--state` is the session state file (`<state dir>/sessions/<id>.json`). `--cwd` is the repository working tree and defaults to the current directory. Every subcommand prints one JSON object. It exits 0 even when a step refuses (`ok: false` with a `reason`) and 2 only on a usage error.
