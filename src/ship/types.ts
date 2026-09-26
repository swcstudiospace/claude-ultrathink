// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/** Greptile's confidence scale: scores run 0..5 and 5 ("5/5") is the maximum. */
export const GREPTILE_MAX_SCORE = 5;

export interface ShipConfig {
	/** Ship is opt-in: false means a skill run never pushes, opens a PR or merges. */
	enabled: boolean;
	autoMerge: boolean;
	/** Skill-name prefixes that trigger ship; empty = every skill run. */
	skills: string[];
	minScore: number;
	requireNoComments: boolean;
	maxRounds: number;
	mergeMethod: "squash" | "merge" | "rebase";
	deleteBranch: boolean;
	/** Greptile organization id or handle passed on every Greptile MCP call; "" = let Greptile pick (single-org accounts). */
	greptileOrganization: string;
	reviewTimeoutMs: number;
	pollMs: number;
	/** Longest a single `review` call blocks before returning "pending"; fits every host's default shell timeout. */
	waitMs: number;
	/** Re-triggers of a failed or timed-out Greptile review per head commit before the ship blocks (0 = none). */
	reviewRetries: number;
	/** How long `merge` keeps retrying one reviewed head commit, from the first time it waited on it, before the ship blocks. */
	mergeTimeoutMs: number;
	/**
	 * "gate": the LLM judge must say done with confidence >= 0.7 (today's behavior).
	 * "advisory": only the deterministic rules gate `done`; the judge verdict is recorded and shown in the PR body,
	 * and the merge gate (Greptile >= minScore, no open threads, CI) is unchanged.
	 */
	judge: JudgeMode;
}

/** How the pre-PR LLM done-judge takes part in `assess`; see ShipConfig.judge. */
export type JudgeMode = "gate" | "advisory";

export const JUDGE_MODES: readonly JudgeMode[] = ["gate", "advisory"];

export const MERGE_METHODS: readonly ShipConfig["mergeMethod"][] = ["squash", "merge", "rebase"];

export const DEFAULT_SHIP_CONFIG: ShipConfig = {
	enabled: false,
	autoMerge: false,
	skills: ["gsd-"],
	minScore: 5,
	requireNoComments: true,
	maxRounds: 5,
	mergeMethod: "squash",
	deleteBranch: false,
	greptileOrganization: "",
	reviewTimeoutMs: 1_200_000,
	pollMs: 20_000,
	waitMs: 100_000,
	reviewRetries: 3,
	mergeTimeoutMs: 3_600_000,
	judge: "gate",
};

export interface GitSignals {
	branch?: string;
	base?: string;
	onBase: boolean;
	ahead: number;
	dirty: string[];
	untracked: number;
	/** owner/repo */
	repo?: string;
	pushed: boolean;
}

/** Evidence of the latest archived GSD milestone (`gsd-autonomous` moves phases out of `.planning/phases`). */
export interface MilestoneEvidence {
	/** Archived milestone version, e.g. "v2.0" (from `.planning/milestones/<version>-phases/`). */
	version: string;
	/** One entry per archived phase dir that has a `*-VERIFICATION.md`, sorted by phase dir name; status = frontmatter `status:`. */
	verifications: { phase: string; status: string }[];
	/** From `.planning/milestones/<version>-MILESTONE-AUDIT.md` frontmatter, when present. */
	audit?: { status: string; scores: Record<string, string> };
}

export interface GsdSignals {
	phaseCount: number;
	completedPhases: number;
	/** False when `.planning/` is neither tracked nor git-ignored (possibly stray planning from another tool). */
	trusted: boolean;
	/** STATE.md frontmatter `status:`, when present. */
	state?: string;
	verification?: { phase: string; status: string };
	/** A roadmap exists but gsd-tools.cjs was found neither via `GSD_TOOLS` nor in any standard GSD install location. */
	toolsMissing?: boolean;
	/** gsd-tools.cjs resolved but `node` could not be spawned to run it (exit 127 / ENOENT). */
	nodeMissing?: boolean;
	/** Latest archived milestone; set only when no active phase under `.planning/phases/` has a `*-VERIFICATION.md`. */
	milestone?: MilestoneEvidence;
}

