<!-- GSD:project-start source:PROJECT.md -->

## Project

**Ultrathink on Hermes**

The TypeScript ultrathink plugin stays the source of truth for prompt uplift, Graph of Thought, and Chain of Thought. Hermes does not reimplement that engine. A Python hook calls the TypeScript pipeline, writes the spec to a session file outside the repo, appends a short path and skill instruction, and a Hermes skill does the Notion and Linear tracking that `ultrathink-kickoff` and `ultrathink-sync` already do for Claude Code.

This is for the operator running Hermes Agent. Claude Code keeps using the existing plugin unchanged, except for a callable engine entry the Hermes hook can invoke.

**Core Value:** Every non-trivial Hermes prompt is planned by the TypeScript ultrathink engine, then tracked in Notion and Linear, before the agent does the work.

### Constraints

- **Host**: Hermes plugins are Python — the hook and skill live in `hermes-plugin`, referenced by absolute path from this planning root
- **Source of truth**: Reasoning stays in `claude-ultrathink`. Do not port the engine to Python
- **MCP split**: Hooks do not call Notion or Linear. The skill does, same as ultrathink
- **Fail-open**: A down engine, Notion, or Linear must not block the user's prompt
- **Tracker**: Notion and Linear only. Same data source and Linear team ultrathink already uses, unless a later decision changes that
- **Git**: Planning docs commit in `claude-ultrathink`. Python edits commit in `/root/src/repos`. Do not nest a new `.git` in `hermes-plugin`
- **Dirty branch**: Do not stage unrelated in-flight TypeScript changes when committing planning files

<!-- GSD:project-end -->

<!-- GSD:stack-start source:research/STACK.md -->

## Technology Stack

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

# Engine — no new runtime packages. Align the host binary with npm current when convenient.

# This host: bun 1.4.0+34cbb9a40 at /root/.local/share/reflex/bun/bin/bun

# npm registry on 2026-09-24: bun@1.4.2, @types/bun@1.4.2

# Do not curl|bash a downgrade. GitHub /releases/latest still advertised 1.3.11 (2026-03-18),

# which disagrees with npm. Trust npm for the pin; keep 1.4.x.

# Plugin — no new Python packages. Bridge is stdlib json + subprocess.

# requires-python stays >=3.11. Do not add a pyproject dependency.

# Notion remote MCP (Linear is already enabled; do not re-add it)

# Operator config the bridge cannot ship inside the plugin (global, not a package):

# plugins.hook_callback_timeout: 600

# hooks.output_spill.max_chars: 80000

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

- Do not spawn Bun.
- Because a child or cron turn cannot answer `clarify`, and a second uplift nests. Return `None`. Confidence: HIGH (Hermes hook kwargs and plugin-authoring pitfalls).
- Return `None`. Log one warning. Do not raise.
- Because `pre_llm_call` exceptions are already swallowed, but a hung subprocess is not an exception until `timeout=` fires. Set the subprocess timeout below `plugins.hook_callback_timeout` (540s when the cap is 600) so the hook returns before Hermes abandons the worker. Confidence: HIGH.
- Hook return is `{"context": "..."}` (or a plain string). Hermes appends that to the user message. It does not replace the bubble and it does not touch the system prompt.
- Include the uplift XML, a compact graph, `stateFile=`, and an instruction to invoke `prompt-uplift:ultrathink-kickoff` before coding. Plugin skills are not in the `<available_skills>` index; the injected line is how the agent finds the skill (`skill_view("prompt-uplift:ultrathink-kickoff")`). Confidence: HIGH.
- The hook still injects. The skill records which Graph ID / node / step writes failed and still emits whatever `<ISSUES>` it has, or omits the block if `plan` was missing.
- Because the locked fail-open rule is about the user's prompt, not about tracker completeness. Same data source and same team are valid from Hermes; a 404 is permissions, not a protocol mismatch. Confidence: HIGH on the split. MEDIUM that this workspace's Notion OAuth user can see `collection://be3418f0-d2d8-411b-8677-fa8a95ee63be` until `hermes mcp test notion` is run against that URL.
- Still one Bun subprocess. Engine selection stays in TypeScript (`selectEngine` in `hooks/uplift.ts`).
- Do not route uplift through `ctx.llm.complete(provider=, model=)`. Confidence: HIGH.
- Nudge the agent to invoke `prompt-uplift:ultrathink-sync`. Use `transform_tool_result` for the PR-create match and `pre_verify` for the coding-stop match. Both are existing Hermes hooks (`VALID_HOOKS`). They return text. They do not call MCP.
- Sync still only updates. It never creates rows. Confidence: HIGH on the hooks. The regex stays the TypeScript one in `src/track/pr-detect.ts`; do not import a Python `gh` library.
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

<!-- GSD:stack-end -->

<!-- GSD:conventions-start source:CONVENTIONS.md -->

## Conventions

## Naming Patterns

