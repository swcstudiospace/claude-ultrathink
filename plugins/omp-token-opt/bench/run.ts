/**
 * Measures token-opt against the bench fixtures.
 * Usage: bun bench/run.ts [--flags none|all|name[,name...]] [--out <path>]
 * Token and cost fields are deterministic. Latency fields are measured and vary by machine.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type tokenOptModule from "../src/index.ts";
import { estimateTokens } from "../src/estimate.ts";
import { FLAG_ENV, FLAG_NAMES, type FlagName, readFlags } from "../src/flags.ts";
import { setGraphifyBinForTests } from "../src/graph.ts";
import { bpeCount } from "./bpe.ts";

type TokenOpt = typeof tokenOptModule;

const BENCH_DIR = fileURLToPath(new URL(".", import.meta.url));
const PLUGIN_ROOT = resolve(BENCH_DIR, "..");
const SRC_DIR = join(PLUGIN_ROOT, "src");
const FIXTURE_DIR = join(BENCH_DIR, "fixtures");
const TOOL_RESULT_DIR = join(FIXTURE_DIR, "tool-results");
const QUESTIONS_FILE = join(FIXTURE_DIR, "graph-questions.json");
const PRICES_FILE = join(BENCH_DIR, "prices.json");

const HOOK_WARMUP = 20;
const HOOK_SAMPLES = 200;
const GRAPH_ROUNDS = 5;
const GRAPH_FAILURE = /^graphify(: command not found| timed out| failed)/;

interface TextBlock {
	type: string;
	text?: string;
}

/** On-disk shape written by bench/record.ts. Asserted at the JSON boundary, then checked field by field. */
interface FixtureFile {
	toolName: string;
	input: Record<string, unknown>;
	isError?: boolean;
	content: TextBlock[];
}

interface QuestionsFile {
	questions: string[];
}

interface PriceFile {
	estimated: boolean;
	inputUsdPerMillionTokens: number;
}

interface ToolResultFixture {
	name: string;
	toolName: string;
	input: Record<string, unknown>;
	isError: boolean;
	content: TextBlock[];
}

interface ToolOutput {
	content: TextBlock[];
	isError?: boolean;
}

type Handler = (event: unknown) => unknown;
type ToolExecute = (
	id: string,
	params: Record<string, unknown>,
	signal: undefined,
	onUpdate: undefined,
	ctx: { cwd: string },
) => Promise<ToolOutput>;

interface RegisteredTool {
	name: string;
	execute: ToolExecute;
}

interface Hooks {
	toolCall: Handler;
	toolResult: Handler;
	messageEnd: Handler;
	graphQuery: ToolExecute;
}

interface Summary {
	p50: number;
	p95: number;
}

interface Args {
	flags: string;
	out: string | null;
}

function parseArgs(argv: readonly string[]): Args {
	const usage = "usage: bun bench/run.ts [--flags none|all|name[,name...]] [--out <path>]";
	const args: Args = { flags: "none", out: null };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] ?? "";
		const eq = arg.indexOf("=");
		const key = eq === -1 ? arg : arg.slice(0, eq);
		let value: string | undefined = eq === -1 ? undefined : arg.slice(eq + 1);
		if (value === undefined && (key === "--flags" || key === "--out")) {
			value = argv[i + 1];
			i++;
		}
		if (key === "--flags") {
			if (value === undefined) throw new Error(`--flags needs a value\n${usage}`);
			args.flags = value;
		} else if (key === "--out") {
			if (value === undefined || value.length === 0) throw new Error(`--out needs a path\n${usage}`);
			args.out = resolve(value);
		} else {
			throw new Error(`unknown argument: ${arg}\n${usage}`);
		}
	}
	return args;
}

function parseFlags(spec: string): Set<FlagName> {
	const tokens = spec
		.split(",")
		.map((token) => token.trim())
		.filter((token) => token.length > 0);
	if (tokens.length === 0 || tokens.includes("none")) {
		if (tokens.some((token) => token !== "none")) throw new Error("'none' cannot be combined with flag names");
		return new Set<FlagName>();
	}
	if (tokens.includes("all")) return new Set<FlagName>(FLAG_NAMES);
	const enabled = new Set<FlagName>();
	for (const token of tokens) {
		const name = FLAG_NAMES.find((candidate) => candidate === token);
		if (name === undefined) throw new Error(`unknown flag: ${token}. Known: ${FLAG_NAMES.join(", ")}`);
		enabled.add(name);
	}
	return enabled;
}

