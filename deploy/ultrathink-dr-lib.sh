#!/usr/bin/env bash
# SPDX-License-Identifier: AGPL-3.0-or-later
# Copyright (C) 2026 SWC Studio
#
# Shared helpers for the ultrathink disaster-recovery scripts (snapshot tick, restore, drill). This file is sourced,
# never executed. Sourcing defines functions and BUN_TOOL only. Exit codes: 0 success; 1 failure; 2 usage or
# configuration.
#
#   dr_setting NAME DEFAULT       environment first, then ULTRATHINK_ENV_FILE (read without sourcing), then DEFAULT
#   dr_bun ACTION SRC [DST]       SQLite helpers through bun:sqlite: copy, check, quick, compat, json, prune-db
#   dr_age encrypt|decrypt IN OUT age encryption to customer recipients, or decryption with an identity
#   dr_rsync SRC... DST           rsync over ssh with the options backup.sh uses
#   dr_timing STEP START_MS       prints "step STEP NNNms" since START_MS
#   dr_now_ms                     milliseconds since the epoch, or ULTRATHINK_DR_NOW_MS when set
#   dr_free_bytes DIR             bytes available on the filesystem holding DIR
#   dr_snapshot_cli CMD ARGS...   store/snapshots-cli.ts; candidate names come on stdin

ENV_FILE="${ULTRATHINK_ENV_FILE:-/etc/ultrathink/ultrathink.env}"

say() { printf '==> %s\n' "$*"; }
warn() { printf 'WARNING: %s\n' "$*" >&2; }
die() {
	printf 'ERROR: %s\n' "$*" >&2
	exit 1
}

# Usage or configuration failure: exit 2. Never call this from inside $(...), where exit only leaves the subshell.
dr_config_error() {
	printf 'ERROR: %s\n' "$*" >&2
	exit 2
}

# Read one KEY from the systemd-style environment file without sourcing it (values may contain "$").
# Only used for non-secret settings.
file_value() {
	local wanted="$1" line value
	[ -f "$ENV_FILE" ] || return 0
	while IFS= read -r line || [ -n "$line" ]; do
		case "$line" in
		"$wanted="*)
			value="${line#*=}"
			case "$value" in
			\"*\") value="${value#\"}"; value="${value%\"}" ;;
			\'*\') value="${value#\'}"; value="${value%\'}" ;;
			esac
			printf '%s' "$value"
			return 0
			;;
		esac
	done <"$ENV_FILE"
	return 0
}

dr_setting() {
	# dr_setting <name> <default>: environment first, then the environment file, then the default.
	local name="$1" default="$2" value="${!1:-}"
	if [ -z "$value" ]; then value="$(file_value "$name")"; fi
	printf '%s' "${value:-$default}"
}

