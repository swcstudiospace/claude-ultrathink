// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import pkg from "../../package.json";
import { createAuth } from "./auth/auth.ts";
import { ConfigError, type UltrathinkConfig, loadConfig } from "./config/config.ts";
import { createShutdown, installProcessHandlers } from "./lifecycle.ts";
import { createLogger } from "./obs/log.ts";
import { createApp } from "./routes/router.ts";
import { openStore } from "./store/store.ts";

// Running plans are aborted and marked interrupted within 5 s of the signal; the rest is draining connections.
const SHUTDOWN_TIMEOUT_MS = 20_000;
// Long polling waits up to 45 s per tool call.
const IDLE_TIMEOUT_SEC = 75;

function loadConfigOrExit(): UltrathinkConfig {
	try {
		return loadConfig();
	} catch (error) {
		if (error instanceof ConfigError) {
			process.stderr.write(`${error.message}\n`);
			process.exit(1);
		}
		throw error;
	}
}

const config = loadConfigOrExit();
const logger = createLogger();
const store = openStore(config.dbPath);
const auth = createAuth({
	ownerPasswordHash: config.ownerPasswordHash,
	sessionSecret: config.sessionSecret,
	cookieSecure: config.publicOrigin.startsWith("https://"),
});
const app = createApp({ config, store, auth, logger });

const server = Bun.serve({
	hostname: "127.0.0.1",
	port: config.port,
	idleTimeout: IDLE_TIMEOUT_SEC,
	maxRequestBodySize: config.maxBodyBytes,
	fetch(req, bunServer) {
		return app.handle(req, bunServer.requestIP(req)?.address ?? "");
	},
});

const shutdown = createShutdown({
	server: { stop: () => server.stop() },
	app,
	store,
	logger,
	timeoutMs: SHUTDOWN_TIMEOUT_MS,
	exit: (code) => process.exit(code),
});
installProcessHandlers(shutdown, logger, process);

logger.info("listening", {
	version: pkg.version,
	port: server.port,
	serverPlanning: config.serverPlanning,
	planningModel: config.planningModel ?? null,
	maxConcurrentPlans: config.maxConcurrentPlans,
});
