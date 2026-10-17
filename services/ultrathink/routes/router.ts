// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { type Auth, clientIpFrom } from "../auth/auth.ts";
import type { UltrathinkConfig } from "../config/config.ts";
import type { PhaseRecord, Run, Store } from "../store/store.ts";
import { ROUTES, type Route, parseRouteFlag, sanitizeInput, selectRoute } from "./input.ts";
import { type JournalOptions, type JournalResult, answerRequest, listPendingRequests, sessionStatus, showRequest, startPlan } from "../engine/journal.ts";
import { type McpToolHost, type ToolOutcome, handleMcpPayload } from "../mcp/mcp.ts";

export interface RouterDeps {
	config: UltrathinkConfig;
	store: Store;
	auth: Auth;
}

type Endpoint = "healthz" | "login" | "ultrathink" | "run" | "mcp";

type Target = { endpoint: Exclude<Endpoint, "run"> } | { endpoint: "run"; runId: string };

type BodyRead = { ok: true; bytes: Uint8Array } | { ok: false; reason: "too_large" | "unreadable" };

type JsonRead = { ok: true; value: unknown } | { ok: false; response: Response };

const METHODS: Record<Endpoint, readonly string[]> = {
	healthz: ["GET"],
	login: ["POST"],
	ultrathink: ["GET", "POST"],
	run: ["GET"],
	mcp: ["POST"],
};

const RUN_PATH = /^\/ultrathink\/runs\/([^/]+)$/;

const CONNECTOR_RATE_OWNER = "connector";

const SECURITY_HEADERS: Record<string, string> = {
	"Cache-Control": "no-store",
	"X-Content-Type-Options": "nosniff",
	"Referrer-Policy": "no-referrer",
};

const USAGE = {
	usage:
		'POST /ultrathink with Content-Type: application/json and JSON {"input": "<text>", "flags": {"route": "auto"}}. The route and its reason are returned before anything runs.',
	routes: ROUTES,
	flags: { route: ["auto", ...ROUTES] },
	examples: [
		"plan the rollout of the billing migration",
		"research options for a background job queue",
		"build a CLI scaffold for the importer",
	],
};

function respond(status: number, body: unknown, headers: Record<string, string> = {}): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { ...SECURITY_HEADERS, "Content-Type": "application/json; charset=utf-8", ...headers },
	});
}

function fail(status: number, code: string, headers: Record<string, string> = {}): Response {
	return respond(status, { error: code }, headers);
}

function persistenceUnavailable(): Response {
	return respond(503, { error: "persistence_unavailable", correlationId: randomUUID() });
}

function runView(run: Run, phases: PhaseRecord[]): Record<string, unknown> {
	return {
		id: run.id,
		route: run.route,
		status: run.status,
		currentPhase: run.currentPhase,
		reason: run.reason,
		createdAt: run.createdAt,
		updatedAt: run.updatedAt,
		elapsedMs: Date.now() - run.createdAt,
		phases: phases.map((phase) => ({ phase: phase.phase, attempt: phase.attempt, status: phase.status })),
	};
}

function keyMatches(presented: string | null, expected: string): boolean {
	if (presented === null) return false;
	const left = createHash("sha256").update(presented).digest();
	const right = createHash("sha256").update(expected).digest();
	return timingSafeEqual(left, right);
}

function rpcError(code: number, message: string): unknown {
	return { jsonrpc: "2.0", id: null, error: { code, message } };
}

function toOutcome(result: JournalResult<unknown>): ToolOutcome {
	if (result.ok) return { ok: true, data: result.data as Record<string, unknown> };
	return { ok: false, code: result.code, ...(result.errors !== undefined ? { errors: result.errors } : {}) };
}

function matchPath(pathname: string): Target | null {
	if (pathname === "/healthz") return { endpoint: "healthz" };
	if (pathname === "/login") return { endpoint: "login" };
	if (pathname === "/ultrathink") return { endpoint: "ultrathink" };
	if (pathname === "/mcp") return { endpoint: "mcp" };
	const match = RUN_PATH.exec(pathname);
	if (match?.[1]) return { endpoint: "run", runId: match[1] };
	return null;
}

