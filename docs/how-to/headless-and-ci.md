# Run agents headless and in CI

A **headless** run is an agent run with nobody at the keyboard: `claude -p` in a script, a CI job, a scheduled task. ultrathink still plans every prompt a host sends it unless you tell it not to, and a plan can take minutes of model calls. This guide lists the switches for those runs and what each host does on its own.

- [The switches](#the-switches)
- [Recipes](#recipes)
- [What each host does without a user](#what-each-host-does-without-a-user)
- [Credentials on a machine without a browser](#credentials-on-a-machine-without-a-browser)
- [Bun in CI](#bun-in-ci)

## The switches

Set these in the environment of the agent process. They beat the config files and the per-host control commands.

| Variable | Effect |
|---|---|
| `ULTRATHINK_UPLIFT=0` | No planning at all in this process, on every host. The `uplift:` prefix does not override it. |
| `ULTRATHINK_TRACK=0` | The planner creates no Linear or Notion rows. Planning continues. If a tracker is configured, the plan still tells the agent to run the `ultrathink-kickoff` skill, which creates the rows in the agent's turn. |
| `ULTRATHINK_SHIP=0` | No `## Ship` section in the plan and no ship nudge at the end of the run, even with `ship.enabled: true`. |
| `ULTRATHINK_STATE_DIR` | Use this directory for the session records and control state instead of the host's own. Ignored when it points into a `.planning` directory. |
| `ULTRATHINK_HOST` | Which host's state directory `bin/ultrathink` changes: `claude-code`, `grok-build`, `hermes`, `muse` or `omp`. |
| `ULTRATHINK_DEBUG=1` | The prompt hook (Claude Code, Grok Build, Muse Code) logs skip reasons and failures to stderr as `[ultrathink] …`. |

Config keys that matter for unattended runs:

| Key | Why |
|---|---|
| `claude.budgetMs` | Caps the whole planning run. Without it the only limit is the host's hook timeout, which is 86,400 seconds for Claude Code's prompt hook. |
| `claude.callTimeoutMs`, `grok.callTimeoutMs` | Cap one engine call. |
| `hitl.enabled: false` | No clarifying questions in the plan (one engine call fewer). |
| `track.enabled: false` | Same as `ULTRATHINK_TRACK=0`, from a config file. |

See [Reduce cost and latency](reduce-cost-and-latency.md) for what each of these saves.

## Recipes

**No ultrathink at all in a job:**

```sh
ULTRATHINK_UPLIFT=0 claude -p "<task>"
```

**Plan, but create no rows and never open a PR:**

```sh
ULTRATHINK_TRACK=0 ULTRATHINK_SHIP=0 claude -p "<task>"
```

`ULTRATHINK_TRACK=0` only stops the planner's own row creation. Leaving `notion.dataSourceUrl` and `linear.team` out of the runner's user config is not enough when the repository commits them in `<repo>/.claude/ultrathink.json`: that file is read too, and a `""` in another file cannot clear them. To stop the kickoff skill as well, turn tracking off in the state directory the job uses:

```sh
export ULTRATHINK_STATE_DIR="$RUNNER_TEMP/ultrathink"   # any writable directory
<clone>/bin/ultrathink track off
ULTRATHINK_SHIP=0 claude -p "<task>"
```

`<clone>` is the directory you cloned ultrathink into. `bin/ultrathink` and the hooks read the same `ULTRATHINK_STATE_DIR`, so the job's control state stays out of your personal one.

**Plan with a time limit**, in the config file the job reads (for example `<repo>/.claude/ultrathink.json` or the runner's `~/.config/ultrathink/config.json`):

```json
{ "claude": { "budgetMs": 120000 }, "hitl": { "enabled": false } }
```

## What each host does without a user

| Host | Headless behaviour |
|---|---|
| Claude Code | ultrathink does not detect print mode: a `claude -p` prompt is planned like any other. Use `ULTRATHINK_UPLIFT=0` to stop it. ultrathink's own `claude -p` calls carry `ULTRATHINK_CHILD=1` and are never planned. With ship on, the Stop hook blocks the first stop of a matching skill run once to ask for `ultrathink-ship`; `ULTRATHINK_SHIP=0` prevents that. |
| Grok Build | Prompts inside Grok subagents are never planned; only the main session is. |
| Muse Code | Runs the same prompt hook as Claude Code, with the same switches. |
| Omp | Task subagent sessions are never planned. A run with no UI and no session file, such as `omp -p --no-session`, is treated the same and not planned. A run with no UI that has a session file and no parent session is planned. |
| Hermes Agent | Cron runs (`platform` `cron`) and sessions with a parent session (subagents) are never planned. Planning needs Hermes' hook cap `plugins.hook_callback_timeout` of at least 105 seconds, 600 recommended; it is a global Hermes setting, and ultrathink never changes it. Below that the bridge skips planning and logs one warning. |

**Clarifying questions.** A plan can contain questions marked blocking. The plan tells the agent to ask them with the host's question tool (`AskUserQuestion`, or Hermes' `clarify`). When that tool is not available, as in a non-interactive run, the agent is told to go on with the recommended defaults and list every assumption it made. To leave the questions out of the plan, set `hitl.enabled: false` or run `bin/ultrathink hitl off` for that host.

## Credentials on a machine without a browser

The engine and the trackers need logins on the runner:

| Service | Headless route |
|---|---|
| Claude engine | Whatever login the `claude` CLI has on the runner, OAuth or API key. ultrathink adds none. |
| Grok engine | A `grok login` session in the Grok home (`grok.home`, `$GROK_HOME` or `~/.grok`), or the `shunt` transport with your own gateway, which needs no Grok login. See [Choose the engine](choose-engine.md). |
| Linear, Greptile | An API key: `<clone>/bin/ultrathink-mcp auth set-key linear --stdin`, or from a file with `auth set-key linear --env-file <path> --var <NAME>`. The same for `greptile`. |
| Notion | OAuth only. Log in once with `auth login notion`; see [Set up Notion](set-up-notion.md) for logging in from a remote machine. |

Keys go to the credential store, `${XDG_CONFIG_HOME:-~/.config}/ultrathink/mcp-credentials.json` (mode 0600), or the path in `ULTRATHINK_MCP_STORE`. Never put a key in a config file. See [Register the MCP gateway](register-mcp-gateway.md).

## Bun in CI

The hooks and the CLIs behave differently when Bun is missing:

- The hooks print `ultrathink: bun not found. Install Bun 1.2 or later (https://bun.sh) or set BUN=/path/to/bun` and exit 0, so the agent run goes on unplanned.
- `bin/ultrathink`, `bin/ultrathink-mcp` and `bin/ultrathink-ship` print the same line and exit 127, so a CI step that calls them fails visibly.

Set `BUN=/path/to/bun` when Bun is not on `PATH` and not in one of the places `bin/run-bun` looks. See [Install](../install.md).
