#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 SWC Studio
#
# Policy runner. Resolves the pinned OPA binary, then checks the Rego sources and evaluates the policy violations
# against the tree under --root. Policy sources always come from policy/ next to this script, so a run against
# another tree applies this repository's rules to it.
#
#   policy/check.sh [--root <dir>] [--live <url>]
#
#   --root <dir>   tree to inspect; .github/workflows and deploy/ are read from here (default: this repository)
#   --live <url>   also collect the live response headers from <url> (collect.ts --live)
#   --live-ca <file>   CA that signed the https --live server (collect.ts --live-ca)
#   --live-cert <file> client certificate for the https --live probe; needs --live-key
#   --live-key <file>  its private key; needs --live-cert
#
# OPA binary: always the one named in policy/opa-pin.json. It is downloaded, its sha256 is checked, and it runs only on a
# match. A mismatch aborts the run. No environment variable selects another binary or skips the check.
#   OPA_DOWNLOAD_URL   replaces the url in opa-pin.json; the sha256 check still applies (tests use a file:// URL)
#   OPA_BIN            ignored; a warning is printed when it is set
#
# Steps, stopping at the first failure:
#   1. opa check --strict on every .rego file
#   2. opa test on policy/
#   3. collect.ts --root <dir> [--live <url>] writes the input document to a temp file
#   4. opa eval data.ultrathink.policy.violations; the run passes only when that set is empty
#
# Exit: 0 pass; 1 a step failed, a checksum mismatched, or violations were found; 2 usage or configuration error.
set -euo pipefail

say() { printf '==> %s\n' "$*"; }
die() {
	printf 'check.sh: %s\n' "$*" >&2
	exit 1
}
usage() {
	printf 'check.sh: %s\n' "$*" >&2
	exit 2
}

# The pin file's fields come from bun, which the rest of the pipeline already needs. The key is passed in the
# environment, so no field value is ever spliced into code.
pin_field() {
# shellcheck disable=SC2016 # The JavaScript is single-quoted on purpose: ${...} is a JS template, not a shell expansion.
	PIN_FILE="$PIN" PIN_KEY="$1" bun -e '
		const pin = JSON.parse(require("node:fs").readFileSync(process.env.PIN_FILE, "utf8"));
		const value = pin[process.env.PIN_KEY];
		if (typeof value !== "string" || value === "") {
			console.error(`opa-pin.json: "${process.env.PIN_KEY}" is null or empty: no verified OPA pin, refusing to download`);
			process.exit(1);
		}
		process.stdout.write(value);
	'
}

sha256_of() {
	if command -v sha256sum >/dev/null 2>&1; then
		sha256sum "$1" | cut -d ' ' -f 1
	else
		shasum -a 256 "$1" | cut -d ' ' -f 1
	fi
}

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
ROOT="$REPO_DIR"
LIVE=""
LIVE_CA=""
LIVE_CERT=""
LIVE_KEY=""

while [ $# -gt 0 ]; do
	case "$1" in
	--root)
		[ $# -ge 2 ] || usage "--root needs a directory"
		ROOT="$2"
		shift 2
		;;
	--live)
		[ $# -ge 2 ] || usage "--live needs a URL"
		LIVE="$2"
		shift 2
		;;
	--live-ca)
		[ $# -ge 2 ] || usage "--live-ca needs a file"
		[ -n "$2" ] || usage "--live-ca needs a non-empty file: an empty value would fall back to the system trust store"
		LIVE_CA="$2"
		shift 2
		;;
	--live-cert)
		[ $# -ge 2 ] || usage "--live-cert needs a file"
		[ -n "$2" ] || usage "--live-cert needs a non-empty file: an empty value would drop the pinned certificate"
		LIVE_CERT="$2"
		shift 2
		;;
	--live-key)
		[ $# -ge 2 ] || usage "--live-key needs a file"
		[ -n "$2" ] || usage "--live-key needs a non-empty file: an empty value would drop the pinned key"
		LIVE_KEY="$2"
		shift 2
		;;
	*)
		usage "unknown argument: $1"
		;;
	esac
done

if [ -z "$LIVE" ] && [ -n "$LIVE_CA$LIVE_CERT$LIVE_KEY" ]; then
	usage "--live-ca, --live-cert and --live-key need --live"
