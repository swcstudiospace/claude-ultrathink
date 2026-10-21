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

4. Check `/etc/ultrathink/ultrathink.env` (mode 0600, owner root). Variables: `ULTRATHINK_PUBLIC_ORIGIN`, `ULTRATHINK_SESSION_SECRET`, `ULTRATHINK_OWNER_PASSWORD_HASH`, `ULTRATHINK_CONNECTOR_KEY`, `ULTRATHINK_PLANNING_MODEL` (for example `x-ai/grok-4.7`), `OPENROUTER_API_KEY`, and optionally the limits listed in `services/ultrathink/config/config.ts`. The owner hash must be argon2id (see section 6); the service refuses to start when it is not an argon2 or bcrypt hash, and when `ULTRATHINK_PUBLIC_ORIGIN` has a path, query or credentials (a trailing slash is dropped). Check the variable names without printing values:

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

- `ultrathink.sqlite` copied with `VACUUM INTO` (consistent while the service runs; the `sqlite3` CLI is not needed), `oauth.json`, and the `jobs/`, `sessions/` and `journal/` directories (saved plans and client-driven sessions live in the last two), with `PRAGMA integrity_check` on the copy and a `SHA256SUMS` file.
- Archive `/var/backups/ultrathink/ultrathink-<utc>.tar.gz` (mode 0600 in a 0700 directory), 14 kept.
- Optional rsync when `ULTRATHINK_BACKUP_RSYNC_TARGET` is set in the env file. For ssh targets put the private key `id_ed25519` and a `known_hosts` file in `/var/lib/ultrathink/home/.ssh` (directory mode 0700, owner `ultrathink`); the script passes both paths to ssh explicitly because OpenSSH ignores `$HOME`. The archive contains prompts and OAuth secrets: use an encrypted or trusted target.
- Retention: `journal/`, `sessions/` and `jobs/` entries, and the root-level `last.json` and `last-plan.json` plan copies, untouched for `ULTRATHINK_RETENTION_DAYS` (default 30) are deleted; newer entries are not touched. SQLite runs not updated within the same window are deleted with their phases and ledger rows in one transaction; the job prints `database retention: removed N runs, M ledger rows`. `deploy/ultrathink-backup.sh prune` runs only the retention part. In `run` the three steps (backup, file retention, database retention) are independent: a failed backup marks the unit failed but retention still runs. A backup killed before it could clean up leaves a `.work.*` staging directory in the backup directory; the next backup removes those older than a day.

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
   mkdir -p "$scratch/state" && cp -a "$scratch"/ultrathink-*/ultrathink.sqlite "$scratch"/ultrathink-*/oauth.json "$scratch/state/"
   for d in jobs sessions journal; do [ -d "$scratch"/ultrathink-*/"$d" ] && cp -a "$scratch"/ultrathink-*/"$d" "$scratch/state/"; done
   chown -R ultrathink:ultrathink "$scratch" && chmod 0700 "$scratch"
   # Start with the production env file and the scratch state on port 8797; see the env parsing in deploy/ultrathink-release.sh.
   ```

   Probe `http://127.0.0.1:8797/readyz` and stop the instance.
3. Real restore: `systemctl stop ultrathink-web`; move the damaged `ultrathink.sqlite*` aside; copy `ultrathink.sqlite`, `oauth.json` and the `jobs/`, `sessions/` and `journal/` directories from the extracted archive into `/var/lib/ultrathink` with `cp -a` (the saved plans and client-driven sessions live in `sessions/` and `journal/`; `jobs/` alone restores status only; `BACKUP_INFO` in the archive lists which directories it holds); `chown -R ultrathink:ultrathink /var/lib/ultrathink`; `find /var/lib/ultrathink -type f -exec chmod 0600 {} +`; `systemctl start ultrathink-web`; probe `/readyz`. Removing stale `ultrathink.sqlite-wal` and `-shm` files before the copy is required.
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

`/healthz` is liveness only (the process answers and the database responds). `/readyz` reports whether the service can do work (database ping, state directory writable, OAuth state readable). Through the edge, a 503 whose body is exactly `{"error":"unavailable"}` with `Retry-After: 60` is nginx saying the upstream is down or timed out (it turns an upstream 502 or 504 into that 503). Any other 503 body comes from the app and is passed through unchanged (`persistence_unavailable` with a `correlationId`, `/readyz` `not_ready`, OAuth `temporarily_unavailable`).

Logs are one JSON object per line with `ts`, `level`, `event` and, for requests, a request id (also returned to the client as `X-Request-Id`), HTTP method and path, status, duration, JSON-RPC method, tool name, auth kind and client address. Error logs carry the `correlationId` that appears in a 500 response body. To follow one request: take the `X-Request-Id` (or `correlationId`) from the client, then `journalctl -u ultrathink-web -o cat | grep <id>`. Secrets, tokens, cookies and authorization headers are dropped from log fields by design. The exact event names are defined in `services/ultrathink/routes/router.ts`; list them with `journalctl -u ultrathink-web -o cat | grep -o '"event":"[^"]*"' | sort | uniq -c | sort -rn`.

Request lines for `/mcp` also carry `mcpVersion` (the `MCP-Protocol-Version` header exactly as the client sent it, cut to a short length; absent when the client sent none) and `rpcMethod` (the JSON-RPC method of the body, or `batch`), and `tool` on `tools/call`. A request refused for an unknown protocol version still logs its `rpcMethod`. Section 13 shows how to read them.

Common symptoms:

| Symptom | Usual cause | Check and action |
|---|---|---|
| 401 on `/mcp` | No bearer, expired or revoked token, wrong connector key. `WWW-Authenticate` carries `error="invalid_token"` when a token was sent but not accepted. | The client should refresh or re-run OAuth. For Grok Bot compare the key (section 6). Absent token plus 401 is normal for the first request of an OAuth flow. |
| 403 with `{"error":"forbidden"}` from nginx | The TCP peer is not a Cloudflare address (direct hit, or the Cloudflare range list is stale). | Refresh the ranges in the nginx conf (instructions at the top of the file). |
| 403 from the app on `/mcp` | `Origin` header not in the allow list. | Add the origin to `ULTRATHINK_ALLOWED_ORIGINS` and restart. Requests without an Origin header are allowed. |
| 429 | Rate limit. An nginx 429 carries the default nginx error page; an app 429 comes from the service itself (it logs the limit that fired). nginx limits: login 5 per minute, OAuth 30, `/mcp` 120, per real client address. | If many users share one address, raise the nginx rate. If every client is limited, real-IP is broken: check that `CF-Connecting-IP` reaches nginx and that the Cloudflare ranges are current. |
| 503 with `{"error":"unavailable"}` and `Retry-After: 60` | nginx: the upstream is down, restarting or timing out (it saw a 502 or 504). | `systemctl status ultrathink-web`, `journalctl -u ultrathink-web`, and the release (section 4). |
| 503 with any other body | The app itself (nginx does not rewrite it): not ready (`/readyz` lists the failing check), persistence unavailable (the body carries a `correlationId`), or the planner is busy (`maxConcurrentPlans` jobs running). | Check `journalctl`, `/readyz`, and wait for running plans; raise `ULTRATHINK_MAX_CONCURRENT_PLANS` (1 to 8) if busy is routine. |
| `planner failed` (result status `failed`) | OpenRouter rejected or timed out: bad or exhausted key, unknown model id, 429 or 5xx from the provider, model timeout, plan timeout. | The result's `error` field and the error log say which. Check the key and credit in the OpenRouter dashboard, `ULTRATHINK_PLANNING_MODEL`, and `ULTRATHINK_MODEL_TIMEOUT_MS` and `ULTRATHINK_PLAN_TIMEOUT_MS`. A plan interrupted by a restart reports `interrupted`. |
| `budget_exceeded` | The per-run or daily token ceiling was reached (`ULTRATHINK_RUN_TOKEN_CEILING`, `ULTRATHINK_DAILY_TOKEN_CEILING`). The day is a UTC calendar day. | Wait for the next UTC day, or raise the ceiling and restart. The ledger keeps abandoned reservations counted against the ceiling. |
| `ultrathink-maintenance.service` fails with `status=226/NAMESPACE` ("Failed to set up mount namespacing: /var/backups/ultrathink: No such file or directory") | The backup directory does not exist. systemd builds the `ReadWritePaths=` mount namespace before any `ExecStartPre=` runs, so the unit cannot create it itself. | `install -m 0644 deploy/ultrathink-tmpfiles.conf /etc/tmpfiles.d/ultrathink.conf && systemd-tmpfiles --create /etc/tmpfiles.d/ultrathink.conf`, then start the unit again. |
| Service flapping | Bad env file, port in use, failed sandbox call. | `systemctl status` shows the start limit (5 starts in 60 seconds). A `SIGSYS` kill means the syscall filter blocked a call: `journalctl -k \| grep -i seccomp`. Roll back the release (section 4). |
| A client connects, then lists no tools or never calls any | The probe was refused and the client did not fall back, the tool list is stale (Grok caches it), or the rate limit fired. | Read the first connection in the request log (section 13). Grok only refreshes its tool list on re-authentication. |

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
| Runs, phases, token ledger | `/var/lib/ultrathink/ultrathink.sqlite` | Request text, phase output, token reservations | `ULTRATHINK_RETENTION_DAYS` (default 30) after the run's last update, any status (a run stuck waiting for 30 days is removed too), with every row that references it (phases, ledger rows, and any other table with a foreign key to `runs`: child tables are found through foreign keys, so a new table is covered automatically), deleted in one transaction by the daily maintenance job. The daily token ceiling only counts today's UTC rows, so pruning does not change it; a run with a ledger row dated today is never pruned. Run text includes user prompts, so this is also the privacy window. Covered by backups, which keep older rows for up to 14 days. |
| OAuth state | `/var/lib/ultrathink/oauth.json` | Registered clients, grants, token records | Pruned by the OAuth module (expired codes and tokens, unused clients). Access tokens live 1 hour, refresh tokens 30 days. |
| Client-driven sessions | `/var/lib/ultrathink/journal/<session>/` | Prompts, pending questions, answers, metadata | `ULTRATHINK_RETENTION_DAYS` (default 30) after the last change, enforced by the daily maintenance job; included in backups. |
| Sessions | `/var/lib/ultrathink/sessions/` | Session records (request, specification) | Same 30 days; included in backups. The root `last.json` and `last-plan.json` copies of the latest plan follow the same window. |
| Server planning jobs | `/var/lib/ultrathink/jobs/` | Job records and plan output | Same 30 days; included in backups. |
| Scratch | `/var/lib/ultrathink/cwd/`, `home/` | Empty working directory and `$HOME` | Not pruned; hold no user data. |
| Backups | `/var/backups/ultrathink/` | Database, `oauth.json`, `jobs/`, `sessions/`, `journal/` | 14 daily archives locally; the rsync target sets its own retention. Archives contain prompts and OAuth secrets. |
| Logs and metrics | journald, `/metrics` | Structured access and error logs without prompt text, secrets or tokens; counters | Per journald configuration (`journalctl --disk-usage`; set `SystemMaxUse` if needed). |
| Provider side | OpenRouter and the model provider | Prompts and outputs of server-side plans | Governed by the provider's policy and your OpenRouter privacy settings. |

