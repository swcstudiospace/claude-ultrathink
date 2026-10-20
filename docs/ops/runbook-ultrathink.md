# Runbook: ultrathink.swcstudio.space

Operations guide for the ultrathink MCP service on the VPS. Commands run as root unless noted. Secrets are never printed in this document; use the patterns below so they do not reach shell history or logs either.

## 1. Architecture

1. Clients (Grok Chat, claude.ai, Claude Desktop, Claude Code, Grok Bot) call `https://ultrathink.swcstudio.space/mcp`.
2. Cloudflare terminates the public TLS connection (SSL mode Full strict) and forwards to the VPS origin `187.77.130.10:443`.
3. nginx (`deploy/nginx-ultrathink.swcstudio.space.conf`) accepts only Cloudflare peers, takes the real client address from `CF-Connecting-IP`, rate-limits per client, and proxies the allowed routes to `127.0.0.1:8795`.
4. The Bun service `ultrathink-web` (`services/ultrathink/server.ts`) serves `/mcp`, the OAuth endpoints, `/login`, `/ultrathink`, `/healthz`, `/readyz` and `/metrics` (loopback only).
5. It runs as the unprivileged user `ultrathink` from `/opt/ultrathink/current`, a symlink into `/opt/ultrathink/releases/<sha>-<utc>`, under a systemd sandbox (`deploy/ultrathink-web.service`).
6. Server-side planning calls OpenRouter (`OPENROUTER_API_KEY`, model `ULTRATHINK_PLANNING_MODEL`); the client-driven loop (Grok Bot) makes no model call.
7. State lives in `/var/lib/ultrathink` (mode 0700): `ultrathink.sqlite` (runs, token ledger), `oauth.json` (OAuth clients and tokens), `journal/`, `sessions/`, `jobs/`, and `audit.jsonl` (the security audit trail, section 7).
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

4. Check `/etc/ultrathink/ultrathink.env` (mode 0600, owner root). Variables: `ULTRATHINK_PUBLIC_ORIGIN`, `ULTRATHINK_SESSION_SECRET`, `ULTRATHINK_OWNER_PASSWORD_HASH`, `ULTRATHINK_CONNECTOR_KEY`, `ULTRATHINK_PLANNING_MODEL` (for example `x-ai/grok-4.7`), `OPENROUTER_API_KEY`, and optionally the variables in the environment table below. The owner hash must be argon2id (see section 6); the service refuses to start when it is not an argon2 or bcrypt hash, and when `ULTRATHINK_PUBLIC_ORIGIN` has a path, query or credentials (a trailing slash is dropped). Check the variable names without printing values:

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

### Environment variables

The service reads its variables in `services/ultrathink/config/config.ts`; if this table disagrees with that file, the file wins. Planner and model variables are in section 12. `deploy/ultrathink-release.sh` reads `ULTRATHINK_KEEP_RELEASES` itself.

