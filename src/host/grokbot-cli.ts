// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * `bin/ultrathink-grokbot`: Desk Lead's native face of the planner. The host model answers every completion request
 * itself (see grokbot.ts); tracker writes go through Desk Lead's connectors (see grokbot-track.ts). Shipping is forced
 * off for every invocation (`ULTRATHINK_SHIP=0`); no subcommand merges, pushes, installs skills, or prints a key.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { runDecisionsCommand } from "../decisions/cli.ts";
import { CLARIFY_SYSTEM_PROMPT } from "../hitl/prompts.ts";
import { runHindsightCommand } from "../hindsight/cli.ts";
import { runRagflowCommand } from "../ragflow/cli.ts";
import { parseScore } from "../ship/greptile.ts";
import { runTeachCommand } from "../teach/cli.ts";
import { DISTILL_SYSTEM } from "../teach/observe.ts";
import { COT_SYSTEM_PROMPT, GRAPH_SYSTEM_PROMPT } from "../think/prompts.ts";
import { workflowWaves } from "../think/graph.ts";
import { readControl, sessionPath, type SessionRecord } from "../claude/state.ts";
import { UPLIFT_SYSTEM_PROMPT } from "../uplift/prompt.ts";
import { runControl, trackingOff } from "../uplift/commands.ts";
import {
	checkRecord,
	createJournalCompleter,
	deepenTargets,
	GROKBOT_ENGINE_HOST,
	grokbotStateDir,
	hostResolution,
	journalDir,
	listPending,
	readMeta,
	runGrokbotPlan,
	storeAnswer,
	thinkingOff,
} from "./grokbot.ts";
import { buildTrackPayloads, graphRegisterPayload, recordRefs } from "./grokbot-track.ts";
import { buildCloudPrompt, type UnitDispatch, validateCloudPrompt } from "./grokbot-prompts.ts";
import { claudeConfigPaths, loadConfig } from "../config.ts";
import { parseAnswersInput, recordAnswers } from "./grokbot-hitl.ts";
import { DEFAULT_INSTALLED_SKILLS, skillsStatus } from "./grokbot-skills.ts";
import { GROKBOT_TEACH_HOST, grokbotDigest } from "./grokbot-teach.ts";

const USAGE = `usage: ultrathink-grokbot <command>
  plan --session S (--prompt-file F | --stdin) [--transcript F] [--cwd D] [--replan]   run/resume the planner; prints pending requests
  pending --session S                         list unanswered requests (key, stage, node)
  show --session S <key> [--part system|user] print one pending request for the host model to answer
  answer --session S <key> (--file F | --stdin) [--replace]   validate + store an answer (never stored when invalid)
  answers --session S (--file F | --stdin)    fold Ming's replies ({"answers":{"q1"|question: answer}}) into the clarifications + spec
  status --session S                          journal status, plan check (nodes, steps, density band)
  deepen --session S                          nodes to deepen when a BUILD/CHANGE plan is below its density band
  summary --session S                         graph summary: nodes, steps per node, total, waves, questions, spec path
  track payloads --session S [--out F] [--project P] [--agent A]   dry-run tracker calls (Linear + Notion), placeholders only
  track record --session S --refs F           write real refs (from Desk Lead's connector results) into state + spec
  track register --session S [--with-nodes]   graph_register payload (graph id, Notion task, surface, status; nodes/steps opt-in)
  review read --repo owner/name --pr N [--from-dir D]   read-only Greptile score + open threads (public GitHub API)
  prompts [uplift|graph|cot|clarify|distill]  print the plugin's system prompts
  prompts build --session S --units units.json [--out-dir D]   cloud-agent prompts per graph node (validated; never launched)
  ctl <status|on|off|skip|last|track ..|think ..|hitl ..|grok ..>   planner controls (grok-bot state dir)
  decisions check | probe <point> <cases.json>
  teach <subcommand…>                         Teachable Moments (host grok-bot; promote: --target drafts only, never --install)
  teach digest --session S --transcript F [--outcome completed|failed|interrupted]   TeachDigest JSON for teach observe --stdin
  skills status [--installed DIR]             read-only drift check: staged hosts/grok-bot/skills vs installed copies
  hindsight … | ragflow …`;

