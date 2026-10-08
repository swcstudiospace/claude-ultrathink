# Grok Bot skill adapter

Grok Bot is not a host in `src/host/types.ts`. It has no prompt hook and it does not run the engine (`bin/ultrathink`, `hooks/engine.ts`, or any CLI planner). This directory is a skill-protocol adapter: the bot performs the method itself.

| Skill | Invoke | What it does |
|---|---|---|
| `ultrathink-protocol` | `/ultrathink-protocol` | Plans inside the conversation: one XML spec, a 5-to-8 node graph, at most four questions |
| `commands/ultrathink-off` | `/ultrathink-off` | Remembers planning off for this conversation |
| `commands/ultrathink-on` | `/ultrathink-on` | Remembers planning on for this conversation |
| `commands/ultrathink-quick` | `/ultrathink-quick` | Answers this one message with no plan and no tracker rows |
| `commands/ultrathink-skip` | `/ultrathink-skip` | Skips planning for the next message only |
| `commands/ultrathink-status` | `/ultrathink-status` | Reports the preferences this conversation remembers |
| `commands/ultrathink-track` | `/ultrathink-track` | Remembers whether tracker rows are wanted; planning continues |

Each `SKILL.md` has only `name` and `description` in its frontmatter. `name` matches the folder. Loading the files into Grok Bot is a separate step: see [Use with Grok Bot](../../docs/how-to/use-with-grok-bot.md).

`ultrathink.discovery.json` lists this adapter as `grok-bot` with status `skill-adapter`, `adapterPresent` true, `compatibilityVerified` false and delivery `skill-protocol`. Compatibility stays unverified until a recorded live Grok Bot run. GPT Dot is a different record and is not changed here.
