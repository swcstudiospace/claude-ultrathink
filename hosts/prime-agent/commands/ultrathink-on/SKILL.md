---
name: ultrathink-on
description: Turn ultrathink planning back on for Prime Agent. Use when the user types /ultrathink-on.
---

# /ultrathink-on on Prime Agent

Run `print(ultrathink.ctl("on"))` and confirm with its one line. Do not plan anything.

Prime Agent has no command hook, so this skill is how the `/ultrathink-on` command of the other hosts is carried out: the `ultrathink` kernel skill runs `bin/ultrathink` against the Prime Agent state directory (`~/.prime/agent/ultrathink`).