type Out = { code: number; text: string };

function flag(args: string[], name: string): string | undefined {
	const i = args.indexOf(name);
	return i >= 0 ? args[i + 1] : undefined;
}

async function readStdin(): Promise<string> {
	return await new Response(Bun.stdin.stream()).text();
}

function session(args: string[]): string {
	const id = flag(args, "--session");
	if (!id) throw new Error("--session S is required");
	return id;
}

function statePathFor(stateDir: string, sessionId: string): string {
	return sessionPath(stateDir, sessionId);
}

function readRecord(stateDir: string, sessionId: string): { record: SessionRecord; path: string } {
	const path = statePathFor(stateDir, sessionId);
	return { record: JSON.parse(readFileSync(path, "utf8")) as SessionRecord, path };
}

const json = (value: unknown): string => JSON.stringify(value, null, 2);

export function promoteGuard(argv: string[]): string | undefined {
	if (argv[0] !== "promote") return undefined;
	if (argv.includes("--install")) return "teach promote --install is disabled for grok-bot (drafts only; install needs Ming's approval)";
	if (argv.includes("--due")) return undefined;
	const i = argv.indexOf("--target");
	if (i < 0 || argv[i + 1] !== "drafts") return "teach promote needs --target drafts for grok-bot";
	return undefined;
}

/** The plugin's status names the Grok CLI and its OAuth login, which grok-bot never uses: say so instead. */
export function grokbotStatusLines(text: string): string {
	const lines = text.split("\n");
	if (!lines.some((line) => /^(?:Grok: |SuperGrok OAuth: )/.test(line))) return text;
	const out: string[] = [];
	let noted = false;
	for (const line of lines) {
		if (/^(?:Grok: |SuperGrok OAuth: )/.test(line)) {
			if (!noted) out.push("Grok CLI: not used (grok-bot host: Desk Lead answers every planner request)");
			noted = true;
			continue;
		}
		out.push(line);
	}
	return out.join("\n");
}

export async function summarize(stateDir: string, sessionId: string, cwd = process.cwd()): Promise<Record<string, unknown>> {
	const { record, path } = readRecord(stateDir, sessionId);
	const check = checkRecord(record, { thinkOff: thinkingOff(stateDir, cwd) });
	const graph = record.graph;
	return {
		graphId: record.plan?.graphId,
		root: record.result.root,
		uplift: record.result.source,
		engine: record.engine,
		nodes: graph?.nodes.map((n) => ({ id: n.id, kind: n.kind, title: n.title, dependsOn: n.dependsOn, steps: check.stepsPerNode[n.id] })),
		totalSteps: check.totalSteps,
		band: check.band,
		belowBand: check.belowBand,
		waves: graph ? workflowWaves(graph) : [],
		clarifications: record.clarifications ?? [],
		decisions: (record.decisions ?? []).map((d) => d),
		degraded: record.degraded ?? [],
		statePath: path,
		specPath: path.replace(/\.json$/, ".xml"),
		check,
	};
}

/** Read-only fixture files (from the GitHub connector) standing in for the REST calls. */
export function dirFetcher(dir: string): typeof fetch {
	const files: Array<[RegExp, string]> = [
		[/\/pulls\/\d+\/comments/, "review-comments.json"],
		[/\/pulls\/\d+\/reviews/, "reviews.json"],
		[/\/issues\/\d+\/comments/, "issue-comments.json"],
		[/\/check-runs/, "check-runs.json"],
		[/\/pulls\/\d+$/, "pull.json"],
	];
	return (async (input: Parameters<typeof fetch>[0]) => {
		const url = String(input).split("?")[0] as string;
		const hit = files.find(([re]) => re.test(url));
		if (!hit) return new Response("{}", { status: 404 });
		return new Response(readFileSync(join(dir, hit[1]), "utf8"), { status: 200 });
	}) as unknown as typeof fetch;
}

