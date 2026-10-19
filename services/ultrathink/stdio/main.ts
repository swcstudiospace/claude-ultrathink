// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

/**
 * Entry point of the local stdio connector (bin/ultrathink-connector): the connector's client-driven surface for one
 * client over stdin and stdout. There is no planner, no OAuth and no network: the client's own model does the
 * planning through the same tools the hosted connector offers. stdout carries JSON-RPC lines and nothing else.
 */

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { detectHost } from "../../../src/host/detect.ts";
import { isPlanningPath, stateDirForHost } from "../../../src/host/paths.ts";
import { defaultGraphResources, loadCatalogWithFallback } from "../mcp/connector-host.ts";
import type { McpToolHost, ToolOutcome } from "../mcp/mcp.ts";
import { createToolHost } from "../mcp/tool-host.ts";
import { type LogLevel, type Logger, createLogger } from "../obs/log.ts";
import { serveStdio } from "./server.ts";

/** The hosted connector's defaults (config.ts), so a prompt or answer is accepted or refused the same way on both. */
const MAX_PROMPT_CHARS = 8000;
const MAX_ANSWER_CHARS = 20000;
/** A signal must end the process within 2 s; this leaves room for the exit itself. */
const SIGNAL_EXIT_MS = 1500;

type Env = Record<string, string | undefined>;

/** ULTRATHINK_STATE_DIR, else the connector directory under the host's state directory (never inside a planning tree). */
export function resolveConnectorStateDir(env: Env = process.env): string {
	const override = env.ULTRATHINK_STATE_DIR?.trim();
	if (override && !isPlanningPath(override)) return override;
	return join(stateDirForHost(detectHost(env), env), "connector");
}

export function logLevelFrom(env: Env = process.env): LogLevel {
	const level = env.ULTRATHINK_LOG_LEVEL?.trim().toLowerCase();
	return level === "info" || level === "warn" || level === "error" ? level : "warn";
}

/** The tool host without a planner, behind the same failure handling as the HTTP router's. */
export function createStdioHost(stateDir: string, logger: Logger): McpToolHost {
	const catalog = loadCatalogWithFallback((error) => logger.warn("command_catalog_fallback", { error }));
	const toolHost = createToolHost({
		journalOpts: { stateDir, maxPromptChars: MAX_PROMPT_CHARS, maxAnswerChars: MAX_ANSWER_CHARS },
		catalog,
		resources: defaultGraphResources(),
	});
	return {
		capabilities: toolHost.capabilities,
		resources: toolHost.resources,
		async call(name, args) {
			let outcome: ToolOutcome;
			try {
				outcome = await toolHost.call(name, args);
			} catch (error) {
				// The class only: a message may quote arguments.
				logger.error("tool_error", { tool: name, error: error instanceof Error ? error.name : "UnknownError" });
				outcome = { ok: false, code: "engine_error" };
			}
			logger.info("tool_call", { tool: name, outcome: outcome.ok ? "ok" : "error" });
			return outcome;
		},
	};
}

export async function main(env: Env = process.env): Promise<number> {
	// A stray console.log anywhere in the import graph would corrupt the protocol stream: send it to stderr.
	console.log = console.error;
	console.info = console.error;
	console.debug = console.error;

	const logger = createLogger({
		write: (line) => void process.stderr.write(`${line}\n`),
		level: logLevelFrom(env),
	});
	const stateDir = resolveConnectorStateDir(env);
	let host: McpToolHost;
	try {
		mkdirSync(stateDir, { recursive: true });
		host = createStdioHost(stateDir, logger);
	} catch (error) {
		process.stderr.write(`ultrathink-connector: cannot start: ${error instanceof Error ? error.message : "unknown error"}\n`);
		return 1;
	}

	process.on("unhandledRejection", (reason) => {
		logger.error("unhandled_rejection", { error: reason instanceof Error ? reason.name : "UnknownError" });
	});
	process.on("uncaughtException", (error) => {
		logger.error("uncaught_exception", { error: error.name });
		process.exit(1);
	});

	const controller = new AbortController();
	const stop = (signal: string): void => {
		logger.info("signal", { signal });
		controller.abort();
		setTimeout(() => process.exit(0), SIGNAL_EXIT_MS);
	};
	process.on("SIGINT", () => stop("SIGINT"));
	process.on("SIGTERM", () => stop("SIGTERM"));
	// A closed stdout means the client is gone.
	process.stdout.on("error", () => controller.abort());

	logger.info("started", { stateDir });
	await serveStdio({
		host,
		input: process.stdin,
		write: (line) =>
			new Promise<void>((resolve) => {
				process.stdout.write(`${line}\n`, () => resolve());
			}),
		logger,
		signal: controller.signal,
	});
	return 0;
}

if (import.meta.main) {
	process.exit(await main());
}
