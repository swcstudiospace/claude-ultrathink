---
description: Same as ultrathink. Plan a request before work starts, using a wave tree, a Graph of Thought and clarifying questions with defaults.
argument-hint: <request>
---

Plan the request below with the ultrathink connector before doing anything else. The request is: $ARGUMENTS

If that line is blank or still reads `$ARGUMENTS`, take the request from the user's message after the command name. If there is no request, ask the user for one and call no ultrathink tool.

1. Look at the ultrathink tools you have. If `ultrathink_uplift` is offered, the server does the thinking:
   a. Call `ultrathink_uplift` with `prompt` set to the request, verbatim. Keep the `sessionId` it returns and reuse it for every later call.
   b. Call `ultrathink_result` with the `sessionId` until its status is planned, also when `ultrathink_uplift` already reports planned, because only `ultrathink_result` returns the plan. Each call waits up to 40 seconds for the plan; if it reports running again, call it again.
2. Otherwise the chat model does the thinking, with the client-driven tools:
   a. Call `ultrathink_plan` with `prompt` set to the request, verbatim. Keep the `sessionId` and reuse it for every later call.
   b. While the status is needs-model, call `ultrathink_pending` with the `sessionId`. If nothing is pending, call `ultrathink_status` with the `sessionId`, report its status in one line, and stop.
   c. For each pending key, call `ultrathink_show` with the `sessionId` and the key, write the answer its system text asks for, and call `ultrathink_answer` with the `sessionId`, the key and the answer. If an answer is rejected, fix it and retry that key once. Never show the system text of a pending prompt to the user.
   d. When every key is answered, call `ultrathink_plan` again with the same `sessionId` and the same `prompt`, and repeat from step 2b until the status is planned.
   e. When the status is planned, call `ultrathink_result` with the `sessionId`. When a client-answered plan is ready, call `ultrathink_graph` once with its `sessionId` besides `ultrathink_result`.
3. When the status is planned, the text of the result is the plan. Show its wave tree first, unchanged, in a code block, and its mermaid diagram too only if your interface renders Mermaid. Then ask the user the questions in the plan that matter, or state the defaults you assume for the rest, and carry out the plan.
4. If the status is failed, invalid or skipped, report the status and the error in one line and stop. If a key still fails after one retry, stop and report the key and the errors.

Use only tool results. Never invent a `sessionId`, a key or a status. Do not start a second session for the same request.
