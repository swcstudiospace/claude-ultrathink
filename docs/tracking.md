# Tracking: Linear and Notion

ultrathink can record every plan as rows in Linear, in Notion, or in both. Tracking is off until you configure a provider: with `notion.dataSourceUrl` and `linear.team` both unset (the default), no rows are created and neither service is contacted.

Step-by-step setup lives in the task guides: [Set up Notion](how-to/set-up-notion.md), [Set up Linear](how-to/set-up-linear.md) and [Register the MCP gateway](how-to/register-mcp-gateway.md). This page is the reference for what they set up.

- [What gets created](#what-gets-created)
- [When rows are created](#when-rows-are-created)
- [The MCP gateway and credential store](#the-mcp-gateway-and-credential-store)
- [Setting up Notion](#setting-up-notion)
- [Setting up Linear](#setting-up-linear)
- [Greptile key](#greptile-key)
- [Registering the gateway in your hosts](#registering-the-gateway-in-your-hosts)
- [Turning tracking off](#turning-tracking-off)
- [Rate limits](#rate-limits)

## What gets created

A plan has one Graph of Thought with 5 to 8 nodes by default. Each node normally has 4 to 8 numbered rationale steps; a node whose fill failed gets one step. For each plan:

**Linear** (when `linear.team` is set), in that team:

| Row | Count | Title | Links |
|---|---|---|---|
| Issue | one per graph node | `[<node id>] <node title>` | `blockedBy` lists the issues of the nodes it depends on. |
| Sub-issue | one per rationale step | `<node title> — Step <n>: <step summary>` | Parent is the node's issue. |

Each description ends with a footer, `ultrathink graph <graph id> · node <node id>`, plus ` · step <n>` on sub-issues. A re-run of `track complete` on a session record that already has `tracking` refs searches for this footer and reuses existing issues instead of creating duplicates.

**Notion** (when `notion.dataSourceUrl` is set), in that database, as a three-level hierarchy linked through the `Parent Item` relation:

| `Level` | Count | Main properties | `Parent Item` |
|---|---|---|---|
| `Task` | one per plan | `Item`, `Description`, `Uplifted Prompt` (cut to 1900 characters), `Agent` (the host), `Status` = `Planning`, `Linear State` = `Todo`, `Repo`, `Branch`, `Graph ID` | none |
| `Issue` | one per graph node | `Item`, `Thought`, `Graph ID`, `Agent`, `Status`, `Linear State`, and `Linear URL` / `Issue ID` when Linear is also configured | the Task |
| `Sub-Issue` | one per rationale step | `Item`, `Step`, `Thought`, `Graph ID`, `Agent`, `Status`, `Linear State`, `Linear URL` / `Issue ID` | the node's Issue |

ultrathink fetches the database schema first and writes only the properties the database has, so a database with fewer columns still works. If the fetched schema does not show `Item`, `Level` and `Graph ID`, it sends every property instead, and a create that names a missing column fails. A re-run finds existing rows by `Graph ID`.

That adoption by Graph ID happens only when `track complete` re-runs on a session record that already has `tracking` refs. The first run on a record (always the case on Hermes, where the hook creates no rows) creates every row without looking for existing ones, so a first run interrupted before it records its refs leaves rows that a retry creates again. Delete the duplicates by `Graph ID` if that happens.

The created links go into the spec's `<ISSUES>` block and into the session record (`tracking`), and the agent gets them as "Linked issues" TODO lines to copy into its TODO list.

A tracking run ends in one of three states: `complete` (every row exists in every configured provider), `partial` (some rows exist) or `failed` (none do). Errors are recorded in the session record and never block the prompt.

## When rows are created

| Step | Who | What it does |
|---|---|---|
| 1. Planner | The prompt hook or host entry, before the agent sees the prompt (not on Hermes) | Creates the Linear issues, then the sub-issues, level by level in dependency order, then the Notion Task, Issue and Sub-Issue rows. Limited by `track.budgetMs` (60 seconds by default) and `track.concurrency` parallel calls. Rows not finished in time are left for step 2. |
| 2. `track complete` | The `ultrathink-kickoff` skill runs it once when tracking is not `complete` | `bin/ultrathink-mcp track complete --state <stateFile>` creates only the missing rows, updates the session record and spec, and prints the Linked issues TODO lines. On Hermes this creates every row. |
| 3. `ultrathink-kickoff` | The agent, at the start of its turn | Runs step 2 if needed. Only when that command cannot run (the file or `bun` is missing) does it create the missing rows by hand through the Notion and Linear MCP tools. Then it resolves blocking questions, sets the Task `Status` to `Implementing`, and records that it ran with `bin/ultrathink-mcp session mark --state <stateFile> kicked-off` (`kickedOff: true` in the session record). |
| 4. `ultrathink-sync` | The agent, after it opens a PR or at a stopping point | Never creates rows. Finds the Task by `Graph ID` and updates `PR URL`, `PR #`, `Repo`, `Branch`, `PR State`, `Checks`, `Reviewers`, `Status`, `Completed` and `Linear State`, and moves the Linear issues to the matching workflow state. Ends with `bin/ultrathink-mcp session mark --state <stateFile> synced` (`synced: true` in the session record). |

On Hermes the hook only plans and skips step 1. Hermes cuts plugin hooks off at `plugins.hook_callback_timeout`, so rows created inside the hook could be left behind by a plan that never reached the agent. Instead `ultrathink-kickoff` creates all of them at the start of the agent's turn by running `ultrathink-mcp track complete --state <file>`. The tracking settings and `bin/ultrathink status` work as on the other hosts; only the moment the rows are created moves.

Kickoff fails open. When `track complete` reports that Notion or Linear is down, unreachable, rate-limited or unauthorised, or returns errors, kickoff creates no rows by hand. It tells you in one line which tracker failed and carries on with your task. Run `track complete` again later to fill in the missing rows.

Sync looks rows up by Graph ID only: the Notion Task by the session record's `tracking.notion.taskUrl` or its `Graph ID`, the Linear issues by the session record's `tracking` refs or the `ultrathink graph <id>` footer. It never matches by branch, PR title or repo, never creates a row, and never clears or overwrites `PR URL` or `PR #` in a turn that has no pull request. It fails open like kickoff: when Notion or Linear is down, unreachable, rate-limited or unauthorised, it doesn't retry, says in one line which tracker it couldn't update, and the turn carries on, including the turn that opened the PR.

A tool call counts as opening a pull request, and nudges the agent to run `ultrathink-sync`, when it is either `gh pr create` run through a shell tool (`Bash`, `bash`, `shell`, `exec`, `terminal` or `run_terminal_command`), or a tool whose name ends in `create_pull_request`, `pull_request_create` or `createPullRequest`, compared case-insensitively (for example `mcp__github__create_pull_request`). The name must end there, so PR-review tools such as `create_pull_request_review` do not count. The `gh pr create` check is a plain text match, so a command that only quotes it, such as a commit message, can nudge too.

On Hermes the plugin nudges sync when a tool call opens a pull request and, through Hermes' `pre_verify` hook, once per plan (per session and Graph ID) when a coding turn is about to finish with rows created but `synced` not yet set. Recording `synced` stops that end-of-turn nudge.

No rows are created when:

- the engine failed and the prompt got the fallback spec,
- the message was sent with `/ultrathink-quick`, `/ultrathink-skip` or the `raw:` prefix, or planning is off,
- the message references an existing ultrathink graph as `graph ut-<id>-<8 hex>` (as dispatched workers and the Linear issue footers do), so it isn't planned again; prefix it with `uplift:` to plan it anyway,
- tracking is turned off (see [Turning tracking off](#turning-tracking-off)).

You can run `track complete` yourself at any time. It is safe to repeat. Run it from the project directory: it reads the config files for the current directory, so `<project>/.claude/ultrathink.json` applies only there.

```sh
cd <project>
<clone>/bin/ultrathink-mcp track complete --state <state dir>/sessions/<session-id>.json
```

It uses the `notion.dataSourceUrl` and `linear.team` configured now, not the ones in effect when the plan was made, so rows still missing after you change them go to the new database or team.

See [Configuration](configuration.md#state-directories) for where each host keeps its session records.

## The MCP gateway and credential store

`bin/ultrathink-mcp` is a small MCP gateway for three hosted servers:

| Provider | Hosted server | Credential |
|---|---|---|
| `notion` | `https://mcp.notion.com/mcp` | OAuth only |
| `linear` | `https://mcp.linear.app/mcp` | API key, or OAuth |
| `greptile` | `https://api.greptile.com/mcp` | API key, or OAuth |

The planner, `track complete` and the ship flow call these servers directly with the credentials in the store. `bin/ultrathink-mcp serve <provider>` exposes the same connection as a stdio MCP server, so your agents use the same login (see [Registering the gateway](#registering-the-gateway-in-your-hosts)). Each provider holds one credential: a later `set-key` or `login` replaces the earlier one.

Commands:

```sh
bin/ultrathink-mcp auth status                     # which providers are ready; never prints a secret
bin/ultrathink-mcp auth set-key <linear|greptile> --stdin
bin/ultrathink-mcp auth set-key <linear|greptile> --env-file <path> --var <NAME>
bin/ultrathink-mcp auth login <provider> [--port <n>] [--redirect <url>] [--tailscale] [--no-listen]
bin/ultrathink-mcp auth logout <provider>          # removes the local entry only
bin/ultrathink-mcp check [provider...]             # initialize + tools/list against each provider
```

### Security of the store

- All credentials live in one file: `~/.config/ultrathink/mcp-credentials.json` (under `$XDG_CONFIG_HOME` when set, or at `$ULTRATHINK_MCP_STORE`).
- The file is written with mode `0600` in a directory created with mode `0700`. Each write goes to a temporary file that is renamed over the store.
- The tokens and keys are stored as plain JSON. File permissions are the only protection, so keep the file out of backups and shared directories you do not trust.
- Token refreshes run under a file lock (`mcp-credentials.json.lock`). Notion rotates its refresh token on every use, and two processes that refresh at once could otherwise reuse a retired token.
- `auth set-key` reads the key from stdin or an env file, never from the command line, so it stays out of your shell history.
- `auth status` shows whether each provider is ready and, for an API key, only its length.
- `auth logout` deletes the provider's entry from the store. It does not revoke anything at the provider. Revoke the token or key there as well if it may have leaked.

See [SECURITY.md](../SECURITY.md) for how to report a vulnerability.

## Setting up Notion

The full walkthrough is [Set up Notion](how-to/set-up-notion.md). In short:

```sh
<clone>/bin/ultrathink-mcp auth login notion                                            # OAuth only
<clone>/bin/ultrathink-mcp notion init --parent <notion page url or id> --write-config   # create the database
```

`auth login` prints an authorization URL and waits. Open it in a browser, approve access, and the browser returns to a local listener on `http://127.0.0.1:8765/callback` (change the port with `--port`). If the page fails to load, copy the full URL from the address bar and paste it into the terminal. With `--no-listen` the command only waits for a pasted URL.

`notion init` creates a database titled `Agent Task Graph` (change it with `--title`) under a page your Notion login can edit, adds the two-way `Parent Item` / `Sub-Items` self-relation, and prints the new `collection://<data source id>` data source. `--write-config` saves it as `notion.dataSourceUrl` in the user config (`~/.config/ultrathink/config.json`, or under `$XDG_CONFIG_HOME`) and keeps the other keys; without it, the command prints the JSON line for you to add yourself. It never creates rows. It exits 1 when the relation could not be added, and its create call waits up to 120 seconds, so check Notion before you rerun after a timeout.

To use an existing database instead, set `notion.dataSourceUrl` to its `collection://<data source id>` data source. It needs at least `Item` (title), `Level` (select) and `Graph ID` (text); see [Or use an existing database](how-to/set-up-notion.md#or-use-an-existing-database).

### Logging in from a remote machine

Over SSH, the browser runs on your own computer, where `127.0.0.1` is not the server. The command detects an SSH session (`SSH_CONNECTION`, `SSH_CLIENT` or `SSH_TTY`) and prints hints for these routes:

| Route | When | How it works |
|---|---|---|
| Port forward | Default | Forward the callback port before you open the URL: `ssh -L 8765:127.0.0.1:8765 <user>@<server>`, or a local port forward in your SSH client (for example Termius: bind `127.0.0.1:8765` on your computer to `127.0.0.1:8765` through the SSH host). |
| Paste | Always | Approve in the browser, then paste the redirected URL into the terminal, even if the page did not load. |
| Tailscale | Opt-in: `--tailscale` or `ULTRATHINK_OAUTH_TAILSCALE=1`, in an SSH session, with Tailscale running and HTTPS certificates for the server's tailnet name | The callback URL is `https://<server tailnet name>/ultrathink-oauth/callback`. For the length of the login, the command adds `tailscale serve --bg --https=443 --set-path=/ultrathink-oauth` pointing at the local listener, and removes it afterwards. Open the URL on any device in the same tailnet and the login finishes by itself. If the handler cannot be added, the command falls back to the loopback callback, so the port forward and paste routes still work. Without the opt-in, ultrathink never runs `tailscale`. |
| Override | `--redirect <url>` or `ULTRATHINK_OAUTH_REDIRECT` (the flag wins); takes precedence over Tailscale | Use your own callback URL. It must be https, or http on `127.0.0.1`, `localhost` or `[::1]`, and it must reach the listener on `127.0.0.1:<port>` with the same path. |

Details and expected output: [Logging in over SSH](how-to/set-up-notion.md#logging-in-over-ssh).

### Database schema

These are the columns `notion init` creates (`TASK_GRAPH_COLUMNS` in `src/mcp/notion-db.ts`), plus the `Parent Item` / `Sub-Items` self-relation:

| Column | Type | Options | Written by |
|---|---|---|---|
| `Item` | title | | planner |
| `Level` | select | `Task`, `Issue`, `Sub-Issue` | planner |
| `Status` | select | `Planning`, `Implementing`, `Blocked`, `Failed`, `Done`, `Merged` | planner, kickoff, sync |
| `Linear State` | select | `Backlog`, `Todo`, `In Progress`, `In Review`, `Done`, `Canceled` | planner, sync |
| `Graph ID` | text | | planner |
| `Description` | text | | planner (Task) |
| `Uplifted Prompt` | text | | planner (Task) |
| `Agent` | text | | planner |
| `Thought` | text | | planner (Issue, Sub-Issue) |
| `Step` | number | | planner (Sub-Issue) |
| `Linear URL` | URL | | planner |
| `Issue ID` | text | | planner |
| `Repo` | text | | planner, sync |
| `Branch` | text | | planner, sync |
| `PR URL` | URL | | sync |
| `PR #` | number | | sync |
| `PR State` | select | `Open`, `Approved`, `Merged` | sync |
| `Checks` | select | `Pending`, `Passing`, `Failing`, `Blocked` | sync |
| `Reviewers` | text | | sync |
| `Completed` | date | | sync |
| `Parent Item` / `Sub-Items` | relation to the same database | | planner |

`Status` is a select, not a Notion status property, because the database is created through DDL, which cannot define status options.

## Setting up Linear

The full walkthrough is [Set up Linear](how-to/set-up-linear.md). In short:

1. Store a credential: a personal API key from Linear's **Settings → Account → Security & access**, read from standard input (paste it, press Enter, then Ctrl-D):

   ```sh
   <clone>/bin/ultrathink-mcp auth set-key linear --stdin
   ```

   Or read it from an env file: `auth set-key linear --env-file <path> --var LINEAR_API_KEY`. `auth login linear` (OAuth) works too.

2. Set the team the issues go into, in any [config file](configuration.md#config-files):

   ```json
   { "linear": { "team": "<your Linear team>" } }
   ```

   The value is passed unchanged as the `team` argument of the Linear MCP `save_issue` call, which Linear's server documents as a team name or ID. ultrathink does not check it first; a wrong value fails each create with Linear's error.

The credential must belong to the Linear workspace that has this team.

## Greptile key

Greptile is not used for tracking. The ship flow uses it for code review (see [Ship](ship.md)), and it shares the same store:

```sh
<clone>/bin/ultrathink-mcp auth set-key greptile --stdin
```

`auth login greptile` (OAuth) also works. The ship flow's CLI review mode uses the separate Greptile CLI login (`greptile login`) instead.

## Registering the gateway in your hosts

The planner, `track complete` and the ship flow read the store directly and need no registration. Register the gateway so that the agents themselves (the kickoff and sync skills, or you asking the agent) can use the Notion, Linear and Greptile tools with the same login. The full guide, including when you can skip it, is [Register the MCP gateway](how-to/register-mcp-gateway.md).

```sh
bun scripts/mcp-register.ts [--hosts claude,grok,hermes,muse,omp] [--providers notion,linear,greptile] [--replace | --remove] [--dry-run]
```

For each provider it adds a server named `notion`, `linear` or `greptile` that runs `<clone>/bin/ultrathink-mcp serve <provider>`:

| Host | How | File backed up first |
|---|---|---|
| Claude Code | `claude mcp add --scope user` | `~/.claude.json` (`$CLAUDE_CONFIG_DIR/.claude.json` when set) |
| Grok Build | `grok mcp add --scope user` | `~/.grok/config.toml` (`$GROK_HOME/config.toml` when set) |
| Hermes Agent | `hermes mcp add` | the active Hermes profile's `config.yaml`: `~/.hermes/config.yaml` (`$HERMES_HOME/config.yaml` when set), or `<Hermes root>/profiles/<name>/config.yaml` when `HERMES_HOME` is a profile directory or the root's `active_profile` names a non-default profile. If the profile cannot be resolved, nothing is backed up and the script says so. |
| Muse Code | writes `mcpServers` in `~/.config/muse/settings.json` (under `$XDG_CONFIG_HOME` when set) | the same file |
| Omp | writes `mcpServers` in `~/.omp/agent/mcp.json` (`$PI_CODING_AGENT_DIR/mcp.json` when set) | the same file |

- It writes user-level config only, and backs up each file it changes as `<file>.bak-ultrathink-mcp-<timestamp>`.
- It changes only ultrathink's entries: those whose command ends with `/bin/ultrathink-mcp`, from any clone. A same-named entry that is not ultrathink's, such as the hosted `notion` or `linear` HTTP server that `scripts/setup.ts apply` adds to Claude Code, is kept and reported as `kept`. `--replace` overwrites it.
- `--remove` deletes ultrathink's entries and keeps every other one.
- `--dry-run` prints the changes without writing a file or changing a host.
- A host whose CLI is not on `PATH` (Claude Code, Grok Build, Hermes Agent) is skipped. Muse and Omp files are written whether or not the host is installed; use `--hosts` to leave them out.
- Run from a path that contains `/plugins/cache/`, it warns that the next plugin update replaces that directory and would break the registered commands. Register from a stable clone.
- It exits 1 when any registration failed and 2 on a usage error.

## Turning tracking off

| Goal | How |
|---|---|
| No rows at all on this host | `/ultrathink-track off` in the agent, or `bin/ultrathink track off`. The planner, `track complete` and the kickoff skill then create nothing. Planning continues. `/ultrathink-track on` turns it back on. |
| No rows anywhere | Leave `notion.dataSourceUrl` and `linear.team` unset. This is the default. |
| No rows for one message | `/ultrathink-quick <message>`, or the `raw:` prefix. |
| Planner creates no rows, kickoff creates them | `ULTRATHINK_TRACK=0` in the environment, or `"track": { "enabled": false }` in config. The config key has no effect on a host where `/ultrathink-track on` or `off` (or `bin/ultrathink track on`/`off`) has been used: that per-host control setting beats `track.enabled` and stays until you delete `trackEnabled` from `<state dir>/control.json`. `ULTRATHINK_TRACK=0` still works there. |

`bin/ultrathink track status` shows which case applies:

| Line | Meaning |
|---|---|
| `Tracking: on (Linear/Notion rows)` | The planner creates rows for the configured providers. |
| `Tracking: on (not configured: set notion.dataSourceUrl / linear.team)` | Nothing is configured, so nothing is created. |
| `Tracking: kickoff (planner-side row creation off; …)` | Config or `ULTRATHINK_TRACK=0` stopped the planner. Kickoff still creates the rows. |
| `Tracking: off (Linear/Notion rows)` | `/ultrathink-track off` is in effect for this host. |

See [Commands](commands.md) for all the skip commands.

## Rate limits

The gateway reports a rate limit as a rate limit, not as a login problem. It treats these responses as rate limited:

- HTTP 429,
- HTTP 401 or 403 with a `Retry-After` header, with `x-ratelimit-remaining: 0`, or with "rate limit" in the body.

It returns a JSON-RPC error with code `-32029` and a message such as `mcp.linear.app rate limited; retry after 30s`. It does not refresh the token and does not ask you to log in again. That matters for Notion, where a needless refresh rotates the refresh token.

Nothing is retried automatically. A rate-limited row is recorded in the session record's `tracking.errors`, and the run ends `partial` or `failed`. Run `track complete` for that session once the limit resets, or let the kickoff skill do it. Existing rows are reused, so nothing is created twice.

For other problems, see [Troubleshooting](troubleshooting.md).
