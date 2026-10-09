// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * `ultrathink-grokbot prompts build`: turns one planned graph node into a cloud-agent prompt. The prompt is derived from
 * the plan, never from a static template: the full uplifted spec, the unit's node question and conclusion, its
 * Chain-of-Thought steps (one SUBISSUE each, linked to tracker refs when kickoff has run), the predecessor conclusions,
 * the synthesize node's WORKFLOW, the clarifications (answers or stated defaults), the verify commands, and at most ten
 * desk rules. `validateCloudPrompt` checks well-formedness and content before anything is shown or launched.
 */
import type { SessionRecord } from "../claude/state.ts";
import { nodeStepTitles, splitRationaleSteps } from "../track/plan.ts";
import type { TrackingRefs } from "../track/types.ts";
import { escapeXml } from "../uplift/xml.ts";
import { stripTrackingXml } from "../track/render.ts";
import { MAX_STEPS, MIN_STEPS } from "../think/types.ts";

export const MAX_DESK_RULES = 10;

export const DEFAULT_DESK_RULES: readonly string[] = [
	"Never merge, enable auto-merge or delete branches; the PR stays a draft until Ming approves the merge.",
	"Never put signing keys (SWARM_ED25519_KEY, SWARM_SIGNING_KEY) or substrate tokens on this VM; this run is keyless and advisory.",
	"Never run scripts/swarm_run.py or hooks/autonomous_run.py, and never use yolo, acceptEdits or bypassPermissions modes.",
	"Never skip or weaken tests, never use --no-verify, and write each regression test so it fails on the pre-fix head first.",
	"Work only on the branch named in DISPATCH; one unit, one PR.",
	"Pass the ultrathink graph id to orch_plan as --graph-id when you plan with the swarm, so every record shares one id.",
	"Greptile is the merge gate: after each push, read its review and fix every finding; Desk Lead runs the loop (cap 5 rounds).",
	"End with a receipt in the PR body: files changed, commands run with results, advisory swarm state, open risks.",
	"Never print or commit secrets; redact emails and tokens from logs you paste.",
	"If a step is blocked or ambiguous, stop and report it in the PR instead of guessing.",
];

export interface UnitDispatch {
	unit: string;
	mode: "new" | "followup";
	repo: string;
	branch: string;
	agentId?: string;
	pr?: number;
	seat?: string;
	base?: string;
	verify?: string;
	notes?: string[];
	rules?: string[];
}

const esc = (value: string): string => escapeXml(value);
const attr = (name: string, value: string | number | undefined): string => (value === undefined || value === "" ? "" : ` ${name}="${escapeXml(String(value))}"`);

function workflowOf(record: SessionRecord): { lines: string[]; verify?: string } {
	const synth = record.graph?.nodes.find((node) => node.kind === "synthesize");
	const text = synth?.conclusion ?? "";
	const lines = text.split("\n").map((line) => line.trim()).filter((line) => /^Wave \d+/.test(line));
	const verify = text.split("\n").map((line) => line.trim()).find((line) => line.startsWith("Verify:"));
	return { lines, ...(verify ? { verify: verify.replace(/^Verify:\s*/, "") } : {}) };
}

/** The spec as planned: `injectTrackingXml` undone (no `<ISSUES>` block, no issue/issueUrl/notionUrl on NODE tags). */
export function untrackedSpec(xml: string): string {
	return stripTrackingXml(xml);
}

/** SUBISSUE steps of the unit itself (inside `<UNIT>…<SUBISSUES>`), never the ones in the embedded SPEC. */
export function unitSubissueCount(xml: string): number {
	const block = xml.match(/<UNIT\b[^>]*>[\s\S]*?<SUBISSUES>([\s\S]*?)<\/SUBISSUES>/);
	return block ? (block[1]!.match(/<SUBISSUE\b/g) ?? []).length : 0;
}

