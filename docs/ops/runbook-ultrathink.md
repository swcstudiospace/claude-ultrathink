# Runbook: ultrathink.swcstudio.space

Operations guide for the ultrathink MCP service on the VPS. Commands run as root unless noted. Secrets are never printed in this document; use the patterns below so they do not reach shell history or logs either.

## 1. Architecture

1. Clients (Grok Chat, claude.ai, Claude Desktop, Claude Code, Grok Bot) call `https://ultrathink.swcstudio.space/mcp`.
2. Cloudflare terminates the public TLS connection (SSL mode Full strict) and forwards to the VPS origin `187.77.130.10:443`.
3. nginx (`deploy/nginx-ultrathink.swcstudio.space.conf`) accepts only Cloudflare peers, takes the real client address from `CF-Connecting-IP`, rate-limits per client, and proxies the allowed routes over mTLS to `127.0.0.1:8795` (section 17).
4. The Bun service `ultrathink-web` (`services/ultrathink/server.ts`) serves `/mcp`, the OAuth endpoints, `/login`, `/ultrathink`, `/healthz`, `/readyz` and `/metrics` on a TLS-only loopback listener. Which client certificate may reach which route is in section 17.
5. It runs as the unprivileged user `ultrathink` from `/opt/ultrathink/current`, a symlink into `/opt/ultrathink/releases/<sha>-<utc>`, under a systemd sandbox (`deploy/ultrathink-web.service`).
6. Server-side planning calls OpenRouter (`OPENROUTER_API_KEY`, model `ULTRATHINK_PLANNING_MODEL`); the client-driven loop (Grok Bot) makes no model call.
7. State lives in `/var/lib/ultrathink` (mode 0700): `ultrathink.sqlite` (runs, token ledger), `oauth.json` (OAuth clients and tokens), `journal/`, `sessions/`, `jobs/`.
8. Configuration and secrets live in `/etc/ultrathink/ultrathink.env` (mode 0600, root), read by systemd.
9. `deploy/ultrathink-release.sh` builds, tests, smoke-tests and switches releases. Scheduled jobs: `deploy/ultrathink-maintenance.timer` runs the daily backup and retention job; `deploy/ultrathink-snapshot.timer` takes a point-in-time snapshot every 30 seconds and stays disabled until the staging measurement is recorded (section 5); `deploy/ultrathink-drill.timer` runs the monthly restore drill.
10. Logs go to journald as JSON lines; Prometheus-format metrics are on `https://127.0.0.1:8795/metrics`, which accepts the probe identity only (section 17).

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
   install -m 0644 deploy/ultrathink-web.service deploy/ultrathink-maintenance.service deploy/ultrathink-maintenance.timer deploy/ultrathink-snapshot.service deploy/ultrathink-snapshot.timer deploy/ultrathink-drill.service deploy/ultrathink-drill.timer /etc/systemd/system/
   systemctl daemon-reload
   install -m 0644 deploy/nginx-ultrathink.swcstudio.space.conf /etc/nginx/sites-available/ultrathink.swcstudio.space
   nginx -t && systemctl reload nginx
   ```

   The vhost needs the TLS files of section 17 first: `nginx -t` fails while `proxy_ssl_trusted_certificate` or the edge leaf is missing.

6. Build and start the first release with the release script (section 3), then enable everything. When the host still runs the old root-owned service, do not use the script for the first release: follow "First cutover from the old root service" below instead.

   ```bash
   install -m 0644 deploy/ultrathink-tmpfiles.conf /etc/tmpfiles.d/ultrathink.conf && systemd-tmpfiles --create /etc/tmpfiles.d/ultrathink.conf
   systemctl enable ultrathink-web
   systemctl enable --now ultrathink-maintenance.timer
   ```

   The snapshot and drill timers stay disabled here. Section 5 gives the conditions for enabling each one.

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
   curl -s --cacert /etc/ultrathink/tls/ca.pem --cert /etc/ultrathink/tls/ops/cert.pem --key /etc/ultrathink/tls/ops/key.pem -o /dev/null -w '%{http_code}\n' https://127.0.0.1:8796/healthz
   curl -s --cacert /etc/ultrathink/tls/ca.pem --cert /etc/ultrathink/tls/ops/cert.pem --key /etc/ultrathink/tls/ops/key.pem -w '\n%{http_code}\n' https://127.0.0.1:8796/readyz
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
   curl -s --cacert /etc/ultrathink/tls/ca.pem --cert /etc/ultrathink/tls/ops/cert.pem --key /etc/ultrathink/tls/ops/key.pem -o /dev/null -w '%{http_code}\n' https://127.0.0.1:8795/healthz
   curl -s --cacert /etc/ultrathink/tls/ca.pem --cert /etc/ultrathink/tls/ops/cert.pem --key /etc/ultrathink/tls/ops/key.pem -o /dev/null -w '%{http_code}\n' https://127.0.0.1:8795/readyz
   ```

   Then install the nginx conf (step 5) in the same window, after the app restart above. Section 17 gives the order: the public site answers 503 until both are live. Then verify from outside (step 7), `systemctl enable ultrathink-web`, and `systemctl enable --now ultrathink-maintenance.timer` (install the tmpfiles entry first, as in step 6). Later deploys use the release script, which treats this release as `current`.

4. Rollback of the cutover: `systemctl stop ultrathink-web`, restore the old unit with `cp -a "$bak"/ultrathink-web.service /etc/systemd/system/`, `systemctl daemon-reload`, `systemctl start ultrathink-web`. The old unit still points at the working tree under `/root`, which the cutover did not modify, and root can read the service-owned state. If the new code changed state the old code cannot read, also restore it: `rm -rf /var/lib/ultrathink && cp -a "$bak"/state /var/lib/ultrathink`. Restore the nginx conf from `$bak` if it was already replaced, then `nginx -t && systemctl reload nginx`.

## 3. Deploy

Commit and push the change first. The release is built from a commit, never from the working tree.

```bash
cd /path/to/claude-ultrathink
deploy/ultrathink-release.sh release <git-ref>      # for example: main, a tag, or a sha
```

The script, in order: checks the TLS files of section 17 and refuses before it creates a release when one is missing, archives the commit into `/opt/ultrathink/releases/<sha>-<utc>`, runs `bun test services/ultrathink` there, then runs the security gate (`security_gate`: `scripts/security-gate.ts audit --root .`, section 19) and discards the release with `security gate failed; release discarded, nothing was switched` when it fails, starts the new release on port 8796 with the production environment but a throwaway state directory and probes `/healthz` and `/readyz` over mTLS, switches `current` atomically (the old release becomes `previous`), restarts `ultrathink-web`, probes both endpoints on the production port over mTLS, and rolls back by itself when any production probe fails. It keeps the 5 newest releases (never deleting `current` or `previous`). It refuses to run unless root.

After a deploy that changed units or nginx, install the new copies (section 2, step 5) and reload. Unit changes need `systemctl daemon-reload` and a restart. The renewal units are installed the same way; section 17 gives their order.

### Release gate evidence

The release workflow (`.github/workflows/release.yml`) runs on a version tag. It creates the GitHub release only after the `Security gate` step passes, and it attaches the four evidence files it wrote to `security-evidence/`:

| File | Written by | What it holds |
|---|---|---|
| `checks.json` | `security-gate.ts checks` | each name in `requiredChecks` with its status, read from the check runs of the tagged commit |
| `audit.json` | `security-gate.ts audit` | `bun audit` results for `.` and `plugins/omp-token-opt` against `audit.level` |
| `licenses.json` | `security-gate.ts licenses` | installed package licenses for both roots against `licenses.allow` |
| `manifest.json` | `security-gate.ts report` | the release manifest that ties the other three files to the tag and the commit SHA |

The required check names come from `requiredChecks` in `.github/security-policy.json`. They are the job names in `security-scan.yml` (`Dependency audit`, `License policy`, `Semgrep`), in `codeql.yml` (`Analyze (javascript-typescript)`, `Analyze (python)`) and in `ci.yml` (`Check and test (ubuntu-latest, Bun latest)`). A check that is absent, not completed or not `success` fails the gate.

To refresh an allow entry: the audit gate blocks an advisory at or above `audit.level` unless an unexpired entry in `audit.allow` names its URL or numeric id, and the licenses gate waives a package only through an unexpired entry in `licenses.exceptions`. An expired entry fails the gate. To refresh one, confirm the reason still holds, set `expires` to a later `YYYY-MM-DD` (the entry is valid through that day) and update `reason`, all in `.github/security-policy.json`. A new audit entry is `{"advisory", "reason", "expires"}`; a new licenses entry is `{"name", "version", "license", "reason", "expires"}`. Each entry accepts a risk, so review it as you would code. The gate reads the policy from the commit it runs on, so an entry takes effect only in a commit that contains it.

## 4. Rollback

```bash
deploy/ultrathink-release.sh status
deploy/ultrathink-release.sh rollback
```

`rollback` points `current` at `previous`, swaps the two links so a second `rollback` returns to the newer release, restarts the service and probes it. It does not undo state changes: if a release migrated data that the older code cannot read, restore from a backup (section 5) as well. Rollback is not gated: it does not run the security gate (section 19) or the tests, and the release it switches to is not audited again.

nginx rollback: `rm /etc/nginx/sites-enabled/ultrathink.swcstudio.space && nginx -t && systemctl reload nginx` takes the vhost offline; to revert a change instead, reinstall the previous conf from git.

## 5. Backup and disaster recovery

The state directory `/var/lib/ultrathink` has three independent layers:

