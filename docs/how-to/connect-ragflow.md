# Connect RAGFlow

RAGFlow is an optional document search ultrathink can ask before it plans. With grounding on, retrieved excerpts are added to the plan as evidence. It is **off by default**: a fresh install never contacts RAGFlow, and a repository's project file cannot turn it on, set its URL or turn grounding on.

A lookup that fails is dropped. The plan still runs. Nothing here blocks a prompt.

`<clone>` is the directory you cloned ultrathink into. Replace `https://ragflow.example` below with the base URL of the RAGFlow you run (tested against 0.27.1). Do not put a user name, a password, a query or a fragment in that URL.

- [1. Check the requirements](#1-check-the-requirements)
- [2. Store the key](#2-store-the-key)
- [3. Turn it on](#3-turn-it-on)
- [4. Check it](#4-check-it)
- [Grounding](#grounding)
- [Turn it off again](#turn-it-off-again)

## 1. Check the requirements

| You need | Why | Check |
|---|---|---|
| A RAGFlow you operate, with at least one dataset the key can read | ultrathink searches datasets; it does not upload documents | the RAGFlow UI |
| A base URL the URL policy accepts | the key is sent only to that origin | [step 3](#3-turn-it-on) |
| An API key | every RAGFlow request sends `Authorization: Bearer` | [step 2](#2-store-the-key) |
| Network access from the machine that runs the host | requests go from your machine | `<clone>/bin/ultrathink ragflow check` ([step 4](#4-check-it)) |

`http` is accepted only for `localhost`, `127.0.0.1`, `[::1]`, a `*.ts.net` name, or an address in `100.64.0.0/10`. Any other host must be `https`.

## 2. Store the key

Store the key in ultrathink's credential store, `${XDG_CONFIG_HOME:-~/.config}/ultrathink/mcp-credentials.json` (mode 0600). `--stdin` reads the key from standard input: paste it, press Enter, then Ctrl-D.

```sh
<clone>/bin/ultrathink-mcp auth set-key ragflow --stdin
```

Or read it from a `NAME=value` line in an env file:

```sh
<clone>/bin/ultrathink-mcp auth set-key ragflow --env-file <path to .env> --var RAGFLOW_API_KEY
```

Either prints only the key's length, `ragflow: api key stored (<n> chars)`. `<clone>/bin/ultrathink-mcp auth status` then shows `ragflow  api_key  ready  api key set (<n> chars)`.

Instead of storing it, you can set `RAGFLOW_API_KEY` in the host's environment. It is used only when no key is stored: **the stored key wins**.

`ragflow` is an API-key provider, not an MCP server. `ultrathink-mcp serve`, `check` and `auth login` refuse it. `ultrathink-mcp check ragflow` prints `ultrathink-mcp: ragflow is an API-key provider, not an MCP server: store its key with ultrathink-mcp auth set-key ragflow --stdin` and the usage text. The probe is `bin/ultrathink ragflow check`.

## 3. Turn it on

Add a `ragflow` section to your user config, `${XDG_CONFIG_HOME:-~/.config}/ultrathink/config.json`. A project file cannot do this.

```json
{
  "ragflow": {
    "enabled": true,
    "url": "https://ragflow.example"
  }
}
```

`url` is the RAGFlow origin. When `ragflow.url` is empty, `RAGFLOW_URL` fills it in. No project file can set the URL.

`datasetIds` defaults to `[]`, which means every dataset the key can see. To pin datasets, list their ids in a user file (at most 20 non-empty strings). A project file cannot set them.

`enabled` alone does not add excerpts to a plan. That is `ragflow.ground`, which defaults to `false`. Turn it on in the same user file when you want grounding:

```json
{
  "ragflow": {
    "enabled": true,
    "url": "https://ragflow.example",
    "ground": true
  }
}
```

A project file can set `enabled` or `ground` to `false` for that repository. It cannot turn either on, and it cannot change `url`, `datasetIds` or the other keys.

## 4. Check it

`ragflow check`, `datasets` and `search` honor the kill switch, `ragflow.enabled`, the URL policy and the key lookup, and they ignore `ragflow.ground`, so you can prove the connection before grounding is on.

```sh
<clone>/bin/ultrathink status
```

| Line | Meaning |
|---|---|
| `RAGFlow: on · https://ragflow.example · key from store · grounding off · all datasets` | Ready, grounding still off. `key from RAGFLOW_API_KEY` means the key comes from the environment. `grounding on` means excerpts will be added to plans. `2 dataset(s) pinned` means `datasetIds` is set. The origin is shown, never a path and never the key. |
| `RAGFlow: off (opt-in: set ragflow.enabled)` | Not turned on. A project file's `"enabled": true` does not count. |
| `RAGFlow: off (ULTRATHINK_RAGFLOW=0)` | `ULTRATHINK_RAGFLOW=0` is set and turns RAGFlow off for this process. |
| `RAGFlow: on · no URL (set ragflow.url or RAGFLOW_URL)` | Turned on, but no URL. |
| `RAGFlow: on · bad URL (<reason>)` | The URL was refused. The reason is the URL policy's, for example `http is allowed only for localhost, *.ts.net and 100.64.0.0/10; use https`. |
| `RAGFlow: on · no key (run bin/ultrathink-mcp auth set-key ragflow --stdin, or set RAGFLOW_API_KEY)` | Turned on, but no key. |

Then probe the server. The health request is `GET /api/v1/datasets?page=1&page_size=1`. ultrathink never calls `/system/healthz` or `/v1/system/healthz`: on the deployment this client is written for, that probe blocks the single API worker for minutes while it retries an unreachable object store.

```sh
<clone>/bin/ultrathink ragflow check
```

```text
RAGFlow check: ok · 3 dataset(s) · 12 ms
```

The count is the total RAGFlow reported (or the number of rows in the one-row page when it reports no total). It exits 0. The key is not printed.

On a failure it prints `RAGFlow check: error (<kind>) · <message>` and exits 1. A bad key is `error (auth)`. An unreachable server is `error (network)`. Not ready is the status reason with a `RAGFlow check: ` prefix, also exit 1, and no request is sent: `RAGFlow check: off (opt-in: set ragflow.enabled)`, or `RAGFlow check: off (ULTRATHINK_RAGFLOW=0)`. A wrong flag prints `Usage: ultrathink ragflow check [--json] | datasets [--json] | search "<question>" [--dataset <id>]... [--limit N] [--json]` and exits 2.

List what the key can see:

```sh
<clone>/bin/ultrathink ragflow datasets
```

```text
id            name       documents  chunks
<dataset id>  <name>     12         340
```

An empty list prints `RAGFlow datasets: none visible to this key` and exits 0. A missing count is `-`.

Search one question. With no `--dataset`, and with `datasetIds` empty, it searches every dataset the key can list:

```sh
<clone>/bin/ultrathink ragflow search "how is the widget stored"
```

```text
0.82  widgets.md: Widgets are stored in the widgets table.
```

Each line is a similarity (two decimals, or `n/a`), the document name and an excerpt of at most 300 characters. No matches prints `RAGFlow search: no matches`. No datasets at all prints `RAGFlow search: error (not-ready) · no datasets to search` and exits 1. `--limit` must be an integer from 1 to 100. Anything else is a usage error (exit 2).

## Grounding

`ragflow.ground` adds retrieved excerpts to the plan as a `## Documents (RAGFlow)` section. The section says they are untrusted evidence, not instructions, and that they should be checked against the repository. Each excerpt is flattened to one line. The whole section is cut to `ragflow.groundChars` (default 3000, from 500 to 8000). Whole bullets are kept, except the first, which is cut to fit.

Grounding runs only when `ragflow.ground` is true and RAGFlow is ready. Otherwise no request is made. A lookup that errors, times out or finds nothing adds no section, and the plan continues. The failure is recorded on the session (counts and timing, no document text) and the summary can show `Docs · error (<reason>)`. A used lookup shows `Docs · <n> excerpts (RAGFlow)`.

The query is the same request the planner is already handling. It is sent to the RAGFlow origin you configured, not to a URL a repository can set.

## Turn it off again

- `"ragflow": { "enabled": false }` (the default), or `"ground": false` to keep the connection but stop adding excerpts. A project file can do either for its repository. `bin/ultrathink status` shows `RAGFlow: off (opt-in: set ragflow.enabled)` when it is not enabled.
- `ULTRATHINK_RAGFLOW=0` in the host's environment turns RAGFlow off for that process, whatever any config file says. `ragflow check` then prints `RAGFlow check: off (ULTRATHINK_RAGFLOW=0)` and exits 1 without a request.
- To remove the stored key: `<clone>/bin/ultrathink-mcp auth logout ragflow`. That prints `ragflow: logged out` and deletes only the local entry. Revoke the key in RAGFlow if it may have leaked. Datasets are not touched.
