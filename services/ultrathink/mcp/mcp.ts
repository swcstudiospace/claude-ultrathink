// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import pkg from "../../../package.json";
import { promptDefinitions, renderPrompt } from "./prompts.ts";
import type { ResourceRegistry } from "./resources.ts";
import { CONNECTOR_TOOL_DEFINITIONS, GRAPH_UI_META, LARGE_RESULT_META, READ_ONLY } from "./tools-connector.ts";

/** Newest first: initialize answers with the requested version when listed here, otherwise the first. */
export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"] as const;

/** Version assumed for a request that names none. It is the newest one that still allows JSON-RPC batches. */
export const DEFAULT_PROTOCOL_VERSION = "2025-03-26";

/** Versions from this one on forbid batches. Versions are ISO dates, so string order is date order. */
const BATCH_REMOVED_IN = "2025-06-18";

export interface ToolDefinition {
	name: string;
	title: string;
	description: string;
	inputSchema: Record<string, unknown>;
	annotations: Record<string, unknown>;
	/** MCP `_meta`: the UI resource a host draws the result with, and the result size Claude Code allows. */
	_meta?: Record<string, unknown>;
}

/**
 * The host's result for one tool call. A refusal is a normal outcome, not an exception.
 * When `text` is present it is the tool result content and `data` becomes structuredContent only;
 * otherwise the content is the JSON of `data`. Claude Code shows the model structuredContent instead of content
 * when both exist, so a host that returns `text` also puts the same text in `data.text`.
 */
export type ToolOutcome =
	| { ok: true; data: Record<string, unknown>; text?: string }
	| { ok: false; code: string; errors?: string[] };

/** The domain side. The host runs each tool; this module only speaks MCP. */
export interface McpToolHost {
	call(name: string, args: Record<string, unknown>): ToolOutcome | Promise<ToolOutcome>;
	/** Absent means { serverPlanning: false }. */
	capabilities?(): { serverPlanning: boolean };
	/** The `ui://` documents the host serves. Absent means none: resources/list is empty and every read is not found. */
	resources?: ResourceRegistry;
}

export interface McpContext {
	/** The negotiated MCP-Protocol-Version of this request. Absent means DEFAULT_PROTOCOL_VERSION. */
	protocolVersion?: string;
}

const JSONRPC = "2.0";
const NOTIFICATION_PREFIX = "notifications/";
const UPLIFT_TOOL = "ultrathink_uplift";
const UI_EXTENSION = "io.modelcontextprotocol/ui";

// Claude Code cuts server instructions at 4096 characters; each mode stays under the 3500 the tests pin.
const CLIENT_PLANNING =
	"ultrathink plans a request before work starts. When the user's message starts with /ultrathink, the request is everything after it, verbatim. If nothing follows, ask for a request and call no tool. Otherwise call ultrathink_plan with the request as prompt, answer each pending prompt with ultrathink_show and ultrathink_answer, then call ultrathink_plan again with the same sessionId and prompt until status is planned. Then call ultrathink_result with the sessionId, ask the user the questions in the plan that matter (or state the defaults you assume), and carry out the plan.";
const SERVER_PLANNING =
	"ultrathink plans a request on the server before work starts. When the user's message starts with /ultrathink, the request is everything after it, verbatim. If nothing follows, ask for a request and call no tool. Otherwise call ultrathink_uplift with the request as prompt; the server does the thinking and needs no work from you. Then call ultrathink_result with the sessionId until its status is planned, also when ultrathink_uplift already reports planned, because only ultrathink_result returns the plan. Then ask the user the questions in the plan that matter (or state the defaults you assume), and carry out the plan.";
const COMMAND_ROUTING =
	"A message that starts with /ultrathink- and a command name is that command, not a request to plan. /ultrathink-think [sessionId] calls ultrathink_graph with the sessionId when one follows (the newest planned session otherwise). /ultrathink-last calls ultrathink_sessions with limit 5, then ultrathink_graph and ultrathink_result with the sessionId of the newest session whose status is planned. /ultrathink-status calls ultrathink_sessions with no arguments. /ultrathink-quick <message> is answered directly, with no ultrathink tool. Any other /ultrathink-<name> (for example /ultrathink-plan or /ultrathink-ship) calls ultrathink_command with command set to the name and args set to the rest of the message, verbatim; relay its message to the user and make the tool call it names in next. When a plan is ready, show its wave tree to the user first, unchanged, in a code block, and its mermaid diagram too only if your interface renders Mermaid.";
const CLIENT_GRAPH_RULE =
	"When a client-answered plan is ready, call ultrathink_graph once with its sessionId besides ultrathink_result.";
const SERVER_GRAPH_RULE =
	"With server planning the plan card already shows the graph: after ultrathink_result, do not call ultrathink_graph for the same session unless the user asks for it, for example with /ultrathink-think or /ultrathink-last.";
