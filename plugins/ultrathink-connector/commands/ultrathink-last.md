---
description: Show the newest planned ultrathink plan with its diagram.
---

Show the newest planned ultrathink plan with its diagram.

1. Call `ultrathink_graph` with no arguments to resolve the newest planned session. If the status is none, say so in one line and stop.
2. Call `ultrathink_result` with the `sessionId` from `ultrathink_graph`.
3. Show the wave tree from `ultrathink_graph` first, unchanged, in a code block, and the mermaid diagram too only if your interface renders Mermaid. Then give the plan from `ultrathink_result`: what it decides and the questions in it that matter.

Use only tool results. Never invent a `sessionId`. Do not start a plan.