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

- The store is `~/.config/ultrathink/mcp-credentials.json` (under `$XDG_CONFIG_HOME` when that is set). Set `ULTRATHINK_MCP_STORE` to use another path.
- The file is written with mode `0600`, in a directory created with mode `0700`. Each write goes to a temporary file that is then renamed over the store, and token refreshes are serialized with a file lock.
- `ultrathink-mcp auth set-key` reads a key from stdin or from an env file, never from the command line, so the key stays out of your shell history.
- `ultrathink-mcp auth status` shows whether each provider is ready, never the secret itself.
- `ultrathink-mcp auth logout <provider>` deletes that provider's entry from the store. It does not revoke anything at the provider, so if a token or key may have leaked, revoke it there too.

ultrathink never logs tokens and never puts them in pull request bodies. When the ship flow opens a pull request, it also replaces local file paths such as `/home/<you>/…` in the title and body with `<local path>`.
