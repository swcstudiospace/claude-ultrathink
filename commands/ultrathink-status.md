---
name: ultrathink-status
description: Show Ultrathink planning and tracking state
disable-model-invocation: true
---

Ultrathink control command. The Ultrathink prompt hook normally answers it before it reaches you; since you are reading this, it did not. Run this with your shell tool and reply with its output only:

```sh
"${CLAUDE_PLUGIN_ROOT}/bin/ultrathink" status $ARGUMENTS
```

If `CLAUDE_PLUGIN_ROOT` is not set in your shell, that path does not exist. Find the Ultrathink plugin directory instead: it is the one that contains both `hooks/hooks.json` and `bin/ultrathink`. This prints the path of its `bin/ultrathink`:

```sh
find "$HOME" -maxdepth 6 -type f -path '*/bin/ultrathink' -exec sh -c 'for f; do [ -f "${f%/bin/ultrathink}/hooks/hooks.json" ] && printf "%s\n" "$f"; done' sh {} + 2>/dev/null | head -n 1
```

Then run `"<printed path>" status $ARGUMENTS` and reply with its output only. If it prints nothing, ask the user where the Ultrathink plugin directory is.
