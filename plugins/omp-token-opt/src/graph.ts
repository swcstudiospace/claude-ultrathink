import { existsSync } from "node:fs";
import { join } from "node:path";

const TIMEOUT_MS = 20_000;
const CAP = 8000;
const CACHE_LIMIT = 32;
const CACHED_COMMANDS: Record<string, true> = { query: true, path: true, explain: true };

export interface GraphifyResult {
	text: string;
	exitCode: number;
	cached: boolean;
	ms: number;
}

let resolvedBin: string | null = null;
let binFound = false;
const queryCache = new Map<string, string>();

/** undefined = production Bun.which; null = force missing; string = skip which. */
let testBin: string | null | undefined;

/** Test-only. null forces command-not-found. A string is spawned instead of Bun.which. undefined clears the override. Clears the query cache. */
export function setGraphifyBinForTests(bin: string | null | undefined): void {
	testBin = bin;
	binFound = false;
	resolvedBin = null;
	queryCache.clear();
}

function resolveGraphify(): string | null {
	if (testBin !== undefined) return testBin;
	if (binFound && resolvedBin) return resolvedBin;
	const bin = Bun.which("graphify");
	if (!bin) {
		binFound = false;
		resolvedBin = null;
		return null;
	}
	binFound = true;
	resolvedBin = bin;
	return bin;
}


function cacheKey(cwd: string, args: readonly string[]): string {
	return JSON.stringify([cwd, args]);
}

function elapsed(started: number): number {
	const ms = Date.now() - started;
	return Number.isSafeInteger(ms) && ms >= 0 ? ms : 0;
}

function remember(key: string, text: string): void {
	if (queryCache.has(key)) queryCache.delete(key);
	queryCache.set(key, text);
	while (queryCache.size > CACHE_LIMIT) {
		const oldest = queryCache.keys().next().value;
		if (oldest === undefined) break;
		queryCache.delete(oldest);
	}
}



async function readCapped(stream: ReadableStream<Uint8Array> | null | undefined, limit: number): Promise<string> {
	if (!stream) return "";
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (total < limit) {
			const step = await reader.read();
			if (step.done) break;
			const value = step.value;
			if (!value || value.byteLength === 0) continue;
			const room = limit - total;
			if (value.byteLength > room) {
				chunks.push(value.subarray(0, room));
				total = limit;
				break;
			}
			chunks.push(value);
			total += value.byteLength;
		}
	} finally {
		try {
			await reader.cancel();
		} catch {
			// draining is best-effort
		}
	}
	return new TextDecoder().decode(Buffer.concat(chunks));
}

/**
 * Run graphify with an argv array. Never a shell string.
 * query [question], path [from, to], explain [node].
 * Successful query/path/explain text is cached by cwd + args (32 entries).
 */
export async function runGraphify(cwd: string, args: readonly string[], signal?: AbortSignal): Promise<GraphifyResult> {
	const started = Date.now();
	const command = args[0];
	const key = cacheKey(cwd, args);
	if (typeof command === "string" && CACHED_COMMANDS[command]) {
		const hit = queryCache.get(key);
		if (hit !== undefined) {
			queryCache.delete(key);
			queryCache.set(key, hit);
			return { text: hit, exitCode: 0, cached: true, ms: elapsed(started) };
		}
		if (testBin === undefined) {
			let missing = false;
			try {
				missing = !existsSync(join(cwd, "graphify-out", "graph.json"));
			} catch {
				missing = false;
			}
			if (missing) {
				return {
					text: "graphify: no graph.json; run graphify extract first",
					exitCode: 2,
					cached: false,
					ms: elapsed(started),
				};
			}
		}
	}
	const bin = resolveGraphify();
	if (!bin) {
		return { text: "graphify: command not found", exitCode: 127, cached: false, ms: elapsed(started) };
	}
	const killer = new AbortController();
	const timer = setTimeout(() => killer.abort(), TIMEOUT_MS);
	const onAbort = () => killer.abort();
	signal?.addEventListener("abort", onAbort, { once: true });
	try {
		const proc = Bun.spawn([bin, ...args], {
			cwd,
			stdout: "pipe",
			stderr: "pipe",
			stdin: "ignore",
			signal: killer.signal,
		});
		const [stdout, stderr] = await Promise.all([readCapped(proc.stdout, CAP), readCapped(proc.stderr, CAP)]);
		const exitCode = await proc.exited;
		const combined = stderr.length > 0 ? `${stdout}${stdout.length > 0 ? "\n" : ""}${stderr}` : stdout;
		const text = combined.length <= CAP ? combined : combined.slice(0, CAP);
		if (exitCode === 0 && typeof command === "string" && CACHED_COMMANDS[command]) remember(key, text);
		return { text, exitCode, cached: false, ms: elapsed(started) };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (message.includes("ENOENT") || message.includes("not found")) {
			binFound = false;
			resolvedBin = null;
			return { text: "graphify: command not found", exitCode: 127, cached: false, ms: elapsed(started) };
		}
		if (killer.signal.aborted && !signal?.aborted) {
			return { text: "graphify timed out after 20s", exitCode: 124, cached: false, ms: elapsed(started) };
		}
		return { text: `graphify failed: ${message}`, exitCode: 1, cached: false, ms: elapsed(started) };
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", onAbort);
	}
}