## 11. Residual risks

Known gaps that are accepted for now. Each has an owner decision pending.

- **Global owner-login lockout (S4).** Failed owner logins from anyone count toward one shared limit, so an attacker spreading guesses over several addresses can lock the owner out of `/login` for the window. nginx limits `/login` per client address, which narrows but does not remove this. Recovery: wait for the window or restart the service (the limiter is in memory).
- **Web sessions are not revocable (S5).** A session cookie is an HMAC over its expiry; logout only clears the browser copy. A stolen cookie works for the full 12 hours. Mitigation: rotate `ULTRATHINK_SESSION_SECRET` (section 6).
- **Cookie name has no `__Host-` prefix (S6).** The cookie has `HttpOnly`, `SameSite=Strict` and `Secure`, but a sibling subdomain could still set a cookie with the same name.
- **The in-memory limiter refuses new keys when full (S8).** At 10,000 tracked keys with nothing expired, new keys are rejected. A rotating-source attacker could therefore cause 429 for new addresses until entries expire; nginx limits and Cloudflare rules reduce the chance.
- **Client ID Metadata Documents are not implemented.** Clients that identify themselves by a metadata URL instead of dynamic registration cannot connect. Dynamic client registration (RFC 7591) is the supported path.
- **`POST /ultrathink` run API has no worker.** The web run API queues runs but nothing executes them (there is no worker entrypoint and no worker unit is shipped). Server-side planning for chat clients runs inside `ultrathink-web` instead; do not tell users the run API works.
- **Abandoned ledger reservations count until pruned.** A run that never finished keeps its reserved tokens against the per-run and daily ceilings of its own day; the daily job removes the rows after the retention window.
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

## 13. Connector surface and diagnostics

Status: the connector has never been connected to Claude chat, Claude Code or Grok Chat in a live session. Until it has, the first connection from each client is the evidence, and this section is how to read it. Nothing here claims a client behavior that the logs have not shown.

### Inventory

| Item | Value |
|---|---|
| Tools in server mode | 10: `ultrathink_uplift`, `ultrathink_plan`, `ultrathink_pending`, `ultrathink_show`, `ultrathink_answer`, `ultrathink_status`, `ultrathink_result`, `ultrathink_graph`, `ultrathink_sessions`, `ultrathink_command`. Server mode is on when `ultrathink_planner_enabled` is 1. |
| Tools without server planning, and on stdio | 9: the same without `ultrathink_uplift`. |
| Connector tools | `ultrathink_graph` (`/ultrathink-think`), `ultrathink_sessions` (`/ultrathink-status`, first step of `/ultrathink-last`) and `ultrathink_command` (every other `/ultrathink-<name>`). They are always listed, so a client that never refreshes `tools/list` cannot miss them. |
| Prompts | 6: `ultrathink`, `ultrathink-plan`, `ultrathink-think`, `ultrathink-last`, `ultrathink-status`, `ultrathink-quick`. The 16 unsupported commands are not listed; `prompts/get` for one returns an explanation. A prompt returns text and runs no tool. |
| Resource | 1: `ui://ultrathink/graph` (name `ultrathink-graph`, MIME `text/html;profile=mcp-app`), a self-contained HTML card of at most 512 KiB, served with an empty content security policy (`csp: {}`), no `domain` and `prefersBorder: false`. The app loads nothing external. `resources/templates/list` returns an empty list. |
| Capabilities in `initialize` | `tools`, `prompts` and `resources`, plus the extension `io.modelcontextprotocol/ui`, announced unconditionally because claude.ai web is reported to render MCP Apps without sending the extension itself. No `listChanged`, no subscriptions, no logging. |
| Protocol versions | `2025-11-25`, `2025-06-18` and `2025-03-26`. `initialize` answers the requested version when it is listed, otherwise `2025-11-25`. A request with no `MCP-Protocol-Version` header is treated as `2025-03-26`. Any other header value, including `2026-07-28`, gets HTTP 400 with JSON-RPC error `-32600` `unsupported MCP-Protocol-Version`. JSON-RPC batches get 400 from `2025-06-18`. `2026-07-28` is not served and `server/discover` answers `-32601`. |
| Errors | A `resources/read` for an unknown `ui://` uri returns `-32002`; a malformed uri returns `-32602`. `GET` and `DELETE` on `/mcp` return 405 with `Allow: POST`, before authentication. |
| Command catalog | Read from `commands/` and `skills/` in the release, with the decision per command in `COMMAND_OVERLAY` (`services/ultrathink/mcp/commands.ts`). A release without those directories serves the static overlay and logs a `command_catalog_fallback` warning at start. |
| Plugin bundle | `plugins/ultrathink-connector/`, built with `sh plugins/ultrathink-connector/package.sh` into a zip for Claude's plugin upload. Its `.mcp.json` points at the production URL and holds no key. |

Metrics: `ultrathink_mcp_tool_calls_total{tool,outcome}` carries the three new tool names.

### Read a first Claude or Grok connection

List the MCP and OAuth requests of the last hour, oldest first:

```bash
journalctl -u ultrathink-web --since "1 hour ago" -o cat | grep '"event":"request"' | grep -E '"endpoint":"(mcp|oauth_[a-z_]+)"'
```

