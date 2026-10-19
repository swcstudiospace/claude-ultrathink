import { linkSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

export type SavingsSource = "provider" | "compress" | "graph";

export interface SavingsPoint {
	at: number;
	source: SavingsSource;
	baseline: number;
	current: number;
	saved: number;
}

export interface PerfFields {
	lastTurnMs?: number;
	cacheHitPct?: number;
	lastQueryMs?: number;
	rtkSavedTokens?: number;
	lastPayloadChars?: number;
	ttftMs?: number;
	lastIdleMs?: number;
	costCents?: number;
	providerInput?: number;
	providerOutput?: number;
	providerCacheRead?: number;
	providerCacheWrite?: number;
	prefixChanged?: number;
	toolsChanged?: number;
	graphReady?: number;
}

/** TokenSavingsSnapshot v1. Reject anything that fails these checks. */
export interface TokenSavingsSnapshot extends PerfFields {
	v: 1;
	sessionId: string;
	updatedAt: number;
	baselineTokens: number;
	currentTokens: number;
	savedTokens: number;
	points: SavingsPoint[];
}

export class LedgerReject extends Error {
	constructor(message: string) {
		super(message);
		this.name = "LedgerReject";
	}
}

const SOURCES: Record<string, true> = { provider: true, compress: true, graph: true };
const MAX_POINTS = 200;

export function defaultTokenOptDir(): string {
	const home = process.env.HOME && process.env.HOME.length > 0 ? process.env.HOME : homedir();
	return join(home, ".omp", "agent", "token-opt");
}

export function isValidSessionId(sessionId: string): boolean {
	return (
		sessionId.length >= 1 &&
		sessionId.length <= 128 &&
		!sessionId.includes("/") &&
		!sessionId.includes("\\") &&
		!sessionId.includes("\0") &&
		sessionId !== "." &&
		sessionId !== ".." &&
		sessionId !== "live"
	);
}

function isNonNegInt(value: unknown): value is number {
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function optionalField(value: unknown, present: boolean, max?: number): boolean {
	if (!present) return true;
	if (!isNonNegInt(value)) return false;
	return max === undefined || value <= max;
}

export function isValidPoint(point: unknown): point is SavingsPoint {
	if (typeof point !== "object" || point === null) return false;
	if (!("at" in point) || !("source" in point) || !("baseline" in point) || !("current" in point) || !("saved" in point)) {
		return false;
	}
	const at = point.at;
	const source = point.source;
	const baseline = point.baseline;
	const current = point.current;
	const saved = point.saved;
	if (!isNonNegInt(at) || !isNonNegInt(baseline) || !isNonNegInt(current) || !isNonNegInt(saved)) return false;
	if (typeof source !== "string" || !SOURCES[source]) return false;
	return saved === baseline - current;
}

export function isValidSnapshot(value: unknown, sessionId?: string): value is TokenSavingsSnapshot {
	if (typeof value !== "object" || value === null) return false;
	if (!("v" in value) || !("sessionId" in value) || !("updatedAt" in value)) return false;
	if (!("baselineTokens" in value) || !("currentTokens" in value) || !("savedTokens" in value) || !("points" in value)) {
		return false;
	}
	if (value.v !== 1 || typeof value.sessionId !== "string" || !isValidSessionId(value.sessionId)) return false;
	if (sessionId !== undefined && value.sessionId !== sessionId) return false;
	if (!isNonNegInt(value.updatedAt) || !isNonNegInt(value.baselineTokens) || !isNonNegInt(value.currentTokens)) {
		return false;
	}
	if (!isNonNegInt(value.savedTokens) || value.savedTokens !== value.baselineTokens - value.currentTokens) return false;
	const lastTurnMs = "lastTurnMs" in value ? value.lastTurnMs : undefined;
	const cacheHitPct = "cacheHitPct" in value ? value.cacheHitPct : undefined;
	const lastQueryMs = "lastQueryMs" in value ? value.lastQueryMs : undefined;
	const rtkSavedTokens = "rtkSavedTokens" in value ? value.rtkSavedTokens : undefined;
	const lastPayloadChars = "lastPayloadChars" in value ? value.lastPayloadChars : undefined;
	const ttftMs = "ttftMs" in value ? value.ttftMs : undefined;
	const lastIdleMs = "lastIdleMs" in value ? value.lastIdleMs : undefined;
	const costCents = "costCents" in value ? value.costCents : undefined;
	const providerInput = "providerInput" in value ? value.providerInput : undefined;
	const providerOutput = "providerOutput" in value ? value.providerOutput : undefined;
	const providerCacheRead = "providerCacheRead" in value ? value.providerCacheRead : undefined;
	const providerCacheWrite = "providerCacheWrite" in value ? value.providerCacheWrite : undefined;
	const prefixChanged = "prefixChanged" in value ? value.prefixChanged : undefined;
	const toolsChanged = "toolsChanged" in value ? value.toolsChanged : undefined;
	const graphReady = "graphReady" in value ? value.graphReady : undefined;
	if (!optionalField(lastTurnMs, "lastTurnMs" in value)) return false;
	if (!optionalField(cacheHitPct, "cacheHitPct" in value, 100)) return false;
	if (!optionalField(lastQueryMs, "lastQueryMs" in value)) return false;
	if (!optionalField(rtkSavedTokens, "rtkSavedTokens" in value)) return false;
	if (!optionalField(lastPayloadChars, "lastPayloadChars" in value)) return false;
	if (!optionalField(ttftMs, "ttftMs" in value)) return false;
	if (!optionalField(lastIdleMs, "lastIdleMs" in value)) return false;
	if (!optionalField(costCents, "costCents" in value)) return false;
	if (!optionalField(providerInput, "providerInput" in value)) return false;
	if (!optionalField(providerOutput, "providerOutput" in value)) return false;
	if (!optionalField(providerCacheRead, "providerCacheRead" in value)) return false;
	if (!optionalField(providerCacheWrite, "providerCacheWrite" in value)) return false;
	if (!optionalField(prefixChanged, "prefixChanged" in value, 1)) return false;
	if (!optionalField(toolsChanged, "toolsChanged" in value, 1)) return false;
	if (!optionalField(graphReady, "graphReady" in value, 1)) return false;
	if (!Array.isArray(value.points) || value.points.length > MAX_POINTS) return false;
	let windowBaseline = 0;
	let windowCurrent = 0;
	let windowSaved = 0;
	for (const point of value.points) {
		if (!isValidPoint(point)) return false;
		windowBaseline += point.baseline;
		windowCurrent += point.current;
		windowSaved += point.saved;
	}
	return (
		windowBaseline <= value.baselineTokens &&
		windowCurrent <= value.currentTokens &&
		windowSaved <= value.savedTokens
	);
}

function readJson(path: string): unknown {
	try {
		return JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return undefined;
	}
}
const LOCK_WAIT_MS = 500;
// A write holds the lock for one small file write plus a rename, so a lock older than this belongs to a hung owner.
const LOCK_STALE_MS = 2_000;
const LOCK_RETRY_MS = 10;
let lockSeq = 0;

interface LockObservation {
	token: string;
	ino: number;
	mtimeMs: number;
}

function observeLock(lockPath: string): LockObservation | null {
	try {
		const st = statSync(lockPath);
		// A directory lock left by an older build has no token; it is identified by inode alone.
		const token = st.isFile() ? readFileSync(lockPath, "utf8") : "";
		return { token, ino: st.ino, mtimeMs: st.mtimeMs };
	} catch {
		return null;
	}
}

function ownerIsDead(token: string): boolean {
	const match = /^(\d+):/.exec(token);
	if (match === null) return false;
	try {
		process.kill(Number(match[1]), 0);
		return false;
	} catch (err) {
		return err !== null && typeof err === "object" && "code" in err && err.code === "ESRCH";
	}
}

/**
 * Removes the lock only if it is still the one that was judged stale. The rename is atomic, so two
 * waiters cannot both remove the same file; the claimed file is then checked against what was observed
 * and put back if a live owner replaced it in between.
 */
function breakStale(lockPath: string, seen: LockObservation): void {
	const claim = `${lockPath}.stale.${process.pid}.${lockSeq++}`;
	try {
		renameSync(lockPath, claim);
	} catch {
		return;
	}
	const claimed = observeLock(claim);
	if (claimed === null || claimed.ino !== seen.ino || claimed.token !== seen.token) {
		try {
			linkSync(claim, lockPath);
		} catch {
			// someone else already created a new lock; the owner's token check keeps its release safe
		}
	}
	rmSync(claim, { recursive: true, force: true });
}

/** Returns the owner token that releaseLock needs. */
function acquireLock(lockPath: string): string {
	const token = `${process.pid}:${lockSeq++}:${Date.now().toString(36)}`;
	const started = Date.now();
	for (;;) {
		try {
			writeFileSync(lockPath, token, { flag: "wx" });
			return token;
		} catch (err) {
			const code = err && typeof err === "object" && "code" in err ? String(err.code) : "";
			if (code !== "EEXIST") {
				// a failed write may have left an empty lock file behind
				rmSync(lockPath, { force: true });
				throw new LedgerReject("ledger lock failed");
			}
		}
		if (Date.now() - started >= LOCK_WAIT_MS) throw new LedgerReject("ledger lock timeout");
		const seen = observeLock(lockPath);
		// A crashed owner is detected at once; a hung owner after LOCK_STALE_MS.
		if (seen !== null && (ownerIsDead(seen.token) || Date.now() - seen.mtimeMs > LOCK_STALE_MS)) {
			breakStale(lockPath, seen);
			continue;
		}
		Bun.sleepSync(LOCK_RETRY_MS);
	}
}

/** Removes the lock only while it still carries this writer's token. */
function releaseLock(lockPath: string, token: string): void {
	try {
		if (readFileSync(lockPath, "utf8") === token) rmSync(lockPath, { force: true });
	} catch {
		// already reclaimed by a waiter
	}
}

function writeAtomic(path: string, body: string): void {
	const dir = dirname(path);
	mkdirSync(dir, { recursive: true });
	const lockPath = join(dir, ".lock");
	const token = acquireLock(lockPath);
	const tmp = join(dir, `.${basename(path)}.${process.pid}.${Date.now()}.tmp`);
	try {
		writeFileSync(tmp, body);
		renameSync(tmp, path);
	} finally {
		rmSync(tmp, { force: true });
		releaseLock(lockPath, token);
	}
}

function copyPerf(from: TokenSavingsSnapshot, onto: TokenSavingsSnapshot): void {
	if (from.lastTurnMs !== undefined) onto.lastTurnMs = from.lastTurnMs;
	if (from.cacheHitPct !== undefined) onto.cacheHitPct = from.cacheHitPct;
	if (from.lastQueryMs !== undefined) onto.lastQueryMs = from.lastQueryMs;
	if (from.rtkSavedTokens !== undefined) onto.rtkSavedTokens = from.rtkSavedTokens;
	if (from.lastPayloadChars !== undefined) onto.lastPayloadChars = from.lastPayloadChars;
	if (from.ttftMs !== undefined) onto.ttftMs = from.ttftMs;
	if (from.lastIdleMs !== undefined) onto.lastIdleMs = from.lastIdleMs;
	if (from.costCents !== undefined) onto.costCents = from.costCents;
	if (from.providerInput !== undefined) onto.providerInput = from.providerInput;
	if (from.providerOutput !== undefined) onto.providerOutput = from.providerOutput;
	if (from.providerCacheRead !== undefined) onto.providerCacheRead = from.providerCacheRead;
	if (from.providerCacheWrite !== undefined) onto.providerCacheWrite = from.providerCacheWrite;
	if (from.prefixChanged !== undefined) onto.prefixChanged = from.prefixChanged;
	if (from.toolsChanged !== undefined) onto.toolsChanged = from.toolsChanged;
	if (from.graphReady !== undefined) onto.graphReady = from.graphReady;
}

interface ProviderTotals {
	input: number;
	cacheRead: number;
	cacheWrite: number;
	output: number;
}

export interface Ledger {
	load(sessionId: string): TokenSavingsSnapshot;
	record(point: SavingsPoint): TokenSavingsSnapshot;
	snapshot(): TokenSavingsSnapshot | null;
	notePerf(fields: PerfFields): TokenSavingsSnapshot;
	addProviderUsage(input: number, cacheRead: number, cacheWrite: number, output?: number): TokenSavingsSnapshot;
	/** Forces pending snapshot writes to disk. Resolves at once when asyncWrites is off. Never rejects. */
	flush(): Promise<void>;
	/** Failed flush writes plus dirty markers dropped past maxPendingSessions. */
	droppedWrites(): number;
	/** Successful snapshot writes to disk, in both modes. */
	writesCompleted(): number;
}

const DEFAULT_MAX_PENDING_SESSIONS = 64;

export function createLedger(options?: {
	dir?: string;
	now?: () => number;
	asyncWrites?: boolean;
	maxPendingSessions?: number;
}): Ledger {
	const dir = options?.dir ?? defaultTokenOptDir();
	const now = options?.now ?? Date.now;
	const asyncWrites = options?.asyncWrites === true;
	const maxPendingSessions = options?.maxPendingSessions ?? DEFAULT_MAX_PENDING_SESSIONS;
	if (!Number.isSafeInteger(maxPendingSessions) || maxPendingSessions <= 0) {
		throw new LedgerReject("invalid maxPendingSessions");
	}
	const memory = new Map<string, TokenSavingsSnapshot>();
	const usage = new Map<string, ProviderTotals>();
	// Insertion order is flush order: the most recently touched session is last, so live.json ends on it.
	const dirty = new Map<string, true>();
	let flushTimer: Timer | null = null;
	let dropped = 0;
	let completed = 0;
	let activeId: string | null = null;

	function writeSnapshot(snap: TokenSavingsSnapshot): void {
		const body = `${JSON.stringify(snap)}\n`;
		writeAtomic(join(dir, `${snap.sessionId}.json`), body);
		writeAtomic(join(dir, "live.json"), body);
		completed += 1;
	}

	function drainDirty(): void {
		if (flushTimer !== null) {
			clearTimeout(flushTimer);
			flushTimer = null;
		}
		const ids = [...dirty.keys()];
		dirty.clear();
		for (const id of ids) {
			const snap = memory.get(id);
			if (snap === undefined) continue;
			try {
				writeSnapshot(snap);
			} catch {
				dropped += 1;
			}
		}
	}

	function markDirty(id: string): void {
		dirty.delete(id);
		dirty.set(id, true);
		if (dirty.size > maxPendingSessions) {
			const oldest = dirty.keys().next();
			if (!oldest.done) dirty.delete(oldest.value);
			dropped += 1;
		}
		if (flushTimer === null) {
			flushTimer = setTimeout(drainDirty, 0);
			flushTimer.unref();
		}
	}

	function adoptUsage(id: string, snap: TokenSavingsSnapshot): void {
		if (usage.has(id)) return;
		const billed =
			snap.providerInput !== undefined ||
			snap.providerOutput !== undefined ||
			snap.providerCacheRead !== undefined ||
			snap.providerCacheWrite !== undefined;
		if (billed) {
			usage.set(id, {
				input: snap.providerInput ?? 0,
				output: snap.providerOutput ?? 0,
				cacheRead: snap.providerCacheRead ?? 0,
				cacheWrite: snap.providerCacheWrite ?? 0,
			});
			return;
		}
		// A legacy snapshot carries a percentage but no totals. Its denominator is unknown, so adopt zero totals rather than invent one.
		usage.set(id, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	}

	function load(sessionId: string): TokenSavingsSnapshot {
		if (!isValidSessionId(sessionId)) throw new LedgerReject("invalid session id");
		const fromSession = readJson(join(dir, `${sessionId}.json`));
		const fromLive = readJson(join(dir, "live.json"));
		let snap: TokenSavingsSnapshot;
		if (isValidSnapshot(fromSession, sessionId)) {
			snap = fromSession;
		} else if (isValidSnapshot(fromLive, sessionId)) {
			snap = fromLive;
		} else {
			snap = {
				v: 1,
				sessionId,
				updatedAt: now(),
				baselineTokens: 0,
				currentTokens: 0,
				savedTokens: 0,
				points: [],
			};
		}
		memory.set(sessionId, snap);
		adoptUsage(sessionId, snap);
		activeId = sessionId;
		if (asyncWrites) markDirty(sessionId);
		else writeSnapshot(snap);
		return snap;
	}

	function requireActive(): { id: string; previous: TokenSavingsSnapshot } {
		if (activeId === null || !memory.has(activeId)) load("default");
		const id = activeId;
		if (id === null) throw new LedgerReject("no session");
		const previous = memory.get(id);
		if (!previous) throw new LedgerReject("no session");
		return { id, previous };
	}

	function commit(next: TokenSavingsSnapshot, id: string): TokenSavingsSnapshot {
		if (!isValidSnapshot(next, id)) throw new LedgerReject("snapshot invariant failed");
		if (asyncWrites) {
			memory.set(id, next);
			markDirty(id);
			return next;
		}
		writeSnapshot(next);
		memory.set(id, next);
		return next;
	}

	function record(point: SavingsPoint): TokenSavingsSnapshot {
		if (!isValidPoint(point)) throw new LedgerReject("invalid savings point");
		const { id, previous } = requireActive();
		const points =
			previous.points.length >= MAX_POINTS
				? previous.points.slice(previous.points.length - (MAX_POINTS - 1))
				: previous.points.slice();
		points.push(point);
		const baselineTokens = previous.baselineTokens + point.baseline;
		const currentTokens = previous.currentTokens + point.current;
		const next: TokenSavingsSnapshot = {
			v: 1,
			sessionId: id,
			updatedAt: now(),
			baselineTokens,
			currentTokens,
			savedTokens: baselineTokens - currentTokens,
			points,
		};
		copyPerf(previous, next);
		return commit(next, id);
	}

	function notePerf(fields: PerfFields): TokenSavingsSnapshot {
		if (!optionalField(fields.lastTurnMs, fields.lastTurnMs !== undefined)) throw new LedgerReject("invalid lastTurnMs");
		if (!optionalField(fields.cacheHitPct, fields.cacheHitPct !== undefined, 100)) throw new LedgerReject("invalid cacheHitPct");
		if (!optionalField(fields.lastQueryMs, fields.lastQueryMs !== undefined)) throw new LedgerReject("invalid lastQueryMs");
		if (!optionalField(fields.rtkSavedTokens, fields.rtkSavedTokens !== undefined)) throw new LedgerReject("invalid rtkSavedTokens");
		if (!optionalField(fields.lastPayloadChars, fields.lastPayloadChars !== undefined)) {
			throw new LedgerReject("invalid lastPayloadChars");
		}
		if (!optionalField(fields.ttftMs, fields.ttftMs !== undefined)) throw new LedgerReject("invalid ttftMs");
		if (!optionalField(fields.lastIdleMs, fields.lastIdleMs !== undefined)) throw new LedgerReject("invalid lastIdleMs");
		if (!optionalField(fields.costCents, fields.costCents !== undefined)) throw new LedgerReject("invalid costCents");
		if (!optionalField(fields.providerInput, fields.providerInput !== undefined)) throw new LedgerReject("invalid providerInput");
		if (!optionalField(fields.providerOutput, fields.providerOutput !== undefined)) throw new LedgerReject("invalid providerOutput");
		if (!optionalField(fields.providerCacheRead, fields.providerCacheRead !== undefined)) {
			throw new LedgerReject("invalid providerCacheRead");
		}
		if (!optionalField(fields.providerCacheWrite, fields.providerCacheWrite !== undefined)) {
			throw new LedgerReject("invalid providerCacheWrite");
		}
		if (!optionalField(fields.prefixChanged, fields.prefixChanged !== undefined, 1)) throw new LedgerReject("invalid prefixChanged");
		if (!optionalField(fields.toolsChanged, fields.toolsChanged !== undefined, 1)) throw new LedgerReject("invalid toolsChanged");
		if (!optionalField(fields.graphReady, fields.graphReady !== undefined, 1)) throw new LedgerReject("invalid graphReady");
		const { id, previous } = requireActive();
		const next: TokenSavingsSnapshot = {
			v: 1,
			sessionId: id,
			updatedAt: now(),
			baselineTokens: previous.baselineTokens,
			currentTokens: previous.currentTokens,
			savedTokens: previous.savedTokens,
			points: previous.points.slice(),
		};
		copyPerf(previous, next);
		if (fields.lastTurnMs !== undefined) next.lastTurnMs = fields.lastTurnMs;
		if (fields.cacheHitPct !== undefined) next.cacheHitPct = fields.cacheHitPct;
		if (fields.lastQueryMs !== undefined) next.lastQueryMs = fields.lastQueryMs;
		if (fields.rtkSavedTokens !== undefined) next.rtkSavedTokens = fields.rtkSavedTokens;
		if (fields.lastPayloadChars !== undefined) next.lastPayloadChars = fields.lastPayloadChars;
		if (fields.ttftMs !== undefined) next.ttftMs = fields.ttftMs;
		if (fields.lastIdleMs !== undefined) next.lastIdleMs = fields.lastIdleMs;
		if (fields.costCents !== undefined) next.costCents = fields.costCents;
		if (fields.providerInput !== undefined) next.providerInput = fields.providerInput;
		if (fields.providerOutput !== undefined) next.providerOutput = fields.providerOutput;
		if (fields.providerCacheRead !== undefined) next.providerCacheRead = fields.providerCacheRead;
		if (fields.providerCacheWrite !== undefined) next.providerCacheWrite = fields.providerCacheWrite;
		if (fields.prefixChanged !== undefined) next.prefixChanged = fields.prefixChanged;
		if (fields.toolsChanged !== undefined) next.toolsChanged = fields.toolsChanged;
		if (fields.graphReady !== undefined) next.graphReady = fields.graphReady;
		return commit(next, id);
	}

	function addProviderUsage(input: number, cacheRead: number, cacheWrite: number, output = 0): TokenSavingsSnapshot {
		if (!isNonNegInt(input) || !isNonNegInt(cacheRead) || !isNonNegInt(cacheWrite) || !isNonNegInt(output)) {
			throw new LedgerReject("invalid provider usage");
		}
		const { id } = requireActive();
		const row = usage.get(id) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
		const providerInput = row.input + input;
		const providerOutput = row.output + output;
		const providerCacheRead = row.cacheRead + cacheRead;
		const providerCacheWrite = row.cacheWrite + cacheWrite;
		if (
			!isNonNegInt(providerInput) ||
			!isNonNegInt(providerOutput) ||
			!isNonNegInt(providerCacheRead) ||
			!isNonNegInt(providerCacheWrite)
		) {
			throw new LedgerReject("invalid provider usage");
		}
		row.input = providerInput;
		row.output = providerOutput;
		row.cacheRead = providerCacheRead;
		row.cacheWrite = providerCacheWrite;
		usage.set(id, row);
		const denom = providerInput + providerCacheRead + providerCacheWrite;
		const cacheHitPct = denom === 0 ? 0 : Math.round((providerCacheRead * 100) / denom);
		return notePerf({ cacheHitPct, providerInput, providerOutput, providerCacheRead, providerCacheWrite });
	}

	return {
		load,
		record,
		notePerf,
		addProviderUsage,
		snapshot(): TokenSavingsSnapshot | null {
			if (activeId === null) return null;
			return memory.get(activeId) ?? null;
		},
		flush(): Promise<void> {
			if (asyncWrites) drainDirty();
			return Promise.resolve();
		},
		droppedWrites(): number {
			return dropped;
		},
		writesCompleted(): number {
			return completed;
		},
	};
}
