// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { defaultRun } from "./run.ts";
import type { PrRef, PrStatus, Run, ShipConfig } from "./types.ts";

export interface Github {
	repo(): { name: string; defaultBranch: string } | undefined;
	push(branch: string): { ok: boolean; error?: string };
	findOpenPr(head: string): PrRef | undefined;
	createPr(input: { base: string; head: string; title: string; body: string }): PrRef | { error: string };
	prStatus(number: number): PrStatus | undefined;
	/** Merges without deleting the branch; ok only once GitHub reports the PR MERGED. */
	merge(input: { number: number; method: ShipConfig["mergeMethod"]; headSha: string }): { ok: boolean; error?: string };
	deleteRemoteBranch(branch: string): { ok: boolean; error?: string };
	comment(number: number, body: string): { ok: boolean; error?: string };
	mergeMethods(): ShipConfig["mergeMethod"][];
	syncBase(input: { base: string; branch: string }): { ok: boolean; error?: string };
}

const LONG_TIMEOUT_MS = 180_000;
const PR_FIELDS = "number,url,headRefName,baseRefName";
const FAILED_CONCLUSIONS: Record<string, true> = {
	FAILURE: true,
	CANCELLED: true,
	TIMED_OUT: true,
	ACTION_REQUIRED: true,
	STARTUP_FAILURE: true,
};
const FAILED_STATES: Record<string, true> = { FAILURE: true, ERROR: true };
const DONE_STATUSES: Record<string, true> = { COMPLETED: true, SUCCESS: true };

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

