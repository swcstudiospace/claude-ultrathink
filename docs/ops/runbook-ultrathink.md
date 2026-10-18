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
   useradd --system --user-group --no-create-home --home-dir /var/lib/ultrathink --shell /usr/sbin/nologin ultrathink
   install -d -m 0755 /opt/ultrathink /opt/ultrathink/bin /opt/ultrathink/releases
   install -d -m 0700 -o ultrathink -g ultrathink /var/backups/ultrathink
   ```

2. Pin Bun outside any home directory (copied, not symlinked, so the service does not depend on `/root`), and record the version in your change log:

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

6. Build and start the first release with the release script (section 3), then enable everything. When the host still runs the old root-owned service, do not use the script for the first release: follow "First cutover from the old root service" below instead.

   ```bash
   install -m 0644 deploy/ultrathink-tmpfiles.conf /etc/tmpfiles.d/ultrathink.conf && systemd-tmpfiles --create /etc/tmpfiles.d/ultrathink.conf
   systemctl enable ultrathink-web
   systemctl enable --now ultrathink-maintenance.timer
   ```

7. Verify from outside: `curl -s https://ultrathink.swcstudio.space/healthz` returns 200. Verify the origin is closed to direct clients: `curl -s --resolve ultrathink.swcstudio.space:443:187.77.130.10 https://ultrathink.swcstudio.space/healthz` returns `{"error":"forbidden"}` with status 403.
8. Run the sandbox audit and read the exposure score: `systemd-analyze security ultrathink-web`.

### First cutover from the old root service

The release script's probes need `/readyz`, which the old code lacks, and its restart step assumes the new unit is already installed. The very first move from the root-run service (code in the working tree under `/root`, state owned by root) is therefore done by hand. Steps 1 and 2 above (user, directories, pinned Bun) come first. `$REPO` is the git checkout; `$REF` is the commit to release.

1. Build the release directory, the same way the script does:

   ```bash
   sha=$(git -C "$REPO" rev-parse --verify "$REF^{commit}")
   rel=/opt/ultrathink/releases/${sha:0:12}-$(date -u +%Y%m%dT%H%M%SZ)
   mkdir "$rel" && git -C "$REPO" archive --format=tar "$sha" | tar -x -C "$rel"
   printf '%s\n' "$sha" >"$rel/REVISION"
   chown -R root:root "$rel" && chmod -R go+rX,go-w "$rel"
   (cd "$rel" && env -i PATH=/usr/bin:/bin HOME=/tmp /opt/ultrathink/bin/bun test services/ultrathink)
   ```

2. Run a canary: the real unit under another name, on port 8796, with its own empty state directory, while the old service keeps serving. The production env file is reused, so the canary can reach OpenRouter; do not start a plan on it.

   ```bash
   printf 'ULTRATHINK_PORT=8796\nULTRATHINK_STATE_DIR=/var/lib/ultrathink-canary\n' >/etc/ultrathink/canary.env
   chmod 0600 /etc/ultrathink/canary.env
   sed -e "s#/opt/ultrathink/current#$rel#g" \
       -e 's#/var/lib/ultrathink#/var/lib/ultrathink-canary#g' \
       -e 's#^StateDirectory=ultrathink$#StateDirectory=ultrathink-canary#' \
       -e 's#^SyslogIdentifier=.*#SyslogIdentifier=ultrathink-canary#' \
       -e '/^Documentation=/d' -e '/^\[Install\]/,$d' \
       -e '/^EnvironmentFile=/a EnvironmentFile=/etc/ultrathink/canary.env' \
       deploy/ultrathink-web.service >/etc/systemd/system/ultrathink-canary.service
   systemctl daemon-reload && systemctl start ultrathink-canary
   curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8796/healthz
   curl -s -w '\n%{http_code}\n' http://127.0.0.1:8796/readyz
   journalctl -u ultrathink-canary -n 30 --no-pager
   ```

   Both probes must be 200. A start that dies with `SIGSYS` means the syscall filter blocked a call (section 7). Then remove the canary: `systemctl stop ultrathink-canary; rm /etc/systemd/system/ultrathink-canary.service /etc/ultrathink/canary.env; rm -rf /var/lib/ultrathink-canary; systemctl daemon-reload`.

3. Back up everything the cutover touches (the service is stopped first, so the SQLite files are consistent), then switch:

   ```bash
   bak=/var/backups/ultrathink-cutover-$(date -u +%Y%m%dT%H%M%SZ)
   install -d -m 0700 "$bak"
   systemctl stop ultrathink-web
   cp -a /etc/systemd/system/ultrathink-web.service /etc/ultrathink "$bak"/
   cp -a /etc/nginx/sites-available/ultrathink.swcstudio.space "$bak"/
   cp -a /var/lib/ultrathink "$bak"/state
   chown -R ultrathink:ultrathink /var/lib/ultrathink && chmod 0700 /var/lib/ultrathink
   find /var/lib/ultrathink -type f -exec chmod 0600 {} +
   ln -sfn "$rel" /opt/ultrathink/current
   install -m 0644 deploy/ultrathink-web.service deploy/ultrathink-maintenance.service deploy/ultrathink-maintenance.timer /etc/systemd/system/
   systemctl daemon-reload && systemctl start ultrathink-web
   curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8795/healthz
   curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8795/readyz
   ```

   Then install the nginx conf (step 5), verify from outside (step 7), `systemctl enable ultrathink-web`, and `systemctl enable --now ultrathink-maintenance.timer` (install the tmpfiles entry first, as in step 6). Later deploys use the release script, which treats this release as `current`.

