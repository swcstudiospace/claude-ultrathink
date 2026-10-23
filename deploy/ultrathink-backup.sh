#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 SWC Studio
#
# Backup, verification and retention for the ultrathink state directory.
#
#   ultrathink-backup.sh run              backup, then prune old backups, then prune old state (what the timer runs)
#   ultrathink-backup.sh backup           consistent copy of the state into /var/backups/ultrathink/ultrathink-<utc>.tar.gz
#   ultrathink-backup.sh verify <archive> check checksums, SQLite integrity and oauth.json syntax of an archive
#   ultrathink-backup.sh prune            remove journal, sessions and jobs entries, the root last.json and last-plan.json copies and SQLite runs older than the retention window
#
# What a backup holds: ultrathink.sqlite (a VACUUM INTO copy, consistent while the service runs), oauth.json
# (registered clients and tokens; losing it logs every connector out) and the jobs/, sessions/ and journal/ directories
# (job status, saved plans and client-driven sessions; jobs/ alone would restore status without the plans). The archive
# holds user prompts and OAuth secrets: it is mode 0600 inside a 0700 directory. audit.jsonl (the audit chain) is
# included when present, and every archive is verified before it is kept. With ULTRATHINK_BACKUP_RECIPIENT set, only the
# age-encrypted .tar.gz.age form is written; without it nothing is pushed off-host.
#
# Environment (all optional; defaults are read from the service environment file when run as root):
#   ULTRATHINK_STATE_DIR              state directory (default /var/lib/ultrathink)
#   ULTRATHINK_BACKUP_DIR             archive directory (default /var/backups/ultrathink)
#   ULTRATHINK_BACKUP_KEEP            archives to keep (default 14)
#   ULTRATHINK_RETENTION_DAYS         age limit for journal, sessions, jobs entries, root plan copies and database runs (default 30; 0 turns retention off)
#   ULTRATHINK_BACKUP_RSYNC_TARGET    rsync destination, for example backup@host:/srv/ultrathink/ (default: none)
#   ULTRATHINK_BACKUP_RECIPIENT       age recipient (age1...) or recipients file; archives are encrypted when set (default: none)
#   ULTRATHINK_AGE_IDENTITY           age identity for verify of .tar.gz.age archives; never set on the host (default: none)
#   ULTRATHINK_BUN                    Bun binary (default /opt/ultrathink/bin/bun)
#
# SQLite is accessed through bun:sqlite because the sqlite3 CLI may not be installed. The script runs as the service
# user; started as root it re-executes itself as that user so no root-owned -wal or -shm file can appear in the state
# directory.
set -euo pipefail

# Shared settings, SQLite, age and rsync helpers (dr_setting, dr_bun, dr_age, dr_rsync). The lib sets ENV_FILE itself.
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/ultrathink-dr-lib.sh"
SERVICE_USER="${ULTRATHINK_SERVICE_USER:-ultrathink}"
SERVICE_HOME="${ULTRATHINK_SERVICE_HOME:-/var/lib/ultrathink/home}"
MODE="${1:-}"

usage() {
	cat >&2 <<'EOF'
usage: ultrathink-backup.sh run | backup | prune
       ultrathink-backup.sh verify <archive>
EOF
	exit 2
}

case "$MODE" in
run | backup | prune | verify) ;;
*) usage ;;
esac

STATE_DIR="$(dr_setting ULTRATHINK_STATE_DIR /var/lib/ultrathink)"
BACKUP_DIR="$(dr_setting ULTRATHINK_BACKUP_DIR /var/backups/ultrathink)"
KEEP="$(dr_setting ULTRATHINK_BACKUP_KEEP 14)"
RETENTION_DAYS="$(dr_setting ULTRATHINK_RETENTION_DAYS 30)"
RSYNC_TARGET="$(dr_setting ULTRATHINK_BACKUP_RSYNC_TARGET '')"
RECIPIENT="$(dr_setting ULTRATHINK_BACKUP_RECIPIENT '')"
BUN="$(dr_setting ULTRATHINK_BUN /opt/ultrathink/bin/bun)"

if [ "$(id -u)" -eq 0 ] && [ "$MODE" != verify ]; then
	id -u "$SERVICE_USER" >/dev/null 2>&1 || die "service user does not exist: $SERVICE_USER"
	install -d -m 0700 -o "$SERVICE_USER" -g "$SERVICE_USER" "$BACKUP_DIR"
	say "re-executing as $SERVICE_USER"
	exec setpriv --reuid="$SERVICE_USER" --regid="$SERVICE_USER" --init-groups -- \
		env "HOME=$SERVICE_HOME" "ULTRATHINK_STATE_DIR=$STATE_DIR" "ULTRATHINK_BACKUP_DIR=$BACKUP_DIR" \
		"ULTRATHINK_BACKUP_KEEP=$KEEP" "ULTRATHINK_RETENTION_DAYS=$RETENTION_DAYS" \
		"ULTRATHINK_BACKUP_RSYNC_TARGET=$RSYNC_TARGET" "ULTRATHINK_BACKUP_RECIPIENT=$RECIPIENT" "ULTRATHINK_BUN=$BUN" \
		bash "${BASH_SOURCE[0]}" "$@"
