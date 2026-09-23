# Stack Research

**Domain:** Python Hermes plugin calling the existing Bun/TypeScript ultrathink engine, plus a Hermes skill that writes Notion and Linear
**Researched:** 2026-09-24
**Confidence:** HIGH

The standard stack is the one ultrathink already uses, with a thinner host adapter. Hermes stays Python (`plugin.yaml` + `register(ctx)`). The engine stays Bun and TypeScript. The hook speaks one JSON object on stdin and one JSON object on stdout. Notion and Linear stay hosted remote MCP servers the skill calls during the agent turn. Do not add a Python reasoning port, an HTTP sidecar, a local MCP binary, or a tracker SDK.

## Recommended Stack

### Core Technologies

| Technology | Version | Purpose | Why Recommended |
|------------|---------|---------|-----------------|
| Hermes plugin contract | This install: `PluginContext.register_hook` and `register_skill` both present (`hermes_cli/plugins.py`) | Register `pre_llm_call` and the two skills | Official plugin surface. A TypeScript Hermes plugin cannot be installed. Verified on the running host, not from memory. Confidence: HIGH. |
| Python | `>=3.11` (plugin `requires-python`; Hermes venv is 3.11.15; system `python3` is 3.12.3) | Hook process, JSON parse, subprocess | Hermes loads the plugin in its own venv. Stay on 3.11-compatible syntax. The bridge needs nothing newer. Confidence: HIGH. |
| `subprocess` + `json` | CPython 3.11 stdlib | Spawn `bun` once per kept prompt; parse one stdout object; kill on timeout | Same stdin/stdout JSON shape `hooks/uplift.ts` already uses. No extra process manager, no open socket, fail-open is a `try/except` plus `timeout=`. Confidence: HIGH. |
| Bun | Host `1.4.0+34cbb9a40` (`bun --revision`); npm registry current `1.4.2` | Run the existing engine entry | The repo is already a Bun program (`bun test`, `bun hooks/uplift.ts`, `@types/bun`). Cold start is one process per prompt, which matches fail-open (no daemon to be down). Confidence: HIGH that Bun is the runtime. MEDIUM on "must upgrade to 1.4.2" — 1.4.0 already runs this repo; upgrade when convenient, do not downgrade. |
| TypeScript ultrathink engine | Package `ultrathink@0.1.0`, zero runtime npm dependencies | Source of truth for decide, uplift, graph, HITL questions, `TrackPlan` | Locked. Add a callable entry (`hooks/engine.ts`) that calls `runPromptSubmit`. Do not add a framework around it. Confidence: HIGH. |
| Notion MCP (hosted) | No package version. URL `https://mcp.notion.com/mcp` | Skill finds and writes Agent Task Graph rows | Official docs call this the hosted, actively maintained server. It accepts `collection://` data-source URLs and SQL via `notion-query-data-sources`. The locked data source `collection://be3418f0-d2d8-411b-8677-fa8a95ee63be` is a Notion URL, not a Claude-only handle. Hermes already speaks this transport for Linear. Confidence: HIGH that the same data source works from Hermes once OAuth is connected. It is not in `~/.hermes/config.yaml` today. |
| Linear MCP (hosted) | No package version. URL `https://mcp.linear.app/mcp`, `auth: oauth`, already `enabled: true` in this Hermes config | Skill creates issues and sub-issues on team Spectrum Web Co | Official Streamable HTTP endpoint. Docs cite the 2025-03-26 MCP spec and explicitly describe creating a parent issue plus sub-issues. Team name is a tool argument, not a client library. Confidence: HIGH that the same team works. MEDIUM on the exact parent-field name — Linear does not publish a frozen tool schema; read the live tool list. |
| Hermes `clarify` | Built-in tool (toolset `clarify`, included in `hermes-cli`) | One batched blocking question before work | Claude's `AskUserQuestion` does not exist here. `clarify` accepts a `questions` array of 2–5, which covers ultrathink's cap of 4 blocking questions in one call. Non-interactive platforms omit the tool; the skill then uses defaults, same fail-open as Claude. Confidence: HIGH. |

### Supporting Libraries

