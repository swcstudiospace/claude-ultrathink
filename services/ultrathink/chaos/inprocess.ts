// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { randomBytes } from "node:crypto";
import { createAuth } from "../auth/auth.ts";
import { type UltrathinkConfig, loadConfig } from "../config/config.ts";
import type { OpenRouterFetch } from "../engine/openrouter.ts";
import { createLogger } from "../obs/log.ts";
import { createApp } from "../routes/router.ts";
import { openStore } from "../store/store.ts";
import { createFaultyFetch } from "./faults.ts";
import type { ChaosResponse, ChaosTarget } from "./observe.ts";
import type { ExperimentTemplate } from "./schema.ts";

// Public origin the requests are addressed to. The app never listens; requests go straight to `app.handle`.
const ORIGIN = "https://ultrathink.test";
// Every in-process request arrives from loopback, so /metrics (loopback only) answers.
const PEER_IP = "127.0.0.1";
// The stand-in upstream: any call that is not faulted reaches it and fails as an upstream error.
const NO_UPSTREAM_MESSAGE = "no upstream in process";

export interface InProcessTargetOptions {
	template: ExperimentTemplate;
	/** Absolute directory for the store and audit files. Created by the caller; never the production state directory. */
	stateDir: string;
	now?: () => Date;
}

export interface InProcessTarget {
	target: ChaosTarget;
	/** Idempotent. Closes the store; removes nothing from disk. */
	close(): Promise<void>;
}

/**
 * Builds the real app in process with a temporary state directory, the template's fault plan at the OpenRouter seam,
 * and the template's config overrides. The environment is fixed and never read from process.env, so a run cannot pick
 * up production configuration. The app's own sleep is not overridden: the planner uses it for the whole-plan timer,
 * and a zero-delay sleep would time every plan out before its first upstream call. Retry waits stay at zero because the
 * faulted 5xx carries `Retry-After: 0`.
 */
export async function createInProcessTarget(options: InProcessTargetOptions): Promise<InProcessTarget> {
	const { template, stateDir, now } = options;
	if (template.kind !== "inprocess" || template.plan === undefined) {
		throw new TypeError(`template ${template.id} is not an inprocess template with a fault plan`);
	}

	const connectorKey = randomBytes(32).toString("base64url");
	const ownerPasswordHash = await Bun.password.hash(randomBytes(24).toString("base64url"));
	const config = applyOverrides(
		loadConfig({
			ULTRATHINK_PUBLIC_ORIGIN: ORIGIN,
			ULTRATHINK_OWNER_PASSWORD_HASH: ownerPasswordHash,
			ULTRATHINK_SESSION_SECRET: randomBytes(32).toString("hex"),
			ULTRATHINK_STATE_DIR: stateDir,
			ULTRATHINK_PLAINTEXT_LOOPBACK: "1",
			ULTRATHINK_SERVER_PLANNING: "1",
			ULTRATHINK_PLANNING_MODEL: "chaos/inprocess",
			ULTRATHINK_CONNECTOR_KEY: connectorKey,
			OPENROUTER_API_KEY: "chaos-inprocess-no-upstream",
		}),
		template.config,
	);

	const auth = createAuth({
		ownerPasswordHash: config.ownerPasswordHash,
		sessionSecret: config.sessionSecret,
		previousSessionSecrets: config.sessionSecretPrevious,
		cookieSecure: true,
	});
	const store = openStore(config.dbPath);
	const upstream: OpenRouterFetch = async () => {
		throw new Error(NO_UPSTREAM_MESSAGE);
	};
	const app = createApp({
		config,
		store,
		auth,
		logger: createLogger({ write: () => undefined }),
		fetch: createFaultyFetch(template.plan, upstream),
		...(now === undefined ? {} : { now: () => now().getTime() }),
	});

	let closing: Promise<void> | undefined;
	const close = (): Promise<void> => {
		closing ??= (async () => {
			await app.shutdown();
			store.close();
		})();
		return closing;
	};

	const target: ChaosTarget = {
		async request(method, path, body): Promise<ChaosResponse> {
			const headers: Record<string, string> = { "x-connector-key": connectorKey };
			const init: RequestInit = { method, headers };
			if (body !== undefined) {
				headers["content-type"] = "application/json";
				init.body = JSON.stringify(body);
			}
			const response = await app.handle(new Request(`${ORIGIN}${path}`, init), PEER_IP);
			return { status: response.status, headers: response.headers, text: await response.text() };
		},
		close,
	};

	return { target, close };
}

function applyOverrides(base: UltrathinkConfig, overrides: ExperimentTemplate["config"]): UltrathinkConfig {
	if (overrides === undefined) return base;
	return {
		...base,
		breakerFailures: overrides.breakerFailures ?? base.breakerFailures,
		breakerOpenMs: overrides.breakerOpenMs ?? base.breakerOpenMs,
		maxInflight: overrides.maxInflight ?? base.maxInflight,
		modelTimeoutMs: overrides.timeoutMs ?? base.modelTimeoutMs,
	};
}