export async function reviewRead(repo: string, pr: string, fetcher: typeof fetch = fetch): Promise<Record<string, unknown>> {
	const headers = { accept: "application/vnd.github+json", "user-agent": "ultrathink-grokbot" };
	const get = async <T,>(path: string): Promise<{ value: T; link: string | null }> => {
		const response = await fetcher(`https://api.github.com/repos/${repo}/${path}`, { headers });
		if (!response.ok) throw new Error(`GitHub ${path}: HTTP ${response.status}`);
		return { value: (await response.json()) as T, link: response.headers.get("link") };
	};
	/** Follows `rel="next"` and stops when a page is short of 100, so a fixture without a Link header is one page. */
	const getAll = async <T,>(path: string, take: (value: unknown) => T[]): Promise<T[]> => {
		const out: T[] = [];
		let next: string | undefined = `https://api.github.com/repos/${repo}/${path}${path.includes("?") ? "&" : "?"}per_page=100`;
		for (let page = 0; page < 20 && next; page++) {
			const response: Response = await fetcher(next, { headers });
			if (!response.ok) throw new Error(`GitHub ${path}: HTTP ${response.status}`);
			const batch: T[] = take(await response.json());
			out.push(...batch);
			const link: string = response.headers.get("link") ?? "";
			next = batch.length < 100 ? undefined : link.match(/<([^>]+)>;\s*rel="next"/)?.[1];
		}
		return out;
	};
	type Item = Record<string, unknown>;
	const isGreptile = (c: Item) => /greptile/i.test(String((c.user as { login?: string } | undefined)?.login ?? ""));
	const pull = (await get<Item>(`pulls/${pr}`)).value;
	const head = String((pull.head as { sha?: string } | undefined)?.sha ?? "");
	const [issueComments, reviews, reviewComments, checkRuns] = await Promise.all([
		getAll<Item>(`issues/${pr}/comments`, (value) => (Array.isArray(value) ? value as Item[] : [])),
		getAll<Item>(`pulls/${pr}/reviews`, (value) => (Array.isArray(value) ? value as Item[] : [])),
		getAll<Item>(`pulls/${pr}/comments`, (value) => (Array.isArray(value) ? value as Item[] : [])),
		head
			? getAll<Item>(`commits/${head}/check-runs`, (value) => {
				const runs = value && typeof value === "object" && !Array.isArray(value) ? (value as { check_runs?: Item[] }).check_runs : undefined;
				return runs ?? [];
			}).catch(() => [])
			: Promise.resolve([]),
	]);
	const greptileReviews = reviews.filter(isGreptile);
	const lastReview = greptileReviews[greptileReviews.length - 1];
	const headReview = [...greptileReviews].reverse().find((review) => review.commit_id === head);
	/** Issue comments and reviews are separate lists, so the newest score is by timestamp, not by which list was fetched last. */
	const scoredAt = (item: Item): number => {
		const raw = item.submitted_at ?? item.created_at;
		const ms = Date.parse(typeof raw === "string" ? raw : "");
		return Number.isFinite(ms) ? ms : 0;
	};
	const latestCommentScore = [...issueComments, ...reviews]
		.filter(isGreptile)
		.flatMap((item) => {
			const parsed = parseScore(String(item.body ?? ""));
			return parsed === null ? [] : [{ score: parsed, at: scoredAt(item) }];
		})
		.sort((a, b) => a.at - b.at)
		.at(-1)?.score;
	const headScore = headReview ? parseScore(String(headReview.body ?? "")) : null;
	const descriptionScore = parseScore(String(pull.body ?? ""));
	const score = headScore ?? latestCommentScore ?? descriptionScore;
	const roots = reviewComments.filter((c) => isGreptile(c) && !c.in_reply_to_id);
	const threads = roots.map((c) => ({
		path: c.path,
		line: c.line ?? c.original_line,
		onHead: c.commit_id === head,
		priority: String(c.body ?? "").match(/alt="(P[0-3])"/)?.[1],
		title: String(c.body ?? "").match(/\*\*([^*]+)\*\*/)?.[1],
		replies: reviewComments.filter((r) => r.in_reply_to_id === c.id).length,
	}));
	const greptileCheck = checkRuns.filter((r) => /greptile/i.test(String(r.name ?? "") + String((r.app as { slug?: string } | undefined)?.slug ?? "")));
	return {
		repo,
		pr: Number(pr),
		state: pull.state,
		draft: pull.draft,
		head: head.slice(0, 12),
		score,
		scoreSource: headScore !== null ? "head-review" : latestCommentScore !== undefined ? "latest-comment" : descriptionScore !== null ? "pr-description" : "none",
		lastGreptileReviewCommit: String(lastReview?.commit_id ?? "").slice(0, 12),
		reviewedHead: lastReview?.commit_id === head,
		greptileThreadsTotal: threads.length,
		greptileThreadsOnHead: threads.filter((t) => t.onHead).length,
		note: "REST cannot see thread resolution; resolved state needs the GitHub connector (GraphQL).",
		threads,
		greptileCheckRuns: greptileCheck.map((r) => ({ name: r.name, status: r.status, conclusion: r.conclusion })),
		retrigger: "fallback: post an @greptileai comment (needs approval)",
	};
}

