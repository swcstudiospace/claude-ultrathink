import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRemoteSink, type RemoteSink, type RemoteSinkOptions, type SinkRow } from "./remote-sink.ts";

const UNREACHABLE_PASSWORD = "hunter2-unreachable-pw";
const UNREACHABLE_URL = `postgres://u:${UNREACHABLE_PASSWORD}@127.0.0.1:1/db`;
const FAKE_PASSWORD = "hunter2-fake-pw";

let dir: string;
const sinks: RemoteSink[] = [];

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "remote-sink-"));
});

afterEach(async () => {
	for (const sink of sinks.splice(0)) await sink.close();
	rmSync(dir, { recursive: true, force: true });
});

function track(options: RemoteSinkOptions): RemoteSink {
	const sink = createRemoteSink(options);
	sinks.push(sink);
	return sink;
}

function row(i: number): SinkRow {
	return { at: 1_700_000_000_000 + i, sessionId: `s${i}`, kind: "savings", source: "graph", baseline: 100, current: 40, saved: 60 };
}

function jsonlLines(path: string): string[] {
	return readFileSync(path, "utf8")
		.split("\n")
		.filter((line) => line.length > 0);
}

describe("createRemoteSink without url", () => {
	test("flush appends one JSONL line per row and creates the parent directory", async () => {
		const fallbackPath = join(dir, "nested", "spill.jsonl");
		const sink = track({ fallbackPath, flushMs: 60_000 });
		for (let i = 0; i < 3; i++) sink.push(row(i));
		await sink.flush();

		const lines = jsonlLines(fallbackPath);
		expect(lines).toHaveLength(3);
		expect(JSON.parse(lines[2] ?? "{}")).toEqual(row(2));
		expect(sink.stats()).toEqual({ queued: 0, sent: 0, dropped: 0, fellBack: 3 });
	});

	test("flush takes at most batchSize rows", async () => {
		const fallbackPath = join(dir, "spill.jsonl");
		const sink = track({ fallbackPath, batchSize: 2, flushMs: 60_000 });
		for (let i = 0; i < 5; i++) sink.push(row(i));
		await sink.flush();

		expect(jsonlLines(fallbackPath)).toHaveLength(2);
		expect(sink.stats()).toEqual({ queued: 3, sent: 0, dropped: 0, fellBack: 2 });
	});

	test("queue overflow increments dropped and does not throw", () => {
		const sink = track({ fallbackPath: join(dir, "spill.jsonl"), maxQueue: 2, flushMs: 60_000 });
		for (let i = 0; i < 5; i++) sink.push(row(i));
		expect(sink.stats()).toEqual({ queued: 2, sent: 0, dropped: 3, fellBack: 0 });
	});

	test("a scheduled flush fires after flushMs without an explicit flush", async () => {
		// Exception to the no-wall-clock rule: this exercises the real setTimeout scheduling path.
		const fallbackPath = join(dir, "timer.jsonl");
		const sink = track({ fallbackPath, flushMs: 20 });
		sink.push(row(0));
		const deadline = Date.now() + 3000;
		while (!existsSync(fallbackPath) && Date.now() < deadline) await Bun.sleep(10);

		expect(jsonlLines(fallbackPath)).toHaveLength(1);
		expect(sink.stats().queued).toBe(0);
	});

	test("close flushes pending rows and later pushes are dropped", async () => {
		const fallbackPath = join(dir, "close.jsonl");
		const sink = track({ fallbackPath, flushMs: 60_000 });
		for (let i = 0; i < 3; i++) sink.push(row(i));
		await sink.close();

		expect(jsonlLines(fallbackPath)).toHaveLength(3);
		expect(sink.stats()).toEqual({ queued: 0, sent: 0, dropped: 0, fellBack: 3 });

		sink.push(row(9));
		expect(sink.stats().dropped).toBe(1);
	});
});

describe("createRemoteSink table validation", () => {
	test("invalid table names throw RangeError", () => {
		const fallbackPath = join(dir, "unused.jsonl");
		for (const table of ["Bad-Name", "1starts_with_digit", "has space", "x".repeat(64), "drop;table"]) {
			expect(() => createRemoteSink({ fallbackPath, table })).toThrow(RangeError);
		}
	});
});

describe("createRemoteSink with an unreachable url", () => {
	test("flush falls back to JSONL within timeoutMs and never leaks the password", async () => {
		const fallbackPath = join(dir, "fallback.jsonl");
		const timeoutMs = 500;
		const warnings = spyOn(process, "emitWarning").mockImplementation(() => {});
		try {
			const sink = track({ url: UNREACHABLE_URL, fallbackPath, timeoutMs, flushMs: 60_000 });
			for (let i = 0; i < 2; i++) sink.push(row(i));

			// Real network connect to a refused port: the elapsed bound is the behaviour under test.
			const started = performance.now();
			await sink.flush();
			const elapsed = performance.now() - started;

			expect(elapsed).toBeLessThan(timeoutMs + 1500);
			expect(jsonlLines(fallbackPath)).toHaveLength(2);
			expect(sink.stats()).toEqual({ queued: 0, sent: 0, dropped: 0, fellBack: 2 });

			const messages = warnings.mock.calls.map((call) => String(call[0]));
			expect(messages).toHaveLength(1);
			expect(messages[0]).toContain("remote sink unavailable");
			for (const message of messages) expect(message).not.toContain(UNREACHABLE_PASSWORD);
		} finally {
			warnings.mockRestore();
		}
	});
});

const SSL_REQUEST_CODE = 80877103;

function int32Body(value: number): Buffer {
	const body = Buffer.alloc(4);
	body.writeInt32BE(value);
	return body;
}

