# Ship: PR, Greptile review, merge

Ship is opt-in. With `ship.enabled` on, when a planned skill run finishes (a GSD `gsd-*` skill by default), ultrathink tells the agent to invoke the `ultrathink-ship` skill. The skill takes the branch from "done" to a reviewed PR:

1. It checks that the task is really done.
2. It opens a PR into the repository's default branch.
3. It runs Greptile review rounds until the score is 5/5 with zero open comments.
4. With `ship.autoMerge` on, it merges the PR (squash by default), retrying until the 5/5-reviewed PR merges. With `ship.deleteBranch` on, it then deletes the branch. Both are off by default, so the PR is left for you to merge.
5. It runs `ultrathink-sync`, so the tracked Linear and Notion rows get the PR link and status.

The skill drives `bin/ultrathink-ship`. Each gate is enforced by that CLI, not left to the agent. For a step-by-step setup, see [Ship with Greptile](how-to/ship-with-greptile.md).

- [Requirements](#requirements)
- [Trigger](#trigger)
- [Done assessment](#done-assessment)
- [GSD tools](#gsd-tools)
- [Pull request](#pull-request)
- [Review: PR mode and CLI mode](#review-pr-mode-and-cli-mode)
- [Blocked before review](#blocked-before-review)
- [Pending reviews and resume](#pending-reviews-and-resume)
- [Fix loop and blocking](#fix-loop-and-blocking)
- [Merge gate](#merge-gate)
- [Merge retries](#merge-retries)
- [Merge and branch cleanup](#merge-and-branch-cleanup)
- [Manual merge](#manual-merge)
- [bin/ultrathink-ship](#binultrathink-ship)
- [Configuration](#configuration)
- [Turning ship off](#turning-ship-off)

## Requirements

| Requirement | Used for |
|---|---|
| `git` with an `origin` remote on github.com. GitHub Enterprise Server and other hosts are not supported for now. | branch state, push, branch deletion |
| `gh`, logged in (`gh auth status`) with rights to push, open PRs and, for auto-merge, merge | default branch, PR create and view, merge, PR comments, review threads |
| A Greptile credential in the ultrathink credential store (`bin/ultrathink-mcp auth set-key greptile --stdin`, or `bin/ultrathink-mcp auth login greptile`) | PR mode review, when Greptile lists the repository |
| The Greptile CLI (tested with 3.4.1), signed in with `greptile login` | CLI mode review, when PR mode is not available |
| A working engine: a logged-in `claude` CLI, or `grok login` (or your shunt gateway) when `think.engine` is `"grok"` | the done judge; required when `ship.autoMerge` is `true` |
| Optional: GSD's `gsd-tools.cjs`, and `node` on `PATH` to run it | GSD roadmap progress in the assessment, when the repository has `.planning/ROADMAP.md` (see [GSD tools](#gsd-tools)) |
| Bun 1.2 or later | `bin/ultrathink-ship` itself; without Bun it exits 127 with an install hint |

You need at least one of the two Greptile setups. See [Tracking](tracking.md) and [Register the MCP gateway](how-to/register-mcp-gateway.md) for the credential store, and [Choose the engine](how-to/choose-engine.md) for the engine.

## Trigger

Ship applies only when all of these hold:

- `ship.enabled` is `true` (the default is `false`) and `ULTRATHINK_SHIP` is not `0`.
- The prompt invoked a skill whose name starts with one of the `ship.skills` prefixes (`gsd-` by default). With `ship.skills: []`, every planned prompt matches.

When they hold, the agent is told in these ways:

| Where | Hosts | What happens |
|---|---|---|
| The plan | every host, Hermes included | The injected plan ends with a `## Ship` section: when the run is finished, invoke `ultrathink-ship` with `stateFile=<session record>`. It gives the absolute CLI path and the skill file to read if the host does not list the skill, and says the PR is merged only when `ship.autoMerge` is on, with the merge retried until the 5/5-reviewed PR merges, and left for a manual merge otherwise. |
| Stop hook | Claude Code, Grok Build (through the global hook file), Muse Code | When the agent tries to stop, the hook blocks the stop once and asks it to invoke `ultrathink-ship`. |
| `agent_end` | Omp | The extension sends one `ultrathink-ship` aside card. |

The Stop hook and `agent_end` nudges also require:

- the prompt invoked a skill (with `ship.skills: []` too);
- the session record has a plan, so the prompt was planned by an engine (a prompt that got the fallback spec has none);
- local git shows committed work on a feature branch: not detached, not on the default branch (`origin/HEAD`, else `origin/master` or `origin/main`), and at least one commit ahead of `origin/<default>`;
- the session has not been nudged before, and its ship is not already `merged` or `blocked`.

The nudge fires once per session. Its time is recorded as `ship.nudgedAt` in the session record.

## Done assessment

`bin/ultrathink-ship assess` decides whether the task is finished. Rules run first. Any of these makes the task not done:

- the checkout is on the default branch;
- there are no commits ahead of the base and no changes;
- tracked files have uncommitted changes.

When the repository has `.planning/ROADMAP.md`, these GSD rules also apply:

- `.planning/ROADMAP.md` is not tracked by git and `.planning/` is not ignored (possibly stray planning written by another tool);
- `gsd-tools.cjs` was not found, or `node` is not on `PATH` to run it (see [GSD tools](#gsd-tools));
- the GSD roadmap (`gsd-tools.cjs query roadmap.analyze`) has incomplete phases;
- the latest `.planning/phases/*/*-VERIFICATION.md` has a status other than `passed`.

`assess --ignore-gsd` leaves all the GSD rules out. Use it only when you have decided the repository's `.planning/` roadmap is separate work from this change, for example planning that belongs to another effort. The judge still reads the request, the plan and the diff, and the PR body records `GSD roadmap: excluded by the operator`.

When the rules pass, an LLM judge runs on the configured engine. It reads:

- the original request and the spec,
- the graph goal and workflow,
- the clarifications and the GSD signals,
- the diff stat and the commit log,
- the patch itself, capped at 24,000 characters, with lockfiles left out.

The task is done only when the judge says done with a confidence of at least 0.7. When unsure, the judge answers not done. If the judge fails or its reply cannot be parsed, the task is not done.

If no engine is available (for example the Grok login is missing):

- with `ship.autoMerge: true`, the task is not done ("no judge available");
- with `ship.autoMerge: false`, the rules alone decide, with confidence 0.5.

When the task is not done, the skill hands the gaps back to you and opens no PR. The agent may finish work only when the gaps are clearly its own unfinished work from the same run.

## GSD tools

GSD is a separate open-source planning workflow for coding agents. Its skills are named `gsd-*`, and it keeps its roadmap, plans and verification reports in `.planning/`. Its script `gsd-tools.cjs` reads the roadmap.

`assess` uses `GSD_TOOLS` when it is set. Otherwise it takes the first of these that exists (`<repo>` is the working tree being shipped):

1. `<repo>/gsd-core/bin/gsd-tools.cjs`
2. `<repo>/.claude/gsd-core/bin/gsd-tools.cjs`
3. `<repo>/.codex/gsd-core/bin/gsd-tools.cjs`
4. `<repo>/.claude/get-shit-done/bin/gsd-tools.cjs` (older project-local installs)
5. `$CLAUDE_CONFIG_DIR/gsd-core/bin/gsd-tools.cjs`, when `CLAUDE_CONFIG_DIR` is set
6. `~/.claude/gsd-core/bin/gsd-tools.cjs`
7. `~/.agents/gsd-core/bin/gsd-tools.cjs`
8. `${HERMES_HOME:-~/.hermes}/gsd-core/bin/gsd-tools.cjs`
9. `${CODEX_HOME:-~/.codex}/gsd-core/bin/gsd-tools.cjs`
10. `${GEMINI_CONFIG_DIR:-~/.gemini}/gsd-core/bin/gsd-tools.cjs`
11. `~/.cursor/gsd-core/bin/gsd-tools.cjs`
12. `${XDG_CONFIG_HOME:-~/.config}/opencode/gsd-core/bin/gsd-tools.cjs`
13. `~/.claude/get-shit-done/bin/gsd-tools.cjs` (older installs)

It runs the script with `node`, which must be on `PATH`. If the repository has `.planning/ROADMAP.md` and none of these exists, the assessment reports the gap `GSD roadmap found but gsd-tools.cjs was not found; set GSD_TOOLS or rerun assess with --ignore-gsd`. If the script is found but `node` cannot be started (exit 127 or `ENOENT`), the gap is `GSD roadmap found but node is not on PATH, so gsd-tools.cjs could not run; install Node.js or rerun assess with --ignore-gsd`. If the script runs but fails or prints no usable JSON, the roadmap counts as 0 of 0 phases and the other rules, including the latest verification status, still apply.

To ship without GSD, set `ship.skills` to `[]` or to your own skill prefixes. A repository without `.planning/ROADMAP.md` never needs GSD.

## Pull request

`bin/ultrathink-ship pr` requires a `done` assessment, the same branch as at assessment time, a feature branch and no uncommitted tracked changes. The skill commits only the files the agent itself edited, by explicit path. It then:

1. reads the default branch from GitHub (`gh repo view`), not an assumed `main`;
2. pushes the branch (`git push -u origin <branch>`);
3. reuses the open PR for the branch, or creates one.

The PR title comes from the graph goal, or the first line of the request when there is no graph. The body has the summary, `Fixes <identifier>` lines for the tracked Linear issues, the Notion task link, the assessment and an `ultrathink graph <graph id>` footer. In the text ultrathink puts into the title and body, control characters are stripped, and absolute local paths under `/home/`, `/Users/`, `/root/`, `/tmp/`, `/var/` or `/private/`, as well as Windows drive paths such as `C:\…`, are replaced with `<local path>`. Nothing else is redacted.

## Review: PR mode and CLI mode

`bin/ultrathink-ship review` runs one Greptile review round for the current PR head. First it checks that the local `HEAD` equals the PR head, so the reviewed code is the code that would be merged. If they differ, it refuses and asks you to push.

Every Greptile API call carries `ship.greptileOrganization` as the organization when it is set.

| | PR mode | CLI mode |
|---|---|---|
| Used when | A Greptile credential is stored, and the Greptile API lists the repository with reviews not disabled for it | No Greptile credential is stored; or the account does not list the repository, lists it with reviews disabled, or the repository lookup fails for any reason other than the organization choice (see [Blocked before review](#blocked-before-review)) |
| Finds a review | Reuses Greptile's review of the PR head commit. Greptile reviews pushes to indexed repositories on its own. It triggers a review only when none exists for that commit or the last one failed or timed out; a review already recorded as a failed or timed-out round is ignored, so a fresh one starts. | `greptile review status --commit <head> --json` finds a finished or running review for the head commit. Only when none exists, or the run it finds was already recorded as a failed or timed-out round, does it start `greptile review --json -b <base>`. |
| Score | `Confidence Score: N/5` in the review body | `confidence` in the CLI's JSON |
| Open comments | The PR's Greptile review threads that are neither resolved nor outdated on GitHub (`gh api graphql`). Greptile reviews incrementally and does not repeat an unfixed finding, and it does not mark fixed ones addressed, so the thread state decides. A thread goes outdated when a commit changes its line. If the thread lookup fails, every unaddressed Greptile comment on the PR stays open. | The run's `comments` (fetched with `greptile review show <runId> --json` when needed) |

A review that finishes gives a completed round with its score and comments. A failed review (Greptile `FAILED`/`ERROR`/`SKIPPED`, no score, or a CLI failure) gives a failed round. When a credential is stored but CLI mode is used anyway and the Greptile CLI is not installed, the round fails.

A failed round, or one pending past `ship.reviewTimeoutMs`, is not a verdict on the code. The next `review` call re-triggers the review of the same head commit, up to `ship.reviewRetries` times (default 3) per head commit; its `next` says `run review again to re-trigger it (retry <k> of <n>)`. When the review of that head still fails or times out after that many re-triggers, the ship blocks with a PR comment. These rounds never count toward `ship.maxRounds`.

## Blocked before review

Two setup problems stop the flow before any round is recorded. `review` then returns `ok: false`, `blocked: true`, `status: "blocked"` and the reason, and `next: "stop: <reason>"`. The phase becomes `blocked`, nothing counts toward `ship.maxRounds` and no PR comment is posted. The skill reports the reason to you and stops. Run `review` again after you fix it.

| Cause | Reason |
|---|---|
| No Greptile credential is stored, and the Greptile CLI is not installed or `greptile whoami` says it is signed out | ``Greptile is not set up: run `bin/ultrathink-mcp auth set-key greptile --stdin` (or `auth login greptile`), or install and sign in to the greptile CLI (`greptile login`)`` |
| The Greptile account belongs to several organizations and `ship.greptileOrganization` is empty (Greptile answers `tenant_required`) | `Greptile account has several organizations; set ship.greptileOrganization in ~/.config/ultrathink/config.json (one of: <ids or handles>)`. The list appears when Greptile's error names the candidates. |

Any other `greptile whoami` failure, such as a network error or a timeout, is not treated as "not set up": the CLI review runs and reports its own error.

## Pending reviews and resume

A Greptile review takes minutes, longer than an agent's shell tool usually allows. So one `review` call blocks for at most `ship.waitMs` (100 seconds). It checks the review status at `ship.pollMs` intervals, starting at 20 seconds and growing to at most 60 seconds.

If the review is still running when the wait ends, `review` returns `status: "pending"`. It records the head commit, the review mode, the start time and the run id as `ship.pending`. Running `review` again picks up the same Greptile review and never starts a second one. A pending result is not a round.

A review of one head commit that stays pending longer than `ship.reviewTimeoutMs` (20 minutes) is recorded as a timed-out round.

In PR mode, a Greptile tool or network error while polling (for example a transient `Repository not found`) is also reported as `pending`, with the message in `error`, rather than as a failed review: the next `review` call retries and resumes the same run. If the error persists past `ship.reviewTimeoutMs`, the round is recorded as timed out and its error keeps the last tool error, and the next `review` call re-triggers the review (see [Review: PR mode and CLI mode](#review-pr-mode-and-cli-mode)). Only completed reviews that do not pass count toward `ship.maxRounds`: a score below `ship.minScore`, or open comments when `ship.requireNoComments` is enabled. Failed and timed-out reviews count toward `ship.reviewRetries` instead.

Every step can be repeated safely. `pr` reuses the open PR, `review` reuses a completed review of the same head commit, and `merge` notices a PR that is already merged. In PR mode a reused review, and `merge` itself, re-read the review threads, so a thread resolved since then no longer counts as open and a finding posted since then does. If the threads cannot be read, `review` reports not ready and `merge` retries (see [Merge retries](#merge-retries)); neither falls back to the stored comments. After an interruption, `bin/ultrathink-ship status` prints the stored state, and the skill continues from its `phase`.

## Fix loop and blocking

After each round the phase is one of:

| Phase | Meaning | Next |
|---|---|---|
| `ready` | The merge gate passes | run `merge` (with `ship.autoMerge`), else [merge by hand](#manual-merge) |
| `needs-fixes` | The gate fails and rounds remain, or a failed or timed-out review will be re-triggered | The agent fixes the findings (security issues first, then P0, P1, P2), commits only the files it edited, pushes and runs `review` again. It never suppresses lint rules, weakens tests or skips checks to satisfy the reviewer. After a failed or timed-out review there is nothing to fix: the agent runs `review` again to re-trigger it. |
| `pr-open` | The review passed (5/5, no open comments) but the PR is still waiting: CI pending or failing, mergeability not computed, or merge conflicts | Not a failed round: it never counts toward `maxRounds` or blocks the ship. Run `merge`: it keeps retrying through pending CI and mergeability not computed (see [Merge retries](#merge-retries)). For failing CI or conflicts, fix them, push, and run `review` again. |
| `blocked` | Greptile is not usable as configured ([Blocked before review](#blocked-before-review)), `ship.maxRounds` completed reviews below 5/5 or with open threads (rounds whose review passed and only waited do not count), the review of one head commit still failing or timing out after `ship.reviewRetries` re-triggers, `merge` still not possible after `ship.mergeTimeoutMs` on one head commit, a terminal GitHub merge refusal, the PR was closed without merging, or it was merged outside the ship flow before its review passed | For an open PR, the CLI posts one comment with the reason, the score, up to 20 remaining findings and the last 10 attempts, and leaves the PR for a human. `run` reports `ok: false`. A PR merged outside the flow after a passing review of its exact head is `ready`: `merge` skips the merge and finishes the branch cleanup. |

The skill also stops and reports when two rounds in a row return the same findings.

In PR mode a fix closes its finding: the commit changes the line, so GitHub marks the thread outdated. A finding that is not actionable, because it is factually wrong or describes intended behavior, gets a one-line reply on its thread and is then resolved. The `review` output gives each finding's `threadId`:

```sh
gh api graphql -f query='mutation($thread: ID!, $body: String!) { addPullRequestReviewThreadReply(input: {pullRequestReviewThreadId: $thread, body: $body}) { comment { id } } }' -f thread=<threadId> -f body='<one-line reason>'
gh api graphql -f query='mutation($thread: ID!) { resolveReviewThread(input: {threadId: $thread}) { thread { isResolved } } }' -f thread=<threadId>
```

The agent never resolves a finding just to pass the gate.

## Merge gate

`merge` refuses with `autoMerge disabled` before doing anything else unless `ship.autoMerge` is `true`: it does not merge, delete branches or change the phase (see [Manual merge](#manual-merge)). With `ship.autoMerge` on, it checks the gate again and merges only when every condition holds. The gate never weakens: retries only wait for it to pass.

| Check | Fails with | Then |
|---|---|---|
| A review round exists and it completed | `no review has run`, `review failed`, `review timeout` | back to the agent: run `review` again |
| The reviewed commit is the current PR head | `PR head changed since last review` | back to the agent: run `review` again |
| The review has a score of at least `ship.minScore` (default 5, Greptile's maximum) | `review has no score`, `review score N/5 is below M/5` | back to the agent: run `review` again |
| No open comments, when `ship.requireNoComments` is `true`. In PR mode these are the unresolved, non-outdated Greptile review threads; in CLI mode, the run's comments. | `N open review comment(s)` | back to the agent: run `review` again |
| The PR is open | `PR closed without merge` | the phase becomes `blocked` |
| GitHub reports the PR mergeable | `merge conflicts`, or `GitHub has not computed mergeability yet` | conflicts go back to the agent; uncomputed mergeability is retried |
| CI checks are neither failing nor pending | `CI checks failing`, `CI checks pending` | failing CI goes back to the agent; pending CI is retried |

The skill never merges any other way, with no `gh pr merge` by hand and no web UI.

## Merge retries

Once the latest review of the exact PR head has passed, `merge` keeps retrying within one call until the PR merges, the outcome needs the agent or blocks, or the call's `ship.waitMs` runs out. It polls starting at `ship.pollMs`, growing to at most 60 seconds.

| Outcome | Causes | What happens |
|---|---|---|
| Retried | CI checks pending, mergeability not computed yet, unreadable PR state or review threads, GitHub's `the base branch policy prohibits the merge` (for example a required approval not given yet), a transient GitHub merge error (network or rate limit) | `merge` waits and tries again. When the call's time runs out it returns `ok: false`, `waiting: true` and `next: "run merge again: <reason> (waited <m> of <limit> min on this commit; it keeps retrying until the PR merges)"`. The agent runs `merge` again. |
| Back to the agent | no review has run, merge conflicts, failing CI, a PR head moved since the review, a latest review that does not pass (below 5/5, open threads, failed or timed out), a GitHub error saying the branch is out of date or not mergeable (other than the base branch policy) | `merge` returns `ok: false` with `next`: fix, commit, push, then run `review` again. It never merges and never blocks. |
| Blocked | `merge still not possible after <minutes> min on <sha7>: <reason>` past `ship.mergeTimeoutMs`; `merge refused by GitHub: <error>` for a terminal refusal (required approving review, missing permission, closed PR) | The phase becomes `blocked` and the CLI posts one PR comment with the reason and the attempt history. |

When branch protection holds the merge (`the base branch policy prohibits the merge`, for example until a required approval is given), `merge` retries it until `ship.mergeTimeoutMs`, so a human can approve in the meantime and the next retry merges; past that bound the ship blocks with the PR comment.

The bound is per head commit: `ship.mergeTimeoutMs` (60 minutes by default) counts from the first time `merge` waited on that commit, across calls, and is stored as `ship.waiting`. A new head commit needs a new passing review and starts a new bound.

`run` merges within its own `ship.waitMs` budget when the review passed, and returns the same `waiting` result when that budget runs out.

Every review result and merge outcome is recorded in `ship.attempts` (newest 50) with its time, step, head commit, outcome, score and detail. `bin/ultrathink-ship status` shows them.

## Merge and branch cleanup

With `ship.autoMerge` on, when the gate passes, `merge`:

1. merges with `gh pr merge <n> --<method> --match-head-commit <sha>`. The method is `ship.mergeMethod` (`squash`). If the repository does not allow it, the first allowed method (squash, merge, rebase) is used and the output reports the substitution. It never uses `--admin`.
2. reads the PR back and counts the merge as done only when GitHub reports it `MERGED`.
3. with `ship.autoMerge` on and `ship.deleteBranch: true`, deletes the remote branch (`git push origin --delete <branch>`) after the merge is confirmed. It then checks out the base branch, fast-forwards it from `origin`, and deletes the local branch with `git branch -D`. With the default `false`, both branches stay and your checkout is not touched.

A PR already merged on GitHub counts as a ship merge only when the ship already recorded it, or when the latest review passed on the exact commit GitHub merged; then `merge` finishes the cleanup. Otherwise the phase becomes `blocked` with `PR was merged outside the ship flow before its review passed`, and nothing is cleaned up.

The phase becomes `merged`. The skill then runs `ultrathink-sync` with the PR URL, and reports the PR URL, the number of review rounds, the final score, and whether it merged or exactly why not.

## Manual merge

With `ship.autoMerge: false`, the default:

- the nudge and the `## Ship` section say the PR is left for a manual merge;
- the done assessment does not require the engine judge (see [Done assessment](#done-assessment));
- `run` stops after a passing review with `next: "autoMerge disabled: merge manually"`, and `merge` refuses with `autoMerge disabled`, so nothing retries a merge;
- the skill tells you the PR is ready to merge, runs `ultrathink-sync` with the current PR status, and reports.

Merge the PR on GitHub yourself. ultrathink does not watch it afterwards, and it deletes no branch. Only `merge` records the `merged` phase, so the stored ship state stays at its last phase: `bin/ultrathink-ship status` prints it, and `review` still re-reads the PR from GitHub. To record the merge in Linear and Notion, invoke `ultrathink-sync` again with the PR URL.

## bin/ultrathink-ship

```sh
<clone>/bin/ultrathink-ship <subcommand> --state <state dir>/sessions/<session-id>.json [--cwd <repo dir>] [--ignore-gsd]
```

`--state` is required. `--cwd` defaults to the current directory, so run it from the project's working tree or pass `--cwd`; the config files are read for that directory. Each call prints one JSON object. The exit code is 0, except 2 for usage errors and 127 when Bun is missing. Failures are reported in the JSON as `ok: false` with a `reason` or `error`.

| Subcommand | Does |
|---|---|
| `assess` | Collect the git, GSD and graph signals and judge whether the task is done. `--ignore-gsd` leaves the GSD roadmap out (see [Done assessment](#done-assessment)). |
| `pr` | Push the branch and open or reuse the PR into the default branch. |
| `review` | Run one Greptile review round in PR or CLI mode. Returns `pending` within `waitMs` while Greptile is still working, or `blocked` when Greptile is not usable as configured. |
| `merge` | Check the merge gate, merge, and (with `deleteBranch`) delete the branch, retrying transient failures within `waitMs` (see [Merge retries](#merge-retries)). Refuses with `autoMerge disabled` when `autoMerge` is off. |
| `run` | `assess`, `pr`, `review` and `merge` in one call. It stops at the first step that is not ready, and before `merge` when `autoMerge` is off. When the review passed, it merges within what is left of its `waitMs`. Fixes stay with the agent. |
| `status` | Print the stored ship state, including the attempt log. |

Progress is stored under `ship` in the session record. It holds `phase`, `assessment`, `pr`, `rounds`, `pending`, `waiting`, `attempts`, `blockedReason`, `nudgedAt` and `mergedAt`. See [Configuration](configuration.md#state-directories) for where each host keeps the record.

## Configuration

These keys go in the `ship` section of any [config file](configuration.md#config-files):

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `false` | Add the ship instruction and nudges. |
| `autoMerge` | `false` | Allow `merge`. When `true`, the assessment also requires the engine judge. |
| `deleteBranch` | `false` | Delete the remote and local branch after a confirmed merge. |
| `skills` | `["gsd-"]` | Skill name prefixes that trigger ship. `[]` matches every planned prompt. |
| `greptileOrganization` | `""` | Greptile organization id or handle sent with every Greptile API call. `""` lets Greptile pick, which works for single-organization accounts. |
| `minScore` | `5` | Lowest Greptile score that may merge (1 to 5). |
| `requireNoComments` | `true` | Refuse to merge with open review comments. |
| `maxRounds` | `5` | Completed reviews below 5/5 or with open threads before the ship is blocked. Failed and timed-out reviews do not count. |
| `reviewRetries` | `3` | Re-triggers of a failed Greptile review (Greptile `FAILED`/`ERROR`/`SKIPPED`, no score, CLI failure) or one pending past `reviewTimeoutMs`, per head commit, before the ship blocks with a PR comment. Integer >= 0; `0` blocks on the first failure. |
| `mergeMethod` | `"squash"` | `"squash"`, `"merge"` or `"rebase"`. |
| `reviewTimeoutMs` | `1200000` | Pending time for one head commit before it counts as a timed-out round. |
| `mergeTimeoutMs` | `3600000` | How long `merge` keeps retrying one reviewed head commit (60 minutes), from the first time it waited on it, before the ship blocks. Integer >= 1 ms. |
| `pollMs` | `20000` | First interval between review and merge status checks. |
| `waitMs` | `100000` | Longest one `review`, `merge` or `run` call blocks. |

A typical opt-in that keeps the merge with you:

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

Full auto-merge, with every other key at its default:

```json
{
  "ship": {
    "enabled": true,
    "autoMerge": true,
    "deleteBranch": true,
    "skills": ["gsd-"],
    "minScore": 5,
    "requireNoComments": true,
    "maxRounds": 5,
    "reviewRetries": 3,
    "mergeMethod": "squash",
    "reviewTimeoutMs": 1200000,
    "mergeTimeoutMs": 3600000,
    "pollMs": 20000,
    "waitMs": 100000
  }
}
```

`bin/ultrathink status` shows the result as `Ship: off (opt-in: set ship.enabled)`, `Ship: off (ULTRATHINK_SHIP=0)` or `Ship: on · auto-merge on|off · delete branch on|off`.

## Turning ship off

- `"ship": { "enabled": false }` in config (the default) turns it off for every host.
- `ULTRATHINK_SHIP=0` in the environment turns it off for that process.

Either way, the plan has no `## Ship` section and no nudge is sent. `bin/ultrathink-ship` still works when you run it yourself. To keep the review but merge by hand, leave `"autoMerge": false`: `run` then stops once the PR is ready.
