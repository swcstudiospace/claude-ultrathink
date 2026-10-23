// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

/**
 * Bounded, drop-oldest delivery queue in front of one {@link SinkTransport} (phase 68, CONTEXT D5).
 *
 * One pump loop per queue sends batches of at most `maxBatch` envelopes, in enqueue order, one batch at a time. A
 * slow or dead sink therefore fills only its own queue and never blocks the request path or another sink. `enqueue`
 * never throws and never calls the transport synchronously: the pump starts on a microtask.
 *
 * Failures: a retryable result, a synchronous throw, a rejection, or a send that outlives `requestTimeoutMs` is
 * retried after `backoffMs(attempt)` until `maxAttempts` total attempts. A non-retryable result is not retried. A
 * batch that is finally given up emits `failed` and then `dropped`. Timers are injected so tests never use the wall
 * clock.
 */

import type { SendResult, SinkEnvelope, SinkTransport } from "./types.ts";

export type SinkEventType = "sent" | "failed" | "dropped";

export interface SinkEvent {
	readonly type: SinkEventType;
	readonly sink: string;
	readonly count: number;
	readonly reason?: string;
}

export type SetTimer = (callback: () => void, ms: number) => unknown;
export type ClearTimer = (handle: unknown) => void;

export interface SinkQueueOptions {
	readonly transport: SinkTransport;
	/** Envelopes that may wait to be sent. Overflow drops the oldest one and emits `dropped` with reason `overflow`. */
	readonly capacity: number;
	/** Largest number of envelopes in one send. */
	readonly maxBatch: number;
	/** Total send attempts per batch, including the first. */
	readonly maxAttempts: number;
	/** Delay before the next attempt. `attempt` is the 1-based attempt that just failed. */
	readonly backoffMs: (attempt: number) => number;
	/** A send that has not settled after this many ms is aborted and counted as a retryable `timeout` failure. */
	readonly requestTimeoutMs: number;
	/** Receives every delivery, failure and drop. A throwing observer is ignored. */
	readonly onEvent: (event: SinkEvent) => void;
	readonly setTimer?: SetTimer;
	readonly clearTimer?: ClearTimer;
}

export interface SinkQueue {
	/** Queues one envelope. Never throws. */
	enqueue(envelope: SinkEnvelope): void;
	/** Resolves true once the queue is empty and nothing is in flight, false when `timeoutMs` passes first or the queue is closed. */
	flush(timeoutMs: number): Promise<boolean>;
	/** Envelopes waiting to be sent, not counting a batch in flight. */
	depth(): number;
	/** Stops the pump. Queued envelopes and an in-flight batch are dropped with reason `closed`; later enqueues are dropped too. */
	close(): void;
}

type Failure = Extract<SendResult, { ok: false }>;

const defaultSetTimer: SetTimer = (callback, ms) => setTimeout(callback, ms);
const defaultClearTimer: ClearTimer = (handle) => clearTimeout(handle as Timer);

function assertPositiveInteger(name: string, value: number): void {
	if (!Number.isInteger(value) || value < 1) {
		throw new RangeError(`${name} must be a positive integer, got ${value}`);
	}
}

/** Maps whatever a transport resolved with onto a SendResult. A malformed value is a retryable failure. */
function normalize(value: SendResult | undefined): SendResult {
	if (value?.ok === true) return { ok: true };
	if (value?.ok === false) return { ok: false, retryable: value.retryable, reason: value.reason };
	return { ok: false, retryable: true, reason: "malformed transport result" };
}