- **Snapshot ring** (`ultrathink-snapshot.timer`, every 30 seconds): point-in-time copies on the same host. A local restore goes to the newest snapshot at or before the target time.
- **Daily archive** (`ultrathink-maintenance.timer`, 03:17 UTC): one verified whole-state archive a day, 14 kept.
- **Off-host copy** (written by the snapshot tick every `ULTRATHINK_OFFHOST_INTERVAL_SECONDS`, default 300): the newest snapshot, encrypted with age and pushed to an rsync target. The daily archive goes to the same target when `ULTRATHINK_BACKUP_RSYNC_TARGET` is set.

### Targets

These are design targets. None of them has been measured on a live host.

| Target | Design value | Basis | Status |
|---|---|---|---|
| Local RPO | under 1 minute | 30 s tick interval plus tick duration | Pending: staging tick on a copy of real state |
| Local restore RTO | under 5 minutes | Scripted restore with per-step timings | Pending: staging restore on a copy |
| Off-host RPO (region loss) | 300 s plus transfer time | Off-host push interval | Pending: off-host target and operator identity |

Not provided: per-transaction point-in-time recovery (restores go to tick granularity), automated failover (promotion is manual, see Promote below), and key custody (the operator holds the age identity, see Encryption). The open items are listed at the end of this section.

### Units

| Unit | Schedule | Runs | After install |
|---|---|---|---|
| `ultrathink-snapshot.timer` | every 30 s (`OnUnitActiveSec=30s`) | `ultrathink-snapshot.sh tick` | Disabled. Keep it disabled and stopped until the staging tick is recorded under "Open items". |
| `ultrathink-maintenance.timer` | daily, 03:17 UTC | `ultrathink-backup.sh run` | Enabled (section 2, step 6). |
| `ultrathink-drill.timer` | 1st of each month, 04:17 UTC, random delay up to 30 minutes | `ultrathink-restore.sh drill` | Not enabled by the release. Enable it after the staging drill passes. |

Ticks never overlap: systemd does not start an active oneshot, and the script also holds a lock.

### Snapshot ring and point-in-time recovery

Each tick (`deploy/ultrathink-snapshot.sh tick`, run by `ultrathink-snapshot.service` as user `ultrathink`):

1. Disk guard. The tick needs free space of at least the larger of `ULTRATHINK_SNAPSHOT_MIN_FREE_BYTES` (default 1 GiB) and twice the size of the database and its WAL. Below that it writes nothing and fails.
2. `VACUUM INTO` a temporary file in the ring. The copy runs in one read transaction, so it is one consistent point in time. `integrity_check` runs on the copy, and the copy is renamed to `ultrathink-<stamp>.sqlite`.
3. File layer (`ULTRATHINK_SNAPSHOT_TREE=1`, the default). `rsync --link-dest` copies `jobs/`, `sessions/`, `journal/`, `oauth.json` and `audit.jsonl` into `tree/ultrathink-<stamp>/`. Unchanged files are hard links to the previous tree. The database is copied before the files: a file written in between is an orphan, which is harmless. The reverse order could leave a row pointing at a file that was never copied.
4. Off-host push, when it is due (see Encryption).
5. Prune by policy (`services/ultrathink/store/snapshots.ts`): every snapshot for one hour, then the newest per five minutes up to `ULTRATHINK_SNAPSHOT_KEEP_HOURS` (default 24). The newest snapshot is never deleted. Entries dated in the future are kept and do not count as newest.

Stamps are UTC with milliseconds, for example `ultrathink-20261021T043224933Z.sqlite`. A new stamp is never older than the newest existing one plus 1 ms, so a backward clock step cannot reuse or reorder a name.

The ring holds plaintext prompts and `oauth.json` for its whole window, in the same trust boundary as the state directory. Erasure timeline: live rows follow `ULTRATHINK_RETENTION_DAYS` (30), the ring keeps 24 hours, daily archives keep 14 days, and off-host copies stay until the target's own cleanup removes them.

| Variable | Default | Meaning |
|---|---|---|
| `ULTRATHINK_SNAPSHOT_DIR` | `$ULTRATHINK_BACKUP_DIR/ring` (`/var/backups/ultrathink/ring`) | Ring location, outside the state directory |
| `ULTRATHINK_SNAPSHOT_TREE` | `1` | `0` skips the file layer |
| `ULTRATHINK_SNAPSHOT_KEEP_HOURS` | `24` | Ring window in whole hours, at least 1 |
| `ULTRATHINK_SNAPSHOT_MIN_FREE_BYTES` | `1073741824` | Disk guard floor |
| `ULTRATHINK_OFFHOST_INTERVAL_SECONDS` | `300` | Minimum seconds between off-host pushes |

Set these in `/etc/ultrathink/ultrathink.env` (mode 0600) only when a default is wrong. None of them is a secret.

Status and logs:

```bash
/opt/ultrathink/current/deploy/ultrathink-snapshot.sh status
journalctl -u ultrathink-snapshot -n 50 --no-pager
systemctl list-timers ultrathink-snapshot
```

`status` prints `newest`, `age_seconds`, `snapshots`, `free_bytes` and `offhost_last_epoch` (`never` before the first push). It exits 1 when the ring is empty. Run it as root, so the env file can be read. Start a tick only through the unit (`systemctl start ultrathink-snapshot.service`). A tick run by hand as root can leave root-owned files in the ring, and those block later ticks. Each tick prints timing lines (`step copy`, `step check`, `step tree`, `step offhost`, `step prune`).

#### Measured cost of VACUUM INTO

Measured 2026-10-21 UTC on a synthetic store with the ultrathink schema: bun 1.4.0, bun:sqlite SQLite 3.53.2, median of 5 runs per size, one VPS (8 vCPU, AMD EPYC 9354P, QEMU virtual disk).

| Source size | Source bytes | Rows runs / phases / token_ledger | VACUUM INTO ms (median, min to max) | Output bytes | Peak RSS MiB (VmHWM) | Plain cp ms (checkpointed DB) | integrity_check ms (of the copy) |
|---|---:|---:|---:|---:|---:|---:|---:|
| 1 MiB | 1,069,056 | 104 / 348 / 348 | 23.3 (14.6 to 36.7) | 1,069,056 | 33.4 (29.8 before) | 3.9 | 2.2 |
| 10 MiB | 10,522,624 | 1086 / 3664 / 3664 | 71.1 (50.6 to 137.1) | 10,469,376 | 35.4 (29.8 before) | 14.7 | 24.2 |
| 100 MiB | 104,865,792 | 11012 / 36398 / 36398 | 398.9 (370.2 to 722.5) | 104,329,216 | 35.4 (29.8 before) | 113.5 | 222.4 |

Derived from the medians (arithmetic, not measured):

- Copy step without bun startup (VACUUM plus integrity_check): about 25 ms at 1 MiB, 95 ms at 10 MiB, 621 ms at 100 MiB.
- Sustained write at one tick per 30 seconds: about 0.03, 0.33 and 3.3 MiB/s.
- Ring footprint if a 100 MiB store stays that size: at most 396 snapshots (120 in the first hour, 276 five-minute buckets for hours 1 to 24), about 38.5 GiB of plaintext.

Caveats:

- The store is synthetic. Real data, page cache and disk differ, so the staging tick on real state is still required.
- The harness never forces writeback, and each output is deleted within seconds. Whether SQLite fsyncs the `VACUUM INTO` output was not verified, so device latency may or may not be inside these numbers.
- The first two runs at 10 and 100 MiB were slower (137.1 and 117.9 ms; 684.1 and 722.5 ms) than runs 3 to 5. The cause was not isolated, and the medians include those runs.
- `integrity_check` runs twice per tick: once in the copy action (`deploy/ultrathink-dr-lib.sh`, `check(dst)`) and once in the snapshot script's own `dr_bun check` step.
- The measurement host had 9.4 GB free on a 400 GB disk at 98 percent use. The 38.5 GiB ring at 100 MiB does not fit there. Size the backup filesystem before enabling the timer.

#### Keep the snapshot timer disabled

`ultrathink-snapshot.timer` stays disabled until a staging tick on a copy of real state has been recorded in this section: the duration of `step copy` and the whole tick over 10 minutes, the IO cost, and the ring size that results. Only then run `systemctl enable --now ultrathink-snapshot.timer`.

### Daily archive

The daily timer runs `deploy/ultrathink-backup.sh run` as user `ultrathink`:

- `ultrathink.sqlite` copied with `VACUUM INTO` (consistent while the service runs; the `sqlite3` CLI is not needed), `oauth.json`, `audit.jsonl` when present, and the `jobs/`, `sessions/` and `journal/` directories (saved plans and client-driven sessions live in the last two), with `PRAGMA integrity_check` on the copy and a `SHA256SUMS` file. The plaintext archive is verified in a 0700 staging directory before it is encrypted or moved into place.
- Archive `/var/backups/ultrathink/ultrathink-<utc>.tar.gz` (mode 0600 in a 0700 directory), 14 kept. With `ULTRATHINK_BACKUP_RECIPIENT` set, the archive is `ultrathink-<utc>.tar.gz.age` instead.
- Optional rsync when `ULTRATHINK_BACKUP_RSYNC_TARGET` is set in the env file. For ssh targets put the private key `id_ed25519` and a `known_hosts` file in `/var/lib/ultrathink/home/.ssh` (directory mode 0700, owner `ultrathink`); the script passes both paths to ssh explicitly because OpenSSH ignores `$HOME`. Set a recipient before the first push (see Encryption); without one nothing is pushed.
- Retention: `journal/`, `sessions/` and `jobs/` entries, and the root-level `last.json` and `last-plan.json` plan copies, untouched for `ULTRATHINK_RETENTION_DAYS` (default 30) are deleted; newer entries are not touched. SQLite runs not updated within the same window are deleted with their phases and ledger rows in one transaction; the job prints `database retention: removed N runs, M ledger rows`. `deploy/ultrathink-backup.sh prune` runs only the retention part. In `run` the three steps (backup, file retention, database retention) are independent: a failed backup marks the unit failed but retention still runs. A backup killed before it could clean up leaves a `.work.*` staging directory in the backup directory; the next backup removes those older than a day.

