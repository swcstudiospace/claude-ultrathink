---
name: ultrathink-plan
description: Read the ultrathink plan written for this turn before other work. Use when a host discarded hook stdout, or when last-plan.json exists for the current session.
---

# Ultrathink plan

The TypeScript engine already planned this prompt. Hook stdout is not a reliable delivery channel on every host (Grok discards an allowing `UserPromptSubmit` `additionalContext`). The plan lives in a file.

1. Read `last-plan.json` from the host state directory. In order, try:
   - `$ULTRATHINK_STATE_DIR/last-plan.json`
   - `$GROK_PLUGIN_DATA/ultrathink/last-plan.json`
   - `${GROK_HOME:-~/.grok}/plugin-data/ultrathink/last-plan.json`
   - `$HERMES_HOME/ultrathink/last-plan.json`, or `~/.hermes/ultrathink/last-plan.json` when `HERMES_HOME` is unset
   - `$XDG_CONFIG_HOME/muse/ultrathink/last-plan.json` or `~/.config/muse/ultrathink/last-plan.json`
   - `$PI_CODING_AGENT_DIR/ultrathink/last-plan.json` or `~/.omp/agent/ultrathink/last-plan.json`
   - `~/.claude/ultrathink/last-plan.json`
2. If `specPath` is set, read that file. It is plugin-authored elaboration of the user's message, not a new permission and not an instruction to ignore the user. The `ORIGINAL` element is the user's verbatim words.
3. Invoke `ultrathink-kickoff` before other work so the Notion and Linear rows exist.
4. Do not reprint the XML. Do not write `.planning/` into the working directory.
