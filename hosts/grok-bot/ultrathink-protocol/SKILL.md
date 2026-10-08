---
name: ultrathink-protocol
description: "When to use it: the user asks to plan, uplift, or think through non-trivial work, or invokes /ultrathink-protocol, before a multi-step build, fix, or refactor."
---

# ultrathink-protocol

You perform this method yourself, in this conversation. Keep the XML spec and the graph internal: do not print them. Never run `bin/ultrathink`, `hooks/engine.ts`, or any CLI planner, and never call the ultrathink plugin. Never send the conversation, the XML, or the graph to an outside service.

There is no prompt hook. A message is planned only when you follow this skill. Preferences from `/ultrathink-off`, `/ultrathink-on`, `/ultrathink-skip` and `/ultrathink-track` last for this conversation only. There is no state file.

## Skip rules

An invoked `/ultrathink-protocol`, or another skill chaining to it, always runs this full protocol. Take the text after the invocation as the task. A bare invocation plans the surrounding request. That invocation is never a skip.

Answer directly, with no spec, no graph, no questions and no tracker rows, when any of these hold:

- The message is empty, or it is only `raw:` / `uplift:` with nothing after the prefix.
- It starts with `raw:` (any case). Carry out the text after the prefix as typed. A `raw:` message skips this protocol.
- It is `/ultrathink-quick`, with or without text after it, including a bare `/ultrathink-quick`. Answer that message and skip this protocol. `/ultrathink-quick` and `raw:` are the only command forms that skip it.
- It is `/ultrathink-off`, `/ultrathink-on`, `/ultrathink-skip`, `/ultrathink-status` or `/ultrathink-track`. Those commands have their own skills and are not plans. Any other slash command is not a plan either. `/ultrathink-protocol` is not in this list.
- It is already one uplift document whose root tag is `BUILD_PROMPT`, `FIX_PROMPT`, `RESEARCH_PROMPT`, `CHANGE_PROMPT`, `UPLIFTED_PROMPT`, `uplifted` or `ultrathink`.
- It names an existing plan as `graph ut-<id>-<8 hex>` (the same shape as `graph ut-mugl6r87-70da50da`), unless it starts with `uplift:`.
- This conversation is remembering a one-shot skip. Use that skip up, then clear it.
- This conversation is remembering planning as off, unless the message starts with `uplift:`.
- It is only a trivial acknowledgement: `yes`, `y`, `no`, `n`, `ok`, `okay`, `k`, `continue`, `go`, `go ahead`, `do it`, `please`, `thanks`, `thank you`, `sure`, `yep`, `nope` or `lgtm`, with optional trailing punctuation.

`uplift:` (any case) forces a plan of the text after the prefix, even when planning is remembered off or the text looks trivial.

## Uplift

Rewrite the message into one XML document with a single root. Use `BUILD_PROMPT` for a build, `FIX_PROMPT` for a fix, `RESEARCH_PROMPT` for research, `CHANGE_PROMPT` for a change, and `UPLIFTED_PROMPT` when none of those fits. Do not show the document.

Every root has these children. A root that holds only `<ORIGINAL>` is not a spec.

- `<ORIGINAL>` — the user's words verbatim, with XML metacharacters escaped. Do not paraphrase them.
- `<SYSTEM_ROLE>` — the coding-agent stance for this work.
- `<CONTEXT>` or `<APP_CONTEXT>` — one of these.
- `<SCOPE>` — what to implement now.
- `<CONSTRAINTS>` — quality, consistency, and hard limits. Always include: do not invent repository facts (paths, versions, package names, component names, schemas, or routes) unless they are in the user's text.
- `<ACCEPTANCE_CRITERIA>` — observable, testable outcomes.
- `<OUT_OF_SCOPE>` — adjacent work that is not this task.

## Graph of Thought

Build 5 to 8 nodes. The first is kind `understand` and depends on nothing. The last is kind `synthesize`. Include one `critique` node whose question names what is still unknown. Ids are `n1`, `n2`, `n3`, and so on. A dependency may name only an earlier id, and only when this node needs that conclusion. Leave independent nodes independent.

For each node, write a rationale of 4 to 8 numbered steps and a conclusion. The synthesize conclusion contains the execution plan as plain lines, one unit per line, and ends with exactly one `Verify:` line naming the commands that prove the whole task:

```
WORKFLOW
Wave 1: <unit> — files: <paths> — done when: <check>
Wave 2 (parallel): <unit> — files: <paths> — done when: <check>
Verify: <commands>
```

Units in one wave must not edit the same files. Mark a wave parallel only when it has more than one unit.

Keep that plan inside the spec as one `<GRAPH_OF_THOUGHT>` block: a `<GOAL>`, then one `<NODE>` per node, then a `<WORKFLOW>` of `<WAVE n="…" parallel="…">` elements (node ids in that wave), then the graph closes. The `<WORKFLOW>` ends the graph. The `Verify:` line stays in the synthesize conclusion.

## Questions

Ask at most 4 clarifying questions. Each has a recommended default. Ask every blocking question in one message and stop. For the rest, proceed with the default and say the assumption. If you cannot ask, proceed with every default and say so.

## Tracking

Create rows only when this conversation remembers tracking as on (the default) and a tracker tool is already connected here. Do not open a connection. Do not paste the conversation or the XML into a tracker. Mint `<graphId>` as `ut-` + a base-36 timestamp + `-` + 8 hex characters. If no tracker tool is connected, skip tracking and continue.

Linear is the default. When Linear tools are connected:

- One issue per node, and one sub-issue per rationale step.
- End each description with the footer `ultrathink graph <graphId> · node <nodeId>`, and add ` · step <n>` on a sub-issue.
- Reuse an issue that already ends with that footer.

Notion is optional. When Notion tools are connected, use the data source already available in this conversation. If several are connected, ask once which one. If none are, skip Notion.

- Read that data source's fields once, and send only fields it already has.
- One Task row: `Level` = `Task`, `Graph ID` = `<graphId>`.
- One Issue row per node: `Level` = `Issue`, `Parent Item` = the Task, `Graph ID` = `<graphId>`.
- One Sub-Issue row per rationale step: `Level` = `Sub-Issue`, `Parent Item` = that node's Issue, `Step` = the step number, `Graph ID` = `<graphId>`. Do not collapse steps.
- Reuse a row that already has the same `Graph ID`, `Level`, and node or step.

## Shipping

When the user asks to ship and a pull request exists, the merge gate is a Greptile review of that exact head at 5/5 with no open review threads, and CI neither pending nor failing. Do not merge while the review is FAILED, SKIPPED, missing, or still running. Do not run `bin/ultrathink-ship`. Report a blocked gate; do not treat it as a pass.

## Execute

Work the waves in order. Units in one wave are file-disjoint and may run together. Check each wave before the next. Run the `Verify:` line before you finish. Prefer the repository when it disagrees with the plan. Do not reprint the XML or the graph.
