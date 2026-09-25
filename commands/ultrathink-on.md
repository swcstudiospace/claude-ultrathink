---
name: ultrathink-on
description: Turn Ultrathink planning back on in this app
disable-model-invocation: true
---

Ultrathink control command. The Ultrathink prompt hook normally answers it before it reaches you; since you are reading this, it did not. Run this with your shell tool and reply with its output only:

```sh
"${CLAUDE_PLUGIN_ROOT}/bin/ultrathink" on $ARGUMENTS
```

If that path is not absolute, run `bin/ultrathink on` from the installed Ultrathink plugin directory instead.
