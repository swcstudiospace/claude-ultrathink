---
name: ultrathink-sync
description: Invoked after opening a pull request for a task ultrathink-kickoff tracked, or at a natural stopping point (nudged by the pr-sync/Stop hooks), or manually to push a status update. Finds the tracked Notion Task row by Graph ID and updates PR/status fields on it and on the matching Linear issue. Never creates new rows — ultrathink-kickoff does that.
---

# ultrathink-sync

You were nudged (or asked) to sync a tracked task. You'll have a `graphId` from the nudge message, or from context if invoked manually — if you don't have one, look at the current session's ultrathink state file (`~/.claude/ultrathink/sessions/<sessionId>.json`) for `plan.graphId`.

## 1. Find the tracked Task row

Query the Notion "🧩 Agent Task Graph" data source (`collection://be3418f0-d2d8-411b-8677-fa8a95ee63be` — confirm against your `notion` config if it has been overridden) for the row where `Level = "Task"` and `Graph ID` equals the `graphId`. If none is found, stop — there is nothing to sync (do not create one; that is `ultrathink-kickoff`'s job, not this one's).

## 2. Update whatever changed

Update only the properties that actually have new information right now — don't overwrite a field with nothing:

| Situation | Notion properties to set | Linear mirror |
|---|---|---|
| A pull request was just opened | `PR URL`, `PR #`, `Repo`, `Branch`, `PR State = "Open"` | move the Linear issue(s) for this task to their "In Review" workflow state |
| CI/checks reported | `Checks` (`"Pending"` / `"Passing"` / `"Failing"` / `"Blocked"`) | — |
| Reviewers assigned | `Reviewers` | — |
| The PR was approved | `PR State = "Approved"` | — |
| The PR was merged | `PR State = "Merged"`, `Status = "Merged"`, `Completed` = now | move the Linear issue(s) to "Done" |
| Work stopped without a PR (research/investigation task) | `Status = "Done"` (or `"Failed"`/`"Blocked"` if it didn't finish), `Completed` = now if terminal | move the Linear issue(s) to match |
| Still in progress, just checking in | `Status = "Implementing"` (leave as-is if already there) | — |

Set `Linear State` on the Notion row to mirror whatever you just set on the actual Linear issue(s), so the two stay consistent.

## 3. Report

State in one line what you updated (or that there was nothing new to sync). Then continue whatever you were doing before this nudge — this skill does not change the task at hand, it only records progress.
