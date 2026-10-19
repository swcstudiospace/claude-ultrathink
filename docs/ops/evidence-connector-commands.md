# Connector commands and Graph x Chain views: evidence

Recorded 2026-10-19 on branch `feat/connector-commands-got-views`. Each row states what was observed and how it was observed. Secret values are never written here. Nothing here proves how Claude or Grok behave as clients: neither has connected to this build (see [Not verified](#not-verified)).

## Change set

Six commits on top of `e461875` (57 files, +9,901 and -238 lines) plus the commit that adds this record. The six are additive to the five plugin hosts (see the regression row below).

| Commit | Subject |
|---|---|
| `3a13cba` | Graph x Chain views for plans: structured graph, wave tree, Mermaid, the MCP App card |
| `d676a5d` | Slash commands through prompts, tools and resources; request-log diagnostics |
| `c0f52ab` | Claude plugin bundle and the local stdio server |
| `d8a3c7e` | Fixes from the independent code and security reviews |
| `42e675a` | Documentation for every client, the command reference, runbook section 13 |
| `8c3d4f8` | Fixes from the cross-phase integration check |

Before this record was added, the branch was 24 commits ahead of `origin/main`. The other 18 are earlier local commits that were never pushed: the hosted connector service with its OAuth, planner and deployment files (`services/ultrathink/**`, `deploy/**`, `docs/ops/**`), the Omp token-optimization plugin (`plugins/omp-token-opt/**`, 34 files), one Grok Bot skill file, a type fix in `src/host/omp-ui.test.ts`, the CI workflow and `package.json`. A pull request into `origin/main` carries all of them; at that point the whole branch was 136 files, +28,879 and -83 lines.

## Decisions on record

| Date | Decision | By |
|---|---|---|
| 2026-10-19 | Blocking clarification q3 (how the connector's reasoning sessions relate to the existing thinking graph and pipeline): reuse the existing graph types and expose the existing planning pipeline. No standalone passive session engine now; it stays an extension point. | The maintainer, when asked |
| 2026-10-19 | Publish all 24 commits in one pull request, including the 18 earlier local commits. | The maintainer, when asked |
| 2026-10-19 | The GSD milestone stays open: the live-client checks below are still to be run. | The maintainer, when asked |

## Five-host regression

| Check | Result |
|---|---|
| `git diff --stat e461875..HEAD -- hosts src hooks commands skills .claude-plugin .muse-plugin .omp-plugin scripts bin ultrathink.discovery.json` | Exactly one file: the new `bin/ultrathink-connector` (+16 lines). No host adapter, hook, command, skill or manifest of the Omp, Hermes, Muse Code, Claude Code or Grok Build hosts changed in the six commits. |
| Same paths in the working tree | No uncommitted change. |
| Host test suites | The adapter suites of all five hosts and of Grok Bot are part of `bun test`, which passes in full (next table). The Hermes and Prime Agent bridge tests pass. |
| The 18 earlier commits | Outside the guard above, because they predate this work. Under the guarded paths they changed only `hosts/grok-bot/remote/ultrathink-remote/SKILL.md` and `src/host/omp-ui.test.ts`; the rest is `services/`, `deploy/`, `docs/` and `plugins/omp-token-opt/`. |

## Gates on the final tree (`8c3d4f8`)

| Gate | Result |
|---|---|
| `bun run verify` (`bun run check`, `bun test`, Hermes bridge test, Prime Agent bridge test) | Exit 0. 4,491 pass, 4 skip, 0 fail across 164 files. Prime Agent bridge: 11 tests OK. |
| `bun run check:services` | Clean. |
| Independent code review | 0 Critical, High or Medium; 6 Low, all fixed in `d8a3c7e`. |
| Independent security review | First verdict OPEN_THREATS (1 Medium: model-written node text reached the chat reply unfenced). The Medium and 4 Low are fixed in `d8a3c7e`; 4 Info notes are accepted with reasons (wildcard `targetOrigin` inside the sandbox, `mcpVersion` logged before auth but cut and encoded, host CSS applied by design, the plugin names the production URL). |
| Independent cross-phase integration check | 6 end-to-end flows. 1 Medium (a plan that `ultrathink_uplift` already reports as planned never reached the card or the model) and 7 Low, all fixed in `8c3d4f8`. |

## Client and transport checks

Run against a local instance of the service in client-driven mode with throwaway secrets, and against the stdio server. Production was not touched.

| Check | Result |
|---|---|
| `@modelcontextprotocol/sdk` 1.32.1 | connect, `tools/list` (9), `prompts/list` (6), `prompts/get`, `resources/list` and `read`, `ultrathink_plan`, `ultrathink_status`, `ultrathink_sessions`, `ultrathink_graph` (8 nodes), `ultrathink_command help` (22), ping, terminate: all pass. |
| `@modelcontextprotocol/client` 2.3.1, legacy mode and auto mode | Same matrix passes. In auto mode the client first sends `server/discover` with `MCP-Protocol-Version: 2026-07-28`, gets HTTP 400 / -32600 and falls back to `initialize`. |
| stdio server with the SDK's stdio client | 8 checks pass: 9 tools, 6 prompts, the card resource (about 41 KB), `ultrathink_graph` on a stored plan, `ultrathink_sessions`, `ultrathink_plan` returns `needs-model`, `ultrathink_command`. The only stderr line is the JSON `started` log. |
| Raw HTTP smoke | `initialize` at 2025-11-25 with `tools`, `prompts`, `resources` and the `io.modelcontextprotocol/ui` extension; 22-command help; unsupported command and unknown prompt answers; `prompts/list` and `resources/list` without credentials return 401; the 2026-07-28 probe returns 400 / -32600 and is logged with `mcpVersion` and `rpcMethod`. |
| Mermaid | 12 graphs (this milestone's own plan, a diamond, 8 hostile ones, a cycle, duplicate ids) parse and render in Mermaid 11 `strict` in headless Chrome 153 with no injected node, link or script. |
| MCP App card in a dev host | In headless Chrome 153 through `services/ultrathink/ui/harness/`: handshake, selection, keyboard, dark and narrow layouts, a running plan that polls, questions with `ui/message`, hostile text rendered inert, no CSP or network violation. A real plan served by the local connector renders with 8 cards, 3 placeholder cards, the degraded notice and 3 questions. A plan that `ultrathink_uplift` already reports as planned makes one `ultrathink_result` call; with no `tools/call` support it makes none; a refused call shows one note and does not loop. |
| Docs against code | The 22-row table in `docs/commands.md` equals the loaded catalog (4 native, 1 alias, 1 passthrough, 16 unsupported). Rate limits and field names in runbook section 13 match `auth/auth.ts` and `routes/router.ts`. |

## Not verified

| Item | Why |
|---|---|
| Claude Desktop, claude.ai, Claude Code and Grok Chat connecting to this connector | Needs the operator's accounts. The setup steps and the expected behavior per client are in [Use /ultrathink in Claude, Claude Code and Grok Chat](../how-to/use-ultrathink-in-chat.md), each marked with its source or *not verified*. |
| Whether Claude or Grok render a fenced Mermaid block | No vendor document says so; the plan text leads with a wave tree for that reason. |
| The MCP App inside Claude | Only run in the dev host harness; custom connectors are reported to render MCP Apps inconsistently. |
| Typed slash commands from the plugin bundle in claude.ai, and `$ARGUMENTS` in chat-loaded plugin commands | The plugin upload was not run. |
| Server-side planning (`ultrathink_uplift`) on this build against a real model | Needs the operator's OpenRouter key and costs money; the code path is covered by the headless tests and the shared view code. |
| The Windows stdio invocation | No Windows host here. |
| The first real connection's protocol fallback | Confirmed for the official SDKs only; runbook section 13 shows how to read it from the log. |

## 2026-10-19 live observations and release

Everything below was observed in the nginx and service logs on the VPS, in xAI's public documentation and issue tracker, and in smoke requests through the Cloudflare edge. Request bodies, tokens and client addresses are not recorded here.

### Grok Chat sessions on the older build

Log windows: 2026-10-18 19:49 to 19:50 UTC, and 2026-10-19 14:25 to 14:35 UTC. The server then ran release `e461875` (7 tools, 1 prompt, no resources). The rows follow the order of one observed connection flow.

| Step | Client (user agent) | Request | Result |
|---|---|---|---|
| 1 | `grok-connectors-manager/0.1.0` | `POST /mcp` without a token | 401 |
| 2 | `Grok` | `GET /mcp` | 405 |
| 3 | `Grok` | Well-known metadata requests | 200 |
| 4 | `Grok` | `POST /oauth/register` (redirect `https://grok.com/connectors-oauth-exchange-code/`) | 201 |
| 5 | The owner, in a browser | `POST /oauth/authorize` (approval on the consent page) | 302 |
| 6 | `Grok` | `POST /oauth/token` | 200 |
| 7 | `grok-connectors-manager/0.1.0` | `initialize`, `notifications/initialized`, `tools/list` | 200, 202, 200 |
| 8 | `grok-connectors-manager/0.1.0` | `initialize` and `notifications/initialized` again before every `tools/call` | 200, 202 |
| 9 | `grok-connectors-manager/0.1.0` | `tools/call` `ultrathink_uplift` (15 s), then `ultrathink_result` long polls of 20, 40 and 45 s | all 200 |

- Grok sent no second `tools/list`, no `prompts/list` and no `resources/*` request in those sessions.
- No HTTP 400 on `/mcp` from Grok appears in the retained logs.

### xAI tool-list caching

xAI's connector documentation (`https://docs.x.ai/grok/connectors.md`) says that Grok discovers the tools the server exposes and does not mention prompts or resources. Issue `https://github.com/xai-org/plugin-marketplace/issues/1402` (opened 2026-10-12) reports that the gateway fetches `tools/list` once when a connector is connected and fetches it again only on re-authentication; the iOS app has no Reauthenticate button. The 2026-10-19 sessions are consistent with this: one `tools/list`, none later. Because they ran against the 7-tool build, Grok needs a reconnect to see the 10-tool surface.

### Claude

No Claude user agent, no Anthropic address range `160.79.104.0/21` and no claude.ai redirect URI appear in the retained nginx logs of 2026-10-11 to 2026-10-19. Claude's behavior with this server has not been observed. Anthropic's documentation says custom connectors connect from Anthropic's cloud and that "Use Claude's published identity" needs a Client ID Metadata Document; this server supports Dynamic Client Registration only, so the documented choice is "Register automatically".

### Production release

| Item | Value |
|---|---|
| Release id | `f1e8a4fab33f-20261019T154303Z` |
| Source | `origin/main` at `f1e8a4f` (pull request 37, the v1.14 build) |
| Time | 2026-10-19 15:43 UTC |
| Replaced | `e461875` (7 tools, 1 prompt, no resources) |

### Live smoke through the Cloudflare edge after the release

| Check | Result |
|---|---|
| `initialize` | Answers the requested `protocolVersion`; capabilities `tools`, `prompts`, `resources` and the extension `io.modelcontextprotocol/ui` |
| `tools/list` | 10 tools (`ultrathink_uplift`, `ultrathink_plan`, `ultrathink_pending`, `ultrathink_show`, `ultrathink_answer`, `ultrathink_status`, `ultrathink_result`, `ultrathink_graph`, `ultrathink_sessions`, `ultrathink_command`); no `nextCursor` |
| `prompts/list` | 6 prompts |
| `resources/list` | `ui://ultrathink/graph`, `text/html;profile=mcp-app`, 42,875 bytes |
| `notifications/initialized` | 202 |
| No credentials | 401 with a `WWW-Authenticate` challenge carrying `resource_metadata` |
| `GET /mcp` | 405 with `Allow: POST` |
| `MCP-Protocol-Version: 2026-07-28` | 400 with JSON-RPC error `-32600` |
| Authorization server metadata | Advertises `registration_endpoint`, token auth method `none` and PKCE `S256`; does not advertise `client_id_metadata_document_supported` |
| Schema probe with the TypeScript SDK 1.30, TypeScript v2 2.3.1 and Python `mcp` 2.3.0 | No validation errors on the real `tools/list`, prompts and resources. Ajv 8 strict draft 2020-12 compiles all 10 tool schemas. |

### Not verified

| Item | Why |
|---|---|
| Whether claude.ai's backend tolerates `capabilities.extensions` in the `initialize` result | The field is not in the 2025-* schemas. The three SDKs above tolerate it; no Claude request has been seen. |
| Whether `grok-connectors-manager` tolerates `capabilities.extensions` | Same field. The Grok sessions above ran against the older build (7 tools, 1 prompt, no resources). |
| Whether Claude's detection picks "Register automatically" by itself | No Claude connection has been seen. |
| Grok Chat against the 10-tool build | The Grok sessions above ran against the 7-tool build, and Grok is reported to cache the tool list until it is re-authenticated. |
