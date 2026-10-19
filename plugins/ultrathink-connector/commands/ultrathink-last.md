---
description: Show the newest planned ultrathink plan with its diagram.
---

Show the newest planned ultrathink plan with its diagram.

1. Call `ultrathink_sessions` with `limit` 5. Pick the newest session whose status is planned. If it lists no session, or none of them is planned, say so in one line and stop.
2. Call `ultrathink_graph` with that `sessionId`, and call `ultrathink_result` with that `sessionId`.
3. Show the wave tree from `ultrathink_graph` first, unchanged, in a code block, and the mermaid diagram too only if your interface renders Mermaid. Then give the plan from `ultrathink_result`: what it decides and the questions in it that matter.

Use only tool results. Never invent a `sessionId`. Do not start a plan.
