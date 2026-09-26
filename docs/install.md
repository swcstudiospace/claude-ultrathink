# Install

ultrathink runs from one checkout of this repository. Each host (the coding agent you type into: Claude Code, Grok Build, Hermes Agent, Muse Code or Omp) loads it through a small entry point, and every host calls the same TypeScript engine. This page covers installing it on each host and checking that it works. It also covers `scripts/setup.ts`, the shared MCP gateway and choosing the planning engine. To upgrade, move or remove an install, see [Upgrade and move](how-to/upgrade-and-move.md) and [Uninstall](how-to/uninstall.md).

In the commands below, `<clone>` is the absolute path of your checkout. Paths written as `${NAME:-default}` use the environment variable when you set it, and the default otherwise.

- [Platforms](#platforms)
- [Prerequisites](#prerequisites)
- [Claude Code](#claude-code)
- [Grok Build](#grok-build)
- [Hermes Agent](#hermes-agent)
- [Muse Code](#muse-code)
- [Omp](#omp)
- [`scripts/setup.ts` reference](#scriptssetupts-reference)
- [Shared MCP gateway](#shared-mcp-gateway)
- [Engine selection](#engine-selection)

## Platforms

ultrathink runs on Linux and macOS. On Windows, run it and your host inside WSL; native Windows is not supported. CI runs the test suite on Linux and macOS.

## Tested with

| Component | Version |
|---|---|
| Claude Code | 2.1.278 |
| Grok Build | 1.0.41 |
| Hermes Agent | v0.21.4 |
| Muse Code | 1.4.0 |
| Omp | 18.3.1 |
| Bun | 1.4.0 (1.2 or later required) |
| Greptile CLI (optional, for ship) | 3.4.1 |

## Prerequisites

| Requirement | Version | Needed for |
|---|---|---|
| [Bun](https://bun.sh) | 1.2 or later | Every host. The hooks, the engine and the CLIs run on Bun. |
| Python | 3.10 or later | Hermes Agent only, which runs the plugin in its own Python. |
| `git` | any | Cloning the repository. |
| `claude` CLI, logged in | 2.1.278 or later (the tested version) | The default Claude engine, on every host (see [Engine selection](#engine-selection)). The engine passes `claude -p` flags that older CLIs reject, and then every plan falls back. |

1. **Bun.** Hosts often start hooks with a short `PATH`, so they launch Bun through `bin/run-bun`. It looks for Bun in this order and uses the first it finds:

   1. `$BUN`
   2. `bun` on `PATH`
   3. `$BUN_INSTALL/bin/bun`
   4. `~/.bun/bin/bun`
   5. `/usr/local/bin/bun`
   6. `/opt/homebrew/bin/bun`
   7. `~/.local/share/*/bun/bin/bun`

   If Bun is in none of these places, `bin/run-bun` prints one line to stderr, `ultrathink: bun not found. Install Bun 1.2 or later (https://bun.sh) or set BUN=/path/to/bun`. What happens next depends on the caller:

   - **Hooks** exit 0, so your prompt still goes through, just unplanned. Nothing blocks the host.
   - **The CLIs** (`bin/ultrathink`, `bin/ultrathink-mcp`, `bin/ultrathink-ship`) exit 127, the shell's "command not found" status, so scripts notice the failure.

2. **A clone of the repository.**

   ```sh
   git clone https://github.com/swcstudiospace/claude-ultrathink.git <clone>
   ```

   ultrathink has no runtime dependencies, so `bun install` is not needed to run it. It only installs type definitions for development. (If you plan to use Muse, see the note on symlinks in [Muse Code](#muse-code).) A Claude Code install from the GitHub marketplace does not need a clone. The other hosts and the MCP gateway do. Keep the clone where it is: several hosts store its path. If you move it later, follow [Upgrade and move](how-to/upgrade-and-move.md#move-the-clone-to-another-directory).

3. **An engine login.** Planning runs on a separate model call, independent of the host you type into.
   - Claude (the default): the `claude` CLI must be on `PATH` and logged in. The engine runs `claude -p` headless.
   - Grok (optional): run `grok login`, unless you use the `shunt` transport. See [Engine selection](#engine-selection).

Optional:

| Tool | Needed for |
|---|---|
| `gh`, logged in | [Ship](ship.md) (opt-in): pushing, opening and merging the PR |
| Greptile CLI (`greptile login`) | Ship's CLI review mode |
| Notion, Linear, Greptile credentials | [Tracking](tracking.md) and ship, through the [shared MCP gateway](#shared-mcp-gateway) |

A fresh install only plans prompts. Linear and Notion tracking, ship, the Agent Substrate brief and the Tailscale OAuth callback are all off until you configure them. See [Configuration](configuration.md) and [Tracking](tracking.md).

Each host keeps its own state directory. Planning never writes `.planning/` into your working directory.

| Host | State directory | `ULTRATHINK_HOST` id |
|---|---|---|
| Claude Code | `${CLAUDE_CONFIG_DIR:-~/.claude}/ultrathink` | `claude-code` |
| Grok Build | `$GROK_PLUGIN_DATA/ultrathink` if set, otherwise `${GROK_HOME:-~/.grok}/plugin-data/ultrathink` | `grok-build` |
| Hermes Agent | `${HERMES_HOME:-~/.hermes}/ultrathink`; with an active Hermes profile, `ultrathink` in that profile's directory (`${HERMES_HOME:-~/.hermes}/profiles/<name>`) | `hermes` |
| Muse Code | `${XDG_CONFIG_HOME:-~/.config}/muse/ultrathink` | `muse` |
| Omp | `${PI_CODING_AGENT_DIR:-~/.omp/agent}/ultrathink` | `omp` |

`bin/ultrathink` works on the Claude Code state unless it detects another host. From a plain shell, set `ULTRATHINK_HOST` to read or change another host's state. For example:

```sh
ULTRATHINK_HOST=hermes <clone>/bin/ultrathink status
```

## Claude Code

Claude Code loads ultrathink as a plugin: `.claude-plugin/` holds the marketplace and plugin manifests, and `hooks/hooks.json` holds the hooks.

### Install

In a Claude Code session:

```text
/plugin marketplace add swcstudiospace/claude-ultrathink
/plugin install ultrathink@ultrathink
```

Or from a shell:

```sh
claude plugin marketplace add swcstudiospace/claude-ultrathink
claude plugin install ultrathink@ultrathink
```

`claude plugin install` installs at user scope by default. Pass `--scope project` or `--scope local` to change that.

**Development install from a clone.** Add the checkout as a local-path marketplace. It has the same marketplace name, `ultrathink`:

```sh
claude plugin validate <clone>
claude plugin marketplace add <clone>
claude plugin install ultrathink@ultrathink
```

`bun scripts/setup.ts apply` does the same two `marketplace add` and `install` steps, and more. See the [`scripts/setup.ts` reference](#scriptssetupts-reference).

Start a new Claude Code session after installing.

### Verify

1. Run `/ultrathink-status`. The plugin also lists it as `/ultrathink:ultrathink-status`. The prompt hook answers before any model turn and shows the engine (for example `Engine: claude:sonnet`), the tracking state and the state directory. From a shell, `<clone>/bin/ultrathink status` prints the same thing.
2. Send a non-trivial prompt, such as a one-line feature request. The transcript shows a summary line that starts with `Prompt Uplift ·`, and the agent invokes `ultrathink-kickoff` before it does other work.

Verified live on Claude Code 2.1.278: `/ultrathink-status` and `/ultrathink-quick` in `claude -p`. Headless, the status reply appears as "blocked by hook" text. A quick message was answered and no plan was written.

### Update and uninstall

See [Upgrade and move](how-to/upgrade-and-move.md#upgrade) and [Uninstall](how-to/uninstall.md#claude-code).

## Grok Build

Grok Build uses the plugin directory for skills and commands. It finds the plugin's `hooks/hooks.json` but does not dispatch plugin hooks, so `bun scripts/setup.ts apply` installs a global hook file, `${GROK_HOME:-~/.grok}/hooks/ultrathink.json`. That file is a copy of `hooks/hooks.json` with absolute paths, `ULTRATHINK_HOST=grok-build` on every hook, and a 600 s timeout on the prompt hook in place of Grok's 30 s default. Because the paths are absolute, run `apply` again after moving the clone.

Grok also discards hook stdout, so the plan cannot be injected into the turn directly. Instead, the hook writes the plan to `last-plan.json` in the Grok state directory (`$GROK_PLUGIN_DATA/ultrathink/` if set, otherwise `${GROK_HOME:-~/.grok}/plugin-data/ultrathink/`), and `apply` installs the rule `${GROK_HOME:-~/.grok}/rules/ultrathink.md`. The rule tells the model to read that file before acting. `last-plan.json` exists only for a prompt that was planned. The hook deletes it on every prompt it does not plan (`/ultrathink-quick`, control commands, skipped or trivial prompts, planning turned off), so the model never picks up an older plan.

`apply` never overwrites the rule. If the rule file is missing, it writes the packaged rule from `hosts/grok/ultrathink.md`. If the file exists, it replaces only the block between `<!-- ultrathink:start -->` and `<!-- ultrathink:end -->`, or appends the block when there is none. Your own text in that file is kept.

### Install

```sh
mkdir -p ${GROK_HOME:-~/.grok}/plugins
ln -sfn <clone> ${GROK_HOME:-~/.grok}/plugins/ultrathink
grok plugin enable ultrathink
bun <clone>/scripts/setup.ts apply
```

Grok keeps a plugin disabled until you enable it, so without `grok plugin enable` the skills and commands don't load.

`apply` installs the Grok rule and hook file first. It also sets up Claude Code, which the [`scripts/setup.ts` reference](#scriptssetupts-reference) describes. If the `claude` CLI is not installed, it skips the Claude Code steps and prints a notice, so a machine with only Grok Build can run it.

### Verify

1. `grok plugin list` shows `ultrathink` as enabled.
2. Run `bun <clone>/scripts/setup.ts status`. It should print `Grok rule: installed (…/rules/ultrathink.md)` and `Grok hooks: installed (…/hooks/ultrathink.json)`. The rule counts as installed only when it contains the `<!-- ultrathink:start -->` … `<!-- ultrathink:end -->` block.
3. Start Grok and run `/ultrathink-status`. The prompt hook blocks the command and shows the state.
4. Send a non-trivial prompt. `last-plan.json` should appear in the Grok state directory, and the model should read the plan and invoke `ultrathink-plan`, then `ultrathink-kickoff`. After a `/ultrathink-quick` message or a control command, the file is gone.

Verified live on Grok Build 1.0.41: `/ultrathink-status` and `/ultrathink-quick` in `grok -p`. A quick message was answered. In headless mode a blocked control command prints nothing, so check status in the interactive UI or with `ULTRATHINK_HOST=grok-build <clone>/bin/ultrathink status`.

### Update and uninstall

See [Upgrade and move](how-to/upgrade-and-move.md#upgrade) and [Uninstall](how-to/uninstall.md#grok-build). After moving the clone, run `bun <new clone>/scripts/setup.ts apply` and re-point the symlink.

## Hermes Agent

Hermes loads `hosts/hermes`, a Python plugin with `plugin.yaml` and `register()`. It needs Python 3.10 or later. Its `pre_llm_call` hook sends the prompt to `hooks/engine.ts` through `bin/run-bun` (or through `$BUN` when set) and returns the plan as context. Hermes gives the hook no working directory, so the planner uses the tools' directory from `TERMINAL_CWD` (set by the gateway and `hermes -w`), falling back to the directory Hermes started in; the repository, branch and project config come from there. The plugin also registers the `/ultrathink-<verb>` commands, the `ultrathink-sync` nudges, and the four ultrathink skills. Hermes does not list plugin skills in the model's system prompt, so they load as `ultrathink:<name>` with `skill_view` (for example `ultrathink:ultrathink-kickoff`), and every instruction that names one also gives its absolute `SKILL.md` path.

### Install

```sh
mkdir -p ${HERMES_HOME:-~/.hermes}/plugins
ln -sfn <clone>/hosts/hermes ${HERMES_HOME:-~/.hermes}/plugins/ultrathink
hermes plugins enable ultrathink
hermes plugins doctor ultrathink
hermes config set plugins.hook_callback_timeout 600
```

Install the plugin as a symlink, not a copy. The plugin finds the engine by resolving the symlink, so the rest of `<clone>` must stay in place. A copied plugin directory has no engine beside it: it never starts Bun, and it logs one warning, `ultrathink: <path> not found; install hosts/hermes as a symlink into a full clone of ultrathink (docs/install.md#hermes-agent)`.

**The hook cap.** The last command is required, and nothing sets it for you: neither the plugin nor `scripts/setup.ts` changes your Hermes config. Hermes stops waiting for a plugin hook after `plugins.hook_callback_timeout` seconds: 30 by default, 600 at most. It is a global Hermes setting that applies to every plugin. A plan takes minutes, so it needs a cap of at least 105 s, and 600 is recommended. Under the default 30 s cap the planner never starts Bun: every prompt goes through unplanned, Hermes logs no hook timeout, and the Hermes log gets one `ultrathink: Hermes hook cap 30.0s leaves under 90s to plan, …` warning per process. Don't set it to 0: that turns off Hermes' hook deadline, and the turn waits on the hook.

The planner reads the cap Hermes enforces and stops the engine after `min(540, cap − 15)` seconds, which leaves 15 s for Hermes to take the plan. At a 600 s cap that is 540 s. `ULTRATHINK_HERMES_TIMEOUT` (seconds) replaces the 540. When the deadline is reached, the planner kills Bun's whole process group, including the engine calls Bun started, and the prompt goes through unplanned. Below a 105 s cap the deadline would be under 90 s, too short for a plan, so the planner doesn't start Bun at all. Every prompt then goes through unplanned, and the Hermes log gets one warning per process naming the fix, `hermes config set plugins.hook_callback_timeout 600`.

If your Hermes version does not report its hook cap to plugins, the planner reads `plugins.hook_callback_timeout` from the active profile's config: `${HERMES_HOME:-~/.hermes}/config.yaml` (or, when `active_profile` names a Hermes profile, `${HERMES_HOME:-~/.hermes}/profiles/<name>/config.yaml`). If that file sets none, it assumes Hermes' 30 s default and therefore never plans. Either way it logs one warning that names the value it used and the same fix. See [Troubleshooting](troubleshooting.md#hermes-the-plan-never-arrives).

ultrathink only registers hooks, commands and skills. It does not replace built-in tools, so if `enable` asks about tool override, decline (or pass `--no-allow-tool-override`).

If another Hermes plugin already plans or rewrites prompts, disable it. Otherwise both will plan the same turn.

On Hermes the hook only plans. It never creates Notion or Linear rows. `ultrathink-kickoff` creates them at the start of the agent's turn by running `ultrathink-mcp track complete --state <file>`, so a plan that Hermes cuts off can't leave orphan rows. See [Tracking](tracking.md).

The plugin nudges the agent to run `ultrathink-sync` in two cases: when a tool call opens a pull request (`transform_tool_result`, `post_tool_call` and `pre_llm_call`), and, through Hermes' `pre_verify` hook, once per plan (per session and Graph ID) when a coding turn (one that edited files with `write_file` or `patch`) is about to finish with a tracked plan that has not been synced. A PR opened inside a `delegate_task` subagent counts too: the child's own `gh pr create` fires the same tool hooks (Hermes' `subagent_start` hook tells the plugin which parent it works for), so the parent gets the nudge on the delegate result that names the PR, or on its next turn. A delegate result that only cites a PR the child did not open is ignored. `pre_verify` sees only the parent agent's own `write_file`/`patch` edits, so a turn whose edits all ran in subagents gets no end-of-turn nudge. The nudge passes the state file (`stateFile=`), the Graph ID (`graphId=`) and, when the session opened one, the PR URL (`prUrl=`). Sync updates only the rows kickoff created, found by Graph ID (the nudge's `graphId=` wins when a newer prompt has since replaced the plan in the state file), and records `synced` in the session record, which stops the end-of-turn nudge. See [Tracking](tracking.md).

Hermes also gets a short handoff instead of the full specification: the spec path, the state file, the Graph ID and the kickoff instruction. The hook creates no rows on Hermes, so the handoff carries no Linked issues TODO lines: kickoff's `track complete` prints them once it has created the rows. Its human-in-the-loop step asks blocking questions with one Hermes `clarify` call (at most 5 questions of up to 4 choices, recommended default first) instead of `AskUserQuestion`, and names Hermes' `todo` and `delegate_task` tools for TodoWrite and Task subagents. The full XML and the graph stay in the spec file. Hermes appends hook context to the user message, replays it in every later turn, and spills any piece over 10,000 characters (`hooks.output_spill.max_chars`) to a file, keeping only its first and last 500 characters, so a full specification would be cut.

The plugin skips some prompts before Bun starts: cron runs, sessions with a parent session, empty prompts, prompts that start with `/`, and prompts that are already uplifted ultrathink XML. In shared multi-user gateway sessions Hermes prefixes each message with the sender's `[Name] ` tag; the plugin strips a leading tag only when it names the current sender (`HERMES_SESSION_USER_NAME`), before these checks, and sends the untagged text to the engine. A label you type yourself, such as `[backend] update the guide`, stays in the request. Hermes expands a skill command into its skill scaffold before `pre_llm_call` runs, so a prompt that still starts with `/` is never a skill with a task. The engine then skips a bare skill scaffold that carries no task, and, on every host, a prompt that references an existing ultrathink graph as `graph ut-<id>-<8 hex>` (as dispatched workers and the Linear issue footers do) unless you prefix it with `uplift:`. See [Commands](commands.md#prompt-prefixes-and-automatic-skips) for the other skips.

In gateways such as Telegram, `/ultrathink-quick` needs `plugins.entries.ultrathink.allow_gateway_injection: true` in the Hermes config. Without it, the command falls back to skipping the next message. See [Commands](commands.md).

### Verify

1. `hermes config get plugins.hook_callback_timeout` prints `600`.
2. `hermes plugins doctor ultrathink` prints `OK: runtime discovery, manifest parsing, import, and registration passed` with 6 hooks registered, and `hermes plugins list` shows `ultrathink` as enabled.
3. Start a Hermes session and run `/ultrathink-status`. Hermes replies inline with the state.
4. In a Hermes session, ask the agent to call its `skills_list` tool. The result includes `ultrathink:ultrathink-kickoff` and the other three ultrathink skills.
5. Send a non-trivial prompt. The short handoff reaches the model as context before its first call, the agent loads `ultrathink:ultrathink-kickoff`, and `${HERMES_HOME:-~/.hermes}/logs/agent.log` gets no new `Hook 'pre_llm_call' callback on_pre_llm_call timed out` line and no `ultrathink:` warning.

Verified live on Hermes Agent v0.21.4 through its real CLI command dispatcher: `/ultrathink-status`, `/ultrathink-track off`, and `/ultrathink-quick`, which injected the message with no plan.

### Update and uninstall

See [Upgrade and move](how-to/upgrade-and-move.md#upgrade) and [Uninstall](how-to/uninstall.md#hermes-agent). Uninstalling also covers putting the hook cap back if no other plugin needs it.

## Muse Code

Muse reads `.muse-plugin/plugin.json`. It declares the four skills, the six commands, and three hooks: `UserPromptSubmit` (`hooks/muse-prompt`, which runs the same prompt hook as Claude Code with a 600 s timeout), `PostToolUse` (`hooks/muse-post-tool`, the PR sync check) and `Stop` (`hooks/muse-stop`).

### Install

```sh
muse plugins validate <clone>
muse plugins install <clone> --scope user
muse plugins approve ultrathink
```

- `validate` prints `diagnostic=multiple-manifests severity=warning … selected .muse-plugin/plugin.json; ignoring .claude-plugin/plugin.json`. This warning is expected: the repository ships manifests for several hosts, and Muse picks its own.
- Muse refuses to install a plugin directory that contains symlinks. `bun install` can create symlinks under `node_modules/.bin`, so install from a clone where you have not run it, or delete `node_modules` first. ultrathink does not need `node_modules` at runtime.
- Muse puts third-party plugin hooks on hold until they are reviewed. Skills and commands are active as soon as the plugin is enabled, but planning starts only after `approve`.

### Verify

1. `muse plugins inspect ultrathink` shows `enabled=true active=true valid=true`, and each of the three hooks (`user-prompt-submit`, `post-tool-use`, `stop`) with `status=trusted_enabled`.
2. In Muse, run `/ultrathink-status`. The prompt hook blocks the command and shows the state.
3. Send a non-trivial prompt. The transcript shows the `Prompt Uplift ·` summary.

Verified live on Muse Code 1.4.0: `/ultrathink-status` and `/ultrathink-quick` in `muse exec`. A quick message was answered. In headless mode a blocked control command ends the run as `Cancelled`, so check status in the interactive UI.

### Update and uninstall

Muse runs a copy from its plugin cache, so `git pull` alone does not update it. See [Upgrade and move](how-to/upgrade-and-move.md#upgrade) and [Uninstall](how-to/uninstall.md#muse-code).

## Omp

Omp loads the extension listed under `omp.extensions` in `package.json` (`src/host/omp.ts`), plus the skills. The extension plans in `before_agent_start` and waits up to 25 s, because Omp caps a handler at 30 s. A plan that takes longer arrives as an aside message. In the TUI, the extension adds a live `ultrathink` status bar above Omp's status band and renders plans as cards.

### Install

```sh
omp plugin link <clone>
```

### Verify

1. `omp plugin list` shows `ultrathink@0.3.0` as enabled.
2. Start the Omp TUI. The `ultrathink` status bar appears above the status band.
3. Run `/ultrathink-status`. Omp shows the state as a notification.
4. Send a non-trivial prompt. The status bar shows the planning stages, and the plan appears as a card, either inline or later as an aside.

Verified live on Omp 18.3.1 in the interactive UI: `/ultrathink-status` showed the notification, and `/ultrathink-quick` was answered with no plan. Use the interactive UI for these commands. In `omp -p` print mode, notifications are not shown and a quick message is not processed before Omp exits.

If something looks wrong, `omp plugin doctor` checks the installed plugins.

### Update and uninstall

See [Upgrade and move](how-to/upgrade-and-move.md#upgrade) and [Uninstall](how-to/uninstall.md#omp).

## `scripts/setup.ts` reference

`bun <clone>/scripts/setup.ts <apply|status|rollback>` works on the clone that contains the script, whatever directory you run it from. With no argument it runs `status`. Grok Build needs `apply`. The other hosts do not, but `apply` also sets up Claude Code when the `claude` CLI is installed.

| Subcommand | What it does |
|---|---|
| `apply` | 1. Writes the Grok hook file `${GROK_HOME:-~/.grok}/hooks/ultrathink.json` and installs the Grok rule `${GROK_HOME:-~/.grok}/rules/ultrathink.md`. The rule is written from `hosts/grok/ultrathink.md` when missing; otherwise only its ultrathink marker block is replaced, or appended when absent, and the rest of the file is kept.<br>2. If the `claude` CLI is installed, adds the hosted Notion (`https://mcp.notion.com/mcp`) and Linear (`https://mcp.linear.app/mcp`) HTTP MCP servers to Claude Code at user scope, unless a server named exactly `notion` or `linear` is already configured. It checks with `claude mcp get <name>`, then falls back to an exact name match in `claude mcp list`, so a server with a similar name or URL does not count.<br>3. Runs `claude plugin marketplace add <clone>` and `claude plugin install ultrathink@ultrathink`.<br>4. Merges a tracking block into `${CLAUDE_CONFIG_DIR:-~/.claude}/CLAUDE.md` between `<!-- ultrathink:start -->` and `<!-- ultrathink:end -->`, updating it in place on re-runs. The block says the plugin *can* track work, and that its tracking workflow applies only when `/ultrathink-status` shows a Notion database or a Linear team. Without either, ultrathink creates no rows.<br>5. Records which MCP servers it added in `${CLAUDE_CONFIG_DIR:-~/.claude}/ultrathink-setup-state.json`. A re-run keeps earlier records, so a server added by any `apply` stays recorded.<br>6. Prints the install commands for Hermes (one `mkdir -p … && ln -sfn … && hermes plugins enable ultrathink` line honoring `HERMES_HOME`, then the hook cap step), Muse and Omp, with the clone path quoted so you can paste them.<br>Without the `claude` CLI, steps 2 to 5 are skipped with the notice `Claude Code: claude CLI not found — skipped …`. |
| `status` | Reports whether the Grok rule (with its marker block) and the Grok hook file are installed. With the `claude` CLI, it also reports whether Claude Code has servers named exactly `notion` and `linear`, and whether the `CLAUDE.md` block is present. Without it, it prints `Claude Code: claude CLI not found` followed by the Grok lines. |
| `rollback` | Removes the Grok hook file and the Grok rule (the whole file if it holds only the ultrathink block, otherwise just the block). Removes the `CLAUDE.md` block. Removes the `notion` and `linear` Claude Code MCP servers only if an `apply` run recorded adding them and `claude mcp get` still shows them as user-scope HTTP servers with the hosted URL; a changed entry is left in place, a missing one is reported as `already removed`. Then it deletes the setup state file. If a removal fails, it says so and keeps the state file, so running `rollback` again retries it. It does not uninstall the Claude Code plugin: its last line prints `claude plugin uninstall ultrathink@ultrathink && claude plugin marketplace remove ultrathink` for you to run. |

`apply` is idempotent. The hosted servers from step 2 connect Claude Code directly to Notion and Linear. If you would rather use the [shared MCP gateway](#shared-mcp-gateway) in Claude Code too, note that `scripts/mcp-register.ts` keeps a same-named entry that is not ultrathink's, and reports it as `kept`. Run `bun scripts/mcp-register.ts --replace --hosts claude` to swap the hosted `notion` and `linear` entries for gateway entries; later `apply` runs leave them alone. `rollback` removes the `notion` and `linear` entries only while they are still the user-scope HTTP servers `apply` added, with the hosted URL. An entry you replaced since, such as a gateway entry from `mcp-register --replace`, is left in place and reported as `left in place: <name> was changed since setup added it`; remove gateway entries with `bun scripts/mcp-register.ts --remove`.

For a full removal, see [Uninstall](how-to/uninstall.md).

## Shared MCP gateway

`bin/ultrathink-mcp` is a stdio MCP server that relays to the hosted Notion, Linear and Greptile MCP servers. It adds credentials from one store, `${XDG_CONFIG_HOME:-~/.config}/ultrathink/mcp-credentials.json` (mode 0600; `ULTRATHINK_MCP_STORE` overrides the path). The planner creates tracking rows through the same store, and the ship loop uses it for Greptile. Register the gateway in each host and log in once. [Register the MCP gateway](how-to/register-mcp-gateway.md) has the full walkthrough.

### Register it in every host

```sh
bun <clone>/scripts/mcp-register.ts --dry-run   # show what would change
bun <clone>/scripts/mcp-register.ts
```

This registers three servers, `notion`, `linear` and `greptile`, each running `<clone>/bin/ultrathink-mcp serve <provider>`, in each host's user-level config:

- An entry whose command ends in `/bin/ultrathink-mcp` is ultrathink's. If it points at another clone, it is replaced; if it already matches, it is reported as `unchanged`.
- Only the user-scope entry counts. A same-named entry in a local or project scope is left alone.
- A same-named entry that runs something else is kept and reported as `kept: existing entry is not ultrathink's; rerun with --replace to overwrite it`. `--replace` overwrites it.
- `--remove` deletes only ultrathink's entries. See [Uninstall](how-to/uninstall.md#3-remove-the-mcp-gateway-entries).
- Every file it changes is backed up as `<file>.bak-ultrathink-mcp-<timestamp>`.
- Claude Code, Grok and Hermes are skipped when their CLI is not on `PATH`. Limit the run with `--hosts claude,grok,hermes,muse,omp` and `--providers notion,linear,greptile`. It exits non-zero if any registration failed.
- Run it from a clone in a stable directory. From a path containing `/plugins/cache/` it prints a warning, because the next plugin update would replace that copy and break the registered commands.

| Host | How it registers | File backed up |
|---|---|---|
| Claude Code | `claude mcp remove` / `claude mcp add --scope user` | `${CLAUDE_CONFIG_DIR:-~}/.claude.json` |
| Grok Build | `grok mcp add --scope user` | `${GROK_HOME:-~/.grok}/config.toml` |
| Hermes Agent | `hermes mcp remove` / `hermes mcp add`. Hermes saves a server it cannot connect to yet as disabled, which the script reports as `saved disabled`. Run the script again after logging in. | `${HERMES_HOME:-~/.hermes}/config.yaml`, or the active profile's `${HERMES_HOME:-~/.hermes}/profiles/<name>/config.yaml` |
| Muse Code | Edits the file directly (`mcpServers`, `mode: "optional"`) | `${XDG_CONFIG_HOME:-~/.config}/muse/settings.json` |
| Omp | Edits the file directly | `${PI_CODING_AGENT_DIR:-~/.omp/agent}/mcp.json` |

### Log in

```sh
<clone>/bin/ultrathink-mcp auth set-key linear --stdin      # paste a Linear API key
<clone>/bin/ultrathink-mcp auth set-key greptile --stdin    # paste a Greptile API key
<clone>/bin/ultrathink-mcp auth login notion                # Notion supports OAuth only
<clone>/bin/ultrathink-mcp auth status
```

Linear and Greptile also accept an OAuth login (`auth login linear`, `auth login greptile`) instead of an API key. `set-key` also accepts `--env-file <path> --var <NAME>` to read the key from a dotenv file. `auth login` starts a browser OAuth flow with a callback on `127.0.0.1:8765` on the machine running the command. For a login over SSH or on a machine without a browser, see [Set up Notion](how-to/set-up-notion.md) and [Troubleshooting](troubleshooting.md#notion-oauth-over-ssh). `auth logout <provider>` removes a provider's stored credentials.

### Check it

```sh
<clone>/bin/ultrathink-mcp check            # all three providers
<clone>/bin/ultrathink-mcp check linear     # one provider
```

For each provider, `check` sends `initialize` and `tools/list` through the gateway and prints `<provider>: OK <n> tools` or `<provider>: FAIL <reason>`. It exits non-zero if any provider fails.

Credentials alone create no rows. The planner creates rows only for providers configured in your config: Linear needs `linear.team` and Notion needs `notion.dataSourceUrl`. See [Tracking](tracking.md).

## Engine selection

The engine is the model that writes the spec, the Graph of Thought and the clarifying questions. It is chosen per host state directory, in this order:

1. The engine set with `bin/ultrathink grok engine grok|claude` for that host, stored in its state directory.
2. `think.engine` in config: `"claude"` (the default) or `"grok"`.
3. Grok is used only when that setting is `grok` and `grok.enabled` is `true` (the default). Otherwise the engine is Claude.

```sh
<clone>/bin/ultrathink grok                       # engine label, Grok model/effort/transport, Grok login status
<clone>/bin/ultrathink grok engine grok           # switch Claude Code's engine to Grok
ULTRATHINK_HOST=omp <clone>/bin/ultrathink grok engine claude
```

To switch every host, set it in config, for example in `${XDG_CONFIG_HOME:-~/.config}/ultrathink/config.json`:

```json
{ "think": { "engine": "grok" } }
```

- **Claude** (default) runs the `claude` CLI headless (`claude -p`) with your existing Claude Code login. Its label is `claude:<model>`, for example `claude:sonnet`.
- **Grok** has three transports. `http` (default) and `cli` use your `grok login` session; if it is missing or expired, the prompt goes through unplanned with ``Prompt Uplift skipped · Grok 4.7 login required (run `grok login`)``, unless `grok.fallbackToClaude` is `true`. `shunt` posts to an Anthropic-compatible gateway that you run and name in `grok.shuntBaseUrl`. There is no built-in gateway: with `shunt` selected and `grok.shuntBaseUrl` empty, every planning call fails with an error naming `grok.shuntBaseUrl`.

[Choose an engine](how-to/choose-engine.md) compares them, and [Configuration](configuration.md#grok-the-grok-engine) lists every `claude.*` and `grok.*` key with its default.

Whichever engine you choose, a failed or timed-out planning call never blocks your prompt. The turn continues with a minimal fallback spec, creates no tracking rows, and the summary line reports `Engine error · …`. See [Troubleshooting](troubleshooting.md).
