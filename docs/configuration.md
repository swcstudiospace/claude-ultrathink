# Configuration

ultrathink reads JSON config files, a small per-host control file written by the `/ultrathink-*` commands and `bin/ultrathink`, and a few environment variables. Everything is optional. With no config at all, ultrathink plans every non-trivial prompt with Claude and creates no Linear or Notion rows.

- [Config files](#config-files)
- [Key reference](#key-reference)
- [Full example](#full-example)
- [Environment variables](#environment-variables)
- [State directories](#state-directories)
- [Control state versus config](#control-state-versus-config)

## Config files

Every host reads the same three files. They are merged in this order, and a later file wins:

| Order | File | Notes |
|---|---|---|
| 1 | `~/.config/ultrathink/config.json` | Host-neutral user config. Uses `$XDG_CONFIG_HOME/ultrathink/config.json` when `XDG_CONFIG_HOME` is set. `bin/ultrathink-mcp notion init --write-config` writes here. |
| 2 | `~/.claude/ultrathink.json` | Claude user config. Uses `$CLAUDE_CONFIG_DIR/ultrathink.json` when `CLAUDE_CONFIG_DIR` is set. |
| 3 | `<project>/.claude/ultrathink.json` | Project config, read from the working directory of the session. |

How the merge works (`src/config.ts`):

- Merging is per key inside each section. A project file that sets only `{"hitl": {"maxQuestions": 2}}` changes that one key and keeps everything else.
- A missing file, a file that is not valid JSON, or a file whose top level is not an object is skipped.
- Unknown sections and keys are ignored.
- A value with the wrong type or outside its allowed range is ignored, and the value from the earlier file (or the default) stays.
- `notion.dataSourceUrl` and `linear.team` only accept non-empty strings. An empty string in a later file does not clear a value set in an earlier file. To stop row creation, use `/ultrathink-track off` (see [Tracking](tracking.md#turning-tracking-off)).

`bin/ultrathink status`, run from the project directory, prints the merged result for the parts most people change: planning, engine, Graph of Thought, HITL, tracking, the Notion data source, the Linear team, the Claude model and the state directory.

## Key reference

### `uplift`: prompt uplift

| Key | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | boolean | `true` | Plan prompts. When `false`, only prompts that start with `uplift:` are planned. `/ultrathink-off` and `/ultrathink-on` override this per host. |
| `skipTrivial` | boolean | `true` | Skip trivial acknowledgements such as `ok` or `lgtm`. |
| `maxChars` | number, >= 0 | `20000` | Prompts longer than this are not sent to the engine; they get the conservative fallback spec, and no rows are created. |
| `echo` | boolean | `true` | Accepted but not read in 0.3.0. The one-line summary after each plan is controlled by `claude.echo`. |

### `think`: Graph of Thought

| Key | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | boolean | `true` | Build the Graph of Thought. `bin/ultrathink think on|off` overrides this per host. |
| `minNodes` | integer, >= 1 | `5` | Fewest graph nodes. Clamped to `maxNodes`. |
| `maxNodes` | integer, >= `minNodes` | `8` | Most graph nodes. Values above 8 are capped at 8. |
| `engine` | `"claude"` or `"grok"` | `"claude"` | Engine for the uplift, the graph, the per-node fills, the HITL questions and the ship judge. `bin/ultrathink grok engine grok|claude` overrides this per host. |

Each node gets 4 to 8 numbered rationale steps. That range is fixed in code, not configurable. Each step becomes one sub-issue when tracking is on.

### `hitl`: clarifying questions

| Key | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | boolean | `true` | Generate clarifying questions. `bin/ultrathink hitl on|off` overrides this per host. |
| `maxQuestions` | integer, 1 to 4 | `4` | Most questions per prompt. |

### `claude`: the Claude engine

The Claude engine runs the `claude` CLI headless. It uses your existing Claude Code login.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `bin` | string | `"claude"` | The `claude` binary. |
| `model` | string | `"sonnet"` | Model alias or name for the planning calls. `""` uses the CLI's default model. |
| `thinking` | boolean | `false` | Allow extended thinking in the planning calls. Slower. |
| `settingSources` | string | `""` | Passed as `--setting-sources` to the planning calls. `""` loads none, which is fastest and keeps other hooks out of the child calls. |
| `callTimeoutMs` | number, >= 0 | `0` | Timeout for one planning call. `0` means no timer. |
| `budgetMs` | number, >= 0 | `0` | Budget for the whole planning pass. `0` means run until the host's hook timeout. |
| `concurrency` | integer, >= 1 | `3` | Node fills that run in parallel within one dependency level. |
| `echo` | boolean | `true` | Show a one-line summary to the user after each plan. |

### `grok`: the Grok engine

Used only when `think.engine` is `"grok"` (or `bin/ultrathink grok engine grok` was run on that host).

| Key | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | boolean | `true` | When `false`, the Claude engine is used even if `think.engine` is `"grok"`. |
| `transport` | `"http"`, `"cli"` or `"shunt"` | `"http"` | `http`: POST `{baseUrl}/responses` with your `grok login` token. `cli`: run the `grok` binary. `shunt`: POST `{shuntBaseUrl}/v1/messages` on a local Anthropic-compatible gateway, with no auth. |
| `baseUrl` | string | `"https://cli-chat-proxy.grok.com/v1"` | Base URL for the `http` transport. Trailing slashes are removed. |
| `model` | string | `"grok-4.7"` | Model for `http` and `cli`. |
| `reasoningEffort` | `"low"`, `"medium"`, `"high"` or `"xhigh"` | `"xhigh"` | Reasoning effort for `http` and `cli`. |
| `bin` | string | `"grok"` | The `grok` binary. |
| `home` | string | `""` | Grok home directory. `""` means `$GROK_HOME`, else `~/.grok`. |
| `callTimeoutMs` | number, >= 0 | `0` | Timeout for one call. `0` means no timer; the host's hook timeout is the limit. |
| `fallbackToClaude` | boolean | `false` | When the Grok login is missing or expired (`http` and `cli` transports), plan with Claude instead. When `false`, the prompt is not planned; the Claude Code, Grok Build and Muse hook shows `Prompt Uplift skipped · Grok 4.7 login required (run grok login)` unless the prompt is a skill invocation. |
| `shuntBaseUrl` | http(s) URL | `"http://127.0.0.1:3001"` | Gateway base URL for `shunt`. `/v1/messages` is appended. |
| `shuntModel` | string | `"grok-4.7-xhigh"` | Model name sent to the gateway. Used instead of `model` for `shunt`. |
| `shuntMaxTokens` | integer, > 0 | `8192` | `max_tokens` for `shunt` calls. |

The `http` and `cli` transports need `grok login`. `shunt` does not.

### `notion`: Notion tracking

| Key | Type | Default | Meaning |
|---|---|---|---|
| `dataSourceUrl` | string | `""` | The `collection://<id>` data source of the tracking database. `""` means Notion tracking is not configured and Notion is never contacted. See [Setting up Notion](tracking.md#setting-up-notion). |

### `linear`: Linear tracking

| Key | Type | Default | Meaning |
|---|---|---|---|
| `team` | string | `""` | The Linear team that issues and sub-issues are created in. `""` means Linear tracking is not configured and Linear is never contacted. See [Setting up Linear](tracking.md#setting-up-linear). |

### `track`: row creation by the planner

| Key | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | boolean | `true` | The planner creates the Linear and Notion rows before the agent sees the prompt. When `false`, the planner creates none and the `ultrathink-kickoff` skill creates them instead. `/ultrathink-track off|on` overrides this per host. |
| `budgetMs` | number, > 0 | `60000` | Time limit for the planner's whole row-creation run, including credential lookup. Rows not created in time are left for kickoff. |
| `concurrency` | integer, >= 1 | `6` | Row-creation calls that run in parallel. |

### `ship`: PR, review and merge

See [Ship](ship.md) for the flow these keys control.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | boolean | `true` | Tell the agent to run `ultrathink-ship` after a matching skill run. |
| `autoMerge` | boolean | `true` | Allow `bin/ultrathink-ship merge`. When `false`, `merge` refuses and `run` stops once the PR is ready. When `true`, the done assessment also requires an engine judge. |
| `skills` | array of non-empty strings | `["gsd-"]` | Skill name prefixes that trigger ship. `[]` matches every skill run, and every planned prompt gets the ship instruction. |
| `minScore` | number, 1 to 5 | `5` | Lowest Greptile confidence score that may merge. |
| `requireNoComments` | boolean | `true` | Refuse to merge while the head review has open comments. |
| `maxRounds` | integer, >= 1 | `5` | Review rounds before the ship is blocked. |
| `mergeMethod` | `"squash"`, `"merge"` or `"rebase"` | `"squash"` | Merge method. When the repository does not allow it, the first allowed method is used and the output says so. |
| `deleteBranch` | boolean | `true` | After the merge, delete the remote branch, check out and fast-forward the base branch, then delete the local branch. |
| `reviewTimeoutMs` | integer, >= 1 | `1200000` | How long a review of one head commit may stay pending before it counts as a timed-out round (20 minutes). |
| `pollMs` | integer, >= 1 | `20000` | First interval between review status checks. It grows by 1.5 times per check, up to 60 seconds. |
| `waitMs` | integer, >= 1 | `100000` | Longest one `review` call blocks before it returns `pending` (100 seconds). |

## Full example

This file sets every key. The values are the defaults, except `notion.dataSourceUrl` and `linear.team`, which have no default. Replace the two placeholders with your own values, or leave them `""` to keep tracking unconfigured. You only need to write the keys you change.

```json
{
  "uplift": { "enabled": true, "skipTrivial": true, "maxChars": 20000, "echo": true },
  "think": { "enabled": true, "minNodes": 5, "maxNodes": 8, "engine": "claude" },
  "hitl": { "enabled": true, "maxQuestions": 4 },
  "claude": {
    "bin": "claude",
    "model": "sonnet",
    "thinking": false,
    "settingSources": "",
    "callTimeoutMs": 0,
    "budgetMs": 0,
    "concurrency": 3,
    "echo": true
  },
  "grok": {
    "enabled": true,
    "transport": "http",
    "baseUrl": "https://cli-chat-proxy.grok.com/v1",
    "model": "grok-4.7",
    "reasoningEffort": "xhigh",
    "bin": "grok",
    "home": "",
    "callTimeoutMs": 0,
    "fallbackToClaude": false,
    "shuntBaseUrl": "http://127.0.0.1:3001",
    "shuntModel": "grok-4.7-xhigh",
    "shuntMaxTokens": 8192
  },
  "notion": { "dataSourceUrl": "collection://<data-source-id>" },
  "linear": { "team": "<your Linear team name>" },
  "track": { "enabled": true, "budgetMs": 60000, "concurrency": 6 },
  "ship": {
    "enabled": true,
    "autoMerge": true,
    "skills": ["gsd-"],
    "minScore": 5,
    "requireNoComments": true,
    "maxRounds": 5,
    "mergeMethod": "squash",
    "deleteBranch": true,
    "reviewTimeoutMs": 1200000,
    "pollMs": 20000,
    "waitMs": 100000
  }
}
```

To plan with Grok through a local gateway:

```json
{ "think": { "engine": "grok" }, "grok": { "transport": "shunt" } }
```

## Environment variables

### Variables you may set

| Variable | Effect |
|---|---|
| `ULTRATHINK_UPLIFT=0` | Do not plan any prompt in this process. The `uplift:` prefix does not override it. Useful for automation and `claude -p` runs. |
| `ULTRATHINK_TRACK=0` | The planner creates no rows in this process. The `ultrathink-kickoff` skill still creates them through `track complete`. To stop all rows, use `/ultrathink-track off`. |
| `ULTRATHINK_SHIP=0` | No ship instruction in the plan and no ship nudge at the end of a run. `bin/ultrathink-ship` still works when you run it yourself. |
| `ULTRATHINK_HOST` | Which host's state directory to use: `claude-code`, `grok-build`, `hermes`, `muse` or `omp`. Any other value is ignored. Without it the host is detected from its environment, and Claude Code is the fallback. Set it for `bin/ultrathink` to change another host's control state, for example `ULTRATHINK_HOST=omp bin/ultrathink off`. The Grok hook file, the Muse hook wrappers, the Hermes plugin and the Omp extension set it for their own processes. |
| `ULTRATHINK_STATE_DIR` | Use this directory instead of the host's state directory. It is ignored when the path is inside a `.planning` directory. |
| `ULTRATHINK_MCP_STORE` | Path of the credential store. Default `~/.config/ultrathink/mcp-credentials.json` (under `$XDG_CONFIG_HOME` when set). |
| `ULTRATHINK_OAUTH_REDIRECT` | OAuth callback URL for `bin/ultrathink-mcp auth login`. Must be https, or http on `127.0.0.1`, `localhost` or `[::1]`. The `--redirect` flag wins over it. See [remote logins](tracking.md#logging-in-from-a-remote-machine). |
| `ULTRATHINK_DEBUG=1` | The prompt hook (`hooks/uplift.ts`, used by Claude Code, Grok Build and Muse) writes `[ultrathink]` log lines to stderr. |
| `ULTRATHINK_MCP_DEBUG=1` | `bin/ultrathink-mcp serve` writes relay log lines to stderr. |
| `ULTRATHINK_HERMES_TIMEOUT` | Seconds the Hermes plugin waits for a plan. Default `540`, below Hermes' 600 second limit. Must be a positive integer. |

### Internal variables

These are set by ultrathink itself. Do not set them.

| Variable | Purpose |
|---|---|
| `ULTRATHINK_CHILD` | Set to `1` on the headless `claude` calls the engine makes, so the prompt hook does not plan them. A process that has it set to `1` is never planned. |
| `ULTRATHINK_PROGRESS_FD` | File descriptor (3 or higher) the Omp extension reads planning progress from. |

### Other variables ultrathink reads

| Variable | Used for |
|---|---|
| `XDG_CONFIG_HOME` | User config, credential store and the Muse state directory. |
| `CLAUDE_CONFIG_DIR` | Claude user config and the Claude Code state directory. |
| `GROK_PLUGIN_DATA` | Grok Build state directory. |
| `GROK_HOME` | Grok login lookup when `grok.home` is empty. |
| `HERMES_HOME` | Hermes state directory. |
| `PI_CODING_AGENT_DIR` | Omp state directory. |
| `BUN` | Path of the `bun` binary for `bin/run-bun`. Without it, `bin/run-bun` looks on `PATH`, then in `$BUN_INSTALL/bin`, `~/.bun/bin`, `/usr/local/bin` and `/opt/homebrew/bin`. |
| `GSD_TOOLS` | Path of `gsd-tools.cjs` for the ship assessment. Default `~/.agents/gsd-core/bin/gsd-tools.cjs`. |

## State directories

Each host keeps its own state. Planning never writes `.planning/` into the working directory.

| Host | State directory |
|---|---|
| Claude Code | `~/.claude/ultrathink` (`$CLAUDE_CONFIG_DIR/ultrathink` when set) |
| Grok Build | `~/.grok/plugin-data/ultrathink` (`$GROK_PLUGIN_DATA/ultrathink` when set) |
| Hermes Agent | `$HERMES_HOME/ultrathink` (`~/.hermes/ultrathink` when `HERMES_HOME` is unset) |
| Muse Code | `~/.config/muse/ultrathink` (`$XDG_CONFIG_HOME/muse/ultrathink` when set) |
| Omp | `~/.omp/agent/ultrathink` (`$PI_CODING_AGENT_DIR/ultrathink` when set) |

`ULTRATHINK_STATE_DIR` replaces the directory for every host, as long as it is not inside `.planning`.

What a state directory holds:

| Path | Contents |
|---|---|
| `control.json` | The per-host control state, described in the next section. |
| `sessions/<session-id>.json` | The session record: the spec, the graph, the clarifications, the tracking plan, the created row links and the ship progress. The kickoff, sync and ship skills take this file as `stateFile`. |
| `sessions/<session-id>.xml` | The full uplifted spec. |
| `last.json` | A copy of the latest session record. `bin/ultrathink last` reads it. |
| `last-plan.json` | The plan carrier for hosts that do not read hook output directly, such as Grok Build. |

## Control state versus config

There are two layers:

- **Config files** are shared by every host and are edited by hand (or by `notion init --write-config`).
- **Control state** is `control.json` in one host's state directory. The `/ultrathink-*` commands in an agent and `bin/ultrathink` on the command line write it. It only affects that host.

A value in the control state beats the config value until you change it again:

| Command | Control field | Overrides |
|---|---|---|
| `/ultrathink-off`, `/ultrathink-on`, `bin/ultrathink off`, `bin/ultrathink on` | `enabled` | `uplift.enabled` |
| `/ultrathink-skip`, `bin/ultrathink skip` | `skipOnce` | Skips the next prompt once, then clears itself. |
| `/ultrathink-track off`, `/ultrathink-track on`, `bin/ultrathink track off`, `bin/ultrathink track on` | `trackEnabled` | `track.enabled`. `off` also stops the kickoff skill and `track complete` from creating rows. |
| `bin/ultrathink think on`, `bin/ultrathink think off` | `thinkEnabled` | `think.enabled` |
| `bin/ultrathink hitl on`, `bin/ultrathink hitl off` | `hitlEnabled` | `hitl.enabled` |
| `bin/ultrathink grok engine grok`, `bin/ultrathink grok engine claude` | `engine` | `think.engine` |

`ULTRATHINK_TRACK=0` beats both the control state and the config, for the planner's own row creation.

`bin/ultrathink` picks the state directory from `ULTRATHINK_HOST`, else from the detected host: Grok Build when a `GROK_PLUGIN_ROOT`, `GROK_HOOK_EVENT` or `GROK_SESSION_ID` variable is set, Muse when `MUSE_TOOL_USE_ID` or `MUSE_PLUGIN_ID` is set (so it works from Muse's shell tool), and Claude Code otherwise. Run from a plain shell, it changes the Claude Code state. See [Commands](commands.md) for every command and how each host shows the reply.
