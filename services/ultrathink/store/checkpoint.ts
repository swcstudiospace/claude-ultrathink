// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/** Periodic `PRAGMA wal_checkpoint` for the store. Timers are injectable, as in the retention sweeper, so tests drive the schedule. */

export interface WalCheckpointerOptions {
	/** Runs one checkpoint. `Store.checkpoint` never throws and reports a busy result as `ok: false`. */
	checkpoint: () => { ok: boolean };
	intervalMs: number;
	/** Called when a checkpoint was blocked by a reader or writer; the next tick tries again. */
	onBlocked?: () => void;
	/** Timer factory for tests; defaults to an unref'd `setInterval`. */
	setTimer?: (run: () => void, intervalMs: number) => object;
	/** Cancels a handle from `setTimer`; defaults to `clearInterval`. */
	clearTimer?: (handle: object) => void;
}

export interface WalCheckpointer {
	/** Schedules a checkpoint every `intervalMs` and returns an idempotent stop. A second `start()` while running changes nothing. */
	start(): () => void;
}

function defaultSetTimer(run: () => void, intervalMs: number): object {
	const timer = setInterval(run, intervalMs);
	timer.unref();
	return timer;
}

export function createWalCheckpointer(options: WalCheckpointerOptions): WalCheckpointer {
	if (typeof options.checkpoint !== "function") throw new TypeError("wal checkpoint: checkpoint must be a function");
	if (!Number.isFinite(options.intervalMs) || options.intervalMs <= 0) {
		throw new RangeError("wal checkpoint: intervalMs must be a positive finite number");
	}
	const setTimer = options.setTimer ?? defaultSetTimer;
	const clearTimer = options.clearTimer ?? ((handle: object) => clearInterval(handle as NodeJS.Timeout));
	let handle: object | undefined;
	const stop = (): void => {
		if (handle === undefined) return;
		clearTimer(handle);
		handle = undefined;
	};
	return {
		start() {
			handle ??= setTimer(() => {
				if (!options.checkpoint().ok) options.onBlocked?.();
			}, options.intervalMs);
			return stop;
		},
	};
}
