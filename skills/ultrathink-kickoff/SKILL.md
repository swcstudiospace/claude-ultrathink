---
name: ultrathink-kickoff
description: Invoked by the ultrathink UserPromptSubmit hook with a stateFile path after an uplift+Graph-of-Thought+HITL pass. Creates the tracked Task/Issue/Sub-Issue rows in the Notion Agent Task Graph database and the matching Linear issues/sub-issues, resolves blocking clarifications, then hands back the final prompt to execute. Do not invoke this for any other purpose.
---

# ultrathink-kickoff

You were told to invoke this skill with `stateFile=<path>`. Follow these steps in order. Every Notion/Linear write below must actually happen before you move on to real engineering work — this skill's whole job is to make the tracking real, not to describe it.

## 0. Read the state

Read the JSON file at `stateFile`. It is a `SessionRecord`:

```ts
interface SessionRecord {
	sessionId: string;
	engine?: string;
	result: { xml: string; original: string; root: string; source: "llm" | "fallback" };
	graph?: { goal: string; nodes: Array<{ id: string; title: string; kind: string; question: string; dependsOn: string[]; thinking?: string; conclusion?: string }> };
	clarifications?: Array<{ id: string; question: string; header: string; why: string; options: Array<{ label: string; description?: string }>; default?: string; blocking: boolean; answer?: string }>;
	plan?: {
		graphId: string;
		task: { graphId: string; item: string; description: string; upliftedPrompt: string; agent: string; status: string; linearState: string; repo?: string; branch?: string };
		issues: Array<{ graphId: string; nodeId: string; item: string; thought: string }>;
		subIssues: Array<{ graphId: string; nodeId: string; item: string; step: number; thought: string }>;
		linearIssues: Array<{ nodeId: string; title: string; description: string }>;
		linearSubIssues: Array<{ nodeId: string; title: string; description: string }>;
		hitl: { blocking: Array<Clarification>; nonBlocking: Array<Clarification> };
	};
}
```

If `plan` is missing (tracking failed to build), skip straight to step 6 with `result.xml` as the final prompt — do not block on tracking. This is the fail-open path.

## 1. Find or create the Task row (idempotency)

Target: the Notion data source at `collection://be3418f0-d2d8-411b-8677-fa8a95ee63be` (the "🧩 Agent Task Graph" database; confirm against your `notion` config if it has been overridden). Look for the Notion MCP tool that queries a data source by a property filter (commonly named something like `notion-query-data-sources` in rows/SQL mode, or `query_database` — inspect your available tools if unsure) and search for a row where `Graph ID` equals `plan.graphId`.

