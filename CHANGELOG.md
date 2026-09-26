# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

A fresh install now contacts only the services you configured, the installers work from any clone on Linux and macOS (Windows through WSL), and the documentation is written for people outside the project. Several defaults changed; every entry under **Changed** and **Removed** says how to keep the old behaviour.

### Added

- Hermes: the plugin registers `ultrathink-kickoff`, `ultrathink-sync`, `ultrathink-plan` and `ultrathink-ship` as Hermes plugin skills (`skill_view name="ultrathink:<name>"`), and the plan's kickoff and ship instructions give each skill's load call and absolute `SKILL.md` path, since Hermes does not list plugin skills to the model.
- `ultrathink-mcp session mark --state <file> <kicked-off|synced>` sets `kickedOff` or `synced` in a session record. `ultrathink-kickoff` runs it with `kicked-off` as its last step.
- Hermes: an end-of-turn sync nudge. Through Hermes' `pre_verify` hook, once per plan (per session and Graph ID), a coding turn (one that edited files with `write_file` or `patch`) that is about to finish with a tracked plan not yet synced is continued with an instruction to run `ultrathink-sync` (with the state file, Graph ID and, when the session opened one, the PR URL). The PR-creation nudge now names the Graph ID and the skill's load call and `SKILL.md` path too.
- `substrate.url` config key for the optional Agent Substrate brief. `SUBSTRATE_URL` still wins over it, and `SUBSTRATE_DISABLED=1` still turns both off.
- `ship.greptileOrganization` config key: the Greptile organization id or handle passed on every Greptile MCP call. An account in several organizations needs it; without it, `review` now returns `status: "blocked"` with a reason that names the key and the candidate organizations.
- `ultrathink-mcp auth login --tailscale` and `ULTRATHINK_OAUTH_TAILSCALE=1`: on a remote session, receive the OAuth callback through `tailscale serve`.
- `scripts/mcp-register.ts --replace` (also overwrite same-named MCP entries that are not ultrathink's) and `--remove` (delete only ultrathink's entries). `mcp-register` also warns when it is run from a plugin cache directory that the next plugin update replaces.
- `bin/ultrathink status` (and `/ultrathink-status`) shows a `Substrate:` line (off, or the URL and whether it came from `SUBSTRATE_URL` or the config) and a `Ship:` line (off, or on with the auto-merge and delete-branch settings).
- Ship: `bin/ultrathink-ship review` returns `status: "blocked"` before any review round when Greptile is not set up (the `greptile` CLI is missing or signed out and no Greptile credential is stored), with the setup commands. A failed or slow `greptile whoami` is not treated as "not set up".
- Ship: `gsd-tools.cjs` is found in the standard GSD install locations (project, including the legacy project-local `.claude/get-shit-done`, `CLAUDE_CONFIG_DIR`, `~/.claude`, `~/.agents`, Hermes, Codex, Gemini, Cursor, opencode, and the legacy `~/.claude/get-shit-done`); `GSD_TOOLS` still wins. It runs with `node`. A GSD roadmap whose tools cannot be found, or whose tools cannot run because `node` is not on `PATH`, is reported as its own assessment gap instead of silently reading as zero phases.
- Hermes: when Hermes does not report its plugin hook cap, the plugin reads `plugins.hook_callback_timeout` from the active Hermes profile's `config.yaml` (`${HERMES_HOME:-~/.hermes}/config.yaml`, or `profiles/<name>/config.yaml` when a profile is active), with Hermes' own rules (negative → 30, over 600 → 600, 0 = no cap), else assumes Hermes' 30 s default, and logs one warning naming `hermes config set plugins.hook_callback_timeout 600`.
- Hermes: when `hooks/engine.ts` or `bin/run-bun` is not beside the plugin (for example, `hosts/hermes` was copied instead of symlinked), Bun is not started and one warning says to install `hosts/hermes` as a symlink into a full clone.
- `package.json` declares `engines.bun >=1.2`. CI runs Bun 1.2.x and the latest Bun on Linux and macOS, and the Hermes plugin tests on Python 3.10, the minimum the plugin now states.
- Documentation for new users: a documentation index (`docs/README.md`), a getting-started tutorial, task guides in `docs/how-to/` (Notion, Linear, the MCP gateway, engine choice, ship with Greptile, cost and latency, headless and CI, team and project config, upgrading and moving, uninstalling), a privacy page listing what leaves your machine, and an FAQ. The configuration and command references now cover every config key, environment variable, flag and exit code.

### Changed

