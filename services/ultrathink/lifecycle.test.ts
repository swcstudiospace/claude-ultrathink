// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { type Shutdown, createShutdown, installProcessHandlers } from "./lifecycle.ts";
import { createLogger } from "./obs/log.ts";

type LogLine = Record<string, unknown>;

interface Guard {
	ms: number;
	cancelled: boolean;
	fire: () => void;
}

interface Rig {
	shutdown: Shutdown;
	steps: string[];
	exits: number[];
	logs: LogLine[];
	guards: Guard[];
}

interface RigOptions {
	stop?: () => Promise<void> | void;
	appShutdown?: () => Promise<void>;
	close?: () => void;
}

function rig(options: RigOptions = {}): Rig {
	const steps: string[] = [];
	const exits: number[] = [];
	const logs: LogLine[] = [];
	const guards: Guard[] = [];
	const shutdown = createShutdown({
		server: {
			stop() {
				steps.push("stop");
				return options.stop?.();
			},
		},
		app: {
			async shutdown() {
				steps.push("app");
				await options.appShutdown?.();
			},
		},
		store: {
			close() {
				steps.push("close");
				options.close?.();
			},
		},
		logger: createLogger({ write: (line) => logs.push(JSON.parse(line) as LogLine) }),
		timeoutMs: 5000,
		// The guard is driven by hand: the test fires it instead of waiting for it.
		schedule: (run, ms) => {
			const guard: Guard = { ms, cancelled: false, fire: run };
			guards.push(guard);
			return () => {
				guard.cancelled = true;
			};
		},
		exit: (code) => {
			steps.push("exit");
			exits.push(code);
		},
	});
	return { shutdown, steps, exits, logs, guards };
}

describe("createShutdown", () => {
	test("stops the server, ends the planner, closes the store, logs and exits 0, in that order", async () => {
		const r = rig();
		await r.shutdown("SIGTERM");
		expect(r.steps).toEqual(["stop", "app", "close", "exit"]);
		expect(r.exits).toEqual([0]);
		expect(r.logs.map((line) => line.event)).toEqual(["shutdown", "stopped"]);
		expect(r.logs[0]).toMatchObject({ reason: "SIGTERM" });
	});

	test("waits for the server to finish draining before it closes the store and exits", async () => {
		const drain = Promise.withResolvers<void>();
		const r = rig({ stop: () => drain.promise });
		const done = r.shutdown("SIGTERM");
		// The planner is told to stop while the server drains: that is what releases long-polling requests.
		expect(r.steps).toEqual(["stop", "app"]);
		expect(r.exits).toEqual([]);
		drain.resolve();
		await done;
		expect(r.steps).toEqual(["stop", "app", "close", "exit"]);
	});

	test("runs once however often it is called", async () => {
		const r = rig();
		const first = r.shutdown("SIGTERM", 0);
		const second = r.shutdown("SIGINT", 1);
		expect(second).toBe(first);
		await first;
		expect(r.steps.filter((step) => step === "stop")).toHaveLength(1);
		expect(r.exits).toEqual([0]);
	});

	test("keeps its requested non-zero code", async () => {
		const r = rig();
		await r.shutdown("uncaughtException", 1);
		expect(r.exits).toEqual([1]);
	});

	test("a failing step is logged, the store still closes, and the exit code is non-zero", async () => {
		const r = rig({
			appShutdown: async () => {
				throw new Error("planner would not stop");
			},
		});
		await r.shutdown("SIGTERM");
		expect(r.steps).toEqual(["stop", "app", "close", "exit"]);
		expect(r.exits).toEqual([1]);
		const failure = r.logs.find((line) => line.event === "shutdown_error");
		expect(failure).toMatchObject({ step: "planner", error: { name: "Error", message: "planner would not stop" } });
	});

	test("a failing store close is logged and does not stop the exit", async () => {
		const r = rig({
			close: () => {
				throw new Error("disk gone");
			},
		});
		await r.shutdown("SIGTERM");
		expect(r.exits).toEqual([1]);
		expect(r.logs.some((line) => line.event === "shutdown_error" && line.step === "store")).toBe(true);
	});

	test("a shutdown that hangs is cut off by the timeout guard, once", async () => {
		const hang = Promise.withResolvers<void>();
		const r = rig({ appShutdown: () => hang.promise });
		const done = r.shutdown("SIGTERM");
		expect(r.guards).toHaveLength(1);
		r.guards[0]?.fire();
		expect(r.exits).toEqual([1]);
		expect(r.logs.some((line) => line.event === "shutdown_timeout")).toBe(true);
		// The step that finally finishes does not exit a second time.
		hang.resolve();
		await done;
		expect(r.exits).toEqual([1]);
	});

	test("a clean shutdown cancels its timeout guard", async () => {
		const r = rig();
		await r.shutdown("SIGTERM");
		expect(r.guards).toHaveLength(1);
		expect(r.guards[0]?.cancelled).toBe(true);
	});
});

describe("installProcessHandlers", () => {
	function handlers(): { source: EventEmitter; calls: Array<[string, number | undefined]>; logs: LogLine[] } {
		const source = new EventEmitter();
		const calls: Array<[string, number | undefined]> = [];
		const logs: LogLine[] = [];
		const logger = createLogger({ write: (line) => logs.push(JSON.parse(line) as LogLine) });
		installProcessHandlers(
			async (reason, code) => {
				calls.push([reason, code]);
			},
			logger,
			source,
		);
		return { source, calls, logs };
	}

	test("SIGTERM and SIGINT shut down cleanly", () => {
		const { source, calls } = handlers();
		source.emit("SIGTERM");
		source.emit("SIGINT");
		expect(calls).toEqual([
			["SIGTERM", 0],
			["SIGINT", 0],
		]);
	});

	test("an unhandled rejection or uncaught exception logs its cause and shuts down non-zero", () => {
		const { source, calls, logs } = handlers();
		source.emit("unhandledRejection", new Error("lost promise"));
		source.emit("uncaughtException", new Error("thrown"));
		expect(calls).toEqual([
			["unhandledRejection", 1],
			["uncaughtException", 1],
		]);
		expect(logs.map((line) => line.event)).toEqual(["unhandled_rejection", "uncaught_exception"]);
		expect(logs[0]).toMatchObject({ level: "error", error: { name: "Error", message: "lost promise" } });
		expect(logs[1]).toMatchObject({ level: "error", error: { name: "Error", message: "thrown" } });
	});

	test("a rejection with a non-error reason is still logged", () => {
		const { source, calls, logs } = handlers();
		source.emit("unhandledRejection", "plain string");
		expect(calls).toEqual([["unhandledRejection", 1]]);
		expect(logs[0]).toMatchObject({ event: "unhandled_rejection", error: "plain string" });
	});
});
