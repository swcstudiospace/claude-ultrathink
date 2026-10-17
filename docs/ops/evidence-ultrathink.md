# ultrathink.swcstudio.space: evidence

Recorded 2026-10-16 from the VPS and public resolvers. Each row states what was observed. Secret values are never written here.

## Current state

| Item | State |
|---|---|
| Web service | `ultrathink-web.service` enabled and active on `127.0.0.1:8795`. |
| Worker | `ultrathink-worker` not installed. Runs queue and do not execute. |
| Public `/healthz` | 200 through the edge. |
| Public `/mcp` | `initialize` and `tools/list` return 200 with the connector key. Without a key, 401. |
| Public web login | 200 with the owner password. No run created during the check. |
| Config | `/etc/ultrathink/ultrathink.env`, mode 600, root. Holds the password hash, session secret, connector key, and planning model name. |
| Owner password | Generated. Plaintext at `/root/.config/ultrathink/owner-password`, mode 600. Read it, then delete the file. |

## DNS and edge

| Check | Result |
|---|---|
| Public DNS (1.1.1.1) | Cloudflare proxy addresses `172.67.209.85`, `104.21.58.224`, plus IPv6. Not the VPS `187.77.130.10`. |
| Edge gate | At first, GET to every path returned `302` to `/login`, and `/login` was an edge page. At the later check the same paths reached the origin. The Cloudflare change was not inspected from here. |

## Origin

| Item | State |
|---|---|
| Certificate | `/etc/letsencrypt/live/ultrathink.swcstudio.space`, Let's Encrypt via the webroot at `/var/www/letsencrypt`. Expires 2027-01-14. Renewal scheduled. |
| vhost | `/etc/nginx/sites-available/ultrathink.swcstudio.space`, symlinked into `sites-enabled`. Binds `187.77.130.10:80` and `:443` explicitly, as sibling vhosts do. Source of truth: `deploy/nginx-ultrathink.swcstudio.space.conf`. |
| Routes | `/login`, `/ultrathink`, `/healthz`, and `/mcp` proxy to `127.0.0.1:8795`. Other paths return 404 JSON. Upstream failures return 503 JSON with `Retry-After`. |
| HTTP to HTTPS | 301. |
| Existing site | `claude.swcstudio.space/health` still returns 200 through the origin. |
| Port 8792 | Used by `hermes-linear-api.service`. The app uses 8795. |
| Snapshot before any edit | `/var/backups/ultrathink-20261015T214745Z`, containing `nginx-T.txt` and a copy of `/etc/nginx`. |

## Planning model

| Item | Result |
|---|---|
| `grok-4-heavy` via the SuperGrok session | HTTP 404: the model does not exist or the team has no access. Recorded in `heavy-probe.json` in the snapshot directory. |
| `grok-4.7` via the SuperGrok session | HTTP 429: the included usage for the model is used up, with a rolling 24-hour reset. Recorded in `grok47-probe.json` in the snapshot directory. No quota was consumed by the failed probe. |
| `grok_heavy`, `grok_heavy_plus` | Found in code only. Not probed. |

The xAI models page lists no Heavy API model, so an API key does not by itself give Heavy access. Options: an xAI API key for a listed model such as `grok-4.7`, or wait for the `grok-4.7` session quota to reset.

## Host resources

8 vCPU, 32 GB RAM. About 15.9 GB available at the time of the first check.
