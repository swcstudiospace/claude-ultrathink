// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { GREPTILE_MAX_SCORE, type PrStatus, type ReviewResult, type ShipConfig } from "./types.ts";

/** The review side of the gate: a completed review at or above minScore with no open comments (when required). */
export function reviewPasses(config: ShipConfig, review: ReviewResult): boolean {
	if (review.status !== "completed" || review.score === null || review.score < config.minScore) return false;
	return !config.requireNoComments || review.comments.length === 0;
}

export function mergeGate(input: { config: ShipConfig; status: PrStatus; latest?: ReviewResult }): {
	ok: boolean;
	reason: string;
} {
	const { config, status, latest } = input;
	const fail = (reason: string) => ({ ok: false, reason });
	if (!latest) return fail("no review has run");
	if (latest.status !== "completed") return fail(`review ${latest.status}`);
	if (latest.headSha && latest.headSha !== status.headSha) return fail("review is for an older commit");
	if (latest.score === null) return fail("review has no score");
	if (latest.score < config.minScore) {
		return fail(`review score ${latest.score}/${GREPTILE_MAX_SCORE} is below ${config.minScore}/${GREPTILE_MAX_SCORE}`);
	}
	if (config.requireNoComments && latest.comments.length > 0) {
		return fail(`${latest.comments.length} open review comment(s)`);
	}
	if (status.state !== "OPEN") return fail(`PR is ${status.state.toLowerCase()}`);
	if (status.mergeable === "CONFLICTING") return fail("merge conflicts");
	if (status.mergeable === "UNKNOWN") return fail("GitHub has not computed mergeability yet");
	if (status.checks === "failing") return fail("CI checks failing");
	if (status.checks === "pending") return fail("CI checks pending");
	return { ok: true, reason: "ready to merge" };
}
