#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 SWC Studio
#
# Release management for ultrathink-web.
#
#   ultrathink-release.sh release <git-ref>   build, test, smoke-test, switch, verify; roll back on any failure
#   ultrathink-release.sh rollback            switch to the previous release and restart
#   ultrathink-release.sh status              show the current and previous release
#
# Layout:
#   /opt/ultrathink/bin/bun                    pinned Bun
#   /opt/ultrathink/releases/<sha>-<utc>/      one directory per release (git archive of the ref)
#   /opt/ultrathink/current                    symlink to the active release
#   /opt/ultrathink/previous                   symlink to the release that was active before the last switch
#
# Environment overrides: ULTRATHINK_REPO (git checkout to archive from, default: the checkout holding this script),
# ULTRATHINK_ROOT, ULTRATHINK_ENV_FILE, ULTRATHINK_UNIT, ULTRATHINK_SERVICE_USER, ULTRATHINK_SMOKE_PORT,
# ULTRATHINK_KEEP_RELEASES.
set -euo pipefail

ROOT="${ULTRATHINK_ROOT:-/opt/ultrathink}"
ENV_FILE="${ULTRATHINK_ENV_FILE:-/etc/ultrathink/ultrathink.env}"
UNIT="${ULTRATHINK_UNIT:-ultrathink-web}"
SERVICE_USER="${ULTRATHINK_SERVICE_USER:-ultrathink}"
SMOKE_PORT="${ULTRATHINK_SMOKE_PORT:-8796}"
KEEP="${ULTRATHINK_KEEP_RELEASES:-5}"
BUN="$ROOT/bin/bun"
RELEASES="$ROOT/releases"
CURRENT="$ROOT/current"
PREVIOUS="$ROOT/previous"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="${ULTRATHINK_REPO:-$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)}"

SMOKE_PID=""
SMOKE_STATE=""
SMOKE_LOG=""