| Library | Version | Purpose | When to Use |
|---------|---------|---------|-------------|
| None on the Python side | — | Bridge | Do not add `httpx`, `pydantic`, `mcp`, `notion-client`, or a Linear SDK. The hook must not import Hermes either, so pytest stays hermetic. |
| `@types/bun` | `^1.4.0` already in `package.json`; npm current `1.4.2` satisfies the caret | Typecheck the new engine entry | Keep the existing devDependency. Do not add Zod, Hono, Elysia, or a second schema package for one internal JSON envelope. Parse the way `hooks/uplift.ts` already parses stdin. |
| Notion MCP tools (remote, not installed) | Hosted server, current tool list as of the 2026-09-24 docs fetch | Idempotent row writes | `notion-query-data-sources` in SQL mode for the Graph ID lookup (`SELECT ... WHERE "Graph ID" = ?`). `notion-create-pages` and `notion-update-page` for Task / Issue / Sub-Issue rows. `notion-fetch` with the `collection://` URL when the skill needs the schema. Pass `allow_async: false` on creates the next step must use immediately. |
| Linear MCP tools (remote, already connected) | Hosted server | Issue and sub-issue creates, status updates | Use the create/update issue tools the connected server exposes. Official example prompts tell the client to create a parent issue and sub-issues. Do not vendor a GraphQL client to get a stable method name. |
| pytest | 9.1.1 on this machine's `python3` | Plugin tests | Dev only. Not a runtime dependency. Keep `python3 -m pytest -q` in `hermes-plugin`. |

### Development Tools

| Tool | Purpose | Notes |
|------|---------|-------|
| `bun test` | Engine tests, including the new entry | Already the gate. Do not add Vitest, Jest, or Node's test runner. |
| `bunx tsc --noEmit` | Engine typecheck | Already `bun run check`. npm reports `typescript@7.0.2` as current. Do not pin that as part of this bridge. The repo typechecks today without a `typescript` dependency. |
| `python3 -m pytest -q` | Plugin tests | Run from `hermes-plugin`. Do not point pytest at the Hermes venv unless a test must load `PluginContext`. Bridge unit tests must not import Hermes. |
| `hermes mcp add notion --url https://mcp.notion.com/mcp --auth oauth` | Connect Notion the same way Linear is already connected | Documented Hermes remote-MCP command. Then `hermes mcp login notion` if the first tool call has no token. Do not wrap it in `npx mcp-remote`. |
| `hermes plugins list` | Confirm `prompt-uplift` is enabled after the skill registration lands | Enable with `hermes plugins enable prompt-uplift --no-allow-tool-override`. Takes effect next session. |

## Installation

```bash
# Engine — no new runtime packages. Align the host binary with npm current when convenient.
# This host: bun 1.4.0+34cbb9a40 at /root/.local/share/reflex/bun/bin/bun
# npm registry on 2026-09-24: bun@1.4.2, @types/bun@1.4.2
# Do not curl|bash a downgrade. GitHub /releases/latest still advertised 1.3.11 (2026-03-18),
# which disagrees with npm. Trust npm for the pin; keep 1.4.x.

# Plugin — no new Python packages. Bridge is stdlib json + subprocess.
# requires-python stays >=3.11. Do not add a pyproject dependency.

# Notion remote MCP (Linear is already enabled; do not re-add it)
hermes mcp add notion --url https://mcp.notion.com/mcp --auth oauth
hermes mcp test notion

# Operator config the bridge cannot ship inside the plugin (global, not a package):
# plugins.hook_callback_timeout: 600
# hooks.output_spill.max_chars: 80000
```

Equivalent `~/.hermes/config.yaml` shape, matching the Linear entry already on this host:

```yaml
mcp_servers:
  notion:
    url: https://mcp.notion.com/mcp
    auth: oauth
    enabled: true
  # linear: already present
  #   url: https://mcp.linear.app/mcp
  #   auth: oauth
  #   enabled: true
plugins:
  hook_callback_timeout: 600   # documented max; default 30s fail-opens this hook
hooks:
  output_spill:
    max_chars: 80000           # default 10000 spills a real uplift+graph
```

Do not set `requires_env` for a Notion or Linear token. A missing key disables the whole plugin, including the hook, which violates fail-open.

## Alternatives Considered