Manual run, status and verification:

```bash
systemctl start ultrathink-maintenance.service
journalctl -u ultrathink-maintenance -n 40 --no-pager
systemctl list-timers ultrathink-maintenance
deploy/ultrathink-backup.sh verify /var/backups/ultrathink/<archive>
```

`verify` of a `.tar.gz.age` archive needs `ULTRATHINK_AGE_IDENTITY` (see Encryption).

### Encryption and recipients

- Archives and off-host copies are encrypted with `age` to `ULTRATHINK_BACKUP_RECIPIENT`, which is an `age1...` public key or a path to a recipients file. The private identity never lives on the host. The local ring stays plaintext.
- Create the key pair on a workstation, not on the VPS:

  ```bash
  age-keygen -o ultrathink-backup-identity.txt
  ```

  The command prints the public key. Keep the identity file in your key store, and put only the public key (`age1...`) in `/etc/ultrathink/ultrathink.env`.
- `ULTRATHINK_AGE_IDENTITY` is a path read at run time for decryption: `restore --identity <file>`, `restore --archive <file>.tar.gz.age`, `backup verify` of an encrypted archive, and the drill's off-host leg. Never put it in the env file. For a decryption on the host, copy the identity to a mode 0600 file under `/run`, use it, and delete it.
- Fail closed. With an rsync target and no recipient, nothing is pushed. The daily job writes its local archive and fails. The tick writes its local snapshot, reports the off-host failure and exits 1.

#### Migrating an rsync target without a recipient

A host that already sets `ULTRATHINK_BACKUP_RSYNC_TARGET` pushes nothing until a recipient is set. Each daily run fails until then.

1. Create the key pair (above) and set `ULTRATHINK_BACKUP_RECIPIENT=age1...` in `/etc/ultrathink/ultrathink.env`.
2. Run `systemctl start ultrathink-maintenance.service` and read `journalctl -u ultrathink-maintenance -n 40 --no-pager`. Expect the lines `encrypting the archive to ULTRATHINK_BACKUP_RECIPIENT` and `rsync to the configured target`.
3. On the target host, confirm that a new `ultrathink-<utc>.tar.gz.age` arrived.
4. Remove the older plaintext `ultrathink-*.tar.gz` copies from the target under its own retention. The scripts never delete remote files.

Once the snapshot timer is enabled, its tick also pushes encrypted snapshots to `ring/` on the same target.

### Restore

Run restore as root. It stops and starts units. It refuses while `ultrathink-web` is active, and in that case it changes nothing. There is no dry run: a restore places files.

Choose one source. With none, the newest ring snapshot is used.

- `--at 2026-10-20T12:00:00Z`: the newest ring snapshot at or before this UTC time. A time earlier than the first snapshot exits 1.
- `--snapshot ultrathink-<stamp>.sqlite`: a named ring snapshot.
- `--archive <path>`: a daily archive, `ultrathink-<utc>.tar.gz`, or `ultrathink-<utc>.tar.gz.age` with `--identity <file>`.

Procedure:

1. Stop the web service: `systemctl stop ultrathink-web`. It drains on SIGTERM (`TimeoutStopSec=30`).
2. Restore. `--no-start` leaves `ultrathink-web` stopped so you can inspect the state first:

   ```bash
   /opt/ultrathink/current/deploy/ultrathink-restore.sh restore --at 2026-10-20T12:00:00Z --no-start
   ```

3. Read the output. It prints `source <label>`, one line per step (`step source`, `step guard`, `step verify`, `step compat`, `step place`, `step start`, `step probe`, each with milliseconds), `step total`, and `restore ok: <source>; pre-restore state at <dir>`. A restore from a ring snapshot whose tree directory is missing fails unless you add `--db-only`.
4. If you used `--no-start`, run `systemctl start ultrathink-web` and check readiness (see Known limits for the probe).

What restore does, in order (D12): refuse while the web unit runs; stop the snapshot and maintenance timers and services; verify the source (checksums, `quick_check`, `oauth.json` as JSON, and the audit chain of `audit.jsonl`); prove schema compatibility on a scratch copy, opened as the service user with the release's own store code; move the current state into `.pre-restore-<stamp>/`; place the source files with their modes; restart the timers; start the web unit unless `--no-start`.

- Failure before placement (verify or compatibility check): exit 1, state unchanged.
- Failure during placement: rolls back from `.pre-restore-<stamp>/`.
- Failure in start or probe after placement: exit 1. The restored state stays in place, and the previous state is in `.pre-restore-<stamp>/`.
- `--db-only` replaces `ultrathink.sqlite` with its `-wal` and `-shm` files, and leaves `oauth.json`, `audit.jsonl`, `jobs/`, `sessions/` and `journal/` alone.
- Restore is roll-forward only (D11). There is no schema version table, so the compatibility check is the only proof that the current release opens the restored database. Archives record the release revision in `BACKUP_INFO`; a mismatch prints a warning.

### Pre-restore state: cleanup rule

Each restore moves the replaced state into `/var/lib/ultrathink/.pre-restore-<stamp>/` (mode 0700). It holds plaintext prompts, OAuth secrets and the previous database. No script removes it, and retention does not look at it. Delete it by hand once the restored service has passed readiness and you no longer need it for a rollback:

```bash
rm -rf /var/lib/ultrathink/.pre-restore-<stamp>
```

Record the directory name and the removal date in your change log. Do not leave these directories on the host past the rollback decision.

### Promote (off-host, manual)

Promotion is the manual step for criterion 2. It is never automatic:

```bash
/opt/ultrathink/current/deploy/ultrathink-restore.sh promote --origin-fenced --archive <path> --identity <file>
```

Promote takes the same source options as restore. `--origin-fenced` is your attestation that the origin is stopped. The script cannot prove that across regions. Without the flag, promote exits 2 and changes nothing. With it, promote restores the source, starts `ultrathink-web`, probes it, and writes `.promoted-<stamp>` in the state directory. `--no-start` and `--scratch` are refused. Confirm the origin is stopped before you attest.

### Monthly drill

`ultrathink-drill.timer` runs `ultrathink-restore.sh drill` on the 1st of each month at 04:17 UTC, with up to 30 minutes of random delay. It replaces the earlier quarterly manual rehearsal.

- Local leg (always runs): restores the newest ring snapshot at or before now into a private scratch state, with the same checks as restore and `--scratch`. No unit is stopped or started, and the live state is not touched. If the snapshot has no tree directory, the leg restores the database alone.
- Off-host leg: runs only when `ULTRATHINK_AGE_IDENTITY` is set. It decrypts the newest off-host copy (`ring/.offhost` or a `.tar.gz.age` daily archive) and checks it. Otherwise it reports `offhost SKIPPED`.
- Output: `drill: local PASS, offhost SKIPPED` (each leg reports `PASS`, `FAIL` or `SKIPPED`). Exit 0 when no leg failed, and 1 when a leg that ran failed. A leg that did not run is never reported as PASS.
- The scratch directory is removed on exit.

The unit carries no identity. To run the off-host leg, copy the identity to a mode 0600 file under `/run`, run the drill as root with the variable set for that command only, then delete the file:

```bash
ULTRATHINK_AGE_IDENTITY=/run/ultrathink-drill/identity.txt /usr/bin/bash /opt/ultrathink/current/deploy/ultrathink-restore.sh drill
rm -f /run/ultrathink-drill/identity.txt
```

After a staging drill passes, enable the timer with `systemctl enable --now ultrathink-drill.timer`. Record the date, the `drill:` line and the step timings in your change log.

### Known limits of the current scripts

- The readiness probe in `restore` and `promote` (`probe_web`) runs `curl -fs` against `ULTRATHINK_PROBE_URL` (default `http://127.0.0.1:8795/readyz`) with no client certificate. The production listener accepts TLS only and requires a client certificate (section 1, item 4). As written, the probe cannot pass on the production host. The restore then exits 1 after it has placed files, and `ultrathink-web` keeps running. Check readiness by hand with the ops identity: `curl -s --cacert /etc/ultrathink/tls/ca.pem --cert /etc/ultrathink/tls/ops/cert.pem --key /etc/ultrathink/tls/ops/key.pem https://127.0.0.1:8795/readyz`.
- `restore` starts `ultrathink-snapshot.timer` and `ultrathink-maintenance.timer` at the end, whether or not they were enabled before. On a host that keeps the snapshot timer disabled, run `systemctl stop ultrathink-snapshot.timer` after the restore.

### Open items (BLOCKED)

Each item below cannot be closed from this repository. The prerequisite is what the operator must supply.

