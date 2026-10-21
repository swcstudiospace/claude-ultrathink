// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { accessSync, constants, existsSync } from "node:fs";
import pkg from "../../package.json";
import { createAuth } from "./auth/auth.ts";
import { loadChaosFetch } from "./chaos/faults.ts";
import { ConfigError, type TlsFiles, type UltrathinkConfig, loadConfig } from "./config/config.ts";
import { createShutdown, installProcessHandlers } from "./lifecycle.ts";
import { ToolDefinitionError, assertToolDefinitions } from "./mcp/definitions.ts";
import { TOOL_DEFINITIONS } from "./mcp/mcp.ts";
import { createLogger } from "./obs/log.ts";
import { type App, createApp } from "./routes/router.ts";
import { identityFromUriSans } from "./security/identity.ts";
import { startMtlsServer } from "./security/mtls.ts";
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

// A tool definition that a strict client would reject stops the service before it opens a socket, with the tool named.
function assertToolDefinitionsOrExit(): void {
	try {
		assertToolDefinitions(TOOL_DEFINITIONS);
	} catch (error) {
		if (error instanceof ToolDefinitionError) {
			process.stderr.write(`${error.message}\n`);
			process.exit(1);
		}
		throw error;
	}
}

// The TLS files must exist and be readable before any socket opens. A failure names the variable and its path only.
function requireReadableOrExit(name: string, path: string): void {
	if (!existsSync(path)) {
		process.stderr.write(`${name} points to a missing file: ${path}\n`);
		process.exit(1);
	}
	try {
		accessSync(path, constants.R_OK);
	} catch {
		process.stderr.write(`${name} points to an unreadable file: ${path}\n`);
		process.exit(1);
	}
}

interface Listener {
	/** Bun types the bound port as optional; the mTLS listener always reports one. */
	readonly port: number | undefined;
	stop(): Promise<void>;
}

// With TLS configured the listener is mTLS only: the handshake refuses any client that does not chain to the CA, and
// the verified SPIFFE identity (never a header) is the only identity the router sees.
function startTlsListener(tls: TlsFiles, config: UltrathinkConfig, app: App): Listener {
	requireReadableOrExit("ULTRATHINK_TLS_CERT", tls.certFile);
	requireReadableOrExit("ULTRATHINK_TLS_KEY", tls.keyFile);
	requireReadableOrExit("ULTRATHINK_TLS_CLIENT_CA", tls.clientCaFile);
	return startMtlsServer(
		{
			port: config.port,
			certFile: tls.certFile,
			keyFile: tls.keyFile,
			clientCaFile: tls.clientCaFile,
			idleTimeoutSec: IDLE_TIMEOUT_SEC,
			maxBodyBytes: config.maxBodyBytes,
		},
		async (req, peer) => {
			const identity = identityFromUriSans(peer.uriSans, config.spiffeTrustDomain);
			return app.handle(req, peer.ip, { spiffeId: identity.ok ? identity.spiffeId : null });
		},
	);
}

// Plaintext exists only behind the loopback opt-in, which config.ts requires whenever no TLS files are set.
function startPlaintextListener(config: UltrathinkConfig, app: App): Listener {
	return Bun.serve({
		hostname: "127.0.0.1",
		port: config.port,
		idleTimeout: IDLE_TIMEOUT_SEC,
		maxRequestBodySize: config.maxBodyBytes,
		fetch(req, bunServer) {
			return app.handle(req, bunServer.requestIP(req)?.address ?? "");
		},
	});
}

const config = loadConfigOrExit();
assertToolDefinitionsOrExit();
const logger = createLogger();
const store = openStore(config.dbPath);
const auth = createAuth({
	ownerPasswordHash: config.ownerPasswordHash,
	sessionSecret: config.sessionSecret,
	previousSessionSecrets: config.sessionSecretPrevious,
	cookieSecure: config.publicOrigin.startsWith("https://"),
});
const chaosFetch = loadChaosFetch(config);
const app = createApp({ config, store, auth, logger, ...(chaosFetch ? { fetch: chaosFetch } : {}) });

const listener: Listener =
	config.tls === undefined ? startPlaintextListener(config, app) : startTlsListener(config.tls, config, app);
app.start();

const shutdown = createShutdown({
	server: { stop: () => listener.stop() },
	app,
	store,
	logger,
	timeoutMs: SHUTDOWN_TIMEOUT_MS + config.drainMs,
	beginDrain: () => app.beginDrain(),
	drainMs: config.drainMs,
	exit: (code) => process.exit(code),
});
installProcessHandlers(shutdown, logger, process);

logger.info("listening", {
	version: pkg.version,
	port: listener.port,
	tls: config.tls !== undefined,
	trustDomain: config.spiffeTrustDomain,
	serverPlanning: config.serverPlanning,
	planningModel: config.planningModel ?? null,
	maxConcurrentPlans: config.maxConcurrentPlans,
});
