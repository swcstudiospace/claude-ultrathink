/**
 * Writes deterministic bench fixtures into bench/fixtures/. Usage: bun bench/record.ts
 * Idempotent: unchanged files are not rewritten, and stale tool-result files are removed.
 * The read-src-index fixture embeds src/index.ts as it exists when this runs.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const BENCH_DIR = fileURLToPath(new URL(".", import.meta.url));
const PLUGIN_ROOT = resolve(BENCH_DIR, "..");
const FIXTURE_DIR = join(BENCH_DIR, "fixtures");
const TOOL_RESULT_DIR = join(FIXTURE_DIR, "tool-results");
const QUESTIONS_FILE = join(FIXTURE_DIR, "graph-questions.json");

const BASH_LOG_ROWS = 480;
const MIN_BASH_LOG_CHARS = 12_000;
const MIN_SOURCE_CHARS = 4_000;
// The hook dedupes only results longer than 200 chars, so the repeated pair must exceed that.
const MIN_REPEAT_CHARS = 201;
const MIN_QUESTIONS = 8;

interface TextBlock {
	type: "text";
	text: string;
}

interface ToolResultFixture {
	toolName: string;
	input: Record<string, unknown>;
	isError: boolean;
	content: TextBlock[];
}

// 12 distinct lines. Stepping by 7 (coprime with 12) cycles through them evenly, so rows repeat.
const BASH_LINES: readonly string[] = [
	"src/ledger.test.ts:",
	"(pass) ledger > loads an empty session [0.42ms]",
	"(pass) ledger > records provider usage once [0.31ms]",
	"[graphify] query cache hit",
	"[graphify] query cache hit",
	"  warning: slow snapshot write (12.4ms)",
	"(pass) skim > keeps signatures [0.11ms]",
	"(pass) skim > keeps signatures [0.11ms]",
	"",
	"(pass) compress > drops repeated lines [0.08ms]",
	"(pass) compress > drops repeated lines [0.08ms]",
	"  12 assertions passed",
];

const REPEAT_LINES: readonly string[] = [
	"src/index.ts:17:const EVENT = \"token-opt:savings\";",
	"src/index.ts:18:const RTK_TIMEOUT_MS = 2_000;",
	"src/index.ts:19:const DEDUPE_MIN_CHARS = 200;",
	"src/index.ts:22:export const PREFIX_POLICY = { injectSystemPrompt: false as const };",
	"src/index.ts:97:function sessionIdFrom(event: unknown, ctx: unknown): string {",
	"src/index.ts:333:export default function tokenOpt(pi: PiLike): void {",
];

// Each question must resolve to a graphify match against a graph built from src/.
const QUESTIONS: readonly string[] = [
	"What does estimateTokens do?",
	"How does readFlags choose flags?",
	"Which function runs graphify?",
	"How does the ledger persist session state?",
	"What does shrinkToolText remove from tool output?",
	"How is a long read skimmed before shrink?",
	"What is the dedupe minimum for tool results?",
	"How does read_span return archived skim lines?",
	"What does rewriteWithRtk do with bash commands?",
	"How is the graph_query tool registered?",
];

function text(value: string): TextBlock[] {
	return [{ type: "text", text: value }];
}

function bashLog(offset: number): string {
	const lines = ["$ bun test src", "bun test v1.4.0", ""];
	for (let i = 0; i < BASH_LOG_ROWS; i++) {
		const line = BASH_LINES[((i + offset) * 7) % BASH_LINES.length];
		if (line === undefined) throw new Error("bash line table is empty");
		lines.push(line);
	}
	const log = lines.join("\n");
	if (log.length < MIN_BASH_LOG_CHARS) throw new Error(`bash log is ${log.length} chars; need ${MIN_BASH_LOG_CHARS}`);
	return log;
}

function buildFixtures(): Record<string, ToolResultFixture> {
	const indexSource = readFileSync(join(PLUGIN_ROOT, "src", "index.ts"), "utf8");
	if (indexSource.length < MIN_SOURCE_CHARS) throw new Error(`src/index.ts is ${indexSource.length} chars; need ${MIN_SOURCE_CHARS}`);
	const repeat = REPEAT_LINES.join("\n");
	if (repeat.length < MIN_REPEAT_CHARS) throw new Error(`repeat fixture is ${repeat.length} chars; need ${MIN_REPEAT_CHARS}`);
	const repeated: ToolResultFixture = {
		toolName: "grep",
		input: { pattern: "DEDUPE_MIN_CHARS|const|function", path: "src" },
		isError: false,
		content: text(repeat),
	};
	return {
		"bash-long-log": { toolName: "bash", input: { command: "bun test src" }, isError: false, content: text(bashLog(0)) },
		"bash-long-log-b": { toolName: "bash", input: { command: "bun build src" }, isError: false, content: text(bashLog(5)) },
		"empty-grep": {
			toolName: "grep",
			input: { pattern: "zz_no_such_symbol", path: "src" },
			isError: false,
			content: text("No matches found"),
		},
		"read-src-index": { toolName: "read", input: { path: "src/index.ts" }, isError: false, content: text(indexSource) },
		"repeat-first": repeated,
		"repeat-second": repeated,
	};
}

function writeIfChanged(path: string, value: unknown): void {
	const body = `${JSON.stringify(value, null, 2)}\n`;
	if (existsSync(path) && readFileSync(path, "utf8") === body) return;
	writeFileSync(path, body);
}

function main(): void {
	mkdirSync(TOOL_RESULT_DIR, { recursive: true });
	const fixtures = buildFixtures();
	const wanted = new Set(Object.keys(fixtures).map((name) => `${name}.json`));
	for (const file of readdirSync(TOOL_RESULT_DIR)) {
		if (file.endsWith(".json") && !wanted.has(file)) rmSync(join(TOOL_RESULT_DIR, file));
	}
	for (const [name, fixture] of Object.entries(fixtures)) writeIfChanged(join(TOOL_RESULT_DIR, `${name}.json`), fixture);
	if (QUESTIONS.length < MIN_QUESTIONS) throw new Error(`need at least ${MIN_QUESTIONS} graph questions`);
	writeIfChanged(QUESTIONS_FILE, { questions: [...QUESTIONS] });
	console.log(`wrote ${Object.keys(fixtures).length} tool-result fixtures and graph-questions.json (${QUESTIONS.length} questions)`);
}

main();