- Hermes: the plan reaches the model as a short handoff (spec path, state file, Graph ID and kickoff instruction) instead of the full specification, because Hermes replays hook context in every turn and spills pieces over 10,000 characters to a file.
- `ultrathink-kickoff` fails open when Notion or Linear is down, unreachable, rate-limited or unauthorised: it creates no rows by hand, says which tracker failed in one line, and continues. The manual MCP fallback is only for when `track complete` itself cannot run. On Hermes it asks blocking questions with one `clarify` call (at most 5 questions of up to 4 choices, default first) and uses the defaults when no user is available.
- `ultrathink-sync` finds rows by Graph ID only (the Notion Task by the session record's `tracking.notion.taskUrl` or its `Graph ID`, the Linear issues by the session's tracking refs or the `ultrathink graph <id>` footer), never by branch, PR title or repo. It never creates rows, never clears `PR URL` or `PR #` in a turn without a pull request, fails open when Notion or Linear is down, unreachable, rate-limited or unauthorised (one line naming the tracker, no retries, the turn continues), and ends with `ultrathink-mcp session mark --state <file> synced`, which stops the Hermes end-of-turn nudge.
- The Agent Substrate brief is opt-in. ultrathink no longer requests a brief from a built-in local address; it asks only when `substrate.url` or `SUBSTRATE_URL` is set. The kickoff skill treats registering the graph with Agent Substrate as optional. To keep the old behaviour, set `substrate.url` (or `SUBSTRATE_URL`) to your Agent Substrate server's URL.
- Ship is opt-in: `ship.enabled`, `ship.autoMerge` and `ship.deleteBranch` now default to `false`. With the defaults, no skill run pushes, opens a PR or merges, and the plan, the end-of-run nudge and the ship skill only promise a merge when `ship.autoMerge` is on. `bin/ultrathink-ship` still works when run by hand, but `merge` refuses unless `ship.autoMerge` is `true`. To keep the old behaviour, set `"ship": { "enabled": true, "autoMerge": true, "deleteBranch": true }`.
- Grok `shunt` transport: `grok.shuntBaseUrl` and `grok.shuntModel` now default to `""`, and there is no built-in gateway. With `transport: "shunt"` and no `grok.shuntBaseUrl`, each engine call fails with an error naming that key; the prompt gets the conservative fallback spec and no rows are created. Claude is not used instead (`grok.fallbackToClaude` only applies to a missing Grok login). An empty `grok.shuntModel` sends `grok.model`. To keep the old behaviour, set `grok.shuntBaseUrl` to your gateway's URL and `grok.shuntModel` to the model name your gateway expects.
- `ultrathink-mcp auth login` no longer runs `tailscale` on its own. Over SSH the default is the loopback callback, with port-forwarding and paste-back instructions; a line mentions the Tailscale option. To keep the old behaviour, pass `--tailscale` or set `ULTRATHINK_OAUTH_TAILSCALE=1`.
- `scripts/mcp-register.ts` keeps a same-named `notion`, `linear` or `greptile` MCP entry that is not ultrathink's (its command does not end in `/bin/ultrathink-mcp`) and reports it as `kept`. ultrathink entries from another clone are still replaced, and entries that already match are reported `unchanged`. To keep the old behaviour of overwriting every same-named entry, pass `--replace`.
- `bin/ultrathink`, `bin/ultrathink-mcp` and `bin/ultrathink-ship` exit 127 with `ultrathink: bun not found. Install Bun 1.2 or later (https://bun.sh) or set BUN=/path/to/bun` when Bun is missing, and keep Bun's exit status when it cannot start. They used to exit 0. The hooks still exit 0, so a missing Bun never blocks a prompt. Scripts that relied on exit 0 should install Bun or set `BUN`.
- Grok Build state lives in `$GROK_PLUGIN_DATA/ultrathink`, else `${GROK_HOME:-~/.grok}/plugin-data/ultrathink`: `GROK_HOME` is now honoured by the engine, the Grok rule, the `ultrathink-plan` skill and `mcp-register` (`scripts/setup.ts` already honoured it). If you set `GROK_HOME` and want to keep your Grok control state, move `~/.grok/plugin-data/ultrathink` to `$GROK_HOME/plugin-data/ultrathink`.
- Grok Build users must re-run `bun scripts/setup.ts apply` after updating, so `${GROK_HOME:-~/.grok}/hooks/ultrathink.json` gets the new PR-sync matcher and the Grok rule gets the new state paths. The Grok plugin itself still needs `grok plugin enable ultrathink` once.
- `scripts/setup.ts`: the `CLAUDE.md` block says the plugin *can* track and applies only when tracking is configured; the Notion and Linear MCP servers are detected by exact name; the printed Hermes steps use `$HERMES_HOME` and say that the hook cap is a global Hermes setting of at least 105 s (600 recommended). Run `bun scripts/setup.ts apply` again to update an existing block.
- Missing-credential messages for Linear and Greptile name both routes: `ultrathink-mcp auth login <provider>` (OAuth) or `ultrathink-mcp auth set-key <provider> --stdin` (API key). Notion stays OAuth-only.
- Shipped text, hook matchers and examples carry no project-specific names: the tracking instructions give `Refs ENG-12` as the example identifier, and the PR-sync hook matches any MCP server's `create_pull_request`, `pull_request_create` or `createPullRequest` tool.

