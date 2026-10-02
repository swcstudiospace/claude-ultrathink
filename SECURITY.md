# Security policy

## Reporting a vulnerability

Report vulnerabilities privately through GitHub's private vulnerability reporting:
<https://github.com/swcstudiospace/claude-ultrathink/security/advisories/new>. Only you and the maintainers can see the report.

Do not open a public issue, pull request or discussion for a vulnerability.

A useful report includes:

- the ultrathink version or commit, and the host (Claude Code, Grok Build, Hermes Agent, Muse or Omp)
- steps or a proof of concept that shows the problem
- what an attacker gains

Remove tokens, API keys and other secrets from everything you attach.

## Supported versions

Security fixes go into the latest release only. Check that the problem still exists there before you report it.

| Version | Supported |
| --- | --- |
| Latest release | Yes |
| Older releases | No |

## Credential handling

The MCP gateway (`bin/ultrathink-mcp`) relays to the hosted Notion, Linear and Greptile servers. It keeps their credentials (OAuth tokens and API keys) in one local store:

- The store is `${XDG_CONFIG_HOME:-~/.config}/ultrathink/mcp-credentials.json`. Set `ULTRATHINK_MCP_STORE` to use another path.
- The file is written with mode `0600`, in a directory created with mode `0700`. Each write goes to a temporary file that is then renamed over the store, and token refreshes are serialized with a file lock.
- `ultrathink-mcp auth set-key` reads a key from stdin or from an env file, never from the command line, so the key stays out of your shell history.
- `ultrathink-mcp auth status` shows whether each provider is ready, never the secret itself.
- `ultrathink-mcp auth logout <provider>` deletes that provider's entry from the store. It does not revoke anything at the provider, so if a token or key may have leaked, revoke it there too.

The same store holds the OpenRouter API key for the optional Jev decisions (`decisions.enabled`), under the key-only provider `openrouter`:

- Store it with `ultrathink-mcp auth set-key openrouter --stdin` (or `--env-file <path> --var <NAME>`). It gets the same file, mode `0600` and atomic write as every other credential. `openrouter` is not an MCP server: `serve`, `check` and `auth login` refuse it, and it is never relayed or registered with a host.
- Without a stored key, ultrathink falls back to the `OPENROUTER_API_KEY` environment variable. When both exist, the stored key wins.
- The key is never printed. `auth set-key` prints only its length, `auth status` shows `api key set (<n> chars)`, and `bin/ultrathink status` names only its source (`key from store` or `key from OPENROUTER_API_KEY`). It never appears in summaries, session records, the ship assessment or pull requests. Decisions error messages replace the key, any `sk-or-…` value and `Bearer` tokens with `[redacted]` and are cut to 200 characters.
- The key is sent only as `Authorization: Bearer <key>` to `https://openrouter.ai/api/alpha/decisions`. The endpoint is not configurable from any config file, including a repository's `<project>/.claude/ultrathink.json`, so a cloned repository cannot redirect your key. Only the `ULTRATHINK_DECISIONS_URL` environment variable, which you set yourself, changes it, and only to an `https://openrouter.ai/…` URL or an `http://` or `https://` URL on `localhost`, `127.0.0.1` or `[::1]`, with no user name or password in it. Any other value is ignored and the default endpoint is used, and only the URL's origin and path are ever used or printed. The Decisions client never follows an HTTP redirect, so a redirect cannot carry the key to another host.
- A project file cannot opt you in. In `<project>/.claude/ultrathink.json`, `decisions.enabled` can only turn Jev off, `decisions.zdr` can only turn zero data retention on, and `decisions.points` can only drop points, so a repository you open never makes your key pay for decisions, or sends your prompt, patch or knowledge-base text to OpenRouter, unless you turned Jev on in your own config. `ULTRATHINK_DECISIONS=0` in the environment turns every decision off for that process.

The same store holds the Hindsight and RAGFlow API keys, under the key-only providers `hindsight` and `ragflow`:

- Store either with `ultrathink-mcp auth set-key hindsight --stdin` or `ultrathink-mcp auth set-key ragflow --stdin` (or `--env-file <path> --var <NAME>`). They use the same file, mode `0600` and atomic write as every other credential. Neither is an MCP server: `serve`, `check` and `auth login` refuse them, and they are never relayed or registered with a host.
- Without a stored key, Hindsight falls back to `HINDSIGHT_API_KEY`, then `HINDSIGHT_API_TOKEN`; RAGFlow falls back to `RAGFLOW_API_KEY`. When a stored key exists, it wins. The keys are not logged. `auth status` shows `api key set (<n> chars)` and never the secret; `bin/ultrathink status` names only the source (`key from store`, `key from HINDSIGHT_API_KEY`, `key from HINDSIGHT_API_TOKEN` or `key from RAGFLOW_API_KEY`). Error text replaces the key with `[redacted]`.
- A key is sent only as `Authorization: Bearer <key>`, and only to a URL `checkServiceUrl` accepts: `https`, or `http` on `localhost`, `127.0.0.1`, `[::1]`, a `*.ts.net` name or an address in `100.64.0.0/10`, with no user name, password, query or fragment. The Hindsight and RAGFlow clients do not follow redirects (`redirect: "error"`), so a redirect cannot carry the key to another host. A project file cannot set the URL.
- A project file cannot enable `hindsight`, `ragflow`, `teach` or `decisions`. In `<project>/.claude/ultrathink.json`, `hindsight.enabled`, `ragflow.enabled` and `ragflow.ground` can only be turned off, and `teach.enabled` can only be turned off (`teach.capture` can only be lowered). `ULTRATHINK_HINDSIGHT=0`, `ULTRATHINK_RAGFLOW=0` and `ULTRATHINK_TEACH=0` turn the matching feature off for that process. `decisions.enabled` can only be turned off there, as above.
- Before a lesson is stored or sent, `redactText` in `src/teach/redact.ts` replaces secrets and out-of-repo home paths. That runs before the moment is written, before it is retained in Hindsight, and before a clipped lesson is sent for a `teachable` or `skillworthy` decision.

ultrathink does not store an Anthropic or xAI key: the planning engine uses your existing `claude` or `grok` login.

`bin/run-bun`, which starts Bun for every hook and CLI, passes `--no-env-file`, so Bun 1.3.3 and later do not load the `.env*` files of the repository you work in into ultrathink. Such a file could otherwise set `OPENROUTER_API_KEY`, `ULTRATHINK_DECISIONS_URL` or any other variable ultrathink reads. Bun 1.2.x ignores the flag and still loads them: on Bun 1.2, check a repository's `.env*` files before you work in it, or upgrade Bun. The Hermes plugin starts Bun in the ultrathink clone, not in your repository.

## What leaves your machine

ultrathink sends no telemetry. Your prompts go to the planning engine, and plans go to Notion, Linear, Greptile and GitHub only when you configure those services; small, capped decision states go to OpenRouter only when you turn on Jev decisions; lesson text and a recall query go to Hindsight only when `hindsight.enabled` is on and a key exists; the grounding query goes to RAGFlow only when `ragflow.ground` is on. Lesson text is redacted (`src/teach/redact.ts`) before it is stored or leaves the machine. [Privacy and data flow](docs/privacy.md) lists every destination, what it receives, and how to turn it off.

Credentials from the store are never written to logs, tracker rows or pull requests. Engine and command error messages pass through a filter that masks `Bearer` tokens and JWT-like strings before they are shown.

When the ship flow opens a pull request, the title and body are built from the plan (`src/ship/pr-body.ts`). Before they are sent, absolute local paths that start with `/home/`, `/Users/`, `/root/`, `/tmp/`, `/var/` or `/private/`, and Windows drive paths such as `C:\…`, are replaced with `<local path>`, and ASCII control characters are removed. No other redaction is applied: the body can include your original prompt, so keep secrets out of prompts you plan to ship.
