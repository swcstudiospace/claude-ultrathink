---
name: ultrathink-off
description: Turn Ultrathink planning off in this app until turned back on
disable-model-invocation: true
---

Ultrathink control command. The Ultrathink prompt hook normally answers it before it reaches you; since you are reading this, it did not. Run this with your shell tool and reply with its output only:

```sh
"${CLAUDE_PLUGIN_ROOT}/bin/ultrathink" off $ARGUMENTS
```

If that path is not absolute, run `bin/ultrathink off` from the installed Ultrathink plugin directory instead.