| Recommended | Alternative | When to Use Alternative |
|-------------|-------------|-------------------------|
| One-shot `subprocess.run([bun, "hooks/engine.ts"], input=json, timeout=...)` | Long-lived Bun HTTP server (Hono, Elysia, `Bun.serve`) | Only if measured cold-start plus engine time cannot fit under the hook budget **and** a daemon health check is acceptable. It is not acceptable for v1: a down daemon is another fail-open path, and this engine is already a one-shot CLI. |
| JSON object in, JSON object out, always exit 0 | JSON-RPC 2.0, gRPC, or a Unix socket | Never for this bridge. There is one method. Extra framing is a second parser to fail open on. |
| Hosted Notion MCP + hosted Linear MCP, called by the skill | `@notionhq/notion-mcp-server@2.5.2` (npm current) over stdio with `NOTION_TOKEN`, or `notion-client` / `@linear/sdk` from Python | Use the local Notion server only if this workspace cannot complete OAuth to `https://mcp.notion.com/mcp`. It is the older API-key server (docs still show `Notion-Version: 2025-09-03`). Do not put either SDK in the hook. |
| `ctx.register_skill(name, skill_md)` from the plugin's `skills/` directory | Copy `SKILL.md` into `~/.hermes/skills/` | Never for this plugin. Official docs mark the copy pattern as legacy and a name-collision risk. Plugin skills are read-only and namespaced (`prompt-uplift:ultrathink-kickoff`). |
| Hermes `clarify` | Claude `AskUserQuestion`, or a plugin-owned prompt UI | Never. `AskUserQuestion` is not a Hermes tool. A custom prompt would bypass the platform adapters `clarify` already has. |
| Inject uplift XML plus a compact graph, full `SessionRecord` on disk | Inject the entire CoT-filled plan into `pre_llm_call` context | Use the fat inject only if `hooks.output_spill.max_chars` is raised and a live turn shows the model ignoring the state file. Default spill is 10,000 characters; a filled graph usually exceeds it and gets replaced by a preview. |
| `plugins.hook_callback_timeout: 600` plus a subprocess timeout under that | Leave the 30s default, or set `0` (unlimited) | Set `0` only if live graphs are still abandoned at 600s. A `0` cap without a subprocess timeout hangs the turn. The 30s default is wrong: `pre_llm_call` is timeout-bounded and fail-open, so a 30s abandon skips uplift silently. Claude's own hook budget is 86,400s (`CLAUDE_USER_PROMPT_HOOK_TIMEOUT_SEC`). Hermes documents 600 as the max. |

## What NOT to Use

| Avoid | Why | Use Instead |
|-------|-----|-------------|
| A Python rewrite of uplift, graph, HITL, or `TrackPlan` | Forks the engine the operator already trusts. Locked out of scope. | `bun hooks/engine.ts` calling `runPromptSubmit` |
| `ctx.llm.complete` as the completer | That is the current plugin's second engine. Provider and model overrides are config-gated and are not the TypeScript pipeline. | The engine's existing `createClaudeCompleter` / `createGrokCompleter`, selected inside the Bun process |
| Node, `tsx`, Deno, or `oven/bun` Docker as the way Hermes invokes the engine | The checkout has no Node toolchain of its own. Node v24.18.0 is on this host and is irrelevant. A container adds a runtime the hook cannot assume. | The `bun` binary on `PATH`, with an optional config override for the binary path. This host resolves bun to `/root/.local/share/reflex/bun/bin/bun`; do not hardcode that path. |
| Hono, Elysia, FastAPI, or a Unix-socket daemon | Another process to supervise. Fail-open becomes "is the port up?" | One subprocess per kept prompt |
| `httpx`, `aiohttp`, `requests`, `pydantic`, `msgspec` | No HTTP call and no schema library belong in the hook. A validation error must not be a new way to block the prompt. | stdlib `json` and a typed dict on the TypeScript side |
| Python `mcp` SDK, `@notionhq/client`, `notion-client`, `@linear/sdk`, community `linear-mcp-server` packages | Hooks must not call Notion or Linear. Community Linear servers are not the hosted server this Hermes config already uses. | Skill calls `mcp__notion__*` and `mcp__linear__*` tools Hermes already registers |
| `https://mcp.linear.app/sse` and `npx mcp-remote` | Linear documents `/sse` as a deprecated fallback. Hermes speaks Streamable HTTP natively (`auth: oauth`). | `https://mcp.linear.app/mcp`, already enabled |
| `https://mcp.linear.app/mcp/readonly` | Read-only cannot create issues. | The default read-write `/mcp` endpoint |
| Hermes Kanban (`hermes kanban create`) and a GSD write into `cwd` | Those are the writes this milestone removes. The older plugin-authoring note that says "native Kanban, never Tissue" does not apply here. | Notion Agent Task Graph + Linear team Spectrum Web Co |
| `requires_env: [NOTION_TOKEN, LINEAR_API_KEY]` | Missing env disables the plugin, so a down tracker also disables uplift. | OAuth on the MCP servers. If either server is down or logged out, the skill says so and continues. |
| Copying skills into `~/.hermes/skills/` | Collides with built-ins and drifts from the plugin checkout. | `ctx.register_skill` |
| Raising only `hooks.output_spill.max_chars` and stuffing every CoT step into the hook return | Spill exists so one plugin cannot blow the prompt-cache prefix. The session file is the plan payload. | Hook returns uplift XML, a compact graph (id, title, edges), the state-file path, and the kickoff instruction. Skill reads the file for steps. |
| Pinning `typescript@7.0.2` or swapping `bunx tsc` for another checker as part of this milestone | Unrelated toolchain change. npm current is 7.0.2; this repo does not pin it. | Keep `bun run check` |