function isJsonRequest(req: Request): boolean {
	const contentType = req.headers.get("content-type");
	if (contentType === null) return false;
	return contentType.split(";")[0]?.trim().toLowerCase() === "application/json";
}

async function readCapped(req: Request, maxBytes: number): Promise<BodyRead> {
	const declared = req.headers.get("content-length");
	if (declared !== null && Number(declared) > maxBytes) return { ok: false, reason: "too_large" };
	if (req.body === null) return { ok: true, bytes: new Uint8Array(0) };

	const reader = req.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const result = await reader.read();
			if (result.done) break;
			total += result.value.byteLength;
			if (total > maxBytes) {
				await reader.cancel().catch(() => undefined);
				return { ok: false, reason: "too_large" };
			}
			chunks.push(result.value);
		}
	} catch {
		return { ok: false, reason: "unreadable" };
	}

	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return { ok: true, bytes };
}

async function readJson(req: Request, maxBytes: number): Promise<JsonRead> {
	const read = await readCapped(req, maxBytes);
	if (!read.ok) {
		const response = read.reason === "too_large" ? fail(413, "body_too_large") : fail(400, "invalid_json");
		return { ok: false, response };
	}
	try {
		const text = new TextDecoder("utf-8", { fatal: true }).decode(read.bytes);
		return { ok: true, value: JSON.parse(text) };
	} catch {
		return { ok: false, response: fail(400, "invalid_json") };
	}
}

