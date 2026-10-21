#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 SWC Studio
#
# Restore, promote and drill for the ultrathink state directory. Sources deploy/ultrathink-dr-lib.sh.
#
#   ultrathink-restore.sh restore [--at ISO_UTC | --snapshot NAME | --archive PATH] [--identity FILE]
#                                 [--db-only] [--no-start] [--scratch]
#   ultrathink-restore.sh promote --origin-fenced [--at ISO_UTC | --snapshot NAME | --archive PATH]
#                                 [--identity FILE] [--db-only]
#   ultrathink-restore.sh drill
#
# restore picks a source (the newest ring snapshot at or before --at, a named ring snapshot, or an archive), refuses
# while ultrathink-web is active, verifies the source, proves schema compatibility on a scratch copy (as the service
# user when run as root), then moves the live files into $STATE/.pre-restore-<stamp>/ and places the source. The
# snapshot and maintenance timers are stopped for the duration and restarted afterwards, also when the restore fails.
#   --db-only   replace ultrathink.sqlite (with its -wal and -shm); leave oauth.json, audit.jsonl and the data dirs alone
#   --no-start  do not start ultrathink-web; the timers are restarted either way
#   --scratch   restore into ULTRATHINK_STATE_DIR with no web guard, no unit stops and no starts (used by drill)
#
# promote needs --origin-fenced: the operator attests that the origin is stopped. It restores with the web unit started
# and probed, then writes $STATE/.promoted-<stamp>. Without the flag it exits 2 and changes nothing.
#
# drill restores the newest ring snapshot into a private scratch state (local leg). When ULTRATHINK_AGE_IDENTITY is set
# it decrypts the newest off-host copy and checks it (off-host leg); otherwise that leg reports SKIPPED. It never
# touches the live state or the services. Exit 1 when a leg that ran failed.
#
# Environment (all optional): ULTRATHINK_STATE_DIR, ULTRATHINK_BACKUP_DIR, ULTRATHINK_SNAPSHOT_DIR,
# ULTRATHINK_SNAPSHOT_TREE, ULTRATHINK_SYSTEMCTL, ULTRATHINK_PROBE_URL, ULTRATHINK_PORT, ULTRATHINK_TLS_DIR,
# ULTRATHINK_SERVICE_USER, ULTRATHINK_BUN,
# ULTRATHINK_AGE_IDENTITY. Exit codes: 0 success; 1 failure; 2 usage or configuration.
set -euo pipefail

SELF="${BASH_SOURCE[0]}"
ROOT="$(cd "$(dirname "$SELF")/.." && pwd)"
LIB="$ROOT/deploy/ultrathink-dr-lib.sh"
# shellcheck source=deploy/ultrathink-dr-lib.sh
. "$LIB"

STATE_DIR="$(dr_setting ULTRATHINK_STATE_DIR /var/lib/ultrathink)"
BACKUP_DIR="$(dr_setting ULTRATHINK_BACKUP_DIR /var/backups/ultrathink)"
SNAPSHOT_DIR="$(dr_setting ULTRATHINK_SNAPSHOT_DIR "$BACKUP_DIR/ring")"
SNAPSHOT_TREE="$(dr_setting ULTRATHINK_SNAPSHOT_TREE 1)"
SYSTEMCTL="$(dr_setting ULTRATHINK_SYSTEMCTL systemctl)"
PORT="$(dr_setting ULTRATHINK_PORT 8795)"
TLS_DIR="$(dr_setting ULTRATHINK_TLS_DIR /etc/ultrathink/tls)"
PROBE_URL="$(dr_setting ULTRATHINK_PROBE_URL "https://127.0.0.1:$PORT/readyz")"
SERVICE_USER="$(dr_setting ULTRATHINK_SERVICE_USER ultrathink)"
SERVICE_HOME="${ULTRATHINK_SERVICE_HOME:-/var/lib/ultrathink/home}"
BUN="$(dr_setting ULTRATHINK_BUN /opt/ultrathink/bin/bun)"

ISO_UTC_RE='^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,9})?(Z|\+00:00)$'

