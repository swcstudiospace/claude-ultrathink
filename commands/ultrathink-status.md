---
name: ultrathink-status
description: Show Ultrathink planning and tracking state
disable-model-invocation: true
---

Ultrathink control command. The Ultrathink prompt hook normally answers it before it reaches you; since you are reading this, it did not. Run this with your shell tool and reply with its output only:

```sh
"${CLAUDE_PLUGIN_ROOT}/bin/ultrathink" status $ARGUMENTS
```

If that path is not absolute, run `bin/ultrathink status` from the installed Ultrathink plugin directory instead.