say() { printf '==> %s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }
die() {
	printf 'ERROR: %s\n' "$*" >&2
	exit 1
}

usage() {
	cat >&2 <<'EOF'
usage: ultrathink-release.sh release <git-ref>
       ultrathink-release.sh rollback
       ultrathink-release.sh status
EOF
	exit 2
}

cleanup_smoke() {
	if [ -n "$SMOKE_PID" ] && kill -0 "$SMOKE_PID" 2>/dev/null; then
		kill "$SMOKE_PID" 2>/dev/null || true
		wait "$SMOKE_PID" 2>/dev/null || true
	fi
	SMOKE_PID=""
	if [ -n "$SMOKE_STATE" ] && [ -d "$SMOKE_STATE" ]; then
		rm -rf -- "$SMOKE_STATE"
	fi
	SMOKE_STATE=""
}
trap cleanup_smoke EXIT

require_root() {
	[ "$(id -u)" -eq 0 ] || die "must run as root (it writes under $ROOT and restarts $UNIT)"
}

require_tools() {
	local tool
	for tool in git tar curl flock systemctl setpriv readlink mktemp; do
		command -v "$tool" >/dev/null 2>&1 || die "missing required command: $tool"
	done
	[ -x "$BUN" ] || die "Bun not found at $BUN"
	[ -r "$ENV_FILE" ] || die "environment file not readable: $ENV_FILE"
	id -u "$SERVICE_USER" >/dev/null 2>&1 || die "service user does not exist: $SERVICE_USER"
}

take_lock() {
	mkdir -p "$ROOT"
	exec 9>"$ROOT/.release.lock"
	flock -n 9 || die "another release operation is running"
}

# Parse the systemd-style environment file into ENV_ARGS (KEY=VALUE words). The file is never sourced by bash:
# values such as password hashes contain "$" and must not be expanded. Values are never printed.
ENV_ARGS=()
load_env_file() {
	local line key value
	ENV_ARGS=()
	while IFS= read -r line || [ -n "$line" ]; do
		case "$line" in
		'' | '#'* | ';'*) continue ;;
		esac
		key="${line%%=*}"
		[ "$key" != "$line" ] || continue
		value="${line#*=}"
		key="${key#"${key%%[![:space:]]*}"}"
		key="${key%"${key##*[![:space:]]}"}"
		case "$value" in
		\"*\") value="${value#\"}"; value="${value%\"}" ;;
		\'*\') value="${value#\'}"; value="${value%\'}" ;;
		esac
		ENV_ARGS+=("$key=$value")
	done <"$ENV_FILE"
}

env_value() {
	local wanted="$1" default="$2" item
	for item in "${ENV_ARGS[@]}"; do
		if [ "${item%%=*}" = "$wanted" ]; then
			printf '%s' "${item#*=}"
			return
		fi
	done
	printf '%s' "$default"
}

probe() {
	# probe <port> <label>: /healthz and /readyz must both answer 200 within about 30 s.
	local port="$1" label="$2" path attempt
	for path in /healthz /readyz; do
		attempt=0
		until [ "$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:$port$path" || true)" = "200" ]; do
			attempt=$((attempt + 1))
			if [ "$attempt" -ge 30 ]; then
				warn "$label: $path did not return 200 on port $port"
				return 1
			fi
			sleep 1
		done
		say "$label: $path is 200"
	done
}

current_target() {
	if [ -L "$CURRENT" ]; then readlink -f "$CURRENT"; fi
}

previous_target() {
	if [ -L "$PREVIOUS" ]; then readlink -f "$PREVIOUS"; fi
}

# Atomic symlink switch: build the new link beside the old one, then rename(2) over it.
point_symlink() {
	local link="$1" target="$2" tmp="$1.new.$$"
	ln -sfn "$target" "$tmp"
	mv -T "$tmp" "$link"
}

restart_and_probe() {
	local port="$1"
	say "restarting $UNIT"
	systemctl restart "$UNIT" || return 1
	probe "$port" "production"
}

prune_releases() {
	local keep_current keep_previous entry name count=0
	keep_current="$(current_target)"
	keep_previous="$(previous_target)"
	# Newest first by the UTC timestamp suffix of <sha>-<timestamp>.
	while IFS= read -r name; do
		entry="$RELEASES/$name"
		count=$((count + 1))
		if [ "$count" -le "$KEEP" ]; then continue; fi
		if [ "$entry" = "$keep_current" ] || [ "$entry" = "$keep_previous" ]; then continue; fi
		say "pruning old release $name"
		rm -rf -- "$entry"
	done < <(
		for entry in "$RELEASES"/*/; do
			[ -d "$entry" ] || continue
			name="$(basename "$entry")"
			printf '%s %s\n' "${name##*-}" "$name"
		done | sort -r | awk '{print $2}'
	)
}

smoke_test() {
	local release="$1" smoke_home
	SMOKE_STATE="$(mktemp -d /var/tmp/ultrathink-smoke.XXXXXX)"
	chown "$SERVICE_USER": "$SMOKE_STATE"
	chmod 0700 "$SMOKE_STATE"
	smoke_home="$SMOKE_STATE/home"
	mkdir "$smoke_home" "$SMOKE_STATE/state"
	chown "$SERVICE_USER": "$smoke_home" "$SMOKE_STATE/state"
	SMOKE_LOG="$SMOKE_STATE/smoke.log"
	# The log file is created by root so the unprivileged process cannot be tricked into following a symlink.
	: >"$SMOKE_LOG"
	chown "$SERVICE_USER": "$SMOKE_LOG"
	say "smoke start on port $SMOKE_PORT with a throwaway state directory"
	(
		cd "$release"
		exec setpriv --reuid="$SERVICE_USER" --regid="$SERVICE_USER" --init-groups -- \
			env -i PATH=/usr/bin:/bin HOME="$smoke_home" "${ENV_ARGS[@]}" \
			ULTRATHINK_PORT="$SMOKE_PORT" ULTRATHINK_STATE_DIR="$SMOKE_STATE/state" \
			"$BUN" run services/ultrathink/server.ts
	) >"$SMOKE_LOG" 2>&1 &
	SMOKE_PID=$!
	if ! probe "$SMOKE_PORT" "smoke"; then
		warn "smoke process output (last lines; secrets are never logged by the service):"
		tail -n 20 "$SMOKE_LOG" >&2 || true
		cleanup_smoke
		return 1
	fi
	cleanup_smoke
}

do_release() {
	local ref="${1:-}" sha short stamp release old_current port
	[ -n "$ref" ] || usage
	require_root
	require_tools
	take_lock
	load_env_file
	port="$(env_value ULTRATHINK_PORT 8795)"

	sha="$(git -C "$REPO" rev-parse --verify "$ref^{commit}")" || die "cannot resolve git ref: $ref"
	short="${sha:0:12}"
	stamp="$(date -u +%Y%m%dT%H%M%SZ)"
	release="$RELEASES/$short-$stamp"
	old_current="$(current_target)"

	say "releasing $ref ($sha) from $REPO"
	say "uncommitted changes in the working tree are NOT part of the release (git archive of the commit)"
	mkdir -p "$RELEASES"
	chmod 0755 "$ROOT" "$RELEASES"
	mkdir "$release"
	if ! git -C "$REPO" archive --format=tar "$sha" | tar -x -C "$release"; then
		rm -rf -- "$release"
		die "git archive failed"
	fi
	printf '%s\n' "$sha" >"$release/REVISION"
	chown -R root:root "$release"
	chmod -R go+rX,go-w "$release"

	say "running tests in $release"
	if ! (cd "$release" && env -i PATH=/usr/bin:/bin HOME="$release/.test-home" \
		GIT_AUTHOR_NAME=ci GIT_AUTHOR_EMAIL=ci@example.com GIT_COMMITTER_NAME=ci GIT_COMMITTER_EMAIL=ci@example.com \
		"$BUN" test services/ultrathink); then
		rm -rf -- "$release"
		die "tests failed; release discarded, nothing was switched"
	fi

	if ! smoke_test "$release"; then
		rm -rf -- "$release"
		die "smoke test failed; release discarded, nothing was switched"
	fi

	say "switching $CURRENT to $release"
	if [ -n "$old_current" ]; then point_symlink "$PREVIOUS" "$old_current"; fi
	point_symlink "$CURRENT" "$release"

	if ! restart_and_probe "$port"; then
		warn "new release failed its production probe"
		if [ -n "$old_current" ]; then
			say "rolling back to $old_current"
			point_symlink "$CURRENT" "$old_current"
			if restart_and_probe "$port"; then
				warn "rolled back; the failed release is kept at $release for inspection"
			else
				warn "rollback restart also failed; inspect: journalctl -u $UNIT -n 100 --no-pager"
			fi
		else
			warn "there was no previous release to roll back to; inspect: journalctl -u $UNIT -n 100 --no-pager"
		fi
		exit 1
	fi

	prune_releases
	say "release complete: $release"
}

do_rollback() {
	local target now port
	require_root
	require_tools
	take_lock
	load_env_file
	port="$(env_value ULTRATHINK_PORT 8795)"

	target="$(previous_target)"
	[ -n "$target" ] && [ -d "$target" ] || die "no previous release to roll back to"
	now="$(current_target)"
	say "rolling back: $now -> $target"
	# Swap the links so that running rollback again flips forward again.
	if [ -n "$now" ]; then point_symlink "$PREVIOUS" "$now"; fi
	point_symlink "$CURRENT" "$target"
	if ! restart_and_probe "$port"; then
		warn "service did not become healthy on $target; restoring $now"
		if [ -n "$now" ]; then
			point_symlink "$CURRENT" "$now"
			point_symlink "$PREVIOUS" "$target"
			restart_and_probe "$port" || warn "restoring $now also failed; inspect: journalctl -u $UNIT -n 100 --no-pager"
		fi
		exit 1
	fi
	say "rollback complete: $target"
}

do_status() {
	printf 'current : %s\n' "$(current_target || true)"
	printf 'previous: %s\n' "$(previous_target || true)"
	if [ -d "$RELEASES" ]; then
		printf 'releases:\n'
		find "$RELEASES" -mindepth 1 -maxdepth 1 -type d -printf '  %f\n' | sort -r
	fi
}

case "${1:-}" in
release) do_release "${2:-}" ;;
rollback) do_rollback ;;
status) do_status ;;
*) usage ;;
esac