# Run-scoped state, set by the argument parser and the steps. The EXIT trap reads SCRATCH and RESUME_TIMERS.
AT=""
SNAPSHOT=""
ARCHIVE=""
DB_ONLY=0
NO_START=0
SCRATCH_MODE=0
SCRATCH=""
RESUME_TIMERS=0
ACTIVE_SERVICES=()
ACTIVE_TIMERS=()
PLACED=()
MOVED_OUT=()
PRE_DIR=""
SRC_LABEL=""
SRC_DB=""
SRC_FILES=""
SRC_TOP=""
SRC_REVISION=""

usage() {
	cat >&2 <<'EOF'
usage: ultrathink-restore.sh restore [--at ISO_UTC | --snapshot NAME | --archive PATH] [--identity FILE] [--db-only] [--no-start] [--scratch]
       ultrathink-restore.sh promote --origin-fenced [--at ISO_UTC | --snapshot NAME | --archive PATH] [--identity FILE] [--db-only]
       ultrathink-restore.sh drill
EOF
	exit 2
}

on_exit() {
	local status="$1"
	if [ "$RESUME_TIMERS" -eq 1 ] && [ "$status" -ne 0 ]; then
		warn "restore did not complete; restarting the snapshot and maintenance timers"
		resume_units || true
	fi
	if [ -n "$SCRATCH" ]; then
		rm -rf -- "$SCRATCH"
	fi
}
trap 'on_exit $?' EXIT

# step NAME FUNCTION ARGS...: runs the function in this shell, then prints "step NAME NNNms".
step() {
	local name="$1" started
	shift
	started="$(dr_now_ms)"
	"$@"
	dr_timing "$name" "$started"
}

new_scratch() {
	SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/ultrathink-restore.XXXXXX")" || die "cannot create a scratch directory"
}

service_user_present() {
	[ "$(id -u)" -eq 0 ] && id -u "$SERVICE_USER" >/dev/null 2>&1
}

validate_iso() {
	[[ "$1" =~ $ISO_UTC_RE ]] || dr_config_error "--at needs an ISO-8601 UTC time such as 2026-10-20T12:00:00Z"
}

