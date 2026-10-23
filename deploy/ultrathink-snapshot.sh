#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 SWC Studio
#
# Point-in-time snapshots of the ultrathink state directory: the ring, the file layer and the off-host copy.
#
#   ultrathink-snapshot.sh tick     one snapshot (what ultrathink-snapshot.service runs every 30 s)
#   ultrathink-snapshot.sh status   newest snapshot, its age, the ring count, free space and the last off-host push
#
# A tick copies the live database with VACUUM INTO to ring/.tmp-<stamp>.sqlite, checks it with integrity_check and
# renames it to ring/ultrathink-<stamp>.sqlite. With ULTRATHINK_SNAPSHOT_TREE=1 it then stages the file layer
# (jobs/ sessions/ journal/ oauth.json audit.jsonl and the sealed audit-*.jsonl segments) in tree/ultrathink-<stamp>/,
# hard-linking unchanged files to the newest earlier tree. When ULTRATHINK_BACKUP_RSYNC_TARGET is set and the off-host
# interval has elapsed, the newest snapshot is age-encrypted to ULTRATHINK_BACKUP_RECIPIENT and pushed. The ring is then
# pruned by the policy in
# store/snapshots.ts (snapshots-cli.ts plan). A failed off-host push is reported after pruning and exits 1; the local
# snapshot is kept.
#
# Environment (all optional; read through dr_setting, see deploy/ultrathink-dr-lib.sh):
#   ULTRATHINK_STATE_DIR                  state directory (default /var/lib/ultrathink)
#   ULTRATHINK_BACKUP_DIR                 backup directory (default /var/backups/ultrathink)
#   ULTRATHINK_SNAPSHOT_DIR               ring directory (default $ULTRATHINK_BACKUP_DIR/ring)
#   ULTRATHINK_SNAPSHOT_TREE              1 keeps the file layer in tree/ (default 1); 0 skips it
#   ULTRATHINK_SNAPSHOT_KEEP_HOURS        ring window in whole hours, at least 1 (default 24)
#   ULTRATHINK_SNAPSHOT_MIN_FREE_BYTES    disk guard floor in bytes (default 1073741824)
#   ULTRATHINK_OFFHOST_INTERVAL_SECONDS   minimum seconds between off-host pushes (default 300)
#   ULTRATHINK_BACKUP_RSYNC_TARGET        rsync destination for off-host copies, for example backup@host:/srv/ultrathink/
#   ULTRATHINK_BACKUP_RECIPIENT           age recipient (age1... or a recipients file); required to push off-host
#   ULTRATHINK_DR_NOW_MS                  fixed "now" in milliseconds (tests only)
#
# Exit codes: 0 success, or the tick lock is held by another tick; 1 failure; 2 usage or configuration.
set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source-path=SCRIPTDIR
# shellcheck source=ultrathink-dr-lib.sh
source "$SELF_DIR/ultrathink-dr-lib.sh"

usage() {
	printf 'usage: ultrathink-snapshot.sh tick | status\n' >&2
	exit 2
}

require_uint() {
	# require_uint NAME VALUE: exit 2 unless VALUE is a plain non-negative decimal integer.
	case "$2" in
	'' | *[!0-9]*) dr_config_error "$1 must be a non-negative integer, not: $2" ;;
	esac
}

MODE="${1:-}"
case "$MODE" in
tick | status) ;;
*) usage ;;
esac

STATE_DIR="$(dr_setting ULTRATHINK_STATE_DIR /var/lib/ultrathink)"
BACKUP_DIR="$(dr_setting ULTRATHINK_BACKUP_DIR /var/backups/ultrathink)"
SNAPSHOT_DIR="$(dr_setting ULTRATHINK_SNAPSHOT_DIR "$BACKUP_DIR/ring")"
SNAPSHOT_TREE="$(dr_setting ULTRATHINK_SNAPSHOT_TREE 1)"
KEEP_HOURS="$(dr_setting ULTRATHINK_SNAPSHOT_KEEP_HOURS 24)"
MIN_FREE="$(dr_setting ULTRATHINK_SNAPSHOT_MIN_FREE_BYTES 1073741824)"
OFFHOST_INTERVAL="$(dr_setting ULTRATHINK_OFFHOST_INTERVAL_SECONDS 300)"
RSYNC_TARGET="$(dr_setting ULTRATHINK_BACKUP_RSYNC_TARGET '')"

