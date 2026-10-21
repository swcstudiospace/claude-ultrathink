// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Cross-session isolation: an edit is attributed to the repo it touched, `/ultrathink-skip` arms one session only, and a
 * prompt with no session id gets a turn id of its own. Temp git repos only; every root is removed after each test.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defaultConfig } from "../config.ts";
import { type HookDeps, runPromptSubmit } from "../claude/hook.ts";
import {
	isTurnSessionId,
	readControl,
	readSession,
	readSkipOnce,
	skipOncePath,
	sessionPath,
	type SessionRecord,
	updateSession,
	writeSession,
} from "../claude/state.ts";
import type { Clarification } from "../hitl/types.ts";
import type { TrackPlan } from "../track/types.ts";
import { runControl, takeSessionFlag } from "../uplift/commands.ts";
import { editTargets, recordEditAttribution } from "./omp.ts";
import { main as grokbotMain } from "./grokbot-cli.ts";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function tempRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "ultrathink-cross-"));
	roots.push(root);
	return root;
}

function git(cwd: string, args: string[]): void {
	const proc = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
	if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}`);
}

/** A git repo whose origin is `slug`, so resolveRepoSlug labels files under it with `slug`. */
function repoAt(root: string, slug: string): string {
	const dir = join(root, slug.replace("/", "-"));
	mkdirSync(dir, { recursive: true });
	git(dir, ["init", "-q"]);
	git(dir, ["remote", "add", "origin", `git@github.com:${slug}.git`]);
	return dir;
}

/** A planned session record whose plan labels its task with `labelled` (undefined: the plan has no repo). */
function plannedRecord(sessionId: string, labelled: string | undefined): SessionRecord {
	const plan: TrackPlan = {
		graphId: "ut-cross-00000000",
		task: {
			graphId: "ut-cross-00000000",
			item: "add a widget",
			description: "",
			upliftedPrompt: "",
			agent: "claude-code",
			status: "",
			linearState: "",
			repo: labelled,
		},
		issues: [],
		subIssues: [],
		linearIssues: [],
		linearSubIssues: [],
		hitl: { blocking: [], nonBlocking: [] },
	};
	return { sessionId, at: 1, result: { xml: "<SPEC/>", original: "add a widget", root: "SPEC", source: "llm" }, plan };
}

function graphJson(count = 5): string {
	return JSON.stringify({
		goal: "Ship it",
		nodes: Array.from({ length: count }, (_, i) => ({
			id: `n${i + 1}`,
			title: `T${i + 1}`,
			kind: i === 0 ? "understand" : i === count - 1 ? "synthesize" : "generate",
			question: `Q${i + 1}`,
			depends_on: i === 0 ? [] : [`n${i}`],
		})),
	});
}

/** Dispatches by payload content so one fake handles uplift, graph, CoT, and clarify calls. */
function smartComplete(): (system: string, user: string) => Promise<string> {
	return async (_system, user) => {
		if (user.includes("<user_request>")) return "<BUILD_PROMPT><ORIGINAL>add a widget</ORIGINAL></BUILD_PROMPT>";
		if (user.startsWith("<spec>")) return JSON.stringify({ questions: [] });
		if (user.includes("current_node")) {
			const id = user.match(/current_node id="([^"]+)"/)?.[1] ?? "n?";
			const steps = Array.from({ length: 5 }, (_, i) => `${i + 1}. ${id} step ${i + 1}`).join(" ");
			return `<node><rationale>${steps}</rationale><conclusion>c ${id}</conclusion></node>`;
		}
		return graphJson();
	};
}

function baseDeps(): HookDeps {
	return {
		config: defaultConfig(),
		control: {},
		complete: smartComplete(),
		engine: "claude:sonnet",
		stateDir: join(tempRoot(), "ultrathink"),
		git: () => ({ repo: "acme/widgets", branch: "feat/widget" }),
		brief: async () => "",
		clarify: async () => [],
		emit: async () => true,
		now: () => 1_000,
		log: () => {},
		// Jev is always on in the hook; this suite has no ambient key and must not reach the network.
		decisionsDeps: { env: { ULTRATHINK_DECISIONS: "0" } },
	};
}

describe("edit attribution", () => {
	test("an edit in a different repo than the labelled one records the mismatch and warns once", () => {
		const root = tempRoot();
		const dir = join(root, "ultrathink");
		repoAt(root, "acme/widgets");
		const other = repoAt(root, "acme/other");
		writeSession(dir, plannedRecord("s1", "acme/widgets"));
		// The file does not exist yet: attribution walks up to the nearest directory that does.
		const file = join(other, "src", "widget.ts");

		expect(recordEditAttribution(dir, "s1", file)).toContain("acme/other");
		expect(recordEditAttribution(dir, "s1", file)).toBeUndefined();

		const record = readSession(dir, "s1");
		expect(record?.workRepos).toEqual(["acme/other"]);
		expect(record?.repoMismatch).toEqual({ labelled: "acme/widgets", edited: ["acme/other"] });
	});

	test("an edit inside the labelled repo records no mismatch; a session with no record changes nothing", () => {
		const root = tempRoot();
		const dir = join(root, "ultrathink");
		const labelledRepo = repoAt(root, "acme/widgets");
		writeSession(dir, plannedRecord("s1", "acme/widgets"));

		expect(recordEditAttribution(dir, "s1", join(labelledRepo, "src", "widget.ts"))).toBeUndefined();
		expect(recordEditAttribution(dir, "never-planned", join(labelledRepo, "src", "widget.ts"))).toBeUndefined();

		const record = readSession(dir, "s1");
		expect(record?.workRepos).toEqual(["acme/widgets"]);
		expect(record?.repoMismatch).toBeUndefined();
		expect(readSession(dir, "never-planned")).toBeUndefined();
	});

	test("an edit whose hashline header names a file in another repo records the mismatch", () => {
		const root = tempRoot();
		const dir = join(root, "ultrathink");
		repoAt(root, "acme/widgets");
		const other = repoAt(root, "acme/other");
		writeSession(dir, plannedRecord("s1", "acme/widgets"));
		const file = join(other, "src", "widget.ts");
		// Two headers in one edit: an absolute path and a relative one, which resolves against the session cwd (`other`).
		const input = { input: `[${file}#5C27]\n+const x = 1;\n[src/extra.ts#A1B2]\n+const y = 2;\n` };

		const targets = editTargets("edit", input, other);
		expect(targets).toEqual([file, join(other, "src", "extra.ts")]);
		const warnings = targets.map((target) => recordEditAttribution(dir, "s1", target)).filter((warning) => warning !== undefined);
		expect(warnings).toHaveLength(1);
		expect(readSession(dir, "s1")?.repoMismatch).toEqual({ labelled: "acme/widgets", edited: ["acme/other"] });
	});

	test("an edit whose input has no hashline header records nothing and does not throw", () => {
		const root = tempRoot();
		const dir = join(root, "ultrathink");
		repoAt(root, "acme/widgets");
		writeSession(dir, plannedRecord("s1", "acme/widgets"));
		// Header-less, malformed, missing and non-string input: each names no file.
		const inputs: Record<string, unknown>[] = [{ input: "+const x = 1;\nno header here" }, { input: "[not a header" }, {}, { input: 42 }];
		for (const input of inputs) expect(editTargets("edit", input, root)).toEqual([]);
		expect(readSession(dir, "s1")?.workRepos).toBeUndefined();
	});

	test("a write to an xd:// device path names no local file, and a plain relative write resolves against cwd", () => {
		const root = tempRoot();
		expect(editTargets("write", { path: "xd://mcp__tavus_pal_get" }, root)).toEqual([]);
		expect(editTargets("write", { path: "src/a.ts" }, root)).toEqual([join(root, "src", "a.ts")]);
	});

	test("a replan keeps the session's edited repos and mismatch, so the next edit in the same set does not warn again", async () => {
		const root = tempRoot();
		const other = repoAt(root, "acme/other");
		const deps = baseDeps();
		await runPromptSubmit({ session_id: "s1", cwd: "/repo", prompt: "add a widget" }, deps);
		const file = join(other, "src", "widget.ts");
		expect(recordEditAttribution(deps.stateDir, "s1", file)).toContain("acme/other");
		// Planning another prompt in the session writes a fresh record; the edit history and mismatch must survive it.
		const replanned = await runPromptSubmit({ session_id: "s1", cwd: "/repo", prompt: "add a button" }, deps);
		expect(replanned.record?.plan).toBeDefined();
		expect(readSession(deps.stateDir, "s1")).toMatchObject({
			workRepos: ["acme/other"],
			repoMismatch: { labelled: "acme/widgets", edited: ["acme/other"] },
		});
		expect(recordEditAttribution(deps.stateDir, "s1", file)).toBeUndefined();
	});
});