fi
if [ -n "$LIVE_CERT$LIVE_KEY" ] && { [ -z "$LIVE_CERT" ] || [ -z "$LIVE_KEY" ]; }; then
	usage "--live-cert and --live-key must be given together"
fi

[ -d "$ROOT" ] || usage "--root is not a directory: $ROOT"
ROOT="$(cd -- "$ROOT" && pwd)"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

if [ -n "${OPA_BIN:-}" ]; then
	printf 'check.sh: OPA_BIN is ignored: only the binary pinned in opa-pin.json, verified by sha256, runs\n' >&2
fi

PIN="$SCRIPT_DIR/opa-pin.json"
[ -f "$PIN" ] || die "missing $PIN"
VERSION="$(pin_field version)"
ASSET="$(pin_field asset)"
EXPECTED_SHA="$(pin_field sha256)"
PINNED_URL="$(pin_field url)"
[[ "$EXPECTED_SHA" =~ ^[0-9a-f]{64}$ ]] || die "opa-pin.json sha256 is not 64 lowercase hex characters"
URL="${OPA_DOWNLOAD_URL:-$PINNED_URL}"

OPA="$WORK/opa"
say "download $ASSET $VERSION"
curl --fail --silent --show-error --location --output "$OPA" "$URL" || die "download failed: $URL"
ACTUAL_SHA="$(sha256_of "$OPA")"
if [ "$ACTUAL_SHA" != "$EXPECTED_SHA" ]; then
	die "OPA checksum mismatch for $ASSET: pinned $EXPECTED_SHA, downloaded $ACTUAL_SHA; refusing to run it"
fi
chmod 0755 "$OPA"

ALL_REGO=("$SCRIPT_DIR"/*.rego)
[ -e "${ALL_REGO[0]}" ] || die "no .rego files in $SCRIPT_DIR"
RULES=()
for file in "${ALL_REGO[@]}"; do
	case "$file" in
	*_test.rego) ;;
	*) RULES+=("$file") ;;
	esac
done

say "opa check --strict"
"$OPA" check --strict "${ALL_REGO[@]}" || die "opa check --strict failed"

say "opa test"
# controls.json is the compliance catalog read by compliance-report.ts. It is not Rego data and is a JSON array, so opa test must skip it.
"$OPA" test --ignore controls.json "$SCRIPT_DIR" -v || die "opa test failed"

say "collect $ROOT${LIVE:+ (live: $LIVE)}"
COLLECT_ARGS=(--root "$ROOT")
if [ -n "$LIVE" ]; then
	COLLECT_ARGS+=(--live "$LIVE")
	if [ -n "$LIVE_CA" ]; then COLLECT_ARGS+=(--live-ca "$LIVE_CA"); fi
	if [ -n "$LIVE_CERT" ]; then COLLECT_ARGS+=(--live-cert "$LIVE_CERT" --live-key "$LIVE_KEY"); fi
fi
bun "$SCRIPT_DIR/collect.ts" "${COLLECT_ARGS[@]}" > "$WORK/input.json" || die "collect.ts failed"

say "opa eval data.ultrathink.policy.violations"
DATA_ARGS=()
for rule in "${RULES[@]}"; do DATA_ARGS+=(-d "$rule"); done
"$OPA" eval --format json "${DATA_ARGS[@]}" -i "$WORK/input.json" data.ultrathink.policy.violations > "$WORK/eval.json" ||
	die "opa eval failed"

# An undefined set is a failure, not a pass: a misspelled package or rule name must not read as "no violations".
STATUS=0
# shellcheck disable=SC2016 # Single quotes keep the JavaScript's template literals and $ references out of bash.
REPORT="$(EVAL_FILE="$WORK/eval.json" bun -e '
	const doc = JSON.parse(require("node:fs").readFileSync(process.env.EVAL_FILE, "utf8"));
	const value = doc?.result?.[0]?.expressions?.[0]?.value;
	if (!Array.isArray(value)) {
		console.error("opa eval returned no violations set: check the package name and the rule");
		process.exitCode = 2;
	} else {
		for (const v of value) console.log(`${v.rule} ${v.file}: ${v.detail}`);
		process.exitCode = value.length > 0 ? 1 : 0;
	}
')" || STATUS=$?

case "$STATUS" in
0)
	say "policy check passed: no violations"
	;;
1)
	printf '%s\n' "$REPORT"
	die "policy violations found"
	;;
*)
	die "could not read the violations set from opa eval output"
	;;
esac
