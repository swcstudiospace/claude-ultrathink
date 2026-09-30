// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Decides whether a finished skill run is ready to ship: deterministic rules
 * first, then an optional LLM judge and, when the `ship` point is on, a Jev
 * decision run alongside it. In "gate" mode unknown outcomes never ship;
 * in "advisory" mode only the rules gate and the verdicts are recorded.
 */
import type { ClaudeCompleter } from "../claude/complete.ts";
import type { SessionRecord } from "../claude/state.ts";
import type { DecisionOutcome, Decisions } from "../decisions/gate.ts";
import { buildShipState, extractAcceptanceCriteria } from "../decisions/questions.ts";
import type { DecisionAction, DecisionRecord, DecisionsErrorKind } from "../decisions/types.ts";
import { formatP } from "../decisions/types.ts";
import type { ShipDiff } from "./signals.ts";
import type { Assessment, JudgeMode, JudgeVerdict, MilestoneEvidence, ShipSignals } from "./types.ts";

export const JUDGE_SYSTEM_PROMPT = `You are a strict release reviewer. You are given the user's original request, the uplifted spec summary, the Graph-of-Thought goal and WORKFLOW, the clarifications with any recorded answers, GSD roadmap/verification signals, the branch diff stat, commit log and the (possibly truncated) patch.
Decide whether the requested work is complete enough to merge: check the patch against every stated requirement. Missing features, TODO/stub markers, failing verification or unanswered blocking clarifications mean NOT done.
You run before the ship flow, which then pushes the branch, opens the PR into the default branch and gates it on CI and a Greptile review; the flow or a person then merges it and may delete the branch. Requirements to push, open a PR, merge into the main/default branch or delete the branch are handled after you: treat them as satisfied, never as gaps. Also never count as gaps: repository settings a person applies after the merge (such as visibility), a truncated patch, or not seeing logs of commands being run. Judge the delivered changes; CI and the review gate verify the code after you.
List in gaps only concrete missing or broken work; leave gaps empty when done.
Reply ONLY with JSON: {"done": boolean, "confidence": number between 0 and 1, "summary": string, "gaps": string[]}`;

const MIN_CONFIDENCE = 0.7;

function ruleGaps(signals: ShipSignals): string[] {
	const { git, gsd } = signals;
	const gaps: string[] = [];
	if (git.onBase) gaps.push("working on the default branch; ship needs a feature branch");
	if (git.ahead === 0 && git.dirty.length === 0) gaps.push(`nothing to ship: no commits ahead of ${git.base ?? "base"}`);
	if (git.dirty.length > 0) {
		const planning = git.dirty.some((path) => path.startsWith(".planning/"))
			? "; uncommitted .planning/ changes (another session may be planning here)"
			: "";
		gaps.push(`uncommitted tracked changes: ${git.dirty.join(", ")}${planning}; commit your work first`);
	}
	if (gsd && !gsd.trusted)
		gaps.push(
			".planning/ is neither tracked nor ignored (possibly stray planning written by another tool); commit or remove it before shipping",
		);
	if (gsd?.toolsMissing) gaps.push("GSD roadmap found but gsd-tools.cjs was not found; set GSD_TOOLS or rerun assess with --ignore-gsd");
	if (gsd?.nodeMissing)
		gaps.push(
			"GSD roadmap found but node is not on PATH, so gsd-tools.cjs could not run; install Node.js or rerun assess with --ignore-gsd",
		);
	if (gsd && gsd.completedPhases < gsd.phaseCount)
		gaps.push(`GSD roadmap incomplete: ${gsd.completedPhases}/${gsd.phaseCount} phases`);
	if (gsd?.verification && gsd.verification.status !== "passed")
		gaps.push(`latest GSD verification is ${gsd.verification.status}`);
	if (gsd?.milestone) {
		if (gsd.milestone.verifications.length === 0)
			gaps.push(`archived milestone ${gsd.milestone.version} has no phase verifications`);
		for (const v of gsd.milestone.verifications) {
			if (v.status !== "passed")
				gaps.push(`archived milestone ${gsd.milestone.version}: ${v.phase} verification is ${v.status}`);
		}
	}
	return gaps;
}

