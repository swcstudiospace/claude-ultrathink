---
name: ultrathink-track
description: Turn Linear/Notion tracking on or off; planning keeps running
argument-hint: on|off
disable-model-invocation: true
---

Ultrathink control command. The Ultrathink prompt hook normally answers it before it reaches you; since you are reading this, it did not. Run this with your shell tool and reply with its output only:

```sh
"${CLAUDE_PLUGIN_ROOT}/bin/ultrathink" track $ARGUMENTS
```

If `CLAUDE_PLUGIN_ROOT` is not set in your shell, that path does not exist. Do not search for or run any other `bin/ultrathink`. Ask the user for the directory where they installed Ultrathink (the one that contains both `bin/ultrathink` and `hooks/hooks.json`). Only after they give it, run `"<that directory>/bin/ultrathink" track $ARGUMENTS` and reply with its output only.
