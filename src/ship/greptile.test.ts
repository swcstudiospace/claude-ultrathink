// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import { findGreptileRepo, parseScore, reviewCli, reviewPr, runReview, type ToolCaller } from "./greptile.ts";
import type { Run, ShipConfig } from "./types.ts";

const repo = { name: "acme/app", remote: "github" as const, defaultBranch: "master" };
const config: ShipConfig = {
	enabled: true,
	autoMerge: true,
	skills: ["gsd-"],
	minScore: 5,
	requireNoComments: true,
	maxRounds: 5,
	mergeMethod: "squash",
	deleteBranch: true,
	reviewTimeoutMs: 1000,
	pollMs: 100,
	waitMs: 1000,
};

function fakeClient(handlers: Record<string, (args: Record<string, unknown>, n: number) => unknown>) {
	const calls: { name: string; args: Record<string, unknown> }[] = [];
	const counts: Record<string, number> = {};
	const client: ToolCaller = {
		async call(name, args) {
			calls.push({ name, args });
			counts[name] = (counts[name] ?? 0) + 1;
			const handler = handlers[name];
			if (!handler) throw new Error(`unexpected ${name}`);
			return handler(args, counts[name]);
		},
	};
	return { client, calls };
}

function clock() {
	let t = 0;
	const sleeps: number[] = [];
	return {
		now: () => t,
		sleep: async (ms: number) => {
			sleeps.push(ms);
			t += ms;
		},
		sleeps,
	};
}

describe("parseScore", () => {
	test.each([
		['...Retrigger" align="right"></picture></a>Confidence Score: 3/5</h2>', 3],
		["**Confidence Score:   5 / 5**", 5],
		["confidence score of 4/5 overall", 4],
		["confidence score: <b>0/5</b>", 0],
		["no score here", null],
		["Confidence Score: 7/5", null],
	])("%s -> %p", (body, expected) => {
		expect(parseScore(body)).toBe(expected);
	});
});

describe("findGreptileRepo", () => {
	test("pages and matches case-insensitively", async () => {
		const { client } = fakeClient({
			list_repositories: (args) =>
				args.page === 0
					? { repositories: [{ name: "acme/other", remote: "github", defaultBranch: "main" }], total: 150 }
					: { repositories: [{ name: "ACME/App", remote: "github", defaultBranch: "master", reviewsEnabled: false }], total: 150 },
		});
		expect(await findGreptileRepo(client, "acme/app")).toEqual({
			name: "ACME/App",
			remote: "github",
			defaultBranch: "master",
			reviewsEnabled: false,
		});
	});

	test("errors -> undefined", async () => {
		const { client } = fakeClient({});
		expect(await findGreptileRepo(client, "acme/app")).toBeUndefined();
	});
});

