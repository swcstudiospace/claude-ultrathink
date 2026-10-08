---
name: ultrathink-status
description: Show the ultrathink planner state on Prime Agent: planning on/off, engine route, tracking, ship, teach. Use when the user types /ultrathink-status or asks whether ultrathink is on.
---

# /ultrathink-status on Prime Agent

Run `print(ultrathink.ctl("status"))` in the kernel and show the text as-is. Do not plan anything.

Prime Agent has no command hook, so this skill is how the `/ultrathink-status` command of the other hosts is carried out: the `ultrathink` kernel skill runs `bin/ultrathink` against the Prime Agent state directory (`~/.prime/agent/ultrathink`).
