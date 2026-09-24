/**
 * Orchestrates one UserPromptSubmit event: decide → uplift → Graph of Thought
 * with per-node Chain of Thought → HITL clarifications → build a Notion/Linear
 * TrackPlan → persist session state → return the spec plus an instruction to
 * invoke ultrathink-kickoff as hook context. Everything after "decide" is
 * fail-open: the user's prompt always goes through.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { UltrathinkConfig } from "../config.ts";
import { injectClarificationsXml } from "../hitl/format.ts";
import { normalizeQuestion, type RunClarifyOptions, runClarify } from "../hitl/pipeline.ts";
import type { Clarification } from "../hitl/types.ts";
import { runThink } from "../think/pipeline.ts";
import type { ThoughtGraph } from "../think/types.ts";
import { fetchBrief } from "../substrate/brief.ts";
import { resolveBranch, resolveRepoSlug } from "../track/git.ts";
import { buildTrackPlan } from "../track/plan.ts";
import type { TrackPlan } from "../track/types.ts";
import type { UpliftResult, UpliftState } from "../types.ts";
import { decideUplift } from "../uplift/detect.ts";
import { runUplift } from "../uplift/run.ts";
import type { ClaudeCompleter } from "./complete.ts";
import { formatPromptContext, formatSummary } from "./output.ts";
import { type ControlState, readSession, type SessionRecord, sessionPath, writeControl, writeSession } from "./state.ts";

export interface PromptSubmitInput {
	session_id?: string;
	transcript_path?: string;
	cwd?: string;
	prompt?: string;
	hook_event_name?: string;
}

export interface HookOutput {
	hookSpecificOutput: { hookEventName: "UserPromptSubmit"; additionalContext: string };
	systemMessage?: string;
}

export interface HookDeps {
	config: UltrathinkConfig;
	control: ControlState;
	complete: ClaudeCompleter;
	/** Thinking engine label recorded and echoed, e.g. "grok-4.7@xhigh", "grok-4.7-xhigh@shunt" or "claude:sonnet". */
	engine: string;
	stateDir: string;
	clarify?: (opts: RunClarifyOptions) => Promise<Clarification[]>;
	/** First error the completer threw (already redacted), surfaced in the summary. */
	engineError?: () => string | undefined;
	/** Test seam for git remote/branch resolution; default reads the real repo at cwd. */
	git?: (cwd: string) => { repo?: string; branch?: string };
	conversation?: (transcriptPath?: string) => string;
	/** Test seam for the Agent Substrate brief; defaults to the real fail-open HTTP call. */
	brief?: (input: { repo?: string; branch?: string; surface?: string }) => Promise<string>;
	now?: () => number;
	log?: (message: string) => void;
}

export interface PromptSubmitResult {
	output?: HookOutput;
	record?: SessionRecord;
	skipped?: string;
}

function specFile(stateDir: string, sessionId: string): string {
	return sessionPath(stateDir, sessionId).replace(/\.json$/, ".xml");
}

export async function runPromptSubmit(input: PromptSubmitInput, deps: HookDeps): Promise<PromptSubmitResult> {
	const now = deps.now ?? Date.now;
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

	const controller = new AbortController();
	const budget =
		deps.config.claude.budgetMs > 0 ? setTimeout(() => controller.abort(), deps.config.claude.budgetMs) : undefined;
	try {
		const original = decision.text;
		const conversation = deps.conversation?.(input.transcript_path) ?? "";

		// Resolved once and shared by the brief and the TrackPlan below.
		const git = (() => {
			try {
				return deps.git?.(cwd) ?? { repo: resolveRepoSlug(cwd), branch: resolveBranch(cwd) };
			} catch {
				return {} as { repo?: string; branch?: string };
			}
		})();

		// Started now, awaited before the Graph of Thought: the graph is then
		// planned knowing what other agents already did, and the round trip
		// overlaps the uplift call instead of adding to it.
		const briefPromise = (deps.brief ?? fetchBrief)({
			repo: git.repo,
			branch: git.branch,
			surface: "claude-code",
		}).catch(() => "");

		let result: UpliftResult;
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
			return { skipped: "uplift-failed" };
		}

		const brief = await briefPromise;
		if (brief) log(`substrate brief: ${brief.split("\n").length} lines`);

		let graph: ThoughtGraph | undefined;
		const thinkOn = deps.control.thinkEnabled ?? deps.config.think.enabled;
		if (thinkOn && !controller.signal.aborted) {
			try {
				const thought = await runThink({
					uplift: result,
					complete: deps.complete,
					signal: controller.signal,
					minNodes: deps.config.think.minNodes,
					maxNodes: deps.config.think.maxNodes,
					concurrency: deps.config.claude.concurrency,
					onProgress: log,
				});
				result = thought;
				graph = thought.graph;
			} catch (error) {
				log(`think failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		}

		/** Answered clarifications from an earlier turn of this session survive; stale open ones are dropped. */
		let clarifications: Clarification[] = (readSession(deps.stateDir, sessionId)?.clarifications ?? []).filter(
			(c) => c.answer,
		);
		const hitlOn = deps.control.hitlEnabled ?? deps.config.hitl.enabled;
		if (hitlOn && !controller.signal.aborted) {
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
				});
				const seen = new Set(clarifications.map((c) => normalizeQuestion(c.question)));
				clarifications = [...clarifications, ...fresh.filter((c) => !seen.has(normalizeQuestion(c.question)))];
			} catch (error) {
				log(`clarify failed: ${error instanceof Error ? error.message : String(error)}`);
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
			try {
				plan = buildTrackPlan({ uplift: result, graph, clarifications, repo: git.repo, branch: git.branch });
			} catch (error) {
				log(`track plan failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		}

		const record: SessionRecord = {
			sessionId,
			at: now(),
			engine: deps.engine,
			result,
			graph,
			clarifications,
			plan,
			kickedOff: false,
			synced: false,
		};
		let specPath: string | undefined;
		let statePath: string | undefined;
		try {
			specPath = specFile(deps.stateDir, sessionId);
			mkdirSync(dirname(specPath), { recursive: true });
			writeFileSync(specPath, `${result.xml}\n`);
			writeSession(deps.stateDir, record);
			statePath = sessionPath(deps.stateDir, sessionId);
		} catch (error) {
			log(`state write failed: ${error instanceof Error ? error.message : String(error)}`);
			specPath = undefined;
			statePath = undefined;
		}

		const output: HookOutput = {
			hookSpecificOutput: {
				hookEventName: "UserPromptSubmit",
				additionalContext: formatPromptContext({ result, graph, clarifications, brief, statePath, specPath }),
			},
		};
		if (deps.config.claude.echo) {
			output.systemMessage = formatSummary({
				result,
				engine: deps.engine,
				graph,
				clarifications,
				brief,
				tracked: Boolean(plan && statePath),
				engineError: deps.engineError?.(),
				elapsedMs: now() - started,
			});
		}
		return { output, record };
	} finally {
		if (budget !== undefined) clearTimeout(budget);
	}
}
