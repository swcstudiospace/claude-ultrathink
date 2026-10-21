#!/bin/sh
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 SWC Studio
#
# Builds dist/ultrathink-connector-<version>.zip for Customize > Plugins > Add > Upload plugin.
# The manifest sits at the archive root. Only an explicit allowlist is packed, so a stray file in the working tree
# (a key, an editor backup, a build output) can never reach the archive.
set -eu

here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
manifest="$here/.claude-plugin/plugin.json"

if [ ! -f "$manifest" ]; then
	echo "package.sh: missing $manifest" >&2
	exit 1
fi

version=$(grep -m1 '"version"' "$manifest" | sed -e 's/^.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*$/\1/' || true)
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
# The allowlist: the manifest, the server entry, the README, every command file and every non-test, non-dot file of skills/.
for required in .claude-plugin/plugin.json .mcp.json README.md; do
	if [ ! -f "$required" ]; then
		echo "package.sh: missing $here/$required" >&2
		exit 1
	fi
done
files=$(
	{
		printf '%s\n' .claude-plugin/plugin.json .mcp.json README.md
		if [ -d commands ]; then
			find commands -maxdepth 1 -type f -name '*.md' ! -name '.*' ! -name '*.test.*'
		fi
		if [ -d skills ]; then
			find skills -type f ! -name '*.test.*' ! -path '*/.*'
		fi
	} | sort
)
if command -v zip >/dev/null 2>&1; then
	# zip -@ reads one path per line, so no -x pattern can catch .claude-plugin/ by accident.
	printf '%s\n' "$files" | zip -q "$archive" -@
elif command -v python3 >/dev/null 2>&1; then
	# The zipfile command line (-c) stores each file by its basename and would drop .claude-plugin/, commands/ and skills/,
	# so write the same list with explicit archive names. The list travels in the environment because stdin carries the program;
	# it is one path per line, so names with spaces or brackets survive.
	ULTRATHINK_PACK_FILES="$files" python3 - "$archive" <<'PY'
import os
import sys
import zipfile

archive = sys.argv[1]
paths = sorted(line for line in os.environ["ULTRATHINK_PACK_FILES"].split("\n") if line)
with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as zf:
    for path in paths:
        zf.write(path, arcname=path.replace(os.sep, "/"))
PY
else
	echo "package.sh: needs zip or python3" >&2
	exit 1
fi

echo "$archive"
