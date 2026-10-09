# hosts/grok-bot

Grok Bot native host. Grok Bot has no prompt hook and no plugin loader, so the adapter has two parts:

- `bin/ultrathink-grokbot` (`src/host/grokbot*.ts`): runs the real planner (`planPrompt`) with a journal completer. Each
  completion the engine needs (uplift, graph, per-node Chain of Thought, clarifier, teach distill) is written to
  `<stateDir>/journal/<session>/pending/` and the run stops with `needs-model`. The bot answers each request by
  following the plugin's own system prompt, stores the answer with `answer` (validated the way the engine parses it),
  and re-runs `plan`, which replays stored answers. Jev decisions are journalled too, so a resumed plan sees the same
  verdicts. Shipping is forced off (`ULTRATHINK_SHIP=0`) on every call.
- `skills/<name>/SKILL.md`: 21 skills the bot loads. `ultrathink-protocol` is the standing rule that replaces the
  UserPromptSubmit hook; the `ultrathink-*` commands map to `ctl`, `teach`, `decisions`, `hindsight` and `ragflow`;
  `ultrathink-kickoff` and `ultrathink-sync` write Linear/Notion rows through the bot's own connectors from the
  dry-run payloads that `track payloads` records (`track record` writes the real refs back into the spec).

State lives in `${ULTRATHINK_STATE_DIR:-~/.local/state/ultrathink-grokbot}`. Tests: `bun test src/host/grokbot.test.ts`.
See [Use with Grok Bot](../../docs/how-to/use-with-grok-bot.md).

The conversation-preference skills from the skill-protocol adapter stay beside the native host: `ultrathink-protocol/SKILL.md` and `commands/<name>/SKILL.md`. Discovery records the native host (`native-adapter`, `skill-protocol-cli`). Those files do not replace `skills/` and they do not run the engine.
