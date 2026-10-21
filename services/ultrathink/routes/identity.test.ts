// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { afterAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAuth } from "../auth/auth.ts";
import { loadConfig } from "../config/config.ts";
import { createLogger } from "../obs/log.ts";
import { type Store, openStore } from "../store/store.ts";
import { type App, createApp } from "./router.ts";

const ORIGIN = "https://ultrathink.test";
const TRUST_DOMAIN = "ultrathink.internal";
const EDGE = `spiffe://${TRUST_DOMAIN}/edge/nginx`;
const PROBE = `spiffe://${TRUST_DOMAIN}/ops/probe`;
const UNKNOWN_PATH = `spiffe://${TRUST_DOMAIN}/edge/other`;
const FOREIGN_DOMAIN = "spiffe://other.example/edge/nginx";
const LOOPBACK = "127.0.0.1";
const FORBIDDEN = "forbidden_identity";
const EVERY_ROUTE = ["/healthz", "/readyz", "/metrics", "/ultrathink", "/oauth/token", "/no-such-route"];

type LogLine = Record<string, unknown>;
type Peer = { spiffeId: string | null };

const dirs: string[] = [];
const stores: Store[] = [];
const apps: App[] = [];

afterAll(async () => {
	for (const app of apps.splice(0)) await app.shutdown();
	for (const store of stores.splice(0)) store.close();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// loadConfig checks only the PHC shape of the owner hash; no test logs in with it.
function passwordHash(): string {
	const salt = randomBytes(16).toString("base64").replace(/=+$/, "");
	const digest = randomBytes(16).toString("base64").replace(/=+$/, "");
	return `$argon2id$v=19$m=65536,t=2,p=1$${salt}$${digest}`;
}

// The router never reads the TLS files; the listener does. So absolute paths are enough here.
function build(tls: boolean): { app: App; logs: LogLine[] } {
	const dir = mkdtempSync(join(tmpdir(), "ultrathink-identity-"));
	dirs.push(dir);
	const env: Record<string, string | undefined> = {
		ULTRATHINK_PUBLIC_ORIGIN: ORIGIN,
		ULTRATHINK_OWNER_PASSWORD_HASH: passwordHash(),
		ULTRATHINK_SESSION_SECRET: randomBytes(32).toString("hex"),
		ULTRATHINK_STATE_DIR: dir,
		...(tls
			? {
					ULTRATHINK_TLS_CERT: "/etc/ultrathink/tls/app/cert.pem",
					ULTRATHINK_TLS_KEY: "/etc/ultrathink/tls/app/key.pem",
					ULTRATHINK_TLS_CLIENT_CA: "/etc/ultrathink/tls/ca.pem",
				}
			: { ULTRATHINK_PLAINTEXT_LOOPBACK: "1" }),
	};
	const config = loadConfig(env);
	const store = openStore(config.dbPath);
	stores.push(store);
	const logs: LogLine[] = [];
	const auth = createAuth({
		ownerPasswordHash: config.ownerPasswordHash,
		sessionSecret: config.sessionSecret,
		previousSessionSecrets: config.sessionSecretPrevious,
		cookieSecure: true,
	});
	const logger = createLogger({ write: (line) => logs.push(JSON.parse(line) as LogLine) });
	const app = createApp({ config, store, auth, logger });
	apps.push(app);
	return { app, logs };
}

function get(app: App, path: string, peer?: Peer, peerIp = LOOPBACK): Promise<Response> {
	return app.handle(new Request(`${ORIGIN}${path}`), peerIp, peer);
}

async function errorOf(response: Response): Promise<string | undefined> {
	const body = (await response.json().catch(() => null)) as { error?: string } | null;
	return body?.error;
}

describe("identity gate with mTLS on", () => {
	const { app, logs } = build(true);

	test("the edge identity reaches healthz", async () => {
		expect((await get(app, "/healthz", { spiffeId: EDGE })).status).toBe(200);
	});

	test("the edge identity reaches the proxied routes", async () => {
		const ultrathink = await get(app, "/ultrathink", { spiffeId: EDGE });
		expect(ultrathink.status).toBe(401);
		expect(await errorOf(ultrathink)).toBe("unauthenticated");

		const oauth = await get(app, "/oauth/token", { spiffeId: EDGE });
		expect(oauth.status).toBe(405);
		expect(await errorOf(oauth)).toBe("method_not_allowed");
	});

	test("the probe identity reaches healthz and metrics", async () => {
		expect((await get(app, "/healthz", { spiffeId: PROBE })).status).toBe(200);
		expect((await get(app, "/metrics", { spiffeId: PROBE })).status).toBe(200);
	});

	test("the probe identity is refused on the proxied routes", async () => {
		const response = await get(app, "/ultrathink", { spiffeId: PROBE });
		expect(response.status).toBe(403);
		expect(await errorOf(response)).toBe(FORBIDDEN);
	});

	test("the edge identity is refused on metrics", async () => {
		const response = await get(app, "/metrics", { spiffeId: EDGE });
		expect(response.status).toBe(403);
		expect(await errorOf(response)).toBe(FORBIDDEN);
	});

	test("a request with no identity is refused on every route", async () => {
		for (const path of EVERY_ROUTE) {
			for (const peer of [undefined, { spiffeId: null }]) {
				const response = await get(app, path, peer);
				expect(response.status).toBe(403);
				expect(await errorOf(response)).toBe(FORBIDDEN);
			}
		}
	});

	test("an identity outside the policy table or trust domain is refused", async () => {
		for (const spiffeId of [UNKNOWN_PATH, FOREIGN_DOMAIN]) {
			const response = await get(app, "/healthz", { spiffeId });
			expect(response.status).toBe(403);
			expect(await errorOf(response)).toBe(FORBIDDEN);
		}
	});

	test("a refusal is logged with its group and reason, and the identity is not logged", async () => {
		await get(app, "/metrics", { spiffeId: EDGE });
		const denied = logs.filter((line) => line.event === "identity_denied" && line.group === "metrics");
		expect(denied.length).toBeGreaterThan(0);
		const last = denied[denied.length - 1] ?? {};
		expect(last.reason).toBe("not_authorized");
		expect(JSON.stringify(last)).not.toContain("spiffe://");
	});
});

describe("identity gate with the plaintext opt-in", () => {
	const { app } = build(false);

	test("the gate is off: a request with no identity keeps its existing behavior", async () => {
		const ultrathink = await get(app, "/ultrathink");
		expect(ultrathink.status).toBe(401);
		expect(await errorOf(ultrathink)).toBe("unauthenticated");
		expect((await get(app, "/healthz")).status).toBe(200);
		expect((await get(app, "/metrics")).status).toBe(200);
	});
});
