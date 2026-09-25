# Ship: PR, Greptile review, merge

When a planned GSD skill run finishes, ultrathink tells the agent to invoke the `ultrathink-ship` skill. The skill takes the branch from "done" to merged:

1. It checks that the task is really done.
2. It opens a PR into the repository's default branch.
3. It runs Greptile review rounds until the score is 5/5 with zero open comments.
4. It squash-merges the PR, then deletes the branch.
5. It runs `ultrathink-sync`, so the tracked Linear and Notion rows get the PR link and the merged status.

The skill drives `bin/ultrathink-ship`. Each gate is enforced by that CLI, not left to the agent.

- [Requirements](#requirements)
- [Trigger](#trigger)
- [Done assessment](#done-assessment)
- [Pull request](#pull-request)
- [Review: PR mode and CLI mode](#review-pr-mode-and-cli-mode)
- [Pending reviews and resume](#pending-reviews-and-resume)
- [Fix loop and blocking](#fix-loop-and-blocking)
- [Merge gate](#merge-gate)
- [Merge and branch cleanup](#merge-and-branch-cleanup)
- [bin/ultrathink-ship](#binultrathink-ship)
- [Configuration](#configuration)
- [Turning ship off](#turning-ship-off)

## Requirements

| Requirement | Used for |
|---|---|
| `git` with an `origin` remote on GitHub | branch state, push, branch deletion |
| `gh`, logged in (`gh auth status`) with rights to push, open PRs and merge | default branch, PR create and view, merge, PR comments, review threads |
| A Greptile API key in the ultrathink credential store (`bin/ultrathink-mcp auth set-key greptile --stdin`) | PR mode review, when Greptile indexes the repository |
| The Greptile CLI (tested with 3.4.1), logged in with `greptile login` | CLI mode review, when PR mode is not available |
| A working engine: a Claude Code login, or `grok login` when `think.engine` is `"grok"` | the done judge |
| Optional: GSD's `gsd-tools.cjs` (`GSD_TOOLS`, default `~/.agents/gsd-core/bin/gsd-tools.cjs`) | GSD roadmap progress in the assessment |

You need at least one of the two Greptile setups. See [Tracking](tracking.md#greptile-key) for the credential store.

## Trigger

Ship applies only when all of these hold:

- `ship.enabled` is `true` and `ULTRATHINK_SHIP` is not `0`.
- The prompt invoked a skill whose name starts with one of the `ship.skills` prefixes (`gsd-` by default).

When they hold, the agent is told in these ways:

| Where | Hosts | What happens |
|---|---|---|
| The plan | every host, Hermes included | The injected plan ends with a `## Ship` section: when the run is finished, invoke `ultrathink-ship` with `stateFile=<session record>`. It gives the absolute CLI path and the skill file to read if the host does not list the skill. |
| Stop hook | Claude Code, Grok Build (through the global hook file), Muse Code | When the agent tries to stop, the hook blocks the stop once and asks it to invoke `ultrathink-ship`. |
| `agent_end` | Omp | The extension sends one `ultrathink-ship` aside card. |

The Stop hook and `agent_end` nudges also require:

- the session record has a plan, so the prompt was planned by an engine (a prompt that got the fallback spec has none);
- local git shows committed work on a feature branch: not detached, not on the default branch (`origin/HEAD`, else `origin/main` or `origin/master`), and at least one commit ahead of `origin/<default>`;
- the session has not been nudged before, and its ship is not already `merged` or `blocked`.

The nudge fires once per session. Its time is recorded as `ship.nudgedAt` in the session record.

## Done assessment

`bin/ultrathink-ship assess` decides whether the task is finished. Rules run first. Any of these makes the task not done:

- the checkout is on the default branch;
- there are no commits ahead of the base and no changes;
- tracked files have uncommitted changes;
- `.planning/` exists but is neither tracked by git nor ignored;
- the GSD roadmap (`gsd-tools.cjs query roadmap.analyze`) has incomplete phases;
- the latest `.planning/phases/*/*-VERIFICATION.md` has a status other than `passed`.

`assess --ignore-gsd` leaves the GSD roadmap and verification rules out. Use it only when you have decided the repository's `.planning/` roadmap is separate work from this change, for example planning that belongs to another effort. The judge still reads the request, the plan and the diff, and the PR body records `GSD roadmap: excluded by the operator`.

When the rules pass, an LLM judge runs on the configured engine. It reads:

- the original request and the spec,
- the graph goal and workflow,
- the clarifications and the GSD signals,
- the diff stat and the commit log,
- the patch itself, capped at 24,000 characters, with lockfiles left out.

The task is done only when the judge says done with a confidence of at least 0.7. When unsure, the judge answers not done. If the judge fails or its reply cannot be parsed, the task is not done. If no engine is available (for example the Grok login is missing) and `ship.autoMerge` is `true`, the task is not done ("no judge available").

When the task is not done, the skill hands the gaps back to you and opens no PR. The agent may finish work only when the gaps are clearly its own unfinished work from the same run.

## Pull request

`bin/ultrathink-ship pr` requires a `done` assessment, the same branch as at assessment time, a feature branch and no uncommitted tracked changes. The skill commits only the files the agent itself edited, by explicit path. It then:

1. reads the default branch from GitHub (`gh repo view`), not an assumed `main`;
2. pushes the branch (`git push -u origin <branch>`);
3. reuses the open PR for the branch, or creates one.

The PR title comes from the graph goal, or the first line of the request when there is no graph. The body has the summary, `Fixes <identifier>` lines for the tracked Linear issues, the Notion task link and the assessment. Local file paths such as `/home/<you>/…` are replaced with `<local path>`.

## Review: PR mode and CLI mode

`bin/ultrathink-ship review` runs one Greptile review round for the current PR head. First it checks that the local `HEAD` equals the PR head, so the reviewed code is the code that would be merged. If they differ, it refuses and asks you to push.

| | PR mode | CLI mode |
|---|---|---|
| Used when | The Greptile API (through the credential store) lists the repository and reviews are not disabled for it | PR mode is not available |
| Finds a review | Reuses Greptile's review of the PR head commit. Greptile reviews pushes to indexed repositories on its own. It triggers a review only when none exists for that commit or the last one failed. | `greptile review status --commit <head> --json` finds a finished or running review for the head commit. Only when none exists does it start `greptile review --json -b <base>`. |
| Score | `Confidence Score: N/5` in the review body | `confidence` in the CLI's JSON |
| Open comments | The PR's Greptile review threads that are neither resolved nor outdated on GitHub (`gh api graphql`). Greptile reviews incrementally and does not repeat an unfixed finding, and it does not mark fixed ones addressed, so the thread state decides. A thread goes outdated when a commit changes its line. If the thread lookup fails, every unaddressed Greptile comment on the PR stays open. | The run's `comments` (fetched with `greptile review show <runId> --json` when needed) |

A review that finishes gives a completed round with its score and comments. A failed review, or one with no score, gives a failed round.

## Pending reviews and resume

A Greptile review takes minutes, longer than an agent's shell tool usually allows. So one `review` call blocks for at most `ship.waitMs` (100 seconds). It checks the review status at `ship.pollMs` intervals, starting at 20 seconds and growing to at most 60 seconds.

If the review is still running when the wait ends, `review` returns `status: "pending"`. It records the head commit, the review mode, the start time and the run id as `ship.pending`. Running `review` again picks up the same Greptile review and never starts a second one. A pending result is not a round.

A review of one head commit that stays pending longer than `ship.reviewTimeoutMs` (20 minutes) is recorded as a timed-out round.

Every step can be repeated safely. `pr` reuses the open PR, `review` reuses a completed review of the same head commit, and `merge` notices a PR that is already merged. In PR mode a reused review re-reads the review threads, so a thread resolved since then no longer counts as open. After an interruption, `bin/ultrathink-ship status` prints the stored state, and the skill continues from its `phase`.

## Fix loop and blocking

After each round the phase is one of:

| Phase | Meaning | Next |
|---|---|---|
| `ready` | The merge gate passes | run `merge` |
| `needs-fixes` | The gate fails and rounds remain | The agent fixes the findings (security issues first, then P0, P1, P2), commits only the files it edited, pushes and runs `review` again. It never suppresses lint rules, weakens tests or skips checks to satisfy the reviewer. |
| `blocked` | `ship.maxRounds` rounds reached, or two failed or timed-out rounds on the same head commit | The CLI posts a PR comment with the reason, the score and up to 20 remaining findings, and leaves the PR open for a human. |

The skill also stops and reports when two rounds in a row return the same findings.

In PR mode a fix closes its finding: the commit changes the line, so GitHub marks the thread outdated. A finding that is not actionable, because it is factually wrong or describes intended behavior, gets a one-line reply on its thread and is then resolved. The `review` output gives each finding's `threadId`:

```sh
gh api graphql -f query='mutation($thread: ID!, $body: String!) { addPullRequestReviewThreadReply(input: {pullRequestReviewThreadId: $thread, body: $body}) { comment { id } } }' -f thread=<threadId> -f body='<one-line reason>'
gh api graphql -f query='mutation($thread: ID!) { resolveReviewThread(input: {threadId: $thread}) { thread { isResolved } } }' -f thread=<threadId>
```

The agent never resolves a finding just to pass the gate.

## Merge gate

`merge` checks the gate again and refuses unless every condition holds:

| Check | Fails with |
|---|---|
| A review round exists and it completed | `no review has run`, `review failed`, `review timeout` |
| The reviewed commit is the current PR head | `review is for an older commit` or `PR head changed since last review` |
| The review has a score of at least `ship.minScore` (5) | `review score N/5 is below 5/5` |
| No open comments, when `ship.requireNoComments` is `true`. In PR mode these are the unresolved, non-outdated Greptile review threads; in CLI mode, the run's comments. | `N open review comment(s)` |
| The PR is open | `PR closed without merge` (the phase becomes `blocked`) |
| GitHub reports the PR mergeable | `merge conflicts`, or `GitHub has not computed mergeability yet` |
| CI checks are neither failing nor pending | `CI checks failing`, `CI checks pending` |

`ship.autoMerge: false` makes `merge` refuse with `autoMerge disabled`. The skill never merges any other way, with no `gh pr merge` by hand and no web UI.

## Merge and branch cleanup

When the gate passes, `merge`:

1. merges with `gh pr merge <n> --<method> --match-head-commit <sha>`. The method is `ship.mergeMethod` (`squash`). If the repository does not allow it, the first allowed method is used and the output reports the substitution. It never uses `--admin`.
2. reads the PR back and counts the merge as done only when GitHub reports it `MERGED`.
3. with `ship.deleteBranch` (the default), deletes the remote branch (`git push origin --delete <branch>`) only after the merge is confirmed. It then checks out the base branch, fast-forwards it from `origin`, and deletes the local branch with `git branch -D`.

The phase becomes `merged`. The skill then runs `ultrathink-sync` with the PR URL, and reports the PR URL, the number of review rounds, the final score, and whether it merged or exactly why not.

## bin/ultrathink-ship

```sh
<clone>/bin/ultrathink-ship <subcommand> --state <state dir>/sessions/<session-id>.json [--cwd <repo dir>]
```

`--state` is required. `--cwd` defaults to the current directory, so run it from the project's working tree or pass `--cwd`. Each call prints one JSON object. The exit code is 0, except 2 for usage errors. Failures are reported in the JSON as `ok: false` with a `reason` or `error`.

| Subcommand | Does |
|---|---|
| `assess` | Collect the git, GSD and graph signals and judge whether the task is done. `--ignore-gsd` leaves the GSD roadmap out (see [Done assessment](#done-assessment)). |
| `pr` | Push the branch and open or reuse the PR into the default branch. |
| `review` | Run one Greptile review round in PR or CLI mode. Returns `pending` within `waitMs` while Greptile is still working. |
| `merge` | Check the merge gate, merge, and delete the branch. |
| `run` | `assess`, `pr`, `review` and `merge` in one call. It stops at the first step that is not ready. Fixes stay with the agent. |
| `status` | Print the stored ship state. |

Progress is stored under `ship` in the session record. It holds `phase`, `assessment`, `pr`, `rounds`, `pending`, `blockedReason`, `nudgedAt` and `mergedAt`. See [Configuration](configuration.md#state-directories) for where each host keeps the record.

## Configuration

These keys go in the `ship` section of any [config file](configuration.md#config-files):

| Key | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Add the ship instruction and nudges. |
| `autoMerge` | `true` | Allow `merge`. When `true`, the assessment also requires the engine judge. |
| `skills` | `["gsd-"]` | Skill name prefixes that trigger ship. `[]` matches every skill run, and every planned prompt gets the `## Ship` section. |
| `minScore` | `5` | Lowest Greptile score that may merge (1 to 5). |
| `requireNoComments` | `true` | Refuse to merge with open review comments. |
| `maxRounds` | `5` | Review rounds before the ship is blocked. |
| `mergeMethod` | `"squash"` | `"squash"`, `"merge"` or `"rebase"`. |
| `deleteBranch` | `true` | Delete the remote and local branch after the merge. |
| `reviewTimeoutMs` | `1200000` | Pending time for one head commit before it counts as a timed-out round. |
| `pollMs` | `20000` | First interval between review status checks. |
| `waitMs` | `100000` | Longest one `review` call blocks. |

```json
{
  "ship": {
    "enabled": true,
    "autoMerge": true,
    "skills": ["gsd-"],
    "minScore": 5,
    "requireNoComments": true,
    "maxRounds": 5,
    "mergeMethod": "squash",
    "deleteBranch": true,
    "reviewTimeoutMs": 1200000,
    "pollMs": 20000,
    "waitMs": 100000
  }
}
```

## Turning ship off

- `"ship": { "enabled": false }` in config turns it off for every host.
- `ULTRATHINK_SHIP=0` in the environment turns it off for that process.

Either way, the plan has no `## Ship` section and no nudge is sent. `bin/ultrathink-ship` still works when you run it yourself. To keep the review but merge by hand, set `"autoMerge": false`. `run` then stops once the PR is ready.