describe("reviewPr", () => {
	const base = { repo, prNumber: 7, headSha: "new", timeoutMs: 1000, pollMs: 100 };

	test("completes on second poll with matching sha, ignoring stale reviews", async () => {
		const { client } = fakeClient({
			trigger_code_review: () => ({ success: true }),
			list_code_reviews: (_args, n) => ({
				codeReviews: [
					{ id: "1", status: "COMPLETED", commitSha: "old", createdAt: "2026-01-02T00:00:00Z" },
					...(n >= 2 ? [{ id: "2", status: "COMPLETED", commitSha: "new", createdAt: "2026-01-01T00:00:00Z" }] : []),
				],
			}),
			get_code_review: (args) => ({
				codeReview: { id: args.codeReviewId, body: "<h2>Confidence Score: 4/5</h2>" },
			}),
			list_merge_request_comments: () => ({
				comments: [
					{ body: "fix this", path: "a.ts", startLine: 3, severity: "P1", isGreptileComment: true, addressed: false },
					{ body: "done", isGreptileComment: true, addressed: true },
					{ body: '<a href="#"><img alt="P2" src="https://greptile.com/p2.svg"></a> **Nit** rename', path: "b.ts", isGreptileComment: true },
				],
			}),
		});
		const result = await reviewPr({ client, ...base, ...clock() });
		expect(result).toMatchObject({
			source: "pr",
			status: "completed",
			score: 4,
			reviewId: "2",
			headSha: "new",
			comments: [
				{ body: "fix this", path: "a.ts", line: 3, severity: "P1" },
				{ path: "b.ts", severity: "P2" },
			],
		});
	});

	test("failed status", async () => {
		const { client } = fakeClient({
			trigger_code_review: () => ({}),
			list_code_reviews: (_args, n) => ({
				codeReviews: n >= 2 ? [{ id: "3", status: "FAILED", commitSha: "new" }] : [],
			}),
		});
		expect(await reviewPr({ client, ...base, ...clock() })).toMatchObject({ status: "failed", score: null });
	});

	test("reuses an existing completed review for headSha without triggering", async () => {
		const { client, calls } = fakeClient({
			list_code_reviews: () => ({ codeReviews: [{ id: "5", status: "COMPLETED", commitSha: "new" }] }),
			get_code_review: () => ({ codeReview: { body: "Confidence Score: 5/5" } }),
			list_merge_request_comments: () => ({ comments: [] }),
		});
		expect(await reviewPr({ client, ...base, ...clock() })).toMatchObject({ status: "completed", score: 5 });
		expect(calls.some((c) => c.name === "trigger_code_review")).toBe(false);
	});

	test("open comments are the head review's: older reviews' unaddressed comments do not block", async () => {
		const { client } = fakeClient({
			list_code_reviews: () => ({
				codeReviews: [
					{ id: "2", status: "COMPLETED", commitSha: "new", createdAt: "2026-09-25T05:35:34Z" },
					{ id: "1", status: "COMPLETED", commitSha: "old", createdAt: "2026-09-25T05:32:49Z" },
				],
			}),
			get_code_review: () => ({ codeReview: { body: "Confidence Score: 5/5" } }),
			list_merge_request_comments: () => ({
				comments: [
					{ body: "fixed by the next commit", filePath: "a.ts", createdAt: "2026-09-25T05:34:48Z", addressed: false },
					{ body: "raised by the head review", filePath: "b.ts", createdAt: "2026-09-25T05:36:10Z", addressed: false },
					{ body: "undated stays open", filePath: "c.ts", addressed: false },
				],
			}),
		});
		const result = await reviewPr({ client, ...base, ...clock() });
		expect(result.comments.map((c) => c.body)).toEqual(["raised by the head review", "undated stays open"]);
	});

	test("re-triggers when the only review for headSha failed, ignoring it afterwards", async () => {
		const { client, calls } = fakeClient({
			trigger_code_review: () => ({}),
			list_code_reviews: (_args, n) => ({
				codeReviews: [
					{ id: "6", status: "FAILED", commitSha: "new" },
					...(n >= 2 ? [{ id: "7", status: "COMPLETED", commitSha: "new" }] : []),
				],
			}),
			get_code_review: () => ({ codeReview: { body: "Confidence Score: 5/5" } }),
			list_merge_request_comments: () => ({ comments: [] }),
		});
		expect(await reviewPr({ client, ...base, ...clock() })).toMatchObject({ status: "completed", reviewId: "7" });
		expect(calls.filter((c) => c.name === "trigger_code_review").length).toBe(1);
	});

	test("completed review without a parseable score fails", async () => {
		const { client } = fakeClient({
			list_code_reviews: () => ({ codeReviews: [{ id: "8", status: "COMPLETED", commitSha: "new" }] }),
			get_code_review: () => ({ codeReview: { body: "Looks good, no comments" } }),
			list_merge_request_comments: () => ({ comments: [] }),
		});
		expect(await reviewPr({ client, ...base, ...clock() })).toMatchObject({
			status: "failed",
			score: null,
			error: "score not found in Greptile review body",
		});
	});

	test("pending (not timeout) when the wait elapses; the review keeps running", async () => {
		const { client, calls } = fakeClient({
			list_code_reviews: () => ({ codeReviews: [{ id: "4", status: "REVIEWING_FILES", commitSha: "new" }] }),
		});
		const time = clock();
		const result = await reviewPr({ client, ...base, timeoutMs: 200_000, pollMs: 20_000, ...time });
		expect(result).toMatchObject({ source: "pr", status: "pending", score: null, comments: [], headSha: "new", reviewId: "4" });
		expect(time.sleeps).toEqual([20_000, 30_000, 45_000, 60_000, 45_000]);
		expect(calls.some((c) => c.name === "trigger_code_review")).toBe(false);
	});

	test("tool error -> failed", async () => {
		const { client } = fakeClient({
			list_code_reviews: () => ({ codeReviews: [] }),
			trigger_code_review: () => {
				throw new Error("boom");
			},
		});
		expect(await reviewPr({ client, ...base, ...clock() })).toMatchObject({ status: "failed", error: "boom" });
	});
});

