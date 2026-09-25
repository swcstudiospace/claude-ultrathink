---
name: ultrathink-kickoff
description: Invoked with a stateFile path after the ultrathink planner ran an uplift+Graph-of-Thought+HITL pass on any host (the Claude Code or Grok UserPromptSubmit hook, or the Hermes/Muse/Omp entry). The planner already created the Linear issues/sub-issues and Notion Task/Issue/Sub-Issue rows through the shared MCP gateway; this skill finishes any missing rows with one command (manual MCP fallback only if that fails), registers the graph in the Agent Substrate index, resolves blocking clarifications, sets the Task to Implementing and hands back the full spec plus linked TODO lines. Do not invoke this for any other purpose.
---

# ultrathink-kickoff

You were told to invoke this skill with `stateFile=<path>`. Follow these steps in order. Tracking must be real (rows exist, links resolve) in every configured tracker before you start engineering work.

## 0. Read the state

Read the JSON file at `stateFile`. It is a `SessionRecord`:

```ts
interface IssueRef { id: string; identifier: string; url: string; title: string }
interface SessionRecord {
	sessionId: string;
	engine?: string;
	host?: string;
	result: { xml: string; original: string; root: string; source: "llm" | "fallback" };
	graph?: { goal: string; nodes: Array<{ id: string; title: string; kind: string; question: string; dependsOn: string[]; thinking?: string; conclusion?: string }> };
	clarifications?: Array<{ id: string; question: string; header: string; why: string; options: Array<{ label: string; description?: string }>; default?: string; blocking: boolean; answer?: string }>;
	plan?: {
		graphId: string;
		task: { graphId: string; item: string; description: string; upliftedPrompt: string; agent: string; status: string; linearState: string; repo?: string; branch?: string };
		issues: Array<{ graphId: string; nodeId: string; item: string; thought: string }>;
		subIssues: Array<{ graphId: string; nodeId: string; item: string; step: number; thought: string }>; // several per nodeId — one per rationale step
		linearIssues: Array<{ nodeId: string; title: string; description: string }>;
		linearSubIssues: Array<{ nodeId: string; step: number; title: string; description: string }>;
		hitl: { blocking: Array<Clarification>; nonBlocking: Array<Clarification> };
	};
	tracking?: {
		graphId: string;
		status: "complete" | "partial" | "failed";
		linearTeam?: string;
		linear: { nodes: Record<string, IssueRef>; steps: Record<string, IssueRef> }; // steps keyed "<nodeId>.<step>"
		notion: { taskUrl?: string; nodes: Record<string, string>; steps: Record<string, string> };
		errors: string[];
		updatedAt: number;
	};
}
```

The spec file is the same path with `.xml` instead of `.json` (`sessions/<id>.xml`); the prompt context also names it as the spec path.

If `plan` is missing (tracking failed to build), skip straight to step 5 with the spec file (or `result.xml`) as the final prompt — do not block on tracking. This is the fail-open path.

## 1. Finish tracking

Rows go to the Notion data source `notion.dataSourceUrl` (a `collection://…` URL) and the Linear team `linear.team` from the ultrathink config: `~/.config/ultrathink/config.json`, `~/.claude/ultrathink.json` and `<project>/.claude/ultrathink.json`, later files winning. `<repo>/bin/ultrathink status`, run from the project directory, prints both as `Notion: …` and `Linear team: …` (`not configured` when unset); `<repo>` is the plugin root (this file is `<repo>/skills/ultrathink-kickoff/SKILL.md`). Skip a tracker that is not configured silently: create nothing in it and do not mention it. If the user asks to set up Notion tracking, `<repo>/bin/ultrathink-mcp notion init --parent <page url or id> --write-config` creates the database and saves its `notion.dataSourceUrl` to `~/.config/ultrathink/config.json`.