- If found: this is a re-entrant kickoff for the same prompt (a retried turn). Use its page as the Task page for step 2 (update, don't recreate) and skip straight to re-checking which Issues/Sub-Issues already exist (by `Graph ID` + `nodeId`, same pattern) before creating new ones.
- If not found: proceed to create it.

## 2. Create/update the Task row

Level = `Task`. Set these properties from `plan.task` (property names are the real Agent Task Graph schema — use them exactly):

| Notion property | Value |
|---|---|
| `Item` | `plan.task.item` |
| `Level` | `"Task"` |
| `Description` | `plan.task.description` |
| `Uplifted Prompt` | `plan.task.upliftedPrompt` |
| `Agent` | `plan.task.agent` (`"claude-code"`) |
| `Status` | `plan.task.status` (`"Planning"`) |
| `Linear State` | `plan.task.linearState` (`"Todo"`) |
| `Repo` | `plan.task.repo`, if set |
| `Branch` | `plan.task.branch`, if set |
| `Graph ID` | `plan.graphId` — the idempotency key for this whole run |
| `Model` | your own model tier (`"Sonnet"`, `"Opus"`, or `"Haiku"`), if the property accepts it |
| `Started` | now (ISO 8601), if this is a new Task row (do not overwrite it on a re-entrant kickoff for the same Graph ID) |

Keep the created/updated Task page's ID/URL — every Issue row created below sets `Parent Item` to it.

## 3. For each node: create a Linear issue, then the Notion Issue row

For every entry in `plan.linearIssues` (each has a `nodeId` matching one in `plan.issues`):

1. Create a Linear issue in the team named in your `linear` config (default **Spectrum Web Co**) with `title` = the entry's `title` and `description` = the entry's `description`.
2. Create (or update, if step 1 found an existing one for this `graphId`+`nodeId`) a Notion row: `Level` = `"Issue"`, `Item` = the matching `plan.issues[].item` (already formatted as `[nodeId] Title`), `Thought` = the matching `plan.issues[].thought`, `Parent Item` = the Task page from step 2, `Graph ID` = `plan.graphId`, `Linear URL` = the Linear issue's URL, `Issue ID` = the Linear issue's identifier (e.g. `ENG-123`), `Issue Type` = your best guess from the node's `kind` if you have it (`understand`/`decompose`/`compare`/`critique` → `"Investigation"`; `generate`/`refine`/`synthesize` → `"Feature"`; leave unset if unsure — never guess destructively).

Keep each node's Notion Issue page ID/URL and Linear issue ID — the matching Sub-Issue in step 4 needs both.

## 4. For each node: create a Linear sub-issue, then the Notion Sub-Issue row

For every entry in `plan.linearSubIssues` (same `nodeId`s as step 3):

1. Create a Linear **sub-issue** under the Linear issue step 3 created for the same `nodeId` (set its parent to that issue), `title` = the entry's `title`, `description` = the entry's `description`.
2. Create (or update) a Notion row: `Level` = `"Sub-Issue"`, `Item` = the matching `plan.subIssues[].item` (`"[nodeId] Chain of Thought"`), `Step` = the matching `plan.subIssues[].step` (currently always `1` — one Chain-of-Thought fill per node), `Thought` = the matching `plan.subIssues[].thought`, `Parent Item` = the **Issue** page from step 3 for this `nodeId` (not the Task page), `Graph ID` = `plan.graphId`, `Linear URL` = the new sub-issue's URL.

## 5. Resolve HITL clarifications

- For every item in `plan.hitl.nonBlocking`: proceed with its `default` option and state the assumption plainly in your next message (do not ask about it).
- For every item in `plan.hitl.blocking` (there are at most 4, already deduplicated): call `AskUserQuestion` **once**, passing all of them together — each with its `header`, `question`, and `options` (put the option matching `default` first). If `AskUserQuestion` is unavailable (a non-interactive run), proceed with every blocking item's default too, and say so.
- Fold the answers (or stated assumptions) into the final prompt in step 6 as a short "Clarifications" note — don't silently drop them.

## 6. Set Status to Implementing and emit the final prompt

Update the Task row's `Status` to `"Implementing"` (you are about to actually start).

Then produce the final prompt: `plan.task.upliftedPrompt` (the uplifted XML — reprint it once here, this is the one place it belongs) followed by an `<ISSUES>` block cross-referencing everything you just created:

```xml
<ISSUES>
	<TASK notionUrl="...">...</TASK>
	<ISSUE nodeId="n1" notionUrl="..." linearId="..." linearUrl="...">...</ISSUE>
	<SUBISSUE nodeId="n1" notionUrl="..." linearId="..." linearUrl="...">...</SUBISSUE>
	<!-- one ISSUE + one SUBISSUE pair per graph node -->
</ISSUES>
```

(Omit this block entirely if `plan` was missing in step 0.)

## 7. Proceed as normal

Treat the text from step 6 as the actual task. From here on, nothing is ultrathink-specific: dispatch the graph's WORKFLOW waves as parallel `Task` subagents per the orchestration instructions already in your context, invoke whatever other skills or plugins the work needs, and write the code. Do not re-read this skill again this turn.
