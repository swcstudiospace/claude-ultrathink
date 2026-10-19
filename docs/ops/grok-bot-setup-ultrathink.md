# Connect Grok Bot to ultrathink (handoff)

Not connected. This document is the handoff. The connection counts as verified only after the checklist in section 4 passes. Sections 8 and 9 cover Grok Chat, which authenticates by OAuth only and, like Claude chat, has not been connected to this server in a live session. For all chat clients, see [Use /ultrathink in Claude, Claude Code and Grok Chat](../how-to/use-ultrathink-in-chat.md). For server operation, see the [runbook](runbook-ultrathink.md).

## 1. What it does

The ultrathink server runs the plugin's planning engine on the VPS. It has two modes. In client-driven mode, which Grok Bot uses through `ultrathink_plan`, the Grok Bot model answers each pending prompt and the server makes no model call. In server-side mode, the server calls an OpenRouter model itself (`ultrathink_uplift`, then `ultrathink_result`); it is on when `OPENROUTER_API_KEY` and `ULTRATHINK_PLANNING_MODEL` are set. Both modes run with the Hindsight and RAGFlow memory services switched off, so request text is not sent to them. Sections 2 to 7 describe the Grok Bot path, which uses the client-driven loop in either mode.

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

The server makes no paid model call on the Grok Bot path. The only spend is the bot's own usage in its chat. Server-side plans (section 9) are paid by the operator's OpenRouter account and are bounded by `ULTRATHINK_RUN_TOKEN_CEILING` and `ULTRATHINK_DAILY_TOKEN_CEILING`. One measured plan (2026-10-18, reasoning effort `low`) cost between 0.018 USD (`openai/gpt-5.6-luna`) and 0.153 USD (`x-ai/grok-4.7`) and took 44 to 138 seconds depending on the model. The full table is in [the chat guide](../how-to/use-ultrathink-in-chat.md) under "Time and cost".

## 7. Known limits

- **Prompt cap:** `ULTRATHINK_MAX_INPUT_CHARS`, default 8000 characters.
- **Answer cap:** `ULTRATHINK_MAX_ANSWER_CHARS`, default 20000 characters. The engine's own limit is 200000 characters, so the server cap is the lower one.
- **State:** sessions live under `ULTRATHINK_STATE_DIR` (`/var/lib/ultrathink` on this VPS), in `journal/` and `sessions/`, and server-side plans in `jobs/`. Pending prompts contain the request text, and they are stored there by design. Entries older than `ULTRATHINK_RETENTION_DAYS` (default 30) are deleted by the daily maintenance job.

## 8. Grok Chat: connect with OAuth and PKCE

The connector URL is `https://ultrathink.swcstudio.space/mcp`. It uses OAuth 2.1 with PKCE (S256). Grok finds the server's metadata at `/.well-known/oauth-protected-resource/mcp`, registers itself with dynamic client registration (RFC 7591), and opens a consent page on this server.

1. In Grok, go to grok.com/connectors, click **New Connector**, and select **Custom**.
2. Enter the URL `https://ultrathink.swcstudio.space/mcp`.
3. If Grok offers OAuth, choose it and continue. Grok opens the ultrathink consent page. Enter the owner password and click **Approve**.
4. Confirm the ultrathink tools appear in the connector. With server-side planning on there are 10: `ultrathink_uplift`, `ultrathink_plan`, `ultrathink_pending`, `ultrathink_show`, `ultrathink_answer`, `ultrathink_status`, `ultrathink_result`, `ultrathink_graph`, `ultrathink_sessions` and `ultrathink_command`. Without it there are 9 (no `ultrathink_uplift`).

Grok Chat takes OAuth only: no place to enter the `x-connector-key` header was found, so that header is for Grok Bot (section 2) and Claude Code, not for Grok Chat. Grok also fetches a connector's tool list once, when it connects, and refreshes it only when the connector is re-authenticated (`https://github.com/xai-org/plugin-marketplace/issues/1402`, maintainer reply of 2026-10-13). After any server change to the tools, such as the three connector tools `ultrathink_graph`, `ultrathink_sessions` and `ultrathink_command`, disconnect and reconnect the connector in Grok before checking the list.

What the server enforces:

- Codes are single-use, expire after 60 seconds, and need the PKCE verifier. A replayed code revokes every token it issued.
- Access tokens last 1 hour. Refresh tokens last 30 days and rotate on each use. A spent refresh token revokes its grant.
- Tokens are bound to the MCP resource. A token for another resource is refused.
- Redirect URIs must be https on an allowed origin, or loopback http. The default allow list is `https://claude.ai`, `https://claude.com`, `https://grok.com` and `https://console.x.ai`. Add more with `ULTRATHINK_OAUTH_REDIRECT_ORIGINS` (comma list of https origins). A registration with any other redirect origin is refused with `invalid_redirect_uri`.
- The consent page shows the origin the client will be sent back to and says the client name is not verified.
- Registration, authorize, token and revoke calls are rate limited per IP. The owner login allows 5 attempts per IP per 15 minutes.
- `/mcp` refuses a browser `Origin` that is not the server's own, one of the four default origins above, or listed in `ULTRATHINK_ALLOWED_ORIGINS`. A request with no `Origin` is allowed.
- The `x-connector-key` header keeps working for the Grok Bot path in section 2. It is not usable from Grok Chat's connector UI.

