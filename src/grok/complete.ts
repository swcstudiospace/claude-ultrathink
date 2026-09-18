/**
 * Grok 4.6 completion for the Ultrathink pre-pass.
 *
 * Default transport talks directly to the Grok CLI chat proxy (`/responses`)
 * with the user's existing `grok login` session; the `cli` transport shells
 * out to the Grok Build CLI instead so the same login is reused either way.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type EnsureFreshOptions,
	ensureFreshGrokAuth,
	type GrokAuth,
	GrokAuthError,
	GrokHttpError,
	grokClientVersion,
	grokHeaders,
	isGrokAuthExpired,
	redactSecrets,
} from "./auth.ts";
import { DEFAULT_GROK_CONFIG, type GrokEffort, type GrokTransport } from "./types.ts";

export type Completer = (system: string, user: string, signal?: AbortSignal) => Promise<string>;

export interface GrokCompleteOptions {
	baseUrl?: string;
	model?: string;
	reasoningEffort?: GrokEffort;
	timeoutMs?: number;
	home?: string;
	signal?: AbortSignal;
	fetch?: typeof fetch;
	transport?: GrokTransport;
	bin?: string;
	/** Unused: the CLI transport always runs in a scratch directory (see `scratchDir`) so headless sessions do not litter the project's `~/.grok/sessions`. */
	cwd?: string;
	/** Test seam for the CLI-driven token refresh; default `ensureFreshGrokAuth`. */
	refresh?: (opts: EnsureFreshOptions) => Promise<GrokAuth | undefined>;
}

const LOGIN_HINT = "run `grok login`";

export function buildResponsesBody(system: string, user: string, model: string, effort: GrokEffort): Record<string, unknown> {
	return { model, instructions: system, input: user, reasoning: { effort }, stream: false };
}

/** Shape of a `/responses` reply; each field is still checked at use because it is upstream JSON. */
interface ResponsesReply {
	output?: unknown;
	output_text?: unknown;
}

interface ResponsesOutputItem {
	type?: unknown;
	content?: unknown;
}

interface ResponsesContentBlock {
	type?: unknown;
	text?: unknown;
}

/** Extracts assistant text from a `/responses` reply. */
export function parseResponsesText(json: unknown): string {
	const reply: ResponsesReply = json && typeof json === "object" ? json : {};
	const parts: string[] = [];
	if (Array.isArray(reply.output)) {
		for (const entry of reply.output) {
			if (!entry || typeof entry !== "object") continue;
			const item: ResponsesOutputItem = entry;
			if (item.type !== "message" || !Array.isArray(item.content)) continue;
			for (const raw of item.content) {
				if (!raw || typeof raw !== "object") continue;
				const block: ResponsesContentBlock = raw;
				if (block.type === "output_text" && typeof block.text === "string" && block.text) parts.push(block.text);
			}
		}
	}
	if (parts.length === 0 && typeof reply.output_text === "string" && reply.output_text) parts.push(reply.output_text);
	const text = parts.join("\n");
	if (!text.trim()) throw new Error("grok returned no text");
	return text;
}

function abortError(): Error {
	const error = new Error("Aborted");
	error.name = "AbortError";
	return error;
}

async function completeHttp(system: string, user: string, opts: GrokCompleteOptions, model: string, effort: GrokEffort): Promise<string> {
	const refresh = opts.refresh ?? ensureFreshGrokAuth;
	const refreshOpts: EnsureFreshOptions = { home: opts.home, bin: opts.bin, timeoutMs: 20_000 };
	const auth = await refresh(refreshOpts);
	if (!auth) throw new GrokAuthError(`Grok login missing: ${LOGIN_HINT}`);
	if (isGrokAuthExpired(auth)) throw new GrokAuthError(`Grok login expired: ${LOGIN_HINT}`);

	const baseUrl = (opts.baseUrl?.trim() || DEFAULT_GROK_CONFIG.baseUrl).replace(/\/+$/, "");
	const timeoutMs = opts.timeoutMs ?? DEFAULT_GROK_CONFIG.callTimeoutMs;
	const controller = new AbortController();
	let timedOut = false;
	const timer = timeoutMs > 0
		? setTimeout(() => {
				timedOut = true;
				controller.abort();
			}, timeoutMs)
		: undefined;
	const onAbort = (): void => controller.abort();
	opts.signal?.addEventListener("abort", onAbort, { once: true });
	const version = grokClientVersion(opts.home);
	const body = JSON.stringify(buildResponsesBody(system, user, model, effort));

	async function send(session: GrokAuth): Promise<Response> {
		try {
			return await (opts.fetch ?? fetch)(`${baseUrl}/responses`, {
				method: "POST",
				headers: { ...grokHeaders(session, model, version), "content-type": "application/json", accept: "application/json" },
				body,
				signal: controller.signal,
			});
		} catch (error) {
			if (opts.signal?.aborted) throw abortError();
			if (timedOut) throw new Error(`grok timed out after ${timeoutMs}ms`);
			throw error;
		}
	}

	try {
		let res = await send(auth);
		if (res.status === 401 || res.status === 403) {
			// The stored token may have been revoked before its expiry; let the CLI refresh it once.
			const refreshed = await refresh({ ...refreshOpts, force: true });
			if (refreshed && refreshed.token !== auth.token && !isGrokAuthExpired(refreshed)) {
				await res.body?.cancel();
				res = await send(refreshed);
			}
		}
		if (res.status === 401 || res.status === 403) {
			throw new GrokAuthError(`Grok login rejected (HTTP ${res.status}): ${LOGIN_HINT}`);
		}
		if (!res.ok) {
			const body = redactSecrets(await res.text().catch(() => "")).slice(0, 500);
			throw new GrokHttpError(`grok HTTP ${res.status}${body ? `: ${body}` : ""}`, res.status, body);
		}
		return parseResponsesText(await res.json());
	} finally {
		clearTimeout(timer);
		opts.signal?.removeEventListener("abort", onAbort);
	}
}

