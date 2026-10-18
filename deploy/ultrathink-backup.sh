#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 SWC Studio
#
# Backup, verification and retention for the ultrathink state directory.
#
#   ultrathink-backup.sh run              backup, then prune old backups, then prune old state (what the timer runs)
#   ultrathink-backup.sh backup           consistent copy of the state into /var/backups/ultrathink/ultrathink-<utc>.tar.gz
#   ultrathink-backup.sh verify <archive> check checksums, SQLite integrity and oauth.json syntax of an archive
#   ultrathink-backup.sh prune            remove journal, sessions and jobs entries older than the retention window
#
# What a backup holds: ultrathink.sqlite (a VACUUM INTO copy, consistent while the service runs), oauth.json
# (registered clients and tokens; losing it logs every connector out) and the jobs/ directory. The archive holds user
# prompts and OAuth secrets: it is mode 0600 inside a 0700 directory. Encrypt before sending off-host unless the
# target is trusted.
#
# Environment (all optional; defaults are read from the service environment file when run as root):
#   ULTRATHINK_STATE_DIR              state directory (default /var/lib/ultrathink)
#   ULTRATHINK_BACKUP_DIR             archive directory (default /var/backups/ultrathink)
#   ULTRATHINK_BACKUP_KEEP            archives to keep (default 14)
#   ULTRATHINK_RETENTION_DAYS         age limit for journal, sessions and jobs entries (default 30)
#   ULTRATHINK_BACKUP_RSYNC_TARGET    rsync destination, for example backup@host:/srv/ultrathink/ (default: none)
#   ULTRATHINK_BUN                    Bun binary (default /opt/ultrathink/bin/bun)
#
# SQLite is accessed through bun:sqlite because the sqlite3 CLI may not be installed. The script runs as the service
# user; started as root it re-executes itself as that user so no root-owned -wal or -shm file can appear in the state
# directory.
set -euo pipefail

ENV_FILE="${ULTRATHINK_ENV_FILE:-/etc/ultrathink/ultrathink.env}"
SERVICE_USER="${ULTRATHINK_SERVICE_USER:-ultrathink}"
SERVICE_HOME="${ULTRATHINK_SERVICE_HOME:-/var/lib/ultrathink/home}"
MODE="${1:-}"

say() { printf '==> %s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }
die() {
	printf 'ERROR: %s\n' "$*" >&2
	exit 1
}

usage() {
	cat >&2 <<'EOF'
usage: ultrathink-backup.sh run | backup | prune
       ultrathink-backup.sh verify <archive>
EOF
	exit 2
}

# Read one KEY from the systemd-style environment file without sourcing it (values may contain "$").
# Only used for non-secret settings.
file_value() {
	local wanted="$1" line value
	[ -r "$ENV_FILE" ] || return 0
	while IFS= read -r line || [ -n "$line" ]; do
		case "$line" in
		"$wanted="*)
			value="${line#*=}"
			case "$value" in
			\"*\") value="${value#\"}"; value="${value%\"}" ;;
			\'*\') value="${value#\'}"; value="${value%\'}" ;;
			esac
			printf '%s' "$value"
			return 0
			;;
		esac
	done <"$ENV_FILE"
	return 0
}

setting() {
	# setting <name> <default>: environment first, then the environment file, then the default.
	local name="$1" default="$2" value="${!1:-}"
	if [ -z "$value" ]; then value="$(file_value "$name")"; fi
	printf '%s' "${value:-$default}"
}

case "$MODE" in
run | backup | prune | verify) ;;
*) usage ;;
esac

STATE_DIR="$(setting ULTRATHINK_STATE_DIR /var/lib/ultrathink)"
BACKUP_DIR="$(setting ULTRATHINK_BACKUP_DIR /var/backups/ultrathink)"
KEEP="$(setting ULTRATHINK_BACKUP_KEEP 14)"
RETENTION_DAYS="$(setting ULTRATHINK_RETENTION_DAYS 30)"
RSYNC_TARGET="$(setting ULTRATHINK_BACKUP_RSYNC_TARGET '')"
BUN="$(setting ULTRATHINK_BUN /opt/ultrathink/bin/bun)"