# Repository root: this file lives in deploy/.
dr_repo_root() {
	(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
}

BUN_TOOL='
const { Database } = require("bun:sqlite");
const { readFileSync } = require("node:fs");

function check(path) {
	const db = new Database(path);
	try {
		const rows = db.query("PRAGMA integrity_check").all();
		const ok = rows.length === 1 && Object.values(rows[0])[0] === "ok";
		if (!ok) throw new Error("integrity_check failed: " + JSON.stringify(rows.slice(0, 5)));
		return db.query("SELECT count(*) AS n FROM sqlite_master WHERE type = \u0027table\u0027").get().n;
	} finally {
		db.close();
	}
}

function quick(path) {
	const db = new Database(path);
	try {
		const rows = db.query("PRAGMA quick_check").all();
		const ok = rows.length === 1 && Object.values(rows[0])[0] === "ok";
		if (!ok) throw new Error("quick_check failed: " + JSON.stringify(rows.slice(0, 5)));
	} finally {
		db.close();
	}
}

const action = process.env.UT_ACTION;
if (action === "copy") {
	const src = process.env.UT_SRC;
	const dst = process.env.UT_DST;
	const db = new Database(src);
	try {
		db.run("PRAGMA busy_timeout = 10000");
		db.run("VACUUM INTO \u0027" + dst.replaceAll("\u0027", "\u0027\u0027") + "\u0027");
	} finally {
		db.close();
	}
	console.log("sqlite copy ok, integrity ok, tables: " + check(dst));
} else if (action === "prune-db") {
	// Child tables are found through foreign keys by the store module, so the schema is not duplicated here.
	(async () => {
		const { pruneRuns } = await import(process.env.UT_RETENTION_MODULE);
		const cutoffMs = Date.now() - Number(process.env.UT_RETENTION_DAYS) * 86400000;
		if (!Number.isFinite(cutoffMs)) throw new Error("bad retention window");
		const db = new Database(process.env.UT_SRC);
		try {
			db.run("PRAGMA busy_timeout = 5000");
			const result = pruneRuns(db, { cutoffMs, today: new Date().toISOString().slice(0, 10) });
			console.log("database retention: removed " + result.runs + " runs, " + (result.rows.token_ledger ?? 0) + " ledger rows");
		} finally {
			db.close();
		}
	})().catch((error) => {
		console.error(String(error && error.message ? error.message : error));
		process.exit(1);
	});
} else if (action === "check") {
	console.log("sqlite integrity ok, tables: " + check(process.env.UT_SRC));
} else if (action === "quick") {
	quick(process.env.UT_SRC);
	console.log("sqlite quick ok");
} else if (action === "compat") {
	// The live file is never migrated: a scratch copy is opened with the openStore of this release, then removed.
	(async () => {
		const { openStore } = await import(process.env.UT_STORE_MODULE);
		const { mkdtempSync, rmSync } = require("node:fs");
		const { tmpdir } = require("node:os");
		const { join } = require("node:path");
		const scratch = mkdtempSync(join(tmpdir(), "ut-compat-"));
		try {
			const copy = join(scratch, "ultrathink.sqlite");
			const db = new Database(process.env.UT_SRC);
			try {
				db.run("PRAGMA busy_timeout = 10000");
				db.run("VACUUM INTO \u0027" + copy.replaceAll("\u0027", "\u0027\u0027") + "\u0027");
			} finally {
				db.close();
			}
			openStore(copy).close();
		} finally {
			rmSync(scratch, { recursive: true, force: true });
		}
		console.log("compat ok");
	})().catch((error) => {
		console.error(String(error && error.message ? error.message : error));
		process.exit(1);
	});
} else if (action === "json") {
	JSON.parse(readFileSync(process.env.UT_SRC, "utf8"));
	console.log("json ok");
} else {
	throw new Error("unknown action");
}
'

# dr_bun ACTION SRC [DST]. copy refuses an existing DST. compat opens a scratch copy, so SRC is never migrated.
dr_bun() {
	local action="$1" src="${2:-}" dst="${3:-}" bun root
	case "$action" in
	copy)
		[ -n "$dst" ] || dr_config_error "dr_bun copy needs a destination"
		if [ -e "$dst" ] || [ -L "$dst" ]; then
			warn "destination exists, not overwritten: $dst"
			return 1
		fi
		;;
	check | quick | compat | json | prune-db) ;;
	*) dr_config_error "unknown dr_bun action: $action" ;;
	esac
	[ -f "$src" ] || {
		warn "not a file: $src"
		return 1
	}
	bun="$(dr_setting ULTRATHINK_BUN /opt/ultrathink/bin/bun)"
	[ -x "$bun" ] || dr_config_error "Bun not found at $bun"
	root="$(dr_repo_root)"
	UT_ACTION="$action" UT_SRC="$src" UT_DST="$dst" \
		UT_RETENTION_DAYS="$(dr_setting ULTRATHINK_RETENTION_DAYS 30)" \
		UT_RETENTION_MODULE="$root/services/ultrathink/store/retention.ts" \
		UT_STORE_MODULE="$root/services/ultrathink/store/store.ts" \
		"$bun" -e "$BUN_TOOL"
}

