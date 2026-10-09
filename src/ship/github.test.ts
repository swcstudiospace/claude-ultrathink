// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import type { SessionRecord } from "../claude/state.ts";
import { classifyChecks, createGithub } from "./github.ts";
import type { ReviewThread, ReviewThreads } from "./github.ts";
import { mergeGate } from "./merge.ts";
import { buildPr } from "./pr-body.ts";
import { DEFAULT_SHIP_CONFIG } from "./types.ts";
import type { Assessment, PrStatus, ReviewResult, Run } from "./types.ts";

type Reply = { exitCode?: number; stdout?: string; stderr?: string };

function fakeRun(respond: (argv: string[]) => Reply) {
	const calls: { argv: string[]; stdin?: string; timeoutMs?: number; cwd?: string }[] = [];
	const run: Run = (argv, opts) => {
		calls.push({ argv, stdin: opts?.stdin, timeoutMs: opts?.timeoutMs, cwd: opts?.cwd });
		const r = respond(argv);
		return { exitCode: r.exitCode ?? 0, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
	};
	return { run, calls };
}

const PR_JSON = { number: 7, url: "https://github.com/o/r/pull/7", headRefName: "feat", baseRefName: "master" };

describe("createGithub", () => {
	test("repo parses name and default branch; failure is undefined", () => {
		const { run, calls } = fakeRun(() => ({
			stdout: JSON.stringify({ nameWithOwner: "o/r", defaultBranchRef: { name: "master" } }),
		}));
		expect(createGithub({ cwd: "/w", run }).repo()).toEqual({ name: "o/r", defaultBranch: "master" });
		expect(calls[0]?.cwd).toBe("/w");
		expect(createGithub({ cwd: "/w", run: fakeRun(() => ({ stdout: "nope" })).run }).repo()).toBeUndefined();
		expect(createGithub({ cwd: "/w", run: fakeRun(() => ({ exitCode: 1 })).run }).repo()).toBeUndefined();
	});

	test("push reports the first stderr line on failure", () => {
		const { run, calls } = fakeRun(() => ({ exitCode: 1, stderr: "rejected: non-fast-forward\nhint" }));
		expect(createGithub({ cwd: "/w", run }).push("feat")).toEqual({ ok: false, error: "rejected: non-fast-forward" });
		expect(calls[0]?.argv).toEqual(["git", "push", "-u", "origin", "feat"]);
		expect(calls[0]?.timeoutMs).toBe(180_000);
	});

	test("findOpenPr returns none or the first PR", () => {
		expect(createGithub({ cwd: "/w", run: fakeRun(() => ({ stdout: "[]" })).run }).findOpenPr("feat")).toBeUndefined();
		const gh = createGithub({ cwd: "/w", run: fakeRun(() => ({ stdout: JSON.stringify([PR_JSON]) })).run });
		expect(gh.findOpenPr("feat")).toEqual({ number: 7, url: PR_JSON.url, head: "feat", base: "master" });
	});

	test("createPr pipes body on stdin and reads back the PR", () => {
		const { run, calls } = fakeRun((argv) =>
			argv[2] === "create" ? { stdout: `Creating...\n${PR_JSON.url}\n` } : { stdout: JSON.stringify(PR_JSON) },
		);
		const pr = createGithub({ cwd: "/w", run }).createPr({ base: "master", head: "feat", title: "T", body: "B\nody" });
		expect(pr).toEqual({ number: 7, url: PR_JSON.url, head: "feat", base: "master" });
		expect(calls[0]?.argv).toEqual([
			"gh", "pr", "create", "--base", "master", "--head", "feat", "--title", "T", "--body-file", "-",
		]);
		expect(calls[0]?.stdin).toBe("B\nody");
		expect(calls[1]?.argv.slice(0, 4)).toEqual(["gh", "pr", "view", PR_JSON.url]);
	});

	test("createPr failure returns error", () => {
		const gh = createGithub({ cwd: "/w", run: fakeRun(() => ({ exitCode: 1, stderr: "already exists" })).run });
		expect(gh.createPr({ base: "m", head: "h", title: "t", body: "b" })).toEqual({ error: "already exists" });
	});

	test.each([
		[[], "none"],
		[undefined, "none"],
		[[{ status: "COMPLETED", conclusion: "SUCCESS" }, { state: "SUCCESS" }], "passing"],
		[[{ status: "COMPLETED", conclusion: "NEUTRAL" }], "passing"],
		[[{ status: "IN_PROGRESS" }], "pending"],
		[[{ status: "QUEUED" }], "pending"],
		[[{ state: "PENDING" }], "pending"],
		[[{ state: "EXPECTED" }], "pending"],
		[[{ status: "IN_PROGRESS" }, { status: "COMPLETED", conclusion: "FAILURE" }], "failing"],
		[[{ status: "COMPLETED", conclusion: "CANCELLED" }], "failing"],
		[[{ status: "COMPLETED", conclusion: "TIMED_OUT" }], "failing"],
		[[{ status: "COMPLETED", conclusion: "ACTION_REQUIRED" }], "failing"],
		[[{ status: "COMPLETED", conclusion: "STARTUP_FAILURE" }], "failing"],
		[[{ state: "ERROR" }], "failing"],
		[[{ state: "FAILURE" }], "failing"],
	] as [unknown, PrStatus["checks"]][])("classifyChecks %j -> %s", (rollup, expected) => {
		expect(classifyChecks(rollup)).toBe(expected);
	});

	test("prStatus parses fields and normalizes mergeable", () => {
		const { run } = fakeRun(() => ({
			stdout: JSON.stringify({
				state: "OPEN",
				headRefOid: "abc",
				mergeable: "WHATEVER",
				statusCheckRollup: [{ status: "QUEUED" }],
				url: PR_JSON.url,
			}),
		}));
		expect(createGithub({ cwd: "/w", run }).prStatus(7)).toEqual({
			state: "OPEN",
			headSha: "abc",
			mergeable: "UNKNOWN",
			checks: "pending",
			url: PR_JSON.url,
		});
		expect(createGithub({ cwd: "/w", run: fakeRun(() => ({ stdout: "{}" })).run }).prStatus(7)).toBeUndefined();
	});

	const prView = (state: string) => ({
		stdout: JSON.stringify({ state, headRefOid: "sha1", mergeable: "UNKNOWN", statusCheckRollup: [], url: "u" }),
	});

	test.each(["squash", "merge", "rebase"] as const)("merge --%s never deletes the branch and confirms MERGED", (method) => {
		const { run, calls } = fakeRun((argv) => (argv[2] === "view" ? prView("MERGED") : {}));
		expect(createGithub({ cwd: "/w", run }).merge({ number: 7, method, headSha: "sha1" })).toEqual({ ok: true });
		expect(calls[0]?.argv).toEqual(["gh", "pr", "merge", "7", `--${method}`, "--match-head-commit", "sha1"]);
		expect(calls[1]?.argv.slice(0, 4)).toEqual(["gh", "pr", "view", "7"]);
	});

	test("merge is not ok unless the PR reads back MERGED", () => {
		const failed = fakeRun((argv) => (argv[2] === "view" ? prView("OPEN") : { exitCode: 1, stderr: "head commit mismatch" }));
		expect(createGithub({ cwd: "/w", run: failed.run }).merge({ number: 7, method: "squash", headSha: "x" })).toEqual({
			ok: false,
			error: "head commit mismatch",
		});
		const queued = fakeRun((argv) => (argv[2] === "view" ? prView("OPEN") : {}));
		expect(createGithub({ cwd: "/w", run: queued.run }).merge({ number: 7, method: "squash", headSha: "x" })).toEqual({
			ok: false,
			error: "PR is OPEN after merge",
		});
		// A non-zero exit whose merge actually landed still counts.
		const landed = fakeRun((argv) => (argv[2] === "view" ? prView("MERGED") : { exitCode: 1, stderr: "local fail" }));
		expect(createGithub({ cwd: "/w", run: landed.run }).merge({ number: 7, method: "squash", headSha: "x" }).ok).toBe(true);
	});

	test("deleteRemoteBranch treats an already-deleted ref as ok", () => {
		const { run, calls } = fakeRun(() => ({ exitCode: 1, stderr: "error: unable to delete 'feat': remote ref does not exist" }));
		expect(createGithub({ cwd: "/w", run }).deleteRemoteBranch("feat")).toEqual({ ok: true });
		expect(calls[0]?.argv).toEqual(["git", "push", "origin", "--delete", "feat"]);
		const denied = fakeRun(() => ({ exitCode: 1, stderr: "permission denied" }));
		expect(createGithub({ cwd: "/w", run: denied.run }).deleteRemoteBranch("feat")).toEqual({
			ok: false,
			error: "permission denied",
		});
	});

	test("comment pipes the body on stdin", () => {
		const { run, calls } = fakeRun(() => ({}));
		expect(createGithub({ cwd: "/w", run }).comment(7, "score 3/5")).toEqual({ ok: true });
		expect(calls[0]?.argv).toEqual(["gh", "pr", "comment", "7", "--body-file", "-"]);
		expect(calls[0]?.stdin).toBe("score 3/5");
	});

	test("mergeMethods lists allowed methods; empty on failure", () => {
		const { run } = fakeRun(() => ({
			stdout: JSON.stringify({ squashMergeAllowed: true, mergeCommitAllowed: false, rebaseMergeAllowed: true }),
		}));
		expect(createGithub({ cwd: "/w", run }).mergeMethods()).toEqual(["squash", "rebase"]);
		expect(createGithub({ cwd: "/w", run: fakeRun(() => ({ exitCode: 1 })).run }).mergeMethods()).toEqual([]);
		expect(createGithub({ cwd: "/w", run: fakeRun(() => ({ stdout: "x" })).run }).mergeMethods()).toEqual([]);
	});

	const node = (o: { resolved?: boolean; outdated?: boolean; login?: string | null; line?: number | null } = {}) => ({
		id: "T1",
		isResolved: o.resolved ?? false,
		isOutdated: o.outdated ?? false,
		comments: {
			nodes: [
				{
					author: o.login === null ? null : { login: o.login ?? "greptile-apps" },
					path: "a.ts",
					line: o.line === undefined ? 3 : o.line,
					originalLine: 9,
					body: "fix",
				},
			],
		},
	});
	const graphql = (nodes: unknown[], hasNextPage = false) => ({
		stdout: JSON.stringify({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage }, nodes } } } } }),
	});
	const thread = { id: "T1", isResolved: false, isOutdated: false, author: "greptile-apps", path: "a.ts", line: 3, body: "fix" };

	test.each<[string, Reply, ReviewThreads]>([
		["open", graphql([node()]), { ok: true, threads: [thread] }],
		["resolved", graphql([node({ resolved: true })]), { ok: true, threads: [{ ...thread, isResolved: true }] }],
		[
			"outdated falls back to its original line",
			graphql([node({ outdated: true, line: null })]),
			{ ok: true, threads: [{ ...thread, isOutdated: true, line: 9 }] },
		],
		["non-Greptile and deleted authors are dropped", graphql([node({ login: "octocat" }), node({ login: null })]), { ok: true, threads: [] }],
		["gh failure", { exitCode: 1, stderr: "gh: HTTP 502\nmore" }, { ok: false, error: "gh: HTTP 502" }],
		["graphql errors", { stdout: JSON.stringify({ errors: [{ message: "Could not resolve to a PullRequest" }] }) }, { ok: false, error: "Could not resolve to a PullRequest" }],
		["missing pull request", { stdout: JSON.stringify({ data: { repository: { pullRequest: null } } }) }, { ok: false, error: "pull request review threads missing" }],
	])("reviewThreads: %s", (_name, reply, expected) => {
		const { run, calls } = fakeRun((argv) =>
			argv[1] === "repo" ? { stdout: JSON.stringify({ nameWithOwner: "o/r", defaultBranchRef: { name: "master" } }) } : reply,
		);
		expect(createGithub({ cwd: "/w", run }).reviewThreads(7)).toEqual(expected);
		const argv = calls[1]?.argv ?? [];
		expect(argv.slice(0, 3)).toEqual(["gh", "api", "graphql"]);
		expect(argv.slice(-6)).toEqual(["-f", "owner=o", "-f", "name=r", "-F", "number=7"]);
		expect(argv.some((a) => a.startsWith("after="))).toBe(false);
		expect(calls).toHaveLength(2);
	});

	describe("reviewThreads pagination", () => {
		const REPO_REPLY = { stdout: JSON.stringify({ nameWithOwner: "o/r", defaultBranchRef: { name: "master" } }) };
		/** A page of `count` thread nodes; every third one is by another author, every fifth resolved, every seventh outdated. */
		const pageNodes = (tag: string, count: number) =>
			Array.from({ length: count }, (_unused, i) => ({
				id: `${tag}-${i}`,
				isResolved: i % 5 === 0,
				isOutdated: i % 7 === 0,
				comments: {
					nodes: [{ author: { login: i % 3 === 0 ? "octocat" : "greptile-apps" }, path: "a.ts", line: i + 1, originalLine: 0, body: `finding ${tag}-${i}` }],
				},
			}));
		const expectedThreads = (tag: string, count: number): ReviewThread[] =>
			pageNodes(tag, count).flatMap((n) => {
				const comment = n.comments.nodes[0];
				if (!comment || comment.author.login !== "greptile-apps") return [];
				return [
					{
						id: n.id,
						isResolved: n.isResolved,
						isOutdated: n.isOutdated,
						author: "greptile-apps",
						path: "a.ts",
						line: comment.line,
						body: comment.body,
					},
				];
			});
		const page = (nodes: unknown[], endCursor?: string | null, hasNextPage = endCursor !== undefined) => ({
			stdout: JSON.stringify({
				data: {
					repository: {
						pullRequest: {
							reviewThreads: { pageInfo: hasNextPage ? { hasNextPage, endCursor } : { hasNextPage }, nodes },
						},
					},
				},
			}),
		});
		const after = (argv: string[]) => argv.find((a) => a.startsWith("after="));
		/** Answers `gh repo view`, then hands each GraphQL call the next scripted reply (the last one repeats). */
		const threadsOf = (...replies: Reply[]) => {
			let n = 0;
			const fake = fakeRun((argv) => (argv[1] === "repo" ? REPO_REPLY : (replies[Math.min(n++, replies.length - 1)] ?? {})));
			const result = createGithub({ cwd: "/w", run: fake.run }).reviewThreads(7);
			return { result, graphqlCalls: fake.calls.filter((c) => c.argv[1] === "api") };
		};

		test("100 or fewer threads take one request without a cursor", () => {
			const { result, graphqlCalls } = threadsOf(page(pageNodes("a", 100)));
			expect(result).toEqual({ ok: true, threads: expectedThreads("a", 100) });
			expect(graphqlCalls).toHaveLength(1);
			expect(graphqlCalls[0]?.argv.some((a) => a.includes("after="))).toBe(false);
		});

		test("follows cursors across three pages and keeps page order and thread flags", () => {
			const { result, graphqlCalls } = threadsOf(
				page(pageNodes("p1", 100), "c1"),
				page(pageNodes("p2", 100), "c2"),
				page(pageNodes("p3", 50)),
			);
			expect(result).toEqual({
				ok: true,
				threads: [...expectedThreads("p1", 100), ...expectedThreads("p2", 100), ...expectedThreads("p3", 50)],
			});
			expect(graphqlCalls).toHaveLength(3);
			expect(after(graphqlCalls[0]?.argv ?? [])).toBeUndefined();
			expect(after(graphqlCalls[1]?.argv ?? [])).toBe("after=c1");
			expect(after(graphqlCalls[2]?.argv ?? [])).toBe("after=c2");
			expect(graphqlCalls[1]?.argv.slice(-2)).toEqual(["-f", "after=c1"]);
			if (result.ok) {
				expect(result.threads.some((t) => t.isResolved)).toBe(true);
				expect(result.threads.some((t) => t.isOutdated)).toBe(true);
				expect(result.threads.every((t) => t.author === "greptile-apps")).toBe(true);
			}
		});

		test.each<[string, Reply, string]>([
			[
				"graphql errors",
				{ stdout: JSON.stringify({ errors: [{ message: "rate limited" }] }) },
				"rate limited",
			],
			["a non-zero exit", { exitCode: 1, stderr: "gh: HTTP 502\nmore" }, "gh: HTTP 502"],
			["unparseable output", { stdout: "<html>" }, "unparseable review threads response"],
			["a malformed thread", page([{ id: "x", comments: { nodes: [] } }]), "malformed review thread"],
			[
				"a Greptile thread without a boolean flag",
				page([{ id: "x", isResolved: "no", isOutdated: false, comments: { nodes: [{ author: { login: "greptile-apps" }, body: "b" }] } }]),
				"malformed review thread",
			],
		])("a later page failing (%s) fails closed with no partial threads", (_name, bad, error) => {
			const { result, graphqlCalls } = threadsOf(page(pageNodes("p1", 100), "c1"), bad);
			expect(result).toEqual({ ok: false, error });
			expect("threads" in result).toBe(false);
			expect(graphqlCalls).toHaveLength(2);
		});

		test.each<[string, string | null | undefined]>([
			["null", null],
			["empty", ""],
			["missing", undefined],
		])("hasNextPage with a %s endCursor fails closed", (_name, cursor) => {
			const first = threadsOf(page(pageNodes("p1", 100), cursor, true));
			expect(first.result).toEqual({ ok: false, error: "review threads pagination did not advance" });
			expect(first.graphqlCalls).toHaveLength(1);
			const later = threadsOf(page(pageNodes("p1", 100), "c1"), page(pageNodes("p2", 100), cursor, true));
			expect(later.result).toEqual({ ok: false, error: "review threads pagination did not advance" });
			expect(later.graphqlCalls).toHaveLength(2);
		});

		test("a non-string endCursor fails closed", () => {
			const reply = {
				stdout: JSON.stringify({
					data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: true, endCursor: 5 }, nodes: [] } } } },
				}),
			};
			expect(threadsOf(reply).result).toEqual({ ok: false, error: "review threads pagination did not advance" });
		});

		test("a repeated cursor stops the loop", () => {
			const { result, graphqlCalls } = threadsOf(page(pageNodes("p1", 100), "same"));
			expect(result).toEqual({ ok: false, error: "review threads pagination did not advance" });
			expect(graphqlCalls).toHaveLength(2);
			expect(after(graphqlCalls[1]?.argv ?? [])).toBe("after=same");
		});

		test("an endless server is cut off at 20 pages", () => {
			let n = 0;
			const fake = fakeRun((argv) => (argv[1] === "repo" ? REPO_REPLY : page(pageNodes("p", 100), `c${++n}`)));
			const result = createGithub({ cwd: "/w", run: fake.run }).reviewThreads(7);
			expect(result).toEqual({ ok: false, error: "more than 2000 review threads" });
			expect(fake.calls.filter((c) => c.argv[1] === "api")).toHaveLength(20);
		});

		test("a scan past its deadline stops early with no partial threads", () => {
			// Each page burns 30s off the caller's 100s wait budget via the injected clock: no sleeps, no timers.
			let now = 0;
			const fake = fakeRun((argv) => {
				if (argv[1] === "repo") return REPO_REPLY;
				now += 30_000;
				return page(pageNodes(`p${now}`, 100), `c${now}`);
			});
			const result = createGithub({ cwd: "/w", run: fake.run }).reviewThreads(7, { deadlineMs: 100_000, now: () => now });
			expect(result).toEqual({ ok: false, error: "review threads scan exceeded its deadline" });
			expect("threads" in result).toBe(false);
			const graphqlCalls = fake.calls.filter((c) => c.argv[1] === "api");
			expect(graphqlCalls.length).toBeGreaterThan(0);
			expect(graphqlCalls.length).toBeLessThan(20);
		});

		test("an already-spent deadline fails closed without paging", () => {
			const fake = fakeRun((argv) => (argv[1] === "repo" ? REPO_REPLY : page(pageNodes("p", 100), "c1")));
			const result = createGithub({ cwd: "/w", run: fake.run }).reviewThreads(7, { deadlineMs: 100_000, now: () => 100_000 });
			expect(result).toEqual({ ok: false, error: "review threads scan exceeded its deadline" });
			expect(fake.calls.filter((c) => c.argv[1] === "api")).toHaveLength(0);
		});

		test("a scan within its deadline still pages to the end", () => {
			const replies = Array.from({ length: 3 }, (_unused, i) => page(pageNodes(`p${i}`, 100), i < 2 ? `c${i}` : undefined));
			let n = 0;
			const fake = fakeRun((argv) => (argv[1] === "repo" ? REPO_REPLY : (replies[Math.min(n++, replies.length - 1)] ?? {})));
			const result = createGithub({ cwd: "/w", run: fake.run }).reviewThreads(7, { deadlineMs: 100_000, now: () => 0 });
			expect(result).toEqual({
				ok: true,
				threads: [...expectedThreads("p0", 100), ...expectedThreads("p1", 100), ...expectedThreads("p2", 100)],
			});
			expect(fake.calls.filter((c) => c.argv[1] === "api")).toHaveLength(3);
		});

		test("exactly 20 full pages still succeed", () => {
			const replies = Array.from({ length: 20 }, (_unused, i) => page(pageNodes(`p${i}`, 100), i < 19 ? `c${i}` : undefined));
			const { result, graphqlCalls } = threadsOf(...replies);
			expect(result.ok).toBe(true);
			expect(graphqlCalls).toHaveLength(20);
		});
	});

	test("reviewThreads fails without a resolvable repo", () => {
		const { run, calls } = fakeRun(() => ({ exitCode: 1 }));
		expect(createGithub({ cwd: "/w", run }).reviewThreads(7)).toEqual({ ok: false, error: "could not resolve GitHub repo" });
		expect(calls.length).toBe(1);
	});

	test("syncBase deletes the local branch when it exists and is not current", () => {
		const { run, calls } = fakeRun((argv) => (argv[1] === "rev-parse" && argv[2] === "--abbrev-ref" ? { stdout: "master\n" } : {}));
		expect(createGithub({ cwd: "/w", run }).syncBase({ base: "master", branch: "feat" })).toEqual({ ok: true });
		expect(calls.map((c) => c.argv)).toContainEqual(["git", "checkout", "master"]);
		expect(calls.map((c) => c.argv)).toContainEqual(["git", "pull", "--ff-only", "origin", "master"]);
		expect(calls.at(-1)?.argv).toEqual(["git", "branch", "-D", "feat"]);
	});

	test("syncBase skips -D when still on the branch or branch is gone", () => {
		const onBranch = fakeRun((argv) => (argv[2] === "--abbrev-ref" ? { stdout: "feat\n" } : {}));
		createGithub({ cwd: "/w", run: onBranch.run }).syncBase({ base: "master", branch: "feat" });
		expect(onBranch.calls.some((c) => c.argv.includes("-D"))).toBe(false);
		const gone = fakeRun((argv) =>
			argv[2] === "--verify" ? { exitCode: 1 } : argv[2] === "--abbrev-ref" ? { stdout: "master" } : {},
		);
		createGithub({ cwd: "/w", run: gone.run }).syncBase({ base: "master", branch: "feat" });
		expect(gone.calls.some((c) => c.argv.includes("-D"))).toBe(false);
	});

	test("syncBase stops when checkout fails", () => {
		const { run, calls } = fakeRun(() => ({ exitCode: 1, stderr: "local changes" }));
		expect(createGithub({ cwd: "/w", run }).syncBase({ base: "master", branch: "feat" })).toEqual({
			ok: false,
			error: "local changes",
		});
		expect(calls).toHaveLength(1);
	});
});

