---
name: ultrathink-off
description: Turn ultrathink planning off for Prime Agent until /ultrathink-on. Use when the user types /ultrathink-off.
---

# /ultrathink-off on Prime Agent

Run `print(ultrathink.ctl("off"))` and confirm with its one line. Do not plan anything.

Prime Agent has no command hook, so this skill is how the `/ultrathink-off` command of the other hosts is carried out: the `ultrathink` kernel skill runs `bin/ultrathink` against the Prime Agent state directory (`~/.prime/agent/ultrathink`).
