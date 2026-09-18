import { ROOT_TAGS } from "../types.ts";

const ALLOWED_ROOTS: Record<string, true> = Object.fromEntries(
	[...ROOT_TAGS, "uplifted", "ultrathink"].map((tag) => [tag.toLowerCase(), true as const]),
);
const ROOT_OPEN_RE = /^<([A-Za-z_][\w.-]*)\b([^>]*)>/;

export function escapeXml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

export function stripFences(text: string): string {
	const value = text.trim();
	const wrapped = value.match(/^```(?:xml)?\s*\r?\n?([\s\S]*?)\r?\n?```$/i);
	if (wrapped?.[1] !== undefined) return wrapped[1].trim();
	return value;
}

function matchRootTag(xml: string): string | null {
	const match = xml.trim().match(/^<([A-Za-z_][\w.-]*)\b/);
	return match?.[1] ?? null;
}

export function looksLikeUpliftXml(text: string): boolean {
	return matchRootTag(stripFences(text)) !== null;
}

export function ensureOriginal(xml: string, original: string): string {
	const trimmed = xml.trim();
	if (/<ORIGINAL\b/i.test(trimmed)) return trimmed;

	const open = trimmed.match(ROOT_OPEN_RE);
	if (!open) return trimmed;

	const tag = open[1]!;
	const inner = open[2] ?? "";
	const originalEl = `<ORIGINAL>${escapeXml(original)}</ORIGINAL>`;

	if (inner.trimEnd().endsWith("/")) {
		const attrs = inner.replace(/\/\s*$/, "");
		return `<${tag}${attrs}>${originalEl}</${tag}>`;
	}

	return `${open[0]}\n${originalEl}\n${trimmed.slice(open[0].length)}`;
}

export function sanitizeUpliftXml(raw: string, original: string): string | null {
	const stripped = stripFences(raw).trim();
	const root = matchRootTag(stripped);
	if (!root) return null;

	let xml = stripped;
	if (!ALLOWED_ROOTS[root.toLowerCase()]) {
		xml = `<UPLIFTED_PROMPT>\n${xml}\n</UPLIFTED_PROMPT>`;
	}
	return ensureOriginal(xml, original);
}
