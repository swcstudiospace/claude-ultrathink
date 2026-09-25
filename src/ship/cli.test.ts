// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Github, ReviewThreads } from "./github.ts";
import { runShip } from "./cli.ts";
import type { ShipDeps } from "./cli.ts";
import { readShip, writeShip } from "./state.ts";
import type { Assessment, GitSignals, PrRef, PrStatus, ReviewResult, ShipConfig, ShipSignals } from "./types.ts";

const CONFIG: ShipConfig = {
	enabled: true,
	autoMerge: true,
	skills: ["gsd-"],
	minScore: 5,
	requireNoComments: true,
	maxRounds: 2,
	mergeMethod: "squash",
	deleteBranch: true,
	reviewTimeoutMs: 1000,
	pollMs: 10,
	waitMs: 100,
};
const PR: PrRef = { number: 7, url: "https://github.com/o/r/pull/7", head: "feat", base: "master" };

let dir: string;
let statePath: string;
let calls: string[];
let comments: string[];

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ship-cli-"));
	statePath = join(dir, "s.json");
	calls = [];
	comments = [];
	writeFileSync(statePath, JSON.stringify({ sessionId: "s", at: 1, result: { original: "ship it", uplifted: "ship it" }, kickedOff: true }));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

interface FakeOpts {
	git?: Partial<GitSignals>;
	done?: boolean;
	source?: Assessment["source"];
	existingPr?: PrRef;
	status?: Partial<PrStatus>;
	review?: Partial<ReviewResult>;
	config?: Partial<ShipConfig>;
	methods?: ShipConfig["mergeMethod"][];
	/** Local `git rev-parse HEAD`; defaults to the PR head sha. */
	head?: string;
	now?: number;
	/** GitHub review threads; defaults to a failed lookup. */
	threads?: ReviewThreads;
}

function deps(o: FakeOpts = {}): ShipDeps {
	const git: GitSignals = { branch: "feat", base: "master", onBase: false, ahead: 1, dirty: [], untracked: 0, pushed: true, ...o.git };
	const signals: ShipSignals = { git };
	const status: PrStatus = { state: "OPEN", headSha: "abc", mergeable: "MERGEABLE", checks: "passing", url: PR.url, ...o.status };
	const github: Github = {
		repo: () => ({ name: "o/r", defaultBranch: "master" }),
		push: (b) => (calls.push(`push:${b}`), { ok: true }),
		findOpenPr: () => o.existingPr,
		createPr: (i) => (calls.push(`create:${i.base}<-${i.head}`), PR),
		prStatus: () => status,
		merge: (i) => (calls.push(`merge:${i.method}:${i.headSha}`), { ok: true }),
		mergeMethods: () => o.methods ?? [],
		deleteRemoteBranch: (b) => (calls.push(`delete:${b}`), { ok: true }),
		comment: (n, body) => (calls.push(`comment:${n}`), comments.push(body), { ok: true }),
		syncBase: (i) => (calls.push(`sync:${i.base}`), { ok: true }),
		reviewThreads: () => o.threads ?? { ok: false, error: "no threads" },
	};
	return {
		config: { ...CONFIG, ...o.config },
		run: (argv) => ({ exitCode: 0, stdout: argv.join(" ") === "git rev-parse HEAD" ? `${o.head ?? status.headSha}\n` : "", stderr: "" }),
		now: () => o.now ?? 1000,
		github: () => github,
		review: async (i) => (
			calls.push(`review:${i.prNumber}:${i.headSha}`),
			{ source: "cli", status: "completed", score: 5, comments: [], headSha: i.headSha, at: 1, ...o.review }
		),
		assess: async (i) => ({
			done: o.done ?? true,
			confidence: 0.9,
			summary: "ok",
			gaps: [],
			signals: i.signals,
			source: o.source ?? "llm",
			at: 1,
		}),
		signals: () => signals,
		diff: () => ({ stat: "", log: "" }),
		engine: async () => async () => "{}",
		greptile: () => undefined,
	};
}

