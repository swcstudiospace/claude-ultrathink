// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, describe, expect, test } from "bun:test";
import { closeSync, existsSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type SessionRecord, writeControl, writeSession } from "../claude/state.ts";
import { escapeXml } from "../uplift/xml.ts";
import { planPrompt } from "./plan.ts";
import {
	checkRecord,
	thinkingOff,
	createJournalCompleter,
	deepenTargets,
	GROKBOT_LABEL,
	hostResolution,
	installDecisionsJournal,
	journalDir,
	listPending,
	type PendingRequest,
	runGrokbotPlan,
	stageOf,
	storeAnswer,
	validateClarify,
	validateGraph,
	validateNodeFill,
	validateUplift,
} from "./grokbot.ts";
import { buildTrackPayloads, graphRegisterPayload, recordRefs } from "./grokbot-track.ts";
import { buildCloudPrompt, DEFAULT_DESK_RULES, unitSubissueCount, untrackedSpec, validateCloudPrompt, wellFormed } from "./grokbot-prompts.ts";
import { dirFetcher, grokbotStatusLines, main, promoteGuard, reviewRead } from "./grokbot-cli.ts";
import { normalizeTranscript } from "./grokbot.ts";
import { mirrorLast, parseAnswersInput, recordAnswers } from "./grokbot-hitl.ts";
import { skillsStatus } from "./grokbot-skills.ts";
import { grokbotDigest } from "./grokbot-teach.ts";
import { conversationFromJsonl } from "../claude/transcript.ts";
import { injectTrackingXml, stripTrackingXml } from "../track/render.ts";
import { parseDigest } from "../teach/digest.ts";
import { mkdirSync } from "node:fs";
import { MAX_STEPS } from "../think/types.ts";
import { writeFileSync } from "node:fs";
import { COT_SYSTEM_PROMPT, GRAPH_SYSTEM_PROMPT } from "../think/prompts.ts";
import { UPLIFT_SYSTEM_PROMPT } from "../uplift/prompt.ts";

