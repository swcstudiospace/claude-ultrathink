# Troubleshooting

ultrathink fails open. When something is wrong, your prompt still goes through, with less planning or none. So most problems look like "the plan didn't appear" or "the rows didn't appear". Start with the [first checks](#first-checks), then look up the symptom or the host.

In the commands below, `<clone>` is the absolute path of your checkout. Paths written as `${NAME:-default}` use the environment variable when you set it, and the default otherwise.

- [First checks](#first-checks)
- By symptom: [Nothing happens](#nothing-happens) · [My control command printed nothing](#my-control-command-printed-nothing) · [Every plan shows fallback](#every-plan-shows-fallback) · [bun not found](#bun-not-found) · [Grok shunt gateway not configured](#grok-shunt-gateway-not-configured) · [The plan is slow or cut off](#the-plan-is-slow-or-cut-off) · [Hermes: the plan never arrives](#hermes-the-plan-never-arrives) · [Tracking rows don't appear](#tracking-rows-dont-appear) · [Linear rate limit](#linear-rate-limit) · [Notion OAuth over SSH](#notion-oauth-over-ssh) · [Ship is blocked](#ship-is-blocked)
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
Model: sonnet · concurrency 3
State: ~/.claude/ultrathink
```

From a plain terminal it reports on Claude Code. Set `ULTRATHINK_HOST` to check another host: `ULTRATHINK_HOST=grok-build`, `hermes`, `muse` or `omp`.

What the less obvious lines mean:

| Line | Meaning |
|---|---|
| `Grok: …` | The Grok engine's settings. They matter only when `Engine:` shows a Grok model. |
| `SuperGrok OAuth: …` | Whether the Grok Build CLI is logged in: ultrathink reads the session that `grok login` saved in `auth.json` in the Grok home (`grok.home`, else `$GROK_HOME`, else `~/.grok`), and asks the `grok` CLI to refresh it when it has expired. It matters only when the engine is Grok with the `http` or `cli` transport. With the default Claude engine, `not logged in (run grok login)` is expected and harmless. With `transport shunt` the line reads `not used (shunt gateway owns upstream auth)`. |
| `Tracking: …`, `Notion: …`, `Linear team: …` | See [Tracking rows don't appear](#tracking-rows-dont-appear). |
| `Substrate: …` | The optional Agent Substrate brief. It is off unless you set `substrate.url` or `SUBSTRATE_URL`; `SUBSTRATE_DISABLED=1` turns it off again. |
| `Ship: …` | The PR, review and merge loop. Off unless you set `ship.enabled`; `ULTRATHINK_SHIP=0` turns it off for that shell. When on, it shows whether `autoMerge` and `deleteBranch` are on. |

After each planned prompt, hosts that show the summary (`claude.echo`, on by default) print one line such as `Prompt Uplift · UPLIFTED_PROMPT · llm · claude:sonnet · Graph of Thought · 6 nodes · Tracking · 6 issues · 18 sub-issues linked · 41.2s`. A `fallback` source means the engine call failed, and an `Engine error · …` segment shows the first error.

## Nothing happens

No summary, no plan, and the agent answers the raw prompt.

1. **Check the state.** Run `bin/ultrathink status` for the right host. `Prompt Uplift off` means planning was turned off; `/ultrathink-on` turns it back on. `(skipping next prompt)` means a skip is armed.
2. **Check that the prompt is one ultrathink plans.** Trivial acknowledgements (`ok`, `lgtm`, …), built-in slash commands, `raw:` prompts, subagent sessions and ultrathink's own skills are skipped on purpose. See [Commands](commands.md#prompt-prefixes-and-automatic-skips). `uplift: <prompt>` forces planning.
3. **Check the environment.** `ULTRATHINK_UPLIFT=0` in the host's environment turns planning off for the whole process.
4. **Check the engine.** With `Engine: grok…` and `SuperGrok OAuth: not logged in` or `expired`, every prompt is skipped with ``Prompt Uplift skipped · Grok 4.7 login required (run `grok login`)``. Run `grok login`, switch back with `bin/ultrathink grok engine claude`, or set `grok.fallbackToClaude: true`. With the `shunt` transport, see [Grok shunt gateway not configured](#grok-shunt-gateway-not-configured). If the summary shows `fallback`, the engine call failed. The default Claude engine runs `claude -p`, so the `claude` binary (`claude.bin`) must be on the host's `PATH` and logged in, on every host that uses it.
5. **Check Bun.** A hook that can't find Bun lets the prompt through without a word to the agent. See [bun not found](#bun-not-found).
6. **Run the hook by hand with debug logging.** On Claude Code, Grok and Muse the prompt hook is `hooks/uplift.ts`. `ULTRATHINK_DEBUG=1` makes it log each skip reason and failure to stderr:

   ```sh
   cd <your project>
   printf '%s' '{"hook_event_name":"UserPromptSubmit","session_id":"debug","cwd":"'"$PWD"'","prompt":"add a health check endpoint"}' \
     | ULTRATHINK_DEBUG=1 ULTRATHINK_TRACK=0 <clone>/bin/run-bun <clone>/hooks/uplift.ts
   ```

   Lines such as `[ultrathink] skipped: slash-command`, `[ultrathink] uplift failed: …` or `[ultrathink] tracking failed: …` name the cause. Stdout is the JSON the host would receive. `ULTRATHINK_TRACK=0` keeps the test from creating rows. The run does call the engine, and it writes a `debug` session into the Claude Code state directory.

   Hermes and Omp use `hooks/engine.ts`, whose JSON response has a `skipped` field with the reason (`child-or-disabled`, `parent-session`, `cron`, `empty`, `subagent`, `ultrathink-command`, `slash-command`, `ultrathink-skill`, `skill-preamble` (Hermes: a skill loaded with no task), `precheck-skip` (trivial, already uplifted, planning off or an armed skip), `precheck-passthrough` (a `raw:` prompt), `uplift-failed`, `engine-error`, or the Grok login message):

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

Every summary line shows `fallback` as the source (often with an `Engine error · …` segment), and no rows are created.

- **Claude engine: update the `claude` CLI.** The Claude engine runs `claude -p` with `--tools ""`, `--strict-mcp-config` and `--exclude-dynamic-system-prompt-sections`. A CLI too old to know these flags fails every call, so every plan falls back. Claude Code 2.1.278 is the tested version; update to it or later, and check that `claude.bin` (default `claude`) is the binary on the host's `PATH` and that it is logged in.
- **Grok engine:** check the login (`SuperGrok OAuth:` in `bin/ultrathink status`) or, for `shunt`, see [Grok shunt gateway not configured](#grok-shunt-gateway-not-configured).

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
| `ultrathink: this Hermes does not report its plugin hook cap, so ultrathink uses plugins.hook_callback_timeout = <n> from <path>/config.yaml; prompts are planned only when the cap is at least 105s (…)` | Your Hermes version doesn't tell plugins its cap, so the planner read it from `${HERMES_HOME:-~/.hermes}/config.yaml`. | Nothing, if `<n>` is 105 or more. Otherwise raise the cap. |
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

Ship is opt-in: it does nothing until you set `ship.enabled: true`. `bin/ultrathink-ship` returns `ok: false` with a `reason`. A blocked review returns `blocked: true` and `next: "stop: <reason>"`, plus `status: "blocked"` when Greptile is unusable as configured; after a failed review loop it also posts a PR comment `ultrathink-ship stopped: <reason>`. `bin/ultrathink-ship status --state <stateFile>` then shows `phase: "blocked"` and the `blockedReason`. A blocked PR is left open for a human, and the skill doesn't retry. See [Ship](ship.md) for the flow and [Ship with Greptile](how-to/ship-with-greptile.md) for setup.

| Step | Reason | What to do |
|---|---|---|
| (no nudge) | The Stop or `agent_end` nudge never appears | The nudge needs `ship.enabled: true` (off by default), no `ULTRATHINK_SHIP=0`, a planned prompt that invoked a skill matching `ship.skills` (default `gsd-`), and local git on a feature branch with commits ahead of `origin/<default>`. It fires once per session. `bin/ultrathink status` shows the `Ship:` line. |
| `assess` | `done: false` with `gaps` | The task isn't finished. Finish the gaps and assess again. |
| `assess` | gap `no judge available` | With `autoMerge` on, the rule-only assessment can't pass. The engine must be available (see [Nothing happens](#nothing-happens)). |
| `assess` | gap `GSD roadmap found but gsd-tools.cjs was not found; set GSD_TOOLS or rerun assess with --ignore-gsd` | The project has `.planning/ROADMAP.md` from GSD (the Get Shit Done planning workflow), but ship can't find GSD's `gsd-tools.cjs` to read it. It looks for `gsd-core/bin/gsd-tools.cjs` under, in order: the project, `<project>/.claude`, `<project>/.codex`, `$CLAUDE_CONFIG_DIR` (if set), `~/.claude`, `~/.agents`, `${HERMES_HOME:-~/.hermes}`, `${CODEX_HOME:-~/.codex}`, `${GEMINI_CONFIG_DIR:-~/.gemini}`, `~/.cursor` and `${XDG_CONFIG_HOME:-~/.config}/opencode`; then for `~/.claude/get-shit-done/bin/gsd-tools.cjs`. Set `GSD_TOOLS=/path/to/gsd-tools.cjs`, or pass `--ignore-gsd` to assess without the roadmap. |
| `pr` | `task not assessed as done; run assess first` | Run `assess`. |
| `pr` | `no current branch (detached HEAD?)`, `on base branch <b>; work must be on a feature branch` | Move the work to a feature branch. |
| `pr` | `branch changed since assessment` | Run `assess` again. |
| `pr` | `uncommitted tracked changes: …` | Commit your own changes by explicit path, then retry. |
| `pr` | `could not determine default branch`, `push failed: …`, `create PR failed: …` | Check `gh auth status`, the `origin` remote and push rights. |
| `review` | `status: "blocked"`, ``Greptile is not set up: run `bin/ultrathink-mcp auth set-key greptile --stdin` (or `auth login greptile`), or install and sign in to the greptile CLI (`greptile login`)`` | No Greptile credential is stored, and the `greptile` CLI is missing or signed out. Ship checks this before the first review round, so no round is used up. Set up one of the two, then run `review` again. |
| `review` | `status: "blocked"`, `Greptile account has several organizations; set ship.greptileOrganization in ~/.config/ultrathink/config.json (one of: …)` | Greptile answered `tenant_required`: your account belongs to several organizations and none was chosen. Set `ship.greptileOrganization` to one of the listed ids or handles, then run `review` again. |
| `review` | `local HEAD <sha> differs from PR head <sha>; push your commits (or pull) first` | `git push`, then run `review` again. |
| `review` | `status: "pending"` | Not an error. Run `review` again; it resumes the same Greptile run. |
| `review` | `max rounds reached: …` | `ship.maxRounds` (5) rounds without passing. A human takes over. |
| `review` | `review failed twice for <sha>: …`, `review timeout twice for <sha>: …` | Greptile failed or timed out twice on the same commit. Check `greptile login` (CLI mode) or the Greptile credential (`bin/ultrathink-mcp auth status`). |
| `merge` | `autoMerge disabled` | Expected by default: `ship.autoMerge` is off, so ship stops at a passing review and `run` reports `autoMerge disabled: merge manually`. Merge by hand, or set `ship.autoMerge: true`. |
| `merge` | `PR head changed since last review; run review again` | Run `review`. |
| `merge` | `review score N/5 is below 5/5`, `no review has run` | Continue the review loop. |
| `review` or `merge` | `N open review comment(s)` | In PR mode these are the PR's Greptile review threads on GitHub that are neither resolved nor outdated. A fix that changes the flagged line makes its thread outdated. For a finding that isn't actionable (factually wrong, or describing intended behavior), reply on its thread with the reason and resolve it; the `review` output gives each finding's `threadId`, and [Ship](ship.md#fix-loop-and-blocking) has the commands. Never resolve a finding just to pass the gate. If the thread lookup fails (a `gh` error, or more than 100 threads), the gate fails closed and counts every unaddressed Greptile comment on the PR. Fix `gh auth status` and run `review` again. In CLI mode the count is the run's comments. |
| `review` or `merge` | `could not read review threads: <error>` | The PR's review threads couldn't be read from GitHub, so nothing is recorded and the merge is refused. Check `gh auth status`, then run `review` again. |
| `merge` | `merge conflicts`, `GitHub has not computed mergeability yet`, `CI checks failing`, `CI checks pending` | Resolve on GitHub, or wait and retry. |
| `merge` | `PR closed without merge` | The ship is marked blocked. |

Resume at any time with `bin/ultrathink-ship status --state <stateFile>`. Every step is idempotent.

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
- **Updates.** Muse runs a cached copy of the plugin. After pulling changes into the clone, run `muse plugins update ultrathink`. If the hook definitions changed, they may need `muse plugins approve ultrathink` again. `muse plugins inspect ultrathink` shows their status.

## Hermes Agent

- **Check that the plugin loads.** `hermes plugins doctor ultrathink` should print `OK: runtime discovery, manifest parsing, import, and registration passed`, with 6 hooks registered.
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

## Uninstalling

See [Uninstall](how-to/uninstall.md). It covers each host, `scripts/setup.ts rollback`, `scripts/mcp-register.ts --remove`, the credential store, config files, state directories and the Hermes hook cap.