fi

[ -x "$BUN" ] || die "Bun not found at $BUN"
case "$KEEP" in '' | *[!0-9]*) die "ULTRATHINK_BACKUP_KEEP must be a positive integer" ;; esac
[ "$KEEP" -ge 1 ] || die "ULTRATHINK_BACKUP_KEEP must be at least 1"
case "$RETENTION_DAYS" in '' | *[!0-9]*) die "ULTRATHINK_RETENTION_DAYS must be a whole number of days (0 turns retention off)" ;; esac

# State directories a backup copies and retention prunes entry by entry.
STATE_DATA_DIRS="jobs sessions journal"
# The planner also writes full plan copies (request text included) next to the state directories.
STATE_ROOT_COPIES="last.json last-plan.json"
# Single files a backup copies when present. BACKUP_INFO files= lists the ones that were actually copied. The sealed
# audit segments (is_sealed_audit) are copied too; the chain does not verify without them.
STATE_FILES="audit.jsonl"

# Sealed audit segments are named audit-<first>-<last>.jsonl and hold the chain records before audit.jsonl.
is_sealed_audit() {
	[[ "$1" =~ ^audit-[1-9][0-9]*-[1-9][0-9]*\.jsonl$ ]]
}

# Bare names of the sealed audit segments in the state directory.
sealed_audit_names() {
	local path
	for path in "$STATE_DIR"/audit-*.jsonl; do
		if [ -f "$path" ] && is_sealed_audit "${path##*/}"; then
			printf '%s\n' "${path##*/}"
		fi
	done
}

work_dir=""
verify_dir=""
cleanup() {
	if [ -n "$work_dir" ] && [ -d "$work_dir" ]; then rm -rf -- "$work_dir"; fi
	if [ -n "$verify_dir" ] && [ -d "$verify_dir" ]; then rm -rf -- "$verify_dir"; fi
}
trap cleanup EXIT

# One `run` step in its own subshell. bash ignores `set -e` inside anything on the left of `||`, and `die` exits, so
# without this a hard failure in the backup would end the script before retention ran. The subshell does not inherit
# the EXIT trap, so it installs its own to remove the staging and verification directories.
run_step() {
	(
		trap cleanup EXIT
		"$@"
	)
}

do_verify() {
	local archive="${1:-}" plain top dirs dir files file
	[ -n "$archive" ] || usage
	[ -f "$archive" ] || die "archive not found: $archive"
	verify_dir="$(mktemp -d "${TMPDIR:-/tmp}/ultrathink-verify.XXXXXX")" || die "cannot create a temporary directory"
	plain="$archive"
	case "$archive" in
	*.tar.gz.age)
		# Needs ULTRATHINK_AGE_IDENTITY; dr_age exits 2 when it is not set.
		say "decrypting $archive"
		plain="$verify_dir/archive.tar.gz"
		dr_age decrypt "$archive" "$plain" || die "cannot decrypt $archive"
		;;
	esac
	say "extracting $archive"
	tar -xzf "$plain" -C "$verify_dir" --no-same-owner || die "cannot extract $archive"
	top="$(find "$verify_dir" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
	[ -n "$top" ] || die "archive has no top-level directory"
	[ -f "$top/SHA256SUMS" ] || die "archive has no SHA256SUMS"
	say "checking sha256 sums"
	(cd "$top" && sha256sum --check --quiet SHA256SUMS) || die "checksum mismatch"
	[ -f "$top/ultrathink.sqlite" ] || die "archive has no ultrathink.sqlite"
	dr_bun check "$top/ultrathink.sqlite" || die "SQLite integrity check failed"
	if [ -f "$top/oauth.json" ]; then dr_bun json "$top/oauth.json" || die "oauth.json is not valid JSON"; fi
	# BACKUP_INFO (covered by the checksums) lists what the backup copied; each entry must still be in the archive.
	# Archives written before sessions/, journal/ and audit.jsonl were included have no dirs= or files= line.
	dirs="$(sed -n 's/^dirs=//p' "$top/BACKUP_INFO" 2>/dev/null || true)"
	for dir in $dirs; do
		case " $STATE_DATA_DIRS " in *" $dir "*) ;; *) die "archive lists an unexpected directory: $dir" ;; esac
		[ -d "$top/$dir" ] || die "archive is missing $dir/"
	done
	files="$(sed -n 's/^files=//p' "$top/BACKUP_INFO" 2>/dev/null || true)"
	for file in $files; do
		case " $STATE_FILES " in *" $file "*) ;; *) is_sealed_audit "$file" || die "archive lists an unexpected file: $file" ;; esac
		[ -f "$top/$file" ] || die "archive is missing $file"
	done
	# The chain is checked whenever the archive holds an audit file; sealed segments alone still verify against the chain.
	if [ -f "$top/audit.jsonl" ] || [ -n "$files" ]; then
		say "checking the audit chain"
		"$BUN" "$(dr_repo_root)/services/ultrathink/obs/audit-cli.ts" verify "$top/audit.jsonl" ||
			die "audit chain is broken in archive: audit.jsonl"
	fi
	say "verified: $archive"
	rm -rf -- "$verify_dir"
	verify_dir=""
}

