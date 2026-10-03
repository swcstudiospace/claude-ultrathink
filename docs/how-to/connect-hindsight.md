# Connect Hindsight

Hindsight is the optional memory server Teachable Moments uses to share confirmed lessons across machines. ultrathink talks to it over HTTP (tested against Hindsight 0.9.1). It is **off by default**: a fresh install never contacts Hindsight, and a repository's project file cannot turn it on or point it at a URL.

When a retain fails, the lesson stays on this machine and planning continues. Nothing here blocks a prompt.

`<clone>` is the directory you cloned ultrathink into. Replace `https://hindsight.example` below with the base URL of the server you run. Do not put a user name, a password, a query or a fragment in that URL.

- [1. Check the requirements](#1-check-the-requirements)
- [2. Store the key](#2-store-the-key)
- [3. Turn it on](#3-turn-it-on)
- [4. Check it](#4-check-it)
- [The bank](#the-bank)
- [Turn it off again](#turn-it-off-again)

## 1. Check the requirements

| You need | Why | Check |
|---|---|---|
| A Hindsight server you operate | ultrathink does not ship one and does not pick a hosted URL | the server's own docs |
| A base URL the URL policy accepts | the key is sent only to that origin | [step 3](#3-turn-it-on) |
| An API key, if the server requires one | `/health` and `/version` need no key; `/v1/**` sends `Authorization: Bearer` | [step 2](#2-store-the-key) |
| Network access from the machine that runs the host | requests go from your machine | `<clone>/bin/ultrathink hindsight check` ([step 4](#4-check-it)) |

`http` is accepted only for `localhost`, `127.0.0.1`, `[::1]`, a `*.ts.net` name, or an address in `100.64.0.0/10`. Any other host must be `https`. A URL with a user name, a password, a query or a fragment is refused.

## 2. Store the key

Store the key in ultrathink's credential store, `${XDG_CONFIG_HOME:-~/.config}/ultrathink/mcp-credentials.json` (mode 0600). `--stdin` reads the key from standard input: paste it, press Enter, then Ctrl-D. The key never appears on the command line.

```sh
<clone>/bin/ultrathink-mcp auth set-key hindsight --stdin
```

Or read it from a `NAME=value` line in an env file:

```sh
<clone>/bin/ultrathink-mcp auth set-key hindsight --env-file <path to .env> --var HINDSIGHT_API_KEY
```

Either prints only the key's length, `hindsight: api key stored (<n> chars)`. `<clone>/bin/ultrathink-mcp auth status` then shows `hindsight  api_key  ready  api key set (<n> chars)`. It never prints the key. The last line is `store: <path>`.

Instead of storing it, you can set `HINDSIGHT_API_KEY` in the host's environment, or `HINDSIGHT_API_TOKEN` if the first is unset. An environment variable is used only when no key is stored: **the stored key wins**, then `HINDSIGHT_API_KEY`, then `HINDSIGHT_API_TOKEN`.

`hindsight` is an API-key provider, not an MCP server. `ultrathink-mcp serve`, `check` and `auth login` refuse it. `ultrathink-mcp check hindsight` prints `ultrathink-mcp: hindsight is an API-key provider, not an MCP server: store its key with ultrathink-mcp auth set-key hindsight --stdin` and the usage text, and exits non-zero. The probe is `bin/ultrathink hindsight check`, not the gateway.

## 3. Turn it on

Add a `hindsight` section to your user config, `${XDG_CONFIG_HOME:-~/.config}/ultrathink/config.json`. A project file (`<repo>/.claude/ultrathink.json`) cannot do this.

```json
{
  "hindsight": {
    "enabled": true,
    "url": "https://hindsight.example"
  }
}
```

`url` is the server's base URL. When `hindsight.url` is empty, `HINDSIGHT_API_URL` fills it in. No config file a repository controls can set the URL, so opening a repository cannot redirect the key.

`bank` defaults to `ultrathink`. Set it only in a user file, and only as 1 to 64 characters that start with a letter or digit and then contain only letters, digits, `.`, `_` and `-`. Any other value is ignored and the earlier value stays.

A project file can set `hindsight.enabled` to `false` for that repository. It cannot turn Hindsight on, and it cannot change `url`, `bank` or the timeouts.

## 4. Check it

From the project directory:

```sh
<clone>/bin/ultrathink status
```

| Line | Meaning |
|---|---|
| `Hindsight: on · https://hindsight.example · bank ultrathink · key from store` | Ready. `key from HINDSIGHT_API_KEY` or `key from HINDSIGHT_API_TOKEN` means the key comes from the environment. The line shows the origin only, never a path and never the key. |
| `Hindsight: off (opt-in: set hindsight.enabled)` | Not turned on. A project file's `"enabled": true` does not count. |
| `Hindsight: off (ULTRATHINK_HINDSIGHT=0)` | `ULTRATHINK_HINDSIGHT=0` is set and turns Hindsight off for this process, whatever the config says. |
| `Hindsight: on · no URL (set hindsight.url or HINDSIGHT_API_URL)` | Turned on, but no URL. |
| `Hindsight: on · bad URL (http is allowed only for localhost, *.ts.net and 100.64.0.0/10; use https)` | The URL was refused. The parenthetical is the reason. |
| `Hindsight: on · no key (run bin/ultrathink-mcp auth set-key hindsight --stdin, or set HINDSIGHT_API_KEY)` | Turned on, but no key. |

Then probe the server. Unlike `decisions check`, this command does not run while Hindsight is off: it needs `hindsight.enabled`, a URL and a key, and it exits 1 without a request otherwise.

```sh
<clone>/bin/ultrathink hindsight check
```

```text
Hindsight check: ok · Hindsight 0.9.1 · database connected · bank ultrathink · 7 ms
Features: observations off · worker off
```

The first line is the server's reported version (`Hindsight unknown` when it reports none), that the database is connected, the configured bank name and the time taken. It exits 0. The health requests are `GET /health` and `GET /version`, and they do not send the key. The second line lists the features the server reported (`Features: none reported` when it lists none). The feature names are the server's; the line above is one 0.9.1 answer, not a fixed list.

On a failure it prints `Hindsight check: error (<kind>) · <message>` and exits 1. A bad key is `error (auth)`. An unreachable server is `error (network)`. A server whose `/health` does not report healthy is `error (server)`, for example `Hindsight check: error (server) · hindsight server: /health did not report healthy (Hindsight 0.9.1, database not connected)`. The message never contains the key. Not ready is the status reason with a `Hindsight check: ` prefix, also exit 1, and no request is sent. A wrong flag prints `Usage: ultrathink hindsight check [--roundtrip] [--json]` and exits 2.

To prove the authenticated path, add `--roundtrip`:

```sh
<clone>/bin/ultrathink hindsight check --roundtrip
```

```text
Hindsight check: ok · Hindsight 0.9.1 · database connected · bank ultrathink · 7 ms
Features: observations off · worker off
Hindsight roundtrip: ok · throwaway bank ultrathink-smoke-a1b2c3d4
  ensure bank: ok · 12 ms
  retain: ok · 20 ms
  recall: ok · 18 ms
  delete document: ok · 9 ms
  delete bank: ok · 8 ms
```

The round trip uses a throwaway bank named `ultrathink-smoke-` plus 8 hex characters. It never reads, writes or deletes the configured bank. The cleanup steps run even when an earlier step failed: a failed step prints `  <name>: failed (<kind>) · <message> · <ms> ms`, a skipped one prints `  <name>: skipped`, and the summary line is `Hindsight roundtrip: failed · throwaway bank ultrathink-smoke-…`. The command then exits 1. `--json` prints one JSON object instead of these lines; it still contains no key.

## The bank

The client creates the configured bank on the first retain, not during a plain `hindsight check`. It `PUT`s the bank if it is missing, then sets `retain_extraction_mode` to `chunks` when that is not already the mode.

That mode is required. The server ultrathink is written for has no LLM, and a retain in any other extraction mode would call one. A retain into a missing bank would also let the server create the bank in its default (LLM) mode, so the client creates the bank and sets `chunks` first. `chunks` stores the lesson text as-is. The `--roundtrip` "ensure bank" step does the same thing in the throwaway bank, then deletes that bank.

## Turn it off again

- `"hindsight": { "enabled": false }` in config (the default), or remove the section. No Hindsight request is made, and `bin/ultrathink status` shows `Hindsight: off (opt-in: set hindsight.enabled)`. A project file can do this for its repository.
- `ULTRATHINK_HINDSIGHT=0` in the host's environment turns Hindsight off for that process, whatever any config file says. `bin/ultrathink status` then shows `Hindsight: off (ULTRATHINK_HINDSIGHT=0)`, and `hindsight check` sends nothing.
- To remove the stored key: `<clone>/bin/ultrathink-mcp auth logout hindsight`. That prints `hindsight: logged out` and deletes only the local entry. Revoke the key on the Hindsight server if it may have leaked. The bank and the documents already retained in it stay on the server; logout does not delete them.

Lessons already stored under the host state directory stay there. See [Use Teachable Moments](use-teachable-moments.md).