export function buildCloudPrompt(record: SessionRecord, dispatch: UnitDispatch): string {
	const graph = record.graph;
	const plan = record.plan;
	if (!graph || !plan) throw new Error("session record has no graph/plan");
	const node = graph.nodes.find((n) => n.id === dispatch.unit);
	if (!node) throw new Error(`unknown unit ${dispatch.unit}`);
	const tracking: TrackingRefs | undefined = record.tracking;
	const steps = nodeStepTitles(node);
	const rawSteps = splitRationaleSteps(node.thinking ?? "");
	const rules = (dispatch.rules ?? DEFAULT_DESK_RULES).slice(0, MAX_DESK_RULES);
	const issue = tracking?.linear.nodes[node.id];
	const notion = tracking?.notion.nodes[node.id];
	const workflow = workflowOf(record);
	const verify = dispatch.verify ?? workflow.verify ?? "";
	const out: string[] = [];
	out.push(`<CLOUD_AGENT_PROMPT${attr("version", "1")}${attr("graph", plan.graphId)}${attr("unit", node.id)}${attr("mode", dispatch.mode)}${attr("agent", dispatch.agentId)}>`);
	if (dispatch.mode === "followup") {
		out.push(
			`  <FOLLOW_UP>${esc(`Continue on the existing ${dispatch.repo} PR${dispatch.pr ? ` #${dispatch.pr}` : ""} on branch ${dispatch.branch}. Do not open a new PR or branch. This prompt replaces your earlier fix-up brief: it is derived from Ming's ORIGINAL request through the ultrathink plan below, and the earlier approved fix content is kept as grounding.`)}</FOLLOW_UP>`,
		);
	}
	out.push("  <DISPATCH>");
	out.push(`    <REPO>${esc(dispatch.repo)}</REPO>`);
	out.push(`    <BRANCH${attr("base", dispatch.base)}>${esc(dispatch.branch)}</BRANCH>`);
	if (dispatch.pr) out.push(`    <PR>${dispatch.pr}</PR>`);
	if (dispatch.seat) out.push(`    <SEAT>${esc(dispatch.seat)}</SEAT>`);
	out.push(`    <GRAPH_ID>${esc(plan.graphId)}</GRAPH_ID>`);
	out.push(`    <MODE>${dispatch.mode === "followup" ? "follow-up on an existing cloud agent" : "new cloud agent, new draft PR"}</MODE>`);
	out.push("  </DISPATCH>");
	out.push(`  <UNIT${attr("id", node.id)}${attr("kind", node.kind)}${attr("title", node.title)}${attr("issue", issue?.identifier ?? "pending kickoff")}${attr("url", issue?.url)}${attr("notion", notion)}>`);
	out.push(`    <QUESTION>${esc(node.question)}</QUESTION>`);
	out.push(`    <NODE_CONCLUSION>${esc(node.conclusion ?? "")}</NODE_CONCLUSION>`);
	out.push("    <SUBISSUES>");
	steps.forEach((title, index) => {
		const key = `${node.id}.${index + 1}`;
		const ref = tracking?.linear.steps[key];
		out.push(`      <SUBISSUE${attr("step", index + 1)}${attr("issue", ref?.identifier ?? "pending kickoff")}${attr("url", ref?.url)}${attr("notion", tracking?.notion.steps[key])}${attr("title", title)}>${esc(rawSteps[index] ?? title)}</SUBISSUE>`);
	});
	out.push("    </SUBISSUES>");
	const preds = node.dependsOn.map((id) => graph.nodes.find((n) => n.id === id)).filter((n) => n !== undefined);
	if (preds.length > 0) {
		out.push("    <PREDECESSORS>");
		for (const pred of preds) out.push(`      <PREDECESSOR${attr("id", pred.id)}${attr("title", pred.title)}>${esc(pred.conclusion ?? "")}</PREDECESSOR>`);
		out.push("    </PREDECESSORS>");
	}
	out.push("  </UNIT>");
	if (dispatch.notes?.length) {
		out.push("  <GROUNDING>");
		for (const note of dispatch.notes) out.push(`    <NOTE>${esc(note)}</NOTE>`);
		out.push("  </GROUNDING>");
	}
	if (workflow.lines.length) {
		out.push("  <WORKFLOW>");
		for (const line of workflow.lines) out.push(`    <WAVE_UNIT>${esc(line)}</WAVE_UNIT>`);
		out.push("  </WORKFLOW>");
	}
	out.push("  <ISSUES>");
	out.push(`    <ISSUE${attr("node", node.id)}${attr("ref", issue?.identifier ?? "pending kickoff")}${attr("url", issue?.url)}${attr("notion", notion)}>${esc(`[${node.id}] ${node.title}`)}</ISSUE>`);
	out.push("  </ISSUES>");
	const questions = record.clarifications ?? [];
	out.push("  <CLARIFICATIONS>");
	for (const q of questions) {
		const answer = q.answer ? `answered: ${q.answer}` : `default (proceed and state it): ${q.default ?? ""}`;
		out.push(`    <CLARIFICATION${attr("id", q.id)}${attr("blocking", String(q.blocking))}>${esc(`${q.question} -> ${answer}`)}</CLARIFICATION>`);
	}
	out.push("  </CLARIFICATIONS>");
	out.push(`  <VERIFY>${esc(verify)}</VERIFY>`);
	out.push("  <DESK_RULES>");
	for (const rule of rules) out.push(`    <RULE>${esc(rule)}</RULE>`);
	out.push("  </DESK_RULES>");
	out.push("  <SPEC>");
	// Kickoff re-renders the spec with tracker links (NODE attributes plus an <ISSUES> block of one SUBISSUE per step of
	// every node). The unit's own refs are already on UNIT/SUBISSUE/ISSUE above, so the embedded spec stays the planned one.
	out.push(untrackedSpec(record.result.xml));
	out.push("  </SPEC>");
	out.push("</CLOUD_AGENT_PROMPT>");
	return `${out.join("\n")}\n`;
}

