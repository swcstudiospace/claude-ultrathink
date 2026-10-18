# ultrathink.swcstudio.space: evidence

First recorded 2026-10-16, refreshed 2026-10-18 from the VPS, public resolvers and a real Chrome 153. Each row states what was observed. Secret values are never written here.

## Current state

| Item | State |
|---|---|
| Web service | `ultrathink-web.service` as user `ultrathink` on `127.0.0.1:8795`. Code comes from `/opt/ultrathink/releases/<sha>-<utc>` through the `current` link, run by the pinned Bun at `/opt/ultrathink/bin/bun`. `systemd-analyze security` scores 1.4 (OK); the first unit scored 9.0 (UNSAFE). |
| Server planning | On. `x-ai/grok-4.7` through OpenRouter, reasoning effort low, 240 s call timeout, at most 2 concurrent plans. Measurements are in the runbook under "Planner model". |
| Worker | `ultrathink-worker` is not installed: `worker/main.ts` does not exist. `POST /ultrathink` queues runs that nothing executes. Chat planning runs inside the web service instead. |
| Public `/healthz` | 200 through Cloudflare. A request straight to the origin address returns 403. |
| Public `/mcp` | Without credentials: 401 with a challenge that names the protected-resource metadata. With the connector key or an OAuth bearer: `initialize` returns protocol 2025-11-25 and `tools/list` returns 7 tools. |
| OAuth | Discovery documents return 200. Registration, authorization with PKCE S256, token, refresh rotation with reuse detection, and revocation work (see the verification table). |
| Config | `/etc/ultrathink/ultrathink.env`, mode 600, root. Holds the password hash, session secret, connector key, OpenRouter key and planner settings. |
| Owner password | Stored as an Argon2id hash (m=65536 KiB, t=2, p=1). The generated plaintext is in `/root/.config/ultrathink/owner-password`, mode 600; it was written once and never read by the automation. Read it, then delete the file. |
| State | `/var/lib/ultrathink`, owned by `ultrathink`. The SQLite file and `oauth.json` are mode 600. |
| Maintenance | `ultrathink-maintenance.timer` runs daily at 03:17 UTC plus a random delay. It writes a SQLite `VACUUM INTO` copy with `oauth.json` and checksums, keeps 14 archives, and removes journal, session, job and SQLite run data older than 30 days. A manual run produced an archive that passed `verify` (checksums, SQLite integrity, `oauth.json` syntax). |

## Verification run, 2026-10-18

The browser rows ran against throwaway instances on loopback ports with a temporary owner password and state directory, headless Chrome 153 with an empty profile, and a local listener standing in for the redirect target. Production was not used for them. They prove this server's behavior in a real browser. They do not prove how Grok Chat or Claude Desktop behave as clients.

| Check | Result |
|---|---|
| Consent in Chrome, code from before the fix (`form-action 'self'`) | Correct password, Approve clicked: no redirect, the page stays on the consent form. This reproduces the original report. |
| Consent in Chrome, current code | Redirect to the registered callback after 245 ms with `code`, `state` and `iss`. The served policy is `form-action 'self' <redirect origin>`. |
| Consent after 50 s on the page | Same result after 333 ms. A pending approval stays valid for 10 minutes. |
| Code exchange with PKCE | 200, `Bearer`, 3600 s access token and a refresh token. |
| Bearer on `/mcp` | `initialize` and `tools/list` return 200. A wrong bearer returns 401 with `error="invalid_token"`. No bearer returns 401 with the metadata URL. |
| Code replay | 400 `invalid_grant`, and the tokens that code issued stop working (401). |
| Refresh rotation | New access and refresh tokens. Reusing the old refresh token returns 400 `invalid_grant` and revokes the grant. |
| Revoke | 200. The access token then returns 401. |
| Approval limits | A third approval within a minute, or a sixth login within 15 minutes from one address, returns "Too many attempts". |
| Restart during a plan | Service back in 2 s. The plan ended `failed` with error `interrupted`. The journal shows `shutdown` (SIGTERM), then `listening`. |
| Real plan through Cloudflare | Three 40 s waits, then a plan of about 23 KB: 10 model calls, $0.15, about 139 s. |
| SQLite retention on a copy | A 40-day and a 60-day run were removed with their phase and ledger rows. A recent run and an old run with spend dated today were kept. A second run removed nothing. The production database was untouched. |
| TLS | Let's Encrypt certificate valid to 2027-01-14 (87 days left at the check). `certbot.timer` is active. |

## DNS and edge

| Check | Result |
|---|---|
| Public DNS (1.1.1.1) | Cloudflare proxy addresses `172.67.209.85`, `104.21.58.224`, plus IPv6. Not the VPS `187.77.130.10`. |
| Edge gate | At first, GET to every path returned `302` to `/login`, and `/login` was an edge page. At the later check the same paths reached the origin. The Cloudflare change was not inspected from here. |
| Origin lock | nginx accepts Cloudflare address ranges only and returns 403 to any other peer. It restores the client address from the Cloudflare header, so logs and rate limits see the real client. Cloudflare Authenticated Origin Pulls is not enabled. |

## Origin

| Item | State |
|---|---|
| Certificate | `/etc/letsencrypt/live/ultrathink.swcstudio.space`, Let's Encrypt via the webroot at `/var/www/letsencrypt`. Renewal scheduled. |
| vhost | `/etc/nginx/sites-available/ultrathink.swcstudio.space`, symlinked into `sites-enabled`, binds `187.77.130.10:80` and `:443` explicitly as sibling vhosts do. Source of truth: `deploy/nginx-ultrathink.swcstudio.space.conf`; the deployed file was byte-identical to it at the 2026-10-18 check and `nginx -t` passed. |
| Routes | `/login`, `/ultrathink`, `/healthz`, `/mcp`, the OAuth and discovery documents (`/oauth/authorize`, `/oauth/token`, `/oauth/register`, `/oauth/revoke`, `/.well-known/oauth-*`) proxy to `127.0.0.1:8795`. Other paths return 404 JSON. Upstream failures return 503 JSON with `Retry-After`. |
| Limits | Per address: `/login` 5 per minute, OAuth routes 30 per minute, `/mcp` 120 per minute. `/mcp` accepts bodies up to 64 KiB and waits up to 75 s for the upstream, which covers the 45 s result long poll and stays under Cloudflare's 100 s limit. |
| HTTP to HTTPS | 301. |
| Existing site | `claude.swcstudio.space/health` still returns 200 through the origin. |
| Port 8792 | Used by `hermes-linear-api.service`. The app uses 8795. |
| Snapshots before changes | `/var/backups/ultrathink-20261015T214745Z` (nginx), `/var/backups/ultrathink-pre-hardening-20261018T211651Z` (config, state, the old unit and the old vhost before the hardened cutover). |

## Planning model

| Item | Result |
|---|---|
| `grok-4-heavy` via the SuperGrok session | HTTP 404: the model does not exist or the team has no access. Recorded 2026-10-16 in `heavy-probe.json` in the first snapshot directory. |
| `grok-4.7` via the SuperGrok session | HTTP 429: the included usage was used up, with a rolling 24-hour reset. Recorded in `grok47-probe.json` there. |
| `grok-4.7` via OpenRouter | Used in production. Reasoning effort low finishes a full plan in about 139 s for $0.15. At the provider's default effort it did not finish in 6 minutes. |

The xAI models page lists no Heavy API model, so an API key does not by itself give Heavy access.

## Host resources

8 vCPU, 32 GB RAM. About 15.9 GB available at the time of the first check.