type Reply = { exitCode: number; stdout?: string; stderr?: string };

function fakeRun(reply: (argv: string[], opts: { timeoutMs?: number }) => Reply) {
	const argvs: string[][] = [];
	const run: Run = (argv, opts = {}) => {
		argvs.push(argv);
		return { stdout: "", stderr: "", ...reply(argv, opts) };
	};
	return { run, argvs };
}

describe("reviewCli", () => {
	const SHA = "0123456789abcdef0123456789abcdef01234567";
	const STATUS = ["greptile", "review", "status", "--commit", SHA, "--json"];
	const START = ["greptile", "review", "--json", "-b", "main"];
	const status = (fields: Record<string, unknown>): Reply => ({
		exitCode: fields.status === "IN_FLIGHT" ? 3 : 0,
		stdout: JSON.stringify({ commit: SHA, headSha: SHA, runId: "run-1", ...fields }),
	});
	const inFlight = status({ status: "IN_FLIGHT", confidence: null });
	const notFound: Reply = { exitCode: 1, stderr: "no review found for commit" };
	const review = (run: Run, time = clock()) =>
		reviewCli({ run, cwd: "/x", base: "main", headSha: SHA, waitMs: 100_000, pollMs: 20_000, ...time });

	test("completed status is reused: score from status, comments from show, no new review", async () => {
		const { run, argvs } = fakeRun((argv) =>
			argv[2] === "status"
				? status({ status: "COMPLETED", commentCount: 1, confidence: 4 })
				: {
						exitCode: 0,
						stdout: JSON.stringify({
							confidence: 4,
							comments: [{ path: "b.ts", startLine: 9, body: '<img alt="P1" src="p1.svg"> null deref', securityIssue: false }],
						}),
					},
		);
		const time = clock();
		expect(await review(run, time)).toMatchObject({
			source: "cli",
			status: "completed",
			score: 4,
			headSha: SHA,
			reviewId: "run-1",
			comments: [{ path: "b.ts", line: 9, severity: "P1", securityIssue: false }],
		});
		expect(argvs).toEqual([STATUS, ["greptile", "review", "show", "run-1", "--json"]]);
		expect(time.sleeps).toEqual([]);
	});

	test("comments embedded in the status JSON skip show; show supplies a missing confidence", async () => {
		const embedded = fakeRun(() => status({ confidence: 5, comments: [] }));
		expect(await review(embedded.run)).toMatchObject({ status: "completed", score: 5, comments: [] });
		expect(embedded.argvs).toEqual([STATUS]);
		const shown = fakeRun((argv) =>
			argv[2] === "status" ? status({ confidence: null }) : { exitCode: 0, stdout: JSON.stringify({ confidence: 3, comments: [] }) },
		);
		expect(await review(shown.run)).toMatchObject({ status: "completed", score: 3 });
	});

	test("in flight for the whole wait -> pending with the runId, never starts a review", async () => {
		const { run, argvs } = fakeRun(() => inFlight);
		const time = clock();
		expect(await review(run, time)).toMatchObject({ source: "cli", status: "pending", score: null, reviewId: "run-1", headSha: SHA });
		expect(time.sleeps).toEqual([20_000, 30_000, 45_000, 5_000]);
		expect(argvs.every((argv) => argv[2] === "status")).toBe(true);
	});

	test("in flight, then completed on a later poll", async () => {
		let polls = 0;
		const { run, argvs } = fakeRun((argv) => {
			if (argv[2] === "show") return { exitCode: 0, stdout: JSON.stringify({ comments: [] }) };
			polls++;
			return polls < 3 ? inFlight : status({ status: "COMPLETED", confidence: 5 });
		});
		const time = clock();
		expect(await review(run, time)).toMatchObject({ status: "completed", score: 5, comments: [] });
		expect(time.sleeps).toEqual([20_000, 30_000]);
		expect(argvs.some((argv) => argv[2] === "--json")).toBe(false);
	});

	test.each([
		["no review for the commit", notFound],
		["status for another commit", status({ commit: "fedcba9876543210", headSha: "fedcba9876543210", confidence: 5 })],
	])("%s -> starts greptile review --json -b main and parses it", async (_name, reply) => {
		const { run, argvs } = fakeRun((argv, opts) => {
			if (argv[2] === "status") return reply;
			expect(opts.timeoutMs).toBe(100_000);
			return {
				exitCode: 0,
				stdout: JSON.stringify({ confidence: 3, comments: [{ path: "c.ts", lineStart: 2, body: "race", severity: "P0", securityIssue: true }] }),
			};
		});
		expect(await review(run)).toMatchObject({
			status: "completed",
			score: 3,
			headSha: SHA,
			comments: [{ path: "c.ts", line: 2, body: "race", severity: "P0", securityIssue: true }],
		});
		expect(argvs).toEqual([STATUS, START]);
	});

	test("start killed by the wait -> pending (it keeps running server-side)", async () => {
		const time = clock();
		const { run } = fakeRun((argv, opts) => {
			if (argv[2] === "status") return notFound;
			void time.sleep(opts.timeoutMs ?? 0);
			return { exitCode: 1 };
		});
		expect(await review(run, time)).toMatchObject({ status: "pending", score: null, headSha: SHA });
	});

	test("start exiting non-zero before the wait -> failed with truncated stderr", async () => {
		const { run } = fakeRun((argv) => (argv[2] === "status" ? notFound : { exitCode: 2, stderr: "x".repeat(500) }));
		const result = await review(run);
		expect(result.status).toBe("failed");
		expect(result.error?.length).toBe(300);
	});

	test.each([
		["status without confidence", () => status({ confidence: null, comments: [] })],
		["status score out of range", () => status({ confidence: 7, comments: [] })],
		["started review without confidence", (argv: string[]) => (argv[2] === "status" ? notFound : { exitCode: 0, stdout: JSON.stringify({ comments: [] }) })],
	])("%s -> failed", async (_name, reply) => {
		const { run } = fakeRun(reply);
		expect(await review(run)).toMatchObject({ status: "failed", score: null, error: "score not found in greptile review" });
	});

	test("bad JSON from the started review -> failed", async () => {
		const { run } = fakeRun((argv) => (argv[2] === "status" ? notFound : { exitCode: 0, stdout: "not json" }));
		expect((await review(run)).status).toBe("failed");
	});
});

