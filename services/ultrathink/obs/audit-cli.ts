// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

/**
 * Operator command for the security audit trail (Refs SPE-17437):
 *
 *   bun services/ultrathink/obs/audit-cli.ts verify [path] [--expect <seq>:<hash>]...
 *
 * Verifies the hash chain of the audit file (default `${ULTRATHINK_STATE_DIR ?? /var/lib/ultrathink}/audit.jsonl`)
 * and prints one line: `audit ok: N records, last <hash>` (exit 0) or `audit BROKEN at record N: <reason>` (exit 1).
 * Each `--expect` names a record and the hash it must have (CONTEXT D3): a copy kept off-host proves that a record
 * is still present. A mismatch prints `audit BROKEN: expected record <seq> hash <hash>, found <found|none>` (exit 1).
 * Usage errors, including a malformed expectation, exit 2. Nothing is written.
 */

import { auditPath, recordHashes, verifyAuditFile } from "./audit.ts";

type Env = Record<string, string | undefined>;

interface Expectation {
	seq: number;
	hash: string;
}

const DEFAULT_STATE_DIR = "/var/lib/ultrathink";
const EXPECT = /^([1-9][0-9]*):([0-9a-f]{64})$/;
const USAGE = `usage: bun services/ultrathink/obs/audit-cli.ts verify [path] [--expect <seq>:<hash>]...

Verifies the tamper-evident audit trail and prints one line.
  path             audit file; default \${ULTRATHINK_STATE_DIR:-${DEFAULT_STATE_DIR}}/audit.jsonl
  --expect S:H     require record S to have hash H (64 lowercase hex); repeatable
  --help           this text

exit 0: chain intact and expectations met; 1: chain broken, unreadable or an expectation failed; 2: usage error`;

export interface CliIo {
	out(line: string): void;
	err(line: string): void;
}

/** Parses `<seq>:<hash>`; undefined when malformed. */
function parseExpectation(value: string | undefined): Expectation | undefined {
	const match = value === undefined ? null : EXPECT.exec(value);
	if (match === null) return undefined;
	const seq = Number(match[1]);
	if (!Number.isSafeInteger(seq)) return undefined;
	return { seq, hash: match[2] as string };
}

/** Runs the command and returns the exit code; `io.out` receives the single result line, `io.err` usage errors. */
export function main(argv: readonly string[], env: Env = process.env, io: CliIo = { out: console.log, err: console.error }): number {
	if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
		(argv.length === 0 ? io.err : io.out)(USAGE);
		return argv.length === 0 ? 2 : 0;
	}
	const [command, ...args] = argv;
	if (command !== "verify") {
		io.err(USAGE);
		return 2;
	}
	let path: string | undefined;
	const expectations: Expectation[] = [];
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i] as string;
		if (arg === "--expect") {
			const expectation = parseExpectation(args[i + 1]);
			if (expectation === undefined) {
				io.err(`audit: malformed --expect "${args[i + 1] ?? ""}": want <seq>:<64 lowercase hex>`);
				return 2;
			}
			expectations.push(expectation);
			i += 1;
		} else if (arg.startsWith("-") || path !== undefined) {
			io.err(USAGE);
			return 2;
		} else {
			path = arg;
		}
	}
	const stateDir = env.ULTRATHINK_STATE_DIR?.trim() || DEFAULT_STATE_DIR;
	const target = path ?? auditPath(stateDir);
	const result = verifyAuditFile(target);
	if (!result.ok) {
		io.out(`audit BROKEN at record ${result.brokenAt}: ${result.reason}`);
		return 1;
	}
	if (expectations.length > 0) {
		const found = recordHashes(target, expectations.map((e) => e.seq));
		for (const expectation of expectations) {
			const actual = found.get(expectation.seq);
			if (actual !== expectation.hash) {
				io.out(`audit BROKEN: expected record ${expectation.seq} hash ${expectation.hash}, found ${actual ?? "none"}`);
				return 1;
			}
		}
	}
	io.out(`audit ok: ${result.records} records, last ${result.lastHash}`);
	return 0;
}

if (import.meta.main) {
	process.exit(main(process.argv.slice(2)));
}
