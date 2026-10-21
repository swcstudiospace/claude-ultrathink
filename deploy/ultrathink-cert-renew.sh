#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 SWC Studio
#
# Renewal hook for the internal TLS leaves (app, edge, ops). Run hourly by ultrathink-cert-renew.timer, as root.
#
#   ultrathink-cert-renew.sh      renew every leaf under 12 h from expiry, then reload only what changed
#
# Reload rules:
#   app renewed   -> systemctl restart ultrathink-web   (the app reads its leaf only at start)
#   edge renewed  -> nginx -t && systemctl reload nginx (nginx loads proxy_ssl_certificate at config time)
#   nothing renewed and no reload pending -> nothing restarted or reloaded
#   a failed reload -> its marker stays in the TLS directory, and the next run retries it
#
# The PKI script is called once per leaf, not once for all three. It stops at its first failing name, so a combined
# call would leave the names after a failing one unchecked, and a leaf could expire without anyone retrying it. Each
# leaf's reload runs even when another leaf failed, because a renewed leaf stays unused in the running process until
# its reload. The hook exits non-zero when any renewal or reload fails, and names the failing leaf in the journal.
#
# Environment (optional):
#   ULTRATHINK_TLS_DIR   TLS directory (default /etc/ultrathink/tls)
#   ULTRATHINK_PKI       PKI script (default: ultrathink-pki.sh next to this script)
set -euo pipefail

TLS_DIR="${ULTRATHINK_TLS_DIR:-/etc/ultrathink/tls}"
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PKI="${ULTRATHINK_PKI:-$SCRIPT_DIR/ultrathink-pki.sh}"

say() { printf '==> %s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }

if [[ ! -f "$PKI" ]]; then
	warn "PKI script not found: $PKI"
	exit 1
fi

renewed=()
failed=()

for name in app edge ops; do
	status=0
	out="$(bash "$PKI" renew-if-due "$TLS_DIR" "$name")" || status=$?
	if [[ -n "$out" ]]; then
		printf '%s\n' "$out"
	fi
	if (( status != 0 )); then
		warn "renewal failed for leaf: $name (pki exit $status)"
		failed+=("$name")
		continue
	fi
	if grep -qx "renewed $name" <<<"$out"; then
		renewed+=("$name")
	fi
done

if (( ${#renewed[@]} == 0 && ${#failed[@]} == 0 )); then
	say "no TLS leaf due for renewal"
fi

# A reload stays pending until it succeeds. Its marker sits in the TLS directory, so a failed reload is retried by the next
# hourly run, even though the leaf is no longer due for renewal.
pending_marker() {
	printf '%s/.reload-pending-%s\n' "$TLS_DIR" "$1"
}

was_renewed() {
	local leaf
	# ${renewed[@]+...} expands to nothing when the array is empty; a bare "${renewed[@]}" fails under set -u on bash 3.2.
	for leaf in ${renewed[@]+"${renewed[@]}"}; do
		if [[ "$leaf" == "$1" ]]; then
			return 0
		fi
	done
	return 1
}

reload_failed=0
for name in app edge; do
	marker="$(pending_marker "$name")"
	if [[ ! -e "$marker" ]] && ! was_renewed "$name"; then
		continue
	fi
	# The marker is written before the reload and removed only after the reload succeeds.
	if ! : >"$marker"; then
		warn "cannot write the reload marker $marker; a failed reload of $name will not be retried"
		reload_failed=1
	fi
	case "$name" in
	app)
		say "restarting ultrathink-web (app leaf renewed or reload pending)"
		if systemctl restart ultrathink-web; then
			rm -f -- "$marker"
		else
			warn "restart of ultrathink-web failed; the next run retries it"
			reload_failed=1
		fi
		;;
	edge)
		say "reloading nginx (edge leaf renewed or reload pending)"
		if nginx -t && systemctl reload nginx; then
			rm -f -- "$marker"
		else
			warn "nginx reload failed; the next run retries it"
			reload_failed=1
		fi
		;;
	esac
done

if (( ${#failed[@]} > 0 || reload_failed )); then
	exit 1
fi
