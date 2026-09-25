// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Detects a GitHub PR-creation event from either a `gh pr create` shell
 * command or a PR-creation tool, plus the PR URL in the tool's response.
 * Hosts without a hook matcher (Muse) route every tool call through here, so
 * the tool-name check must reject everything else itself. Pure, no I/O.
 */

const GH_PR_CREATE_RE = /\bgh\s+pr\s+create\b/;
const PR_URL_RE = /https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/pull\/(\d+)/;
const PR_TOOL_RE = /(?:create[_-]?pull[_-]?request|pull[_-]?request[_-]?create|createPullRequest)$/i;
const SHELL_TOOLS: Record<string, true> = {
	Bash: true,
	bash: true,
	run_terminal_command: true,
	shell: true,
	exec: true,
	terminal: true,
};

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

/**
 * True for a shell tool running `gh pr create`, or a tool whose name reads as
 * PR creation (e.g. `mcp__github__create_pull_request`, `createPullRequest`).
 */
export function isPrCreationTool(toolName: string | undefined, command: string | undefined): boolean {
	if (!toolName) return false;
	if (SHELL_TOOLS[toolName] === true) return isGhPrCreateCommand(command ?? "");
	return PR_TOOL_RE.test(toolName);
}

/** Finds the first `github.com/.../pull/<n>` URL in arbitrary text (Bash stdout or a JSON-stringified MCP response). */
export function extractPrFromOutput(output: string): DetectedPr | undefined {
	const match = PR_URL_RE.exec(output);
	if (!match) return undefined;
	return { url: match[0], number: Number(match[1]) };
}
