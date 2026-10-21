---
name: ultrathink-skip
description: Skip Ultrathink planning for the next prompt in Cursor
disable-model-invocation: true
---

Ultrathink control command for Cursor. The Ultrathink Cursor hook normally answers it before it reaches you; since you are reading this, it did not. Run this with your shell tool and reply with its output only:

```sh
ULTRATHINK_HOST=cursor "$(cat "$HOME/.cursor/hooks/ultrathink-cursor-plan.root")/bin/ultrathink" skip $ARGUMENTS
```

If `$HOME/.cursor/hooks/ultrathink-cursor-plan.root` does not exist, the Ultrathink Cursor hook is not installed. Ask the user for the directory where they cloned Ultrathink (the one that contains `bin/ultrathink` and `hooks/engine.ts`). Only after they give it, run `ULTRATHINK_HOST=cursor "<that directory>/bin/ultrathink" skip $ARGUMENTS` and reply with its output only. Do not run any other `bin/ultrathink`, and do not set any other `ULTRATHINK_HOST`.