/** Sets every flag env var explicitly so the caller's shell cannot leak flags into the run. */
function applyFlags(enabled: ReadonlySet<FlagName>): void {
	for (const name of FLAG_NAMES) process.env[FLAG_ENV[name]] = enabled.has(name) ? "1" : "0";
}

function parseFixture(name: string, raw: FixtureFile): ToolResultFixture {
	if (typeof raw.toolName !== "string" || typeof raw.input !== "object" || raw.input === null || !Array.isArray(raw.content)) {
		throw new Error(`invalid tool-result fixture: ${name}`);
	}
	const content = raw.content.map((block): TextBlock => {
		if (block.type !== "text" || typeof block.text !== "string") throw new Error(`invalid content block in ${name}`);
		return { type: "text", text: block.text };
	});
	return { name, toolName: raw.toolName, input: raw.input, isError: raw.isError === true, content };
}

function loadToolResults(): ToolResultFixture[] {
	if (!existsSync(TOOL_RESULT_DIR)) throw new Error(`missing ${TOOL_RESULT_DIR}; run: bun bench/record.ts`);
	const files = readdirSync(TOOL_RESULT_DIR)
		.filter((file) => file.endsWith(".json"))
		.sort();
	if (files.length === 0) throw new Error(`no tool-result fixtures in ${TOOL_RESULT_DIR}; run: bun bench/record.ts`);
	return files.map((file) =>
		parseFixture(`tool-results/${file}`, JSON.parse(readFileSync(join(TOOL_RESULT_DIR, file), "utf8")) as FixtureFile),
	);
}

function loadQuestions(): string[] {
	if (!existsSync(QUESTIONS_FILE)) throw new Error(`missing ${QUESTIONS_FILE}; run: bun bench/record.ts`);
	const raw = JSON.parse(readFileSync(QUESTIONS_FILE, "utf8")) as QuestionsFile;
	if (!Array.isArray(raw.questions) || raw.questions.length === 0) throw new Error("graph-questions.json needs a non-empty questions array");
	for (const question of raw.questions) {
		if (typeof question !== "string" || question.trim().length === 0) throw new Error("graph questions must be non-empty strings");
	}
	return raw.questions;
}

function loadPrice(): number {
	const raw = JSON.parse(readFileSync(PRICES_FILE, "utf8")) as PriceFile;
	if (raw.estimated !== true || !Number.isFinite(raw.inputUsdPerMillionTokens) || raw.inputUsdPerMillionTokens < 0) {
		throw new Error("prices.json needs estimated: true and a finite inputUsdPerMillionTokens >= 0");
	}
	return raw.inputUsdPerMillionTokens;
}

/** Copies src/ into a temp root and builds its graph with the real graphify binary. Returns the query cwd. */
async function buildGraph(root: string): Promise<string> {
	const bin = Bun.which("graphify");
	if (bin === null) throw new Error("graphify is not on PATH; graph query latency needs the real binary");
	const cwd = join(root, "src");
	cpSync(SRC_DIR, cwd, { recursive: true });
	const proc = Bun.spawn([bin, "update", cwd], { cwd: root, stdin: "ignore", stdout: "ignore", stderr: "pipe" });
	const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
	if (code !== 0) throw new Error(`graphify update exited ${code}: ${stderr.slice(-500)}`);
	const graphFile = join(cwd, "graphify-out", "graph.json");
	if (!existsSync(graphFile)) throw new Error(`graphify update did not write ${graphFile}`);
	return cwd;
}

function required<T>(registry: Map<string, T>, key: string): T {
	const value = registry.get(key);
	if (value === undefined) throw new Error(`extension did not register ${key}`);
	return value;
}