const PROMPT = "Build a small TypeScript CLI that converts CSV files to JSON with streaming support, tests and a README.";
const dirs: string[] = [];
const tmp = (): string => {
	const dir = mkdtempSync(join(tmpdir(), "ut-grokbot-"));
	dirs.push(dir);
	return dir;
};
afterEach(() => {
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const testEnv = (root: string): Record<string, string | undefined> => ({
	HOME: root,
	XDG_CONFIG_HOME: join(root, "xdg"),
	ULTRATHINK_DECISIONS: "0",
	PATH: process.env.PATH,
});

const UPLIFT = (original: string) =>
	`<BUILD_PROMPT><ORIGINAL>${escapeXml(original)}</ORIGINAL><SYSTEM_ROLE>Senior TypeScript engineer.</SYSTEM_ROLE><APP_CONTEXT>A standalone CLI.</APP_CONTEXT><SCOPE>CSV to JSON with streaming.</SCOPE><CONSTRAINTS>Do not invent repo facts.</CONSTRAINTS><ACCEPTANCE_CRITERIA>Converts a 1 GB file in bounded memory.</ACCEPTANCE_CRITERIA><OUT_OF_SCOPE>XLSX input.</OUT_OF_SCOPE></BUILD_PROMPT>`;

const GRAPH = JSON.stringify({
	goal: "Ship a streaming CSV to JSON CLI",
	nodes: [
		{ id: "n1", title: "Understand the request", kind: "understand", question: "What exactly must the CLI do?", depends_on: [] },
		{ id: "n2", title: "Parser design", kind: "decompose", question: "How is CSV parsed as a stream?", depends_on: ["n1"] },
		{ id: "n3", title: "CLI surface", kind: "generate", question: "What flags and outputs does the CLI expose?", depends_on: ["n1"] },
		{ id: "n4", title: "Gaps and risks", kind: "critique", question: "What is missing or ambiguous?", depends_on: ["n2", "n3"] },
		{ id: "n5", title: "Execution plan", kind: "synthesize", question: "What is the ordered wave plan?", depends_on: ["n4"] },
	],
});

const steps = (n: number, id: string) => Array.from({ length: n }, (_, i) => `${i + 1}. Step ${i + 1} of ${id}: a discrete, self-contained action.`).join("\n");

const NODE = (id: string, kind: string, n: number) => {
	let conclusion = `Answer for ${id}.`;
	if (kind === "critique") conclusion += "\nOpen questions:\n- Output as JSON lines or array? Default: array.";
	if (kind === "synthesize") conclusion += "\nWORKFLOW\nWave 1 (parallel): parser — files: src/parse.ts — done when: unit tests pass\nWave 1 (parallel): cli — files: src/cli.ts — done when: --help prints\nWave 2: docs — files: README.md — done when: README lists flags\nVerify: bun test";
	return `<node><rationale>\n${steps(n, id)}\n</rationale><conclusion>${conclusion}</conclusion></node>`;
};

const CLARIFY = JSON.stringify({
	questions: [{ id: "q1", question: "Should output be a JSON array or JSON lines?", header: "Output", why: "Changes the writer.", options: [{ label: "JSON array", description: "Standard" }, { label: "JSON lines", description: "Streamable" }], default: "JSON array", blocking: false }],
});

/** The scripted host model: answers each plugin request by its system prompt. */
function hostModel(stepsPerNode = 8) {
	return (system: string, user: string): string => {
		if (system === UPLIFT_SYSTEM_PROMPT) return UPLIFT(PROMPT);
		if (system === GRAPH_SYSTEM_PROMPT) return GRAPH;
		if (system === COT_SYSTEM_PROMPT) {
			const match = user.match(/<current_node id="([^"]+)" kind="([^"]+)"/);
			return NODE(match?.[1] ?? "n?", match?.[2] ?? "generate", stepsPerNode);
		}
		if (stageOf(system) === "clarify") return CLARIFY;
		throw new Error(`unexpected request: ${system.slice(0, 40)}`);
	};
}

async function drive(stateDir: string, cwd: string, model: (s: string, u: string) => string, sessionId = "s1") {
	const passes: Array<Array<Pick<PendingRequest, "stage" | "nodeId">>> = [];
	for (let pass = 0; pass < 12; pass++) {
		const result = await runGrokbotPlan({ sessionId, prompt: PROMPT, cwd, stateDir, env: testEnv(cwd), debounceMs: 20 });
		if (result.status !== "needs-model") return { result, passes };
		passes.push(result.pending.map(({ stage, nodeId }) => ({ stage, nodeId })));
		const dir = journalDir(stateDir, sessionId);
		for (const request of listPending(dir)) {
			const stored = storeAnswer(dir, request.key, model(request.system, request.user));
			expect(stored.errors).toEqual([]);
		}
	}
	throw new Error("plan did not converge");
}

describe("grok-bot journal driver", () => {
	test("suspends per stage, collects sibling nodes together, and resumes to a validated plan", async () => {
		const root = tmp();
		const stateDir = join(root, "state");
		const { result, passes } = await drive(stateDir, root, hostModel(8));
		expect(result.status).toBe("planned");
		expect(passes[0]).toEqual([{ stage: "uplift", nodeId: undefined }]);
		expect(passes[1]).toEqual([{ stage: "graph", nodeId: undefined }]);
		expect(passes[2]).toEqual([{ stage: "cot", nodeId: "n1" }]);
		expect(passes[3]?.map((p) => p.nodeId).sort()).toEqual(["n2", "n3"]);
		expect(result.check?.nodes).toBe(5);
		expect(result.check?.totalSteps).toBe(40);
		expect(result.check?.belowBand).toBe(false);
		expect(result.check?.degraded).toEqual([]);
		const record = JSON.parse(readFileSync(result.response?.statePath as string, "utf8")) as SessionRecord;
		expect(record.engine).toBe(GROKBOT_LABEL);
		expect(record.result.source).toBe("llm");
		expect(record.kickedOff).toBeFalsy();
		expect(record.tracking).toBeUndefined();
		expect(existsSync(result.response?.specPath as string)).toBe(true);
	});

	test("matches a direct planPrompt run with the same answers (parity)", async () => {
		const root = tmp();
		const { result } = await drive(join(root, "a"), root, hostModel(6));
		const model = hostModel(6);
		const direct = await planPrompt(
			{ host: "prime-agent", session_id: "s1", prompt: PROMPT, cwd: root },
			{ ...testEnv(root), ULTRATHINK_SHIP: "0" },
			{ stateDir: join(root, "b"), selectEngine: async () => ({ label: GROKBOT_LABEL, complete: async (s, u) => model(s, u), error: () => undefined, resolution: hostResolution() }), createTracker: () => undefined },
		);
		const a = JSON.parse(readFileSync(result.response?.statePath as string, "utf8")) as SessionRecord;
		const b = JSON.parse(readFileSync(direct.statePath as string, "utf8")) as SessionRecord;
		expect(a.graph?.nodes.map((n) => [n.id, n.thinking, n.conclusion])).toEqual(b.graph?.nodes.map((n) => [n.id, n.thinking, n.conclusion]) as never);
		expect(a.clarifications).toEqual(b.clarifications);
		expect(a.result.root).toBe(b.result.root);
	});

	test("replays answered requests and marks a below-band BUILD plan for deepening", async () => {
		const root = tmp();
		const stateDir = join(root, "state");
		const { result } = await drive(stateDir, root, hostModel(5));
		expect(result.status).toBe("planned");
		expect(result.check?.totalSteps).toBe(25);
		expect(result.check?.belowBand).toBe(true);
		expect(deepenTargets(result.check!)).toHaveLength(5);
		const cached = await runGrokbotPlan({ sessionId: "s1", prompt: PROMPT, cwd: root, stateDir, env: testEnv(root), debounceMs: 20 });
		expect(cached.replayed).toBe(0);
		expect(cached.response?.statePath).toBe(result.response?.statePath);
		const again = await runGrokbotPlan({ sessionId: "s1", prompt: PROMPT, cwd: root, stateDir, env: testEnv(root), debounceMs: 20, replan: true });
		expect(again.status).toBe("planned");
		expect(again.pending).toEqual([]);
		expect(again.replayed).toBeGreaterThanOrEqual(7);
	});

	test("refuses a different original for the same session", async () => {
		const root = tmp();
		const stateDir = join(root, "state");
		await runGrokbotPlan({ sessionId: "s1", prompt: PROMPT, cwd: root, stateDir, env: testEnv(root), debounceMs: 5 });
		await expect(runGrokbotPlan({ sessionId: "s1", prompt: "something else entirely, build a thing", cwd: root, stateDir, env: testEnv(root) })).rejects.toThrow(/different original/);
	});

	test("an invalid answer is never stored", async () => {
		const root = tmp();
		const stateDir = join(root, "state");
		await runGrokbotPlan({ sessionId: "s1", prompt: PROMPT, cwd: root, stateDir, env: testEnv(root), debounceMs: 5 });
		const dir = journalDir(stateDir, "s1");
		const [request] = listPending(dir);
		const bad = storeAnswer(dir, request!.key, UPLIFT("a paraphrase of the request"));
		expect(bad.ok).toBe(false);
		expect(existsSync(join(dir, "answers"))).toBe(false);
		expect(listPending(dir)).toHaveLength(1);
	});
});

describe("grok-bot validators", () => {
	test("uplift needs a known root, verbatim ORIGINAL and every required section", () => {
		expect(validateUplift(UPLIFT(PROMPT), PROMPT).ok).toBe(true);
		expect(validateUplift(UPLIFT(PROMPT).replace(/<OUT_OF_SCOPE>.*<\/OUT_OF_SCOPE>/, ""), PROMPT).errors.join()).toMatch(/OUT_OF_SCOPE/);
		expect(validateUplift("plain prose", PROMPT).ok).toBe(false);
	});
	test("graph needs 5-8 nodes, understand first, synthesize last and a critique", () => {
		expect(validateGraph(GRAPH, PROMPT).ok).toBe(true);
		const four = JSON.parse(GRAPH);
		four.nodes.splice(2, 1);
		expect(validateGraph(JSON.stringify(four), PROMPT).ok).toBe(false);
		const noCritique = JSON.parse(GRAPH);
		noCritique.nodes[3].kind = "compare";
		expect(validateGraph(JSON.stringify(noCritique), PROMPT).errors.join()).toMatch(/critique/);
	});
	test("node fills need 5-8 steps and kind-specific sections", () => {
		expect(validateNodeFill(NODE("n2", "decompose", 5), "decompose").ok).toBe(true);
		expect(validateNodeFill(NODE("n2", "decompose", 4), "decompose").ok).toBe(false);
		expect(validateNodeFill(NODE("n2", "decompose", 9), "decompose").ok).toBe(false);
		expect(validateNodeFill(NODE("n4", "decompose", 6), "critique").errors.join()).toMatch(/Open questions/);
		expect(validateNodeFill(NODE("n5", "decompose", 6), "synthesize").errors.join()).toMatch(/WORKFLOW/);
		expect(validateNodeFill(NODE("n5", "synthesize", 6), "synthesize").ok).toBe(true);
		expect(validateNodeFill(NODE("n2", "decompose", 6).replace("Step 1 of n2", "footer &lt;id&gt;"), "decompose").errors.join()).toMatch(/XML-escape/);
	});
	test("clarify allows at most 4 questions", () => {
		expect(validateClarify(CLARIFY).ok).toBe(true);
		expect(validateClarify('{"questions":[]}').ok).toBe(true);
		const q = JSON.parse(CLARIFY).questions[0];
		const five = { questions: [1, 2, 3, 4, 5].map((i) => ({ ...q, id: `q${i}`, question: `Question number ${i}?` })) };
		expect(validateClarify(JSON.stringify(five)).ok).toBe(false);
	});
});

describe("grok-bot Jev journal", () => {
	test("journals decisions responses by url+body without headers and replays offline", async () => {
		const root = tmp();
		let calls = 0;
		const base = (async () => {
			calls++;
			return new Response('{"p":0.9}', { status: 200 });
		}) as unknown as typeof fetch;
		const restore = installDecisionsJournal(root, base);
		try {
			const init = { method: "POST", body: '{"x":1}', headers: { authorization: "Bearer sk-test-should-not-persist" } };
			const first = await fetch("https://openrouter.ai/api/alpha/decisions", init);
			const second = await fetch("https://openrouter.ai/api/alpha/decisions", init);
			expect(await first.text()).toBe('{"p":0.9}');
			expect(await second.text()).toBe('{"p":0.9}');
			expect(calls).toBe(1);
		} finally {
			restore();
		}
		const files = readdirSync(join(root, "decisions"));
		expect(files).toHaveLength(1);
		expect(readFileSync(join(root, "decisions", files[0]!), "utf8")).not.toContain("sk-test");
	});
	test("a pending request without a controller rejects as AbortError", async () => {
		const root = tmp();
		const journal = createJournalCompleter({ dir: root });
		await expect(journal.complete("sys", "user")).rejects.toThrow(/waiting for the host model/);
		expect(journal.missed()).toHaveLength(1);
	});
});

describe("grok-bot track bridge", () => {
	test("dry-run payloads carry the Kanban project and placeholders, then record real refs", async () => {
		const root = tmp();
		const stateDir = join(root, "state");
		const { result } = await drive(stateDir, root, hostModel(8));
		const statePath = result.response?.statePath as string;
		const record = JSON.parse(readFileSync(statePath, "utf8")) as SessionRecord;
		const payloads = await buildTrackPayloads(record, { linearTeam: "Team", notionDataSource: "collection://abc", project: "Kanban", agent: "grok-bot" });
		const pages = payloads.calls.filter((c) => c.tool === "notion-create-pages").flatMap((c) => c.args.pages as Array<{ properties: Record<string, unknown> }>);
		expect(pages.every((page) => page.properties.Agent === "grok-bot")).toBe(true);
		expect(payloads.counts).toEqual({ linearIssues: 5, linearSubIssues: 40, notionTask: 1, notionIssues: 5, notionSubIssues: 40 });
		const saves = payloads.calls.filter((c) => c.tool === "save_issue");
		expect(saves.every((c) => c.args.project === "Kanban" && c.args.team === "Team")).toBe(true);
		const defined = new Set<string>();
		for (const call of payloads.calls) {
			const parent = call.args.parentId as string | undefined;
			if (parent) expect(defined.has(parent)).toBe(true);
			for (const dep of (call.args.blockedBy as string[] | undefined) ?? []) expect(defined.has(dep)).toBe(true);
			for (const id of call.defines) defined.add(id);
		}
		const n4 = saves.find((c) => c.keys[0] === "n4");
		expect((n4?.args.blockedBy as string[]).length).toBe(2);

		const linear: Record<string, { id: string; identifier: string; url: string; title: string }> = {};
		saves.forEach((c, i) => {
			linear[c.keys[0] as string] = { id: `id${i}`, identifier: `SPE-${9000 + i}`, url: `https://linear.app/x/issue/SPE-${9000 + i}/t`, title: String(c.args.title) };
		});
		const notion: Record<string, string> = {};
		payloads.calls.filter((c) => c.tool === "notion-create-pages").forEach((c) => c.keys.forEach((k, i) => (notion[k] = `https://www.notion.so/real-${k}-${i}`)));
		const first = recordRefs(statePath, { linear, notion });
		expect(first.tracking.status).toBe("complete");
		const once = readFileSync(statePath.replace(/\.json$/, ".xml"), "utf8");
		recordRefs(statePath, { linear, notion }, first.tracking.updatedAt);
		expect(readFileSync(statePath.replace(/\.json$/, ".xml"), "utf8")).toBe(once);
		expect(once).toContain("SPE-9000");
	});

	test("a second payload build skips rows that already exist, and one configured tracker can finish", async () => {
		const root = tmp();
		const stateDir = join(root, "state");
		const { result } = await drive(stateDir, root, hostModel(5));
		const statePath = result.response?.statePath as string;
		const record = JSON.parse(readFileSync(statePath, "utf8")) as SessionRecord;
		const options = { linearTeam: "Team", notionDataSource: "collection://abc", project: "Kanban", agent: "grok-bot" };
		const first = await buildTrackPayloads(record, options);
		const issue = first.calls.find((call) => call.tool === "save_issue" && !String(call.keys[0]).includes("."));
		const key = String(issue?.keys[0]);
		const linear = {
			[key]: { id: "id0", identifier: "SPE-1", url: "https://linear.app/x/issue/SPE-1/t", title: "t" },
		};
		const partial = recordRefs(statePath, { linear });
		expect(partial.tracking.status).toBe("partial");
		const again = await buildTrackPayloads(JSON.parse(readFileSync(statePath, "utf8")) as SessionRecord, options);
		expect(again.calls.filter((call) => call.tool === "save_issue").some((call) => call.keys[0] === key)).toBe(false);
		expect(again.calls.some((call) => call.tool === "list_issues" || call.tool === "notion-query-data-sources")).toBe(false);
		expect(again.counts.linearIssues).toBe(first.counts.linearIssues - 1);

		const other = tmp();
		const otherDir = join(other, "state");
		const planned = await drive(otherDir, other, hostModel(5));
		const otherPath = planned.result.response?.statePath as string;
		const payloads = await buildTrackPayloads(JSON.parse(readFileSync(otherPath, "utf8")) as SessionRecord, options);
		const allLinear: Record<string, { id: string; identifier: string; url: string; title: string }> = {};
		payloads.calls.filter((call) => call.tool === "save_issue").forEach((call, i) => {
			allLinear[String(call.keys[0])] = { id: `id${i}`, identifier: `SPE-${i}`, url: `https://linear.app/x/issue/SPE-${i}/t`, title: "t" };
		});
		const linearOnly = recordRefs(otherPath, { linear: allLinear, trackers: { linear: true, notion: false } });
		expect(linearOnly.tracking.status).toBe("complete");
		expect(linearOnly.tracking.notion.taskUrl).toBeUndefined();

		const env = { ...testEnv(root), ULTRATHINK_STATE_DIR: stateDir } as NodeJS.ProcessEnv;
		const off = await main(["track", "payloads", "--session", "s1", "--cwd", root], env);
		expect(off.code).toBe(0);
		expect(off.text).toContain('"tracking": "off"');
		expect(off.text).toContain('"calls": []');
		const stale = join(root, "payloads.json");
		writeFileSync(stale, '{"calls":[{"tool":"save_issue"}]}\n');
		const replaced = await main(["track", "payloads", "--session", "s1", "--cwd", root, "--out", stale], env);
		expect(replaced.code).toBe(0);
		expect(JSON.parse(readFileSync(stale, "utf8")).calls).toEqual([]);
		mkdirSync(join(root, "xdg", "ultrathink"), { recursive: true });
		writeFileSync(join(root, "xdg", "ultrathink", "config.json"), JSON.stringify({ linear: { team: "Team" }, notion: { dataSourceUrl: "collection://abc" } }));
		writeControl(stateDir, { trackEnabled: false });
		const forced = await main(["track", "payloads", "--session", "s1", "--cwd", root], env);
		expect(forced.text).toContain('"tracking": "off"');
	});
});

describe("grok-bot teach guard", () => {
	test("promote is drafts-only and never installs", () => {
		expect(promoteGuard(["promote", "abc", "--target", "drafts"])).toBeUndefined();
		expect(promoteGuard(["promote", "abc", "--target", "drafts", "--install"])).toMatch(/disabled/);
		expect(promoteGuard(["promote", "abc", "--target", "hermes"])).toMatch(/drafts/);
		expect(promoteGuard(["promote", "--due"])).toBeUndefined();
		expect(promoteGuard(["list"])).toBeUndefined();
	});
});

describe("grok-bot review read", () => {
	test("reads the score from the PR description and counts Greptile threads on the head commit", async () => {
		const root = tmp();
		const bot = { login: "greptile-apps[bot]" };
		writeFileSync(join(root, "pull.json"), JSON.stringify({ state: "open", draft: true, head: { sha: "abc" }, body: "<h3>Confidence Score: 3/5</h3>" }));
		writeFileSync(join(root, "issue-comments.json"), "[]");
		writeFileSync(join(root, "reviews.json"), JSON.stringify([{ user: bot, commit_id: "old" }, { user: bot, commit_id: "abc" }]));
		writeFileSync(join(root, "review-comments.json"), JSON.stringify([
			{ id: 1, user: bot, commit_id: "old", path: "a.ts", line: 1, body: '<img alt="P2"> **Old**' },
			{ id: 2, user: bot, commit_id: "abc", path: "b.ts", line: 2, body: '<img alt="P1"> **New**' },
			{ id: 3, user: { login: "someone" }, commit_id: "abc", in_reply_to_id: 1, body: "fixed" },
		]));
		writeFileSync(join(root, "check-runs.json"), JSON.stringify({ check_runs: [{ name: "Greptile Review", status: "completed", conclusion: "success" }] }));
		const read = await reviewRead("o/r", "21", dirFetcher(root));
		expect(read.score).toBe(3);
		expect(read.reviewedHead).toBe(true);
		expect(read.greptileThreadsTotal).toBe(2);
		expect(read.greptileThreadsOnHead).toBe(1);
		expect(read.greptileCheckRuns).toEqual([{ name: "Greptile Review", status: "completed", conclusion: "success" }]);
		expect(read.scoreSource).toBe("pr-description");
	});

	test("prefers the current head review score and follows a next page", async () => {
		const root = tmp();
		const bot = { login: "greptile-apps[bot]" };
		writeFileSync(join(root, "pull.json"), JSON.stringify({ state: "open", draft: true, head: { sha: "abc" }, body: "" }));
		writeFileSync(join(root, "issue-comments.json"), JSON.stringify([{ user: bot, body: "Confidence Score: 5/5" }]));
		writeFileSync(join(root, "reviews.json"), JSON.stringify([{ user: bot, commit_id: "abc", body: "Confidence Score: 2/5" }]));
		writeFileSync(join(root, "review-comments.json"), "[]");
		writeFileSync(join(root, "check-runs.json"), JSON.stringify({ check_runs: [] }));
		const read = await reviewRead("o/r", "21", dirFetcher(root));
		expect(read.score).toBe(2);
		expect(read.scoreSource).toBe("head-review");

		let reviewPage = 0;
		const paged = (async (input: Parameters<typeof fetch>[0]) => {
			const url = String(input).split("?")[0] ?? "";
			if (url.endsWith("/pulls/21")) return new Response(readFileSync(join(root, "pull.json"), "utf8"), { status: 200 });
			if (url.endsWith("/reviews")) {
				reviewPage++;
				if (reviewPage === 1) {
					const filler = Array.from({ length: 100 }, (_, i) => ({ id: i, user: { login: "someone" }, body: "" }));
					return new Response(JSON.stringify(filler), { status: 200, headers: { link: '<https://api.github.com/repos/o/r/pulls/21/reviews?page=2>; rel="next"' } });
				}
				return new Response(readFileSync(join(root, "reviews.json"), "utf8"), { status: 200 });
			}
			if (url.includes("/comments")) return new Response("[]", { status: 200 });
			if (url.includes("/check-runs")) return new Response(JSON.stringify({ check_runs: [] }), { status: 200 });
			return new Response("{}", { status: 404 });
		}) as typeof fetch;
		const pagedRead = await reviewRead("o/r", "21", paged);
		expect(reviewPage).toBe(2);
		expect(pagedRead.score).toBe(2);
		expect(pagedRead.scoreSource).toBe("head-review");
	});

	test("the fallback score is the newest comment or review by time, not by list order", async () => {
		const root = tmp();
		const bot = { login: "greptile-apps[bot]" };
		writeFileSync(join(root, "pull.json"), JSON.stringify({ state: "open", draft: true, head: { sha: "abc" }, body: "" }));
		writeFileSync(join(root, "issue-comments.json"), JSON.stringify([{ user: bot, body: "Confidence Score: 2/5", created_at: "2026-10-09T00:00:00Z" }]));
		writeFileSync(join(root, "reviews.json"), JSON.stringify([{ user: bot, commit_id: "old", body: "Confidence Score: 5/5", submitted_at: "2026-10-01T00:00:00Z" }]));
		writeFileSync(join(root, "review-comments.json"), "[]");
		writeFileSync(join(root, "check-runs.json"), JSON.stringify({ check_runs: [] }));
		const read = await reviewRead("o/r", "23", dirFetcher(root));
		expect(read.score).toBe(2);
		expect(read.scoreSource).toBe("latest-comment");

		writeFileSync(join(root, "issue-comments.json"), JSON.stringify([{ user: bot, body: "Confidence Score: 1/5", created_at: "2026-10-01T00:00:00Z" }]));
		writeFileSync(join(root, "reviews.json"), JSON.stringify([{ user: bot, commit_id: "old", body: "Confidence Score: 4/5", submitted_at: "2026-10-09T00:00:00Z" }]));
		const newerReview = await reviewRead("o/r", "23", dirFetcher(root));
		expect(newerReview.score).toBe(4);
		expect(newerReview.scoreSource).toBe("latest-comment");
	});
});

describe("grok-bot prompts build", () => {
	test("builds a validated follow-up prompt from a planned node", async () => {
		const root = tmp();
		const { result } = await drive(join(root, "state"), root, hostModel(6));
		const record = JSON.parse(readFileSync(result.response?.statePath as string, "utf8")) as SessionRecord;
		const dispatch = { unit: "n2", mode: "followup" as const, agentId: "bc-test", repo: "o/r", pr: 14, branch: "grokbot/fix-a & b", notes: ["keep <fixture> rule"] };
		const xml = buildCloudPrompt(record, dispatch);
		const check = validateCloudPrompt(xml, dispatch, PROMPT);
		expect(check.errors).toEqual([]);
		expect((xml.match(/<SUBISSUE /g) ?? []).length).toBe(6);
		expect(xml).toContain("<FOLLOW_UP>");
		expect(xml).toContain("grokbot/fix-a &amp; b");
		expect(xml).toContain(`graph="${record.plan?.graphId}"`);
		expect((xml.match(/<RULE>/g) ?? []).length).toBe(DEFAULT_DESK_RULES.length);
	});
	test("rejects malformed XML, too many rules, missing agent ids and secret-like text", async () => {
		expect(wellFormed("<A><B></A></B>").length).toBeGreaterThan(0);
		expect(wellFormed("<A>x & y</A>").join()).toMatch(/bare/);
		expect(wellFormed("<A/><B/>").join()).toMatch(/one root/);
		const root = tmp();
		const { result } = await drive(join(root, "state"), root, hostModel(5));
		const record = JSON.parse(readFileSync(result.response?.statePath as string, "utf8")) as SessionRecord;
		const many = { unit: "n3", mode: "new" as const, repo: "o/r", branch: "b", rules: Array.from({ length: 11 }, (_, i) => `rule ${i}`) };
		expect(validateCloudPrompt(buildCloudPrompt(record, many), many, PROMPT).ok).toBe(true);
		const injected = buildCloudPrompt(record, many).replace("<RULE>rule 0</RULE>", "<RULE>rule 0</RULE><RULE>x</RULE>".repeat(6));
		expect(validateCloudPrompt(injected, many, PROMPT).errors.join()).toMatch(/DESK_RULES/);
		const follow = { unit: "n3", mode: "followup" as const, repo: "o/r", branch: "b" };
		expect(validateCloudPrompt(buildCloudPrompt(record, follow), follow, PROMPT).errors.join()).toMatch(/agent id/);
		const leaky = { unit: "n3", mode: "new" as const, repo: "o/r", branch: "b", notes: ["key sk-or-abcdefghijklmnop"] };
		expect(validateCloudPrompt(buildCloudPrompt(record, leaky), leaky, PROMPT).errors.join()).toMatch(/secret-like/);
	});

	test("placeholder text inside ORIGINAL is kept and a placeholder outside still fails", async () => {
		const root = tmp();
		const { result } = await drive(join(root, "state"), root, hostModel(5));
		const record = JSON.parse(readFileSync(result.response?.statePath as string, "utf8")) as SessionRecord;
		const dispatch = { unit: "n3", mode: "new" as const, repo: "o/r", branch: "b" };
		const original = `${PROMPT} TODO in the request`;
		const xml = buildCloudPrompt(record, dispatch).replace(
			`<ORIGINAL>${escapeXml(PROMPT)}</ORIGINAL>`,
			`<ORIGINAL>${escapeXml(original)}</ORIGINAL>`,
		);
		expect(validateCloudPrompt(xml, dispatch, original).errors).toEqual([]);
		const outside = xml.replace("<VERIFY>", "<VERIFY>TODO ");
		expect(validateCloudPrompt(outside, dispatch, original).errors.join()).toMatch(/placeholder/);
		const leaked = xml.replace("</ORIGINAL>", " sk-or-abcdefghijklmnop</ORIGINAL>");
		expect(validateCloudPrompt(leaked, dispatch, `${original} sk-or-abcdefghijklmnop`).errors.join()).toMatch(/secret-like/);
	});

	test("a graph-free plan is valid only when thinking is off", async () => {
		const root = tmp();
		const stateDir = join(root, "state");
		const { result } = await drive(stateDir, root, hostModel(5));
		const record = JSON.parse(readFileSync(result.response?.statePath as string, "utf8")) as SessionRecord;
		const empty = structuredClone(record);
		if (empty.graph) empty.graph = { ...empty.graph, nodes: [] };
		expect(checkRecord(empty).ok).toBe(false);
		expect(checkRecord(empty).errors.join()).toMatch(/0 nodes/);
		expect(checkRecord(empty, { thinkOff: true }).ok).toBe(true);
		const broken = structuredClone(record);
		broken.graph?.nodes.splice(0, 3);
		expect(checkRecord(broken, { thinkOff: true }).ok).toBe(false);
		expect(thinkingOff(stateDir, root, testEnv(root))).toBe(false);
		writeControl(stateDir, { thinkEnabled: false });
		expect(thinkingOff(stateDir, root, testEnv(root))).toBe(true);
	});
});

/** Fake connector results for every recorded create, keyed like Desk Lead's refs.json. */
async function kickoff(statePath: string) {
	const record = JSON.parse(readFileSync(statePath, "utf8")) as SessionRecord;
	const payloads = await buildTrackPayloads(record, { linearTeam: "Team", notionDataSource: "collection://abc", project: "Kanban", agent: "grok-bot" });
	const linear: Record<string, { id: string; identifier: string; url: string; title: string }> = {};
	payloads.calls.filter((c) => c.tool === "save_issue").forEach((c, i) => {
		linear[c.keys[0] as string] = { id: `id${i}`, identifier: `SPE-${9000 + i}`, url: `https://linear.app/x/issue/SPE-${9000 + i}/t`, title: String(c.args.title) };
	});
	const notion: Record<string, string> = {};
	payloads.calls.filter((c) => c.tool === "notion-create-pages").forEach((c) => c.keys.forEach((k, i) => (notion[k] = `https://www.notion.so/real${k.replace(/\W/g, "")}${i}`)));
	recordRefs(statePath, { linear, notion });
	return JSON.parse(readFileSync(statePath, "utf8")) as SessionRecord;
}

describe("grok-bot prompts build after kickoff", () => {
	test("rebuilds the same prompt with real Linear/Notion refs; SUBISSUEs in the embedded spec are not counted", async () => {
		const root = tmp();
		const { result } = await drive(join(root, "state"), root, hostModel(7));
		const statePath = result.response?.statePath as string;
		const before = JSON.parse(readFileSync(statePath, "utf8")) as SessionRecord;
		const dispatch = { unit: "n2", mode: "followup" as const, agentId: "bc-test", repo: "o/r", pr: 14, branch: "b" };
		const pre = buildCloudPrompt(before, dispatch);
		expect(validateCloudPrompt(pre, dispatch, PROMPT).errors).toEqual([]);

		const after = await kickoff(statePath);
		expect(after.result.xml).not.toBe(before.result.xml);
		const post = buildCloudPrompt(after, dispatch);
		expect(unitSubissueCount(post)).toBe(7);
		expect(validateCloudPrompt(post, dispatch, PROMPT).errors).toEqual([]);
		// Regression: with the tracked spec embedded (the old builder), a whole-document count saw the spec's
		// <ISSUES> block too (5 nodes x 7 steps on top of the unit's 7) and rejected the prompt; the unit-scoped count does not.
		const tracked = post.replace(untrackedSpec(after.result.xml), after.result.xml);
		expect((tracked.match(/<SUBISSUE /g) ?? []).length).toBeGreaterThan(MAX_STEPS);
		expect(validateCloudPrompt(tracked, dispatch, PROMPT).errors).toEqual([]);

		const n2 = after.tracking?.linear.nodes.n2;
		expect(post).toContain(`<UNIT id="n2" kind="decompose" title="Parser design" issue="${n2?.identifier}" url="${n2?.url}" notion="${after.tracking?.notion.nodes.n2}">`);
		expect(post).toContain(`<SUBISSUE step="3" issue="${after.tracking?.linear.steps["n2.3"]?.identifier}" url="${after.tracking?.linear.steps["n2.3"]?.url}" notion="${after.tracking?.notion.steps["n2.3"]}" title=`);
		expect(post).toContain(`<ISSUE node="n2" ref="${n2?.identifier}" url="${n2?.url}" notion="${after.tracking?.notion.nodes.n2}">`);
		// Same content: dropping the ref attributes gives back the pre-kickoff prompt byte for byte.
		const unref = post
			.replace(/ issue="SPE-\d+" url="[^"]*" notion="[^"]*"/g, ' issue="pending kickoff"')
			.replace(/ ref="SPE-\d+" url="[^"]*" notion="[^"]*"/g, ' ref="pending kickoff"');
		expect(unref).toBe(pre);
	});

	test("stripTrackingXml undoes injectTrackingXml", async () => {
		const root = tmp();
		const { result } = await drive(join(root, "state"), root, hostModel(5));
		const statePath = result.response?.statePath as string;
		const before = JSON.parse(readFileSync(statePath, "utf8")) as SessionRecord;
		const after = await kickoff(statePath);
		expect(after.result.xml).toContain("<ISSUES graphId=");
		expect(stripTrackingXml(after.result.xml)).toBe(before.result.xml);
		expect(untrackedSpec(before.result.xml)).toBe(before.result.xml);
		const again = injectTrackingXml(stripTrackingXml(after.result.xml), after.plan!, after.tracking!);
		expect(again).toBe(after.result.xml);
	});
});

describe("grok-bot transcript", () => {
	test("simple role/content lines reach the planner's transcript reader", () => {
		const root = tmp();
		const src = join(root, "t.jsonl");
		writeFileSync(src, [
			JSON.stringify({ role: "user", content: "We use pnpm and Vitest in this repo." }),
			"not json",
			JSON.stringify({ role: "assistant", content: [{ type: "text", text: "Noted: pnpm + Vitest." }] }),
			JSON.stringify({ type: "user", message: { role: "user", content: "Claude-shaped line" } }),
			JSON.stringify({ role: "system", content: "ignored" }),
		].join("\n"));
		// The plugin's reader ignores the simple shape on its own.
		expect(conversationFromJsonl(readFileSync(src, "utf8"))).toBe("User: Claude-shaped line");
		const path = normalizeTranscript(src, join(root, "journal"));
		expect(conversationFromJsonl(readFileSync(path, "utf8"))).toBe("User: We use pnpm and Vitest in this repo.\n\nAssistant: Noted: pnpm + Vitest.\n\nUser: Claude-shaped line");
		expect(readFileSync(normalizeTranscript(join(root, "missing.jsonl"), join(root, "journal")), "utf8")).toBe("");
	});
});

describe("grok-bot answers", () => {
	test("folds Ming's replies into the clarifications, the spec and later prompts", async () => {
		const root = tmp();
		const { result } = await drive(join(root, "state"), root, hostModel(6));
		const statePath = result.response?.statePath as string;
		expect(recordAnswers(statePath, parseAnswersInput({ answers: { q9: "x" } })).unknownIds).toEqual(["q9"]);
		const outcome = recordAnswers(statePath, parseAnswersInput({ q1: "JSON lines" }), 1_700_000_000_000);
		expect(outcome.matched.map((c) => c.id)).toEqual(["q1"]);
		const record = JSON.parse(readFileSync(statePath, "utf8")) as SessionRecord;
		expect(record.clarifications?.[0]).toMatchObject({ answer: "JSON lines", source: "user", answeredAt: 1_700_000_000_000 });
		expect(readFileSync(statePath.replace(/\.json$/, ".xml"), "utf8")).toContain("JSON lines");
		const dispatch = { unit: "n3", mode: "new" as const, repo: "o/r", branch: "b" };
		expect(buildCloudPrompt(record, dispatch)).toContain("answered: JSON lines");
		expect(() => parseAnswersInput({ answers: {} })).toThrow(/no answers/);
		expect(() => parseAnswersInput({ q1: 3 })).toThrow(/string/);
		const lastPath = join(join(root, "state"), "last.json");
		const last = JSON.parse(readFileSync(lastPath, "utf8")) as SessionRecord;
		expect(last.clarifications?.[0]?.answer).toBe("JSON lines");
		expect(readFileSync(lastPath, "utf8")).toContain("\t");
		writeFileSync(lastPath, `${JSON.stringify({ sessionId: "other", result: { xml: "stale" } }, null, "\t")}\n`);
		recordAnswers(statePath, parseAnswersInput({ q1: "JSON lines" }));
		expect(JSON.parse(readFileSync(lastPath, "utf8")).sessionId).toBe("other");
	});

	test("a held last.json lock keeps the current plan in place", () => {
		const root = tmp();
		const stateDir = join(root, "state");
		const record = { sessionId: "s1", at: 1, result: { xml: "<x/>", original: "o", root: "BUILD_PROMPT", source: "llm" } } as SessionRecord;
		writeSession(stateDir, record);
		const lastPath = join(stateDir, "last.json");
		const fd = openSync(`${lastPath}.lock`, "wx");
		try {
			mirrorLast(join(stateDir, "sessions", "s1.json"), { ...record, at: 2 });
			expect(JSON.parse(readFileSync(lastPath, "utf8")).at).toBe(1);
		} finally {
			closeSync(fd);
			unlinkSync(`${lastPath}.lock`);
		}
		mirrorLast(join(stateDir, "sessions", "s1.json"), { ...record, at: 2 });
		expect(JSON.parse(readFileSync(lastPath, "utf8")).at).toBe(2);
		expect(existsSync(`${lastPath}.lock`)).toBe(false);
	});
});

describe("grok-bot teach digest and host", () => {
	test("builds a valid TeachDigest from Grok Bot turns", () => {
		const root = tmp();
		const src = join(root, "run.jsonl");
		writeFileSync(src, [
			JSON.stringify({ role: "user", content: "Fix the flaky fetch test." }),
			JSON.stringify({ role: "assistant", content: "The test raced the mock server; awaiting listen() fixed it." }),
		].join("\n"));
		const digest = grokbotDigest(src, { sessionId: "s1", cwd: root, outcome: "completed", now: () => 0 });
		expect(digest?.host).toBe("grok-bot");
		expect(digest?.turns.map((t) => t.role)).toEqual(["user", "assistant"]);
		expect(parseDigest(JSON.parse(JSON.stringify(digest)))).toBeDefined();
		writeFileSync(src, [
			JSON.stringify({ role: "user", content: "Fix it." }),
			JSON.stringify({ role: "tool", name: "Shell", input: { command: "bun test" }, content: "1 fail", isError: true }),
			JSON.stringify({ role: "tool", name: "Shell", input: { command: "bun test" }, content: "3 pass" }),
		].join("\n"));
		const tools = grokbotDigest(src, { sessionId: "s2", cwd: root });
		expect(tools?.toolCalls).toBe(2);
		expect(tools?.turns.filter((t) => t.role === "tool").map((t) => [t.tool, t.isError ?? false])).toEqual([["Shell", true], ["Shell", false]]);
		writeFileSync(src, [
			JSON.stringify({ type: "user", message: { role: "user", content: "Keep the user line." } }),
			JSON.stringify({ role: "tool", name: "Shell", input: { command: "bun test" }, content: "1 fail", isError: true }),
		].join("\n"));
		const mixed = grokbotDigest(src, { sessionId: "s3", cwd: root });
		expect(mixed?.toolCalls).toBeGreaterThanOrEqual(1);
		expect(mixed?.turns.some((turn) => turn.role === "user" && turn.text === "Keep the user line.")).toBe(true);
		writeFileSync(src, [
			JSON.stringify({ type: "user", message: { role: "user", content: "Fix the fetch." } }),
			JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "tu1", name: "Shell", input: { command: "bun test" } }] } }),
			JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: "1 fail", is_error: true }] } }),
			JSON.stringify({ type: "user", isMeta: true, message: { role: "user", content: "do not do that, do this instead" } }),
			JSON.stringify({ type: "user", message: { role: "user", content: "[Request interrupted by user]" } }),
		].join("\n"));
		const claude = grokbotDigest(src, { sessionId: "s4", cwd: root, now: () => 0 });
		expect(claude?.outcome).toBe("interrupted");
		expect(claude?.turns.some((turn) => turn.role === "tool" && turn.tool === "Shell" && turn.isError === true)).toBe(true);
		expect(claude?.turns.some((turn) => turn.text.includes("do not") || turn.text.includes("interrupted"))).toBe(false);
		expect(grokbotDigest(src, { sessionId: "s4", cwd: root, outcome: "completed", now: () => 0 })?.outcome).toBe("completed");
	});

	test("teach captures are host grok-bot", async () => {
		const root = tmp();
		const env = { ...testEnv(root), ULTRATHINK_STATE_DIR: join(root, "state"), ULTRATHINK_HINDSIGHT: "0" } as NodeJS.ProcessEnv;
		const captured = await main(["teach", "capture", "--name", "await listen", "--body", "Await server.listen() before fetch in tests.", "--json"], env);
		expect(captured.text).toContain('"ok"');
		expect(captured.code).toBe(0);
		const listed = await main(["teach", "list", "--json"], env);
		expect(listed.text).toContain('"grok-bot"');
	});
});