describe("buildPr", () => {
	const base = {
		sessionId: "s",
		at: 1,
		result: { xml: "", original: "Fix the widget\nmore detail in /root/secret/file.ts", root: "" },
	} as unknown as SessionRecord;

	test("title from first line of original, sections without assessment", () => {
		const { title, body } = buildPr(base);
		expect(title).toBe("Fix the widget");
		expect(body).toContain("## Summary");
		expect(body).not.toContain("/root/");
		expect(body).not.toContain("## Assessment");
		expect(body).not.toContain("## Linked issues");
		expect(body).not.toContain("ultrathink graph");
	});

	test("goal truncated to 72 chars; linked issues, assessment and footer", () => {
		const record = {
			...base,
			graph: { goal: "x".repeat(100), nodes: [] },
			plan: { graphId: "g-1" },
			tracking: {
				linear: { nodes: { n1: { id: "1", identifier: "ENG-12", url: "https://linear.app/i/ENG-12", title: "Do\u0007 it" } }, steps: {} },
				notion: { taskUrl: "https://notion.so/t", nodes: {}, steps: {} },
			},
		} as unknown as SessionRecord;
		const { title, body } = buildPr(record, {
			done: true,
			confidence: 0.9,
			summary: "All phases verified",
			gaps: ["docs"],
			signals: { git: { onBase: false, ahead: 1, dirty: [], untracked: 0, pushed: true } },
			source: "llm",
			at: 1,
		});
		expect(title).toHaveLength(72);
		expect(title.endsWith("…")).toBe(true);
		expect(body).toContain("## Summary\n\nAll phases verified");
		expect(body).toContain("Fixes ENG-12 — Do it\nhttps://linear.app/i/ENG-12");
		expect(body).toContain("https://notion.so/t");
		expect(body).toContain("- Done: yes");
		expect(body).toContain("  - docs");
		expect(body).toContain("ultrathink graph g-1");
	});

	const assessment: Assessment = {
		done: true,
		confidence: 0.6,
		summary: "ok",
		gaps: [],
		signals: { git: { onBase: false, ahead: 1, dirty: [], untracked: 0, pushed: true } },
		source: "llm",
		at: 1,
	};

	test("advisory assessment renders the judge verdict, error and notes, scrubbed", () => {
		const { body } = buildPr(base, {
			...assessment,
			mode: "advisory",
			judge: { done: false, confidence: 0.6, summary: "", gaps: ["docs in /root/x.md", "tests"], error: "timeout\u0007" },
		});
		expect(body).toContain("- Judge (advisory): done no, confidence 0.6, error: timeout\n");
		expect(body).toContain("- Judge notes:\n  - docs in <local path>\n  - tests");
		expect(body).not.toContain("/root/");
	});

	test("gate assessment renders no judge line", () => {
		const { body } = buildPr(base, {
			...assessment,
			mode: "gate",
			judge: { done: false, confidence: 0.6, summary: "", gaps: ["docs"] },
		});
		expect(body).toContain("- Done: yes");
		expect(body).not.toContain("Judge");
	});
});