| Item | Needed to close | Prerequisite |
|---|---|---|
| Staging tick on real state | Ten minutes of ticks on a copy of production state; record `step copy`, the tick duration and the IO cost; then enable the timer. This is the input to the RPO claim. | A staging host with a copy of production state and this release installed |
| Staging restore timings | `restore --snapshot <name> --no-start` on that copy, with the step lines recorded. This is the input to the RTO claim. | The same staging host |
| Staging drill, both legs | `drill` with `ULTRATHINK_AGE_IDENTITY` on that host, the `drill:` line recorded; then enable the drill timer. | The operator's age identity, supplied at run time |
| Encrypted off-host round trip on the VPS | Encrypt, push and decrypt one real snapshot on the VPS. | `age` installed on the VPS (ops) and a customer recipient |
| Off-host target and its retention | An rsync target with a cleanup job for its own copies (for example cron `find -mtime`). | An operator-owned target host |
| DR drill on a second host | Restore an off-host copy on a second host and check it. | A second host |
| Customer-managed key custody (criterion 5) | Key creation, custody, a named key owner and a rotation procedure. | A customer KMS, HSM or hardware token |
| Per-transaction PITR and measured live RPO (criterion 1) | A WAL-class shipper with a reset barrier and an off-host sink. | Neither exists in this repository |
| Automated failover (criterion 2) | Automatic promotion with fencing. | A second-region host, a DNS or load-balancer control, and a fencing service |
| Measured RTO on a production-like host, and region-loss RTO (criterion 3) | A measured restore on a production-like host. Region loss also depends on the failover item. | A production-like host |

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
curl -s --cacert /etc/ultrathink/tls/ca.pem --cert /etc/ultrathink/tls/ops/cert.pem --key /etc/ultrathink/tls/ops/key.pem -o /dev/null -w '%{http_code}\n' https://127.0.0.1:8795/healthz
curl -s --cacert /etc/ultrathink/tls/ca.pem --cert /etc/ultrathink/tls/ops/cert.pem --key /etc/ultrathink/tls/ops/key.pem https://127.0.0.1:8795/readyz
curl -s --cacert /etc/ultrathink/tls/ca.pem --cert /etc/ultrathink/tls/ops/cert.pem --key /etc/ultrathink/tls/ops/key.pem https://127.0.0.1:8795/metrics | head -50
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
| curl exit 35 or 56 on `https://127.0.0.1:8795` with no HTTP status | The TLS handshake was refused: no client certificate, a leaf that does not chain to `ca.pem`, or an expired leaf. | `openssl x509 -in /etc/ultrathink/tls/ops/cert.pem -noout -enddate` must show a future date, and `openssl verify -CAfile /etc/ultrathink/tls/ca.pem /etc/ultrathink/tls/ops/cert.pem` must pass. Renewal is in section 17. |
| `deploy/ultrathink-release.sh` stops with `TLS file missing` or `cannot read ... app/key.pem` | The release checks the TLS files before it creates a release, so nothing was switched. | Install the files (section 17, cutover step 2), then run the release again. |
| The app stops at start with a `ConfigError` that names `ULTRATHINK_TLS_*` or `ULTRATHINK_PLAINTEXT_LOOPBACK` | TLS settings are missing, partial or not absolute paths. Plaintext starts only with `ULTRATHINK_PLAINTEXT_LOOPBACK=1`. | Fix `/etc/ultrathink/ultrathink.env` (section 17, environment table). Do not set the plaintext opt-in in production. |

## 8. Suggested alerts

Scrape `https://127.0.0.1:8795/metrics` with the probe identity (loopback only; nginx does not proxy it; section 17). List the series and label values with `curl -s --cacert /etc/ultrathink/tls/ca.pem --cert /etc/ultrathink/tls/ops/cert.pem --key /etc/ultrathink/tls/ops/key.pem https://127.0.0.1:8795/metrics`. Series:

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
| Backups | Newest `ultrathink-*.tar.gz` or `ultrathink-*.tar.gz.age` at the top level of `/var/backups/ultrathink` older than 36 hours (the `ring/` subdirectory is excluded, because it fills every 30 seconds); `ultrathink-maintenance.service` in `failed`. | Ticket |
| Snapshot unit failed | `systemctl is-failed ultrathink-snapshot.service` reports `failed`. The journal names the cause: `disk guard:`, `off-host push failed`, `tree copy failed` or an integrity failure. Applies only while the snapshot timer is enabled. | Ticket |
| Snapshot ring stale | `/opt/ultrathink/current/deploy/ultrathink-snapshot.sh status` shows `age_seconds` above 300, so no snapshot in five minutes. Applies only while the snapshot timer is enabled. | Page |
| Off-host push stale | `offhost_last_epoch` in the status output is older than 15 minutes, or `never` after the first push was due. Applies only when `ULTRATHINK_BACKUP_RSYNC_TARGET` is set and the snapshot timer is enabled. | Ticket |
| Drill unit failed | `ultrathink-drill.service` in `failed`; the journal shows `drill: local FAIL` or `offhost FAIL`. Applies only once the drill timer is enabled. | Ticket |
| Disk | `/var/lib/ultrathink` or `/var/backups/ultrathink` filesystem above 80 percent. | Ticket |
| Certificate | Edge or origin certificate expires in under 14 days (`certbot renew --dry-run` monthly). | Ticket |

The metric rows of this table are encoded as alert rules in `deploy/observability/rules.yml`; the backup, snapshot, drill, disk, certificate, restart and external-probe rows are not (section 16).

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
| Backups | `/var/backups/ultrathink/` | Database, `oauth.json`, `audit.jsonl`, `jobs/`, `sessions/`, `journal/` | 14 daily archives locally, as `.tar.gz` or, with `ULTRATHINK_BACKUP_RECIPIENT` set, `.tar.gz.age`; the rsync target sets its own retention. Archives contain prompts and OAuth secrets. |
| Snapshot ring | `/var/backups/ultrathink/ring/` (`ULTRATHINK_SNAPSHOT_DIR`): `ultrathink-<stamp>.sqlite` and `tree/ultrathink-<stamp>/` | Plaintext prompts, OAuth state and audit lines | Every snapshot for one hour, then the newest per five minutes up to `ULTRATHINK_SNAPSHOT_KEEP_HOURS` (default 24). The newest is never deleted. |
| Off-host staging copies | `/var/backups/ultrathink/ring/.offhost/` | Encrypted snapshot waiting to be pushed | Removed by the tick once older than 60 minutes. |
| Pre-restore state | `/var/lib/ultrathink/.pre-restore-<stamp>/` | Plaintext copy of the state a restore replaced | Never pruned. Delete by hand after the restore is confirmed (section 5, "Pre-restore state"). |
| Off-host copies | The rsync target (`ULTRATHINK_BACKUP_RSYNC_TARGET`): archives at its root, snapshots under `ring/` | Encrypted archives and snapshots, once a recipient is set | The operator's cleanup on the target host. The scripts never delete remote files. |
| Drill scratch | `$TMPDIR/ultrathink-restore.*` | Restored copy used by the drill | Removed when the drill exits. |
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
- **Smoke tests run unsandboxed.** The release script's smoke start uses the production secrets as the service user without the systemd sandbox, on loopback port 8796 for a few seconds, over TLS with the production leaves.
- **Internal CA key on the host (phase 69).** The intermediate key that issues the 24 hour internal leaves stays on the VPS, so the renewal timer needs no person. A host compromise can mint leaves for the internal trust domain. Section 17 gives the scope and the recovery limits.

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
2. `systemctl restart ultrathink-web`, then confirm `curl -s --cacert /etc/ultrathink/tls/ca.pem --cert /etc/ultrathink/tls/ops/cert.pem --key /etc/ultrathink/tls/ops/key.pem https://127.0.0.1:8795/readyz` is 200 and `ultrathink_planner_enabled` is 1.
3. Run one plan from a chat client with a short prompt.
4. Check the cost and size of that plan: `curl -s --cacert /etc/ultrathink/tls/ca.pem --cert /etc/ultrathink/tls/ops/cert.pem --key /etc/ultrathink/tls/ops/key.pem https://127.0.0.1:8795/metrics | grep ultrathink_plan_` (`ultrathink_plan_cost_usd_total`, `ultrathink_plan_tokens_total`; the counters start from zero at the restart, so the values are that plan), and inspect the job file under `/var/lib/ultrathink/jobs/` (as root; it holds the request and the plan) for the status, usage and any error.
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

Run it on the VPS against the public URL. The `/mcp` route admits only the edge identity (section 17), and a loopback request carrying the probe identity is refused there, so this check does not use the loopback listener. The key goes into a variable and is never printed:

```bash
BASE=https://ultrathink.swcstudio.space
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
  3. `systemctl restart ultrathink-web`, then `curl -s --cacert /etc/ultrathink/tls/ca.pem --cert /etc/ultrathink/tls/ops/cert.pem --key /etc/ultrathink/tls/ops/key.pem https://127.0.0.1:8795/readyz`.
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

Check the series with `curl -s --cacert /etc/ultrathink/tls/ca.pem --cert /etc/ultrathink/tls/ops/cert.pem --key /etc/ultrathink/tls/ops/key.pem https://127.0.0.1:8795/metrics | grep -E 'ultrathink_(adaptive_quota|load_forecast|recommended_replicas|fair_share|abuse_|rate_limited)'`.

### Blocked items

Each item below is not built. Its prerequisite is named; until that exists, only the behaviour above applies.

- **Automatic scale-out.** Prerequisite: an orchestrator (an autoscaler or HPA) and state that replicas can share. State is one SQLite file under `/var/lib/ultrathink`, so a second replica today would split every counter. Nothing here acts on the recommendation; an orchestrator would have to read it.
- **Shared rate-limit state (RATE-04, Redis Cluster).** Prerequisite: a reachable Redis Cluster endpoint, approval of a Redis client dependency (`package.json` has none), and a multi-replica deployment to test against. Until then the limits in this section apply per process.
- **SIEM delivery of abuse events.** Prerequisite: the Phase 68 SIEM sink and its collector. Until both exist, `abuse_penalty` stays in the local audit log and in any sink from section 14, and no collector alerts on it.
- **Calibration of `ULTRATHINK_REPLICA_CAPACITY_RPS`.** Prerequisite: a load test on the VPS with the production build. See the warning above.

