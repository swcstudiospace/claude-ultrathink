/**
 * Detects a GitHub PR-creation event from either a `gh pr create` Bash
 * command or a PR-creation MCP tool's response, without needing to know the
 * exact MCP tool name in advance (that name is environment-dependent — see
 * hooks/hooks.json). Pure, no I/O.
 */

const GH_PR_CREATE_RE = /\bgh\s+pr\s+create\b/;
const PR_URL_RE = /https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/(\d+)/;

export interface DetectedPr {
	url: string;
	number: number;
}

/**
 * Substring heuristic on a Bash command string: matches `gh pr create` even
 * inside an unrelated quoted string (e.g. a commit message). Accepted
 * limitation — a false positive here costs only an unnecessary nudge, never
 * a missed one.
 */
export function isGhPrCreateCommand(command: string): boolean {
	return GH_PR_CREATE_RE.test(command);
}

/** Finds the first `github.com/.../pull/<n>` URL in arbitrary text (Bash stdout or a JSON-stringified MCP response). */
export function extractPrFromOutput(output: string): DetectedPr | undefined {
	const match = PR_URL_RE.exec(output);
	if (!match) return undefined;
	return { url: match[0], number: Number(match[1]) };
}
