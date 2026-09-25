# Troubleshooting

ultrathink fails open. When something is wrong, your prompt still goes through, with less planning or none. So most problems look like "the plan didn't appear" or "the rows didn't appear". Start with the [first checks](#first-checks), then look up the symptom or the host.

- [First checks](#first-checks)
- By symptom: [Nothing happens](#nothing-happens) · [My control command printed nothing](#my-control-command-printed-nothing) · [bun not found](#bun-not-found) · [The plan is slow or cut off](#the-plan-is-slow-or-cut-off) · [Hermes: the plan never arrives](#hermes-the-plan-never-arrives) · [Tracking rows don't appear](#tracking-rows-dont-appear) · [Linear rate limit](#linear-rate-limit) · [Notion OAuth over SSH](#notion-oauth-over-ssh) · [Ship is blocked](#ship-is-blocked)
- By host: [Claude Code](#claude-code) · [Grok Build](#grok-build) · [Muse Code](#muse-code) · [Hermes Agent](#hermes-agent) · [Omp](#omp)
- [Uninstalling](#uninstalling)

## First checks

`bin/ultrathink status` (or `/ultrathink-status` inside the agent) prints the full state for one host:

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
Model: sonnet · concurrency 3
State: ~/.claude/ultrathink
```

From a plain terminal it reports on Claude Code. Set `ULTRATHINK_HOST` to check another host: `ULTRATHINK_HOST=grok-build`, `hermes`, `muse` or `omp`.

After each planned prompt, hosts that show the summary (`claude.echo`, on by default) print one line such as `Prompt Uplift · UPLIFTED_PROMPT · llm · claude:sonnet · Graph of Thought · 6 nodes · Tracking · 6 issues · 18 sub-issues linked · 41.2s`. A `fallback` source means the engine call failed, and an `Engine error · …` segment shows the first error.

## Nothing happens

No summary, no plan, and the agent answers the raw prompt.

1. **Check the state.** Run `bin/ultrathink status` for the right host. `Prompt Uplift off` means planning was turned off; `/ultrathink-on` turns it back on. `(skipping next prompt)` means a skip is armed.
2. **Check that the prompt is one ultrathink plans.** Trivial acknowledgements (`ok`, `lgtm`, …), built-in slash commands, `raw:` prompts, subagent sessions and ultrathink's own skills are skipped on purpose. See [Commands](commands.md#prompt-prefixes-and-automatic-skips). `uplift: <prompt>` forces planning.
3. **Check the environment.** `ULTRATHINK_UPLIFT=0` in the host's environment turns planning off for the whole process.
4. **Check the engine.** With `Engine: grok…` and `SuperGrok OAuth: not logged in` or `expired`, every prompt is skipped with ``Prompt Uplift skipped · Grok 4.7 login required (run `grok login`)``. Run `grok login`, switch back with `bin/ultrathink grok engine claude`, or set `grok.fallbackToClaude: true`. If the summary shows `fallback`, the engine call failed. The default Claude engine runs `claude -p`, so the `claude` binary (`claude.bin`) must be on the host's `PATH` and logged in, on every host that uses it.
5. **Run the hook by hand with debug logging.** On Claude Code, Grok and Muse the prompt hook is `hooks/uplift.ts`. `ULTRATHINK_DEBUG=1` makes it log each skip reason and failure to stderr:

   ```sh
   cd <your project>
   printf '%s' '{"hook_event_name":"UserPromptSubmit","session_id":"debug","cwd":"'"$PWD"'","prompt":"add a health check endpoint"}' \
     | ULTRATHINK_DEBUG=1 ULTRATHINK_TRACK=0 <clone>/bin/run-bun <clone>/hooks/uplift.ts
   ```

   Lines such as `[ultrathink] skipped: slash-command`, `[ultrathink] uplift failed: …` or `[ultrathink] tracking failed: …` name the cause. Stdout is the JSON the host would receive. `ULTRATHINK_TRACK=0` keeps the test from creating rows. The run does call the engine, and it writes a `debug` session into the Claude Code state directory.

   Hermes and Omp use `hooks/engine.ts`, whose JSON response has a `skipped` field with the reason (`child-or-disabled`, `parent-session`, `cron`, `empty`, `subagent`, `ultrathink-command`, `slash-command`, `ultrathink-skill`, `skip`, `uplift-failed`, `engine-error`, or the Grok login message):

   ```sh
   printf '%s' '{"host":"omp","session_id":"debug","cwd":"'"$PWD"'","prompt":"add a health check endpoint"}' \
     | ULTRATHINK_TRACK=0 <clone>/bin/run-bun <clone>/hooks/engine.ts
   ```

6. **Check the host wiring.** See the host sections below. Grok needs the global hook file, Muse needs approved hooks, Hermes needs the plugin to load, and Omp needs the link.

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

## bun not found

Every hook goes through `bin/run-bun`, which looks for Bun in this order: `$BUN`, `PATH`, `$BUN_INSTALL/bin/bun`, `~/.bun/bin/bun`, `/usr/local/bin/bun`, `/opt/homebrew/bin/bun`, `~/.local/share/*/bun/bin/bun`. If none of them exist, it prints `ultrathink: bun not found` to stderr and exits 0. The prompt goes through unplanned.

- Install Bun 1.2 or newer, or point `BUN` at the binary in the host's environment.
- On Hermes, a control command replies `Ultrathink <verb> failed: ultrathink: bun not found`. The Hermes planner also honors `BUN`.

## The plan is slow or cut off

A full plan makes several model calls (uplift, graph, one fill per node, clarifications) and then creates rows, so it can take minutes. Each host bounds it differently:

| Host | Bound | What happens at the bound |
|---|---|---|
| Claude Code | Hook timeout 86 400 s (`hooks/hooks.json`) | Not reached in practice. |
| Grok Build | 600 s `UserPromptSubmit` timeout in `~/.grok/hooks/ultrathink.json` | Grok stops the hook and the prompt goes through unplanned. |
| Muse Code | 600 s (`timeoutMs: 600000` in `.muse-plugin/plugin.json`) | Same. |
| Hermes Agent | `min(540, cap − 15)` s, where the cap is Hermes' `plugins.hook_callback_timeout` (30 s by default, set it to 600); `ULTRATHINK_HERMES_TIMEOUT` replaces the 540 | The planner kills Bun's process group and no context is added. See [Hermes: the plan never arrives](#hermes-the-plan-never-arrives). |
| Omp | 25 s inline, then the plan arrives as an aside, with the engine run capped at 10 minutes | See [Omp](#omp). |

To make plans faster, lower `think.maxNodes`, raise `claude.concurrency`, set `claude.budgetMs` to cap the whole run, or turn Graph of Thought (`bin/ultrathink think off`) or HITL (`bin/ultrathink hitl off`) off for a host. See [Configuration](configuration.md).

## Hermes: the plan never arrives

Hermes stops waiting for a plugin hook after `plugins.hook_callback_timeout` seconds, 30 by default. A plan takes minutes, so at the default every plan is dropped and `~/.hermes/logs/agent.log` shows, once per prompt:

```text
Hook 'pre_llm_call' callback on_pre_llm_call timed out after 30s — skipping
```

Fix it and restart Hermes, including any running gateway:

```sh
hermes config set plugins.hook_callback_timeout 600
hermes config get plugins.hook_callback_timeout   # prints 600
```

600 is Hermes' maximum. Don't use 0, which turns off Hermes' hook deadline and makes the turn wait on the hook.

The planner gives the engine `min(540, cap − 15)` seconds. Under a 105 s cap that is under 90 s, too short for a plan, so the planner doesn't start Bun at all and logs one warning per process naming `hermes config set plugins.hook_callback_timeout 600`. In that case Hermes logs no timeout line, yet no prompt is planned.

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

- **Credentials.** `bin/ultrathink-mcp auth status` must show the configured provider as `ready`, and `bin/ultrathink-mcp check linear` (or `notion`) must print `OK <n> tools`. A provider that isn't logged in is skipped without a message. Linear takes `auth set-key linear --stdin`, and Notion takes `auth login notion`.
- **Linear team.** `linear.team` must name a team in the workspace that the Linear key belongs to.
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

`bin/ultrathink-mcp auth login notion` prints an authorization URL, then waits for the browser to come back to a callback on `127.0.0.1:8765` on the machine running the command. It also accepts the redirected URL pasted into the terminal. Over SSH the browser runs on another machine, so pick one of these:

| Situation | What to do |
|---|---|
| Tailscale is running on the host (with HTTPS certificates) | Nothing. Over SSH, `auth login` adds a temporary `tailscale serve` handler at `https://<host's tailnet name>/ultrathink-oauth/callback` and removes it after login. Open the URL on any device in the same tailnet and the login finishes by itself. |
| No Tailscale | Forward the port before opening the URL: `ssh -L 8765:127.0.0.1:8765 <user>@<host>`, or a local port forward in your SSH client (bind `127.0.0.1:8765` locally to `127.0.0.1:8765` through the host). |
| No forwarding possible | Approve in the browser, copy the full URL of the page you are redirected to (it may fail to load), and paste it into the terminal. `--no-listen` waits only for the pasted URL. |
| Your own callback URL | `--redirect <url>` or `ULTRATHINK_OAUTH_REDIRECT=<url>`. It must be `https`, or `http` only for `127.0.0.1`, `localhost` or `[::1]`, and it must reach the listener on `127.0.0.1:<port>`. `--port <n>` changes the port. |

If `auth status` later shows Notion as not ready, the grant was revoked or expired. Run `auth login notion` again.

## Ship is blocked

`bin/ultrathink-ship` returns `ok: false` with a `reason`, or, for a blocked review, `phase: "blocked"` and a PR comment `ultrathink-ship stopped: <reason>`. A blocked PR is left open for a human, and the skill doesn't retry. See [Ship](ship.md) for the flow.

| Step | Reason | What to do |
|---|---|---|
| (no nudge) | The Stop or `agent_end` nudge never appears | The nudge needs a planned prompt that invoked a skill matching `ship.skills` (default `gsd-`), `ship.enabled`, no `ULTRATHINK_SHIP=0`, and local git on a feature branch with commits ahead of `origin/<default>`. It fires once per session. |
| `assess` | `done: false` with `gaps` | The task isn't finished. Finish the gaps and assess again. |
| `assess` | gap `no judge available` | With `autoMerge` on, the rule-only assessment can't pass. The engine must be available (see [Nothing happens](#nothing-happens)). |
| `pr` | `task not assessed as done; run assess first` | Run `assess`. |
| `pr` | `no current branch (detached HEAD?)`, `on base branch <b>; work must be on a feature branch` | Move the work to a feature branch. |
| `pr` | `branch changed since assessment` | Run `assess` again. |
| `pr` | `uncommitted tracked changes: …` | Commit your own changes by explicit path, then retry. |
| `pr` | `could not determine default branch`, `push failed: …`, `create PR failed: …` | Check `gh auth status`, the `origin` remote and push rights. |
| `review` | `local HEAD <sha> differs from PR head <sha>; push your commits (or pull) first` | `git push`, then run `review` again. |
| `review` | `status: "pending"` | Not an error. Run `review` again; it resumes the same Greptile run. |
| `review` | `max rounds reached: …` | `ship.maxRounds` (5) rounds without passing. A human takes over. |
| `review` | `review failed twice for <sha>: …`, `review timeout twice for <sha>: …` | Greptile failed or timed out twice on the same commit. Check `greptile login` (CLI mode) or the Greptile key (`bin/ultrathink-mcp auth status`). |
| `merge` | `autoMerge disabled` | Merge by hand, or set `ship.autoMerge: true`. |
| `merge` | `PR head changed since last review; run review again` | Run `review`. |
| `merge` | `review score N/5 is below 5/5`, `review is for an older commit`, `no review has run` | Continue the review loop. |
| `review` or `merge` | `N open review comment(s)` | In PR mode these are the PR's Greptile review threads on GitHub that are neither resolved nor outdated. A fix that changes the flagged line makes its thread outdated. For a finding that isn't actionable (factually wrong, or describing intended behavior), reply on its thread with the reason and resolve it; the `review` output gives each finding's `threadId`, and [Ship](ship.md#fix-loop-and-blocking) has the commands. Never resolve a finding just to pass the gate. If the thread lookup fails (a `gh` error, or more than 100 threads), the gate fails closed and counts every unaddressed Greptile comment on the PR. Fix `gh auth status` and run `review` again. In CLI mode the count is the run's comments. |
| `merge` | `merge conflicts`, `GitHub has not computed mergeability yet`, `CI checks failing`, `CI checks pending`, `PR is closed` | Resolve on GitHub, or wait and retry. |
| `merge` | `PR closed without merge` | The ship is marked blocked. |

Resume at any time with `bin/ultrathink-ship status --state <stateFile>`. Every step is idempotent.

## Claude Code

- The hooks come from `hooks/hooks.json`: `UserPromptSubmit`, `PostToolUse` (`AskUserQuestion`, `Bash`, PR-creation tools) and `Stop`. They run through `bin/run-bun`.
- `bun scripts/setup.ts status` reports the Notion and Linear MCP entries, the `CLAUDE.md` block that `apply` manages, and the Grok rule and hooks. Without the `claude` CLI on `PATH`, it prints `Claude Code: claude CLI not found` followed by the Grok lines, and `apply` skips the Claude steps with a notice and still installs the Grok hooks and rule.
- Commands appear as `/ultrathink-<verb>` and `/ultrathink:ultrathink-<verb>`. If a control command produces a model turn that runs `bin/ultrathink`, the hook didn't run. Check that the plugin is installed and enabled.
- For `claude -p` automation that shouldn't be planned, set `ULTRATHINK_UPLIFT=0`.

## Grok Build

- **Plugin hooks are not dispatched.** Grok loads the plugin directory's skills and commands but doesn't run its `hooks/hooks.json`. Run `bun scripts/setup.ts apply` from the clone to install `~/.grok/hooks/ultrathink.json` and the rule `~/.grok/rules/ultrathink.md` (under `GROK_HOME` when set). This works without the `claude` CLI installed. `bun scripts/setup.ts status` reports `Grok rule:` and `Grok hooks:` as `installed` or `missing`. The hook file holds absolute paths, so run `apply` again after moving the clone.
- **Timeout.** Grok's default `UserPromptSubmit` timeout is 30 s, too short for a plan. The installed hook file sets 600 s. A plan that takes longer is dropped.
- **Stdout is discarded.** Grok throws away the stdout of a hook that allows the prompt, so the context never reaches the model that way. The plan goes to `~/.grok/plugin-data/ultrathink/last-plan.json` (or `$GROK_PLUGIN_DATA/ultrathink/`). `apply` merges the ultrathink block into the rule `~/.grok/rules/ultrathink.md` and keeps any other text in that file. The rule tells the model to read the carrier, the spec it points to, and then `ultrathink-plan` and `ultrathink-kickoff`. If the model ignores the plan, check that the rule file contains the `<!-- ultrathink:start -->` block, and read `last-plan.json` to confirm a plan was written for this session.
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

- **Check that the plugin loads.** `hermes plugins doctor <clone>/hosts/hermes` should print `OK: runtime discovery, manifest parsing, import, and registration passed`, with 4 hooks registered.
- **One planner.** If another plugin also plans prompts before the model call, disable it, or both will plan the same turn.
- **Gateway injection.** `/ultrathink-quick <message>` sends the message through `inject_message`. In gateways this needs `plugins.entries.ultrathink.allow_gateway_injection: true` in the Hermes config. Without it, the command falls back to skipping your next message and replies `Ultrathink will not plan your next message. Send it now (or prefix any message with raw:).`
- **Command names in chat apps.** The commands are registered with hyphens (`ultrathink-status`) because chat menus accept only a restricted character set, and one colon name stops Discord from listing the commands after it. Telegram menus show them with underscores: `ultrathink_status`, `ultrathink_quick` and so on.
- **Timeout.** The planner subprocess runs for at most `min(540, cap − 15)` seconds, where the cap is `plugins.hook_callback_timeout`. `ULTRATHINK_HERMES_TIMEOUT` replaces the 540. On the deadline the whole Bun process group is killed. Under a 105 s cap the planner doesn't run at all. See [Hermes: the plan never arrives](#hermes-the-plan-never-arrives). Control commands time out after 20 s.
- **Skipped before Bun.** Cron runs, sessions with a parent session, empty prompts, prompts that start with `/`, and already uplifted ultrathink XML are never sent to the engine. The engine then skips a bare skill scaffold with no task, and a prompt that references an existing graph as `graph ut-<id>-<8 hex>` unless it starts with `uplift:`.
- **No rows from the hook.** On Hermes the planner creates no Notion or Linear rows. `ultrathink-kickoff` creates them at the start of the agent's turn with `ultrathink-mcp track complete --state <file>`, so rows appear only once the agent has run kickoff.

## Omp

- **30 s handler cap.** Omp stops waiting on `before_agent_start` handlers after 30 s. ultrathink waits 25 s. A plan that isn't ready by then is replaced by a pending note, which tells the model to only read and investigate until the plan arrives. The plan then comes as an `aside` message at the next step boundary. The status bar shows `pending`, then `aside`. This is normal for large prompts.
- **Asides that never arrive.** The engine run is capped at 10 minutes. If it fails or produces nothing, a short note says so, and the model proceeds with the request as written.
- **Superseded plans.** If you send a newer prompt in the same session before a deferred plan finishes, the older plan is dropped and not delivered, so it can't steer the newer request. The status bar shows `superseded by a newer prompt`. Every submission is planned, including an identical resend. Only Omp's own re-runs of the same submission reuse the plan already in flight.
- **No status bar.** The bar, live graph and plan cards render only in the TUI (`mode: "tui"`). RPC, print and JSON modes plan the same way without the chrome.
- **Not planned.** Task-subagent sessions, and a top-level `omp -p --no-session` run, are treated as subagents and never planned.
- `omp plugin link <clone>` loads `src/host/omp.ts` through `package.json` `omp.extensions`. `omp plugin list` should show `ultrathink`.

## Uninstalling

Remove what each host loaded, then optionally the shared config, credentials and state.

| Host | Remove |
|---|---|
| Claude Code | `claude plugin uninstall ultrathink@ultrathink`, then `claude plugin marketplace remove ultrathink`. |
| Grok Build | Remove the plugin from `~/.grok/plugins/` the way you added it (see [Install](install.md)). `rollback` below removes the global hook file and the rule. |
| Hermes Agent | Remove the `~/.hermes/plugins/ultrathink` symlink, and any `plugins.entries.ultrathink` settings. |
| Muse Code | `muse plugins remove ultrathink`. |
| Omp | `omp plugin uninstall ultrathink`. |

Then:

- `bun scripts/setup.ts rollback` removes the `CLAUDE.md` block, the `notion` and `linear` Claude Code MCP servers (only those `apply` added), `~/.grok/hooks/ultrathink.json`, and the ultrathink block in `~/.grok/rules/ultrathink.md`. The rule file is deleted when it holds only that block. Any text you added around the block stays.
- Remove the `notion`, `linear` and `greptile` MCP entries that `scripts/mcp-register.ts` added to each host's user config. Every file it changed has a `*.bak-ultrathink-mcp-<timestamp>` backup next to it.
- `bin/ultrathink-mcp auth logout notion` (and `linear`, `greptile`), or delete `~/.config/ultrathink/mcp-credentials.json`.
- Delete the config files you created: `~/.config/ultrathink/config.json`, `~/.claude/ultrathink.json`, `<project>/.claude/ultrathink.json`.
- Delete the state directories: `~/.claude/ultrathink`, `~/.grok/plugin-data/ultrathink`, `$HERMES_HOME/ultrathink` (`~/.hermes/ultrathink`), `~/.config/muse/ultrathink`, `~/.omp/agent/ultrathink`.

Rows already created in Notion and Linear stay. Delete them in those apps if you no longer want them.
