# Choose the planning engine

The **engine** is the model ultrathink calls to plan a prompt. It writes the spec, the Graph of Thought (a small graph of reasoning steps that ends in an execution plan) and the clarifying questions. When ship is on, a CLI engine is also the judge that decides whether a task is done. The **host** is the coding agent you type into (Claude Code, Grok Build, Hermes Agent, Muse Code, Omp or Prime Agent). The host keeps its own model for the actual work. The engine is separate: Claude, Grok or Muse on any host, or, on Omp, the session's own model. By default Claude Code and Prime Agent plan with Claude, Grok Build with Grok, Muse Code with Muse, Hermes with the engine of its session model's family (Claude when the family is unknown), and Omp natively with the session's own live model.

- [Claude](#claude)
- [Grok](#grok)
- [Muse](#muse)
- [Omp: the session's own model](#omp-the-sessions-own-model)
- [Switch engines](#switch-engines)
- [Check which engine is active](#check-which-engine-is-active)
- [Planning model states](#planning-model-states)
- [When the engine fails](#when-the-engine-fails)

## Claude

ultrathink runs the Claude Code CLI headless (`claude -p`) for every planning call on the hosts whose engine resolves to Claude: Claude Code by default, Hermes when the session model is a Claude model or of an unknown family, Omp and every other host with `think.engine` set to `"claude"`, and a Grok route that one of the two Grok switches below hands to Claude. On Omp under `auto` it also runs the ship done check and the Teachable Moments distiller, which never use the session's model. Each call is a plain completion: no tools, no MCP servers and no settings sources, and it runs with `ULTRATHINK_CHILD=1` so the prompt hook never plans ultrathink's own calls.

You need:

- the `claude` CLI on `PATH` (or its path in `claude.bin`);
- a working login for it. ultrathink uses whatever login the CLI already has, OAuth or API key. The calls count against that account.

| Key | Default | Meaning |
|---|---|---|
| `claude.model` | `"sonnet"` | Model alias passed as `--model`. `""` uses the CLI's own default model. The built-in value comes from the [route-default map](../configuration.md#route-defaults). |
| `claude.bin` | `"claude"` | Binary to run. |
| `claude.thinking` | `false` | Allow extended thinking in the planning calls. Off sets `MAX_THINKING_TOKENS=0` for the child, which is much faster. |
| `claude.settingSources` | `""` | `--setting-sources` for the child. Empty loads none: fastest, and no nested hooks. |
| `claude.callTimeoutMs` | `0` | Timeout for one call. `0` means no timer; the host's hook timeout still applies. |

The `Engine:` line of `bin/ultrathink status` shows `claude:<model>`, for example `claude:sonnet`, or `claude:session default` when `claude.model` is `""`. The plan's model line shows how the model was chosen: `claude:sonnet [route default]` for the built-in model, `claude:<model> [override]` for a model set in a config file, and `claude:CLI default (model unobserved)` for `""`.

## Grok

Grok Build plans with Grok by default (`grok-4.7` at `xhigh` reasoning effort). Set `think.engine` to `"grok"` to plan with Grok on every host. `grok.enabled` (default `true`) must stay `true`; `false` forces Claude even when Grok is selected.

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
- Before planning, ultrathink checks the login. If it is missing or expired, the prompt goes through unplanned with the reason ``Prompt Uplift skipped · Grok 4.7 login required (run `grok login`)``, which the Claude Code, Grok Build and Muse Code hook shows for a plain prompt. That is the same under `auto` on Grok Build and with `think.engine: "grok"`; the record says `grok:unresolved [grok-unavailable]`.
- Claude replaces a selected Grok route only through the two explicit, labeled user switches: `grok.fallbackToClaude: true` (HTTP/CLI login missing or expired) and `grok.enabled: false` (documented ‘forces Claude even when Grok is selected’). Without them, a missing or expired Grok login skips planning with the unchanged `GROK_LOGIN_REQUIRED` notice. Naming `think.engine: "claude"` is a deliberate engine choice, not a replacement.
- With either switch, Claude plans on its own `claude.model`, never on the Grok model, and the plan's model line reads `claude:<model> [configured fallback · grok unavailable]`.

For `shunt`:

- Set `grok.shuntBaseUrl` to your gateway's base URL (http or https; `/v1/messages` is appended). Without it the prompt is not planned and nothing is sent: the reason is ``Prompt Uplift skipped · grok:unresolved [transport-incompatible]``.
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

The `Engine:` status label is `<model>@<effort>` for `http` and `cli` (for example `grok-4.7@xhigh`) and `<shuntModel or model>@shunt` for `shunt`. The plan's model line reads, for example, `grok:grok-4.7 [route default]`.

## Muse

Muse Code plans with Muse by default (`muse-spark-1.3-contributor` at `high` reasoning effort). Set `think.engine` to `"muse"` to plan with Muse on every host.

ultrathink runs the `muse` CLI headless (`muse exec --json`) for one agent turn per planning call, with the shell, file writes and web tools disabled, and with `ULTRATHINK_CHILD=1` so the prompt hook never plans ultrathink's own calls.

You need:

- the `muse` CLI on `PATH` (or its path in `muse.bin`);
- a working login for it. ultrathink uses whatever login the CLI already has. The calls count against that account.

| Key | Default | Meaning |
|---|---|---|
| `muse.model` | `"muse-spark-1.3-contributor"` | Model id passed as `--model`. `""` omits the flag and the CLI's session default answers. |
| `muse.reasoningEffort` | `"high"` | `"none"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`, `"max"` or `"ultra"`, passed as `--reasoning-effort`. |
| `muse.bin` | `"muse"` | Binary to run. |
| `muse.callTimeoutMs` | `0` | Timeout for one call. `0` means no timer. |

The `Engine:` status label is `muse:<model>`, for example `muse:muse-spark-1.3-contributor`, or `muse:session default` when `muse.model` is `""`. The plan's model line reads, for example, `muse:muse-spark-1.3-contributor [route default]`.

## Omp: the session's own model

On Omp with `think.engine: "auto"` (the default), ultrathink plans inside Omp on the model your session is using. For each prompt it reads the session's current model once, copies it, and sends the uplift, the graph, every node fill and the clarifying questions to that copy through Omp's own completion call, with Omp's own provider and login.

- **No extra login.** Native planning needs no `claude`, `grok` or `muse` CLI and no separate login, and ultrathink copies no credential out of Omp. Only the text of each answer is used; the planning calls run no tools.
- **Other models.** `models.hosts.omp.model` plans with another model Omp knows, and `models.hosts.omp.provider` requires one provider. When the live model can't be used, the provider's default from `models.providerDefaults`, else Omp's installed catalog, is used. See [Configuration: `models`](../configuration.md#models-planning-model-selection).
- **Opting out.** A named engine (`think.engine: "claude"`, `"grok"` or `"muse"`, or `ULTRATHINK_HOST=omp <clone>/bin/ultrathink grok engine claude`) plans on that CLI route as on any other host. The status then shows `native opt-out`.
- **Thinking level.** Every native stage inherits the session's captured thinking level. `off` uses Omp's reasoning-disable convention; `inherit` or an unavailable setting leaves provider defaults alone. For lower latency, explicitly choose a lower session level; ultrathink never lowers it silently. Named CLI engines retain their own effort settings.
- **Timing.** On reasoning-heavy models a native plan can take several minutes. Omp waits 25 s; after that the agent gets a note to only read and investigate, and the plan arrives later as an aside message. A run is capped at 10 minutes.
- **Cancellation.** A plan is cancelled and never delivered when you send a newer prompt or `/ultrathink-quick`, when a changed session model is observed at a planning call, existing agent/turn/tool lifecycle event or delivery, when a changed thinking level or effective target invalidates reentry, or when you switch or end the session. The 10-minute cap releases a terminal no-plan note even if the provider ignores cancellation; late results are discarded. A print-mode run (`omp -p`) that exits early cancels its plan. An unchanged turn ending while the plan is pending does not.
- **Helpers stay on CLI routes.** The ship done check and the Teachable Moments distiller run outside the planning flight, so they use the Claude CLI route under `auto` (or the named engine), never the session's model.

## Switch engines

There are two layers, and the first beats the second:

1. **Per host**, stored in that host's state directory:

   ```sh
   <clone>/bin/ultrathink grok engine grok     # this host now plans with Grok
   <clone>/bin/ultrathink grok engine muse     # this host now plans with Muse
   <clone>/bin/ultrathink grok engine auto     # back to this host's own engine
   ULTRATHINK_HOST=omp <clone>/bin/ultrathink grok engine grok   # another host's setting
   ```

   `<clone>` is the directory you cloned ultrathink into. Without `ULTRATHINK_HOST`, `bin/ultrathink` changes the host it detects from the environment, and Claude Code from a plain shell. `ULTRATHINK_HOST` takes `claude-code`, `grok-build`, `hermes`, `muse` or `omp`.

2. **Every host**, in a config file (see [Team and project config](team-and-project-config.md) for which file):

   ```json
   { "think": { "engine": "grok" } }
   ```

A host with no stored control engine follows `think.engine`. A stored control choice, including `auto`, takes precedence over that config value: explicitly choosing `auto` restores that host's automatic route. Automatic routes are Claude on Claude Code, Grok on Grok Build, Muse on Muse Code, the session model's family route on Hermes (Claude when unknown), and the session's own live model on Omp. A named engine on Omp opts out of native planning.

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

With `shunt`, the second line adds the gateway URL (or `shunt gateway not configured (set grok.shuntBaseUrl)`), the wire model and `max_tokens`, and the third reads `SuperGrok OAuth: not used (shunt gateway owns upstream auth)`. `bin/ultrathink status` shows the same lines among the rest of the state, plus `Engine request: <engine> (<config or control>[, native opt-out]) · concurrency <n>` and, after a plan, `Last planned resolution:` with that plan's model line.

On Omp, `/ultrathink-status` shows the latest model the session planned with as the `Engine:` line, for example `omp-native:<provider>/<model> [detected]`. Before the first plan, and from a shell (`ULTRATHINK_HOST=omp <clone>/bin/ultrathink status`), which can't see the live session, it reads `omp-native:auto (live model not observed)`. The status bar and each plan card show the same model line.

## Planning model states

Every selection records one of four states, with the source and the reason. The record appears in the summary line, in the plan's `Planning model:` line, in the session record, in `Last planned resolution:`, and on Omp in the status bar, the plan cards and `/ultrathink-status`. It never contains an endpoint, a header or a credential.

| State | Meaning | Example labels |
|---|---|---|
| `detected` | Omp's live session model, used as it is. | `omp-native:<provider>/<model> [detected]` |
| `default` | A default chose the model: a CLI route's built-in model, the CLI's own default after `""`, the configured or catalog default for the live model's provider on Omp, or Claude through one of the two Grok switches. | `claude:sonnet [route default]`, `claude:CLI default (model unobserved)`, `omp-native:<provider>/<model> [configured default]`, `omp-native:<provider>/<model> [host-catalog default]`, `claude:sonnet [configured fallback · grok unavailable]` |
| `override` | You chose it: a model key set in a config file, `grok.shuntModel`, `models.hosts.<host>.model`, or an Omp provider constraint that picked that provider's default (the record's `defaultSource` then names `configured-default` or `host-catalog`). | `claude:opus [override]`, `omp-native:<provider>/<model> [override]` |
| `unresolved` | No model could be used. The prompt goes through unplanned with the reason. | `omp-native:unresolved [provider-unknown]`, `grok:unresolved [grok-unavailable]` |

The reasons:

| Reason | Meaning |
|---|---|
| `live-model` | Omp's live model was used. |
| `active-unavailable` | Omp's live model couldn't be used, so its provider's default was. |
| `explicit-model`, `explicit-provider` | A model you set, or an Omp provider constraint. |
| `route-default-model` | A CLI route's built-in model from the route-default map. |
| `cli-delegation` | `claude.model` or `muse.model` is `""`, so the CLI chose. |
| `grok-unavailable` | The Grok login is missing or expired, so the prompt is skipped; or Claude plans in Grok's place through `grok.fallbackToClaude` or `grok.enabled: false`. |
| `native-unavailable` | Omp planning under `auto` ran without Omp's model interfaces, for example `hooks/engine.ts` called with `host: "omp"`. |
| `provider-unknown` | Omp has no live model and no `models.hosts.omp.provider` is set. |
| `mapping-missing` | No configured or catalog default exists for the provider. |
| `selector-unresolved` | Omp could not resolve the model you set, or the default, to a usable model. |
| `provider-mismatch` | The model resolved to another provider than required. |
| `unsupported-model` | The model can't do a plain text completion. |
| `selector-invalid` | A configured model or provider contains a control character. |
| `transport-incompatible` | A provider is set for a CLI route, which can't bind one, or `shunt` has no `grok.shuntBaseUrl`. |
| `concrete-model-required` | The Grok route has no model to send. |
| `unsupported-host` | `hooks/engine.ts` was given a host it doesn't support, such as a bot name. |

The record shows the selection, not that the calls worked. A `detected` model whose calls fail keeps its state; the failure shows as `Engine error · …` and degraded stages, as below.

## When the engine fails

A failed or timed-out planning call never blocks your prompt. If the spec call fails, the turn goes on with a minimal fallback spec and creates no tracking rows, and the summary line reports `Engine error · …`. If the graph call fails, a built-in five-node graph is used. A node whose detail call fails keeps its question as its conclusion. A failed clarification call asks no questions. See [Troubleshooting](../troubleshooting.md) and [Reduce cost and latency](reduce-cost-and-latency.md) for the timeouts.

For every engine key, see [Configuration](../configuration.md#key-reference). For what each engine sends off your machine, see [Privacy](../privacy.md).
