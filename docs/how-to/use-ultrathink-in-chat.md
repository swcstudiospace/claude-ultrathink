# Use /ultrathink in Grok Chat, Claude and Claude Code

This guide connects a chat client to the hosted ultrathink server and shows how to run `/ultrathink <request>` from it. The server is at `https://ultrathink.swcstudio.space/mcp`. For the server's operation, see the [runbook](../ops/runbook-ultrathink.md). For Grok Bot, see [Connect Grok Bot to ultrathink](../ops/grok-bot-setup-ultrathink.md).

## What /ultrathink does in a chat

`/ultrathink` runs the planning part of the ultrathink plugin and hands the result back to the chat model. The pipeline has four steps:

1. **Uplift.** The request is rewritten as a structured specification.
2. **Graph of Thought.** The specification is split into 5 to 8 nodes, each a question to settle, in dependency order.
3. **Chain of Thought.** Each node gets numbered reasoning steps and a conclusion. Nodes run level by level, three at a time.
4. **Clarifying questions.** The pipeline lists what it could not settle, each with a default answer.

The chat model then reads the plan, asks you the questions that matter (or states the defaults it assumes), and carries out the plan.

This path has no Notion, no Linear, no tracking, no shipping, and no Hindsight or RAGFlow lookups. The Jev decision gate is off unless the operator sets `ULTRATHINK_SERVER_DECISIONS=1`. Nothing is written to your repository or to any tracker.

## Two modes

The server offers two ways to do the thinking. The tool list tells you which one is active.

| | Server-side mode | Client-driven mode |
|---|---|---|
| Who thinks | The server calls an OpenRouter model. | The chat model answers each planning prompt itself. |
| Tools the chat model uses | `ultrathink_uplift`, then `ultrathink_result` | `ultrathink_plan`, `ultrathink_pending`, `ultrathink_show`, `ultrathink_answer`, `ultrathink_status`, then `ultrathink_result` |
| Tool count | 7 tools | 6 tools (`ultrathink_uplift` is not listed) |
| Who pays | The operator's OpenRouter account. | Your chat plan. The server makes no paid call. |
| Used by | Grok Chat, Claude, Claude Code | Grok Bot, or any client when server-side mode is off |

Server-side mode is on when `OPENROUTER_API_KEY` and `ULTRATHINK_PLANNING_MODEL` are both set and `ULTRATHINK_SERVER_PLANNING` is not `0`. Without them the server lists no `ultrathink_uplift`, and its prompt and instructions describe the client-driven loop. The client-driven tools stay available in both modes. `ultrathink_result` returns the plan for a finished session from either mode.

## Connect a client

All three clients use the same URL and the same login: OAuth 2.1 with PKCE, and the owner password on the consent page. The server finds each client through its metadata at `/.well-known/oauth-protected-resource/mcp` and registers it with dynamic client registration.

The server accepts a client's redirect URI only when it is https on one of these origins, or http on loopback (any port):

- `https://claude.ai`
- `https://claude.com`
- `https://grok.com`
- `https://console.x.ai`

The operator can add origins with `ULTRATHINK_OAUTH_REDIRECT_ORIGINS`. A client with any other redirect origin fails at registration.

The consent page names the client, says that the name is unverified, and shows the origin you will be sent back to. Approve only an address you recognize.

### Grok Chat

1. Open grok.com/connectors and click **New Connector**.
2. Select **Custom**.
3. Enter the URL `https://ultrathink.swcstudio.space/mcp`.
4. Choose OAuth when Grok offers it. Grok opens the ultrathink consent page.
5. Enter the owner password and click **Approve**.
6. Check that the ultrathink tools are listed in the connector, including `ultrathink_uplift`.

### Claude and Claude Desktop

1. Open Settings, then Connectors.
2. Choose **Add custom connector**.
3. Enter a name (`ultrathink`) and the URL `https://ultrathink.swcstudio.space/mcp`.
4. Leave the advanced OAuth client ID and secret empty so that Claude registers itself automatically.
5. Choose **Connect**. The consent page opens. Enter the owner password and click **Approve**.
6. In a new chat, open the connectors menu and switch the ultrathink connector on for that chat.

Menu labels differ by app version and plan. Custom connectors may not be available on every plan.

### Claude Code

```bash
claude mcp add --transport http ultrathink https://ultrathink.swcstudio.space/mcp
```

Then run `/mcp` inside Claude Code, select `ultrathink`, and choose to authenticate. Claude Code opens the browser and receives the code on a loopback address, which the redirect rules allow. Enter the owner password on the consent page. Add `--scope user` to the command to make the server available in every project.

## Use it

Type `/ultrathink` followed by the request, in one message:

```text
/ultrathink design a rate limiter for the public API, with per-key and per-IP limits
```

What happens next:

1. The chat model calls `ultrathink_uplift` with everything after `/ultrathink`, verbatim. The reply has a `sessionId` and a status, normally `running`. The call waits up to 15 seconds in case the plan finishes fast.
2. The model calls `ultrathink_result` with the `sessionId`. Each call waits up to 30 seconds by default (at most 45) and reports `running` if the plan is not ready. The model calls it again until the status is `planned`. No other work is needed from the model meanwhile, and you do not need to answer anything during this wait.
3. When the status is `planned`, the result text is the plan. The model asks you the questions in it that matter, or states the defaults it assumes, and then carries out the plan.

If the request is empty (`/ultrathink` alone), the model should ask for a request and call no tool.

The request is limited by `ULTRATHINK_MAX_INPUT_CHARS` (default 8000 characters).

### Brief and full

`ultrathink_result` takes a `detail` argument:

| Value | Result |
|---|---|
| `brief` (default) | The request, the specification, each Graph of Thought node with its question and conclusion, and the clarifying questions with defaults. Limited to 40,000 characters. |
| `full` | The same plus the numbered Chain of Thought steps of every node. Limited to 80,000 characters. |

When the plan does not fit, whole sections are left out and a note says so. The required parts (request, specification, questions) are kept ahead of the Graph of Thought waves. The structured result has `truncated: true` in that case. Ask the model for `detail: "full"` only when you want the reasoning steps: a large result uses more of the chat's context, and Claude Code warns above 10,000 tokens for one tool result.

### Time and cost

| | Typical value |
|---|---|
| Time | 1 to 5 minutes |
| Model calls | about 8 to 11: uplift 1, graph 1, Chain of Thought one per node (5 to 8), clarify 1 |
| Cost | about 0.1 to 0.3 USD per plan with `x-ai/grok-4.7` at 2 and 6 USD per million input and output tokens |

The time and cost figures are estimates for typical requests, not measured limits. The result's `usage` field reports the real calls, tokens and, when OpenRouter returns it, the cost of each plan.

Two ceilings bound the spend, both counted in tokens by a ledger in the server's database:

- `ULTRATHINK_RUN_TOKEN_CEILING` (default 150,000 tokens) for one plan.
- `ULTRATHINK_DAILY_TOKEN_CEILING` (default 1,000,000 tokens) for one UTC day, across all plans.

A plan that would pass a ceiling stops with `budget_exceeded`. Abandoned reservations keep counting, so the ledger errs toward stopping early.

The server runs at most `ULTRATHINK_MAX_CONCURRENT_PLANS` plans at once (default 2). It cancels a model call after `ULTRATHINK_MODEL_TIMEOUT_MS` (default 120000) and a whole plan after `ULTRATHINK_PLAN_TIMEOUT_MS` (default 600000).

## Make it reliable

A typed `/ultrathink` is only text. No client turns it into a command by itself. It works when the model sees the tool descriptions, the server instructions or a prompt that tell it what to do with that text. These routes add up:

1. **Tool descriptions and server instructions.** `ultrathink_uplift` is described as the entry point for `/ultrathink`, and the server's `instructions` say the same. A client that shows the model this text needs nothing else. This works in all three clients, as far as the tool list reaches the model.
2. **MCP prompt.** The server lists one prompt, `ultrathink`, with a required `request` argument. It returns the full tool sequence plus your request as one user message. Claude Code shows it as `/mcp__ultrathink__ultrathink`. Claude should list it under the plus menu, which is not verified (see below). Grok documents no prompt surface, so do not count on it there.
3. **Custom instructions.** If the model ignores a typed `/ultrathink`, add the text below.

For Grok, paste this into Grok's custom instructions (Settings, Customize; the label varies by app version):

```text
When a message starts with /ultrathink, use the ultrathink connector. The request is everything after the command, verbatim. Call ultrathink_uplift with it as prompt. If the status is running, call ultrathink_result with the sessionId, and call it again until the status is planned. Do not invent a sessionId or a status. When the plan is ready, ask the user the questions in it that matter, state the defaults you assume for the rest, and carry out the plan. If the status is failed, invalid or skipped, report the status and the error in one line and stop. If nothing follows /ultrathink, ask for a request and call no tool.
```

For Claude, paste the same text into the instructions of a Claude Project that has the ultrathink connector switched on. For Claude Code, add it to `CLAUDE.md`, or use the prompt route above.

If server-side planning is off (no `ultrathink_uplift` in the tool list), the text above does not apply. Use the client-driven text in [Connect Grok Bot to ultrathink](../ops/grok-bot-setup-ultrathink.md) section 9.

### What is not verified