/** Fresh extension instance against a mock pi, same shape as src/index.test.ts. */
function instantiate(tokenOpt: TokenOpt): Hooks {
	const handlers = new Map<string, Handler>();
	const tools = new Map<string, RegisteredTool>();
	const pi = {
		setLabel() {},
		zod: {
			object: () => ({}),
			string: () => ({}),
			number: () => ({}),
		},
		registerTool(tool: RegisteredTool) {
			tools.set(tool.name, tool);
		},
		registerCommand() {},
		on(event: string, handler: Handler) {
			handlers.set(event, handler);
		},
		events: { emit() {} },
	};
	tokenOpt(pi as unknown as Parameters<TokenOpt>[0]);
	handlers.get("session_start")?.({ sessionId: "bench-session" }, { cwd: process.cwd() });
	return {
		toolCall: required(handlers, "tool_call"),
		toolResult: required(handlers, "tool_result"),
		messageEnd: required(handlers, "message_end"),
		graphQuery: required(tools, "graph_query").execute,
	};
}

function textOf(blocks: readonly TextBlock[]): string {
	return blocks
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text ?? "")
		.join("\n");
}

/** Text of a hook's returned content, or the fallback when the hook left the result unchanged. */
function outputText(out: unknown, fallback: string): string {
	if (typeof out !== "object" || out === null || !("content" in out) || !Array.isArray(out.content)) return fallback;
	return textOf(out.content);
}

function pick<T>(items: readonly T[], index: number): T {
	const item = items[index % items.length];
	if (item === undefined) throw new Error("no fixtures to sample");
	return item;
}

async function measureTokens(
	hooks: Hooks,
	fixtures: readonly ToolResultFixture[],
	cwd: string,
): Promise<{ baseline: number; current: number; bpeBaseline: number; bpeCurrent: number }> {
	let baseline = 0;
	let current = 0;
	let bpeBaseline = 0;
	let bpeCurrent = 0;
	for (const fixture of fixtures) {
		const before = textOf(fixture.content);
		await hooks.toolCall({ toolName: fixture.toolName, input: structuredClone(fixture.input), cwd });
		const after = outputText(
			hooks.toolResult({
				toolName: fixture.toolName,
				input: structuredClone(fixture.input),
				isError: fixture.isError,
				content: structuredClone(fixture.content),
			}),
			before,
		);
		baseline += estimateTokens(before);
		current += estimateTokens(after);
		bpeBaseline += bpeCount(before);
		bpeCurrent += bpeCount(after);
		hooks.messageEnd({
			message: {
				role: "assistant",
				id: `bench-${fixture.name}`,
				usage: { input: estimateTokens(before), output: 0, cacheRead: 0, cacheWrite: 0 },
			},
		});
	}
	return { baseline, current, bpeBaseline, bpeCurrent };
}

/** Each sample uses a fresh extension instance, so dedupe state is cold. Event setup is outside the timed call. */
function measureToolResult(tokenOpt: TokenOpt, fixtures: readonly ToolResultFixture[]): number[] {
	const samples: number[] = [];
	for (let i = 0; i < HOOK_WARMUP + HOOK_SAMPLES; i++) {
		const fixture = pick(fixtures, i);
		const hooks = instantiate(tokenOpt);
		const event = {
			toolName: fixture.toolName,
			input: structuredClone(fixture.input),
			isError: fixture.isError,
			content: structuredClone(fixture.content),
		};
		const started = performance.now();
		hooks.toolResult(event);
		const elapsed = performance.now() - started;
		if (i >= HOOK_WARMUP) samples.push(elapsed);
	}
	return samples;
}

function measureMessageEnd(tokenOpt: TokenOpt, fixtures: readonly ToolResultFixture[]): number[] {
	const samples: number[] = [];
	for (let i = 0; i < HOOK_WARMUP + HOOK_SAMPLES; i++) {
		const fixture = pick(fixtures, i);
		const hooks = instantiate(tokenOpt);
		const event = {
			message: {
				role: "assistant",
				id: `bench-latency-${i}`,
				usage: { input: estimateTokens(textOf(fixture.content)), output: 0, cacheRead: 0, cacheWrite: 0 },
			},
		};
		const started = performance.now();
		hooks.messageEnd(event);
		const elapsed = performance.now() - started;
		if (i >= HOOK_WARMUP) samples.push(elapsed);
	}
	return samples;
}

