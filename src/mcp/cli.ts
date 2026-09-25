// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { claudeConfigPaths, loadConfig, userConfigPath } from "../config.ts";
import { readControl } from "../claude/state.ts";
import type { SessionRecord } from "../claude/state.ts";
import { createGatewayTracker } from "../track/gateway.ts";
import { formatTrackingTodos, injectTrackingXml } from "../track/render.ts";
import { createMcpClient } from "./client.ts";
import { DEFAULT_TASK_GRAPH_TITLE, initTaskGraphDatabase, notionPageId, writeNotionConfig } from "./notion-db.ts";
import {
	beginLogin,
	completeLogin,
	logout,
	recoverUnauthorized,
	resolveAuthHeader,
	setApiKey,
	status,
} from "./oauth.ts";
import type { AuthDeps } from "./oauth.ts";
import { isProviderId, PROVIDERS, USER_AGENT } from "./providers.ts";
import type { ProviderId } from "./providers.ts";
import { defaultRun, mountTailscale, planRedirect, readTailscaleDns, unmountTailscale } from "./redirect.ts";
import type { RedirectPlan, Run } from "./redirect.ts";
import { createRelay, runStdioRelay } from "./relay.ts";
import type { RelayAuth } from "./relay.ts";
import { storePath } from "./store.ts";

const USAGE = `usage:
  ultrathink-mcp serve <notion|linear|greptile>
  ultrathink-mcp auth status
  ultrathink-mcp auth set-key <provider> (--stdin | --env-file <path> --var <NAME>)
  ultrathink-mcp auth login <provider> [--port <n>] [--redirect <url>] [--tailscale] [--no-listen]
  ultrathink-mcp auth logout <provider>
  ultrathink-mcp check [provider...]
  ultrathink-mcp track complete --state <sessions/<id>.json>
  ultrathink-mcp session mark --state <sessions/<id>.json> <kicked-off|synced>
  ultrathink-mcp notion init --parent <notion page url or id> [--title <title>] [--write-config]`;

class UsageError extends Error {}

function out(line: string): void {
	process.stdout.write(`${line}\n`);
}

function err(line: string): void {
	process.stderr.write(`${line}\n`);
}

function provider(value: string | undefined): ProviderId {
	if (!value || !isProviderId(value)) throw new UsageError(`unknown provider: ${value ?? "(none)"}`);
	return value;
}

function flag(args: string[], name: string): string | undefined {
	const index = args.indexOf(name);
	if (index < 0) return undefined;
	const value = args[index + 1];
	if (!value || value.startsWith("--")) throw new UsageError(`${name} needs a value`);
	return value;
}

function loginHint(id: ProviderId): string {
	return PROVIDERS[id].apiKey
		? `run: ultrathink-mcp auth set-key ${id} --stdin`
		: `run: ultrathink-mcp auth login ${id}`;
}

function relayAuth(id: ProviderId, deps: AuthDeps): RelayAuth {
	return {
		header: () => resolveAuthHeader(id, deps),
		unauthorized: (failed) => recoverUnauthorized(id, failed, deps),
	};
}

