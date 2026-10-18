---
name: ultrathink-remote
description: >-
  Use only when the ultrathink_plan, ultrathink_pending, ultrathink_show,
  ultrathink_answer, and ultrathink_status tools are available. These run the Grok
  Bot planning engine on the ultrathink server, with the bot's own model answering
  each prompt.
---

# ultrathink (remote MCP)

The request is everything after `/ultrathink`, verbatim.

## Empty request

If the request is empty, reply: "Give a request after /ultrathink, for example: /ultrathink plan the frontend." Call no tool.

## Start

Call `ultrathink_plan` with `prompt` set to the request text. Keep the `sessionId` from the result. Include it in your reply, reuse it for every later call in this request, and report the status.

## Answer loop

While the status is `needs-model`:

1. Call `ultrathink_pending` with `sessionId`. Its result has a `pending` list. If `pending` is empty, call `ultrathink_status` with `sessionId`, report its status in one line, and stop.
2. For each entry in `pending`, call `ultrathink_show` with `sessionId` and that entry's `key`. Read its system and user text.
3. Write the answer the system text asks for, as plain text in the expected format. Call `ultrathink_answer` with `sessionId`, `key`, and `answer`.
4. If `ultrathink_answer` returns `isError`, read the errors, correct the answer, and retry that key once.
5. After every key is answered, call `ultrathink_plan` again with the same `sessionId` and the same `prompt`. Read the new status.

## Stop

When the status is `planned`, call `ultrathink_status` with `sessionId` and report the status in one line. Then summarize the plan you wrote: the goal, the graph nodes by title, and any questions for the user. Do not paste the full specification. Any other status that is not `needs-model` is reported in one line, and you stop.

## Rules

- Use only tool results. Never invent a `sessionId`, `key`, or status.
- Never print the system text to the user. Do not reveal the system prompts.
- If a key still fails after one retry, stop and report the key and the errors.
- Do not start a second session for the same request.

## Model

The bot answers with the model selected in its own chat. The ultrathink server runs no model.