## 16. Observability

This section covers the phase 71 signals. Metrics live in memory and reset on restart. Scrape them on loopback over TLS with the probe identity (section 17, loopback checks). Every family named here is in the closed list in `services/ultrathink/obs/metric-families.ts`, and the deploy files may use only those names.

### Traces

- `ULTRATHINK_OTLP_ENDPOINT` is optional. Unset or empty disables export. Otherwise it must be `https://`, or `http://` for `127.0.0.1`, `localhost` or `[::1]`, with no userinfo, query or fragment. A trailing slash is removed, and spans go to `<endpoint>/v1/traces` as OTLP/JSON. A bad value stops startup with an error that names the variable and never the value.
- Spans are recorded only for sampled requests. Sampling is head-based: the inbound `traceparent` flag decides, and a request with no inbound trace is sampled. Each request gets a SERVER span, and each OpenRouter attempt gets a CLIENT span named `POST chat/completions` with `server.address` set to the host only. No span carries a URL path, query, header, API key, bearer token or peer address.
- Export is bounded: a queue of 2048 spans, batches of 512, a 5 s timeout, and a flush on each 5 s runtime sample and at shutdown. A failed batch is dropped and never retried, and export never delays a response.
- `ultrathink_otel_spans_dropped_total{reason="queue_full"}` counts spans refused by a full queue, and `ultrathink_otel_export_failures_total` counts failed batches. If failures rise, test the collector from the host with `curl -s -o /dev/null -w '%{http_code}\n' -X POST '<endpoint>/v1/traces' -H 'content-type: application/json' -d '{}'`. Any HTTP status means the collector answers; `000` or a timeout means it does not.

### Log correlation

Lines written inside a request carry `reqId`, `traceId` and `spanId`. The `request` line (info, or warn for 5xx) has the `reqId` that the response returns in `X-Request-Id`, and its `spanId` equals the parent-id of the response `traceparent`. To follow one request, grep its `traceId` or `reqId` in `journalctl -u ultrathink-web -o cat`. A `planner_call` line carries the `reqId` of the request that started the plan.

`tracestate` is not parsed, forwarded or echoed (D3). This deviates from the W3C trace-context SHOULD on purpose: the service must not pass opaque third-party state to upstreams it calls for a client (`services/ultrathink/obs/trace.ts`). The owner may reverse it; see the blocked items.

### New metric families

| Family | Labels | Meaning |
|---|---|---|
| `ultrathink_upstream_breaker_transitions_total` | `from`, `to` | Breaker state changes on the OpenRouter hop |
| `ultrathink_audit_chain_notices_total` | none | Audit chain notices (section 14) |
| `ultrathink_retention_sweep_duration_seconds` | histogram | Duration of one retention sweep |
| `ultrathink_retention_errors_total` | none | Errors reported by retention sweeps |
| `ultrathink_otel_spans_dropped_total` | `reason` (`queue_full`) | Spans not exported |
| `ultrathink_otel_export_failures_total` | none | Export batches that failed and were dropped |
| `ultrathink_anomaly_active` | `signal` | 1 while that signal's detector is raised |
| `ultrathink_anomaly_transitions_total` | `signal`, `to` (`raised` or `cleared`) | Detector transitions |
| `ultrathink_slo_error_budget_remaining_ratio` | `slo` | Budget left over the 6 h in-process window; negative when overspent |
| `ultrathink_slo_burn_rate` | `slo`, `window` (`5m`, `30m`, `1h`, `6h`) | Burn rate per window; 1 spends the budget exactly at the objective's pace |
| `ultrathink_slo_observed_seconds` | `slo` | Span of history the SLO figures cover |

### Anomaly detection

The detector watches three runtime values sampled every 5 s: `event_loop_lag`, `rss` and `heap_used`. HTTP rates are not watched, because they are sparse at current traffic. Each signal keeps an EWMA baseline (alpha 0.1). After 30 warm-up samples, a sample breaches when its z-score reaches 4 in either direction; sigma is floored at 5 percent of the mean. A signal raises after 3 breaching samples in a row and clears after 5 calm samples in a row. The baseline freezes during a breach, so a sustained step does not become the new normal. After 120 breaching samples while raised, the detector adopts the new level and clears. Each raise or clear logs an `anomaly` line at warn with `signal` and `to`.

State is in memory, so after a restart a signal needs about 150 s of warm-up before it can raise. `UltrathinkAnomalyActive` is a ticket after 10 minutes. A raised signal marks a change in the process; it does not name a cause.

### SLO

- The SLI is the share of `ultrathink_http_requests_total` that is not `status_class="5xx"`. Only 5xx count as bad. The objective is 0.99 for `http_availability`, a chosen default that the owner may change in one place.
- In process, the budget and burn-rate gauges cover the last 6 h at 5 s sampling. Counters reset at restart, so `ultrathink_slo_observed_seconds` stays under 6 h for a while after one. A short value means partial coverage, not a healthy service.
- For 30 days, Prometheus records `ultrathink:http_bad_ratio:30d`. The 30-day budget is `1 - ratio / 0.01`.
- Burn-rate alerts: page when the 1 h and 5 m burn rates both exceed 14.4; ticket when the 6 h and 30 m burn rates both exceed 6.

### Deploy files

- `deploy/observability/rules.yml`: group `ultrathink-alerts` encodes the metric rows of section 8, plus breaker open (page, 5 m) and anomaly active (ticket, 10 m). Group `ultrathink-slo` holds the 30-day recording rule and the burn-rate alerts. Ratios and increases use `or vector(0)`. Check with `promtool check rules deploy/observability/rules.yml`. Not encoded: restart count, external probes, planner saturation, the USD budget threshold, backups, disk and certificates.
- `deploy/observability/prometheus.yml`: scrapes `127.0.0.1:8795/metrics` every 30 s over plain HTTP and loads `rules.yml`. It has no `alerting:` block. Prometheus must run on the same host, because `/metrics` answers only on loopback. The TLS-only listener refuses that plain-HTTP scrape; section 17 lists the change. Check with `promtool check config deploy/observability/prometheus.yml`.
- `deploy/observability/dashboards/ultrathink.json`: one Grafana dashboard with a `DS_PROMETHEUS` input and three rows: Service health, Business flows, and SLO and anomaly.
- `services/ultrathink/obs/observability-contract.test.ts` fails when a deploy file names a family outside `METRIC_FAMILIES`, so a rename cannot silently blank a rule or panel.

### Not provided by this repo

Each item is open and names its prerequisite. Until the prerequisite exists, the behaviour above is unverified end to end.

- **Collector export check.** Prerequisite: an OTLP/HTTP collector reachable at `ULTRATHINK_OTLP_ENDPOINT`. Until then, export is covered by unit tests only.
- **End-to-end trace view.** Prerequisite: the same collector, and the owner's ruling on `tracestate` (D3).
- **Scope of "all services" (D12).** Only `services/ultrathink` is covered. `hosts/*` and `src/*` are host and CLI packages; they count as services only if the owner rules so.
- **Prometheus host and tooling.** Prerequisite: Prometheus on the same host, `promtool`, and 30-day retention for the budget. Rule and config validity are unchecked until then.
- **Alert routing.** Prerequisite: an Alertmanager URL, or a PagerDuty or Opsgenie routing key, an on-call schedule, and a named escalation owner. `prometheus.yml` has no receiver, so alerts fire into nothing.
- **Log shipping.** Prerequisite: a log backend such as journald forwarded to an aggregator. The service writes to stdout only.
- **Grafana and staging.** Prerequisite: a Grafana instance with a Prometheus datasource to render the dashboard, and a staging host to run the scrape and rules before production.
- **ML anomaly models.** Prerequisite: persisted time-series history and an approved ML dependency. The detector is an in-process EWMA, and the repo has no runtime dependencies (D1).

## 17. Internal TLS and identity

Phase 69 puts the one internal hop, nginx to the app, and every loopback probe under mutual TLS. The app listens on `127.0.0.1:8795` with TLS only. A client reaches it only with a leaf certificate that chains to the internal CA, and the SPIFFE ID in that certificate selects what it may reach. Headers never set an identity.

**Status.** The code, the nginx vhost, the systemd units and the release script carry this change. The issuing script `deploy/ultrathink-pki.sh` is not in the repository, so the certificate files cannot be created from it yet (see 17.8). Until the files exist, the TLS-only service refuses to start, and the release script stops before it switches `current`. Do not work around that with `ULTRATHINK_PLAINTEXT_LOOPBACK=1`.

### 17.1 Identities and route policy

The trust domain is `ultrathink.internal` (`ULTRATHINK_SPIFFE_TRUST_DOMAIN`).

| SPIFFE ID | Certificate | Routes it may reach |
|---|---|---|
| `spiffe://ultrathink.internal/edge/nginx` | `edge/` leaf, presented by nginx | `proxied` and `health`: every route except `/metrics` |
| `spiffe://ultrathink.internal/ops/probe` | `ops/` leaf, used by root for probes, scrapes and operator curl | `health` (`/healthz`, `/readyz`) and `metrics` (`/metrics`) only |

- No certificate, a certificate that does not chain to `ca.pem`, or an expired one: the handshake fails and the request never reaches the app.
- A valid certificate whose SPIFFE ID is not in the table, or whose trust domain is not the configured one: the router answers 403 `forbidden_identity` on every route.
- `X-Real-IP` is honoured only from the edge identity. Any other peer's address is the one used for limits and logs.
- `/metrics` stays refused to any non-loopback peer, as before.