describe("grok-bot skills status and status lines", () => {
	test("reports in-sync, drift and not-installed without writing", () => {
		const root = tmp();
		const staged = join(root, "staged");
		const installed = join(root, "installed");
		for (const [dir, name, body] of [[staged, "a", "x"], [staged, "b", "y"], [staged, "c", "z"], [installed, "a", "x"], [installed, "b", "changed"]] as const) {
			mkdirSync(join(dir, name), { recursive: true });
			writeFileSync(join(dir, name, "SKILL.md"), body);
		}
		const report = skillsStatus(staged, installed);
		expect(report.skills.map((s) => [s.name, s.state])).toEqual([["a", "in-sync"], ["b", "drift"], ["c", "not-installed"]]);
		expect(existsSync(join(installed, "c"))).toBe(false);
	});

	test("replaces the Grok CLI lines in ctl status", () => {
		const text = "Prompt Uplift on\nGrok: grok-4.7 @ xhigh · transport http\nSuperGrok OAuth: not logged in (run grok login)\nGraph of Thought on";
		expect(grokbotStatusLines(text)).toBe("Prompt Uplift on\nGrok CLI: not used (grok-bot host: Desk Lead answers every planner request)\nGraph of Thought on");
		expect(grokbotStatusLines("HITL on")).toBe("HITL on");
	});
});

