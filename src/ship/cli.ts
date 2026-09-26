// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * ultrathink-ship: assess | pr | review | merge | run | status --state <sessions/<id>.json> [--cwd <dir>].
 * Prints one JSON object; always exits 0 except usage errors (2). Fails open.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { ClaudeCompleter } from "../claude/complete.ts";
import type { SessionRecord } from "../claude/state.ts";
import { readControl } from "../claude/state.ts";
import { claudeConfigPaths, loadConfig } from "../config.ts";
import { selectEngine } from "../host/engine.ts";
import { createMcpClientIfCredentialed } from "../mcp/client.ts";
import type { McpClient } from "../mcp/client.ts";
import { storePath } from "../mcp/store.ts";
import { assessDone } from "./assess.ts";
import { createGithub } from "./github.ts";
import type { Github } from "./github.ts";
import { openThreadComments, runReview } from "./greptile.ts";
import type { ToolCaller } from "./greptile.ts";
import { mergeGate, reviewPasses } from "./merge.ts";
import { buildPr } from "./pr-body.ts";
import { defaultRun } from "./run.ts";
import { collectSignals, gatherDiff } from "./signals.ts";
import { appendAttempts, readShip, writeShip } from "./state.ts";
import { GREPTILE_MAX_SCORE } from "./types.ts";
import type { Assessment, PrRef, ReviewComment, ReviewResult, Run, ShipAttempt, ShipConfig, ShipState } from "./types.ts";

export interface ShipDeps {
	config: ShipConfig;
	run: Run;
	now: () => number;
	github: (cwd: string) => Github;
	review: typeof runReview;
	assess: typeof assessDone;
	signals: typeof collectSignals;
	diff: typeof gatherDiff;
	/** Judge completer; undefined when no engine is available. */
	engine: () => Promise<ClaudeCompleter | undefined>;
	greptile: () => ToolCaller | undefined;
	/** Waits between merge polls; tests inject a fake clock. */
	sleep: (ms: number) => Promise<void>;
}

type Output = Record<string, unknown>;
type ShipRecord = SessionRecord & { ship?: ShipState };

const USAGE =
	"usage: ultrathink-ship assess|pr|review|merge|run|status --state <sessions/<id>.json> [--cwd <dir>] [--ignore-gsd]";
const NEXT_FIX = "fix the listed findings, commit only the files you edited, push, then run review again";
const NEXT_PENDING = "Greptile review still running; run review again (safe to repeat, it resumes the same review)";

/** What the agent does when the merge gate refuses for a reason only a new commit can fix. */
const GATE_NEXT: Record<string, string> = {
	"CI checks failing": "CI checks failing: fix CI, commit, push, then run review again",
	"merge conflicts": "merge conflicts: resolve them against the base, push, then run review again",
};
/** Gate reasons that clear on their own; `merge` keeps retrying through them. */
const TRANSIENT_GATE: Record<string, true> = { "CI checks pending": true, "GitHub has not computed mergeability yet": true };
/** GitHub merge errors that clear without a new commit: branch protection awaiting a human (bounded by mergeTimeoutMs) or rate limits. */
const TRANSIENT_MERGE_ERROR = /base branch policy prohibits|rate limit/i;
/** GitHub merge errors no retry or new commit fixes: a human must act. */
const TERMINAL_MERGE_ERROR =
	/approv|review(s)? required|changes requested|permission|forbidden|not authori[sz]ed|pull request is closed|PR is CLOSED/i;
/** GitHub merge errors the agent fixes with a new commit and review. */
const AGENT_MERGE_ERROR = /conflict|not mergeable|out of date|behind|update the branch|head branch was modified|head commit/i;
const MAX_POLL_MS = 60_000;
const MERGED_OUTSIDE = "PR was merged outside the ship flow before its review passed";

/** Next step when the review passed but the PR itself is not mergeable yet. */
function prWaitNext(reason: string): string {
	const next = GATE_NEXT[reason];
	return next ? `review passed; ${next}` : `review passed; ${reason}: wait, then run merge again`;
}

