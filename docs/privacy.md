# Privacy and data flow

ultrathink has no server of its own. It sends no telemetry, no analytics and no update checks. Data leaves your machine only to services you already use and have set up: the model behind your `claude` (or `grok`) login, and, if you configure them, Notion, Linear, Greptile, GitHub and an Agent Substrate server.

This page lists every destination, what it receives, when, and how to turn it off. It is derived from the code; file names are given so you can check. For the credential store and how to report a vulnerability, see [SECURITY.md](../SECURITY.md). For how the pieces fit together, see [Architecture](architecture.md#services-and-trust-boundaries).

- [What leaves your machine](#what-leaves-your-machine)
- [Details per destination](#details-per-destination)
- [What stays local](#what-stays-local)
- [Turning things off](#turning-things-off)

## What leaves your machine

On a fresh install, only the first row applies: tracking, ship, the Greptile knowledge base, Grok, Agent Substrate and Tailscale are all off until you configure them. Two exceptions reach xAI or the hosted trackers without ultrathink's own tracking: `bin/ultrathink status` may refresh an expired Grok login (see [Planning engine](#planning-engine)), and `bun scripts/setup.ts apply` registers the hosted Notion and Linear MCP servers in Claude Code (see [Claude Code's own MCP entries](#claude-codes-own-mcp-entries)).

| Destination | Data sent | When | How to turn it off |
|---|---|---|---|
| **Planning engine: Anthropic**, through your `claude` CLI (default engine) | Your prompt; up to 3 500 characters of recent conversation; when you invoke a skill, its name and up to 600 characters from its `SKILL.md` or command file; the spec, graph and your earlier clarification answers in the follow-up calls; with `hitl.knowledgeBase` on, up to 24 000 characters of Greptile knowledge-base documents in the clarification call. No source files. | Every prompt that is planned: one spec call, one graph call, one call per node, one clarification call. A prompt over `uplift.maxChars` (20 000) skips only the spec call; the graph, node and clarification calls still send it in full unless you turn them off. | `/ultrathink-off`, `uplift.enabled: false`, `ULTRATHINK_UPLIFT=0`, or a `raw:` prefix or `/ultrathink-skip` for one prompt. `bin/ultrathink think off` and `bin/ultrathink hitl off` drop the graph and clarification calls. |
| **Planning engine: xAI Grok** (opt-in) | The same as above. | When `bin/ultrathink grok engine grok` was run for this host, or, if no engine was set that way, when `think.engine` is `"grok"`. The command's choice beats the config key and is stored per host (set `ULTRATHINK_HOST` to change another host from a shell). | `bin/ultrathink grok engine claude` on each host where you switched, and `think.engine: "claude"`. |
| **Your Anthropic-compatible gateway** (opt-in) | The same as above. | Only with `grok.transport: "shunt"` and `grok.shuntBaseUrl` set. | Unset `grok.shuntBaseUrl` or use another transport. |
| **Notion**, through its hosted MCP server | A Task row per plan (title, your full prompt, the first 1 900 characters of the spec, host id such as `claude-code` or `grok-build`, repository and branch, Graph ID), one row per plan node (title and conclusion), one row per reasoning step (step text). Later the sync skill adds PR URL, number, branch, state, checks and reviewers. | When `notion.dataSourceUrl` is set, you are logged in, and tracking is on: at planning time (on Hermes, when `ultrathink-kickoff` runs), then when a PR is opened or the turn ends. | `/ultrathink-track off` (stops all rows), or leave `notion.dataSourceUrl` empty. |
| **Linear**, through its hosted MCP server | One issue per plan node (title, conclusion, a footer with the Graph ID, `blockedBy` links), one sub-issue per reasoning step (step text). Later the sync skill moves issue states and attaches the PR link. | When `linear.team` is set, you are logged in, and tracking is on. Same timing as Notion. | `/ultrathink-track off`, or leave `linear.team` empty. |
| **Planning engine, again: done check** (ship flow) | Your original prompt, the first 6 000 characters of the spec and of the plan's workflow, the graph goal, the clarifications, a GSD summary when the repository has a GSD roadmap (state status, phase counts, latest verification), git signals (branch, base, repository slug), the diff stat (which names the changed files) and commit log (8 000 characters each) and the patch against the base branch, capped at 24 000 characters (lockfiles excluded). **This is the one place your code goes to the engine.** | When the ship flow runs `assess` and the rule checks pass. | Leave `ship.enabled` off (the default), or set `ULTRATHINK_SHIP=0`. |
| **GitHub**, through your `gh` login and plain `git` with your credentials for `origin` (ship flow) | A fetch of the base branch; a push of your branch; a pull request whose title and body come from the plan (goal or first prompt line, the done-check summary or your full prompt, tracker links, assessment gaps), with local paths scrubbed; a PR comment if the flow stops; the merge, remote branch deletion and `git pull` only if you enabled them. | When the ship flow runs. | Leave `ship.enabled` off; `ship.autoMerge` and `ship.deleteBranch` are off by default too. |
| **Greptile** (ship flow) | PR review: the repository name and PR number through Greptile's hosted MCP server; Greptile then reads the PR itself. CLI review: the `greptile` CLI reviews your local branch against the base, and what it uploads is decided by that CLI. | When the ship flow runs `review`. PR review is used when a Greptile credential is stored and Greptile lists the repository, otherwise CLI review. | Leave `ship.enabled` off. |
| **Greptile knowledge base**, through Greptile's hosted MCP server `https://api.greptile.com/mcp` (opt-in) | Only list and read calls: the organization (`ship.greptileOrganization`, when set), the knowledge-base namespace id, and the document paths to read. **Nothing from your prompt or your code is sent to Greptile.** Greptile returns the list of repositories with a knowledge base, the repository's document paths, and the documents' markdown (`index.md` plus up to 3 more). | Every planned prompt with clarifying questions on, only when `hitl.knowledgeBase` is `true` and a Greptile credential is stored. | Leave `hitl.knowledgeBase` off (the default), or turn clarifying questions off. |
| **Agent Substrate server: brief** (opt-in) | `POST <url>/brief` with repository slug, branch and host id (`claude-code`, `grok-build`, …); bearer token from `SUBSTRATE_TOKEN` if set. | Every planned prompt, only when `substrate.url` or `SUBSTRATE_URL` is set. | Leave both unset, or set `SUBSTRATE_DISABLED=1`. |
| **Agent Substrate server: graph registration** (opt-in) | A `graph_register` call with the Graph ID, the Notion Task page, repository and branch, host id, task status, and for each node and step its Linear issue id, identifier and URL and its Notion page. | When `ultrathink-kickoff` runs and your host has an MCP server named `substrate` with a `graph_register` tool connected (`skills/ultrathink-kickoff/SKILL.md`, step 3). | Don't connect an MCP server named `substrate`. |
| **Tailscale** (opt-in) | Nothing is sent to a third party: `tailscale serve` exposes the local OAuth callback listener on your tailnet (not the public internet) at the path `/ultrathink-oauth`, then removes it. | Only during `ultrathink-mcp auth login` with `--tailscale` or `ULTRATHINK_OAUTH_TAILSCALE=1`, on a remote session. | Don't pass the flag; the default is a `127.0.0.1` callback. |
| **Notion, Linear, Greptile OAuth servers** | Discovery requests, a dynamic client registration (client name `ultrathink`, the callback URL), then the PKCE code exchange and token refreshes. | During `ultrathink-mcp auth login`, and when a token is within 60 s of expiry. | Use an API key (`auth set-key`, Linear and Greptile only), or don't log in. |

## Details per destination

### Planning engine

- The Claude engine runs `claude -p` with `--tools ""` and `--setting-sources ""`, so the child model cannot read files or run commands (`src/claude/complete.ts`). It uses your existing Claude Code login; ultrathink stores no Anthropic key.
- The recent-conversation excerpt comes from the host's transcript file when the host passes one (Claude Code, Grok Build and Muse do; Hermes and Omp don't). It keeps at most 8 user and assistant text messages, 600 characters each, 3 500 characters in total, and leaves out tool calls, tool results and injected system text (`src/claude/transcript.ts`). These limits are fixed.
- The graph and per-node calls get your prompt and the spec, not the conversation. The clarification call gets the spec, the node conclusions, the conversation excerpt and questions you already answered, and, with `hitl.knowledgeBase` on, the knowledge-base documents read (see [Greptile knowledge base](#greptile-knowledge-base)).
- The Grok `http` transport posts to `grok.baseUrl` (default `https://cli-chat-proxy.grok.com/v1`) with the token from your `grok login`. The `cli` transport runs `grok` with tools, web search and subagents disabled, in a private temporary directory that is removed afterwards (`src/grok/complete.ts`).
- The Agent Substrate brief is not sent to the engine. It is added to the context your agent sees.
- When you invoke a skill, the engine gets the skill's name and a summary of up to 600 characters from its `SKILL.md` or command file (frontmatter description, `<objective>` or first paragraph). For a bare invocation with no text, that summary is what gets planned, so it also becomes the Notion Task row's title and description (`src/uplift/skill.ts`).
- `grok.baseUrl` receives your Grok login token. Any config file can set it, including `<project>/.claude/ultrathink.json` in a repository you open, so check a project file before using Grok's `http` transport in an untrusted repository.
- `bin/ultrathink status` (and `/ultrathink-status`) checks your Grok login even when Claude is the engine, unless `grok.transport` is `"shunt"`. If `${GROK_HOME:-~/.grok}/auth.json` (or `grok.home`) holds an expired session with a refresh token, it runs `grok models`, which contacts xAI to refresh it.

### Notion and Linear

- A plan whose spec is the fallback (the spec call failed) is never tracked. If only the graph call fails, a generic 5-node fallback graph is used and is tracked like any other plan.
- A provider that is not configured is never contacted, and a configured provider without a stored credential is skipped (`src/track/gateway.ts`).
- When `ultrathink-mcp track complete` runs for a session that already has tracker rows recorded, it looks them up by Graph ID before creating anything, so it sends a search query too. The planner itself doesn't search.
- `ULTRATHINK_TRACK=0` and `track.enabled: false` stop only the planner's own row creation. `ultrathink-kickoff` can still create the rows when it runs `ultrathink-mcp track complete`. To stop all rows, use `/ultrathink-track off`.
- The MCP gateway (`bin/ultrathink-mcp serve`) also relays calls your agent makes on its own through the registered `notion`, `linear` and `greptile` servers. Those calls are chosen by your agent, not by ultrathink.

### Greptile knowledge base

- The planner finds the knowledge base by the `origin` remote's `owner/repo`, reads `index.md`, then picks up to 3 documents from its routing table that match the request. The matching happens on your machine: the request itself never goes to Greptile.
- The documents read, at most 24 000 characters, go to the planning engine inside the clarification call, marked as untrusted Greptile-synthesized evidence. They are also named (paths only) in the context your agent sees.
- The session record keeps the lookup's outcome, repository, namespace id, version, document paths, digest length and timing, not the document text. A question the documents settled is kept with the clarifications, with its one-sentence answer and the document it cites.
- Without a stored credential nothing is contacted. Each Greptile stage has a 20-second budget, and any failure means the clarification call runs exactly as with the feature off.

### GitHub and pull request bodies

- The pull request title and body are built in `src/ship/pr-body.ts`. Before they are sent, absolute local paths under `/home/`, `/Users/`, `/root/`, `/tmp/`, `/var/` and `/private/`, and Windows drive paths such as `C:\…`, are replaced with `<local path>`, and ASCII control characters are removed.
- Nothing else is redacted from the body. If your prompt contains a secret, it can end up in the PR through the `## Summary` section, so don't paste secrets into prompts you plan to ship.
- Running `bin/ultrathink-ship` by hand does not check `ship.enabled`: that setting decides whether the flow is suggested and started automatically.

### Claude Code's own MCP entries

`bun scripts/setup.ts apply`, when the `claude` CLI is present, adds `notion` (`https://mcp.notion.com/mcp`) and `linear` (`https://mcp.linear.app/mcp`) HTTP MCP servers to Claude Code's user config if servers with those names are missing. Claude Code then connects to them itself, with its own login and outside ultrathink's gateway and credential store. `bun scripts/setup.ts rollback` removes the entries it added. `scripts/mcp-register.ts` is different: its entries run the local gateway.

### Hosts' own traffic

Your coding agent sends the injected plan to its own model provider as part of your conversation, the same way it sends everything else you type. That traffic is between you and your host.

## What stays local

| Where | What | Protection |
|---|---|---|
| Credential store: `${XDG_CONFIG_HOME:-~/.config}/ultrathink/mcp-credentials.json`, or `ULTRATHINK_MCP_STORE` | OAuth tokens and API keys for Notion, Linear and Greptile. | File `0600`, in a directory created with mode `0700` (an existing directory keeps its mode); written atomically; refreshes serialized with a lock. Never printed: `auth status` shows readiness only. |
| State directory (per host; see [Architecture](architecture.md#state-directory)) | `control.json`, `sessions/<id>.json` (your prompt, the spec, graph, clarifications and answers, the knowledge-base lookup, tracker refs, ship state), `sessions/<id>.xml`, `last.json`, `last-plan.json`, `claims/`. | Written with your default file permissions. Never inside your repository, never in `.planning/`. |
| Config files: `${XDG_CONFIG_HOME:-~/.config}/ultrathink/config.json`, `${CLAUDE_CONFIG_DIR:-~/.claude}/ultrathink.json`, `<project>/.claude/ultrathink.json` | Your settings, including tracker ids. | Your default permissions. The project file is in your repository, so don't commit anything you don't want to share. |
| Temporary files | The Grok `cli` transport's prompt file under `$TMPDIR/ultrathink-grok-*`. | Private directory (`0700`), removed after the call and on exit. |

There are no log files. `ULTRATHINK_DEBUG=1` and `ULTRATHINK_MCP_DEBUG=1` print diagnostics to stderr only; the gateway's debug lines never include tokens or request bodies.

## Turning things off

| To stop | Do this |
|---|---|
| All planning, for this host | `/ultrathink-off` (undo with `/ultrathink-on`) |
| Planning for one prompt | Prefix it with `raw:`, or run `/ultrathink-skip` first, or send it with `/ultrathink-quick <message>` |
| Planning in one shell or process | `ULTRATHINK_UPLIFT=0` |
| All Notion and Linear rows | `/ultrathink-track off` |
| Grok | `bin/ultrathink grok engine claude` |
| Ship (push, PR, review, merge) | Leave `ship.enabled` false (the default), or set `ULTRATHINK_SHIP=0` |
| Greptile knowledge-base reads | Leave `hitl.knowledgeBase: false` (the default) |
| Agent Substrate | Leave `substrate.url` and `SUBSTRATE_URL` unset, or set `SUBSTRATE_DISABLED=1`, and don't connect an MCP server named `substrate` |
| A provider's stored credential | `ultrathink-mcp auth logout <provider>`, then revoke the token or key in that provider's settings |
| Everything | Uninstall: see [Uninstall](how-to/uninstall.md) |

The exact effect of each switch and key is in [Commands](commands.md) and [Configuration](configuration.md).
