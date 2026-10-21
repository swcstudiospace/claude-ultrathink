// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { describe, expect, test } from "bun:test";
import { type ClearTimer, createSinkQueue, type SetTimer, type SinkEvent, type SinkQueue, type SinkQueueOptions } from "./queue.ts";
import type { SendResult, SinkEnvelope, SinkTransport } from "./types.ts";

const SINK = "test-sink";
const REQUEST_TIMEOUT_MS = 5_000;
const BACKOFF_MS = 10;
const FLUSH_MS = 60_000;

interface PendingTimer {
	readonly ms: number;
	readonly callback: () => void;
}

/** Injected timers: nothing fires unless the test fires it, and fired timers are removed. */
interface Timers {
	setTimer: SetTimer;
	clearTimer: ClearTimer;
	/** Pending timers with this delay. */
	count(ms: number): number;
	/** Fires every pending timer with this delay; returns how many fired. */
	fire(ms: number): number;
}

function fakeTimers(): Timers {
	const pending = new Map<number, PendingTimer>();
	let nextId = 1;
	const setTimer: SetTimer = (callback, ms) => {
		const id = nextId++;
		pending.set(id, { ms, callback });
		return id;
	};
	const clearTimer: ClearTimer = (handle) => {
		pending.delete(handle as number);
	};
	const count = (ms: number): number => [...pending.values()].filter((timer) => timer.ms === ms).length;
	const fire = (ms: number): number => {
		let fired = 0;
		for (const [id, timer] of [...pending]) {
			if (timer.ms !== ms) continue;
			pending.delete(id);
			timer.callback();
			fired++;
		}
		return fired;
	};
	return { setTimer, clearTimer, count, fire };
}

interface Call {
	readonly batch: readonly SinkEnvelope[];
	readonly signal: AbortSignal;
}

type Responder = (call: Call, callNumber: number) => Promise<SendResult>;

/** A transport whose behaviour is scripted per call. A responder that throws synchronously makes `send` throw. */
function scriptedTransport(respond: Responder): { transport: SinkTransport; calls: Call[] } {
	const calls: Call[] = [];
	const transport: SinkTransport = {
		name: SINK,
		send(batch, signal) {
			const call = { batch, signal };
			calls.push(call);
			return respond(call, calls.length);
		},
	};
	return { transport, calls };
}

const okResult = (): Promise<SendResult> => Promise.resolve({ ok: true });

const failResult = (retryable: boolean, reason: string): Promise<SendResult> => Promise.resolve({ ok: false, retryable, reason });

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
	const { promise, resolve } = Promise.withResolvers<T>();
	return { promise, resolve };
}

/** A transport that never settles and ignores the abort signal. */
const hangingResult = (): Promise<SendResult> => new Promise<SendResult>(() => {});

const envelope = (n: number): SinkEnvelope => ({ kind: "audit", at: "2026-01-01T00:00:00.000Z", body: { n } });

const numbersOf = (batch: readonly SinkEnvelope[]): number[] => batch.map((item) => item.body.n as number);

/** Yields to the event loop so every queued microtask runs. This is not a timer. */
function yieldToEventLoop(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	return promise;
}

/** Starts a flush, then fires backoff timers until the queue goes idle. */
async function drain(queue: SinkQueue, timers: Timers): Promise<boolean> {
	const outcome: { value?: boolean } = {};
	void queue.flush(FLUSH_MS).then((value) => {
		outcome.value = value;
	});
	for (let round = 0; round < 100; round++) {
		await yieldToEventLoop();
		if (outcome.value !== undefined) return outcome.value;
		timers.fire(BACKOFF_MS);
	}
	throw new Error("queue did not drain");
}

function makeQueue(
	transport: SinkTransport,
	timers: Timers,
	overrides: {
		capacity?: number;
		maxBatch?: number;
		maxAttempts?: number;
		backoffMs?: (attempt: number) => number;
		onEvent?: (event: SinkEvent) => void;
	} = {},
): { queue: SinkQueue; events: SinkEvent[] } {
	const events: SinkEvent[] = [];
	const options: SinkQueueOptions = {
		transport,
		capacity: overrides.capacity ?? 100,
		maxBatch: overrides.maxBatch ?? 10,
		maxAttempts: overrides.maxAttempts ?? 3,
		backoffMs: overrides.backoffMs ?? (() => BACKOFF_MS),
		requestTimeoutMs: REQUEST_TIMEOUT_MS,
		onEvent: overrides.onEvent ?? ((event) => events.push(event)),
		setTimer: timers.setTimer,
		clearTimer: timers.clearTimer,
	};
	return { queue: createSinkQueue(options), events };
}