case "$SNAPSHOT_TREE" in
0 | 1) ;;
*) dr_config_error "ULTRATHINK_SNAPSHOT_TREE must be 0 or 1, not: $SNAPSHOT_TREE" ;;
esac
require_uint ULTRATHINK_SNAPSHOT_KEEP_HOURS "$KEEP_HOURS"
require_uint ULTRATHINK_SNAPSHOT_MIN_FREE_BYTES "$MIN_FREE"
require_uint ULTRATHINK_OFFHOST_INTERVAL_SECONDS "$OFFHOST_INTERVAL"
KEEP_HOURS=$((10#$KEEP_HOURS))
MIN_FREE=$((10#$MIN_FREE))
OFFHOST_INTERVAL=$((10#$OFFHOST_INTERVAL))
if [ "$KEEP_HOURS" -lt 1 ]; then
	dr_config_error "ULTRATHINK_SNAPSHOT_KEEP_HOURS must be at least 1"
fi
if [ -n "$RSYNC_TARGET" ]; then
	case "$RSYNC_TARGET" in
	*/) ;;
	*) RSYNC_TARGET="$RSYNC_TARGET/" ;;
	esac
fi

DB="$STATE_DIR/ultrathink.sqlite"
LOCK_FILE="$SNAPSHOT_DIR/.tick.lock"
TREE_DIR="$SNAPSHOT_DIR/tree"
OFFHOST_DIR="$SNAPSHOT_DIR/.offhost"
OFFHOST_LAST_FILE="$SNAPSHOT_DIR/.offhost-last"
OFFHOST_TMP="$SNAPSHOT_DIR/.tmp-offhost-last"

# Set by tick and read by its helpers.
NOW=""
STAMP=""
NAME=""
FINAL_DB=""
TMP_DB=""
TMP_TREE=""
OFFHOST_FAILED=0

# Snapshot candidates for the policy, one per snapshot. The ring file ultrathink-<stamp>.sqlite and the tree directory
# ultrathink-<stamp> are the same snapshot, so both are listed under the bare name; the policy keeps or deletes them together.
list_names() {
	local path name
	for path in "$SNAPSHOT_DIR"/ultrathink-* "$TREE_DIR"/ultrathink-*; do
		if [ -e "$path" ] || [ -L "$path" ]; then
			name="$(basename -- "$path")"
			printf '%s\n' "${name%.sqlite}"
		fi
	done | sort -u
}

# Ring snapshot files only (ultrathink-<stamp>.sqlite).
list_ring_names() {
	local path
	for path in "$SNAPSHOT_DIR"/ultrathink-*.sqlite; do
		if [ -f "$path" ]; then
			basename -- "$path"
		fi
	done
}

# Tree directories only (tree/ultrathink-<stamp>).
list_tree_names() {
	local path
	for path in "$TREE_DIR"/ultrathink-*; do
		if [ -d "$path" ]; then
			basename -- "$path"
		fi
	done
}

# Prints the newest of the names on stdin, by stamp. Prints nothing when there are none. Any other policy failure
# stops the script; it is never read as "no snapshot".
newest_name() {
	local out rc=0
	out="$(dr_snapshot_cli pick 9007199254740991)" || rc=$?
	case "$rc" in
	0) printf '%s\n' "$out" ;;
	1) ;;
	*) die "snapshot policy failed with exit $rc" ;;
	esac
}

# Milliseconds since the epoch encoded in a snapshot name (UTC). Fails when the name carries no real time.
name_ms() {
	local name="$1" secs ms
	if ! [[ "$name" =~ ^ultrathink-([0-9]{4})([0-9]{2})([0-9]{2})T([0-9]{2})([0-9]{2})([0-9]{2})([0-9]{3})?Z(\.sqlite)?$ ]]; then
		return 1
	fi
	ms="${BASH_REMATCH[7]:-0}"
	secs="$(date -u -d "${BASH_REMATCH[1]}-${BASH_REMATCH[2]}-${BASH_REMATCH[3]} ${BASH_REMATCH[4]}:${BASH_REMATCH[5]}:${BASH_REMATCH[6]}" +%s)" || return 1
	printf '%s\n' "$((secs * 1000 + 10#$ms))"
}

size_of() {
	if [ -f "$1" ]; then
		stat -c %s -- "$1"
	else
		printf '0'
	fi
}

# Epoch seconds of the last off-host push, or 0 when there has never been one.
offhost_last_epoch() {
	local value=""
	if [ -f "$OFFHOST_LAST_FILE" ]; then
		value="$(cat -- "$OFFHOST_LAST_FILE")"
	fi
	case "$value" in
	'' | *[!0-9]*) printf '0' ;;
	*) printf '%s' "$value" ;;
	esac
}

