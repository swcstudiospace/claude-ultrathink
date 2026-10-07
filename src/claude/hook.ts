// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Orchestrates one UserPromptSubmit event: decide → Jev plan gate (opt-in) → uplift → Graph of Thought
 * with per-node rationale/conclusion fills → HITL clarifications → build a Notion/Linear
 * TrackPlan → persist session state → return the spec plus an instruction to
 * invoke ultrathink-kickoff as hook context. Everything after "decide" is
 * fail-open: the user's prompt always goes through. A caller cancellation (HookDeps.signal) is re-thrown as an
 * AbortError at every stage boundary, and nothing later starts.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { UltrathinkConfig } from "../config.ts";
import { createDecisions, type DecisionsDeps } from "../decisions/gate.ts";
import type { DecisionRecord } from "../decisions/types.ts";
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
import type { ModelResolution } from "../host/engine.ts";
import type { ProgressEvent, ProgressSink, StageName } from "../host/progress.ts";
import type { UpliftResult, UpliftState } from "../types.ts";
import { docsLookup, formatDocsSection, groundDocs } from "../ragflow/ground.ts";
import { teachContext, teachEnabled } from "../teach/context.ts";
import { formatLessonsSection, lessonsLookup, recallLessons } from "../teach/recall.ts";
import type { GroundOutcome, DocsLookup } from "../ragflow/types.ts";
import { formatSkillsSection, recallSkills, skillsLookup, SKILL_SECTION_CHARS } from "../teach/skills.ts";
import type { LessonsLookup, RecallOutcome, SkillRecallOutcome, SkillsLookup } from "../teach/types.ts";
import { isSubagentEnvelope } from "../host/envelope.ts";
import { decideUplift } from "../uplift/detect.ts";
import type { SkillInvocation } from "../uplift/skill.ts";
import { runUplift } from "../uplift/run.ts";
import { type ClaudeCompleter, isChildInvocation } from "./complete.ts";
import { formatPlanSkipNotice, formatPromptContext, formatSummary } from "./output.ts";
import { JEV_PLAN_SKIP, planGate } from "./plan-gate.ts";
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
	/** Thinking engine label recorded and echoed: the selected route and its wire model, e.g. "claude:<model>", "<model>@<effort>" or "<shuntModel or model>@shunt". */
	engine: string;
	/**
	 * Safe selection record of `complete` (UT-Planning-ModelSelection §6). Reported on progress begin/end and in the
	 * summary and context, and persisted on the SessionRecord of a real plan only. Absent for legacy injected callers.
	 */
	modelResolution?: ModelResolution;
	stateDir: string;
	clarify?: (opts: RunClarifyOptions) => Promise<Clarification[]>;
	/** First error the completer threw (already redacted), surfaced in the summary. */
	engineError?: () => string | undefined;
	/** Test seam for git remote/branch resolution; default reads the real repo at cwd. */
	git?: (cwd: string) => { repo?: string; branch?: string };
	conversation?: (transcriptPath?: string) => string;
	/** Test seam for the Agent Substrate brief; defaults to the real fail-open HTTP call against `config.substrate.url`. */
	brief?: (input: { repo?: string; branch?: string; surface?: string; signal?: AbortSignal }) => Promise<string>;
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
	/**
	 * The whole planning lifetime (caller or flight cancellation). Combined with `config.claude.budgetMs` and passed to the
	 * Jev gate, the brief, every lookup and stage, and tracking; once it aborts, the next stage boundary throws an
	 * AbortError and no later stage, tracker call, state write or delivery starts.
	 */
	signal?: AbortSignal;
	/** Seams for the Decisions runtime (env, storePath, fetch, now, sleep, random, debug); config comes from config.decisions. */
	decisionsDeps?: DecisionsDeps;
	/**
	 * Lessons lookup (Teachable Moments). Defaults to `recallLessons` when `config.teach.enabled && config.teach.recall`;
	 * an injected seam always runs. Gets only the user's original prompt (truncated), never the spec or history.
	 */
	recall?: (input: { query: string; cwd: string; signal: AbortSignal }) => Promise<RecallOutcome>;
	/** RAGFlow document grounding. Defaults to `groundDocs` when `config.ragflow.enabled && config.ragflow.ground`; same query rule. */
	ground?: (input: { query: string; signal: AbortSignal }) => Promise<GroundOutcome>;
	/**
	 * Promoted-skills lookup (Teachable Moments). Defaults to `recallSkills` when `config.teach.enabled && config.teach.recall`;
	 * an injected seam always runs. Same query rule as `recall`.
	 */
	skills?: (input: { query: string; cwd: string; signal: AbortSignal }) => Promise<SkillRecallOutcome>;
}