| Variable | Default | Allowed values | Effect |
|---|---|---|---|
| `ULTRATHINK_PUBLIC_ORIGIN` | none (required) | An origin without path, query or credentials; a trailing slash is dropped | The public origin. `POST /logout` needs this exact `Origin`. An https origin makes the session cookie `__Host-ut_session` with `Secure`. |
| `ULTRATHINK_SESSION_SECRET` | none (required) | At least 32 characters | Signs web session cookies and approval proofs (section 6). |
| `ULTRATHINK_SESSION_SECRET_PREVIOUS` | empty | Comma-separated, newest first; each at least 32 characters; at most 4 entries | Earlier secrets that still verify sessions and pending consents during a rotation (section 6). |
| `ULTRATHINK_OWNER_PASSWORD_HASH` | none (required) | An argon2id or bcrypt hash; other values are refused at startup | Owner login. Changing it ends every web session. |
| `ULTRATHINK_CONNECTOR_KEY` | empty | At least 32 characters | Key for the connector (`x-connector-key`, section 6). |
| `OPENROUTER_API_KEY`, `ULTRATHINK_PLANNING_MODEL` | none | OpenRouter key; model id | Server-side planning is on only when both are set. Section 12 covers the model, effort and timeout variables. |
| `ULTRATHINK_PORT` | 8795 | 1024 to 65535 | Loopback port of `ultrathink-web`. |
| `ULTRATHINK_ALLOWED_ORIGINS` | empty | Comma-separated bare origins | Origins allowed on `/mcp`. Requests without an `Origin` header are always allowed (section 7). |
| `ULTRATHINK_STATE_DIR` | `/var/lib/ultrathink` | Absolute path; trailing slashes are removed. A relative path fails startup | Holds the database, OAuth state, audit file, sessions, jobs and journals. |
| `ULTRATHINK_MAX_INPUT_CHARS` | 8000 | 1 to 20000 | Longest accepted prompt, in UTF-16 code units. |
| `ULTRATHINK_MAX_ANSWER_CHARS` | 20000 | 1 to 20000 | Longest accepted answer. Changed in this release: the maximum was 200000. The 64 KiB request body cap cannot carry more, so a larger value fails startup and names the variable. |
| `ULTRATHINK_MAX_INFLIGHT` | 256 | 1 to 10000 | Requests admitted at once. Further requests get 503 `overloaded` (section 7). `/healthz`, `/readyz` and `/metrics` are never refused. |
| `ULTRATHINK_DRAIN_MS` | 5000 | 0 to 60000 | Time `/readyz` reports `draining` before the listener stops on SIGTERM or SIGINT (section 3). Keep it well below `TimeoutStopSec=30`. |
| `ULTRATHINK_BREAKER_FAILURES` | 5 | 0 to 100 | Upstream failures (errors, timeouts, rate limits) in one window that open the OpenRouter breaker. 0 disables the breaker. |
| `ULTRATHINK_BREAKER_WINDOW_MS` | 60000 | 1000 to 3600000 | Window in which upstream failures are counted. |
| `ULTRATHINK_BREAKER_OPEN_MS` | 30000 | 1000 to 600000 | How long planning is refused once the breaker opens, before one probe is let through. |
| `ULTRATHINK_RETENTION_DAYS` | 30 | 0 to 3650 | Age after which finished jobs, sessions and journals are removed by the hourly sweep. 0 disables the sweep (see the note below). |
| `ULTRATHINK_AUDIT_LOG` | 1 | 0 or 1 | 0 stops writing `audit.jsonl` (section 7). |
| `ULTRATHINK_KEEP_RELEASES` | 5 | Integer, at least 1 | Releases kept by `deploy/ultrathink-release.sh`. Checked in every mode. |

`ULTRATHINK_RETENTION_DAYS=0` turns retention off in both places: the service's hourly sweep and the daily backup's file and database prune (`deploy/ultrathink-backup.sh` skips both steps). Nothing is removed then, so the disk grows until someone deletes old entries by hand.

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

Deploy effects to expect from this release:

- **Sessions end at the deploy.** The session cookie is renamed (`__Host-ut_session` over https, `ut_session` otherwise), and sessions issued before this release are refused, so each browser signs in once more. Changing the owner password hash ends every session at any time (section 6).
- **Drain on stop.** On SIGTERM or SIGINT, `/readyz` returns 503 with `draining` in `failed` for `ULTRATHINK_DRAIN_MS` (default 5000) before the listener stops. `/healthz` stays 200. The nginx vhost in this repository does not poll `/readyz`: it routes to the one upstream and maps a 502 or 504 to the `unavailable` response (section 7). The drain window is what an external load balancer needs to stop sending traffic to this host, if one is put in front of it. On this host it lets in-flight requests finish.
- **Stop timeout.** Keep `ULTRATHINK_DRAIN_MS` well below `TimeoutStopSec=30` in `deploy/ultrathink-web.service`. systemd kills a process whose stop runs longer than that timeout, so a value near the 60000 maximum would cut the drain short.
- **Integrity.** `/readyz` includes `integrity`, the SQLite `quick_check` result, computed at startup and after each retention sweep. A failing check puts `integrity` in `failed` and returns 503. Treat it as database damage and restore from backup (section 5).
- **Release tests.** `deploy/ultrathink-release.sh` runs the archived commit's test suite as the service user, in a throwaway directory that is removed afterwards. It never runs those tests as root.

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
| Session secret (`ULTRATHINK_SESSION_SECRET`, at least 32 characters) | Graceful: move the current value into `ULTRATHINK_SESSION_SECRET_PREVIOUS`, set the new value, restart, and remove the old entry 12 hours later (see "Rotating the session secret" below). Immediate: set the new value and leave the old one out of `ULTRATHINK_SESSION_SECRET_PREVIOUS`, then restart. | Graceful: existing sessions and pending consents keep working until the old entry is removed. Immediate: every web session and pending consent ends at restart. |
| OpenRouter key (`OPENROUTER_API_KEY`) | Create a new key in the OpenRouter dashboard with a spending limit, store it, restart, confirm one plan succeeds, then delete the old key in the dashboard. | Server-side planning uses the new key. |
| Owner password hash (`ULTRATHINK_OWNER_PASSWORD_HASH`) | Generate an argon2id hash without putting the password in argv (command below), store it, restart. | The old password stops working; OAuth approvals use the new one. Changing the hash also ends every web session. |