Each line has `ts`, `status`, `endpoint`, `rpcMethod`, `mcpVersion`, `tool`, `authKind` (`none`, `bearer` or `connector-key`) and `ip`. The order to expect for a new connector:

1. `POST /mcp` with `status` 401 and `authKind` `none`: the client learns it must sign in. Then `oauth_protected_resource`, `oauth_authorization_server`, `oauth_register` (201), `oauth_authorize` and `oauth_token` requests: the OAuth flow. A 429 on `oauth_register` is the registration limit (below).
2. With a token, the first `POST /mcp` shows which revision the client opens with:
   - **`status` 400 with `mcpVersion` `2026-07-28` and `rpcMethod` `server/discover`, then `status` 200 with `rpcMethod` `initialize` from the same `ip`.** The client probed for the newer revision, read the 400 as "legacy server" and fell back. This is the expected, working case for a client that probes.
   - **`status` 200 `initialize` with no 400 before it.** A legacy-only client. Also working.
   - **`status` 400 and then nothing from that `ip`.** The client treated the 400 as fatal. This is a hard failure: serving `2026-07-28` (a dual-era server) becomes urgent. Keep the log lines as the evidence.
3. After `initialize` expect `notifications/initialized` (202), often a `GET /mcp` that returns 405 (the client's optional event stream; harmless), then `tools/list`, `prompts/list` and perhaps `resources/list` with `mcpVersion` `2025-11-25`. The `initialize` line itself usually has no `mcpVersion`, because the header is sent only after the version is negotiated.
4. Tool use appears as `rpcMethod` `tools/call` with `tool` set. A client that lists tools and never calls one points at the model or the client, not the server.

A 5xx on the probe would be worse than a 400: official SDK clients treat a 5xx or an unusable 2xx on a probe as a hard error. The router answers an unknown `MCP-Protocol-Version` with 400 whatever the body holds, so a probe does not produce one.

### Smoke checklist with curl

Run it on the VPS against `http://127.0.0.1:8795` (or against the public URL). The key goes into a variable and is never printed:

```bash
BASE=http://127.0.0.1:8795
UT_KEY=$(grep -m1 '^ULTRATHINK_CONNECTOR_KEY=' /etc/ultrathink/ultrathink.env | cut -d= -f2-)
rpc() { curl -s "$BASE/mcp" -H "x-connector-key: $UT_KEY" -H 'content-type: application/json' "$@"; }
rpc -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}'
rpc -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
rpc -d '{"jsonrpc":"2.0","id":3,"method":"prompts/list"}'
rpc -d '{"jsonrpc":"2.0","id":4,"method":"resources/list"}'
rpc -d '{"jsonrpc":"2.0","id":5,"method":"resources/read","params":{"uri":"ui://ultrathink/graph"}}'
rpc -d '{"jsonrpc":"2.0","id":6,"method":"tools/call","params":{"name":"ultrathink_sessions","arguments":{}}}'
```

Expected:

1. `initialize`: `result.protocolVersion` `2025-11-25`, capabilities `tools`, `prompts`, `resources` and the `io.modelcontextprotocol/ui` extension, `serverInfo.name` `ultrathink`, and `instructions` text that names `/ultrathink`.
2. `tools/list`: 10 tools (9 when `ultrathink_planner_enabled` is 0). `ultrathink_graph` and `ultrathink_uplift` carry `_meta.ui.resourceUri` `ui://ultrathink/graph`.
3. `prompts/list`: the 6 prompt names above.
4. `resources/list`: one entry, `ui://ultrathink/graph`, MIME `text/html;profile=mcp-app`.
5. `resources/read`: `result.contents[0].text` is an HTML document with the same MIME type. A different `ui://` uri returns error `-32002`.
6. `tools/call`: `isError` false and `structuredContent.text` equal to the content text (the copy Claude Code reads).

The refusal cases, each with its expected status:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$BASE/mcp" -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'            # 401, WWW-Authenticate: Bearer resource_metadata=...
curl -s -i -X GET "$BASE/mcp"                                                                                                                             # 405, Allow: POST
rpc -H 'MCP-Protocol-Version: 2026-07-28' -d '{"jsonrpc":"2.0","id":1,"method":"server/discover"}' -w '\n%{http_code}\n'                                  # 400, -32600 unsupported MCP-Protocol-Version
rpc -d '{"jsonrpc":"2.0","id":1,"method":"server/discover"}'                                                                                              # 200 with -32601 method not found
rpc -H 'MCP-Protocol-Version: 2025-11-25' -d '[{"jsonrpc":"2.0","id":1,"method":"ping"}]' -w '\n%{http_code}\n'                                           # 400, batches are refused from 2025-06-18
```

Finish with `unset UT_KEY`. After a release that changes tools, also check the tool names in `ultrathink_mcp_tool_calls_total` once a client has used them.

### Smoke check of the stdio server

The stdio server needs no running service. From a checkout, send JSON-RPC lines into `bin/ultrathink-connector` with a throwaway state directory:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | ULTRATHINK_STATE_DIR="$(mktemp -d)" bin/ultrathink-connector
```

Expect two JSON lines on stdout and nothing else: an `initialize` result, then a `tools/list` result with 9 tools and no `ultrathink_uplift`. Diagnostics go to stderr (level `warn` by default, `ULTRATHINK_LOG_LEVEL=info` for more) and never include request text. A line that is not JSON gets `-32700`; a line over 1 MiB gets `-32600`. The process exits when stdin ends. Without Bun it exits 127 with an install hint; on Windows use `bun <path>\services\ultrathink\stdio\main.ts`. The same assertions run against the tool host, the HTTP app and a spawned stdio process in `services/ultrathink/mcp/conformance.test.ts`.

### Rate limits that matter for connectors

| Limit | Value | What it looks like |
|---|---|---|
| Client registration (`POST /oauth/register`) | 10 per hour per client address, in memory (a restart clears it). | 429 `temporarily_unavailable` with `Retry-After`. Claude registers a new client on every fresh connection, and Anthropic's connector traffic comes from a fixed address range (160.79.104.0/21 in Anthropic's documentation), so a burst of fresh connections can exhaust the limit for every Claude user. Grok registers through dynamic client registration too. |
| `/mcp` in the app | 120 per minute per client address, and 60 per minute for all connector traffic together (one shared bucket for key and OAuth clients). | 429 `rate_limited` with `Retry-After`, logged as `rate_limited` with `scope` `mcp`. Do not poll `ultrathink_result` with `waitSeconds: 0` in a loop. |
| `/mcp` in nginx | 120 per minute per client address, burst 60. | nginx's default 429 page. |
| OAuth in nginx and the app | nginx 30 per minute (burst 20); the app limits authorize to 30 per minute and token and revoke to 60 per minute. | 429 on the OAuth endpoints. |
| Login | nginx 5 per minute; the app allows 5 attempts per address per 15 minutes. | 429 or a login refusal. |

