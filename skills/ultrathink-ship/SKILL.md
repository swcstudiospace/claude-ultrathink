---
name: ultrathink-ship
description: Invoked with a stateFile after a GSD skill run finishes (or when the Ultrathink Stop hook or plan says so) to decide whether the task is really done and, if so, open a PR into the repository's default branch, run the Greptile review until 5/5 with no open comments, then merge (only when `ship.autoMerge` is on, retrying until the 5/5-reviewed PR merges) and delete the branch (only when `ship.deleteBranch` is on). Do not invoke it for anything else.
---

# ultrathink-ship

You have a `stateFile` (the session's `<state dir>/sessions/<id>.json`) from the nudge or the plan's `## Ship` section. Every step uses the plugin's CLI, `bin/ultrathink-ship <subcommand> --state <stateFile> [--cwd <repo dir>]`, which prints one JSON object. `bin/ultrathink-ship` below means the absolute path given as `CLI:` in the nudge or the Ship section (in Claude Code also `${CLAUDE_PLUGIN_ROOT}/bin/ultrathink-ship` (quote it if the path contains spaces)); run it from the project's working tree, or pass `--cwd`. Run the steps in order and never skip the gates.

Ship is opt-in: Ultrathink only asks for this skill when `ship.enabled` is true in the ultrathink config (`~/.config/ultrathink/config.json`). Merging additionally needs `ship.autoMerge`, and deleting the branch after the merge needs `ship.deleteBranch`; both are off by default.

Every step is idempotent: it reuses an open PR, reuses a review of the same head commit and detects an already-merged PR. To resume after a partial failure, run `bin/ultrathink-ship status --state <stateFile>` and continue from the step its `phase` points to.

## 0. Is the task done?

`bin/ultrathink-ship assess --state <stateFile>`

If `done` is false, a GSD phase verification is `human_needed` or `gaps_found`, or the roadmap still has incomplete phases: never ship. Hand back to the user with the `gaps` (gsd-autonomous pause semantics) and do NOT open a PR. Only when the gaps are clearly your own unfinished work in this same run may you finish it and run `assess` again.

Exception, only on the user's explicit decision: when the user has said the repository's GSD roadmap is separate work (for example they chose not to run its phases for this change), run `bin/ultrathink-ship assess --state <stateFile> --ignore-gsd`. The roadmap and verification signals are left out, the judge still decides on the request, the plan and the diff, and the PR body records the exclusion. Never add the flag on your own initiative.

## 1. Commit your own finished work

If `assess` reports dirty tracked files that you created or edited in this task, commit them first: stage by explicit path (`git add <file> ...`), never `git add -A` / `git add .`, and never commit other people's changes. If you are unsure whose a change is, stop and ask the user.

## 2. Open the PR

`bin/ultrathink-ship pr --state <stateFile>` — pushes the branch and opens (or reuses) a PR into the default branch read from GitHub (never assume `main`).

## 3. Review loop

Always `git push` before `review`: it refuses when the local HEAD differs from the PR head, so the reviewed code is exactly the code that would be merged.

`bin/ultrathink-ship review --state <stateFile>`

`review` returns within about 100 seconds (config `waitMs`), well inside a shell tool's default timeout, even though a Greptile review can take several minutes.

- `status: "pending"`: the Greptile review is still running. Run the same command again (optionally wait ~30s first); it resumes the same Greptile run and never starts a duplicate. Pending never counts as a round. Only if a review of one head stays pending past config `reviewTimeoutMs` (20 min) is it recorded as a timed-out round.
- A failed review (Greptile FAILED/ERROR/SKIPPED, no score, CLI failure) or a timed-out one is not a verdict on your code: `next` says `run review again to re-trigger it (retry k of N)`. Run `review` again; it starts a fresh Greptile review of the same head. Config `ship.reviewRetries` (default 3) bounds these re-triggers per head commit; they never count toward `maxRounds`.
- `ready`: go to step 4.
- `pr-open` (the review passed: 5/5, no open findings, but the PR is still waiting): go to step 4; `merge` itself waits out pending CI and mergeability not computed yet. For failing CI or merge conflicts, fix them, commit, `git push`, then run `review` again. A waiting round never counts toward `maxRounds`.
- Stop the loop and report only when the phase is `blocked` (config `maxRounds` completed reviews below 5/5 or with open threads reached, default 5; a review of one head still failed or timed out after `ship.reviewRetries` re-triggers; the PR was closed; or it was merged outside the flow before its review passed) or when two consecutive rounds return identical findings. On `blocked` the CLI has already posted a PR comment (for an open PR) with the attempt history and left it for a human; do not retry or merge.
- `status: "blocked"` with no round recorded means Greptile is not usable as configured (not set up, or the account needs `ship.greptileOrganization`): report the `reason` to the user verbatim and stop; run `review` again only after they fixed it.
- Never lower the bar: the only passing result is exactly 5/5 with zero open comments.
- `needs-fixes`: fix the findings in greploop order — `securityIssue` first, then P0, P1, P2. Make the smallest correct fix; never suppress lint rules, weaken or delete tests, or skip checks to satisfy the reviewer. Stage only the files you edited, commit `address greptile review feedback`, `git push`, then run `review` again.
  - In PR mode the open findings are the PR's Greptile review threads that are neither resolved nor outdated. Changing a finding's line makes its thread outdated, so a real fix closes it.
  - A finding that is not actionable (factually wrong, or intended behavior) has no fix. Reply on its thread with a one-line reason, then resolve it, using the finding's `threadId` from the `review` output:

    ```sh
    gh api graphql -f query='mutation($thread: ID!, $body: String!) { addPullRequestReviewThreadReply(input: {pullRequestReviewThreadId: $thread, body: $body}) { comment { id } } }' -f thread=<threadId> -f body='<one-line reason>'
    gh api graphql -f query='mutation($thread: ID!) { resolveReviewThread(input: {threadId: $thread}) { thread { isResolved } } }' -f thread=<threadId>
    ```

    Then run `review` again; it re-reads the threads for the same head without a new round.
  - Never resolve a finding just to pass the gate. Resolve only when you can state why it is wrong or intended.

## 4. Merge

`bin/ultrathink-ship merge --state <stateFile>`

Only when `ship.autoMerge` is on. Otherwise `merge` refuses with `autoMerge disabled` (and `run` reports `autoMerge disabled: merge manually`): do not merge at all, tell the user the PR is ready for them to merge, and continue with steps 5 and 6.

The merge gate never changes: a completed Greptile review of the exact PR head with score >= `ship.minScore` (default 5, Greptile's maximum) and no open threads, an open mergeable PR, CI neither pending nor failing. On success it merges with config `mergeMethod` (squash by default) and, only when `ship.deleteBranch` is on, deletes the branch locally and remotely. `run` also merges within its own `ship.waitMs` budget when the review passed.

`merge` keeps retrying inside the call (pending CI, mergeability not computed, unreadable PR state or threads, transient GitHub errors) for up to `ship.waitMs`:

- `merged: true`: done; go to step 5.
- `waiting: true`: the call's time ran out; `next` says `run merge again: …`. Run `merge` again (optionally wait ~30s first) and keep going until it returns `merged: true` or the phase is `blocked`. Past `ship.mergeTimeoutMs` (60 min) on one head commit the ship blocks.
- `ok: false` without `waiting`, with a `next` (merge conflicts, failing CI, the PR head moved since the review, or the review is not passing): follow `next` — fix, commit, `git push` — then run `review` again. These never merge and never block.
- phase `blocked` (the retry bound ran out, or GitHub refused for good: missing permission, requested changes, closed PR): the CLI has posted a PR comment listing the attempt history; stop and report.

Never lower the bar, and never merge any other way (no `gh pr merge`, no web UI).

## 5. Record it

Invoke the ultrathink-sync skill with the stateFile, `graphId=` (the `plan.graphId` you read from the state file when this ship flow started, so a newer plan written to the same file meanwhile cannot take the PR) and the PR URL (status merged, or the current PR status if not merged). On Hermes, load it with `skill_view name="ultrathink:ultrathink-sync"` (a bare `ultrathink-sync` does not reach plugin skills there), or read `<repo>/skills/ultrathink-sync/SKILL.md`, where `<repo>` is the plugin root (the `CLI:` path without its trailing `/bin/ultrathink-ship`). The ship CLI opens the PR itself, so no PR nudge fires for it: this step is what records the PR.

## 6. Report

One short summary: PR URL, review rounds, final Greptile score, and merged — or ready to merge manually (`ship.autoMerge` off) — or exactly why not. When blocked, include the recent attempts from `bin/ultrathink-ship status --state <stateFile>` (its `attempts` log: time, step, commit, outcome, score, detail).
