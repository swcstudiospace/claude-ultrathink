---
name: ultrathink-ship
description: Invoked with a stateFile after a GSD skill run finishes (or when the Ultrathink Stop hook or plan says so) to decide whether the task is really done and, if so, open a PR into the repository's default branch, run the Greptile review until 5/5 with no open comments, then merge and delete the branch. Do not invoke it for anything else.
---

# ultrathink-ship

You have a `stateFile` (the session's `<state dir>/sessions/<id>.json`) from the nudge or the plan's `## Ship` section. Every step uses the plugin's CLI, `bin/ultrathink-ship <subcommand> --state <stateFile> [--cwd <repo dir>]`, which prints one JSON object. `bin/ultrathink-ship` below means the absolute path given as `CLI:` in the nudge or the Ship section (in Claude Code also `${CLAUDE_PLUGIN_ROOT}/bin/ultrathink-ship`); run it from the project's working tree, or pass `--cwd`. Run the steps in order and never skip the gates.

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
- `ready`: go to step 4.
- Stop the loop and report when the phase is `blocked` (config `maxRounds`, default 5, reached or the review failed) or when two consecutive rounds return identical findings. On `blocked` the CLI has already posted a PR comment and left the PR open for a human; do not retry or merge.
- Never lower the bar: the only passing result is exactly 5/5 with zero open comments.
- `needs-fixes`: fix the findings in greploop order — `securityIssue` first, then P0, P1, P2. Make the smallest correct fix; never suppress lint rules, weaken or delete tests, or skip checks to satisfy the reviewer. Stage only the files you edited, commit `address greptile review feedback`, `git push`, then run `review` again.

## 4. Merge

`bin/ultrathink-ship merge --state <stateFile>`

It refuses unless the latest review is 5/5 with zero open comments, the reviewed commit is still the PR head, the PR is mergeable and CI is not failing; on success it squash-merges and deletes the branch locally and remotely. Never merge any other way (no `gh pr merge`, no web UI).

## 5. Record it

Invoke the ultrathink-sync skill with the stateFile and the PR URL (status merged, or the current PR status if not merged).

## 6. Report

One short summary: PR URL, review rounds, final Greptile score, and merged — or exactly why not.
