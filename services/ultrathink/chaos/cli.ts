// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { appendHistory, readHistory } from "./history.ts";
import { createInProcessTarget } from "./inprocess.ts";
import { type ChaosTarget, type HttpFetch, httpTarget } from "./observe.ts";
import { type RunResult, runTemplate } from "./run.ts";
import { type ExperimentTemplate, loadTemplates } from "./schema.ts";
import { resilience } from "./score.ts";

/**
 * Exit codes: 0 every hypothesis passed; 1 at least one hypothesis failed (the run completed and was recorded); 2 the
 * run did not happen (usage error, refused gate, operator step not confirmed, or an error before the run finished).
 */
export interface CliDeps {
	stdout: (text: string) => void;
	stderr: (text: string) => void;
	env: Record<string, string | undefined>;
	/** Used only by the http driver. */
	fetch: HttpFetch;
	/** Runs the rollback argv. The argv is never passed through a shell. */
	exec: (argv: string[]) => Promise<number>;
	/** Resolves only when a human confirms the operator step that was just printed. Rejection stops the run. */
	confirm: (step: string) => Promise<void>;
	now: () => Date;
	sleep: (ms: number) => Promise<void>;
	templatesDir: string;
	historyPath: string;
}

const USAGE = [
	"usage: chaos templates",
	"       chaos run <id> --driver inprocess|http [--base-url URL] [--history PATH] [--rollback-argv JSON]",
	"       chaos score <id> [--history PATH]",
].join("\n");

const RUN_FLAGS = ["--driver", "--base-url", "--history", "--rollback-argv"] as const;
const SCORE_FLAGS = ["--history"] as const;

class UsageError extends Error {}

export async function runCli(argv: string[], deps: CliDeps): Promise<number> {
	const [command, ...rest] = argv;
	try {
		if (command === "templates") return listTemplates(rest, deps);
		if (command === "run") return await runCommand(rest, deps);
		if (command === "score") return scoreCommand(rest, deps);
		throw new UsageError(command === undefined ? "missing command" : `unknown command ${command}`);
	} catch (error) {
		if (error instanceof UsageError) {
			deps.stderr(`${error.message}\n${USAGE}\n`);
			return 2;
		}
		deps.stderr(`chaos: ${error instanceof Error ? error.message : String(error)}\n`);
		return 2;
	}
}

function listTemplates(args: string[], deps: CliDeps): number {
	if (args.length > 0) throw new UsageError("templates takes no arguments");
	for (const template of loadTemplates(deps.templatesDir)) {
		deps.stdout(`${template.id}\t${template.failureMode}\t${template.kind}\t${template.hypotheses.length}\n`);
	}
	return 0;
}

async function runCommand(args: string[], deps: CliDeps): Promise<number> {
	const { positional, flags } = parseArgs(args, RUN_FLAGS);
	const [id, ...extra] = positional;
	if (id === undefined || extra.length > 0) throw new UsageError("run needs exactly one template id");

	const driver = flags.get("--driver");
	if (driver !== "inprocess" && driver !== "http") throw new UsageError("--driver must be inprocess or http");
	const rollbackArgv = parseRollbackArgv(flags.get("--rollback-argv"));
	const staging = deps.env.ULTRATHINK_CHAOS_ENV === "staging";
	const baseUrl = flags.get("--base-url");
	// The production-safety gate comes first: a non-loopback target is refused before any template is looked at.
	if (driver === "http") {
		if (baseUrl === undefined) throw new UsageError("--driver http needs --base-url");
		const host = hostOf(baseUrl);
		if (!isLoopback(host) && !staging) {
			throw new UsageError(`refusing to run against ${host}: a non-loopback host needs ULTRATHINK_CHAOS_ENV=staging; no request was sent`);
		}
	}
	const template = findTemplate(id, deps);
	if (template.kind === "inprocess" && driver !== "inprocess") {
		throw new UsageError(`${id} injects its faults in process; run it with --driver inprocess`);
	}
	if (template.kind === "operator" && driver !== "http") {
		throw new UsageError(`${id} needs a human step and observes a running unit; run it with --driver http --base-url URL`);
	}

	const result = await execute({ template, driver, baseUrl, staging, rollbackArgv, deps });
	const historyPath = flags.get("--history") ?? deps.historyPath;
	const record = appendHistory(historyPath, result);
	printRun(result, deps);
	deps.stdout(`recorded seq ${record.seq} in ${historyPath}\n`);
	return result.passed ? 0 : 1;
}