const ship = (cmd: string, d: ShipDeps) => runShip([cmd, "--state", statePath, "--cwd", dir], d);

describe("state", () => {
	test("writeShip preserves other record fields and merges patches", () => {
		writeShip(statePath, { pr: PR }, 5);
		const next = writeShip(statePath, { phase: "pr-open" }, 6);
		expect(next).toMatchObject({ phase: "pr-open", pr: PR, rounds: [], updatedAt: 6 });
		const record = JSON.parse(readFileSync(statePath, "utf8"));
		expect(record.kickedOff).toBe(true);
		expect(record.sessionId).toBe("s");
	});
	test("missing state file yields undefined", () => {
		expect(writeShip(join(dir, "nope.json"), { phase: "ready" })).toBeUndefined();
		expect(readShip(join(dir, "nope.json"))).toBeUndefined();
	});
});

describe("runShip", () => {
	test("usage errors exit 2", async () => {
		expect((await runShip(["assess"], deps())).code).toBe(2);
		expect((await runShip(["bogus", "--state", statePath], deps())).code).toBe(2);
	});

	test("assess stores assessment; rules-only is not done under autoMerge", async () => {
		const out = await ship("assess", deps());
		expect(out.output.done).toBe(true);
		expect(readShip(statePath)?.assessment?.done).toBe(true);
		const rules = await ship("assess", deps({ source: "rules" }));
		expect(rules.output.done).toBe(false);
		expect(rules.output.gaps).toContain("no judge available");
	});

	test("assess --ignore-gsd leaves the GSD roadmap out of the assessment and records it", async () => {
		const gsd = { phaseCount: 3, completedPhases: 0, trusted: true };
		const d = { ...deps(), signals: () => ({ git: { branch: "feat", base: "master", onBase: false, ahead: 1, dirty: [], untracked: 0, pushed: true }, gsd }) };
		const seen: ShipSignals[] = [];
		const capture = { ...d, assess: async (i: Parameters<ShipDeps["assess"]>[0]) => (seen.push(i.signals), d.assess(i)) };
		await runShip(["assess", "--state", statePath, "--cwd", dir], capture);
		await runShip(["assess", "--state", statePath, "--cwd", dir, "--ignore-gsd"], capture);
		expect(seen[0]).toMatchObject({ gsd });
		expect(seen[0]?.gsdIgnored).toBeUndefined();
		expect(seen[1]?.gsd).toBeUndefined();
		expect(seen[1]?.gsdIgnored).toBe(true);
		expect(readShip(statePath)?.assessment?.signals.gsdIgnored).toBe(true);
	});

	test("pr refuses when not assessed done", async () => {
		await ship("assess", deps({ done: false }));
		expect((await ship("pr", deps())).output.ok).toBe(false);
		expect(calls).toEqual([]);
	});

	test("pr refuses on dirty tree and on base branch", async () => {
		await ship("assess", deps());
		expect((await ship("pr", deps({ git: { dirty: ["a.ts"] } }))).output.ok).toBe(false);
		expect((await ship("pr", deps({ git: { onBase: true, branch: "master" } }))).output.ok).toBe(false);
		expect(calls).toEqual([]);
	});

	test("pr creates into default branch when absent, reuses when present", async () => {
		await ship("assess", deps());
		const created = await ship("pr", deps());
		expect(created.output).toMatchObject({ ok: true, pr: PR, reused: false });
		expect(calls).toEqual(["push:feat", "create:master<-feat"]);
		expect(readShip(statePath)?.phase).toBe("pr-open");
		calls = [];
		const reused = await ship("pr", deps({ existingPr: PR }));
		expect(reused.output).toMatchObject({ ok: true, reused: true });
		expect(calls).toEqual(["push:feat"]);
	});

	test("review: ready, needs-fixes, then blocked at maxRounds", async () => {
		writeShip(statePath, { pr: PR, phase: "pr-open" });
		const bad = deps({ review: { score: 3, comments: [{ body: "fix" }] } });
		const first = await ship("review", bad);
		expect(first.output).toMatchObject({ ready: false, round: 1, maxRounds: 2 });
		expect(String(first.output.next)).toContain("fix the listed findings");
		expect(readShip(statePath)?.phase).toBe("needs-fixes");
		const second = await ship("review", deps({ status: { headSha: "def" }, review: { score: 3, comments: [{ body: "fix" }] } }));
		expect(String(second.output.next)).toStartWith("stop: max rounds reached");
		expect(readShip(statePath)?.phase).toBe("blocked");

		writeShip(statePath, { rounds: [], phase: "pr-open" });
		const good = await ship("review", deps());
		expect(good.output).toMatchObject({ ready: true, score: 5, next: "run merge" });
		expect(readShip(statePath)?.phase).toBe("ready");
	});

	test("merge refuses when autoMerge disabled", async () => {
		writeShip(statePath, { pr: PR });
		const out = await ship("merge", deps({ config: { autoMerge: false } }));
		expect(out.output).toMatchObject({ ok: false, reason: "autoMerge disabled" });
		expect(calls).toEqual([]);
	});

	test("merge refuses on gate failure", async () => {
		writeShip(statePath, { pr: PR, rounds: [{ source: "cli", status: "completed", score: 5, comments: [], headSha: "abc", at: 1 }] });
		const out = await ship("merge", deps({ status: { checks: "failing" } }));
		expect(out.output.ok).toBe(false);
		expect(calls).toEqual([]);
	});

	test("merge refuses when head moved since the review", async () => {
		writeShip(statePath, { pr: PR, rounds: [{ source: "cli", status: "completed", score: 5, comments: [], headSha: "old", at: 1 }] });
		expect((await ship("merge", deps())).output.ok).toBe(false);
		expect(calls).toEqual([]);
	});

	test("merge merges, syncs base, marks merged", async () => {
		writeShip(statePath, { pr: PR, rounds: [{ source: "cli", status: "completed", score: 5, comments: [], headSha: "abc", at: 1 }] });
		const out = await ship("merge", deps());
		expect(out.output).toMatchObject({ ok: true, merged: true });
		expect(calls).toEqual(["merge:squash:abc", "delete:feat", "sync:master"]);
		expect(readShip(statePath)).toMatchObject({ phase: "merged", mergedAt: 1000 });
	});

	test("run chains all steps to merge", async () => {
		const out = await ship("run", deps());
		expect(out.output.next).toBe("run ultrathink-sync");
		expect(calls).toEqual(["push:feat", "create:master<-feat", "review:7:abc", "merge:squash:abc", "delete:feat", "sync:master"]);
	});

	test("run stops at the first unmet step", async () => {
		const notDone = await ship("run", deps({ done: false }));
		expect(notDone.output.pr).toBeUndefined();
		expect(calls).toEqual([]);
		const needsFix = await ship("run", deps({ review: { score: 4 } }));
		expect(needsFix.output.merge).toBeUndefined();
		expect(calls).not.toContain("merge:squash:abc");
	});

	test("unexpected throw is reported with exit 0", async () => {
		const d = deps();
		d.signals = () => {
			throw new Error("boom");
		};
		expect(await ship("assess", d)).toEqual({ code: 0, output: { ok: false, error: "boom" } });
	});

	test("pr refuses when branch changed since assessment", async () => {
		await ship("assess", deps());
		expect((await ship("pr", deps({ git: { branch: "other" } }))).output.ok).toBe(false);
		expect(calls).toEqual([]);
	});

	test("review reuses a completed round for the same head", async () => {
		writeShip(statePath, { pr: PR, rounds: [{ source: "cli", status: "completed", score: 5, comments: [], headSha: "abc", at: 1 }] });
		const out = await ship("review", deps({ head: "unpushed" }));
		expect(out.output).toMatchObject({ reused: true, ready: true, round: 1 });
		expect(calls).toEqual([]);
	});

	test("a reused PR round re-reads threads: a resolved finding clears; a failed lookup is not ready and persists nothing", async () => {
		const open = { body: "intended behavior", path: "a.ts", threadId: "T1" };
		const round: ReviewResult = { source: "pr", status: "completed", score: 5, comments: [open], headSha: "abc", at: 1 };
		writeShip(statePath, { pr: PR, rounds: [round] });
		const failed = await ship("review", deps());
		expect(failed.output).toMatchObject({ ok: false, ready: false });
		expect(String(failed.output.reason)).toContain("could not read review threads");
		expect(readShip(statePath)?.rounds).toMatchObject([{ comments: [open] }]);
		const resolved = { id: "T1", isResolved: true, isOutdated: false, author: "greptile-apps", body: "intended behavior" };
		const threads: ReviewThreads = { ok: true, threads: [resolved] };
		const cleared = await ship("review", deps({ threads }));
		expect(cleared.output).toMatchObject({ reused: true, ready: true, round: 1, comments: [] });
		expect(readShip(statePath)?.rounds).toMatchObject([{ comments: [] }]);
		expect((await ship("merge", deps())).output).toMatchObject({ ok: false, merged: false });
		expect(calls.some((c) => c.startsWith("merge:"))).toBe(false);
		expect((await ship("merge", deps({ threads }))).output).toMatchObject({ ok: true, merged: true });
	});

	test("a clean stored PR round does not pass review or merge when the threads cannot be read", async () => {
		const round: ReviewResult = { source: "pr", status: "completed", score: 5, comments: [], headSha: "abc", at: 1 };
		writeShip(statePath, { pr: PR, rounds: [round] });
		expect((await ship("review", deps())).output).toMatchObject({ ok: false, ready: false });
		expect((await ship("merge", deps())).output).toMatchObject({ ok: false, merged: false });
		const posted = { id: "T9", isResolved: false, isOutdated: false, author: "greptile-apps", body: "**New finding**" };
		const merge = await ship("merge", deps({ threads: { ok: true, threads: [posted] } }));
		expect(merge.output).toMatchObject({ ok: false, merged: false, reason: "1 open review comment(s)" });
		expect(calls.some((c) => c.startsWith("merge:"))).toBe(false);
	});

	test("review refuses when local HEAD differs from the PR head", async () => {
		writeShip(statePath, { pr: PR, phase: "pr-open" });
		const out = await ship("review", deps({ head: "1234567890" }));
		expect(out.output).toMatchObject({
			ok: false,
			ready: false,
			reason: "local HEAD 1234567 differs from PR head abc; push your commits (or pull) first",
			next: "git push, then run review again",
		});
		expect(calls).toEqual([]);
		expect(readShip(statePath)).toMatchObject({ phase: "pr-open", rounds: [] });
	});

	describe("pending review", () => {
		const pendingReview: Partial<ReviewResult> = { status: "pending", score: null, reviewId: "run-1" };

		test("is not a round and keeps `since` for the same head", async () => {
			writeShip(statePath, { pr: PR, phase: "needs-fixes", rounds: [{ source: "cli", status: "completed", score: 3, comments: [], headSha: "old", at: 1 }] });
			const first = await ship("review", deps({ review: pendingReview, now: 2000 }));
			expect(first.output).toMatchObject({
				ok: true,
				ready: false,
				status: "pending",
				round: 1,
				next: "Greptile review still running; run review again (safe to repeat, it resumes the same review)",
			});
			const second = await ship("review", deps({ review: { ...pendingReview, reviewId: undefined }, now: 2900 }));
			expect(second.output.status).toBe("pending");
			expect(readShip(statePath)).toMatchObject({
				phase: "needs-fixes",
				rounds: [{ headSha: "old" }],
				pending: { headSha: "abc", source: "cli", since: 2000, runId: "run-1" },
			});
		});

		test("restarts `since` when the head moved", async () => {
			writeShip(statePath, { pr: PR, pending: { headSha: "old", source: "cli", since: 1 } });
			await ship("review", deps({ review: pendingReview, now: 5000 }));
			expect(readShip(statePath)?.pending).toEqual({ headSha: "abc", source: "cli", since: 5000, runId: "run-1" });
		});

		test("becomes a timeout round after reviewTimeoutMs", async () => {
			writeShip(statePath, { pr: PR, phase: "pr-open", pending: { headSha: "abc", source: "cli", since: 2000, runId: "run-1" } });
			const out = await ship("review", deps({ review: pendingReview, now: 3001 }));
			expect(out.output).toMatchObject({ status: "timeout", round: 1, ready: false });
			const state = readShip(statePath);
			expect(state?.rounds).toMatchObject([{ status: "timeout", headSha: "abc" }]);
			expect(state?.pending).toBeUndefined();
			expect(state?.phase).toBe("needs-fixes");
		});

		test("a terminal result clears it", async () => {
			writeShip(statePath, { pr: PR, pending: { headSha: "abc", source: "cli", since: 900 } });
			const out = await ship("review", deps());
			expect(out.output).toMatchObject({ ready: true, round: 1 });
			expect(readShip(statePath)?.pending).toBeUndefined();
		});

		test("run stops at a pending review", async () => {
			const out = await ship("run", deps({ review: pendingReview }));
			expect(out.output.next).toBe("Greptile review still running; run review again (safe to repeat, it resumes the same review)");
			expect(calls).toEqual(["push:feat", "create:master<-feat", "review:7:abc"]);
		});
	});

	test("blocked review posts one PR comment; intermediate rounds do not", async () => {
		writeShip(statePath, { pr: PR });
		const finding = { path: "a.ts", line: 4, severity: "P1", body: "null deref" };
		await ship("review", deps({ review: { score: 3, comments: [finding] } }));
		expect(comments).toEqual([]);
		await ship("review", deps({ status: { headSha: "def" }, review: { score: 3, comments: [finding] } }));
		expect(comments).toHaveLength(1);
		expect(comments[0]).toContain("a.ts:4 P1 null deref");
		expect(comments[0]).toContain("Left open for human follow-up");
		expect(readShip(statePath)?.blockedReason).toContain("max rounds");
	});

	test("review failing twice on the same head blocks", async () => {
		writeShip(statePath, { pr: PR, rounds: [{ source: "cli", status: "failed", score: null, comments: [], headSha: "abc", at: 1 }] });
		const out = await ship("review", deps({ config: { maxRounds: 9 }, review: { status: "timeout", score: null } }));
		expect(String(out.output.next)).toStartWith("stop:");
		expect(readShip(statePath)?.phase).toBe("blocked");
		expect(comments).toHaveLength(1);
	});

	test("merge on already-merged PR skips merge but cleans up", async () => {
		writeShip(statePath, { pr: PR });
		const out = await ship("merge", deps({ status: { state: "MERGED" } }));
		expect(out.output).toMatchObject({ ok: true, alreadyMerged: true });
		expect(calls).toEqual(["delete:feat", "sync:master"]);
	});

	test("merge on closed PR blocks without deleting", async () => {
		writeShip(statePath, { pr: PR });
		expect((await ship("merge", deps({ status: { state: "CLOSED" } }))).output.ok).toBe(false);
		expect(readShip(statePath)?.phase).toBe("blocked");
		expect(calls).toEqual([]);
	});

	test("merge substitutes an allowed method", async () => {
		writeShip(statePath, { pr: PR, rounds: [{ source: "cli", status: "completed", score: 5, comments: [], headSha: "abc", at: 1 }] });
		const out = await ship("merge", deps({ methods: ["rebase"], config: { deleteBranch: false } }));
		expect(out.output.method).toBe("rebase");
		expect(calls).toEqual(["merge:rebase:abc"]);
	});
});
