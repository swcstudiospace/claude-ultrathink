// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
export interface ShipConfig {
	enabled: boolean;
	autoMerge: boolean;
	/** Skill-name prefixes that trigger ship; empty = every skill run. */
	skills: string[];
	minScore: number;
	requireNoComments: boolean;
	maxRounds: number;
	mergeMethod: "squash" | "merge" | "rebase";
	deleteBranch: boolean;
	reviewTimeoutMs: number;
	pollMs: number;
	/** Longest a single `review` call blocks before returning "pending"; fits every host's default shell timeout. */
	waitMs: number;
}

export const MERGE_METHODS: readonly ShipConfig["mergeMethod"][] = ["squash", "merge", "rebase"];

export const DEFAULT_SHIP_CONFIG: ShipConfig = {
	enabled: true,
	autoMerge: true,
	skills: ["gsd-"],
	minScore: 5,
	requireNoComments: true,
	maxRounds: 5,
	mergeMethod: "squash",
	deleteBranch: true,
	reviewTimeoutMs: 1_200_000,
	pollMs: 20_000,
	waitMs: 100_000,
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

export interface GsdSignals {
	phaseCount: number;
	completedPhases: number;
	/** False when `.planning/` is neither tracked nor git-ignored (possibly stray planning from another tool). */
	trusted: boolean;
	/** STATE.md frontmatter `status:`, when present. */
	state?: string;
	verification?: { phase: string; status: string };
}

export interface ShipSignals {
	git: GitSignals;
	gsd?: GsdSignals;
	/** The operator excluded the repository's GSD roadmap from this assessment (`assess --ignore-gsd`). */
	gsdIgnored?: boolean;
	graph?: { nodes: number; workflowUnits: number };
}

export interface Assessment {
	done: boolean;
	confidence: number;
	summary: string;
	gaps: string[];
	signals: ShipSignals;
	source: "llm" | "rules";
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
	/** "pending": the review is still running server-side; call again to resume it. */
	status: "completed" | "pending" | "timeout" | "failed";
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
}

export interface PrStatus {
	state: "OPEN" | "MERGED" | "CLOSED";
	headSha: string;
	mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
	checks: "passing" | "pending" | "failing" | "none";
	url: string;
}

export type ShipPhase = "not-done" | "pr-open" | "needs-fixes" | "ready" | "merged" | "blocked";

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
	updatedAt: number;
}

export type Run = (
	argv: string[],
	opts?: { cwd?: string; timeoutMs?: number; stdin?: string },
) => { exitCode: number; stdout: string; stderr: string };
