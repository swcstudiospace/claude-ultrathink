#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 SWC Studio
#
# Release management for ultrathink-web.
#
#   ultrathink-release.sh release <git-ref>   build, test, security audit, smoke-test, switch, verify; roll back on any failure
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
# ULTRATHINK_KEEP_RELEASES, ULTRATHINK_TLS_DIR (CA bundle and app/ops leaves, default /etc/ultrathink/tls).
set -euo pipefail

ROOT="${ULTRATHINK_ROOT:-/opt/ultrathink}"
ENV_FILE="${ULTRATHINK_ENV_FILE:-/etc/ultrathink/ultrathink.env}"
UNIT="${ULTRATHINK_UNIT:-ultrathink-web}"
SERVICE_USER="${ULTRATHINK_SERVICE_USER:-ultrathink}"
SMOKE_PORT="${ULTRATHINK_SMOKE_PORT:-8796}"
KEEP="${ULTRATHINK_KEEP_RELEASES:-5}"
TLS_DIR="${ULTRATHINK_TLS_DIR:-/etc/ultrathink/tls}"
BUN="$ROOT/bin/bun"
RELEASES="$ROOT/releases"
CURRENT="$ROOT/current"
PREVIOUS="$ROOT/previous"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Only `release` needs a git checkout; rollback and status must work from an installed copy that has no .git.
REPO=""

SMOKE_PID=""
SMOKE_STATE=""
SMOKE_LOG=""
TEST_STATE=""
SEC_STATE=""

say() { printf '==> %s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }
die() {
	printf 'ERROR: %s\n' "$*" >&2
	exit 1
}

# Validated before anything else runs: a non-integer KEEP makes `[ "$count" -le "$KEEP" ]` false for every release,
# and prune_releases would then delete everything except current/previous. Same check as ultrathink-backup.sh.
case "$KEEP" in '' | *[!0-9]*) die "ULTRATHINK_KEEP_RELEASES must be a positive integer" ;; esac
[ "$KEEP" -ge 1 ] || die "ULTRATHINK_KEEP_RELEASES must be at least 1"

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

cleanup_test() {
	if [ -n "$TEST_STATE" ] && [ -d "$TEST_STATE" ]; then
		rm -rf -- "$TEST_STATE"
	fi
	TEST_STATE=""
}

cleanup_security() {
	if [ -n "$SEC_STATE" ] && [ -d "$SEC_STATE" ]; then
		rm -rf -- "$SEC_STATE"
	fi
	SEC_STATE=""
}

cleanup_all() {
	cleanup_smoke
	cleanup_test
	cleanup_security
}
trap cleanup_all EXIT

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

probe_status() {
	# probe_status <port> <path>: prints the HTTP status, or 000 when the handshake or the request fails.
	curl -s -o /dev/null -w '%{http_code}' --max-time 5 \
		--cacert "$TLS_DIR/ca.pem" --cert "$TLS_DIR/ops/cert.pem" --key "$TLS_DIR/ops/key.pem" \
		"https://127.0.0.1:$1$2" || true
}

probe() {
	# probe <port> <label>: /healthz and /readyz must both answer 200 within about 30 s over mTLS as the ops identity.
	# The app CA is pinned with --cacert and -k is never passed, so a server that cannot prove its chain or refuses the
	# ops leaf fails here, and no probe request goes out unauthenticated.
	local port="$1" label="$2" path attempt
	for path in /healthz /readyz; do
		attempt=0
		until [ "$(probe_status "$port" "$path")" = "200" ]; do
			attempt=$((attempt + 1))
			if [ "$attempt" -ge 30 ]; then
				warn "$label: $path did not return 200 on port $port over mTLS"
				return 1
			fi
			sleep 1
		done
		say "$label: $path is 200"
	done
}