/** Tools the Grok CLI still registers under `--tools none`; disallowed by name so a headless call cannot start a tool loop. */
const CLI_DISALLOWED_TOOLS = "run_terminal_cmd,search_replace,write_file,read_file,list_dir,grep,web_search,web_fetch,todo_write,task,Agent";

let scratch: string | undefined;

/** Working directory for headless CLI calls, created once per process. */
function scratchDir(): string {
	if (!scratch) {
		scratch = join(tmpdir(), "aio-grok-scratch");
		mkdirSync(scratch, { recursive: true });
	}
	return scratch;
}

/** Extracts `.text` from `grok --output-format json` stdout; a non-`end_turn` stop (e.g. `cancelled`) is an error, not partial text. */
function parseCliJson(stdout: string): string {
	const trimmed = stdout.trim();
	if (!trimmed) throw new Error("grok returned no output");
	let parsed: unknown;
	try {
		parsed = JSON.parse(trimmed);
	} catch {
		const start = trimmed.lastIndexOf("\n{");
		if (start === -1) throw new Error("grok output is not JSON");
		parsed = JSON.parse(trimmed.slice(start + 1));
	}
	if (!parsed || typeof parsed !== "object") throw new Error("grok output is not an object");
	if ("stopReason" in parsed && parsed.stopReason !== undefined && parsed.stopReason !== "end_turn") {
		throw new Error(`grok cli stopped: ${String(parsed.stopReason)}`);
	}
	if (!("text" in parsed)) throw new Error("grok output is not an object");
	const text = parsed.text;
	if (typeof text !== "string" || !text.trim()) throw new Error("grok returned no text");
	return text;
}

async function completeCli(system: string, user: string, opts: GrokCompleteOptions, model: string, effort: GrokEffort): Promise<string> {
	const dir = mkdtempSync(join(tmpdir(), "aio-grok-"));
	const promptPath = join(dir, "prompt.md");
	writeFileSync(promptPath, user, "utf8");
	const env: Record<string, string | undefined> = { ...process.env, GROK_SUBAGENTS: "0", GROK_MEMORY: "0", GROK_WEB_FETCH: "0" };
	if (opts.home?.trim()) env.GROK_HOME = opts.home.trim();
	const proc = Bun.spawn(
		[
			opts.bin?.trim() || DEFAULT_GROK_CONFIG.bin,
			"-m",
			model,
			"--reasoning-effort",
			effort,
			"--output-format",
			"json",
			"--tools",
			"none",
			"--disallowed-tools",
			CLI_DISALLOWED_TOOLS,
			"--no-plan",
			"--no-subagents",
			"--disable-web-search",
			"--max-turns",
			"1",
			"--permission-mode",
			"plan",
			"--deny",
			"Bash",
			"--deny",
			"Edit",
			"--deny",
			"Write",
			"--verbatim",
			"--system-prompt-override",
			system,
			"--prompt-file",
			promptPath,
		],
		{ cwd: scratchDir(), env, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
	);

	const timeoutMs = opts.timeoutMs ?? DEFAULT_GROK_CONFIG.callTimeoutMs;
	let timedOut = false;
	let aborted = false;
	const timer = timeoutMs > 0
		? setTimeout(() => {
				timedOut = true;
				proc.kill();
			}, timeoutMs)
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
		if (timedOut) throw new Error(`grok timed out after ${timeoutMs}ms`);
		if (code !== 0 && !stdout.trim()) {
			const message = redactSecrets(stderr.trim()) || `grok exited ${code}`;
			if (/login|unauthori[sz]ed|401/i.test(message)) throw new GrokAuthError(`Grok login rejected: ${LOGIN_HINT}`);
			throw new Error(message);
		}
		return parseCliJson(stdout);
	} finally {
		clearTimeout(timer);
		opts.signal?.removeEventListener("abort", onAbort);
		rmSync(dir, { recursive: true, force: true });
	}
}

export async function grokComplete(system: string, user: string, opts: GrokCompleteOptions = {}): Promise<string> {
	if (opts.signal?.aborted) throw abortError();
	const model = opts.model?.trim() || DEFAULT_GROK_CONFIG.model;
	const effort = opts.reasoningEffort ?? DEFAULT_GROK_CONFIG.reasoningEffort;
	return opts.transport === "cli"
		? completeCli(system, user, opts, model, effort)
		: completeHttp(system, user, opts, model, effort);
}

export function createGrokCompleter(opts: Omit<GrokCompleteOptions, "signal">): Completer {
	return (system, user, signal) => grokComplete(system, user, { ...opts, signal });
}

export function isGrokAuthError(error: unknown): boolean {
	if (error instanceof GrokAuthError) return true;
	return typeof error === "object" && error !== null && "name" in error && error.name === "GrokAuthError";
}
