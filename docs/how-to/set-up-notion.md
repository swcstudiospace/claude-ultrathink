# Set up Notion tracking

This guide connects ultrathink to Notion so that every plan is recorded as rows in a Notion database: one `Task` row per plan, one `Issue` row per Graph of Thought node and one `Sub-Issue` row per rationale step. [Tracking](../tracking.md) explains what those rows contain and when they are created.

Terms used below:

- **Tracker**: Notion or Linear, the service the rows are written to.
- **MCP gateway**: `<clone>/bin/ultrathink-mcp`, the small program in this repository that talks to Notion's hosted MCP server (`https://mcp.notion.com/mcp`) with your login. `<clone>` is the directory you cloned ultrathink into.
- **Credential store**: the file the gateway keeps logins in, `~/.config/ultrathink/mcp-credentials.json` (see [Security of the store](../tracking.md#security-of-the-store)).

Notion supports OAuth only. `auth set-key notion` fails with `notion does not accept API keys; use OAuth login`.

You need:

- ultrathink installed on a host (see [Install](../install.md)) and Bun on `PATH`,
- a Notion page that your Notion account can edit, to hold the new database.

## 1. Log in

```sh
<clone>/bin/ultrathink-mcp auth login notion
```

The command prints an authorization URL and waits:

```text
Open this URL in any browser to authorize Notion:

https://…

If this machine has no browser: open it elsewhere, approve, then copy the full URL of the page you are redirected to (it may fail to load) and paste it here.

Waiting for the callback; or paste the full redirected URL here and press Enter:
```

Open the URL, approve access, and the browser returns to a listener the command runs on `http://127.0.0.1:8765/callback`. The command prints `notion: logged in` and exits.

The first login registers ultrathink with Notion as an OAuth client named `ultrathink`. The tokens go into the credential store, and the gateway refreshes them by itself from then on.

| Flag | Effect |
|---|---|
| `--port <n>` | Listen on another port instead of `8765`. |
| `--no-listen` | Start no listener; only wait for a pasted URL. |
| `--tailscale` | Receive the callback through Tailscale. Opt-in, see [Logging in over SSH](#logging-in-over-ssh). |
| `--redirect <url>` | Use your own callback URL, see [Logging in over SSH](#logging-in-over-ssh). |

### Logging in over SSH

On a remote machine the browser runs on your own computer, where `127.0.0.1` means your computer, not the server. The command treats the session as remote when `SSH_CONNECTION`, `SSH_CLIENT` or `SSH_TTY` is set, and prints the matching hints. Pick one of these routes.

**Port forward.** Forward the callback port from your computer to the server before you open the URL:

```sh
ssh -L 8765:127.0.0.1:8765 <user>@<server>
```

When `SSH_CONNECTION` is set, the command prints this line with your user name and the server address filled in. In an SSH client with a port-forwarding screen (Termius, for example), add a local forward that binds `127.0.0.1:8765` on your computer to `127.0.0.1:8765` through the SSH host. The browser then reaches the listener and the login finishes by itself.

**Paste-back.** Needs nothing set up. Approve in the browser. The page it is sent to, `http://127.0.0.1:8765/callback?…`, fails to load on your computer. Copy the full URL from the address bar, paste it into the terminal and press Enter.

**Tailscale (opt-in).** If the server is on a [Tailscale](https://tailscale.com) tailnet with HTTPS certificates enabled, you can receive the callback over `tailscale serve`:

```sh
<clone>/bin/ultrathink-mcp auth login notion --tailscale
# or: ULTRATHINK_OAUTH_TAILSCALE=1 <clone>/bin/ultrathink-mcp auth login notion
```

ultrathink runs `tailscale` only when you ask for it this way. The route is used when all of these hold:

- the session is remote (see above),
- `tailscale status --json` reports the backend `Running`,
- the server's tailnet name is one of its HTTPS certificate domains.

The callback URL is then `https://<server tailnet name>/ultrathink-oauth/callback`. For the length of the login the command adds a `tailscale serve --bg --https=443 --set-path=/ultrathink-oauth http://127.0.0.1:<port>` handler, and removes it afterwards, also when you stop the command with Ctrl-C. Open the URL on any device signed in to the same tailnet and the login finishes by itself. If the handler cannot be added, the command says so and falls back to `http://127.0.0.1:<port>/callback`, so the port-forward and paste-back routes still work. When any condition above fails, it uses that loopback URL directly.

**Your own callback URL.** `--redirect <url>`, or the `ULTRATHINK_OAUTH_REDIRECT` environment variable (the flag wins), replaces the callback URL and takes precedence over `--tailscale`. The URL must be `https`, or `http` on `127.0.0.1`, `localhost` or `[::1]`. It must forward to the listener on `127.0.0.1:<port>` with the same path, because the listener accepts only that path.

## 2. Create the tracking database

```sh
<clone>/bin/ultrathink-mcp notion init --parent <notion page url or id> --write-config
```

`--parent` takes the page's URL (from `notion.so`, `notion.site` or `app.notion.com`) or its 32-character id, with or without dashes. The id must end the last part of the URL, as it does in the links Notion copies.

The command:

1. creates a database titled `Agent Task Graph` under that page (change the title with `--title <title>`), with every column ultrathink writes (see [Database schema](../tracking.md#database-schema)),
2. adds the two-way `Parent Item` / `Sub-Items` relation from the database to itself, which nests Sub-Issues under Issues and Issues under the Task,
3. prints the new data source and the config line for it:

```text
created Notion database "Agent Task Graph": https://…
data source: collection://<data source id>

ultrathink config (~/.config/ultrathink/config.json):
{ "notion": { "dataSourceUrl": "collection://<data source id>" } }
wrote notion.dataSourceUrl to ~/.config/ultrathink/config.json
```

The printed paths are absolute on your machine. With `--write-config`, `notion.dataSourceUrl` is saved in the user config (`$XDG_CONFIG_HOME/ultrathink/config.json` when `XDG_CONFIG_HOME` is set) and every other key in that file is kept. If the file is not a JSON object, the command fails and leaves it untouched. Without `--write-config`, copy the printed line into any [config file](../configuration.md#config-files) yourself. A project's `.claude/ultrathink.json` gives that project its own database.

`notion init` never creates rows. Things that can go wrong:

- **Not logged in**: it prints `ultrathink-mcp: notion is not logged in: run: ultrathink-mcp auth login notion` and exits 1.
- **The relation fails**: the database exists, but the command exits 1 and says the `Parent Item` self-relation could not be added. Rows stay flat until you add, in Notion, a two-way relation named `Parent Item` (synced as `Sub-Items`) from the database to itself.
- **A timeout**: the create call waits up to 120 seconds. If it times out, look in Notion before you run it again, because the database may exist already.

### Or use an existing database

Set `notion.dataSourceUrl` to the database's data source in any [config file](../configuration.md#config-files):

```json
{ "notion": { "dataSourceUrl": "collection://<data source id>" } }
```

To find the data source id, ask your agent to fetch the database with the Notion MCP `notion-fetch` tool. The reply names it as `collection://…`.

What the database needs:

- **Required:** a title column named `Item`, a select `Level` with the options `Task`, `Issue` and `Sub-Issue`, and a text column `Graph ID`. ultrathink reads the schema before it writes. If it cannot find these three columns there, it sends every property, so a create that names a column the database lacks fails and nothing is recorded for it.
- **Optional:** every other column in [Database schema](../tracking.md#database-schema). Once the schema is understood, the planner writes only the columns that exist, so a database with fewer columns still works. The sync skill writes the PR columns (`PR URL`, `PR #`, `PR State`, `Checks`, `Reviewers`, `Completed`), so keep those if you want PR status in Notion.
- **Hierarchy:** a two-way self-relation named `Parent Item`, synced as `Sub-Items`. Without it, rows are created flat.
- **`Status`:** the planner writes `Planning`, kickoff `Implementing`, and sync `Done`, `Failed`, `Blocked` or `Merged`. `notion init` makes it a select. If yours is a Notion status property, it must already have every one of these options, because Notion rejects a status value that is not an option.

The simplest way to get a matching schema is to run `notion init` under a scratch page and compare the two databases.

## 3. Verify

From your project directory:

```sh
<clone>/bin/ultrathink status
<clone>/bin/ultrathink-mcp auth status
<clone>/bin/ultrathink-mcp check notion
```

Expected:

- `bin/ultrathink status` shows `Tracking: on (Linear/Notion rows)` and `Notion: collection://<data source id>`.
- `auth status` shows a line like `notion  oauth  ready  oauth token expires in …`. It never prints a secret.
- `check notion` connects through the gateway and prints `notion: OK <n> tools`. It exits 1 and prints `notion: FAIL <reason>` otherwise.

Then send a normal prompt to your agent. A `Task` row with the plan's `Graph ID` should appear in the database, with its Issue and Sub-Issue rows under it. If rows are missing, run `track complete` for that session (see [When rows are created](../tracking.md#when-rows-are-created)) or see [Troubleshooting](../troubleshooting.md).

## Next steps

- Give your agents the Notion tools too, so the kickoff and sync skills can update the rows with the same login: [Register the MCP gateway](register-mcp-gateway.md).
- Add Linear as well: [Set up Linear](set-up-linear.md).
- Sign out with `<clone>/bin/ultrathink-mcp auth logout notion`. That deletes only the local entry in the credential store. Revoke ultrathink's access in Notion too if the token may have leaked.