# The app key is 0440 root:ultrathink, so the service user must be able to read it. Runs before any release file is
# written: a missing file or an unreadable key stops the release before the symlink switch.
check_tls_material() {
	local path
	for path in "$TLS_DIR/ca.pem" "$TLS_DIR/app/cert.pem" "$TLS_DIR/app/key.pem" "$TLS_DIR/ops/cert.pem" "$TLS_DIR/ops/key.pem"; do
		[ -f "$path" ] || die "TLS file missing: $path"
	done
	setpriv --reuid="$SERVICE_USER" --regid="$SERVICE_USER" --init-groups -- test -r "$TLS_DIR/app/key.pem" ||
		die "service user $SERVICE_USER cannot read $TLS_DIR/app/key.pem"
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
	# A release that crash-loops hits the unit's start limit and lands in "failed"; without this, the rollback restart
	# inside the same window is refused ("Start request repeated too quickly").
	systemctl reset-failed "$UNIT" 2>/dev/null || true
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

# The test suite of the archived commit is untrusted code (whatever the operator's ref contains), so it must never run
# as root: drop to the service user exactly like smoke_test, with HOME and TMPDIR in a throwaway directory outside the
# release tree so no root-owned artefacts (bun cache, test state) ship inside what becomes $CURRENT. The release tree is
# already root-owned and world-readable (see do_release), so the service user can read it but not modify it.
run_tests() {
	local release="$1" test_home
	TEST_STATE="$(mktemp -d /var/tmp/ultrathink-test.XXXXXX)"
	chown "$SERVICE_USER": "$TEST_STATE"
	chmod 0700 "$TEST_STATE"
	test_home="$TEST_STATE/home"
	mkdir "$test_home"
	chown "$SERVICE_USER": "$test_home"
	say "running tests in $release as $SERVICE_USER"
	if ! (
		cd "$release"
		exec setpriv --reuid="$SERVICE_USER" --regid="$SERVICE_USER" --init-groups -- \
			env -i PATH=/usr/bin:/bin HOME="$test_home" TMPDIR="$TEST_STATE" \
			GIT_AUTHOR_NAME=ci GIT_AUTHOR_EMAIL=ci@example.com GIT_COMMITTER_NAME=ci GIT_COMMITTER_EMAIL=ci@example.com \
			"$BUN" test services/ultrathink
	); then
		cleanup_test
		return 1
	fi
	cleanup_test
}

# The dependency audit gate: `security-gate.ts audit` runs in the release tree before the switch. Same isolation as
# run_tests: it runs as the service user, with HOME and the state directory in a throwaway directory outside the release
# tree, so nothing it writes ships inside $CURRENT. Rollback never runs it.
security_gate() {
	local release="$1" sec_home
	SEC_STATE="$(mktemp -d /var/tmp/ultrathink-security.XXXXXX)"
	chown "$SERVICE_USER": "$SEC_STATE"
	chmod 0700 "$SEC_STATE"
	sec_home="$SEC_STATE/home"
	mkdir "$sec_home"
	chown "$SERVICE_USER": "$sec_home"
	say "running security audit in $release as $SERVICE_USER"
	if ! (
		cd "$release"
		exec setpriv --reuid="$SERVICE_USER" --regid="$SERVICE_USER" --init-groups -- \
			env -i PATH=/usr/bin:/bin HOME="$sec_home" \
			"$BUN" run scripts/security-gate.ts audit --root . --out "$SEC_STATE"
	); then
		cleanup_security
		return 1
	fi
	cleanup_security
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
	# ENV_ARGS carries ULTRATHINK_TLS_*, so the smoke process serves the leaf production serves, and probe checks it over mTLS.
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
	local ref="${1:-}" sha short stamp release old_current old_previous port
	[ -n "$ref" ] || usage
	require_root
	require_tools
	take_lock
	REPO="${ULTRATHINK_REPO:-$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)}" || die "cannot locate the git checkout; set ULTRATHINK_REPO"
	load_env_file
	check_tls_material
	port="$(env_value ULTRATHINK_PORT 8795)"

	sha="$(git -C "$REPO" rev-parse --verify "$ref^{commit}")" || die "cannot resolve git ref: $ref"
	short="${sha:0:12}"
	stamp="$(date -u +%Y%m%dT%H%M%SZ)"
	release="$RELEASES/$short-$stamp"
	old_current="$(current_target)"
	old_previous="$(previous_target)"

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

	if ! run_tests "$release"; then
		rm -rf -- "$release"
		die "tests failed; release discarded, nothing was switched"
	fi

	if ! security_gate "$release"; then
		rm -rf -- "$release"
		die "security gate failed; release discarded, nothing was switched"
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
			# The failed switch pointed previous at old_current; put the earlier rollback target back.
			if [ -n "$old_previous" ]; then point_symlink "$PREVIOUS" "$old_previous"; else rm -f -- "$PREVIOUS"; fi
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
		find "$RELEASES" -mindepth 1 -maxdepth 1 -type d | while IFS= read -r dir; do printf '  %s\n' "${dir##*/}"; done | LC_ALL=C sort -r
	fi
}

# Sourcing the file defines its functions without running a subcommand; the release test sources it that way.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then
	case "${1:-}" in
	release) do_release "${2:-}" ;;
	rollback) do_rollback ;;
	status) do_status ;;
	*) usage ;;
	esac
fi