- If `tracking.status` is `"complete"`: every row exists in each configured tracker. Skip all row creation and go to step 3.
- Otherwise run the command printed in the prompt's **Ultrathink tracking** section once with the shell tool:

  ```sh
  <repo>/bin/ultrathink-mcp track complete --state <stateFile>
  ```

  It creates only the missing Linear/Notion rows through the shared MCP gateway (reusing the host's stored OAuth logins), updates `tracking` in the state file, rewrites the spec's `<ISSUES>` block and prints the Linked-issues TODO lines. Re-read the state file afterwards. If it reports that tracking is not configured or turned off, go to step 3 without mentioning it. If it reports `notion: login required`, tell the user to run `<repo>/bin/ultrathink-mcp auth login notion` and continue — do not block.
- Only if that command is unavailable or fails outright, do step 2 manually.

## 2. Manual fallback (only when step 1's command could not run)

Create only what `tracking` does not already contain.

**Linear** (team = `tracking.linearTeam`, else the configured `linear.team`; skip Linear when neither is set):

1. Look up existing issues first: `list_issues` with `query` = `ultrathink graph <plan.graphId>`. Every issue the planner creates ends its description with the footer `ultrathink graph <graphId> · node <nodeId>` (plus ` · step <n>` for sub-issues); reuse matches instead of creating duplicates.
2. For each `plan.linearIssues` entry without a ref, in dependency order: `save_issue` with `team`, `title`, `description` (keep the footer), and `blockedBy` = identifiers of the node's `dependsOn` issues.
3. For each `plan.linearSubIssues` entry without a ref: `save_issue` with `team`, `title`, `description`, `parentId` = the node issue's identifier. Batch independent creates; if one fails, still create the rest and report which `nodeId`/`step` failed.

**Notion** (data source = the configured `notion.dataSourceUrl`; skip Notion when it is not set): `notion-fetch` the data source once for the schema and send only properties that exist. Find existing rows by `Graph ID` = `plan.graphId` (query tool SQL mode: `SELECT url, "Level", "Item" FROM "<data-source-url>" WHERE "Graph ID" = ?`). Then create with `notion-create-pages`:

- Task row: `Item`, `Level`=`Task`, `Description`, `Uplifted Prompt`, `Agent` (= `plan.task.agent`; if the select rejects it, omit it — never substitute `claude-code`), `Status`, `Linear State`, `Repo`, `Branch`, `Graph ID`.
- Issue rows (one per node): `Item`, `Level`=`Issue`, `Thought`, `Parent Item` = Task page, `Graph ID`, `Linear URL`, `Issue ID`.
- Sub-Issue rows (one per rationale step — never collapse steps): `Item`, `Level`=`Sub-Issue`, `Step`, `Thought`, `Parent Item` = that node's Issue page, `Graph ID`, `Linear URL`, `Issue ID`.

Keep every identifier/URL you created; steps 3 and 5 use them.

## 3. Register the graph in the substrate index

Only when an MCP server named `substrate` is connected in this session (you have its `graph_register` tool); otherwise skip this step without logging anything. Call `graph_register` on it. It is idempotent by `graph_id`, so call it without checking for an earlier registration. Build it from the tracking refs, leaving out fields whose value is absent:

| Field | Value |
|---|---|
| `graph_id` | `plan.graphId` (required) |
| `notion_task_page` | `tracking.notion.taskUrl` |
| `repo` / `branch` | `plan.task.repo` / `plan.task.branch`, when set |
| `surface` | the record's `host`; `claude-code` only when `host` is absent |
| `status` | `plan.task.status` |
| `nodes` | per node: `node_id`, `linear_issue_id` (`linear.nodes[n].id`), `linear_identifier`, `linear_url`, `notion_page` (`notion.nodes[n]`) |
| `steps` | per step key: `node_id`, `step`, `linear_sub_issue_id`, `linear_identifier`, `linear_url`, `notion_page` (`notion.steps[key]`) |

**Fail open.** If the call errors, log one line and continue. Do not retry or ask the user.

## 4. Resolve HITL clarifications

- For every item in `plan.hitl.nonBlocking`: proceed with its `default` option and state the assumption plainly in your next message (do not ask about it).
- For every item in `plan.hitl.blocking` (at most 4, already deduplicated): call the host's question tool **once** (`AskUserQuestion` in Claude Code, `ask` in Omp, `clarify` in Hermes), passing all of them together — each with its `header`, `question`, and `options` (the option matching `default` first). If no question tool is available, proceed with every blocking default and say so.
- Fold the answers (or stated assumptions) into the final prompt as a short "Clarifications" note.

## 5. Set Implementing and emit the final prompt

1. Set the Task `Status` to `"Implementing"`: `notion-update-page` on `tracking.notion.taskUrl` when present (skip silently when absent).
2. The final prompt is the **full spec file** (`sessions/<id>.xml`, the spec path from the prompt context), which already carries the `<ISSUES>` block with identifiers and URLs. Do not use `plan.task.upliftedPrompt` — that copy is truncated to 1900 characters.
3. Copy every **Linked issues** TODO line into the host TODO tool verbatim, keeping the identifier and URL on each line. When step 1 ran `track complete`, take the lines from its output — the prompt-context lines are stale then (they still show `(pending)` rows); otherwise take them from the prompt context.

## 6. Proceed as normal

Treat the spec as the actual task. Dispatch the graph's WORKFLOW waves as parallel subagents with the host's subagent tool (`Task` in Claude Code, `task` in Omp), passing each subagent the Linear/Notion URLs of the node(s) it owns. Reference issues in commits as `Refs <identifier>` and in PR bodies as `Fixes <identifier>`. Do not re-read this skill again this turn.
