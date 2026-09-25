// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * LLM completion for the Claude Code plugin path.
 *
 * Calls headless `claude -p` so the plugin reuses whatever login the user already
 * has (OAuth or API key). Tools and settings sources are disabled so the child is a
 * plain completion, and ULTRATHINK_CHILD marks it so the UserPromptSubmit hook does
 * not recurse into itself.
 */

export const CHILD_ENV = "ULTRATHINK_CHILD";

export interface ClaudeCompleteOptions {
	bin?: string;
	model?: string;
	/** Comma-separated `--setting-sources` value; empty string loads none. */
	settingSources?: string;
	cwd?: string;
	/** Allow extended thinking in the child; off by default because it dominates latency. */
	thinking?: boolean;
	timeoutMs?: number;
	signal?: AbortSignal;
	env?: Record<string, string | undefined>;
}

export type ClaudeCompleter = (system: string, user: string, signal?: AbortSignal) => Promise<string>;

export function isChildInvocation(env: Record<string, string | undefined> = process.env): boolean {
	return env[CHILD_ENV] === "1";
}

export function buildClaudeArgs(system: string, opts: Pick<ClaudeCompleteOptions, "model" | "settingSources"> = {}): string[] {
	const args = [
		"-p",
		"--tools",
		"",
		"--setting-sources",
		opts.settingSources ?? "",
		"--no-session-persistence",
		"--strict-mcp-config",
		"--exclude-dynamic-system-prompt-sections",
		"--output-format",
		"json",
		"--system-prompt",
		system,
	];
	if (opts.model?.trim()) args.push("--model", opts.model.trim());
	return args;
}

/** Extracts the assistant text from `claude -p --output-format json` stdout. */
export function parseClaudeJson(stdout: string): string {
	const trimmed = stdout.trim();
	if (!trimmed) throw new Error("claude returned no output");
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		// Some builds print log lines before the JSON; take the last JSON object.
		const start = trimmed.lastIndexOf("\n{");
		if (start === -1) throw new Error("claude output is not JSON");
		parsed = JSON.parse(trimmed.slice(start + 1));
	}
	if (!parsed || typeof parsed !== "object") throw new Error("claude output is not an object");
	const rec = parsed as { result?: unknown; is_error?: unknown; subtype?: unknown };
	const result = typeof rec.result === "string" ? rec.result : "";
	if (rec.is_error === true) throw new Error(result || `claude error (${String(rec.subtype ?? "unknown")})`);
	return result;
}

function abortError(): Error {
	const error = new Error("Aborted");
	error.name = "AbortError";
	return error;
}

export async function claudeComplete(system: string, user: string, opts: ClaudeCompleteOptions = {}): Promise<string> {
	if (opts.signal?.aborted) throw abortError();
	const bin = opts.bin?.trim() || "claude";
	const env: Record<string, string | undefined> = { ...(opts.env ?? process.env), [CHILD_ENV]: "1" };
	if (!opts.thinking) env.MAX_THINKING_TOKENS = "0";
	const proc = Bun.spawn([bin, ...buildClaudeArgs(system, opts)], {
		cwd: opts.cwd,
		env,
		stdin: Buffer.from(user, "utf8"),
		stdout: "pipe",
		stderr: "pipe",
	});

	let timedOut = false;
	let aborted = false;
	const timer = opts.timeoutMs && opts.timeoutMs > 0
		? setTimeout(() => {
				timedOut = true;
				proc.kill();
			}, opts.timeoutMs)
		: undefined;
	const onAbort = (): void => {
		aborted = true;
		proc.kill();
	};
	opts.signal?.addEventListener("abort", onAbort, { once: true });

	try {
		const [stdout, stderr, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		if (aborted) throw abortError();
		if (timedOut) throw new Error(`claude timed out after ${opts.timeoutMs}ms`);
		if (code !== 0 && !stdout.trim()) throw new Error(stderr.trim() || `claude exited ${code}`);
		return parseClaudeJson(stdout);
	} finally {
		if (timer) clearTimeout(timer);
		opts.signal?.removeEventListener("abort", onAbort);
	}
}

export function createClaudeCompleter(opts: Omit<ClaudeCompleteOptions, "signal">): ClaudeCompleter {
	return (system, user, signal) => claudeComplete(system, user, { ...opts, signal });
}
