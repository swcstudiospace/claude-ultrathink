// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import type { ReviewThread, ReviewThreads } from "./github.ts";
import { defaultRun } from "./run.ts";
import { GREPTILE_MAX_SCORE, type ReviewComment, type ReviewResult, type Run, type ShipConfig } from "./types.ts";

export interface ToolCaller {
	call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
}

export interface GreptileRepo {
	name: string;
	remote: "github" | "gitlab";
	defaultBranch: string;
	remoteUrl?: string;
}

/** A repository as Greptile lists it; `reviewsEnabled` is absent when Greptile does not say. */
export type ListedGreptileRepo = GreptileRepo & { reviewsEnabled?: boolean };

type Obj = Record<string, unknown>;

const asObj = (value: unknown): Obj | undefined =>
	typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Obj) : undefined;
const asStr = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const asNum = (value: unknown): number | undefined =>
	typeof value === "number" && Number.isFinite(value) ? value : undefined;
const asArr = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const SCORE_PATTERN = new RegExp(
	String.raw`confidence\s+score(?:\s*:|\s+of)?\s*(?:<[^>]*>\s*)*(\d+)\s*\/\s*${GREPTILE_MAX_SCORE}\b`,
	"i",
);
/** Greptile renders comment priority as a badge image: `<img alt="P1" ...>`. */
const BADGE_PATTERN = /<img\b[^>]*\balt\s*=\s*["']?(P[0-3])\b/i;

export function parseScore(body: string): number | null {
	const match = SCORE_PATTERN.exec(body.replace(/\*\*/g, ""));
	if (!match) return null;
	const n = Number(match[1]);
	return n >= 0 && n <= GREPTILE_MAX_SCORE ? n : null;
}

function repoArgs(repo: GreptileRepo): Obj {
	const args: Obj = { name: repo.name, remote: repo.remote, defaultBranch: repo.defaultBranch };
	if (repo.remoteUrl) args.remoteUrl = repo.remoteUrl;
	return args;
}

/** `{ organization }` for every Greptile MCP call when ship.greptileOrganization is set; empty lets Greptile pick. */
const orgArgs = (organization: string | undefined): Obj => (organization ? { organization } : {});

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** Organization ids/handles a tenant_required error offers, from a JSON payload or a `candidates: a, b` list. */
function tenantCandidates(message: string): string[] {
	const start = message.indexOf("{");
	const payload = start >= 0 ? parseJson(message.slice(start)) : undefined;
	const listed = payload ? asArr(payload.candidates ?? asObj(payload.error)?.candidates) : [];
	const names = listed
		.map((entry) => asStr(entry) ?? asStr(asObj(entry)?.handle) ?? asStr(asObj(entry)?.id))
		.filter((name): name is string => Boolean(name));
	if (names.length > 0) return names;
	// A truncated JSON payload lands here too: keep only bare ids/handles, never fragments of objects.
	const inline = /candidates["']?\s*[:=]\s*\[?([^\]\n]+)/i.exec(message)?.[1] ?? "";
	return inline
		.split(",")
		.map((name) => name.trim().replace(/^["']|["']$/g, ""))
		.filter((name) => /^[\w.@-]+$/.test(name));
}

/** Actionable reason when Greptile refuses a call because the account spans several organizations and none was chosen. */
export function tenantReason(message: string): string | undefined {
	if (!/tenant_required/i.test(message)) return undefined;
	const candidates = tenantCandidates(message);
	const choose = candidates.length > 0 ? ` (one of: ${candidates.join(", ")})` : "";
	return `Greptile account has several organizations; set ship.greptileOrganization in ~/.config/ultrathink/config.json${choose}`;
}

/** Lookup errors mean "not listed", except tenant_required, which throws the ship.greptileOrganization reason. */
export async function findGreptileRepo(
	client: ToolCaller,
	repo: string,
	organization?: string,
): Promise<ListedGreptileRepo | undefined> {
	const wanted = repo.toLowerCase();
	const limit = 100;
	try {
		for (let page = 0; page < 50; page++) {
			const result = asObj(
				await client.call("list_repositories", { limit, page, nameContains: repo.split("/").pop(), ...orgArgs(organization) }),
			);
			const repos = asArr(result?.repositories);
			for (const entry of repos) {
				const item = asObj(entry);
				const name = asStr(item?.name);
				const remote = asStr(item?.remote);
				const defaultBranch = asStr(item?.defaultBranch);
				if (!item || !name || name.toLowerCase() !== wanted || !defaultBranch) continue;
				if (remote !== "github" && remote !== "gitlab") return undefined;
				const found: ListedGreptileRepo = { name, remote, defaultBranch };
				const remoteUrl = asStr(item.remoteUrl);
				if (remoteUrl) found.remoteUrl = remoteUrl;
				if (typeof item.reviewsEnabled === "boolean") found.reviewsEnabled = item.reviewsEnabled;
				return found;
			}
			const total = asNum(result?.total) ?? 0;
			if (repos.length === 0 || (page + 1) * limit >= total) return undefined;
		}
	} catch (error) {
		const reason = tenantReason(errorText(error));
		if (reason) throw new Error(reason);
		return undefined;
	}
	return undefined;
}

function mapComment(value: unknown): ReviewComment | undefined {
	const item = asObj(value);
	const body = asStr(item?.body);
	if (!item || !body) return undefined;
	const comment: ReviewComment = { body };
	const path = asStr(item.path) ?? asStr(item.filePath) ?? asStr(item.file);
	if (path) comment.path = path;
	const line = asNum(item.line) ?? asNum(item.startLine) ?? asNum(item.lineStart);
	if (line !== undefined) comment.line = line;
	const severity = asStr(item.severity) ?? BADGE_PATTERN.exec(body)?.[1]?.toUpperCase();
	if (severity) comment.severity = severity;
	if (typeof item.securityIssue === "boolean") comment.securityIssue = item.securityIssue;
	return comment;
}

/** Open findings in PR mode: Greptile threads neither resolved nor outdated (a fixing commit outdates its line). */
export const openThreadComments = (threads: ReviewThread[]): ReviewComment[] =>
	threads.flatMap((thread) => {
		const comment = thread.isResolved || thread.isOutdated ? undefined : mapComment(thread);
		return comment ? [{ ...comment, threadId: thread.id }] : [];
	});

function reviewTime(item: Obj): number {
	const stamp = asStr(item.updatedAt) ?? asStr(item.createdAt) ?? "";
	const parsed = Date.parse(stamp);
	return Number.isNaN(parsed) ? 0 : parsed;
}

function reviewSha(item: Obj): string | undefined {
	return asStr(item.commitSha) ?? asStr(asObj(item.commit)?.sha) ?? asStr(item.commit);
}

export async function reviewPr(input: {
	client: ToolCaller;
	repo: GreptileRepo;
	prNumber: number;
	headSha: string;
	timeoutMs: number;
	pollMs: number;
	/** ship.greptileOrganization; "" or undefined omits `organization`. */
	organization?: string;
	/** The PR's review threads on GitHub; without them, or on failure, every unaddressed Greptile comment stays open. */
	reviewThreads?: () => ReviewThreads;
	/** Review ids already recorded as failed or timed out for headSha: ignored, so a fresh review is triggered. */
	staleReviewIds?: string[];
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
}): Promise<ReviewResult> {
	const now = input.now ?? Date.now;
	const sleep = input.sleep ?? Bun.sleep;
	const base = { source: "pr" as const, headSha: input.headSha };
	const done = (fields: Partial<ReviewResult> & Pick<ReviewResult, "status">): ReviewResult => ({
		...base,
		score: null,
		comments: [],
		...fields,
		at: now(),
	});
	// The newest review id seen for headSha; a thrown error below still reports it so the next call resumes that run.
	let pendingId: string | undefined;
	try {
		const org = orgArgs(input.organization);
		const tuple = { ...repoArgs(input.repo), ...org };
		const deadline = now() + input.timeoutMs;
		const stale = new Set<string>(input.staleReviewIds);
		let triggered = false;
		let delay = input.pollMs;
		while (true) {
			const listed = asObj(await input.client.call("list_code_reviews", { ...tuple, prNumber: input.prNumber, limit: 20 }));
			const latest = asArr(listed?.codeReviews)
				.map(asObj)
				.filter(
					(item): item is Obj =>
						item !== undefined && reviewSha(item) === input.headSha && !stale.has(String(item.id)),
				)
				.sort((a, b) => reviewTime(b) - reviewTime(a))[0];
			const status = asStr(latest?.status)?.toUpperCase();
			const failed = status === "FAILED" || status === "ERROR" || status === "SKIPPED";
			const reviewId = latest && (asStr(latest.id) ?? (asNum(latest.id) !== undefined ? String(latest.id) : undefined));
			pendingId = reviewId;
			if (!triggered && (!latest || failed)) {
				// Greptile auto-reviews pushes of indexed repos; trigger only when no live review exists for headSha.
				if (latest) stale.add(String(latest.id));
				await input.client.call("trigger_code_review", { ...tuple, prNumber: input.prNumber });
				triggered = true;
			} else if (failed && status) {
				return done({ status: "failed", reviewId, error: `greptile review ${status.toLowerCase()}` });
			} else if (status === "COMPLETED" && reviewId) {
				const detail = asObj(
					asObj(await input.client.call("get_code_review", { codeReviewId: reviewId, ...org }))?.codeReview,
				);
				const score = parseScore(asStr(detail?.body) ?? "");
				if (score === null) {
					return done({ status: "failed", reviewId, error: "score not found in Greptile review body" });
				}
				// Greptile reviews incrementally and never flips `addressed` on a fix, so GitHub thread state decides.
				// If threads are unavailable, fail closed: every unaddressed Greptile comment on the PR stays open.
				const threads = input.reviewThreads?.();
				const comments = threads?.ok
					? openThreadComments(threads.threads)
					: mapComments(
							asArr(
								asObj(
									await input.client.call("list_merge_request_comments", {
										...tuple,
										prNumber: input.prNumber,
										greptileGenerated: true,
										addressed: false,
									}),
								)?.comments,
							).filter((c) => asObj(c)?.isGreptileComment !== false && asObj(c)?.addressed !== true),
						);
				const url = asStr(asObj(detail?.mergeRequest)?.url);
				return done({ status: "completed", reviewId, score, comments, ...(url ? { url } : {}) });
			}
			const remaining = deadline - now();
			if (remaining <= 0) break;
			await sleep(Math.min(delay, remaining));
			delay = Math.min(delay * 1.5, 60_000);
		}
		// The wait elapsed; the review keeps running server-side and the next call resumes it.
		return done({ status: "pending", reviewId: pendingId });
	} catch (error) {
		const message = errorText(error);
		// Without an organization Greptile refuses every call; retrying cannot help, the user must choose one.
		const reason = tenantReason(message);
		if (reason) return done({ status: "blocked", error: reason });
		// A thrown tool or transport error says nothing about the review itself (Greptile's own FAILED/ERROR status is
		// handled above), so it is pending: the next call retries, and ship.reviewTimeoutMs still bounds the wait.
		return done({ status: "pending", error: message.slice(0, 300), ...(pendingId ? { reviewId: pendingId } : {}) });
	}
}

const parseJson = (text: string): Obj | undefined => {
	try {
		return asObj(JSON.parse(text));
	} catch {
		return undefined;
	}
};
const validScore = (value: unknown): number | undefined => {
	const n = asNum(value);
	return n !== undefined && n >= 0 && n <= GREPTILE_MAX_SCORE ? n : undefined;
};
const mapComments = (value: unknown): ReviewComment[] =>
	asArr(value)
		.map(mapComment)
		.filter((c): c is ReviewComment => c !== undefined);

const CLI_QUERY_TIMEOUT_MS = 30_000;

/**
 * Resumable CLI review of `headSha`: reuses a finished or in-flight `greptile review` run for that commit
 * (`greptile review status --commit`), otherwise starts one. Blocks at most ~waitMs, then reports "pending";
 * a killed `greptile review` keeps running server-side and the next call finds it via status.
 */
export async function reviewCli(input: {
	run: Run;
	cwd: string;
	base: string;
	headSha: string;
	waitMs: number;
	pollMs: number;
	/** Run ids already recorded as failed or timed out for headSha: a status record naming one counts as no review. */
	staleRunIds?: string[];
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
}): Promise<ReviewResult> {
	const now = input.now ?? Date.now;
	const sleep = input.sleep ?? Bun.sleep;
	const { run, cwd } = input;
	const done = (fields: Partial<ReviewResult> & Pick<ReviewResult, "status">): ReviewResult => ({
		source: "cli",
		headSha: input.headSha,
		score: null,
		comments: [],
		...fields,
		at: now(),
	});
	const fail = (error: string, reviewId?: string): ReviewResult =>
		done({ status: "failed", error: error.slice(0, 300), ...(reviewId ? { reviewId } : {}) });
	const complete = (info: Obj): ReviewResult => {
		const runId = asStr(info.runId);
		let detail = info;
		if (!Array.isArray(info.comments)) {
			if (!runId) return fail("greptile review status has neither comments nor runId");
			const shown = run(["greptile", "review", "show", runId, "--json"], { cwd, timeoutMs: CLI_QUERY_TIMEOUT_MS });
			if (shown.exitCode !== 0) return fail(shown.stderr.trim() || `greptile review show exited ${shown.exitCode}`, runId);
			const parsed = parseJson(shown.stdout);
			if (!parsed) return fail("greptile review show returned invalid JSON", runId);
			detail = parsed;
		}
		const score = validScore(info.confidence) ?? validScore(detail.confidence);
		if (score === undefined) return fail("score not found in greptile review", runId);
		return done({ status: "completed", score, comments: mapComments(detail.comments), ...(runId ? { reviewId: runId } : {}) });
	};
	const deadline = now() + input.waitMs;
	let delay = input.pollMs;
	const staleRuns = new Set(input.staleRunIds);
	while (true) {
		const checked = run(["greptile", "review", "status", "--commit", input.headSha, "--json"], {
			cwd,
			timeoutMs: CLI_QUERY_TIMEOUT_MS,
		});
		const info = parseJson(checked.stdout);
		// Records may carry full or abbreviated shas; any sha naming another commit means no review for headSha.
		const matches = [asStr(info?.commit), asStr(info?.headSha)].every(
			(sha) =>
				sha === undefined ||
				sha === input.headSha ||
				(sha.length >= 7 && (input.headSha.startsWith(sha) || sha.startsWith(input.headSha))),
		);
		const staleRun = staleRuns.has(asStr(info?.runId) ?? "");
		const inFlight =
			matches && !staleRun && (checked.exitCode === 3 || asStr(info?.status)?.toUpperCase() === "IN_FLIGHT");
		if (!inFlight) {
			if (info && matches && !staleRun && checked.exitCode === 0) return complete(info);
			break;
		}
		const remaining = deadline - now();
		if (remaining <= 0) {
			const runId = asStr(info?.runId);
			return done({ status: "pending", ...(runId ? { reviewId: runId } : {}) });
		}
		await sleep(Math.min(delay, remaining));
		delay = Math.min(delay * 1.5, 60_000);
	}
	// No review exists for headSha: start one (it reviews local HEAD, which the caller verified equals headSha).
	const remaining = deadline - now();
	if (remaining <= 0) return done({ status: "pending" });
	const startedAt = now();
	const started = run(["greptile", "review", "--json", "-b", input.base], { cwd, timeoutMs: remaining });
	if (started.exitCode !== 0) {
		if (now() - startedAt >= remaining) return done({ status: "pending" });
		return fail(started.stderr.trim() || `greptile exited ${started.exitCode}`);
	}
	const parsed = parseJson(started.stdout);
	if (!parsed) return fail("greptile review returned invalid JSON");
	const runId = asStr(parsed.runId);
	const score = validScore(parsed.confidence);
	if (score === undefined) return fail("score not found in greptile review", runId);
	return done({ status: "completed", score, comments: mapComments(parsed.comments), ...(runId ? { reviewId: runId } : {}) });
}

export const GREPTILE_SETUP =
	"Greptile is not set up: run `bin/ultrathink-mcp auth set-key greptile --stdin` (or `auth login greptile`), or install and sign in to the greptile CLI (`greptile login`)";

/**
 * True only on a definite "not set up" answer: the greptile CLI cannot be spawned, or `greptile whoami` says it is
 * signed out (that exits 0). A timeout or API error is not proof, so the CLI review runs and reports it itself.
 */
function cliNotSetUp(run: Run, cwd: string): boolean {
	const who = run(["greptile", "whoami"], { cwd, timeoutMs: 10_000 });
	const text = `${who.stdout}\n${who.stderr}`;
	return who.exitCode === 127 || /ENOENT/.test(text) || /not signed in|saved sign-in could not be read/i.test(text);
}

export async function runReview(input: {
	config: ShipConfig;
	/** Greptile MCP client; undefined when no Greptile MCP credential is stored. */
	client?: ToolCaller;
	run?: Run;
	cwd: string;
	repo: string;
	base: string;
	prNumber: number;
	headSha: string;
	reviewThreads?: () => ReviewThreads;
	/** reviewIds of rounds for headSha that failed or timed out; those reviews are re-triggered instead of reused. */
	staleReviewIds?: string[];
	now?: () => number;
}): Promise<ReviewResult> {
	const run = input.run ?? defaultRun;
	const organization = input.config.greptileOrganization;
	const blocked = (source: ReviewResult["source"], error: string): ReviewResult => ({
		source,
		status: "blocked",
		score: null,
		comments: [],
		headSha: input.headSha,
		error,
		at: (input.now ?? Date.now)(),
	});
	if (!input.client) {
		if (cliNotSetUp(run, input.cwd)) return blocked("cli", GREPTILE_SETUP);
	} else {
		let found: ListedGreptileRepo | undefined;
		try {
			found = await findGreptileRepo(input.client, input.repo, organization);
		} catch (error) {
			return blocked("pr", errorText(error));
		}
		if (found && found.reviewsEnabled !== false) {
			const { reviewsEnabled: _, ...repo } = found;
			return reviewPr({
				client: input.client,
				repo,
				prNumber: input.prNumber,
				headSha: input.headSha,
				timeoutMs: input.config.waitMs,
				pollMs: input.config.pollMs,
				organization,
				...(input.reviewThreads ? { reviewThreads: input.reviewThreads } : {}),
				...(input.staleReviewIds ? { staleReviewIds: input.staleReviewIds } : {}),
			});
		}
	}
	return reviewCli({
		run,
		cwd: input.cwd,
		base: input.base,
		headSha: input.headSha,
		waitMs: input.config.waitMs,
		pollMs: input.config.pollMs,
		...(input.staleReviewIds ? { staleRunIds: input.staleReviewIds } : {}),
	});
}
