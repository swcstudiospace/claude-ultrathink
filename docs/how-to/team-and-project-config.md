# Share config with a team or a project

ultrathink reads the same three JSON config files on every host. One of them lives in the repository, so a team can commit the settings that belong to the project and keep everything personal out of git. This guide says which file is which, how they combine, and what goes where.

- [The three files](#the-three-files)
- [How they combine](#how-they-combine)
- [What to put in the project file](#what-to-put-in-the-project-file)
- [What stays with each user](#what-stays-with-each-user)
- [Credentials never go in config](#credentials-never-go-in-config)
- [Review a project file before you trust it](#review-a-project-file-before-you-trust-it)

## The three files

| Order | File | Use it for |
|---|---|---|
| 1 | `~/.config/ultrathink/config.json` (`$XDG_CONFIG_HOME/ultrathink/config.json` when `XDG_CONFIG_HOME` is set) | Your own settings on this machine, for every host and every project. `bin/ultrathink-mcp notion init --write-config` writes here. |
| 2 | `~/.claude/ultrathink.json` (`$CLAUDE_CONFIG_DIR/ultrathink.json` when `CLAUDE_CONFIG_DIR` is set) | Also per user. Every host reads it, not only Claude Code. |
| 3 | `<repo>/.claude/ultrathink.json` | The project file, read from the session's working directory. Commit it to share it. |

Every file is optional. `bin/ultrathink-ship` reads them for the directory given with `--cwd`, or the current directory.

## How they combine

- Later files win: the project file beats both user files, and `~/.claude/ultrathink.json` beats `~/.config/ultrathink/config.json`.
- The merge is per key inside each section. A project file with only `{"hitl": {"maxQuestions": 2}}` changes that one key and keeps everything else.
- A missing file, invalid JSON, or a top level that is not an object is skipped. Unknown keys are ignored. A value of the wrong type or out of range is ignored, and the earlier value stays.
- `notion.dataSourceUrl` and `linear.team` accept only non-empty strings. A project file cannot clear a Notion database or Linear team that a user file sets; `""` is ignored.
- The per-host control state beats the config for the keys it covers. `/ultrathink-off`, `/ultrathink-track off`, `bin/ultrathink think off`, `bin/ultrathink hitl off` and `bin/ultrathink grok engine …` write it to that host's state directory on that machine. It is never shared.
- Environment switches beat both: `ULTRATHINK_UPLIFT=0`, `ULTRATHINK_TRACK=0`, `ULTRATHINK_SHIP=0`.

To see the merged result for a project, run this from the repository:

```sh
<clone>/bin/ultrathink status
```

`<clone>` is the directory you cloned ultrathink into. It prints the engine, Graph of Thought, clarifying questions, tracking, the Notion data source, the Linear team, the Agent Substrate and ship lines, the Claude model and the state directory.

## What to put in the project file

Settings that describe the project, and are the same for everyone who works in it:

| Key | Why it belongs to the project |
|---|---|
| `linear.team` | The Linear team whose issues this project's work creates. See [Set up Linear](set-up-linear.md). |
| `notion.dataSourceUrl` | The shared Notion "Agent Task Graph" database, `collection://<data source id>`. See [Set up Notion](set-up-notion.md). |
| `ship` | Whether this repository ships, and how: `enabled`, `autoMerge`, `deleteBranch`, `skills`, `mergeMethod`, `minScore`, `maxRounds`, `greptileOrganization`. See [Ship with Greptile](ship-with-greptile.md). |
| `think.minNodes`, `think.maxNodes`, `hitl.maxQuestions` | How much planning the project wants. |

Example `<repo>/.claude/ultrathink.json`:

```json
{
  "linear": { "team": "<your Linear team>" },
  "notion": { "dataSourceUrl": "collection://<data source id>" },
  "ship": {
    "enabled": true,
    "autoMerge": false,
    "skills": ["gsd-"],
    "greptileOrganization": "<your Greptile organization>"
  }
}
```

These values are identifiers, not secrets. Each person still needs their own access: a Notion login that can see the database, a Linear login in that workspace, `gh` rights on the repository and a Greptile login in the organization.

## What stays with each user

Put these in `~/.config/ultrathink/config.json`, not in the repository:

| Key | Why it is personal |
|---|---|
| `think.engine`, `grok.*` | Which model account each person has. `grok.shuntBaseUrl` points at a gateway only that person runs. |
| `claude.model`, `claude.thinking`, `claude.concurrency`, `claude.budgetMs`, `claude.callTimeoutMs` | Speed and cost trade-offs of each person's own account. |
| `claude.bin`, `grok.bin`, `grok.home` | Paths on one machine. |
| `substrate.url` | An optional Agent Substrate service that person runs. |
| `uplift.*`, `track.enabled` | How each person wants to work. Everyone can also switch these per host with the control commands. |

## Credentials never go in config

No config key holds a secret, and ultrathink never reads one from a config file. Credentials live outside the repository:

| Credential | Where it lives |
|---|---|
| Notion, Linear and Greptile logins and API keys | The ultrathink credential store, `${XDG_CONFIG_HOME:-~/.config}/ultrathink/mcp-credentials.json`. The file is written with mode `0600`, in a directory created with mode `0700` (a directory that already exists keeps its mode). `ULTRATHINK_MCP_STORE` moves it. Written by `bin/ultrathink-mcp auth login` and `auth set-key`. See [Register the MCP gateway](register-mcp-gateway.md). |
| Claude engine | The `claude` CLI's own login. |
| Grok engine | `auth.json` in the Grok home, written by `grok login`. |
| GitHub | `gh`'s own login. |
| Greptile CLI | The Greptile CLI's own login (`greptile login`). |

Never copy the credential store into a repository or share it between people.

## Review a project file before you trust it

The project file wins over your own config, and it can set any key. A repository you clone can therefore:

- turn ship on, including `autoMerge` and `deleteBranch`, for your sessions in that repository;
- point Linear and Notion row creation at its own team and database;
- choose the binaries ultrathink runs (`claude.bin`, `grok.bin`) and the URLs planning calls go to (`grok.baseUrl`, `grok.shuntBaseUrl`, `substrate.url`);
- take your Grok login token: with the `http` transport, ultrathink sends that token as `Authorization: Bearer` to `grok.baseUrl`, so a project file that sets `think.engine: "grok"` and its own `grok.baseUrl` receives it.

Read `<repo>/.claude/ultrathink.json` in a repository you did not write, as you would read its code. `bin/ultrathink status` shows the engine, tracking and ship settings it produces. `ULTRATHINK_SHIP=0` turns ship off whatever the files say.

For every key and default, see [Configuration](../configuration.md#key-reference). For what leaves your machine, see [Privacy](../privacy.md).
