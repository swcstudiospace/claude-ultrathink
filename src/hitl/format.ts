import { escapeXml } from "../uplift/xml.ts";
import type { Clarification, ClarificationOption } from "./types.ts";

const CLARIFICATIONS_BLOCK_RE = /<CLARIFICATIONS\b[\s\S]*?<\/CLARIFICATIONS>/i;

function optionText(option: ClarificationOption): string {
	return option.description ? `${option.label} — ${option.description}` : option.label;
}

function clarificationXml(item: Clarification): string {
	const lines = [
		`	<CLARIFICATION id="${escapeXml(item.id)}" header="${escapeXml(item.header)}" blocking="${item.blocking ? "true" : "false"}">`,
		`		<QUESTION>${escapeXml(item.question)}</QUESTION>`,
		`		<WHY>${escapeXml(item.why)}</WHY>`,
		"		<OPTIONS>",
		...item.options.map((option) => {
			const recommended = item.default !== undefined && option.label === item.default ? ' recommended="true"' : "";
			return `			<OPTION${recommended}>${escapeXml(optionText(option))}</OPTION>`;
		}),
		"		</OPTIONS>",
	];
	if (item.answer !== undefined) {
		lines.push(`		<ANSWER source="${item.source ?? "user"}">${escapeXml(item.answer)}</ANSWER>`);
	}
	lines.push("	</CLARIFICATION>");
	return lines.join("\n");
}

export function clarificationsToXml(list: Clarification[]): string {
	if (list.length === 0) return "";
	return ["<CLARIFICATIONS>", ...list.map((item) => clarificationXml(item)), "</CLARIFICATIONS>"].join("\n");
}

/** Replace an existing <CLARIFICATIONS> block, else insert before the root closing tag. Empty list removes the block. */
export function injectClarificationsXml(upliftXml: string, list: Clarification[]): string {
	const block = clarificationsToXml(list);
	if (CLARIFICATIONS_BLOCK_RE.test(upliftXml)) {
		if (!block) return upliftXml.replace(/\n?[ \t]*<CLARIFICATIONS\b[\s\S]*?<\/CLARIFICATIONS>/i, "");
		return upliftXml.replace(CLARIFICATIONS_BLOCK_RE, block);
	}
	if (!block) return upliftXml;

	const trimmed = upliftXml.trim();
	const open = trimmed.match(/^<([A-Za-z_][\w.-]*)\b([^>]*)>/);
	if (!open) return trimmed ? `${trimmed}\n${block}` : block;

	const tag = open[1]!;
	const closeRe = new RegExp(`</${tag}\\s*>\\s*$`, "i");
	if (!closeRe.test(trimmed)) return `${trimmed}\n${block}`;
	return trimmed.replace(closeRe, `\n${block}\n</${tag}>`);
}

function optionsLine(item: Clarification): string {
	const labels = item.options.map((option) => option.label).join(" | ");
	const recommended = item.default ? ` (recommended: ${item.default})` : "";
	return `${labels}${recommended}`;
}

export function formatHitlAddendum(list: Clarification[]): string {
	if (list.length === 0) return "";
	const open = list.filter((item) => item.answer === undefined);
	const blocking = open.filter((item) => item.blocking);
	const nonBlocking = open.filter((item) => !item.blocking);
	const answered = list.filter((item) => item.answer !== undefined);

	const lines = [
		"## Clarifications (HITL)",
		"",
		"The planning pass flagged open questions whose answers change the implementation. Handle them before writing code:",
		"",
		"1. First try to resolve each open question from repository evidence (files, config, git history, the conversation). A question answered by a file read is settled; do not ask it.",
		"2. For questions still open that are marked blocking, call the `AskUserQuestion` tool ONCE with up to 4 of them, using the given header and options with the recommended default listed first. Users see the options as suggestions and may type their own answer.",
		"3. For non-blocking open questions, proceed with the recommended default and state the assumption explicitly in your first reply.",
		'4. Never re-ask items listed under "Answered"; treat those answers as settled decisions.',
		"5. If `AskUserQuestion` is unavailable (non-interactive run), proceed with the recommended defaults and list every assumption you made.",
	];

	if (blocking.length > 0) {
		lines.push("", "### Open (blocking)", "");
		for (const item of blocking) lines.push(`- [${item.id}] ${item.question} — options: ${optionsLine(item)}`);
	}
	if (nonBlocking.length > 0) {
		lines.push("", "### Open (non-blocking)", "");
		for (const item of nonBlocking) lines.push(`- [${item.id}] ${item.question} — options: ${optionsLine(item)}`);
	}
	if (answered.length > 0) {
		lines.push("", "### Answered", "");
		for (const item of answered) lines.push(`- [${item.id}] ${item.question} → ${item.answer}`);
	}
	lines.push("");
	return lines.join("\n");
}

export function formatHitlEcho(list: Clarification[]): string {
	if (list.length === 0) return "No clarifications recorded";
	return list
		.map((item) => {
			const flag = item.blocking ? " [blocking]" : "";
			const options = item.options.map((option) => option.label).join(" | ");
			const defaultBit = item.default ? ` (default: ${item.default})` : "";
			const lines = [`${item.id}${flag} ${item.header}: ${item.question}`, `   options: ${options}${defaultBit}`];
			if (item.answer !== undefined) {
				const source = item.source === "assumed" ? " (assumed)" : "";
				lines.push(`   answer: ${item.answer}${source}`);
			}
			return lines.join("\n");
		})
		.join("\n");
}
