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
#   nothing renewed -> nothing restarted or reloaded
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

reload_failed=0
for name in "${renewed[@]}"; do
	case "$name" in
	app)
		say "restarting ultrathink-web (app leaf renewed)"
		if ! systemctl restart ultrathink-web; then
			warn "restart of ultrathink-web failed after app leaf renewal"
			reload_failed=1
		fi
		;;
	edge)
		say "reloading nginx (edge leaf renewed)"
		if ! { nginx -t && systemctl reload nginx; }; then
			warn "nginx reload failed after edge leaf renewal"
			reload_failed=1
		fi
		;;
	esac
done

if (( ${#failed[@]} > 0 || reload_failed )); then
	exit 1
fi
