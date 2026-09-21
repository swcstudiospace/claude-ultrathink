/**
 * Builds the `additionalContext` block a UserPromptSubmit hook returns.
 *
 * Claude Code (2.1.x) does not let a hook replace the prompt text, so the uplifted
 * spec rides alongside the user's message as context. The wording matters: Claude
 * treats hook context that "overrides the user" as prompt injection, so the block is
 * framed as the user's own request, elaborated by a plugin the user installed.
 */
import { formatHitlAddendum } from "../hitl/format.ts";
import type { Clarification } from "../hitl/types.ts";
import { workflowWaves } from "../think/graph.ts";
import { THINK_ADDENDUM } from "../think/prompts.ts";
import type { ThoughtGraph } from "../think/types.ts";
import type { UpliftResult } from "../types.ts";

/** Generous ceiling; the spec is normally far smaller. Over budget, RATIONALE bodies go first, then the tail. */
export const DEFAULT_CONTEXT_CHARS = 90_000;

const RATIONALE_RE = /(<RATIONALE>)[\s\S]*?(<\/RATIONALE>)/g;
const RATIONALE_OMITTED = "(omitted — full text in the specification file)";

export const UPLIFT_CONTEXT_HEADER = `## Prompt Uplift

The user installed the Ultrathink plugin. It expanded the user's message into the specification below; the ORIGINAL element holds the user's verbatim words. Treat the specification as the user's own elaborated intent and execute it. Do not reprint the XML. Prefer repository evidence over inferred assumptions. Plugin slash commands remain available this turn and later; invoke them when they would help. Completing this rewrite is not the end of the turn.`;

export interface PromptContextInput {
	result: UpliftResult;
	graph?: ThoughtGraph;
	clarifications?: Clarification[];
	/** Path to the session state file `ultrathink-kickoff` should read; adds the tracking tail when set. */
	statePath?: string;
	specPath?: string;
	maxChars?: number;
}

/**
 * Keeps the spec under `maxChars` with the least valuable content going first:
 * RATIONALE bodies are elided before anything is cut, so the graph's WORKFLOW and
 * the CLARIFICATIONS block at the end survive whenever they possibly can.
 */
export function truncateXml(xml: string, maxChars: number, specPath?: string): string {
	if (xml.length <= maxChars) return xml;
	const elided = xml.replace(RATIONALE_RE, `$1${RATIONALE_OMITTED}$2`);
	if (elided.length <= maxChars) return elided;
	const cut = elided.lastIndexOf("\n", maxChars);
	const head = elided.slice(0, cut > 0 ? cut : maxChars);
	const where = specPath ? ` Full specification: ${specPath}` : "";
	return `${head}\n<!-- truncated by Prompt Uplift.${where} -->`;
}

export function formatPromptContext(input: PromptContextInput): string {
	const maxChars = input.maxChars ?? DEFAULT_CONTEXT_CHARS;
	const parts: string[] = [UPLIFT_CONTEXT_HEADER];
	if (input.specPath) parts.push(`Specification file: ${input.specPath}`);

	const tail: string[] = [];
	if (input.graph) {
		tail.push(THINK_ADDENDUM.trim());
		const waves = workflowWaves(input.graph)
			.map((w) => `${w.wave}: ${w.ids.join(", ")}${w.parallel ? " (parallel)" : ""}`)
			.join(" · ");
		if (waves) tail.push(`Workflow waves: ${waves}`);
	}
	if (input.clarifications?.length) {
		const hitl = formatHitlAddendum(input.clarifications).trim();
		if (hitl) tail.push(hitl);
	}
	if (input.statePath) {
		tail.push(
			[
				"## Ultrathink tracking",
				"",
				`Before starting work, invoke the ultrathink-kickoff skill with stateFile=${input.statePath}. It records this Task, its Graph-of-Thought Issues, and per-node detail Sub-Issues in Notion and Linear, resolves any blocking clarifications, and returns the final prompt to execute. Do not start coding before it returns.`,
			].join("\n"),
		);
	}

	const fixed = parts.join("\n\n").length + tail.join("\n\n").length + 4;
	const budget = Math.max(2_000, maxChars - fixed);
	parts.push(truncateXml(input.result.xml, budget, input.specPath));
	return [...parts, ...tail].join("\n\n");
}

export function formatSummary(input: {
	result: UpliftResult;
	engine?: string;
	graph?: ThoughtGraph;
	clarifications?: Clarification[];
	/** True once a TrackPlan has been written but ultrathink-kickoff has not run yet this turn. */
	tracked?: boolean;
	engineError?: string;
	elapsedMs?: number;
}): string {
	const bits = [`Prompt Uplift · ${input.result.root} · ${input.result.source}`];
	if (input.engine) bits.push(input.engine);
	if (input.graph) bits.push(`Graph of Thought · ${input.graph.nodes.length} nodes`);
	if (input.clarifications?.length) {
		const open = input.clarifications.filter((c) => !c.answer).length;
		bits.push(`HITL · ${open} question(s)`);
	}
	if (input.tracked) bits.push("Tracking · ultrathink-kickoff pending");
	if (input.engineError) bits.push(`Engine error · ${input.engineError}`);
	if (input.elapsedMs !== undefined) bits.push(`${(input.elapsedMs / 1000).toFixed(1)}s`);
	return bits.join(" · ");
}
