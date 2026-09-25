# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Hermes: the plugin registers `ultrathink-kickoff`, `ultrathink-sync`, `ultrathink-plan` and `ultrathink-ship` as Hermes plugin skills (`skill_view name="ultrathink:<name>"`), and the plan's kickoff and ship instructions give each skill's load call and absolute `SKILL.md` path, since Hermes does not list plugin skills to the model.
- `ultrathink-mcp session mark --state <file> <kicked-off|synced>` sets `kickedOff` or `synced` in a session record. `ultrathink-kickoff` runs it with `kicked-off` as its last step.

### Changed

- Hermes: the plan reaches the model as a short handoff (spec path, state file, Graph ID and kickoff instruction) instead of the full specification, because Hermes replays hook context in every turn and spills pieces over 10,000 characters to a file.
- `ultrathink-kickoff` fails open when Notion or Linear is down, unreachable, rate-limited or unauthorised: it creates no rows by hand, says which tracker failed in one line, and continues. The manual MCP fallback is only for when `track complete` itself cannot run. On Hermes it asks blocking questions with one `clarify` call (at most 5 questions of up to 4 choices, default first) and uses the defaults when no user is available.

### Fixed

- Hermes: plans are no longer dropped by Hermes' 30 s plugin hook cap. Install now sets `hermes config set plugins.hook_callback_timeout 600`, and the planner reads the cap Hermes enforces and stops at `min(540, cap − 15)` seconds. Under a 105 s cap (a deadline under 90 s) it doesn't start Bun and logs one warning naming that command. On the deadline it kills Bun's whole process group, so no engine call outlives the hook.
- Hermes: the prompt hook no longer creates Notion or Linear rows. `ultrathink-kickoff` creates them with `ultrathink-mcp track complete --state <file>`, so a plan that Hermes abandons can't leave orphan rows.
- A prompt that references an existing ultrathink graph (`graph ut-<id>-<8 hex>`, as dispatched workers and Linear issue footers do) is no longer planned again as a new graph on any host. Prefix it with `uplift:` to force a plan. On Hermes a bare skill preamble with no task is skipped too.
- Hermes and Omp: stateless skips (`raw:`, commands, already uplifted XML, graph references, trivial acknowledgements) run before an engine is selected, and the Hermes plugin skips prompts that start with `/` and already uplifted XML before starting Bun.

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