export function cleanKey(raw: string): string {
	let value = raw.trim();
	if (value.startsWith("export ")) value = value.slice(7).trim();
	const quoted = /^(['"])(.*)\1$/.exec(value);
	if (quoted) value = (quoted[2] ?? "").trim();
	return value;
}

export function keyFromEnvFile(text: string, name: string): string | undefined {
	for (const rawLine of text.split(/\r?\n/)) {
		let line = rawLine.trim();
		if (line.startsWith("export ")) line = line.slice(7).trim();
		const eq = line.indexOf("=");
		if (eq < 0 || line.slice(0, eq).trim() !== name) continue;
		return cleanKey(line.slice(eq + 1));
	}
	return undefined;
}

async function readLine(stream: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<string | undefined> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	signal.addEventListener("abort", () => void reader.cancel().catch(() => {}), { once: true });
	try {
		while (!signal.aborted) {
			const { value, done } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			const nl = buffer.indexOf("\n");
			if (nl >= 0) return buffer.slice(0, nl).trim();
		}
		return signal.aborted ? undefined : buffer.trim() || undefined;
	} finally {
		reader.releaseLock();
	}
}

/**
 * Plans the OAuth callback route for `auth login`. Tailscale is used only when asked for with `--tailscale` or
 * `ULTRATHINK_OAUTH_TAILSCALE=1`; then the `tailscale serve` handler is added, and `mount` is returned only if
 * that worked (the caller removes it). If it fails, the login falls back to the loopback route.
 */
export function prepareRedirect(input: {
	args: string[];
	env: Record<string, string | undefined>;
	port: number;
	run: Run;
}): { plan: RedirectPlan; mount?: NonNullable<RedirectPlan["mount"]> } {
	const { env, port, run } = input;
	const redirect = flag(input.args, "--redirect");
	const tailscale = input.args.includes("--tailscale") || env.ULTRATHINK_OAUTH_TAILSCALE === "1";
	let plan: RedirectPlan;
	try {
		plan = planRedirect({ env, port, redirect, tailscale, tailscaleDns: () => readTailscaleDns(run) });
	} catch (error) {
		throw new UsageError(error instanceof Error ? error.message : String(error));
	}
	const mount = plan.mount;
	if (!mount) return { plan };
	if (mountTailscale(mount, run)) return { plan, mount };
	const fallback = planRedirect({ env, port, tailscale, tailscaleDns: () => undefined });
	return {
		plan: {
			...fallback,
			hint: [
				`The Tailscale route (tailscale serve ${mount.path}) could not be set up; using ${fallback.redirectUri} instead.`,
				...fallback.hint,
			],
		},
	};
}

async function login(id: ProviderId, args: string[], deps: AuthDeps): Promise<void> {
	const portText = flag(args, "--port") ?? "8765";
	const port = Number(portText);
	if (!Number.isInteger(port) || port < 1 || port > 65535) throw new UsageError(`invalid port: ${portText}`);
	const listen = !args.includes("--no-listen");
	const { plan, mount } = prepareRedirect({ args, env: process.env, port, run: defaultRun });
	let mounted = mount !== undefined;
	const unmount = (): void => {
		if (!mount || !mounted) return;
		mounted = false;
		unmountTailscale(mount, defaultRun);
	};
	const onSignal = (signal: NodeJS.Signals): void => {
		unmount();
		process.exit(signal === "SIGINT" ? 130 : 143);
	};
	if (mounted) {
		process.on("SIGINT", onSignal);
		process.on("SIGTERM", onSignal);
	}
	const received = Promise.withResolvers<string>();
	const abort = new AbortController();
	let server: Bun.Server<undefined> | undefined;
	try {
		const pending = await beginLogin(id, { ...deps, redirectUri: plan.redirectUri });
		out(`Open this URL in any browser to authorize ${PROVIDERS[id].label}:\n\n${pending.url}\n`);
		for (const line of plan.hint) out(line);
		out(
			listen
				? "\nWaiting for the callback; or paste the full redirected URL here and press Enter:"
				: "\nPaste the full redirected URL here and press Enter:",
		);
		if (listen) {
			const callbackPaths = plan.callbackPaths;
			server = Bun.serve({
				hostname: "127.0.0.1",
				port: plan.port,
				fetch(request) {
					const url = new URL(request.url);
					if (!callbackPaths.includes(url.pathname)) return new Response("not found", { status: 404 });
					if (url.searchParams.get("state") !== pending.state) {
						return new Response("state mismatch", { status: 400 });
					}
					received.resolve(url.search);
					return new Response("ultrathink-mcp: authorization received, you can close this tab.", {
						headers: { "content-type": "text/plain; charset=utf-8" },
					});
				},
			});
		}
		readLine(Bun.stdin.stream(), abort.signal).then(
			(line) => {
				if (line) received.resolve(line);
				else if (!listen) received.reject(new Error("no callback URL provided"));
			},
			() => {},
		);
		const input = await received.promise;
		await completeLogin(pending, input, deps);
	} finally {
		abort.abort();
		server?.stop(true);
		unmount();
		process.off("SIGINT", onSignal);
		process.off("SIGTERM", onSignal);
	}
	out(`${id}: logged in`);
}

async function setKey(id: ProviderId, args: string[], deps: AuthDeps): Promise<void> {
	let key: string | undefined;
	if (args.includes("--stdin")) {
		key = cleanKey(await Bun.stdin.text());
	} else {
		const file = flag(args, "--env-file");
		const name = flag(args, "--var");
		if (!file || !name) throw new UsageError("set-key needs --stdin or --env-file <path> --var <NAME>");
		key = keyFromEnvFile(readFileSync(file, "utf8"), name);
		if (key === undefined) throw new Error(`${name} not found in ${file}`);
	}
	if (!key) throw new Error("empty api key");
	await setApiKey(id, key, deps);
	out(`${id}: api key stored (${key.length} chars)`);
}

interface RpcMessage {
	id?: number | string;
	result?: { tools?: unknown[]; nextCursor?: string; protocolVersion?: string };
	error?: { message?: string };
}

async function checkOne(id: ProviderId, deps: AuthDeps): Promise<number> {
	const responses = new Map<number | string, RpcMessage>();
	const relay = createRelay({
		url: PROVIDERS[id].url,
		userAgent: USER_AGENT,
		loginHint: loginHint(id),
		auth: relayAuth(id, deps),
		write(line) {
			const message = JSON.parse(line) as RpcMessage;
			if (message.id !== undefined) responses.set(message.id, message);
		},
	});
	let nextId = 1;
	const request = async (method: string, params: Record<string, unknown>): Promise<NonNullable<RpcMessage["result"]>> => {
		const id = nextId++;
		await relay.handle({ jsonrpc: "2.0", id, method, params });
		const response = responses.get(id);
		if (!response) throw new Error(`no response to ${method}`);
		if (response.error) throw new Error(response.error.message ?? `${method} failed`);
		return response.result ?? {};
	};
	await request("initialize", {
		protocolVersion: "2025-06-18",
		capabilities: {},
		clientInfo: { name: "ultrathink-mcp-check", version: "0.2.0" },
	});
	await relay.handle({ jsonrpc: "2.0", method: "notifications/initialized" });
	let count = 0;
	let cursor: string | undefined;
	do {
		const result = await request("tools/list", cursor ? { cursor } : {});
		count += result.tools?.length ?? 0;
		cursor = result.nextCursor;
	} while (cursor);
	return count;
}

async function trackComplete(args: string[]): Promise<number> {
	const statePath = flag(args, "--state");
	if (!statePath) throw new UsageError("track complete needs --state <path>");
	// The state file lives at <host state dir>/sessions/<id>.json; control.json sits in the state dir.
	if (readControl(dirname(dirname(statePath))).trackEnabled === false) {
		err("ultrathink-mcp: tracking is off (/ultrathink-track on to enable)");
		return 0;
	}
	const record = readRecord(statePath);
	if (!record) return 1;
	const plan = record.plan;
	if (!plan) {
		err(`ultrathink-mcp: session record has no plan: ${statePath}`);
		return 1;
	}
	const config = loadConfig(claudeConfigPaths(process.cwd()));
	const tracker = createGatewayTracker(config);
	if (!tracker) {
		err(
			`ultrathink-mcp: tracking not configured: set linear.team and/or notion.dataSourceUrl in ${userConfigPath()} (or run: ultrathink-mcp notion init --parent <page>)`,
		);
		return 0;
	}
	const tracking = await tracker({ plan, graph: record.graph, existing: record.tracking });
	if (!tracking) {
		err("ultrathink-mcp: no tracker credentials: run ultrathink-mcp auth status");
		return 1;
	}
	record.tracking = tracking;
	const xml = injectTrackingXml(record.result.xml, plan, tracking);
	record.result = { ...record.result, xml };
	writeAtomic(statePath, `${JSON.stringify(record, null, 2)}\n`);
	const specPath = statePath.replace(/\.json$/, ".xml");
	writeAtomic(specPath, xml);
	out(
		`tracking ${tracking.status} · ${Object.keys(tracking.linear.nodes).length} issues · ${Object.keys(tracking.linear.steps).length} sub-issues · graph ${tracking.graphId}`,
	);
	for (const error of tracking.errors) out(`! ${error}`);
	out("");
	out(formatTrackingTodos(plan, tracking));
	return tracking.status === "failed" ? 1 : 0;
}

/** Reads a session record, or reports one stderr line and returns undefined. */
function readRecord(statePath: string): SessionRecord | undefined {
	try {
		const record = JSON.parse(readFileSync(statePath, "utf8")) as Partial<SessionRecord> | null;
		if (record && typeof record === "object" && record.result && typeof record.result === "object") {
			return record as SessionRecord;
		}
	} catch {
		// Reported below.
	}
	err(`ultrathink-mcp: cannot read session record: ${statePath}`);
	return undefined;
}

/** Temp file in the same directory, then rename, so readers never see a partial record. */
function writeAtomic(path: string, text: string): void {
	const tmp = `${path}.${process.pid}.tmp`;
	writeFileSync(tmp, text);
	renameSync(tmp, path);
}

function sessionMark(args: string[]): number {
	const statePath = flag(args, "--state");
	if (!statePath) throw new UsageError("session mark needs --state <path>");
	const marks = args.filter((arg, index) => arg !== "--state" && args[index - 1] !== "--state");
	const mark = marks.length === 1 ? marks[0] : undefined;
	const field = mark === "kicked-off" ? "kickedOff" : mark === "synced" ? "synced" : undefined;
	if (!field) throw new UsageError(`session mark needs one of kicked-off, synced: ${marks.join(" ") || "(none)"}`);
	const record = readRecord(statePath);
	if (!record) return 1;
	// Plan-scoped: the mark describes the plan now in the record; the session's next planned prompt replaces the record
	// with a new graph whose kickedOff and synced start false, because that graph has not been kicked off or synced.
	record[field] = true;
	writeAtomic(statePath, `${JSON.stringify(record, null, 2)}\n`);
	return 0;
}

async function notionInit(args: string[], deps: AuthDeps): Promise<number> {
	const parent = flag(args, "--parent");
	if (!parent) throw new UsageError("notion init needs --parent <notion page url or id>");
	if (notionPageId(parent) === undefined) throw new UsageError(`--parent is not a Notion page url or id: ${parent}`);
	const title = flag(args, "--title") ?? DEFAULT_TASK_GRAPH_TITLE;
	if ((await resolveAuthHeader("notion", deps)) === undefined) {
		err(`ultrathink-mcp: notion is not logged in: ${loginHint("notion")}`);
		return 1;
	}
	// Generous timeout: a create that times out here may still land in Notion, and a rerun would duplicate it.
	const client = createMcpClient("notion", { storePath: deps.storePath, callTimeoutMs: 120_000 });
	const created = await initTaskGraphDatabase(client, { parent, title }).finally(() => client.close());
	const configPath = userConfigPath();
	out(`created Notion database "${title}"${created.url ? `: ${created.url}` : ""}`);
	out(`data source: ${created.dataSourceUrl}`);
	out(`\nultrathink config (${configPath}):`);
	out(`{ "notion": { "dataSourceUrl": ${JSON.stringify(created.dataSourceUrl)} } }`);
	if (args.includes("--write-config")) {
		writeNotionConfig(configPath, created.dataSourceUrl);
		out(`wrote notion.dataSourceUrl to ${configPath}`);
	}
	if (created.relationError === undefined) return 0;
	err(`ultrathink-mcp: the database exists, but adding its "Parent Item" self-relation failed: ${created.relationError}`);
	err('ultrathink-mcp: rows stay flat until you add a two-way relation "Parent Item" (synced as "Sub-Items") from the database to itself in Notion');
	return 1;
}

export async function main(argv: string[]): Promise<number> {
	const [command, ...rest] = argv;
	const deps: AuthDeps = { storePath: storePath() };
	try {
		if (command === "serve") {
			const id = provider(rest[0]);
			const debug = process.env.ULTRATHINK_MCP_DEBUG === "1";
			await runStdioRelay({
				url: PROVIDERS[id].url,
				userAgent: USER_AGENT,
				loginHint: loginHint(id),
				auth: relayAuth(id, deps),
				log: debug ? (message) => err(`ultrathink-mcp[${id}]: ${message}`) : undefined,
			});
			return 0;
		}
		if (command === "check") {
			const ids = rest.length ? rest.map(provider) : (Object.keys(PROVIDERS) as ProviderId[]);
			let failed = false;
			for (const id of ids) {
				try {
					out(`${id}: OK ${await checkOne(id, deps)} tools`);
				} catch (error) {
					failed = true;
					out(`${id}: FAIL ${error instanceof Error ? error.message : String(error)}`);
				}
			}
			return failed ? 1 : 0;
		}
		if (command === "track" && rest[0] === "complete") return await trackComplete(rest.slice(1));
		if (command === "session" && rest[0] === "mark") return sessionMark(rest.slice(1));
		if (command === "notion" && rest[0] === "init") return await notionInit(rest.slice(1), deps);
		if (command === "auth") {
			const [sub, ...args] = rest;
			if (sub === "status") {
				for (const s of status(deps)) out(`${s.provider}  ${s.kind}  ${s.ready ? "ready" : "not ready"}  ${s.detail}`);
				out(`store: ${deps.storePath}`);
				return 0;
			}
			if (sub === "set-key") {
				await setKey(provider(args[0]), args.slice(1), deps);
				return 0;
			}
			if (sub === "login") {
				await login(provider(args[0]), args.slice(1), deps);
				return 0;
			}
			if (sub === "logout") {
				const id = provider(args[0]);
				await logout(id, deps);
				out(`${id}: logged out`);
				return 0;
			}
		}
		throw new UsageError(command ? `unknown command: ${[command, ...rest.slice(0, 1)].join(" ")}` : "missing command");
	} catch (error) {
		if (error instanceof UsageError) {
			err(`ultrathink-mcp: ${error.message}\n${USAGE}`);
			return 2;
		}
		err(`ultrathink-mcp: ${error instanceof Error ? error.message : String(error)}`);
		return 1;
	}
}

if (import.meta.main) {
	process.exit(await main(process.argv.slice(2)));
}
