#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 SWC Studio
#
# Builds dist/ultrathink-connector-<version>.zip for Customize > Plugins > Add > Upload plugin.
# The manifest sits at the archive root; dist/, this script and test files are left out.
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
manifest="$here/.claude-plugin/plugin.json"

if [ ! -f "$manifest" ]; then
	echo "package.sh: missing $manifest" >&2
	exit 1
fi

version=$(grep -m1 '"version"' "$manifest" | sed -e 's/^.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*$/\1/')
case "$version" in
	"" | *[!0-9A-Za-z.+-]*)
		echo "package.sh: cannot read a usable version from $manifest" >&2
		exit 1
		;;
esac

dist="$here/dist"
archive="$dist/ultrathink-connector-$version.zip"
mkdir -p "$dist"
rm -f "$archive"

cd "$here"
# Dotfiles (.gitignore, .DS_Store, anything under a dot directory) stay out, except .mcp.json and .claude-plugin/.
files=$(find . -type f \
	! -path './dist/*' ! -name 'package.sh' ! -name '*.test.*' ! -name '.DS_Store' \
	! \( -name '.*' ! -path './.mcp.json' ! -path './.claude-plugin/*' \) \
	! \( -path '*/.*/*' ! -path './.claude-plugin/*' \) \
	| sed -e 's|^\./||' | sort)
if command -v zip >/dev/null 2>&1; then
	# zip -@ reads one path per line, so no -x pattern can catch .claude-plugin/ by accident.
	printf '%s\n' "$files" | zip -q "$archive" -@
elif command -v python3 >/dev/null 2>&1; then
	# python3 -m zipfile -c takes explicit paths, so pass the same list.
	# One path per line; no globbing, so names with spaces or brackets survive.
	set -f
	IFS='
'
	# shellcheck disable=SC2086
	python3 -m zipfile -c "$archive" $files
else
	echo "package.sh: needs zip or python3" >&2
	exit 1
fi

echo "$archive"