if [ "$(id -u)" -eq 0 ] && [ "$MODE" != verify ]; then
	id -u "$SERVICE_USER" >/dev/null 2>&1 || die "service user does not exist: $SERVICE_USER"
	install -d -m 0700 -o "$SERVICE_USER" -g "$SERVICE_USER" "$BACKUP_DIR"
	say "re-executing as $SERVICE_USER"
	exec setpriv --reuid="$SERVICE_USER" --regid="$SERVICE_USER" --init-groups -- \
		env "HOME=$SERVICE_HOME" "ULTRATHINK_STATE_DIR=$STATE_DIR" "ULTRATHINK_BACKUP_DIR=$BACKUP_DIR" \
		"ULTRATHINK_BACKUP_KEEP=$KEEP" "ULTRATHINK_RETENTION_DAYS=$RETENTION_DAYS" \
		"ULTRATHINK_BACKUP_RSYNC_TARGET=$RSYNC_TARGET" "ULTRATHINK_BUN=$BUN" \
		bash "${BASH_SOURCE[0]}" "$@"
fi

[ -x "$BUN" ] || die "Bun not found at $BUN"
case "$KEEP" in '' | *[!0-9]*) die "ULTRATHINK_BACKUP_KEEP must be a positive integer" ;; esac
[ "$KEEP" -ge 1 ] || die "ULTRATHINK_BACKUP_KEEP must be at least 1"
case "$RETENTION_DAYS" in '' | *[!0-9]*) die "ULTRATHINK_RETENTION_DAYS must be a positive integer" ;; esac
[ "$RETENTION_DAYS" -ge 1 ] || die "ULTRATHINK_RETENTION_DAYS must be at least 1"

BUN_TOOL='
const { Database } = require("bun:sqlite");
const { readFileSync } = require("node:fs");

function check(path) {
	const db = new Database(path);
	try {
		const rows = db.query("PRAGMA integrity_check").all();
		const ok = rows.length === 1 && Object.values(rows[0])[0] === "ok";
		if (!ok) throw new Error("integrity_check failed: " + JSON.stringify(rows.slice(0, 5)));
		return db.query("SELECT count(*) AS n FROM sqlite_master WHERE type = \u0027table\u0027").get().n;
	} finally {
		db.close();
	}
}

const action = process.env.UT_ACTION;
if (action === "copy") {
	const src = process.env.UT_SRC;
	const dst = process.env.UT_DST;
	const db = new Database(src);
	try {
		db.run("PRAGMA busy_timeout = 10000");
		db.run("VACUUM INTO \u0027" + dst.replaceAll("\u0027", "\u0027\u0027") + "\u0027");
	} finally {
		db.close();
	}
	console.log("sqlite copy ok, integrity ok, tables: " + check(dst));
} else if (action === "check") {
	console.log("sqlite integrity ok, tables: " + check(process.env.UT_SRC));
} else if (action === "json") {
	JSON.parse(readFileSync(process.env.UT_SRC, "utf8"));
	console.log("json ok");
} else {
	throw new Error("unknown action");
}
'

bun_tool() {
	# bun_tool <action> <src> [dst]
	UT_ACTION="$1" UT_SRC="$2" UT_DST="${3:-}" "$BUN" -e "$BUN_TOOL"
}

work_dir=""
verify_dir=""
cleanup() {
	if [ -n "$work_dir" ] && [ -d "$work_dir" ]; then rm -rf -- "$work_dir"; fi
	if [ -n "$verify_dir" ] && [ -d "$verify_dir" ]; then rm -rf -- "$verify_dir"; fi
}
trap cleanup EXIT