4. Rollback of the cutover: `systemctl stop ultrathink-web`, restore the old unit with `cp -a "$bak"/ultrathink-web.service /etc/systemd/system/`, `systemctl daemon-reload`, `systemctl start ultrathink-web`. The old unit still points at the working tree under `/root`, which the cutover did not modify, and root can read the service-owned state. If the new code changed state the old code cannot read, also restore it: `rm -rf /var/lib/ultrathink && cp -a "$bak"/state /var/lib/ultrathink`. Restore the nginx conf from `$bak` if it was already replaced, then `nginx -t && systemctl reload nginx`.

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
| `ultrathink-maintenance.service` fails with `status=226/NAMESPACE` ("Failed to set up mount namespacing: /var/backups/ultrathink: No such file or directory") | The backup directory does not exist. systemd builds the `ReadWritePaths=` mount namespace before any `ExecStartPre=` runs, so the unit cannot create it itself. | `install -m 0644 deploy/ultrathink-tmpfiles.conf /etc/tmpfiles.d/ultrathink.conf && systemd-tmpfiles --create /etc/tmpfiles.d/ultrathink.conf`, then start the unit again. |
| Service flapping | Bad env file, port in use, failed sandbox call. | `systemctl status` shows the start limit (5 starts in 60 seconds). A `SIGSYS` kill means the syscall filter blocked a call: `journalctl -k \| grep -i seccomp`. Roll back the release (section 4). |

## 8. Suggested alerts

Scrape `127.0.0.1:8795/metrics` (loopback only; nginx does not proxy it). List the series and label values with `curl -s 127.0.0.1:8795/metrics`. Series:

| Series | Labels | Meaning |
|---|---|---|
| `ultrathink_http_requests_total` | `endpoint`, `status_class` | HTTP requests handled |
| `ultrathink_http_request_duration_seconds` | `endpoint` (histogram) | Request latency; `/mcp` long-polls up to 40 s per `ultrathink_result` poll, so judge it separately |
| `ultrathink_mcp_tool_calls_total` | `tool`, `outcome` | MCP tool calls and their result |
| `ultrathink_auth_failures_total` | `kind` | Failed logins, bearer tokens and connector keys |
| `ultrathink_rate_limited_total` | `scope` | Requests refused by an in-app limiter |
| `ultrathink_plan_jobs_total` | `status` | Server-side plan jobs by final status |
| `ultrathink_planner_calls_total` | `outcome` | OpenRouter model calls by outcome (including `timeout`) |
| `ultrathink_planner_call_duration_seconds` | histogram | Duration of one model call |
| `ultrathink_plan_tokens_total` | `direction` | Planner tokens (input and output) |
| `ultrathink_plan_cost_usd_total` | none | Planner spend reported by OpenRouter |
| `ultrathink_planner_enabled` | none | 1 when server-side planning is configured |
| `ultrathink_build_info` | `version` | Constant 1; identifies the running version |
| `ultrathink_metrics_dropped_total` | none | Series dropped by the cardinality cap |

A counter appears only after its first increment, so a fresh process, a quiet hour or a never-failed status shows no series at all. Write ratio and rate alerts so that an absent series counts as zero (in PromQL, `or vector(0)`), and alert on absence only for series that must always exist: `ultrathink_build_info` and `ultrathink_planner_enabled` (gauges set at start), plus the external probes. Counters reset at every restart; use `rate` and `increase`, never raw values. The metrics are in memory: a restart or deploy clears them.

