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
| `/ultrathink-status` | Shows planning, engine, Graph of Thought, HITL and tracking state, the configured Notion data source and Linear team, the Agent Substrate, ship and knowledge-base state, and the state directory. The output is the same as [`bin/ultrathink status`](#binultrathink). |

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

- The extension (`src/host/omp.ts`) registers `/ultrathink-quick`, `/ultrathink-skip`, `/ultrathink-off`, `/ultrathink-on`, `/ultrathink-track` (with `on`/`off` completions) and `/ultrathink-status`.
- Control commands reply with an Omp notification. No model turn runs. `omp -p` shows no notifications and exits before a quick message runs, so use the interactive UI for these commands.
- `/ultrathink-quick <message>` sends the message to the agent as a normal user message and skips planning, tracking and the status bar for exactly that message. Without a message it shows a usage notification.
- In a task-subagent session the commands do nothing special: the typed text goes to the agent unchanged.

### Hermes Agent

- The plugin (`hosts/hermes/__init__.py`) registers `ultrathink-quick`, `ultrathink-skip`, `ultrathink-off`, `ultrathink-on`, `ultrathink-track` and `ultrathink-status`. Control commands run `bin/ultrathink` against the Hermes state directory, and the command dispatcher replies inline. A command that gets no answer within 20 seconds reports that instead.
- `/ultrathink-quick <message>` hands the message to Hermes through `inject_message` as the next user turn, which `pre_llm_call` then leaves unplanned. This works in the Hermes CLI.
- In gateways (Telegram, Discord, Slack and so on), `inject_message` needs `plugins.entries.ultrathink.allow_gateway_injection: true` in the Hermes config. Without it, or wherever Hermes cannot inject (the TUI, an older Hermes), `quick` arms a skip for your next message and replies: `Ultrathink will not plan your next message. Send it now (or prefix any message with raw:).` `/ultrathink-quick` with no message does the same.
- The names use hyphens, not colons. Chat command menus accept only a restricted character set, and a single colon name stops Discord from listing the plugin commands that follow it. Telegram menus show the commands with underscores: `ultrathink_status`, `ultrathink_quick` and so on.
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
| `ULTRATHINK_DEBUG=1` | `hooks/uplift.ts` (Claude Code, Grok, Muse) logs every skip reason and failure to stderr as `[ultrathink] …`. |
| `ULTRATHINK_HOST` | Forces the host id: `claude-code`, `grok-build`, `hermes`, `muse` or `omp`. This selects the state directory, which matters for `bin/ultrathink` run from a plain terminal. |
| `ULTRATHINK_STATE_DIR` | Overrides the state directory. Use an absolute path (a relative one resolves differently per host; see [Configuration](configuration.md#environment-variables)). It is ignored if it points into a `.planning/` directory. |

The other variables (credential store, OAuth callback and Tailscale opt-in, Hermes timeout, Agent Substrate, GSD tools, Bun) are listed in [Configuration: Environment variables](configuration.md#environment-variables).

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
  grok [engine grok|claude]
```

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
| `grok engine grok`, `grok engine claude` | Switches the planning engine for this host. |

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
Model: sonnet · concurrency 3
State: ~/.claude/ultrathink
```

What the lines can say:

| Line | Values |
|---|---|
| `Prompt Uplift` | `on` or `off`, plus `(skipping next prompt)` while a `/ultrathink-skip` is armed. |
| `Engine` | `claude:<model>` (`claude:session default` when `claude.model` is `""`), or the Grok engine label when `think.engine` is `grok`. |
| `Grok` | Model, effort and transport. With `transport: "shunt"` it adds `<shuntBaseUrl>/v1/messages`, or `shunt gateway not configured (set grok.shuntBaseUrl)`, then the wire model and `max_tokens`. |
| `SuperGrok OAuth` | The `grok login` state: the account and expiry, `not logged in (run grok login)`, `expired (run grok login)`, or `not used (shunt gateway owns upstream auth)`. |
| `Tracking` | `on (Linear/Notion rows)`, `off (Linear/Notion rows)` after `/ultrathink-track off`, `on (not configured: …)` when neither tracker is set, or `kickoff (…)` when only the planner's own row creation is off. |
| `Notion`, `Linear team` | The configured value or `not configured`. |
| `Substrate` | `off (optional: set substrate.url or SUBSTRATE_URL)`, `off (SUBSTRATE_DISABLED=1)`, or `<url> (SUBSTRATE_URL)` / `<url> (config)` showing where the URL came from. |
| `Ship` | `off (opt-in: set ship.enabled)`, `off (ULTRATHINK_SHIP=0)`, or `on · auto-merge on\|off · delete branch on\|off`. |
| `Knowledge base` | The Greptile knowledge-base read before the clarifying questions (see [`hitl.knowledgeBase`](configuration.md#hitl-clarifying-questions)): `off (opt-in: set hitl.knowledgeBase)`; `on · not read while HITL is off`; `on · no Greptile credential (run bin/ultrathink-mcp auth login greptile)`; or `on · Greptile` (`on · Greptile · organization <org>` when `ship.greptileOrganization` is set). |
| `Model` | `claude.model` and `claude.concurrency`. |
| `State` | The state directory in use. |
| `Last` | Only after a plan: root element, source (`llm` or `fallback`) and node count of the last plan. |

### `bin/ultrathink-mcp`

The shared MCP gateway for Notion, Linear and Greptile: one local stdio MCP server per provider that adds your stored credentials and relays to the provider's hosted MCP endpoint. See [Tracking](tracking.md) and [Register the MCP gateway](how-to/register-mcp-gateway.md).

```text
usage:
  ultrathink-mcp serve <notion|linear|greptile>
  ultrathink-mcp auth status
  ultrathink-mcp auth set-key <provider> (--stdin | --env-file <path> --var <NAME>)
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
| `auth status` | One line per provider (kind, ready or not ready, detail), then the store path. |
| `auth set-key <provider>` | Stores an API key for `linear` or `greptile`, read from stdin (`--stdin`) or from a `NAME=value` line in an env file (`--env-file <path> --var <NAME>`). Surrounding quotes and a leading `export` are stripped. Notion has no API-key route. |
| `auth login <provider>` | OAuth login (Notion needs it; Linear and Greptile can use it instead of a key). See [OAuth login options](#oauth-login-options). |
| `auth logout <provider>` | Removes that provider's credentials. |
| `check [provider...]` | Runs `initialize` and `tools/list` against each provider (all three by default) and prints `OK <n> tools` or `FAIL <reason>`. Exits 1 if any provider fails. |
| `track complete --state <file>` | Creates the rows still missing for a planned session, rewrites its spec and state file, and prints the linked TODO lines. `ultrathink-kickoff` runs this. Run it from the project directory: it reads the config files, including `<project>/.claude/ultrathink.json`, from the current directory. Does nothing (exit 0) when `/ultrathink-track off` is set or no tracker is configured. Exits 1 when the record cannot be read, has no plan, there are no tracker credentials, or tracking failed. |
| `session mark --state <file> <kicked-off\|synced>` | Sets `kickedOff` or `synced` to `true` in the session record and prints nothing. `ultrathink-kickoff` runs it with `kicked-off` as its last step. The marks describe the plan now in the record: the session's next planned prompt writes a new graph with both back at `false`. A missing or unreadable record exits 1 and is left untouched. |
| `notion init --parent <page>` | Creates the Agent Task Graph database under a Notion page. `--title` sets its name. `--write-config` saves `notion.dataSourceUrl` to `~/.config/ultrathink/config.json` (under `$XDG_CONFIG_HOME` when set). Exits 1 when Notion is not logged in, or when the database was created but its `Parent Item` self-relation could not be added. |

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
| `assess` | Collects git, GSD and diff signals and asks the engine to judge whether the task is done. A GSD roadmap whose `gsd-tools.cjs` cannot be found is reported as a gap (see [GSD tools lookup](configuration.md#gsd-tools-lookup)). `--ignore-gsd` leaves the GSD roadmap out; use it only when that roadmap is separate work (see [Ship](ship.md)). |
| `pr` | Pushes the branch and opens a PR into the repository's default branch, or reuses the open one. |
| `review` | One Greptile review round. Returns `status: "pending"` within `ship.waitMs` while Greptile is still working, and running it again resumes the same review. Returns `status: "blocked"` without counting a round when Greptile is not set up (no stored Greptile credential and no signed-in `greptile` CLI) or when your Greptile account needs `ship.greptileOrganization`; the reason says what to do. |
| `merge` | Checks the merge gate and merges. Refuses with `autoMerge disabled` unless `ship.autoMerge` is `true`. Deletes the remote and local branch and fast-forwards the base branch only when `ship.deleteBranch` is `true`. |
| `run` | `assess`, `pr`, `review` and `merge` in one go. Fixing findings stays with the agent. |
| `status` | Prints the stored ship state. |

`--state` is the session state file (`<state dir>/sessions/<id>.json`). `--cwd` is the repository working tree and defaults to the current directory. Every subcommand prints one JSON object. `bin/ultrathink-ship` works when you run it by hand even with `ship.enabled: false`; that key only controls whether the agent is told to run it.

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
| `bin/ultrathink` | 0, including for unknown verbs (which print the usage text). |
| `bin/ultrathink-mcp` | 0 on success, 1 on failure, 2 on a usage error (the usage text is printed to stderr). During an `auth login` that set up a Tailscale route, Ctrl-C removes the route and exits 130 (143 on `SIGTERM`). |
| `bin/ultrathink-ship` | 0, even when a step refuses (`ok: false` with a `reason`); 2 on a usage error. |
| All three CLIs above | 127 when Bun is not found. When Bun is found but cannot start, the shell's own status (for example 126). |
| Hooks (`hooks/*`, run by the hosts) | 0 when Bun is missing, so a prompt is never blocked by ultrathink. |
| `scripts/setup.ts` | 0; 1 on an unexpected error. |
| `scripts/mcp-register.ts` | 0 on success, 1 when any host change `FAILED`, 2 on an argument error (unknown host or provider, `--replace` with `--remove`). |
