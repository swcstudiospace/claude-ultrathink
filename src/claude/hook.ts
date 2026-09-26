// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Orchestrates one UserPromptSubmit event: decide → uplift → Graph of Thought
 * with per-node rationale/conclusion fills → HITL clarifications → build a Notion/Linear
 * TrackPlan → persist session state → return the spec plus an instruction to
 * invoke ultrathink-kickoff as hook context. Everything after "decide" is
 * fail-open: the user's prompt always goes through.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { UltrathinkConfig } from "../config.ts";
import { createGreptileKnowledge, type KnowledgeLookup, type KnowledgeReader, type KnowledgeResult, type KnowledgeSession } from "../greptile/knowledge.ts";
import { injectClarificationsXml } from "../hitl/format.ts";
import { normalizeQuestion, type RunClarifyOptions, runClarify } from "../hitl/pipeline.ts";
import type { Clarification } from "../hitl/types.ts";
import { runThink } from "../think/pipeline.ts";
import type { ThoughtGraph } from "../think/types.ts";
import { fetchBrief } from "../substrate/brief.ts";
import { resolveBranch, resolveRepoSlug } from "../track/git.ts";
import { buildTrackPlan } from "../track/plan.ts";
import type { Tracker } from "../track/gateway.ts";
import { injectTrackingXml } from "../track/render.ts";
import type { TrackingRefs, TrackPlan } from "../track/types.ts";
import type { ProgressEvent, ProgressSink, StageName } from "../host/progress.ts";
import type { UpliftResult, UpliftState } from "../types.ts";
import { decideUplift } from "../uplift/detect.ts";
import type { SkillInvocation } from "../uplift/skill.ts";
import { runUplift } from "../uplift/run.ts";
import type { ClaudeCompleter } from "./complete.ts";
import { formatPromptContext, formatSummary } from "./output.ts";
import { shipApplies } from "../ship/policy.ts";
import { type ControlState, readSession, type SessionRecord, sessionPath, writeControl, writeSession } from "./state.ts";

export interface PromptSubmitInput {
	session_id?: string;
	transcript_path?: string;
	cwd?: string;
	prompt?: string;
	hook_event_name?: string;
	/** Set when `prompt` is the instruction (or objective) of a skill invocation; the skill stays authoritative. */
	skill?: SkillInvocation;
}

export interface HookOutput {
	hookSpecificOutput: { hookEventName: "UserPromptSubmit"; additionalContext: string };
	systemMessage?: string;
}

export interface HookDeps {
	config: UltrathinkConfig;
	control: ControlState;
	complete: ClaudeCompleter;
	/** Thinking engine label recorded and echoed, e.g. "grok-4.7@xhigh", "<shuntModel or model>@shunt" or "claude:sonnet". */
	engine: string;
	stateDir: string;
	clarify?: (opts: RunClarifyOptions) => Promise<Clarification[]>;
	/** First error the completer threw (already redacted), surfaced in the summary. */
	engineError?: () => string | undefined;
	/** Test seam for git remote/branch resolution; default reads the real repo at cwd. */
	git?: (cwd: string) => { repo?: string; branch?: string };
	conversation?: (transcriptPath?: string) => string;
	/** Test seam for the Agent Substrate brief; defaults to the real fail-open HTTP call against `config.substrate.url`. */
	brief?: (input: { repo?: string; branch?: string; surface?: string }) => Promise<string>;
	/** Host that asked for the brief. Defaults to Claude so existing callers stay stable. */
	surface?: string;
	now?: () => number;
	log?: (message: string) => void;
	/** Creates tracker rows through the MCP gateway before the prompt goes out; fail-open. */
	track?: Tracker;
	/** Deterministic command the kickoff skill runs to finish missing rows. */
	trackCommand?: string;
	/** Tracking is off for this prompt: no tracker call, no kickoff instruction or Linked issues; the plan is still recorded. */
	trackingOff?: boolean;
	/** Structured live progress (Omp status bar); a throwing sink never breaks planning. */
	progress?: ProgressSink;
	/** Test seam for the Greptile knowledge-base prefetch; defaults to `createGreptileKnowledge(config)` (undefined unless opted in). */
	knowledge?: KnowledgeReader;
}

export interface PromptSubmitResult {
	output?: HookOutput;
	record?: SessionRecord;
	skipped?: string;
}