const isFailedReview = (round: ReviewResult) => round.status === "failed" || round.status === "timeout";

/** Rounds counted toward ship.maxRounds: completed reviews that did not pass. Failed or timed-out reviews never count. */
function countFailedRounds(config: ShipConfig, rounds: ReviewResult[]): number {
	return rounds.filter((round) => round.status === "completed" && !reviewPasses(config, round)).length;
}

/** Minutes with one decimal, for messages. */
const minutes = (ms: number) => String(Math.round(ms / 6000) / 10);

/** One attempt as a PR-comment list line: `- <ISO time> <step> <sha7> <outcome>[ <score>/5][ — <detail>]`. */
function formatAttempt(attempt: ShipAttempt): string {
	const at = Number.isFinite(attempt.at) ? new Date(attempt.at).toISOString() : String(attempt.at);
	const score = typeof attempt.score === "number" ? ` ${attempt.score}/${GREPTILE_MAX_SCORE}` : "";
	const detail = attempt.detail ? ` — ${attempt.detail}` : "";
	return `- ${at} ${attempt.step} ${attempt.headSha.slice(0, 7)} ${attempt.outcome}${score}${detail}`;
}

/** The one PR comment posted when the ship stops; shared by review and merge. */
function stoppedComment(input: {
	reason: string;
	score: number | null | undefined;
	failedRounds: number;
	findings: ReviewComment[];
	attempts: ShipAttempt[];
}): string {
	const findings = input.findings
		.slice(0, 20)
		.map((c) => `- ${c.path ?? "?"}${c.line ? `:${c.line}` : ""} ${c.severity ?? ""} ${c.body.split("\n")[0]}`.replace(/ +/g, " "));
	const attempts = input.attempts.slice(-10).map(formatAttempt);
	return [
		`**ultrathink-ship stopped:** ${input.reason}`,
		`Greptile score: ${input.score ?? "n/a"}/${GREPTILE_MAX_SCORE} after ${input.failedRounds} failed round(s).`,
		...(findings.length ? ["Remaining findings:", ...findings] : []),
		...(attempts.length ? ["Attempts:", ...attempts] : []),
		"Left open for human follow-up.",
	].join("\n");
}

function readRecord(statePath: string): ShipRecord | undefined {
	try {
		return JSON.parse(readFileSync(statePath, "utf8")) as ShipRecord;
	} catch {
		return undefined;
	}
}

interface Ctx {
	deps: ShipDeps;
	statePath: string;
	cwd: string;
	/** Leave the repository's GSD roadmap out of the done assessment; the operator decided it is separate work. */
	ignoreGsd: boolean;
}

async function stepAssess(ctx: Ctx): Promise<Output & { done: boolean }> {
	const { deps, statePath, cwd } = ctx;
	const record = readRecord(statePath);
	if (!record) return { ok: false, done: false, reason: "state file missing or unreadable" };
	const probed = deps.signals({ cwd, record, run: deps.run });
	const signals = ctx.ignoreGsd ? { ...probed, gsd: undefined, gsdIgnored: true } : probed;
	const diff = signals.git.base ? deps.diff({ cwd, base: signals.git.base, run: deps.run }) : { stat: "", log: "" };
	const complete = await deps.engine();
	let assessment: Assessment = await deps.assess({ record, signals, diff, complete, now: deps.now });
	if (deps.config.autoMerge && assessment.source === "rules" && assessment.done) {
		assessment = { ...assessment, done: false, gaps: [...assessment.gaps, "no judge available"] };
	}
	const pr = record.ship?.pr;
	writeShip(statePath, { assessment, phase: assessment.done && pr ? "pr-open" : "not-done" }, deps.now());
	const { done, confidence, summary, gaps } = assessment;
	return { ok: true, done, confidence, summary, gaps, signals };
}