### Removed

- The built-in Agent Substrate address. Set `substrate.url` or `SUBSTRATE_URL` to use Agent Substrate.
- The built-in Grok `shunt` gateway URL and model. Set `grok.shuntBaseUrl` and `grok.shuntModel` to use the `shunt` transport.
- The automatic Tailscale probe and `tailscale serve` route in `ultrathink-mcp auth login`. Use `--tailscale` or `ULTRATHINK_OAUTH_TAILSCALE=1`.
- The PR-sync hook's matcher entry for one private MCP server name; the generic matcher above covers it.

### Fixed

- Notion rows are created with their properties again. The hosted Notion MCP now returns a data source's schema as JSON inside a text field, which the schema reader missed, so every Task, Issue and Sub-Issue row was created empty (no Item, Level or Graph ID) while tracking still reported complete, and lookups by Graph ID found nothing. The reader now parses the schema inside text payloads, and a schema read that misses the core names sends every property unfiltered, so a mismatch fails the create loudly instead of recording empty or partial rows.
- Hermes: plans are no longer dropped by Hermes' plugin hook cap. The planner reads the cap Hermes enforces and stops at `min(540, cap − 15)` seconds; below a 105 s cap (a deadline under 90 s) it doesn't start Bun and logs one warning naming `hermes config set plugins.hook_callback_timeout 600`. Nothing sets the cap for you: Hermes defaults to 30 s, so run that command yourself (at least 105 s, 600 recommended; it is a global Hermes setting that applies to every plugin). `scripts/setup.ts apply` prints the command but does not run it. On the deadline the plugin kills Bun's whole process group, so no engine call outlives the hook.
- Hermes: the prompt hook no longer creates Notion or Linear rows. `ultrathink-kickoff` creates them with `ultrathink-mcp track complete --state <file>`, so a plan that Hermes abandons can't leave orphan rows.
- A prompt that references an existing ultrathink graph (`graph ut-<id>-<8 hex>`, as dispatched workers and Linear issue footers do) is no longer planned again as a new graph on any host. Prefix it with `uplift:` to force a plan. On Hermes a bare skill preamble with no task is skipped too.
- Hermes and Omp: stateless skips (`raw:`, commands, already uplifted XML, graph references, trivial acknowledgements) run before an engine is selected, and the Hermes plugin skips prompts that start with `/` and already uplifted XML before starting Bun.
- Hermes integration: the handoff's human-in-the-loop step asks blocking questions with one `clarify` call (at most 5 questions of up to 4 choices, recommended default first) instead of the nonexistent `AskUserQuestion`, and names Hermes' `todo` and `delegate_task` tools. With `/ultrathink-skip` armed, a trivial or bare-preamble prompt on Hermes and Omp now uses up the skip, as on the other hosts. The plugin strips a shared-session `[Name] ` sender tag that names the current sender before its skips and plans the untagged text (a `[label]` the user typed stays), and takes the planner's working directory from `TERMINAL_CWD` before its own. An armed skip is consumed before engine selection, so an unavailable engine cannot leave it armed. A PR a `delegate_task` subagent really opened (its own `gh pr create`, matched to the parent through `subagent_start`) nudges the parent; a delegate result that only cites a PR does not. Both sync nudges pass `graphId=`, and `ultrathink-sync` prefers it over a state file that a newer plan has since replaced. The ship skill loads `ultrathink:ultrathink-sync` by its Hermes name, and the plan skill falls back to `~/.hermes/ultrathink` when `HERMES_HOME` is unset.
- Notion rows whose create reply links to `https://app.notion.com/…` are counted as created.
- PR sync: tool names count as PR creation only when they end in the create verb, so `create_pull_request_review` and `create_pull_request_with_copilot` no longer link tracked rows to an unrelated pull request.
- `scripts/setup.ts` works from a clone whose path has spaces or non-ASCII characters, no longer counts lookalike MCP server names (such as `notion-foo`) as installed, removes its `ultrathink-setup-state.json` on `rollback`, and prints (without running) the Claude Code plugin uninstall commands.
- `scripts/mcp-register.ts` no longer rewrites Muse's entries on every run when only key order or a default `type: "stdio"` differs, verifies each removal, and backs up the `config.toml` under `GROK_HOME`.
- `scripts/mcp-register.ts` reads and backs up the `config.yaml` of the active Hermes profile (`<Hermes home>/profiles/<name>/config.yaml` when a profile other than `default` is active, or when `HERMES_HOME` points at a profile directory) instead of always the root `config.yaml`. When the active profile cannot be resolved, it backs up nothing and says so.
- `scripts/setup.ts apply` keeps the MCP servers recorded as added by earlier runs, so `rollback` still removes them after a re-run. `rollback` keeps its state file when a removal fails, prints the error and the manual `claude mcp remove` command, and retries on the next run.
- `scripts/setup.ts rollback` never removes a Notion or Linear MCP server you replaced after `apply` added it (for example with the gateway through `mcp-register --replace`): it removes a server only while `claude mcp get` still shows setup's user-scope HTTP entry with the hosted URL, reports a replaced one as left in place and a missing one as already removed.
- `scripts/mcp-register.ts` decides ownership from the user-scope entry only, the scope it adds to and removes from: a same-named project- or local-scope entry in Claude Code or Grok no longer blocks registration and is never touched.
- The `/ultrathink-off`, `-on`, `-skip`, `-status` and `-track` command files work when `CLAUDE_PLUGIN_ROOT` is not set: the model asks you for the ultrathink directory and runs `bin/ultrathink` from there, instead of failing.