describe("createSinkQueue", () => {
	test("overflow drops the oldest envelopes and reports exactly the overflow count", async () => {
		const timers = fakeTimers();
		const { transport, calls } = scriptedTransport(okResult);
		const { queue, events } = makeQueue(transport, timers, { capacity: 3 });

		for (let n = 1; n <= 5; n++) queue.enqueue(envelope(n));

		// enqueue never calls the transport synchronously, so nothing has been sent yet.
		expect(calls.length).toBe(0);
		expect(queue.depth()).toBe(3);
		const overflow = events.filter((event) => event.reason === "overflow");
		expect(overflow.reduce((sum, event) => sum + event.count, 0)).toBe(2);
		expect(overflow.every((event) => event.type === "dropped")).toBe(true);

		expect(await drain(queue, timers)).toBe(true);
		expect(calls.flatMap((call) => numbersOf(call.batch))).toEqual([3, 4, 5]);
	});

	test("a retryable failure is retried until maxAttempts, then dropped once with failed and dropped emitted", async () => {
		const timers = fakeTimers();
		const { transport, calls } = scriptedTransport(() => failResult(true, "503"));
		const backoffAttempts: number[] = [];
		const { queue, events } = makeQueue(transport, timers, {
			maxAttempts: 3,
			backoffMs: (attempt) => {
				backoffAttempts.push(attempt);
				return BACKOFF_MS;
			},
		});

		queue.enqueue(envelope(1));
		expect(await drain(queue, timers)).toBe(true);

		expect(calls.length).toBe(3);
		// backoffMs receives the 1-based attempt that just failed, and there is no wait after the last attempt.
		expect(backoffAttempts).toEqual([1, 2]);
		expect(events).toEqual([
			{ type: "failed", sink: SINK, count: 1, reason: "503" },
			{ type: "dropped", sink: SINK, count: 1, reason: "503" },
		]);
		expect(queue.depth()).toBe(0);
	});

	test("a non-retryable failure is sent once and dropped without retry", async () => {
		const timers = fakeTimers();
		const { transport, calls } = scriptedTransport(() => failResult(false, "400"));
		const { queue, events } = makeQueue(transport, timers, { maxAttempts: 5 });

		queue.enqueue(envelope(1));
		expect(await drain(queue, timers)).toBe(true);

		expect(calls.length).toBe(1);
		expect(timers.count(BACKOFF_MS)).toBe(0);
		expect(events).toEqual([
			{ type: "failed", sink: SINK, count: 1, reason: "400" },
			{ type: "dropped", sink: SINK, count: 1, reason: "400" },
		]);
	});

	test("batches never exceed maxBatch and keep enqueue order across batches", async () => {
		const timers = fakeTimers();
		const { transport, calls } = scriptedTransport(okResult);
		const { queue, events } = makeQueue(transport, timers, { maxBatch: 2 });

		for (let n = 1; n <= 5; n++) queue.enqueue(envelope(n));
		expect(await drain(queue, timers)).toBe(true);

		const batches = calls.map((call) => numbersOf(call.batch));
		expect(batches).toEqual([[1, 2], [3, 4], [5]]);
		expect(batches.every((batch) => batch.length <= 2)).toBe(true);
		expect(events.map((event) => event.count)).toEqual([2, 2, 1]);
	});

	test("envelopes enqueued while a batch is in flight are sent after it, in order", async () => {
		const timers = fakeTimers();
		const firstBatchGate = deferred<SendResult>();
		const { transport, calls } = scriptedTransport((_call, callNumber) =>
			callNumber === 1 ? firstBatchGate.promise : okResult(),
		);
		const { queue } = makeQueue(transport, timers, { maxBatch: 2 });

		queue.enqueue(envelope(1));
		queue.enqueue(envelope(2));
		await yieldToEventLoop();
		expect(calls.length).toBe(1);

		queue.enqueue(envelope(3));
		queue.enqueue(envelope(4));
		firstBatchGate.resolve({ ok: true });

		expect(await drain(queue, timers)).toBe(true);
		expect(calls.map((call) => numbersOf(call.batch))).toEqual([[1, 2], [3, 4]]);
	});

	test("a transport that throws synchronously or rejects is a retryable failure and does not escape", async () => {
		const timers = fakeTimers();
		const throwing = scriptedTransport((_call, callNumber) => {
			if (callNumber === 1) throw new Error("boom");
			return okResult();
		});
		const first = makeQueue(throwing.transport, timers, { maxAttempts: 2 });
		expect(() => first.queue.enqueue(envelope(1))).not.toThrow();
		expect(await drain(first.queue, timers)).toBe(true);
		expect(throwing.calls.length).toBe(2);
		expect(first.events).toEqual([{ type: "sent", sink: SINK, count: 1 }]);

		const rejecting = scriptedTransport(() => Promise.reject(new Error("socket reset")));
		const second = makeQueue(rejecting.transport, timers, { maxAttempts: 2 });
		second.queue.enqueue(envelope(1));
		expect(await drain(second.queue, timers)).toBe(true);
		expect(rejecting.calls.length).toBe(2);
		// The reason names the failure class only, never the error text.
		expect(second.events).toEqual([
			{ type: "failed", sink: SINK, count: 1, reason: "transport rejected" },
			{ type: "dropped", sink: SINK, count: 1, reason: "transport rejected" },
		]);
	});

	test("a malformed transport result is a retryable failure and does not crash the pump", async () => {
		const timers = fakeTimers();
		const { transport } = scriptedTransport(() => Promise.resolve(undefined as unknown as SendResult));
		const { queue, events } = makeQueue(transport, timers, { maxAttempts: 1 });

		queue.enqueue(envelope(1));
		expect(await drain(queue, timers)).toBe(true);
		expect(events.map((event) => event.reason)).toEqual(["malformed transport result", "malformed transport result"]);
	});

	test("a send that outlives requestTimeoutMs is aborted and retried", async () => {
		const timers = fakeTimers();
		const { transport, calls } = scriptedTransport((_call, callNumber) =>
			callNumber === 1 ? hangingResult() : okResult(),
		);
		const { queue, events } = makeQueue(transport, timers, { maxAttempts: 2 });

		queue.enqueue(envelope(1));
		await yieldToEventLoop();
		expect(calls.length).toBe(1);
		expect(timers.count(REQUEST_TIMEOUT_MS)).toBe(1);

		timers.fire(REQUEST_TIMEOUT_MS);
		expect(calls[0]?.signal.aborted).toBe(true);

		expect(await drain(queue, timers)).toBe(true);
		expect(calls.length).toBe(2);
		expect(events).toEqual([{ type: "sent", sink: SINK, count: 1 }]);
	});

	test("flush resolves true at once when empty, and true after delivery", async () => {
		const timers = fakeTimers();
		const { transport, calls } = scriptedTransport(okResult);
		const { queue } = makeQueue(transport, timers);

		expect(await queue.flush(1)).toBe(true);
		expect(timers.count(1)).toBe(0);

		queue.enqueue(envelope(1));
		expect(await drain(queue, timers)).toBe(true);
		expect(calls.length).toBe(1);
	});

	test("flush resolves false when the transport never settles and the injected timer fires", async () => {
		const timers = fakeTimers();
		const { transport } = scriptedTransport(hangingResult);
		const { queue } = makeQueue(transport, timers);

		queue.enqueue(envelope(1));
		const outcome = queue.flush(1_000);
		expect(timers.count(1_000)).toBe(1);
		expect(timers.fire(1_000)).toBe(1);
		expect(await outcome).toBe(false);

		queue.close();
	});

	test("enqueue after close is counted as dropped and does not throw", async () => {
		const timers = fakeTimers();
		const { transport, calls } = scriptedTransport(okResult);
		const { queue, events } = makeQueue(transport, timers);

		queue.close();
		expect(() => queue.enqueue(envelope(1))).not.toThrow();
		expect(events).toEqual([{ type: "dropped", sink: SINK, count: 1, reason: "closed" }]);
		expect(calls.length).toBe(0);
		expect(await queue.flush(FLUSH_MS)).toBe(false);
	});

	test("close drops queued envelopes and the in-flight batch once each, and aborts the send", async () => {
		const timers = fakeTimers();
		const { transport, calls } = scriptedTransport(hangingResult);
		const { queue, events } = makeQueue(transport, timers, { maxBatch: 2 });

		queue.enqueue(envelope(1));
		queue.enqueue(envelope(2));
		queue.enqueue(envelope(3));
		await yieldToEventLoop();
		expect(calls.length).toBe(1);

		queue.close();
		expect(events).toEqual([{ type: "dropped", sink: SINK, count: 1, reason: "closed" }]);

		await yieldToEventLoop();
		expect(calls[0]?.signal.aborted).toBe(true);
		expect(events).toEqual([
			{ type: "dropped", sink: SINK, count: 1, reason: "closed" },
			{ type: "dropped", sink: SINK, count: 2, reason: "closed" },
		]);
		expect(queue.depth()).toBe(0);
	});

	test("a throwing onEvent observer never escapes enqueue or the pump", async () => {
		const timers = fakeTimers();
		const { transport, calls } = scriptedTransport(okResult);
		const { queue } = makeQueue(transport, timers, {
			capacity: 1,
			onEvent: () => {
				throw new Error("observer failed");
			},
		});

		expect(() => {
			queue.enqueue(envelope(1));
			queue.enqueue(envelope(2));
		}).not.toThrow();
		expect(await drain(queue, timers)).toBe(true);
		expect(calls.flatMap((call) => numbersOf(call.batch))).toEqual([2]);
	});

	test("invalid sizing is rejected with RangeError at construction", () => {
		const timers = fakeTimers();
		const { transport } = scriptedTransport(okResult);
		const base = { transport, backoffMs: () => BACKOFF_MS, requestTimeoutMs: REQUEST_TIMEOUT_MS, onEvent: () => {}, setTimer: timers.setTimer, clearTimer: timers.clearTimer };
		expect(() => createSinkQueue({ ...base, capacity: 0, maxBatch: 1, maxAttempts: 1 })).toThrow(RangeError);
		expect(() => createSinkQueue({ ...base, capacity: 1, maxBatch: 1.5, maxAttempts: 1 })).toThrow(RangeError);
		expect(() => createSinkQueue({ ...base, capacity: 1, maxBatch: 1, maxAttempts: 0 })).toThrow(RangeError);
	});
});