prune_archives() {
	local count=0 archive
	while IFS= read -r archive; do
		count=$((count + 1))
		if [ "$count" -le "$KEEP" ]; then continue; fi
		say "removing old backup $(basename "$archive")"
		rm -f -- "$archive"
	done < <(find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type f \( -name 'ultrathink-*.tar.gz' -o -name 'ultrathink-*.tar.gz.age' \) | sort -r)
}

do_backup() {
	local stamp name stage archive tmp_archive enc_tmp rsync_failed=0 dir file copied_dirs="" copied_files="" revision
	[ -d "$STATE_DIR" ] || die "state directory not found: $STATE_DIR"
	[ -f "$STATE_DIR/ultrathink.sqlite" ] || die "database not found: $STATE_DIR/ultrathink.sqlite"
	install -d -m 0700 "$BACKUP_DIR" || die "cannot create $BACKUP_DIR"
	# A run killed by SIGKILL (timeout escalation, OOM) skips the EXIT trap and leaves a plaintext copy of the state here.
	find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -name '.work.*' -mmin +1440 -exec rm -rf -- {} + ||
		warn "cannot remove stale staging directories in $BACKUP_DIR"
	stamp="$(date -u +%Y%m%dT%H%M%SZ)" || die "date failed"
	name="ultrathink-$stamp"
	work_dir="$(mktemp -d "$BACKUP_DIR/.work.XXXXXX")" || die "cannot create a staging directory in $BACKUP_DIR"
	stage="$work_dir/$name"
	mkdir -m 0700 "$stage" || die "cannot create $stage"

	say "copying the database with VACUUM INTO"
	dr_bun copy "$STATE_DIR/ultrathink.sqlite" "$stage/ultrathink.sqlite" || die "database copy failed"
	rm -f -- "$stage/ultrathink.sqlite-wal" "$stage/ultrathink.sqlite-shm"

	if [ -f "$STATE_DIR/oauth.json" ]; then
		say "copying oauth.json"
		cp -- "$STATE_DIR/oauth.json" "$stage/oauth.json" || die "cannot copy oauth.json"
		dr_bun json "$stage/oauth.json" || die "oauth.json is not valid JSON"
	else
		warn "no oauth.json in $STATE_DIR (skipped)"
	fi
	# Sealed segments are copied before audit.jsonl. A prune only deletes segments and records itself in the active file, so
	# a segment copied before the prune stays in the archive. Copied the other way round, an active file taken before a
	# prune would need a segment that the later segment copy no longer finds, and verification would reject the archive.
	while IFS= read -r file; do
		say "copying $file"
		cp -- "$STATE_DIR/$file" "$stage/$file" || die "cannot copy $file"
		copied_files="${copied_files:+$copied_files }$file"
	done < <(sealed_audit_names)
	if [ -f "$STATE_DIR/audit.jsonl" ]; then
		say "copying audit.jsonl"
		cp -- "$STATE_DIR/audit.jsonl" "$stage/audit.jsonl" || die "cannot copy audit.jsonl"
		copied_files="${copied_files:+$copied_files }audit.jsonl"
	fi
	# jobs/ holds status and usage only; the plans themselves live in sessions/ and journal/, so a restore needs all three.
	for dir in $STATE_DATA_DIRS; do
		if [ -d "$STATE_DIR/$dir" ]; then
			say "copying $dir/"
			cp -r -- "$STATE_DIR/$dir" "$stage/$dir" || die "cannot copy $dir/"
			copied_dirs="${copied_dirs:+$copied_dirs }$dir"
		fi
	done
	revision=unknown
	if [ -r "$(dr_repo_root)/REVISION" ]; then
		revision="$(head -n 1 "$(dr_repo_root)/REVISION" | tr -cd 'A-Za-z0-9._+-')"
		revision="${revision:-unknown}"
	fi
	printf 'created_utc=%s\nstate_dir=%s\ndirs=%s\nfiles=%s\nrevision=%s\n' "$stamp" "$STATE_DIR" "$copied_dirs" "$copied_files" "$revision" >"$stage/BACKUP_INFO" || die "cannot write BACKUP_INFO"

	say "writing checksums"
	(cd "$stage" && find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum >SHA256SUMS) || die "checksum step failed"

	tmp_archive="$work_dir/$name.tar.gz"
	tar -C "$work_dir" -czf "$tmp_archive" "$name" || die "tar failed"
	# The plaintext archive is verified in the 0700 staging directory before it is encrypted or moved into place (D10).
	do_verify "$tmp_archive"
	if [ -n "$RECIPIENT" ]; then
		# Encrypted through a .tmp name, so a failed run never leaves a partial .tar.gz.age behind.
		archive="$BACKUP_DIR/$name.tar.gz.age"
		enc_tmp="$archive.tmp"
		say "encrypting the archive to ULTRATHINK_BACKUP_RECIPIENT"
		dr_age encrypt "$tmp_archive" "$enc_tmp" || die "encryption failed; no archive was written"
		chmod 0600 "$enc_tmp" || die "chmod failed"
		mv -- "$enc_tmp" "$archive" || die "cannot move the archive into place"
	else
		archive="$BACKUP_DIR/$name.tar.gz"
		chmod 0600 "$tmp_archive" || die "chmod failed"
		mv -- "$tmp_archive" "$archive" || die "cannot move the archive into place"
	fi
	say "wrote $archive ($(du -h "$archive" | cut -f1))"

	prune_archives

	if [ -n "$RSYNC_TARGET" ]; then
		if [ -z "$RECIPIENT" ]; then
			warn "refusing plaintext off-host: ULTRATHINK_BACKUP_RECIPIENT is not set; the local backup is intact"
			rsync_failed=1
		else
			say "rsync to the configured target"
			if ! dr_rsync "$archive" "$RSYNC_TARGET"; then
				warn "rsync failed; the local backup is intact"
				rsync_failed=1
			fi
		fi
	fi
	[ "$rsync_failed" -eq 0 ] || return 1
}