export interface PromptSubmitResult {
	output?: HookOutput;
	record?: SessionRecord;
	skipped?: string;
	/** Jev skip notice (§5.3); set only on a Jev skip with claude.echo on. */
	notice?: string;
	/** Every DecisionRecord of this prompt, in call order; absent when none. */
	decisions?: DecisionRecord[];
}

function specFile(stateDir: string, sessionId: string): string {
	return sessionPath(stateDir, sessionId).replace(/\.json$/, ".xml");
}

/**
 * What the knowledge base should be matched against: the uplifted spec's text plus the graph's goal and node titles and
 * conclusions. Tags are stripped: their names and attributes (GRAPH_OF_THOUGHT, NODE, kind, …) would otherwise score
 * unrelated routing entries on every request.
 */
function knowledgeTopic(result: UpliftResult, graph: ThoughtGraph | undefined): string {
	const parts = [result.xml.replace(/<[^>]*>/g, " ")];
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

/**
 * Cancellation is the caller's lifetime (HookDeps.signal) ending: thrown as an AbortError whatever its reason (a timeout
 * included), never swallowed into a fallback. The hook budget alone is not cancellation; it keeps its documented "plan
 * built so far" behavior.
 */
function throwIfCancelled(lifetime: AbortSignal | undefined): void {
	if (!lifetime?.aborted) return;
	const error = new Error("Planning cancelled");
	error.name = "AbortError";
	throw error;
}

const LOOKUP_QUERY_CHARS = 1_500;
/** How long a seam may overrun its own signal before the plan stops waiting for it. */
const LOOKUP_GRACE_MS = 150;

interface LookupInput {
	query: string;
	env: NodeJS.ProcessEnv;
	parent: AbortSignal;
	now: () => number;
}

/**
 * Runs one evidence lookup with a hard deadline: the signal aborts at `timeoutMs` and the plan stops waiting shortly
 * after, so a seam that ignores its signal still cannot hold the prompt. A parent abort releases the waiter at once,
 * and an already aborted parent starts no lookup. A rejection becomes `fallback(reason)`; the reason is an error name,
 * never a message that could carry the prompt.
 */
async function bounded<T>(
	run: (signal: AbortSignal) => Promise<T>,
	timeoutMs: number,
	parent: AbortSignal,
	fallback: (reason: string) => T,
): Promise<T> {
	if (parent.aborted) return fallback("AbortError");
	const local = new AbortController();
	const abort = (): void => local.abort();
	const { promise: deadline, resolve } = Promise.withResolvers<T>();
	const release = (): void => {
		local.abort();
		resolve(fallback("AbortError"));
	};
	parent.addEventListener("abort", release, { once: true });
	const abortTimer = setTimeout(abort, timeoutMs);
	const deadlineTimer = setTimeout(() => resolve(fallback("timeout")), timeoutMs + LOOKUP_GRACE_MS);
	try {
		return await Promise.race([run(local.signal), deadline]);
	} catch (error) {
		return fallback(error instanceof Error && error.name !== "Error" ? error.name : "error");
	} finally {
		clearTimeout(abortTimer);
		clearTimeout(deadlineTimer);
		parent.removeEventListener("abort", release);
	}
}

/** Lessons lookup; undefined when nothing is configured to run. Never rejects. */
function startRecall(
	deps: HookDeps,
	input: LookupInput & { cwd: string; sessionId: string; host: string; log: (message: string) => void },
): Promise<RecallOutcome> | undefined {
	const seam = deps.recall;
	const teach = deps.config.teach;
	if (!seam && !(teach.enabled && teach.recall)) return undefined;
	const started = input.now();
	const run =
		seam ??
		(async (arg: { query: string; cwd: string; signal: AbortSignal }): Promise<RecallOutcome> => {
			const ctx = teachContext({
				host: input.host,
				cwd: arg.cwd,
				env: input.env,
				sessionId: input.sessionId,
				stateDir: deps.stateDir,
				config: { teach, hindsight: deps.config.hindsight },
				signal: arg.signal,
				now: input.now,
				log: input.log,
			});
			if (!teachEnabled(ctx)) return { status: "off", lessons: [], source: "none", chars: 0, ms: 0, reason: "disabled" };
			return recallLessons({ query: arg.query }, ctx, { countUse: true });
		});
	return bounded(
		(signal) => run({ query: input.query, cwd: input.cwd, signal }),
		teach.timeoutMs,
		input.parent,
		(reason) => ({ status: "error", lessons: [], source: "none", chars: 0, ms: input.now() - started, reason }),
	);
}

/** RAGFlow grounding lookup; undefined when nothing is configured to run. Never rejects. */
function startGround(deps: HookDeps, input: LookupInput): Promise<GroundOutcome> | undefined {
	const seam = deps.ground;
	const ragflow = deps.config.ragflow;
	if (!seam && !(ragflow.enabled && ragflow.ground)) return undefined;
	const started = input.now();
	const run =
		seam ??
		(async (arg: { query: string; signal: AbortSignal }): Promise<GroundOutcome> => {
			return groundDocs({ query: arg.query, config: ragflow, env: input.env, signal: arg.signal, now: input.now });
		});
	return bounded(
		(signal) => run({ query: input.query, signal }),
		ragflow.timeoutMs,
		input.parent,
		(reason) => ({ status: "error", chunks: [], chars: 0, ms: input.now() - started, datasets: 0, reason }),
	);
}

/** Promoted-skills lookup; undefined when nothing is configured to run. Never rejects. */
function startSkills(
	deps: HookDeps,
	input: LookupInput & { cwd: string; sessionId: string; host: string; log: (message: string) => void },
): Promise<SkillRecallOutcome> | undefined {
	const seam = deps.skills;
	const teach = deps.config.teach;
	if (!seam && !(teach.enabled && teach.recall)) return undefined;
	const started = input.now();
	const run =
		seam ??
		(async (arg: { query: string; cwd: string; signal: AbortSignal }): Promise<SkillRecallOutcome> => {
			const ctx = teachContext({
				host: input.host,
				cwd: arg.cwd,
				env: input.env,
				sessionId: input.sessionId,
				stateDir: deps.stateDir,
				config: { teach, hindsight: deps.config.hindsight },
				signal: arg.signal,
				now: input.now,
				log: input.log,
			});
			if (!teachEnabled(ctx)) return { status: "off", skills: [], chars: 0, ms: 0, reason: "disabled" };
			return recallSkills({ query: arg.query }, ctx);
		});
	return bounded(
		(signal) => run({ query: input.query, cwd: input.cwd, signal }),
		teach.timeoutMs,
		input.parent,
		(reason) => ({ status: "error", skills: [], chars: 0, ms: input.now() - started, reason }),
	);
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
	// A cancelled flight starts nothing: no gate request, stage, lookup, tracker call or write.
	throwIfCancelled(deps.signal);
	const skill = input.skill;
	// Read once: the plan gate's last assistant turn and the planner's recent conversation.
	const history = deps.conversation?.(input.transcript_path) ?? "";
	// DP-PLAN (D8): consulted once every deterministic rule has left the prompt to plan, before anything runs. A skip
	// looks exactly like a deterministic one: no event, engine, brief, knowledge or tracker call, and no state write.
	const decisions = createDecisions({
		config: deps.config.decisions,
		...(sessionId === "unknown" ? {} : { sessionId }),
		...deps.decisionsDeps,
	});
	// The planning lifetime every stage gets: the caller's flight signal combined with this hook's budget, whose timer
	// starts after the gate as before.
	const controller = new AbortController();
	const lifetime = deps.signal ? AbortSignal.any([deps.signal, controller.signal]) : controller.signal;
	const gate = await planGate({ prompt: input.prompt ?? "", text: decision.text, skill, history }, decisions, lifetime);
	throwIfCancelled(deps.signal);
	if (!gate.plan) {
		return {
			skipped: JEV_PLAN_SKIP,
			decisions: [gate.record],
			...(deps.config.claude.echo ? { notice: formatPlanSkipNotice(gate.p) } : {}),
		};
	}
	const records: DecisionRecord[] = gate.record ? [gate.record] : [];
	const withResolution = deps.modelResolution ? { modelResolution: deps.modelResolution } : {};
	emit({
		type: "begin",
		at: now(),
		sessionId,
		engine: deps.engine,
		...withResolution,
		track: deps.track !== undefined && !deps.trackingOff,
		...(skill ? { skill: skill.name } : {}),
	});
	let outcome: "planned" | "skipped" | "failed" = "failed";
	let outcomeDetail: string | undefined;

	let session: KnowledgeSession | undefined;
	const budget =
		deps.config.claude.budgetMs > 0 ? setTimeout(() => controller.abort(), deps.config.claude.budgetMs) : undefined;
	try {
		const original = decision.text;
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
			signal: lifetime,
		}).catch(() => "");

		// The two evidence lookups start next to the brief and use only the user's own words: never the spec XML, the
		// conversation history, or anything the engine produced.
		const lookupQuery = original.trim().slice(0, LOOKUP_QUERY_CHARS);
		const lookups =
			lookupQuery !== "" && !isChildInvocation() && !isSubagentEnvelope(input as Record<string, unknown>);
		const lookupEnv = deps.decisionsDeps?.env ?? process.env;
		const surfaceId = deps.surface ?? "claude-code";
		const recallPromise = lookups
			? startRecall(deps, { query: lookupQuery, cwd, sessionId, host: surfaceId, env: lookupEnv, parent: lifetime, now, log })
			: undefined;
		const groundPromise = lookups
			? startGround(deps, { query: lookupQuery, env: lookupEnv, parent: lifetime, now })
			: undefined;
		const skillsPromise = lookups
			? startSkills(deps, { query: lookupQuery, cwd, sessionId, host: surfaceId, env: lookupEnv, parent: lifetime, now, log })
			: undefined;

		// The knowledge-base prefetch (find the repo, list documents, read index.md) overlaps the uplift and the
		// Graph of Thought; the topic-specific documents are read right before clarify.
		const reader = hitlOn ? (deps.knowledge ?? createGreptileKnowledge(deps.config)) : undefined;
		if (reader) {
			try {
				session = reader.start({ repo: git.repo, signal: lifetime });
				stage("knowledge", "start");
			} catch (error) {
				log(`greptile knowledge base: start failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		}

		let result: UpliftResult;
		throwIfCancelled(deps.signal);
		stage("uplift", "start");
		try {
			result = await runUplift({
				original,
				conversation,
				complete: deps.complete,
				signal: lifetime,
				maxChars: deps.config.uplift.maxChars,
			});
		} catch (error) {
			throwIfCancelled(deps.signal);
			log(`uplift failed: ${error instanceof Error ? error.message : String(error)}`);
			stage("uplift", "end", false);
			outcome = "skipped";
			outcomeDetail = "uplift-failed";
			return { skipped: "uplift-failed", ...(records.length ? { decisions: records } : {}) };
		}
		// A completer that ignored its signal and answered anyway still ends a cancelled flight here.
		throwIfCancelled(deps.signal);
		stage("uplift", "end", true, `${result.root} · ${result.source}`);

		const brief = await briefPromise;
		throwIfCancelled(deps.signal);
		if (brief) log(`substrate brief: ${brief.split("\n").length} lines`);
		stage("brief", "end", true, brief ? `${brief.split("\n").length} lines` : "none");

		// Settled before anything is formatted so the record says what happened; all are bounded and never reject.
		const [recalled, grounded, skilled] = await Promise.all([recallPromise, groundPromise, skillsPromise]);
		throwIfCancelled(deps.signal);
		let lessons: LessonsLookup | undefined;
		let lessonsText = "";
		if (recalled) {
			try {
				lessons = lessonsLookup(recalled);
				lessonsText = formatLessonsSection(recalled, deps.config.teach.recallChars);
			} catch (error) {
				log(`lessons: format failed: ${error instanceof Error ? error.name : "error"}`);
				lessons = { outcome: "error", count: 0, ids: [], chars: 0, ms: recalled.ms, source: "none", reason: "format" };
			}
			log(`lessons: ${lessons.outcome} · ${lessons.count} · ${lessons.source} · ${lessons.ms}ms${lessons.reason ? ` · ${lessons.reason}` : ""}`);
		}
		let docs: DocsLookup | undefined;
		let docsText = "";
		if (grounded) {
			try {
				docs = docsLookup(grounded);
				docsText = formatDocsSection(grounded, deps.config.ragflow.groundChars);
			} catch (error) {
				log(`docs: format failed: ${error instanceof Error ? error.name : "error"}`);
				docs = { status: "error", count: 0, chars: 0, ms: grounded.ms, datasets: grounded.datasets, reason: "format" };
			}
			log(`docs (RAGFlow): ${docs.status} · ${docs.count} excerpts · ${docs.datasets} datasets · ${docs.ms}ms${docs.reason ? ` · ${docs.reason}` : ""}`);
		}
		let skills: SkillsLookup | undefined;
		let skillsText = "";
		if (skilled) {
			try {
				skills = skillsLookup(skilled);
				skillsText = formatSkillsSection(skilled, SKILL_SECTION_CHARS);
			} catch (error) {
				log(`skills: format failed: ${error instanceof Error ? error.name : "error"}`);
				skills = { outcome: "error", count: 0, names: [], chars: 0, ms: skilled.ms, reason: "format" };
			}
			log(`skills: ${skills.outcome} · ${skills.count} · ${skills.ms}ms${skills.reason ? ` · ${skills.reason}` : ""}`);
		}

		let graph: ThoughtGraph | undefined;
		let thinkDegraded: string[] = [];
		const thinkOn = deps.control.thinkEnabled ?? deps.config.think.enabled;
		if (thinkOn && !lifetime.aborted) {
			stage("think", "start");
			try {
				const thought = await runThink({
					uplift: result,
					complete: deps.complete,
					signal: lifetime,
					minNodes: deps.config.think.minNodes,
					maxNodes: deps.config.think.maxNodes,
					concurrency: deps.config.claude.concurrency,
					onProgress: log,
					onEvent: (event) => emit({ ...event, at: now() }),
				});
				throwIfCancelled(deps.signal);
				result = thought;
				graph = thought.graph;
				thinkDegraded = [
					...(thought.degraded.graph ? ["graph"] : []),
					...thought.degraded.fills.map((id) => `fill:${id}`),
				];
				stage("think", "end", true, `${graph.nodes.length} nodes`);
			} catch (error) {
				throwIfCancelled(deps.signal);
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
			throwIfCancelled(deps.signal);
			const lookup = read.lookup;
			log(
				`greptile knowledge base: ${lookup.outcome}${lookup.docs.length > 0 ? ` · ${lookup.docs.join(", ")}` : ""}${lookup.reason ? ` · ${lookup.reason}` : ""} · ${lookup.ms}ms`,
			);
			stage("knowledge", "end", lookup.outcome !== "error", lookup.outcome === "used" ? `${lookup.docs.length} docs` : lookup.outcome);
			knowledge = { ...lookup, settled: 0 };
			if (lookup.outcome === "used") knowledgeInput = { digest: read.digest, docs: lookup.docs };
		}
		if (hitlOn && !lifetime.aborted) {
			stage("clarify", "start");
			try {
				const fresh = await (deps.clarify ?? runClarify)({
					uplift: result,
					graph,
					conversation,
					answered: clarifications,
					complete: deps.complete,
					signal: lifetime,
					maxQuestions: deps.config.hitl.maxQuestions,
					onProgress: log,
					...(knowledgeInput ? { knowledge: knowledgeInput } : {}),
					// DP-KNOWLEDGE and DP-BLOCKING share the plan gate's runtime; every record lands in this prompt's list.
					decisions,
					onDecision: (decisionRecord) => records.push(decisionRecord),
				});
				throwIfCancelled(deps.signal);
				const seen = new Set(clarifications.map((c) => normalizeQuestion(c.question)));
				const kept = fresh.filter((c) => !seen.has(normalizeQuestion(c.question)));
				clarifications = [...clarifications, ...kept];
				if (knowledge) knowledge = { ...knowledge, settled: kept.filter((c) => c.source === "knowledge").length };
				stage("clarify", "end", true, `${clarifications.length} question${clarifications.length === 1 ? "" : "s"}`);
			} catch (error) {
				throwIfCancelled(deps.signal);
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
			tracking = await deps.track({ plan, graph, signal: lifetime, progress: deps.progress }).catch((error: unknown) => {
				throwIfCancelled(deps.signal);
				log(`tracking failed: ${error instanceof Error ? error.message : String(error)}`);
				return undefined;
			});
			throwIfCancelled(deps.signal);
			if (tracking) {
				result = { ...result, xml: injectTrackingXml(result.xml, plan, tracking) };
				log(`tracking ${tracking.status}${tracking.errors.length > 0 ? `: ${tracking.errors.join("; ")}` : ""}`);
				const issues = Object.keys(tracking.linear.nodes).length;
				stage("track", "end", tracking.status !== "failed", `${tracking.status} · ${issues}/${plan.linearIssues.length} issues`);
			} else {
				stage("track", "end", false);
			}
		}

		// Read once: the record, the summary and the context all report the same first error.
		const engineError = deps.engineError?.();
		const degraded = [...(result.source === "fallback" ? ["uplift"] : []), ...thinkDegraded];
		const record: SessionRecord = {
			sessionId,
			at: now(),
			engine: deps.engine,
			...withResolution,
			...(engineError ? { engineError } : {}),
			...(degraded.length > 0 ? { degraded } : {}),
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
			...(lessons ? { lessons } : {}),
			...(docs ? { docs } : {}),
			...(skills ? { skills } : {}),
			...(records.length ? { decisions: records } : {}),
		};
		let specPath: string | undefined;
		let statePath: string | undefined;
		// No spec or session write for a cancelled flight.
		throwIfCancelled(deps.signal);
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
					engine: deps.engine,
					...withResolution,
					...(engineError ? { engineError } : {}),
					...(degraded.length > 0 ? { degraded } : {}),
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
					lessons: lessonsText,
					docs: docsText,
					skills: skillsText,
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
				...withResolution,
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
				lessons,
				docs,
				skills,
				...(engineError ? { engineError } : {}),
				elapsedMs: now() - started,
				decisions: records,
			});
		}
		outcome = "planned";
		return { output, record, ...(records.length ? { decisions: records } : {}) };
	} catch (error) {
		// A cancelled flight ends skipped, as planPrompt reports it; anything else stays a failure named by its error.
		if (deps.signal?.aborted) {
			outcome = "skipped";
			outcomeDetail = "aborted";
		} else outcomeDetail = error instanceof Error ? error.name : "error";
		throw error;
	} finally {
		session?.close();
		clearTimeout(budget);
		emit({ type: "end", at: now(), outcome, ...(outcomeDetail ? { detail: outcomeDetail } : {}), ...withResolution });
	}
}
