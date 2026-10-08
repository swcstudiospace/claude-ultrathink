---
name: ultrathink-skip
description: Skip ultrathink planning for the next request only. Use when the user types /ultrathink-skip.
---

# /ultrathink-skip on Prime Agent

Run `print(ultrathink.ctl("skip"))`. The next `await ultrathink(...)` call returns `skipped` once; answer the next message without planning.

Prime Agent has no command hook, so this skill is how the `/ultrathink-skip` command of the other hosts is carried out: the `ultrathink` kernel skill runs `bin/ultrathink` against the Prime Agent state directory (`~/.prime/agent/ultrathink`).