describe("runReview", () => {
	const input = { config, cwd: "/x", repo: "acme/app", base: "master", prNumber: 7, headSha: "new" };
	const cliOut = { exitCode: 0, stdout: JSON.stringify({ confidence: 2, comments: [] }) };
	const cliRun = () => fakeRun((argv) => (argv[2] === "status" ? { exitCode: 1 } : cliOut));

	test("CLI mode when repo is not listed", async () => {
		const { client } = fakeClient({ list_repositories: () => ({ repositories: [], total: 0 }) });
		const { run, argvs } = cliRun();
		const result = await runReview({ ...input, client, run });
		expect(argvs).toEqual([
			["greptile", "review", "status", "--commit", "new", "--json"],
			["greptile", "review", "--json", "-b", "master"],
		]);
		expect(result).toMatchObject({ source: "cli", score: 2, headSha: "new" });
	});

	test("CLI mode when reviews are disabled", async () => {
		const { client } = fakeClient({
			list_repositories: () => ({ repositories: [{ ...repo, reviewsEnabled: false }], total: 1 }),
		});
		const { run } = cliRun();
		expect((await runReview({ ...input, client, run })).source).toBe("cli");
	});

	test("PR mode when repo is listed", async () => {
		const { client, calls } = fakeClient({
			list_repositories: () => ({ repositories: [{ ...repo, reviewsEnabled: true }], total: 1 }),
			list_code_reviews: () => ({ codeReviews: [] }),
			trigger_code_review: () => {
				throw new Error("stop");
			},
		});
		const { run, argvs } = cliRun();
		const result = await runReview({ ...input, client, run });
		expect(argvs.length).toBe(0);
		expect(result).toMatchObject({ source: "pr", status: "failed", headSha: "new" });
		expect(calls.find((c) => c.name === "trigger_code_review")?.args).toMatchObject({ name: "acme/app", remote: "github", defaultBranch: "master", prNumber: 7 });
	});
});
