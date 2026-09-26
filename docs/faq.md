# FAQ

Short answers to the questions people ask first. Each links to the page with the full story.

- [What does it cost?](#what-does-it-cost)
- [Why is my prompt slower?](#why-is-my-prompt-slower)
- [Do I need Notion or Linear?](#do-i-need-notion-or-linear)
- [Does it run on Windows?](#does-it-run-on-windows)
- [Can I run it next to another planning plugin?](#can-i-run-it-next-to-another-planning-plugin)
- [Why do I see duplicate rows or issues?](#why-do-i-see-duplicate-rows-or-issues)
- [How do I turn it off?](#how-do-i-turn-it-off)
- [Where does it write files?](#where-does-it-write-files)
- [What data leaves my machine?](#what-data-leaves-my-machine)

## What does it cost?

ultrathink itself is free (AGPL-3.0-or-later). The planning runs on your own engine login, so it uses your Claude Code plan or API usage (or your Grok account if you switched engines), the same as any other `claude -p` call.

Each planned prompt makes several engine calls: one to write the spec, one to draft the Graph of Thought, one per node (5 to 8 by default), and one for clarifying questions. The default Claude model is `sonnet` (`claude.model`).

To spend less:

- Short acknowledgements such as "ok" or "thanks" are skipped automatically (`uplift.skipTrivial`).
- Skip prompts that don't need a plan: prefix them with `raw:`, run `/ultrathink-skip` first, or use `/ultrathink-quick <message>`.
- Use fewer nodes: lower `think.minNodes` and `think.maxNodes` together (a `maxNodes` below `minNodes` is ignored), turn off the graph (`bin/ultrathink think off`) or the questions (`bin/ultrathink hitl off`), or pick another `claude.model`.

See [Reduce cost and latency](how-to/reduce-cost-and-latency.md).

## Why is my prompt slower?

Planning takes time: several model calls run before your agent starts, and on a large prompt the whole plan can take minutes. Nodes that don't depend on each other are filled in parallel (`claude.concurrency`, 3 by default). `claude.budgetMs` puts a ceiling on the whole run; 0, the default, means no ceiling.

What you see depends on the host:

- **Claude Code, Grok Build, Muse Code:** the prompt waits until the plan is ready.
- **Omp:** ultrathink waits up to 25 s. If the plan isn't ready by then, your agent starts with a note to only read and investigate, and the plan arrives as an aside message when it is done.
- **Hermes Agent:** the plan must finish inside Hermes' hook cap. With the default 30 s cap nothing is planned; set `plugins.hook_callback_timeout` to 600 as described in [Architecture](architecture.md#hermes-hook-cap).

For prompts that don't need planning, the skip options above cost nothing. More in [Reduce cost and latency](how-to/reduce-cost-and-latency.md) and [Troubleshooting](troubleshooting.md).

## Do I need Notion or Linear?

No. Planning works without either. Tracking is on only once you set `notion.dataSourceUrl` or `linear.team` and log in with `ultrathink-mcp auth login`. Until then, `bin/ultrathink status` shows `Tracking: on (not configured: set notion.dataSourceUrl / linear.team)` and no rows are created anywhere.

You can use one without the other. To set them up, see [Set up Notion](how-to/set-up-notion.md), [Set up Linear](how-to/set-up-linear.md) and [Tracking](tracking.md).

## Does it run on Windows?

Only through WSL. ultrathink supports Linux and macOS; its hook launchers are POSIX shell scripts and it needs Bun 1.2 or later. On Windows, install the host agent, Bun and the ultrathink clone inside the same WSL distribution and run the host from there. See [Install](install.md).

## Can I run it next to another planning plugin?

Don't let two planners plan the same prompt. Each one adds its own plan to the context, and the agent gets two sets of instructions. Disable any other prompt-planning plugin on a host where ultrathink is installed; the Hermes setup output says the same.

ultrathink already protects itself from planning twice:

- A prompt that is already an ultrathink spec, or that refers to an existing plan as `graph ut-<id>-<8 hex>` (as dispatched workers and Linear issue footers do), is not planned again.
- Processes ultrathink starts itself (`ULTRATHINK_CHILD=1`) and subagent sessions are not planned.
- On Grok Build, a per-turn claim stops the same turn from being planned twice if Grok ever runs both the global hook and the plugin hook.

## Why do I see duplicate rows or issues?

Every planned prompt is a new plan with a new Graph ID, and a new plan gets its own Task, Issues and Sub-Issues. Sending the same request twice, or re-sending it after an edit, therefore creates a second set. On Omp, an identical resend is planned again on purpose.

Within one plan, rows are not duplicated: the planner creates each row once and records it in the session, and `ultrathink-mcp track complete` (run by `ultrathink-kickoff`) looks up the rows already recorded for that Graph ID and creates only the missing ones. On Hermes, rows are created only by `ultrathink-kickoff`, so a hook that Hermes cuts short leaves nothing behind.

To avoid extra plans for follow-ups, prefix them with `raw:` or run `/ultrathink-skip`. To keep planning but stop creating rows, run `/ultrathink-track off`. See [Tracking](tracking.md).

## How do I turn it off?

| For | Do this |
|---|---|
| One prompt | Prefix it with `raw:`, or run `/ultrathink-skip` first |
| This host, until you turn it back on | `/ultrathink-off`, then `/ultrathink-on` |
| One shell or process | `ULTRATHINK_UPLIFT=0` |
| Tracker rows only | `/ultrathink-track off` |
| The ship flow | It is off unless you set `ship.enabled`; `ULTRATHINK_SHIP=0` also turns it off |
| Everything | [Uninstall](how-to/uninstall.md) |

Full list in [Commands](commands.md) and [Privacy and data flow](privacy.md#turning-things-off).

## Where does it write files?

Never into your repository's working tree, and never into `.planning/`.

- **State directory**, per host: session records, specs, toggles and the plan carrier. For example `~/.claude/ultrathink` on Claude Code. The full table is in [Architecture](architecture.md#state-directory). `ULTRATHINK_STATE_DIR` moves it, unless it points into `.planning/`.
- **Credential store**: `${XDG_CONFIG_HOME:-~/.config}/ultrathink/mcp-credentials.json`, mode 0600.
- **Config files you create**: `${XDG_CONFIG_HOME:-~/.config}/ultrathink/config.json`, `~/.claude/ultrathink.json` and `<project>/.claude/ultrathink.json`. `ultrathink-mcp notion init --write-config` writes the first one for you.
- **`bun scripts/setup.ts apply`** writes the Grok hook file and rule under `${GROK_HOME:-~/.grok}/hooks/` and `rules/`. When the `claude` CLI is present, it also adds `notion` and `linear` MCP servers to Claude Code's user config if they are missing, installs the plugin, and writes an ultrathink block in `~/.claude/CLAUDE.md` plus `~/.claude/ultrathink-setup-state.json`. `bun scripts/setup.ts rollback` removes the hook file, the rule block, the CLAUDE.md block, the MCP servers it added and the state file, and prints the plugin uninstall commands for you to run.
- **`bun scripts/mcp-register.ts`** edits each host's MCP config and keeps a backup of every file it changes (`*.bak-ultrathink-mcp-<timestamp>`).

## What data leaves my machine?

Only what goes to services you set up. On a fresh install that is your prompt, a short excerpt of recent conversation and, when you invoke a skill, a short summary from its skill file, sent to the planning engine through your own `claude` login. ultrathink itself contacts Notion, Linear, Greptile, GitHub, Agent Substrate and Tailscale only after you configure them. `bun scripts/setup.ts apply` does add the hosted Notion and Linear MCP servers to Claude Code, which then connects to them itself. There is no telemetry.

The full table, with what each destination receives and how to turn it off, is in [Privacy and data flow](privacy.md).
