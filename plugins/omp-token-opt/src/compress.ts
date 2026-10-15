import { estimateTokens } from "./estimate.ts";

const NOOP_UNDER = 4000;
const CAP = 6000;

export interface ShrinkResult {
	text: string;
	baseline: number;
	current: number;
	saved: number;
}

function unchanged(text: string): ShrinkResult {
	const baseline = estimateTokens(text);
	return { text, baseline, current: baseline, saved: 0 };
}

function looksLikeEditableSource(text: string): boolean {
	const start = text.trimStart();
	if (/^diff(?:\s|--git)/.test(start) || (start.startsWith("--- ") && text.includes("\n+++ "))) return true;
	if (start.startsWith("[") && /^\[[^\n]*#[^\n]*\]/.test(start)) return true;
	return false;
}

function collapseDuplicateLines(text: string): string {
	const lines = text.split("\n");
	const out: string[] = [];
	let i = 0;
	while (i < lines.length) {
		const line = lines[i] ?? "";
		let j = i + 1;
		while (j < lines.length && lines[j] === line) j += 1;
		const count = j - i;
		out.push(count > 1 ? `${line} ×${count}` : line);
		i = j;
	}
	return out.join("\n");
}

function headTail(text: string): string {
	const headLen = Math.floor(CAP * 0.6);
	const tailLen = CAP - headLen;
	if (text.length <= headLen + tailLen) return text;
	const omitted = text.length - headLen - tailLen;
	const head = text.slice(0, headLen);
	const tail = text.slice(text.length - tailLen);
	return `${head}\n… omitted ${omitted} chars …\n${tail}`;
}

/** Shrink tool text. Never throws. saved === baseline - current, or the original text. */
export function shrinkToolText(text: string): ShrinkResult {
	try {
		if (typeof text !== "string" || text.length === 0) return unchanged("");
		if (text.length < NOOP_UNDER || looksLikeEditableSource(text)) return unchanged(text);
		let next = collapseDuplicateLines(text);
		if (next.length > CAP) next = headTail(next);
		const baseline = estimateTokens(text);
		const current = estimateTokens(next);
		const saved = baseline - current;
		if (saved <= 0 || next === text) return unchanged(text);
		return { text: next, baseline, current, saved };
	} catch {
		return unchanged(typeof text === "string" ? text : "");
	}
}
