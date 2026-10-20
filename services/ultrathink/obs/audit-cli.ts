// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

/**
 * Operator command for the security audit trail (Refs SPE-17437):
 *
 *   bun services/ultrathink/obs/audit-cli.ts verify [path]
 *
 * Verifies the hash chain of the audit file (default `${ULTRATHINK_STATE_DIR ?? /var/lib/ultrathink}/audit.jsonl`)
 * and prints one line: `audit ok: N records, last <hash>` (exit 0) or `audit BROKEN at record N: <reason>` (exit 1).
 * Usage errors exit 2. Nothing is written.
 */

import { auditPath, verifyAuditFile } from "./audit.ts";

type Env = Record<string, string | undefined>;

const DEFAULT_STATE_DIR = "/var/lib/ultrathink";
const USAGE = `usage: bun services/ultrathink/obs/audit-cli.ts verify [path]

Verifies the tamper-evident audit trail and prints one line.
  path    audit file; default \${ULTRATHINK_STATE_DIR:-${DEFAULT_STATE_DIR}}/audit.jsonl
  --help  this text

exit 0: chain intact; 1: chain broken or unreadable; 2: usage error`;

export interface CliIo {
	out(line: string): void;
	err(line: string): void;
}

/** Runs the command and returns the exit code; `io.out` receives the single result line, `io.err` usage errors. */
export function main(argv: readonly string[], env: Env = process.env, io: CliIo = { out: console.log, err: console.error }): number {
	if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
		(argv.length === 0 ? io.err : io.out)(USAGE);
		return argv.length === 0 ? 2 : 0;
	}
	const [command, path, ...rest] = argv;
	if (command !== "verify" || rest.length > 0 || path?.startsWith("-")) {
		io.err(USAGE);
		return 2;
	}
	const stateDir = env.ULTRATHINK_STATE_DIR?.trim() || DEFAULT_STATE_DIR;
	const target = path ?? auditPath(stateDir);
	const result = verifyAuditFile(target);
	if (result.ok) {
		io.out(`audit ok: ${result.records} records, last ${result.lastHash}`);
		return 0;
	}
	io.out(`audit BROKEN at record ${result.brokenAt}: ${result.reason}`);
	return 1;
}

if (import.meta.main) {
	process.exit(main(process.argv.slice(2)));
}