- Lowercase, single-word or kebab-case `.ts` names: `src/track/pr-detect.ts`, `src/claude/complete.ts`, `hooks/pr-sync.ts`.
- One concern per file, named for the verb/noun it owns: `detect.ts`, `run.ts`, `xml.ts`, `fallback.ts` in `src/uplift/`; `graph.ts`, `pipeline.ts`, `prompts.ts`, `types.ts` in `src/think/`.
- Tests are co-located siblings with the `.test.ts` suffix: `src/think/graph.ts` ↔ `src/think/graph.test.ts`.
- Per-module type files are always `types.ts` (`src/types.ts`, `src/think/types.ts`, `src/hitl/types.ts`, `src/track/types.ts`, `src/grok/types.ts`). Put shared interfaces, string-literal unions, and DEFAULT_* constants there, never in implementation files.
- Prompt text lives in `prompts.ts` (`src/think/prompts.ts`, `src/hitl/prompts.ts`) or `prompt.ts` (`src/uplift/prompt.ts`) as exported template-literal constants.
- Hook entry points are `hooks/<event>.ts` with a `#!/usr/bin/env bun` shebang (`hooks/uplift.ts`, `hooks/stop.ts`, `hooks/answers.ts`, `hooks/pr-sync.ts`).
- `camelCase`, verb-first: `runPromptSubmit`, `buildTrackPlan`, `normalizeGraph`, `parseClaudeJson`, `injectGraphXml`, `formatSummary`.
- Predicates start with `is`: `isTrivial`, `isAlreadyUplifted`, `isCommandPrompt`, `isAbortError`, `isGrokAuthError`, `isChildInvocation` (`src/uplift/detect.ts`, `src/claude/complete.ts`).
- Type-narrowing helpers start with `as`: `asString`, `asRecord` (`src/config.ts:95`, `src/think/graph.ts:35`, `src/hitl/pipeline.ts:35`).
- Factory functions are `create<Thing>`: `createClaudeCompleter`, `createGrokCompleter`.
- Read/write pairs are `read<Thing>`/`write<Thing>`: `readControl`/`writeControl`, `readSession`/`writeSession`, `readJson`/`writeJson` (`src/claude/state.ts`).
- Idempotent setup steps are `ensure<Thing>`: `ensureMcpServer`, `ensurePluginInstalled`, `ensureFreshGrokAuth`.
- Path resolvers end in `Path`/`Paths`/`Dir`: `sessionPath`, `controlPath`, `claudeConfigPaths`, `defaultStateDir`, `claudeMdPath`.
- Prompt-payload builders end in `Payload`: `graphUserPayload`, `cotUserPayload`, `clarifyUserPayload`.
- `camelCase` for locals and parameters.
- `UPPER_SNAKE_CASE` for module-level constants, including regexes and limits: `MAX_NODES`, `MIN_STEPS`, `MAX_RATIONALE_CHARS`, `DEFAULT_CONTEXT_CHARS`, `TRIVIAL_RE`, `GRAPH_BLOCK_RE`, `LINE_MARKER_RE`, `CHILD_ENV`, `LOGIN_HINT`.
- Regex constants end in `_RE`: `RATIONALE_RE` (`src/claude/output.ts:19`), `SSH_RE`/`HTTPS_RE` (`src/track/git.ts:1-2`), `BEARER_RE`/`JWT_RE` (`src/grok/auth.ts:197-198`).
- Digit separators in numeric literals: `90_000`, `86_400`, `60_000`, `20_000`, `1_000`.
- Prefer `const`; `let` only for loop cursors and mutable flags (`let timedOut = false;` in `src/claude/complete.ts:89`).
- Discard unused callback params with a leading underscore: `async (_system, user) => …` (`src/claude/hook.test.ts:30`).
- `PascalCase` interfaces and type aliases, no `I` prefix: `UpliftResult`, `ThoughtGraph`, `TrackPlan`, `HookDeps`, `SessionRecord`.
- Options bags are `<Verb><Noun>Options`: `ClaudeCompleteOptions`, `GrokCompleteOptions`, `RunThinkOptions`, `RunClarifyOptions`, `EnsureFreshOptions`.
- Function-type aliases for injectable behaviour: `ClaudeCompleter`, `Completer`, `GitRun`, `Run` (`src/claude/complete.ts:25`, `src/hitl/pipeline.ts:13`, `src/track/git.ts:14`, `scripts/setup.ts:82`).
- String-literal unions instead of enums: `NodeKind`, `GrokEffort`, `GrokTransport`, `"llm" | "fallback"`, `"grok" | "claude"`. When a runtime list is needed too, derive the type from an `as const` tuple: `ROOT_TAGS` → `RootTag = (typeof ROOT_TAGS)[number]` (`src/types.ts:1-9`), `CTL_SCOPES` → `CtlScope` (`hooks/uplift.ts:19-20`).
- Discriminated unions on an `action`/`type` field: `UpliftDecision` (`src/types.ts:24-27`), `Engine | { skipped: string }` (`hooks/uplift.ts:83`).
- Tracking rows are `<Thing>Row` for Notion and `<Thing>Plan` for Linear: `TaskRow`, `IssueRow`, `SubIssueRow`, `LinearIssuePlan`, `LinearSubIssuePlan` (`src/track/types.ts`).
- Untrusted JSON shapes are declared with every field `?: unknown` and narrowed at use: `AuthEntry` (`src/grok/auth.ts:74`), `ResponsesReply`/`ResponsesOutputItem` (`src/grok/complete.ts:50-63`).

## Code Style

