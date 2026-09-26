# Getting started

This tutorial takes you from nothing to a first planned prompt, and then, if you want it, to a first plan tracked in Notion or Linear. It uses Claude Code as the host; the other hosts differ only in the install step, and [Other hosts](#other-hosts) points you to theirs.

A few terms used throughout:

- **Host**: the coding agent you type into (Claude Code, Grok Build, Hermes Agent, Muse Code or Omp). ultrathink plugs into its prompt hook.
- **Engine**: the model that writes the plan. It runs as a separate headless call, independent of the host. The default engine is Claude, through the `claude` CLI.
- **Spec**: your message rewritten as structured XML. Your own words stay verbatim inside it.
- **Graph of Thought**: the plan itself, 5 to 8 nodes by default with dependencies between them. It ends in a WORKFLOW: waves of work whose units can run in parallel.
- **HITL questions** (human in the loop): up to 4 clarifying questions whose answers would change the work. Blocking ones are asked once, before any code is written.
- **Tracker**: Notion or Linear. Tracking is off until you configure one.
- **MCP gateway**: `bin/ultrathink-mcp`, a small local relay to the hosted Notion, Linear and Greptile MCP servers that keeps their credentials in one store.
- **State directory**: where ultrathink keeps a host's plans and settings, for example `~/.claude/ultrathink` for Claude Code. It never writes planning files into your project.

## 1. Check the prerequisites

| You need | Version | Why |
|---|---|---|
| Linux or macOS | | Windows works only inside WSL |
| [Bun](https://bun.sh) | 1.2 or later | Runs the hooks, the engine and the CLIs |
| `git` | any | To clone the repository |
| The host's CLI | Claude Code for this tutorial (tested with 2.1.278) | ultrathink is a plugin for it |
| The `claude` CLI, logged in | 2.1.278 or later | The default engine runs `claude -p` with that login. It passes `--tools ""`, `--strict-mcp-config` and `--exclude-dynamic-system-prompt-sections`; an older CLI rejects these, so every plan falls back to the minimal spec |

Check them:

```sh
bun --version     # 1.2.0 or later
git --version
claude --version  # 2.1.278 or later
```

If `claude` is installed but not logged in, start it once and log in. Planning with Grok instead is optional; see [Choose the engine](how-to/choose-engine.md).

Bun does not need to be on the `PATH` that your host gives its hooks: `bin/run-bun` tries `$BUN`, then `PATH`, then `$BUN_INSTALL/bin/bun`, `~/.bun/bin/bun`, `/usr/local/bin/bun`, `/opt/homebrew/bin/bun` and `~/.local/share/*/bun/bin/bun`. If it finds no Bun at all, the hooks exit quietly and your prompts go through unplanned.

## 2. Clone the repository

Every host loads ultrathink from one checkout. Pick a permanent place for it; this guide writes its absolute path as `<clone>`.

```sh
git clone https://github.com/swcstudiospace/claude-ultrathink.git <clone>
```

ultrathink has no runtime dependencies, so you do not need `bun install` to use it.

## 3. Install it in Claude Code

```sh
claude plugin marketplace add <clone>
claude plugin install ultrathink@ultrathink
```

This adds your checkout as a plugin marketplace named `ultrathink` and installs the plugin at user scope. Claude Code runs the plugin from a copy in its plugin cache, so after a later `git pull` you also run `claude plugin marketplace update ultrathink` and `claude plugin update ultrathink@ultrathink`.

If you only want Claude Code and no tracking, you can skip the clone and install from GitHub instead: `claude plugin marketplace add swcstudiospace/claude-ultrathink`, then the same `install` line. The tracking steps below need the clone.

Start a new Claude Code session so it loads the plugin.

### Other hosts

| Host | Install section | What is different |
|---|---|---|
| Grok Build | [install.md#grok-build](install.md#grok-build) | Tested with 1.0.41. Plugins stay off until enabled: after the symlink, run `grok plugin enable ultrathink` and check it with `grok plugin list`. Grok ignores plugin hooks, so `bun scripts/setup.ts apply` installs a global hook file and a rule file |
| Hermes Agent | [install.md#hermes-agent](install.md#hermes-agent) | Tested with v0.21.4. Python plugin (Python 3.10 or later). You must raise Hermes' plugin hook cap to at least 105 s (600 recommended) |
| Muse Code | [install.md#muse-code](install.md#muse-code) | `muse plugins install`, then `muse plugins approve ultrathink` before planning starts |
| Omp | [install.md#omp](install.md#omp) | `omp plugin link <clone>`; a slow plan arrives as an aside message |

## 4. Check the install

In the new Claude Code session, run:

```text
/ultrathink-status
```

The hook answers before any model turn. The same report is available from a shell:

```sh
<clone>/bin/ultrathink status
```

On a fresh install it looks like this (the state path is your home directory):

```text
Prompt Uplift on
Engine: claude:sonnet
Grok: grok-4.7 @ xhigh · transport http
SuperGrok OAuth: not logged in (run grok login)
Graph of Thought on
HITL clarifications on · max 4
Tracking: on (not configured: set notion.dataSourceUrl / linear.team)
Notion: not configured
Linear team: not configured
Substrate: off (optional: set substrate.url or SUBSTRATE_URL)
Ship: off (opt-in: set ship.enabled)
Model: sonnet · concurrency 3
State: /home/<you>/.claude/ultrathink
```

The Grok lines only matter if you switch the engine to Grok. Nothing is configured to leave your machine except the engine call: no tracker, no Agent Substrate, no ship.

## 5. Send your first prompt

Open a repository in Claude Code and send a request that is more than a one-liner, for example:

```text
Add a --json flag to the export command and document it in the README
```

What happens:

1. While ultrathink plans, Claude Code shows the hook status `Ultrathink · Graph of Thought`. The engine makes several model calls in a row (see [Cost and latency](../README.md#cost-and-latency)), so this takes a while.
2. A summary line appears in the transcript, for example:

   ```text
   Prompt Uplift · BUILD_PROMPT · llm · claude:sonnet · Graph of Thought · 6 nodes · HITL · 2 question(s) · Tracking · off · 48.3s
   ```

   `BUILD_PROMPT` is the kind of spec, `llm` means the engine wrote it (`fallback` means the engine failed and a minimal spec was used), then the engine, the node count, the open questions, the tracking state and the time taken.
3. The agent receives the plan in its context. It tries to answer the HITL questions from the repository, asks you the blocking ones that remain, then works through the waves, running the units of a wave in parallel.

If planning fails for any reason, your prompt still goes through: the agent gets the minimal spec and the summary line reports `Engine error · …`.

### Where to look afterwards

Everything lands in the host's state directory, `~/.claude/ultrathink` for Claude Code (`$CLAUDE_CONFIG_DIR/ultrathink` if you set that variable):

| File | Contents |
|---|---|
| `sessions/<session-id>.xml` | The full spec with the Graph of Thought and the questions |
| `sessions/<session-id>.json` | The session record: spec, graph, questions, tracking plan and tracker links |
| `last.json` | A copy of the most recent session record |
| `control.json` | Your `/ultrathink-*` toggles for this host, once you use one |

From a shell:

```sh
<clone>/bin/ultrathink last          # the last spec
<clone>/bin/ultrathink think last    # the last graph as a sketch
<clone>/bin/ultrathink hitl last     # the last questions and answers
```

To send a message without planning, use `/ultrathink-quick <message>` or start it with `raw:`. Short replies such as `ok` are not planned either. All commands: [commands.md](commands.md).

## 6. Optional: track plans in Notion or Linear

Tracking records each plan as rows: one task per prompt, one issue per graph node and one sub-issue per rationale step. It stays off until you configure a provider, and only the providers you configure are contacted. You can set up either one or both.

All commands below run from `<clone>`:

```sh
cd <clone>
```

### Linear

Log in with OAuth, or store a personal API key from your Linear account settings (paste it, then press Ctrl-D):

```sh
bin/ultrathink-mcp auth login linear
# or
bin/ultrathink-mcp auth set-key linear --stdin
```

Then name the team that issues are created in. Add `linear.team` to your user config, `~/.config/ultrathink/config.json` (`$XDG_CONFIG_HOME/ultrathink/config.json` if that is set):

```json
{
  "linear": { "team": "<your Linear team name>" }
}
```

Details, including logging in on a remote machine: [Set up Linear](how-to/set-up-linear.md).

### Notion

Log in with OAuth (Notion has no API-key option), then let ultrathink create the tracking database under a page you choose and save its address in your user config:

```sh
bin/ultrathink-mcp auth login notion
bin/ultrathink-mcp notion init --parent <notion page url or id> --write-config
```

`notion init` prints the new `notion.dataSourceUrl` (`collection://<data source id>`), and `--write-config` writes it to `~/.config/ultrathink/config.json`, keeping the keys already there. With both providers, the file ends up like this:

```json
{
  "linear": { "team": "<your Linear team name>" },
  "notion": { "dataSourceUrl": "collection://<data source id>" }
}
```

Using an existing database, and logging in over SSH: [Set up Notion](how-to/set-up-notion.md).

### Give the agent the tracker tools

The planner creates rows itself, but the agent's `ultrathink-kickoff` and `ultrathink-sync` skills use the Notion and Linear MCP tools. Register the gateway so every host gets them:

```sh
bun scripts/mcp-register.ts --dry-run   # preview
bun scripts/mcp-register.ts
```

It adds `notion`, `linear` and `greptile` servers that run `<clone>/bin/ultrathink-mcp serve <provider>`, backs up every file it changes, and keeps any same-named server that is not ultrathink's unless you pass `--replace`. Limit it with `--hosts` and `--providers`. See [Register the MCP gateway](how-to/register-mcp-gateway.md).

### Check it

```sh
bin/ultrathink-mcp auth status   # which providers have credentials
bin/ultrathink-mcp check         # <provider>: OK <n> tools, or FAIL <reason>
bin/ultrathink status            # Tracking: on (Linear/Notion rows), with your team and database
```

`check` sends a real request through the gateway for each provider and exits non-zero if any of them fails. A provider without credentials fails with the command that fixes it, for example `linear: FAIL … run: ultrathink-mcp auth login linear (OAuth) or ultrathink-mcp auth set-key linear --stdin …`. To test only the trackers you use, name them: `bin/ultrathink-mcp check notion linear`.

## 7. What a tracked plan looks like

Send another non-trivial prompt. Now the summary line ends with the tracking result, for example `Tracking · 6 issues · 29 sub-issues linked`, or `Tracking · partial (4 missing) · kickoff will finish` when some rows were not created in time. The agent then runs the `ultrathink-kickoff` skill before any other work: it creates any missing rows, resolves the blocking questions and sets the Notion task's `Status` to `Implementing`.

Every plan gets a Graph ID such as `ut-<id>-<8 hex>`. In **Linear**, in your team:

| Row | Title |
|---|---|
| One issue per node | `[n1] Add the --json flag to the export command` |
| One sub-issue per rationale step | `Add the --json flag to the export command — Step 1: …` |

A node's issue is blocked by the issues of the nodes it depends on, and every description ends with `ultrathink graph <graph id> · node <node id>` (plus ` · step <n>` on sub-issues).

In **Notion**, in your database, a three-level hierarchy linked through `Parent Item`: a `Task` row for the prompt (with the uplifted prompt, the host, the repository and branch), an `Issue` row per node and a `Sub-Issue` row per step, all carrying the same `Graph ID`.

The agent also gets the links as TODO lines, which it copies into its own TODO list:

```text
- [ ] n1 · [ENG-12](https://linear.app/<workspace>/issue/ENG-12/…) · Add the --json flag to the export command · notion: <Notion row URL>
  - [ ] n1.1 · [ENG-13](https://linear.app/<workspace>/issue/ENG-13/…) · Step 1: … · notion: <Notion row URL>
```

After the agent opens a pull request, the `ultrathink-sync` skill writes the PR link, checks and state onto the same rows. It never creates rows.

Rows and their properties in full: [tracking.md](tracking.md).

## Next steps

- [Choose the engine](how-to/choose-engine.md): plan with Grok instead of Claude.
- [Reduce cost and latency](how-to/reduce-cost-and-latency.md): fewer nodes, no questions, skipping planning for small messages.
- [Ship with Greptile](how-to/ship-with-greptile.md): opt in to opening, reviewing and merging pull requests.
- [Team and project config](how-to/team-and-project-config.md): share settings per repository.
- [Headless and CI](how-to/headless-and-ci.md): turn planning off for scripts.
- [What leaves your machine](privacy.md) and [Configuration](configuration.md).
- Something not working: [Troubleshooting](troubleshooting.md).
- All documentation: [docs index](README.md).