describe("session file names", () => {
	test("a plain session id keeps its file name; any other id gets a lowercase name with a hash of the exact id", () => {
		expect(sessionPath("/state", "s1")).toBe(join("/state", "sessions", "s1.json"));
		const hash = createHash("sha256").update("Claude-A").digest("hex").slice(0, 16);
		expect(sessionPath("/state", "Claude-A")).toBe(join("/state", "sessions", `claude-a~${hash}.json`));
	});

	test("ids that differ only in case or in characters a file name cannot hold never share a record or a skip flag", async () => {
		const deps = baseDeps();
		writeSession(deps.stateDir, plannedRecord("Claude-A", "acme/widgets"));
		writeSession(deps.stateDir, plannedRecord("a/b", "acme/other"));
		writeSession(deps.stateDir, plannedRecord("a_b", "acme/third"));
		expect(readSession(deps.stateDir, "claude-a")).toBeUndefined();
		expect(readSession(deps.stateDir, "Claude-A")?.plan?.task.repo).toBe("acme/widgets");
		expect(readSession(deps.stateDir, "a/b")?.plan?.task.repo).toBe("acme/other");
		expect(readSession(deps.stateDir, "a_b")?.plan?.task.repo).toBe("acme/third");
		expect(await runControl(["skip"], { stateDir: deps.stateDir, cwd: "/repo", sessionId: "Claude-A" })).toContain("will skip");
		expect(readSkipOnce(deps.stateDir, "claude-a")).toBe(false);
		// macOS and Windows file systems ignore case: the two ids' skip flags must differ even after folding case.
		expect(skipOncePath(deps.stateDir, "Claude-A").toLowerCase()).not.toBe(skipOncePath(deps.stateDir, "claude-a").toLowerCase());
	});

	test("Prime Agent's unknown placeholder is no session: the prompt gets a turn id and no unknown record is written", async () => {
		const deps = baseDeps();
		const planned = await runPromptSubmit({ session_id: "unknown", cwd: "/repo", prompt: "add a widget" }, deps);
		expect(isTurnSessionId(planned.record?.sessionId ?? "")).toBe(true);
		expect(existsSync(sessionPath(deps.stateDir, "unknown"))).toBe(false);
	});
});

