---
name: ultrathink-quick
description: Answer one message without ultrathink planning or tracker rows. Use when the user types /ultrathink-quick <message>.
---

# /ultrathink-quick on Prime Agent

Everything after the command is the message. Do not call `ultrathink(...)` for it; just do what the message asks. With no message, say: `Usage: /skill:ultrathink-quick <message>`.

Prime Agent has no command hook, so this skill is how the `/ultrathink-quick` command of the other hosts is carried out: the `ultrathink` kernel skill runs `bin/ultrathink` against the Prime Agent state directory (`~/.prime/agent/ultrathink`).
