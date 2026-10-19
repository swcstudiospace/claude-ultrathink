// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import type { Logger } from "./obs/log.ts";

export interface ShutdownDeps {
	/** Bun's `server.stop()`: stops accepting connections and resolves when in-flight requests are done. */
	server: { stop(): Promise<void> | void };
	app: { shutdown(): Promise<void> };
	store: { close(): void };
	logger: Logger;
	/** Longest a graceful shutdown may take before the process exits anyway. */
	timeoutMs: number;
	/** Runs `run` after `ms` and returns a canceller. Defaults to an unref'd timer; a test supplies its own. */
	schedule?: (run: () => void, ms: number) => () => void;
	exit: (code: number) => void;
}

export type Shutdown = (reason: string, code?: number) => Promise<void>;

export interface SignalSource {
	on(event: string, listener: (...args: unknown[]) => void): unknown;
}

function defaultSchedule(run: () => void, ms: number): () => void {
	const timer = setTimeout(run, ms);
	// The exit is explicit; a pending guard must not keep an otherwise finished process alive.
	timer.unref();
	return () => clearTimeout(timer);
}

/**
 * One shutdown for the whole process; later calls return the first one's promise.
 * `server.stop()` is started first and awaited last: ending the planner's jobs is what releases
 * long-polling requests, which the graceful stop is waiting for. The store closes only after both.
 */
export function createShutdown(deps: ShutdownDeps): Shutdown {
	const { server, app, store, logger } = deps;
	let running: Promise<void> | undefined;

	function run(reason: string, requested: number): Promise<void> {
		let finished = false;
		const finish = (code: number): void => {
			if (finished) return;
			finished = true;
			deps.exit(code);
		};
		let code = requested;
		const failedStep = (step: string, error: unknown): void => {
			logger.error("shutdown_error", { step, error });
			if (code === 0) code = 1;
		};

		logger.info("shutdown", { reason });
		const schedule = deps.schedule ?? defaultSchedule;
		const cancel = schedule(() => {
			logger.error("shutdown_timeout", { reason, timeoutMs: deps.timeoutMs });
			finish(code === 0 ? 1 : code);
		}, deps.timeoutMs);

		return (async () => {
			try {
				let stopped: Promise<void> = Promise.resolve();
				try {
					stopped = Promise.resolve(server.stop());
				} catch (error) {
					failedStep("server", error);
				}
				try {
					await app.shutdown();
				} catch (error) {
					failedStep("planner", error);
				}
				try {
					await stopped;
				} catch (error) {
					failedStep("server", error);
				}
				try {
					store.close();
				} catch (error) {
					failedStep("store", error);
				}
			} finally {
				cancel();
			}
			logger.info("stopped", { reason, code });
			finish(code);
		})();
	}

	return (reason, code = 0) => {
		running ??= run(reason, code);
		return running;
	};
}

/** Signals end the process cleanly; a crash logs its cause and ends it with a non-zero code. */
export function installProcessHandlers(shutdown: Shutdown, logger: Logger, source: SignalSource): void {
	source.on("SIGTERM", () => void shutdown("SIGTERM", 0));
	source.on("SIGINT", () => void shutdown("SIGINT", 0));
	source.on("unhandledRejection", (reason) => {
		logger.error("unhandled_rejection", { error: reason, stack: true });
		void shutdown("unhandledRejection", 1);
	});
	source.on("uncaughtException", (error) => {
		logger.error("uncaught_exception", { error, stack: true });
		void shutdown("uncaughtException", 1);
	});
}
