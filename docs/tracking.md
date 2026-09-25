# Tracking: Linear and Notion

ultrathink can record every plan as rows in Linear, in Notion, or in both. Tracking is off until you configure a provider: with `notion.dataSourceUrl` and `linear.team` both unset (the default), no rows are created and neither service is contacted.

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

Each description ends with a footer, `ultrathink graph <graph id> · node <node id>`, plus ` · step <n>` on sub-issues. A re-run searches for this footer and reuses existing issues instead of creating duplicates.

**Notion** (when `notion.dataSourceUrl` is set), in that database, as a three-level hierarchy linked through the `Parent Item` relation:

| `Level` | Count | Main properties | `Parent Item` |
|---|---|---|---|
| `Task` | one per plan | `Item`, `Description`, `Uplifted Prompt` (cut to 1900 characters), `Agent` (the host), `Status` = `Planning`, `Linear State` = `Todo`, `Repo`, `Branch`, `Graph ID` | none |
| `Issue` | one per graph node | `Item`, `Thought`, `Graph ID`, and `Linear URL` / `Issue ID` when Linear is also configured | the Task |
| `Sub-Issue` | one per rationale step | `Item`, `Step`, `Thought`, `Graph ID`, `Linear URL` / `Issue ID` | the node's Issue |

ultrathink fetches the database schema first and writes only the properties the database has, so a database with fewer columns still works. A re-run finds existing rows by `Graph ID`.

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

On Hermes the plugin nudges sync when a tool call opens a pull request and, through Hermes' `pre_verify` hook, once per plan (per session and Graph ID) when a coding turn is about to finish with rows created but `synced` not yet set. Recording `synced` stops that end-of-turn nudge.

No rows are created when:

- the engine failed and the prompt got the fallback spec,
- the message was sent with `/ultrathink-quick`, `/ultrathink-skip` or the `raw:` prefix, or planning is off,
- the message references an existing ultrathink graph as `graph ut-<id>-<8 hex>` (as dispatched workers and the Linear issue footers do), so it isn't planned again; prefix it with `uplift:` to plan it anyway,
- tracking is turned off (see [Turning tracking off](#turning-tracking-off)).

You can run `track complete` yourself at any time. It is safe to repeat:

```sh
<clone>/bin/ultrathink-mcp track complete --state <state dir>/sessions/<session-id>.json
```

See [Configuration](configuration.md#state-directories) for where each host keeps its session records.

## The MCP gateway and credential store

`bin/ultrathink-mcp` is a small MCP gateway for three hosted servers:

| Provider | Hosted server | Credential |
|---|---|---|
| `notion` | `https://mcp.notion.com/mcp` | OAuth only |
| `linear` | `https://mcp.linear.app/mcp` | API key, or OAuth |
| `greptile` | `https://api.greptile.com/mcp` | API key, or OAuth |

The planner, `track complete` and the ship flow call these servers directly with the credentials in the store. `bin/ultrathink-mcp serve <provider>` exposes the same connection as a stdio MCP server, so your agents use the same login (see [Registering the gateway](#registering-the-gateway-in-your-hosts)).

Commands:

```sh
bin/ultrathink-mcp auth status                     # which providers are ready; never prints a secret
bin/ultrathink-mcp auth set-key <linear|greptile> --stdin
bin/ultrathink-mcp auth set-key <linear|greptile> --env-file <path> --var <NAME>
bin/ultrathink-mcp auth login <provider> [--port <n>] [--redirect <url>] [--no-listen]
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

### 1. Log in

```sh
<clone>/bin/ultrathink-mcp auth login notion
```

The command prints an authorization URL and waits. Open the URL in a browser, approve access, and the browser returns to a local callback listener on `127.0.0.1:8765` (change the port with `--port`). If the page fails to load, copy the full URL from the address bar and paste it into the terminal. That works too. With `--no-listen` the command only waits for a pasted URL.

### Logging in from a remote machine

Over SSH, the browser runs on your own computer, where `127.0.0.1` is not the server. The command detects an SSH session (`SSH_CONNECTION`, `SSH_CLIENT` or `SSH_TTY`) and picks one of these routes:

| Route | When | How it works |
|---|---|---|
| Tailscale | Tailscale is running on the server and its tailnet name has HTTPS certificates | The callback URL is `https://<server tailnet name>/ultrathink-oauth/callback`. For the length of the login, the command adds `tailscale serve --bg --https=443 --set-path=/ultrathink-oauth` pointing at the local listener, and removes it afterwards. Open the URL on any device in the same tailnet and the login finishes by itself. If the route cannot be added, the command falls back to the port forward route. |
| Port forward | No usable Tailscale | Forward the callback port before you open the URL: `ssh -L 8765:127.0.0.1:8765 <user>@<server>`, or a local port forward in your SSH client (for example Termius: bind `127.0.0.1:8765` locally to `127.0.0.1:8765` through the SSH host). |
| Paste | Always | Approve in the browser, then paste the redirected URL into the terminal, even if the page did not load. |
| Override | `--redirect <url>` or `ULTRATHINK_OAUTH_REDIRECT` | Use your own callback URL. It must be https, or http on `127.0.0.1`, `localhost` or `[::1]`, and it must reach the listener on `127.0.0.1:<port>` with the same path. |

### 2. Create the tracking database

```sh
<clone>/bin/ultrathink-mcp notion init --parent <notion page url or id> --write-config
```

This creates a database titled `Agent Task Graph` (change it with `--title`) under the parent page. The page must be one your Notion login can edit. The command then adds the two-way `Parent Item` / `Sub-Items` relation on the database itself and prints the new `collection://…` data source. `--write-config` saves it as `notion.dataSourceUrl` in `~/.config/ultrathink/config.json` and keeps the other keys. Without `--write-config`, it prints the JSON snippet for you to add yourself.

It never creates rows. If the database is created but the relation fails, the command exits with status 1 and says so. Rows then stay flat until you add a two-way relation named `Parent Item` (synced as `Sub-Items`) from the database to itself in Notion. The create call waits up to 120 seconds. If it times out, check Notion before you run it again, because the database may exist already.

To use an existing database instead, set `notion.dataSourceUrl` to its `collection://<id>` data source by hand.

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

1. Store a Linear API key. `--stdin` reads it from standard input (paste it, then press Ctrl-D):

   ```sh
   <clone>/bin/ultrathink-mcp auth set-key linear --stdin
   ```

   Or read it from an env file: `auth set-key linear --env-file <path> --var LINEAR_API_KEY`. `auth login linear` (OAuth) also works.

2. Set the team the issues go into, in any [config file](configuration.md#config-files):

   ```json
   { "linear": { "team": "<your team name>" } }
   ```

The key must belong to the Linear workspace that has this team.

## Greptile key

Greptile is not used for tracking. The ship flow uses it for code review (see [Ship](ship.md)), and it shares the same store:

```sh
<clone>/bin/ultrathink-mcp auth set-key greptile --stdin
```

`auth login greptile` (OAuth) also works. The ship flow's CLI review mode uses the separate Greptile CLI login (`greptile login`) instead.

## Registering the gateway in your hosts

The planner and `track complete` read the store directly and need no registration. Register the gateway so that the agents themselves (the kickoff and sync skills, or you asking the agent) can use the Notion, Linear and Greptile tools with the same login:

```sh
bun scripts/mcp-register.ts [--hosts claude,grok,hermes,muse,omp] [--providers notion,linear,greptile] [--dry-run]
```

For each provider it adds a server named `notion`, `linear` or `greptile` that runs `<clone>/bin/ultrathink-mcp serve <provider>`:

| Host | How | File backed up first |
|---|---|---|
| Claude Code | `claude mcp add --scope user` | `~/.claude.json` |
| Grok Build | `grok mcp add --scope user` | `~/.grok/config.toml` |
| Hermes Agent | `hermes mcp add` | `$HERMES_HOME/config.yaml` |
| Muse Code | writes `mcpServers` in `~/.config/muse/settings.json` | the same file |
| Omp | writes `~/.omp/agent/mcp.json` | the same file |

It writes user-level config only, replaces entries with the same name, and backs up each file it changes as `<file>.bak-ultrathink-mcp-<timestamp>`. A host whose CLI is not on `PATH` is skipped. `--dry-run` prints the changes without writing anything. Claude Code keeps any claude.ai Notion or Linear connectors next to these. Disable them in `/mcp` if you want only one.

## Turning tracking off

| Goal | How |
|---|---|
| No rows at all on this host | `/ultrathink-track off` in the agent, or `bin/ultrathink track off`. The planner, `track complete` and the kickoff skill then create nothing. Planning continues. `/ultrathink-track on` turns it back on. |
| No rows anywhere | Leave `notion.dataSourceUrl` and `linear.team` unset. This is the default. |
| No rows for one message | `/ultrathink-quick <message>`, or the `raw:` prefix. |
| Planner creates no rows, kickoff creates them | `"track": { "enabled": false }` in config, or `ULTRATHINK_TRACK=0` in the environment. |

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
