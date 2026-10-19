import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { LeaseOutcome } from "./shared-cache.ts";

const TIMEOUT_MS = 20_000;
const CAP = 8000;
const CACHE_LIMIT = 32;
const CACHED_COMMANDS: Record<string, true> = { query: true, path: true, explain: true };
const L2_TIMEOUT_MS = 300;
const LEASE_MS = 2000;
const WAIT_MS = 2000;
const POLL_MS = 50;

export interface GraphifyResult {
	text: string;
	exitCode: number;
	cached: boolean;
	ms: number;
}

interface GraphL2Cache {
	get(key: string): Promise<string | null>;
	set(key: string, value: string): Promise<void>;
	/** Optional lease. `granted` only for the caller that created the key; `held` when another holds it; `unavailable` when the lease cannot be checked. Enables singleflight. */
	acquire?: (key: string, ttlMs: number) => Promise<LeaseOutcome>;
}

interface GraphL2Lease extends GraphL2Cache {
	acquire: (key: string, ttlMs: number) => Promise<LeaseOutcome>;
}

interface GraphifyRunOptions {
	/** Positive safe integer. Appends `--budget N` to query only. */
	budget?: number;
	/** Key L1 by graph.json stamp; bypass the cache when graph.json is missing. */
	keyedCache?: boolean;
	/** Shared L2 cache. Consulted only with keyedCache. */
	l2?: GraphL2Cache;
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


function cacheKey(cwd: string, args: readonly string[], stamp?: string): string {
	return stamp === undefined ? JSON.stringify([cwd, args]) : JSON.stringify([cwd, args, stamp]);
}

/** Stamp of graphify-out/graph.json (size:mtimeMs), or "none" when the file is missing. */
export function graphStamp(cwd: string): string {
	try {
		const info = statSync(join(cwd, "graphify-out", "graph.json"));
		return `${info.size}:${info.mtimeMs}`;
	} catch {
		return "none";
	}
}

function budgetArgv(command: string | undefined, args: readonly string[], budget: number | undefined): readonly string[] {
	if (command !== "query" || budget === undefined || !Number.isSafeInteger(budget) || budget <= 0) return args;
	return [...args, "--budget", String(budget)];
}

/** Bounded L2 call. A rejection, sync throw or timeout all resolve to null. */
async function boundedL2<T>(op: () => Promise<T>): Promise<T | null> {
	const timeout = new Promise<null>((resolve) => {
		setTimeout(resolve, L2_TIMEOUT_MS, null).unref();
	});
	try {
		return await Promise.race([op(), timeout]);
	} catch {
		return null;
	}
}

/** Bounded L2 read. A rejection, sync throw or timeout all count as a miss. */
async function readL2(l2: GraphL2Cache, key: string): Promise<string | null> {
	const value = await boundedL2(() => l2.get(key));
	return typeof value === "string" ? value : null;
}

function hasLease(l2: GraphL2Cache): l2 is GraphL2Lease {
	return typeof l2.acquire === "function";
}

/**
 * Returns the text another caller stored while this one waited, or null when this caller
 * should spawn now. Only an exact "held" outcome waits. "granted", "unavailable", a boundedL2
 * timeout or throw (null), and any other value all spawn at once, so an L2 outage never stalls
 * a query.
 */
async function singleflight(l2: GraphL2Lease, key: string, signal?: AbortSignal): Promise<string | null> {
	// The lease sits beside the result key, so the result key only ever holds graphify output.
	const outcome = await boundedL2(() => l2.acquire(`${key}:lease`, LEASE_MS));
	if (outcome !== "held") return null;
	const until = Date.now() + WAIT_MS;
	for (;;) {
		if (signal?.aborted) return null;
		const shared = await readL2(l2, key);
		if (shared !== null) return shared;
		const remaining = until - Date.now();
		if (remaining <= 0) return null;
		await sleepUnlessAborted(Math.min(POLL_MS, remaining), signal);
	}
}

/** Sleeps for ms, or until signal aborts, whichever comes first. */
function sleepUnlessAborted(ms: number, signal?: AbortSignal): Promise<void> {
	if (!signal) return Bun.sleep(ms);
	if (signal.aborted) return Promise.resolve();
	const { promise, resolve } = Promise.withResolvers<void>();
	const done = () => {
		clearTimeout(timer);
		signal.removeEventListener("abort", done);
		resolve();
	};
	const timer = setTimeout(done, ms);
	signal.addEventListener("abort", done, { once: true });
	return promise;
}

/** Same outcome the spawn path reports when the caller's signal aborts a running graphify. */
function aborted(signal: AbortSignal, started: number): GraphifyResult {
	const reason: unknown = signal.reason;
	const message = reason instanceof Error ? reason.message : "The operation was aborted.";
	return { text: `graphify failed: ${message}`, exitCode: 1, cached: false, ms: elapsed(started) };
}

/** Fire-and-forget L2 write. Never throws and is never awaited. */
function writeL2(l2: GraphL2Cache, key: string, text: string): void {
	try {
		Promise.resolve(l2.set(key, text)).catch(() => {});
	} catch {
		// L2 is best-effort
	}
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
 * options.budget appends `--budget N` to query only. options.keyedCache keys the
 * cache by the graph.json stamp and bypasses it when graph.json is missing.
 * options.l2 is a shared write-through cache, consulted on L1 miss when keyedCache is set.
 * With l2.acquire, one caller per key spawns. Others wait on L2 only while the lease reports "held"; "granted" or "unavailable" spawns at once (singleflight).
 */
export async function runGraphify(
	cwd: string,
	args: readonly string[],
	signal?: AbortSignal,
	options?: GraphifyRunOptions,
): Promise<GraphifyResult> {
	const started = Date.now();
	const command = args[0];
	const cacheable = typeof command === "string" && Boolean(CACHED_COMMANDS[command]);
	const argv = budgetArgv(command, args, options?.budget);
	const keyed = options?.keyedCache === true;
	const stamp = keyed ? graphStamp(cwd) : undefined;
	// Keyed mode with no graph.json bypasses the cache entirely: no read, no write.
	const useCache = cacheable && stamp !== "none";
	const key = cacheKey(cwd, argv, stamp);
	const l2 = keyed ? options?.l2 : undefined;
	if (cacheable) {
		if (useCache) {
			const hit = queryCache.get(key);
			if (hit !== undefined) {
				queryCache.delete(key);
				queryCache.set(key, hit);
				return { text: hit, exitCode: 0, cached: true, ms: elapsed(started) };
			}
			if (l2) {
				if (signal?.aborted) return aborted(signal, started);
				const shared = await readL2(l2, key);
				if (shared !== null) {
					remember(key, shared);
					return { text: shared, exitCode: 0, cached: true, ms: elapsed(started) };
				}
			}
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
	if (signal?.aborted) return aborted(signal, started);
	if (useCache && l2 && hasLease(l2)) {
		const shared = await singleflight(l2, key, signal);
		if (signal?.aborted) return aborted(signal, started);
		if (shared !== null) {
			remember(key, shared);
			return { text: shared, exitCode: 0, cached: true, ms: elapsed(started) };
		}
	}
	const killer = new AbortController();
	const timer = setTimeout(() => killer.abort(), TIMEOUT_MS);
	const onAbort = () => killer.abort();
	signal?.addEventListener("abort", onAbort, { once: true });
	try {
		const proc = Bun.spawn([bin, ...argv], {
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
		if (exitCode === 0 && useCache) {
			remember(key, text);
			if (l2) writeL2(l2, key, text);
		}
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
