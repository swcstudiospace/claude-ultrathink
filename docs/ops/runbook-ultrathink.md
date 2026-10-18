# Runbook: ultrathink.swcstudio.space

Operations guide for the ultrathink MCP service on the VPS. Commands run as root unless noted. Secrets are never printed in this document; use the patterns below so they do not reach shell history or logs either.

## 1. Architecture

1. Clients (Grok Chat, claude.ai, Claude Desktop, Claude Code, Grok Bot) call `https://ultrathink.swcstudio.space/mcp`.
2. Cloudflare terminates the public TLS connection (SSL mode Full strict) and forwards to the VPS origin `187.77.130.10:443`.
3. nginx (`deploy/nginx-ultrathink.swcstudio.space.conf`) accepts only Cloudflare peers, takes the real client address from `CF-Connecting-IP`, rate-limits per client, and proxies the allowed routes to `127.0.0.1:8795`.
4. The Bun service `ultrathink-web` (`services/ultrathink/server.ts`) serves `/mcp`, the OAuth endpoints, `/login`, `/ultrathink`, `/healthz`, `/readyz` and `/metrics` (loopback only).
5. It runs as the unprivileged user `ultrathink` from `/opt/ultrathink/current`, a symlink into `/opt/ultrathink/releases/<sha>-<utc>`, under a systemd sandbox (`deploy/ultrathink-web.service`).
6. Server-side planning calls OpenRouter (`OPENROUTER_API_KEY`, model `ULTRATHINK_PLANNING_MODEL`); the client-driven loop (Grok Bot) makes no model call.
7. State lives in `/var/lib/ultrathink` (mode 0700): `ultrathink.sqlite` (runs, token ledger), `oauth.json` (OAuth clients and tokens), `journal/`, `sessions/`, `jobs/`.
8. Configuration and secrets live in `/etc/ultrathink/ultrathink.env` (mode 0600, root), read by systemd.
9. `deploy/ultrathink-release.sh` builds, tests, smoke-tests and switches releases; `deploy/ultrathink-maintenance.timer` runs the daily backup and retention job.
10. Logs go to journald as JSON lines; Prometheus-format metrics are on `127.0.0.1:8795/metrics`.

## 2. First install

Prerequisites: a git checkout of this repository on the VPS (any path; the release script archives from it), nginx and certbot already serving the vhost.

1. Create the service user and directories:

   ```bash
   useradd --system --home-dir /var/lib/ultrathink --shell /usr/sbin/nologin --no-create-home ultrathink
   install -d -m 0755 /opt/ultrathink /opt/ultrathink/bin /opt/ultrathink/releases
   install -d -m 0700 -o ultrathink -g ultrathink /var/backups/ultrathink
   ```

2. Pin Bun outside any home directory, and record the version in your change log:

   ```bash
   install -m 0755 /root/.local/share/reflex/bun/bin/bun /opt/ultrathink/bin/bun
   /opt/ultrathink/bin/bun --version
   ```

3. Hand existing state to the service user (migration from the old root-owned install). Stop the service first if it is running:

   ```bash
   systemctl stop ultrathink-web
   chown -R ultrathink:ultrathink /var/lib/ultrathink
   chmod 0700 /var/lib/ultrathink
   find /var/lib/ultrathink -type f -exec chmod 0600 {} +
   ```

4. Check `/etc/ultrathink/ultrathink.env` (mode 0600, owner root). Variables: `ULTRATHINK_PUBLIC_ORIGIN`, `ULTRATHINK_SESSION_SECRET`, `ULTRATHINK_OWNER_PASSWORD_HASH`, `ULTRATHINK_CONNECTOR_KEY`, `ULTRATHINK_PLANNING_MODEL` (for example `x-ai/grok-4.7`), `OPENROUTER_API_KEY`, and optionally the limits listed in `services/ultrathink/config/config.ts`. The owner hash must be argon2id (see section 6). Check the variable names without printing values:

   ```bash
   cut -d= -f1 /etc/ultrathink/ultrathink.env
   ```

5. Install the units and the nginx vhost:

   ```bash
   install -m 0644 deploy/ultrathink-web.service deploy/ultrathink-maintenance.service deploy/ultrathink-maintenance.timer /etc/systemd/system/
   systemctl daemon-reload
   install -m 0644 deploy/nginx-ultrathink.swcstudio.space.conf /etc/nginx/sites-available/ultrathink.swcstudio.space
   nginx -t && systemctl reload nginx
   ```