async function stepPr(ctx: Ctx): Promise<Output & { ok: boolean }> {
	const { deps, statePath, cwd } = ctx;
	const record = readRecord(statePath);
	const assessment = record?.ship?.assessment;
	if (!record || !assessment?.done) return { ok: false, reason: "task not assessed as done; run assess first" };
	const { git } = deps.signals({ cwd, record, run: deps.run });
	if (!git.branch) return { ok: false, reason: "no current branch (detached HEAD?)" };
	if (assessment.signals.git.branch !== git.branch) {
		return { ok: false, reason: `branch changed since assessment (${assessment.signals.git.branch ?? "none"} -> ${git.branch}); run assess again` };
	}
	if (git.onBase) return { ok: false, reason: `on base branch ${git.base ?? ""}; work must be on a feature branch` };
	if (git.dirty.length > 0) return { ok: false, reason: `uncommitted tracked changes: ${git.dirty.join(", ")}` };
	const github = deps.github(cwd);
	const base = github.repo()?.defaultBranch ?? git.base;
	if (!base) return { ok: false, reason: "could not determine default branch" };
	const pushed = github.push(git.branch);
	if (!pushed.ok) return { ok: false, reason: `push failed: ${pushed.error ?? "unknown"}` };
	let pr: PrRef | undefined = github.findOpenPr(git.branch);
	const reused = pr !== undefined;
	if (!pr) {
		const created = github.createPr({ base, head: git.branch, ...buildPr(record, assessment) });
		if ("error" in created) return { ok: false, reason: `create PR failed: ${created.error}` };
		pr = created;
	}
	pr = { ...pr, head: git.branch };
	writeShip(statePath, { pr, phase: "pr-open" }, deps.now());
	return { ok: true, pr, reused };
}

