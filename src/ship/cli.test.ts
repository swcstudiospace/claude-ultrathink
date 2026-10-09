// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDecisions } from "../decisions/gate.ts";
import { DEFAULT_DECISIONS_CONFIG } from "../decisions/types.ts";
import type { DecisionsConfig, DecisionsErrorKind } from "../decisions/types.ts";
import type { Github, ReviewThreads, ReviewThreadsOptions } from "./github.ts";
import { assessDone } from "./assess.ts";
import { runShip } from "./cli.ts";
import type { ShipDeps } from "./cli.ts";
import { runReview } from "./greptile.ts";
import { appendAttempts, archiveShip, readShip, writeShip } from "./state.ts";
import { MAX_SHIP_HISTORY } from "./types.ts";
import type { Assessment, GitSignals, PrRef, PrStatus, ReviewResult, ShipAttempt, ShipConfig, ShipSignals } from "./types.ts";

const CONFIG: ShipConfig = {
	enabled: true,
	autoMerge: true,
	skills: ["gsd-"],
	minScore: 5,
	requireNoComments: true,
	maxRounds: 2,
	mergeMethod: "squash",
	deleteBranch: true,
	greptileOrganization: "",
	reviewTimeoutMs: 1000,
	pollMs: 10,
	waitMs: 100,
	reviewRetries: 3,
	mergeTimeoutMs: 10_000,
	judge: "gate",
};
const PR: PrRef = { number: 7, url: "https://github.com/o/r/pull/7", head: "feat", base: "master" };
const PASSED: ReviewResult = { source: "cli", status: "completed", score: 5, comments: [], headSha: "abc", at: 1 };

let dir: string;
let statePath: string;
let calls: string[];
let comments: string[];
/** Fake clock: `now` reads it, the fake `sleep` advances it, so nothing really waits. */
let clock: number;
let sleeps: number[];
let reviewInputs: Parameters<ShipDeps["review"]>[0][];

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ship-cli-"));
	statePath = join(dir, "s.json");
	calls = [];
	comments = [];
	clock = 1000;
	sleeps = [];
	reviewInputs = [];
	writeFileSync(statePath, JSON.stringify({ sessionId: "s", at: 1, result: { original: "ship it", uplifted: "ship it" }, kickedOff: true }));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

interface FakeOpts {
	git?: Partial<GitSignals>;
	done?: boolean;
	source?: Assessment["source"];
	existingPr?: PrRef;
	status?: Partial<PrStatus>;
	/** PR status per prStatus call, each over `status` (null = unreadable); once used up, `status` answers. */
	statuses?: (Partial<PrStatus> | null)[];
	review?: Partial<ReviewResult>;
	config?: Partial<ShipConfig>;
	methods?: ShipConfig["mergeMethod"][];
	/** GitHub merge result per merge call; once used up, merges succeed. */
	merges?: { ok: boolean; error?: string }[];
	/** Local `git rev-parse HEAD`; defaults to the PR head sha. */
	head?: string;
	/** Sets the fake clock when the deps are built. */
	now?: number;
	/** GitHub review threads; defaults to a failed lookup. */
	threads?: ReviewThreads;
}

