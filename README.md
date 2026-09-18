# ultrathink

Claude Code plugin. Every prompt gets **Prompt Uplift** (rewritten into a
nested XML spec), a **Graph of Thought** (3–8 nodes) with per-node **Chain of
Thought**, and **HITL clarifications** — then the whole graph is tracked live
in the **🧩 Agent Task Graph** Notion database and the **Spectrum Web Co**
Linear team, before the agent does any real work.

Forked from [`omp-all-in-one`](https://github.com/swcstudiospace/plugin)'s
Claude Code pipeline, stripped of everything specific to that plugin (omp/pi
TUI chrome, Tissue/ktui issue tracking, AgentSwarm, the Grok Haiku-tier proxy,
GitHub/Greptile/Supabase/LSP/Pod integrations) and re-pointed at Notion +
Linear via two skills instead of local markdown files.

## Install

```bash
cd ~/src/repos/claude-ultrathink
bun install
bun scripts/setup.ts apply
```

`apply` is idempotent and safe to re-run:

1. `claude mcp add --transport http --scope user notion https://mcp.notion.com/mcp`
2. `claude mcp add --transport http --scope user linear https://mcp.linear.app/mcp`
3. `claude plugin marketplace add ~/src/repos/claude-ultrathink` + `claude plugin install ultrathink@ultrathink`
4. Merges the Agent Command Center contract into your **global** `~/.claude/CLAUDE.md` (between `<!-- ultrathink:start -->`/`<!-- ultrathink:end -->` markers) — every project on this machine picks it up.

After `apply`, run `/mcp` in a Claude Code session and confirm both `notion` and `linear` show as connected (first use triggers their OAuth flow).

`bun scripts/setup.ts status` reports what's configured. `bun scripts/setup.ts rollback` reverts the CLAUDE.md block and removes both MCP servers.

## How it works

1. **`hooks/uplift.ts`** (`UserPromptSubmit`) — skips slash commands, trivial acknowledgements (`ok`, `lgtm`, …), already-uplifted XML, and child-session invocations. Otherwise: calls the configured engine (Claude by default, Grok optional) for the uplift XML, Graph of Thought, per-node Chain of Thought, and HITL questions; builds a `TrackPlan` (`src/track/plan.ts`) of the exact Notion/Linear rows to create; persists it to `~/.claude/ultrathink/sessions/<sessionId>.json`; and tells the agent to invoke `ultrathink-kickoff` before starting work.
2. **`ultrathink-kickoff` skill** — runs inside the agent's own turn (hooks cannot call MCP tools; only the agent can). Finds-or-creates the Task row (keyed by a generated `Graph ID`), creates one Linear issue + Notion Issue row per graph node, one Linear sub-issue + Notion Sub-Issue row per node's Chain-of-Thought fill, resolves HITL clarifications (blocking ones via one `AskUserQuestion` call), then hands back the final prompt with an `<ISSUES>` cross-reference block.
3. From there, it's just Claude Code: the agent dispatches the graph's parallel waves as `Task` subagents, invokes whatever other skills/plugins the work needs, writes the code.
4. **`hooks/pr-sync.ts`** (`PostToolUse` on a PR-creation tool) and **`hooks/stop.ts`** (`Stop`) nudge the agent to invoke **`ultrathink-sync`** — which updates the already-created Task row's PR URL/number/branch/checks/reviewers and status, mirroring the same transition onto the Linear issue. Neither hook writes to Notion/Linear itself.
5. **`hooks/answers.ts`** (`PostToolUse` on `AskUserQuestion`) folds the user's answers back into the session state so a re-entrant turn never re-asks.

Everything is fail-open: an engine failure, missing MCP connection, or tool error inside a skill never blocks the user's prompt — worst case, a turn proceeds untracked with a conservative XML fallback.

## Config

`~/.claude/ultrathink.json`, project override at `<project>/.claude/ultrathink.json` (later wins):

```json
{
  "think": { "minNodes": 3, "maxNodes": 8, "engine": "claude" },
  "hitl": { "maxQuestions": 4 },
  "notion": { "dataSourceUrl": "collection://be3418f0-d2d8-411b-8677-fa8a95ee63be" },
  "linear": { "team": "Spectrum Web Co" }
}
```

`think.engine: "grok"` switches Stage 1 to Grok 4.6 (reuses your existing `grok login` session via `src/grok/`); `grok.fallbackToClaude: true` opts into silently falling back to Claude when Grok isn't logged in (off by default — a missing Grok login fails visibly instead).

## Commands

```bash
bun hooks/uplift.ts --ctl status          # full status: uplift/think/hitl/engine/Notion/Linear/state dir
bun hooks/uplift.ts --ctl on|off          # toggle Prompt Uplift for this machine
bun hooks/uplift.ts --ctl skip            # skip the next prompt only
bun hooks/uplift.ts --ctl last            # show the last uplifted XML
bun hooks/uplift.ts --ctl think on|off|last
bun hooks/uplift.ts --ctl hitl on|off|last
bun hooks/uplift.ts --ctl grok engine grok|claude
bun hooks/uplift.ts --ctl grok            # engine + SuperGrok OAuth status
```

Prefix a prompt with `raw:` to send it unchanged; `uplift:` to force uplift even when disabled. Set `ULTRATHINK_UPLIFT=0` in the environment to skip the pre-pass for a whole process (automation, `claude -p` runners).

## Verify

```bash
cd ~/src/repos/claude-ultrathink
bun install
bun test
bun run check
```

1. Start a new Claude Code session with this plugin installed. Type a one-line feature request.
2. The transcript should show a `Prompt Uplift · …` summary and the agent should invoke `ultrathink-kickoff` before writing any code.
3. Check the "🧩 Agent Task Graph" Notion database — a new Task row should appear, with one Issue row per graph node nested under it via `Parent Item`, and matching issues in the Spectrum Web Co Linear team.
4. `raw: do this exactly` should reach the agent un-uplifted and untracked.