Owner password hash, with a prompt so nothing lands in shell history:

```bash
read -rs -p 'New owner password: ' UT_PW; echo
UT_PW="$UT_PW" /opt/ultrathink/bin/bun -e 'console.log(await Bun.password.hash(process.env.UT_PW, { algorithm: "argon2id", memoryCost: 19456, timeCost: 2 }))'
unset UT_PW
```

The output starts with `$argon2id$`. Paste it as the value of `ULTRATHINK_OWNER_PASSWORD_HASH`; systemd does not expand `$` in environment files, so no escaping is needed. To revoke every OAuth client and token: stop the service, delete `/var/lib/ultrathink/oauth.json`, start it.

### Rotating the session secret

Web session cookies and pending consents are signed with `ULTRATHINK_SESSION_SECRET`. A session cookie is valid for 12 hours and a pending consent for 10 minutes. Rotate in this order:

1. Generate the new value with `openssl rand -hex 32`. Store it in the env file in step 2; do not paste it into chat or a ticket.
2. Edit the env file with `sudoedit /etc/ultrathink/ultrathink.env`. Move the current `ULTRATHINK_SESSION_SECRET` value into `ULTRATHINK_SESSION_SECRET_PREVIOUS` (comma-separated, newest first, at most 4 entries, each at least 32 characters), then set `ULTRATHINK_SESSION_SECRET` to the new value.
3. `systemctl restart ultrathink-web`, then probe `/readyz`. Existing sessions and pending consents keep working; new ones are signed with the new value.
4. Wait at least 12 hours. By then every session signed with the old value has expired; pending consents expired after 10 minutes.
5. Delete the old entry from `ULTRATHINK_SESSION_SECRET_PREVIOUS` and leave any other entries. `systemctl restart ultrathink-web`, then probe `/readyz`. Cookies signed with the removed value are refused from then on.

Remove the old value as soon as step 4 allows: while it is listed, anyone who holds it can forge session cookies. To end every session and pending consent immediately, skip step 2's move: set the new value, leave the old one out, and restart. A stolen cookie stops working only after the old value leaves the list, or at once with that method.

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