do_verify() {
	local archive="${1:-}" top
	[ -n "$archive" ] || usage
	[ -f "$archive" ] || die "archive not found: $archive"
	verify_dir="$(mktemp -d "${TMPDIR:-/tmp}/ultrathink-verify.XXXXXX")"
	say "extracting $archive"
	tar -xzf "$archive" -C "$verify_dir" --no-same-owner || die "cannot extract $archive"
	top="$(find "$verify_dir" -mindepth 1 -maxdepth 1 -type d | head -n 1)"
	[ -n "$top" ] || die "archive has no top-level directory"
	[ -f "$top/SHA256SUMS" ] || die "archive has no SHA256SUMS"
	say "checking sha256 sums"
	(cd "$top" && sha256sum --check --quiet SHA256SUMS) || die "checksum mismatch"
	[ -f "$top/ultrathink.sqlite" ] || die "archive has no ultrathink.sqlite"
	bun_tool check "$top/ultrathink.sqlite" || die "SQLite integrity check failed"
	if [ -f "$top/oauth.json" ]; then bun_tool json "$top/oauth.json" || die "oauth.json is not valid JSON"; fi
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
	done < <(find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type f -name 'ultrathink-*.tar.gz' | sort -r)
}

do_backup() {
	local stamp name stage archive tmp_archive rsync_failed=0
	[ -d "$STATE_DIR" ] || die "state directory not found: $STATE_DIR"
	[ -f "$STATE_DIR/ultrathink.sqlite" ] || die "database not found: $STATE_DIR/ultrathink.sqlite"
	install -d -m 0700 "$BACKUP_DIR"
	stamp="$(date -u +%Y%m%dT%H%M%SZ)"
	name="ultrathink-$stamp"
	work_dir="$(mktemp -d "$BACKUP_DIR/.work.XXXXXX")"
	stage="$work_dir/$name"
	mkdir -m 0700 "$stage"

	say "copying the database with VACUUM INTO"
	bun_tool copy "$STATE_DIR/ultrathink.sqlite" "$stage/ultrathink.sqlite" || die "database copy failed"
	rm -f -- "$stage/ultrathink.sqlite-wal" "$stage/ultrathink.sqlite-shm"

	if [ -f "$STATE_DIR/oauth.json" ]; then
		say "copying oauth.json"
		cp -- "$STATE_DIR/oauth.json" "$stage/oauth.json" || die "cannot copy oauth.json"
		bun_tool json "$stage/oauth.json" || die "oauth.json is not valid JSON"
	else
		warn "no oauth.json in $STATE_DIR (skipped)"
	fi
	if [ -d "$STATE_DIR/jobs" ]; then
		say "copying jobs/"
		cp -r -- "$STATE_DIR/jobs" "$stage/jobs" || die "cannot copy jobs/"
	fi
	printf 'created_utc=%s\nstate_dir=%s\n' "$stamp" "$STATE_DIR" >"$stage/BACKUP_INFO" || die "cannot write BACKUP_INFO"

	say "writing checksums"
	(cd "$stage" && find . -type f ! -name SHA256SUMS -print0 | sort -z | xargs -0 sha256sum >SHA256SUMS) || die "checksum step failed"

	archive="$BACKUP_DIR/$name.tar.gz"
	tmp_archive="$work_dir/$name.tar.gz"
	tar -C "$work_dir" -czf "$tmp_archive" "$name" || die "tar failed"
	chmod 0600 "$tmp_archive" || die "chmod failed"
	mv -- "$tmp_archive" "$archive" || die "cannot move the archive into place"
	say "wrote $archive ($(du -h "$archive" | cut -f1))"

	do_verify "$archive"
	prune_archives

	if [ -n "$RSYNC_TARGET" ]; then
		say "rsync to the configured target"
		if ! rsync -a --chmod=F600 -e 'ssh -o BatchMode=yes -o ConnectTimeout=20' -- "$archive" "$RSYNC_TARGET"; then
			warn "rsync failed; the local backup is intact"
			rsync_failed=1
		fi
	fi
	[ "$rsync_failed" -eq 0 ] || return 1
}

# A journal, sessions or jobs entry is removed only when nothing inside it (or the entry itself) was modified within
# the retention window, so a session that is still being written is never touched.
do_prune() {
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
	say "retention: removed $removed entries older than $RETENTION_DAYS days"
}

case "$MODE" in
verify) do_verify "${2:-}" ;;
backup) do_backup ;;
prune) do_prune ;;
run)
	status=0
	do_backup || status=1
	do_prune || status=1
	exit "$status"
	;;
esac