async function measureGraphQuery(hooks: Hooks, questions: readonly string[], cwd: string): Promise<{ samples: number[]; outputTokens: number }> {
	const samples: number[] = [];
	let outputTokens = 0;
	for (let round = 0; round < GRAPH_ROUNDS; round++) {
		for (const question of questions) {
			// Clears graph.ts's query cache so every sample spawns the real graphify binary.
			setGraphifyBinForTests(undefined);
			const started = performance.now();
			const result = await hooks.graphQuery("bench", { question }, undefined, undefined, { cwd });
			const elapsed = performance.now() - started;
			const text = result.content[0]?.text ?? "";
			if (round === 0) outputTokens += estimateTokens(text);
			if (result.isError === true || GRAPH_FAILURE.test(text)) {
				throw new Error(`graph_query failed for "${question}": ${text.slice(0, 200)}`);
			}
			samples.push(elapsed);
		}
	}
	return { samples, outputTokens };
}

function percentile(sorted: readonly number[], p: number): number {
	const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
	const value = sorted[rank - 1];
	if (value === undefined) throw new Error("no latency samples");
	return value;
}

function summarize(samples: readonly number[]): Summary {
	const sorted = [...samples].sort((a, b) => a - b);
	const p50 = percentile(sorted, 50);
	const p95 = percentile(sorted, 95);
	return { p50: Math.round(p50 * 1000) / 1000, p95: Math.round(p95 * 1000) / 1000 };
}

async function run(args: Args): Promise<string> {
	const enabled = parseFlags(args.flags);
	const questions = loadQuestions();
	const fixtures = loadToolResults();
	const usdPerMillion = loadPrice();
	const home = mkdtempSync(join(tmpdir(), "token-opt-bench-home-"));
	const graphRoot = mkdtempSync(join(tmpdir(), "token-opt-bench-graph-"));
	try {
		applyFlags(enabled);
		// Isolates ledger writes and rtk detection (both read HOME) from the real home directory.
		process.env.HOME = home;
		// Dynamic on purpose: the flag env vars must be set before the extension loads, and a static
		// import would evaluate src/index.ts before applyFlags runs.
		const { default: tokenOpt } = await import("../src/index.ts");
		const flags = readFlags(process.env);
		const graphCwd = await buildGraph(graphRoot);

		const totals = await measureTokens(instantiate(tokenOpt), fixtures, graphCwd);
		const toolResultSamples = measureToolResult(tokenOpt, fixtures);
		const messageEndSamples = measureMessageEnd(tokenOpt, fixtures);
		const graph = await measureGraphQuery(instantiate(tokenOpt), questions, graphCwd);

		const report = {
			flags,
			graph: { outputTokens: graph.outputTokens },
			fixtures: ["graph-questions.json", ...fixtures.map((fixture) => fixture.name)],
			tokens: {
				baseline: totals.baseline,
				current: totals.current,
				saved: totals.baseline - totals.current,
			},
			// BPE counts (gpt-tokenizer cl100k family, not provider billing)
			tokensBpe: {
				baseline: totals.bpeBaseline,
				current: totals.bpeCurrent,
				saved: totals.bpeBaseline - totals.bpeCurrent,
			},
			latencyMs: {
				toolResult: summarize(toolResultSamples),
				messageEnd: summarize(messageEndSamples),
				graphQuery: summarize(graph.samples),
			},
			costUsd: {
				baseline: Number(((totals.baseline * usdPerMillion) / 1_000_000).toFixed(8)),
				current: Number(((totals.current * usdPerMillion) / 1_000_000).toFixed(8)),
				estimated: true as const,
			},
		};
		const text = `${JSON.stringify(report, null, 2)}\n`;
		if (args.out !== null) {
			mkdirSync(dirname(args.out), { recursive: true });
			writeFileSync(args.out, text);
		}
		return text;
	} finally {
		rmSync(home, { recursive: true, force: true });
		rmSync(graphRoot, { recursive: true, force: true });
	}
}

Promise.resolve()
	.then(() => run(parseArgs(process.argv.slice(2))))
	.then((text) => {
		process.stdout.write(text);
	})
	.catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
