---
name: ultrathink-sync
description: Invoked after opening a pull request for a task ultrathink-kickoff tracked, or at a natural stopping point (nudged by the pr-sync/Stop hooks; on Hermes, by the plugin when a tool call opens a PR and when a coding turn is about to finish with a tracked plan that has not been synced), or manually to push a status update. On Hermes it loads as `ultrathink:ultrathink-sync`. Finds the tracked Notion Task row by Graph ID and updates PR/status fields on it and on the matching Linear issue. Never creates new rows — ultrathink-kickoff does that.
---

# ultrathink-sync

You were nudged (or asked) to sync a tracked task. You'll have a `graphId` from the nudge message, or from context if invoked manually — if you don't have one, look at the current session's ultrathink state file (`<host state dir>/sessions/<sessionId>.json` — e.g. `~/.claude/ultrathink/` in Claude Code; the planner reports the exact `statePath` on other hosts) for `plan.graphId`. The Hermes nudges pass that file as `stateFile=<path>` (and the pull request as `prUrl=<url>` when the session opened one): read `plan.graphId` from it.

## 1. Find the tracked Task row

The trackers are the Notion data source `notion.dataSourceUrl` (a `collection://…` URL) and the Linear team `linear.team` from the ultrathink config: `~/.config/ultrathink/config.json`, `~/.claude/ultrathink.json` and `<project>/.claude/ultrathink.json`, later files winning. `<repo>/bin/ultrathink status`, run from the project directory, prints both as `Notion: …` and `Linear team: …` (`not configured` when unset); `<repo>` is the plugin root (this file is `<repo>/skills/ultrathink-sync/SKILL.md`). Skip a tracker that is not configured silently. With neither configured there is nothing to sync: stop here without a report and carry on. If the user asks to set up Notion tracking, `<repo>/bin/ultrathink-mcp notion init --parent <page url or id> --write-config` creates the database and saves its `notion.dataSourceUrl` to `~/.config/ultrathink/config.json`.

Query the configured Notion data source for the row where `Level = "Task"` and `Graph ID` equals the `graphId`. Look rows and issues up by Graph ID only — the Notion Task by `Graph ID`, the Linear issues by the state file's `tracking` refs or the `ultrathink graph <graphId>` footer (see below) — never by branch, PR title or repo, even when one of those looks like a match. If none is found, stop — there is nothing to sync (do not create one; that is `ultrathink-kickoff`'s job, not this one's). Without Notion configured, skip this lookup and update only the Linear issues.

## 2. Update whatever changed

Update only the properties that actually have new information right now — don't overwrite a field with nothing. A turn without a pull request never clears or overwrites `PR URL`/`PR #`:

| Situation | Notion properties to set | Linear mirror |
|---|---|---|
| A pull request was just opened | `PR URL`, `PR #`, `Repo`, `Branch`, `PR State = "Open"` | move the Linear issue(s) for this task to their "In Review" workflow state |
| CI/checks reported | `Checks` (`"Pending"` / `"Passing"` / `"Failing"` / `"Blocked"`) | — |
| Reviewers assigned | `Reviewers` | — |
| The PR was approved | `PR State = "Approved"` | — |
| The PR was merged | `PR State = "Merged"`, `Status = "Merged"`, `Completed` = now | move the Linear issue(s) to "Done" |
| Work stopped without a PR (research/investigation task) | `Status = "Done"` (or `"Failed"`/`"Blocked"` if it didn't finish), `Completed` = now if terminal | move the Linear issue(s) to match |
| Still in progress, just checking in | `Status = "Implementing"` (leave as-is if already there) | move node issues whose TODOs are done to "Done" |

Apply only the columns of configured trackers. When both are configured, set `Linear State` on the Notion row to mirror whatever you just set on the actual Linear issue(s), so the two stay consistent.

### Locating the Linear issues

Read `tracking` from the same state file: `tracking.linear.nodes[<nodeId>]` and `tracking.linear.steps["<nodeId>.<step>"]` hold `{ id, identifier, url }` for every node issue and step sub-issue. Fallback when `tracking` is absent: Linear `list_issues` with `query` = `ultrathink graph <graphId>` (every planner-created issue ends its description with that footer).

- Attach the PR with `save_issue` (`id` = the identifier, `links` = `[{ url: <PR URL>, title: "PR #<n>" }]`) on each node issue it covers.
- Move the state of node issues whose TODO lines (and step sub-issues) are done; leave the rest.
- Never create issues or rows here, even if some are missing — that is `ultrathink-kickoff`'s job.

### When a tracker is down

If Notion or Linear is down, unreachable, rate-limited or unauthorised, do not retry in a loop. Say in one line which tracker could not be updated, update the other one if it works, and continue — a tracker outage never blocks the turn, least of all the one that created the PR.

## 3. Report

State in one line what you updated (or that there was nothing new to sync). When you have the state file, then run `<repo>/bin/ultrathink-mcp session mark --state <stateFile> synced` once and ignore any failure; it records `synced: true` in the session record, which stops the Hermes end-of-turn nudge. Then continue whatever you were doing before this nudge — this skill does not change the task at hand, it only records progress.