export async function main(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<Out> {
	env.ULTRATHINK_SHIP = "0";
	env.ULTRATHINK_HOST = GROKBOT_ENGINE_HOST;
	const stateDir = grokbotStateDir(env);
	env.ULTRATHINK_STATE_DIR = stateDir;
	const [command, ...rest] = argv;
	const cwd = resolve(flag(rest, "--cwd") ?? process.cwd());
	switch (command) {
		case "plan": {
			const file = flag(rest, "--prompt-file");
			const prompt = file ? readFileSync(file, "utf8") : rest.includes("--stdin") ? await readStdin() : undefined;
			if (prompt === undefined) return { code: 2, text: "plan needs --prompt-file F or --stdin" };
			const transcript = flag(rest, "--transcript");
			const result = await runGrokbotPlan({ sessionId: session(rest), prompt, cwd, stateDir, env, replan: rest.includes("--replan"), ...(transcript ? { transcriptPath: resolve(transcript) } : {}) });
			const { response, ...view } = result;
			return { code: result.status === "invalid" ? 1 : 0, text: json({ ...view, ...(response ? { statePath: response.statePath, specPath: response.specPath, skipped: response.skipped } : {}) }) };
		}
		case "pending": {
			const dir = journalDir(stateDir, session(rest));
			return { code: 0, text: json(listPending(dir).map(({ key, stage, nodeId, nodeKind, nodeTitle }) => ({ key, stage, nodeId, nodeKind, nodeTitle }))) };
		}
		case "show": {
			const dir = journalDir(stateDir, session(rest));
			const key = rest.find((arg, i) => !arg.startsWith("--") && !rest[i - 1]?.startsWith("--"));
			const request = listPending(dir).find((r) => r.key === key);
			if (!request) return { code: 1, text: `no pending request ${key}` };
			const part = flag(rest, "--part");
			if (part === "system") return { code: 0, text: request.system };
			if (part === "user") return { code: 0, text: request.user };
			return { code: 0, text: `# stage ${request.stage}${request.nodeId ? ` · ${request.nodeId} (${request.nodeKind}) ${request.nodeTitle}` : ""}\n## SYSTEM\n${request.system}\n## USER\n${request.user}` };
		}
		case "answer": {
			const dir = journalDir(stateDir, session(rest));
			const key = rest.find((arg, i) => !arg.startsWith("--") && !rest[i - 1]?.startsWith("--"));
			if (!key) return { code: 2, text: "answer needs <key>" };
			const file = flag(rest, "--file");
			const raw = file ? readFileSync(file, "utf8") : await readStdin();
			const result = storeAnswer(dir, key, raw, { replace: rest.includes("--replace") });
			return { code: result.ok ? 0 : 1, text: json(result) };
		}
		case "answers": {
			const id = session(rest);
			const file = flag(rest, "--file");
			const raw = file ? readFileSync(file, "utf8") : rest.includes("--stdin") ? await readStdin() : undefined;
			if (raw === undefined) return { code: 2, text: "answers needs --file F or --stdin" };
			const outcome = recordAnswers(statePathFor(stateDir, id), parseAnswersInput(JSON.parse(raw)));
			if (outcome.unknownIds.length) return { code: 1, text: `unknown question id(s): ${outcome.unknownIds.join(", ")} (nothing recorded)` };
			return { code: 0, text: `HITL · ${outcome.matched.length} answer(s) recorded\n${json(outcome.list.map(({ id, question, answer, default: def, blocking }) => ({ id, question, blocking, ...(answer ? { answer } : { default: def }) })))}` };
		}
		case "skills": {
			if (rest[0] !== "status") return { code: 2, text: "skills status [--installed DIR] (read-only; installs need Ming's approval)" };
			const staged = resolve(import.meta.dir, "../../hosts/grok-bot/skills");
			const report = skillsStatus(staged, resolve(flag(rest, "--installed") ?? DEFAULT_INSTALLED_SKILLS));
			return { code: report.counts.drift || report.counts["not-installed"] ? 1 : 0, text: json(report) };
		}
		case "status": {
			const id = session(rest);
			const dir = journalDir(stateDir, id);
			let check: unknown;
			try {
				check = checkRecord(readRecord(stateDir, id).record, { thinkOff: thinkingOff(stateDir, cwd) });
			} catch {
				check = undefined;
			}
			return { code: 0, text: json({ meta: { ...readMeta(dir), original: undefined }, pending: listPending(dir).length, check }) };
		}
		case "deepen": {
			const check = checkRecord(readRecord(stateDir, session(rest)).record, { thinkOff: thinkingOff(stateDir, cwd) });
			return { code: 0, text: json({ totalSteps: check.totalSteps, band: check.band, belowBand: check.belowBand, deepen: deepenTargets(check) }) };
		}
		case "summary":
			return { code: 0, text: json(await summarize(stateDir, session(rest), cwd)) };
		case "track": {
			const sub = rest[0];
			const id = session(rest);
			const { record, path } = readRecord(stateDir, id);
			if (sub === "payloads") {
				const config = loadConfig(claudeConfigPaths(cwd, env));
				if (trackingOff(config, readControl(stateDir))) {
					const empty = { graphId: record.plan?.graphId, calls: [] as unknown[], counts: { linearIssues: 0, linearSubIssues: 0, notionTask: 0, notionIssues: 0, notionSubIssues: 0 }, tracking: "off" as const };
					const out = flag(rest, "--out");
					if (out) writeFileSync(out, `${json(empty)}\n`);
					return { code: 0, text: out ? json({ out, counts: empty.counts, calls: 0, graphId: empty.graphId, tracking: "off" }) : json(empty) };
				}
				const payloads = await buildTrackPayloads(record, {
					linearTeam: config.linear.team,
					notionDataSource: config.notion.dataSourceUrl,
					project: flag(rest, "--project") ?? "Kanban",
					agent: flag(rest, "--agent") ?? "grok-bot",
				});
				const text = json(payloads);
				const out = flag(rest, "--out");
				if (out) writeFileSync(out, `${text}\n`);
				return { code: 0, text: out ? json({ out, counts: payloads.counts, calls: payloads.calls.length, graphId: payloads.graphId }) : text };
			}
			if (sub === "record") {
				const refsFile = flag(rest, "--refs");
				if (!refsFile) return { code: 2, text: "track record needs --refs F" };
				const config = loadConfig(claudeConfigPaths(cwd, env));
				const parsed = JSON.parse(readFileSync(refsFile, "utf8")) as Parameters<typeof recordRefs>[1];
				const { tracking, todos } = recordRefs(path, {
					...parsed,
					trackers: parsed.trackers ?? { linear: config.linear.team.trim() !== "", notion: config.notion.dataSourceUrl.trim() !== "" },
				});
				return { code: tracking.status === "failed" ? 1 : 0, text: `tracking ${tracking.status} · graph ${tracking.graphId}\n\n${todos}` };
			}
			if (sub === "register") return { code: 0, text: json(graphRegisterPayload(record, { withNodes: rest.includes("--with-nodes") })) };
			return { code: 2, text: "track payloads|record|register" };
		}
		case "review": {
			if (rest[0] !== "read") return { code: 2, text: "review read --repo owner/name --pr N (read-only; never retriggers)" };
			const repo = flag(rest, "--repo");
			const pr = flag(rest, "--pr");
			if (!repo || !pr) return { code: 2, text: "review read needs --repo and --pr" };
			const fromDir = flag(rest, "--from-dir");
			return { code: 0, text: json(await reviewRead(repo, pr, fromDir ? dirFetcher(resolve(fromDir)) : fetch)) };
		}
		case "prompts": {
			if (rest[0] === "build") {
				const units = flag(rest, "--units");
				if (!units) return { code: 2, text: "prompts build needs --session S --units units.json [--out-dir D] (units: [{unit, mode, repo, branch, agentId?, pr?, seat?, base?, verify?, notes?, file?}])" };
				const { record } = readRecord(stateDir, session(rest));
				const outDir = resolve(flag(rest, "--out-dir") ?? ".");
				const list = JSON.parse(readFileSync(units, "utf8")) as Array<UnitDispatch & { file?: string }>;
				const report: Array<Record<string, unknown>> = [];
				let failed = 0;
				for (const dispatch of list) {
					const xml = buildCloudPrompt(record, dispatch);
					const check = validateCloudPrompt(xml, dispatch, record.result.original);
					const path = join(outDir, dispatch.file ?? `${dispatch.unit}.prompt.xml`);
					if (check.ok) writeFileSync(path, xml);
					else failed++;
					report.push({ unit: dispatch.unit, mode: dispatch.mode, agent: dispatch.agentId, path: check.ok ? path : undefined, ...check });
				}
				return { code: failed ? 1 : 0, text: json(report) };
			}
			const all: Record<string, string> = { uplift: UPLIFT_SYSTEM_PROMPT, graph: GRAPH_SYSTEM_PROMPT, cot: COT_SYSTEM_PROMPT, clarify: CLARIFY_SYSTEM_PROMPT, distill: DISTILL_SYSTEM };
			const which = rest[0];
			if (which) return all[which] ? { code: 0, text: all[which] } : { code: 2, text: `unknown prompt ${which}` };
			return { code: 0, text: Object.entries(all).map(([k, v]) => `## ${k}\n${v}`).join("\n\n") };
		}
		case "ctl":
			return { code: 0, text: grokbotStatusLines(await runControl(rest, { stateDir, cwd, host: GROKBOT_ENGINE_HOST, modelResolution: hostResolution() })) };
		case "decisions":
			return await runDecisionsCommand(rest, { cwd });
		case "hindsight":
			return await runHindsightCommand(rest, { cwd, env });
		case "ragflow":
			return await runRagflowCommand(rest, { cwd, env });
		case "teach": {
			if (rest[0] === "digest") {
				const transcript = flag(rest, "--transcript");
				if (!transcript) return { code: 2, text: "teach digest needs --session S --transcript F" };
				const outcome = flag(rest, "--outcome");
				if (outcome !== undefined && !["completed", "failed", "interrupted"].includes(outcome)) return { code: 2, text: "--outcome must be completed, failed or interrupted" };
				const digest = grokbotDigest(resolve(transcript), { sessionId: session(rest), cwd, ...(outcome ? { outcome: outcome as "completed" } : {}) });
				return digest ? { code: 0, text: json(digest) } : { code: 1, text: "transcript has no user/assistant turns" };
			}
			const blocked = promoteGuard(rest);
			if (blocked) return { code: 2, text: blocked };
			const journal = createJournalCompleter({ dir: journalDir(stateDir, "teach") });
			// Moments are captured as host grok-bot; an unknown host's promotion target is drafts, so even with
			// teach.autoPromote on nothing is installed into another host's skill directory.
			const teachEnv = { ...env, ULTRATHINK_HOST: GROKBOT_TEACH_HOST };
			const result = await runTeachCommand(rest, { cwd, env: teachEnv, stateDir, stdin: readStdin, complete: journal.complete });
			const missed = journal.missed();
			if (missed.length === 0) return result;
			return { code: result.code, text: `${result.text}\n${json({ needsModel: missed.map(({ key, stage }) => ({ key, stage, session: "teach" })) })}` };
		}
		default:
			return { code: command ? 2 : 0, text: USAGE };
	}
}

if (import.meta.main) {
	main(process.argv.slice(2))
		.then(({ code, text }) => process.stdout.write(`${text}\n`, () => process.exit(code)))
		.catch((error: unknown) => {
			process.stderr.write(`ultrathink-grokbot: ${error instanceof Error ? error.message : String(error)}\n`, () => process.exit(1));
		});
}
