// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionRecord } from "../claude/state.ts";
import { escapeXml } from "../uplift/xml.ts";
import { planPrompt } from "./plan.ts";
import {
	checkRecord,
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
import { buildTrackPayloads, recordRefs } from "./grokbot-track.ts";
import { buildCloudPrompt, DEFAULT_DESK_RULES, validateCloudPrompt, wellFormed } from "./grokbot-prompts.ts";
import { dirFetcher, promoteGuard, reviewRead } from "./grokbot-cli.ts";
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
});
