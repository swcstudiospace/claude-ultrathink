// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Embeds created tracker rows (Linear issues, Notion pages) into the uplifted spec
 * and renders the TODO checklist the agent copies into its task list.
 */
import { stepKey } from "./create.ts";
import type { IssueRef, SubIssueRow, TrackingRefs, TrackPlan } from "./types.ts";

const NODE_TAG_RE = /<NODE\b([^>]*?)(\s*\/?)>/g;
const ID_ATTR_RE = /\sid="([^"]*)"/;
const TRACK_ATTR_RE = /\s(?:issue|issueUrl|notionUrl)="[^"]*"/g;
const ISSUES_BLOCK_RE = /\n?[ \t]*<ISSUES graphId="[^"]*"[\s\S]*?<\/ISSUES>/g;
const GRAPH_CLOSE = "</GRAPH_OF_THOUGHT>";

export function escapeXml(value: string): string {
	return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** "[n1] Step 3: …" -> "Step 3: …"; leaves other items untouched. */
function stripNodePrefix(item: string, nodeId: string): string {
	const prefix = `[${nodeId}] `;
	return item.startsWith(prefix) ? item.slice(prefix.length) : item;
}

function attr(name: string, value: string | undefined): string {
	return value ? ` ${name}="${escapeXml(value)}"` : "";
}

function linkAttrs(ref: IssueRef | undefined, notionUrl: string | undefined): string {
	const pending = !ref && !notionUrl ? ' status="pending"' : "";
	return `${pending}${attr("identifier", ref?.identifier)}${attr("url", ref?.url)}${attr("notionUrl", notionUrl)}`;
}

function stepsOf(plan: TrackPlan, nodeId: string): SubIssueRow[] {
	return plan.subIssues.filter((s) => s.nodeId === nodeId).sort((a, b) => a.step - b.step);
}

function issuesBlock(plan: TrackPlan, tracking: TrackingRefs): string {
	const lines = [
		`<ISSUES graphId="${escapeXml(tracking.graphId)}" status="${escapeXml(tracking.status)}"${attr("notionTaskUrl", tracking.notion.taskUrl)}>`,
	];
	for (const issue of plan.issues) {
		const ref = tracking.linear.nodes[issue.nodeId];
		lines.push(
			`\t<ISSUE node="${escapeXml(issue.nodeId)}"${linkAttrs(ref, tracking.notion.nodes[issue.nodeId])}>${escapeXml(issue.item)}`,
		);
		for (const sub of stepsOf(plan, issue.nodeId)) {
			const key = stepKey(sub.nodeId, sub.step);
			lines.push(
				`\t\t<SUBISSUE step="${sub.step}"${linkAttrs(tracking.linear.steps[key], tracking.notion.steps[key])}>${escapeXml(stripNodePrefix(sub.item, sub.nodeId))}</SUBISSUE>`,
			);
		}
		lines.push("\t</ISSUE>");
	}
	lines.push("</ISSUES>");
	return lines.join("\n");
}

/**
 * Idempotently links the spec to its tracker rows: NODE tags gain issue/issueUrl/notionUrl
 * attributes and one ISSUES block sits after the graph (or before the root's closing tag).
 */
export function injectTrackingXml(xml: string, plan: TrackPlan, tracking: TrackingRefs): string {
	const stripped = xml.replace(ISSUES_BLOCK_RE, "");
	const block = issuesBlock(plan, tracking);
	const graphEnd = stripped.lastIndexOf(GRAPH_CLOSE);
	if (graphEnd >= 0) {
		// Only the real graph (the last one) is rewritten; user text copied into ORIGINAL stays verbatim.
		const openAt = stripped.lastIndexOf("<GRAPH_OF_THOUGHT", graphEnd);
		const start = openAt >= 0 ? openAt : graphEnd;
		const at = graphEnd + GRAPH_CLOSE.length;
		const graph = stripped.slice(start, at).replace(NODE_TAG_RE, (whole, attrs: string, close: string) => {
			const id = ID_ATTR_RE.exec(attrs)?.[1];
			if (id === undefined) return whole;
			const ref = tracking.linear.nodes[id];
			const notionUrl = tracking.notion.nodes[id];
			const extra = `${attr("issue", ref?.identifier)}${attr("issueUrl", ref?.url)}${attr("notionUrl", notionUrl)}`;
			return `<NODE${attrs.replace(TRACK_ATTR_RE, "")}${extra}${close}>`;
		});
		return `${stripped.slice(0, start)}${graph}\n${block}${stripped.slice(at)}`;
	}
	const rootClose = stripped.lastIndexOf("</");
	if (rootClose < 0) return `${stripped}\n${block}`;
	const before = stripped.slice(0, rootClose).replace(/\n*$/, "");
	return `${before}\n${block}\n${stripped.slice(rootClose)}`;
}

function todoLine(indent: string, id: string, ref: IssueRef | undefined, title: string, notionUrl: string | undefined): string {
	const notion = notionUrl ? ` · notion: ${notionUrl}` : "";
	return `${indent}- [ ] ${id} · ${ref ? `[${ref.identifier}](${ref.url})` : "(pending)"} · ${title}${notion}`;
}

/** Markdown checklist, one line per node then its indented steps, each carrying its tracker links. */
export function formatTrackingTodos(plan: TrackPlan, tracking: TrackingRefs): string {
	const lines: string[] = [];
	for (const issue of plan.issues) {
		lines.push(
			todoLine(
				"",
				issue.nodeId,
				tracking.linear.nodes[issue.nodeId],
				stripNodePrefix(issue.item, issue.nodeId),
				tracking.notion.nodes[issue.nodeId],
			),
		);
		for (const sub of stepsOf(plan, issue.nodeId)) {
			const key = stepKey(sub.nodeId, sub.step);
			lines.push(
				todoLine("  ", key, tracking.linear.steps[key], stripNodePrefix(sub.item, sub.nodeId), tracking.notion.steps[key]),
			);
		}
	}
	return lines.join("\n");
}