function milestoneLine(milestone: MilestoneEvidence): string {
	const passed = milestone.verifications.filter((v) => v.status === "passed").length;
	let line = `latest milestone: ${milestone.version} archived: ${passed}/${milestone.verifications.length} phase verifications passed`;
	if (milestone.audit) {
		const scores = Object.entries(milestone.audit.scores).map(([k, v]) => `${k} ${v}`);
		line += `; audit ${milestone.audit.status}${scores.length > 0 ? ` (${scores.join(", ")})` : ""}`;
	}
	return line;
}

function gsdBlock(gsd: NonNullable<ShipSignals["gsd"]>): string {
	const lines = [
		`state: ${gsd.state ?? "unknown"}`,
		`roadmap: ${gsd.completedPhases}/${gsd.phaseCount} phases`,
		`latest verification: ${gsd.verification ? `${gsd.verification.phase} ${gsd.verification.status}` : "none"}`,
	];
	if (gsd.milestone) lines.push(milestoneLine(gsd.milestone));
	return `<gsd>\n${lines.join("\n")}\n</gsd>`;
}

function judgePrompt(record: SessionRecord, signals: ShipSignals, diff: ShipDiff): string {
	const synth = record.graph?.nodes.find((node) => node.kind === "synthesize")?.conclusion ?? "";
	const clarifications = (record.clarifications ?? []).map((c) => JSON.stringify(c)).join("\n");
	return [
		`<original_request>\n${record.result.original}\n</original_request>`,
		`<uplifted_spec>\n${record.result.xml.slice(0, 6000)}\n</uplifted_spec>`,
		`<graph_goal>\n${record.graph?.goal ?? ""}\n</graph_goal>`,
		`<workflow>\n${synth.slice(0, 6000)}\n</workflow>`,
		clarifications ? `<clarifications>\n${clarifications}\n</clarifications>` : "",
		signals.gsd ? gsdBlock(signals.gsd) : "",
		`<signals>\n${JSON.stringify(signals)}\n</signals>`,
		`<diff_stat>\n${diff.stat}\n</diff_stat>`,
		`<commit_log>\n${diff.log}\n</commit_log>`,
		diff.patch ? `<patch>\n${diff.patch}\n</patch>` : "",
	]
		.filter(Boolean)
		.join("\n\n");
}

/** Extracts the first balanced JSON object from free text. */
export function parseJudge(text: string): JudgeVerdict | undefined {
	for (let start = text.indexOf("{"); start !== -1; start = text.indexOf("{", start + 1)) {
		let depth = 0;
		let inString = false;
		for (let i = start; i < text.length; i++) {
			const ch = text[i];
			if (inString) {
				if (ch === "\\") i++;
				else if (ch === '"') inString = false;
			} else if (ch === '"') inString = true;
			else if (ch === "{") depth++;
			else if (ch === "}" && --depth === 0) {
				try {
					const value = JSON.parse(text.slice(start, i + 1)) as Record<string, unknown>;
					if (typeof value.done !== "boolean") break;
					return {
						done: value.done,
						confidence: typeof value.confidence === "number" ? value.confidence : 0,
						summary: typeof value.summary === "string" ? value.summary : "",
						gaps: Array.isArray(value.gaps) ? value.gaps.filter((g): g is string => typeof g === "string") : [],
					};
				} catch {
					break;
				}
			}
		}
	}
	return undefined;
}

interface AssessInput {
	record: SessionRecord;
	signals: ShipSignals;
	diff: ShipDiff;
	complete?: ClaudeCompleter;
	signal?: AbortSignal;
	now?: () => number;
	mode?: JudgeMode;
	/** Jev runtime for the `ship` point; absent or inactive = today's assessment, no request. */
	decisions?: Decisions;
	/** `ship.autoMerge`: in gate mode Jev may then only veto a usable judge "done", never stand in for the judge. */
	autoMerge?: boolean;
}

/** A started Jev `ship` decision and what its outcome is read against. */
interface ShipDecision {
	/** Rejects only with an AbortError (caller abort). */
	outcome: Promise<DecisionOutcome>;
	/** The patch Jev saw was cut (by gatherDiff or the state builder): a veto is then never applied. */
	truncated: boolean;
	veto: number;
	approve: number;
}

