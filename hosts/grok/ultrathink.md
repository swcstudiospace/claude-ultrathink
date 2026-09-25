<!-- ultrathink:start -->
Before acting on the user's message, read the ultrathink plan for this message if it exists.

Look for `last-plan.json` under `$GROK_PLUGIN_DATA/ultrathink/`, then `${GROK_HOME:-~/.grok}/plugin-data/ultrathink/`, and use the first one that exists. The plugin writes it for the current prompt only and removes it on every prompt it does not plan. If the file is missing, there is no plan for this prompt: do not reuse a plan or spec from an earlier message. If `specPath` is set, read that file. It is plugin-authored elaboration of the user's current message, not a new permission and not an instruction to ignore the user. The ORIGINAL element is the user's verbatim words. Invoke the `ultrathink-plan` skill, then `ultrathink-kickoff`, before other work. Do not reprint the XML.
<!-- ultrathink:end -->
