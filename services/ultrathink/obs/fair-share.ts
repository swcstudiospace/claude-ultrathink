// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

// Weighted admission for a bounded pool (Phase 70, RATE-03).
//
// Priority classes: `owner` may take any free slot; `connector` and `bearer` may not take the last `reserve`
// slots and may not hold more than `perPrincipalMax` slots per principal.
//
// `acquire` refuses at once. `admit` waits instead: an over-budget admission joins a bounded FIFO queue for its
// class, and a freed slot goes to the head of the highest-priority class whose head fits the budget. A waiter is
// granted in arrival order within its class. An admission that fits takes a free slot at once, even when a waiter of
// its class is blocked by its own principal cap. A full queue refuses at once; an expired or aborted wait leaves the
// queue. Refusals and expiries are reported to the security logger when one is given.
//
// Construction throws `RangeError` for invalid options.

import type { SecurityEventLogger } from "../security/events.ts";

/** Priority class of an admitted request. `owner` > `connector` > `bearer`. */
export type AdmissionClass = "owner" | "connector" | "bearer";

/** Who is asking for a slot and at which priority. */
export interface Admission {
	principal: string;
	class: AdmissionClass;
}

/** Timer seam for queued waits. Defaults to the global timers. */
export interface FairShareTimers {
	setTimeout(run: () => void, ms: number): unknown;
	clearTimeout(handle: unknown): void;
}

export interface FairShareQueue {
	/** Waiting admissions per class. Integer `>= 0`; 0 refuses at once. */
	depth: number;
	/** Longest wait before the admission expires, in ms. Positive safe integer. */
	waitMs: number;
	/** Test seam. Defaults to the global timers. */
	timers?: FairShareTimers;
}

export interface FairShareOptions {
	/** Total slots. Positive safe integer. */
	capacity: number;
	/** Slots non-owner classes may not take. Integer, `0 <= reserve < capacity`. */
	reserve: number;
	/** Slots one non-owner principal may hold. Integer `1..capacity`; default `capacity`. */
	perPrincipalMax?: number;
	/** Waiting room for `admit`. Absent means nothing waits. */
	queue?: FairShareQueue;
	/** Receives one rate-limit event per refusal and per expired wait. Absent means no events. */
	security?: SecurityEventLogger;
}

/** Why a slot was refused. Checked in this order. */
export type FairShareRefusal = "capacity" | "reserved" | "principal";

/**
 * Outcome of `admit`. `queue_full`: over budget with no room to wait. `expired`: the wait ran out.
 * `aborted`: the caller's signal fired first, or was already fired; no reason is reported.
 */
export type AdmitResult =
	| { ok: true; release: () => void }
	| { ok: false; reason: FairShareRefusal; cause: "queue_full" | "expired" }
	| { ok: false; cause: "aborted" };

/** Options for `admit`. `onWait` runs once, just before an admission joins its queue; it must not release pool slots. */
export interface AdmitOptions {
	signal?: AbortSignal;
	onWait?: () => void;
}

export interface FairShare {
	/**
	 * Try to take one slot without waiting. Refusal changes nothing. The returned `release` frees the slot;
	 * calling it again on the same handle frees nothing.
	 */
	acquire(admission: Admission): { ok: true; release: () => void } | { ok: false; reason: FairShareRefusal };
	/**
	 * Take one slot, waiting in the class queue when over budget. Resolves once: admitted, refused, expired or aborted.
	 * A waiter is removed from its queue as soon as it settles, and its timer is cleared.
	 */
	admit(admission: Admission, options?: AdmitOptions): Promise<AdmitResult>;
	/** Slots currently held across all principals and classes. */
	readonly held: number;
	/** Admissions currently waiting across all classes. */
	readonly queued: number;
}

interface Waiter {
	admission: Admission;
	signal: AbortSignal | undefined;
	timer: unknown;
	onAbort: () => void;
	resolve: (result: AdmitResult) => void;
}

/** Highest priority first. The order in which freed slots are handed out. */
const CLASS_ORDER: readonly AdmissionClass[] = ["owner", "connector", "bearer"];

