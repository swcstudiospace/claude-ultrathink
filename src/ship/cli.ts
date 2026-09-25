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
import { createMcpClient } from "../mcp/client.ts";
import type { McpClient } from "../mcp/client.ts";
import { storePath } from "../mcp/store.ts";
import { assessDone } from "./assess.ts";
import { createGithub } from "./github.ts";
import type { Github } from "./github.ts";
import { openThreadComments, runReview } from "./greptile.ts";
import type { ToolCaller } from "./greptile.ts";
import { mergeGate } from "./merge.ts";
import { buildPr } from "./pr-body.ts";
import { defaultRun } from "./run.ts";
import { collectSignals, gatherDiff } from "./signals.ts";
import { readShip, writeShip } from "./state.ts";
import type { Assessment, PrRef, ReviewResult, Run, ShipConfig, ShipState } from "./types.ts";

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
}

type Output = Record<string, unknown>;
type ShipRecord = SessionRecord & { ship?: ShipState };

const USAGE =
	"usage: ultrathink-ship assess|pr|review|merge|run|status --state <sessions/<id>.json> [--cwd <dir>] [--ignore-gsd]";
const NEXT_FIX = "fix the listed findings, commit only the files you edited, push, then run review again";
const NEXT_PENDING = "Greptile review still running; run review again (safe to repeat, it resumes the same review)";

/** Next step when the review passed but the PR itself is not mergeable yet. */
function prWaitNext(reason: string): string {
	if (reason === "CI checks failing") return "review passed; CI checks failing: fix CI, commit, push, then run review again";
	if (reason === "merge conflicts") return "review passed; merge conflicts: resolve them against the base, push, then run review again";
	return `review passed; ${reason}: wait, then run merge again`;
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
	const maxRounds = deps.config.maxRounds;
	if (result.status === "pending") {
		const same = ship.pending?.headSha === status.headSha ? ship.pending : undefined;
		const since = same?.since ?? deps.now();
		if (deps.now() - since <= deps.config.reviewTimeoutMs) {
			const runId = result.reviewId ?? same?.runId;
			const pending = { headSha: status.headSha, source: result.source, since, ...(runId ? { runId } : {}) };
			writeShip(statePath, { pending }, deps.now());
			return { ok: true, ready: false, status: "pending", pending, round: ship.rounds.length, maxRounds, next: NEXT_PENDING };
		}
		result = { ...result, status: "timeout", error: `review still pending after ${deps.config.reviewTimeoutMs}ms` };
	}
	const rounds: ReviewResult[] = reusedRound ? [...ship.rounds.slice(0, -1), result] : [...ship.rounds, result];
	const gate = mergeGate({ config: deps.config, status, latest: result });
	const failedTwice =
		result.status !== "completed" && prior !== undefined && prior.status !== "completed" && prior.headSha === result.headSha;
	// A passing review whose PR is still waiting on CI, mergeability or conflicts is not a failed round: it never counts
	// toward maxRounds and never blocks the ship.
	const reviewPassed = mergeGate({
		config: deps.config,
		status: { ...status, state: "OPEN", mergeable: "MERGEABLE", checks: "passing" },
		latest: result,
	}).ok;
	const waiting = !gate.ok && reviewPassed;
	const blockedReason =
		gate.ok || waiting
			? undefined
			: failedTwice
				? `review ${result.status} twice for ${status.headSha}: ${result.error ?? gate.reason}`
				: rounds.length >= maxRounds
					? `max rounds reached: ${gate.reason}`
					: undefined;
	const phase = gate.ok ? "ready" : waiting ? "pr-open" : blockedReason ? "blocked" : "needs-fixes";
	let commented: boolean | undefined;
	if (blockedReason && !reusedRound && ship.phase !== "blocked") {
		const findings = result.comments
			.slice(0, 20)
			.map((c) => `- ${c.path ?? "?"}${c.line ? `:${c.line}` : ""} ${c.severity ?? ""} ${c.body.split("\n")[0]}`.replace(/ +/g, " "));
		const body = [
			`**ultrathink-ship stopped:** ${blockedReason}`,
			`Greptile score: ${result.score ?? "n/a"}/5 after ${rounds.length} round(s).`,
			...(findings.length ? ["Remaining findings:", ...findings] : []),
			"Left open for human follow-up.",
		].join("\n");
		commented = github.comment(pr.number, body).ok;
	}
	writeShip(statePath, { rounds, phase, blockedReason, pending: undefined }, deps.now());
	const next = gate.ok
		? "run merge"
		: waiting
			? prWaitNext(gate.reason)
			: blockedReason
				? `stop: ${blockedReason}`
				: NEXT_FIX;
	return {
		ok: true,
		ready: gate.ok,
		reused: reusedRound,
		status: result.status,
		score: result.score,
		comments: result.comments,
		gate,
		round: rounds.length,
		maxRounds,
		next,
		...(commented === undefined ? {} : { commented }),
	};
}

