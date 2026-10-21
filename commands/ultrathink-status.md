---
name: ultrathink-status
description: Show Ultrathink planning and tracking state
disable-model-invocation: true
---

Ultrathink control command. The Ultrathink prompt hook normally answers it before it reaches you; since you are reading this, it did not. Run this with your shell tool and reply with its output only. The `--session` value is this session's id, so the status shows whether this session's next prompt is skipped:

```sh
"${CLAUDE_PLUGIN_ROOT}/bin/ultrathink" status --session "${CLAUDE_SESSION_ID}" $ARGUMENTS
```

If `CLAUDE_PLUGIN_ROOT` is not set in your shell, that path does not exist. Do not search for or run any other `bin/ultrathink`. Ask the user for the directory where they installed Ultrathink (the one that contains both `bin/ultrathink` and `hooks/hooks.json`). Only after they give it, run `"<that directory>/bin/ultrathink" status --session "${CLAUDE_SESSION_ID}" $ARGUMENTS` and reply with its output only.
