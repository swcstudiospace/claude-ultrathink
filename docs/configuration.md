# Configuration

ultrathink reads JSON config files, a small per-host control file written by the `/ultrathink-*` commands and `bin/ultrathink`, and some environment variables. All of them are optional. With no config at all, ultrathink plans every non-trivial prompt with Claude and contacts nothing except the engine: it creates no Linear or Notion rows, requests no Agent Substrate brief, and never pushes, opens a pull request or merges.

Terms used on this page:

- **Host**: the coding agent ultrathink runs inside: Claude Code, Grok Build, Hermes Agent, Muse Code or Omp.
- **Engine**: the model that writes the plan: Claude (through the `claude` CLI) by default, or Grok.
- **Graph of Thought**: the 5 to 8 reasoning nodes the engine builds for each prompt. Each node is filled with numbered rationale steps.
- **HITL** (human in the loop): the clarifying questions the plan asks before work starts.
- **Tracker**: Notion and/or Linear, where the plan becomes rows and issues.
- **Ship**: the optional flow that opens a pull request, has Greptile review it and can merge it. See [Ship](ship.md).
- **State directory**: the per-host directory where ultrathink keeps its control file and session records. See [State directories](#state-directories).

Contents:

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
| 2 | `~/.claude/ultrathink.json` | Claude user config. Uses `$CLAUDE_CONFIG_DIR/ultrathink.json` when `CLAUDE_CONFIG_DIR` is set. Read on every host, not only Claude Code. |
| 3 | `<project>/.claude/ultrathink.json` | Project config, read from the working directory of the session. |

How the merge works (`src/config.ts`):

- Merging is per key inside each section. A project file that sets only `{"hitl": {"maxQuestions": 2}}` changes that one key and keeps everything else.
- A missing file, a file that is not valid JSON, or a file whose top level is not an object is skipped.
- Unknown sections and keys are ignored.
- A value with the wrong type or outside its allowed range is ignored, and the value from the earlier file (or the default) stays.
- Some string keys only accept a non-empty value, so an empty string in a later file does not clear a value an earlier file set: `notion.dataSourceUrl`, `linear.team`, `grok.baseUrl`, `grok.model`, `grok.bin`, `grok.shuntModel`, `claude.bin`, and the URL keys `grok.shuntBaseUrl` and `substrate.url`. To stop row creation, use `/ultrathink-track off` (see [Turning tracking off](tracking.md#turning-tracking-off)). To turn the Agent Substrate brief off, set `SUBSTRATE_DISABLED=1`.
- The URL keys `grok.shuntBaseUrl` and `substrate.url` must be `http://` or `https://` URLs. Trailing slashes are removed.

`bin/ultrathink status`, run from the project directory, prints the merged result for the parts most people change. See [Commands](commands.md#binultrathink) for its output.

## Key reference

Types: "integer" means a whole JSON number; "number" allows fractions. Ranges are inclusive.

### `uplift`: prompt uplift

| Key | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | boolean | `true` | Plan prompts. When `false`, only prompts that start with `uplift:` are planned. `/ultrathink-off` and `/ultrathink-on` override this per host. |
| `skipTrivial` | boolean | `true` | Skip trivial acknowledgements such as `ok` or `lgtm`. |
| `maxChars` | number, >= 0 | `20000` | Prompts longer than this are not sent to the engine; they get the conservative fallback spec, and no rows are created. |
| `echo` | boolean | `true` | Accepted but not read. The one-line summary after each plan is controlled by `claude.echo`. |

### `think`: Graph of Thought

| Key | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | boolean | `true` | Build the Graph of Thought. `bin/ultrathink think on\|off` overrides this per host. |
| `minNodes` | integer, >= 1 | `5` | Fewest graph nodes. Clamped to `maxNodes`. |
| `maxNodes` | integer, >= `minNodes` | `8` | Most graph nodes. Values above 8 are capped at 8. |
| `engine` | `"claude"` or `"grok"` | `"claude"` | Engine for the uplift, the graph, the per-node fills, the HITL questions and the ship judge. `bin/ultrathink grok engine grok\|claude` overrides this per host. |

Each node gets 4 to 8 numbered rationale steps. That range is fixed in code, not configurable. Each step becomes one sub-issue when tracking is on.

### `hitl`: clarifying questions

| Key | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | boolean | `true` | Generate clarifying questions. `bin/ultrathink hitl on\|off` overrides this per host. |
| `maxQuestions` | integer, 1 to 4 | `4` | Most questions per prompt. |

### `claude`: the Claude engine

The Claude engine runs the `claude` CLI headless. It uses your existing Claude Code login.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `bin` | string | `"claude"` | The `claude` binary. |
| `model` | string | `"sonnet"` | Model alias or name for the planning calls. `""` uses the CLI's default model. |
| `thinking` | boolean | `false` | Allow extended thinking in the planning calls. Slower. When `false`, the child calls run with `MAX_THINKING_TOKENS=0`. |
| `settingSources` | string | `""` | Passed as `--setting-sources` to the planning calls. `""` loads none, which is fastest and keeps other hooks out of the child calls. |
| `callTimeoutMs` | number, >= 0 | `0` | Timeout for one planning call. `0` means no timer. |
| `budgetMs` | number, >= 0 | `0` | Budget for the whole planning pass. `0` means run until the host's hook timeout. |
| `concurrency` | number, > 0 | `3` | Node fills that run in parallel within one dependency level. Rounded down, at least 1. |
| `echo` | boolean | `true` | Show a one-line summary to the user after each plan. |

### `grok`: the Grok engine

Used only when `think.engine` is `"grok"` (or `bin/ultrathink grok engine grok` was run on that host). See [Choose an engine](how-to/choose-engine.md).

| Key | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | boolean | `true` | When `false`, the Claude engine is used even if `think.engine` is `"grok"`. |
| `transport` | `"http"`, `"cli"` or `"shunt"` | `"http"` | `http`: POST `{baseUrl}/responses` with your `grok login` token. `cli`: run the `grok` binary. `shunt`: POST `{shuntBaseUrl}/v1/messages` on an Anthropic-compatible gateway that you run, with no auth. |
| `baseUrl` | string | `"https://cli-chat-proxy.grok.com/v1"` | Base URL for the `http` transport. Trailing slashes are removed. |
| `model` | string | `"grok-4.7"` | Model for `http` and `cli`, and for `shunt` when `shuntModel` is empty. |
| `reasoningEffort` | `"low"`, `"medium"`, `"high"` or `"xhigh"` | `"xhigh"` | Reasoning effort for `http` and `cli`. |
| `bin` | string | `"grok"` | The `grok` binary. |
| `home` | string | `""` | Grok home directory, used to find the `grok login` session. `""` means `$GROK_HOME`, else `~/.grok`. |
| `callTimeoutMs` | number, >= 0 | `0` | Timeout for one call. `0` means no timer; the host's hook timeout is the limit. |
| `fallbackToClaude` | boolean | `false` | When the Grok login is missing or expired (`http` and `cli` transports), plan with Claude instead. When `false`, the prompt is not planned and the hook reports ``Prompt Uplift skipped · Grok 4.7 login required (run `grok login`)``. |
| `shuntBaseUrl` | http(s) URL | `""` | Base URL of your gateway for `shunt`; `/v1/messages` is appended. There is no built-in gateway: with `transport: "shunt"` and this key empty, every engine call fails with an error that names `grok.shuntBaseUrl`. The prompt then gets the conservative fallback spec and no rows are created. Claude is not used instead: `fallbackToClaude` only applies to a missing Grok login. |
| `shuntModel` | string | `""` | Model name sent to the gateway. `""` sends `model`. |
| `shuntMaxTokens` | integer, > 0 | `8192` | `max_tokens` for `shunt` calls. |

The `http` and `cli` transports need `grok login`. `shunt` does not; the gateway owns the upstream credentials.

### `notion`: Notion tracking

| Key | Type | Default | Meaning |
|---|---|---|---|
| `dataSourceUrl` | string | `""` | The `collection://<data source id>` data source of the tracking database. `""` means Notion tracking is not configured and Notion is never contacted. See [Set up Notion](how-to/set-up-notion.md). |

### `linear`: Linear tracking

| Key | Type | Default | Meaning |
|---|---|---|---|
| `team` | string | `""` | The Linear team that issues and sub-issues are created in. `""` means Linear tracking is not configured and Linear is never contacted. See [Set up Linear](how-to/set-up-linear.md). |

### `track`: row creation by the planner

| Key | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | boolean | `true` | The planner creates the Linear and Notion rows before the agent sees the prompt. When `false`, the planner creates none and the `ultrathink-kickoff` skill creates them instead. On Hermes the planner never creates rows, whatever this says; kickoff creates them all. `/ultrathink-track off\|on` overrides this per host. Has no effect when neither tracker is configured. |
| `budgetMs` | number, > 0 | `60000` | Time limit for the planner's whole row-creation run, including credential lookup. Rows not created in time are left for kickoff. |
| `concurrency` | number, >= 1 | `6` | Row-creation calls that run in parallel. Rounded down. |

### `ship`: PR, review and merge

Ship is opt-in. With the defaults, no skill run ever pushes a branch, opens a pull request or merges. See [Ship](ship.md) for the flow and [Ship with Greptile](how-to/ship-with-greptile.md) for setup.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `enabled` | boolean | `false` | Tell the agent to run `ultrathink-ship` after a matching skill run: the plan gets a Ship section and the end-of-run nudge fires. `bin/ultrathink-ship` still works when you run it by hand with this off. |
| `autoMerge` | boolean | `false` | Allow `bin/ultrathink-ship merge`. When `false`, `merge` refuses (`autoMerge disabled`) and `run` stops once the PR is ready, with `next: "autoMerge disabled: merge manually"`. When `true`, the done assessment also requires an engine judge. |
| `skills` | array of non-empty strings | `["gsd-"]` | Skill name prefixes that trigger ship. `[]` matches every skill run, and every planned prompt gets the ship instruction. |
| `minScore` | number, 1 to 5 | `5` | Lowest Greptile confidence score that may merge. |
| `requireNoComments` | boolean | `true` | Refuse to merge while the head review has open comments. |
| `maxRounds` | number, >= 1 | `5` | Review rounds before the ship is blocked. Rounded down. |
| `mergeMethod` | `"squash"`, `"merge"` or `"rebase"` | `"squash"` | Merge method. When the repository does not allow it, the first allowed method is used and the output says so. |
| `deleteBranch` | boolean | `false` | After the merge, delete the remote branch, check out and fast-forward the base branch, then delete the local branch. When `false`, branches are left alone. |
| `greptileOrganization` | string | `""` | Greptile organization id or handle, passed as `organization` on every Greptile MCP call. `""` lets Greptile pick, which works for accounts in one organization. An account in several organizations needs it: without it, the review is `blocked` with a reason that names this key and the candidates. |
| `reviewTimeoutMs` | number, >= 1 | `1200000` | How long a review of one head commit may stay pending before it counts as a timed-out round (20 minutes). Rounded down. |
| `pollMs` | number, >= 1 | `20000` | First interval between review status checks. It grows by 1.5 times per check, up to 60 seconds. Rounded down. |
| `waitMs` | number, >= 1 | `100000` | Longest one `review` call blocks before it returns `pending` (100 seconds). Rounded down. |

`ULTRATHINK_SHIP=0` turns the ship instruction and nudge off for one process whatever `ship.enabled` says.

### `substrate`: Agent Substrate brief

Agent Substrate is an optional service that tells the planner what other agents already did in the repository. ultrathink asks it for a brief before it builds the Graph of Thought, and adds the answer to the plan under `## Agent Substrate brief`. Nothing is requested unless a URL is set.

| Key | Type | Default | Meaning |
|---|---|---|---|
| `url` | http(s) URL | `""` | Base URL of your Agent Substrate server. ultrathink sends `POST <url>/brief` with the repository (`owner/repo`), the branch and the host name. `""` means the service is never contacted. `SUBSTRATE_URL` wins over this key, and `SUBSTRATE_DISABLED=1` turns both off. |

The request times out after 1.5 seconds (`SUBSTRATE_TIMEOUT_MS` changes that). A missing, slow or failing server never blocks a prompt: the plan is built without the brief. `bin/ultrathink status` shows the `Substrate:` line with the URL in use and where it came from.

## Full example

All keys are optional; write only the ones you change. This file shows every key. The values are the defaults, with these exceptions:

- `notion.dataSourceUrl` and `linear.team` hold placeholders. Replace them with your own values, or leave them `""` to keep tracking unconfigured.
- `grok.shuntBaseUrl`, `grok.shuntModel` and `substrate.url` are `""`, which is the default and means off. Set them only if you run those services.
- `ship.enabled`, `ship.autoMerge` and `ship.deleteBranch` are `false`, the opt-in defaults.

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
    "shuntBaseUrl": "",
    "shuntModel": "",
    "shuntMaxTokens": 8192
  },
  "notion": { "dataSourceUrl": "collection://<data source id>" },
  "linear": { "team": "<your Linear team>" },
  "track": { "enabled": true, "budgetMs": 60000, "concurrency": 6 },
  "ship": {
    "enabled": false,
    "autoMerge": false,
    "skills": ["gsd-"],
    "minScore": 5,
    "requireNoComments": true,
    "maxRounds": 5,
    "mergeMethod": "squash",
    "deleteBranch": false,
    "greptileOrganization": "",
    "reviewTimeoutMs": 1200000,
    "pollMs": 20000,
    "waitMs": 100000
  },
  "substrate": { "url": "" }
}
```

Optional integrations, one small file each:

Plan with Grok through an Anthropic-compatible gateway you run:

```json
{
  "think": { "engine": "grok" },
  "grok": { "transport": "shunt", "shuntBaseUrl": "https://<your gateway host>", "shuntModel": "<model name your gateway expects>" }
}
```

Turn ship on, with merging and branch cleanup (all three are off by default):

```json
{ "ship": { "enabled": true, "autoMerge": true, "deleteBranch": true, "greptileOrganization": "<your Greptile organization>" } }
```

Ask an Agent Substrate server for a brief before each plan:

```json
{ "substrate": { "url": "https://<your substrate host>" } }
```

## Environment variables

Every variable ultrathink reads, grouped by who sets it. Variables that expect `1` or `0` compare the exact string: `ULTRATHINK_SHIP=false` does nothing.

### Variables you may set

| Variable | Effect |
|---|---|
| `ULTRATHINK_UPLIFT=0` | Do not plan any prompt in this process. The `uplift:` prefix does not override it. Useful for automation and `claude -p` runs. |
| `ULTRATHINK_TRACK=0` | The planner creates no rows in this process. The `ultrathink-kickoff` skill still creates them through `track complete`. To stop all rows, use `/ultrathink-track off`. |
| `ULTRATHINK_SHIP=0` | No ship instruction in the plan and no ship nudge at the end of a run, even with `ship.enabled: true`. `bin/ultrathink-ship` still works when you run it yourself. |
| `ULTRATHINK_HOST` | Which host's state directory to use: `claude-code`, `grok-build`, `hermes`, `muse` or `omp`. Any other value is ignored. Without it the host is detected from its environment, and Claude Code is the fallback. Set it for `bin/ultrathink` to change another host's control state, for example `ULTRATHINK_HOST=omp bin/ultrathink off`. The Grok hook file, the Muse hook wrappers, the Hermes plugin and the Omp extension set it for their own processes. |
| `ULTRATHINK_STATE_DIR` | Use this directory instead of the host's state directory. Give an absolute path: a relative one is resolved against the session's working directory on Claude Code, Grok Build, Muse and Omp, but against the ultrathink checkout on Hermes. It is ignored when the path is inside a `.planning` directory. The Hermes plugin sets it for its own control commands. |
| `ULTRATHINK_MCP_STORE` | Path of the credential store. Default `~/.config/ultrathink/mcp-credentials.json` (under `$XDG_CONFIG_HOME` when set). |
| `ULTRATHINK_OAUTH_REDIRECT` | OAuth callback URL for `bin/ultrathink-mcp auth login`. Must be https, or http on `127.0.0.1`, `localhost` or `[::1]`. The `--redirect` flag wins over it. |
| `ULTRATHINK_OAUTH_TAILSCALE=1` | Same as `auth login --tailscale`: on a remote (SSH) session, receive the OAuth callback through `tailscale serve`. Without it, ultrathink never runs `tailscale`. Only the exact value `1` opts in. See [Commands](commands.md#binultrathink-mcp). |
| `ULTRATHINK_DEBUG=1` | The prompt hook (`hooks/uplift.ts`, used by Claude Code, Grok Build and Muse) writes `[ultrathink]` log lines to stderr. |
| `ULTRATHINK_MCP_DEBUG=1` | `bin/ultrathink-mcp serve` writes relay log lines to stderr. |
| `ULTRATHINK_HERMES_TIMEOUT` | Hermes only. Longest time in seconds the Hermes plugin lets one plan run. A positive integer; anything else means the default, `540`. The plugin stops the plan at min(this, cap − 15) seconds, where the cap is Hermes' `plugins.hook_callback_timeout`, and does not start planning when that leaves less than 90 seconds. See the note below the table. |
| `SUBSTRATE_URL` | Agent Substrate base URL. Wins over `substrate.url`. |
| `SUBSTRATE_TOKEN` | Sent as `Authorization: Bearer <token>` on Agent Substrate requests. |
| `SUBSTRATE_TIMEOUT_MS` | Timeout for one Agent Substrate request, in milliseconds. A positive number; default `1500`. |
| `SUBSTRATE_DISABLED=1` | Never contact Agent Substrate, even when `SUBSTRATE_URL` or `substrate.url` is set. |
| `GSD_TOOLS` | Path of `gsd-tools.cjs`, which the ship assessment runs to read a GSD roadmap. See [GSD tools lookup](#gsd-tools-lookup). |
| `BUN` | Path of the `bun` binary. See [Finding Bun](#finding-bun). |

About the Hermes hook cap: Hermes abandons a plugin hook that runs longer than its `plugins.hook_callback_timeout` (30 seconds unless you change it). A plan needs at least 90 seconds, so the cap must be at least 105 seconds; 600 is recommended. It is a global Hermes setting that affects every plugin, and nothing in ultrathink changes it. Set it yourself:

```sh
hermes config set plugins.hook_callback_timeout 600
```

The plugin asks Hermes for the cap it enforces. When that Hermes does not report it, the plugin reads `plugins.hook_callback_timeout` from `$HERMES_HOME/config.yaml` (`~/.hermes/config.yaml` when `HERMES_HOME` is unset), else assumes 30 seconds, and logs one warning naming the command above.

#### GSD tools lookup

GSD (Get Shit Done) is a planning workflow that keeps a roadmap in `.planning/ROADMAP.md`. When a repository has one, `bin/ultrathink-ship assess` runs `gsd-tools.cjs` with `node` to read it, so Node.js must be on `PATH`. It looks for `gsd-tools.cjs` in this order, and the first match wins:

1. `$GSD_TOOLS`, when set.
2. `<repo>/gsd-core/bin/gsd-tools.cjs`, then the same under `<repo>/.claude` and `<repo>/.codex`.
3. `$CLAUDE_CONFIG_DIR/gsd-core/bin/gsd-tools.cjs`, when `CLAUDE_CONFIG_DIR` is set.
4. `gsd-core/bin/gsd-tools.cjs` under `~/.claude`, `~/.agents`, `$HERMES_HOME` (else `~/.hermes`), `$CODEX_HOME` (else `~/.codex`), `$GEMINI_CONFIG_DIR` (else `~/.gemini`), `~/.cursor` and `$XDG_CONFIG_HOME/opencode` (else `~/.config/opencode`), in that order.
5. `~/.claude/get-shit-done/bin/gsd-tools.cjs`.

When a roadmap exists and none of these is found, the assessment reports the gap `GSD roadmap found but gsd-tools.cjs was not found; set GSD_TOOLS or rerun assess with --ignore-gsd`. When the tools are found but `node` is not on `PATH`, it reports `GSD roadmap found but node is not on PATH, so gsd-tools.cjs could not run; install Node.js or rerun assess with --ignore-gsd`.

#### Finding Bun

The launcher `bin/run-bun` looks for `bun` in this order: `$BUN`, `PATH`, `$BUN_INSTALL/bin/bun`, `~/.bun/bin/bun`, `/usr/local/bin/bun`, `/opt/homebrew/bin/bun`, then `~/.local/share/*/bun/bin/bun`. It adds the directory it found to `PATH` for everything Bun starts. When there is no Bun, it prints `ultrathink: bun not found. Install Bun 1.2 or later (https://bun.sh) or set BUN=/path/to/bun`; the hooks then exit 0 so the prompt still goes through, and the three CLIs exit 127. The Hermes plugin runs `$BUN` directly when it is set, else `bin/run-bun`.

### Internal variables

ultrathink sets these itself. Do not set them.

| Variable | Purpose |
|---|---|
| `ULTRATHINK_CHILD` | Set to `1` on the headless `claude` calls the engine makes, so the hooks do not plan or track them. A process that has it set to `1` is never planned. |
| `ULTRATHINK_PROGRESS_FD` | File descriptor (3 or higher) the Omp extension reads planning progress from. |
| `ULTRATHINK_BUN_REQUIRED` | Set to `1` by `bin/ultrathink`, `bin/ultrathink-mcp` and `bin/ultrathink-ship` so `bin/run-bun` exits 127 when Bun is missing. `bin/run-bun` removes it before starting Bun. |
| `MAX_THINKING_TOKENS` | Set to `0` on the headless `claude` calls when `claude.thinking` is `false`. |
| `GROK_SUBAGENTS`, `GROK_MEMORY`, `GROK_WEB_FETCH` | Set to `0` on the `grok` process the `cli` transport starts. `GROK_HOME` is set there too when `grok.home` is not empty. |

### Variables ultrathink reads from your system or host

| Variable | Used for |
|---|---|
| `HOME` | Default locations of the config files, the credential store and the host directories. |
| `XDG_CONFIG_HOME` | User config, credential store, the Muse state directory and Muse's `settings.json` for `mcp-register`. |
| `CLAUDE_CONFIG_DIR` | Claude user config, the Claude Code state directory, the `CLAUDE.md` that `scripts/setup.ts` edits, and the Claude config file `mcp-register` backs up. |
| `GROK_HOME` | Grok home: the `grok login` lookup when `grok.home` is empty, the Grok Build state directory when `GROK_PLUGIN_DATA` is unset, and where `scripts/setup.ts` installs the Grok rule and hook file. |
| `GROK_PLUGIN_DATA` | Grok Build state directory. |
| `HERMES_HOME` | Hermes state directory, Hermes' `config.yaml`, and the plugin path `scripts/setup.ts` prints. |
| `PI_CODING_AGENT_DIR` | Omp state directory and Omp's `mcp.json` for `mcp-register`. |
| `GROK_PLUGIN_ROOT`, `GROK_HOOK_EVENT`, `GROK_SESSION_ID` | Any of them set means the process runs under Grok Build. |
| `MUSE_TOOL_USE_ID`, `MUSE_PLUGIN_ID` | Either set means the process runs under Muse Code, so `bin/ultrathink` run from Muse's shell tool changes the Muse state. |
| `CLAUDE_PLUGIN_ROOT` | Set by the host for plugin hooks and commands. `hooks/hooks.json` and the command files in `commands/` use it to find the checkout. |
| `TERMINAL_CWD` | Hermes only: the working directory for planning when Hermes passes none. |
| `HERMES_SESSION_USER_NAME`, `HERMES_SESSION_KEY` | Hermes gateway session values (read through Hermes' session context, not the process environment): the sender name whose `[Name] ` tag is stripped from shared-session messages, and the chat that `/ultrathink-quick` sends its message to. |
| `SSH_CONNECTION`, `SSH_CLIENT`, `SSH_TTY` | Any of them set marks a remote session, so `auth login` prints port-forwarding hints (and uses the Tailscale route when you opted in). |
| `USER`, `LOGNAME` | The user name in the printed `ssh -L` command. |
| `PATH`, `BUN_INSTALL` | Finding `bun`, and finding the `claude`, `grok` and `hermes` CLIs for `mcp-register`. |
| `CODEX_HOME`, `GEMINI_CONFIG_DIR` | Two of the [GSD tools](#gsd-tools-lookup) locations. |

## State directories

Each host keeps its own state. Planning never writes `.planning/` into the working directory.

| Host | State directory |
|---|---|
| Claude Code | `~/.claude/ultrathink` (`$CLAUDE_CONFIG_DIR/ultrathink` when set) |
| Grok Build | `$GROK_PLUGIN_DATA/ultrathink` when set, else `~/.grok/plugin-data/ultrathink` (`$GROK_HOME/plugin-data/ultrathink` when `GROK_HOME` is set) |
| Hermes Agent | `~/.hermes/ultrathink` (`$HERMES_HOME/ultrathink` when set) |
| Muse Code | `~/.config/muse/ultrathink` (`$XDG_CONFIG_HOME/muse/ultrathink` when set) |
| Omp | `~/.omp/agent/ultrathink` (`$PI_CODING_AGENT_DIR/ultrathink` when set) |

Empty or whitespace-only values count as unset. `ULTRATHINK_STATE_DIR` replaces the directory for every host, as long as it is not inside `.planning`. Use an absolute path for it: a relative path resolves against the session's working directory on most hosts, but against the ultrathink checkout on Hermes.

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

`ULTRATHINK_TRACK=0` beats both the control state and the config, for the planner's own row creation. `ULTRATHINK_UPLIFT=0` and `ULTRATHINK_SHIP=0` likewise beat both for planning and ship.

`bin/ultrathink` picks the state directory from `ULTRATHINK_HOST`, else from the detected host: Grok Build when `GROK_PLUGIN_ROOT`, `GROK_HOOK_EVENT` or `GROK_SESSION_ID` is set, Muse when `MUSE_TOOL_USE_ID` or `MUSE_PLUGIN_ID` is set, and Claude Code otherwise. Run from a plain shell, it changes the Claude Code state. See [Commands](commands.md) for every command and how each host shows the reply.
