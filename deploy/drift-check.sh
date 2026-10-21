#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 SWC Studio
#
# Report-only drift check for the ultrathink systemd units.
#
#   drift-check.sh --unit-dir <dir> --install-dir <dir> --report <file> [--remediation-plan] [--live <url>]
#
# Every ultrathink-*.service and ultrathink-*.timer in --unit-dir (the release's deploy/ directory) is compared by
# sha256 with the copy of the same name in --install-dir (/etc/systemd/system on a host). Each unit is reported as:
#   ok       the installed copy is byte-identical
#   drift    the installed copy differs
#   missing  there is no installed copy
# The JSON report goes to --report, written atomically. One status line per unit goes to stderr.
#
# --remediation-plan prints the commands that would bring drifted units up to date, on stdout:
#   install -m 0644 <unit> <install-dir>/
#   systemctl daemon-reload
# The script runs none of them and never writes to --install-dir. Missing units are reported, not planned.
#
# --live <url> also runs policy/check.sh --live <url> (policy/ beside deploy/ in the release) and records its result
# under "live" in the report. A failing live check fails the run. Its output goes to stderr.
#
# Exit codes: 0 every unit ok and the live check, if requested, passed; 1 drift, a missing unit or a failed live
# check (the report is written); 2 usage, configuration or dependency error (no report is written).
set -euo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHECK_SCRIPT="$SELF_DIR/../policy/check.sh"

usage() {
	printf 'usage: drift-check.sh --unit-dir DIR --install-dir DIR --report FILE [--remediation-plan] [--live URL]\n' >&2
	exit 2
}

die() {
	printf 'drift-check: %s\n' "$*" >&2
	exit 2
}

json_str() {
	# json_str TEXT: prints TEXT as a quoted JSON string.
	local s="$1"
	s="${s//\\/\\\\}"
	s="${s//\"/\\\"}"
	s="${s//$'\t'/\\t}"
	s="${s//$'\n'/\\n}"
	s="${s//$'\r'/\\r}"
	printf '"%s"' "$s"
}

json_or_null() {
	# json_or_null TEXT: a quoted JSON string, or null when TEXT is empty.
	if [[ -n "$1" ]]; then json_str "$1"; else printf 'null'; fi
}

UNIT_DIR=""
INSTALL_DIR=""
REPORT=""
REMEDIATION_PLAN=0
LIVE_URL=""