# Removes this tick's own temporary entries when the script exits, on success or failure.
cleanup() {
	if [ -n "$TMP_DB" ]; then
		rm -f -- "$TMP_DB"
	fi
	if [ -n "$TMP_TREE" ]; then
		rm -rf -- "$TMP_TREE"
	fi
}

# Sealed audit segments in the state directory, by bare name (audit-<first>-<last>.jsonl). The audit chain verifies only
# with them, so the file layer copies them next to audit.jsonl.
sealed_audit_names() {
	local path name
	for path in "$STATE_DIR"/audit-*.jsonl; do
		name="${path##*/}"
		if [ -f "$path" ] && [[ "$name" =~ ^audit-[1-9][0-9]*-[1-9][0-9]*\.jsonl$ ]]; then
			printf '%s\n' "$name"
		fi
	done
}

# Stages the file layer in tree/.tmp-<stamp>, hard-linking unchanged files to the newest earlier tree, then renames it.
# Uses rsync directly because dr_rsync passes everything after "--", so it cannot carry --files-from or --link-dest.
# rsync needs -r with --files-from: -a alone copies a listed directory as an empty entry.
snapshot_tree() {
	local item newest=""
	local -a tree_items=() link_args=()
	if [ -e "$TREE_DIR/$NAME" ]; then
		die "tree name already exists: $TREE_DIR/$NAME"
	fi
	mkdir -p -- "$TREE_DIR"
	for item in jobs sessions journal oauth.json audit.jsonl; do
		if [ -e "$STATE_DIR/$item" ]; then
			tree_items+=("$item")
		fi
	done
	while IFS= read -r item; do
		tree_items+=("$item")
	done < <(sealed_audit_names)
	TMP_TREE="$TREE_DIR/.tmp-$STAMP"
	rm -rf -- "$TMP_TREE"
	mkdir -- "$TMP_TREE"
	if [ "${#tree_items[@]}" -gt 0 ]; then
		newest="$(list_tree_names | newest_name)"
		if [ -n "$newest" ]; then
			link_args=("--link-dest=$TREE_DIR/$newest")
		fi
		printf '%s\n' "${tree_items[@]}" |
			rsync -a -r --chmod=F600 ${link_args[@]+"${link_args[@]}"} --files-from=- -- "$STATE_DIR/" "$TMP_TREE/" ||
			die "tree copy failed; the database snapshot is kept"
	fi
	mv -- "$TMP_TREE" "$TREE_DIR/$NAME"
	TMP_TREE=""
}

# Encrypts the new snapshot to the recipient and pushes it to ${RSYNC_TARGET}ring/. Runs in a subshell, so every
# failure is an explicit return; errexit does not apply inside a subshell that is tested with "!".
offhost_push() {
	local now_s last recipient out
	if [ -z "$RSYNC_TARGET" ]; then
		return 0
	fi
	now_s=$((NOW / 1000))
	last=$((10#$(offhost_last_epoch)))
	if [ "$now_s" -ge "$last" ] && [ $((now_s - last)) -lt "$OFFHOST_INTERVAL" ]; then
		return 0
	fi
	recipient="$(dr_setting ULTRATHINK_BACKUP_RECIPIENT '')"
	if [ -z "$recipient" ]; then
		warn "refusing plaintext off-host: ULTRATHINK_BACKUP_RECIPIENT is not set; nothing was pushed"
		return 1
	fi
	mkdir -p -- "$OFFHOST_DIR" || return 1
	out="$OFFHOST_DIR/$NAME.sqlite.age"
	dr_age encrypt "$FINAL_DB" "$out" || return 1
	dr_rsync "$out" "${RSYNC_TARGET}ring/" || return 1
	printf '%s\n' "$now_s" >"$OFFHOST_TMP" || return 1
	mv -f -- "$OFFHOST_TMP" "$OFFHOST_LAST_FILE" || return 1
}

# Removes the ring entries the policy names. The newest non-future entry is always kept by the policy itself.
prune_ring() {
	local plan line name
	plan="$(list_names | dr_snapshot_cli plan "$NOW" 3600000 300000 "$((KEEP_HOURS * 3600000))")"
	while IFS= read -r line; do
		case "$line" in
		"delete ultrathink-"*) name="${line#delete }" ;;
		*) continue ;;
		esac
		rm -f -- "$SNAPSHOT_DIR/$name.sqlite"
		rm -rf -- "$TREE_DIR/${name:?}"
	done <<<"$plan"
	# Leftovers of crashed ticks and off-host copies older than an hour (a SIGKILL skips the EXIT trap).
	find "$SNAPSHOT_DIR" -maxdepth 1 -name '.tmp-*' -mmin +60 -exec rm -rf -- {} +
	if [ -d "$TREE_DIR" ]; then
		find "$TREE_DIR" -maxdepth 1 -name '.tmp-*' -mmin +60 -exec rm -rf -- {} +
	fi
	if [ -d "$OFFHOST_DIR" ]; then
		find "$OFFHOST_DIR" -mindepth 1 -maxdepth 1 -mmin +60 -exec rm -rf -- {} +
	fi
}

