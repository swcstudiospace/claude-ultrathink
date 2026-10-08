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
import { sessionPath, type SessionRecord } from "../claude/state.ts";
import { UPLIFT_SYSTEM_PROMPT } from "../uplift/prompt.ts";
import { runControl } from "../uplift/commands.ts";
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
} from "./grokbot.ts";
import { buildTrackPayloads, recordRefs } from "./grokbot-track.ts";
import { buildCloudPrompt, type UnitDispatch, validateCloudPrompt } from "./grokbot-prompts.ts";
import { claudeConfigPaths, loadConfig } from "../config.ts";

const USAGE = `usage: ultrathink-grokbot <command>
  plan --session S (--prompt-file F | --stdin) [--transcript F] [--cwd D] [--replan]   run/resume the planner; prints pending requests
  pending --session S                         list unanswered requests (key, stage, node)
  show --session S <key> [--part system|user] print one pending request for the host model to answer
  answer --session S <key> (--file F | --stdin) [--replace]   validate + store an answer (never stored when invalid)
  status --session S                          journal status, plan check (nodes, steps, density band)
  deepen --session S                          nodes to deepen when a BUILD/CHANGE plan is below its density band
  summary --session S                         graph summary: nodes, steps per node, total, waves, questions, spec path
  track payloads --session S [--out F] [--project P] [--agent A]   dry-run tracker calls (Linear + Notion), placeholders only
  track record --session S --refs F           write real refs (from Desk Lead's connector results) into state + spec
  review read --repo owner/name --pr N [--from-dir D]   read-only Greptile score + open threads (public GitHub API)
  prompts [uplift|graph|cot|clarify|distill]  print the plugin's system prompts
  prompts build --session S --units units.json [--out-dir D]   cloud-agent prompts per graph node (validated; never launched)
  ctl <status|on|off|skip|last|track ..|think ..|hitl ..|grok ..>   planner controls (grok-bot state dir)
  decisions check | probe <point> <cases.json>
  teach <subcommand…>                         Teachable Moments (promote: --target drafts only, never --install)
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

export async function summarize(stateDir: string, sessionId: string): Promise<Record<string, unknown>> {
	const { record, path } = readRecord(stateDir, sessionId);
	const check = checkRecord(record);
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
	const get = async <T,>(path: string): Promise<T> => {
		const response = await fetcher(`https://api.github.com/repos/${repo}/${path}`, { headers });
		if (!response.ok) throw new Error(`GitHub ${path}: HTTP ${response.status}`);
		return (await response.json()) as T;
	};
	type Item = Record<string, unknown>;
	const isGreptile = (c: Item) => /greptile/i.test(String((c.user as { login?: string } | undefined)?.login ?? ""));
	const pull = await get<Item>(`pulls/${pr}`);
	const head = String((pull.head as { sha?: string } | undefined)?.sha ?? "");
	const [issueComments, reviews, reviewComments, checks] = await Promise.all([
		get<Item[]>(`issues/${pr}/comments?per_page=100`),
		get<Item[]>(`pulls/${pr}/reviews?per_page=100`),
		get<Item[]>(`pulls/${pr}/comments?per_page=100`),
		head ? get<{ check_runs?: Item[] }>(`commits/${head}/check-runs?per_page=100`).catch(() => ({ check_runs: [] })) : Promise.resolve({ check_runs: [] }),
	]);
	// Greptile writes its summary (with the confidence score) into the PR description and/or a comment.
	const bodies = [String(pull.body ?? ""), ...[...issueComments, ...reviews].filter(isGreptile).map((c) => String(c.body ?? ""))];
	const scores = bodies.map(parseScore).filter((s): s is number => s !== null);
	const greptileReviews = reviews.filter(isGreptile);
	const lastReview = greptileReviews[greptileReviews.length - 1];
	const roots = reviewComments.filter((c) => isGreptile(c) && !c.in_reply_to_id);
	const threads = roots.map((c) => ({
		path: c.path,
		line: c.line ?? c.original_line,
		onHead: c.commit_id === head,
		priority: String(c.body ?? "").match(/alt="(P[0-3])"/)?.[1],
		title: String(c.body ?? "").match(/\*\*([^*]+)\*\*/)?.[1],
		replies: reviewComments.filter((r) => r.in_reply_to_id === c.id).length,
	}));
	const greptileCheck = (checks.check_runs ?? []).filter((r) => /greptile/i.test(String(r.name ?? "") + String((r.app as { slug?: string } | undefined)?.slug ?? "")));
	return {
		repo,
		pr: Number(pr),
		state: pull.state,
		draft: pull.draft,
		head: head.slice(0, 12),
		score: scores.length ? scores[0] : null,
		scoreSource: scores.length ? "pr-description-or-comment" : "none",
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
		case "status": {
			const id = session(rest);
			const dir = journalDir(stateDir, id);
			let check: unknown;
			try {
				check = checkRecord(readRecord(stateDir, id).record);
			} catch {
				check = undefined;
			}
			return { code: 0, text: json({ meta: { ...readMeta(dir), original: undefined }, pending: listPending(dir).length, check }) };
		}
		case "deepen": {
			const check = checkRecord(readRecord(stateDir, session(rest)).record);
			return { code: 0, text: json({ totalSteps: check.totalSteps, band: check.band, belowBand: check.belowBand, deepen: deepenTargets(check) }) };
		}
		case "summary":
			return { code: 0, text: json(await summarize(stateDir, session(rest))) };
		case "track": {
			const sub = rest[0];
			const id = session(rest);
			const { record, path } = readRecord(stateDir, id);
			if (sub === "payloads") {
				const config = loadConfig(claudeConfigPaths(cwd));
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
				const { tracking, todos } = recordRefs(path, JSON.parse(readFileSync(refsFile, "utf8")));
				return { code: tracking.status === "failed" ? 1 : 0, text: `tracking ${tracking.status} · graph ${tracking.graphId}\n\n${todos}` };
			}
			return { code: 2, text: "track payloads|record" };
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
			return { code: 0, text: await runControl(rest, { stateDir, cwd, host: GROKBOT_ENGINE_HOST, modelResolution: hostResolution() }) };
		case "decisions":
			return await runDecisionsCommand(rest, { cwd });
		case "hindsight":
			return await runHindsightCommand(rest, { cwd, env });
		case "ragflow":
			return await runRagflowCommand(rest, { cwd, env });
		case "teach": {
			const blocked = promoteGuard(rest);
			if (blocked) return { code: 2, text: blocked };
			const journal = createJournalCompleter({ dir: journalDir(stateDir, "teach") });
			const result = await runTeachCommand(rest, { cwd, env, stateDir, stdin: readStdin, complete: journal.complete });
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