- Whether Grok Chat or Claude list the server's MCP prompt in a menu. Claude Code's `/mcp__<server>__<prompt>` form is Claude Code's documented behavior. For the hosted apps, the plus-menu entry is the expected behavior, and it has not been checked against this server.
- That the model follows a typed `/ultrathink`. This is a convention that the descriptions, the prompt and your custom instructions encourage. A model can still answer the request directly without calling a tool. Say "use ultrathink" or run the prompt when that happens.
- Which model a hosted client uses. The server cannot see it, and server-side mode does not depend on it: the planning model is the server's OpenRouter model.

To check a client, send `/ultrathink plan a short test feature` and look for an `ultrathink_uplift` call in the chat, then `ultrathink_result` calls, then a plan with questions.

## Security

- **Owner password.** Only the owner can approve a client. The owner password is an argon2id hash in `ULTRATHINK_OWNER_PASSWORD_HASH`. The consent login allows 5 attempts per IP per 15 minutes. Anyone who knows the password can connect a client, so do not reuse it.
- **Tokens.** Authorization codes are single-use and live 60 seconds. Access tokens last 1 hour and refresh tokens 30 days. Refresh tokens rotate on each use, and a spent one revokes its grant. Tokens are bound to the `/mcp` resource.
- **Revoking.** A client can revoke its own token at `POST /oauth/revoke` (RFC 7009). To revoke every client and token, stop the service, delete `/var/lib/ultrathink/oauth.json`, and start it again (`systemctl stop ultrathink-web`, `rm /var/lib/ultrathink/oauth.json`, `systemctl start ultrathink-web`). Every client then registers and asks you to approve again. Plans are not lost. To lock out the owner login, rotate the hash (runbook section 6).
- **Connector key.** The legacy `x-connector-key` header (`ULTRATHINK_CONNECTOR_KEY`) is for Grok Bot, which cannot do OAuth. It works on `/mcp` next to OAuth. Do not paste it into Grok Chat or Claude. Rotate it in [the Grok Bot guide](../ops/grok-bot-setup-ultrathink.md) section 5.
- **Browser origins.** `/mcp` refuses a request whose `Origin` header is not the server's own origin, `https://claude.ai`, `https://claude.com`, `https://grok.com`, `https://console.x.ai` or an origin in `ULTRATHINK_ALLOWED_ORIGINS`. A request with no `Origin` header (native and server-side clients) is allowed.
- **Where your text goes.** In server-side mode the request and the model's intermediate text go to OpenRouter and the model provider you chose, under their privacy terms. The server stores the request, the prompts and the plan under `/var/lib/ultrathink` (`journal/`, `sessions/`, `jobs/`) for 30 days by default. Do not send secrets in a request.
- **Logs.** The server logs one JSON line per request: request id, HTTP method and path, status, duration, JSON-RPC method, tool name, auth kind and client address. It does not log prompt text, plans, the owner password, tokens, the connector key, the OpenRouter key or authorization headers; fields with such names are dropped by the logger.
- **OpenRouter key.** The key stays on the server (`OPENROUTER_API_KEY` in `/etc/ultrathink/ultrathink.env`). Use a key with a spending limit.

## Configuration

The operator sets these in `/etc/ultrathink/ultrathink.env` and restarts the service. The server refuses to start on an invalid value and names the variable. The source is `services/ultrathink/config/config.ts`.

| Variable | Default | Meaning |
|---|---|---|
| `ULTRATHINK_PUBLIC_ORIGIN` | none (required) | Public origin of the service, `https://ultrathink.swcstudio.space`. `http://` is allowed only for localhost and 127.0.0.1. |
| `ULTRATHINK_OWNER_PASSWORD_HASH` | none (required) | Argon2id hash of the owner password. |
| `ULTRATHINK_SESSION_SECRET` | none (required) | Secret for web login sessions, at least 32 characters. |
| `ULTRATHINK_STATE_DIR` | `/var/lib/ultrathink` | State directory: database, `oauth.json`, `journal/`, `sessions/`, `jobs/`. |
| `ULTRATHINK_PORT` | `8795` | Listen port, 1024 to 65535. |
| `ULTRATHINK_MAX_INPUT_CHARS` | `8000` | Longest request, 1 to 20000 characters. |
| `ULTRATHINK_MAX_ANSWER_CHARS` | `20000` | Longest client-driven answer, 1 to 200000 characters. |
| `ULTRATHINK_RUN_TOKEN_CEILING` | `150000` | Token limit for one plan. A plan over it stops with `budget_exceeded`. |
| `ULTRATHINK_DAILY_TOKEN_CEILING` | `1000000` | Token limit per UTC day across all plans. |
| `ULTRATHINK_PLANNING_MODEL` | unset | OpenRouter model id for server-side planning, for example `x-ai/grok-4.7`. Server-side mode needs it. |
| `OPENROUTER_API_KEY` | unset | OpenRouter key, at least 20 characters. Server-side mode needs it. |
| `ULTRATHINK_OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` | OpenRouter API base. https only, no credentials, query or fragment. |
| `ULTRATHINK_SERVER_PLANNING` | unset | `0` turns server-side mode off. `1` requires the key and the model, otherwise the server refuses to start. Unset means on when both are set. |
| `ULTRATHINK_MAX_CONCURRENT_PLANS` | `2` | Plans that run at once, 1 to 8. More starts return `busy`. |
| `ULTRATHINK_MODEL_TIMEOUT_MS` | `120000` | Timeout for one model call, 5000 to 600000. |
| `ULTRATHINK_PLAN_TIMEOUT_MS` | `600000` | Timeout for one whole plan, 30000 to 1800000. |
| `ULTRATHINK_MODEL_MAX_OUTPUT_TOKENS` | `8000` | Output token limit for one model call, 256 to 32000. |
| `ULTRATHINK_SERVER_DECISIONS` | off | `1` turns on the Jev decision gate in server-side plans. |
| `ULTRATHINK_CONNECTOR_KEY` | unset | Key for the `x-connector-key` header (Grok Bot), at least 32 characters. |
| `ULTRATHINK_ALLOWED_ORIGINS` | none | Comma list of extra browser origins (http or https) that `/mcp` accepts. |
| `ULTRATHINK_OAUTH_REDIRECT_ORIGINS` | none | Comma list of extra https origins allowed in client redirect URIs. |