/** Minimal well-formedness check: balanced tags, no stray `<` or bare `&`, one root. */
export function wellFormed(xml: string): string[] {
	const errors: string[] = [];
	const stack: string[] = [];
	const tag = /<(\/?)([A-Za-z_][\w.-]*)((?:\s+[\w:.-]+\s*=\s*"[^"]*")*)\s*(\/?)>|<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>/g;
	let last = 0;
	let roots = 0;
	for (const match of xml.matchAll(tag)) {
		const between = xml.slice(last, match.index);
		if (between.includes("<")) errors.push(`stray "<" near offset ${last + between.indexOf("<")}`);
		if (/&(?!(?:lt|gt|amp|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(between)) errors.push(`bare "&" near offset ${last}`);
		last = (match.index ?? 0) + match[0].length;
		if (match[0].startsWith("<!")) continue;
		const [, close, name, , self] = match;
		if (self) {
			if (stack.length === 0) roots++;
			continue;
		}
		if (close) {
			const open = stack.pop();
			if (open !== name) errors.push(`</${name}> closes <${open ?? "nothing"}>`);
		} else {
			if (stack.length === 0) roots++;
			stack.push(name as string);
		}
		if (errors.length > 5) break;
	}
	const tail = xml.slice(last);
	if (tail.includes("<")) errors.push("stray \"<\" after the last tag");
	if (stack.length) errors.push(`unclosed: ${stack.join(", ")}`);
	if (roots !== 1) errors.push(`expected one root element, found ${roots}`);
	return errors;
}

const SECRET_PATTERNS = [/sk-or-[A-Za-z0-9]{8,}/, /gh[pousr]_[A-Za-z0-9]{20,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /lin_api_[A-Za-z0-9]{8,}/, /SWARM_(?:ED25519|SIGNING)_KEY\s*=\s*\S{8,}/];

export function validateCloudPrompt(xml: string, dispatch: UnitDispatch, original: string): { ok: boolean; errors: string[]; chars: number } {
	const errors = wellFormed(xml);
	const need = ["<DISPATCH>", "<UNIT ", "<SUBISSUES>", "<ISSUES>", "<CLARIFICATIONS>", "<VERIFY>", "<DESK_RULES>", "<SPEC>"];
	for (const section of need) if (!xml.includes(section)) errors.push(`missing ${section.replace(/[<> ]/g, "")}`);
	const rules = (xml.match(/<RULE>/g) ?? []).length;
	if (rules === 0 || rules > MAX_DESK_RULES) errors.push(`DESK_RULES must have 1-${MAX_DESK_RULES} rules (got ${rules})`);
	const subs = unitSubissueCount(xml);
	if (subs < MIN_STEPS || subs > MAX_STEPS) errors.push(`unit must carry ${MIN_STEPS}-${MAX_STEPS} SUBISSUE steps (got ${subs})`);
	if (!xml.includes(`<ORIGINAL>${escapeXml(original)}</ORIGINAL>`)) errors.push("SPEC must carry ORIGINAL verbatim");
	if (!xml.includes(`<BRANCH`) || !xml.includes(`>${escapeXml(dispatch.branch)}</BRANCH>`)) errors.push("DISPATCH branch missing");
	if (dispatch.mode === "followup" && (!dispatch.agentId || !xml.includes("<FOLLOW_UP>"))) errors.push("follow-up prompts need an agent id and a FOLLOW_UP block");
	const generated = xml.replace(/<ORIGINAL>[\s\S]*?<\/ORIGINAL>/g, "");
	if (/\{\{|\bTODO\b|\bTBD\b|lorem ipsum/i.test(generated)) errors.push("template placeholder text found");
	for (const pattern of SECRET_PATTERNS) if (pattern.test(xml)) errors.push(`secret-like string matched ${pattern.source}`);
	return { ok: errors.length === 0, errors, chars: xml.length };
}
