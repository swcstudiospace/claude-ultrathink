# Uninstall ultrathink

This guide removes ultrathink completely: from each host, from the host settings that `scripts/setup.ts` and `scripts/mcp-register.ts` changed, and from your machine (credentials, config and state). Do the steps in order. Steps 2 and 3 run scripts from the clone with Bun, so delete the clone last.

In the commands below, `<clone>` is the absolute path of your checkout. Paths written as `${NAME:-default}` use the environment variable when you set it, and the default otherwise.

1. [Remove the plugin from each host](#1-remove-the-plugin-from-each-host)
2. [Undo `scripts/setup.ts apply`](#2-undo-scriptssetupts-apply)
3. [Remove the MCP gateway entries](#3-remove-the-mcp-gateway-entries)
4. [Delete stored credentials](#4-delete-stored-credentials)
5. [Delete config files](#5-delete-config-files)
6. [Delete planning state](#6-delete-planning-state)
7. [Delete the clone](#7-delete-the-clone)

Rows ultrathink created in Notion and Linear are not touched. See [What stays in Notion and Linear](#what-stays-in-notion-and-linear).

## 1. Remove the plugin from each host

Skip the hosts you don't use.

### Claude Code

```sh
claude plugin uninstall ultrathink@ultrathink
claude plugin marketplace remove ultrathink
```

`scripts/setup.ts rollback` (step 2) prints these two commands but does not run them. Restart Claude Code afterwards.

### Grok Build

```sh
grok plugin disable ultrathink
rm ${GROK_HOME:-~/.grok}/plugins/ultrathink
```

This removes the symlink the install created, not your clone. Grok's global hook file and rule are removed in step 2.

### Hermes Agent

```sh
hermes plugins disable ultrathink
rm ${HERMES_HOME:-~/.hermes}/plugins/ultrathink
```

`rm` removes the symlink only. Then undo the Hermes settings ultrathink asked you to make:

- `plugins.hook_callback_timeout` is a global Hermes setting that applies to every plugin. ultrathink never sets it; you set it during install. If no other plugin needs a long hook cap, put it back to Hermes' default of 30 s:

  ```sh
  hermes config unset plugins.hook_callback_timeout
  ```

- If you set `plugins.entries.ultrathink.allow_gateway_injection` for `/ultrathink-quick` in gateways, remove it:

  ```sh
  hermes config unset plugins.entries.ultrathink
  ```

Restart Hermes, and any running Hermes gateway.

### Muse Code

```sh
muse plugins remove ultrathink
```

### Omp

```sh
omp plugin uninstall ultrathink
```

## 2. Undo `scripts/setup.ts apply`

Skip this step if you never ran `bun scripts/setup.ts apply`.

```sh
bun <clone>/scripts/setup.ts rollback
```

`rollback` undoes what `apply` recorded, and prints one line per item:

| Item | What `rollback` does |
|---|---|
| `CLAUDE.md` tracking block | Removes the block between `<!-- ultrathink:start -->` and `<!-- ultrathink:end -->` from `${CLAUDE_CONFIG_DIR:-~/.claude}/CLAUDE.md`. The rest of the file stays. |
| Claude Code `notion` and `linear` MCP servers | For each one that any `apply` run added (a re-run of `apply` keeps earlier records), checks it with `claude mcp get` and runs `claude mcp remove --scope user` only while it is still the user-scope HTTP server `apply` added, with the hosted URL. A changed entry is reported as `left in place: <name> was changed since setup added it`, a missing one as `already removed`, and a server that was configured before `apply` as `left in place (setup did not add it)`. |
| Setup state file | Deletes `${CLAUDE_CONFIG_DIR:-~/.claude}/ultrathink-setup-state.json`, where `apply` recorded which servers it added. If `claude` failed, the line says `removal failed (…)` and the state file is kept, so running `rollback` again retries it; or run the printed `claude mcp remove --scope user <name>` yourself. |
| Grok hook file | Deletes `${GROK_HOME:-~/.grok}/hooks/ultrathink.json`. |
| Grok rule | Removes the ultrathink block from `${GROK_HOME:-~/.grok}/rules/ultrathink.md`. The file is deleted when nothing else is left in it; text you added around the block stays. |
| Claude Code plugin | Not removed. The last line prints `claude plugin uninstall ultrathink@ultrathink && claude plugin marketplace remove ultrathink` for you to run (step 1). |

If you replaced the hosted `notion` and `linear` servers with gateway entries (`mcp-register --replace`), `rollback` leaves those in place; step 3 removes them.

## 3. Remove the MCP gateway entries

Skip this step if you never ran `bun scripts/mcp-register.ts`.

```sh
bun <clone>/scripts/mcp-register.ts --remove --dry-run   # show what would be removed
bun <clone>/scripts/mcp-register.ts --remove
```

`--remove` deletes only ultrathink's `notion`, `linear` and `greptile` entries, meaning entries whose command ends in `/bin/ultrathink-mcp`. A same-named entry that runs something else is left in place and reported as `kept`. Hosts whose CLI (`claude`, `grok`, `hermes`) is not on `PATH` are skipped. Limit the run with `--hosts` and `--providers` if you only want some of them removed. Only user-scope entries are touched; same-named local or project entries are left alone.

Every file the script changed, now or when you registered, has a backup next to it named `<file>.bak-ultrathink-mcp-<timestamp>`. Delete the backups once you are happy with the result:

| Host | Config file |
|---|---|
| Claude Code | `${CLAUDE_CONFIG_DIR:-~}/.claude.json` |
| Grok Build | `${GROK_HOME:-~/.grok}/config.toml` |
| Hermes Agent | `${HERMES_HOME:-~/.hermes}/config.yaml`, or with an active Hermes profile `${HERMES_HOME:-~/.hermes}/profiles/<name>/config.yaml` |
| Muse Code | `${XDG_CONFIG_HOME:-~/.config}/muse/settings.json` |
| Omp | `${PI_CODING_AGENT_DIR:-~/.omp/agent}/mcp.json` |

## 4. Delete stored credentials

The gateway keeps every Notion, Linear and Greptile credential in one file. Remove them per provider:

```sh
<clone>/bin/ultrathink-mcp auth logout notion
<clone>/bin/ultrathink-mcp auth logout linear
<clone>/bin/ultrathink-mcp auth logout greptile
```

or delete the file itself: `$ULTRATHINK_MCP_STORE` if you set it, otherwise `${XDG_CONFIG_HOME:-~/.config}/ultrathink/mcp-credentials.json`. A `mcp-credentials.json.lock` directory next to it, if one is left, can go too.

`auth logout` only deletes the local copy. To revoke the access you granted, remove the ultrathink connection or API key in your Notion, Linear or Greptile account settings.

If you used `auth login --tailscale` and a login was interrupted before it finished, the temporary `tailscale serve` handler may still be there. Remove it with:

```sh
tailscale serve --https=443 --set-path=/ultrathink-oauth off
```

## 5. Delete config files

Delete the ultrathink config files you created. Any of them may be absent.

- `${XDG_CONFIG_HOME:-~/.config}/ultrathink/config.json`
- `${CLAUDE_CONFIG_DIR:-~/.claude}/ultrathink.json`
- `<project>/.claude/ultrathink.json` in each project where you added one

## 6. Delete planning state

Each host keeps its own state directory: control state, planned sessions, specs and claims. Delete the ones that exist:

| Host | State directory |
|---|---|
| Claude Code | `${CLAUDE_CONFIG_DIR:-~/.claude}/ultrathink` |
| Grok Build | `$GROK_PLUGIN_DATA/ultrathink` if set, otherwise `${GROK_HOME:-~/.grok}/plugin-data/ultrathink` |
| Hermes Agent | `${HERMES_HOME:-~/.hermes}/ultrathink`, and `ultrathink` in each Hermes profile directory you used it in (`${HERMES_HOME:-~/.hermes}/profiles/<name>`) |
| Muse Code | `${XDG_CONFIG_HOME:-~/.config}/muse/ultrathink` |
| Omp | `${PI_CODING_AGENT_DIR:-~/.omp/agent}/ultrathink` |

If you set `ULTRATHINK_STATE_DIR`, the state is in that directory instead. Unset the variable too.

## 7. Delete the clone

```sh
rm -rf <clone>
```

A Claude Code install from the GitHub marketplace has no clone. Step 1 removed it.

## What stays in Notion and Linear

Rows ultrathink created stay where they are: Notion Task, Issue and Sub-Issue rows, the Notion database that `ultrathink-mcp notion init` created, and Linear issues and sub-issues. Delete them in Notion and Linear if you no longer want them. Pull requests and branches that ship opened on GitHub also stay.

## Reinstalling later

Follow [Install](../install.md) or [Getting started](../getting-started.md) again. To move a working install to another directory instead of reinstalling, see [Upgrade and move](upgrade-and-move.md).
