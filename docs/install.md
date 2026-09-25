# Install

ultrathink runs from one checkout of this repository. Each host loads it through a small entry point, and every host calls the same TypeScript engine. This page covers installing it on each host, checking that it works, updating it and removing it. It also covers the shared MCP gateway and choosing the planning engine.

In the commands below, `<clone>` is the absolute path of your checkout.

- [Prerequisites](#prerequisites)
- [Claude Code](#claude-code)
- [Grok Build](#grok-build)
- [Hermes Agent](#hermes-agent)
- [Muse Code](#muse-code)
- [Omp](#omp)
- [`scripts/setup.ts` reference](#scriptssetupts-reference)
- [Shared MCP gateway](#shared-mcp-gateway)
- [Engine selection](#engine-selection)

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

1. **Bun 1.2 or later.** Every hook, the engine and the CLIs run on Bun. Hosts often start hooks with a short `PATH`, so they launch Bun through `bin/run-bun`. It checks `$BUN`, `PATH`, `$BUN_INSTALL/bin/bun`, `~/.bun/bin/bun`, `/usr/local/bin/bun` and `/opt/homebrew/bin/bun`. If it finds no Bun, it exits 0 so the prompt still goes through, just unplanned.
2. **A clone of the repository.**

   ```sh
   git clone https://github.com/swcstudiospace/claude-ultrathink.git <clone>
   ```

   ultrathink has no runtime dependencies, so `bun install` is not needed to run it. It only installs type definitions for development. (If you plan to use Muse, see the note on symlinks in [Muse Code](#muse-code).) A Claude Code install from the GitHub marketplace does not need a clone. The other hosts and the MCP gateway do.
3. **An engine login.** Planning runs on a separate model call, independent of the host you type into.
   - Claude (the default): the `claude` CLI must be on `PATH` and logged in. The engine runs `claude -p` headless.
   - Grok (optional): run `grok login`, unless you use the `shunt` transport. See [Engine selection](#engine-selection).

Optional:

| Tool | Needed for |
|---|---|
| `gh`, logged in | [Ship](ship.md): pushing, opening and merging the PR |
| Greptile CLI (`greptile login`) | Ship's CLI review mode |
| Notion, Linear, Greptile credentials | [Tracking](tracking.md) and ship, through the [shared MCP gateway](#shared-mcp-gateway) |

Linear and Notion tracking are off until you configure them. A fresh install plans prompts and creates no rows. See [Configuration](configuration.md) and [Tracking](tracking.md).

Each host keeps its own state directory. Planning never writes `.planning/` into your working directory.

| Host | State directory | `ULTRATHINK_HOST` id |
|---|---|---|
| Claude Code | `~/.claude/ultrathink` (`$CLAUDE_CONFIG_DIR/ultrathink` if set) | `claude-code` |
| Grok Build | `~/.grok/plugin-data/ultrathink` (`$GROK_PLUGIN_DATA/ultrathink` if set) | `grok-build` |
| Hermes Agent | `~/.hermes/ultrathink` (`$HERMES_HOME/ultrathink` if set) | `hermes` |
| Muse Code | `~/.config/muse/ultrathink` (`$XDG_CONFIG_HOME/muse/ultrathink` if set) | `muse` |
| Omp | `~/.omp/agent/ultrathink` (`$PI_CODING_AGENT_DIR/ultrathink` if set) | `omp` |

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

Start a new Claude Code session after installing.

### Verify

1. Run `/ultrathink-status`. The plugin also lists it as `/ultrathink:ultrathink-status`. The prompt hook answers before any model turn and shows the engine (for example `Engine: claude:sonnet`), the tracking state and the state directory. From a shell, `<clone>/bin/ultrathink status` prints the same thing.
2. Send a non-trivial prompt, such as a one-line feature request. The transcript shows a summary line that starts with `Prompt Uplift ·`, and the agent invokes `ultrathink-kickoff` before it does other work.

Verified live on Claude Code 2.1.278: `/ultrathink-status` and `/ultrathink-quick` in `claude -p`. Headless, the status reply appears as "blocked by hook" text. A quick message was answered and no plan was written.

### Update

```sh
claude plugin marketplace update ultrathink
claude plugin update ultrathink@ultrathink
```

For a local-path marketplace, `git pull` in `<clone>` first. Claude Code runs the plugin from a copy in its plugin cache, so the update step is still needed. Restart Claude Code to apply the update.

### Uninstall

```sh
claude plugin uninstall ultrathink@ultrathink
claude plugin marketplace remove ultrathink
```

Delete `~/.claude/ultrathink` if you also want to remove the planning state. If you ran `bun scripts/setup.ts apply`, also run `bun scripts/setup.ts rollback`. See the [`scripts/setup.ts` reference](#scriptssetupts-reference).

## Grok Build

Grok Build uses the plugin directory for skills and commands. It finds the plugin's `hooks/hooks.json` but does not dispatch plugin hooks, so `bun scripts/setup.ts apply` installs a global hook file, `~/.grok/hooks/ultrathink.json`. That file is a copy of `hooks/hooks.json` with absolute paths, `ULTRATHINK_HOST=grok-build` on every hook, and a 600 s timeout on the prompt hook in place of Grok's 30 s default.

Grok also discards hook stdout, so the plan cannot be injected into the turn directly. Instead, the hook writes the plan to `~/.grok/plugin-data/ultrathink/last-plan.json`, and `apply` installs the rule `~/.grok/rules/ultrathink.md` (copied from `hosts/grok/ultrathink.md`). The rule tells the model to read that file before acting.

### Install

```sh
mkdir -p ~/.grok/plugins
ln -sfn <clone> ~/.grok/plugins/ultrathink
cd <clone>
bun scripts/setup.ts apply
```

`apply` installs the Grok rule and hook file first. It uses `$GROK_HOME` in place of `~/.grok` when that variable is set. `apply` also sets up Claude Code, which the [`scripts/setup.ts` reference](#scriptssetupts-reference) describes. If the `claude` CLI is not installed, it skips the Claude Code steps and prints a notice, so a machine with only Grok Build can run it.

### Verify

1. Run `bun scripts/setup.ts status` in `<clone>`. It should print `Grok rule: installed (…/rules/ultrathink.md)` and `Grok hooks: installed (…/hooks/ultrathink.json)`. The rule counts as installed only when it contains the `<!-- ultrathink:start -->` … `<!-- ultrathink:end -->` block.
2. Start Grok and run `/ultrathink-status`. The prompt hook blocks the command and shows the state.
3. Send a non-trivial prompt. `~/.grok/plugin-data/ultrathink/last-plan.json` should update, and the model should read the plan and invoke `ultrathink-plan`, then `ultrathink-kickoff`.

Verified live on Grok Build 1.0.41: `/ultrathink-status` and `/ultrathink-quick` in `grok -p`. A quick message was answered. In headless mode a blocked control command prints nothing, so check status in the interactive UI or with `ULTRATHINK_HOST=grok-build <clone>/bin/ultrathink status`.

### Update

```sh
cd <clone>
git pull
bun scripts/setup.ts apply
```

The symlink points at your clone, so skills and commands update with `git pull`. Re-running `apply` rewrites the global hook file and the rule when they changed. It is idempotent.

### Uninstall

```sh
cd <clone>
bun scripts/setup.ts rollback
rm ~/.grok/plugins/ultrathink
```

`rollback` removes `~/.grok/hooks/ultrathink.json` and the rule. If the rule file holds only the ultrathink block, it deletes the file. If you added your own text around the block, it removes only the block. `rollback` also undoes the Claude Code changes that `apply` made. Delete `~/.grok/plugin-data/ultrathink` to remove the state.

## Hermes Agent

Hermes loads `hosts/hermes`, a Python plugin with `plugin.yaml` and `register()`. Its `pre_llm_call` hook sends the prompt to `hooks/engine.ts` through `bin/run-bun` and returns the plan as context. It waits up to 540 s, below Hermes' 600 s backstop; `ULTRATHINK_HERMES_TIMEOUT` (seconds) overrides this. The plugin also registers the `/ultrathink-<verb>` commands and a pull-request nudge for `ultrathink-sync`.

### Install

```sh
mkdir -p ~/.hermes/plugins
ln -sfn <clone>/hosts/hermes ~/.hermes/plugins/ultrathink
hermes plugins enable ultrathink
hermes plugins doctor ultrathink
```

ultrathink only registers hooks and commands. It does not replace built-in tools, so if `enable` asks about tool override, decline (or pass `--no-allow-tool-override`). The plugin resolves the symlink to find the engine, so keep the rest of `<clone>` in place.

If another Hermes plugin already plans or rewrites prompts, disable it. Otherwise both will plan the same turn.

In gateways such as Telegram, `/ultrathink-quick` needs `plugins.entries.ultrathink.allow_gateway_injection: true` in the Hermes config. Without it, the command falls back to skipping the next message. See [Commands](commands.md).

### Verify

1. `hermes plugins doctor ultrathink` reports no errors, and `hermes plugins list` shows `ultrathink` as enabled.
2. Start a Hermes session and run `/ultrathink-status`. Hermes replies inline with the state.
3. Send a non-trivial prompt. The plan reaches the model as context before its first call.

Verified live on Hermes Agent v0.21.4 through its real CLI command dispatcher: `/ultrathink-status`, `/ultrathink-track off`, and `/ultrathink-quick`, which injected the message with no plan.

### Update

```sh
cd <clone>
git pull
```

The plugin is a symlink into your clone, so there is nothing to reinstall. Restart Hermes, including any running gateway, so it reloads the Python plugin.

### Uninstall

```sh
hermes plugins disable ultrathink
rm ~/.hermes/plugins/ultrathink
```

Delete `~/.hermes/ultrathink` to remove the state.

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

### Update

```sh
cd <clone>
git pull
muse plugins update ultrathink
muse plugins inspect ultrathink
```

Muse installs a copy into its plugin cache, so `git pull` alone does not update it. If `inspect` shows a hook that is not `trusted_enabled` after the update, run `muse plugins approve ultrathink` again.

### Uninstall

```sh
muse plugins remove ultrathink
```

Delete `~/.config/muse/ultrathink` to remove the planning state.

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

### Update

```sh
cd <clone>
git pull
```

`omp plugin link` links the clone itself, so restart Omp to load the new code.

### Uninstall

```sh
omp plugin uninstall ultrathink
```

Delete `~/.omp/agent/ultrathink` to remove the state.

## `scripts/setup.ts` reference

`bun scripts/setup.ts <apply|status|rollback>` runs from `<clone>`. With no argument it runs `status`. Grok Build needs `apply`. The other hosts do not.

| Subcommand | What it does |
|---|---|
| `apply` | 1. Installs the Grok rule `~/.grok/rules/ultrathink.md` (copied from `hosts/grok/ultrathink.md`) and the Grok hook file `~/.grok/hooks/ultrathink.json`, under `$GROK_HOME` if set.<br>2. If the `claude` CLI is installed, adds the hosted Notion (`https://mcp.notion.com/mcp`) and Linear (`https://mcp.linear.app/mcp`) HTTP MCP servers to Claude Code at user scope, unless `claude mcp list` already shows a server with that name.<br>3. Runs `claude plugin marketplace add <clone>` and `claude plugin install ultrathink@ultrathink`.<br>4. Merges a tracking block into `~/.claude/CLAUDE.md` (`$CLAUDE_CONFIG_DIR/CLAUDE.md` if set) between `<!-- ultrathink:start -->` and `<!-- ultrathink:end -->`, updating it in place on re-runs.<br>5. Records which MCP servers it added in `~/.claude/ultrathink-setup-state.json`.<br>6. Prints the install commands for Hermes, Muse and Omp.<br>Without the `claude` CLI, steps 2 to 5 are skipped with the notice `Claude Code: claude CLI not found — skipped …`. |
| `status` | Reports whether the Grok rule (with its marker block) and the Grok hook file are installed. With the `claude` CLI, it also reports whether Claude Code has `notion` and `linear` MCP servers and whether the `CLAUDE.md` block is present. Without it, it prints `Claude Code: claude CLI not found` followed by the Grok lines. |
| `rollback` | Removes the Grok hook file and the Grok rule (the whole file if it holds only the ultrathink block, otherwise just the block). Removes the `CLAUDE.md` block. Removes the `notion` and `linear` Claude Code MCP servers only if `apply` added them. It does not uninstall the Claude Code plugin. |

`apply` is idempotent. The hosted servers from step 2 connect Claude Code directly to Notion and Linear. If you also use the [shared MCP gateway](#shared-mcp-gateway), run `bun scripts/mcp-register.ts` after `apply`: it replaces Claude Code's `notion` and `linear` entries with gateway entries, and later `apply` runs leave them alone. `rollback` removes the `notion` and `linear` entries by name when `apply` recorded adding them, even if the gateway has replaced them since. Run `mcp-register` again afterwards if you want to keep the gateway in Claude Code.

## Shared MCP gateway

`bin/ultrathink-mcp` is a stdio MCP server that relays to the hosted Notion, Linear and Greptile MCP servers. It adds credentials from one store, `~/.config/ultrathink/mcp-credentials.json` (mode 0600; `$XDG_CONFIG_HOME` is honored, and `ULTRATHINK_MCP_STORE` overrides the path). The planner creates tracking rows through the same store, and the ship loop uses it for Greptile. Register the gateway in each host and log in once.

### Register it in every host

```sh
cd <clone>
bun scripts/mcp-register.ts --dry-run   # show what would change
bun scripts/mcp-register.ts
```

This adds three servers, `notion`, `linear` and `greptile`, each running `<clone>/bin/ultrathink-mcp serve <provider>`. It writes user-level config only, replaces entries with the same name, and backs up every file it changes as `<file>.bak-ultrathink-mcp-<timestamp>`.

| Host | How it registers |
|---|---|
| Claude Code | `claude mcp remove` / `claude mcp add --scope user` (backs up `~/.claude.json`) |
| Grok Build | `grok mcp add --scope user` (backs up `~/.grok/config.toml`) |
| Hermes Agent | `hermes mcp remove` / `hermes mcp add` (backs up `~/.hermes/config.yaml`). Hermes saves a server it cannot connect to yet as disabled, which the script reports as `saved disabled`. Run the script again after logging in. |
| Muse Code | Edits `~/.config/muse/settings.json` directly (`mcpServers`, `mode: "optional"`) |
| Omp | Edits `~/.omp/agent/mcp.json` directly |

The script skips Claude Code, Grok or Hermes when its CLI is not on `PATH`. Limit the run with `--hosts claude,grok,hermes,muse,omp` and `--providers notion,linear,greptile`. It exits non-zero if any registration failed.

### Log in

```sh
bin/ultrathink-mcp auth set-key linear --stdin      # paste a Linear API key
bin/ultrathink-mcp auth set-key greptile --stdin    # paste a Greptile API key
bin/ultrathink-mcp auth login notion                # Notion supports OAuth only
bin/ultrathink-mcp auth status
```

`set-key` also accepts `--env-file <path> --var <NAME>` to read the key from a dotenv file. `auth login` starts a browser OAuth flow with a callback on `127.0.0.1:8765`. For a login over SSH or on another machine, see [Configuration](configuration.md). `auth logout <provider>` removes a provider's credentials.

### Check it

```sh
bin/ultrathink-mcp check            # all three providers
bin/ultrathink-mcp check linear     # one provider
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

To switch every host, set it in config, for example in `~/.config/ultrathink/config.json`. See [Configuration](configuration.md) for file locations and precedence.

```json
{ "think": { "engine": "grok" } }
```

### Claude engine

The Claude engine runs the `claude` CLI headless (`claude -p`) with your existing Claude Code login.

| Key | Default | Meaning |
|---|---|---|
| `claude.bin` | `claude` | Binary to run |
| `claude.model` | `sonnet` | Model alias. Empty uses the CLI's default model. |
| `claude.thinking` | `false` | Allow extended thinking in the planning calls (slower) |
| `claude.settingSources` | `""` | `--setting-sources` for the child call. Empty loads none. |
| `claude.callTimeoutMs` | `0` | Per-call timeout. 0 means no timer; the host hook timeout still applies. |

The engine label is `claude:<model>`, for example `claude:sonnet`.

### Grok engine

| Key | Default | Meaning |
|---|---|---|
| `grok.enabled` | `true` | `false` forces Claude even when `grok` is selected |
| `grok.transport` | `http` | `http`, `cli` or `shunt` (below) |
| `grok.model` | `grok-4.7` | Model for `http` and `cli` |
| `grok.reasoningEffort` | `xhigh` | `low`, `medium`, `high` or `xhigh` |
| `grok.baseUrl` | `https://cli-chat-proxy.grok.com/v1` | Endpoint for the `http` transport |
| `grok.bin` | `grok` | Grok CLI binary |
| `grok.home` | `""` | Grok home. Empty uses `$GROK_HOME`, else `~/.grok`. |
| `grok.callTimeoutMs` | `0` | Per-call timeout. 0 means no timer. |
| `grok.fallbackToClaude` | `false` | Use Claude when the Grok login is missing or expired |
| `grok.shuntBaseUrl` | `http://127.0.0.1:3001` | Gateway base URL for `shunt` (`/v1/messages` is appended) |
| `grok.shuntModel` | `grok-4.7-xhigh` | Model name sent to the gateway |
| `grok.shuntMaxTokens` | `8192` | `max_tokens` for `shunt` calls |

| Transport | Wire | Auth |
|---|---|---|
| `http` | `POST {grok.baseUrl}/responses` | Your `grok login` session (`auth.json` in the Grok home) |
| `cli` | Runs the `grok` binary | Your `grok login` session |
| `shunt` | `POST {grok.shuntBaseUrl}/v1/messages`, Anthropic Messages format | None from ultrathink. The gateway you run handles upstream auth. |

For `http` and `cli`, ultrathink checks the Grok login before planning. If the login is missing or expired and `grok.fallbackToClaude` is `false`, the prompt goes through unplanned and the prompt hook reports ``Prompt Uplift skipped · Grok 4.7 login required (run `grok login`)``. With `fallbackToClaude: true`, it plans on Claude instead and the label ends in `(grok fallback)`. `shunt` skips the login check.

The engine label is `<model>@<effort>` for `http` and `cli` (for example `grok-4.7@xhigh`) and `<shuntModel>@shunt` for `shunt`.

Whichever engine you choose, a failed or timed-out planning call never blocks your prompt. The turn continues with a minimal fallback spec, creates no tracking rows, and the summary line reports `Engine error · …`. See [Troubleshooting](troubleshooting.md).