/**
 * Assesses whether the run is ready to ship. Rule gaps block `done` in both modes and return before any Jev request.
 * "gate" (default): the judge must say done with confidence >= MIN_CONFIDENCE; Jev may veto that "done", or judge
 * alone when there is no usable judge verdict (never with `autoMerge`: the judge's result then stands).
 * "advisory": no rule gaps means done; the judge verdict (or its failure) is recorded in `judge`, Jev's in `decision`.
 */
export async function assessDone(input: AssessInput): Promise<Assessment> {
	const { signals } = input;
	const mode = input.mode ?? "gate";
	const at = (input.now ?? Date.now)();
	const gaps = ruleGaps(signals);
	if (gaps.length > 0)
		return { done: false, confidence: 1, summary: gaps[0] ?? "", gaps, signals, source: "rules", mode, at };
	// Started before the judge is called, so Jev adds no latency; awaited outside the judge's try/catch so a caller
	// abort is re-thrown rather than read as a judge failure.
	const jev = startShipDecision(input);
	if (mode === "advisory") {
		const assessment = await assessAdvisory(input, at);
		return jev ? adviseWithJev(assessment, await jev.outcome, jev) : assessment;
	}
	const judged = await judgeGate(input, at);
	return jev ? gateWithJev(judged, await jev.outcome, jev, input.autoMerge === true) : judged.assessment;
}

/** Starts the `ship` decision when the point is active. State: request, acceptance criteria and patch only (D9). */
function startShipDecision(input: AssessInput): ShipDecision | undefined {
	const { decisions } = input;
	if (!decisions?.active("ship")) return undefined;
	const { state, truncated } = buildShipState({
		request: input.record.result.original,
		acceptanceCriteria: extractAcceptanceCriteria(input.record.result.xml),
		patch: input.diff.patch ?? "",
		patchTruncated: input.diff.patchTruncated,
	});
	const { shipVetoAtOrBelow: veto, shipApproveAt: approve } = decisions.config;
	const outcome = decisions.run("ship", state, { signal: input.signal, threshold: veto, action: () => "none" });
	// An early exit must never leave an unhandled rejection; assessDone still awaits (and so re-throws) the outcome.
	outcome.catch(() => {});
	return { outcome, truncated, veto, approve };
}

function decided(record: DecisionRecord, action: DecisionAction, threshold: number): DecisionRecord {
	return { ...record, action, threshold };
}

/**
 * Gate mode with Jev: a usable "done" verdict is vetoed at or below `shipVetoAtOrBelow` on an
 * untruncated patch; without a usable verdict Jev decides (done iff P >= `shipApproveAt`), unless `autoMerge` is on:
 * a merge then always needs a usable judge verdict, so the judge's result stands and Jev is only recorded. Jev never
 * turns a judge's "not done" into done, and a failed decision leaves today's result.
 */
function gateWithJev(judged: GateJudgement, outcome: DecisionOutcome, jev: ShipDecision, autoMerge: boolean): Assessment {
	const { assessment, verdict } = judged;
	// Jev can only veto here: it decides alone only when there is no usable verdict and no auto-merge.
	const vetoOnly = verdict !== undefined || autoMerge;
	if (outcome.status === "inactive") return assessment;
	if (outcome.status === "error")
		return { ...assessment, decision: decided(outcome.record, "fail-open", vetoOnly ? jev.veto : jev.approve) };
	const { p, record } = outcome;
	if (vetoOnly) {
		if (verdict && assessment.done && p <= jev.veto && !jev.truncated) {
			const gap = `Jev judged the change incomplete (P(complete) ${formatP(p)})`;
			const decision = decided(record, "veto", jev.veto);
			return { ...assessment, done: false, summary: gap, gaps: [...verdict.gaps, gap], decision };
		}
		return { ...assessment, decision: decided(record, "none", jev.veto) };
	}
	const { signals, at } = assessment;
	if (p >= jev.approve) {
		const summary = `Jev judged the change complete (P(complete) ${formatP(p)})`;
		const decision = decided(record, "approve", jev.approve);
		return { done: true, confidence: p, summary, gaps: [], signals, source: "jev", mode: "gate", at, decision };
	}
	const gap = `Jev P(complete) ${formatP(p)} is below ${String(jev.approve)}`;
	const decision = decided(record, "reject", jev.approve);
	return { done: false, confidence: p, summary: gap, gaps: [gap], signals, source: "jev", mode: "gate", at, decision };
}