describe("mergeGate", () => {
	const status: PrStatus = { state: "OPEN", headSha: "h", mergeable: "MERGEABLE", checks: "passing", url: "u" };
	const review: ReviewResult = { source: "pr", status: "completed", score: 5, comments: [], headSha: "h", at: 1 };
	const config = DEFAULT_SHIP_CONFIG;

	test.each([
		["no review", undefined, {}, "no review"],
		["not completed", { status: "timeout" }, {}, "review timeout"],
		["stale", { headSha: "old" }, {}, "older commit"],
		["null score", { score: null }, {}, "no score"],
		["low score", { score: 4 }, {}, "below"],
		["comments", { comments: [{ body: "fix" }] }, {}, "open review comment"],
		["closed", {}, { state: "CLOSED" }, "PR is closed"],
		["conflicts", {}, { mergeable: "CONFLICTING" }, "merge conflicts"],
		["unknown", {}, { mergeable: "UNKNOWN" }, "not computed mergeability"],
		["failing", {}, { checks: "failing" }, "failing"],
		["pending", {}, { checks: "pending" }, "pending"],
	] as [string, Partial<ReviewResult> | undefined, Partial<PrStatus>, string][])(
		"%s blocks merge",
		(_name, reviewPatch, statusPatch, reason) => {
			const latest = reviewPatch === undefined ? undefined : { ...review, ...reviewPatch };
			const gate = mergeGate({ config, status: { ...status, ...statusPatch }, latest });
			expect(gate.ok).toBe(false);
			expect(gate.reason).toContain(reason);
		},
	);

	test("comments allowed when requireNoComments is off; ok case", () => {
		const latest = { ...review, comments: [{ body: "nit" }] };
		expect(mergeGate({ config: { ...config, requireNoComments: false }, status, latest })).toEqual({
			ok: true,
			reason: "ready to merge",
		});
		expect(mergeGate({ config, status, latest: review })).toEqual({ ok: true, reason: "ready to merge" });
	});
});