tick() {
	local t0 db_bytes wal_bytes need free
	mkdir -p -- "$SNAPSHOT_DIR"
	exec 9>"$LOCK_FILE"
	if ! flock -n 9; then
		say "snapshot tick skipped: another tick holds $LOCK_FILE"
		return 0
	fi
	trap cleanup EXIT
	trap 'exit 1' INT TERM HUP

	[ -f "$DB" ] || die "no state database at $DB; no snapshot written"
	db_bytes="$(size_of "$DB")"
	wal_bytes="$(size_of "$DB-wal")"
	need="$MIN_FREE"
	if [ $((2 * (db_bytes + wal_bytes))) -gt "$need" ]; then
		need=$((2 * (db_bytes + wal_bytes)))
	fi
	free="$(dr_free_bytes "$SNAPSHOT_DIR")"
	if [ "$free" -lt "$need" ]; then
		die "disk guard: $free bytes free in $SNAPSHOT_DIR, need $need; no snapshot written"
	fi

	NOW="$(dr_now_ms)"
	STAMP="$(list_names | dr_snapshot_cli next "$NOW")"
	NAME="ultrathink-$STAMP"
	FINAL_DB="$SNAPSHOT_DIR/$NAME.sqlite"
	TMP_DB="$SNAPSHOT_DIR/.tmp-$STAMP.sqlite"

	rm -f -- "$TMP_DB"
	t0="$(dr_now_ms)"
	dr_bun copy "$DB" "$TMP_DB"
	dr_timing copy "$t0"
	t0="$(dr_now_ms)"
	dr_bun check "$TMP_DB"
	dr_timing check "$t0"
	if [ -e "$FINAL_DB" ] || [ -L "$FINAL_DB" ]; then
		die "snapshot name already exists: $FINAL_DB"
	fi
	mv -- "$TMP_DB" "$FINAL_DB"
	TMP_DB=""

	if [ "$SNAPSHOT_TREE" = 1 ]; then
		t0="$(dr_now_ms)"
		snapshot_tree
		dr_timing tree "$t0"
	fi

	t0="$(dr_now_ms)"
	if ! (offhost_push); then
		OFFHOST_FAILED=1
	fi
	dr_timing offhost "$t0"

	t0="$(dr_now_ms)"
	prune_ring
	dr_timing prune "$t0"
	printf 'snapshot ok %s.sqlite\n' "$NAME"
	if [ "$OFFHOST_FAILED" = 1 ]; then
		die "off-host push failed; the local snapshot $NAME.sqlite is kept"
	fi
}

status() {
	local newest count free last ms
	newest="$(list_ring_names | newest_name)"
	if [ -z "$newest" ]; then
		say "snapshot ring is empty: $SNAPSHOT_DIR"
		return 1
	fi
	NOW="$(dr_now_ms)"
	ms="$(name_ms "$newest")" || die "cannot read the stamp of $newest"
	count="$(list_ring_names | wc -l)"
	count="${count//[[:space:]]/}"
	free="$(dr_free_bytes "$SNAPSHOT_DIR")"
	last="$(offhost_last_epoch)"
	if [ "$last" = 0 ]; then
		last=never
	fi
	printf 'newest %s\n' "$newest"
	printf 'age_seconds %s\n' "$(((NOW - ms) / 1000))"
	printf 'snapshots %s\n' "$count"
	printf 'free_bytes %s\n' "$free"
	printf 'offhost_last_epoch %s\n' "$last"
}

case "$MODE" in
tick) tick ;;
status) status ;;
esac