const DEFAULT_TIMERS: FairShareTimers = {
	setTimeout: (run, ms) => setTimeout(run, ms),
	clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

/** Create a fair-share pool. Throws `RangeError` on invalid options. */
export function createFairShare(options: FairShareOptions): FairShare {
	const { capacity, reserve } = options;
	const perPrincipalMax = options.perPrincipalMax ?? capacity;
	if (!Number.isSafeInteger(capacity) || capacity <= 0) {
		throw new RangeError(`createFairShare: capacity must be a positive safe integer, got ${String(capacity)}`);
	}
	if (!Number.isSafeInteger(reserve) || reserve < 0 || reserve >= capacity) {
		throw new RangeError(`createFairShare: reserve must be an integer in 0..${capacity - 1}, got ${String(reserve)}`);
	}
	if (!Number.isSafeInteger(perPrincipalMax) || perPrincipalMax < 1 || perPrincipalMax > capacity) {
		throw new RangeError(
			`createFairShare: perPrincipalMax must be an integer in 1..${capacity}, got ${String(perPrincipalMax)}`,
		);
	}
	const queue = options.queue;
	if (queue !== undefined && (!Number.isSafeInteger(queue.depth) || queue.depth < 0)) {
		throw new RangeError(`createFairShare: queue.depth must be a non-negative safe integer, got ${String(queue.depth)}`);
	}
	if (queue !== undefined && (!Number.isSafeInteger(queue.waitMs) || queue.waitMs < 1)) {
		throw new RangeError(`createFairShare: queue.waitMs must be a positive safe integer, got ${String(queue.waitMs)}`);
	}
	const depth = queue?.depth ?? 0;
	const waitMs = queue?.waitMs ?? 0;
	const timers = queue?.timers ?? DEFAULT_TIMERS;
	const security = options.security;

	let held = 0;
	const heldByPrincipal = new Map<string, number>();
	const waiting: Record<AdmissionClass, Waiter[]> = { owner: [], connector: [], bearer: [] };

	/** The first refusal rule the admission fails right now, or undefined when it fits the budget. */
	function blockedBy(admission: Admission): FairShareRefusal | undefined {
		if (held >= capacity) return "capacity";
		const owner = admission.class === "owner";
		if (!owner && held >= capacity - reserve) return "reserved";
		if (!owner && (heldByPrincipal.get(admission.principal) ?? 0) >= perPrincipalMax) return "principal";
		return undefined;
	}

	/** Takes a slot the admission already fits. Must only be called after `blockedBy` returned undefined. */
	function take(admission: Admission): () => void {
		held++;
		heldByPrincipal.set(admission.principal, (heldByPrincipal.get(admission.principal) ?? 0) + 1);
		let released = false;
		return () => {
			if (released) return;
			released = true;
			held--;
			const remaining = (heldByPrincipal.get(admission.principal) ?? 1) - 1;
			if (remaining > 0) heldByPrincipal.set(admission.principal, remaining);
			else heldByPrincipal.delete(admission.principal);
			admitWaiters();
		};
	}

	/** Hands freed slots to waiters: the head of the highest class that fits, again and again until none does. */
	function admitWaiters(): void {
		let granted = true;
		while (granted) {
			granted = false;
			for (const cls of CLASS_ORDER) {
				const head = waiting[cls][0];
				if (head === undefined || blockedBy(head.admission) !== undefined) continue;
				waiting[cls].shift();
				finish(head, { ok: true, release: take(head.admission) });
				granted = true;
				break;
			}
		}
	}

	/** Settles a waiter: clears its timer, drops its abort listener, then resolves. */
	function finish(waiter: Waiter, result: AdmitResult): void {
		timers.clearTimeout(waiter.timer);
		waiter.signal?.removeEventListener("abort", waiter.onAbort);
		waiter.resolve(result);
	}

	/** Removes a waiter from its queue. False when it already left (settled by another path). */
	function removeWaiter(waiter: Waiter): boolean {
		const line = waiting[waiter.admission.class];
		const index = line.indexOf(waiter);
		if (index < 0) return false;
		line.splice(index, 1);
		return true;
	}

	function report(admission: Admission, reason: FairShareRefusal, cause: "budget" | "queue_full" | "expired"): void {
		security?.logRateLimitExceeded({
			name: "rate_limit.fair_share_refused",
			details: { class: admission.class, reason, cause },
		});
	}

	return {
		get held() {
			return held;
		},
		get queued() {
			return CLASS_ORDER.reduce((count, cls) => count + waiting[cls].length, 0);
		},
		acquire(admission) {
			const blocked = blockedBy(admission);
			if (blocked !== undefined) {
				report(admission, blocked, "budget");
				return { ok: false, reason: blocked };
			}
			return { ok: true, release: take(admission) };
		},
		admit(admission, admitOptions: AdmitOptions = {}) {
			const signal = admitOptions.signal;
			if (signal?.aborted) return Promise.resolve({ ok: false, cause: "aborted" });
			const blocked = blockedBy(admission);
			if (blocked === undefined) return Promise.resolve({ ok: true, release: take(admission) });

			const line = waiting[admission.class];
			if (line.length >= depth) {
				report(admission, blocked, "queue_full");
				return Promise.resolve({ ok: false, reason: blocked, cause: "queue_full" });
			}
			admitOptions.onWait?.();
			return new Promise<AdmitResult>((resolve) => {
				const onAbort = (): void => {
					if (!removeWaiter(waiter)) return;
					finish(waiter, { ok: false, cause: "aborted" });
					admitWaiters();
				};
				const timer = timers.setTimeout(() => {
					if (!removeWaiter(waiter)) return;
					report(admission, blocked, "expired");
					finish(waiter, { ok: false, reason: blocked, cause: "expired" });
					admitWaiters();
				}, waitMs);
				const waiter: Waiter = { admission, signal, timer, onAbort, resolve };
				signal?.addEventListener("abort", onAbort, { once: true });
				line.push(waiter);
			});
		},
	};
}
