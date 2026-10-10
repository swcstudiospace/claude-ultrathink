# Run pstack skills beside GSD in Cursor

The Cursor pstack plugin ships skills (`how`, `architect`, `arena`, `tdd`, `interrogate`, `no-comments`) that Cursor will not start on its own. ultrathink's bridge does not start them either. When you submit a `/gsd-*` command, a Cursor hook adds a short instruction that names the skills for that step and the absolute path of each `SKILL.md`. The agent reads those files, then continues the GSD workflow. The hook writes nothing and sends nothing off the machine.

It is off until you enable it. A file inside a repository cannot turn it on.

`<clone>` is the directory you cloned ultrathink into.

- [Install the hook](#install-the-hook)
- [Enable it](#enable-it)
- [Check it](#check-it)
- [What each command maps to](#what-each-command-maps-to)
- [Turn it off or remove it](#turn-it-off-or-remove-it)

## Install the hook

From the clone:

```sh
bun <clone>/scripts/cursor-hooks.ts install
```

That copies `hosts/cursor/ultrathink-cursor-pstack.js` to `~/.cursor/hooks/ultrathink-cursor-pstack.js` and adds one `beforeSubmitPrompt` entry to `~/.cursor/hooks.json`, marked `ultrathink-managed: true`. Running it again does not add a second entry. Entries marked `gsd-managed` or `substrate-managed`, and any other entry, are left in place. `hooks.json` is written as a private file (mode `0600`) by renaming a temporary file over it.

`--cursor-dir <dir>` targets a Cursor directory other than `~/.cursor`.

## Enable it

In your user config, `${XDG_CONFIG_HOME:-~/.config}/ultrathink/config.json` (create the file if you have none):

```json
{ "pstack": { "enabled": true } }
```

The hook reads the first user file that exists and parses, and it does not merge files. That is `$ULTRATHINK_CONFIG_DIR/config.json` when `ULTRATHINK_CONFIG_DIR` is set; otherwise the user file above, then `${CLAUDE_CONFIG_DIR:-~/.claude}/ultrathink.json`. Put `pstack` in the file it will actually read. `<project>/.claude/ultrathink.json` is ignored for this section.

Optional keys, all user-only:

| Key | Purpose |
|---|---|
| `cursorDir` | Absolute Cursor directory. Otherwise `$ULTRATHINK_PSTACK_CURSOR_DIR`, or `~/.cursor`. |
| `mapping` | Replace one stage's skills. Stages are `discuss`, `plan`, `execute`, `review`. |
| `contextCapChars` | Longest instruction block. Default `2000`. A block that cannot fit even one skill is not injected. |

Every key is in [Configuration](../configuration.md#pstack-cursor-bridge).

## Check it

```sh
<clone>/bin/ultrathink doctor
```

Use the `bin/ultrathink` from the clone. The `pstack` section names the deciding config file, the resolved plugin version and path, each stage's skills (a warning when a mapped name has no `SKILL.md`), and whether the hook entry is installed. `--json` prints the same findings. Nothing is changed.

Submit a prompt such as `/gsd-plan-phase 24` in Cursor. With the bridge on and pstack installed, the agent receives an instruction that includes `architect` and `arena` and the path of each `SKILL.md`. The command has to be invoked at the start of a line. A mention later in a sentence or inside quotes, including a quote that spans lines, such as "What does /gsd-ship do?", is left alone, as is a prompt that is not a `/gsd-*` command, including a pstack command such as `/architect`.

The plugin ultrathink resolves is the newest completed pstack directory under `<cursor dir>/plugins/cache/cursor-public/pstack` (a `plugin.json` whose name is `pstack`, plus a zero-byte `.cache-complete` marker).

## What each command maps to

| Commands | Stage | Default skills |
|---|---|---|
| `/gsd-discuss-phase` | discuss | `how` |
| `/gsd-plan-phase`, `/gsd-ultraplan-phase`, `/gsd-spec-phase` | plan | `architect`, `arena` |
| `/gsd-execute-phase`, `/gsd-fast`, `/gsd-quick`, `/gsd-quick-batch` | execute | `tdd` |
| `/gsd-verify-work`, `/gsd-code-review`, `/gsd-ui-review`, `/gsd-audit-uat`, `/gsd-audit-fix`, `/gsd-audit-milestone`, `/gsd-ship` | review | `interrogate`, `no-comments` |
| `/gsd-autonomous` | all four, each at its moment | all six |

A skill that is missing is skipped. The hook still injects the ones that resolve. If none resolve, it injects nothing.

## Turn it off or remove it

| To stop | Do this |
|---|---|
| One process | `ULTRATHINK_PSTACK=0` |
| Until you turn it on again | `"pstack": { "enabled": false }` in the user file the hook reads |
| The hook entry and the staged file | `bun <clone>/scripts/cursor-hooks.ts remove` |

`remove` deletes only the entry ultrathink owns and `ultrathink-cursor-pstack.js`. Other hook entries stay, in the same order.
