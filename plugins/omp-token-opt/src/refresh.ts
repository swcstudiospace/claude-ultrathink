export interface RefreshClock {
	now?: () => number;
	/** Starts a timer and returns a function that cancels it. */
	setTimer?: (run: () => void, ms: number) => () => void;
}

/**
 * Wraps a read so that at most one runs at a time and hook-driven calls start at most one per `minMs`.
 * A call that is skipped (a read is in flight, or the window has not ended) schedules one trailing read for the end of
 * the window, so a change that arrives while the window is closed is still read when the calls stop.
 * `force` starts a read now unless one is already in flight, and returns it.
 */
export function createTrailingRefresh(read: () => Promise<void>, minMs: number, clock: RefreshClock = {}): (force?: boolean) => Promise<void> {
	const now = clock.now ?? Date.now;
	const setTimer =
		clock.setTimer ??
		((run: () => void, ms: number): (() => void) => {
			const handle = setTimeout(run, ms);
			handle.unref?.();
			return () => clearTimeout(handle);
		});

	let inFlight: Promise<void> | null = null;
	let lastAt = 0;
	let skipped = false;
	let cancelTimer: (() => void) | null = null;

	function start(): Promise<void> {
		skipped = false;
		inFlight = read()
			.catch(() => {})
			.finally(() => {
				inFlight = null;
				lastAt = now();
				if (skipped) schedule();
			});
		return inFlight;
	}

	function schedule(): void {
		if (cancelTimer !== null) return;
		cancelTimer = setTimer(
			() => {
				cancelTimer = null;
				if (inFlight === null) void start();
				else skipped = true;
			},
			Math.max(0, lastAt + minMs - now()),
		);
	}

	return (force = false) => {
		if (inFlight !== null) {
			if (!force) skipped = true;
			return inFlight;
		}
		if (!force && now() - lastAt < minMs) {
			skipped = true;
			schedule();
			return Promise.resolve();
		}
		if (cancelTimer !== null) {
			cancelTimer();
			cancelTimer = null;
		}
		return start();
	};
}
