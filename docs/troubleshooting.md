# Troubleshooting

ultrathink fails open. When something is wrong, your prompt still goes through, with less planning or none. So most problems look like "the plan didn't appear" or "the rows didn't appear". Start with the [first checks](#first-checks), then look up the symptom or the host.

In the commands below, `<clone>` is the absolute path of your checkout. Paths written as `${NAME:-default}` use the environment variable when you set it, and the default otherwise.

- [First checks](#first-checks)
- By symptom: [Nothing happens](#nothing-happens) · [My control command printed nothing](#my-control-command-printed-nothing) · [Every plan shows fallback](#every-plan-shows-fallback) · [bun not found](#bun-not-found) · [Grok shunt gateway not configured](#grok-shunt-gateway-not-configured) · [The plan is slow or cut off](#the-plan-is-slow-or-cut-off) · [Hermes: the plan never arrives](#hermes-the-plan-never-arrives) · [Tracking rows don't appear](#tracking-rows-dont-appear) · [Linear rate limit](#linear-rate-limit) · [Notion OAuth over SSH](#notion-oauth-over-ssh) · [Ship is blocked](#ship-is-blocked) · [Greptile knowledge base](#greptile-knowledge-base) · [Decisions](#decisions) · [Hindsight](#hindsight) · [RAGFlow](#ragflow) · [Teachable Moments](#teachable-moments) · [Redaction](#redaction)
- By host: [Claude Code](#claude-code) · [Grok Build](#grok-build) · [Muse Code](#muse-code) · [Hermes Agent](#hermes-agent) · [Omp](#omp)
- [Uninstalling](#uninstalling)

## First checks

`bin/ultrathink status` (or `/ultrathink-status` inside the agent) prints the full state for one host. On a fresh install it looks like this:

```text
Prompt Uplift on
Engine: claude:sonnet
Grok: grok-4.7 @ xhigh · transport http
SuperGrok OAuth: not logged in (run grok login)
Graph of Thought on
HITL clarifications on · max 4
Tracking: on (not configured: set notion.dataSourceUrl / linear.team)
Notion: not configured
Linear team: not configured
Substrate: off (optional: set substrate.url or SUBSTRATE_URL)
Ship: off (opt-in: set ship.enabled)
Knowledge base: off (opt-in: set hitl.knowledgeBase)
Decisions: on · no Jev key (Vercel: bin/ultrathink-mcp auth set-key vercel --stdin or AI_GATEWAY_API_KEY; OpenRouter: bin/ultrathink-mcp auth set-key openrouter --stdin or OPENROUTER_API_KEY)
Hindsight: off (opt-in: set hindsight.enabled)
RAGFlow: off (opt-in: set ragflow.enabled)
Teach: on · capture auto · recall on · 0 confirmed, 0 candidate · Hindsight off · outbox 0
Model: sonnet · concurrency 3
State: ~/.claude/ultrathink
```

From a plain terminal it reports on Claude Code. Set `ULTRATHINK_HOST` to check another host: `ULTRATHINK_HOST=grok-build`, `hermes`, `muse` or `omp`.

What the less obvious lines mean:

| Line | Meaning |
|---|---|
| `Grok: …` | The Grok engine's settings. They matter only when `Engine:` shows a Grok model. |
| `SuperGrok OAuth: …` | Whether the Grok Build CLI is logged in: ultrathink reads the session that `grok login` saved in `auth.json` in the Grok home (`grok.home`, else `$GROK_HOME`, else `~/.grok`), and asks the `grok` CLI to refresh it when it has expired. It matters only when the engine is Grok with the `http` or `cli` transport. When the engine is Claude or Muse, `not logged in (run grok login)` is expected and harmless. With `transport shunt` the line reads `not used (shunt gateway owns upstream auth)`. |
| `Tracking: …`, `Notion: …`, `Linear team: …` | See [Tracking rows don't appear](#tracking-rows-dont-appear). |
| `Substrate: …` | The optional Agent Substrate brief. It is off unless you set `substrate.url` or `SUBSTRATE_URL`; `SUBSTRATE_DISABLED=1` turns it off again. |
| `Ship: …` | The PR, review and merge loop. Off unless you set `ship.enabled`; `ULTRATHINK_SHIP=0` turns it off for that shell. When on, it shows whether `autoMerge` and `deleteBranch` are on. |
| `Knowledge base: …` | The Greptile knowledge-base read before the clarifying questions. Off unless you set `hitl.knowledgeBase`. See [Greptile knowledge base](#greptile-knowledge-base). |
| `Decisions: …` | Jev decisions over OpenRouter or Vercel. Jev is always on; `Decisions: off (ULTRATHINK_DECISIONS=0)` shows whenever that variable is set, whatever the config says. When on, it shows the model, the active points, the rail (`provider vercel` or `provider openrouter`), where the key came from (`key from store`, `key from AI_GATEWAY_API_KEY` or `key from OPENROUTER_API_KEY`, never the key) and whether zero data retention is requested, or `Decisions: on · no Jev key (…)` when there is no key for the resolved rail. On the OpenRouter rail, a trailing ` · url <url>` means `ULTRATHINK_DECISIONS_URL` is in effect; a trailing ` · ULTRATHINK_DECISIONS_URL ignored (must be https://openrouter.ai/… or a loopback URL)` means it is set but not accepted. See [Decisions](#decisions). |
| `Hindsight: …` | The optional memory server. `Hindsight: off (opt-in: set hindsight.enabled)` until a user file sets `hindsight.enabled`, and `Hindsight: off (ULTRATHINK_HINDSIGHT=0)` whenever that variable is the exact string `0`. A missing key names the command to run: `Hindsight: on · no key (run bin/ultrathink-mcp auth set-key hindsight --stdin, or set HINDSIGHT_API_KEY)`. See [Hindsight](#hindsight). |
| `RAGFlow: …` | Optional document search. `RAGFlow: off (opt-in: set ragflow.enabled)` until you opt in, and `RAGFlow: off (ULTRATHINK_RAGFLOW=0)` when that variable is `0`. A missing key names `bin/ultrathink-mcp auth set-key ragflow --stdin`. See [RAGFlow](#ragflow). |
| `Teach: …` | Teachable Moments. On by default (`capture auto`, auto-promote); `Teach: off (opt-in: set teach.enabled)` only when a user file turned it off. State is under the host state directory's `teach/`, never `<cwd>/.planning`. See [Teachable Moments](#teachable-moments). |

After each planned prompt, hosts that show the summary (`claude.echo`, on by default) print one line such as `Prompt Uplift · UPLIFTED_PROMPT · llm · claude:sonnet · Graph of Thought · 6 nodes · Tracking · 6 issues · 18 sub-issues linked · 41.2s`. A `fallback` source means the engine call failed, and an `Engine error · …` segment shows the first error. With Jev decisions on, a `Decisions · …` segment shows what Jev decided, for example `Decisions · plan 0.97` or `Decisions · error (credits)`.

## Nothing happens

No summary, no plan, and the agent answers the raw prompt.

1. **Check the state.** Run `bin/ultrathink status` for the right host. `Prompt Uplift off` means planning was turned off; `/ultrathink-on` turns it back on. `(skipping next prompt)` means a skip is armed.
2. **Check that the prompt is one ultrathink plans.** Trivial acknowledgements (`ok`, `lgtm`, …), built-in slash commands, `raw:` prompts, subagent sessions and ultrathink's own skills are skipped on purpose. See [Commands](commands.md#prompt-prefixes-and-automatic-skips). `uplift: <prompt>` forces planning. With Jev decisions on, a message Jev judged is not new multi-step work is not planned either; with `claude.echo` on you see `Prompt Uplift · not planned: Jev judged this is not new multi-step work (<P>) · start with uplift: to plan it`. See [Decisions](#decisions).
3. **Check the environment.** `ULTRATHINK_UPLIFT=0` in the host's environment turns planning off for the whole process.
4. **Check the engine.** With `Engine: grok…` and `SuperGrok OAuth: not logged in` or `expired`, every prompt is skipped with ``Prompt Uplift skipped · Grok 4.7 login required (run `grok login`)``. Run `grok login`, switch back with `bin/ultrathink grok engine claude`, or set `grok.fallbackToClaude: true`. With the `shunt` transport, see [Grok shunt gateway not configured](#grok-shunt-gateway-not-configured). If the summary shows `fallback`, the engine call failed. The Claude engine runs `claude -p`, so the `claude` binary (`claude.bin`) must be on the host's `PATH` and logged in, on every host that uses it; likewise the `muse` binary (`muse.bin`) for the Muse engine.
5. **Check Bun.** A hook that can't find Bun lets the prompt through without a word to the agent. See [bun not found](#bun-not-found).
6. **Run the hook by hand with debug logging.** On Claude Code, Grok and Muse the prompt hook is `hooks/uplift.ts`. `ULTRATHINK_DEBUG=1` makes it log each skip reason and failure to stderr:

   ```sh
   cd <your project>
   printf '%s' '{"hook_event_name":"UserPromptSubmit","session_id":"debug","cwd":"'"$PWD"'","prompt":"add a health check endpoint"}' \
     | ULTRATHINK_DEBUG=1 ULTRATHINK_TRACK=0 <clone>/bin/run-bun <clone>/hooks/uplift.ts
   ```

   Lines such as `[ultrathink] skipped: slash-command`, `[ultrathink] uplift failed: …` or `[ultrathink] tracking failed: …` name the cause. Stdout is the JSON the host would receive. `ULTRATHINK_TRACK=0` keeps the test from creating rows. The run does call the engine, and it writes a `debug` session into the Claude Code state directory.

   Hermes and Omp use `hooks/engine.ts`, whose JSON response has a `skipped` field with the reason (`child-or-disabled`, `parent-session`, `cron`, `empty`, `subagent`, `ultrathink-command`, `slash-command`, `ultrathink-skill`, `skill-preamble` (Hermes: a skill loaded with no task), `precheck-skip` (trivial, already uplifted, planning off or an armed skip), `precheck-passthrough` (a `raw:` prompt), `jev-skip` (Jev judged the message is not new work; see [Decisions](#decisions)), `uplift-failed`, `engine-error`, or the Grok login message):

   ```sh
   printf '%s' '{"host":"omp","session_id":"debug","cwd":"'"$PWD"'","prompt":"add a health check endpoint"}' \
     | ULTRATHINK_TRACK=0 <clone>/bin/run-bun <clone>/hooks/engine.ts
   ```

7. **Check the host wiring.** See the host sections below. Grok needs the global hook file, Muse needs approved hooks, Hermes needs the plugin to load and a hook cap of at least 105 s, and Omp needs the link.

## My control command printed nothing

Control commands (`/ultrathink-status`, `-off`, `-on`, `-skip`, `-track`) are answered by the prompt hook, which blocks the prompt so that no model turn runs. How the reply shows up depends on the host and on whether you run it interactively or headless:

| Host | Interactive | Headless |
|---|---|---|
| Claude Code | The reply is shown in the session. | `claude -p` prints `UserPromptSubmit operation blocked by hook:` followed by the reply. |
| Grok Build | The reply is shown in the UI. | `grok -p` prints nothing for a blocked command. |
| Muse Code | The reply is shown in the UI. | `muse exec` ends the run as `Cancelled`. |
| Omp | The reply is an Omp notification. | `omp -p` shows no notifications, and it exits before a `/ultrathink-quick` message runs. |
| Hermes Agent | The command dispatcher replies inline. | Same. |

The command still took effect when nothing was printed. Check with `bin/ultrathink status` (with `ULTRATHINK_HOST` set for that host), or run the command in the interactive UI. To change state from a script, call `bin/ultrathink <verb>` directly instead of sending a slash command through a headless run.

## Every plan shows fallback

Every summary line shows `fallback` as the source (often with an `Engine error · …` segment), and no rows are created. The plan context also carries a `## Planning degraded` block naming the engine and the error, and the session record keeps it as `engineError`.

- **Claude engine: update the `claude` CLI.** The Claude engine runs `claude -p` with `--tools ""`, `--strict-mcp-config` and `--exclude-dynamic-system-prompt-sections`. A CLI too old to know these flags fails every call, so every plan falls back. Claude Code 2.1.278 is the tested version; update to it or later, and check that `claude.bin` (default `claude`) is the binary on the host's `PATH` and that it is logged in.
- **Grok engine:** check the login (`SuperGrok OAuth:` in `bin/ultrathink status`) or, for `shunt`, see [Grok shunt gateway not configured](#grok-shunt-gateway-not-configured).
- **Muse engine:** it runs `muse exec` with `--reasoning-effort` from `muse.reasoningEffort` (`high` by default; `xhigh` or `ultra` thinks longer). If the summary shows `fallback` with the bare `claude:sonnet` label (not `muse:…`), check the selected engine (`Engine:` line in `bin/ultrathink status`) and the `Engine error · …` segment first: an explicitly selected Claude engine whose CLI fails looks exactly the same. Only when the Muse engine is selected — or `auto` on the muse host — does that symptom mean the installed plugin predates the Muse engine: refresh it as in [Muse Code](#muse-code).

To see the error, run the hook by hand as in [Nothing happens](#nothing-happens), step 6.

## bun not found

Hooks and CLIs start Bun through `bin/run-bun`, which looks for it in this order: `$BUN`, `PATH`, `$BUN_INSTALL/bin/bun`, `~/.bun/bin/bun`, `/usr/local/bin/bun`, `/opt/homebrew/bin/bun`, `~/.local/share/*/bun/bin/bun`. If none of them exist, it prints this to stderr:

```text
ultrathink: bun not found. Install Bun 1.2 or later (https://bun.sh) or set BUN=/path/to/bun
```

- **From a hook** it then exits 0, so the prompt goes through unplanned and the host shows no error. The line only appears where the host shows hook stderr.
- **From a CLI** (`bin/ultrathink`, `bin/ultrathink-mcp`, `bin/ultrathink-ship`) it exits 127. A script that checks the exit status sees the failure.

Fix it by installing Bun 1.2 or newer in one of those places, or by setting `BUN` to the binary in the host's environment. On Hermes, a control command replies `Ultrathink <verb> failed: ultrathink: bun not found. Install Bun …`. The Hermes planner also honors `BUN`.

## Grok shunt gateway not configured

The Grok `shunt` transport sends planning calls to an Anthropic-compatible gateway that you run. ultrathink ships no gateway and has no default address. If `grok.transport` is `shunt` and `grok.shuntBaseUrl` is empty:

- `bin/ultrathink status` shows `shunt gateway not configured (set grok.shuntBaseUrl)` on the `Grok:` line.
- Every planning call fails before any request is sent, with `grok shunt transport: set grok.shuntBaseUrl (the base URL of your Anthropic-compatible gateway) in ~/.config/ultrathink/config.json, or switch grok.transport to "http"`. The prompt goes through with the fallback spec, and the summary shows an `Engine error ·` segment.

Set `grok.shuntBaseUrl` to your gateway's base URL (ultrathink appends `/v1/messages`), or set `grok.transport` back to `http`. See [Choose an engine](how-to/choose-engine.md) and [Configuration](configuration.md#grok-the-grok-engine).

## The plan is slow or cut off

A full plan makes several model calls (uplift, graph, one fill per node, clarifications) and then creates rows, so it can take minutes. Each host bounds it differently:

| Host | Bound | What happens at the bound |
|---|---|---|
| Claude Code | Hook timeout 86 400 s (`hooks/hooks.json`) | Not reached in practice. |
| Grok Build | 600 s `UserPromptSubmit` timeout in `${GROK_HOME:-~/.grok}/hooks/ultrathink.json` | Grok stops the hook and the prompt goes through unplanned. |
| Muse Code | 600 s (`timeoutMs: 600000` in `.muse-plugin/plugin.json`) | Same. |
| Hermes Agent | `min(540, cap − 15)` s, where the cap is Hermes' `plugins.hook_callback_timeout` (30 s by default; set it to 600); `ULTRATHINK_HERMES_TIMEOUT` replaces the 540 | The planner kills Bun's process group and no context is added. See [Hermes: the plan never arrives](#hermes-the-plan-never-arrives). |
| Omp | 25 s inline, then the plan arrives as an aside, with the engine run capped at 10 minutes | See [Omp](#omp). |

To make plans faster, lower `think.maxNodes`, raise `claude.concurrency`, set `claude.budgetMs` to cap the whole run, or turn Graph of Thought (`bin/ultrathink think off`) or HITL (`bin/ultrathink hitl off`) off for a host. See [Configuration](configuration.md) and [Reduce cost and latency](how-to/reduce-cost-and-latency.md).

## Hermes: the plan never arrives

Hermes stops waiting for a plugin hook after `plugins.hook_callback_timeout` seconds, 30 by default. This is a global Hermes setting that applies to every plugin, and nothing sets it for you: neither the plugin nor `scripts/setup.ts` changes it. A plan takes minutes, so the cap must be at least 105 s, and 600 is recommended.

The planner gives the engine `min(540, cap − 15)` seconds. Below a 105 s cap that is under 90 s, too short for a plan, so the planner doesn't start Bun at all and returns at once. Hermes never waits long enough to time out, so its log shows no hook timeout line, yet no prompt is planned. At the default 30 s cap, `${HERMES_HOME:-~/.hermes}/logs/agent.log` shows this once per Hermes process:

```text
ultrathink: Hermes hook cap 30.0s leaves under 90s to plan, so prompts go unplanned; run `hermes config set plugins.hook_callback_timeout 600`
```

Fix it and restart Hermes, including any running gateway:

```sh
hermes config set plugins.hook_callback_timeout 600
hermes config get plugins.hook_callback_timeout   # prints 600
```

600 is Hermes' maximum. Don't use 0, which turns off Hermes' hook deadline and makes the turn wait on the hook.

Every ultrathink warning in the Hermes log starts with `ultrathink:` and is logged once per process:

| Warning | Meaning | Fix |
|---|---|---|
| ``ultrathink: Hermes hook cap <n>s leaves under 90s to plan, so prompts go unplanned; run `hermes config set plugins.hook_callback_timeout 600` `` | The cap is below 105 s. | Raise the cap as above. |
| `ultrathink: this Hermes does not report its plugin hook cap, so ultrathink uses plugins.hook_callback_timeout = <n> from <path>/config.yaml; prompts are planned only when the cap is at least 105s (…)` | Your Hermes version doesn't tell plugins its cap, so the planner read it from the active profile's config, `${HERMES_HOME:-~/.hermes}/config.yaml` (or, when `active_profile` names a Hermes profile, `${HERMES_HOME:-~/.hermes}/profiles/<name>/config.yaml`). | Nothing, if `<n>` is 105 or more. Otherwise raise the cap. |
| `ultrathink: this Hermes does not report its plugin hook cap, so ultrathink uses Hermes' 30s default, as <path>/config.yaml sets no plugins.hook_callback_timeout; …` | The planner found no cap in the config, assumed 30 s, and never plans. | Set the cap as above. |
| `ultrathink: <path> not found; install hosts/hermes as a symlink into a full clone of ultrathink (docs/install.md#hermes-agent)` | The plugin directory was copied rather than symlinked, so `hooks/engine.ts` (or `bin/run-bun`) isn't beside it. Bun is never started. | Replace the copy with a symlink: `ln -sfn <clone>/hosts/hermes ${HERMES_HOME:-~/.hermes}/plugins/ultrathink`. See [Install](install.md#hermes-agent). |

If the cap is 600 and plans still don't arrive, the engine ran past 540 s and its process group was killed. See [The plan is slow or cut off](#the-plan-is-slow-or-cut-off) to make plans faster.

## Tracking rows don't appear

Check the tracking line of `bin/ultrathink status` first:

| Status line | Meaning | Fix |
|---|---|---|
| `Tracking: on (not configured: set notion.dataSourceUrl / linear.team)` | Neither tracker is configured, and none is by default. | Configure one: `bin/ultrathink-mcp notion init --parent <page> --write-config`, or set `linear.team`. See [Tracking](tracking.md). |
| `Tracking: off (Linear/Notion rows)` | `/ultrathink-track off` is set for this host. | `/ultrathink-track on`. |
| `Tracking: kickoff (planner-side row creation off; …)` | `ULTRATHINK_TRACK=0` or `track.enabled: false`. The planner creates nothing, and `ultrathink-kickoff` creates the rows during the agent's turn. | Expected. Unset it for planner-side rows. |
| `Tracking: on (Linear/Notion rows)` | Tracking should run. | Continue below. |

On Hermes the planner never creates rows, whatever the status line says. `ultrathink-kickoff` creates them at the start of the agent's turn with `ultrathink-mcp track complete --state <file>`, so check that the agent ran kickoff before anything else.

If tracking is on and configured:

- **Credentials.** `bin/ultrathink-mcp auth status` must show the configured provider as `ready`, and `bin/ultrathink-mcp check linear` (or `notion`) must print `OK <n> tools`. If no configured provider has credentials, tracking is skipped without a message. If one is logged in and the other isn't, tracking is `partial`, and `track complete` prints `! linear: login required` (or `! notion: login required`). For Linear, log in with `auth login linear` (OAuth) or store an API key from your Linear account settings with `auth set-key linear --stdin`. Notion takes `auth login notion` only.
- **Linear team.** `linear.team` must name a team in the workspace that the Linear credential belongs to.
- **Engine fallback.** A prompt whose summary says `fallback` is never tracked, so an engine outage doesn't fill your trackers with boilerplate.
- **Partial tracking.** Creation is bounded by `track.budgetMs` (60 s). The summary then says `Tracking · partial (N missing) · kickoff will finish`, and `ultrathink-kickoff` runs `track complete` in the agent's turn. To finish a session by hand:

  ```sh
  <clone>/bin/ultrathink-mcp track complete --state <state dir>/sessions/<id>.json
  ```

  It prints `tracking <status> · <n> issues · <n> sub-issues · graph <id>`, one `! <error>` line per failure, and the linked TODO lines. `tracking is off`, `tracking not configured` and `no tracker credentials` mean what they say.
- **Flat Notion rows.** If `notion init` reported that adding the `Parent Item` self-relation failed, rows are created but not nested. Add a two-way relation named `Parent Item` (synced as `Sub-Items`) from the database to itself in Notion.

## Linear rate limit

When Linear throttles the gateway, the error reads as a rate limit and not as an authentication failure:

```text
linear: FAIL mcp.linear.app rate limited; retry after 60s
```

Inside the planner it appears as a tracking error, and the tracking is `partial`. Wait for the retry delay, then let `ultrathink-kickoff` finish, or run `track complete` yourself. It creates only the missing rows. Lowering `track.concurrency` (default 6) reduces bursts of parallel creates. Don't log in again: the credentials are fine.

## Notion OAuth over SSH

`bin/ultrathink-mcp auth login notion` prints an authorization URL, then waits for the browser to come back to a callback on `127.0.0.1:8765` on the machine running the command. It also accepts the redirected URL pasted into the terminal. Over SSH the browser runs on another machine, where `127.0.0.1` is your own computer, so the callback can't reach the listener by itself. `auth login` detects an SSH session and prints the options. Pick one:

| Situation | What to do |
|---|---|
| You can forward a port (the default route) | Forward the port before opening the URL: `ssh -L 8765:127.0.0.1:8765 <user>@<host>`, or a local port forward in your SSH client (bind `127.0.0.1:8765` locally to `127.0.0.1:8765` through the host). |
| No forwarding possible | Approve in the browser, copy the full URL of the page you are redirected to (it may fail to load), and paste it into the terminal. `--no-listen` waits only for the pasted URL. |
| The host is on a Tailscale tailnet with HTTPS certificates | Opt in with `auth login notion --tailscale`, or set `ULTRATHINK_OAUTH_TAILSCALE=1`. Over SSH, `auth login` then adds a temporary `tailscale serve` handler at `https://<host's tailnet name>/ultrathink-oauth/callback` and removes it after login. Open the URL on any device in the same tailnet and the login finishes by itself. Without the opt-in, ultrathink never runs `tailscale`. With the opt-in but outside an SSH session, or when Tailscale isn't running or has no HTTPS certificate for the host, login quietly uses the loopback callback instead. Only a failing `tailscale serve` is reported, with a line saying the Tailscale route could not be set up. |
| Your own callback URL | `--redirect <url>` or `ULTRATHINK_OAUTH_REDIRECT=<url>`. It must be `https`, or `http` only for `127.0.0.1`, `localhost` or `[::1]`, and it must reach the listener on `127.0.0.1:<port>`. `--port <n>` changes the port. |

If `auth status` later shows Notion as not ready, the grant was revoked or expired. Run `auth login notion` again. See also [Set up Notion](how-to/set-up-notion.md).

## Ship is blocked

Ship is opt-in: it does nothing until you set `ship.enabled: true`. `bin/ultrathink-ship` returns `ok: false` with a `reason`. A blocked review returns `blocked: true` and `next: "stop: <reason>"`, plus `status: "blocked"` when Greptile is unusable as configured; when a review or merge loop gives up it also posts a PR comment `ultrathink-ship stopped: <reason>` that lists the last attempts. `bin/ultrathink-ship status --state <stateFile>` then shows `phase: "blocked"`, the `blockedReason` and `attempts`, the log of every review result and merge outcome (newest 50). A blocked PR is left open for a human, and the skill doesn't retry. See [Ship](ship.md) for the flow and [Ship with Greptile](how-to/ship-with-greptile.md) for setup.

| Step | Reason | What to do |
|---|---|---|
| (no nudge) | The Stop or `agent_end` nudge never appears | The nudge needs `ship.enabled: true` (off by default), no `ULTRATHINK_SHIP=0`, a planned prompt that invoked a skill matching `ship.skills` (default `gsd-`), and local git on a feature branch with commits ahead of `origin/<default>`. It fires once per session. `bin/ultrathink status` shows the `Ship:` line. |
| `assess` | `done: false` with `gaps` | The task isn't finished. Finish the gaps and assess again. |
| `assess` | gap `no judge available` | With `autoMerge` on, the rule-only assessment can't pass. The engine must be available (see [Nothing happens](#nothing-happens)). A Jev answer never stands in for the engine judge here either, even with Jev decisions on for `ship`. |
| `assess` | gap `Jev judged the change incomplete (P(complete) <P>)` | Gate mode: the engine judge said done, but Jev's P(complete) was at or below `decisions.shipVetoAtOrBelow` (0.2) on an untruncated patch, so no PR is opened. Treat it like any not-done result: check the request and its acceptance criteria against the diff, finish the missing part and assess again. If Jev is wrong on your kind of change, see [Decisions](#decisions). |
| `assess` | gap `Jev P(complete) <P> is below <shipApproveAt>` | Gate mode with `ship.autoMerge` off and no usable engine verdict: Jev decided (`source: "jev"`) and its P(complete) was below `decisions.shipApproveAt` (0.7). Finish the work and assess again, or fix the engine so the judge can run (see [Nothing happens](#nothing-happens)). |
| `assess` | gap `GSD roadmap found but gsd-tools.cjs was not found; set GSD_TOOLS or rerun assess with --ignore-gsd` | The project has `.planning/ROADMAP.md` from GSD (the Get Shit Done planning workflow), but ship can't find GSD's `gsd-tools.cjs` to read it. It looks for `gsd-core/bin/gsd-tools.cjs` under, in order: the project, `<project>/.claude`, `<project>/.codex`; then `<project>/.claude/get-shit-done/bin/gsd-tools.cjs`; then `gsd-core/bin/gsd-tools.cjs` under `$CLAUDE_CONFIG_DIR` (if set), `~/.claude`, `~/.agents`, `${HERMES_HOME:-~/.hermes}`, `${CODEX_HOME:-~/.codex}`, `${GEMINI_CONFIG_DIR:-~/.gemini}`, `~/.cursor` and `${XDG_CONFIG_HOME:-~/.config}/opencode`; then for `~/.claude/get-shit-done/bin/gsd-tools.cjs`. Set `GSD_TOOLS=/path/to/gsd-tools.cjs`, or pass `--ignore-gsd` to assess without the roadmap. |
| `pr` | `task not assessed as done; run assess first` | Run `assess`. |
| `pr` | `no current branch (detached HEAD?)`, `on base branch <b>; work must be on a feature branch` | Move the work to a feature branch. |
| `pr` | `branch changed since assessment` | Run `assess` again. |
| `pr` | `uncommitted tracked changes: …` | Commit your own changes by explicit path, then retry. |
| `pr` | `could not determine default branch`, `push failed: …`, `create PR failed: …` | Check `gh auth status`, the `origin` remote and push rights. |
| `review` | `status: "blocked"`, ``Greptile is not set up: run `bin/ultrathink-mcp auth set-key greptile --stdin` (or `auth login greptile`), or install and sign in to the greptile CLI (`greptile login`)`` | No Greptile credential is stored, and the `greptile` CLI is missing or signed out. Ship checks this before the first review round, so no round is used up. Set up one of the two, then run `review` again. |
| `review` | `status: "blocked"`, `Greptile account has several organizations; set ship.greptileOrganization in ~/.config/ultrathink/config.json (one of: …)` | Greptile answered `tenant_required`: your account belongs to several organizations and none was chosen. Set `ship.greptileOrganization` to one of the listed ids or handles, then run `review` again. |
| `review` | `local HEAD <sha> differs from PR head <sha>; push your commits (or pull) first` | `git push`, then run `review` again. |
| `review` | `status: "pending"` | Not an error. Run `review` again; it resumes the same Greptile run. |
| `review` | `max rounds reached: …` | `ship.maxRounds` (5) completed reviews below 5/5 or with open threads. Failed and timed-out reviews don't count. A human takes over. |
| `review` | `Greptile review failed: <error>; run review again to re-trigger it (retry k of N)`, `Greptile review timed out; run review again to re-trigger it (retry k of N)` | Not a block. Greptile returned FAILED, ERROR or SKIPPED, no score, the CLI failed, or the review stayed pending past `ship.reviewTimeoutMs`. Run `review` again: it starts a fresh review of the same commit. Up to `ship.reviewRetries` (3) re-triggers per head commit. |
| `review` | `Greptile review failed N times on <sha> (ship.reviewRetries N): <error>`, `Greptile review timed out N times on <sha> (ship.reviewRetries N)` | Greptile failed or timed out more than `ship.reviewRetries` times on the same commit, so the ship is blocked and the PR comment lists the attempts. Check `greptile login` (CLI mode) or the Greptile credential (`bin/ultrathink-mcp auth status`), then run `review` again. |
| `merge` | `autoMerge disabled` | Expected by default: `ship.autoMerge` is off, so ship stops at a passing review and `run` reports `autoMerge disabled: merge manually`. Merge by hand, or set `ship.autoMerge: true`. |
| `merge` | `PR head changed since last review; run review again` | Run `review`. |
| `merge` | `review score N/5 is below 5/5; run review again` | Continue the review loop. |
| `review` or `merge` | `N open review comment(s)` | In PR mode these are the PR's Greptile review threads on GitHub that are neither resolved nor outdated. A fix that changes the flagged line makes its thread outdated. For a finding that isn't actionable (factually wrong, or describing intended behavior), reply on its thread with the reason and resolve it; the `review` output gives each finding's `threadId`, and [Ship](ship.md#fix-loop-and-blocking) has the commands. Never resolve a finding just to pass the gate. If the thread lookup fails (a `gh` error, or more than 100 threads), the gate fails closed and counts every unaddressed Greptile comment on the PR. Fix `gh auth status` and run `review` again. In CLI mode the count is the run's comments. |
| `review` or `merge` | `could not read review threads: <error>` | The PR's review threads couldn't be read from GitHub, so nothing is recorded and the merge is refused. `merge` keeps retrying this within its time (see `run merge again` below). Check `gh auth status`, then run `review` or `merge` again. |
| `merge` | `waiting: true`, `run merge again: <reason> (waited N of 60 min on this commit; it keeps retrying until the PR merges)` | Not an error. The review passed, but CI is pending, GitHub has not computed mergeability, the PR state or threads couldn't be read, GitHub returned a transient error, or branch protection refused with `the base branch policy prohibits the merge` (for example a required approval not given yet), and this call's `ship.waitMs` ran out. Run `merge` again; it keeps retrying the same commit for up to `ship.mergeTimeoutMs` (60 min), so a human can approve in the meantime. Past that it blocks with a PR comment. |
| `merge` | `merge conflicts: resolve them against the base, push, then run review again`, `CI checks failing: fix CI, commit, push, then run review again` | Back to the agent, never merged. Fix the cause, push, then run `review` again. |
| `merge` | `merge still not possible after N min on <sha>: <reason>` | The ship is blocked: the same reviewed commit could not merge within `ship.mergeTimeoutMs`. The PR comment lists the attempts. Fix the cause (for example stuck CI), then run `review` or `merge` again. |
| `merge` | `merge refused by GitHub: <error>` | The ship is blocked: GitHub refused for a reason retrying can't fix, such as missing permission, requested changes or a closed PR. A human acts (grant rights, resolve the requested changes or reopen), then runs `merge` again. |
| `merge` | `PR closed without merge` | The ship is marked blocked. |
| `merge` | `PR was merged outside the ship flow before its review passed` | The ship is blocked and not recorded as a ship merge: the PR was merged (by hand, web UI or another tool) without a passing Greptile review of its head. Review the merged change yourself. Agents must never merge any other way than `bin/ultrathink-ship merge`. |

Resume at any time with `bin/ultrathink-ship status --state <stateFile>`. Every step is idempotent.

## Greptile knowledge base

With `hitl.knowledgeBase: true` (see [Configuration](configuration.md#hitl-clarifying-questions) and [Use the Greptile knowledge base](how-to/use-greptile-knowledge-base.md)), the planner reads the repository's Greptile knowledge base before the clarifying questions. It fails open: whatever goes wrong, you get the same questions as with the key off. The summary after each plan shows what happened, and `bin/ultrathink status` shows the `Knowledge base:` line.

With `ULTRATHINK_DEBUG=1` (Claude Code, Grok Build and Muse), the prompt hook writes one line per lookup to stderr: `greptile knowledge base: <outcome>`, then the documents read or the reason, then the elapsed time, for example `[ultrathink] greptile knowledge base: error · timed out after 20000ms · 20004ms`.

| Symptom | Meaning | What to do |
|---|---|---|
| No `Knowledge` segment in the summary | The key is off, HITL is off (`Knowledge base: on · not read while HITL is off`), or the prompt was not clarified. | Set `hitl.knowledgeBase: true` and turn HITL on (`bin/ultrathink hitl on`). |
| `Knowledge · off (no Greptile login)` | No usable Greptile credential is stored, so Greptile was not contacted. `bin/ultrathink status` shows `Knowledge base: on · no Greptile credential (…)`. | Store one: `bin/ultrathink-mcp auth login greptile`, or `bin/ultrathink-mcp auth set-key greptile --stdin`. `bin/ultrathink-mcp auth status` shows whether it is ready. |
| `Knowledge · none` | Nothing to read: the git remote gives no `owner/repo`, Greptile has no knowledge base for that `owner/repo`, or the knowledge base has no published documents yet. The debug line gives the reason. | Check `git remote get-url origin` names the repository Greptile indexes (for example `acme/widgets`). A new repository needs Greptile to publish its knowledge base first. |
| `Knowledge · error` | A Greptile call failed, the account needs an organization, or a stage ran past its 20-second budget. One selected document that fails to read or times out is enough: the lookup is then `error` as a whole, never used with only some documents. The debug line reads `greptile knowledge base: error · <reason> · <ms>ms`. | For `Greptile account has several organizations; set ship.greptileOrganization …` (Greptile answered `tenant_required`), set `ship.greptileOrganization` to one of the listed ids or handles. A timeout or a failed document read needs no action: the questions were composed exactly as with the feature off. For other errors, check the credential with `bin/ultrathink-mcp auth status`. |
| A question you expected was not asked | The knowledge base settled it. Settled questions are listed in their own `### Settled from the Greptile knowledge base` subsection of the Clarifications (HITL) block as `- [k1] <question> → <answer> (Greptile knowledge base: <document>)`, marked as untrusted evidence the agent checks against the repository (asking you when the repository disagrees), not as your decisions. In the spec they appear as `<ANSWER source="knowledge" evidence="<document>">`. A claim that cites a document that was not read, or is otherwise invalid, is asked as an ordinary question. Product decisions and questions the clarifier marks blocking are always asked, never settled. | If the answer is wrong, say so in your next prompt; settled answers are not carried over to it. To stop settling questions this way, set `hitl.knowledgeBase: false`. |

## Decisions

Jev is always on (see [Configuration](configuration.md#decisions-jev-decisions-openrouter-decisions-api) and [Use Jev decisions](how-to/use-jev-decisions.md)): with a key for the resolved rail, ultrathink asks Jev over OpenRouter or Vercel at the points in `decisions.points`. Every failure fails open: the point behaves exactly as with Decisions off, and the error kind is shown where that point reports:

- plan, knowledge and blocking: the summary segment `Decisions · error (<kind>)`, with `claude.echo` on;
- ship: `decision.error` in the `bin/ultrathink-ship assess` JSON and the pull request line `- Jev: error (<kind>)`;
- every point, with `ULTRATHINK_DEBUG=1`: `[ultrathink] decisions <point> · error (<kind>) · <ms>ms · attempts <n>` on stderr.

None of these show the error message. To see it, run `bin/ultrathink decisions check` from the project directory: it sends one live decision and prints `Decisions check: error (<kind>) · <message> · <ms> ms · attempts <n> · provider <vercel|openrouter> · zdr on|off · key from <source>`, where `<message>` is the redacted one-line error `decisions <kind>: <detail>`. The key is never printed.

| Symptom | Meaning | What to do |
|---|---|---|
| `Decisions: on · no Jev key (…)` | There is no key for the resolved rail, so no point sends a request. `decisions check` prints `Decisions check: no Jev key (…)` and exits 1. | Store a key for the rail you want: `bin/ultrathink-mcp auth set-key vercel --stdin` (or `AI_GATEWAY_API_KEY`), or `bin/ultrathink-mcp auth set-key openrouter --stdin` (or `OPENROUTER_API_KEY`). With `provider: "auto"`, a Vercel key picks the Vercel rail, else the OpenRouter rail is used. |
| `Decisions: off (ULTRATHINK_DECISIONS=0)`, `Decisions check: off (ULTRATHINK_DECISIONS=0)` or `Decisions probe: off (ULTRATHINK_DECISIONS=0)` | `ULTRATHINK_DECISIONS=0` is set in the environment. It turns every point off whatever the config says, and `decisions check` and `decisions probe` send nothing and exit 1. | Unset `ULTRATHINK_DECISIONS` in the host's environment to use Decisions. |
| ` · ULTRATHINK_DECISIONS_URL ignored (must be https://openrouter.ai/… or a loopback URL)` at the end of the `Decisions:` line or the `decisions check` line | `ULTRATHINK_DECISIONS_URL` is set, but it is not an `https://openrouter.ai/…` URL or an `http://` or `https://` URL on `localhost`, `127.0.0.1` or `[::1]`, or it has a user name or password in it. It is ignored, and requests go to the default endpoint. | Point it at `openrouter.ai` or a proxy on this machine, without credentials in the URL, or unset it. |
| `Prompt Uplift · not planned: Jev judged this is not new multi-step work (<P>) · start with uplift: to plan it` | Jev's P(`plan_worthy`) was below `decisions.planSkipBelow` (0.2), so the message went to the agent unplanned, exactly like a skipped short reply. Nothing was written to the state directory. | Resend it with `uplift:` in front to plan it. If Jev skips messages you want planned, lower `decisions.planSkipBelow`, or remove `plan` from `decisions.points`. Check with `bin/ultrathink decisions probe plan <cases.json>`. |
| `error (auth)`: `decisions auth: HTTP 401: …` (OpenRouter answers `User not found.` for an unknown key) or HTTP 403 | The rail refused the request: a rejected key on most rails, or missing purchased credits on the Vercel rail (see right). Not retried. | Store a valid key for the rail in use (check the `provider` segment): `bin/ultrathink-mcp auth set-key vercel --stdin` or `bin/ultrathink-mcp auth set-key openrouter --stdin`. A stored key wins over the environment key on its rail, so a stale stored key hides a good environment key: check the status line's `key from …`, and remove the stored one with `bin/ultrathink-mcp auth logout <provider>`. Exception: on the Vercel rail, HTTP 403 `Free tier users do not have access to this model` for `typesafe-ai/jev` is not a key problem — Jev needs purchased AI Gateway credits, and the free-tier allowance does not unlock it. Add credits on the AI Gateway page ([pricing](https://vercel.com/docs/ai-gateway/pricing)); Jev calls cost fractions of a cent, so a small top-up lasts a long time. |
| `error (credits)`: `decisions credits: HTTP 402: …` | The rail's account has too few credits. Not retried. | Add credits in your Vercel or OpenRouter account. One OpenRouter decision costs about $0.000019. |
| `error (timeout)`: `decisions timeout: no answer within 3000 ms` (the number is `decisions.timeoutMs`), or a final HTTP 408 | No answer within the budget, retry included. | Nothing, if it is rare. On a slow network raise `decisions.timeoutMs` (for example to `5000`; values above `30000` are ignored); planning and ship wait up to that long for Jev. |
| `error (rate-limit)`: `decisions rate-limit: HTTP 429: …` | The rail throttled the request; it was retried once when the budget allowed. | Nothing, if it is rare. Otherwise wait, or ask Jev at fewer points (`decisions.points`). |
| `error (upstream)`: `decisions upstream: HTTP <status>: …` | The rail or the model provider failed. 500, 502, 503, 524 and 529 are retried once when the budget allows. | Nothing: the point ran as with Decisions off. Try `decisions check` later. |
| `error (network)`: `decisions network: <reason>` | The request did not reach the rail (DNS, proxy, no network), or the server answered with a redirect, which is never followed; retried once when the budget allowed. | Check the machine's network, and that `ULTRATHINK_DECISIONS_URL`, if set, points at a reachable server. |
| `error (invalid-response)`: `decisions invalid-response: <rule>`, for example `decisions invalid-response: answers.plan_worthy.noul must be a finite number in [0, 1]` | The answer did not pass the strict check: a missing or extra answer key, a wrong type, a value out of range, or a body that is not JSON. It is never read as 0. The Decisions API is alpha, and its shape may change. | Run `decisions check`. If it persists, pin `decisions.model` to `typesafe/jev-1.13` and report it with the `decisions check` line. |
| `error (too-large)`: `decisions too-large: request is about <n> tokens (limit 28000)`, or HTTP 413 | The state was over the size limit, so nothing was sent (or the rail refused it). Most often a ship check with a very long original prompt. | Nothing: that point ran as with Decisions off. |
| `error (bad-request)`: `decisions bad-request: HTTP 400: …` or `HTTP 404: …` | The rail refused the request, often because of an unknown `decisions.model`. Not retried. | Check `decisions.model` (`~typesafe/jev-latest` or `typesafe/jev-1.13`), then run `decisions check`. |
| Ship: `- Jev: P(complete) <P> · <model> · veto` in the PR body's assessment, or a veto gap from `assess` | See the `assess` rows in [Ship is blocked](#ship-is-blocked). With `ship.judge: "advisory"` the line reads `- Jev: P(complete) <P> · <model> · veto (advisory: shipped anyway)` and the PR opened anyway. | Finish the missing work. If Jev vetoes complete changes of your kind, lower `decisions.shipVetoAtOrBelow` after probing your cases with `bin/ultrathink decisions probe ship <cases.json>`, or remove `ship` from `decisions.points`. |
| A question you expected the knowledge base to settle was asked or is missing, or a question became blocking | Jev's P(`supported`) was below `decisions.groundedAt` (0.8), so the settled answer was taken back: it is asked after the clarifier's own questions while fewer than `hitl.maxQuestions` are open, and dropped (neither settled nor asked) when no slot is left; or its P(`risky`) was at or above `decisions.blockingAt` (0.5), so the question is asked before work starts. The summary shows `Decisions · knowledge <kept>/<n> kept` and `Decisions · blocking <promoted>/<n> promoted`. | Answer the question. To change how often it happens, tune `groundedAt` or `blockingAt` after probing with `decisions probe knowledge` or `decisions probe blocking`. |

## Hindsight

Hindsight is opt-in. See [Configuration](configuration.md#hindsight-memory-server) and [Connect Hindsight](how-to/connect-hindsight.md) (`docs/how-to/connect-hindsight.md`). `bin/ultrathink hindsight check` exits 0 when `/health` reports healthy, 1 when the integration is not ready or the probe fails, and 2 on a usage error.

| Symptom | Meaning | What to do |
|---|---|---|
| `Hindsight: off (opt-in: set hindsight.enabled)` | The default. A project file cannot turn it on. | Set `hindsight.enabled: true` in `~/.config/ultrathink/config.json`, with `url` and `bank`. |
| `Hindsight: off (ULTRATHINK_HINDSIGHT=0)` | The exact string `0` is set. No request is made. | Unset `ULTRATHINK_HINDSIGHT` in the host's environment. |
| `Hindsight: on · no URL (set hindsight.url or HINDSIGHT_API_URL)` | Enabled, but neither the config URL nor `HINDSIGHT_API_URL` is set. | Set `hindsight.url` in a user file, or set `HINDSIGHT_API_URL`. Do not put a production URL in a project file: it is ignored. |
| `Hindsight: on · bad URL (<reason>)` | The URL was refused. `http` is allowed only for `localhost`, `127.0.0.1`, `[::1]`, `*.ts.net` and `100.64.0.0/10`. A user name, password, query or fragment is refused. | Fix the URL. The status line shows the reason and never the key. |
| `Hindsight: on · no key (run bin/ultrathink-mcp auth set-key hindsight --stdin, or set HINDSIGHT_API_KEY)` | No stored `hindsight` key, and `HINDSIGHT_API_KEY` is empty. | Run the command the line names. `HINDSIGHT_API_TOKEN` is also accepted, after the stored key and `HINDSIGHT_API_KEY`. A stored key wins. |
| `Hindsight check: error (auth)` | The server rejected the key. | Store a valid key with the command the status line names. `bin/ultrathink-mcp auth logout hindsight` removes a stale stored key that hides a good environment key. |
| Lessons are not retained, or a retain times out | The server has no LLM, and a mode other than `chunks` would call one. | Leave the bank in `chunks` mode. The client sets `retain_extraction_mode` to `chunks` itself. Do not enable verbatim or reflect. |

`--roundtrip` proves retain, recall and delete in a throwaway `ultrathink-smoke-*` bank and then deletes that bank. It does not touch the configured bank. A failed step still runs the cleanup steps.

## RAGFlow

RAGFlow is opt-in. See [Configuration](configuration.md#ragflow-document-search) and [Connect RAGFlow](how-to/connect-ragflow.md) (`docs/how-to/connect-ragflow.md`). `bin/ultrathink ragflow check` exits 0 when the datasets probe answers, 1 when not ready or the probe fails, and 2 on a usage error.

Never probe `/system/healthz`, `/v1/system/healthz` or `/api/v1/system/healthz`. On a deployment whose object storage is down, that route can block the API worker for minutes. The client does not call it. Health is the datasets probe the client uses: `GET /api/v1/datasets?page=1&page_size=1`, which is what `bin/ultrathink ragflow check` runs. `datasets` lists what the key can see. `search "<question>"` retrieves chunks.

| Symptom | Meaning | What to do |
|---|---|---|
| `RAGFlow: off (opt-in: set ragflow.enabled)` | The default. A project file cannot turn it on or turn `ground` on. | Set `ragflow.enabled` in a user file. Set `ground` only if plans should include excerpts. |
| `RAGFlow: off (ULTRATHINK_RAGFLOW=0)` | That variable is `0` (whitespace around it is trimmed). | Unset it. |
| `RAGFlow: on · no key (run bin/ultrathink-mcp auth set-key ragflow --stdin, or set RAGFLOW_API_KEY)` | No stored `ragflow` key, and `RAGFLOW_API_KEY` is empty. | Run the command the line names. A stored key wins over `RAGFLOW_API_KEY`. |
| `RAGFlow check: error (auth)` | The server rejected the key (HTTP 401/403, or body code 109/108). | Store a valid key with the command the status line names. |
| No `Docs` segment in the summary | `ragflow.ground` is off, RAGFlow is not ready, or the lookup found nothing. Grounding fails open: the plan is unchanged. | Turn `ground` on in a user file, then `bin/ultrathink ragflow check`. `Docs · error (<reason>)` names the failure; nothing else to do for one failed lookup. |

## Teachable Moments

On by default (`enabled`, `auto` capture, auto-promote). See [Configuration](configuration.md#teach-teachable-moments) and [Use Teachable Moments](how-to/use-teachable-moments.md) (`docs/how-to/use-teachable-moments.md`). On Hermes, see [Teachable Moments on Hermes](how-to/teachable-moments-on-hermes.md) (`docs/how-to/teachable-moments-on-hermes.md`).

State is `<stateDir>/teach/` (`moments/`, `outbox/`, `inbox/`, `skill-drafts/`). `ULTRATHINK_STATE_DIR` overrides the state directory and is ignored when it points into `.planning`. Nothing is written into `<cwd>/.planning`.

| Symptom | Meaning | What to do |
|---|---|---|
| `Teach: off (opt-in: set teach.enabled)` | Off: a user file set `enabled: false` (a project file's `enabled: true` cannot override that). | Remove the `false`, or set `teach.enabled: true` in `~/.config/ultrathink/config.json`. |
| `Teach: off (ULTRATHINK_TEACH=0)` | Enabled, and the exact string `0` is set. Mutating `teach` commands exit 1. | Unset `ULTRATHINK_TEACH`. |
| `Teach: on · … · Hindsight no key` | Lessons stay local. A retain is not attempted. | Fix the `Hindsight:` line. The word after `Hindsight` is `ready`, `off`, `no URL`, `bad URL` or `no key`. |
| `retain queued` | The local file was written. Hindsight did not take it. The outbox retries (1 minute, doubling, capped at 6 hours). | `bin/ultrathink teach sync` after Hindsight is ready. A failure does not block the caller. |
| `promote --due` lists nothing you expected | The moment is not confirmed, occurrences are below `teach.promoteAfter` (unless kind is `playbook`), or Jev's P(`skillworthy`) was below `skillworthyAt`. | Confirm it, or `teach promote <id>` which does not ask `skillworthy`. A last line `Jev skipped <n> moment(s): not worth a standing skill.` is that gate. |
| Hermes skill did not appear under `~/.hermes/skills` | ultrathink never writes that directory. `--install --target hermes` only drafts under `<stateDir>/teach/skill-drafts/`. | Install through Hermes `skill_manage`, so `skills.write_approval` applies, then `teach promote <id> --mark-promoted --skill <name> --target hermes`. |

## Redaction

Before a lesson is stored or sent, `Bearer` plus a token is redacted only when the token looks like a credential. `Bearer` plus a short English word is left as prose: `the Bearer key` and `Bearer token rotation` stay. A token is replaced with `[redacted]` when it is at least 16 characters, or at least 6 characters and contains a digit. Trailing dots stay after `[redacted]`. A short word with no digit, such as `Bearer token`, is not a credential.

The same pass redacts PEM private keys, URL userinfo, assignment-shaped secrets, and home-directory paths that are outside the repository. The replacement `[redacted]` matches no pattern, so running it again changes nothing. A redaction failure yields `[redacted]` rather than the original text.

## Claude Code

- The hooks come from `hooks/hooks.json`: `UserPromptSubmit`, `PostToolUse` (`AskUserQuestion`, `Bash`, PR-creation tools) and `Stop`. They run through `bin/run-bun`.
- `bun <clone>/scripts/setup.ts status` reports whether Claude Code has MCP servers named exactly `notion` and `linear` (a server with a similar name or URL doesn't count), the `CLAUDE.md` block that `apply` manages, and the Grok rule and hooks. Without the `claude` CLI on `PATH`, it prints `Claude Code: claude CLI not found` followed by the Grok lines, and `apply` skips the Claude steps with a notice and still installs the Grok hooks and rule.
- Commands appear as `/ultrathink-<verb>` and `/ultrathink:ultrathink-<verb>`. If a control command produces a model turn that runs `bin/ultrathink`, the hook didn't run. Check that the plugin is installed and enabled.
- For `claude -p` automation that shouldn't be planned, set `ULTRATHINK_UPLIFT=0`.

## Grok Build

- **Skills and commands missing.** Grok installs plugins disabled. Run `grok plugin enable ultrathink`, then check that `grok plugin list` shows it as enabled.
- **Plugin hooks are not dispatched.** Grok loads the plugin directory's skills and commands but doesn't run its `hooks/hooks.json`. Run `bun <clone>/scripts/setup.ts apply` to install the hook file `${GROK_HOME:-~/.grok}/hooks/ultrathink.json` and the rule `${GROK_HOME:-~/.grok}/rules/ultrathink.md`. This works without the `claude` CLI installed. `bun <clone>/scripts/setup.ts status` reports `Grok rule:` and `Grok hooks:` as `installed` or `missing`.
- **Moved the clone?** The hook file holds absolute paths, so planning stops after a move. Run `apply` again from the new location. See [Upgrade and move](how-to/upgrade-and-move.md#move-the-clone-to-another-directory).
- **Timeout.** Grok's default `UserPromptSubmit` timeout is 30 s, too short for a plan. The installed hook file sets 600 s. A plan that takes longer is dropped.
- **Stdout is discarded.** Grok throws away the stdout of a hook that allows the prompt, so the context never reaches the model that way. The plan goes to `last-plan.json` in the Grok state directory: `$GROK_PLUGIN_DATA/ultrathink/` if set, otherwise `${GROK_HOME:-~/.grok}/plugin-data/ultrathink/`. `apply` merges the ultrathink block into the rule and keeps any other text in that file. The rule tells the model to read the carrier, the spec it points to, and then `ultrathink-plan` and `ultrathink-kickoff`. If the model ignores the plan, check that the rule file contains the `<!-- ultrathink:start -->` block, and read `last-plan.json` to confirm a plan was written for this session.
- **No `last-plan.json`.** The file exists only for a prompt ultrathink planned. It is deleted on every prompt that isn't planned: `/ultrathink-quick`, control commands, skipped or trivial prompts, planning turned off, and `ULTRATHINK_UPLIFT=0`. A missing file means there is no plan for the current prompt, and the rule tells the model not to reuse an earlier one. If you expected a plan, see [Nothing happens](#nothing-happens).
- **Control commands** return a block decision from the hook. Grok blocks the prompt and shows the reply.
- If a turn looks planned twice, a per-turn claim in `<state dir>/claims/` should prevent it. Make sure only one ultrathink hook file is installed.

## Muse Code

- **Approve the hooks.** Skills and commands are active once the plugin is enabled, but hooks need review: `muse plugins approve ultrathink`. `muse plugins inspect ultrathink` should list `plugin:ultrathink:hook:user-prompt-submit`, `post-tool-use` and `stop` as `status=trusted_enabled`.
- **Symlink error.** Muse refuses plugin directories that contain symlinks:

  ```text
  plugin contains symlink entries and cannot be installed; replace symlinks with regular files
  ```

  The usual culprit is `node_modules/.bin`. Install from a clean clone without `node_modules`, or remove `node_modules`, before `muse plugins install <clone> --scope user`.
- **Multiple manifests.** `muse plugins validate <clone>` reports `diagnostic=multiple-manifests severity=warning … selected .muse-plugin/plugin.json; ignoring .claude-plugin/plugin.json`. This is expected: the clone carries manifests for several hosts, and Muse picks its own.
- **Updates.** Muse runs a cached copy of the plugin, refreshed from the directory it was installed from — not necessarily the clone you develop in. After pulling changes, sync them into the install source first (or reinstall from your clone), then run `muse plugins update ultrathink`. A stale install shows up as plans that never use the new code: on the muse host, every summary shows `fallback` with the bare `claude:sonnet` label even though the repo has the Muse engine — once you have ruled out an explicitly selected Claude engine, as in [Every plan shows fallback](#every-plan-shows-fallback). `muse plugins inspect ultrathink` prints the active cache path; check it contains the new files (for example `src/muse`). If the hook definitions changed, they may need `muse plugins approve ultrathink` again.

## Hermes Agent

- **Check that the plugin loads.** `hermes plugins doctor ultrathink` should print `OK: runtime discovery, manifest parsing, import, and registration passed`. `hosts/hermes/plugin.yaml` lists `pre_llm_call`, `transform_tool_result`, `post_tool_call`, `pre_verify`, `subagent_start`, `post_llm_call` and `on_session_finalize`, plus the tools `ultrathink_lesson_save` and `ultrathink_lesson_recall`. The commands `/ultrathink-learn` and `/ultrathink-lessons` and the skill `ultrathink-teach` are registered in code. Nothing is written to `~/.hermes/skills`; Hermes `skill_manage` is the install path. Lessons live under the Hermes state directory's `teach/`, never `<cwd>/.planning`. See [Teachable Moments](#teachable-moments).
- **Check the hook cap and the warnings.** `hermes config get plugins.hook_callback_timeout` should print at least 105; 600 is recommended. Search `${HERMES_HOME:-~/.hermes}/logs/agent.log` for lines starting with `ultrathink:`. See [Hermes: the plan never arrives](#hermes-the-plan-never-arrives) for what each warning means, including the missing-engine warning for a copied plugin directory.
- **One planner.** If another plugin also plans prompts before the model call, disable it, or both will plan the same turn.
- **Gateway injection.** `/ultrathink-quick <message>` sends the message through `inject_message`. In gateways this needs `plugins.entries.ultrathink.allow_gateway_injection: true` in the Hermes config. Without it, the command falls back to skipping your next message and replies `Ultrathink will not plan your next message. Send it now (or prefix any message with raw:).`
- **Command names in chat apps.** The commands are registered with hyphens (`ultrathink-status`) because chat menus accept only a restricted character set, and one colon name stops Discord from listing the commands after it. Telegram menus show them with underscores: `ultrathink_status`, `ultrathink_quick` and so on.
- **Timeout.** The planner subprocess runs for at most `min(540, cap − 15)` seconds, where the cap is `plugins.hook_callback_timeout`. `ULTRATHINK_HERMES_TIMEOUT` replaces the 540. On the deadline the whole Bun process group is killed. Below a 105 s cap the planner doesn't run at all. Control commands time out after 20 s.
- **Skipped before Bun.** Cron runs, sessions with a parent session, empty prompts, prompts that start with `/`, and already uplifted ultrathink XML are never sent to the engine. The engine then skips a bare skill scaffold with no task, and a prompt that references an existing graph as `graph ut-<id>-<8 hex>` unless it starts with `uplift:`.
- **No rows from the hook.** On Hermes the planner creates no Notion or Linear rows. `ultrathink-kickoff` creates them at the start of the agent's turn with `ultrathink-mcp track complete --state <file>`, so rows appear only once the agent has run kickoff.

## Omp

- **30 s handler cap.** Omp stops waiting on `before_agent_start` handlers after 30 s. ultrathink waits 25 s. A plan that isn't ready by then is replaced by a pending note, which tells the model to only read and investigate until the plan arrives. The plan then comes as an `aside` message at the next step boundary. While it is pending the status bar shows `→ plan arrives as aside`, then the plan summary once it is delivered. This is normal for large prompts.
- **Asides that never arrive.** The engine run is capped at 10 minutes. If it fails or produces nothing, a short note says so, and the model proceeds with the request as written.
- **Superseded plans.** If you send a newer prompt in the same session before a deferred plan finishes, the older plan is dropped and not delivered, so it can't steer the newer request. The status bar shows `superseded by a newer prompt`. Every submission is planned, including an identical resend. Only Omp's own re-runs of the same submission reuse the plan already in flight.
- **No status bar.** The bar, live graph and plan cards render only in the TUI (`mode: "tui"`). RPC, print and JSON modes plan the same way without the chrome.
- **Not planned.** Task-subagent sessions, and a top-level `omp -p --no-session` run, are treated as subagents and never planned.
- `omp plugin link <clone>` loads `src/host/omp.ts` through `package.json` `omp.extensions`. `omp plugin list` should show `ultrathink`.
- **Stale extension after an update.** The extension — session-model routing, the status bar, the plan cards — loads from the linked clone when the Omp session starts; pulling the clone does not refresh running sessions. After updating, restart your Omp sessions: re-running `omp plugin link <clone>` only matters when the clone moved. `omp plugin list` shows the linked version (`ultrathink@0.4.0`), not what a running session loaded — confirm the session itself picked the update up by the plan's engine label (the session's own model means the new routing is active). A session started before the update keeps planning on the old code: for example, on Claude instead of the session's Muse model, with a short boilerplate graph when Claude is out of credits.

## Uninstalling

See [Uninstall](how-to/uninstall.md). It covers each host, `scripts/setup.ts rollback`, `scripts/mcp-register.ts --remove`, the credential store, config files, state directories and the Hermes hook cap.