- No Prettier/Biome/ESLint config. Match the existing style by hand.
- Tabs for indentation, everywhere (`.ts`, `.json`, generated XML strings in `src/think/graph.ts:187-199`, and JSON written with `JSON.stringify(value, null, "\t")` in `src/claude/state.ts:54`).
- Double quotes for strings; template literals for interpolation. Backtick multi-line prompts in `src/think/prompts.ts`, `src/uplift/prompt.ts`.
- Semicolons always. Trailing commas in multi-line literals and argument lists.
- Line width is soft; roughly 120 chars is typical, but long lines are accepted when wrapping hurts readability (long `expect(...)` chains, template strings, CLI arg arrays). Do not introduce a formatter that would reflow the repo.
- Single-statement `if` bodies stay on one line without braces: `if (!trimmed) throw new Error("claude returned no output");` (`src/claude/complete.ts:53`). Use braces when the body spans multiple lines.
- Ternaries for short either/or; chain `? :` on new lines when the branches are long (`src/config.ts:117-120`).
- Arrow functions for callbacks and injected seams; `function` declarations for module-level named functions.
- `bunx tsc --noEmit` (`bun run check`) is the only static check. `tsconfig.json` has `strict: true` and `verbatimModuleSyntax: true`; both must pass.
- No `any`. Narrow `unknown` with `typeof`/`Array.isArray`/`in` checks. The only casts in production are `as Record<string, unknown>` after an object check and `as Partial<SessionRecord>` after a shape check (`src/claude/state.ts:83`).
- Non-null assertions (`!`) are allowed only immediately after a guard that proves the value exists: `const tag = open[1]!;` after `if (!open) return` (`src/uplift/xml.ts:39`, `src/think/graph.ts:234`, `src/hitl/format.ts:47`); `group[cursor++]!` inside a `while (cursor < group.length)` (`src/think/pipeline.ts:107`).
- Use optional chaining on regex matches: `text.match(re)?.[1]?.trim() ?? ""` (`src/think/graph.ts:12`).
- No `@ts-ignore`/`@ts-expect-error` anywhere in `src/`, `hooks/`, or `scripts/`.

## Import Organization

- None. Always relative paths with an explicit `.ts` extension (`allowImportingTsExtensions` + `verbatimModuleSyntax`). Never omit the extension; never write `.js`.
- Hooks and scripts reach into `src/` with `../src/...` (`hooks/uplift.ts:8-17`).
- No barrel/index files. Import from the concrete module.
- Use `Bun.spawn`/`Bun.spawnSync` for subprocesses (`src/claude/complete.ts:81`, `src/track/git.ts:17`), `new Response(stream).text()` to drain stdout/stdin (`hooks/uplift.ts:28`), `import.meta.main` to guard a CLI `main()` in an importable script (`scripts/setup.ts:195`).
- Use `node:fs` sync APIs (`readFileSync`, `writeFileSync`, `mkdirSync`, `existsSync`) for config/state I/O; hooks are one-shot processes so sync is the norm.

## Error Handling

- **Fail-open is the architecture.** Everything after the "should we uplift?" decision must let the user's prompt through. `runPromptSubmit` (`src/claude/hook.ts:66`) wraps each stage (uplift, think, clarify, track plan, state write) in its own `try/catch`, logs, and continues. Hook entry points end with `main().catch(() => process.exit(0))` (`hooks/stop.ts:31`, `hooks/pr-sync.ts:66`) or log-then-`exit(0)` (`hooks/uplift.ts:244-247`). Never exit non-zero from a hook.
- **AbortError is the one exception to fail-open.** Every pipeline catch rethrows aborts so the budget timer can cancel the whole run:
- **Fallback values instead of throws for parsing.** JSON readers return `undefined` on any failure (`readJson` in `src/config.ts:100`, `src/claude/state.ts:43`, `src/grok/auth.ts:55`); normalizers return `[]`/`null`/a default object for garbage (`normalizeClarifications`, `extractJsonObject`, `normalizeGraph` pads with `FALLBACK_GRAPH`). Config merge functions coerce each field with `typeof` checks and fall back to defaults per field, never rejecting the whole file (`src/config.ts:138-206`).
- **Throw only at trust boundaries with a specific message.** Parsers of subprocess/HTTP output throw plain `Error`s with lowercase, tool-prefixed messages: `"claude returned no output"`, `"claude output is not JSON"`, `"grok timed out after ${timeoutMs}ms"`, `"grok cli stopped: ${reason}"` (`src/claude/complete.ts:51-67`, `src/grok/complete.ts:169-188`).
- **Custom error classes only for the Grok boundary**, with `override name` so `instanceof`-free checks work: `GrokAuthError`, `GrokHttpError` (`src/grok/auth.ts:35-49`). Pair each with an `is<Name>(error: unknown)` that matches by class or by `name` (`src/grok/complete.ts:280-283`). Auth errors always end with the actionable hint `run \`grok login\`` (`LOGIN_HINT`).
- **Redact before surfacing.** Any error text that could contain a token passes through `redactSecrets` (`src/grok/auth.ts:201`) before logging or including in a message (`hooks/uplift.ts:61`, `src/grok/complete.ts:144`).
- **Stringify unknown errors uniformly:** `error instanceof Error ? error.message : String(error)` (`src/claude/hook.ts:104`, `scripts/setup.ts:197`).
- **Empty catches carry a comment** explaining why swallowing is correct: `// fail-open` (`src/claude/hook.ts:83`), `// fall through` (`src/think/graph.ts:21`), `// The CLI is optional here…` (`src/grok/auth.ts:178`).
- **Timers and listeners are cleaned up in `finally`:** `clearTimeout(timer); opts.signal?.removeEventListener("abort", onAbort);` (`src/claude/complete.ts:113-116`, `src/grok/complete.ts:148-151`, `260-264`).

## Logging