6. Build and start the first release (section 3), then enable everything:

   ```bash
   systemctl enable ultrathink-web
   systemctl enable --now ultrathink-maintenance.timer
   ```

7. Verify from outside: `curl -s https://ultrathink.swcstudio.space/healthz` returns 200. Verify the origin is closed to direct clients: `curl -s --resolve ultrathink.swcstudio.space:443:187.77.130.10 https://ultrathink.swcstudio.space/healthz` returns `{"error":"forbidden"}` with status 403.
8. Run the sandbox audit and read the exposure score: `systemd-analyze security ultrathink-web`.

## 3. Deploy

Commit and push the change first. The release is built from a commit, never from the working tree.

```bash
cd /path/to/claude-ultrathink
deploy/ultrathink-release.sh release <git-ref>      # for example: main, a tag, or a sha
```

The script, in order: archives the commit into `/opt/ultrathink/releases/<sha>-<utc>`, runs `bun test services/ultrathink` there, starts the new release on port 8796 with the production environment but a throwaway state directory and probes `/healthz` and `/readyz`, switches `current` atomically (the old release becomes `previous`), restarts `ultrathink-web`, probes both endpoints on the production port, and rolls back by itself when any production probe fails. It keeps the 5 newest releases (never deleting `current` or `previous`). It refuses to run unless root.

After a deploy that changed units or nginx, install the new copies (section 2, step 5) and reload. Unit changes need `systemctl daemon-reload` and a restart.

## 4. Rollback

```bash
deploy/ultrathink-release.sh status
deploy/ultrathink-release.sh rollback
```

`rollback` points `current` at `previous`, swaps the two links so a second `rollback` returns to the newer release, restarts the service and probes it. It does not undo state changes: if a release migrated data that the older code cannot read, restore from a backup (section 5) as well.

nginx rollback: `rm /etc/nginx/sites-enabled/ultrathink.swcstudio.space && nginx -t && systemctl reload nginx` takes the vhost offline; to revert a change instead, reinstall the previous conf from git.

## 5. Backup and restore drill

The daily timer runs `deploy/ultrathink-backup.sh run` as user `ultrathink`:

- `ultrathink.sqlite` copied with `VACUUM INTO` (consistent while the service runs; the `sqlite3` CLI is not needed), `oauth.json`, and `jobs/`, with `PRAGMA integrity_check` on the copy and a `SHA256SUMS` file.
- Archive `/var/backups/ultrathink/ultrathink-<utc>.tar.gz` (mode 0600 in a 0700 directory), 14 kept.
- Optional rsync when `ULTRATHINK_BACKUP_RSYNC_TARGET` is set in the env file. For ssh targets put a key and `known_hosts` in `/var/lib/ultrathink/home/.ssh`. The archive contains prompts and OAuth secrets: use an encrypted or trusted target.
- Retention: `journal/`, `sessions/` and `jobs/` entries untouched for `ULTRATHINK_RETENTION_DAYS` (default 30) are deleted; newer entries are not touched.

Manual run and status:

```bash
systemctl start ultrathink-maintenance.service
journalctl -u ultrathink-maintenance -n 40 --no-pager
systemctl list-timers ultrathink-maintenance
```

Restore drill (do it after the first install and then quarterly):

1. Verify the newest archive: `deploy/ultrathink-backup.sh verify /var/backups/ultrathink/<archive>`.
2. Rehearse on a scratch instance without touching production:

   ```bash
   scratch=$(mktemp -d /var/tmp/ut-restore.XXXXXX)
   tar -xzf /var/backups/ultrathink/<archive> -C "$scratch" --no-same-owner
   mkdir -p "$scratch/state" && cp "$scratch"/ultrathink-*/ultrathink.sqlite "$scratch"/ultrathink-*/oauth.json "$scratch/state/"
   chown -R ultrathink:ultrathink "$scratch" && chmod 0700 "$scratch"
   # Start with the production env file and the scratch state on port 8797; see the env parsing in deploy/ultrathink-release.sh.
   ```

   Probe `http://127.0.0.1:8797/readyz` and stop the instance.
3. Real restore: `systemctl stop ultrathink-web`; move the damaged `ultrathink.sqlite*` aside; copy `ultrathink.sqlite`, `oauth.json` and `jobs/` from the extracted archive into `/var/lib/ultrathink`; `chown -R ultrathink:ultrathink /var/lib/ultrathink`; `find /var/lib/ultrathink -type f -exec chmod 0600 {} +`; `systemctl start ultrathink-web`; probe `/readyz`. Removing stale `ultrathink.sqlite-wal` and `-shm` files before the copy is required.
4. Record the date, archive name and outcome of the drill in your change log.