`/healthz` is liveness only (the process answers and the database responds). `/readyz` reports whether the service can do work: the store (database ping), the state directory (writable), the OAuth state (readable), the planner (when planning is on, both `OPENROUTER_API_KEY` and `ULTRATHINK_PLANNING_MODEL` are set), `integrity` (SQLite `quick_check`, run at startup and after each retention sweep) and `draining` (fails from SIGTERM or SIGINT until the stop; section 3). Through the edge, a 503 whose body is exactly `{"error":"unavailable"}` with `Retry-After: 60` is nginx saying the upstream is down or timed out (it turns an upstream 502 or 504 into that 503). Any other 503 body comes from the app and is passed through unchanged (`persistence_unavailable` with a `correlationId`, `/readyz` `not_ready`, OAuth `temporarily_unavailable`, `overloaded`).

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
| 503 with any other body | The app itself (nginx does not rewrite it): not ready (`/readyz` lists the failing check: store, state directory, OAuth, planner, integrity or draining), persistence unavailable (the body carries a `correlationId`), or the planner is busy (`maxConcurrentPlans` jobs running). | Check `journalctl`, `/readyz`, and wait for running plans; raise `ULTRATHINK_MAX_CONCURRENT_PLANS` (1 to 8) if busy is routine. |
| 503 with `{"error":"overloaded"}` and `Retry-After: 1` | More than `ULTRATHINK_MAX_INFLIGHT` requests (default 256) were in flight, so this request was refused. `/healthz`, `/readyz` and `/metrics` are never refused. | `ultrathink_overload_total` and `ultrathink_http_inflight` in `/metrics`. Find the slow endpoint in the request log (its duration field). Raise `ULTRATHINK_MAX_INFLIGHT` only when CPU and memory have headroom. |
| `planner failed` (result status `failed`) | OpenRouter rejected or timed out: bad or exhausted key, unknown model id, 429 or 5xx from the provider, model timeout, plan timeout. Or the upstream breaker is open after repeated upstream failures, and planning is refused as `upstream_unavailable` without a request to OpenRouter. | The result's `error` field and the error log say which. Check the key and credit in the OpenRouter dashboard, `ULTRATHINK_PLANNING_MODEL`, and `ULTRATHINK_MODEL_TIMEOUT_MS` and `ULTRATHINK_PLAN_TIMEOUT_MS`. For `upstream_unavailable`, check the provider's status and wait: one probe is let through after `ULTRATHINK_BREAKER_OPEN_MS` (`ultrathink_upstream_breaker_state` shows the state). A plan interrupted by a restart reports `interrupted`. |
| `budget_exceeded` | The per-run or daily token ceiling was reached (`ULTRATHINK_RUN_TOKEN_CEILING`, `ULTRATHINK_DAILY_TOKEN_CEILING`). The day is a UTC calendar day. | Wait for the next UTC day, or raise the ceiling and restart. The ledger keeps abandoned reservations counted against the ceiling. |
| `ultrathink-maintenance.service` fails with `status=226/NAMESPACE` ("Failed to set up mount namespacing: /var/backups/ultrathink: No such file or directory") | The backup directory does not exist. systemd builds the `ReadWritePaths=` mount namespace before any `ExecStartPre=` runs, so the unit cannot create it itself. | `install -m 0644 deploy/ultrathink-tmpfiles.conf /etc/tmpfiles.d/ultrathink.conf && systemd-tmpfiles --create /etc/tmpfiles.d/ultrathink.conf`, then start the unit again. |
| Service flapping | Bad env file, port in use, failed sandbox call. | `systemctl status` shows the start limit (5 starts in 60 seconds). A `SIGSYS` kill means the syscall filter blocked a call: `journalctl -k \| grep -i seccomp`. Roll back the release (section 4). |
| A client connects, then lists no tools or never calls any | The probe was refused and the client did not fall back, the tool list is stale (Grok caches it), or the rate limit fired. | Read the first connection in the request log (section 13). Grok only refreshes its tool list on re-authentication. |

### Audit log

The service appends security events to `${ULTRATHINK_STATE_DIR}/audit.jsonl`, by default `/var/lib/ultrathink/audit.jsonl`. The file is owned by `ultrathink` with mode 0600, and every append is fsynced. Each line is a JSON record whose `hash` covers its own fields and the `hash` of the record before it, so editing, removing or reordering a line breaks the chain from that line on. Set `ULTRATHINK_AUDIT_LOG=0` to stop writing the file.

Events: `login_ok` and `login_failed` (field `ip`), `logout`, `rate_limited` (fields `scope` and `ip`), `client_registered`, `consent_approved`, `code_exchanged`, `token_refreshed`, `refresh_reuse_detected` and `token_revoked`. OAuth events carry only the client id. `consent_denied` is in the event list, but no code path emits it, because the consent flow has no deny action.

The file is not in the backup archive (section 5), and the maintenance job does not prune it (section 10). It grows until you archive it.

Verify the chain with the release's CLI. It only reads:

```bash
/opt/ultrathink/bin/bun /opt/ultrathink/current/services/ultrathink/obs/audit-cli.ts verify
/opt/ultrathink/bin/bun /opt/ultrathink/current/services/ultrathink/obs/audit-cli.ts verify /path/to/copy/audit.jsonl
```

Without a path it checks `${ULTRATHINK_STATE_DIR}/audit.jsonl`, with `ULTRATHINK_STATE_DIR` taken from the environment and `/var/lib/ultrathink` as the default.

| Exit | Output | Meaning |
|---|---|---|
| 0 | `audit ok: N records, last <hash>` | Chain intact. A missing file also reports `ok` with 0 records. |
| 1 | `audit BROKEN at record N: <reason>` | Chain broken at record N. `record 0` means the file could not be read (an I/O problem, not necessarily tampering). |
| 2 | usage text | Bad arguments. |

The chain detects edits and removals inside the file. Removing the last records is only visible against a `lastHash` kept off the host, so if you need that guarantee, copy the verify output off the host on a schedule.

Quarantine: at startup the service verifies the file. A broken file is renamed to `audit.jsonl.corrupt-<timestamp>` in the same directory and a new chain starts at record 1; the old records are kept in the renamed file. The rename is logged as `audit_write_failed` with a message that says `moved to`, and it increments `ultrathink_audit_write_failures_total` once, so that counter reads 1 after a quarantine although nothing failed to write. If the file cannot be opened or read, or cannot be renamed, startup fails rather than run without an audit trail. A crash during a write can leave a truncated last line; verify reports that as BROKEN too.

While the service runs, a failed write drops the affected record and the request continues. Each distinct failure message is logged once until a later append succeeds, and every drop increments `ultrathink_audit_write_failures_total`.

When verify reports BROKEN:

1. Keep the file as it is. Do not edit, truncate, repair, rename or delete it.
2. Do not restart the service before the copy in step 3 exists. Startup moves a broken file aside and starts a new chain.
3. Copy the file off the host: `install -d -m 0700 /root/evidence && cp -a /var/lib/ultrathink/audit.jsonl /root/evidence/audit-$(date -u +%Y%m%dT%H%M%SZ).jsonl`. Transfer that copy to the incident owner over a channel that is not this host, and record its `sha256sum`.
4. Record the line that verify reports, the reason, and the `hash` of the last good record (the line before it).
5. Open an incident. Find out how the file changed: the service journal around the time, the owner and mode of the file and its directory, and who had shell access.
6. Decide with the incident owner how to continue. Only then restart the service; the broken file stays as `audit.jsonl.corrupt-<timestamp>`.

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
| `ultrathink_http_inflight` | none | Requests in flight now (gauge, sampled every 5 s) |
| `ultrathink_overload_total` | none | Requests refused with 503 `overloaded` because `ULTRATHINK_MAX_INFLIGHT` was reached |
| `ultrathink_upstream_breaker_state` | `state` (`closed`, `open`, `half_open`) | 1 for the current breaker state, 0 for the others; absent when `ULTRATHINK_BREAKER_FAILURES` is 0 |
| `ultrathink_audit_write_failures_total` | none | Audit records dropped on a write failure, plus one count for a startup quarantine (section 7, Audit log) |
| `ultrathink_retention_removed_total` | `kind` (`jobs`, `sessions`, `journals`) | Entries removed by the hourly retention sweep |
| `ultrathink_event_loop_lag_seconds` | none | Event-loop lag at the last sample (gauge, sampled every 5 s) |

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
| Overload (suggested) | `increase(ultrathink_overload_total[10m]) > 0` for 10 minutes, or `ultrathink_http_inflight` held at the `ULTRATHINK_MAX_INFLIGHT` value for 5 minutes. A few refusals in a burst are expected. A sustained count means requests arrive faster than they finish, usually from a slow upstream call or a flood. Find the slow endpoint in the request log. | Ticket |
| Upstream breaker (suggested) | `ultrathink_upstream_breaker_state{state="open"} == 1` for more than 5 minutes. Planning is refused while it is open; check OpenRouter's status and your key credit (section 7). Repeated short `half_open` periods mean the probe keeps failing. | Ticket |
| Audit writes (suggested) | `increase(ultrathink_audit_write_failures_total[1h]) > 0`. Each count is an audit record that was not written, so the trail has a gap. A startup quarantine also counts once, so an alert right after a restart needs a look at the journal (section 7, Audit log). | Ticket |
| Event-loop lag (suggested) | `ultrathink_event_loop_lag_seconds` above 0.2 for 5 minutes. Sustained lag means the process is CPU-bound or blocked, which slows every endpoint and can lead to overload refusals. | Ticket |
| Retention sweep (no alert) | `increase(ultrathink_retention_removed_total[1d]) or vector(0)` shows what the hourly sweep removed. The counter appears only after its first removal. A sweep that never removes anything while old entries exist is not running: check the service journal for errors. | None |
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