When registrations are limited, wait for `Retry-After`. Restarting `ultrathink-web` also clears the in-memory limiter, at the cost of a restart. Raising the limit needs a code change (`REGISTER_LIMIT` in `services/ultrathink/oauth/oauth.ts`).

### After changing tools

Grok fetches a connector's tool list once and refreshes it only when the connector is re-authenticated (`https://github.com/xai-org/plugin-marketplace/issues/1402`); tell Grok users to reconnect after any release that changes a tool name, description or schema. Whether claude.ai re-fetches `tools/list` on its own is not verified: have Claude users remove and re-add the connector.

## 14. Audit trail

The audit log is `/var/lib/ultrathink/audit.jsonl` (`ULTRATHINK_STATE_DIR` plus `audit.jsonl`). Each line is one hash-chained record with `seq`, `ts`, `event`, `prev`, `hash` and sanitized `fields`. The file is the source of truth. SIEM sinks get a copy only after the record is fsynced, so a sink never holds a record the chain lost. `ULTRATHINK_AUDIT_LOG=0` turns the log off.

### Environment

| Variable | Default | Allowed |
|---|---|---|
| `ULTRATHINK_AUDIT_ANCHOR_EVERY` | 1000 | integer 1 to 1000000 |
| `ULTRATHINK_AUDIT_SEGMENT_BYTES` | 67108864 (64 MiB) | integer 1048576 to 4294967296 |
| `ULTRATHINK_AUDIT_RETENTION_DAYS` | 365 | integer 0 to 36500; 0 keeps every segment |
| `ULTRATHINK_AUDIT_WATCH_MS` | 1000 | integer 100 to 1000 |
| `ULTRATHINK_AUDIT_SINK_QUEUE` | 10000 | integer 1 to 1000000, per sink |
| `ULTRATHINK_AUDIT_RULES` | built-in rules | JSON array of anomaly rules; replaces the built-ins |
| `ULTRATHINK_AUDIT_HTTP_URL` | unset | `https://`, or `http://` to 127.0.0.1 or localhost; no credentials in the URL |
| `ULTRATHINK_AUDIT_HTTP_TOKEN` | unset | at least 16 printable ASCII characters, no spaces |
| `ULTRATHINK_AUDIT_SYSLOG` | unset | `host:port`, port 1 to 65535 |
| `ULTRATHINK_AUDIT_KAFKA_REST_URL` | unset | same URL rule as the HTTP sink; requires the topic |
| `ULTRATHINK_AUDIT_KAFKA_TOPIC` | unset | requires the REST URL, and the reverse |

An invalid value stops startup with a `ConfigError` that names the variable. The token value is never printed.

### Layout

- **Anchors.** After every `ULTRATHINK_AUDIT_ANCHOR_EVERY` non-anchor records the log appends an `audit_anchor` record, `{through, root}`. `through` is the seq of the record before the anchor. `root` is a Merkle Mountain Range root over every record hash up to `through`, with RFC 6962 domain separation and no duplicated last leaf. An anchor is an ordinary chained record.
- **Segments.** Before an append that would push the active file past `ULTRATHINK_AUDIT_SEGMENT_BYTES`, the active file is sealed: renamed to `audit-<firstSeq>-<lastSeq>.jsonl` in the same directory, mode 0400. The new active `audit.jsonl` starts with `prev` equal to the sealed file's last hash. A single record larger than the limit is still written, and no empty segment is created.
- **Verification** reads the sealed segments and the active file as one chain, with global `seq` numbers.
- **Quarantine.** A broken active file is moved to `audit.jsonl.corrupt-<time>` on open. Nothing prunes `.corrupt-*` files.

### Prune boundary

When `ULTRATHINK_AUDIT_RETENTION_DAYS` is above 0, an hourly sweep calls `prune(now - days)`. It deletes sealed segments oldest first while the segment's last record `ts` is older than the cutoff. It never deletes the active file or `.corrupt-*` files. It then appends `audit_retention_pruned` `{segments, fromSeq, throughSeq, throughHash}`, which carries the anchor frontier, so the remaining chain still verifies and later anchors still cover every record. With nothing eligible, the sweep writes nothing.

