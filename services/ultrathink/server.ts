// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { createAuth } from "./auth/auth.ts";
import { ConfigError, type UltrathinkConfig, loadConfig } from "./config/config.ts";
import { createHandler } from "./routes/router.ts";
import { openStore } from "./store/store.ts";

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
const store = openStore(config.dbPath);
const auth = createAuth({
	ownerPasswordHash: config.ownerPasswordHash,
	sessionSecret: config.sessionSecret,
	cookieSecure: config.publicOrigin.startsWith("https://"),
});
const handler = createHandler({ config, store, auth });

async function handleLogged(req: Request, peerIp: string): Promise<Response> {
	const started = performance.now();
	const response = await handler(req, peerIp);
	const { pathname } = new URL(req.url);
	const elapsedMs = Math.round(performance.now() - started);
	console.log(`${req.method} ${pathname} ${response.status} ${elapsedMs}ms`);
	return response;
}

const server = Bun.serve({
	hostname: "127.0.0.1",
	port: config.port,
	idleTimeout: 30,
	fetch(req, bunServer) {
		return handleLogged(req, bunServer.requestIP(req)?.address ?? "");
	},
});

let stopping = false;

function shutdown(): void {
	if (stopping) return;
	stopping = true;
	server.stop();
	store.close();
	process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

console.log(`ultrathink listening on 127.0.0.1:${config.port}`);