async function stepReview(ctx: Ctx): Promise<Output & { ready: boolean }> {
	const { deps, statePath, cwd } = ctx;
	const ship = readShip(statePath);
	const pr = ship?.pr;
	if (!pr) return { ok: false, ready: false, reason: "no PR; run pr first" };
	const github = deps.github(cwd);
	const status = github.prStatus(pr.number);
	if (!status) return { ok: false, ready: false, reason: "could not read PR status" };
	const repo = github.repo()?.name;
	if (!repo) return { ok: false, ready: false, reason: "could not resolve GitHub repo" };
	const prior = ship.rounds.at(-1);
	const reusedRound = prior?.status === "completed" && prior.headSha === status.headSha;
	if (!reusedRound) {
		// CLI mode reviews local HEAD and the gate records the PR head: they must be the same commit.
		const local = deps.run(["git", "rev-parse", "HEAD"], { cwd });
		const head = local.exitCode === 0 ? local.stdout.trim() : "";
		if (head !== status.headSha) {
			return {
				ok: false,
				ready: false,
				reason: `local HEAD ${head.slice(0, 7) || "unknown"} differs from PR head ${status.headSha.slice(0, 7)}; push your commits (or pull) first`,
				next: "git push, then run review again",
			};
		}
	}
	// Reviews of this head that failed or timed out are never resumed: the next call triggers a fresh one.
	const staleReviewIds = ship.rounds.flatMap((round) =>
		isFailedReview(round) && round.headSha === status.headSha && round.reviewId ? [round.reviewId] : [],
	);
	let result: ReviewResult = reusedRound
		? prior
		: await deps.review({
				config: deps.config,
				client: deps.greptile(),
				run: deps.run,
				cwd,
				repo,
				base: pr.base,
				prNumber: pr.number,
				headSha: status.headSha,
				reviewThreads: () => github.reviewThreads(pr.number),
				staleReviewIds,
			});
	if (reusedRound && result.source === "pr") {
		// Threads resolved since the round (non-actionable findings) close without a new commit. A failed refresh must not
		// fall back to the stored snapshot: a finding posted since then would be missed, so report not ready and persist nothing.
		const threads = github.reviewThreads(pr.number);
		if (!threads.ok) {
			return { ok: false, ready: false, reason: `could not read review threads: ${threads.error}`, next: "run review again" };
		}
		result = { ...result, comments: openThreadComments(threads.threads) };
	}
	if (result.status === "blocked") {
		// Greptile is unusable as configured: no round is recorded and the flow stops until the user fixes the setup.
		const reason = result.error ?? "Greptile review blocked";
		writeShip(statePath, { phase: "blocked", blockedReason: reason, pending: undefined }, deps.now());
		return { ok: false, ready: false, blocked: true, status: "blocked", reason, round: ship.rounds.length, next: `stop: ${reason}` };
	}
	const maxRounds = deps.config.maxRounds;
	if (result.status === "pending") {
		const same = ship.pending?.headSha === status.headSha ? ship.pending : undefined;
		const since = same?.since ?? deps.now();
		if (deps.now() - since <= deps.config.reviewTimeoutMs) {
			const runId = result.reviewId ?? same?.runId;
			const pending = { headSha: status.headSha, source: result.source, since, ...(runId ? { runId } : {}) };
			writeShip(statePath, { pending }, deps.now());
			const error = result.error ? { error: result.error } : {};
			return { ok: true, ready: false, status: "pending", pending, round: ship.rounds.length, maxRounds, next: NEXT_PENDING, ...error };
		}
		const cause = result.error ? ` (last error: ${result.error})` : "";
		const runId = result.reviewId ?? same?.runId;
		result = {
			...result,
			status: "timeout",
			error: `review still pending after ${deps.config.reviewTimeoutMs}ms${cause}`,
			...(runId ? { reviewId: runId } : {}),
		};
	}
	const now = deps.now();
	const rounds: ReviewResult[] = reusedRound ? [...ship.rounds.slice(0, -1), result] : [...ship.rounds, result];
	const gate = mergeGate({ config: deps.config, status, latest: result });
	const failedRounds = countFailedRounds(deps.config, rounds);
	const passed = reviewPasses(deps.config, result);
	// A failed or timed-out review is re-triggered up to reviewRetries times per head; `used` includes this one.
	const failure = isFailedReview(result) ? (result.status === "timeout" ? "timed out" : "failed") : undefined;
	const used = failure ? ship.rounds.filter((round) => isFailedReview(round) && round.headSha === status.headSha).length + 1 : 0;
	const retries = deps.config.reviewRetries;
	const errorSuffix = result.error ? `: ${result.error}` : "";
	// A PR merged outside the flow is ready only for cleanup, and only when its review passed.
	const mergedPassing = status.state === "MERGED" && passed;
	const waiting = !gate.ok && status.state === "OPEN" && result.headSha === status.headSha && passed;
	const blockedReason =
		gate.ok || waiting || mergedPassing
			? undefined
			: status.state === "MERGED"
				? MERGED_OUTSIDE
				: status.state === "CLOSED"
					? "PR closed without merge"
					: failure
						? used > retries
							? `Greptile review ${failure} ${used} times on ${status.headSha.slice(0, 7)} (ship.reviewRetries ${retries})${errorSuffix}`
							: undefined
						: failedRounds >= maxRounds
							? `max rounds reached: ${gate.reason}`
							: undefined;
	const phase = gate.ok || mergedPassing ? "ready" : waiting ? "pr-open" : blockedReason ? "blocked" : "needs-fixes";
	let attempts = ship.attempts ?? [];
	if (!reusedRound) {
		const attempt: ShipAttempt = {
			at: now,
			step: "review",
			headSha: status.headSha,
			outcome: result.status === "failed" || result.status === "timeout" ? result.status : passed ? "passed" : "needs-fixes",
			score: result.score,
			detail: result.error ?? gate.reason,
		};
		attempts = appendAttempts(statePath, [attempt], now)?.attempts ?? [...attempts, attempt];
	}
	let commented: boolean | undefined;
	if (blockedReason && status.state === "OPEN" && !reusedRound && ship.phase !== "blocked") {
		const body = stoppedComment({ reason: blockedReason, score: result.score, failedRounds, findings: result.comments, attempts });
		commented = github.comment(pr.number, body).ok;
	}
	writeShip(statePath, { rounds, phase, blockedReason, pending: undefined }, now);
	const next = gate.ok
		? "run merge"
		: mergedPassing
			? "PR already merged: run merge to finish the cleanup"
			: waiting
				? prWaitNext(gate.reason)
				: blockedReason
					? `stop: ${blockedReason}`
					: failure
						? `Greptile review ${failure}${errorSuffix}; run review again to re-trigger it (retry ${used} of ${retries})`
						: NEXT_FIX;
	return {
		ok: true,
		ready: gate.ok || mergedPassing,
		passed,
		blocked: blockedReason !== undefined,
		reused: reusedRound,
		status: result.status,
		score: result.score,
		comments: result.comments,
		gate,
		round: rounds.length,
		failedRounds,
		maxRounds,
		next,
		...(commented === undefined ? {} : { commented }),
	};
}

