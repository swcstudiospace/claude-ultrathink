# FAQ

Short answers to the questions people ask first. Each links to the page with the full story.

- [What does it cost?](#what-does-it-cost)
- [Why is my prompt slower?](#why-is-my-prompt-slower)
- [Which model plans my prompt?](#which-model-plans-my-prompt)
- [Do I need Notion or Linear?](#do-i-need-notion-or-linear)
- [Does it run on Windows?](#does-it-run-on-windows)
- [Can I run it next to another planning plugin?](#can-i-run-it-next-to-another-planning-plugin)
- [Why do I see duplicate rows or issues?](#why-do-i-see-duplicate-rows-or-issues)
- [How do I turn it off?](#how-do-i-turn-it-off)
- [Where does it write files?](#where-does-it-write-files)
- [What data leaves my machine?](#what-data-leaves-my-machine)
- [Is Teachable Moments on by default?](#is-teachable-moments-on-by-default)
- [Where do lessons live?](#where-do-lessons-live)
- [Can a project file turn lessons on?](#can-a-project-file-turn-lessons-on)
- [What if Hindsight is down?](#what-if-hindsight-is-down)
- [Does Hermes install skills by itself?](#does-hermes-install-skills-by-itself)

## What does it cost?

ultrathink itself is free (AGPL-3.0-or-later). The planning runs on your own engine login, so it uses your Claude Code plan or API usage (or your Grok account if you switched engines), the same as any other `claude -p` call. On Omp it runs on the session's own model and counts against that provider account, like the rest of the session.

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
- **Omp:** ultrathink waits up to 25 s. If the plan isn't ready by then, your agent starts with a note to only read and investigate, and the plan arrives as an aside message when it is done. Planning on the session's own model can take several minutes on reasoning-heavy models. A plan is dropped, not delivered, when you send a newer prompt, switch the session's model, switch sessions or end the session first; in print mode (`omp -p`), keep the run going until the aside lands.
- **Hermes Agent:** the plan must finish inside Hermes' hook cap. With the default 30 s cap nothing is planned; set `plugins.hook_callback_timeout` to 600 as described in [Architecture](architecture.md#hermes-hook-cap).

For prompts that don't need planning, the skip options above cost nothing. More in [Reduce cost and latency](how-to/reduce-cost-and-latency.md) and [Troubleshooting](troubleshooting.md).

## Which model plans my prompt?

Each host's own engine, unless you name one with `think.engine`:

- **Omp:** the session's own model, called inside Omp with Omp's own provider and login. No extra login is needed and ultrathink copies no credential. `models.hosts.omp` can name another model or provider; see [`models`](configuration.md#models-planning-model-selection).
- **Claude Code, Grok Build, Muse Code:** Claude, Grok or Muse on their CLI routes, with the built-in models `sonnet`, `grok-4.7` and `muse-spark-1.3-contributor` unless you set `claude.model`, `grok.model` or `muse.model`. A blank `claude.model` or `muse.model` lets the CLI pick its own default. See [Route defaults](configuration.md#route-defaults).
- **Hermes Agent:** the Claude, Grok or Muse route that matches the session model's family, Claude when the family is unknown.

The summary line, the plan and `bin/ultrathink status` (`Last planned resolution:`) say which model planned and why: `detected`, `default`, `override` or `unresolved`. When no model can be used, the prompt goes through unplanned and the reason is shown; nothing is blocked. The six `/ultrathink-*` commands work the same on every host. See [Planning model states](how-to/choose-engine.md#planning-model-states).

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
| Jev decisions | They are always on; set `ULTRATHINK_DECISIONS=0` or remove the keys (see [Use Jev decisions](how-to/use-jev-decisions.md#turn-it-off-again)) |
| Teachable Moments | On by default; set `teach.enabled: false` to turn it off. `ULTRATHINK_TEACH=0` turns it off for that process (see [Use Teachable Moments](how-to/use-teachable-moments.md#turn-it-off-again)) |
| Hindsight | Off unless you set `hindsight.enabled`. `ULTRATHINK_HINDSIGHT=0` turns it off for that process |
| RAGFlow | Off unless you set `ragflow.enabled`. `ULTRATHINK_RAGFLOW=0` turns it off for that process |
| Everything | [Uninstall](how-to/uninstall.md) |

Full list in [Commands](commands.md) and [Privacy and data flow](privacy.md#turning-things-off).

## Where does it write files?

Never into your repository's working tree, and never into `.planning/`.

- **State directory**, per host: session records, specs, toggles and the plan carrier. For example `~/.claude/ultrathink` on Claude Code. The full table is in [Architecture](architecture.md#state-directory). `ULTRATHINK_STATE_DIR` moves it, unless it points into `.planning/`.
- **Lessons**: `<state dir>/teach/` (moments, the Hindsight outbox, the observe inbox and skill drafts). Same state directory as above, never the repository and never `.planning/`.
- **Credential store**: `${XDG_CONFIG_HOME:-~/.config}/ultrathink/mcp-credentials.json`, mode 0600.
- **Config files you create**: `${XDG_CONFIG_HOME:-~/.config}/ultrathink/config.json`, `~/.claude/ultrathink.json` and `<project>/.claude/ultrathink.json`. `ultrathink-mcp notion init --write-config` writes the first one for you.
- **`bun scripts/setup.ts apply`** writes the Grok hook file and rule under `${GROK_HOME:-~/.grok}/hooks/` and `rules/`. When the `claude` CLI is present, it also adds `notion` and `linear` MCP servers to Claude Code's user config if they are missing, installs the plugin, and writes an ultrathink block in `~/.claude/CLAUDE.md` plus `~/.claude/ultrathink-setup-state.json`. `bun scripts/setup.ts rollback` removes the hook file, the rule block, the CLAUDE.md block, the MCP servers it added and the state file, and prints the plugin uninstall commands for you to run.
- **`bun scripts/mcp-register.ts`** edits each host's MCP config and keeps a backup of every file it changes (`*.bak-ultrathink-mcp-<timestamp>`).

## What data leaves my machine?

Only what goes to services you set up. On a fresh install that is your prompt, a short excerpt of recent conversation and, when you invoke a skill, a short summary from its skill file, sent to the planning engine through your own `claude` login (on Omp, to the session's own model through Omp's own login, without the conversation excerpt). ultrathink itself contacts Notion, Linear, Greptile, GitHub, Hindsight (`hindsight.enabled`), RAGFlow (`ragflow.enabled`), Agent Substrate and Tailscale only after you configure them. Jev decisions (OpenRouter or Vercel) are always on but send nothing until you store or set a key. A lesson is redacted before it is stored or sent. `bun scripts/setup.ts apply` does add the hosted Notion and Linear MCP servers to Claude Code, which then connects to them itself. There is no telemetry.

The full table, with what each destination receives and how to turn it off, is in [Privacy and data flow](privacy.md).

## Is Teachable Moments on by default?

Yes. `teach.enabled` defaults to true with `capture: "auto"` and `autoPromote: true`, so a fresh install distills finished turns into lessons, recalls matching lessons and skills into plans, and installs recurring lessons as skills. `hindsight.enabled` and `ragflow.enabled` still default to false, so lessons stay on the local machine and neither server is contacted: `bin/ultrathink status` shows `Hindsight: off (opt-in: set hindsight.enabled)` and `RAGFlow: off (opt-in: set ragflow.enabled)`. Set `teach.enabled: false` to turn lessons off entirely. See [Use Teachable Moments](how-to/use-teachable-moments.md).

## Where do lessons live?

In `<state dir>/teach/`, for example `${CLAUDE_CONFIG_DIR:-~/.claude}/ultrathink/teach` on Claude Code. That directory holds the lesson files, the outbox of pending Hindsight writes, the observe inbox and skill drafts. ultrathink never writes them into the repository and never into `.planning/`. `ULTRATHINK_STATE_DIR` moves the state directory, unless the path points into `.planning/`, in which case it is ignored. A confirmed lesson is also copied to the Hindsight bank (default `ultrathink`) when [Hindsight](how-to/connect-hindsight.md) is ready.

## Can a project file turn lessons on?

No: a project file can only tighten Teachable Moments, never loosen it. `<repo>/.claude/ultrathink.json` can turn `teach`, `hindsight` and `ragflow` off, turn `teach.recall` and `ragflow.ground` off, and lower `teach.capture` (`auto` to `observe` or `explicit`, `observe` to `explicit`). It cannot enable `hindsight` or `ragflow`, set a URL, a bank or a dataset, override an explicit `teach.enabled: false`, or turn `teach.autoPromote` back on. Set those in your user file, `${XDG_CONFIG_HOME:-~/.config}/ultrathink/config.json`.

## What if Hindsight is down?

The lesson stays in `<state dir>/teach`. If the server was ready and the write failed, the retain waits in the outbox and `bin/ultrathink teach sync` retries it (`Sync: 0 done · 1 pending · <reason>` while it cannot, exit 1). If Hindsight was not ready, the lesson is local-only and the next sync sends it once Hindsight is ready. Recall uses this machine's store when the server does not answer. Planning is not blocked. See [When Hindsight is down](how-to/use-teachable-moments.md#6-when-hindsight-is-down).

## Does Hermes install skills by itself?

No. ultrathink never writes `~/.hermes/skills`. Promoting a lesson on Hermes only writes a draft under `<state dir>/teach/skill-drafts/` and tells you to install it through Hermes `skill_manage`, so `skills.write_approval` still applies. `/ultrathink-lessons promote <id>` stages that skill; with write approval on, review it with `/skills pending`, then `/skills approve <id>`. `teach.autoPromote` is user-file only and default off, and even then a Hermes host only gets a draft. See [Teachable Moments on Hermes](how-to/teachable-moments-on-hermes.md).