### Security

- The Grok `cli` transport runs the `grok` process in a private per-process temporary directory (mode 0700) instead of a fixed, shared directory under the system temp directory.
- When `CLAUDE_PLUGIN_ROOT` is not set, the command files tell the model not to search for or run any other `bin/ultrathink`; it runs only the one in the directory you name.
- With no configuration, ultrathink no longer contacts an Agent Substrate server, runs `tailscale`, or pushes, opens pull requests or merges; each needs an explicit opt-in (see **Changed**).

## [0.3.0] - 2026-09-25

First public release, licensed under AGPL-3.0-or-later.

### Added

- Ship flow: the `ultrathink-ship` skill, driven by `bin/ultrathink-ship`, checks that the task is really done, opens a pull request into the repository's default branch, runs Greptile reviews until the score is 5/5 with zero open comments, squash-merges only when that gate passes, and cleans up the branch.
- `/ultrathink-quick`, `/ultrathink-skip`, `/ultrathink-off`, `/ultrathink-on`, `/ultrathink-track` and `/ultrathink-status` slash commands on all five hosts: send one message without planning, skip planning for the next message, turn planning or Linear/Notion tracking off and on, and show the current state.
- `ultrathink-mcp notion init --parent <page>` creates the Agent Task Graph database in your Notion workspace; `--write-config` saves it to your config.
- Host-neutral config file `~/.config/ultrathink/config.json` (under `$XDG_CONFIG_HOME` when that is set). `~/.claude/ultrathink.json` and `<project>/.claude/ultrathink.json` still apply on top of it.
- Muse, Hermes Agent and Omp hosts, with one MCP gateway (`bin/ultrathink-mcp`) that serves Notion, Linear and Greptile to every host from a single credential store. Omp also gets a live status bar and plan cards.

### Changed

- Notion and Linear targets no longer default to the author's workspace. Set `notion.dataSourceUrl` and/or `linear.team` (or run `ultrathink-mcp notion init`); with neither set, tracking is off.
- The MCP gateway reports an upstream rate limit as a rate limit, with the retry delay when it is known, instead of as an authentication error.

### Fixed

- Ship: a passing review whose pull request is only waiting on CI, mergeability or conflicts is no longer counted as a failed round, so it cannot block the ship at `maxRounds`, and `review` now says what to wait for instead of "fix the listed findings".
- Ship: a transient Greptile tool or network error during a PR-mode review is reported as `pending` and retried on the next call, instead of being recorded as a failed round that counts toward `maxRounds`.

### Security

- Nothing notable in this release.

## [0.2.x]

Pre-public builds that were never tagged; their work ships as part of 0.3.0. In summary:

- One planning engine shared by several hosts, with host-scoped state directories.
- Optional Grok engine (`think.engine: "grok"`) next to the default Claude engine.
- HITL clarifications: blocking questions are asked once, before work starts.
- One Linear sub-issue per Chain-of-Thought step under each graph node's issue.

[Unreleased]: https://github.com/swcstudiospace/claude-ultrathink/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/swcstudiospace/claude-ultrathink/releases/tag/v0.3.0
[0.2.x]: https://github.com/swcstudiospace/claude-ultrathink/commits/v0.3.0