| Alert | Condition | Severity |
|---|---|---|
| Service down | External probe of `https://ultrathink.swcstudio.space/healthz` fails twice in a row, or `/readyz` fails for 5 minutes; `ultrathink_build_info` absent from the scrape for 2 minutes. | Page |
| Restart loop | `systemctl show ultrathink-web -p NRestarts` rises by more than 3 in 10 minutes, or the unit enters `failed`. `ultrathink_build_info{version}` changing outside a deploy window is also a restart signal. | Page |
| Server errors | `ultrathink_http_requests_total{status_class="5xx"}` above 2 percent of all requests for 10 minutes. | Page |
| Slow requests | p95 of `ultrathink_http_request_duration_seconds` above 5 s for 10 minutes on every endpoint except `/mcp`; for `/mcp` above 60 s. | Ticket |
| Tool failures | `ultrathink_mcp_tool_calls_total` with an error outcome above 20 percent of calls for 30 minutes. | Ticket |
| Planner timeouts | `ultrathink_planner_calls_total{outcome="timeout"}` increases, or `ultrathink_planner_call_duration_seconds` p95 approaches `ULTRATHINK_MODEL_TIMEOUT_MS`. A timeout is not retried and fails the whole plan. Find the call with `journalctl -u ultrathink-web -o cat \| grep '"event":"planner_call"'`. | Ticket |
| Planner failures | `ultrathink_plan_jobs_total{status="failed"}` above 20 percent of finished jobs for 30 minutes (usually key, credit, provider outage or model timeout). | Ticket |
| Planner disabled | `ultrathink_planner_enabled == 0` when server-side planning is expected (key or model missing from the env file). | Ticket |
| Budget | `increase(ultrathink_plan_cost_usd_total[24h])` above 80 percent of the daily spend you accept; `ultrathink_plan_tokens_total` summed over both directions above 80 percent of `ULTRATHINK_DAILY_TOKEN_CEILING` for the UTC day; any `budget_exceeded` result in the logs. | Ticket |
| Auth abuse | `ultrathink_auth_failures_total` or `ultrathink_rate_limited_total` more than 10 times their usual rate for 10 minutes; any burst of login failures. | Ticket |
| Planner saturation | Busy refusals from the planner, or jobs at `ULTRATHINK_MAX_CONCURRENT_PLANS` for more than 15 minutes. | Ticket |
| Dropped series | `increase(ultrathink_metrics_dropped_total[1h]) > 0` (label cardinality abuse). | Ticket |
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

## 12. Planner latency and model choice

The planner calls OpenRouter once per pipeline stage: uplift, graph, one Chain of Thought call per graph node, then clarify. That is about 9 to 11 calls per plan. Nodes run level by level because a node depends on the nodes before it, so the calls are sequential within a level and the total time is the sum of the levels, not of the nodes.

Measured on this VPS on 2026-10-18, one prompt, reasoning effort low:

| Model | Plan time | Cost per plan |
|---|---|---|
| gemini-3.6-flash | 44 s | 0.051 USD |
| grok-4.3 | 62 s | 0.036 USD |
| gpt-5.6-luna | 65 s | 0.018 USD |
| claude-haiku-4.5 | 111 s | 0.089 USD |
| grok-4.7 | 138 s | 0.153 USD |

At the provider's default reasoning effort, grok-4.7 did not finish in 6 minutes. One prompt on one day is an indication, not a benchmark: re-measure after a model or prompt change. Keep the effort low unless plan quality demands more and the timeouts below are raised with it.

| Variable | Default | Effect |
|---|---|---|
| `ULTRATHINK_PLANNING_MODEL` | none (planning off without it) | OpenRouter model id used for every stage |
| `ULTRATHINK_MODEL_REASONING_EFFORT` | `low` | Reasoning effort sent with each call; the main lever on latency and cost |
| `ULTRATHINK_MODEL_TIMEOUT_MS` | 240000 | Per model call. A call that exceeds it is not retried: it fails with `timeout` and the whole plan ends as `failed`. Only 429, 5xx and network errors are retried (up to 2 times) |
| `ULTRATHINK_PLAN_TIMEOUT_MS` | 600000 | Whole plan; a plan over this ends as `failed` |
| `ULTRATHINK_MAX_CONCURRENT_PLANS` | 2 | Plans running at once; further starts are refused as busy |
| `ULTRATHINK_RUN_TOKEN_CEILING` | see `config.ts` | Token ceiling for one run |
| `ULTRATHINK_DAILY_TOKEN_CEILING` | see `config.ts` | Token ceiling per UTC day |

The default per-call timeout is 240 s because grok-4.7 writes about 45 tokens per second, so its single large specification call takes 110 to 120 s; a timeout close to that would fail healthy plans. Every model call is logged as a `planner_call` event (fields `sessionId`, `model`, `ms`, `outcome`, `attempts`, `usage`) and counted in `ultrathink_planner_calls_total{outcome}` and `ultrathink_planner_call_duration_seconds`; use them to see which stage is slow before raising a timeout.

Chat clients wait through long polling (`ultrathink_result` waits up to 40 s per poll), so a plan of a few minutes is normal; a plan that needs more than the 10 minute limit will never complete.

Switching models safely:

1. Edit `/etc/ultrathink/ultrathink.env` with `sudoedit` (mode stays 0600): change `ULTRATHINK_PLANNING_MODEL` and, if needed, `ULTRATHINK_MODEL_REASONING_EFFORT`. Keep the old line as a comment until the check passes.
2. `systemctl restart ultrathink-web`, then confirm `curl -s http://127.0.0.1:8795/readyz` is 200 and `ultrathink_planner_enabled` is 1.
3. Run one plan from a chat client with a short prompt.
4. Check the cost and size of that plan: `curl -s http://127.0.0.1:8795/metrics | grep ultrathink_plan_` (`ultrathink_plan_cost_usd_total`, `ultrathink_plan_tokens_total`; the counters start from zero at the restart, so the values are that plan), and inspect the job file under `/var/lib/ultrathink/jobs/` (as root; it holds the request and the plan) for the status, usage and any error.
5. If the plan failed, was slow, or cost more than expected, restore the old line and restart again. If it passed, delete the commented old line.