## Stack Patterns by Variant

**If the prompt is a child session (`parent_session_id` set), `platform=cron`, empty, or non-text:**

- Do not spawn Bun.
- Because a child or cron turn cannot answer `clarify`, and a second uplift nests. Return `None`. Confidence: HIGH (Hermes hook kwargs and plugin-authoring pitfalls).

**If Bun is missing, the engine exits badly, stdout is not one JSON object, or the subprocess exceeds its timeout:**

- Return `None`. Log one warning. Do not raise.
- Because `pre_llm_call` exceptions are already swallowed, but a hung subprocess is not an exception until `timeout=` fires. Set the subprocess timeout below `plugins.hook_callback_timeout` (540s when the cap is 600) so the hook returns before Hermes abandons the worker. Confidence: HIGH.

**If the engine returns a plan:**

- Hook return is `{"context": "..."}` (or a plain string). Hermes appends that to the user message. It does not replace the bubble and it does not touch the system prompt.
- Include the uplift XML, a compact graph, `stateFile=`, and an instruction to invoke `prompt-uplift:ultrathink-kickoff` before coding. Plugin skills are not in the `<available_skills>` index; the injected line is how the agent finds the skill (`skill_view("prompt-uplift:ultrathink-kickoff")`). Confidence: HIGH.

**If Notion or Linear is down, logged out, or the data source is not shared with the OAuth connection:**

- The hook still injects. The skill records which Graph ID / node / step writes failed and still emits whatever `<ISSUES>` it has, or omits the block if `plan` was missing.
- Because the locked fail-open rule is about the user's prompt, not about tracker completeness. Same data source and same team are valid from Hermes; a 404 is permissions, not a protocol mismatch. Confidence: HIGH on the split. MEDIUM that this workspace's Notion OAuth user can see `collection://be3418f0-d2d8-411b-8677-fa8a95ee63be` until `hermes mcp test notion` is run against that URL.

**If the completer is Grok (`http`, `cli`, or `shunt`):**

- Still one Bun subprocess. Engine selection stays in TypeScript (`selectEngine` in `hooks/uplift.ts`).
- Do not route uplift through `ctx.llm.complete(provider=, model=)`. Confidence: HIGH.

**If a PR was just created, or a coding turn is stopping:**

- Nudge the agent to invoke `prompt-uplift:ultrathink-sync`. Use `transform_tool_result` for the PR-create match and `pre_verify` for the coding-stop match. Both are existing Hermes hooks (`VALID_HOOKS`). They return text. They do not call MCP.
- Sync still only updates. It never creates rows. Confidence: HIGH on the hooks. The regex stays the TypeScript one in `src/track/pr-detect.ts`; do not import a Python `gh` library.

**If `clarify` is absent (API server, ACP, webhook toolsets drop it):**

- Proceed with each blocking item's default and say so.
- Because those platforms have no one to ask, and a missing tool must not stall the turn. Confidence: HIGH.

## Version Compatibility

