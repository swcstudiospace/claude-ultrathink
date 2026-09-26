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

ultrathink does not store an Anthropic or xAI key: the planning engine uses your existing `claude` or `grok` login.

## What leaves your machine

ultrathink sends no telemetry. Your prompts go to the planning engine, and plans go to Notion, Linear, Greptile and GitHub only when you configure those services. [Privacy and data flow](docs/privacy.md) lists every destination, what it receives, and how to turn it off.

Credentials from the store are never written to logs, tracker rows or pull requests. Engine and command error messages pass through a filter that masks `Bearer` tokens and JWT-like strings before they are shown.

When the ship flow opens a pull request, the title and body are built from the plan (`src/ship/pr-body.ts`). Before they are sent, absolute local paths that start with `/home/`, `/Users/`, `/root/`, `/tmp/`, `/var/` or `/private/`, and Windows drive paths such as `C:\…`, are replaced with `<local path>`, and ASCII control characters are removed. No other redaction is applied: the body can include your original prompt, so keep secrets out of prompts you plan to ship.