const CLIENT_INSTRUCTIONS = [CLIENT_PLANNING, COMMAND_ROUTING, CLIENT_GRAPH_RULE].join("\n\n");
const SERVER_INSTRUCTIONS = [SERVER_PLANNING, COMMAND_ROUTING, SERVER_GRAPH_RULE].join("\n\n");

const SERVER_INFO = { name: "ultrathink", version: pkg.version };

const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const RESOURCE_NOT_FOUND = -32002;
const INTERNAL_ERROR = -32603;

const READ_WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const READ_WRITE_OPEN_WORLD = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true };

/** Every tool the service can offer. Use toolDefinitions for the list a host actually serves. */
export const TOOL_DEFINITIONS: readonly ToolDefinition[] = [
	{
		name: UPLIFT_TOOL,
		title: "Plan a request on the server",
		description:
			"The entry point for the /ultrathink command. The trigger is /ultrathink followed by a space and the request (pass everything after it, verbatim, as prompt), or a message that is exactly /ultrathink. A message that starts with /ultrathink- (a hyphen) is a different command: use ultrathink_command (or ultrathink_graph / ultrathink_sessions for /ultrathink-think, /ultrathink-last, /ultrathink-status), not this tool. The server does the thinking; no work is needed from you while it runs. Returns a sessionId and a status. Then call ultrathink_result with the sessionId until its status is planned, also when this tool already reports planned, because only ultrathink_result returns the plan.",
		inputSchema: {
			type: "object",
			properties: {
				prompt: { type: "string", description: "The request to plan." },
				sessionId: {
					type: "string",
					description: "Session id from a previous call. Omit to start a new session.",
				},
			},
			required: ["prompt"],
			additionalProperties: false,
		},
		annotations: READ_WRITE_OPEN_WORLD,
		_meta: GRAPH_UI_META,
	},
	{
		name: "ultrathink_plan",
		title: "Start or continue a client-answered plan",
		description:
			"Start or continue an ultrathink planning session for a request. This is the entry point for the /ultrathink command. The trigger is /ultrathink followed by a space and the request (pass everything after it, verbatim, as prompt), or a message that is exactly /ultrathink. A message that starts with /ultrathink- (a hyphen) is a different command: use ultrathink_command (or ultrathink_graph / ultrathink_sessions for /ultrathink-think, /ultrathink-last, /ultrathink-status), not this tool. Returns the sessionId, the status, and the pending prompts. Answer each pending prompt, then call this again with the same sessionId and prompt until status is planned.",
		inputSchema: {
			type: "object",
			properties: {
				prompt: { type: "string", description: "The request to plan." },
				sessionId: {
					type: "string",
					description: "Session id from a previous call. Omit to start a new session.",
				},
			},
			required: ["prompt"],
			additionalProperties: false,
		},
		annotations: READ_WRITE,
	},
	{
		name: "ultrathink_pending",
		title: "List pending prompts",
		description: "List the prompts still waiting for an answer in a planning session.",
		inputSchema: {
			type: "object",
			properties: { sessionId: { type: "string" } },
			required: ["sessionId"],
			additionalProperties: false,
		},
		annotations: READ_ONLY,
	},
	{
		name: "ultrathink_show",
		title: "Show a pending prompt",
		description: "Return the system and user text of one pending prompt, to be answered by the calling model.",
		inputSchema: {
			type: "object",
			properties: {
				sessionId: { type: "string" },
				key: { type: "string" },
				part: { type: "string", enum: ["system", "user"] },
			},
			required: ["sessionId", "key"],
			additionalProperties: false,
		},
		annotations: READ_ONLY,
	},
	{
		name: "ultrathink_answer",
		title: "Answer a pending prompt",
		description:
			"Store the answer to one pending prompt. The answer is validated. A rejected answer returns the reasons and the prompt stays pending.",
		inputSchema: {
			type: "object",
			properties: {
				sessionId: { type: "string" },
				key: { type: "string" },
				answer: { type: "string" },
			},
			required: ["sessionId", "key", "answer"],
			additionalProperties: false,
		},
		annotations: READ_WRITE,
	},
	{
		name: "ultrathink_status",
		title: "Get planning status",
		description: "Return the status of a planning session and its pending prompts.",
		inputSchema: {
			type: "object",
			properties: { sessionId: { type: "string" } },
			required: ["sessionId"],
			additionalProperties: false,
		},
		annotations: READ_ONLY,
	},
	{
		name: "ultrathink_result",
		title: "Get the uplifted plan",
		description:
			"Return the finished plan for a session from ultrathink_uplift or a finished ultrathink_plan session: the request, the specification, the Graph of Thought conclusions and the clarifying questions. If the plan is still running, this waits up to waitSeconds and then reports status running; call it again. After receiving the plan, ask the user its questions that matter (or state the defaults you assume) and carry out the plan.",
		inputSchema: {
			type: "object",
			properties: {
				sessionId: { type: "string" },
				waitSeconds: {
					type: "integer",
					minimum: 0,
					maximum: 45,
					default: 40,
					description: "How long to wait for a running plan before reporting status running.",
				},
				detail: {
					type: "string",
					enum: ["brief", "full"],
					default: "brief",
					description: "full adds the numbered Chain of Thought steps of every node.",
				},
			},
			required: ["sessionId"],
			additionalProperties: false,
		},
		annotations: READ_ONLY,
		_meta: LARGE_RESULT_META,
	},
	...CONNECTOR_TOOL_DEFINITIONS,
];