# dr_age encrypt|decrypt IN OUT. Recipients come from ULTRATHINK_BACKUP_RECIPIENT (an age1 key, or a path to a
# recipients file); the identity from ULTRATHINK_AGE_IDENTITY. A missing key, identity or age binary exits 2 before
# anything is written. Output is written beside OUT and moved into place only on success.
dr_age() {
	local mode="$1" in="${2:-}" out="${3:-}" bin op tmp recipient identity
	local -a key_args
	if [ -z "$in" ] || [ -z "$out" ]; then dr_config_error "dr_age needs an input and an output path"; fi
	bin="$(dr_setting ULTRATHINK_AGE age)"
	case "$mode" in
	encrypt)
		recipient="$(dr_setting ULTRATHINK_BACKUP_RECIPIENT '')"
		[ -n "$recipient" ] || dr_config_error "ULTRATHINK_BACKUP_RECIPIENT is not set; refusing to write an unencrypted archive"
		case "$recipient" in
		age1*) key_args=(-r "$recipient") ;;
		*)
			[ -r "$recipient" ] || dr_config_error "recipients file not readable: $recipient"
			key_args=(-R "$recipient")
			;;
		esac
		op=--encrypt
		;;
	decrypt)
		identity="$(dr_setting ULTRATHINK_AGE_IDENTITY '')"
		[ -n "$identity" ] || dr_config_error "ULTRATHINK_AGE_IDENTITY is not set; decryption needs the operator identity"
		[ -r "$identity" ] || dr_config_error "identity file not readable: $identity"
		key_args=(-i "$identity")
		op=--decrypt
		;;
	*) dr_config_error "dr_age mode must be encrypt or decrypt, not: $mode" ;;
	esac
	command -v "$bin" >/dev/null 2>&1 || dr_config_error "age binary not found: $bin"
	[ -r "$in" ] || {
		warn "not readable: $in"
		return 1
	}
	tmp="$out.tmp-$$"
	if "$bin" "$op" "${key_args[@]}" -o "$tmp" "$in"; then
		mv -f -- "$tmp" "$out" || {
			rm -f -- "$tmp"
			die "cannot move $mode output into place: $out"
		}
	else
		rm -f -- "$tmp"
		die "age $mode failed for $in"
	fi
}

# dr_rsync SRC... DST. The same ssh options and file mode backup.sh has always used: the key and known_hosts come
# from $HOME/.ssh because ssh ignores $HOME and reads the passwd entry.
dr_rsync() {
	[ "$#" -ge 2 ] || dr_config_error "dr_rsync needs at least one source and a destination"
	rsync -a --chmod=F600 \
		-e "ssh -o BatchMode=yes -o ConnectTimeout=20 -o IdentitiesOnly=yes -i $HOME/.ssh/id_ed25519 -o UserKnownHostsFile=$HOME/.ssh/known_hosts" \
		-- "$@"
}

# Milliseconds since the epoch, or ULTRATHINK_DR_NOW_MS when set (a test seam: a fixed "now"). Returns 2 on a bad value.
dr_now_ms() {
	local fixed
	fixed="$(dr_setting ULTRATHINK_DR_NOW_MS '')"
	if [ -n "$fixed" ]; then
		case "$fixed" in
		*[!0-9]*)
			warn "ULTRATHINK_DR_NOW_MS must be a non-negative integer"
			return 2
			;;
		esac
		printf '%s\n' "$fixed"
		return 0
	fi
	date +%s%3N
}

# dr_timing STEP START_MS: prints "step STEP NNNms" for the time elapsed since START_MS.
dr_timing() {
	local now
	now="$(dr_now_ms)" || return 2
	printf 'step %s %sms\n' "$1" "$((now - $2))"
}

# dr_free_bytes DIR: bytes available to unprivileged users on the filesystem holding DIR (df -P -B1, field 4).
dr_free_bytes() {
	local out _fs _total _used avail _rest
	out="$(df -P -B1 -- "$1")" || return 1
	read -r _fs _total _used avail _rest <<<"$(printf '%s\n' "$out" | tail -n 1)"
	printf '%s\n' "$avail"
}

# dr_snapshot_cli CMD ARGS...: runs store/snapshots-cli.ts. Names for pick, plan and next are read from stdin.
dr_snapshot_cli() {
	local bun root
	bun="$(dr_setting ULTRATHINK_BUN /opt/ultrathink/bin/bun)"
	[ -x "$bun" ] || dr_config_error "Bun not found at $bun"
	root="$(dr_repo_root)"
	"$bun" "$root/services/ultrathink/store/snapshots-cli.ts" "$@"
}
