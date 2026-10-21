---
name: ultrathink-track
description: Turn Ultrathink issue tracking on or off in Cursor (Linear and Notion rows)
argument-hint: on|off
disable-model-invocation: true
---

Ultrathink control command for Cursor. The Ultrathink Cursor hook normally answers it before it reaches you; since you are reading this, it did not. Run this with your shell tool and reply with its output only:

```sh
ULTRATHINK_HOST=cursor "$(cat "$HOME/.cursor/hooks/ultrathink-cursor-plan.root")/bin/ultrathink" track $ARGUMENTS
```

If `$HOME/.cursor/hooks/ultrathink-cursor-plan.root` does not exist, the Ultrathink Cursor hook is not installed. Ask the user for the directory where they cloned Ultrathink (the one that contains `bin/ultrathink` and `hooks/engine.ts`). Only after they give it, run `ULTRATHINK_HOST=cursor "<that directory>/bin/ultrathink" track $ARGUMENTS` and reply with its output only. Do not run any other `bin/ultrathink`, and do not set any other `ULTRATHINK_HOST`.