/** Advisory mode with Jev: the run still ships; Jev's verdict is only recorded (`advise-veto` where gate would veto). */
function adviseWithJev(assessment: Assessment, outcome: DecisionOutcome, jev: ShipDecision): Assessment {
	if (outcome.status === "inactive") return assessment;
	if (outcome.status === "error") return { ...assessment, decision: decided(outcome.record, "fail-open", jev.veto) };
	const action = outcome.p <= jev.veto && !jev.truncated ? "advise-veto" : "none";
	return { ...assessment, decision: decided(outcome.record, action, jev.veto) };
}

/** The gate-mode judge result, plus the parsed verdict when it was usable (completer present, no throw, parsed). */
interface GateJudgement {
	assessment: Assessment;
	verdict?: JudgeVerdict;
}

// Gate mode: exactly today's judge result.
async function judgeGate(input: AssessInput, at: number): Promise<GateJudgement> {
	const { signals } = input;
	const mode = "gate";
	if (!input.complete)
		return { assessment: { done: true, confidence: 0.5, summary: "deterministic checks passed", gaps: [], signals, source: "rules", mode, at } };
	let reason: string;
	try {
		const text = await input.complete(JUDGE_SYSTEM_PROMPT, judgePrompt(input.record, signals, input.diff), input.signal);
		const verdict = parseJudge(text);
		if (verdict) {
			const done = verdict.done && verdict.confidence >= MIN_CONFIDENCE;
			const judgeGaps =
				!done && verdict.done ? [...verdict.gaps, `judge confidence ${verdict.confidence} below ${MIN_CONFIDENCE}`] : verdict.gaps;
			const { confidence, summary } = verdict;
			return { assessment: { done, confidence, summary, gaps: judgeGaps, signals, source: "llm", mode, at }, verdict };
		}
		reason = "judge reply was not parseable JSON";
	} catch (error) {
		reason = error instanceof Error ? error.message : String(error);
	}
	const gap = `assessment unavailable: ${reason}`;
	return { assessment: { done: false, confidence: 0, summary: gap, gaps: [gap], signals, source: "llm", mode, at } };
}

// Rules passed: the run ships; the judge only informs the PR body and the audit trail.
async function assessAdvisory(input: AssessInput, at: number): Promise<Assessment> {
	const { signals } = input;
	const base = { done: true, gaps: [], signals, mode: "advisory" as const, at };
	if (!input.complete)
		return {
			...base,
			confidence: 0.5,
			summary: "deterministic checks passed (judge unavailable, advisory)",
			source: "rules",
			judge: { done: false, confidence: 0, summary: "", gaps: [], error: "no judge available" },
		};
	let reason: string;
	try {
		const text = await input.complete(JUDGE_SYSTEM_PROMPT, judgePrompt(input.record, signals, input.diff), input.signal);
		const verdict = parseJudge(text);
		if (verdict) return { ...base, confidence: verdict.confidence, summary: verdict.summary, source: "llm", judge: verdict };
		reason = "judge reply was not parseable JSON";
	} catch (error) {
		reason = error instanceof Error ? error.message : String(error);
	}
	return {
		...base,
		confidence: 0,
		summary: `deterministic checks passed; judge failed: ${reason}`,
		source: "llm",
		judge: { done: false, confidence: 0, summary: "", gaps: [], error: reason },
	};
}

/** The assess JSON `decision` (§5.5): what Jev did, never the record's timing, cost or id. */
export interface AssessDecisionJson {
	p?: number;
	model?: string;
	action: DecisionAction;
	error?: DecisionsErrorKind;
}

/** ok → {p, model, action}; error → {action: "fail-open", error}. */
export function assessDecisionJson(record: DecisionRecord): AssessDecisionJson {
	if (record.outcome === "error") return { action: "fail-open", ...(record.error ? { error: record.error } : {}) };
	return { p: record.p, model: record.model, action: record.action };
}
