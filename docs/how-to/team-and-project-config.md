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
- The project file can only tighten Jev decisions: `decisions.enabled` only from `true` to `false`, `decisions.zdr` only from `false` to `true`, and `decisions.points` only narrowed to the points the user files (or the default) also list. `decisions.model`, `decisions.timeoutMs` and the thresholds merge as usual.
- The per-host control state beats the config for the keys it covers. `/ultrathink-off`, `/ultrathink-track off`, `bin/ultrathink think off`, `bin/ultrathink hitl off` and `bin/ultrathink grok engine …` write it to that host's state directory on that machine. It is never shared.
- Environment switches beat both: `ULTRATHINK_UPLIFT=0`, `ULTRATHINK_TRACK=0`, `ULTRATHINK_SHIP=0`, `ULTRATHINK_DECISIONS=0`.

To see the merged result for a project, run this from the repository:

```sh
<clone>/bin/ultrathink status
```

`<clone>` is the directory you cloned ultrathink into. It prints the engine, Graph of Thought, clarifying questions, tracking, the Notion data source, the Linear team, the Agent Substrate, ship, knowledge-base and `Decisions:` lines, the Claude model and the state directory.

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
| `decisions.enabled`, `decisions.zdr` | Jev decisions send prompt, patch and knowledge-base text to OpenRouter on each person's own key, so only a user file can turn them on or turn zero data retention off; the project file cannot. A project may still turn them off, narrow `decisions.points`, and set `decisions.model`, `decisions.timeoutMs` and the thresholds (`planSkipBelow`, `shipVetoAtOrBelow`, `shipApproveAt`, `groundedAt`, `blockingAt`) it has tuned on its own cases. See [Use Jev decisions](use-jev-decisions.md). |
| `uplift.*`, `track.enabled` | How each person wants to work. Everyone can also switch these per host with the control commands. |

## Credentials never go in config

No config key holds a secret, and ultrathink never reads one from a config file. Credentials live outside the repository:

| Credential | Where it lives |
|---|---|
| Notion, Linear and Greptile logins and API keys, and the OpenRouter API key for Jev decisions | The ultrathink credential store, `${XDG_CONFIG_HOME:-~/.config}/ultrathink/mcp-credentials.json`. The file is written with mode `0600`, in a directory created with mode `0700` (a directory that already exists keeps its mode). `ULTRATHINK_MCP_STORE` moves it. Written by `bin/ultrathink-mcp auth login` and `auth set-key`. See [Register the MCP gateway](register-mcp-gateway.md). The OpenRouter key can come from `OPENROUTER_API_KEY` instead; a stored key wins. |
| Claude engine | The `claude` CLI's own login. |
| Grok engine | `auth.json` in the Grok home, written by `grok login`. |
| GitHub | `gh`'s own login. |
| Greptile CLI | The Greptile CLI's own login (`greptile login`). |

Never copy the credential store into a repository or share it between people.

## Review a project file before you trust it

The project file wins over your own config and can set any key, except that it can only tighten Jev decisions (see below). A repository you clone can therefore:

- turn ship on, including `autoMerge` and `deleteBranch`, for your sessions in that repository;
- point Linear and Notion row creation at its own team and database;
- choose the binaries ultrathink runs (`claude.bin`, `grok.bin`) and the URLs planning calls go to (`grok.baseUrl`, `grok.shuntBaseUrl`, `substrate.url`);
- take your Grok login token: with the `http` transport, ultrathink sends that token as `Authorization: Bearer` to `grok.baseUrl`, so a project file that sets `think.engine: "grok"` and its own `grok.baseUrl` receives it;
- change the model, timeout and thresholds of Jev decisions you turned on yourself (for example, so that the plan gate skips more of your prompts), and turn them off or narrow their points.

A project file cannot opt you into Jev decisions: it can turn them off, narrow `decisions.points`, set `decisions.zdr` to `true` and set the model, timeout and thresholds, but it cannot turn them on, add points or turn zero data retention off. So it can never make ultrathink send your prompt, patch or knowledge-base text to OpenRouter unless you enabled Jev in your own config. It cannot redirect your OpenRouter key either: there is no config key for the Decisions endpoint, and any other key under `decisions` (a `url` or `endpoint`, for example) is ignored. The key is sent only to `https://openrouter.ai/api/alpha/decisions`, or to the `ULTRATHINK_DECISIONS_URL` environment variable you set yourself, which must be an `https://openrouter.ai/…` or loopback URL.

On Bun 1.3.3 and later, a repository's `.env*` files do not reach ultrathink at all: it starts Bun with `--no-env-file`. Bun 1.2.x ignores that flag and still loads them into ultrathink's environment, where they can set any variable in [Environment variables](../configuration.md#environment-variables); on Bun 1.2, read them too, or upgrade Bun.

Read `<repo>/.claude/ultrathink.json` in a repository you did not write, as you would read its code. `bin/ultrathink status` shows the engine, tracking and ship settings it produces. `ULTRATHINK_SHIP=0` turns ship off, and `ULTRATHINK_DECISIONS=0` turns Jev decisions off, whatever the files say.

For every key and default, see [Configuration](../configuration.md#key-reference). For what leaves your machine, see [Privacy](../privacy.md).