describe("grok-bot graph_register payload", () => {
	test("carries graph id, Notion task and surface; nodes and steps only on request", async () => {
		const root = tmp();
		const { result } = await drive(join(root, "state"), root, hostModel(5));
		const statePath = result.response?.statePath as string;
		const pre = JSON.parse(readFileSync(statePath, "utf8")) as SessionRecord;
		expect(graphRegisterPayload(pre)).toEqual(expect.objectContaining({ graph_id: pre.plan?.graphId, surface: "grok-bot" }));
		expect(graphRegisterPayload(pre).notion_task_page).toBeUndefined();
		const after = await kickoff(statePath);
		const bare = graphRegisterPayload(after);
		expect(bare.notion_task_page).toBe(after.tracking?.notion.taskUrl);
		expect(bare.nodes).toBeUndefined();
		const full = graphRegisterPayload(after, { withNodes: true }) as { nodes: Array<Record<string, unknown>>; steps: Array<Record<string, unknown>> };
		expect(full.nodes).toHaveLength(5);
		expect(full.steps).toHaveLength(25);
		expect(full.steps[0]).toEqual({ node_id: "n1", step: 1, linear_sub_issue_id: expect.any(String), linear_identifier: expect.stringMatching(/^SPE-/), linear_url: expect.any(String), notion_page: expect.any(String) });
	});
});
