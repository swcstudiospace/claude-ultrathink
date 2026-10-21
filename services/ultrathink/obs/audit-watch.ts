// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

/**
 * In-process tamper watch for the audit file (AUDIT-04, CONTEXT D6).
 *
 * Each tick compares the file's current fingerprint with the fingerprint the log wrote last. Writes made by the log
 * itself match and cost nothing. A different fingerprint triggers one full chain scan, which alerts when the chain is
 * broken or when the disk head differs from the acknowledged head. Every `fullScanEveryTicks` ticks a full scan runs
 * even when the fingerprint matches, which catches an in-place edit that keeps size, mtime and inode.
 * A tick whose fingerprint matches the acknowledged one never clears an alert; only a full scan that comes back healthy does.
 *
 * The watch never writes to the chain. Alerts go to `onAlert`; the caller decides where they land.
 * `stat`, `acknowledged` and `scan` are expected not to throw.
 */

/** Identity of the audit file as seen by `stat`. Any change to one field is a change to the file. */
export interface Fingerprint {
	readonly size: number;
	readonly mtimeMs: number;
	readonly ino: number;
}

export type ScanOutcome = { readonly ok: true; readonly records: number; readonly lastHash: string } | { readonly ok: false; readonly records: number; readonly brokenAt: number; readonly reason: string };

export interface WatchAlert {
	readonly kind: "chain_broken" | "head_mismatch";
	readonly reason: string;
}

/** The head the log has acknowledged: the fingerprint it left after its last write, and the last record's seq and hash. */
export interface Acknowledged {
	readonly fingerprint: Fingerprint | undefined;
	readonly seq: number;
	readonly hash: string;
}

export interface AuditWatchOptions {
	readonly intervalMs: number;
	/** Full scan cadence in ticks, regardless of the fingerprint. Defaults to 60. */
	readonly fullScanEveryTicks?: number;
	readonly stat: () => Fingerprint | undefined;
	readonly acknowledged: () => Acknowledged;
	readonly scan: () => ScanOutcome;
	readonly onAlert: (alert: WatchAlert) => void;
	/** Called once when an alerting condition clears. */
	readonly onRecover?: () => void;
	/** Defaults to an unref'd `setInterval`. */
	readonly setTimer?: (run: () => void, intervalMs: number) => object;
	/** Cancels a handle returned by `setTimer`; defaults to `clearInterval`. */
	readonly clearTimer?: (handle: object) => void;
}

export interface AuditWatch {
	/** Starts the periodic tick. Returns an idempotent stop function. */
	start(): () => void;
	/** Runs one tick. Exposed so tests and the timer share one code path. */
	tick(): void;
}

const MIN_INTERVAL_MS = 100;
const MAX_INTERVAL_MS = 1000;
const DEFAULT_FULL_SCAN_TICKS = 60;

function realSetTimer(run: () => void, intervalMs: number): object {
	const timer = setInterval(run, intervalMs);
	timer.unref();
	return timer;
}

function sameFingerprint(a: Fingerprint | undefined, b: Fingerprint | undefined): boolean {
	return a !== undefined && b !== undefined && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ino === b.ino;
}

/**
 * Compares a full scan with the acknowledged head. Returns the condition, or undefined when the file is healthy. The head
 * is compared by hash only: the hash commits to the record's seq, while the retained record count stops equalling the
 * global seq once a prune has removed segments.
 */
function judge(outcome: ScanOutcome, ack: Acknowledged): WatchAlert | undefined {
	if (!outcome.ok) return { kind: "chain_broken", reason: `chain broken at record ${outcome.brokenAt}: ${outcome.reason}` };
	if (outcome.lastHash !== ack.hash) return { kind: "head_mismatch", reason: `last record on disk is not the acknowledged head, record ${ack.seq}` };
	return undefined;
}

export function createAuditWatch(options: AuditWatchOptions): AuditWatch {
	const { intervalMs, stat, acknowledged, scan, onAlert } = options;
	if (!Number.isInteger(intervalMs) || intervalMs < MIN_INTERVAL_MS || intervalMs > MAX_INTERVAL_MS) {
		throw new RangeError(`audit watch interval must be an integer ${MIN_INTERVAL_MS}..${MAX_INTERVAL_MS} ms`);
	}
	const fullScanEvery = options.fullScanEveryTicks ?? DEFAULT_FULL_SCAN_TICKS;
	if (!Number.isInteger(fullScanEvery) || fullScanEvery < 1) throw new RangeError("audit watch fullScanEveryTicks must be a positive integer");
	const setTimer = options.setTimer ?? realSetTimer;
	const clearTimer = options.clearTimer ?? ((handle: object) => clearInterval(handle as NodeJS.Timeout));

	let ticks = 0;
	/** Fingerprint of the file the last time its state was decided. A repeat of it means nothing has changed. */
	let decided: Fingerprint | undefined;
	let active: WatchAlert | undefined;
	let handle: object | undefined;

	// Alerts once per distinct reason. A cleared condition fires onRecover once.
	const apply = (condition: WatchAlert | undefined): void => {
		if (condition === undefined) {
			if (active !== undefined) {
				active = undefined;
				options.onRecover?.();
			}
			return;
		}
		if (active?.reason === condition.reason) return;
		active = condition;
		onAlert(condition);
	};

	const tick = (): void => {
		ticks += 1;
		const current = stat();
		const ack = acknowledged();

		const fullScan = ticks % fullScanEvery === 0;
		if (current === undefined) {
			decided = undefined;
			// A missing file is a condition only when records were acknowledged. Clearing a standing alert is a full-scan decision.
			if (ack.seq > 0) apply({ kind: "head_mismatch", reason: `audit file is missing; acknowledged head is record ${ack.seq}` });
			else if (fullScan) apply(undefined);
			return;
		}

		if (!fullScan) {
			// The log's own last write: nothing changed since it acknowledged the head. It is not a full scan, so it never clears an alert.
			if (sameFingerprint(current, ack.fingerprint)) {
				decided = current;
				return;
			}
			// Already decided for this exact state; a persisting condition does not re-alert.
			if (sameFingerprint(current, decided)) return;
		}

		decided = current;
		apply(judge(scan(), ack));
	};

	return {
		start(): () => void {
			if (handle === undefined) handle = setTimer(tick, intervalMs);
			return () => {
				if (handle === undefined) return;
				clearTimer(handle);
				handle = undefined;
			};
		},
		tick,
	};
}