function pgMessage(type: string, body: Buffer): Buffer {
	const header = Buffer.alloc(5);
	header.write(type, 0, "latin1");
	header.writeInt32BE(body.length + 4, 1);
	return Buffer.concat([header, body]);
}

/** Per-connection parse state. Bun.SQL pools several connections, so state must not be shared. */
interface StubConnection {
	pending: Buffer;
	started: boolean;
}

/** Minimal Postgres wire stub: accepts the startup, answers each Sync or Query with an error, and records SQL text. */
function startFakePostgres(received: string[]) {
	return Bun.listen<StubConnection>({
		hostname: "127.0.0.1",
		port: 0,
		socket: {
			open(socket) {
				socket.data = { pending: Buffer.alloc(0), started: false };
			},
			data(socket, chunk) {
				const state = socket.data;
				state.pending = Buffer.concat([state.pending, chunk]);
				for (;;) {
					if (!state.started) {
						if (state.pending.length < 8) return;
						const length = state.pending.readInt32BE(0);
						if (state.pending.length < length) return;
						const code = state.pending.readInt32BE(4);
						state.pending = state.pending.subarray(length);
						if (code === SSL_REQUEST_CODE) {
							socket.write("N");
							continue;
						}
						state.started = true;
						socket.write(Buffer.concat([pgMessage("R", int32Body(0)), pgMessage("Z", Buffer.from("I"))]));
						continue;
					}
					if (state.pending.length < 5) return;
					const type = state.pending.toString("latin1", 0, 1);
					const length = state.pending.readInt32BE(1);
					if (state.pending.length < 1 + length) return;
					const body = state.pending.subarray(5, 1 + length);
					state.pending = state.pending.subarray(1 + length);
					if (type === "P" || type === "Q") received.push(body.toString("utf8"));
					if (type === "S" || type === "Q") {
						const error = pgMessage("E", Buffer.from("SERROR\0C42P01\0Mrelation does not exist\0\0", "utf8"));
						socket.write(Buffer.concat([error, pgMessage("Z", Buffer.from("I"))]));
					}
					if (type === "X") socket.end();
				}
			},
		},
	});
}

async function flushOnceToFakePostgres(extra: { ensureSchema?: boolean }): Promise<string> {
	const received: string[] = [];
	const server = startFakePostgres(received);
	const warnings = spyOn(process, "emitWarning").mockImplementation(() => {});
	try {
		const fallbackPath = join(dir, "fake.jsonl");
		const sink = track({
			url: `postgres://u:${FAKE_PASSWORD}@127.0.0.1:${server.port}/db`,
			fallbackPath,
			timeoutMs: 2000,
			flushMs: 60_000,
			...extra,
		});
		sink.push(row(0));
		await sink.flush();

		expect(jsonlLines(fallbackPath)).toHaveLength(1);
		expect(sink.stats()).toEqual({ queued: 0, sent: 0, dropped: 0, fellBack: 1 });
		const messages = warnings.mock.calls.map((call) => String(call[0]));
		expect(messages).toHaveLength(1);
		for (const message of messages) expect(message).not.toContain(FAKE_PASSWORD);
		return received.join("\n");
	} finally {
		warnings.mockRestore();
		server.stop(true);
	}
}

describe("createRemoteSink schema provisioning", () => {
	test("default sink issues INSERT only: no CREATE TABLE and no create_hypertable, and falls back to JSONL", async () => {
		const sent = await flushOnceToFakePostgres({});

		expect(sent).toContain("INSERT INTO");
		expect(sent).not.toContain("CREATE");
		expect(sent).not.toContain("create_hypertable");
	});

	test("ensureSchema: true issues CREATE TABLE before writing, and a failed CREATE falls back to JSONL", async () => {
		const sent = await flushOnceToFakePostgres({ ensureSchema: true });

		expect(sent).toContain("CREATE TABLE IF NOT EXISTS");
	});
});

describe("createRemoteSink close with a stalled remote", () => {
	test("close returns within about timeoutMs and spills every queued row to JSONL", async () => {
		// A real listener that accepts TCP and never answers the Postgres handshake.
		const stalled = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { open() {}, data() {} } });
		const fallbackPath = join(dir, "stalled.jsonl");
		const timeoutMs = 400;
		const warnings = spyOn(process, "emitWarning").mockImplementation(() => {});
		try {
			const sink = track({
				url: `postgres://u:${UNREACHABLE_PASSWORD}@127.0.0.1:${stalled.port}/db`,
				fallbackPath,
				timeoutMs,
				batchSize: 1,
				flushMs: 60_000,
			});
			for (let i = 0; i < 5; i++) sink.push(row(i));

			const started = performance.now();
			await sink.close();
			const elapsed = performance.now() - started;

			// The old drain-everything close spent one timeout per row (about 2 s here).
			expect(elapsed).toBeLessThan(timeoutMs * 3);
			expect(jsonlLines(fallbackPath)).toHaveLength(5);
			expect(sink.stats()).toEqual({ queued: 0, sent: 0, dropped: 0, fellBack: 5 });
		} finally {
			warnings.mockRestore();
			stalled.stop(true);
		}
	});
});

const LIVE_URL = process.env.TOKEN_OPT_TEST_TIMESCALE_URL ?? "";

describe("createRemoteSink against TimescaleDB", () => {
	test.skipIf(!process.env.TOKEN_OPT_TEST_TIMESCALE_URL)("writes a row to a hypertable", async () => {
		const sink = track({
			url: LIVE_URL,
			fallbackPath: join(dir, "live-fallback.jsonl"),
			table: `token_opt_test_${Date.now()}`,
			ensureSchema: true,
			flushMs: 60_000,
		});
		sink.push(row(0));
		await sink.close();

		expect(sink.stats()).toEqual({ queued: 0, sent: 1, dropped: 0, fellBack: 0 });
	});
});