function deps(o: FakeOpts = {}): ShipDeps {
	if (o.now !== undefined) clock = o.now;
	const git: GitSignals = { branch: "feat", base: "master", onBase: false, ahead: 1, dirty: [], untracked: 0, pushed: true, ...o.git };
	const signals: ShipSignals = { git };
	const status: PrStatus = { state: "OPEN", headSha: "abc", mergeable: "MERGEABLE", checks: "passing", url: PR.url, ...o.status };
	const statuses = [...(o.statuses ?? [])];
	const merges = [...(o.merges ?? [])];
	const github: Github = {
		repo: () => ({ name: "o/r", defaultBranch: "master" }),
		push: (b) => (calls.push(`push:${b}`), { ok: true }),
		findOpenPr: () => o.existingPr,
		createPr: (i) => (calls.push(`create:${i.base}<-${i.head}`), PR),
		prStatus: () => {
			const next = statuses.shift();
			return next === null ? undefined : { ...status, ...next };
		},
		merge: (i) => (calls.push(`merge:${i.method}:${i.headSha}`), merges.shift() ?? { ok: true }),
		mergeMethods: () => o.methods ?? [],
		deleteRemoteBranch: (b) => (calls.push(`delete:${b}`), { ok: true }),
		comment: (n, body) => (calls.push(`comment:${n}`), comments.push(body), { ok: true }),
		syncBase: (i) => (calls.push(`sync:${i.base}`), { ok: true }),
		reviewThreads: (_prNumber: number, opts?: ReviewThreadsOptions) =>
			opts?.deadlineMs !== undefined && (opts.now ?? Date.now)() >= opts.deadlineMs
				? { ok: false, error: "review threads scan exceeded its deadline" }
				: (o.threads ?? { ok: false, error: "no threads" }),
	};
	return {
		config: { ...CONFIG, ...o.config },
		run: (argv) => ({ exitCode: 0, stdout: argv.join(" ") === "git rev-parse HEAD" ? `${o.head ?? status.headSha}\n` : "", stderr: "" }),
		now: () => clock,
		github: () => github,
		review: async (i) => (
			calls.push(`review:${i.prNumber}:${i.headSha}`),
			reviewInputs.push(i),
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
		sleep: async (ms) => {
			sleeps.push(ms);
			clock += ms;
		},
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
	test("appendAttempts keeps the newest 50 attempts, each detail one line of at most 200 characters", () => {
		writeShip(statePath, { pr: PR });
		const attempt = (at: number): ShipAttempt => ({ at, step: "merge", headSha: "abc", outcome: "waiting", detail: `CI checks\npending ${at}` });
		for (let at = 0; at < 45; at++) appendAttempts(statePath, [attempt(at)], 5);
		const state = appendAttempts(statePath, [attempt(45), { ...attempt(46), detail: "x".repeat(300) }, attempt(47)], 6);
		expect(state?.attempts).toHaveLength(48);
		const full = appendAttempts(statePath, Array.from({ length: 12 }, (_, i) => attempt(48 + i)), 7);
		expect(full?.attempts).toHaveLength(50);
		expect(full?.attempts?.[0]?.at).toBe(10);
		expect(full?.attempts?.at(-1)).toEqual({ at: 59, step: "merge", headSha: "abc", outcome: "waiting", detail: "CI checks pending 59" });
		expect(full?.attempts?.find((a) => a.at === 46)?.detail).toHaveLength(200);
		expect(readShip(statePath)).toMatchObject({ pr: PR, updatedAt: 7 });
	});
	test("archiveShip replaces the ship with a fresh one and keeps the newest finished ships in history", () => {
		for (let n = 1; n <= MAX_SHIP_HISTORY + 2; n++) {
			writeShip(statePath, { pr: { ...PR, number: n }, phase: "merged", rounds: [PASSED], mergedAt: n }, n);
			archiveShip(statePath, n);
		}
		const fresh = readShip(statePath);
		expect(fresh).toMatchObject({ phase: "not-done", rounds: [], updatedAt: MAX_SHIP_HISTORY + 2 });
		expect(fresh?.pr).toBeUndefined();
		expect(fresh?.mergedAt).toBeUndefined();
		expect(fresh?.history?.map((entry) => entry.pr?.number)).toEqual(Array.from({ length: MAX_SHIP_HISTORY }, (_, i) => i + 3));
		expect(fresh?.history?.every((entry) => !("history" in entry))).toBe(true);
		expect(JSON.parse(readFileSync(statePath, "utf8")).sessionId).toBe("s");
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

	test("a roadmap without gsd-tools.cjs is a gap naming GSD_TOOLS; --ignore-gsd drops it", async () => {
		const git = { branch: "feat", base: "master", onBase: false, ahead: 1, dirty: [], untracked: 0, pushed: true };
		const gsd = { phaseCount: 0, completedPhases: 0, trusted: true, toolsMissing: true };
		const d = { ...deps(), signals: () => ({ git, gsd }), assess: assessDone, engine: async () => undefined };
		const missing = await runShip(["assess", "--state", statePath, "--cwd", dir], d);
		expect(missing.output.done).toBe(false);
		expect(missing.output.gaps).toContain(
			"GSD roadmap found but gsd-tools.cjs was not found; set GSD_TOOLS or rerun assess with --ignore-gsd",
		);
		const ignored = await runShip(["assess", "--state", statePath, "--cwd", dir, "--ignore-gsd"], {
			...d,
			config: { ...CONFIG, autoMerge: false },
		});
		expect(ignored.output.gaps).toEqual([]);
		expect(ignored.output.done).toBe(true);
	});

	test("advisory judge mode: rules-only assessment is done under autoMerge; gate mode refuses it", async () => {
		const d = { ...deps(), assess: assessDone, engine: async () => undefined };
		const advisory = await ship("assess", { ...d, config: { ...CONFIG, judge: "advisory" } });
		expect(advisory.output).toMatchObject({ ok: true, done: true, mode: "advisory", gaps: [] });
		expect(readShip(statePath)?.assessment?.done).toBe(true);
		const gate = await ship("assess", d);
		expect(gate.output).toMatchObject({ done: false, mode: "gate" });
		expect(gate.output.gaps).toContain("no judge available");
	});

	test("assess archives a finished ship of another branch or repository and assesses into a fresh ship", async () => {
		const cases: [Partial<PrRef>, Partial<GitSignals>, "merged" | "blocked"][] = [
			[{ head: "old" }, {}, "merged"],
			// Same branch name, other repository: the prior repo is parsed from the PR url.
			[{}, { repo: "o/other" }, "blocked"],
		];
		for (const [prior, git, phase] of cases) {
			writeFileSync(statePath, JSON.stringify({ sessionId: "s", at: 1, result: { original: "ship it" } }));
			writeShip(statePath, { pr: { ...PR, ...prior }, phase, rounds: [PASSED] }, 5);
			const out = await ship("assess", deps({ git }));
			expect(out.output).toMatchObject({ ok: true, done: true });
			const state = readShip(statePath);
			expect(state).toMatchObject({ phase: "not-done", rounds: [], assessment: { done: true } });
			expect(state?.pr).toBeUndefined();
			expect(state?.history).toHaveLength(1);
			expect(state?.history?.[0]).toMatchObject({ phase, pr: { ...PR, ...prior }, rounds: [PASSED] });
		}
	});

	test("assess refuses while a ship of another branch is still active and leaves the state untouched", async () => {
		writeShip(statePath, { pr: { ...PR, head: "old" }, phase: "needs-fixes", rounds: [PASSED] }, 5);
		const before = readFileSync(statePath, "utf8");
		const out = await ship("assess", deps());
		expect(out.output).toMatchObject({ ok: false, done: false });
		expect(String(out.output.reason)).toContain(PR.url);
		expect(readFileSync(statePath, "utf8")).toBe(before);
	});

	test("assess on the ship's own branch and repository keeps an active ship without archiving", async () => {
		writeShip(statePath, { pr: { ...PR, repo: "o/r" }, phase: "needs-fixes", rounds: [PASSED] }, 5);
		const out = await ship("assess", deps({ git: { repo: "o/r" } }));
		expect(out.output).toMatchObject({ ok: true, done: true });
		const state = readShip(statePath);
		expect(state?.history).toBeUndefined();
		expect(state).toMatchObject({ phase: "pr-open", pr: { ...PR, repo: "o/r" }, rounds: [PASSED] });
	});

	test("assess never reopens a merged ship on its own branch: it is archived", async () => {
		writeShip(statePath, { pr: { ...PR, repo: "o/r" }, phase: "merged", rounds: [PASSED] }, 5);
		const out = await ship("assess", deps({ git: { repo: "o/r" } }));
		expect(out.output).toMatchObject({ ok: true, done: true });
		const state = readShip(statePath);
		expect(state).toMatchObject({ phase: "not-done", rounds: [] });
		expect(state?.pr).toBeUndefined();
		expect(state?.history?.[0]).toMatchObject({ phase: "merged", pr: { ...PR, repo: "o/r" } });
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
		expect(created.output).toMatchObject({ ok: true, pr: { ...PR, repo: "o/r" }, reused: false });
		expect(readShip(statePath)?.pr?.repo).toBe("o/r");
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

	test("a blocked review (Greptile not set up) records no round, posts no comment and stops the run", async () => {
		const setup = "Greptile is not set up: run `bin/ultrathink-mcp auth set-key greptile --stdin`";
		const blocked = deps({ review: { status: "blocked", score: null, error: setup } });
		writeShip(statePath, { pr: PR, phase: "pr-open" });
		const out = await ship("review", blocked);
		expect(out.output).toMatchObject({ ok: false, ready: false, blocked: true, status: "blocked", reason: setup, next: `stop: ${setup}` });
		expect(readShip(statePath)).toMatchObject({ phase: "blocked", blockedReason: setup, rounds: [] });
		expect(comments).toEqual([]);

		const run = await ship("run", blocked);
		expect(run.output).toMatchObject({ ok: false, review: { blocked: true }, next: `stop: ${setup}` });
		expect(run.output.merge).toBeUndefined();
		expect(calls.some((c) => c.startsWith("merge:"))).toBe(false);
	});

	test("a passing review that waits on CI or mergeability is not a failed round, even at maxRounds", async () => {
		const old: ReviewResult = { source: "cli", status: "completed", score: 3, comments: [{ body: "fix" }], headSha: "old", at: 1 };
		writeShip(statePath, { pr: PR, phase: "needs-fixes", rounds: [old] });
		const pending = await ship("review", deps({ status: { checks: "pending" } }));
		expect(pending.output).toMatchObject({ ready: false, round: 2, maxRounds: 2, score: 5 });
		expect(String(pending.output.next)).toBe("review passed; CI checks pending: wait, then run merge again");
		expect(readShip(statePath)).toMatchObject({ phase: "pr-open" });
		expect(readShip(statePath)?.blockedReason).toBeUndefined();
		expect(comments).toEqual([]);
		const failing = await ship("review", deps({ status: { checks: "failing" } }));
		expect(String(failing.output.next)).toStartWith("review passed; CI checks failing: fix CI");
		expect(readShip(statePath)?.phase).toBe("pr-open");
		expect((await ship("merge", deps())).output).toMatchObject({ ok: true, merged: true });
	});

	test("a waiting round does not count later: one failed review after it is still below maxRounds", async () => {
		const waited: ReviewResult = { source: "cli", status: "completed", score: 5, comments: [], headSha: "abc", at: 1 };
		writeShip(statePath, { pr: PR, phase: "pr-open", rounds: [waited] });
		const out = await ship("review", deps({ status: { headSha: "def" }, head: "def", review: { score: 3, comments: [{ body: "fix" }] } }));
		expect(out.output).toMatchObject({ round: 2, failedRounds: 1, maxRounds: 2 });
		expect(readShip(statePath)?.phase).toBe("needs-fixes");
		expect(comments).toEqual([]);
	});

	test("a passing review on a closed PR blocks without a comment; on a merged PR it points to merge", async () => {
		writeShip(statePath, { pr: PR, phase: "pr-open" });
		const closed = await ship("review", deps({ status: { state: "CLOSED" } }));
		expect(String(closed.output.next)).toBe("stop: PR closed without merge");
		expect(readShip(statePath)).toMatchObject({ phase: "blocked", blockedReason: "PR closed without merge" });
		expect(comments).toEqual([]);
		writeShip(statePath, { rounds: [], phase: "pr-open", blockedReason: undefined });
		const merged = await ship("review", deps({ status: { state: "MERGED" } }));
		expect(String(merged.output.next)).toBe("PR already merged: run merge to finish the cleanup");
		expect(readShip(statePath)?.phase).toBe("ready");
	});

	test("run finishes the cleanup when the PR was merged outside the flow", async () => {
		const out = await ship("run", deps({ existingPr: PR, status: { state: "MERGED" } }));
		expect(out.output).toMatchObject({ ok: true, review: { ready: true }, merge: { ok: true, merged: true, alreadyMerged: true } });
		expect(calls).toContain("delete:feat");
		expect(calls).toContain("sync:master");
		expect(calls.some((c) => c.startsWith("merge:"))).toBe(false);
	});

	test("a PR merged outside the flow with a failing review is blocked, not ready, and run reports ok false", async () => {
		const out = await ship("run", deps({ existingPr: PR, status: { state: "MERGED" }, review: { score: 3, comments: [{ body: "fix" }] } }));
		expect(out.output).toMatchObject({ ok: false, review: { ready: false, blocked: true } });
		expect(String(out.output.next)).toBe("stop: PR was merged outside the ship flow before its review passed");
		expect(out.output.merge).toBeUndefined();
		expect(calls.some((c) => c.startsWith("delete:") || c.startsWith("sync:"))).toBe(false);
		expect(comments).toEqual([]);
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

	test("run reports ok false when its review step fails", async () => {
		const round: ReviewResult = { source: "pr", status: "completed", score: 5, comments: [], headSha: "abc", at: 1 };
		writeShip(statePath, { pr: PR, rounds: [round] });
		const out = await ship("run", deps({ existingPr: PR }));
		expect(out.output).toMatchObject({ ok: false, review: { ok: false, ready: false } });
		expect(String(out.output.next)).toBe("run review again");
		expect(out.output.merge).toBeUndefined();
		expect(calls.some((c) => c.startsWith("merge:"))).toBe(false);
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

	test("failed fresh thread scans do not spend review retries or restart a completed review", async () => {
		writeShip(statePath, { pr: PR, phase: "pr-open", pending: { headSha: "abc", source: "pr", since: 0, runId: "completed" } });
		const client = {
			async call(name: string): Promise<unknown> {
				if (name === "list_repositories") return { repositories: [{ name: "o/r", remote: "github", defaultBranch: PR.base }] };
				if (name === "list_code_reviews") return { codeReviews: [{ id: "completed", commitSha: "abc", status: "COMPLETED" }] };
				if (name === "get_code_review") return { codeReview: { body: "Confidence Score: 5/5" } };
				throw new Error(`completed review must remain reusable, not call ${name}`);
			},
		};
		const failed: ShipDeps = { ...deps({ config: { reviewRetries: 0 } }), greptile: () => client, review: runReview };
		for (let i = 0; i < 2; i++) {
			clock += CONFIG.reviewTimeoutMs + 1;
			expect((await ship("review", failed)).output).toMatchObject({ ok: false, ready: false, status: "unverified", reviewId: "completed", round: 0 });
			expect(readShip(statePath)).toMatchObject({ phase: "pr-open", rounds: [] });
			expect(readShip(statePath)?.pending).toBeUndefined();
			expect((await ship("merge", failed)).output).toMatchObject({ ok: false, merged: false });
		}
		const recovered: ShipDeps = {
			...deps({ config: { reviewRetries: 0 }, threads: { ok: true, threads: [] } }),
			greptile: () => client,
			review: runReview,
		};
		expect((await ship("review", recovered)).output).toMatchObject({ ok: true, ready: true, passed: true, round: 1 });
		expect(readShip(statePath)?.rounds).toMatchObject([{ status: "completed", reviewId: "completed", score: 5 }]);
		expect((await ship("merge", recovered)).output).toMatchObject({ ok: true, merged: true });
	});

	test("review thread scans share the review call budget: an over-deadline scan stops fail-closed", async () => {
		const open = { body: "intended behavior", path: "a.ts", threadId: "T1" };
		const round: ReviewResult = { source: "pr", status: "completed", score: 5, comments: [open], headSha: "abc", at: 1 };
		writeShip(statePath, { pr: PR, rounds: [round] });
		// The refresh runs after entry, so the second clock read already passes the entry-now + waitMs deadline.
		const base = deps({ threads: { ok: true, threads: [] } });
		let reads = 0;
		const d: ShipDeps = { ...base, now: () => ((reads += 1) === 1 ? 1000 : 1000 + CONFIG.waitMs) };
		const out = await ship("review", d);
		expect(out.output).toMatchObject({ ok: false, ready: false });
		expect(String(out.output.reason)).toContain("review threads scan exceeded its deadline");
		expect(readShip(statePath)?.rounds).toMatchObject([{ comments: [open] }]);

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

		test("a tool error that persists to the timeout stays in the timed-out round's error", async () => {
			writeShip(statePath, { pr: PR, pending: { headSha: "abc", source: "pr", since: 2000 } });
			const failing = { ...pendingReview, source: "pr" as const, error: "list_code_reviews: Repository not found" };
			const early = await ship("review", deps({ review: failing, now: 2500 }));
			expect(early.output).toMatchObject({ status: "pending", error: "list_code_reviews: Repository not found", round: 0 });
			await ship("review", deps({ review: failing, now: 3001 }));
			expect(readShip(statePath)?.rounds).toMatchObject([
				{ status: "timeout", error: "review still pending after 1000ms (last error: list_code_reviews: Repository not found)" },
			]);
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

	test("review failing more than reviewRetries times on the same head blocks", async () => {
		writeShip(statePath, { pr: PR, rounds: [{ source: "cli", status: "failed", score: null, comments: [], headSha: "abc", at: 1 }] });
		const out = await ship("review", deps({ config: { maxRounds: 9, reviewRetries: 1 }, review: { status: "timeout", score: null } }));
		expect(String(out.output.next)).toBe("stop: Greptile review timed out 2 times on abc (ship.reviewRetries 1)");
		expect(readShip(statePath)?.phase).toBe("blocked");
		expect(comments).toHaveLength(1);
	});

	describe("failed Greptile review", () => {
		const failed: Partial<ReviewResult> = { status: "failed", score: null, reviewId: "run-1", error: "Greptile review FAILED" };

		test("is re-triggered with the failed review marked stale and never counts toward maxRounds", async () => {
			writeShip(statePath, { pr: PR, phase: "pr-open" });
			const first = await ship("review", deps({ review: failed }));
			expect(first.output).toMatchObject({
				ok: true,
				ready: false,
				passed: false,
				blocked: false,
				failedRounds: 0,
				next: "Greptile review failed: Greptile review FAILED; run review again to re-trigger it (retry 1 of 3)",
			});
			expect(reviewInputs[0]?.staleReviewIds).toEqual([]);
			const second = await ship("review", deps({ review: { ...failed, reviewId: "run-2" } }));
			expect(second.output).toMatchObject({ blocked: false, failedRounds: 0, round: 2 });
			expect(String(second.output.next)).toEndWith("run review again to re-trigger it (retry 2 of 3)");
			expect(reviewInputs[1]?.staleReviewIds).toEqual(["run-1"]);
			expect(readShip(statePath)?.phase).toBe("needs-fixes");
			expect(comments).toEqual([]);
			const passed = await ship("review", deps());
			expect(reviewInputs[2]?.staleReviewIds).toEqual(["run-1", "run-2"]);
			expect(passed.output).toMatchObject({ ready: true, passed: true, failedRounds: 0, round: 3 });
			expect(readShip(statePath)?.attempts?.map((a) => a.outcome)).toEqual(["failed", "failed", "passed"]);
		});

		test("blocks with one comment once the failures on one head exceed reviewRetries", async () => {
			writeShip(statePath, { pr: PR, phase: "pr-open" });
			const retryOnce = deps({ config: { reviewRetries: 1 }, review: failed });
			expect((await ship("review", retryOnce)).output).toMatchObject({ blocked: false });
			expect(comments).toEqual([]);
			const second = await ship("review", retryOnce);
			const reason = "Greptile review failed 2 times on abc (ship.reviewRetries 1): Greptile review FAILED";
			expect(second.output).toMatchObject({ blocked: true, failedRounds: 0, next: `stop: ${reason}` });
			expect(readShip(statePath)).toMatchObject({ phase: "blocked", blockedReason: reason });
			expect(comments).toHaveLength(1);
			expect(comments[0]).toContain("Attempts:");
			expect(comments[0]).toContain("review abc failed — Greptile review FAILED");
		});
	});

	test("merge on an already-merged PR whose head passed review skips merge but cleans up", async () => {
		writeShip(statePath, { pr: PR, rounds: [PASSED] });
		const out = await ship("merge", deps({ status: { state: "MERGED" } }));
		expect(out.output).toMatchObject({ ok: true, alreadyMerged: true });
		expect(calls).toEqual(["delete:feat", "sync:master"]);
		expect(readShip(statePath)?.phase).toBe("merged");
	});

	test("merge on a PR merged outside the flow without a passing review of its head blocks without cleanup", async () => {
		const reason = "PR was merged outside the ship flow before its review passed";
		for (const rounds of [[], [{ ...PASSED, score: 4 }], [{ ...PASSED, headSha: "old" }]]) {
			writeShip(statePath, { pr: PR, rounds, phase: "pr-open", blockedReason: undefined });
			const out = await ship("merge", deps({ status: { state: "MERGED" } }));
			expect(out.output).toMatchObject({ ok: false, merged: false, blocked: true, reason });
			expect(readShip(statePath)).toMatchObject({ phase: "blocked", blockedReason: reason });
		}
		expect(calls).toEqual([]);
		expect(comments).toEqual([]);
	});

	test("merge without a passing stored review goes back to the agent and never waits, even when the PR is unreadable", async () => {
		const cases: [ReviewResult[], string][] = [
			[[], "no review has run; run review again"],
			[[{ ...PASSED, score: 3 }], "review score 3/5 is below 5/5; run review again"],
		];
		for (const [rounds, next] of cases) {
			for (const statuses of [[null], []]) {
				writeShip(statePath, { pr: PR, rounds, phase: "needs-fixes" });
				const out = await ship("merge", deps({ statuses }));
				expect(out.output).toMatchObject({ ok: false, merged: false, next });
				expect(out.output.waiting).toBeUndefined();
				expect(readShip(statePath)?.phase).toBe("needs-fixes");
				expect(readShip(statePath)?.waiting).toBeUndefined();
			}
		}
		expect(sleeps).toEqual([]);
		expect(calls).toEqual([]);
		expect(comments).toEqual([]);
	});

	test("merge on closed PR blocks without deleting, with or without a review", async () => {
		for (const rounds of [[], [PASSED]]) {
			writeShip(statePath, { pr: PR, rounds, phase: "pr-open", blockedReason: undefined });
			const out = await ship("merge", deps({ status: { state: "CLOSED" } }));
			expect(out.output).toMatchObject({ ok: false, merged: false, blocked: true, reason: "PR closed without merge" });
			expect(readShip(statePath)?.phase).toBe("blocked");
		}
		expect(calls).toEqual([]);
		expect(comments).toEqual([]);
	});

	describe("review restart for a failed round without a review id", () => {
		const idless: ReviewResult = { source: "cli", status: "failed", score: null, comments: [], headSha: "abc", error: "no score", at: 1 };

		test("the next review restarts; once its fresh review is pending it is resumed, not restarted", async () => {
			writeShip(statePath, { pr: PR, rounds: [idless], phase: "needs-fixes" });
			await ship("review", deps({ review: { status: "pending", score: null } }));
			expect(reviewInputs[0]?.restart).toBe(true);
			await ship("review", deps());
			expect(reviewInputs[1]?.restart).toBeUndefined();
		});

		test("rounds with ids only mark those ids stale, without restart", async () => {
			writeShip(statePath, { pr: PR, rounds: [{ ...idless, reviewId: "run-1" }] });
			await ship("review", deps());
			expect(reviewInputs[0]).toMatchObject({ staleReviewIds: ["run-1"] });
			expect(reviewInputs[0]?.restart).toBeUndefined();
		});
	});

	test("merge substitutes an allowed method", async () => {
		writeShip(statePath, { pr: PR, rounds: [{ source: "cli", status: "completed", score: 5, comments: [], headSha: "abc", at: 1 }] });
		const out = await ship("merge", deps({ methods: ["rebase"], config: { deleteBranch: false } }));
		expect(out.output.method).toBe("rebase");
		expect(calls).toEqual(["merge:rebase:abc"]);
	});

	describe("merge retry loop", () => {
		const outcomes = () => readShip(statePath)?.attempts?.map((a) => a.outcome);
		beforeEach(() => {
			writeShip(statePath, { pr: PR, phase: "pr-open", rounds: [PASSED] });
		});

		test("CI pending on the first polls, then passing: merges within one call", async () => {
			const out = await ship("merge", deps({ statuses: [{ checks: "pending" }, { checks: "pending" }] }));
			expect(out.output).toMatchObject({ ok: true, merged: true, next: "run ultrathink-sync" });
			expect(sleeps).toEqual([10, 15]);
			expect(calls).toEqual(["merge:squash:abc", "delete:feat", "sync:master"]);
			expect(outcomes()).toEqual(["merged"]);
			expect(readShip(statePath)?.waiting).toBeUndefined();
		});

		test("a call that runs out of time waits without blocking; past mergeTimeoutMs on the head it blocks with one comment", async () => {
			const pending = deps({ status: { checks: "pending" } });
			const first = await ship("merge", pending);
			expect(first.output).toMatchObject({ ok: false, merged: false, waiting: true, reason: "CI checks pending", polls: 6, waitedMs: 100 });
			expect(String(first.output.next)).toStartWith("run merge again: CI checks pending (waited ");
			expect(first.output.blocked).toBeUndefined();
			expect(readShip(statePath)).toMatchObject({ phase: "pr-open", waiting: { headSha: "abc", since: 1000 } });
			expect(readShip(statePath)?.blockedReason).toBeUndefined();
			expect(outcomes()).toEqual(["waiting"]);
			expect(comments).toEqual([]);

			clock += CONFIG.mergeTimeoutMs;
			const late = await ship("merge", pending);
			expect(late.output).toMatchObject({ ok: false, merged: false, blocked: true, commented: true });
			expect(String(late.output.reason)).toStartWith("merge still not possible after ");
			expect(String(late.output.reason)).toEndWith(" min on abc: CI checks pending");
			expect(readShip(statePath)?.phase).toBe("blocked");
			expect(outcomes()).toEqual(["waiting", "blocked"]);
			expect(comments).toHaveLength(1);
			expect(comments[0]).toContain("merge still not possible");
			expect(comments[0]).toContain("Attempts:");
			expect(comments[0]).toContain("merge abc waiting — CI checks pending (6 poll(s))");
			await ship("merge", pending);
			expect(comments).toHaveLength(1);
			expect(calls.some((c) => c.startsWith("merge:"))).toBe(false);
		});

		test("a transient GitHub merge error is retried and merges in the same call", async () => {
			const out = await ship("merge", deps({ merges: [{ ok: false, error: "GraphQL: something went wrong" }] }));
			expect(out.output).toMatchObject({ ok: true, merged: true });
			expect(calls.filter((c) => c.startsWith("merge:"))).toEqual(["merge:squash:abc", "merge:squash:abc"]);
			expect(sleeps).toEqual([10]);
			expect(readShip(statePath)?.attempts).toMatchObject([
				{ step: "merge", outcome: "retry", detail: "merge failed: GraphQL: something went wrong" },
				{ step: "merge", outcome: "merged", score: 5 },
			]);
		});

		test("an access denial blocks with one comment", async () => {
			const error = "GraphQL: Resource not accessible by integration (mergePullRequest)";
			const out = await ship("merge", deps({ merges: [{ ok: false, error }] }));
			expect(out.output).toMatchObject({ blocked: true, reason: `merge refused by GitHub: ${error}`, commented: true });
			expect(comments).toHaveLength(1);
			expect(sleeps).toEqual([]);
		});

		test("a GitHub refusal only a human can clear blocks with one comment", async () => {
			const error = "At least 1 approving review is required by reviewers with write access.";
			const out = await ship("merge", deps({ merges: [{ ok: false, error }] }));
			const reason = `merge refused by GitHub: ${error}`;
			expect(out.output).toMatchObject({ ok: false, merged: false, blocked: true, reason, next: `stop: ${reason}` });
			expect(readShip(statePath)).toMatchObject({ phase: "blocked", blockedReason: reason });
			expect(comments).toHaveLength(1);
			expect(comments[0]).toContain(`**ultrathink-ship stopped:** ${reason}`);
			expect(sleeps).toEqual([]);
		});

		test("a GitHub merge conflict goes back to the agent without blocking", async () => {
			const error = "Pull Request has merge conflicts";
			const out = await ship("merge", deps({ merges: [{ ok: false, error }] }));
			expect(out.output).toMatchObject({ ok: false, merged: false, reason: error, next: `${error}; run review again` });
			expect(out.output.blocked).toBeUndefined();
			expect(readShip(statePath)?.phase).toBe("pr-open");
			expect(outcomes()).toEqual(["needs-agent"]);
			expect(comments).toEqual([]);
		});

		test("merge conflicts and failing CI go back to the agent without merging", async () => {
			const cases: [Partial<PrStatus>, string][] = [
				[{ mergeable: "CONFLICTING" }, "merge conflicts: resolve them against the base, push, then run review again"],
				[{ checks: "failing" }, "CI checks failing: fix CI, commit, push, then run review again"],
			];
			for (const [status, next] of cases) {
				const out = await ship("merge", deps({ status }));
				expect(out.output).toMatchObject({ ok: false, merged: false, next });
				expect(readShip(statePath)?.phase).toBe("pr-open");
			}
			expect(calls).toEqual([]);
			expect(comments).toEqual([]);
			expect(sleeps).toEqual([]);
		});

		test("a base branch policy refusal is retried until mergeTimeoutMs, then blocks with one comment", async () => {
			const error = "X Pull request #7 is not mergeable: the base branch policy prohibits the merge.";
			const refused = deps({ merges: Array.from({ length: 20 }, () => ({ ok: false, error })) });
			const first = await ship("merge", refused);
			expect(first.output).toMatchObject({ ok: false, merged: false, waiting: true, reason: `merge failed: ${error}` });
			expect(readShip(statePath)?.phase).toBe("pr-open");
			expect(comments).toEqual([]);
			clock += CONFIG.mergeTimeoutMs;
			const late = await ship("merge", refused);
			expect(late.output).toMatchObject({ blocked: true, commented: true });
			expect(String(late.output.reason)).toStartWith("merge still not possible after ");
			expect(String(late.output.reason)).toEndWith("the base branch policy prohibits the merge.");
			expect(comments).toHaveLength(1);
		});

		test("network and rate-limit errors are retried, not blocked", async () => {
			for (const error of [
				'Post "https://api.github.com/graphql": http2: server sent GOAWAY and closed the connection',
				"use of closed network connection",
				"HTTP 403: You have exceeded a secondary rate limit. Please wait a few minutes before you try again.",
			]) {
				calls = [];
				writeShip(statePath, { phase: "pr-open", blockedReason: undefined });
				const out = await ship("merge", deps({ merges: [{ ok: false, error }] }));
				expect(out.output).toMatchObject({ ok: true, merged: true });
				expect(calls.filter((c) => c.startsWith("merge:"))).toHaveLength(2);
			}
			expect(comments).toEqual([]);
		});

		test("an unreadable PR status never counts against a stale waiting head", async () => {
			writeShip(statePath, { waiting: { headSha: "old", since: 0 } });
			clock = 10 * CONFIG.mergeTimeoutMs;
			const out = await ship("merge", deps({ statuses: [null] }));
			expect(out.output).toMatchObject({ ok: true, merged: true });
			expect(comments).toEqual([]);
		});

		test("after a timeout block, a new review and merge start a fresh bound instead of blocking again", async () => {
			const pending = deps({ status: { checks: "pending" } });
			await ship("merge", pending);
			clock += CONFIG.mergeTimeoutMs;
			expect((await ship("merge", pending)).output).toMatchObject({ blocked: true });
			expect(readShip(statePath)?.waiting).toBeUndefined();
			expect((await ship("review", pending)).output).toMatchObject({ passed: true, blocked: false });
			expect(readShip(statePath)?.phase).toBe("pr-open");
			const again = await ship("merge", pending);
			expect(again.output).toMatchObject({ ok: false, waiting: true });
			expect(again.output.blocked).toBeUndefined();
			expect(comments).toHaveLength(1);
		});

		test("merge without any review round goes back to the agent", async () => {
			writeShip(statePath, { rounds: [] });
			const out = await ship("merge", deps());
			expect(out.output).toMatchObject({ ok: false, merged: false, reason: "no review has run", next: "no review has run; run review again" });
			expect(calls).toEqual([]);
		});

		test("run merges once CI passes when the review passed while CI was pending", async () => {
			writeShip(statePath, { pr: undefined, rounds: [], phase: "not-done" });
			const out = await ship("run", deps({ statuses: [{ checks: "pending" }, { checks: "pending" }] }));
			expect(out.output).toMatchObject({
				ok: true,
				review: { passed: true, ready: false },
				merge: { ok: true, merged: true },
				next: "run ultrathink-sync",
			});
			expect(sleeps).toEqual([10]);
			expect(calls).toEqual(["push:feat", "create:master<-feat", "review:7:abc", "merge:squash:abc", "delete:feat", "sync:master"]);
		});
	});
});

// Jev ship decision point through `ultrathink-ship assess` and `pr`. Canonical Decisions fixtures, defined per test file.
const K = "sk-or-v1-UTTESTKEY-0123456789abcdef";
interface Recorded {
	url: string;
	method: string;
	headers: Record<string, string>;
	body: unknown;
}

/** Recording fetch R: records every call, answers from a queue (last entry repeats). Installed as globalThis.fetch too. */
function recordingFetch(queue: Array<() => Response | Promise<Response>>): { fetch: typeof fetch; calls: Recorded[] } {
	const calls: Recorded[] = [];
	const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
		const headers: Record<string, string> = {};
		new Headers(init?.headers).forEach((value, key) => {
			headers[key] = value;
		});
		const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : init?.body;
		calls.push({ url: String(input), method: init?.method ?? "GET", headers, body });
		const next = queue[Math.min(calls.length, queue.length) - 1];
		if (!next) throw new Error("empty queue");
		return next();
	}) as typeof fetch;
	globalThis.fetch = fetchImpl;
	return { fetch: fetchImpl, calls };
}

const JEV =
	(p: number, key = "plan_worthy") =>
	() =>
		Response.json({
			id: "gen-dec-test",
			model: "typesafe/jev-1.13-20260917",
			provider: "TypeSafe",
			answers: { [key]: { type: "noul", noul: p } },
			usage: { input_tokens: 450, output_tokens: 0, cost: 0.000019 },
		});
const ERR = (s: number, headers?: Record<string, string>) => () =>
	Response.json({ error: { code: s, message: `upstream said no for ${K}` } }, { status: s, headers });

/** Never resolves; rejects with an AbortError when its signal fires (as src/grok/complete.test.ts hangingFetch). */
function hangingFetch(onCall?: () => void): typeof fetch {
	return ((_input: string | URL | Request, init?: RequestInit) =>
		new Promise<Response>((_resolve, reject) => {
			init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
			onCall?.();
		})) as typeof fetch;
}

const COMPLETE = "complete";
const MODEL = "typesafe/jev-1.13-20260917";
const JEV_ON: DecisionsConfig = { ...DEFAULT_DECISIONS_CONFIG, enabled: true, points: [...DEFAULT_DECISIONS_CONFIG.points] };
const DONE_REPLY = JSON.stringify({ done: true, confidence: 0.9, summary: "ok", gaps: [] });
/** A session record the real judge can read (the shared fixture has no spec XML). */
const SPEC_STATE = JSON.stringify({
	sessionId: "s",
	at: 1,
	result: { xml: "<spec/>", original: "ship it", root: "", source: "llm" },
	kickedOff: true,
});
const realFetch = globalThis.fetch;

/** Every failure of AC-4.1–4.9, as a fresh fetch per runtime. */
const FAILURES: { name: string; kind: DecisionsErrorKind; fetch: () => typeof fetch; timeoutMs?: number }[] = [
	{ name: "401", kind: "auth", fetch: () => recordingFetch([ERR(401)]).fetch },
	{ name: "402", kind: "credits", fetch: () => recordingFetch([ERR(402)]).fetch },
	{ name: "400", kind: "bad-request", fetch: () => recordingFetch([ERR(400)]).fetch },
	{ name: "429 twice", kind: "rate-limit", fetch: () => recordingFetch([ERR(429)]).fetch },
	...[500, 502, 503, 524, 529].map((status) => ({
		name: `${status} twice`,
		kind: "upstream" as const,
		fetch: () => recordingFetch([ERR(status)]).fetch,
	})),
	{ name: "a hanging request", kind: "timeout", fetch: () => hangingFetch(), timeoutMs: 50 },
	{ name: "a body that is not JSON", kind: "invalid-response", fetch: () => recordingFetch([() => new Response("{not json")]).fetch },
	{
		name: "a missing answer key",
		kind: "invalid-response",
		fetch: () =>
			recordingFetch([
				() => Response.json({ model: MODEL, answers: {}, usage: { input_tokens: 450, output_tokens: 0, cost: 0.000019 } }),
			]).fetch,
	},
	{ name: "a noul out of range", kind: "invalid-response", fetch: () => recordingFetch([JEV(1.5, COMPLETE)]).fetch },
];

/** T6: the key and a bearer header never reach a collected output. */
function expectNoKey(...outputs: unknown[]): void {
	for (const output of outputs) {
		const text = typeof output === "string" ? output : JSON.stringify(output);
		expect(text).not.toContain(K);
		expect(text).not.toContain("Bearer sk-or-");
	}
}

describe("runShip assess with Jev (DP-SHIP)", () => {
	let bodies: string[];
	let debug: string[];
	beforeEach(() => {
		bodies = [];
		debug = [];
		writeFileSync(statePath, SPEC_STATE);
	});
	afterEach(() => {
		globalThis.fetch = realFetch;
	});

	/** The real assessDone with a Jev runtime (K only in its injected env), an optional judge reply and PR bodies captured. */
	function jevShip(o: {
		fetch: typeof fetch;
		judge?: string;
		config?: Partial<ShipConfig>;
		decisions?: Partial<DecisionsConfig>;
		env?: Record<string, string | undefined>;
	}): ShipDeps {
		const base = deps({ config: o.config });
		const github = base.github(dir);
		const { judge } = o;
		return {
			...base,
			assess: assessDone,
			engine: async () => (judge === undefined ? undefined : async () => judge),
			github: () => ({ ...github, createPr: (input) => (bodies.push(input.body), github.createPr(input)) }),
			decisions: (record) =>
				createDecisions({
					config: { ...JEV_ON, ...o.decisions },
					sessionId: record.sessionId,
					env: o.env ?? { OPENROUTER_API_KEY: K },
					storePath: join(dir, "mcp-credentials.json"),
					fetch: o.fetch,
					sleep: async () => {},
					random: () => 0.5,
					debug: (line) => debug.push(line),
				}),
		};
	}

	test("Decisions killed: zero requests, and assess JSON and PR body equal the run without a Jev runtime", async () => {
		const r = recordingFetch([JEV(0.03, COMPLETE)]);
		const d = jevShip({ fetch: r.fetch, judge: DONE_REPLY, env: { OPENROUTER_API_KEY: K, ULTRATHINK_DECISIONS: "0" } });
		const baseline = await ship("assess", { ...d, decisions: undefined });
		expect((await ship("pr", { ...d, decisions: undefined })).output.ok).toBe(true);
		writeFileSync(statePath, SPEC_STATE);
		const off = await ship("assess", d);
		expect(off.output).toEqual(baseline.output);
		expect((await ship("pr", d)).output.ok).toBe(true);
		expect(bodies).toHaveLength(2);
		expect(bodies[1]).toBe(bodies[0]);
		expect(bodies[1]).not.toContain("Jev");
		expect(r.calls).toHaveLength(0);
	});

	test("under autoMerge a Jev-only verdict never stands in for the judge: main's outcome, Jev recorded as none", async () => {
		const offline = jevShip({ fetch: recordingFetch([JEV(0.95, COMPLETE)]).fetch });
		const throwing: ShipDeps = {
			...offline,
			engine: async () => async () => {
				throw new Error("offline");
			},
		};
		const cases: [ShipDeps, string][] = [
			[offline, "no judge available"],
			[throwing, "assessment unavailable: offline"],
		];
		for (const [d, gap] of cases) {
			writeFileSync(statePath, SPEC_STATE);
			const out = await ship("assess", d);
			expect(out.output).toMatchObject({ ok: true, done: false, decision: { p: 0.95, model: MODEL, action: "none" } });
			expect(out.output.gaps).toContain(gap);
			expect("source" in out.output).toBe(false);
			expect(readShip(statePath)?.assessment).toMatchObject({ done: false, decision: { action: "none" } });
			expect((await ship("pr", d)).output).toMatchObject({ ok: false, reason: "task not assessed as done; run assess first" });
		}
		expect(bodies).toEqual([]);

		writeFileSync(statePath, SPEC_STATE);
		const vetoed = await ship("assess", jevShip({ fetch: recordingFetch([JEV(0.03, COMPLETE)]).fetch, judge: DONE_REPLY }));
		expect(vetoed.output).toMatchObject({ ok: true, done: false, decision: { p: 0.03, action: "veto" } });
	});

	test("without autoMerge a Jev approval stands in for a missing judge (AC-6.4)", async () => {
		const r = recordingFetch([JEV(0.79, COMPLETE)]);
		const out = await ship("assess", jevShip({ fetch: r.fetch, config: { autoMerge: false } }));
		expect(out.output).toMatchObject({ ok: true, done: true, source: "jev", gaps: [], decision: { p: 0.79, model: MODEL, action: "approve" } });
		expect(readShip(statePath)?.assessment).toMatchObject({ done: true, source: "jev" });
		expect(r.calls).toHaveLength(1);
	});

	test("advisory mode ships and the PR body ends ## Assessment with the Jev line (AC-6.10)", async () => {
		const cases: [number, string][] = [
			[0.94, `- Jev: P(complete) 0.94 · ${MODEL}`],
			[0.03, `- Jev: P(complete) 0.03 · ${MODEL} · veto (advisory: shipped anyway)`],
		];
		for (const [p, line] of cases) {
			writeFileSync(statePath, SPEC_STATE);
			const d = jevShip({ fetch: recordingFetch([JEV(p, COMPLETE)]).fetch, judge: DONE_REPLY, config: { judge: "advisory" } });
			const assess = await ship("assess", d);
			expect(assess.output).toMatchObject({ ok: true, done: true, mode: "advisory", decision: { p, model: MODEL } });
			expect((await ship("pr", d)).output.ok).toBe(true);
			const section = bodies.at(-1)?.split("## Assessment\n\n")[1]?.split("\n\n")[0]?.trimEnd() ?? "";
			expect(section.split("\n").at(-1)).toBe(line);
		}
	});

	test("assess JSON carries the decision and the stored assessment the DecisionRecord (AC-6.11)", async () => {
		const ok = await ship("assess", jevShip({ fetch: recordingFetch([JEV(0.94, COMPLETE)]).fetch, judge: DONE_REPLY }));
		expect(ok.output).toMatchObject({ ok: true, done: true });
		expect(ok.output.decision).toEqual({ p: 0.94, model: MODEL, action: "none" });
		expect("source" in ok.output).toBe(false);
		expect(readShip(statePath)?.assessment?.decision).toMatchObject({
			point: "ship",
			outcome: "ok",
			model: MODEL,
			id: "gen-dec-test",
			p: 0.94,
			probabilities: { complete: 0.94 },
			action: "none",
			threshold: 0.2,
			attempts: 1,
			cost: 0.000019,
		});
		const okState = readFileSync(statePath, "utf8");

		writeFileSync(statePath, SPEC_STATE);
		const failed = await ship("assess", jevShip({ fetch: recordingFetch([ERR(402)]).fetch, judge: DONE_REPLY }));
		expect(failed.output).toMatchObject({ ok: true, done: true });
		expect(failed.output.decision).toEqual({ action: "fail-open", error: "credits" });
		expect(readShip(statePath)?.assessment?.decision).toMatchObject({
			point: "ship",
			outcome: "error",
			error: "credits",
			action: "fail-open",
			probabilities: {},
			attempts: 1,
		});
		expectNoKey(ok.output, failed.output, okState, readFileSync(statePath, "utf8"), debug);
	});

	for (const failure of FAILURES) {
		test(`${failure.name}: assess fails open and its JSON and PR body name the kind (AC-4.12)`, async () => {
			const decisions: Partial<DecisionsConfig> = { points: ["ship"], ...(failure.timeoutMs ? { timeoutMs: failure.timeoutMs } : {}) };
			const judged = jevShip({ fetch: failure.fetch(), judge: DONE_REPLY, decisions });
			const baseline = await ship("assess", { ...judged, decisions: undefined });
			const withJudge = await ship("assess", judged);
			const { decision, ...rest } = withJudge.output;
			expect(rest).toEqual(baseline.output);
			expect(rest).toMatchObject({ ok: true, done: true, gaps: [] });
			expect(decision).toEqual({ action: "fail-open", error: failure.kind });
			expect((await ship("pr", judged)).output.ok).toBe(true);
			const body = bodies.at(-1) ?? "";
			const section = body.split("## Assessment\n\n")[1]?.split("\n\n")[0]?.trimEnd() ?? "";
			expect(section.split("\n").at(-1)).toBe(`- Jev: error (${failure.kind})`);

			writeFileSync(statePath, SPEC_STATE);
			const bare = jevShip({ fetch: failure.fetch(), decisions });
			const bareBaseline = await ship("assess", { ...bare, decisions: undefined });
			const withoutJudge = await ship("assess", bare);
			const { decision: bareDecision, ...bareRest } = withoutJudge.output;
			expect(bareRest).toEqual(bareBaseline.output);
			expect(bareRest).toMatchObject({ done: false, gaps: ["no judge available"] });
			expect(bareDecision).toEqual({ action: "fail-open", error: failure.kind });
			expectNoKey(withJudge.output, withoutJudge.output, body, readFileSync(statePath, "utf8"), debug);
		});
	}
});
