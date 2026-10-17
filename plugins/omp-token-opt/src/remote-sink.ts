import { appendFileSync, mkdirSync } from "node:fs";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { redactText } from "./redact.ts";

export interface SinkRow {
	/** Epoch milliseconds. */
	at: number;
	sessionId: string;
	kind: "savings" | "perf";
	source?: string;
	field?: string;
	baseline?: number;
	current?: number;
	saved?: number;
	value?: number;
}

export interface RemoteSinkOptions {
	/** Postgres/TimescaleDB URL. Omit to spill every row to fallbackPath. */
	url?: string;
	fallbackPath: string;
	batchSize?: number;
	flushMs?: number;
	maxQueue?: number;
	timeoutMs?: number;
	table?: string;
	/** Run CREATE TABLE IF NOT EXISTS and create_hypertable before the first write. Default false: INSERT only. */
	ensureSchema?: boolean;
}

interface SinkStats {
	queued: number;
	sent: number;
	dropped: number;
	fellBack: number;
}

export interface RemoteSink {
	push(row: SinkRow): void;
	flush(): Promise<void>;
	close(): Promise<void>;
	stats(): SinkStats;
}

const TABLE_PATTERN = /^[a-z_][a-z0-9_]{0,62}$/;
const COLUMNS = "ts, session_id, kind, source, field, baseline, current, saved, value";
const COLUMNS_PER_ROW = 9;
const INSERT_CHUNK_ROWS = 1000;
const WARNING_CODE = "TOKEN_OPT_REMOTE_SINK";
const CLOSE_GRACE_MS = 500;

