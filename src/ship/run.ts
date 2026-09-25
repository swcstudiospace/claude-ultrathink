// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import type { Run } from "./types.ts";

/** Runs argv synchronously; never throws (spawn failure -> exitCode 127). */
export const defaultRun: Run = (argv, opts = {}) => {
	try {
		const proc = Bun.spawnSync(argv, {
			cwd: opts.cwd,
			timeout: opts.timeoutMs ?? 120_000,
			stdin: opts.stdin === undefined ? "ignore" : Buffer.from(opts.stdin),
			stdout: "pipe",
			stderr: "pipe",
		});
		return {
			exitCode: proc.exitCode ?? 1,
			stdout: proc.stdout?.toString() ?? "",
			stderr: proc.stderr?.toString() ?? "",
		};
	} catch (error) {
		return { exitCode: 127, stdout: "", stderr: error instanceof Error ? error.message : String(error) };
	}
};