validate_snapshot_name() {
	case "$1" in */*) dr_config_error "--snapshot takes a file name, not a path" ;; esac
	case "$1" in
	ultrathink-*.sqlite) ;;
	*) dr_config_error "--snapshot needs a ring file name such as ultrathink-<stamp>.sqlite" ;;
	esac
}

parse_restore_args() {
	local identity="" chosen=0
	AT=""
	SNAPSHOT=""
	ARCHIVE=""
	DB_ONLY=0
	NO_START=0
	SCRATCH_MODE=0
	while [ "$#" -gt 0 ]; do
		case "$1" in
		--at | --snapshot | --archive | --identity)
			[ "$#" -ge 2 ] || usage
			case "$1" in
			--at) AT="$2" ;;
			--snapshot) SNAPSHOT="$2" ;;
			--archive) ARCHIVE="$2" ;;
			*) identity="$2" ;;
			esac
			shift 2
			;;
		--db-only)
			DB_ONLY=1
			shift
			;;
		--no-start)
			NO_START=1
			shift
			;;
		--scratch)
			SCRATCH_MODE=1
			shift
			;;
		*) usage ;;
		esac
	done
	[ -z "$AT" ] || {
		validate_iso "$AT"
		chosen=$((chosen + 1))
	}
	[ -z "$SNAPSHOT" ] || {
		validate_snapshot_name "$SNAPSHOT"
		chosen=$((chosen + 1))
	}
	[ -z "$ARCHIVE" ] || chosen=$((chosen + 1))
	[ "$chosen" -le 1 ] || usage
	if [ -n "$identity" ]; then
		export ULTRATHINK_AGE_IDENTITY="$identity"
	fi
}

# Ring file names, one per line. Only regular files: tree directories and dot entries are not snapshots.
ring_names() {
	if [ -d "$SNAPSHOT_DIR" ]; then
		find "$SNAPSHOT_DIR" -mindepth 1 -maxdepth 1 -type f -name 'ultrathink-*.sqlite' -printf '%f\n'
	fi
}

# pick_snapshot TARGET_MS: prints the newest ring file at or before TARGET_MS. Returns 1 when there is none.
pick_snapshot() {
	local names
	names="$(ring_names)"
	printf '%s\n' "$names" | dr_snapshot_cli pick "$1"
}

audit_verify() {
	[ -x "$BUN" ] || dr_config_error "Bun not found at $BUN"
	"$BUN" "$ROOT/services/ultrathink/obs/audit-cli.ts" verify "$1" ||
		die "audit chain is broken or unreadable in $SRC_LABEL; state untouched"
}

warn_revision() {
	local here="unknown"
	if [ -z "$SRC_REVISION" ]; then
		return 0
	fi
	if [ -r "$ROOT/REVISION" ]; then
		here="$(tr -d '[:space:]' <"$ROOT/REVISION")"
	fi
	if [ "$here" != "$SRC_REVISION" ]; then
		warn "$SRC_LABEL was written by revision $SRC_REVISION; this release is $here (restore is roll-forward only)"
	fi
	return 0
}

select_source() {
	local name target
	SRC_TOP=""
	SRC_REVISION=""
	if [ -n "$ARCHIVE" ]; then
		select_archive
		return 0
	fi
	if [ -n "$SNAPSHOT" ]; then
		name="$SNAPSHOT"
		[ -f "$SNAPSHOT_DIR/$name" ] || die "snapshot not found: $SNAPSHOT_DIR/$name"
	else
		if [ -n "$AT" ]; then
			target="$(date -u -d "$AT" +%s%3N)" || die "cannot read --at $AT"
		else
			target="$(dr_now_ms)"
		fi
		name="$(pick_snapshot "$target")" || die "no snapshot at or before ${AT:-now} in $SNAPSHOT_DIR"
	fi
	SRC_LABEL="$name"
	SRC_DB="$SNAPSHOT_DIR/$name"
	SRC_FILES=""
	if [ "$DB_ONLY" -eq 0 ] && [ "$SNAPSHOT_TREE" = 1 ]; then
		SRC_FILES="$SNAPSHOT_DIR/tree/${name%.sqlite}"
		[ -d "$SRC_FILES" ] || die "no tree for $name at $SRC_FILES; restore the database alone with --db-only"
	fi
	printf 'source %s\n' "$SRC_LABEL"
}

select_archive() {
	local base tarball extract="$SCRATCH/archive"
	[ -f "$ARCHIVE" ] || die "archive not found: $ARCHIVE"
	base="$(basename -- "$ARCHIVE")"
	case "$base" in
	ultrathink-*.tar.gz)
		tarball="$ARCHIVE"
		;;
	ultrathink-*.tar.gz.age)
		[ -n "$(dr_setting ULTRATHINK_AGE_IDENTITY '')" ] ||
			dr_config_error "$base is encrypted: pass --identity FILE (or set ULTRATHINK_AGE_IDENTITY)"
		tarball="$SCRATCH/archive.tar.gz"
		dr_age decrypt "$ARCHIVE" "$tarball"
		;;
	*) dr_config_error "--archive needs an ultrathink-<stamp>.tar.gz or .tar.gz.age file" ;;
	esac
	mkdir -m 0700 "$extract"
	tar -xzf "$tarball" -C "$extract" --no-same-owner || die "cannot extract $base"
	SRC_TOP="$(find "$extract" -mindepth 1 -maxdepth 1 -type d -print -quit)"
	[ -n "$SRC_TOP" ] || die "archive has no top-level directory: $base"
	SRC_LABEL="$base"
	SRC_DB="$SRC_TOP/ultrathink.sqlite"
	[ -f "$SRC_DB" ] || die "archive has no ultrathink.sqlite: $base"
	[ -f "$SRC_TOP/SHA256SUMS" ] || die "archive has no SHA256SUMS: $base"
	SRC_FILES=""
	if [ "$DB_ONLY" -eq 0 ]; then
		SRC_FILES="$SRC_TOP"
	fi
	SRC_REVISION="$(sed -n 's/^revision=//p' "$SRC_TOP/BACKUP_INFO" 2>/dev/null || true)"
	warn_revision
	printf 'source %s\n' "$SRC_LABEL"
}

verify_source() {
	if [ -n "$SRC_TOP" ]; then
		(cd "$SRC_TOP" && sha256sum --check --quiet SHA256SUMS) || die "checksum mismatch in $SRC_LABEL"
	fi
	dr_bun quick "$SRC_DB" || die "database failed quick_check: $SRC_LABEL"
	if [ -n "$SRC_FILES" ]; then
		if [ -f "$SRC_FILES/oauth.json" ]; then
			dr_bun json "$SRC_FILES/oauth.json" || die "oauth.json is not valid JSON: $SRC_LABEL"
		fi
		if [ -f "$SRC_FILES/audit.jsonl" ]; then
			audit_verify "$SRC_FILES/audit.jsonl"
		fi
	fi
}

# Compatibility is proven on a scratch copy. As root with the service user present, the copy is owned by that user and
# the check runs as that user, so the same file permissions apply as in production.
check_compat() {
	local dir="$SCRATCH/compat" db="$SCRATCH/compat/ultrathink.sqlite"
	mkdir -m 0700 "$dir"
	cp -- "$SRC_DB" "$db"
	if service_user_present; then
		chown "$SERVICE_USER:$SERVICE_USER" "$SCRATCH"
		chown -R "$SERVICE_USER:$SERVICE_USER" "$dir"
		# shellcheck disable=SC2016 # single quotes are intentional: the child shell expands $1 and $2
		setpriv --reuid="$SERVICE_USER" --regid="$SERVICE_USER" --init-groups -- \
			env "HOME=$SERVICE_HOME" "ULTRATHINK_BUN=$BUN" \
			bash -c 'source "$1" && dr_bun compat "$2"' compat "$LIB" "$db" ||
			die "schema compatibility check failed for $SRC_LABEL; state untouched"
	else
		dr_bun compat "$db" || die "schema compatibility check failed for $SRC_LABEL; state untouched"
	fi
}

guard_and_stop_units() {
	local unit
	if "$SYSTEMCTL" is-active --quiet ultrathink-web; then
		die "ultrathink-web is active; stop it before restoring (nothing was changed)"
	fi
	# Only units active now are stopped, and only those are restarted afterwards. A timer that is inactive (the snapshot
	# timer ships disabled until a staging measurement is recorded) stays inactive: restore never enables or starts one.
	for unit in ultrathink-snapshot.timer ultrathink-maintenance.timer; do
		if "$SYSTEMCTL" is-active --quiet "$unit"; then
			ACTIVE_TIMERS+=("$unit")
		fi
	done
	for unit in ultrathink-snapshot.service ultrathink-maintenance.service; do
		if "$SYSTEMCTL" is-active --quiet "$unit"; then
			ACTIVE_SERVICES+=("$unit")
		fi
	done
	RESUME_TIMERS=1
	for unit in "${ACTIVE_TIMERS[@]}" "${ACTIVE_SERVICES[@]}"; do
		"$SYSTEMCTL" stop "$unit" || die "cannot stop $unit; restore aborted"
	done
}

resume_units() {
	local unit
	# Restarts only what guard_and_stop_units recorded as active. Nothing is enabled.
	for unit in "${ACTIVE_TIMERS[@]}" "${ACTIVE_SERVICES[@]}"; do
		"$SYSTEMCTL" start "$unit" || warn "cannot start $unit"
	done
	RESUME_TIMERS=0
}

# state_entries: names in the state directory that a restore replaces. The database family always; the rest only for
# a full restore (--db-only leaves oauth.json, audit.jsonl and the data directories in place).
state_entries() {
	local entry name
	for entry in "$STATE_DIR"/ultrathink.sqlite*; do
		if [ -e "$entry" ] || [ -L "$entry" ]; then
			basename -- "$entry"
		fi
	done
	if [ "$DB_ONLY" -eq 0 ]; then
		for name in oauth.json audit.jsonl jobs sessions journal; do
			if [ -e "$STATE_DIR/$name" ] || [ -L "$STATE_DIR/$name" ]; then
				printf '%s\n' "$name"
			fi
		done
	fi
}

# place_files runs inside `if !`, where set -e is off, so every step returns explicitly.
place_files() {
	local name
	while IFS= read -r name; do
		mv -- "$STATE_DIR/$name" "$PRE_DIR/$name" || return 1
		MOVED_OUT+=("$name")
	done < <(state_entries)
	PLACED+=("ultrathink.sqlite")
	cp -- "$SRC_DB" "$STATE_DIR/ultrathink.sqlite" || return 1
	if [ -n "$SRC_FILES" ]; then
		for name in oauth.json audit.jsonl; do
			if [ -f "$SRC_FILES/$name" ]; then
				PLACED+=("$name")
				cp -- "$SRC_FILES/$name" "$STATE_DIR/$name" || return 1
			fi
		done
		for name in jobs sessions journal; do
			if [ -d "$SRC_FILES/$name" ]; then
				PLACED+=("$name")
				cp -r -- "$SRC_FILES/$name" "$STATE_DIR/$name" || return 1
			fi
		done
	fi
	for name in "${PLACED[@]}"; do
		if [ -d "$STATE_DIR/$name" ]; then
			find "$STATE_DIR/$name" -type d -exec chmod 0700 {} + || return 1
			find "$STATE_DIR/$name" -type f -exec chmod 0600 {} + || return 1
		else
			chmod 0600 -- "$STATE_DIR/$name" || return 1
		fi
		if service_user_present; then
			chown -R "$SERVICE_USER:$SERVICE_USER" -- "$STATE_DIR/$name" || return 1
		fi
	done
	return 0
}

rollback_placement() {
	local name
	for name in "${PLACED[@]}"; do
		rm -rf -- "${STATE_DIR:?}/$name"
	done
	for name in "${MOVED_OUT[@]}"; do
		mv -- "$PRE_DIR/$name" "$STATE_DIR/$name" || warn "cannot move $name back from $PRE_DIR"
	done
}

place_state() {
	local stamp
	stamp="$(dr_snapshot_cli stamp "$(dr_now_ms)")" || die "cannot format the pre-restore stamp"
	PRE_DIR="$STATE_DIR/.pre-restore-$stamp"
	[ ! -e "$PRE_DIR" ] || die "pre-restore directory already exists: $PRE_DIR"
	mkdir -m 0700 -- "$PRE_DIR" || die "cannot create $PRE_DIR"
	if ! place_files; then
		warn "placement failed; rolling back from $PRE_DIR"
		rollback_placement
		die "restore failed while placing files; state is back to its previous contents"
	fi
}

start_units() {
	if [ "$RESUME_TIMERS" -eq 1 ]; then
		resume_units
	fi
	if [ "$NO_START" -eq 0 ]; then
		"$SYSTEMCTL" start ultrathink-web ||
			die "cannot start ultrathink-web; restored state is in place, previous state in $PRE_DIR"
	fi
}

probe_web() {
	local i file
	local -a tls_args=()
	command -v curl >/dev/null 2>&1 || die "curl is needed for the readiness probe"
	if [[ "$PROBE_URL" == https://* ]]; then
		# Production is mTLS: pin the app CA and present the ops identity, as ultrathink-release.sh probes. -k is never passed.
		for file in "$TLS_DIR/ca.pem" "$TLS_DIR/ops/cert.pem" "$TLS_DIR/ops/key.pem"; do
			[ -r "$file" ] || die "readiness probe needs $file; restored state is in place, previous state in $PRE_DIR"
		done
		tls_args=(--cacert "$TLS_DIR/ca.pem" --cert "$TLS_DIR/ops/cert.pem" --key "$TLS_DIR/ops/key.pem")
	fi
	for ((i = 1; i <= 30; i++)); do
		if curl -fs --max-time 2 "${tls_args[@]}" -o /dev/null "$PROBE_URL"; then
			return 0
		fi
		if [ "$i" -lt 30 ]; then
			sleep 1
		fi
	done
	die "ultrathink-web did not answer $PROBE_URL within 30 s; restored state is in place, previous state in $PRE_DIR"
}

run_restore_steps() {
	local started
	[ -d "$STATE_DIR" ] || die "state directory not found: $STATE_DIR"
	started="$(dr_now_ms)"
	new_scratch
	step source select_source
	if [ "$SCRATCH_MODE" -eq 0 ]; then
		step guard guard_and_stop_units
	fi
	step verify verify_source
	step compat check_compat
	step place place_state
	if [ "$SCRATCH_MODE" -eq 0 ]; then
		step start start_units
		if [ "$NO_START" -eq 0 ]; then
			step probe probe_web
		fi
	fi
	dr_timing total "$started"
	printf 'restore ok: %s; pre-restore state at %s\n' "$SRC_LABEL" "$PRE_DIR"
}

run_promote() {
	local arg origin=0 stamp marker
	local -a rest=()
	for arg in "$@"; do
		if [ "$arg" = --origin-fenced ]; then
			origin=1
		else
			rest+=("$arg")
		fi
	done
	if [ "$origin" -eq 0 ]; then
		warn "promote refuses without --origin-fenced: the operator must attest that the origin is stopped"
		exit 2
	fi
	parse_restore_args "${rest[@]}"
	if [ "$NO_START" -eq 1 ] || [ "$SCRATCH_MODE" -eq 1 ]; then
		usage
	fi
	run_restore_steps
	stamp="$(dr_snapshot_cli stamp "$(dr_now_ms)")" || die "cannot format the promotion stamp"
	marker="$STATE_DIR/.promoted-$stamp"
	printf 'source=%s\npromoted_utc=%s\n' "$SRC_LABEL" "$stamp" >"$marker"
	chmod 0600 -- "$marker"
	say "promoted $SRC_LABEL; marker $marker"
}

# Off-host copies, newest last: archives in the backup directory and sqlite copies under ring/.offhost.
offhost_candidates() {
	if [ -d "$BACKUP_DIR" ]; then
		find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type f -name 'ultrathink-*.tar.gz.age' -printf '%f\t%p\n'
	fi
	if [ -d "$SNAPSHOT_DIR/.offhost" ]; then
		find "$SNAPSHOT_DIR/.offhost" -mindepth 1 -maxdepth 1 -type f -name 'ultrathink-*.sqlite.age' -printf '%f\t%p\n'
	fi
}

# Runs in a subshell. Every step returns explicitly: a subshell inside `if` does not inherit set -e.
offhost_leg() {
	local work="$1" newest db top
	newest="$(offhost_candidates | sort | tail -n 1 | cut -f2)"
	if [ -z "$newest" ]; then
		warn "no off-host copy in $BACKUP_DIR or $SNAPSHOT_DIR/.offhost"
		return 1
	fi
	say "off-host copy $(basename -- "$newest")"
	case "$newest" in
	*.tar.gz.age)
		dr_age decrypt "$newest" "$work/archive.tar.gz" || return 1
		mkdir -m 0700 "$work/archive" || return 1
		tar -xzf "$work/archive.tar.gz" -C "$work/archive" --no-same-owner || return 1
		top="$(find "$work/archive" -mindepth 1 -maxdepth 1 -type d -print -quit)"
		[ -n "$top" ] || return 1
		(cd "$top" && sha256sum --check --quiet SHA256SUMS) || return 1
		db="$top/ultrathink.sqlite"
		;;
	*.sqlite.age)
		dr_age decrypt "$newest" "$work/ultrathink.sqlite" || return 1
		db="$work/ultrathink.sqlite"
		;;
	*) return 1 ;;
	esac
	dr_bun quick "$db" || return 1
	dr_bun compat "$db" || return 1
}

run_drill() {
	local newest="" scratch_root local_status="FAIL" offhost_status="SKIPPED"
	local -a args
	[ "$#" -eq 0 ] || usage
	new_scratch
	scratch_root="$SCRATCH"
	mkdir -m 0700 "$scratch_root/local" "$scratch_root/local/state"
	if newest="$(pick_snapshot "$(dr_now_ms)")"; then
		args=(restore --scratch --snapshot "$newest")
		if [ ! -d "$SNAPSHOT_DIR/tree/${newest%.sqlite}" ]; then
			args+=(--db-only)
		fi
		if ULTRATHINK_STATE_DIR="$scratch_root/local/state" bash "$SELF" "${args[@]}"; then
			local_status="PASS"
		fi
	else
		warn "no ring snapshot at or before now in $SNAPSHOT_DIR"
	fi
	if [ -n "$(dr_setting ULTRATHINK_AGE_IDENTITY '')" ]; then
		offhost_status="FAIL"
		mkdir -m 0700 "$scratch_root/offhost"
		if (offhost_leg "$scratch_root/offhost"); then
			offhost_status="PASS"
		fi
	fi
	printf 'drill: local %s, offhost %s\n' "$local_status" "$offhost_status"
	if [ "$offhost_status" = SKIPPED ]; then
		say "off-host leg not run: ULTRATHINK_AGE_IDENTITY is not set"
	fi
	if [ "$local_status" != PASS ] || [ "$offhost_status" = FAIL ]; then
		exit 1
	fi
}

MODE="${1:-}"
if [ "$#" -gt 0 ]; then
	shift
fi
case "$MODE" in
restore)
	parse_restore_args "$@"
	run_restore_steps
	;;
promote) run_promote "$@" ;;
drill) run_drill "$@" ;;
*) usage ;;
esac
