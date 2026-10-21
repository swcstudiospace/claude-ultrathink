/**
 * Offline flags-off replay of the bench tool-result fixtures, and the recorder for its goldens.
 * Usage: bun bench/record-flags-off.ts
 *
 * The replay follows bench/run.ts measureTokens. For each fixture in sorted order it calls tool_call, then
 * tool_result, then message_end, all on one extension instance, so dedupe state carries across fixtures as it
 * does in run.ts. It makes no model, network, or graphify calls. The only external binary the plugin can reach
 * here is rtk, so the replay runs in a child process started with PATH set to an empty directory, and rtk is absent on every
 * machine (Bun.which reads PATH once at process start, so changing PATH in-process would not hide it). HOME is a temp directory,
 * so ledger writes never reach the real home directory.
 *
 * Not replayed: the graph_query path (bench/run.ts measureGraphQuery). Its output depends on the contents of src/
 * at run time and on the graphify binary, so it cannot be a stable committed golden.
 *
 * Output normalisation: session_start emissions are dropped because they belong to no fixture. Time fields
 * (`at`, `updatedAt`) are removed from emitted events because they come from Date.now(). Everything else is kept.
 * Goldens are serialized with sorted keys and a trailing newline.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
// Static import is safe: src/index.ts reads flag env only inside its default export, never at module load.
import tokenOpt from "../src/index.ts";
import { estimateTokens } from "../src/estimate.ts";
import { FLAG_ENV, FLAG_NAMES } from "../src/flags.ts";

type PiLike = Parameters<typeof tokenOpt>[0];
type Handler = (event: unknown, ctx?: unknown) => unknown;

interface TextBlock {
	type: string;
	text?: string;
}

interface FixtureFile {
	toolName: string;
	input: Record<string, unknown>;
	isError?: boolean;
	content: TextBlock[];
}

interface EmittedEvent {
	event: string;
	payload: unknown;
}

interface Hooks {
	toolCall: Handler;
	toolResult: Handler;
	messageEnd: Handler;
}

/** One fixture's replay output. This object is the golden, serialized by serializeGolden. */
export interface FixtureReplay {
	fixture: string;
	tokens: { baseline: number; current: number };
	toolCall: unknown;
	toolResult: unknown;
	events: EmittedEvent[];
}

const BENCH_DIR = fileURLToPath(new URL(".", import.meta.url));
export const TOOL_RESULT_DIR = join(BENCH_DIR, "fixtures", "tool-results");
export const GOLDEN_DIR = join(BENCH_DIR, "fixtures", "flags-off");

const SESSION_ID = "bench-session";
const TIME_KEYS: Record<string, true> = { at: true, updatedAt: true };

/** Tool-result fixture file names, sorted as bench/run.ts loads them. */
export function listFixtureFiles(): string[] {
	if (!existsSync(TOOL_RESULT_DIR)) throw new Error(`missing ${TOOL_RESULT_DIR}; run: bun bench/record.ts`);
	const files = readdirSync(TOOL_RESULT_DIR)
		.filter((file) => file.endsWith(".json"))
		.sort();
	if (files.length === 0) throw new Error(`no tool-result fixtures in ${TOOL_RESULT_DIR}; run: bun bench/record.ts`);
	return files;
}

function loadFixture(file: string): FixtureFile {
	const raw = JSON.parse(readFileSync(join(TOOL_RESULT_DIR, file), "utf8")) as FixtureFile;
	if (typeof raw.toolName !== "string" || typeof raw.input !== "object" || raw.input === null || !Array.isArray(raw.content)) {
		throw new Error(`invalid tool-result fixture: ${file}`);
	}
	for (const block of raw.content) {
		if (block.type !== "text" || typeof block.text !== "string") throw new Error(`invalid content block in ${file}`);
	}
	return raw;
}

function textOf(blocks: readonly TextBlock[]): string {
	return blocks
		.filter((block) => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text ?? "")
		.join("\n");
}

/** Text of a hook's returned content, or the fallback when the hook left the result unchanged. Same as run.ts. */
function outputText(out: unknown, fallback: string): string {
	if (typeof out !== "object" || out === null || !("content" in out) || !Array.isArray(out.content)) return fallback;
	return textOf(out.content as TextBlock[]);
}

function required(handlers: Map<string, Handler>, event: string): Handler {
	const handler = handlers.get(event);
	if (handler === undefined) throw new Error(`extension did not register ${event}`);
	return handler;
}

function stripTime(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(stripTime);
	if (typeof value === "object" && value !== null) {
		const out: Record<string, unknown> = {};
		for (const [key, child] of Object.entries(value)) {
			if (TIME_KEYS[key] !== true) out[key] = stripTime(child);
		}
		return out;
	}
	return value;
}

/** Same mock pi shape as bench/run.ts instantiate. Emitted events are captured instead of dropped. */
function instantiate(emitted: EmittedEvent[], cwd: string): Hooks {
	const handlers = new Map<string, Handler>();
	const pi = {
		setLabel() {},
		zod: {
			object: () => ({}),
			string: () => ({}),
			number: () => ({}),
		},
		registerTool() {},
		registerCommand() {},
		on(event: string, handler: Handler) {
			handlers.set(event, handler);
		},
		events: {
			emit(event: string, payload: unknown) {
				emitted.push({ event, payload: stripTime(payload) });
			},
		},
	};
	tokenOpt(pi as unknown as PiLike);
	handlers.get("session_start")?.({ sessionId: SESSION_ID }, { cwd });
	return {
		toolCall: required(handlers, "tool_call"),
		toolResult: required(handlers, "tool_result"),
		messageEnd: required(handlers, "message_end"),
	};
}

const REPLAY_CHILD_ARG = "--replay-child";

