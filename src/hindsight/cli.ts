// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * `bin/ultrathink hindsight check [--roundtrip] [--json]`: operator probe for the Hindsight integration. Plain `check`
 * asks `/health` and `/version` (no key). `--roundtrip` additionally proves the authenticated path end to end (bank,
 * retain, recall, delete) in a throwaway `ultrathink-smoke-*` bank, so it can never read, write or delete the configured
 * bank, and it always cleans up after itself.
 */
import { randomBytes } from "node:crypto";
import { claudeConfigPaths, loadConfig } from "../config.ts";
import type { GatewayConfig } from "../gateway/types.ts";
import type { CliResult } from "../teach/types.ts";
import { storePath as defaultStorePath } from "../mcp/store.ts";
import { createHindsightClient, redactMessage } from "./client.ts";
import { hindsightStatusLine, resolveHindsight, resolveHindsightKey } from "./settings.ts";
import type { HindsightConfig, HindsightError, HindsightResult } from "./types.ts";

export interface CommandDeps {
	cwd: string;
	env?: NodeJS.ProcessEnv;
	stateDir?: string;
	storePath?: string;
	fetch?: typeof fetch;
	/** The `hindsight` config section; tests pass it, otherwise it is loaded like the other commands do. */
	config?: HindsightConfig;
	/** Desk gateway section. Loaded with `config` when omitted. */
	gateway?: GatewayConfig;
	stdin?: () => Promise<string>;
	now?: () => number;
}

const USAGE = "Usage: ultrathink hindsight check [--roundtrip] [--json]";
const SMOKE_BANK_PREFIX = "ultrathink-smoke-";
const SMOKE_TAG = "ultrathink-smoke";

interface Step {
	name: string;
	ok: boolean;
	ms: number;
	skipped?: true;
	error?: HindsightError;
	/** A pass that carries a note, e.g. the document was already gone. */
	note?: string;
}

function stepLine(step: Step): string {
	if (step.skipped) return `  ${step.name}: skipped`;
	if (step.ok) return `  ${step.name}: ok · ${step.ms} ms${step.note ? ` · ${step.note}` : ""}`;
	const reason = step.error ? ` (${step.error.kind}) · ${step.error.message}` : step.note ? ` · ${step.note}` : "";
	return `  ${step.name}: failed${reason} · ${step.ms} ms`;
}

/** The throwaway-bank round trip. The cleanup steps run whatever happened before them. */
async function roundtrip(
	config: HindsightConfig,
	url: string,
	apiKey: string,
	deps: CommandDeps,
	now: () => number,
): Promise<{ bank: string; steps: Step[] }> {
	const nonce = randomBytes(4).toString("hex");
	const bank = `${SMOKE_BANK_PREFIX}${nonce}`;
	const documentId = `smoke:${nonce}`;
	const client = createHindsightClient({
		url,
		apiKey,
		bank,
		timeoutMs: config.timeoutMs,
		retainTimeoutMs: config.retainTimeoutMs,
		fetch: deps.fetch,
	});
	const steps: Step[] = [];
	const run = async <T>(name: string, work: () => Promise<HindsightResult<T>>, verify?: (value: T) => string | undefined) => {
		const started = now();
		const result = await work();
		const step: Step = { name, ok: result.ok, ms: now() - started };
		if (!result.ok) step.error = result.error;
		else {
			const problem = verify?.(result.value);
			if (problem) {
				step.ok = false;
				step.note = problem;
			}
		}
		steps.push(step);
		return step.ok;
	};
	const skip = (name: string) => steps.push({ name, ok: false, ms: 0, skipped: true });

	let usable = await run("ensure bank", () => client.ensureBank());
	if (usable) {
		usable = await run("retain", () =>
			client.retain({
				documentId,
				content: `ultrathink smoke check ${nonce}`,
				context: "ultrathink hindsight check --roundtrip",
				tags: [SMOKE_TAG],
			}),
		);
	} else skip("retain");
	if (usable) {
		await run(
			"recall",
			() => client.recall({ query: nonce }),
			(hits) => (hits.some((hit) => hit.text.includes(nonce)) ? undefined : `no hit contains the nonce (${hits.length} hits)`),
		);
	} else skip("recall");
	await run("delete document", () => client.deleteDocument(documentId));
	await run("delete bank", () => client.deleteBank());
	return { bank, steps };
}