| Package A | Compatible With | Notes |
|-----------|-----------------|-------|
| Plugin `requires-python >=3.11` | Hermes venv Python 3.11.15 | Write the bridge for 3.11. `subprocess.run(..., timeout=)` has been stdlib since 3.3. Do not use 3.12-only syntax (`type` aliases that need `from __future__` are fine; `type` statement syntax is not required). |
| Host Bun `1.4.0+34cbb9a40` | `@types/bun ^1.4.0` (npm `1.4.2` matches the caret) | Safe. Upgrade the binary to 1.4.2 if you want types and runtime identical. Do not install Bun 1.3.11 over this; that tag is what GitHub `/releases/latest` still showed, and it is older than both npm and this host. |
| `hooks/engine.ts` | Existing `src/claude/hook.ts` `runPromptSubmit` | The new entry is an adapter. It must not replace `hooks/uplift.ts`. Claude Code keeps its own stdin protocol (`hookSpecificOutput`). Hermes gets a different JSON envelope and always exits 0. |
| Hermes `pre_llm_call` | `plugins.hook_callback_timeout` default 30, max 600, `0` disables | A full graph plus per-node fills will not finish in 30s. Set 600 and kill Bun earlier. Claude's hook timeout of 86,400s is not available here. |
| Hermes context injection | `hooks.output_spill.max_chars` default 10000 | Uplift `maxChars` default is 20000, already over the spill cap. Raise spill to 80000 or the injected spec becomes a preview plus a path under `$HERMES_HOME/hook_outputs/`. |
| Notion `collection://be3418f0-d2d8-411b-8677-fa8a95ee63be` | Hosted MCP `notion-fetch` and `notion-query-data-sources` | Official tool docs: fetch a `collection://` URL for schema; query with SQL or `mode: "rows"`. Keep SQL for the Graph ID lookup. The existing skill recorded that rows-mode filters were rejected live; official docs now describe row filters, but do not switch until a live call against this data source succeeds. SQL across one data source is metered off Business+AI; one lookup per kickoff is inside that shape. |
| Linear team `Spectrum Web Co` | `https://mcp.linear.app/mcp` already enabled | No client upgrade. Sub-issues are a parent link on create, which Linear's own MCP prompts describe. Read the live tool schema for the parent argument before hardcoding it. |
| Hermes tool names | Official tool names with hyphens | Hermes rewrites non-identifier characters to underscores: server `notion`, tool `notion-query-data-sources` is exposed as `mcp__notion__notion_query_data_sources`. Skill text should name the official tool and tell the agent to use the connected server's tool, not a Claude Code name. |
| `ctx.register_skill` | This install's `PluginContext` | Present, alongside `register_hook`. The older "no `get_config`" skew does not block skill registration. Still probe `getattr` if the hook reads config; do not require `ctx.get_config` for the bridge. |
| pytest 9.1.1 | Plugin tests via `python3 -m pytest -q` | Do not add pytest to the Hermes venv for this milestone. Do not add `pytest-asyncio`; the bridge is synchronous. |

## Sources

- Installed Hermes plugin guide, `website/docs/developer-guide/plugins/index.md` — `pre_llm_call` return `{"context": ...}`, 10,000-character spill, `ctx.register_skill`, fail-open on hook exceptions. Confidence: HIGH (local docs matching this install).
- Installed Hermes hooks guide, `website/docs/user-guide/features/hooks.md` — `plugins.hook_callback_timeout` default 30s, max 600, `pre_llm_call` fail-open on timeout. Confidence: HIGH.
- Installed Hermes MCP guide, `website/docs/user-guide/features/mcp.md` and `website/docs/reference/mcp-config-reference.md` — `auth: oauth`, Streamable HTTP, tool-name sanitization to `mcp__<server>__<tool>`. `hermes mcp add --url ... --auth oauth` from `website/docs/getting-started/nix-setup.md`. Confidence: HIGH.
- Installed `PluginContext` — `register_hook` and `register_skill` present. Confidence: HIGH.
- This host: `bun --revision` → `1.4.0+34cbb9a40`; `npm view bun version` → `1.4.2`; `npm view @types/bun version` → `1.4.2`; `npm view typescript version` → `7.0.2`; `npm view @notionhq/notion-mcp-server version` → `2.5.2` (cited only to reject it). Confidence: HIGH for the numbers, MEDIUM for treating GitHub's 1.3.11 "latest" as stale.
- Notion, Connecting to Notion MCP — https://developers.notion.com/guides/mcp/get-started-with-mcp — hosted URL `https://mcp.notion.com/mcp`. Confidence: HIGH.
- Notion, Supported tools — https://developers.notion.com/guides/mcp/mcp-supported-tools — `notion-query-data-sources` SQL mode, `collection://` fetch, `notion-create-pages` / `notion-update-page`, `allow_async`. Confidence: HIGH.
- Linear, MCP server — https://linear.app/docs/mcp — `https://mcp.linear.app/mcp`, OAuth 2.1, SSE deprecated, create-issue and sub-issue prompts. Spec cited: https://modelcontextprotocol.io/specification/2025-03-26. Confidence: HIGH on the endpoint, MEDIUM on unpublished tool parameter names.
- Repo `package.json`, `src/config.ts`, `hooks/uplift.ts`, `skills/ultrathink-kickoff/SKILL.md` — existing Bun entry, data source, team name, SQL lookup. Confidence: HIGH (code, not a version claim).
- `~/.hermes/config.yaml` — Linear already at `https://mcp.linear.app/mcp` with `auth: oauth`; Notion server absent. Confidence: HIGH.

---
*Stack research for: Hermes host bridge onto the Bun/TypeScript ultrathink engine, skill-side Notion and Linear*
*Researched: 2026-09-24*