A client can revoke its own token at `POST /oauth/revoke`. To revoke every client and token, stop `ultrathink-web`, delete `/var/lib/ultrathink/oauth.json`, and start the service again. Every client then connects and asks for approval again.

## 9. Use /ultrathink in Grok Chat

In a chat that has the connector attached, send `/ultrathink <request>`.

**Server-side planning (the normal case).** The chat model calls `ultrathink_uplift` with the request. The server runs the plugin's pipeline (uplift, Graph of Thought, Chain of Thought, clarifying questions) with the OpenRouter model, in the background. One measured run took 44 to 138 seconds depending on the model (see the cost section). The chat model calls `ultrathink_result` with the `sessionId` until the status is `planned`, then asks you the questions in the plan that matter, or states the defaults it assumes, and carries out the plan. The finished plan is also stored in `sessions/` and `jobs/` under `ULTRATHINK_STATE_DIR`. The prompt cap in section 7 applies.

**Client-driven fallback.** When the server has no OpenRouter key or planning model, or `ULTRATHINK_SERVER_PLANNING=0`, `ultrathink_uplift` is not listed. The chat model then calls `ultrathink_plan`, answers each pending prompt with `ultrathink_show` and `ultrathink_answer`, and repeats until the status is `planned`. It then calls `ultrathink_result` for the plan. In this mode the server runs no model, and the plan comes from the chat model's own answers.

The server offers the command in these ways:

1. **Tool text.** `ultrathink_uplift` (or `ultrathink_plan` in client-driven mode) is described as the entry point for `/ultrathink`, and the connector tools `ultrathink_graph`, `ultrathink_sessions` and `ultrathink_command` carry the trigger text for `/ultrathink-think`, `/ultrathink-last`, `/ultrathink-status` and every other `/ultrathink-<name>`. The server `instructions` say the same, but whether Grok Chat shows `instructions` to the model is not verified. A client that shows the model tool descriptions needs nothing else.
2. **MCP prompts.** The server lists six prompts, one per supported command (`ultrathink`, `ultrathink-plan`, `ultrathink-think`, `ultrathink-last`, `ultrathink-status`, `ultrathink-quick`). A client that turns MCP prompts into slash commands shows them in its `/` menu. Grok's connector documentation describes tool discovery only, and no source found says Grok Chat lists MCP prompts. Treat this route as unverified in Grok Chat.
3. **Custom instructions.** If Grok does not act on a typed `/ultrathink`, paste this into Grok's global custom instructions (Settings, Customize; the label varies by app version).

For server-side planning:

```text
When a message starts with /ultrathink, use the ultrathink connector. The request is everything after the command, verbatim. Call ultrathink_uplift with it as prompt. If the status is running, call ultrathink_result with the sessionId, and call it again until the status is planned. Do not invent a sessionId or a status. When the plan is ready, show the user its wave tree first, unchanged, in a code block, ask the questions in the plan that matter, state the defaults you assume for the rest, and carry out the plan. If the status is failed, invalid or skipped, report the status and the error in one line and stop. If nothing follows /ultrathink, ask for a request and call no tool.
A message that starts with /ultrathink- and a command name is another command, not a request to plan. /ultrathink-think [sessionId] [node] calls ultrathink_graph. /ultrathink-last calls ultrathink_sessions with limit 5, then ultrathink_graph and ultrathink_result with the sessionId of the newest session whose status is planned. /ultrathink-status calls ultrathink_sessions with no arguments. /ultrathink-quick <message> is answered directly, with no ultrathink tool. Any other /ultrathink-<name> calls ultrathink_command with command set to the name and args set to the rest, verbatim; relay its message and make the tool call it names in next.
```

For the client-driven fallback:

```text
When a message starts with /ultrathink, use the ultrathink connector. The request is everything after the command. Call ultrathink_plan with it as prompt. While the status is needs-model, answer each pending prompt: call ultrathink_show, write the answer its system text asks for, and call ultrathink_answer. Then call ultrathink_plan again with the same sessionId and prompt. When the status is planned, call ultrathink_result with the sessionId and call ultrathink_graph once with it, show the user the wave tree first, unchanged, in a code block, ask the questions in the plan that matter, state the defaults you assume for the rest, and carry out the plan. If nothing follows /ultrathink, ask for a request.
A message that starts with /ultrathink- and a command name is another command, not a request to plan. /ultrathink-think [sessionId] [node] calls ultrathink_graph. /ultrathink-last calls ultrathink_sessions with limit 5, then ultrathink_graph and ultrathink_result with the sessionId of the newest session whose status is planned. /ultrathink-status calls ultrathink_sessions with no arguments. /ultrathink-quick <message> is answered directly, with no ultrathink tool. Any other /ultrathink-<name> calls ultrathink_command with command set to the name and args set to the rest, verbatim; relay its message and make the tool call it names in next.
```

A typed `/ultrathink` is a convention the model follows, not a command the client runs. To check what Grok does, send `/ultrathink plan the frontend` and look for `ultrathink_uplift` (or `ultrathink_plan`) calls in the chat. Then type `/` and `@` and see whether `ultrathink` is listed.

Grok Bot uses `hosts/grok-bot/remote/ultrathink-remote/SKILL.md`, which treats `/ultrathink` as the command and drives the client-driven loop. For failures and limits, see the troubleshooting table in [the chat guide](../how-to/use-ultrathink-in-chat.md) and the symptom table in the [runbook](runbook-ultrathink.md) section 7.