Losing `oauth.json` signs every connector out; clients re-register and the owner approves again. It does not lose plans.

## 6. Secret rotation

Edit the env file with `sudoedit /etc/ultrathink/ultrathink.env` (keeps mode 0600), then `systemctl restart ultrathink-web` and probe `/readyz`. Never paste a secret into a command line argument, chat or ticket.

| Secret | How to rotate | Effect |
|---|---|---|
| Connector key (`ULTRATHINK_CONNECTOR_KEY`) | `openssl rand -hex 32`, store it, restart, then update the `x-connector-key` header in Grok Bot (`docs/ops/grok-bot-setup-ultrathink.md` section 5). | The old key stops working at restart. |
| Session secret (`ULTRATHINK_SESSION_SECRET`, at least 32 characters) | `openssl rand -hex 32`, store it, restart. | Every web login session is invalidated; this is also the only way to revoke a stolen session cookie (see residual risks). |
| OpenRouter key (`OPENROUTER_API_KEY`) | Create a new key in the OpenRouter dashboard with a spending limit, store it, restart, confirm one plan succeeds, then delete the old key in the dashboard. | Server-side planning uses the new key. |
| Owner password hash (`ULTRATHINK_OWNER_PASSWORD_HASH`) | Generate an argon2id hash without putting the password in argv (command below), store it, restart. | The old password stops working; OAuth approvals use the new one. |

Owner password hash, with a prompt so nothing lands in shell history:

```bash
read -rs -p 'New owner password: ' UT_PW; echo
UT_PW="$UT_PW" /opt/ultrathink/bin/bun -e 'console.log(await Bun.password.hash(process.env.UT_PW, { algorithm: "argon2id", memoryCost: 19456, timeCost: 2 }))'
unset UT_PW
```

The output starts with `$argon2id$`. Paste it as the value of `ULTRATHINK_OWNER_PASSWORD_HASH`; systemd does not expand `$` in environment files, so no escaping is needed. To revoke every OAuth client and token: stop the service, delete `/var/lib/ultrathink/oauth.json`, start it.

## 7. Incident triage

First look:

```bash
systemctl status ultrathink-web --no-pager
journalctl -u ultrathink-web -n 100 --no-pager
journalctl -u ultrathink-web --since "15 min ago" -o cat | grep '"level":"error"'
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8795/healthz
curl -s http://127.0.0.1:8795/readyz
curl -s http://127.0.0.1:8795/metrics | head -50
```

`/healthz` is liveness only (the process answers and the database responds). `/readyz` reports whether the service can do work (database ping, state directory writable, OAuth state readable). Through the edge, a 503 body `{"error":"unavailable"}` with `Retry-After` is nginx saying the upstream is down.

Logs are one JSON object per line with `ts`, `level`, `event` and, for requests, a request id (also returned to the client as `X-Request-Id`), HTTP method and path, status, duration, JSON-RPC method, tool name, auth kind and client address. Error logs carry the `correlationId` that appears in a 500 response body. To follow one request: take the `X-Request-Id` (or `correlationId`) from the client, then `journalctl -u ultrathink-web -o cat | grep <id>`. Secrets, tokens, cookies and authorization headers are dropped from log fields by design. The exact event names are defined in `services/ultrathink/routes/router.ts`; list them with `journalctl -u ultrathink-web -o cat | grep -o '"event":"[^"]*"' | sort | uniq -c | sort -rn`.

Common symptoms:

| Symptom | Usual cause | Check and action |
|---|---|---|
| 401 on `/mcp` | No bearer, expired or revoked token, wrong connector key. `WWW-Authenticate` carries `error="invalid_token"` when a token was sent but not accepted. | The client should refresh or re-run OAuth. For Grok Bot compare the key (section 6). Absent token plus 401 is normal for the first request of an OAuth flow. |
| 403 with `{"error":"forbidden"}` from nginx | The TCP peer is not a Cloudflare address (direct hit, or the Cloudflare range list is stale). | Refresh the ranges in the nginx conf (instructions at the top of the file). |
| 403 from the app on `/mcp` | `Origin` header not in the allow list. | Add the origin to `ULTRATHINK_ALLOWED_ORIGINS` and restart. Requests without an Origin header are allowed. |
| 429 | Rate limit. An nginx 429 carries the default nginx error page; an app 429 comes from the service itself (it logs the limit that fired). nginx limits: login 5 per minute, OAuth 30, `/mcp` 120, per real client address. | If many users share one address, raise the nginx rate. If every client is limited, real-IP is broken: check that `CF-Connecting-IP` reaches nginx and that the Cloudflare ranges are current. |
| 503 | nginx: upstream down or restarting (`systemctl status`). App: not ready, or the planner is busy (`maxConcurrentPlans` jobs running). | Check `journalctl`, `/readyz`, and wait for running plans; raise `ULTRATHINK_MAX_CONCURRENT_PLANS` (1 to 8) if busy is routine. |
| `planner failed` (result status `failed`) | OpenRouter rejected or timed out: bad or exhausted key, unknown model id, 429 or 5xx from the provider, model timeout, plan timeout. | The result's `error` field and the error log say which. Check the key and credit in the OpenRouter dashboard, `ULTRATHINK_PLANNING_MODEL`, and `ULTRATHINK_MODEL_TIMEOUT_MS` and `ULTRATHINK_PLAN_TIMEOUT_MS`. A plan interrupted by a restart reports `interrupted`. |
| `budget_exceeded` | The per-run or daily token ceiling was reached (`ULTRATHINK_RUN_TOKEN_CEILING`, `ULTRATHINK_DAILY_TOKEN_CEILING`). The day is a UTC calendar day. | Wait for the next UTC day, or raise the ceiling and restart. The ledger keeps abandoned reservations counted against the ceiling. |
| Service flapping | Bad env file, port in use, failed sandbox call. | `systemctl status` shows the start limit (5 starts in 60 seconds). A `SIGSYS` kill means the syscall filter blocked a call: `journalctl -k \| grep -i seccomp`. Roll back the release (section 4). |

## 8. Suggested alerts

Scrape `127.0.0.1:8795/metrics` (loopback only; nginx does not proxy it). List the series with `curl -s 127.0.0.1:8795/metrics | grep '^# TYPE'`; names below describe the signal, confirm the series name there before writing rules.

| Alert | Condition | Severity |
|---|---|---|
| Service down | External probe of `https://ultrathink.swcstudio.space/healthz` fails twice in a row, or `/readyz` fails for 5 minutes. | Page |
| Restart loop | `systemctl show ultrathink-web -p NRestarts` rises by more than 3 in 10 minutes, or the unit enters `failed`. | Page |
| Server errors | 5xx responses above 2 percent of requests for 10 minutes. | Page |
| Planner failures | Failed plans above 20 percent of started plans for 30 minutes (usually key, credit or provider outage). | Ticket |
| Budget | Daily token spend above 80 percent of `ULTRATHINK_DAILY_TOKEN_CEILING`; any `budget_exceeded` result. | Ticket |
| Auth abuse | 401, 403 or 429 counts more than 10 times their usual rate for 10 minutes; any burst of login failures. | Ticket |
| Planner saturation | Running plans at `ULTRATHINK_MAX_CONCURRENT_PLANS` for more than 15 minutes. | Ticket |
| Dropped series | `ultrathink_metrics_dropped_total` increases (label cardinality abuse). | Ticket |
| Backups | Newest file in `/var/backups/ultrathink` older than 36 hours; `ultrathink-maintenance.service` in `failed`. | Ticket |
| Disk | `/var/lib/ultrathink` or `/var/backups/ultrathink` filesystem above 80 percent. | Ticket |
| Certificate | Edge or origin certificate expires in under 14 days (`certbot renew --dry-run` monthly). | Ticket |

## 9. Cloudflare settings to check