while (($# > 0)); do
	case "$1" in
	--unit-dir)
		[[ $# -ge 2 && -n "$2" ]] || die "--unit-dir needs a directory"
		UNIT_DIR="$2"
		shift 2
		;;
	--install-dir)
		[[ $# -ge 2 && -n "$2" ]] || die "--install-dir needs a directory"
		INSTALL_DIR="$2"
		shift 2
		;;
	--report)
		[[ $# -ge 2 && -n "$2" ]] || die "--report needs a file path"
		REPORT="$2"
		shift 2
		;;
	--live)
		[[ $# -ge 2 && -n "$2" ]] || die "--live needs a URL"
		LIVE_URL="$2"
		shift 2
		;;
	--remediation-plan)
		REMEDIATION_PLAN=1
		shift
		;;
	*)
		usage
		;;
	esac
done

[[ -n "$UNIT_DIR" ]] || die "missing --unit-dir"
[[ -n "$INSTALL_DIR" ]] || die "missing --install-dir"
[[ -n "$REPORT" && -n "${REPORT##*/}" ]] || die "--report needs a file name"
[[ -d "$UNIT_DIR" ]] || die "unit dir is not a directory: $UNIT_DIR"
[[ -d "$INSTALL_DIR" ]] || die "install dir is not a directory: $INSTALL_DIR"
REPORT_DIR="$(dirname "$REPORT")"
[[ -d "$REPORT_DIR" ]] || die "report directory does not exist: $REPORT_DIR"
if [[ -n "$LIVE_URL" && ! -f "$CHECK_SCRIPT" ]]; then
	die "--live needs policy/check.sh beside deploy/, not found: $CHECK_SCRIPT"
fi

UNIT_DIR="$(cd "$UNIT_DIR" && pwd)"
INSTALL_DIR="$(cd "$INSTALL_DIR" && pwd)"
REPORT_DIR="$(cd "$REPORT_DIR" && pwd)"
REPORT="$REPORT_DIR/${REPORT##*/}"

if command -v sha256sum >/dev/null 2>&1; then
	HASH_NAME="sha256sum"
	HASH_CMD=(sha256sum)
elif command -v shasum >/dev/null 2>&1; then
	HASH_NAME="shasum -a 256"
	HASH_CMD=(shasum -a 256)
else
	die "neither sha256sum nor shasum is on PATH"
fi

sha256_of() {
	# sha256_of FILE: prints the hex digest of FILE; fails when FILE cannot be read.
	local line
	line="$("${HASH_CMD[@]}" "$1")" || return 1
	printf '%s' "${line%% *}"
}

shopt -s nullglob
UNIT_FILES=("$UNIT_DIR"/ultrathink-*.service "$UNIT_DIR"/ultrathink-*.timer)
shopt -u nullglob
((${#UNIT_FILES[@]} > 0)) || die "no ultrathink-*.service or ultrathink-*.timer in $UNIT_DIR"

NAMES=()
STATUSES=()
SOURCE_SHAS=()
INSTALLED_SHAS=()
DRIFT_COUNT=0
MISSING_COUNT=0

for unit in "${UNIT_FILES[@]}"; do
	[[ -f "$unit" ]] || continue
	name="${unit##*/}"
	source_sha="$(sha256_of "$unit")" || die "cannot read unit: $unit"
	installed="$INSTALL_DIR/$name"
	installed_sha=""
	if [[ -f "$installed" ]]; then
		installed_sha="$(sha256_of "$installed")" || die "cannot read installed unit: $installed"
		if [[ "$installed_sha" == "$source_sha" ]]; then
			status="ok"
		else
			status="drift"
			DRIFT_COUNT=$((DRIFT_COUNT + 1))
		fi
	else
		status="missing"
		MISSING_COUNT=$((MISSING_COUNT + 1))
	fi
	NAMES+=("$name")
	STATUSES+=("$status")
	SOURCE_SHAS+=("$source_sha")
	INSTALLED_SHAS+=("$installed_sha")
	printf '%s: %s\n' "$name" "$status" >&2
done

((${#NAMES[@]} > 0)) || die "no regular ultrathink unit files in $UNIT_DIR"

LIVE_JSON="null"
LIVE_FAILED=0
if [[ -n "$LIVE_URL" ]]; then
	if bash "$CHECK_SCRIPT" --live "$LIVE_URL" >&2; then
		live_rc=0
		live_status="pass"
	else
		live_rc=$?
		live_status="fail"
		LIVE_FAILED=1
	fi
	printf 'live: %s (exit %s)\n' "$live_status" "$live_rc" >&2
	LIVE_JSON="$(printf '{"url": %s, "exit_code": %s, "status": "%s"}' \
		"$(json_str "$LIVE_URL")" "$live_rc" "$live_status")"
fi

OVERALL="ok"
if ((DRIFT_COUNT > 0 || MISSING_COUNT > 0 || LIVE_FAILED > 0)); then
	OVERALL="fail"
fi

UNITS_JSON=""
SEPARATOR=""
for ((i = 0; i < ${#NAMES[@]}; i++)); do
	entry="$(printf '{"name": %s, "status": "%s", "source_sha256": %s, "installed_sha256": %s}' \
		"$(json_str "${NAMES[i]}")" "${STATUSES[i]}" "$(json_str "${SOURCE_SHAS[i]}")" \
		"$(json_or_null "${INSTALLED_SHAS[i]}")")"
	UNITS_JSON+="${SEPARATOR}    ${entry}"
	SEPARATOR=$',\n'
done

TMP_REPORT="$(mktemp "$REPORT_DIR/.drift-report.XXXXXX")"
trap 'rm -f "$TMP_REPORT"' EXIT
{
	printf '{\n'
	printf '  "tool": "drift-check.sh",\n'
	printf '  "hash": %s,\n' "$(json_str "$HASH_NAME")"
	printf '  "unit_dir": %s,\n' "$(json_str "$UNIT_DIR")"
	printf '  "install_dir": %s,\n' "$(json_str "$INSTALL_DIR")"
	printf '  "units": [\n%s\n  ],\n' "$UNITS_JSON"
	printf '  "drift_count": %s,\n' "$DRIFT_COUNT"
	printf '  "missing_count": %s,\n' "$MISSING_COUNT"
	printf '  "live": %s,\n' "$LIVE_JSON"
	printf '  "status": "%s"\n' "$OVERALL"
	printf '}\n'
} >"$TMP_REPORT"
mv -f "$TMP_REPORT" "$REPORT"
trap - EXIT

if ((REMEDIATION_PLAN == 1 && DRIFT_COUNT > 0)); then
	for ((i = 0; i < ${#NAMES[@]}; i++)); do
		if [[ "${STATUSES[i]}" == "drift" ]]; then
			printf 'install -m 0644 %q %s/\n' "$UNIT_DIR/${NAMES[i]}" "$(printf '%q' "$INSTALL_DIR")"
		fi
	done
	printf 'systemctl daemon-reload\n'
fi

printf 'drift-check: %s (%s drift, %s missing), report %s\n' \
	"$OVERALL" "$DRIFT_COUNT" "$MISSING_COUNT" "$REPORT" >&2

if [[ "$OVERALL" == "ok" ]]; then
	exit 0
fi
exit 1
