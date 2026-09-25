// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import type { SessionRecord } from "../claude/state.ts";
import type { Assessment } from "./types.ts";

const TITLE_MAX = 72;
// Absolute local paths (/root/..., /home/..., C:\...) never belong in a PR.
const LOCAL_PATH = /(?:[A-Za-z]:\\|\/(?:root|home|Users|tmp|var|private)\/)[^\s)`'"]*/g;

// Strips ASCII control chars (keeping \n and \t) and absolute local paths from interpolated text.
function scrub(text: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
	return text.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "").replace(LOCAL_PATH, "<local path>");
}

export function buildPr(record: SessionRecord, assessment?: Assessment): { title: string; body: string } {
	const source = record.graph?.goal?.trim() || record.result.original.trim().split("\n")[0]?.trim() || "ultrathink change";
	const oneLine = scrub(source).replace(/\s+/g, " ").trim();
	const title = oneLine.length > TITLE_MAX ? `${oneLine.slice(0, TITLE_MAX - 1).trimEnd()}…` : oneLine;

	const sections: string[] = [];
	const summary = assessment?.summary.trim() || record.result.original.trim();
	sections.push(`## Summary\n\n${scrub(summary)}`);

	const tracking = record.tracking;
	const links: string[] = [];
	if (tracking) {
		for (const ref of Object.values(tracking.linear.nodes)) {
			links.push(`Fixes ${scrub(ref.identifier)} — ${scrub(ref.title)}\n${scrub(ref.url)}`);
		}
		if (tracking.notion.taskUrl) links.push(`Notion task: ${scrub(tracking.notion.taskUrl)}`);
	}
	if (links.length > 0) sections.push(`## Linked issues\n\n${links.join("\n\n")}`);

	if (assessment) {
		const lines = [`- Done: ${assessment.done ? "yes" : "no"}`, `- Confidence: ${assessment.confidence}`];
		if (assessment.gaps.length > 0) {
			lines.push("- Gaps:", ...assessment.gaps.map((gap) => `  - ${scrub(gap)}`));
		}
		sections.push(`## Assessment\n\n${lines.join("\n")}`);
	}

	if (record.plan) sections.push(`---\nultrathink graph ${scrub(record.plan.graphId)}`);
	return { title, body: `${sections.join("\n\n")}\n` };
}