const CLIENT_TOOL_DEFINITIONS: readonly ToolDefinition[] = TOOL_DEFINITIONS.filter((tool) => tool.name !== UPLIFT_TOOL);

/** The tools a host serves: ultrathink_uplift exists only when the host plans on the server. */
export function toolDefinitions(serverPlanning: boolean): readonly ToolDefinition[] {
	return serverPlanning ? TOOL_DEFINITIONS : CLIENT_TOOL_DEFINITIONS;
}

type RpcResponse =
	| { jsonrpc: "2.0"; id: unknown; result: unknown }
	| { jsonrpc: "2.0"; id: unknown; error: { code: number; message: string } };

interface ToolResult {
	content: { type: "text"; text: string }[];
	structuredContent: Record<string, unknown>;
	isError: boolean;
}

/** One message's reply. `status` is set only when the HTTP status must differ from 200. */
interface Handled {
	reply: RpcResponse;
	status?: number;
}

/**
 * Handles one parsed JSON-RPC payload.
 * Returns null when nothing should be sent back (notifications and client responses only).
 * A batch is refused with 400 from 2025-06-18 on and handled for 2025-03-26, one message at a time in
 * payload order, so host side effects follow the batch order. A request id that is not a string or an
 * integer is refused with 400.
 */
export async function handleMcpPayload(
	host: McpToolHost,
	payload: unknown,
	ctx?: McpContext,
): Promise<{ body: unknown; status?: number } | null> {
	if (!Array.isArray(payload)) {
		const handled = await handleMessage(host, payload);
		if (handled === null) return null;
		return handled.status === undefined
			? { body: handled.reply }
			: { body: handled.reply, status: handled.status };
	}
	if ((ctx?.protocolVersion ?? DEFAULT_PROTOCOL_VERSION) >= BATCH_REMOVED_IN) {
		return { body: invalidRequest(), status: 400 };
	}
	if (payload.length === 0) return { body: invalidRequest() };
	const replies: RpcResponse[] = [];
	for (const message of payload) {
		const handled = await handleMessage(host, message);
		if (handled !== null) replies.push(handled.reply);
	}
	return replies.length === 0 ? null : { body: replies };
}

async function handleMessage(host: McpToolHost, message: unknown): Promise<Handled | null> {
	if (!isRecord(message) || message.jsonrpc !== JSONRPC) return { reply: invalidRequest() };
	const id = message.id;
	const method = message.method;
	if (method === undefined) {
		// A message with an id and a result or error answers a request the server never sends: no reply.
		const isResponse = id !== undefined && ("result" in message || "error" in message);
		return isResponse ? null : { reply: invalidRequest() };
	}
	if (typeof method !== "string") return { reply: invalidRequest() };
	// A message without an id is a notification. It is never dispatched, so no host side effect runs without a reply.
	if (id === undefined) return null;
	if (typeof id !== "string" && !(typeof id === "number" && Number.isInteger(id))) {
		return { reply: invalidRequest(), status: 400 };
	}
	// A request cannot be a notification: the client waits for an answer.
	if (method.startsWith(NOTIFICATION_PREFIX)) return { reply: rpcError(id, METHOD_NOT_FOUND, "method not found") };
	try {
		return { reply: await dispatch(host, id, method, message.params) };
	} catch {
		// Host failures are reported without the thrown message or stack.
		return { reply: rpcError(id, INTERNAL_ERROR, "internal error") };
	}
}

