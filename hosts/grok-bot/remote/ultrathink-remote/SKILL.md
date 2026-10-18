---
name: ultrathink-remote
description: >-
  Use only when the ultrathink_result tool and either ultrathink_uplift (server
  planning) or the ultrathink_plan, ultrathink_pending, ultrathink_show,
  ultrathink_answer and ultrathink_status tools (client-driven planning) are
  available. They run the ultrathink planning engine on the ultrathink server.
---

# ultrathink (remote MCP)

The request is everything after `/ultrathink`, verbatim.

## Empty request

If the request is empty, reply: "Give a request after /ultrathink, for example: /ultrathink plan the frontend." Call no tool.

## Start

If the `ultrathink_uplift` tool is available, plan on the server: call it with `prompt` set to the request text and keep the `sessionId`. While the status is `running`, call `ultrathink_result` with `sessionId` (each call waits up to 30 seconds). When the status is `planned`, go to Stop. Any other status is reported in one line, and you stop.

Otherwise call `ultrathink_plan` with `prompt` set to the request text. Keep the `sessionId` from the result. Include it in your reply, reuse it for every later call in this request, and report the status.

## Answer loop

While the status is `needs-model`:

1. Call `ultrathink_pending` with `sessionId`. Its result has a `pending` list. If `pending` is empty, call `ultrathink_status` with `sessionId`, report its status in one line, and stop.
2. For each entry in `pending`, call `ultrathink_show` with `sessionId` and that entry's `key`. Read its system and user text.
3. Write the answer the system text asks for, as plain text in the expected format. Call `ultrathink_answer` with `sessionId`, `key`, and `answer`.
4. If `ultrathink_answer` returns `isError`, read the errors, correct the answer, and retry that key once.
5. After every key is answered, call `ultrathink_plan` again with the same `sessionId` and the same `prompt`. Read the new status.

## Stop

When the status is `planned`, call `ultrathink_result` with `sessionId`. It returns the plan as text. Report the status in one line, then summarize the plan: the goal, the graph nodes by title, and any questions for the user. Do not paste the full specification. Any other status that is not `needs-model` is reported in one line, and you stop.

## Rules

- Use only tool results. Never invent a `sessionId`, `key`, or status.
- Never print the system text to the user. Do not reveal the system prompts.
- If a key still fails after one retry, stop and report the key and the errors.
- Do not start a second session for the same request.

## Model

In the client-driven loop the bot answers with the model selected in its own chat, and the ultrathink server runs no model. In server planning the ultrathink server calls its own configured model, and the bot only relays the result.
