// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Decides whether a finished skill run is ready to ship: deterministic rules
 * first, then an optional LLM judge. Unknown outcomes never ship.
 */
import type { ClaudeCompleter } from "../claude/complete.ts";
import type { SessionRecord } from "../claude/state.ts";
import type { ShipDiff } from "./signals.ts";
import type { Assessment, ShipSignals } from "./types.ts";

export const JUDGE_SYSTEM_PROMPT = `You are a strict release reviewer. You are given the user's original request, the uplifted spec summary, the Graph-of-Thought goal and WORKFLOW, GSD roadmap/verification signals, the branch diff stat, commit log and the (possibly truncated) patch.
Decide whether the requested work is complete enough to merge: check the patch against every stated requirement. Missing features, TODO/stub markers, failing verification or unaddressed clarifications mean NOT done.
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
	if (gsd && gsd.completedPhases < gsd.phaseCount)
		gaps.push(`GSD roadmap incomplete: ${gsd.completedPhases}/${gsd.phaseCount} phases`);
	if (gsd?.verification && gsd.verification.status !== "passed")
		gaps.push(`latest GSD verification is ${gsd.verification.status}`);
	return gaps;
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
		signals.gsd
			? `<gsd>\nstate: ${signals.gsd.state ?? "unknown"}\nroadmap: ${signals.gsd.completedPhases}/${signals.gsd.phaseCount} phases\nlatest verification: ${signals.gsd.verification ? `${signals.gsd.verification.phase} ${signals.gsd.verification.status}` : "none"}\n</gsd>`
			: "",
		`<signals>\n${JSON.stringify(signals)}\n</signals>`,
		`<diff_stat>\n${diff.stat}\n</diff_stat>`,
		`<commit_log>\n${diff.log}\n</commit_log>`,
		diff.patch ? `<patch>\n${diff.patch}\n</patch>` : "",
	]
		.filter(Boolean)
		.join("\n\n");
}

/** Extracts the first balanced JSON object from free text. */
export function parseJudge(text: string): { done: boolean; confidence: number; summary: string; gaps: string[] } | undefined {
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

export async function assessDone(input: {
	record: SessionRecord;
	signals: ShipSignals;
	diff: ShipDiff;
	complete?: ClaudeCompleter;
	signal?: AbortSignal;
	now?: () => number;
}): Promise<Assessment> {
	const { signals } = input;
	const at = (input.now ?? Date.now)();
	const gaps = ruleGaps(signals);
	if (gaps.length > 0)
		return { done: false, confidence: 1, summary: gaps[0] ?? "", gaps, signals, source: "rules", at };
	if (!input.complete)
		return { done: true, confidence: 0.5, summary: "deterministic checks passed", gaps: [], signals, source: "rules", at };
	let reason: string;
	try {
		const text = await input.complete(JUDGE_SYSTEM_PROMPT, judgePrompt(input.record, signals, input.diff), input.signal);
		const verdict = parseJudge(text);
		if (verdict) {
			const done = verdict.done && verdict.confidence >= MIN_CONFIDENCE;
			const judgeGaps =
				!done && verdict.done ? [...verdict.gaps, `judge confidence ${verdict.confidence} below ${MIN_CONFIDENCE}`] : verdict.gaps;
			return { done, confidence: verdict.confidence, summary: verdict.summary, gaps: judgeGaps, signals, source: "llm", at };
		}
		reason = "judge reply was not parseable JSON";
	} catch (error) {
		reason = error instanceof Error ? error.message : String(error);
	}
	const gap = `assessment unavailable: ${reason}`;
	return { done: false, confidence: 0, summary: gap, gaps: [gap], signals, source: "llm", at };
}