function specFile(stateDir: string, sessionId: string): string {
	return sessionPath(stateDir, sessionId).replace(/\.json$/, ".xml");
}

/** What the knowledge base should be matched against: the uplifted spec plus the graph's goal and node conclusions. */
function knowledgeTopic(result: UpliftResult, graph: ThoughtGraph | undefined): string {
	const parts = [result.xml];
	if (graph) {
		parts.push(graph.goal);
		for (const node of graph.nodes) parts.push(node.conclusion ? `${node.title}: ${node.conclusion}` : node.title);
	}
	return parts.filter(Boolean).join("\n");
}

/** Awaits a knowledge read; a session that breaks its never-rejects contract still fails open as an error lookup. */
async function readKnowledge(session: KnowledgeSession, topic: string): Promise<KnowledgeResult> {
	try {
		return await session.read(topic);
	} catch (error) {
		const reason = (error instanceof Error ? error.message : String(error)).split("\n")[0]?.slice(0, 200) ?? "error";
		return { lookup: { outcome: "error", docs: [], chars: 0, ms: 0, reason }, digest: "" };
	}
}

export async function runPromptSubmit(input: PromptSubmitInput, deps: HookDeps): Promise<PromptSubmitResult> {
	const now = deps.now ?? Date.now;
	const emit = (event: ProgressEvent): void => {
		try {
			deps.progress?.(event);
		} catch {
			// fail-open: progress is display only
		}
	};
	const stage = (name: StageName, phase: "start" | "end", ok?: boolean, detail?: string): void =>
		emit({ type: "stage", at: now(), stage: name, phase, ...(ok === undefined ? {} : { ok }), ...(detail ? { detail } : {}) });
	const started = now();
	const log = deps.log ?? (() => {});
	const cwd = input.cwd?.trim() || process.cwd();
	const sessionId = input.session_id?.trim() || "unknown";

	const state: UpliftState = {
		enabled: deps.control.enabled ?? deps.config.uplift.enabled,
		skipOnce: deps.control.skipOnce === true,
		skipTrivial: deps.config.uplift.skipTrivial,
	};
	const decision = decideUplift({ text: input.prompt ?? "", source: "user", idle: true }, state);
	if (deps.control.skipOnce && !state.skipOnce) {
		try {
			writeControl(deps.stateDir, { skipOnce: false });
		} catch {
			// fail-open
		}
	}
	if (decision.action !== "uplift") return { skipped: decision.action };
	const skill = input.skill;
	emit({
		type: "begin",
		at: now(),
		sessionId,
		engine: deps.engine,
		track: deps.track !== undefined && !deps.trackingOff,
		...(skill ? { skill: skill.name } : {}),
	});
	let outcome: "planned" | "skipped" | "failed" = "failed";
	let outcomeDetail: string | undefined;

	const controller = new AbortController();
	let session: KnowledgeSession | undefined;
	const budget =
		deps.config.claude.budgetMs > 0 ? setTimeout(() => controller.abort(), deps.config.claude.budgetMs) : undefined;
	try {
		const original = decision.text;
		const history = deps.conversation?.(input.transcript_path) ?? "";
		const skillLine = skill
			? `The user invoked the "${skill.name}" skill with this message.${skill.summary ? ` Skill summary: ${skill.summary}` : ""}`
			: "";
		const conversation = [skillLine, history].filter(Boolean).join("\n");

		// Resolved once and shared by the brief and the TrackPlan below.
		const git = (() => {
			try {
				return deps.git?.(cwd) ?? { repo: resolveRepoSlug(cwd), branch: resolveBranch(cwd) };
			} catch {
				return {} as { repo?: string; branch?: string };
			}
		})();

		// Decided before the brief: the knowledge-base prefetch only runs when clarify will.
		const hitlOn = deps.control.hitlEnabled ?? deps.config.hitl.enabled;

		// Started now, awaited before the Graph of Thought: the graph is then
		// planned knowing what other agents already did, and the round trip
		// overlaps the uplift call instead of adding to it.
		stage("brief", "start");
		const fetchSessionBrief = deps.brief ?? ((brief) => fetchBrief(brief, process.env, deps.config.substrate.url));
		const briefPromise = fetchSessionBrief({
			repo: git.repo,
			branch: git.branch,
			surface: deps.surface ?? "claude-code",
		}).catch(() => "");

		// The knowledge-base prefetch (find the repo, list documents, read index.md) overlaps the uplift and the
		// Graph of Thought; the topic-specific documents are read right before clarify.
		const reader = hitlOn ? (deps.knowledge ?? createGreptileKnowledge(deps.config)) : undefined;
		if (reader) {
			try {
				session = reader.start({ repo: git.repo, signal: controller.signal });
				stage("knowledge", "start");
			} catch (error) {
				log(`greptile knowledge base: start failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		}

		let result: UpliftResult;
		stage("uplift", "start");
		try {
			result = await runUplift({
				original,
				conversation,
				complete: deps.complete,
				signal: controller.signal,
				maxChars: deps.config.uplift.maxChars,
			});
		} catch (error) {
			log(`uplift failed: ${error instanceof Error ? error.message : String(error)}`);
			stage("uplift", "end", false);
			outcome = "skipped";
			outcomeDetail = "uplift-failed";
			return { skipped: "uplift-failed" };
		}
		stage("uplift", "end", true, `${result.root} · ${result.source}`);

		const brief = await briefPromise;
		if (brief) log(`substrate brief: ${brief.split("\n").length} lines`);
		stage("brief", "end", true, brief ? `${brief.split("\n").length} lines` : "none");

		let graph: ThoughtGraph | undefined;
		const thinkOn = deps.control.thinkEnabled ?? deps.config.think.enabled;
		if (thinkOn && !controller.signal.aborted) {
			stage("think", "start");
			try {
				const thought = await runThink({
					uplift: result,
					complete: deps.complete,
					signal: controller.signal,
					minNodes: deps.config.think.minNodes,
					maxNodes: deps.config.think.maxNodes,
					concurrency: deps.config.claude.concurrency,
					onProgress: log,
					onEvent: (event) => emit({ ...event, at: now() }),
				});
				result = thought;
				graph = thought.graph;
				stage("think", "end", true, `${graph.nodes.length} nodes`);
			} catch (error) {
				log(`think failed: ${error instanceof Error ? error.message : String(error)}`);
				stage("think", "end", false);
			}
		}

		/** Answered clarifications from an earlier turn of this session survive; stale open ones are dropped. */
		let clarifications: Clarification[] = (readSession(deps.stateDir, sessionId)?.clarifications ?? []).filter(
			(c) => c.answer && c.source !== "knowledge",
		);

		// Always awaited once started (it honours the abort signal and never rejects) so the record says what happened.
		let knowledge: KnowledgeLookup | undefined;
		let knowledgeInput: { digest: string; docs: string[] } | undefined;
		if (session) {
			const read = await readKnowledge(session, knowledgeTopic(result, graph));
			const lookup = read.lookup;
			log(
				`greptile knowledge base: ${lookup.outcome}${lookup.docs.length > 0 ? ` · ${lookup.docs.join(", ")}` : ""}${lookup.reason ? ` · ${lookup.reason}` : ""} · ${lookup.ms}ms`,
			);
			stage("knowledge", "end", lookup.outcome !== "error", lookup.outcome === "used" ? `${lookup.docs.length} docs` : lookup.outcome);
			knowledge = { ...lookup, settled: 0 };
			if (lookup.outcome === "used") knowledgeInput = { digest: read.digest, docs: lookup.docs };
		}
		if (hitlOn && !controller.signal.aborted) {
			stage("clarify", "start");
			try {
				const fresh = await (deps.clarify ?? runClarify)({
					uplift: result,
					graph,
					conversation,
					answered: clarifications,
					complete: deps.complete,
					signal: controller.signal,
					maxQuestions: deps.config.hitl.maxQuestions,
					onProgress: log,
					...(knowledgeInput ? { knowledge: knowledgeInput } : {}),
				});
				const seen = new Set(clarifications.map((c) => normalizeQuestion(c.question)));
				const kept = fresh.filter((c) => !seen.has(normalizeQuestion(c.question)));
				clarifications = [...clarifications, ...kept];
				if (knowledge) knowledge = { ...knowledge, settled: kept.filter((c) => c.source === "knowledge").length };
				stage("clarify", "end", true, `${clarifications.length} question${clarifications.length === 1 ? "" : "s"}`);
			} catch (error) {
				log(`clarify failed: ${error instanceof Error ? error.message : String(error)}`);
				stage("clarify", "end", false);
			}
		}
		if (clarifications.length > 0) {
			result = { ...result, xml: injectClarificationsXml(result.xml, clarifications) };
		}

		let plan: TrackPlan | undefined;
		// Fail-open per design: a totally failed engine (conservative XML fallback) proceeds
		// untracked rather than creating generic FALLBACK_GRAPH boilerplate rows in the shared
		// Notion/Linear tracker on every engine outage. Only build a plan for real LLM output.
		if (result.source !== "fallback") {
			stage("plan", "start");
			try {
				plan = buildTrackPlan({
					uplift: result,
					graph,
					clarifications,
					repo: git.repo,
					branch: git.branch,
					agent: deps.surface ?? "claude-code",
				});
				stage("plan", "end", true, `${plan.linearIssues.length} issues · ${plan.linearSubIssues.length} steps`);
			} catch (error) {
				log(`track plan failed: ${error instanceof Error ? error.message : String(error)}`);
				stage("plan", "end", false);
			}
		}

		let tracking: TrackingRefs | undefined;
		if (plan && deps.track && !deps.trackingOff) {
			stage("track", "start");
			tracking = await deps.track({ plan, graph, signal: controller.signal, progress: deps.progress }).catch((error: unknown) => {
				log(`tracking failed: ${error instanceof Error ? error.message : String(error)}`);
				return undefined;
			});
			if (tracking) {
				result = { ...result, xml: injectTrackingXml(result.xml, plan, tracking) };
				log(`tracking ${tracking.status}${tracking.errors.length > 0 ? `: ${tracking.errors.join("; ")}` : ""}`);
				const issues = Object.keys(tracking.linear.nodes).length;
				stage("track", "end", tracking.status !== "failed", `${tracking.status} · ${issues}/${plan.linearIssues.length} issues`);
			} else {
				stage("track", "end", false);
			}
		}

		const record: SessionRecord = {
			sessionId,
			at: now(),
			engine: deps.engine,
			host: deps.surface ?? "claude-code",
			result,
			graph,
			clarifications,
			plan,
			tracking,
			...(skill ? { skill: { name: skill.name, ...(skill.summary ? { summary: skill.summary } : {}), source: skill.source } } : {}),
			kickedOff: false,
			synced: false,
			...(knowledge ? { knowledge } : {}),
		};
		let specPath: string | undefined;
		let statePath: string | undefined;
		stage("state", "start");
		try {
			specPath = specFile(deps.stateDir, sessionId);
			mkdirSync(dirname(specPath), { recursive: true });
			writeFileSync(specPath, `${result.xml}\n`);
			writeSession(deps.stateDir, record);
			statePath = sessionPath(deps.stateDir, sessionId);
			stage("state", "end", true);
		} catch (error) {
			log(`state write failed: ${error instanceof Error ? error.message : String(error)}`);
			specPath = undefined;
			statePath = undefined;
			stage("state", "end", false);
		}

		const providers = { linear: deps.config.linear.team.trim() !== "", notion: deps.config.notion.dataSourceUrl.trim() !== "" };
		const output: HookOutput = {
			hookSpecificOutput: {
				hookEventName: "UserPromptSubmit",
				additionalContext: formatPromptContext({
					result,
					graph,
					clarifications,
					brief,
					statePath,
					specPath,
					plan,
					tracking,
					trackCommand: deps.trackCommand,
					...(skill ? { skill: skill.name } : {}),
					ship: shipApplies(deps.config.ship, skill?.name),
					trackingOff: deps.trackingOff,
					providers,
					knowledge,
					skillHints: deps.surface === "hermes",
					// No spec file (the write failed) means nothing to point at: fall back to the inline spec.
					handoff: deps.surface === "hermes" && specPath !== undefined,
				}),
			},
		};
		if (deps.config.claude.echo) {
			output.systemMessage = formatSummary({
				result,
				engine: deps.engine,
				graph,
				clarifications,
				brief,
				tracked: Boolean(plan && statePath) && !deps.trackingOff,
				tracking,
				plan,
				...(skill ? { skill: skill.name } : {}),
				trackingOff: deps.trackingOff,
				providers,
				knowledge,
				engineError: deps.engineError?.(),
				elapsedMs: now() - started,
			});
		}
		outcome = "planned";
		return { output, record };
	} catch (error) {
		outcomeDetail = error instanceof Error ? error.name : "error";
		throw error;
	} finally {
		session?.close();
		clearTimeout(budget);
		emit({ type: "end", at: now(), outcome, ...(outcomeDetail ? { detail: outcomeDetail } : {}) });
	}
}