export function createHandler(deps: RouterDeps): (req: Request, peerIp: string) => Promise<Response> {
	const { config, store, auth } = deps;

	async function login(req: Request, peerIp: string): Promise<Response> {
		if (!isJsonRequest(req) || req.headers.get("origin") !== config.publicOrigin) {
			return fail(403, "forbidden");
		}
		const parsed = await readJson(req, config.maxBodyBytes);
		if (!parsed.ok) return parsed.response;
		const password = (parsed.value as { password?: unknown } | null)?.password;
		if (typeof password !== "string") return fail(400, "invalid_input");

		const result = await auth.login({ password, clientIp: clientIpFrom(req, peerIp) });
		if (result.ok) return respond(200, { ok: true }, { "Set-Cookie": result.setCookie });
		if (result.reason === "rate_limited") {
			return fail(429, "rate_limited", { "Retry-After": String(result.retryAfterSec ?? 60) });
		}
		return fail(401, "invalid_credentials");
	}

	async function usageRoute(req: Request): Promise<Response> {
		if (!auth.sessionFor(req)) return fail(401, "unauthenticated");
		return respond(200, USAGE);
	}

	async function createRunRoute(req: Request, peerIp: string): Promise<Response> {
		const session = auth.sessionFor(req);
		if (!session) return fail(401, "unauthenticated");

		const limit = auth.allowRequest({ clientIp: clientIpFrom(req, peerIp), ownerId: session.ownerId });
		if (!limit.ok) return fail(429, "rate_limited", { "Retry-After": String(limit.retryAfterSec) });

		if (!isJsonRequest(req) || req.headers.get("origin") !== config.publicOrigin) {
			return fail(403, "forbidden");
		}

		const parsed = await readJson(req, config.maxBodyBytes);
		if (!parsed.ok) return parsed.response;
		if (typeof parsed.value !== "object" || parsed.value === null || Array.isArray(parsed.value)) {
			return fail(400, "invalid_input");
		}
		const body = parsed.value as { input?: unknown; flags?: unknown };

		const input = sanitizeInput(body.input, config.maxInputChars);
		if (!input.ok) {
			if (input.code === "empty") return respond(200, USAGE);
			if (input.code === "too_long") {
				return respond(413, { error: "input_too_long", maxChars: config.maxInputChars });
			}
			return fail(400, "invalid_input");
		}

		let explicitRoute: Route | undefined;
		if (body.flags !== undefined) {
			if (typeof body.flags !== "object" || body.flags === null || Array.isArray(body.flags)) {
				return fail(400, "invalid_input");
			}
			const flags = body.flags as { route?: unknown };
			if (Object.keys(flags).some((key) => key !== "route")) return fail(400, "unknown_flag");
			const flag = parseRouteFlag(flags.route);
			if (!flag.ok) return fail(400, flag.code);
			explicitRoute = flag.route;
		}
		const choice =
			explicitRoute !== undefined
				? { route: explicitRoute, reason: "route set by flag" }
				: selectRoute(input.text);

		let run: Run;
		try {
			run = store.createRun({ ownerId: session.ownerId, request: input.text, route: choice.route });
		} catch {
			return persistenceUnavailable();
		}

		return respond(202, {
			runId: run.id,
			route: run.route,
			routeReason: choice.reason,
			status: run.status,
			statusUrl: `/ultrathink/runs/${run.id}`,
		});
	}

	async function getRunRoute(req: Request, runId: string): Promise<Response> {
		const session = auth.sessionFor(req);
		if (!session) return fail(401, "unauthenticated");

		let found: { run: Run; phases: PhaseRecord[] } | null;
		try {
			const run = store.getRunForOwner(runId, session.ownerId);
			found = run ? { run, phases: store.listPhases(run.id) } : null;
		} catch {
			return persistenceUnavailable();
		}
		if (!found) return fail(404, "not_found");

		const { run, phases } = found;
		return respond(200, runView(run, phases));
	}

	const journalOpts: JournalOptions = {
		stateDir: config.stateDir,
		maxPromptChars: config.maxInputChars,
		maxAnswerChars: config.maxAnswerChars,
	};

	const mcpHost: McpToolHost = {
		async call(name, args) {
			try {
				switch (name) {
					case "ultrathink_plan":
						return toOutcome(await startPlan(journalOpts, { prompt: args.prompt, sessionId: args.sessionId }));
					case "ultrathink_pending": {
						const pending = listPendingRequests(journalOpts, { sessionId: args.sessionId });
						return toOutcome(pending.ok ? { ok: true, data: { pending: pending.data } } : pending);
					}
					case "ultrathink_show":
						return toOutcome(showRequest(journalOpts, { sessionId: args.sessionId, key: args.key, part: args.part }));
					case "ultrathink_answer":
						return toOutcome(answerRequest(journalOpts, { sessionId: args.sessionId, key: args.key, answer: args.answer }));
					case "ultrathink_status":
						return toOutcome(sessionStatus(journalOpts, { sessionId: args.sessionId }));
					default:
						return { ok: false, code: "unknown_tool" };
				}
			} catch {
				return { ok: false, code: "engine_error" };
			}
		},
	};

	async function mcpRoute(req: Request, peerIp: string): Promise<Response> {
		const expectedKey = config.connectorKey;
		if (expectedKey === undefined) return fail(404, "not_found");
		if (!keyMatches(req.headers.get("x-connector-key"), expectedKey)) return fail(401, "unauthenticated");

		const limit = auth.allowRequest({ clientIp: clientIpFrom(req, peerIp), ownerId: CONNECTOR_RATE_OWNER });
		if (!limit.ok) return fail(429, "rate_limited", { "Retry-After": String(limit.retryAfterSec) });

		if (!isJsonRequest(req)) return fail(415, "unsupported_media_type");
		const parsed = await readJson(req, config.maxBodyBytes);
		if (!parsed.ok) return respond(400, rpcError(-32700, "parse error"));

		const reply = await handleMcpPayload(mcpHost, parsed.value);
		if (reply === null) return new Response(null, { status: 202, headers: SECURITY_HEADERS });
		return respond(200, reply.body);
	}

	return async function handle(req: Request, peerIp: string): Promise<Response> {
		try {
			const target = matchPath(new URL(req.url).pathname);
			if (!target) return fail(404, "not_found");

			const methods = METHODS[target.endpoint];
			if (!methods.includes(req.method)) {
				return fail(405, "method_not_allowed", { Allow: methods.join(", ") });
			}

			if (target.endpoint === "run") return await getRunRoute(req, target.runId);
			if (target.endpoint === "healthz") {
				return store.ping() ? respond(200, { ok: true }) : persistenceUnavailable();
			}
			if (target.endpoint === "login") return await login(req, peerIp);
			if (target.endpoint === "mcp") return await mcpRoute(req, peerIp);
			return req.method === "GET" ? await usageRoute(req) : await createRunRoute(req, peerIp);
		} catch {
			return respond(500, { error: "internal_error", correlationId: randomUUID() });
		}
	};
}
