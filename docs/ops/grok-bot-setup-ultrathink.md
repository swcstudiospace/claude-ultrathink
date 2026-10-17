# Connect Grok Bot to ultrathink (handoff)

Not connected. This document is the handoff. The connection counts as verified only after the checklist in section 4 passes.

## 1. What it does

The ultrathink server runs the plugin's planning engine on the VPS. The Grok Bot model answers each pending prompt, and the server makes no model call. Planning runs with the Hindsight and RAGFlow memory services switched off, so request text is not sent to them.

## 2. Register the server in Grok Bot

Read the connector key on the VPS:

```bash
grep '^ULTRATHINK_CONNECTOR_KEY=' /etc/ultrathink/ultrathink.env
```

The output has the form `ULTRATHINK_CONNECTOR_KEY=<value>`. Use only the part after the `=` sign.

Send Grok Bot this one message, with the value in place of `<KEY>`:

```text
Add a custom remote MCP server. Name: ultrathink. URL: https://ultrathink.swcstudio.space/mcp. Authentication: HTTP header x-connector-key with value <KEY>.
```

The key goes only into that message. Grok Bot keeps chat history, so treat that chat as holding the key. Rotate it (section 5) if the chat is shared or exported.

## 3. Load the skill

Give Grok Bot the file `hosts/grok-bot/remote/ultrathink-remote/SKILL.md` and say it is the /ultrathink skill. This skill is separate from the local ultrathink-* skills, which run the CLI on the bot's computer.

## 4. Verification checklist

Run each item in Grok Bot, in order. The connection counts as verified only when items a to d pass.

- **a. Server list.** ultrathink appears in Grok Bot's remote MCP server list with no connection error.
- **b. Plan.** Send `/ultrathink plan a short test feature`. The reply gives a sessionId and pending prompts. After the answer loop, the status is `planned`.
- **c. Empty request.** Send `/ultrathink` with nothing after it. The reply is the usage line, and no session starts.
- **d. Wrong key refused.** Set the `x-connector-key` value to a wrong value such as `wrong-value`, send the plan request, and expect a refusal. Then restore the real value and repeat item a.
- **e. Model choice.** Before item b, note the model selected in this chat. The answers come from that model, including Grok Heavy if you select it. The server cannot verify which model answered.

## 5. Rotate the connector key

1. Generate a new 32-byte value: `openssl rand -hex 32`.
2. Replace `ULTRATHINK_CONNECTOR_KEY` in `/etc/ultrathink/ultrathink.env` with the new value.
3. Restart the service: `systemctl restart ultrathink-web`.
4. Update the `x-connector-key` value in Grok Bot.

## 6. Cost

The server makes no paid model call on this path. The only spend is the bot's own usage in its chat.

## 7. Known limits

- **Prompt cap:** `ULTRATHINK_MAX_INPUT_CHARS`, default 8000 characters.
- **Answer cap:** `ULTRATHINK_MAX_ANSWER_CHARS`, default 20000 characters. The engine's own limit is 200000 characters, so the server cap is the lower one.
- **State:** sessions live under `ULTRATHINK_STATE_DIR` (`/var/lib/ultrathink` on this VPS), in `journal/` and `sessions/`. Pending prompts contain the request text, and they are stored there by design.