export interface ShipSignals {
	git: GitSignals;
	gsd?: GsdSignals;
	/** The operator excluded the repository's GSD roadmap from this assessment (`assess --ignore-gsd`). */
	gsdIgnored?: boolean;
	graph?: { nodes: number; workflowUnits: number };
}

/** The LLM done-judge's parsed verdict. */
export interface JudgeVerdict {
	done: boolean;
	confidence: number;
	summary: string;
	gaps: string[];
}

export interface Assessment {
	done: boolean;
	confidence: number;
	summary: string;
	gaps: string[];
	signals: ShipSignals;
	source: "llm" | "rules";
	/** Judge mode the assessment ran under. */
	mode?: JudgeMode;
	/** Advisory mode: the judge verdict, or `error` when the judge was unavailable or failed. */
	judge?: JudgeVerdict & { error?: string };
	at: number;
}

export interface ReviewComment {
	path?: string;
	line?: number;
	body: string;
	severity?: string;
	securityIssue?: boolean;
	/** GitHub review thread id (PR mode), for replying to and resolving the finding. */
	threadId?: string;
}

export interface ReviewResult {
	source: "pr" | "cli";
	/**
	 * "pending": the review is still running server-side; call again to resume it.
	 * "blocked": Greptile is not usable as configured (no credential or CLI, organization not chosen); `error` says how to fix it.
	 */
	status: "completed" | "pending" | "timeout" | "failed" | "blocked";
	score: number | null;
	comments: ReviewComment[];
	headSha?: string;
	reviewId?: string;
	url?: string;
	error?: string;
	at: number;
}

export interface PrRef {
	number: number;
	url: string;
	head: string;
	base: string;
	/** owner/repo, recorded by `pr`. */
	repo?: string;
}

export interface PrStatus {
	state: "OPEN" | "MERGED" | "CLOSED";
	headSha: string;
	mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
	checks: "passing" | "pending" | "failing" | "none";
	url: string;
}

export type ShipPhase = "not-done" | "pr-open" | "needs-fixes" | "ready" | "merged" | "blocked";

export type ShipAttemptOutcome =
	| "passed"
	| "needs-fixes"
	| "failed"
	| "timeout"
	| "waiting"
	| "retry"
	| "merged"
	| "needs-agent"
	| "blocked";

/** One review result or merge outcome, kept in ShipState.attempts for the audit trail. */
export interface ShipAttempt {
	at: number;
	step: "review" | "merge";
	headSha: string;
	outcome: ShipAttemptOutcome;
	score?: number | null;
	/** One line, at most 200 chars. */
	detail?: string;
}

/** Most attempts kept; older ones are dropped. */
export const MAX_ATTEMPTS = 50;

/** A finished ship of this session, kept in ShipState.history. */
export type ShipHistoryEntry = Omit<ShipState, "history">;

/** Most finished ships kept per session; older ones are dropped. */
export const MAX_SHIP_HISTORY = 10;

export interface ShipState {
	phase: ShipPhase;
	assessment?: Assessment;
	pr?: PrRef;
	rounds: ReviewResult[];
	mergedAt?: number;
	blockedReason?: string;
	nudgedAt?: number;
	/** In-flight Greptile review for headSha; never counted as a round. */
	pending?: { headSha: string; source: "pr" | "cli"; since: number; runId?: string };
	attempts?: ShipAttempt[];
	/** Since when `merge` has waited on this head commit. */
	waiting?: { headSha: string; since: number };
	/** Finished ships of this session, oldest first. */
	history?: ShipHistoryEntry[];
	updatedAt: number;
}

export type Run = (
	argv: string[],
	opts?: { cwd?: string; timeoutMs?: number; stdin?: string },
) => { exitCode: number; stdout: string; stderr: string };
