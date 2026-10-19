---
description: Show the state of ultrathink planning on the connector, meaning the planning mode, the token ceilings and recent sessions.
---

Show the state of ultrathink planning on the connector.

1. Call `ultrathink_sessions` with no arguments.
2. Report in a few lines the planning mode (server planning or client-driven), the token ceilings and the tokens used today when the result has them, then one line per recent session with its `sessionId`, status and goal.

Use only tool results. Never invent a `sessionId` or a status. Do not start a plan and call no other ultrathink tool.