/** One merge poll's outcome. */
type MergeStep =
	| { kind: "merged"; headSha: string; score: number | null | undefined; method: ShipConfig["mergeMethod"]; alreadyMerged: boolean }
	/** Clears on its own: poll again. `retry` marks a failed GitHub merge call. */
	| { kind: "transient"; reason: string; headSha?: string; retry?: boolean }
	/** Only a new commit and review fix it: back to the agent. */
	| { kind: "needs-agent"; reason: string; next: string; headSha: string }
	/** A human must act; `comment` posts the stopped comment (open PRs only). */
	| { kind: "blocked"; reason: string; headSha: string; comment: boolean };

/** A merge-gate refusal after the review passed: pending CI and mergeability are retried, the rest go back to the agent. */
function classifyGateReason(reason: string, headSha: string): MergeStep {
	if (TRANSIENT_GATE[reason] === true) return { kind: "transient", reason, headSha };
	return { kind: "needs-agent", reason, next: GATE_NEXT[reason] ?? `${reason}; run review again`, headSha };
}

/** A failed GitHub merge: refused for good (a human must act), fixable by the agent with a new commit, or retried. */
function classifyMergeError(error: string, headSha: string): MergeStep {
	const transient = { kind: "transient", reason: `merge failed: ${error}`, headSha, retry: true } as const;
	if (TRANSIENT_MERGE_ERROR.test(error)) return transient;
	if (TERMINAL_MERGE_ERROR.test(error)) return { kind: "blocked", reason: `merge refused by GitHub: ${error}`, headSha, comment: true };
	if (AGENT_MERGE_ERROR.test(error)) return { kind: "needs-agent", reason: error, next: `${error}; run review again`, headSha };
	return transient;
}