A directory whose first remaining segment does not start at seq 1 verifies only when a retained `audit_retention_pruned` record names that segment's `seq - 1` and `prev`. Removing or editing that record makes verification fail.

### Verify and off-host expectations

```bash
bun services/ultrathink/obs/audit-cli.ts verify /var/lib/ultrathink/audit.jsonl
bun services/ultrathink/obs/audit-cli.ts verify /var/lib/ultrathink/audit.jsonl \
  --expect 4210:<hash-from-off-host-copy> --expect 5000:<hash-from-off-host-copy>
```

`--expect <seq>:<hash>` is repeatable. The hash is the record's `hash` field, 64 lowercase hex characters. Exit codes: 0 means the chain is intact and every expectation is met; 1 means the chain is broken or unreadable, or an expectation failed, and prints `audit BROKEN: expected record <seq> hash <hash>, found <found|none>`; 2 is a usage error, including a malformed expectation. A file truncated before a stored record reports `found none`. Store the head pair (the last line's `seq` and `hash`) off-host on a schedule. That pair catches tail truncation and a full-file rewrite (see B5).

### Tamper watch

The watch ticks every `ULTRATHINK_AUDIT_WATCH_MS` (default 1000 ms). Each tick stats the file. If size, mtime and inode match the fingerprint the log wrote itself, nothing is scanned, so the service's own appends never alert. A different fingerprint triggers a full scan across the segments. A broken chain raises `chain_broken`. A disk head (seq, hash) that differs from the head the process acknowledged raises `head_mismatch`, as does a missing file while records exist. Every 60 ticks a full scan runs even when the stat matches.

**Limit.** An in-place edit that keeps size and mtime (for example `touch -r`) is caught by the 60-tick scan: up to 60 seconds at the default interval, not within 1 second. A rewrite made while the service is stopped has no acknowledged head to compare against, and the service accepts the file it finds at start. Only off-host pairs catch that (B5).

A tamper alert is logged as `audit_tamper_detected` at error level, counted in `ultrathink_audit_tamper_alerts_total`, and sent to the sinks as an alert envelope. It is not appended to the chain, because the chain is what is broken. Each reason alerts once until it clears; `audit_tamper_cleared` is then logged.

### Anomaly rules

Built-in rules, used when `ULTRATHINK_AUDIT_RULES` is unset:

| Rule | Event | Count | Window | Keyed by |
|---|---|---|---|---|
| `login_failed` | `login_failed` | 10 | 300 s | `ip` |
| `refresh_reuse_detected` | `refresh_reuse_detected` | 1 | 3600 s | `clientId` |
| `rate_limited` | `rate_limited` | 50 | 300 s | `ip` |

A key alerts at most once per window, and each rule tracks at most 10000 keys. A match appends `anomaly_detected` `{rule, key, count, windowSec}` after the triggering record, increments `ultrathink_audit_anomalies_total{rule}`, and sends an alert envelope. Audit's own events never count toward a rule.

### Stream sinks

Each configured sink receives three envelope kinds: `audit` (every acknowledged record, anchors included), `security` (security events, with only the top-level fields `type, name, severity, source, ip, userId, resource, action, correlationId, timestamp`; `details` and `userAgent` are dropped), and `alert` (tamper and anomaly). Syslog frames are RFC 5424 with RFC 6587 octet-counting over TCP, with PRI 134 for audit, 132 for security and 130 for alert. UDP is not offered.

Each sink has its own queue of `ULTRATHINK_AUDIT_SINK_QUEUE` envelopes, so a slow sink does not hold back another. When a queue is full, the oldest queued envelope is dropped. Batches hold at most 100 envelopes and keep their order. Retryable failures (network errors, 408, 425, 429, 5xx) are retried up to 5 attempts, with a 500 ms backoff that doubles to a 30 s cap; a batch that still fails is dropped. Other 4xx responses and redirects are dropped at once. Each request times out after 10 s. At shutdown the service flushes for up to 2 s, then closes, and anything still queued is dropped. Drops and failures appear in `ultrathink_audit_sink_events_total{sink,outcome}` and as `audit_sink_failed` log lines. The record path never waits for a sink.

### Blocked items

These cannot be finished from the repo. Each names what must exist first. Until then the code path is present and the sink or step stays off.

- **B1, SIEM endpoint (AUDIT-02).** Prerequisite: an ingest URL and token from the operator's SIEM tenant (for example Splunk HEC, Elastic or Sentinel).
  1. Confirm the endpoint accepts NDJSON POSTs. The HTTP sink sends `Authorization: Bearer <token>`. If the SIEM expects another scheme, put a receiver-side adapter in front of it; the repo has none, and changing the transport is a code change.
  2. `sudoedit /etc/ultrathink/ultrathink.env` (mode 0600): set `ULTRATHINK_AUDIT_HTTP_URL` and `ULTRATHINK_AUDIT_HTTP_TOKEN`. Never put the token on a command line.
  3. `systemctl restart ultrathink-web`, then `curl -s 127.0.0.1:8795/readyz`.
  4. Wait for one record to appear in the SIEM, and check that `ultrathink_audit_sink_events_total` with `outcome="sent"` rises.
- **B2, Kafka via REST Proxy (AUDIT-02).** Prerequisite: a running Kafka cluster behind Confluent REST Proxy v2, reachable over https, and the topic created on it. The native broker protocol is not implemented, and no client dependency is approved. The router sends no bearer token to the Kafka transport, so the REST Proxy must be reachable without one (a private network or an allowlist); adding auth needs a code change.
  1. Create the topic. Confirm `POST <url>/topics/<topic>` with `Content-Type: application/vnd.kafka.json.v2+json` is accepted from the VPS.
  2. Set `ULTRATHINK_AUDIT_KAFKA_REST_URL` and `ULTRATHINK_AUDIT_KAFKA_TOPIC` together in the env file, then restart and probe as in B1.
  3. Consume the topic and confirm envelopes arrive.