/**
 * Environment for the replay child: a temp HOME, an empty PATH, every TOKEN_OPT_* and flag variable unset, then overrides.
 * Bun.which reads PATH once at process start, so the empty PATH only hides rtk from a process started with it.
 */
function hermeticEnv(home: string, emptyPath: string, overrides: Readonly<Record<string, string>>): Record<string, string> {
	const flagVars = new Set<string>(FLAG_NAMES.map((name) => FLAG_ENV[name]));
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) {
		if (value === undefined || key.startsWith("TOKEN_OPT_") || flagVars.has(key)) continue;
		env[key] = value;
	}
	return { ...env, HOME: home, PATH: emptyPath, ...overrides };
}

/**
 * Replays every tool-result fixture through the extension in a child process started with the hermetic env, so an
 * rtk on the parent's PATH is never found. overrides sets extra env on top of the flags-off base, which is how the
 * sensitivity of a golden to a flag is checked. Callers that record or test goldens pass none.
 */
export async function replayFixtures(overrides: Readonly<Record<string, string>> = {}): Promise<FixtureReplay[]> {
	const home = mkdtempSync(join(tmpdir(), "flags-off-home-"));
	const emptyPath = mkdtempSync(join(tmpdir(), "flags-off-path-"));
	try {
		const proc = Bun.spawn([process.execPath, fileURLToPath(import.meta.url), REPLAY_CHILD_ARG], {
			cwd: home,
			env: hermeticEnv(home, emptyPath, overrides),
			stdout: "pipe",
			stderr: "pipe",
		});
		const [out, err, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		if (code !== 0) throw new Error(`flags-off replay child exited ${code}: ${err}`);
		return JSON.parse(out) as FixtureReplay[];
	} finally {
		rmSync(home, { recursive: true, force: true });
		rmSync(emptyPath, { recursive: true, force: true });
	}
}

/** Runs in the replay child. HOME, PATH and flag env were set by replayFixtures before this process started. */
async function replayInProcess(): Promise<FixtureReplay[]> {
	const home = process.env.HOME;
	if (home === undefined || home === "") throw new Error("replay child needs HOME");
	const emitted: EmittedEvent[] = [];
	const hooks = instantiate(emitted, home);
	emitted.length = 0;
	const replays: FixtureReplay[] = [];
	for (const file of listFixtureFiles()) {
		const fixture = loadFixture(file);
		emitted.length = 0;
		const before = textOf(fixture.content);
		const toolCall = await hooks.toolCall({
			toolName: fixture.toolName,
			input: structuredClone(fixture.input),
			cwd: home,
		});
		const toolResult = hooks.toolResult({
			toolName: fixture.toolName,
			input: structuredClone(fixture.input),
			isError: fixture.isError === true,
			content: structuredClone(fixture.content),
		});
		hooks.messageEnd({
			message: {
				role: "assistant",
				id: `flags-off-${file}`,
				usage: { input: estimateTokens(before), output: 0, cacheRead: 0, cacheWrite: 0 },
			},
		});
		// Lets fire-and-forget work (rtk delta refresh) settle before this fixture's events are read.
		await Bun.sleep(0);
		replays.push({
			fixture: file,
			tokens: { baseline: estimateTokens(before), current: estimateTokens(outputText(toolResult, before)) },
			toolCall: toolCall ?? null,
			toolResult: toolResult ?? null,
			events: [...emitted],
		});
	}
	return replays;
}

/** Stable JSON: sorted keys, two-space indent, trailing newline. Equal replays give equal bytes. */
export function serializeGolden(replay: FixtureReplay): string {
	return `${JSON.stringify(sortKeys(replay), null, 2)}\n`;
}

function sortKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortKeys);
	if (typeof value === "object" && value !== null) {
		const source = value as Record<string, unknown>;
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(source).sort()) out[key] = sortKeys(source[key]);
		return out;
	}
	return value;
}

function writeGoldens(replays: readonly FixtureReplay[]): { written: number; unchanged: number; removed: number } {
	mkdirSync(GOLDEN_DIR, { recursive: true });
	const expected = new Set(replays.map((replay) => replay.fixture));
	let written = 0;
	let unchanged = 0;
	for (const replay of replays) {
		const path = join(GOLDEN_DIR, replay.fixture);
		const text = serializeGolden(replay);
		if (existsSync(path) && readFileSync(path, "utf8") === text) {
			unchanged++;
			continue;
		}
		writeFileSync(path, text);
		written++;
	}
	let removed = 0;
	for (const file of readdirSync(GOLDEN_DIR)) {
		if (file.endsWith(".json") && !expected.has(file)) {
			rmSync(join(GOLDEN_DIR, file));
			removed++;
		}
	}
	return { written, unchanged, removed };
}

async function main(): Promise<void> {
	const replays = await replayFixtures();
	const result = writeGoldens(replays);
	const baseline = replays.reduce((sum, replay) => sum + replay.tokens.baseline, 0);
	const current = replays.reduce((sum, replay) => sum + replay.tokens.current, 0);
	process.stdout.write(
		`flags-off replay: ${replays.length} fixtures, tokens baseline ${baseline} current ${current} saved ${baseline - current}\n` +
			`goldens in ${GOLDEN_DIR}: written ${result.written}, unchanged ${result.unchanged}, removed ${result.removed}\n`,
	);
}

if (import.meta.main && process.argv.includes(REPLAY_CHILD_ARG)) {
	replayInProcess()
		.then((replays) => process.stdout.write(JSON.stringify(replays)))
		.catch((error: unknown) => {
			console.error(error instanceof Error ? error.message : String(error));
			process.exitCode = 1;
		});
} else if (import.meta.main) {
	main().catch((error: unknown) => {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	});
}