interface ExecuteOptions {
	template: ExperimentTemplate;
	driver: "inprocess" | "http";
	baseUrl: string | undefined;
	staging: boolean;
	rollbackArgv: string[] | undefined;
	deps: CliDeps;
}

async function execute(options: ExecuteOptions): Promise<RunResult> {
	const { template, driver, baseUrl, staging, rollbackArgv, deps } = options;
	const common = {
		template,
		sleep: deps.sleep,
		staging,
		rollbackArgv,
		exec: deps.exec,
		now: deps.now,
		...(template.kind === "operator" ? { confirm: (step: string) => confirmOperatorStep(step, deps) } : {}),
	};

	if (driver === "inprocess") {
		const stateDir = mkdtempSync(join(tmpdir(), "chaos-run-"));
		const { target, close } = await createInProcessTarget({ template, stateDir, now: deps.now });
		try {
			return await runTemplate({ ...common, target, driver: "inprocess" });
		} finally {
			await close();
			rmSync(stateDir, { recursive: true, force: true });
		}
	}
	const target: ChaosTarget = httpTarget(baseUrl ?? "", deps.fetch);
	try {
		return await runTemplate({ ...common, target, driver: "http" });
	} finally {
		await target.close();
	}
}

// The operator driver prints the step and waits for a human. It never runs the step itself.
async function confirmOperatorStep(step: string, deps: CliDeps): Promise<void> {
	deps.stdout(`Operator step, to be performed by hand (the runner does not execute it):\n${step}\n`);
	await deps.confirm(step);
}

function scoreCommand(args: string[], deps: CliDeps): number {
	const { positional, flags } = parseArgs(args, SCORE_FLAGS);
	const [id, ...extra] = positional;
	if (id === undefined || extra.length > 0) throw new UsageError("score needs exactly one template id");

	const { records, skipped } = readHistory(flags.get("--history") ?? deps.historyPath);
	if (skipped > 0) deps.stderr(`skipped ${skipped} unreadable history line(s)\n`);
	const summary = resilience(records, id);
	if (summary.runs === 0) {
		deps.stdout(`${id}: no runs recorded\n`);
		return 0;
	}
	deps.stdout(`${id}: runs ${summary.runs}\n`);
	deps.stdout(`mean ${formatNumber(summary.mean ?? 0)}\n`);
	if (summary.trend === undefined) deps.stdout("trend: needs at least 2 runs\n");
	else deps.stdout(`trend slope ${formatNumber(summary.trend.slope)}\n`);
	deps.stdout(`latest ${formatNumber(summary.trend?.latest ?? summary.mean ?? 0)}\n`);
	return 0;
}

function printRun(result: RunResult, deps: CliDeps): void {
	const verdict = result.passed ? "PASSED" : "FAILED";
	const exit = result.rollbackExitCode === undefined ? "" : ` (exit ${result.rollbackExitCode})`;
	deps.stdout(
		`${result.templateId} via ${result.driver}: ${verdict}, score ${formatNumber(result.score)}, settled ${String(result.settled)}, rollback ${result.rollback}${exit}\n`,
	);
	for (const hypothesis of result.hypotheses) {
		if (hypothesis.passed) {
			deps.stdout(`  pass ${hypothesis.id}\n`);
		} else {
			const observed = hypothesis.observed === undefined ? "none" : String(hypothesis.observed);
			deps.stdout(`  fail ${hypothesis.id} (${hypothesis.reason ?? "not met"}; observed ${observed})\n`);
		}
	}
}

