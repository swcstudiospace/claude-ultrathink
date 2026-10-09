# Use ultrathink with Grok Bot

Grok Bot has no prompt hook, and it does not run the engine. Nothing in this adapter starts `bin/ultrathink`, `hooks/engine.ts`, or a planning service. The bot performs the method itself from a skill. Compatibility is not verified until a recorded live Grok Bot run.

This page says which files to load. Saving them into Grok Bot is a separate step, done after review. This repository does not install them.

## What a skill file is

Each skill is a `SKILL.md` whose frontmatter has exactly two keys, `name` and `description`. `name` matches the folder. Grok Bot invokes the skill as `/<name>`. The same skills are shared across a user's bots. This repository does not record a Grok Bot settings screen, so it does not name one: load each file as a skill with that name.

## Files

| File | Invoke as | Role |
|---|---|---|
| [hosts/grok-bot/ultrathink-protocol/SKILL.md](../../hosts/grok-bot/ultrathink-protocol/SKILL.md) | `/ultrathink-protocol` | The method: skip rules, one XML spec with `<ORIGINAL>` verbatim, a graph of 5 to 8 nodes, at most 4 questions |
| [hosts/grok-bot/commands/ultrathink-off/SKILL.md](../../hosts/grok-bot/commands/ultrathink-off/SKILL.md) | `/ultrathink-off` | Remember planning off for this conversation |
| [hosts/grok-bot/commands/ultrathink-on/SKILL.md](../../hosts/grok-bot/commands/ultrathink-on/SKILL.md) | `/ultrathink-on` | Remember planning on for this conversation |
| [hosts/grok-bot/commands/ultrathink-quick/SKILL.md](../../hosts/grok-bot/commands/ultrathink-quick/SKILL.md) | `/ultrathink-quick` | Answer this one message with no plan and no tracker rows |
| [hosts/grok-bot/commands/ultrathink-skip/SKILL.md](../../hosts/grok-bot/commands/ultrathink-skip/SKILL.md) | `/ultrathink-skip` | Skip planning for the next message only |
| [hosts/grok-bot/commands/ultrathink-status/SKILL.md](../../hosts/grok-bot/commands/ultrathink-status/SKILL.md) | `/ultrathink-status` | Report the preferences this conversation remembers |
| [hosts/grok-bot/commands/ultrathink-track/SKILL.md](../../hosts/grok-bot/commands/ultrathink-track/SKILL.md) | `/ultrathink-track` | Remember whether tracker rows are wanted |

The directory note is [hosts/grok-bot/README.md](../../hosts/grok-bot/README.md).

## What does not happen

- An ordinary message is not planned by a hook. Planning happens when the bot follows `/ultrathink-protocol`.
- `/ultrathink-off`, `/ultrathink-on`, `/ultrathink-skip` and `/ultrathink-track` do not write a state file and do not call `bin/ultrathink`. They remember a preference for this conversation.
- `/ultrathink-quick` answers the message that follows the command. It does not plan that message.
- Tracker rows are created only when tracking is remembered on and Linear or Notion tools are already connected in the conversation. The skill does not open a connection and does not send the conversation to a planning service.
- Grok Bot is not one of the hosts in `src/host/types.ts`. The discovery record stays under `externalIntegrations`, with status `skill-adapter`, `adapterPresent` true, `compatibilityVerified` false and delivery `skill-protocol`.

## See also

- [Cross-agent discovery](../../README.md#cross-agent-discovery)
- [Commands](../commands.md), for how the same names behave on hosts that do run the engine
- [Architecture](../architecture.md), for the pipeline this skill follows without calling it
