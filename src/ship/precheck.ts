// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { defaultRun } from "./run.ts";
import type { Run } from "./types.ts";

/** Local-git-only readiness check: on a non-base branch with commits ahead of origin/<base>. */
export function shipPrecheck(
	cwd: string,
	run: Run = defaultRun,
): { ok: boolean; reason: string; branch?: string; base?: string; ahead: number } {
	const git = (...args: string[]) => run(["git", ...args], { cwd, timeoutMs: 2_000 });
	const head = git("rev-parse", "--abbrev-ref", "HEAD");
	const branch = head.exitCode === 0 ? head.stdout.trim() : "";
	if (!branch) return { ok: false, reason: "not a git repository", ahead: 0 };
	if (branch === "HEAD") return { ok: false, reason: "detached HEAD", ahead: 0 };
	const symbolic = git("symbolic-ref", "--short", "refs/remotes/origin/HEAD");
	let base = symbolic.exitCode === 0 ? symbolic.stdout.trim().replace(/^origin\//, "") : "";
	if (!base) {
		base =
			["master", "main"].find(
				(name) => git("rev-parse", "--verify", "--quiet", `refs/remotes/origin/${name}`).exitCode === 0,
			) ?? "";
	}
	if (!base) return { ok: false, reason: "no origin default branch", branch, ahead: 0 };
	if (branch === base) return { ok: false, reason: `on base branch ${base}`, branch, base, ahead: 0 };
	const count = git("rev-list", "--count", `origin/${base}..HEAD`);
	const ahead = count.exitCode === 0 ? Number.parseInt(count.stdout.trim(), 10) || 0 : 0;
	if (ahead <= 0) return { ok: false, reason: `no commits ahead of origin/${base}`, branch, base, ahead: 0 };
	return { ok: true, reason: `${ahead} commit(s) ahead of origin/${base}`, branch, base, ahead };
}
