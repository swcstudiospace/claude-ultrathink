# Choose the planning engine

The **engine** is the model ultrathink calls to plan a prompt. It writes the spec, the Graph of Thought (a small graph of reasoning steps that ends in an execution plan) and the clarifying questions. When ship is on, it is also the judge that decides whether a task is done. The **host** is the coding agent you type into (Claude Code, Grok Build, Hermes Agent, Muse Code or Omp). The host keeps its own model for the actual work. The engine is separate, and it can be Claude or Grok on any host.

- [Claude (the default)](#claude-the-default)
- [Grok](#grok)
- [Switch engines](#switch-engines)
- [Check which engine is active](#check-which-engine-is-active)
- [When the engine fails](#when-the-engine-fails)

## Claude (the default)

ultrathink runs the Claude Code CLI headless (`claude -p`) for every planning call, whichever host you use. Each call is a plain completion: no tools, no MCP servers and no settings sources, and it runs with `ULTRATHINK_CHILD=1` so the prompt hook never plans ultrathink's own calls.

You need:

- the `claude` CLI on `PATH` (or its path in `claude.bin`);
- a working login for it. ultrathink uses whatever login the CLI already has, OAuth or API key. The calls count against that account.

| Key | Default | Meaning |
|---|---|---|
| `claude.model` | `"sonnet"` | Model alias passed as `--model`. `""` uses the CLI's own default model. |
| `claude.bin` | `"claude"` | Binary to run. |
| `claude.thinking` | `false` | Allow extended thinking in the planning calls. Off sets `MAX_THINKING_TOKENS=0` for the child, which is much faster. |
| `claude.settingSources` | `""` | `--setting-sources` for the child. Empty loads none: fastest, and no nested hooks. |
| `claude.callTimeoutMs` | `0` | Timeout for one call. `0` means no timer; the host's hook timeout still applies. |

The engine label is `claude:<model>`, for example `claude:sonnet`, or `claude:session default` when `claude.model` is `""`.

## Grok

Set `think.engine` to `"grok"` to plan with Grok (`grok-4.7` at `xhigh` reasoning effort by default). `grok.enabled` (default `true`) must stay `true`; `false` forces Claude even when Grok is selected.

Grok has three **transports**, the ways ultrathink reaches the model:

| `grok.transport` | What ultrathink does | What you need |
|---|---|---|
| `"http"` (default) | `POST {grok.baseUrl}/responses`, default base `https://cli-chat-proxy.grok.com/v1` | The Grok Build CLI (`grok`) signed in with `grok login`. ultrathink reads that session from `auth.json` in the Grok home. |
| `"cli"` | Runs the `grok` binary headless for one turn in a private temporary directory, with tools, web search and subagents turned off | The same `grok login` session. |
| `"shunt"` | `POST {grok.shuntBaseUrl}/v1/messages` in Anthropic Messages format, with no auth header | An Anthropic-compatible gateway that **you** run and that handles its own upstream auth. ultrathink ships no gateway and has no default URL. |

For `http` and `cli`:

- The Grok home is `grok.home`, else `$GROK_HOME`, else `~/.grok`.
- `bin/ultrathink status` calls this session "SuperGrok OAuth". You need a Grok account that can sign in to the Grok Build CLI.
- When the session has expired and has a refresh token, ultrathink runs `grok models` once so the CLI refreshes it. ultrathink never calls the token endpoint itself.
- Before planning, ultrathink checks the login. If it is missing or expired, the prompt goes through unplanned with the reason ``Prompt Uplift skipped · Grok 4.7 login required (run `grok login`)``, which the Claude Code, Grok Build and Muse Code hook shows for a plain prompt. Set `grok.fallbackToClaude: true` to plan on Claude instead; the engine label then ends in `(grok fallback)`.

For `shunt`:

- Set `grok.shuntBaseUrl` to your gateway's base URL (http or https; `/v1/messages` is appended). Without it every call fails with `grok shunt transport: set grok.shuntBaseUrl (the base URL of your Anthropic-compatible gateway) in ~/.config/ultrathink/config.json, or switch grok.transport to "http"`.
- `grok.shuntModel` is the model name sent to the gateway. Empty sends `grok.model`. The gateway route decides the reasoning effort, so `grok.reasoningEffort` is not sent.
- `grok.shuntMaxTokens` (default `8192`) is the `max_tokens` of each call.
- No `grok login` check runs.

| Key | Default | Meaning |
|---|---|---|
| `grok.model` | `"grok-4.7"` | Model for `http` and `cli`. |
| `grok.reasoningEffort` | `"xhigh"` | `"low"`, `"medium"`, `"high"` or `"xhigh"`. Used by `http` and `cli`. |
| `grok.baseUrl` | `"https://cli-chat-proxy.grok.com/v1"` | Endpoint for `http`. |
| `grok.bin` | `"grok"` | Grok CLI binary, for `cli` and for the session refresh. |
| `grok.home` | `""` | Grok home; empty uses `$GROK_HOME`, else `~/.grok`. |
| `grok.callTimeoutMs` | `0` | Timeout for one call. `0` means no timer. |
| `grok.fallbackToClaude` | `false` | Plan on Claude when the Grok login is missing or expired. |
| `grok.shuntBaseUrl` | `""` | Your gateway's base URL. Required for `shunt`. |
| `grok.shuntModel` | `""` | Model name sent to the gateway; empty sends `grok.model`. |
| `grok.shuntMaxTokens` | `8192` | `max_tokens` for `shunt` calls. |

Example: Grok over your own gateway.

```json
{
  "think": { "engine": "grok" },
  "grok": {
    "transport": "shunt",
    "shuntBaseUrl": "https://<your gateway>",
    "shuntModel": "<model name your gateway routes>"
  }
}
```

The engine label is `<model>@<effort>` for `http` and `cli` (for example `grok-4.7@xhigh`) and `<shuntModel or model>@shunt` for `shunt`.

## Switch engines

There are two layers, and the first beats the second:

1. **Per host**, stored in that host's state directory:

   ```sh
   <clone>/bin/ultrathink grok engine grok     # this host now plans with Grok
   <clone>/bin/ultrathink grok engine claude   # back to Claude
   ULTRATHINK_HOST=omp <clone>/bin/ultrathink grok engine grok   # another host's setting
   ```

   `<clone>` is the directory you cloned ultrathink into. Without `ULTRATHINK_HOST`, `bin/ultrathink` changes the host it detects from the environment, and Claude Code from a plain shell. `ULTRATHINK_HOST` takes `claude-code`, `grok-build`, `hermes`, `muse` or `omp`.

2. **Every host**, in a config file (see [Team and project config](team-and-project-config.md) for which file):

   ```json
   { "think": { "engine": "grok" } }
   ```

A host that has never run `grok engine` follows the config.

## Check which engine is active

```sh
<clone>/bin/ultrathink grok
```

It prints three lines, for example:

```text
Engine: grok-4.7@xhigh
Grok: grok-4.7 @ xhigh · transport http
SuperGrok OAuth: you@example.com · expires 2026-10-01T12:00:00.000Z
```

With `shunt`, the second line adds the gateway URL (or `shunt gateway not configured (set grok.shuntBaseUrl)`), the wire model and `max_tokens`, and the third reads `SuperGrok OAuth: not used (shunt gateway owns upstream auth)`. `bin/ultrathink status` shows the same lines among the rest of the state.

## When the engine fails

A failed or timed-out planning call never blocks your prompt. If the spec call fails, the turn goes on with a minimal fallback spec and creates no tracking rows, and the summary line reports `Engine error · …`. If the graph call fails, a built-in five-node graph is used. A node whose detail call fails keeps its question as its conclusion. A failed clarification call asks no questions. See [Troubleshooting](../troubleshooting.md) and [Reduce cost and latency](reduce-cost-and-latency.md) for the timeouts.

For every engine key, see [Configuration](../configuration.md#key-reference). For what each engine sends off your machine, see [Privacy](../privacy.md).