### 17.2 Files

| Path | Who reads it | Mode and notes |
|---|---|---|
| `/etc/ultrathink/tls/ca.pem` | app, nginx, probes | Trust bundle: root and intermediate |
| `/etc/ultrathink/tls/intermediate/intermediate.key` | root only | `0400`. Issuing key of the intermediate CA; never leaves the host |
| `/etc/ultrathink/tls/app/cert.pem`, `key.pem` | app (group `ultrathink`) | Server leaf for `127.0.0.1` (SAN IP). Key `0440 root:ultrathink` |
| `/etc/ultrathink/tls/edge/cert.pem`, `key.pem` | nginx (root) | Client leaf, SAN `spiffe://ultrathink.internal/edge/nginx`. Key `0400` |
| `/etc/ultrathink/tls/ops/cert.pem`, `key.pem` | root | Client leaf, SAN `spiffe://ultrathink.internal/ops/probe`. Key `0400` |

Directories come from `deploy/ultrathink-tmpfiles.conf`: `tls` `0750 root:ultrathink`; `intermediate`, `edge` and `ops` `0700 root:root`; `app` `0750 root:ultrathink`. The root CA key is not on the host.

Check a leaf's identity and expiry without printing key material: `openssl x509 -in /etc/ultrathink/tls/app/cert.pem -noout -ext subjectAltName -enddate`.

### 17.3 Chain, lifetimes and renewal

- **Root**: ECDSA P-256, 10 years, `pathlen:1`. Created offline and never copied to the VPS.
- **Intermediate**: `pathlen:0`, one year, signed by the offline root. Its key is created on the host.
- **Leaves**: 24 hours, usable for server and client authentication. Issued from the intermediate.
- **Renewal**: `ultrathink-cert-renew.timer` runs `ultrathink-cert-renew.service` hourly (up to 5 minutes random delay, `Persistent=true`). It renews each leaf with less than 12 hours left, then reloads only what changed:
  - app leaf renewed: `systemctl restart ultrathink-web`;
  - edge leaf renewed: `nginx -t && systemctl reload nginx`;
  - ops leaf renewed: nothing is reloaded.
- A failed renewal keeps the old files and fails the unit. The journal names the leaf: `journalctl -u ultrathink-cert-renew -n 50 --no-pager`.
- Old and new leaves of the same CA are both accepted during rotation, because the CA is the trust anchor.

Consequences:

- Each leaf is renewed about every 12 hours, so **the app restarts about twice a day.** The app reads its leaf only at start. A plan running at that moment ends `interrupted` (section 7).
- The intermediate is the one file the timer cannot renew. It expires a year after it was signed, and re-signing needs the offline root. Nothing in the repository alerts before it expires.

### 17.4 Accepted risk: the intermediate key on the host

Phase 69 keeps the intermediate key on the VPS so that the hourly timer can issue leaves without a person. This is accepted and recorded here.

- A compromise of the host with root reads the intermediate key and can mint leaves for any `spiffe://ultrathink.internal/...` identity, including `edge/nginx` and `ops/probe`.
- The exposure is this trust domain only. Public TLS does not trust this CA, and the root stays offline, so the attacker cannot sign a new intermediate.
- There is no revocation. Nothing checks a CRL or OCSP, and the app trusts every unexpired leaf that chains to `ca.pem`. Replacing the intermediate does not revoke a stolen one, because the root still signs it until it expires. Full recovery means a new root, a new `ca.pem` everywhere, and reissued leaves. The repository has no procedure for that.

### 17.5 Listener configuration

From `services/ultrathink/config/config.ts`:

| Variable | Default | Allowed |
|---|---|---|
| `ULTRATHINK_TLS_CERT` | unset | Absolute path. Production: `/etc/ultrathink/tls/app/cert.pem` |
| `ULTRATHINK_TLS_KEY` | unset | Absolute path. Production: `/etc/ultrathink/tls/app/key.pem` |
| `ULTRATHINK_TLS_CLIENT_CA` | unset | Absolute path. Production: `/etc/ultrathink/tls/ca.pem` |
| `ULTRATHINK_SPIFFE_TRUST_DOMAIN` | `ultrathink.internal` | 1 to 255 characters from `a-z`, `0-9`, `.`, `_` and `-` |
| `ULTRATHINK_PLAINTEXT_LOOPBACK` | unset (off) | `0` or `1`. `1` allows a start with no TLS settings; dev and local smoke only |

- The three TLS variables are one set. Set all three or none; a partial set stops startup even with the opt-in.
- With none set and no opt-in, startup stops with a `ConfigError` that names the variables.
- The listener binds `127.0.0.1` only.

Production env file lines:

```bash
ULTRATHINK_TLS_CERT=/etc/ultrathink/tls/app/cert.pem
ULTRATHINK_TLS_KEY=/etc/ultrathink/tls/app/key.pem
ULTRATHINK_TLS_CLIENT_CA=/etc/ultrathink/tls/ca.pem
```

Never set `ULTRATHINK_PLAINTEXT_LOOPBACK=1` on the VPS.

### 17.6 Cutover order

Do these steps in one window. Between the app restart (step 5) and the nginx reload (step 6), the public site answers 503 `{"error":"unavailable"}` (section 7), so keep the gap short.

1. Create the directories: `install -m 0644 deploy/ultrathink-tmpfiles.conf /etc/tmpfiles.d/ultrathink.conf && systemd-tmpfiles --create /etc/tmpfiles.d/ultrathink.conf`.
2. Create the CA bundle and the three leaves at the paths in 17.2, with the issuing script that 17.8 lists as blocked. Then check that each leaf chains to the bundle: `openssl verify -CAfile /etc/ultrathink/tls/ca.pem /etc/ultrathink/tls/app/cert.pem /etc/ultrathink/tls/edge/cert.pem /etc/ultrathink/tls/ops/cert.pem`. Each must print `OK`.
3. Add the three `ULTRATHINK_TLS_*` lines (17.5) to `/etc/ultrathink/ultrathink.env` with `sudoedit`.
4. Install the renewal units and reload systemd: `install -m 0644 deploy/ultrathink-cert-renew.service deploy/ultrathink-cert-renew.timer /etc/systemd/system/ && systemctl daemon-reload`. Do not enable the timer yet (step 8).
5. Release the app: `deploy/ultrathink-release.sh release <ref>`, or the first-cutover path in section 2. The release checks the TLS files before it creates a release, and it probes the new listener over mTLS before it keeps the switch.
6. In the same window: `install -m 0644 deploy/nginx-ultrathink.swcstudio.space.conf /etc/nginx/sites-available/ultrathink.swcstudio.space && nginx -t && systemctl reload nginx`. The vhost sends traffic to `https://ultrathink_app`, and `nginx -t` fails while the CA or edge files are missing.
7. Run the loopback checks in 17.7, and the public `/healthz` check from section 2, step 7.
8. Enable the timer, only once the issuing script exists: `systemctl enable --now ultrathink-cert-renew.timer`. Until then every hourly run fails with `PKI script not found`.

Rollback: put back the previous release and the previous vhost in the same window (section 2, first cutover, step 4). The previous code and vhost both speak plain HTTP. Rolling back one side alone gives the 503 described above.

### 17.7 Loopback checks

Probe identity, expect `200` on health and metrics:

```bash
curl -s --cacert /etc/ultrathink/tls/ca.pem --cert /etc/ultrathink/tls/ops/cert.pem --key /etc/ultrathink/tls/ops/key.pem -o /dev/null -w '%{http_code}\n' https://127.0.0.1:8795/healthz
```

No client certificate, expect no HTTP status and curl exit 35 or 56:

```bash
curl -sS --cacert /etc/ultrathink/tls/ca.pem -o /dev/null https://127.0.0.1:8795/healthz; echo "exit $?"
```

The edge leaf is refused on `/metrics` (expect 403). Testing it needs the edge key, which only root can read, and it presents nginx's identity, so run it only as a deliberate check.

### 17.8 Blocked items

Each item is not built. Its prerequisite is named. Until the prerequisite exists, the matching part of this section is unverified.

- **Issuing script and its test: `deploy/ultrathink-pki.sh` and `deploy/ultrathink-pki.test.ts`.** The write to `deploy/` was refused by a protected-path guard, so neither file is in the repository, and nothing in this runbook assumes that either exists. Prerequisite: the operator supplies an executable script with the subcommands the phase plan specifies (`init-root`, `init-intermediate`, `sign-intermediate`, `issue`, `renew-if-due`) and its test. Until then no leaf can be issued, `ultrathink-cert-renew.sh` exits 1 with `PKI script not found`, the release script stops before its switch, and the TLS-only service cannot start.
- **Checks that need the VPS.** `nginx -t` with the files present, `systemd-analyze verify` on the renewal units, `systemd-analyze security ultrathink-web`, and `openssl verify` on the installed leaves. Prerequisite: root on the VPS and the files from the item above.
- **Real SPIFFE identities (ZT-04 real SVIDs, ZT-06 SPIRE part).** Prerequisite: a SPIRE server and agent on the host, and a decision on who owns the `ultrathink.internal` trust domain. The local CA covers the authorization layer only.
- **Service mesh and mesh-wide mTLS (ZT-02, and ZT-01 beyond the one hop).** Prerequisite: a Kubernetes cluster, a chosen mesh control plane (Istio or Linkerd), and more than one service to protect. The repository has one internal hop.
- **Network policy at L3/L4 (ZT-05).** Prerequisite: root on `187.77.130.10` for `nft -c` and a rollback window that keeps SSH reachable, or a cluster with a NetworkPolicy-capable CNI. No ruleset is in the repository.
- **ZT-03.** The roadmap has no criterion 3 text. Prerequisite: the orchestrator confirms the intended requirement.