# A journal, sessions or jobs entry (and the root-level last.json and last-plan.json plan copies) is removed only when
# nothing inside it (or the entry itself) was modified within the retention window, so a session that is still being
# written is never touched.
do_prune() {
	if [ "$RETENTION_DAYS" -eq 0 ]; then
		say "retention: disabled (ULTRATHINK_RETENTION_DAYS=0)"
		return 0
	fi
	local base entry removed=0 window_minutes=$((RETENTION_DAYS * 1440))
	case "$STATE_DIR" in
	/?*) ;;
	*) die "ULTRATHINK_STATE_DIR must be an absolute path" ;;
	esac
	[ -d "$STATE_DIR" ] || die "state directory not found: $STATE_DIR"
	for base in journal sessions jobs; do
		[ -d "$STATE_DIR/$base" ] || continue
		while IFS= read -r -d '' entry; do
			if [ -z "$(find "$entry" -mmin "-$window_minutes" -print -quit)" ]; then
				rm -rf -- "$entry"
				removed=$((removed + 1))
			fi
		done < <(find "$STATE_DIR/$base" -mindepth 1 -maxdepth 1 -print0)
	done
	for base in $STATE_ROOT_COPIES; do
		entry="$STATE_DIR/$base"
		[ -f "$entry" ] && [ ! -L "$entry" ] || continue
		if [ -z "$(find "$entry" -mmin "-$window_minutes" -print -quit)" ]; then
			rm -f -- "$entry"
			removed=$((removed + 1))
		fi
	done
	say "retention: removed $removed entries older than $RETENTION_DAYS days"
}

# SQLite rows: runs (any status) not updated within the retention window, with every row in a table that references
# runs through a foreign key (phases, token_ledger, run_leases, decisions, and any later table; services/ultrathink/
# store/retention.ts discovers them). `request` holds user prompts, so this is the database half of the retention policy. Runs with a ledger row dated today (UTC) are kept, so the daily ceiling,
# which sums token_ledger by day, never loses today's spend. Runs inside one transaction: all or nothing.
prune_database() {
	if [ "$RETENTION_DAYS" -eq 0 ]; then
		say "retention: disabled (ULTRATHINK_RETENTION_DAYS=0)"
		return 0
	fi
	[ -f "$STATE_DIR/ultrathink.sqlite" ] || {
		warn "no database in $STATE_DIR (skipped)"
		return 0
	}
	dr_bun prune-db "$STATE_DIR/ultrathink.sqlite" || die "database retention failed (nothing was deleted)"
}

case "$MODE" in
verify) do_verify "${2:-}" ;;
backup) do_backup ;;
prune)
	do_prune
	prune_database
	;;
run)
	status=0
	run_step do_backup || status=1
	run_step do_prune || status=1
	run_step prune_database || status=1
	exit "$status"
	;;
esac
