---
name: ultrathink-track
description: Keep planning but stop or start creating Linear/Notion rows. Use when the user types /ultrathink-track off, /ultrathink-track on or /ultrathink-track status.
---

# /ultrathink-track on Prime Agent

The argument is `off`, `on` or `status` (default `status`). Run `print(ultrathink.ctl("track", <arg>))` and show the line. Do not plan anything.

Prime Agent has no command hook, so this skill is how the `/ultrathink-track` command of the other hosts is carried out: the `ultrathink` kernel skill runs `bin/ultrathink` against the Prime Agent state directory (`~/.prime/agent/ultrathink`).