/** One merge poll: re-reads the PR and merges only when the latest review passed for its exact head commit. */
function mergeOnce(config: ShipConfig, github: Github, ship: ShipState, pr: PrRef): MergeStep {
	const status = github.prStatus(pr.number);
	if (!status) return { kind: "transient", reason: "could not read PR status" };
	const headSha = status.headSha;
	if (status.state === "CLOSED") return { kind: "blocked", reason: "PR closed without merge", headSha, comment: false };
	let latest = ship.rounds.at(-1);
	if (status.state === "MERGED") {
		// Cleanup only for a merge this flow made or one whose exact head passed review; anything else is reported, never recorded.
		if (ship.phase === "merged" || (latest?.headSha === headSha && reviewPasses(config, latest))) {
			return { kind: "merged", headSha, score: latest?.score, method: config.mergeMethod, alreadyMerged: true };
		}
		return { kind: "blocked", reason: MERGED_OUTSIDE, headSha, comment: false };
	}
	if (!latest) {
		const reason = "no review has run";
		return { kind: "needs-agent", reason, next: `${reason}; run review again`, headSha };
	}
	if (latest.headSha !== headSha) {
		const reason = "PR head changed since last review";
		return { kind: "needs-agent", reason, next: `${reason}; run review again`, headSha };
	}
	if (latest.source === "pr") {
		// Merge on the PR's current threads, never on the stored snapshot; an unreadable thread list refuses this poll.
		const threads = github.reviewThreads(pr.number);
		if (!threads.ok) return { kind: "transient", reason: `could not read review threads: ${threads.error}`, headSha };
		latest = { ...latest, comments: openThreadComments(threads.threads) };
	}
	const gate = mergeGate({ config, status, latest });
	if (!reviewPasses(config, latest)) return { kind: "needs-agent", reason: gate.reason, next: `${gate.reason}; run review again`, headSha };
	if (!gate.ok) return classifyGateReason(gate.reason, headSha);
	const allowed = github.mergeMethods();
	const method = allowed.length > 0 && !allowed.includes(config.mergeMethod) ? (allowed[0] ?? config.mergeMethod) : config.mergeMethod;
	const merged = github.merge({ number: pr.number, method, headSha });
	if (merged.ok) return { kind: "merged", headSha, score: latest.score, method, alreadyMerged: false };
	return classifyMergeError(merged.error ?? "unknown", headSha);
}

/** Stops the ship: phase blocked, a "blocked" attempt, and on an open PR the stopped comment once. */
function blockMerge(
	ctx: Ctx,
	github: Github,
	ship: ShipState,
	pr: PrRef,
	block: { reason: string; headSha: string; comment: boolean },
	now: number,
): Output & { ok: boolean } {
	const { deps, statePath } = ctx;
	const attempt: ShipAttempt = { at: now, step: "merge", headSha: block.headSha, outcome: "blocked", detail: block.reason };
	const attempts = appendAttempts(statePath, [attempt], now)?.attempts ?? [...(ship.attempts ?? []), attempt];
	let commented: boolean | undefined;
	if (block.comment && ship.phase !== "blocked") {
		const body = stoppedComment({
			reason: block.reason,
			score: ship.rounds.at(-1)?.score,
			failedRounds: countFailedRounds(deps.config, ship.rounds),
			findings: [],
			attempts,
		});
		commented = github.comment(pr.number, body).ok;
	}
	// A later merge of this head (after a new review) starts a fresh bound instead of blocking again at once.
	writeShip(statePath, { phase: "blocked", blockedReason: block.reason, waiting: undefined }, now);
	return {
		ok: false,
		merged: false,
		blocked: true,
		reason: block.reason,
		next: `stop: ${block.reason}`,
		...(commented === undefined ? {} : { commented }),
	};
}

/** After the merge (by this flow or already on GitHub): branch cleanup, phase merged, a "merged" attempt. */
function finishMerge(
	ctx: Ctx,
	github: Github,
	ship: ShipState,
	pr: PrRef,
	merged: Extract<MergeStep, { kind: "merged" }>,
	now: number,
): Output & { ok: boolean } {
	const { deps, statePath } = ctx;
	const cleanup: Output = {};
	if (deps.config.deleteBranch) {
		const deleted = github.deleteRemoteBranch(pr.head);
		const synced = github.syncBase({ base: pr.base, branch: pr.head });
		Object.assign(cleanup, { remoteDeleted: deleted.ok, synced: synced.ok });
		if (deleted.error) cleanup.deleteError = deleted.error;
		if (synced.error) cleanup.syncError = synced.error;
	}
	const detail = merged.alreadyMerged ? { detail: "PR already merged" } : {};
	appendAttempts(statePath, [{ at: now, step: "merge", headSha: merged.headSha, outcome: "merged", score: merged.score, ...detail }], now);
	writeShip(statePath, { phase: "merged", mergedAt: ship.mergedAt ?? now, waiting: undefined }, now);
	const { method } = merged;
	return {
		ok: true,
		merged: true,
		alreadyMerged: merged.alreadyMerged,
		pr,
		method,
		...(method !== deps.config.mergeMethod ? { methodSubstituted: `${deps.config.mergeMethod} not allowed; used ${method}` } : {}),
		...cleanup,
		next: "run ultrathink-sync",
	};
}