### Open nginx items

These two items are not in `deploy/nginx-ultrathink.swcstudio.space.conf` yet. The snippets are suggestions for the operator. Test each change with `nginx -t` before reloading, and keep the previous conf from git (section 4) for rollback.

- **Rate limit on `/healthz` and `/ultrathink`.** Those two locations have no `limit_req` today; `/login`, `/oauth/*` and `/mcp` do. Suggested zone, in the `http` context next to the existing `limit_req_zone` lines:

  ```nginx
  limit_req_zone $binary_remote_addr zone=ultrathink_web:10m rate=60r/m;
  ```

  Suggested limit, inside the `location = /healthz` and `location ~ ^/ultrathink(/|$)` blocks:

  ```nginx
  limit_req zone=ultrathink_web burst=30 nodelay;
  ```

- **OCSP stapling.** Suggested, in the 443 server block:

  ```nginx
  ssl_stapling on;
  ssl_stapling_verify on;
  ssl_trusted_certificate <chain>;
  ```

  `<chain>` is a file with the issuer chain. For a certbot certificate that is `chain.pem` in the live directory, not `fullchain.pem`. nginx also needs a `resolver` directive to fetch OCSP responses; without one, stapling does not take effect. After reload, check on the VPS with `openssl s_client -connect 127.0.0.1:443 -servername ultrathink.swcstudio.space -status </dev/null`.


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
| Audit trail | `/var/lib/ultrathink/audit.jsonl` | Security events: login results and client address, rate-limit scope and address, OAuth client ids (no tokens or secrets) | Not pruned by the service or the maintenance job, and not in backups. Kept until you archive it (section 7, Audit log). |
| Provider side | OpenRouter and the model provider | Prompts and outputs of server-side plans | Governed by the provider's policy and your OpenRouter privacy settings. |

## 11. Residual risks

Known gaps that are accepted for now. Each has an owner decision pending.

- **Global owner-login lockout (S4).** Failed owner logins from anyone count toward one shared limit, so an attacker spreading guesses over several addresses can lock the owner out of `/login` for the window. nginx limits `/login` per client address, which narrows but does not remove this. Recovery: wait for the window or restart the service (the limiter is in memory).
- **Web sessions are not revocable one at a time (S5), partly mitigated.** Logout clears the browser cookie and writes a `logout` audit event, but the server keeps no session list. A session cookie is an HMAC over its expiry, so a copied cookie stays valid until it expires (12 hours) or until the secret that signed it leaves `ULTRATHINK_SESSION_SECRET_PREVIOUS`. Changing `ULTRATHINK_OWNER_PASSWORD_HASH` ends every session at once. Setting a new `ULTRATHINK_SESSION_SECRET` without keeping the old value in `ULTRATHINK_SESSION_SECRET_PREVIOUS` also ends every session and pending consent at the restart. The graceful rotation keeps the old secret for 12 hours by design, so it does not revoke a stolen cookie until the old entry is removed (section 6).
- **Cookie name prefix (S6), resolved on https.** When the origin is https the session cookie is `__Host-ut_session`. The `__Host-` prefix requires `Secure`, `Path=/` and no `Domain`, so a sibling subdomain cannot overwrite it. A plain-http origin still uses `ut_session` without the prefix, so this protection depends on https.
- **The in-memory limiters refuse new keys when full (S8).** Each limiter in the auth module (per-address login, owner login failures, requests and approvals) and the OAuth limiter holds at most 10,000 keys. At the cap with nothing expired, new keys are refused with 429. A rotating-source attacker could therefore cause 429 for new addresses until entries expire; nginx limits and Cloudflare rules reduce the chance. The state is in memory, so a restart clears it. The overload shed (`ULTRATHINK_MAX_INFLIGHT`, section 7) is a separate mechanism and does not use these tables.
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