async function dispatch(host: McpToolHost, id: unknown, method: string, params: unknown): Promise<RpcResponse> {
	const serverPlanning = host.capabilities?.().serverPlanning === true;
	switch (method) {
		case "initialize":
			return rpcResult(id, initializeResult(params, serverPlanning));
		case "ping":
			return rpcResult(id, {});
		case "tools/list":
			return rpcResult(id, { tools: toolDefinitions(serverPlanning) });
		case "tools/call":
			return callTool(host, id, params, serverPlanning);
		case "prompts/list":
			return rpcResult(id, { prompts: promptDefinitions({ serverPlanning }) });
		case "prompts/get":
			return getPrompt(id, params, serverPlanning);
		case "resources/list":
			return rpcResult(id, { resources: host.resources?.list() ?? [] });
		case "resources/templates/list":
			return rpcResult(id, { resourceTemplates: host.resources?.templates() ?? [] });
		case "resources/read":
			return readResource(host, id, params);
		default:
			return rpcError(id, METHOD_NOT_FOUND, "method not found");
	}
}

function initializeResult(params: unknown, serverPlanning: boolean) {
	const requested = isRecord(params) ? params.protocolVersion : undefined;
	const protocolVersion =
		SUPPORTED_PROTOCOL_VERSIONS.find((version) => version === requested) ?? SUPPORTED_PROTOCOL_VERSIONS[0];
	return {
		protocolVersion,
		// The UI extension is announced unconditionally: claude.ai web renders MCP Apps without sending the extension itself.
		capabilities: { tools: {}, prompts: {}, resources: {}, extensions: { [UI_EXTENSION]: {} } },
		serverInfo: SERVER_INFO,
		instructions: serverPlanning ? SERVER_INSTRUCTIONS : CLIENT_INSTRUCTIONS,
	};
}

/** The 2025-era revisions answer a resource that does not exist with -32002; -32602 is for a malformed uri. */
function readResource(host: McpToolHost, id: unknown, params: unknown): RpcResponse {
	const uri = isRecord(params) ? params.uri : undefined;
	const read = host.resources
		? host.resources.read(uri)
		: { ok: false as const, code: typeof uri === "string" ? ("not_found" as const) : ("invalid_uri" as const) };
	if (read.ok) return rpcResult(id, { contents: read.contents });
	return read.code === "not_found"
		? rpcError(id, RESOURCE_NOT_FOUND, "resource not found")
		: rpcError(id, INVALID_PARAMS, "invalid params: uri must be a ui:// uri");
}

function getPrompt(id: unknown, params: unknown, serverPlanning: boolean): RpcResponse {
	const name = isRecord(params) ? params.name : undefined;
	const given = isRecord(params) ? params.arguments : undefined;
	const args: Record<string, unknown> = isRecord(given) ? given : {};
	const prompt = renderPrompt(name, args, { serverPlanning });
	if (!prompt.ok) return rpcError(id, INVALID_PARAMS, prompt.message);
	return rpcResult(id, { description: prompt.description, messages: prompt.messages });
}

async function callTool(
	host: McpToolHost,
	id: unknown,
	params: unknown,
	serverPlanning: boolean,
): Promise<RpcResponse> {
	const name = isRecord(params) ? params.name : undefined;
	const args = isRecord(params) ? params.arguments : undefined;
	if (typeof name !== "string" || !toolDefinitions(serverPlanning).some((tool) => tool.name === name)) {
		return rpcError(id, INVALID_PARAMS, "unknown tool");
	}
	if (!isRecord(args)) {
		return rpcResult(id, {
			content: [{ type: "text", text: "invalid arguments" }],
			structuredContent: { error: "invalid_arguments" },
			isError: true,
		});
	}
	return rpcResult(id, toolResult(await host.call(name, args)));
}

/** Maps a host outcome to an MCP tool result. Throws on a malformed outcome, which becomes -32603. */
function toolResult(outcome: unknown): ToolResult {
	if (!isRecord(outcome) || typeof outcome.ok !== "boolean") throw new Error("malformed host outcome");
	if (outcome.ok) {
		const { data, text } = outcome;
		if (!isRecord(data)) throw new Error("malformed host outcome");
		if (text !== undefined && typeof text !== "string") throw new Error("malformed host outcome");
		return {
			content: [{ type: "text", text: text ?? JSON.stringify(data) }],
			structuredContent: data,
			isError: false,
		};
	}
	const { code, errors } = outcome;
	if (typeof code !== "string") throw new Error("malformed host outcome");
	if (errors !== undefined && !isStringArray(errors)) throw new Error("malformed host outcome");
	const detail = errors !== undefined && errors.length > 0 ? ` (${errors.join("; ")})` : "";
	return {
		content: [{ type: "text", text: `request refused: ${code}${detail}` }],
		structuredContent: { error: code, ...(errors !== undefined ? { errors } : {}) },
		isError: true,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function rpcResult(id: unknown, result: unknown): RpcResponse {
	return { jsonrpc: JSONRPC, id, result };
}

function rpcError(id: unknown, code: number, message: string): RpcResponse {
	return { jsonrpc: JSONRPC, id, error: { code, message } };
}

function invalidRequest(): RpcResponse {
	return rpcError(null, INVALID_REQUEST, "invalid request");
}