/**
 * Merges once the latest review passed for the PR's exact head, retrying transient refusals (pending CI, uncomputed
 * mergeability, unreadable PR state, transient GitHub errors) within `budgetMs`, and blocking after
 * `ship.mergeTimeoutMs` on one head commit.
 */
async function stepMerge(ctx: Ctx, budgetMs: number = ctx.deps.config.waitMs): Promise<Output & { ok: boolean }> {
	const { deps, statePath, cwd } = ctx;
	const { config } = deps;
	if (!config.autoMerge) return { ok: false, merged: false, reason: "autoMerge disabled" };
	const ship = readShip(statePath);
	const pr = ship?.pr;
	if (!pr) return { ok: false, merged: false, reason: "no PR; run pr first" };
	const github = deps.github(cwd);
	const started = deps.now();
	let waiting = ship.waiting;
	let delay = config.pollMs;
	for (let polls = 1; ; polls++) {
		const step = mergeOnce(config, github, ship, pr);
		const now = deps.now();
		if (step.kind === "merged") return finishMerge(ctx, github, ship, pr, step, now);
		if (step.kind === "blocked") return blockMerge(ctx, github, ship, pr, step, now);
		if (step.kind === "needs-agent") {
			appendAttempts(statePath, [{ at: now, step: "merge", headSha: step.headSha, outcome: "needs-agent", detail: step.reason }], now);
			return { ok: false, merged: false, reason: step.reason, next: step.next };
		}
		// An unreadable PR status has no head: count against the reviewed head, never a stale persisted `waiting` head.
		const headSha = step.headSha ?? ship.rounds.at(-1)?.headSha ?? waiting?.headSha ?? "";
		if (step.retry) appendAttempts(statePath, [{ at: now, step: "merge", headSha, outcome: "retry", detail: step.reason }], now);
		if (waiting?.headSha !== headSha) {
			waiting = { headSha, since: now };
			writeShip(statePath, { waiting }, now);
		}
		const waitedMs = now - waiting.since;
		if (waitedMs >= config.mergeTimeoutMs) {
			const reason = `merge still not possible after ${minutes(waitedMs)} min on ${headSha.slice(0, 7)}: ${step.reason}`;
			return blockMerge(ctx, github, ship, pr, { reason, headSha, comment: true }, now);
		}
		const remaining = budgetMs - (now - started);
		if (remaining <= 0) {
			const detail = `${step.reason} (${polls} poll(s))`;
			appendAttempts(statePath, [{ at: now, step: "merge", headSha, outcome: "waiting", detail }], now);
			const progress = `waited ${minutes(waitedMs)} of ${minutes(config.mergeTimeoutMs)} min on this commit`;
			return {
				ok: false,
				merged: false,
				waiting: true,
				reason: step.reason,
				polls,
				waitedMs,
				next: `run merge again: ${step.reason} (${progress}; it keeps retrying until the PR merges)`,
			};
		}
		await deps.sleep(Math.min(delay, remaining));
		delay = Math.min(delay * 1.5, MAX_POLL_MS);
	}
}

