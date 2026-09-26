# Set up Linear tracking

This guide connects ultrathink to Linear so that every plan is recorded as issues in one Linear team: one issue per Graph of Thought node, blocked by the issues of the nodes it depends on, and one sub-issue per rationale step. [Tracking](../tracking.md) explains what those issues contain and when they are created.

ultrathink talks to Linear's hosted MCP server (`https://mcp.linear.app/mcp`) through its MCP gateway, `<clone>/bin/ultrathink-mcp`, with a credential kept in the local credential store (see [The MCP gateway and credential store](../tracking.md#the-mcp-gateway-and-credential-store)). `<clone>` is the directory you cloned ultrathink into.

You need ultrathink installed on a host (see [Install](../install.md)), Bun on `PATH`, and a Linear account in the workspace that has the team you want the issues in.

## 1. Store a credential

Linear accepts an API key or an OAuth login. Use one. The store holds one credential per provider, so a later `set-key` or `login` replaces the earlier one.

### Option A: a personal API key

1. In Linear, open **Settings → Account → Security & access** (`https://linear.app/settings/account/security`). Under **Personal API keys**, choose **New API key**, name it, and give it access to the team you will track in, with permission to create issues. Copy the key; Linear shows it only once. If the section is missing, a workspace admin has turned off member API keys (**Settings → Administration → API**).
2. Store it. `--stdin` reads the key from standard input: paste it, press Enter, then Ctrl-D.

   ```sh
   <clone>/bin/ultrathink-mcp auth set-key linear --stdin
   ```

   Or read it from a dotenv-style file:

   ```sh
   <clone>/bin/ultrathink-mcp auth set-key linear --env-file <path> --var LINEAR_API_KEY
   ```

   The file may use `NAME=value` or `export NAME=value` lines, and quotes around the value are removed. Either way the command prints `linear: api key stored (<n> chars)`. The key never appears on the command line, so it stays out of your shell history.

### Option B: OAuth

```sh
<clone>/bin/ultrathink-mcp auth login linear
```

This is the same browser flow as Notion, with the same flags and the same routes for a login over SSH (port forward, paste-back, opt-in `--tailscale`, or `--redirect`). See [Log in](set-up-notion.md#1-log-in) and [Logging in over SSH](set-up-notion.md#logging-in-over-ssh). ultrathink asks Linear for the `read` and `write` scopes. The command ends with `linear: logged in`.

## 2. Choose the team

Set `linear.team` in any [config file](../configuration.md#config-files), for example the user config `~/.config/ultrathink/config.json`, or a project's `.claude/ultrathink.json` to send one project's issues to its own team:

```json
{ "linear": { "team": "<your Linear team>" } }
```

How the value is used:

- ultrathink trims it and passes it unchanged as the `team` argument of the Linear MCP `save_issue` call for every issue and sub-issue. It does not look the team up or check it first.
- Linear's server describes that argument as the **team name or ID**. Use the team's name exactly as Linear shows it, or its ID. To see both, ask your agent to list the teams with the Linear MCP `list_teams` tool.
- A wrong value fails each create with Linear's error, which is recorded in the session record's `tracking.errors`. Nothing else is affected.
- An empty or blank value means Linear is not configured: no Linear call is made. An empty string in a later config file does not clear a team set in an earlier one; use `/ultrathink-track off` to stop rows (see [Turning tracking off](../tracking.md#turning-tracking-off)).
- The planner and `track complete` always use the `linear.team` configured when they run, so issues still missing after you change it are created in the new team. The team a plan's issues were first created in is recorded in the session record (`tracking.linearTeam`), and only the kickoff skill's manual fallback, used when `track complete` cannot run, prefers that recorded team. The sync skill uses no team; it updates the issues it finds by Graph ID.

The credential must belong to the Linear workspace that has this team.

## 3. Verify

From your project directory:

```sh
<clone>/bin/ultrathink status
<clone>/bin/ultrathink-mcp auth status
<clone>/bin/ultrathink-mcp check linear
```

Expected:

- `bin/ultrathink status` shows `Tracking: on (Linear/Notion rows)` and `Linear team: <your Linear team>`.
- `auth status` shows `linear  api_key  ready  api key set (<n> chars)`, or an `oauth` line with `ready` after an OAuth login. It never prints a secret.
- `check linear` connects through the gateway and prints `linear: OK <n> tools`. It exits 1 and prints `linear: FAIL <reason>` otherwise.

Then send a normal prompt to your agent. Issues titled `[<node id>] <node title>` should appear in the team, each description ending with the footer `ultrathink graph <graph id> · node <node id>`, and sub-issues titled `<node title> — Step <n>: <step summary>` under them. If issues are missing, run `track complete` for that session (see [When rows are created](../tracking.md#when-rows-are-created)) or see [Troubleshooting](../troubleshooting.md). A Linear rate limit is reported as such and never as a login problem; see [Rate limits](../tracking.md#rate-limits).

## Next steps

- Give your agents the Linear tools too, so the sync skill can move the issues through your workflow states with the same credential: [Register the MCP gateway](register-mcp-gateway.md).
- Add Notion as well: [Set up Notion](set-up-notion.md).
- Remove the credential with `<clone>/bin/ultrathink-mcp auth logout linear`. That deletes only the local entry. Revoke the API key in Linear's settings, or the OAuth access in Linear, if it may have leaked.
