---
description: Answer one message directly, skipping ultrathink planning for it. Use when the user types /ultrathink-quick.
argument-hint: <message>
---

Answer the message below directly. Ultrathink planning is skipped for this one message.

The message is: $ARGUMENTS

If that line is blank or still reads `$ARGUMENTS`, take the message from the user's text after the command name. If there is none, ask the user for the message.

1. Answer the message in full, as you would without any plan.
2. Do not plan it, and call no ultrathink tool.