export function createRemoteSink(options: RemoteSinkOptions): RemoteSink {
	const table = options.table ?? "token_opt_points";
	if (!TABLE_PATTERN.test(table)) throw new RangeError("remote sink table name is invalid");

	const batchSize = Math.max(1, Math.floor(options.batchSize ?? 50));
	const flushMs = options.flushMs ?? 1000;
	const maxQueue = options.maxQueue ?? 1000;
	const timeoutMs = options.timeoutMs ?? 2000;
	const fallbackPath = options.fallbackPath;
	const remoteUrl = options.url || undefined;
	const secrets = urlSecrets(remoteUrl);
	const ensureSchema = options.ensureSchema ?? false;

	const queue: SinkRow[] = [];
	const inflight = new Set<Promise<void>>();
	const counters = { sent: 0, dropped: 0, fellBack: 0 };
	let timer: Timer | null = null;
	let closed = false;
	let warned = false;
	let client: Bun.SQL | null = null;
	let schema: Promise<void> | null = null;

	function schedule(): void {
		if (timer !== null || closed || queue.length === 0) return;
		timer = setTimeout(() => {
			timer = null;
			void flush();
		}, flushMs);
		timer.unref();
	}

	function push(row: SinkRow): void {
		if (closed || queue.length >= maxQueue) {
			counters.dropped += 1;
			return;
		}
		queue.push(row);
		schedule();
	}

	async function flush(): Promise<void> {
		if (queue.length === 0) return;
		const batch = queue.splice(0, batchSize);
		const job = deliver(batch);
		inflight.add(job);
		try {
			await job;
		} finally {
			inflight.delete(job);
		}
		schedule();
	}

	async function deliver(batch: SinkRow[]): Promise<void> {
		if (remoteUrl === undefined) {
			await spill(batch);
			return;
		}
		try {
			await withTimeout(writeRemote(remoteUrl, batch), timeoutMs);
			counters.sent += batch.length;
		} catch (err) {
			warnOnce(err);
			await spill(batch);
		}
	}

	async function spill(batch: SinkRow[]): Promise<void> {
		try {
			await mkdir(dirname(fallbackPath), { recursive: true });
			await appendFile(fallbackPath, batch.map((row) => `${JSON.stringify(row)}\n`).join(""));
			counters.fellBack += batch.length;
		} catch (err) {
			counters.dropped += batch.length;
			warnOnce(err);
		}
	}

	async function writeRemote(url: string, batch: SinkRow[]): Promise<void> {
		client ??= new Bun.SQL(url);
		const sql = client;
		if (ensureSchema) {
			schema ??= createSchema(sql).catch((err: unknown) => {
				schema = null;
				throw err;
			});
			await schema;
		}
		for (let start = 0; start < batch.length; start += INSERT_CHUNK_ROWS) {
			const chunk = batch.slice(start, start + INSERT_CHUNK_ROWS);
			const values: unknown[] = [];
			const tuples = chunk.map((row, i) => {
				values.push(
					row.at,
					row.sessionId,
					row.kind,
					row.source ?? null,
					row.field ?? null,
					row.baseline ?? null,
					row.current ?? null,
					row.saved ?? null,
					row.value ?? null,
				);
				const p = Array.from({ length: COLUMNS_PER_ROW }, (_, k) => `$${i * COLUMNS_PER_ROW + k + 1}`);
				return `(to_timestamp(${p[0]} / 1000.0), ${p.slice(1).join(", ")})`;
			});
			await sql.unsafe(`INSERT INTO "${table}" (${COLUMNS}) VALUES ${tuples.join(", ")}`, values);
		}
	}

	async function createSchema(sql: Bun.SQL): Promise<void> {
		await sql.unsafe(
			`CREATE TABLE IF NOT EXISTS "${table}" (
				ts timestamptz not null default now(),
				session_id text not null,
				kind text not null,
				source text,
				field text,
				baseline bigint,
				current bigint,
				saved bigint,
				value double precision
			)`,
		);
		try {
			await sql.unsafe("SELECT create_hypertable($1::regclass, 'ts', if_not_exists => TRUE)", [table]);
		} catch {
			// TimescaleDB absent or already a hypertable: a plain Postgres table is acceptable.
		}
	}

	function warnOnce(err: unknown): void {
		if (warned) return;
		warned = true;
		const message = err instanceof Error ? err.message : String(err);
		process.emitWarning(`remote sink unavailable, spilling to JSONL: ${redactText(message, secrets)}`, {
			code: WARNING_CODE,
		});
	}

	/** Synchronous spill of rows that no flush attempt took. Used only by close(). */
	function spillQueued(): void {
		if (queue.length === 0) return;
		const rows = queue.splice(0, queue.length);
		try {
			mkdirSync(dirname(fallbackPath), { recursive: true });
			appendFileSync(fallbackPath, rows.map((row) => `${JSON.stringify(row)}\n`).join(""));
			counters.fellBack += rows.length;
		} catch (err) {
			counters.dropped += rows.length;
			warnOnce(err);
		}
	}

	/**
	 * Bounded close: one flush attempt plus in-flight batches, raced against timeoutMs + CLOSE_GRACE_MS.
	 * Rows still queued are appended to the JSONL fallback synchronously.
	 */
	async function close(): Promise<void> {
		closed = true;
		if (timer !== null) {
			clearTimeout(timer);
			timer = null;
		}
		const attempt = flush().catch(() => {});
		let deadline: Timer | undefined;
		const expired = new Promise<void>((resolve) => {
			deadline = setTimeout(resolve, timeoutMs + CLOSE_GRACE_MS);
		});
		try {
			await Promise.race([Promise.allSettled([...inflight, attempt]), expired]);
			spillQueued();
			const sql = client;
			client = null;
			schema = null;
			if (sql === null) return;
			await Promise.race([sql.close({ timeout: 0 }).catch(() => {}), expired]);
		} finally {
			clearTimeout(deadline);
		}
	}

	function stats(): SinkStats {
		return { queued: queue.length, ...counters };
	}

	return { push, flush, close, stats };
}

function urlSecrets(url: string | undefined): string[] {
	if (url === undefined) return [];
	const secrets = [url];
	try {
		const { password } = new URL(url);
		if (password !== "") secrets.push(password, decodeURIComponent(password));
	} catch {
		// Unparseable URL: the full string above is still scrubbed from messages.
	}
	return secrets;
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
	let timer: Timer | undefined;
	const expired = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error("remote sink timed out")), ms);
	});
	return Promise.race([work, expired]).finally(() => clearTimeout(timer));
}