async function stepMerge(ctx: Ctx): Promise<Output & { ok: boolean }> {
	const { deps, statePath, cwd } = ctx;
	if (!deps.config.autoMerge) return { ok: false, merged: false, reason: "autoMerge disabled" };
	const ship = readShip(statePath);
	const pr = ship?.pr;
	if (!pr) return { ok: false, merged: false, reason: "no PR; run pr first" };
	const github = deps.github(cwd);
	const status = github.prStatus(pr.number);
	if (!status) return { ok: false, merged: false, reason: "could not read PR status" };
	if (status.state === "CLOSED") {
		writeShip(statePath, { phase: "blocked", blockedReason: "PR closed without merge" }, deps.now());
		return { ok: false, merged: false, reason: "PR closed without merge" };
	}
	let method = deps.config.mergeMethod;
	if (status.state !== "MERGED") {
		let latest = ship.rounds.at(-1);
		if (latest?.headSha && latest.headSha !== status.headSha) {
			return { ok: false, merged: false, reason: "PR head changed since last review; run review again" };
		}
		if (latest?.source === "pr") {
			// Merge on the PR's current threads, never on the stored snapshot; an unreadable thread list refuses the merge.
			const threads = github.reviewThreads(pr.number);
			if (!threads.ok) return { ok: false, merged: false, reason: `could not read review threads: ${threads.error}` };
			latest = { ...latest, comments: openThreadComments(threads.threads) };
		}
		const gate = mergeGate({ config: deps.config, status, latest });
		if (!gate.ok) return { ok: false, merged: false, reason: gate.reason };
		const allowed = github.mergeMethods();
		if (allowed.length > 0 && !allowed.includes(method)) method = allowed[0] ?? method;
		const merged = github.merge({ number: pr.number, method, headSha: status.headSha });
		if (!merged.ok) return { ok: false, merged: false, reason: `merge failed: ${merged.error ?? "unknown"}` };
	}
	const cleanup: Output = {};
	if (deps.config.deleteBranch) {
		const deleted = github.deleteRemoteBranch(pr.head);
		const synced = github.syncBase({ base: pr.base, branch: pr.head });
		Object.assign(cleanup, { remoteDeleted: deleted.ok, synced: synced.ok });
		if (deleted.error) cleanup.deleteError = deleted.error;
		if (synced.error) cleanup.syncError = synced.error;
	}
	const mergedAt = ship.mergedAt ?? deps.now();
	writeShip(statePath, { phase: "merged", mergedAt }, deps.now());
	return {
		ok: true,
		merged: true,
		alreadyMerged: status.state === "MERGED",
		pr,
		method,
		...(method !== deps.config.mergeMethod ? { methodSubstituted: `${deps.config.mergeMethod} not allowed; used ${method}` } : {}),
		...cleanup,
	};
}

async function stepRun(ctx: Ctx): Promise<Output> {
	const assess = await stepAssess(ctx);
	if (!assess.done) return { ok: true, assess, next: "task not done: finish the listed gaps, then run again" };
	const pr = await stepPr(ctx);
	if (!pr.ok) return { ok: false, assess, pr, next: `stop: ${String(pr.reason)}` };
	const review = await stepReview(ctx);
	if (!review.ready || !ctx.deps.config.autoMerge) {
		const next = review.ready ? "autoMerge disabled: merge manually" : (review.next ?? `stop: ${String(review.reason)}`);
		return { ok: review.ok !== false, assess, pr, review, next };
	}
	const merge = await stepMerge(ctx);
	return { ok: merge.ok, assess, pr, review, merge, next: merge.ok ? "run ultrathink-sync" : `stop: ${String(merge.reason)}` };
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
			try {
				client ??= createMcpClient("greptile", { storePath: storePath() });
			} catch {
				return undefined;
			}
			return client;
		},
	};
	const { code, output } = await runShip(argv, deps);
	client?.close();
	process.stdout.write(`${JSON.stringify(output)}\n`);
	return code;
}

if (import.meta.main) {
	process.exit(await main());
}