### 17.9 Open items

These need no outside resource, but they are not done.

- **Prometheus scrape.** `deploy/observability/prometheus.yml` still scrapes `http://127.0.0.1:8795/metrics`, and no phase 69 unit changes it. The change is `scheme: https` with `tls_config` naming the CA and the ops leaf and key, and its owner has to make it. Any scraper that reads the ops leaf once needs a reload after that leaf renews every 12 hours; nothing in this repository reloads it.
- **Alerts on leaf and intermediate expiry.** Section 8 has none. Prerequisite: the alert routing that section 16 already lists as open.
- **Plans interrupted at renewal.** Each app-leaf renewal restarts `ultrathink-web` (17.3). There is no in-place reload, so a plan running at that moment is interrupted. Prerequisite: a design decision on zero-downtime rotation.

## 18. Chaos experiments

The chaos framework in `services/ultrathink/chaos/` checks that the service degrades as designed when its upstream or one of its processes fails. Fault injection is off by default and is never armed in production. Nothing runs on a schedule: scheduled runs are not shipped (see "Not shipped" below).

### Gates

Fault injection in the service is armed only when all three variables follow the rules below.

| Variable | Default | Rule |
|---|---|---|
| `ULTRATHINK_CHAOS` | `0` | `0` or `1`; any other value stops startup and names the variable |
| `ULTRATHINK_CHAOS_ENV` | unset | must be `staging` when `ULTRATHINK_CHAOS=1` |
| `ULTRATHINK_CHAOS_PLAN` | unset | absolute path to a fault plan JSON file; requires `ULTRATHINK_CHAOS=1`; a relative path is refused |

With `ULTRATHINK_CHAOS=1` and no `staging` marker, the service exits at startup with a `ConfigError` that names `ULTRATHINK_CHAOS_ENV`. The same check runs whenever the flag is set, so a production environment cannot arm it. The deploy units and environment files in the repository never set these variables.

The CLI has its own gate, separate from the service. An `http` run against a host that is not loopback requires `ULTRATHINK_CHAOS_ENV=staging` in the environment of the CLI process. Without it the CLI exits 2 and sends no request. A rollback runs only when all four hold: a hypothesis failed, the template sets `rollbackOnFail`, `ULTRATHINK_CHAOS_ENV=staging`, and `--rollback-argv` was given. Otherwise the rollback is recorded as skipped.

### Drivers

- **`inprocess`** builds the real app inside the CLI process, with a temporary state directory and the template's fault plan at the OpenRouter seam. No upstream is reached, and the state directory is removed after the run. It does not read `ULTRATHINK_CHAOS`, because it never touches a running service. Its runs are deterministic.
- **`http`** observes a URL that is already running. It is the only driver for operator templates. The CLI never executes an operator step. It prints the step and waits until someone types `confirmed`; no load is sent before that.

### Commands

```bash
bun run chaos -- templates
bun run chaos -- run upstream-5xx-breaker --driver inprocess --history /tmp/chaos-history.jsonl
bun run chaos -- run sigterm-drain --driver http --base-url <staging-url> \
  --rollback-argv '["deploy/ultrathink-release.sh","rollback"]'
bun run chaos -- score upstream-5xx-breaker
```

`templates` lists id, failure mode, kind and hypothesis count. `run` exits 0 when every hypothesis passed, 1 when one failed, and 2 for a usage error or a refused gate. Each run appends one line to the history.

The documented rollback argv is `deploy/ultrathink-release.sh rollback`. The CLI runs it from its working directory, so run the CLI from the release root. The script rewrites the production symlinks and restarts the unit, so it needs root on the staging host. The CLI does not elevate privileges: run it as root with `ULTRATHINK_CHAOS_ENV=staging` in that root environment, or the rollback is skipped.

### Templates

| Id | Failure mode | Kind | Hypotheses | Status |
|---|---|---|---|---|
| `upstream-5xx-breaker` | `upstream_5xx` | inprocess | `breaker-open`, `healthz-200` | runs in process |
| `upstream-latency-timeout` | `upstream_latency` | inprocess | `calls-time-out`, `healthz-200` | runs in process |
| `inflight-saturation` | `inflight_saturation` | inprocess | `overload-refused`, `readyz-200` | runs in process |
| `sigterm-drain` | `sigterm_drain` | operator | `readyz-503-during-drain` | not yet run on staging |
| `persistence-unavailable` | `persistence_unavailable` | operator | `healthz-503`, `healthz-error-persistence-unavailable` | BLOCKED, do not run |
| `audit-corrupt` | `audit_corrupt` | operator | `readyz-200-after-audit-corrupt`, `healthz-200-after-audit-corrupt` | not yet run on staging |
| `stale-journal-retention` | `stale_journal` | operator | `readyz-200-with-stale-journal`, `healthz-200-with-stale-journal` | not yet run on staging |

Operator prerequisites, each performed by hand on the staging host:

- **`sigterm-drain`.** Set `ULTRATHINK_DRAIN_MS` to at least 30000 in `/etc/ultrathink/ultrathink.env` and restart `ultrathink-web.service`; the default of 5000 is too short to observe. Then run `sudo systemctl kill --kill-who=main --signal=SIGTERM ultrathink-web.service` once. Do not `stop` or `restart` the unit during the run. `Restart=always` starts it again after the drain, and that restart falls outside the observation window.
- **`audit-corrupt`.** While the unit runs, append one non-JSON line to `<stateDir>/audit.jsonl`, which is `/var/lib/ultrathink/audit.jsonl` unless `ULTRATHINK_STATE_DIR` is set. Readiness and health must not change, because audit is fail-open. The line also breaks the audit hash chain, so the tamper watch in section 14 is expected to alert. The hypotheses do not check that alert, and it has not been observed on staging.
- **`stale-journal-retention`.** Create `journal/<valid-session-id>` under the state directory and age it with `touch -d` past `ULTRATHINK_RETENTION_DAYS` (use N+1 days if the environment sets N). The retention sweep runs on the maintenance schedule, not on a request, so this step does not force removal. The hypotheses check only readiness and liveness.
- **`persistence-unavailable`: BLOCKED.** `store.ping()` runs `SELECT 1` on the SQLite handle that is already open. Changing the file's permissions or deleting it leaves that handle working, and no operator step makes `ping()` return false. The template needs a code seam in `services/ultrathink/store/store.ts`, which this phase does not change. Do not run it.

### Reading `score`

`score <id>` reads the history and prints:

- `runs`: the number of runs recorded for that template.
- `mean`: the resilience figure, the mean of the last 20 run scores for the template. A run scores 100 times the passed hypotheses divided by the total hypotheses.
- `trend slope`: the least-squares slope of those same scores against run order, in points per run. A negative slope means scores are falling. It needs at least two runs; below that the line reads `trend: needs at least 2 runs`.
- `latest`: the score of the most recent run.

Unreadable history lines are left out of the figures and reported on stderr as `skipped N unreadable history line(s)`. With no runs the output is `<id>: no runs recorded`.

The default history file is `<ULTRATHINK_STATE_DIR>/chaos/history.jsonl`, or `/var/lib/ultrathink/chaos/history.jsonl` when `ULTRATHINK_STATE_DIR` is unset. `run` and `score` both use it. Set `ULTRATHINK_STATE_DIR` or pass `--history PATH`. A history write that fails is reported with exit 2, after the experiment has already run.

### Not shipped

- **CHAOS-04, scheduled chaos.** No timer, unit or schedule exists. Scheduled runs need a staging environment with its own state directory and non-production secrets, and a signed chaos policy that names the blast radius, the abort criteria and an owner. The repository has none of these yet.
- **Network-level faults.** TCP partitions and real latency need a staging host with `toxiproxy` or `tc netem` between the service and its upstream. The framework injects faults only at the OpenRouter seam.
- **Long-horizon trend charts.** The trend covers the local run history only. A time-series store is needed for charts over longer periods.

### Status

The gates, templates, scoring, history and in-process runs are covered by `bun test services/ultrathink/config services/ultrathink/chaos`. The operator templates and the live rollback have not been run against a staging host.

## 19. Security scanning pipeline

The pipeline is a set of gates that fail closed: a missing check run, an expired allow entry or a tool error fails the run. The gate CLI is `bun scripts/security-gate.ts <mode>` with the modes `audit`, `licenses`, `checks` and `report`, each writing one file to `--out`. Exit 0 passes, 1 is a policy failure (the evidence is still written), and 2 is a usage error, an unknown tool output shape or a tool error. Each run deletes its own evidence file first, so an older pass cannot survive.

| Gate | Workflow or script | Runs | Blocks |
|---|---|---|---|
| Dependency audit | `.github/workflows/security-scan.yml`, job `Dependency audit` | `audit` on `.` and `plugins/omp-token-opt` | the pull request or push check |
| License policy | `.github/workflows/security-scan.yml`, job `License policy` | `licenses` on both roots | the pull request or push check |
| Semgrep | `.github/workflows/security-scan.yml`, job `Semgrep` | `semgrep --test` on `.semgrep/rules`, then a scan with `--error` (pinned `semgrep==1.182.0`) | the pull request or push check |
| CodeQL | `.github/workflows/codeql.yml`, jobs `Analyze (javascript-typescript)` and `Analyze (python)` | CodeQL analysis | the pull request or push check |
| Release gate | `.github/workflows/release.yml`, step `Security gate` | `checks`, `audit`, `licenses`, then `report` | creating the GitHub release |
| VPS gate | `deploy/ultrathink-release.sh`, function `security_gate` | `audit --root .` | switching `current` to the new release |