export function createSinkQueue(options: SinkQueueOptions): SinkQueue {
	const { transport, capacity, maxBatch, maxAttempts, backoffMs, requestTimeoutMs, onEvent } = options;
	const setTimer = options.setTimer ?? defaultSetTimer;
	const clearTimer = options.clearTimer ?? defaultClearTimer;
	const sink = transport.name;

	assertPositiveInteger("capacity", capacity);
	assertPositiveInteger("maxBatch", maxBatch);
	assertPositiveInteger("maxAttempts", maxAttempts);
	if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
		throw new RangeError(`requestTimeoutMs must be a positive number, got ${requestTimeoutMs}`);
	}

	// Pending envelopes are items[head..]. Dropping the oldest advances head, so no element shifts.
	let items: SinkEnvelope[] = [];
	let head = 0;
	let pumping = false;
	let closed = false;
	// Cancels the one wait the pump is in (an attempt or a backoff). Set only while that wait is pending.
	let interrupt: (() => void) | undefined;
	const idleWaiters = new Set<(idle: boolean) => void>();

	const emit = (event: SinkEvent): void => {
		try {
			onEvent(event);
		} catch {
			// An observer failure must never reach the record path.
		}
	};

	const compact = (): void => {
		if (head === items.length) {
			items = [];
			head = 0;
		} else if (head >= 1024 && head * 2 >= items.length) {
			items = items.slice(head);
			head = 0;
		}
	};

	const takeBatch = (): SinkEnvelope[] => {
		const end = Math.min(items.length, head + maxBatch);
		const batch = items.slice(head, end);
		head = end;
		compact();
		return batch;
	};

	const resolveIdle = (idle: boolean): void => {
		for (const waiter of [...idleWaiters]) waiter(idle);
	};

	const attempt = (batch: SinkEnvelope[]): Promise<SendResult> => {
		const { promise, resolve } = Promise.withResolvers<SendResult>();
		const controller = new AbortController();
		let settled = false;
		let timer: unknown;
		const settle = (result: SendResult): void => {
			if (settled) return;
			settled = true;
			interrupt = undefined;
			clearTimer(timer);
			resolve(result);
		};
		// Close aborts the request and settles it at once, so a transport that never answers cannot hang shutdown.
		interrupt = () => {
			controller.abort();
			settle({ ok: false, retryable: false, reason: "closed" });
		};
		timer = setTimer(() => {
			controller.abort();
			settle({ ok: false, retryable: true, reason: "timeout" });
		}, requestTimeoutMs);
		let pending: Promise<SendResult>;
		try {
			pending = transport.send(batch, controller.signal);
		} catch {
			settle({ ok: false, retryable: true, reason: "transport threw" });
			return promise;
		}
		Promise.resolve(pending).then(
			(result) => settle(normalize(result)),
			() => settle({ ok: false, retryable: true, reason: "transport rejected" }),
		);
		return promise;
	};

	const wait = (ms: number): Promise<void> => {
		const { promise, resolve } = Promise.withResolvers<void>();
		const timer = setTimer(() => {
			interrupt = undefined;
			resolve();
		}, ms);
		interrupt = () => {
			clearTimer(timer);
			interrupt = undefined;
			resolve();
		};
		return promise;
	};

	const giveUp = (count: number, failure: Failure): void => {
		emit({ type: "failed", sink, count, reason: failure.reason });
		emit({ type: "dropped", sink, count, reason: failure.reason });
	};

	const deliver = async (batch: SinkEnvelope[]): Promise<void> => {
		const count = batch.length;
		for (let n = 1; ; n++) {
			const result = await attempt(batch);
			if (result.ok) {
				emit({ type: "sent", sink, count });
				return;
			}
			if (closed) {
				emit({ type: "dropped", sink, count, reason: "closed" });
				return;
			}
			if (!result.retryable || n >= maxAttempts) {
				giveUp(count, result);
				return;
			}
			await wait(backoffMs(n));
			if (closed) {
				emit({ type: "dropped", sink, count, reason: "closed" });
				return;
			}
		}
	};

	const run = async (): Promise<void> => {
		try {
			while (!closed && items.length > head) {
				await deliver(takeBatch());
			}
		} finally {
			pumping = false;
			if (!closed && items.length === head) resolveIdle(true);
		}
	};

	return {
		enqueue(envelope: SinkEnvelope): void {
			if (closed) {
				emit({ type: "dropped", sink, count: 1, reason: "closed" });
				return;
			}
			let overflowed = false;
			if (items.length - head >= capacity) {
				head++;
				compact();
				overflowed = true;
			}
			items.push(envelope);
			if (!pumping) {
				pumping = true;
				queueMicrotask(() => {
					void run();
				});
			}
			if (overflowed) emit({ type: "dropped", sink, count: 1, reason: "overflow" });
		},
		flush(timeoutMs: number): Promise<boolean> {
			if (closed) return Promise.resolve(false);
			if (!pumping && items.length === head) return Promise.resolve(true);
			const { promise, resolve } = Promise.withResolvers<boolean>();
			const waiter = (idle: boolean): void => {
				clearTimer(timer);
				idleWaiters.delete(waiter);
				resolve(idle);
			};
			const timer = setTimer(() => {
				idleWaiters.delete(waiter);
				resolve(false);
			}, timeoutMs);
			idleWaiters.add(waiter);
			return promise;
		},
		depth(): number {
			return items.length - head;
		},
		close(): void {
			if (closed) return;
			closed = true;
			const dropped = items.length - head;
			items = [];
			head = 0;
			interrupt?.();
			resolveIdle(false);
			if (dropped > 0) emit({ type: "dropped", sink, count: dropped, reason: "closed" });
		},
	};
}
