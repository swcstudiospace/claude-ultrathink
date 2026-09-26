# Upgrade ultrathink, or move its clone

This guide covers two jobs:

- [Upgrading](#upgrade) to a newer version of ultrathink on each host.
- [Moving the clone](#move-the-clone-to-another-directory) to another directory, which several hosts need to be told about.

In the commands below, `<clone>` is the absolute path of your checkout of the repository. Your config files, credentials and planning state are not stored in the clone. Upgrading and moving keep them.

Before you upgrade, read [CHANGELOG.md](../../CHANGELOG.md) for changes that affect your setup.

## Upgrade

Get the new code first:

```sh
cd <clone>
git pull
```

Then do the step for each host you use. A Claude Code install from the GitHub marketplace has no clone, so skip `git pull` for it.

| Host | After `git pull` | Why |
|---|---|---|
| Claude Code | `claude plugin marketplace update ultrathink`<br>`claude plugin update ultrathink@ultrathink`<br>Then restart Claude Code. | Claude Code runs a copy of the plugin from its plugin cache, for both the GitHub and the local-path marketplace. |
| Grok Build | `bun scripts/setup.ts apply` | The symlink in Grok's plugin directory already points at the clone, so skills and commands are current. `apply` rewrites the global hook file and refreshes the ultrathink block in the Grok rule if either changed. It is safe to run again. |
| Hermes Agent | Restart Hermes, and any running Hermes gateway. | The plugin is a symlink into the clone. Hermes loads Python plugins at start. |
| Muse Code | `muse plugins update ultrathink`<br>`muse plugins inspect ultrathink` | Muse runs a copy from its plugin cache. If `inspect` lists a hook that is not `status=trusted_enabled`, run `muse plugins approve ultrathink` again. |
| Omp | Restart Omp. | `omp plugin link` links the clone itself. |

`bun scripts/setup.ts apply` also re-runs its Claude Code steps when the `claude` CLI is installed. Those steps are idempotent too. See the [`scripts/setup.ts` reference](../install.md#scriptssetupts-reference).

The shared MCP gateway needs nothing extra. Each host starts `<clone>/bin/ultrathink-mcp serve <provider>` itself, so the next session the host starts runs the new code. Your credential store is not touched.

### Upgrading Bun

ultrathink needs Bun 1.2 or later. If you install Bun somewhere new, the hooks find it without changes, as long as it is in one of the places `bin/run-bun` searches (see [Install](../install.md#prerequisites)). Otherwise set `BUN=/path/to/bun` in the host's environment.

## Move the clone to another directory

Several hosts store the clone's absolute path. After you move the clone, each of them still points at the old path until you update it. Until then, prompts on those hosts go through unplanned, and the gateway's MCP servers fail to start.

Move the directory first:

```sh
mv <old clone> <new clone>
cd <new clone>
```

Then update every place that holds the old path. Skip the hosts you don't use.

| What holds the path | How to update it |
|---|---|
| Grok hook file, `${GROK_HOME:-~/.grok}/hooks/ultrathink.json` | `bun scripts/setup.ts apply`. The file is a copy of `hooks/hooks.json` with absolute paths, and `apply` writes it again with the new ones. |
| Grok plugin symlink | `ln -sfn <new clone> ${GROK_HOME:-~/.grok}/plugins/ultrathink` |
| Hermes plugin symlink | `ln -sfn <new clone>/hosts/hermes ${HERMES_HOME:-~/.hermes}/plugins/ultrathink`, then restart Hermes and any running gateway. |
| MCP gateway entries in every host | `bun scripts/mcp-register.ts`. Each entry runs `<clone>/bin/ultrathink-mcp`. An entry that runs another clone's `bin/ultrathink-mcp` counts as ultrathink's, so the script replaces it with the new path. Add `--dry-run` first to see the changes. |
| Claude Code local-path marketplace (added with `claude plugin marketplace add <clone>`, or by `setup.ts apply`) | `claude plugin marketplace remove ultrathink`<br>`claude plugin marketplace add <new clone>`<br>`claude plugin install ultrathink@ultrathink`<br>A GitHub marketplace install has no local path and needs nothing. |
| Muse Code | `muse plugins remove ultrathink`<br>`muse plugins install <new clone> --scope user`<br>`muse plugins approve ultrathink`<br>`muse plugins update` refreshes from the source it was installed from, which is the old path. |
| Omp | `omp plugin uninstall ultrathink`<br>`omp plugin link <new clone>` |

Check the result:

```sh
bun scripts/setup.ts status             # Grok rule and Grok hooks: installed
bun scripts/mcp-register.ts --dry-run   # no "added" or "replaced" lines left
```

Then start each host and run `/ultrathink-status`.

The slash commands, config files, credential store and state directories don't hold the clone path. They need no change.

### Don't register the gateway from a plugin cache

Some hosts keep their own copy of the plugin in a plugin cache, and replace it on the next plugin update. If you run `scripts/mcp-register.ts` from a directory whose path contains `/plugins/cache/`, it prints a warning, because the registered commands would break on that update. Run it from a clone in a stable directory.

## Move to another machine

Install from scratch on the new machine with [Getting started](../getting-started.md) or [Install](../install.md). You can copy your config files (`~/.config/ultrathink/config.json` and any `.claude/ultrathink.json` files) as they are.

Log in to Notion, Linear and Greptile again on the new machine rather than copying the credential store. Notion issues a new refresh token each time one is used, and using a retired one can revoke the whole grant, so two machines sharing one copied store can log each other out. See [Set up Notion](set-up-notion.md) and [Register the MCP gateway](register-mcp-gateway.md).