- Library code in `src/` never logs directly. It accepts an optional callback — `log?: (message: string) => void` on `HookDeps` (`src/claude/hook.ts:53`) or `onProgress?: (message: string) => void` on pipeline options (`src/think/pipeline.ts:24`, `src/hitl/pipeline.ts:23`) — and defaults it to a no-op: `const log = deps.log ?? (() => {});`.
- `hooks/uplift.ts:22-24` defines the only real logger; it is gated on `ULTRATHINK_DEBUG=1` and prefixes `[ultrathink] `. Wire it in via `deps.log`.
- Log messages are short, lowercase, `stage: detail` form: `` `uplift failed: ${msg}` ``, `` `skipped: ${reason}` ``, `` `fatal: ${msg}` ``. Progress messages use `…` while running and `→ N` on completion (`"Clarifications…"`, `` `Clarifications → ${list.length}` ``).
- stdout of a hook is protocol, not logs: write exactly one JSON object (`{ hookSpecificOutput, systemMessage? }` or `{ systemMessage }`) and nothing else (`hooks/uplift.ts:241`, `hooks/answers.ts:52`).
- User-facing summaries are built by `formatSummary` (`src/claude/output.ts:84`) as ` · `-joined bits; keep that separator for any new status line.
- Never log tokens, auth headers, or raw `auth.json` contents; route through `redactSecrets` first.

## Comments

- Every non-trivial module opens with a `/** … */` block explaining its role and the constraint it exists to satisfy (`src/claude/complete.ts:1-8`, `src/claude/output.ts:1-8`, `src/grok/auth.ts:1-7`, `hooks/pr-sync.ts:2-11`). Do this for any new file in `src/`, `hooks/`, or `scripts/`.
- Comment the *why*, not the *what*: hidden host behaviour (`src/config.ts:27-31` on the Claude Code hook timeout), deliberate trade-offs (`src/track/pr-detect.ts:16-21` on the accepted false positive), fail-open reasoning (`src/claude/hook.ts:156-158`), back-compat tag names (`src/think/graph.ts:177`).
- Mark test seams inline: `/** Test seam for git remote/branch resolution; default reads the real repo at cwd. */` (`src/claude/hook.ts:49`), `/** Test seam: runs \`cmd\` with \`env\`, resolves with the exit code. */` (`src/grok/auth.ts:142`).
- No `TODO`/`FIXME`/`HACK` markers exist; do not add them — open a concern in `.planning/codebase/CONCERNS.md` or a tracked issue instead.
- Single-line `/** … */` on interface fields that carry units, defaults, or semantics: `/** Per-call timeout in ms. 0 = no timer. */` (`src/grok/types.ts:24`), `/** Epoch milliseconds. */` (`src/grok/auth.ts:17`), `/** Set true once ultrathink-kickoff has run … */` (`src/claude/state.ts:30`).
- Single-line `/** … */` on exported functions whose contract is non-obvious: `/** Fail-open: returns [] on any failure except an abort, which is rethrown. */` (`src/hitl/pipeline.ts:158`), `/** Safe to print: never contains the token. */` (`src/grok/auth.ts:25`).
- No `@param`/`@returns` tags; the signature is the documentation. Describe behaviour in prose.
- Regex constants get a one-line doc with an example of what they match (`src/track/plan.ts:46-49`).

## Function Design

- One or two positional params for pure helpers (`escapeXml(value)`, `extractTag(xml, tag)`).
- A single named options object (`opts`/`input`/`deps`) once there are more than two inputs or any are optional: `runThink(opts: RunThinkOptions)`, `buildTrackPlan(input: {...})`, `runPromptSubmit(input, deps)`.
- Inject every side effect through the options object with a production default so tests need no module mocking: `complete`, `signal`, `now`, `log`, `git`, `conversation`, `clarify`, `fetch`, `refresh`, `spawn`, `run`, `env`. Defaults are applied at the top of the function: `const now = deps.now ?? Date.now;` (`src/claude/hook.ts:67`), `run: Run = defaultRun` (`scripts/setup.ts:89`), `env: Record<string, string | undefined> = process.env` (`src/config.ts:251`).
- Environment access always goes through an `env` parameter defaulting to `process.env`; never read `process.env` inside a helper that could be unit-tested (`defaultStateDir`, `claudeConfigPaths`, `grokHome`, `claudeMdPath`, `isChildInvocation`).
- Trim string inputs at the boundary: `opts.bin?.trim() || "claude"`, `input.cwd?.trim() || process.cwd()`.
- Return plain objects or discriminated unions; never throw for expected outcomes. `decideUplift` returns `{ action: "skip" | "passthrough" | "uplift" }`; `runPromptSubmit` returns `{ output?, record?, skipped? }`; `selectEngine` returns `Engine | { skipped: string }`.
- `undefined` (not `null`) for "not found": `readSession`, `parseRepoSlug`, `resolveBranch`, `extractPrFromOutput`. `null` appears only where a JSON parse result is being signalled (`extractJsonObject`, `sanitizeUpliftXml`).
- Pure functions return new values and never mutate inputs; say so in the doc comment when it matters (`applyAnswers`: "Returns a new list (input untouched)", `src/hitl/answers.ts:66-69`). The one intentional mutation, `decideUplift` clearing `state.skipOnce`, is covered by a test (`src/uplift/detect.test.ts:162`).
- Build strings with `[...].join("\n")` arrays rather than concatenation, for XML and multi-line text (`src/think/graph.ts:192-199`, `src/uplift/fallback.ts:4-15`, `src/hitl/format.ts:11-26`).
- Truncation helpers append an explicit marker so consumers can tell content was cut (`TRUNCATION_MARKER` in `src/track/plan.ts:14`, `<!-- truncated by Prompt Uplift … -->` in `src/claude/output.ts:48`).

## Module Design

