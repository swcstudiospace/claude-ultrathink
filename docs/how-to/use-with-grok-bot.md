# Use ultrathink with Grok Bot

Grok Bot runs the engine through `bin/ultrathink-grokbot`, and the bot's own model answers the engine's prompts. There is no prompt hook: the `ultrathink-protocol` skill is a standing rule the bot applies to every message. Compatibility is not verified beyond the recorded Desk Lead runs.

## How a plan runs

1. The bot writes the request byte-for-byte to `ORIGINAL.txt` and runs `ultrathink-grokbot plan --session S --prompt-file ORIGINAL.txt [--transcript turns.jsonl]`.
2. The output lists pending requests (`stage`: uplift, graph, cot, clarify). For each, `show --session S <key>` prints the plugin's system prompt and user text; the bot writes the answer and stores it with `answer --session S <key> --file F`. Invalid answers are rejected with reasons and never stored.
3. Re-running `plan` replays stored answers and asks for the next stage, until `status` is `planned`. `summary`, `status` and `deepen` report nodes, steps per node and the density band.
4. Clarifying questions are asked in chat; `answers --session S --file answers.json` folds the replies into the session and spec (the AskUserQuestion hook's job on Claude Code).
5. Kickoff: `track payloads` records every Linear/Notion call `createTracking` would make, with placeholders; the bot runs them through its connectors and `track record --refs refs.json` writes the real refs into the record and spec. `prompts build --units units.json` then derives validated cloud-agent prompts per node, with the unit's Linear and Notion refs.

`turns.jsonl` lines are `{"role":"user"|"assistant","content":"..."}`; Claude Code transcript lines are accepted too.

## Commands

| Grok Bot | Engine call |
|---|---|
| `/ultrathink <request>`, any substantive message | `plan` / `show` / `answer` loop |
| `/ultrathink-status`, `-on`, `-off`, `-skip`, `-track`, `-think`, `-hitl`, `-last` | `ctl …` (grok-bot state dir) |
| `/ultrathink-decisions` | `decisions check`, `decisions probe <point> <cases.json>` |
| `/ultrathink-teach`, `-learn`, `-lessons`, `-teach-admin` | `teach …` (host `grok-bot`; promote is drafts-only), `teach digest` |
| `/ultrathink-hindsight` | `hindsight …`, `ragflow …` |
| `/ultrathink-ship` | `review read` (read-only Greptile score and threads; nothing ships) |

## What does not happen

- No hook fires: planning happens when the bot follows `ultrathink-protocol`, and the Stop hook's `teach observe` is a protocol step (`teach digest` then `teach observe --stdin`).
- `ultrathink-ship` never merges, pushes or retriggers; `ship pr|merge|run` are not exposed.
- `teach promote --install` is refused; promotions go to drafts. Installing a skill into the bot is a reviewed, manual step (`skills status` reports drift between `hosts/grok-bot/skills` and the installed copies).
- No engine CLI (Claude, Grok, Muse) is spawned: the bot's model is the planner, and the only outside model call is Jev.

## Files

The directory note is [hosts/grok-bot/README.md](../../hosts/grok-bot/README.md). The discovery record lists Grok Bot under `externalIntegrations` with status `native-adapter`, delivery `skill-protocol-cli`, `adapterPresent` true and `compatibilityVerified` false.

## Gateway backend

Direct Hindsight, RAGFlow and substrate clients stay the default. To send memory, document search and the substrate brief and events through the desk gateway, with no Hindsight or RAGFlow key on the bot, set this in the user config (`~/.config/ultrathink/config.json`). A project file cannot set it.

```json
{
  "gateway": { "url": "https://gateway.example", "seat": "lead", "timeoutMs": 8000 },
  "hindsight": { "enabled": true, "backend": "gateway" },
  "ragflow": { "enabled": true, "backend": "gateway", "ground": true },
  "substrate": { "backend": "gateway" }
}
```

The seat token is `DESK_GATEWAY_TOKEN`, or an `api_key` / OAuth access token stored under the credential-store provider `desk-gateway`. The client calls `POST <gateway.url>/mcp/<seat>` with `tools/call`. Recall is `desk_memory_recall`, retain is `desk_memory_retain`, document search is `desk_docs_search`, the brief is `desk_brief` and plan events are `desk_event_emit`. `ULTRATHINK_GATEWAY=0` forces the direct clients again. `bin/ultrathink status` reports each integration as `gateway · ready` or `gateway · unready` with the reason. `bin/ultrathink hindsight check` and `bin/ultrathink ragflow check` are the doctor: a gateway `not_configured` or `error`/`reason` reply is a one-line degraded result, not a crash.

`ultrathink-plan` and `ultrathink-hindsight` pick the plane from `G ctl status`: with the gateway backend ready they use the CLI, otherwise they call the `desk_*` tools through the bot's desk gateway MCP connection, so the box copies match this tree either way.

## Skill-protocol files kept beside the native host

`hosts/grok-bot/ultrathink-protocol/SKILL.md` and `hosts/grok-bot/commands/<name>/SKILL.md` remain from the skill-protocol adapter. Each file's frontmatter has exactly `name` and `description`, parsed without PyYAML. They remember a conversation preference and do not call `bin/ultrathink`. The native host above is what discovery records and what the bot runs.
