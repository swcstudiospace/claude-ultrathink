# Reduce cost and latency

Planning makes several model calls before your agent starts, and the agent waits for them. This guide counts those calls and lists every setting that makes planning cheaper or faster. The **engine** is the model that plans (see [Choose the engine](choose-engine.md)). With the default Claude engine, each call is one headless `claude -p` run on the account the `claude` CLI is logged in with.

- [What one plan costs](#what-one-plan-costs)
- [Plan fewer prompts](#plan-fewer-prompts)
- [Make each plan smaller](#make-each-plan-smaller)
- [Make each call faster](#make-each-call-faster)
- [Cap the waiting time](#cap-the-waiting-time)
- [Tracking and ship](#tracking-and-ship)

## What one plan costs

| Stage | Model calls | Turned off by |
|---|---|---|
| Spec (the "uplift" that rewrites your prompt into a structured spec) | 1 | planning off |
| Graph of Thought: the graph | 1 | `think.enabled: false` or `bin/ultrathink think off` |
| Graph of Thought: one detail call per node | N, between `think.minNodes` (5) and `think.maxNodes` (8) | same |
| Clarifying questions (HITL, "human in the loop") | 1 | `hitl.enabled: false` or `bin/ultrathink hitl off` |

With the defaults, one planned prompt makes **8 to 11** engine calls. With the Graph of Thought off it makes 2, and with both the graph and the questions off it makes 1.

Other costs:

- The plan is added to your agent's context, so it also adds input tokens to the agent's own turn.
- Creating Linear and Notion rows makes no model calls. It makes API calls through the MCP gateway (see [Tracking and ship](#tracking-and-ship)).
- With ship on, each `assess` makes one more engine call, the done judge.

## Plan fewer prompts

| How | Scope |
|---|---|
| Short replies are never planned: `yes`, `y`, `no`, `n`, `ok`, `okay`, `k`, `continue`, `go`, `go ahead`, `do it`, `please`, `thanks`, `thank you`, `sure`, `yep`, `nope`, `lgtm` (with trailing punctuation). Set `uplift.skipTrivial: false` to plan them too. | config |
| `/ultrathink-quick <message>` sends one message as typed: no plan, no Graph of Thought, no rows. | one message |
| `/ultrathink-skip` or `bin/ultrathink skip`: do not plan the next message. | next message, this host |
| Built-in and unknown slash commands, such as `/model`, are never planned. A slash command that runs a skill is planned. | always |
| Start a message with `raw:` and it is neither planned nor tracked. | one message |
| `/ultrathink-off` or `bin/ultrathink off` turns planning off; `/ultrathink-on` turns it back on. | this host, until changed |
| `"uplift": { "enabled": false }` in config. | every host without its own on/off setting |
| `ULTRATHINK_UPLIFT=0` in the environment. | that process; not even `uplift:` overrides it |

To plan one message while planning is off, or a short reply, start it with `uplift:`.

`bin/ultrathink` changes the host it detects, and Claude Code from a plain shell. Set `ULTRATHINK_HOST` (`claude-code`, `grok-build`, `hermes`, `muse` or `omp`) to change another host. See [Commands](../commands.md#skip-and-control-commands) for how each host shows the commands.

A prompt longer than `uplift.maxChars` (20,000 characters) skips the spec call: it gets the minimal fallback spec and creates no rows. The Graph of Thought and the questions still run unless they are off.

## Make each plan smaller

| Key | Default | Effect |
|---|---|---|
| `think.maxNodes` | `8` | Upper bound on graph nodes, so on node detail calls. It cannot go above 8, and a value below `think.minNodes` is ignored: to go under 5, lower `minNodes` too. |
| `think.minNodes` | `5` | Lower bound. A graph from the engine with fewer nodes is replaced by a built-in five-node graph. |
| `think.enabled` | `true` | `false` skips the graph and every node call. The plan is then the spec plus the clarifying questions. |
| `hitl.enabled` | `true` | `false` skips the clarifying-questions call. |
| `hitl.maxQuestions` | `4` | Most questions one plan may contain (1 to 4). It does not change the number of calls. |

For example, a lighter plan for every host:

```json
{
  "think": { "minNodes": 3, "maxNodes": 5 },
  "hitl": { "enabled": false }
}
```

`bin/ultrathink think off|on` and `bin/ultrathink hitl off|on` do the same per host, and beat the config for that host.

## Make each call faster

| Key | Default | Effect |
|---|---|---|
| `claude.model` | `"sonnet"` | Model alias for the Claude engine. A smaller model is faster and cheaper. `""` uses the `claude` CLI's default. |
| `claude.thinking` | `false` | Keep it off. On allows extended thinking in every planning call, which dominates latency. |
| `claude.settingSources` | `""` | Keep it empty. Empty loads no settings in the child `claude` calls: fastest, and no nested hooks. |
| `claude.concurrency` | `3` | Node detail calls that run at once, per dependency level of the graph. It applies to both engines. `1` runs them one by one. Higher is faster, if your account allows the parallel calls. |
| `grok.reasoningEffort` | `"xhigh"` | Grok `http` and `cli` transports: `"low"`, `"medium"` or `"high"` trade depth for speed. |
| `grok.model`, `grok.shuntModel` | `"grok-4.7"`, `""` | The Grok model, or the model your shunt gateway routes. |

## Cap the waiting time

| Key | Default | Effect |
|---|---|---|
| `claude.budgetMs` | `0` | Budget for the whole planning run, on every host and with either engine. `0` means no budget. When it runs out, the stage that is running is cancelled and dropped, the later stages are skipped, and the agent gets the plan built so far. If the spec itself had not finished, the prompt goes through unplanned. |
| `claude.callTimeoutMs` | `0` | Timeout for one Claude call. `0` means no timer. A timed-out spec call gives the fallback spec. |
| `grok.callTimeoutMs` | `0` | Same, for Grok calls. |

Without these, the host's own hook timeout is the limit. Claude Code's prompt hook allows 86,400 seconds. On Hermes Agent the limit is Hermes' hook cap (`plugins.hook_callback_timeout`): set it to at least 105 seconds, 600 recommended; it is a global Hermes setting, and ultrathink never changes it. See [Install](../install.md).

## Tracking and ship

Tracking creates the Linear and Notion rows before the agent sees the plan, so it adds network time to every tracked prompt, but no model calls. On Hermes Agent the planner creates no rows: the `ultrathink-kickoff` skill creates them in the agent's turn, so the `track.*` budget keys below do not apply there.

| Key | Default | Effect |
|---|---|---|
| `track.budgetMs` | `60000` | Longest the planner spends creating rows. Rows it did not finish are left to the `ultrathink-kickoff` skill, which the agent runs. |
| `track.concurrency` | `6` | Tracker calls at once. |
| `track.enabled` | `true` | `false`, or `ULTRATHINK_TRACK=0`, stops the planner creating rows. The kickoff skill still creates them in the agent's turn, which costs agent tokens instead. |
| `/ultrathink-track off` | | Stops all row creation for this host, the kickoff skill included. |

See [Tracking](../tracking.md) for how rows are created.

Ship runs only when you turn it on (`ship.enabled`). Each `assess` makes one engine call. Review rounds cost Greptile reviews, not engine calls. See [Ship with Greptile](ship-with-greptile.md).

To see why a prompt was skipped or which stage failed, set `ULTRATHINK_DEBUG=1`: the prompt hook (Claude Code, Grok Build, Muse Code) then writes `[ultrathink]` log lines to stderr. The summary line the hook shows after each plan (`claude.echo`, on by default) includes the elapsed time.