- **B3, pager delivery (AUDIT-04).** Prerequisite: a pager or incident endpoint with account and routing key, owned by A13. The repo has no pager transport: alerts leave the process only as logs, metrics and sink envelopes. Until A13 wires delivery, alert in your monitoring stack on the `audit_tamper_detected` log events and on `ultrathink_audit_tamper_alerts_total` (scrape as in section 8).
- **B4, host immutability (AUDIT-05).** Prerequisite: root on the VPS for `chattr`, or an S3-compatible bucket with Object Lock enabled. Neither exists in the repo.
  - `chattr +a` on sealed segments only: `chattr +a /var/lib/ultrathink/audit-*.jsonl`. Do not set it on the active `audit.jsonl`: rotation renames that file, so rotation fails and the active file keeps growing. Verify with `lsattr /var/lib/ultrathink/audit-*.jsonl`.
  - An attributed segment cannot be pruned. The prune fails and is logged as `audit_prune_failed`. Removing a segment for retention then needs `chattr -a` first; that is an operator decision, by design.
  - Object Lock: upload each sealed segment with a retention period at least `ULTRATHINK_AUDIT_RETENTION_DAYS` long, using the bucket's own tooling. No job in the repo does this, so the copy is manual until one is written. Keep its credentials in a root-only file, not in the service env file.
- **B5, off-host anchors (AUDIT-01).** Prerequisite: B1 or B2, or another store the VPS cannot rewrite. B4 protects the files on the host; B5 protects the `(seq, hash)` pairs. Without an off-host store, a whole-file rewrite that recomputes anchors and head, made while the service is stopped, is not detected. `chattr` on the VPS does not help, because root can undo it.
  1. Each day, read the head with `tail -n 1 /var/lib/ultrathink/audit.jsonl` and copy its `seq` and `hash` to the off-host store.
  2. Each day, run verify with the stored pairs: `bun services/ultrathink/obs/audit-cli.ts verify /var/lib/ultrathink/audit.jsonl --expect <seq>:<hash>`. Exit 1 means a stored record is missing or changed. Treat it as an incident: copy the file before any repair.

## 15. Rate limits, load shedding and abuse penalties

Phase 70 makes the request limits follow process load, shares the HTTP pool and the plan slots across priority classes, and blocks an IP that keeps failing. Every counter lives in process memory, so with more than one replica each process counts alone (see the blocked items).

### Priority classes

A request that reaches the HTTP pool has one of three classes: `owner` (a signed-in session), `connector` (a connector key) or `bearer` (an OAuth token). Anonymous requests never reach the pool. `/healthz`, `/readyz` and `/metrics` are never shed. On `/mcp`, discovery and `initialize` are not gated by the pool; `tools/call` and batches are.

- `owner` may take any free slot.
- `connector` and `bearer` may not take the last `reserve` slots, and no one non-owner principal may hold more than `ceil(capacity / 2)` slots.

The HTTP pool has `capacity` = `ULTRATHINK_MAX_INFLIGHT` (default 256) and `reserve` = `floor(ULTRATHINK_MAX_INFLIGHT * ULTRATHINK_PRIORITY_RESERVE_PCT / 100)`. The plan slots have `capacity` = `ULTRATHINK_MAX_CONCURRENT_PLANS`, a reserve of 1 when that value is 2 or more (fixed in code, not an env key), and a per-principal cap of `ceil(max / 2)`.

### Environment

| Variable | Default | Allowed | Effect |
|---|---|---|---|
| `ULTRATHINK_PRIORITY_RESERVE_PCT` | 25 | integer 0 to 90 | Share of the HTTP pool that non-owner classes may not take. 0 removes the reserve. |
| `ULTRATHINK_ADAPTIVE_QUOTA_MIN_PCT` | 50 | integer 10 to 100 | Lowest factor, in percent, applied to the IP, principal and owner windows. 100 keeps the windows at full size. |
| `ULTRATHINK_LAG_TARGET_MS` | 100 | integer 10 to 5000 | Event-loop lag above which a probe sample counts as pressure. |
| `ULTRATHINK_REPLICA_CAPACITY_RPS` | 20 | integer 1 to 100000 | Requests per second one replica serves. The replica recommendation divides by it. The default is an uncalibrated placeholder. |
| `ULTRATHINK_ABUSE_FAILURES_PER_MINUTE` | 20 | integer 1 to 10000 | Failures from one IP in one minute that trigger a block. |
| `ULTRATHINK_PENALTY_BASE_SEC` | 60 | integer 1 to 86400 | Length of the first block. |
| `ULTRATHINK_PENALTY_MAX_SEC` | 3600 | integer 1 to 86400, not less than the base | Cap on any one block. |

An out-of-range value stops startup with a `ConfigError` that names the variable. A max below the base fails with a message that names both.

### Responses that refuse a request

Every 429 has the body `{"error":"rate_limited"}` and a `Retry-After` header in seconds. The body does not say which limit fired.