describe("per-session /ultrathink-skip", () => {
	test("a skip armed in session A leaves session B's next decision unchanged", async () => {
		const deps = baseDeps();

		expect(await runControl(["skip"], { stateDir: deps.stateDir, cwd: "/repo", sessionId: "A" })).toBe(
			"Prompt Uplift will skip the next prompt in this session",
		);
		// Only the armed session is affected: B plans, and A's flag is still there for its own next prompt.
		const b = await runPromptSubmit({ session_id: "B", cwd: "/repo", prompt: "add a widget" }, deps);
		expect(b.skipped).toBeUndefined();
		expect(b.record?.sessionId).toBe("B");
		expect(readSkipOnce(deps.stateDir, "A")).toBe(true);

		const a = await runPromptSubmit({ session_id: "A", cwd: "/repo", prompt: "add a widget" }, deps);
		expect(a.skipped).toBe("skip");
		expect(readSkipOnce(deps.stateDir, "A")).toBe(false);
	});

	test("a skip with no session id is refused and arms nothing, not even the global control", async () => {
		const deps = baseDeps();

		expect(await runControl(["skip"], { stateDir: deps.stateDir, cwd: "/repo" })).toBe(
			"Prompt Uplift skip needs a session id (--session <id>); none was given, so nothing was armed.",
		);
		expect(readControl(deps.stateDir)).toEqual({});
		const planned = await runPromptSubmit({ session_id: "B", cwd: "/repo", prompt: "add a widget" }, deps);
		expect(planned.skipped).toBeUndefined();
	});

	test("a Claude-style skip with the session id arms that session only", async () => {
		const deps = baseDeps();
		// The Claude command passes `--session "${CLAUDE_SESSION_ID}"` after `skip`; the id keeps its case.
		const { sessionId, args } = takeSessionFlag(["skip", "--session", "Claude-A"]);

		expect(await runControl(args, { stateDir: deps.stateDir, cwd: "/repo", sessionId })).toBe("Prompt Uplift will skip the next prompt in this session");
		expect(readSkipOnce(deps.stateDir, "Claude-A")).toBe(true);
		expect(readSkipOnce(deps.stateDir, "claude-a")).toBe(false);
		const other = await runPromptSubmit({ session_id: "other", cwd: "/repo", prompt: "add a widget" }, deps);
		expect(other.skipped).toBeUndefined();
		const armed = await runPromptSubmit({ session_id: "Claude-A", cwd: "/repo", prompt: "add a widget" }, deps);
		expect(armed.skipped).toBe("skip");
		expect(readSkipOnce(deps.stateDir, "Claude-A")).toBe(false);
	});

	test("a grok-bot-style ctl skip arms only the session named by --session; without it the refusal names the gap", async () => {
		const deps = baseDeps();

		const named = await grokbotMain(["ctl", "skip", "--session", "desk-20261020-1200-slug"], { ULTRATHINK_STATE_DIR: deps.stateDir });
		expect(named.text).toContain("Prompt Uplift will skip the next prompt in this session");
		expect(readSkipOnce(deps.stateDir, "desk-20261020-1200-slug")).toBe(true);
		expect(readSkipOnce(deps.stateDir, "desk-other")).toBe(false);

		const bare = await grokbotMain(["ctl", "skip"], { ULTRATHINK_STATE_DIR: deps.stateDir });
		expect(bare.text).toContain("--session <id>");
		expect(readSkipOnce(deps.stateDir, "desk-other")).toBe(false);
		expect(readSkipOnce(deps.stateDir, "desk-20261020-1200-slug")).toBe(true);
	});

	test("status shows the armed skip for the session it names, and only for that session", async () => {
		const deps = baseDeps();
		expect(await runControl(["skip"], { stateDir: deps.stateDir, cwd: "/repo", sessionId: "Claude-A" })).toContain("will skip");

		// The status fallback passes `--session "${CLAUDE_SESSION_ID}"` like the skip does; the id keeps its case.
		const { sessionId, args } = takeSessionFlag(["status", "--session", "Claude-A"]);
		expect(await runControl(args, { stateDir: deps.stateDir, cwd: "/repo", sessionId })).toContain("(skipping next prompt)");
		expect(await runControl(["status"], { stateDir: deps.stateDir, cwd: "/repo", sessionId: "other" })).not.toContain("(skipping next prompt)");
		expect(await runControl(["status"], { stateDir: deps.stateDir, cwd: "/repo" })).not.toContain("(skipping next prompt)");
		// Showing the flag never consumes it.
		expect(readSkipOnce(deps.stateDir, "Claude-A")).toBe(true);
	});

	test("a grok-bot-style ctl status shows the skip armed for the session named by --session", async () => {
		const deps = baseDeps();
		await grokbotMain(["ctl", "skip", "--session", "desk-20261020-1200-slug"], { ULTRATHINK_STATE_DIR: deps.stateDir });

		const named = await grokbotMain(["ctl", "status", "--session", "desk-20261020-1200-slug"], { ULTRATHINK_STATE_DIR: deps.stateDir });
		expect(named.text).toContain("(skipping next prompt)");
		const other = await grokbotMain(["ctl", "status", "--session", "desk-other"], { ULTRATHINK_STATE_DIR: deps.stateDir });
		expect(other.text).not.toContain("(skipping next prompt)");
		expect(readSkipOnce(deps.stateDir, "desk-20261020-1200-slug")).toBe(true);
	});

	test("a grok-bot skip armed for the reserved next-request id makes that request's G plan return skipped, once", async () => {
		const root = tempRoot();
		const stateDir = join(root, "state");
		const env = (): NodeJS.ProcessEnv => ({ HOME: root, XDG_CONFIG_HOME: join(root, "xdg"), ULTRATHINK_DECISIONS: "0", ULTRATHINK_STATE_DIR: stateDir, PATH: process.env.PATH });
		const promptFile = join(root, "ORIGINAL.txt");
		writeFileSync(promptFile, "Add a CSV export button to the reports page.");
		// The skill reserves the next request's id N and arms the skip for it; the protocol then plans that request under N.
		expect((await grokbotMain(["ctl", "skip", "--session", "desk-20261022-0940-next"], env())).text).toContain("will skip the next prompt in this session");
		expect((await grokbotMain(["ctl", "status", "--session", "desk-20261022-0940-next"], env())).text).toContain("(skipping next prompt)");

		const skipped = await grokbotMain(["plan", "--session", "desk-20261022-0940-next", "--prompt-file", promptFile, "--cwd", root], env());
		expect(skipped.code).toBe(0);
		expect(JSON.parse(skipped.text)).toMatchObject({ status: "skipped", sessionId: "desk-20261022-0940-next", skipped: expect.stringContaining("skip") });
		expect(readSkipOnce(stateDir, "desk-20261022-0940-next")).toBe(false);
		expect((await grokbotMain(["ctl", "status", "--session", "desk-20261022-0940-next"], env())).text).not.toContain("(skipping next prompt)");

		// A request under any other fresh id is not skipped by it.
		await grokbotMain(["ctl", "skip", "--session", "desk-20261022-0941-next"], env());
		const other = await grokbotMain(["plan", "--session", "desk-20261022-0942-other", "--prompt-file", promptFile, "--cwd", root], env());
		expect(JSON.parse(other.text).status).not.toBe("skipped");
		expect(readSkipOnce(stateDir, "desk-20261022-0941-next")).toBe(true);
	});

	test("two conversations reserving in the same minute get their own ids, and each request with its own prompt is skipped", async () => {
		const root = tempRoot();
		const stateDir = join(root, "state");
		const env = (): NodeJS.ProcessEnv => ({ HOME: root, XDG_CONFIG_HOME: join(root, "xdg"), ULTRATHINK_DECISIONS: "0", ULTRATHINK_STATE_DIR: stateDir, PATH: process.env.PATH });
		const ids = ["desk-20261022-0940-next-1a2b3c4d", "desk-20261022-0940-next-9f8e7d6c"];
		const prompts = ["Add a CSV export button to the reports page.", "Rename the billing module to invoicing."];
		for (const id of ids) await grokbotMain(["ctl", "skip", "--session", id], env());
		for (const [i, id] of ids.entries()) {
			const file = join(root, `ORIGINAL-${i}.txt`);
			writeFileSync(file, prompts[i] as string);
			const planned = await grokbotMain(["plan", "--session", id, "--prompt-file", file, "--cwd", root], env());
			expect(planned.code).toBe(0);
			expect(JSON.parse(planned.text)).toMatchObject({ status: "skipped", sessionId: id });
			expect(readSkipOnce(stateDir, id)).toBe(false);
		}
	});

	test("the Markdown and Grok Bot skip/status fallbacks forward the current session id", () => {
		const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
		const read = (path: string) => readFileSync(join(root, path), "utf8");
		// Claude Code and Muse run commands/*.md when the prompt hook did not answer: both commands name this session.
		for (const verb of ["skip", "status"]) {
			const command = read(`commands/ultrathink-${verb}.md`);
			const runs = command.match(/bin\/ultrathink" [^`\n]*/g) ?? [];
			expect(runs.length).toBe(2);
			for (const run of runs) expect(run).toContain(`${verb} --session "\${CLAUDE_SESSION_ID}"`);
		}
		// Grok Bot's skills pass the planner session, so `G ctl skip` is not refused and `G ctl status` sees its flag.
		// Each request plans under a fresh id, so the skip reserves the next request's id `N` and the protocol plans under it.
		const skipSkill = read("hosts/grok-bot/skills/ultrathink-skip/SKILL.md");
		expect(skipSkill).toContain("`G ctl skip --session N`");
		// A new reservation carries a random suffix, so two conversations reserving in the same minute get different ids.
		expect(skipSkill).toContain("`desk-YYYYMMDD-HHMM-next-<8 random hex>`");
		expect(skipSkill).not.toContain("`desk-YYYYMMDD-HHMM-next`");
		expect(read("hosts/grok-bot/skills/ultrathink-status/SKILL.md")).toContain("`G ctl status --session N`");
		expect(read("hosts/grok-bot/skills/ultrathink-protocol/SKILL.md")).toContain("`G plan --session N`");
	});

	test("a skip read before an engine wait is consumed by the prompt that read it, and cleared with it", async () => {
		const deps = baseDeps();
		expect(await runControl(["skip"], { stateDir: deps.stateDir, cwd: "/repo", sessionId: "W2" })).toContain("will skip");
		const readBeforeWait = readSkipOnce(deps.stateDir, "W2");
		expect(readBeforeWait).toBe(true);
		const skipped = await runPromptSubmit({ session_id: "W2", cwd: "/repo", prompt: "add a widget" }, { ...deps, armedSkip: readBeforeWait });
		expect(skipped.skipped).toBe("skip");
		expect(readSkipOnce(deps.stateDir, "W2")).toBe(false);
	});

	test("a skip armed after the caller read the flag waits for the session's next prompt", async () => {
		const deps = baseDeps();
		// The caller read the flag (clear), then /ultrathink-skip is typed while the engine is being selected.
		const readBeforeWait = readSkipOnce(deps.stateDir, "W1");
		expect(readBeforeWait).toBe(false);
		expect(await runControl(["skip"], { stateDir: deps.stateDir, cwd: "/repo", sessionId: "W1" })).toContain("will skip");
		const during = await runPromptSubmit({ session_id: "W1", cwd: "/repo", prompt: "add a widget" }, { ...deps, armedSkip: readBeforeWait });
		expect(during.skipped).toBeUndefined();
		expect(readSkipOnce(deps.stateDir, "W1")).toBe(true);
		const next = await runPromptSubmit({ session_id: "W1", cwd: "/repo", prompt: "add a button" }, deps);
		expect(next.skipped).toBe("skip");
		expect(readSkipOnce(deps.stateDir, "W1")).toBe(false);
	});
});

describe("blank session ids", () => {
	test("two prompts with no session id get different turn records and never read each other's clarifications", async () => {
		const deps = baseDeps();

		const first = await runPromptSubmit({ cwd: "/repo", prompt: "add a widget" }, deps);
		const firstId = first.record?.sessionId ?? "";
		expect(isTurnSessionId(firstId)).toBe(true);
		const answered: Clarification = {
			id: "db",
			question: "Which database?",
			header: "Database",
			why: "storage",
			options: [{ label: "Postgres" }],
			blocking: true,
			answer: "Postgres",
			answeredAt: 2,
			source: "user",
		};
		updateSession(deps.stateDir, firstId, (record) => ({ ...record, clarifications: [answered] }));

		const second = await runPromptSubmit({ cwd: "/repo", prompt: "add a widget" }, deps);
		const secondId = second.record?.sessionId ?? "";
		expect(isTurnSessionId(secondId)).toBe(true);
		expect(secondId).not.toBe(firstId);
		expect(second.record?.plan?.graphId).toBeDefined();
		expect(second.record?.clarifications ?? []).not.toContainEqual(answered);
		expect(readSession(deps.stateDir, firstId)?.clarifications).toEqual([answered]);
		// The shared "unknown" record is never written, and no turn's state lands in a file another turn reads.
		expect(existsSync(sessionPath(deps.stateDir, "unknown"))).toBe(false);
	});
});