Origin lists take bare origins only (`https://host[:port]`, no path, query or fragment). The request body limit is 65,536 bytes and is not configurable. `ULTRATHINK_RETENTION_DAYS` and the backup variables belong to the maintenance job; see the runbook.

## Troubleshooting

| Symptom | Cause | What to do |
|---|---|---|
| 401 on `/mcp` | No token, an expired or revoked token, or a wrong connector key. A 401 with no token on the first request is normal: it starts the OAuth flow. | Disconnect and reconnect the connector to run OAuth again. For Grok Bot, compare the key. |
| 403 with an `Origin` error from `/mcp` | The request's `Origin` is not in the allow list. | Add the origin to `ULTRATHINK_ALLOWED_ORIGINS` and restart. Check that the request is sent by the client and not by a browser page. |
| 403 `{"error":"forbidden"}` from nginx | The caller reached the origin server directly, not through Cloudflare. | Use the public hostname. |
| Registration fails: redirect URI refused (`invalid_redirect_uri`) | The client's redirect URI is not https on an allowed origin and not loopback. The message lists the allowed origins. | Add the client's redirect origin to `ULTRATHINK_OAUTH_REDIRECT_ORIGINS` and restart, only if you trust that client. |
| 429 | A rate limit fired. nginx allows 120 `/mcp` requests per minute per client address, 30 OAuth requests per minute, and 5 login requests per minute. The app has its own limits on registration (10 per hour), authorize (30 per minute) and token and revoke (60 per minute). | Wait for the `Retry-After` time. Do not poll `ultrathink_result` with `waitSeconds: 0` in a loop. |
| `busy` error from `ultrathink_uplift` | `ULTRATHINK_MAX_CONCURRENT_PLANS` plans are already running. | Wait a minute and call again with the same `sessionId`. The operator can raise the limit. |
| `disabled` or `not_ready` from `ultrathink_uplift` | Server-side mode is off, or the server is shutting down. | Use the client-driven tools (`ultrathink_plan`), or ask the operator to set the key and the model. |
| Status `failed`, error `budget_exceeded` | The per-run or daily token ceiling was reached. | Wait for the next UTC day, or ask the operator to raise the ceiling. |
| Status `skipped` | The pipeline declined the request, for example one that starts with a slash command or a `raw:` prefix. | State the request as a plain description of the task and call `ultrathink_uplift` again with a new `sessionId`. |
| Status `failed`, error `auth` | OpenRouter refused the API key (HTTP 401 or 403). | The operator replaces `OPENROUTER_API_KEY` and restarts. |
| Status `failed`, error `rate_limited`, `upstream`, `timeout`, `empty` or `bad_response` | The model provider limited, failed, timed out or returned nothing usable, after retries. | Try again with a new `sessionId`. The operator checks the model id, credit and timeouts. |
| Status `failed`, error `interrupted` | The service restarted while the plan ran. | Run it again with a new `sessionId`. |
| Status `invalid` | The model produced an incomplete plan. | Run it again, or rephrase the request. |
| Result says `truncated` | The plan was larger than the size limit, so later Graph of Thought sections were left out. | Ask the user for what is missing, or split the request into smaller ones. |
| The model does not call any tool | The client did not act on the typed `/ultrathink`. | Use the MCP prompt, add the custom instructions above, or say "use the ultrathink connector". |

For server-side checks (logs, `/readyz`, metrics), see the runbook section 7.