async function stepRun(ctx: Ctx): Promise<Output> {
	const { config } = ctx.deps;
	const started = ctx.deps.now();
	const assess = await stepAssess(ctx);
	if (!assess.done) return { ok: true, assess, next: "task not done: finish the listed gaps, then run again" };
	const pr = await stepPr(ctx);
	if (!pr.ok) return { ok: false, assess, pr, next: `stop: ${String(pr.reason)}` };
	const review = await stepReview(ctx);
	// A passed review merges now, or waits on the PR (CI, mergeability) inside the merge loop; blocked means closed.
	const passed = review.ready || (review.passed === true && review.blocked !== true);
	if (!passed || !config.autoMerge) {
		const next = review.ready ? "autoMerge disabled: merge manually" : (review.next ?? `stop: ${String(review.reason)}`);
		return { ok: review.ok !== false && review.blocked !== true, assess, pr, review, next };
	}
	const merge = await stepMerge(ctx, Math.max(0, config.waitMs - (ctx.deps.now() - started)));
	const next = merge.ok ? "run ultrathink-sync" : String(merge.next ?? `stop: ${String(merge.reason)}`);
	return { ok: merge.ok, assess, pr, review, merge, next };
}

export async function runShip(argv: string[], deps: ShipDeps): Promise<{ code: number; output: Output }> {
	const [command, ...rest] = argv;
	let state: string | undefined;
	let cwd = process.cwd();
	let ignoreGsd = false;
	for (let i = 0; i < rest.length; i++) {
		if (rest[i] === "--state") state = rest[++i];
		else if (rest[i] === "--cwd") cwd = rest[++i] ?? cwd;
		else if (rest[i] === "--ignore-gsd") ignoreGsd = true;
		else return { code: 2, output: { ok: false, error: `unknown argument ${rest[i]}`, usage: USAGE } };
	}
	if (!state) return { code: 2, output: { ok: false, error: "--state is required", usage: USAGE } };
	const ctx: Ctx = { deps, statePath: resolve(state), cwd: resolve(cwd), ignoreGsd };
	try {
		switch (command) {
			case "assess":
				return { code: 0, output: await stepAssess(ctx) };
			case "pr":
				return { code: 0, output: await stepPr(ctx) };
			case "review":
				return { code: 0, output: await stepReview(ctx) };
			case "merge":
				return { code: 0, output: await stepMerge(ctx) };
			case "run":
				return { code: 0, output: await stepRun(ctx) };
			case "status": {
				const ship = readShip(ctx.statePath);
				return { code: 0, output: ship ? { ok: true, ship } : { ok: false, reason: "no ship state" } };
			}
			default:
				return { code: 2, output: { ok: false, error: `unknown command ${command ?? ""}`, usage: USAGE } };
		}
	} catch (error) {
		return { code: 0, output: { ok: false, error: error instanceof Error ? error.message : String(error) } };
	}
}

async function main(): Promise<number> {
	const argv = process.argv.slice(2);
	const cwdIndex = argv.indexOf("--cwd");
	const cwd = resolve(cwdIndex >= 0 ? (argv[cwdIndex + 1] ?? process.cwd()) : process.cwd());
	const stateIndex = argv.indexOf("--state");
	const config = loadConfig(claudeConfigPaths(cwd));
	let client: McpClient | undefined;
	const deps: ShipDeps = {
		config: config.ship,
		run: defaultRun,
		now: Date.now,
		github: (dir) => createGithub({ cwd: dir, run: defaultRun }),
		review: runReview,
		assess: assessDone,
		signals: collectSignals,
		diff: gatherDiff,
		engine: async () => {
			const stateFile = stateIndex >= 0 ? argv[stateIndex + 1] : undefined;
			if (!stateFile) return undefined;
			// state file lives at <stateDir>/sessions/<id>.json
			const selected = await selectEngine(config, readControl(dirname(dirname(resolve(stateFile)))), cwd);
			return "skipped" in selected ? undefined : selected.complete;
		},
		greptile: () => {
			// No stored Greptile credential means no MCP mode; review then needs a signed-in greptile CLI.
			client ??= createMcpClientIfCredentialed("greptile", { storePath: storePath() });
			return client;
		},
		sleep: Bun.sleep,
	};
	const { code, output } = await runShip(argv, deps);
	client?.close();
	process.stdout.write(`${JSON.stringify(output)}\n`);
	return code;
}

if (import.meta.main) {
	process.exit(await main());
}