- SSL/TLS mode **Full (strict)**; minimum TLS version 1.2; Always Use HTTPS on.
- The DNS record for `ultrathink` is proxied (orange cloud). The origin vhost returns 403 to every non-Cloudflare peer, so an unproxied record breaks the service.
- **Authenticated Origin Pulls** (optional extra layer): enable it in SSL/TLS, Origin Server. Then download Cloudflare's origin pull CA, store it at `/etc/ssl/cloudflare/authenticated_origin_pull_ca.pem`, and add `ssl_client_certificate /etc/ssl/cloudflare/authenticated_origin_pull_ca.pem;` and `ssl_verify_client on;` to the 443 server block. Test with `nginx -t` and a request through Cloudflare before reloading in production. Leave it off if other tooling needs to reach the origin directly.
- A host firewall allowing TCP 443 only from the Cloudflare ranges for this IP is a further optional layer; keep it in step with the range list in the nginx conf.
- **Rate limiting rules** (in addition to nginx): `/login` about 10 requests per minute per IP with a block action; `/oauth/*` about 60 per minute; `/mcp` about 300 per minute.
- **WAF**: managed rules on. Do not apply Bot Fight Mode, JS challenges or browser integrity checks to `/mcp`, `/oauth/*` and `/.well-known/*`: MCP clients are servers, not browsers, and a challenge page breaks the OAuth flow.
- **Caching**: bypass cache for the whole hostname. No responses from this service may be cached.
- Do not enable an Access or redirect-to-login rule on this hostname (a past edge login gate redirected every path to `/login` and hid the origin).

## 10. Data retention

| Data | Location | Contents | Retention |
|---|---|---|---|
| Runs, phases, token ledger | `/var/lib/ultrathink/ultrathink.sqlite` | Request text, phase output, token reservations | None in the application today: rows are never deleted. Disk growth is the only limit; watch the disk alert. Covered by backups. |
| OAuth state | `/var/lib/ultrathink/oauth.json` | Registered clients, grants, token records | Pruned by the OAuth module (expired codes and tokens, unused clients). Access tokens live 1 hour, refresh tokens 30 days. |
| Client-driven sessions | `/var/lib/ultrathink/journal/<session>/` | Prompts, pending questions, answers, metadata | `ULTRATHINK_RETENTION_DAYS` (default 30) after the last change, enforced by the daily maintenance job. |
| Sessions | `/var/lib/ultrathink/sessions/` | Session records (request, specification) | Same 30 days. |
| Server planning jobs | `/var/lib/ultrathink/jobs/` | Job records and plan output | Same 30 days; included in backups. |
| Scratch | `/var/lib/ultrathink/cwd/`, `home/` | Empty working directory and `$HOME` | Not pruned; hold no user data. |
| Backups | `/var/backups/ultrathink/` | Database, `oauth.json`, `jobs/` | 14 daily archives locally; the rsync target sets its own retention. Archives contain prompts and OAuth secrets. |
| Logs and metrics | journald, `/metrics` | Structured access and error logs without prompt text, secrets or tokens; counters | Per journald configuration (`journalctl --disk-usage`; set `SystemMaxUse` if needed). |
| Provider side | OpenRouter and the model provider | Prompts and outputs of server-side plans | Governed by the provider's policy and your OpenRouter privacy settings. |

## 11. Residual risks

Known gaps that are accepted for now. Each has an owner decision pending.

- **Global owner-login lockout (S4).** Failed owner logins from anyone count toward one shared limit, so an attacker spreading guesses over several addresses can lock the owner out of `/login` for the window. nginx limits `/login` per client address, which narrows but does not remove this. Recovery: wait for the window or restart the service (the limiter is in memory).
- **Web sessions are not revocable (S5).** A session cookie is an HMAC over its expiry; logout only clears the browser copy. A stolen cookie works for the full 12 hours. Mitigation: rotate `ULTRATHINK_SESSION_SECRET` (section 6).
- **Cookie name has no `__Host-` prefix (S6).** The cookie has `HttpOnly`, `SameSite=Strict` and `Secure`, but a sibling subdomain could still set a cookie with the same name.
- **The in-memory limiter refuses new keys when full (S8).** At 10,000 tracked keys with nothing expired, new keys are rejected. A rotating-source attacker could therefore cause 429 for new addresses until entries expire; nginx limits and Cloudflare rules reduce the chance.
- **Client ID Metadata Documents are not implemented.** Clients that identify themselves by a metadata URL instead of dynamic registration cannot connect. Dynamic client registration (RFC 7591) is the supported path.
- **`POST /ultrathink` run API has no worker.** The web run API queues runs but nothing executes them (`ultrathink-worker.service` is a draft with a missing entrypoint). Server-side planning for chat clients runs inside `ultrathink-web` instead; do not tell users the run API works.
- **SQLite has no retention.** Run history and the token ledger grow without bound; abandoned ledger reservations keep counting against ceilings.
- **Smoke tests run unsandboxed.** The release script's smoke start uses the production secrets as the service user without the systemd sandbox, on loopback port 8796 for a few seconds.