async function check(config: HindsightConfig, flags: { roundtrip: boolean; json: boolean }, deps: CommandDeps): Promise<CliResult> {
	const env = deps.env ?? process.env;
	const storePath = deps.storePath ?? defaultStorePath(env);
	const now = deps.now ?? Date.now;
	const resolution = resolveHindsight(config, env, { storePath, fetch: deps.fetch, gateway: deps.gateway });
	const { readiness } = resolution;
	if (readiness.state !== "ready" || !resolution.client) {
		const reason = hindsightStatusLine(config, env, storePath, deps.gateway).replace(/^Hindsight: /, "");
		return flags.json
			? { code: 1, text: JSON.stringify({ ok: false, state: readiness.state, reason }) }
			: { code: 1, text: `Hindsight check: ${reason}` };
	}
	const origin = new URL(readiness.url).origin;
	const started = now();
	const health = await resolution.client.health();
	const ms = now() - started;
	if (!health.ok || !health.value.ok) {
		const error: HindsightError = health.ok
			? {
					kind: "server",
					message: redactMessage(
						`hindsight server: /health did not report healthy (Hindsight ${health.value.apiVersion || "unknown"}, database ${health.value.databaseConnected ? "connected" : "not connected"})`,
					),
				}
			: health.error;
		return flags.json
			? { code: 1, text: JSON.stringify({ ok: false, state: "ready", origin, bank: readiness.bank, error, ms }) }
			: { code: 1, text: `Hindsight check: error (${error.kind}) · ${error.message}` };
	}
	const { apiVersion, features } = health.value;
	let smoke: { bank: string; steps: Step[] } | undefined;
	if (flags.roundtrip && !("backend" in readiness)) {
		const key = resolveHindsightKey(storePath, env);
		if (key) smoke = await roundtrip(config, readiness.url, key.key, deps, now);
	}
	const passed = flags.roundtrip ? (smoke?.steps.every((step) => step.ok) ?? false) : true;
	if (flags.json) {
		const payload: Record<string, unknown> = {
			ok: passed,
			state: "ready",
			origin,
			bank: readiness.bank,
			apiVersion,
			databaseConnected: true,
			features,
			ms,
		};
		if (smoke) payload.roundtrip = { ok: passed, bank: smoke.bank, steps: smoke.steps };
		return { code: passed ? 0 : 1, text: JSON.stringify(payload) };
	}
	const lines = [
		`Hindsight check: ok · Hindsight ${apiVersion || "unknown"} · database connected · bank ${readiness.bank} · ${ms} ms`,
		`Features: ${Object.entries(features)
			.map(([name, on]) => `${name} ${on ? "on" : "off"}`)
			.join(" · ") || "none reported"}`,
	];
	if (smoke) {
		lines.push(`Hindsight roundtrip: ${passed ? "ok" : "failed"} · throwaway bank ${smoke.bank}`);
		for (const step of smoke.steps) lines.push(stepLine(step));
	}
	return { code: passed ? 0 : 1, text: lines.join("\n") };
}

/** `bin/ultrathink hindsight <argv…>`. Never rejects. code 0 ok, 1 failure or not ready, 2 usage. text has no trailing newline. */
export async function runHindsightCommand(argv: string[], deps: CommandDeps): Promise<CliResult> {
	try {
		if (argv[0]?.trim().toLowerCase() !== "check") return { code: 2, text: USAGE };
		const flags = { roundtrip: false, json: false };
		for (const arg of argv.slice(1)) {
			if (arg === "--roundtrip") flags.roundtrip = true;
			else if (arg === "--json") flags.json = true;
			else return { code: 2, text: USAGE };
		}
		const env = deps.env ?? process.env;
		const loaded = deps.config && deps.gateway ? undefined : loadConfig(claudeConfigPaths(deps.cwd, env));
		const config = deps.config ?? loaded?.hindsight;
		if (!config) return { code: 1, text: "Hindsight: config unavailable" };
		return await check(config, flags, { ...deps, gateway: deps.gateway ?? loaded?.gateway });
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { code: 1, text: `Hindsight: ${redactMessage(message)}` };
	}
}