- Named exports only; no `export default` anywhere.
- Export what tests need, even if only tests import it (`buildClaudeArgs`, `parseClaudeJson`, `truncateXml`, `splitRationaleSteps`, `normalizeClarifications`, `MAX_UPLIFTED_PROMPT_CHARS`). Keep purely internal helpers (`asString`, `nodeXml`, `lineMarkers`, `scratchDir`) unexported.
- Export a `DEFAULT_<THING>_CONFIG` constant next to each config interface (`src/config.ts:34`, `src/grok/types.ts:30`, `src/hitl/types.ts:27`) and spread it in `defaultConfig()` so the object is fresh per call.
- Limits live as exported constants in `types.ts` and are referenced from prompts and tests so they cannot drift (`MIN_STEPS`/`MAX_STEPS`/`MAX_RATIONALE_CHARS` in `src/think/types.ts` → `src/think/prompts.ts` → asserted in `src/think/prompts.test.ts`).
- `src/types.ts` and `src/*/types.ts` depend on nothing (except each other's types).
- Pure helpers (`src/uplift/xml.ts`, `src/think/graph.ts`, `src/hitl/format.ts`, `src/track/plan.ts`, `src/track/pr-detect.ts`) depend only on types and other pure helpers.
- Pipelines (`src/uplift/run.ts`, `src/think/pipeline.ts`, `src/hitl/pipeline.ts`) take a `Completer` and never import `src/claude/complete.ts` or `src/grok/complete.ts`.
- `src/claude/hook.ts` is the only orchestrator; `hooks/*.ts` and `scripts/setup.ts` are thin I/O shells that parse stdin/argv, resolve config/state, and call into `src/`. Put logic in `src/`, not in `hooks/`.
- Duplicate a 5-line helper (`isAbortError`, `asString`, `readJson`) per module rather than creating a shared `utils.ts`; the codebase prefers module locality over a grab-bag.
- Any code that spawns a child `claude` must set `ULTRATHINK_CHILD=1` (`CHILD_ENV`) and every hook must early-return on `isChildInvocation()` to prevent recursion (`src/claude/complete.ts:10-29`, `hooks/*.ts` first line of `main`).
- Child completions run with tools, setting sources, and session persistence disabled (`buildClaudeArgs`, `CLI_DISALLOWED_TOOLS`); keep any new engine equally sandboxed.

## Commit Messages

- Conventional Commits with an optional scope: `feat(hooks): …`, `fix: …`, `docs(skill): …`, `feat(setup): …`. Scopes in use: `hooks`, `skills`, `claude`, `setup`, `skill`.
- Subject is imperative, lowercase after the type, and states the behaviour change ("detect PR creation via `gh pr create`, not just an MCP tool name").

<!-- GSD:conventions-end -->

<!-- GSD:architecture-start source:ARCHITECTURE.md -->

## Architecture

## System Overview

```text

```

## Component Responsibilities

| Component | Responsibility | File |
|-----------|----------------|------|
| Uplift hook entry | Parse stdin hook JSON, select engine, run orchestrator, emit hook JSON; `--ctl` control CLI | `hooks/uplift.ts` |
| Answers hook | Fold `AskUserQuestion` tool responses back into session clarifications and spec XML | `hooks/answers.ts` |
| PR-sync hook | Detect `gh pr create` / PR MCP tool, nudge agent to run `ultrathink-sync` | `hooks/pr-sync.ts` |
| Stop hook | Nudge agent to run `ultrathink-sync` at turn end if a plan exists | `hooks/stop.ts` |
| Hook registration | Maps Claude Code events to hook scripts, timeouts, matchers | `hooks/hooks.json` |
| Orchestrator | One `UserPromptSubmit` event: decide → uplift → think → clarify → plan → persist → format | `src/claude/hook.ts` |
| Output formatter | Build `additionalContext` block and one-line `systemMessage` summary; truncation budget | `src/claude/output.ts` |
| Session/control state | Read/write `control.json`, `sessions/<id>.json`, `last.json` under `~/.claude/ultrathink` | `src/claude/state.ts` |
| Claude engine | Headless `claude -p` completer; `ULTRATHINK_CHILD` recursion guard | `src/claude/complete.ts` |
| Transcript reader | Extract recent user/assistant turns from JSONL transcript for context | `src/claude/transcript.ts` |
| Grok engine | Optional `/responses` HTTP or CLI transport completer; OAuth session reuse | `src/grok/complete.ts`, `src/grok/auth.ts` |
| Config loader | Defaults + validated merge of `~/.claude/ultrathink.json` and `<cwd>/.claude/ultrathink.json` | `src/config.ts` |
| Uplift decision | Skip/passthrough/uplift gate (slash commands, trivial, already-uplifted, `raw:`/`uplift:` prefixes) | `src/uplift/detect.ts` |
| Uplift run | Call engine with `UPLIFT_SYSTEM_PROMPT`, sanitize XML, fallback | `src/uplift/run.ts`, `src/uplift/xml.ts`, `src/uplift/fallback.ts` |
| Graph of Thought | Build DAG JSON, normalize, topo-sort, fill each node (rationale/conclusion), inject `<GRAPH_OF_THOUGHT>` | `src/think/pipeline.ts`, `src/think/graph.ts` |
| HITL clarify | Ask engine for ≤4 clarifying questions, normalize, dedupe against answered | `src/hitl/pipeline.ts` |
| HITL format/answers | `<CLARIFICATIONS>` XML injection, markdown addendum, answer folding | `src/hitl/format.ts`, `src/hitl/answers.ts` |
| Track plan | Build `TrackPlan` (Task/Issue/Sub-Issue rows + Linear mirrors) from uplift+graph+clarifications | `src/track/plan.ts` |
| Git context | Resolve `owner/repo` slug and current branch via `git` subprocess | `src/track/git.ts` |
| PR detection | Pure regex detection of `gh pr create` and `github.com/.../pull/N` URLs | `src/track/pr-detect.ts` |
| Kickoff skill | Agent-side: find-or-create Notion/Linear rows by `Graph ID`, resolve blocking HITL, emit final prompt | `skills/ultrathink-kickoff/SKILL.md` |
| Sync skill | Agent-side: update PR/status fields on existing Task row and Linear issue | `skills/ultrathink-sync/SKILL.md` |
| Setup script | Idempotent `apply`/`status`/`rollback` of MCP servers, plugin install, global `CLAUDE.md` block | `scripts/setup.ts` |

## Pattern Overview

- **Hooks cannot call MCP tools.** Every Notion/Linear write is delegated to the agent by emitting `additionalContext` instructing it to invoke `ultrathink-kickoff` with a `stateFile=` path (`src/claude/output.ts:777-785`). Hooks only read/write local JSON.
- **Fail-open everywhere after "decide".** Every stage is wrapped in try/catch; failure logs and degrades (fallback XML, `FALLBACK_GRAPH`, empty clarifications, no plan) but never blocks the user's prompt. All hook entrypoints end with `main().catch(() => process.exit(0))`.
- **Injectable `Completer` seam.** Every LLM-calling stage takes `complete: (system, user, signal) => Promise<string>` as a parameter (`src/uplift/run.ts:178`, `src/think/pipeline.ts:621`, `src/hitl/pipeline.ts:288`). Engines (`src/claude/complete.ts`, `src/grok/complete.ts`) are selected once in `hooks/uplift.ts:381` and never imported by pipeline modules.
- **Pure core, I/O at the edges.** `src/uplift/`, `src/think/`, `src/hitl/`, `src/track/plan.ts`, `src/track/pr-detect.ts` are pure functions over strings/objects. Process spawning lives only in `src/claude/complete.ts`, `src/grok/complete.ts`, `src/track/git.ts`, `scripts/setup.ts`. File I/O lives only in `src/claude/state.ts`, `src/config.ts`, `src/claude/transcript.ts`, `src/grok/auth.ts`, and the hook entrypoints.
- **Idempotency by `Graph ID`.** `src/track/plan.ts:579` generates `ut-<base36 time>-<uuid8>`; skills find-or-update rows by this key, never duplicate.
- **Strict DAG of module dependencies:** `src/types.ts` ← `src/uplift/` ← `src/think/` ← `src/hitl/` ← `src/track/` ← `src/claude/` ← `hooks/`. `src/grok/` is a leaf imported only by `src/config.ts` and `hooks/uplift.ts`.

## Layers

- Purpose: Adapt Claude Code's stdin/stdout hook protocol to the orchestrator; never throw.
- Location: `hooks/uplift.ts`, `hooks/answers.ts`, `hooks/pr-sync.ts`, `hooks/stop.ts`, registered in `hooks/hooks.json`
- Contains: stdin parsing, `isChildInvocation()` guard, engine selection, `--ctl` CLI, JSON output to stdout
- Depends on: `src/claude/*`, `src/config.ts`, `src/grok/*`, `src/hitl/*`, `src/think/graph.ts`, `src/track/pr-detect.ts`, `src/uplift/detect.ts`
- Used by: Claude Code host process
- Purpose: Sequence the pipeline for one prompt; own on-disk state and output formatting.
- Location: `src/claude/hook.ts` (`runPromptSubmit`), `src/claude/output.ts`, `src/claude/state.ts`, `src/claude/transcript.ts`, `src/claude/complete.ts`
- Contains: `HookDeps` dependency-injection interface, `SessionRecord`/`ControlState` types, context truncation, Claude `-p` completer
- Depends on: all pipeline stages, `src/config.ts`
- Used by: `hooks/*`
- Purpose: Each stage transforms an `UpliftResult` (+ graph, + clarifications) toward a `TrackPlan`.
- Location: `src/<stage>/pipeline.ts` or `run.ts` is the entry; `types.ts` holds the stage's data model and constants; `prompts.ts` holds system prompts.
- Contains: pure normalization/parsing (`normalizeGraph`, `normalizeClarifications`, `sanitizeUpliftXml`, `splitRationaleSteps`), XML injection helpers, prompt text
- Depends on: `src/types.ts`, earlier stages only (see DAG above)
- Used by: `src/claude/hook.ts`
- Purpose: Implement the `Completer` signature over a real LLM.
- Contains: process spawning (`Bun.spawn`), HTTP fetch, OAuth token reading/redaction, JSON response parsing
- Depends on: nothing in the pipeline (`src/grok/*` imports only itself)
- Used by: `hooks/uplift.ts` (selection), `src/config.ts` (`GrokConfig` type)
- Purpose: Markdown instructions executed by the agent inside its own turn; the only layer that touches Notion/Linear.
- Location: `skills/ultrathink-kickoff/SKILL.md`, `skills/ultrathink-sync/SKILL.md`
- Depends on: the `SessionRecord` JSON shape from `src/claude/state.ts` (documented inline in the kickoff skill)
- Used by: the agent, when nudged by hook `additionalContext`/`systemMessage`
- Purpose: Install-time wiring — MCP servers, plugin marketplace, global `CLAUDE.md` contract block between `<!-- ultrathink:start/end -->` markers.
- Depends on: `claude` CLI via injectable `Run` seam

## Data Flow

### Primary Request Path (UserPromptSubmit)

### HITL Answer Fold-back (PostToolUse: AskUserQuestion)

### PR Sync Nudge (PostToolUse: Bash | PR MCP tool; Stop)

### Control CLI (`bun hooks/uplift.ts --ctl …`)

- All state is on disk under `defaultStateDir()` = `$ULTRATHINK_STATE_DIR` || `$CLAUDE_CONFIG_DIR/ultrathink` || `~/.claude/ultrathink` (`src/claude/state.ts:515`).
- `control.json` — machine-wide toggles (`enabled`, `skipOnce`, `thinkEnabled`, `hitlEnabled`, `engine`); overrides config file values.
- `sessions/<sessionId>.json` — `SessionRecord` (result, graph, clarifications, plan, `kickedOff`, `synced`); `sessions/<sessionId>.xml` — full spec.
- `last.json` — copy of the most recent `SessionRecord` for `--ctl last`.
- Hooks are one-shot processes; no in-memory state survives between events.

## Key Abstractions

- Purpose: The single LLM seam — `(system: string, user: string, signal?: AbortSignal) => Promise<string>`.
- Examples: `src/claude/complete.ts:612`, `src/grok/complete.ts:25`, `src/hitl/pipeline.ts:288`
- Pattern: Created once by a factory (`createClaudeCompleter`, `createGrokCompleter`), wrapped by `captureFirstError()` in `hooks/uplift.ts:351`, passed down through every stage. Tests supply a fake.
- Purpose: The accumulating artifact — `{ xml, original, root, source }`. Each stage returns a new copy with more XML injected into `xml`.
- Examples: `src/types.ts:12`, `src/think/pipeline.ts:615` (`ThinkResult extends UpliftResult`)
- Pattern: Immutable spread (`{ ...result, xml: … }`); `source: "fallback"` propagates to suppress tracking.
- Purpose: DAG of reasoning nodes with `dependsOn`, filled with `thinking` (numbered rationale) and `conclusion`.
- Examples: `src/think/types.ts:291-304`, `FALLBACK_GRAPH` at `src/think/types.ts:313`
- Pattern: `normalizeGraph()` is the only constructor from untrusted JSON; `topoSort()`, `dependencyLevels()`, `workflowWaves()` derive execution order.
- Purpose: One HITL question with `options`, `default`, `blocking`, and optional `answer`/`source`.
- Examples: `src/hitl/types.ts:7`
- Pattern: Identity is `normalizeQuestion(question)` (`src/hitl/pipeline.ts:314`), used for dedupe and answer matching.
- Purpose: The exact Notion rows and Linear issues the kickoff skill must create, pre-computed so the skill does no string processing.
- Examples: `src/track/types.ts:547`, built by `src/track/plan.ts:695`
- Pattern: One `IssueRow` per node; one `SubIssueRow` per numbered rationale step via `splitRationaleSteps()`; `linearIssues`/`linearSubIssues` mirror by `nodeId` (+ `step`).
- Purpose: The contract between hook processes and the skills — the JSON the kickoff skill reads.
- Examples: `src/claude/state.ts:500`; shape duplicated as documentation in `skills/ultrathink-kickoff/SKILL.md:14-33`
- Pattern: Any change to `SessionRecord`/`TrackPlan` must be mirrored in the skill's inline TypeScript block.
- Purpose: Dependency-injection bag for `runPromptSubmit` — config, control, completer, engine label, state dir, and test seams (`clarify`, `git`, `conversation`, `now`, `log`).
- Examples: `src/claude/hook.ts:303`
- Pattern: Optional fields default to real implementations; tests override.
- Purpose: Fully-defaulted, validated config; each sub-section has a `mergeX()` that type-checks every field individually.
- Examples: `src/config.ts:92`, `defaultConfig()` at `src/config.ts:102`
- Pattern: Never trust file JSON — every field passes a `typeof` guard before overriding the default.

## Entry Points

- Location: `hooks/uplift.ts`
- Triggers: Claude Code `UserPromptSubmit` (via `hooks/hooks.json`); manual `bun hooks/uplift.ts --ctl <scope> <verb>`
- Responsibilities: Guard, config, engine selection, call `runPromptSubmit`, write hook JSON; control CLI
- Location: `hooks/answers.ts`
- Triggers: `PostToolUse` with matcher `AskUserQuestion`
- Responsibilities: Fold answers into session state and spec XML; emit `HITL · N answer(s) recorded`
- Location: `hooks/pr-sync.ts`
- Triggers: `PostToolUse` with matcher `Bash` or PR-creation MCP tool names
- Responsibilities: Detect PR creation; nudge `ultrathink-sync` with `graphId`
- Location: `hooks/stop.ts`
- Triggers: `Stop`
- Responsibilities: Nudge `ultrathink-sync` if a plan exists
- Location: `scripts/setup.ts`
- Triggers: `bun scripts/setup.ts apply|status|rollback`
- Responsibilities: MCP server registration, plugin install, `CLAUDE.md` contract block, setup-state tracking for safe rollback
- Triggers: Agent invocation after hook nudge
- Responsibilities: All Notion/Linear MCP writes

## Architectural Constraints

- **Threading:** Single-threaded Bun processes, one per hook event. Concurrency is only async: `fillLevel()` runs up to `config.claude.concurrency` (default 3) node fills in parallel per dependency level (`src/think/pipeline.ts:704`). Each fill spawns a separate `claude -p` child process.
- **Recursion guard:** `claude -p` children inherit `ULTRATHINK_CHILD=1` (`src/claude/complete.ts:666`); every hook checks `isChildInvocation()` first so nested sessions never re-trigger the pipeline.
- **Hook timeout:** `UserPromptSubmit` is registered with `timeout: 86400` seconds (`hooks/hooks.json:148`, `CLAUDE_USER_PROMPT_HOOK_TIMEOUT_SEC` in `src/config.ts:61`). The host discards stdout if exceeded; `config.claude.budgetMs` provides an optional in-process `AbortController` budget (`src/claude/hook.ts:352-354`).
- **Global state:** None in-process. Module-level constants only (`ROOT_TAGS`, `FALLBACK_GRAPH`, prompt strings, regexes). All mutable state is on disk under the state dir.
- **Circular imports:** None. Verified DAG: `src/types.ts` ← `src/uplift/` ← `src/think/` ← `src/hitl/` ← `src/track/` ← `src/claude/` ← `hooks/`. `src/hitl/answers.ts` imports `normalizeQuestion` from `src/hitl/pipeline.ts` (same module, no cycle).
- **Hooks cannot replace the prompt.** Claude Code 2.1.x only allows `additionalContext`; the spec rides alongside the user's message and must be framed as the user's own elaborated intent (`src/claude/output.ts:712-716`, `UPLIFT_CONTEXT_HEADER`).
- **Hooks cannot call MCP tools.** All Notion/Linear writes are delegated to skills run by the agent.
- **Notion property limits:** `Uplifted Prompt` is truncated to 1900 chars (`MAX_UPLIFTED_PROMPT_CHARS`, `src/track/plan.ts:568`); full XML is always in `sessions/<id>.xml`.
- **Context budget:** `additionalContext` capped at 90k chars (`DEFAULT_CONTEXT_CHARS`, `src/claude/output.ts:726`); `<RATIONALE>` bodies are elided first, then the tail is cut.
- **Secrets:** Grok tokens never leave `src/grok/auth.ts` except in request headers; `redactSecrets()` is applied to every surfaced engine error (`hooks/uplift.ts:359`).
- **`verbatimModuleSyntax` + `.ts` import extensions:** All imports must use explicit `.ts` suffixes and `import type` for type-only imports (`tsconfig.json`).

## Anti-Patterns

### Calling an engine directly from a pipeline stage

### Throwing from a hook entrypoint or letting a stage failure block the prompt

### Calling Notion or Linear from a hook

### Building a `TrackPlan` from fallback output

### Changing `SessionRecord`/`TrackPlan` without updating the kickoff skill

### Trusting parsed JSON/XML from the engine

## Error Handling

- Stage-level: catch everything except `AbortError`, return a fallback artifact (`fallbackResult()` in `src/uplift/run.ts:170`; `FALLBACK_GRAPH` via `normalizeGraph(null, …)` in `src/think/pipeline.ts:683`; `node.thinking = node.question` in `src/think/pipeline.ts:699`; `[]` in `src/hitl/pipeline.ts:448`).
- Orchestrator-level: each stage in its own try/catch; failures logged with `deps.log("<stage> failed: …")` and the pipeline continues with what it has (`src/claude/hook.ts`).
- Engine-level: first error captured and redacted by `captureFirstError()` (`hooks/uplift.ts:351`), surfaced in the `systemMessage` summary as `Engine error · …`.
- Engine selection: Grok-not-logged-in fails visibly with `GROK_LOGIN_REQUIRED` unless `grok.fallbackToClaude` is set (`hooks/uplift.ts:348-349`, `385-388`) — never a silent engine swap.
- Hook-level: `main().catch(() => process.exit(0))` in every hook; stdin parse failures return `{}`/early exit.
- File I/O: `readJson()` helpers return `undefined` on any error (`src/config.ts:129`, `src/claude/state.ts:522`, `src/grok/auth.ts`); `readSetupState()` treats missing state as "nothing added" (`scripts/setup.ts:797`).
- Timeouts: per-call `timeoutMs` kills the child process (`src/claude/complete.ts:678-683`); whole-hook `budgetMs` aborts via `AbortController` (`src/claude/hook.ts:352`).
- Debug logging: `ULTRATHINK_DEBUG=1` enables stderr `[ultrathink] …` lines (`hooks/uplift.ts:320`).

## Cross-Cutting Concerns

<!-- GSD:architecture-end -->

<!-- GSD:skills-start source:skills/ -->

## Project Skills

No project skills found. Add skills to any of: `.hermes/skills/`, `.agents/skills/`, `.cursor/skills/`, `.github/skills/`, or `.codex/skills/` with a `SKILL.md` index file.
<!-- GSD:skills-end -->

<!-- GSD:workflow-start source:GSD defaults -->

## GSD Workflow Enforcement

Before using Edit, Write, or other file-changing tools, start work through a GSD command so planning artifacts and execution context stay in sync.

Use these entry points:

- `/gsd-quick` for small fixes, doc updates, and ad-hoc tasks
- `/gsd-debug` for investigation and bug fixing
- `/gsd-execute-phase` for planned phase work

Do not make direct repo edits outside a GSD workflow unless the user explicitly asks to bypass it.
<!-- GSD:workflow-end -->

<!-- GSD:profile-start -->

## Developer Profile

> Profile not yet configured. Run `/gsd-profile-user` to generate your developer profile.
> This section is managed by `generate-claude-profile` -- do not edit manually.
<!-- GSD:profile-end -->