function parseArgs(
	args: string[],
	allowed: readonly string[],
): { positional: string[]; flags: Map<string, string> } {
	const positional: string[] = [];
	const flags = new Map<string, string>();
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i] ?? "";
		if (!arg.startsWith("--")) {
			positional.push(arg);
			continue;
		}
		const equals = arg.indexOf("=");
		const name = equals === -1 ? arg : arg.slice(0, equals);
		if (!allowed.includes(name)) throw new UsageError(`unknown option ${name}`);
		const value = equals === -1 ? args[i + 1] : arg.slice(equals + 1);
		if (equals === -1) i += 1;
		if (value === undefined || value === "" || value.startsWith("--")) throw new UsageError(`${name} needs a value`);
		if (flags.has(name)) throw new UsageError(`${name} is given twice`);
		flags.set(name, value);
	}
	return { positional, flags };
}

function parseRollbackArgv(raw: string | undefined): string[] | undefined {
	if (raw === undefined) return undefined;
	const invalid = "--rollback-argv must be a JSON array of non-empty strings";
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new UsageError(invalid);
	}
	if (!Array.isArray(parsed) || parsed.length === 0) throw new UsageError(invalid);
	const items: unknown[] = parsed;
	const argv: string[] = [];
	for (const item of items) {
		if (typeof item !== "string" || item === "") throw new UsageError(invalid);
		argv.push(item);
	}
	return argv;
}

function findTemplate(id: string, deps: CliDeps): ExperimentTemplate {
	const template = loadTemplates(deps.templatesDir).find((candidate) => candidate.id === id);
	if (template === undefined) throw new UsageError(`no template ${id}`);
	return template;
}

function hostOf(baseUrl: string): string {
	try {
		return new URL(baseUrl).hostname;
	} catch {
		throw new UsageError("--base-url is not a URL");
	}
}

function isLoopback(hostname: string): boolean {
	return hostname === "localhost" || hostname === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(hostname);
}

function formatNumber(value: number): string {
	return String(Math.round(value * 10_000) / 10_000);
}

// Real dependencies. The state directory matches the service default when ULTRATHINK_STATE_DIR is unset.
const DEFAULT_STATE_DIR = "/var/lib/ultrathink";

function realDeps(): CliDeps {
	const env = process.env;
	return {
		stdout: (text) => {
			process.stdout.write(text);
		},
		stderr: (text) => {
			process.stderr.write(text);
		},
		env,
		fetch: (url, init) => fetch(url, init),
		exec: async (argv) => {
			const child = Bun.spawn(argv, { stdin: "ignore", stdout: "inherit", stderr: "inherit" });
			return child.exited;
		},
		confirm: promptForConfirmation,
		now: () => new Date(),
		sleep: (ms) => {
			const { promise, resolve } = Promise.withResolvers<void>();
			setTimeout(resolve, ms);
			return promise;
		},
		templatesDir: join(dirname(fileURLToPath(import.meta.url)), "experiments"),
		historyPath: join(env.ULTRATHINK_STATE_DIR ?? DEFAULT_STATE_DIR, "chaos", "history.jsonl"),
	};
}

// Accepts only the exact word `confirmed` on standard input. End of input before an answer is a refusal, never a yes.
function promptForConfirmation(): Promise<void> {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	const lines = createInterface({ input: process.stdin });
	let answered = false;
	lines.once("line", (line) => {
		answered = true;
		lines.close();
		if (line.trim() === "confirmed") resolve();
		else reject(new Error("operator step not confirmed; no load was sent"));
	});
	lines.once("close", () => {
		if (!answered) reject(new Error("operator step not confirmed: input ended; no load was sent"));
	});
	process.stdout.write("Type 'confirmed' once the step is done: ");
	return promise;
}

if (import.meta.main) {
	const code = await runCli(process.argv.slice(2), realDeps());
	process.exit(code);
}