| Cause | Response | Counter |
|---|---|---|
| Login window | 429 | `ultrathink_rate_limited_total{scope="login"}` |
| `POST /ultrathink`: IP, principal or owner window | 429 | `ultrathink_rate_limited_total{scope="run"}` |
| `/mcp`: IP, principal or owner window | 429 | `ultrathink_rate_limited_total{scope="mcp"}` |
| IP blocked by a penalty (every route except probes) | 429, `Retry-After` = seconds left in the block | `ultrathink_rate_limited_total{scope="penalty"}` |
| Pool refusal by class (`/mcp`, `POST /ultrathink`) | 429, `Retry-After: 1` | `ultrathink_fair_share_refused_total{class,reason}` |
| Global in-flight cap full | 503, body `{"error":"overloaded"}`, `Retry-After: 1` | `ultrathink_overload_total` |

The window names `ip`, `principal` and `owner` are the scopes that `allowRequest` reports. They are not metric labels; on `/mcp` they appear as the `window` field of the `rate_limit_window` log line. The global cap is checked first, so a full process answers 503 to everyone, and a class refusal happens only while the process still has room. `reason` is `capacity`, `reserved` or `principal`; `class` is `owner`, `connector` or `bearer`.

### Busy

Plan start returns `busy` when `ULTRATHINK_MAX_CONCURRENT_PLANS` plans are running, and also when the plan-slot policy refuses the caller: capacity, the reserved slot, or the per-principal cap. Every case returns the same `busy` code, so the response does not give the reason. Section 7 lists the 503 that carries it.

### Forecast gauges and replica recommendation

The runtime probe samples every 5 s, and each sample updates these gauges.

| Gauge | Value |
|---|---|
| `ultrathink_adaptive_quota_factor` | The current factor, from `ULTRATHINK_ADAPTIVE_QUOTA_MIN_PCT / 100` up to 1, starting at 1. A sample with lag above `ULTRATHINK_LAG_TARGET_MS`, or in-flight utilisation of 0.8 or more, halves it. A calm sample adds 0.05 back. |
| `ultrathink_load_forecast_rps` | Forecast peak admitted rate over the next 15 minutes, in requests per second. Holt linear trend over per-minute counts, with the same 15 minutes one day earlier as a floor. With fewer than 5 observed minutes it reports the current minute's rate; with no history, 0. |
| `ultrathink_recommended_replicas` | `max(1, ceil(load_forecast_rps / ULTRATHINK_REPLICA_CAPACITY_RPS))`. |

> **Do not act on `ultrathink_recommended_replicas` until `ULTRATHINK_REPLICA_CAPACITY_RPS` is calibrated.** The default of 20 is a placeholder. Run a load test on the VPS with the production build, find the sustained requests per second one replica serves at the latency you accept, set that value in `/etc/ultrathink/ultrathink.env`, and restart. A wrong value gives a wrong replica count at every traffic level.

The factor scales the IP, principal and owner windows only. The login and approval windows keep their own limits. Setting `ULTRATHINK_ADAPTIVE_QUOTA_MIN_PCT` to 100 makes the factor always 1.

### Load history

Per-minute admitted-request counts are kept for one day (1440 minutes). They are written to `/var/lib/ultrathink/load-history.json` every 5 minutes and at shutdown, through a temporary file in the same directory that is renamed into place, mode 0600. At start, a missing file means an empty history. An unreadable or malformed file also means an empty history, with one warning in the log, and the service still starts. A failed save logs a warning and does not stop the service. Retention does not sweep this file.

### Abuse penalties

A failed credential (a 401 on `/mcp`, or a failed session on `POST /ultrathink`) and every 429 from the rate windows count against the client IP. When one IP has more than `ULTRATHINK_ABUSE_FAILURES_PER_MINUTE` failures in one fixed minute, it is blocked for `base * 2^(level - 1)` seconds, capped at `ULTRATHINK_PENALTY_MAX_SEC`.

- While blocked, every request from that IP except the probes returns 429 `rate_limited` before authentication, including valid ones. Users behind one NAT share the block.
- A block that starts within 15 minutes after the previous block ended doubles the level. After 15 quiet minutes the level resets to 1.
- Failures during an active block change nothing.
- The ladder tracks 10000 IPs. A new IP that finds the table full is not tracked, so no penalty applies to it (`ultrathink_abuse_untracked_total`). The rate windows still refuse new keys when full, so a key-churn flood can refuse new clients for up to one window.
- `ultrathink_abuse_penalty_total` counts each new block. The audit log records `abuse_penalty` with `ip`, `level` and `blockedSec`.

Check the series with `curl -s 127.0.0.1:8795/metrics | grep -E 'ultrathink_(adaptive_quota|load_forecast|recommended_replicas|fair_share|abuse_|rate_limited)'`.

### Blocked items

Each item below is not built. Its prerequisite is named; until that exists, only the behaviour above applies.

- **Automatic scale-out.** Prerequisite: an orchestrator (an autoscaler or HPA) and state that replicas can share. State is one SQLite file under `/var/lib/ultrathink`, so a second replica today would split every counter. Nothing here acts on the recommendation; an orchestrator would have to read it.
- **Shared rate-limit state (RATE-04, Redis Cluster).** Prerequisite: a reachable Redis Cluster endpoint, approval of a Redis client dependency (`package.json` has none), and a multi-replica deployment to test against. Until then the limits in this section apply per process.
- **SIEM delivery of abuse events.** Prerequisite: the Phase 68 SIEM sink and its collector. Until both exist, `abuse_penalty` stays in the local audit log and in any sink from section 14, and no collector alerts on it.
- **Calibration of `ULTRATHINK_REPLICA_CAPACITY_RPS`.** Prerequisite: a load test on the VPS with the production build. See the warning above.
