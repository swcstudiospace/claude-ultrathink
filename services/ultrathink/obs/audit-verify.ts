// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

/**
 * The tamper watch's full chain scan, kept off the request thread (AUDIT-04). `verifyObserved` checks the chain as one
 * observed state of the audit file; `createAuditVerifier` runs it in a worker thread, so a year of retained history is
 * hashed without pausing a request.
 *
 * The log keeps appending while a scan runs. The active file is therefore read only up to the size the watch observed,
 * and a scan is discarded (reported as `raced`) when the chain's identity moves under it: a rotation, a prune, or the
 * active file being replaced. A discarded scan decides nothing, so a real change is judged on the next scan.
 */

import * as nodeFs from "node:fs";
import { verifyAuditFile } from "./audit.ts";
import { listSegments } from "./audit-segments.ts";
import type { ScanReply } from "./audit-watch.ts";

/**
 * One observed state of the audit file. `activeBytes` and `activeIno` are the active file as the watch stat'd it; `identity`
 * is {@link chainIdentity} captured in the same synchronous step, so the sealed segments and the active bytes describe one moment.
 */
export interface VerifyRequest {
	readonly path: string;
	readonly activeBytes: number;
	readonly activeIno: number;
	readonly identity: string;
}

/** The identity of the chain on disk: the active file's inode, then the names of its sealed segments, in order. */
export function chainIdentity(path: string): string {
	let ino = "missing";
	try {
		ino = String(nodeFs.statSync(path).ino);
	} catch {
		// Absent: the identity records that, and it never matches an observed active file.
	}
	return `${ino}\n${listSegments(path, nodeFs).map((segment) => segment.name).join("\n")}`;
}

/**
 * Verifies the chain as the watch observed it. The chain must still have the identity captured with the observed bytes: a
 * prune or a new sealed segment in between changes the records the observed bytes stand for, so the scan is raced, not judged.
 * The verdict stands only if the identity is also unchanged after the scan.
 */
export function verifyObserved(request: VerifyRequest): ScanReply {
	if (chainIdentity(request.path) !== request.identity) return "raced";
	if (!request.identity.startsWith(`${request.activeIno}\n`)) return "raced";
	const outcome = verifyAuditFile(request.path, { activeBytes: request.activeBytes });
	return chainIdentity(request.path) === request.identity ? outcome : "raced";
}

/** How long one scan may run before it is abandoned and its worker terminated. */
export const DEFAULT_VERIFY_DEADLINE_MS = 120_000;

export interface AuditVerifierOptions {
	/** Worker entry. Defaults to `audit-verify.worker.ts` beside this module. */
	readonly workerUrl?: URL;
	/** Longest one scan may run before it fails with a timeout. Defaults to {@link DEFAULT_VERIFY_DEADLINE_MS}. */
	readonly deadlineMs?: number;
	/** Starts a worker for a URL. Defaults to `new Worker(url)`; a test passes a stand-in to make dispatch fail or hang. */
	readonly createWorker?: (url: URL) => Worker;
	/** Arms the deadline. Defaults to `setTimeout`; a test passes a fake so the deadline fires when the test says so. */
	readonly setTimer?: (run: () => void, ms: number) => object;
	/** Cancels a deadline armed by `setTimer`. Defaults to `clearTimeout`. */
	readonly clearTimer?: (handle: object) => void;
}

export interface AuditVerifier {
	/**
	 * Verifies one observed state; requests run one at a time. Resolves with the verdict, or `raced` once the verifier is
	 * closed. Rejects when the worker fails, cannot be started, or does not answer within the deadline. A rejected worker is
	 * terminated, and the next request starts a new one.
	 */
	verify(request: VerifyRequest): Promise<ScanReply>;
	/** Stops the worker. A request in flight resolves `raced`: no verdict is made on an unfinished scan. */
	close(): void;
}

type Outcome = { readonly reply: ScanReply } | { readonly error: Error };

/**
 * Runs `verifyObserved` in a worker thread, started on the first request. A worker that fails or never answers fails its
 * request instead of holding the watch, so the next tick can scan again.
 */
export function createAuditVerifier(options: AuditVerifierOptions = {}): AuditVerifier {
	const workerUrl = options.workerUrl ?? new URL("./audit-verify.worker.ts", import.meta.url);
	const deadlineMs = options.deadlineMs ?? DEFAULT_VERIFY_DEADLINE_MS;
	const createWorker = options.createWorker ?? ((url: URL) => new Worker(url));
	const setTimer = options.setTimer ?? ((run: () => void, ms: number) => setTimeout(run, ms));
	const clearTimer = options.clearTimer ?? ((handle: object) => clearTimeout(handle as NodeJS.Timeout));
	let worker: Worker | undefined;
	let closed = false;
	/** Settles the request in flight; undefined when none is in flight. */
	let settle: ((outcome: Outcome) => void) | undefined;
	let queue: Promise<unknown> = Promise.resolve();

	const stopWorker = (): void => {
		worker?.terminate();
		worker = undefined;
	};

	const spawn = (): Worker => {
		const next = createWorker(workerUrl);
		next.onmessage = (event: MessageEvent<ScanReply>) => {
			if (worker === next) settle?.({ reply: event.data });
		};
		next.onerror = (event: ErrorEvent) => {
			if (worker !== next) return;
			stopWorker();
			settle?.({ error: new Error(`worker failed: ${event.message}`) });
		};
		return next;
	};

	const run = (request: VerifyRequest): Promise<ScanReply> =>
		new Promise<ScanReply>((resolve, reject) => {
			if (closed) {
				resolve("raced");
				return;
			}
			const timer = setTimer(() => {
				// A worker that never answers is terminated, so it cannot hold the next scan or keep a thread running.
				stopWorker();
				settle?.({ error: new Error(`timed out after ${deadlineMs} ms`) });
			}, deadlineMs);
			settle = (outcome) => {
				clearTimer(timer);
				settle = undefined;
				if ("error" in outcome) reject(outcome.error);
				else resolve(outcome.reply);
			};
			try {
				worker ??= spawn();
				worker.postMessage(request);
			} catch (error) {
				// The dispatch failed, so this request is over: its timer and settle hook must not outlive it. A stale timer
				// would otherwise terminate, or reject, whichever request runs next.
				clearTimer(timer);
				settle = undefined;
				stopWorker();
				reject(error);
			}
		});

	return {
		verify(request) {
			const next = queue.then(() => run(request));
			queue = next.catch(() => undefined);
			return next;
		},
		close() {
			closed = true;
			stopWorker();
			settle?.({ reply: "raced" });
		},
	};
}
