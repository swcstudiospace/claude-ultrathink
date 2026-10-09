// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { defaultRun } from "./run.ts";
import type { PrRef, PrStatus, Run, ShipConfig } from "./types.ts";

/** A Greptile review thread on the PR, keyed by its first comment. */
export interface ReviewThread {
	id: string;
	isResolved: boolean;
	isOutdated: boolean;
	author: string;
	path?: string;
	line?: number;
	body: string;
}

export type ReviewThreads = { ok: true; threads: ReviewThread[] } | { ok: false; error: string };

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
	/**
	 * The PR's Greptile review threads; fails on any doubt (errors, truncation) so callers can fail closed.
	 * With `opts.deadlineMs` the page scan stops fail-closed once the shared deadline passes instead of
	 * paging past the caller's wait budget; each page keeps its own request timeout.
	 */
	reviewThreads(prNumber: number, opts?: ReviewThreadsOptions): ReviewThreads;
}

/** Bounds a `reviewThreads` page scan: the loop stops fail-closed once `now()` reaches `deadlineMs`. */
export interface ReviewThreadsOptions {
	/** Absolute timestamp on the `now` clock bounding the whole scan; unset scans without a bound. */
	deadlineMs?: number;
	/** Clock for the deadline check; defaults to `Date.now`. Injected in tests. */
	now?: () => number;
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
// GitHub caps `first` at 100, so a larger pull request is read page by page, up to this many pages.
const MAX_THREAD_PAGES = 20;
const PAGINATION_STALLED = "review threads pagination did not advance";
const THREADS_DEADLINE_EXCEEDED = "review threads scan exceeded its deadline";
const THREADS_QUERY = `query($owner: String!, $name: String!, $number: Int!, $after: String) {
	repository(owner: $owner, name: $name) {
		pullRequest(number: $number) {
			reviewThreads(first: 100, after: $after) {
				pageInfo { hasNextPage endCursor }
				nodes { id isResolved isOutdated comments(first: 1) { nodes { author { login } path line originalLine body } } }
			}
		}
	}
}`;

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

type ThreadsPage = { ok: true; threads: ReviewThread[]; next?: string } | { ok: false; error: string };

/** Parses one page of the reviewThreads response; `next` is the cursor of the following page when there is one. */
function parseThreadsPage(stdout: string): ThreadsPage {
	const root = obj(parseJson(stdout));
	if (!root) return { ok: false, error: "unparseable review threads response" };
	const errors = root.errors;
	if (Array.isArray(errors) && errors.length > 0) {
		return { ok: false, error: str(obj(errors[0])?.message)?.slice(0, 300) ?? "graphql error" };
	}
	const threads = obj(obj(obj(obj(root.data)?.repository)?.pullRequest)?.reviewThreads);
	if (!threads || !Array.isArray(threads.nodes)) return { ok: false, error: "pull request review threads missing" };
	const pageInfo = obj(threads.pageInfo);
	const next = pageInfo?.hasNextPage === true ? str(pageInfo.endCursor) : undefined;
	if (pageInfo?.hasNextPage === true && !next) return { ok: false, error: PAGINATION_STALLED };
	const out: ReviewThread[] = [];
	for (const node of threads.nodes) {
		const thread = obj(node);
		const id = str(thread?.id);
		const comments = obj(thread?.comments)?.nodes;
		const first = obj(Array.isArray(comments) ? comments[0] : undefined);
		const author = str(obj(first?.author)?.login);
		const body = str(first?.body);
		if (!thread || !id || !first) return { ok: false, error: "malformed review thread" };
		// The Greptile app posts as `greptile-apps[bot]`; GraphQL reports the login without the suffix.
		if (!author?.toLowerCase().startsWith("greptile")) continue;
		if (!body || typeof thread.isResolved !== "boolean" || typeof thread.isOutdated !== "boolean") {
			return { ok: false, error: "malformed review thread" };
		}
		const entry: ReviewThread = { id, isResolved: thread.isResolved, isOutdated: thread.isOutdated, author, body };
		const path = str(first.path);
		if (path) entry.path = path;
		const line = typeof first.line === "number" ? first.line : first.originalLine;
		if (typeof line === "number") entry.line = line;
		out.push(entry);
	}
	return next ? { ok: true, threads: out, next } : { ok: true, threads: out };
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
		reviewThreads(prNumber, opts = {}) {
			const [owner, name] = gh.repo()?.name.split("/") ?? [];
			if (!owner || !name) return { ok: false, error: "could not resolve GitHub repo" };
			const now = opts.now ?? Date.now;
			const threads: ReviewThread[] = [];
			const seen = new Set<string>();
			let after: string | undefined;
			for (let page = 1; page <= MAX_THREAD_PAGES; page++) {
				// Fail closed once the caller's wait budget is spent: no partial threads, same as other doubts.
				// Each page keeps its own request timeout; this only stops starting another page past the deadline.
				if (opts.deadlineMs !== undefined && now() >= opts.deadlineMs) {
					return { ok: false, error: THREADS_DEADLINE_EXCEEDED };
				}
				const r = exec([
					"gh", "api", "graphql",
					"-f", `query=${THREADS_QUERY}`,
					"-f", `owner=${owner}`,
					"-f", `name=${name}`,
					"-F", `number=${prNumber}`,
					...(after === undefined ? [] : ["-f", `after=${after}`]),
				]);
				if (r.exitCode !== 0) return { ok: false, error: errorOf(r) };
				const parsed = parseThreadsPage(r.stdout);
				if (!parsed.ok) return parsed;
				threads.push(...parsed.threads);
				if (!parsed.next) return { ok: true, threads };
				if (seen.has(parsed.next)) return { ok: false, error: PAGINATION_STALLED };
				seen.add(parsed.next);
				after = parsed.next;
			}
			return { ok: false, error: `more than ${MAX_THREAD_PAGES * 100} review threads` };
		},
	};
	return gh;
}
