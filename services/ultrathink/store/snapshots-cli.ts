// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

/**
 * Command-line front end for the snapshot policy in snapshots.ts, called by the Phase 74 shell scripts.
 * Snapshot names are read from stdin, one per line. Exit codes: 0 success, 1 no result (pick found nothing),
 * 2 usage or non-numeric argument.
 *
 *   next <nowMs>                                  print the stamp for a new snapshot
 *   pick <targetMs>                               print the newest name at or before the target
 *   plan <nowMs> <recentMs> <thinMs> <windowMs>   print "delete <name>" for each name to remove
 *   stamp <ms>                                    print the stamp for a time
 */

import { formatStamp, nextStamp, pickAtOrBefore, retentionPlan } from "./snapshots.ts";

const USAGE =
	"usage: snapshots-cli.ts next <nowMs> | pick <targetMs> | plan <nowMs> <recentMs> <thinMs> <windowMs> | stamp <ms>  (names on stdin)";

export interface CliResult {
	code: number;
	stdout: string;
	stderr: string;
}

const USAGE_ERROR = (message: string): CliResult => ({ code: 2, stdout: "", stderr: `${message}\n${USAGE}\n` });

function integer(text: string | undefined): number | undefined {
	if (text === undefined || !/^-?\d+$/.test(text)) return undefined;
	const value = Number(text);
	return Number.isSafeInteger(value) ? value : undefined;
}

function namesFrom(stdin: string): string[] {
	return stdin
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
}

export function runCli(argv: readonly string[], stdin: string): CliResult {
	const [command, ...args] = argv;
	try {
		switch (command) {
			case "next": {
				const nowMs = integer(args[0]);
				if (args.length !== 1 || nowMs === undefined) return USAGE_ERROR("next needs one integer <nowMs>");
				return { code: 0, stdout: `${nextStamp(nowMs, namesFrom(stdin))}\n`, stderr: "" };
			}
			case "pick": {
				const targetMs = integer(args[0]);
				if (args.length !== 1 || targetMs === undefined) return USAGE_ERROR("pick needs one integer <targetMs>");
				const name = pickAtOrBefore(namesFrom(stdin), targetMs);
				if (name === undefined) return { code: 1, stdout: "", stderr: "" };
				return { code: 0, stdout: `${name}\n`, stderr: "" };
			}
			case "plan": {
				const [nowMs, recentMs, thinMs, windowMs] = args.map((arg) => integer(arg));
				if (
					args.length !== 4 ||
					nowMs === undefined ||
					recentMs === undefined ||
					thinMs === undefined ||
					windowMs === undefined
				) {
					return USAGE_ERROR("plan needs four integers <nowMs> <recentMs> <thinMs> <windowMs>");
				}
				const plan = retentionPlan(namesFrom(stdin), nowMs, { recentMs, thinMs, windowMs });
				return { code: 0, stdout: plan.delete.map((name) => `delete ${name}\n`).join(""), stderr: "" };
			}
			case "stamp": {
				const ms = integer(args[0]);
				if (args.length !== 1 || ms === undefined) return USAGE_ERROR("stamp needs one integer <ms>");
				return { code: 0, stdout: `${formatStamp(ms)}\n`, stderr: "" };
			}
			default:
				return USAGE_ERROR(`unknown command: ${command ?? "(none)"}`);
		}
	} catch (error) {
		// Policy rejects out-of-range or negative windows with RangeError; that is bad input, not a miss.
		if (error instanceof RangeError) return { code: 2, stdout: "", stderr: `${error.message}\n` };
		throw error;
	}
}

if (import.meta.main) {
	const argv = process.argv.slice(2);
	const stdin = argv[0] === "stamp" ? "" : await Bun.stdin.text();
	const result = runCli(argv, stdin);
	if (result.stdout) process.stdout.write(result.stdout);
	if (result.stderr) process.stderr.write(result.stderr);
	process.exit(result.code);
}
