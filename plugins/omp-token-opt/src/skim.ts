const SOURCE_EXT = /\.(ts|tsx|js|jsx|py|go|rs)$/;
const SKIM_LINE = /^(export\s+|function\s+|class\s+|def\s+|type\s+|interface\s+|async\s+function\s+)/;
const SKIM_MIN_CHARS = 12_000;
const SKIM_MAX_LINES = 80;
const SKIM_ARCHIVE_CAP = 8;
const skimArchive = new Map<string, string>();

/** Drop in-memory skim bodies. Does not touch the ledger or disk. */
export function clearSkimArchive(): void {
	skimArchive.clear();
}

export function skimArchiveSize(): number {
	return skimArchive.size;
}

/** Keep the original body for a path that was actually shortened. Oldest path drops at 8. */
export function rememberSkim(path: string, original: string): void {
	if (typeof path !== "string" || path.length === 0 || typeof original !== "string") return;
	if (skimArchive.has(path)) skimArchive.delete(path);
	skimArchive.set(path, original);
	while (skimArchive.size > SKIM_ARCHIVE_CAP) {
		const oldest = skimArchive.keys().next().value;
		if (oldest === undefined) break;
		skimArchive.delete(oldest);
	}
}

/** Inclusive 1-based lines from the archive, or null if this session never skimmed the path. */
export function readSkimSpan(path: string, start: number, end: number): string | null {
	const body = skimArchive.get(path);
	if (body === undefined) return null;
	const lines = body.split("\n");
	const from = start - 1;
	const to = Math.min(end, start + 199);
	return lines.slice(from, to).join("\n");
}

function skipBody(text: string): boolean {
	const start = text.trimStart();
	if (/^diff(?:\s|--git)/.test(start) || (start.startsWith("--- ") && text.includes("\n+++ "))) return true;
	if (start.startsWith("[") && /^\[[^\n]*#[^\n]*\]/.test(start)) return true;
	return false;
}

/** Return a declaration skim, or the original text. Never throws. */
export function skimSource(text: string, path: string): string {
	try {
		const body = typeof text === "string" ? text : "";
		if (typeof path !== "string" || path.length === 0) return body;
		if (!SOURCE_EXT.test(path) || path.includes(":")) return body;
		if (body.length <= SKIM_MIN_CHARS || skipBody(body)) return body;
		const kept: string[] = [];
		for (const line of body.split("\n")) {
			if (kept.length >= SKIM_MAX_LINES) break;
			if (SKIM_LINE.test(line)) kept.push(line);
		}
		if (kept.length === 0) return body;
		const selected = kept.join("\n");
		const omitted = body.length - selected.length;
		if (!Number.isSafeInteger(omitted) || omitted < 0) return body;
		const skimmed = `${selected}\ntoken-opt: skimmed ${omitted} chars`;
		if (skimmed.length >= body.length) return body;
		return skimmed;
	} catch {
		return typeof text === "string" ? text : "";
	}
}
