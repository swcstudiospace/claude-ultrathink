# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
