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

If that path is not absolute, run `bin/ultrathink track` with the same arguments from the installed Ultrathink plugin directory instead.