A check blocks a merge only once branch protection requires it, which is item SC1 below. Dependabot (`.github/dependabot.yml`) opens weekly grouped pull requests for the GitHub Actions versions, the root `bun` lockfile and the `plugins/omp-token-opt` lockfile.

### Blocked and open items

| Item | State | Prerequisite |
|---|---|---|
| SC1 required checks | BLOCKED (external) | A repository administrator marks the six `requiredChecks` names as required on `main` in branch protection. Until then no check blocks a merge. |
| Semgrep findings | BLOCKED | `services/ultrathink/ui/graph-app.test.ts` calls `new Function` on repo-owned strings at lines 67, 140 and 223, and the rule `no-dynamic-code` (`.semgrep/rules/no-dynamic-code.yaml`) reports each one. The `Semgrep` job fails until a human approves a suppression for each. This phase adds no suppression. |
| Tag ancestry | Open gap | The release gate reads check runs for the tagged commit. It does not check that the commit is reachable from `main`, and a `pull_request` run on that commit counts the same as a run on `main`. Until `release.yml` checks ancestry, tag only a commit that merged to `main` and passed there. |
| Prerelease tag run | BLOCKED (external) | Operator approval. Pushing a tag such as `v1.5.0-rc.1` runs `release.yml` on GitHub and creates a prerelease. |
| Red PR run | BLOCKED (external) | A temporary branch with `eval("1")` in `scripts/`, opened as a pull request and closed without merging, to show the `Semgrep` job fails on a finding. |
| SC2 DAST | BLOCKED | A staging URL with TLS, non-production secrets, a test OAuth client and a ZAP target. No workflow is added. |
| SC4 container image scanning | BLOCKED | A containerize decision and a registry. No Dockerfile is added. |
| VPS gate scope | Known limit | `security_gate` runs `audit --root .` only. It does not audit `plugins/omp-token-opt`, and it runs neither `licenses` nor `checks`. Widening it is a change to `deploy/ultrathink-release.sh`, which this phase does not make. |

### Status

The workflows, the gate CLI and `.github/security-policy.json` are part of this phase's change. `semgrep` and `actionlint` are not installed on the host where this section was written, so the Semgrep rule tests, the Semgrep scan and the workflow lint have not run locally; the first run is the CI job. The red PR run and the prerelease tag run have not happened.
## 20. Policy as code

Phase 75. Policy is Rego under `policy/`, tested with `opa test`, and evaluated by the pinned OPA CLI against the repository and, when asked, against the live response headers. Drift detection is report only. The scope is the enumerated domains: the CI workflows, the web and drift units, and the security headers. Organisation-wide policy (GitHub rulesets, environment protection rules, cloud IAM) is not covered.

### Status

| Item | Status | Prerequisite |
|---|---|---|
| OPA pin, `policy/opa-pin.json` | BLOCKED. `version`, `sha256` and `url` are null. | An operator-approved fetch of the OPA release asset `opa_linux_amd64_static` and its published checksum. Verify the checksum before writing the pin. |
| Rego execution | Not run on the machine where this section was written: `command -v opa` returned nothing. | The pinned binary, or the `policy.yml` CI job. |
| `policy:check` | Fails closed until the pin is set. It refuses to download and exits 1 with `no verified OPA pin`. | The pin above, or an explicit `OPA_BIN`. |
| Drift units | Installed by hand and not enabled. | An operator with root on the host. Enabling them is a separate decision, recorded here when made. |
| Maintenance unit in unit scope | Not in scope. The baseline result is recorded below. | Add it to `unit_scope` in `policy/units.rego` and cover it in `units_test.rego` in the same change, then run the Rego tests in CI. |

### Pinning OPA

1. Choose the OPA release tag. Fetch the asset `opa_linux_amd64_static` and the release's published checksum. Both need operator approval.
2. Run `sha256sum` on the asset and compare the digest with the published checksum. A mismatch stops the process.
3. In a reviewed commit, set `version` (the tag), `sha256` (the verified 64-character hex) and `url` (`https://github.com/open-policy-agent/opa/releases/download/<tag>/opa_linux_amd64_static`) in `policy/opa-pin.json`.
4. Run `bash policy/check.sh`. It downloads the asset again and checks the digest again before it runs the binary.

On a host, the drift unit runs OPA from `OPA_BIN=/opt/ultrathink/bin/opa`. `check.sh` uses an explicit `OPA_BIN` as given, with no download and no digest check. Before installing a binary there, check its digest by hand against the pin:

```
sha256sum <verified-opa-binary>
install -m 0755 <verified-opa-binary> /opt/ultrathink/bin/opa
```

### Running the check

```
bash policy/check.sh                                  # or: bun run policy:check
bash policy/check.sh --live http://127.0.0.1:8795/    # also collects the live response headers
OPA_BIN=/path/to/opa bash policy/check.sh             # explicit binary, no digest check
bun run policy:collect                                # prints the input document to stdout
```

`check.sh` runs `opa check --strict` on every `.rego` file, then `opa test` on `policy/`, then evaluates `data.ultrathink.policy.violations` against the collected input. Exit 0 means every step passed and no violation was found. Exit 1 means a step failed, a checksum mismatched, the pin is unset, or violations were found. Exit 2 is a usage or configuration error.

### Installing the drift units (by hand, not enabled)

The drift units follow the convention of section 2 and the header of each file:

```
install -m 0644 deploy/ultrathink-drift.service deploy/ultrathink-drift.timer /etc/systemd/system/
systemctl daemon-reload
```

Do not run `systemctl enable` or `enable --now` on these units until the enablement decision is recorded in this section. A manual run is `systemctl start ultrathink-drift.service`, then `journalctl -u ultrathink-drift -n 50 --no-pager`. While the OPA pin is unset, the unit's second `ExecStart` (`policy/check.sh --live`) fails, and the unit reports failure. That is expected until section "Pinning OPA" is complete.

### Reading the drift report

The unit writes `/var/lib/ultrathink-policy/drift-report.json`, its only write, and the state directory is created by `StateDirectory=`. Each unit is `ok` (byte-identical to the installed copy), `drift`, or `missing`. The report also has the live header result under `live`. `cat /var/lib/ultrathink-policy/drift-report.json` shows the last run. The drift script exits 1 on drift, a missing unit or a failed live check, and it still writes the report.

### Remediation plan (manual, root)

Drift remediation is manual. No unit installs anything (D2). To print the commands that would bring drifted units up to date:

```
bash /opt/ultrathink/current/deploy/drift-check.sh --unit-dir /opt/ultrathink/current/deploy --install-dir /etc/systemd/system --report /tmp/drift-plan.json --remediation-plan
```

The output is `install -m 0644 <unit> <install-dir>/` lines and `systemctl daemon-reload`. Missing units are reported, not planned. Review the printed commands, then an operator with root runs them. Automated remediation needs an approval gate, such as a GitHub environment with required reviewers. That is a repository-admin setting and is not configured.

### Compliance report

```
bun run compliance                                              # Markdown to stdout, --root .
bun policy/compliance-report.ts --root . --out compliance.md    # Markdown to a file
bun policy/compliance-report.ts --root <tree> --controls <file> # another controls file
```

Each control in `policy/controls.json` is `PASS` (all evidence present, no pending reason), `PENDING` (a `pending` reason is set and no evidence is missing) or `FAIL` (an evidence path is missing or is not a regular file). The report records the sha256 of every present evidence file. Exit 0 means no FAIL, 1 means at least one FAIL (the report is still written), and 2 means a usage or schema error (no report). CI appends the report to the job summary. Result when this section was written: 6 PASS, 1 PENDING (`CRYPTO-BACKUP`), 0 FAIL, and the open finding `RET-D7`.

### Open findings

- **RET-D7 (retention).** Live runs are pruned after `ULTRATHINK_RETENTION_DAYS` (default 30). Archives are kept for `ULTRATHINK_BACKUP_KEEP` (default 14) and contain the pruned data. Off-host copies persist until the target's own cleanup removes them. The repository defines no erasure deadline that covers archives. This needs a retention decision from the data owner, then a change to the backup retention settings or to the erasure procedure.
- **CRYPTO-BACKUP (PENDING).** Phase 74 DR-05 encrypts archives with `age` when a recipient is set. Customer key creation and custody (KMS, HSM or token, key owner, rotation) are not in the repository.
- **Organisation-wide policy (C1).** GitHub rulesets, environment protection rules and cloud IAM are not in the repository. This needs an org admin export and an owner-provided inventory.
- **Host runtime evidence (C2).** The drift timer must run on the production host, with a journal that shows a passing run.
- **Remediation approval gate (C3).** Not configured. See the remediation section above.
- **Auditor attestation (C5).** Not started. See `docs/ops/compliance-mapping.md` for the prerequisites.
- **Rego verification.** The Rego rules run only in CI or after the pinned binary is installed.

### Maintenance unit baseline

`deploy/ultrathink-maintenance.service` is not in `unit_scope`. Its baseline was checked when this section was written by evaluating U-R1 to U-R4 against the collector output, using a TypeScript comparison of the same rules, because Rego does not run here. Result: no violations, so the baseline passes. The unit stays out of `unit_scope` in this change because `policy/units.rego` is outside the I1 change set. Adding it is a follow-up change that goes through the Rego tests in CI.