Status: Grok Chat connected to this server live on 2026-10-18 and 2026-10-19, against the older build (7 tools, 1 prompt, no resources). No connection from Claude chat, Claude Desktop or Claude Code appears in the retained server logs of 2026-10-11 to 2026-10-19 (no Claude user agent, no Anthropic address range, no claude.ai redirect URI), so none is known to have connected. The v1.14 surface described below went live with release `f1e8a4fab33f-20261019T154303Z` on 2026-10-19 at 15:43 UTC. For the first connection from a client with none seen yet, this section is how to read it. Nothing here claims a client behavior that the logs have not shown. The dated record is in [the evidence file](evidence-connector-commands.md#2026-10-19-live-observations-and-release).

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
| OAuth metadata | The authorization server metadata advertises `registration_endpoint`, token auth method `none` and PKCE `S256`, and does not advertise `client_id_metadata_document_supported`. Claude must therefore be added with OAuth client "Register automatically"; "Use Claude's published identity" needs a Client ID Metadata Document, which this server does not offer. |
| Errors | A `resources/read` for an unknown `ui://` uri returns `-32002`; a malformed uri returns `-32602`. `GET` and `DELETE` on `/mcp` return 405 with `Allow: POST`, before authentication. |
| Command catalog | Read from `commands/` and `skills/` in the release, with the decision per command in `COMMAND_OVERLAY` (`services/ultrathink/mcp/commands.ts`). A release without those directories serves the static overlay and logs a `command_catalog_fallback` warning at start. |
| Plugin bundle | `plugins/ultrathink-connector/`, built with `sh plugins/ultrathink-connector/package.sh` into a zip for Claude's plugin upload. Its `.mcp.json` points at the production URL and holds no key. |
| Tool definition check | `services/ultrathink/mcp/definitions.ts` checks every tool definition: name pattern and uniqueness, description length and content (no absolute paths, stack frames or secret-like strings), a hand-checked JSON Schema subset and boolean annotations. `ultrathink-web` and `ultrathink-connector` refuse to start when a definition fails, naming the tool on stderr, and `bun test` runs the same check, so `deploy/ultrathink-release.sh` stops before it switches `current`. |

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
| `/mcp` in the app | 120 per minute per client address; 60 per minute per principal (the connector key, or each bearer token); 240 per minute for all connector traffic per owner. | 429 `rate_limited` with `Retry-After`, logged as `rate_limited` with `scope` `mcp`. Do not poll `ultrathink_result` with `waitSeconds: 0` in a loop. |
| `/mcp` in nginx | 120 per minute per client address, burst 60. | nginx's default 429 page. |
| OAuth in nginx and the app | nginx 30 per minute (burst 20); the app limits authorize to 30 per minute, `/oauth/token` to 60 per minute per address and 30 per minute per client id, and revoke to 60 per minute. | 429 on the OAuth endpoints. |
| Login | nginx 5 per minute; the app allows 5 attempts per address per 15 minutes. | 429 or a login refusal. |

When registrations are limited, wait for `Retry-After`. Restarting `ultrathink-web` also clears the in-memory limiter, at the cost of a restart. Raising the limit needs a code change (`REGISTER_LIMIT` in `services/ultrathink/oauth/oauth.ts`).

### After changing tools

Grok fetches a connector's tool list once and refreshes it only when the connector is re-authenticated (`https://github.com/xai-org/plugin-marketplace/issues/1402`); tell Grok users to reconnect after any release that changes a tool name, description or schema. Whether claude.ai re-fetches `tools/list` on its own is not verified: have Claude users remove and re-add the connector.

The first live Grok session (2026-10-18 and 2026-10-19 logs) sent `initialize` and `notifications/initialized` before every `tools/call` and never sent a second `tools/list`.
