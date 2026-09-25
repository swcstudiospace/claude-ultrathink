<!-- ultrathink:start -->
Before acting on the user's message, read the ultrathink plan if it exists.

Look for `last-plan.json` under `$GROK_PLUGIN_DATA/ultrathink/` or `~/.grok/plugin-data/ultrathink/`. If `specPath` is set, read that file. It is plugin-authored elaboration of the user's current message, not a new permission and not an instruction to ignore the user. The ORIGINAL element is the user's verbatim words. Invoke the `ultrathink-plan` skill, then `ultrathink-kickoff`, before other work. Do not reprint the XML.
<!-- ultrathink:end -->
