# Ship with Greptile

**Ship** is ultrathink's optional last step: when a planned skill run finishes, the agent checks that the work is really done, opens a pull request, gets a Greptile review of 5/5 with no open comments, and (only if you allow it) merges. **Greptile** is a hosted AI code reviewer. Ship is **off by default**: a fresh install never pushes a branch, opens a PR or merges anything.

This guide turns ship on. [Ship: PR, Greptile review, merge](../ship.md) is the full reference.

- [1. Check the requirements](#1-check-the-requirements)
- [2. Set up Greptile](#2-set-up-greptile)
- [3. Turn ship on](#3-turn-ship-on)
- [4. Decide about GSD](#4-decide-about-gsd)
- [5. Run it](#5-run-it)
- [Merge by hand](#merge-by-hand)
- [Turn it off again](#turn-it-off-again)

## 1. Check the requirements

| You need | Why | Check |
|---|---|---|
| A git repository whose `origin` remote is on github.com | ship pushes to `origin` and reads the default branch, PR, checks and review threads through `gh`. GitHub Enterprise Server and other hosts are not supported for now. | `git remote get-url origin` |
| The GitHub CLI `gh`, logged in, with rights to push, open PRs and (for auto-merge) merge | every GitHub call | `gh auth status` |
| Greptile, through the ultrathink credential store or the Greptile CLI | the review | [step 2](#2-set-up-greptile) |
| A working engine (see [Choose the engine](choose-engine.md)) | the done judge. Required when `ship.autoMerge` is `true`. | `<clone>/bin/ultrathink status` |
| Bun 1.2 or later | `bin/ultrathink-ship` exits 127 with an install hint without it | `bun --version` |

`<clone>` is the directory you cloned ultrathink into.

## 2. Set up Greptile

Pick one. Ship tries them in this order on every review.

**PR mode, through the credential store.** Store a Greptile API key (from your Greptile account settings), or log in with OAuth:

```sh
<clone>/bin/ultrathink-mcp auth set-key greptile --stdin   # paste the key, then Ctrl-D
# or
<clone>/bin/ultrathink-mcp auth login greptile
```

PR mode is used when Greptile lists the repository and its reviews are not disabled. Greptile then reviews the PR on GitHub itself. See [Register the MCP gateway](register-mcp-gateway.md) for the credential store.

**CLI mode, through the Greptile CLI.** Install the Greptile CLI and sign in:

```sh
greptile login
greptile whoami
```

CLI mode is used when no Greptile credential is stored, or when the stored account does not list the repository, lists it with reviews disabled, or the repository lookup fails for any reason other than the organization choice below. If a credential is stored, CLI mode is used anyway and the CLI is not installed, the review round fails.

**Several Greptile organizations.** If your Greptile account belongs to more than one organization, Greptile refuses calls until one is chosen. Ship then stops before any review round with a reason like:

```text
Greptile account has several organizations; set ship.greptileOrganization in ~/.config/ultrathink/config.json (one of: acme, acme-labs)
```

Put one of the listed ids or handles in `ship.greptileOrganization` ([step 3](#3-turn-ship-on)). It is sent with every Greptile call. Leave it `""` for a single-organization account.

**Nothing set up.** If no Greptile credential is stored and `greptile whoami` shows the CLI missing or signed out, ship stops before any review round with:

```text
Greptile is not set up: run `bin/ultrathink-mcp auth set-key greptile --stdin` (or `auth login greptile`), or install and sign in to the greptile CLI (`greptile login`)
```

The ship phase becomes `blocked`, nothing is counted against `ship.maxRounds`, and no PR comment is posted. Fix the setup and ask the agent to run the review again.

## 3. Turn ship on

Add a `ship` section to a config file: your user file `~/.config/ultrathink/config.json` for yourself, or `<repo>/.claude/ultrathink.json` to share it with everyone who works in that repository (see [Team and project config](team-and-project-config.md)).

```json
{
  "ship": {
    "enabled": true,
    "autoMerge": false,
    "deleteBranch": false,
    "greptileOrganization": ""
  }
}
```

The three switches are separate, and all default to `false`:

| Key | `true` means |
|---|---|
| `ship.enabled` | The plan gets a `## Ship` section and the agent is nudged to ship at the end of a matching skill run. Pushing and opening the PR are part of this. |
| `ship.autoMerge` | `merge` may merge the PR once the gate passes. Off, the flow stops with the PR ready for you. |
| `ship.deleteBranch` | After a confirmed merge, delete the remote and local branch and fast-forward the base branch. |

Check it from the project directory:

```sh
<clone>/bin/ultrathink status
```

```text
Ship: on · auto-merge off · delete branch off
```

## 4. Decide about GSD

By default ship only follows skill runs whose name starts with `gsd-` (`ship.skills: ["gsd-"]`).

**GSD** is a separate open-source planning workflow for coding agents. Its skills are named `gsd-*`, and it keeps a roadmap of phases, plans and verification reports in a `.planning/` directory in your repository. Its `gsd-tools.cjs` script reads that roadmap.

How ship uses GSD, when the repository has `.planning/ROADMAP.md`:

- The done assessment runs `node <gsd-tools.cjs> query roadmap.analyze` and treats incomplete phases as not done, so `node` must be on `PATH`. If `node` cannot be started, the task is not done, with the gap `GSD roadmap found but node is not on PATH, so gsd-tools.cjs could not run; install Node.js or rerun assess with --ignore-gsd`. If the script runs but fails, the roadmap counts as 0 of 0 phases and the other checks still run. The latest `.planning/phases/*/*-VERIFICATION.md` must have `status: passed`.
- `gsd-tools.cjs` is found through `GSD_TOOLS` when set. Otherwise ship takes the first one that exists, in this order: `<repo>/gsd-core/bin/`, `<repo>/.claude/gsd-core/bin/`, `<repo>/.codex/gsd-core/bin/`, the older `<repo>/.claude/get-shit-done/bin/`, `$CLAUDE_CONFIG_DIR/gsd-core/bin/` (when set), `~/.claude/gsd-core/bin/`, `~/.agents/gsd-core/bin/`, `${HERMES_HOME:-~/.hermes}/gsd-core/bin/`, `${CODEX_HOME:-~/.codex}/gsd-core/bin/`, `${GEMINI_CONFIG_DIR:-~/.gemini}/gsd-core/bin/`, `~/.cursor/gsd-core/bin/`, `${XDG_CONFIG_HOME:-~/.config}/opencode/gsd-core/bin/`, and last the older `~/.claude/get-shit-done/bin/`.
- If the roadmap exists but no `gsd-tools.cjs` is found, the task is not done, with the gap `GSD roadmap found but gsd-tools.cjs was not found; set GSD_TOOLS or rerun assess with --ignore-gsd`.
- `assess --ignore-gsd` leaves the roadmap and verification out. Use it only when you decided the repository's `.planning/` roadmap is separate work from this change. The agent adds it only on your explicit say-so, and the PR body records the exclusion.

A repository without `.planning/ROADMAP.md` needs no GSD at all.

**Ship without GSD.** Set the skill prefixes that should trigger ship:

```json
{ "ship": { "enabled": true, "skills": [] } }
```

- `[]` matches every prompt: every plan gets the `## Ship` section, and the end-of-run nudge fires after any skill run.
- A list such as `["my-release-"]` matches only skill runs whose name starts with one of the prefixes.

## 5. Run it

Invoke a matching skill as usual. When the run ends with committed work on a feature branch (at least one commit ahead of the default branch), the agent invokes the `ultrathink-ship` skill. It:

1. runs `assess`. When the task is not done, it hands the gaps back to you and opens no PR;
2. commits only the files it edited, pushes, and opens (or reuses) a PR into the default branch;
3. runs Greptile review rounds, fixing findings and pushing, until the review is 5/5 with no open comments. After `ship.maxRounds` (5) completed reviews below 5/5 or with open threads it stops, comments on the PR and leaves it for you;
4. merges, only with `ship.autoMerge`, and keeps retrying the merge until the 5/5-reviewed PR merges;
5. runs `ultrathink-sync` so tracked Linear and Notion rows get the PR link and status;
6. reports the PR URL, rounds, final score, and merged, ready to merge by hand, or why not.

A Greptile review can take several minutes. Each `review` call returns within about 100 seconds (`ship.waitMs`) with `status: "pending"` while Greptile is still working; calling it again resumes the same review.

Ship retries instead of giving up early:

- **Failed reviews.** A failed Greptile review (Greptile FAILED/ERROR/SKIPPED, no score, CLI failure) or one pending past `ship.reviewTimeoutMs` (20 minutes) is re-triggered on the next `review` call, up to `ship.reviewRetries` times per head commit; then the ship blocks with a PR comment. These never count toward `ship.maxRounds`.
- **Merge.** After the head's review passed, `merge` keeps retrying through pending CI, mergeability not yet computed, unreadable PR state or threads and transient GitHub errors, for up to `ship.waitMs` per call. When a call's time runs out it returns `waiting: true` and `next: "run merge again: …"`, and the agent runs `merge` again. `run` also merges within its own `ship.waitMs` when the review passed.
- **Back to the agent.** Merge conflicts, failing CI, a moved head or a review below 5/5 never merge: `next` tells the agent to fix, push and run `review` again.
- **Blocked.** Past `ship.mergeTimeoutMs` on one head commit, or on a terminal GitHub refusal (missing permission, requested changes, a closed PR; a branch-protection hold such as a missing approval is retried until the bound instead), the ship blocks and the PR comment lists the attempt history.

Every review result and merge outcome is recorded in `ship.attempts` (newest 50); `<clone>/bin/ultrathink-ship status --state <stateFile>` shows them. The merge gate never weakens, and the agent never merges any other way (no `gh pr merge`, no web UI). The defaults:

```json
{ "ship": { "reviewRetries": 3, "mergeTimeoutMs": 3600000 } }
```

`ship.reviewRetries` is an integer >= 0; `ship.mergeTimeoutMs` is an integer >= 1 ms (3600000 = 60 minutes). See [Merge retries](../ship.md#merge-retries).

You can ask the agent to run the `ultrathink-ship` skill yourself too, or drive the CLI directly: see [bin/ultrathink-ship](../ship.md#binultrathink-ship).

## Merge by hand

With `ship.autoMerge: false` (the default) the flow stops once the PR is ready: `merge` refuses with `autoMerge disabled`, and `run` reports `next: "autoMerge disabled: merge manually"`. The agent tells you the PR is ready, runs `ultrathink-sync` with the current PR status, and reports.

Merge on GitHub the way you normally do. ultrathink does not watch the PR after that. To mark the tracked rows as merged, ask the agent to invoke `ultrathink-sync` with the PR URL.

## Turn it off again

- `"ship": { "enabled": false }` in config, for every host.
- `ULTRATHINK_SHIP=0` in the environment, for that process only.

Either way the plan has no `## Ship` section and no nudge is sent. `bin/ultrathink-ship` still works when you run it yourself.

For what ship sends to GitHub, Greptile and the engine, see [Privacy](../privacy.md).