function obj(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function str(value: unknown): string | undefined {
	return typeof value === "string" && value ? value : undefined;
}

function errorOf(result: { stdout: string; stderr: string; exitCode: number }): string {
	const text = (result.stderr.trim() || result.stdout.trim()).split("\n")[0] ?? "";
	return text.slice(0, 300) || `exit ${result.exitCode}`;
}

function toPrRef(value: unknown): PrRef | undefined {
	const o = obj(value);
	if (!o || typeof o.number !== "number") return undefined;
	const url = str(o.url);
	const head = str(o.headRefName);
	const base = str(o.baseRefName);
	if (!url || !head || !base) return undefined;
	return { number: o.number, url, head, base };
}

export function classifyChecks(rollup: unknown): PrStatus["checks"] {
	if (!Array.isArray(rollup) || rollup.length === 0) return "none";
	let pending = false;
	for (const entry of rollup) {
		const o = obj(entry) ?? {};
		const conclusion = str(o.conclusion)?.toUpperCase();
		const state = str(o.state)?.toUpperCase();
		const status = str(o.status)?.toUpperCase();
		if ((conclusion && FAILED_CONCLUSIONS[conclusion]) || (state && FAILED_STATES[state])) return "failing";
		// CheckRun carries `status`; StatusContext carries `state`.
		const progress = status ?? state;
		if (progress && !DONE_STATUSES[progress]) pending = true;
	}
	return pending ? "pending" : "passing";
}

export function createGithub(input: { cwd: string; run?: Run }): Github {
	const run = input.run ?? defaultRun;
	const cwd = input.cwd;
	const exec = (argv: string[], opts: { timeoutMs?: number; stdin?: string } = {}) => run(argv, { cwd, ...opts });

	const gh: Github = {
		repo() {
			const r = exec(["gh", "repo", "view", "--json", "nameWithOwner,defaultBranchRef"]);
			if (r.exitCode !== 0) return undefined;
			const o = obj(parseJson(r.stdout));
			const name = str(o?.nameWithOwner);
			const defaultBranch = str(obj(o?.defaultBranchRef)?.name);
			return name && defaultBranch ? { name, defaultBranch } : undefined;
		},
		push(branch) {
			const r = exec(["git", "push", "-u", "origin", branch], { timeoutMs: LONG_TIMEOUT_MS });
			return r.exitCode === 0 ? { ok: true } : { ok: false, error: errorOf(r) };
		},
		findOpenPr(head) {
			const r = exec(["gh", "pr", "list", "--head", head, "--state", "open", "--json", PR_FIELDS, "--limit", "1"]);
			if (r.exitCode !== 0) return undefined;
			const list = parseJson(r.stdout);
			return Array.isArray(list) ? toPrRef(list[0]) : undefined;
		},
		createPr({ base, head, title, body }) {
			const created = exec(
				["gh", "pr", "create", "--base", base, "--head", head, "--title", title, "--body-file", "-"],
				{ stdin: body, timeoutMs: LONG_TIMEOUT_MS },
			);
			if (created.exitCode !== 0) return { error: errorOf(created) };
			const url = created.stdout
				.trim()
				.split("\n")
				.reverse()
				.find((line) => line.startsWith("http"));
			if (!url) return { error: "gh pr create printed no PR url" };
			const view = exec(["gh", "pr", "view", url.trim(), "--json", PR_FIELDS]);
			if (view.exitCode !== 0) return { error: errorOf(view) };
			return toPrRef(parseJson(view.stdout)) ?? { error: "could not parse created PR" };
		},
		prStatus(number) {
			const r = exec(["gh", "pr", "view", String(number), "--json", "state,headRefOid,mergeable,statusCheckRollup,url"]);
			if (r.exitCode !== 0) return undefined;
			const o = obj(parseJson(r.stdout));
			const state = str(o?.state);
			const headSha = str(o?.headRefOid);
			const url = str(o?.url);
			if (!o || !headSha || !url || (state !== "OPEN" && state !== "MERGED" && state !== "CLOSED")) return undefined;
			const m = str(o.mergeable);
			const mergeable = m === "MERGEABLE" || m === "CONFLICTING" ? m : "UNKNOWN";
			return { state, headSha, mergeable, checks: classifyChecks(o.statusCheckRollup), url };
		},
		merge({ number, method, headSha }) {
			const r = exec(["gh", "pr", "merge", String(number), `--${method}`, "--match-head-commit", headSha], {
				timeoutMs: LONG_TIMEOUT_MS,
			});
			const state = gh.prStatus(number)?.state;
			if (state === "MERGED") return { ok: true };
			return { ok: false, error: r.exitCode !== 0 ? errorOf(r) : `PR is ${state ?? "unknown"} after merge` };
		},
		deleteRemoteBranch(branch) {
			const r = exec(["git", "push", "origin", "--delete", branch], { timeoutMs: LONG_TIMEOUT_MS });
			if (r.exitCode === 0 || r.stderr.includes("remote ref does not exist")) return { ok: true };
			return { ok: false, error: errorOf(r) };
		},
		comment(number, body) {
			const r = exec(["gh", "pr", "comment", String(number), "--body-file", "-"], { stdin: body });
			return r.exitCode === 0 ? { ok: true } : { ok: false, error: errorOf(r) };
		},
		mergeMethods() {
			const r = exec(["gh", "repo", "view", "--json", "squashMergeAllowed,mergeCommitAllowed,rebaseMergeAllowed"]);
			const o = r.exitCode === 0 ? obj(parseJson(r.stdout)) : undefined;
			if (!o) return [];
			const methods: ShipConfig["mergeMethod"][] = [];
			if (o.squashMergeAllowed === true) methods.push("squash");
			if (o.mergeCommitAllowed === true) methods.push("merge");
			if (o.rebaseMergeAllowed === true) methods.push("rebase");
			return methods;
		},
		syncBase({ base, branch }) {
			const checkout = exec(["git", "checkout", base]);
			if (checkout.exitCode !== 0) return { ok: false, error: errorOf(checkout) };
			const pull = exec(["git", "pull", "--ff-only", "origin", base], { timeoutMs: LONG_TIMEOUT_MS });
			if (pull.exitCode !== 0) return { ok: false, error: errorOf(pull) };
			const current = exec(["git", "rev-parse", "--abbrev-ref", "HEAD"]).stdout.trim();
			const exists = exec(["git", "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]).exitCode === 0;
			if (exists && current !== branch) exec(["git", "branch", "-D", branch]);
			return { ok: true };
		},
	};
	return gh;
}
