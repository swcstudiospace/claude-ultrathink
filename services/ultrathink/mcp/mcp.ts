// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

export const MCP_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26"] as const;

export interface ToolDefinition {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
	annotations: Record<string, unknown>;
}

/** The host's result for one tool call. A refusal is a normal outcome, not an exception. */
export type ToolOutcome =
	| { ok: true; data: Record<string, unknown> }
	| { ok: false; code: string; errors?: string[] };

/** The domain side. The host runs each tool; this module only speaks MCP. */
export interface McpToolHost {
	call(name: string, args: Record<string, unknown>): ToolOutcome | Promise<ToolOutcome>;
}

const JSONRPC = "2.0";
const NOTIFICATION_PREFIX = "notifications/";
const INSTRUCTIONS =
	"Run ultrathink planning here. Call ultrathink_plan, answer each pending prompt with ultrathink_show and ultrathink_answer, then call ultrathink_plan again with the same sessionId and prompt until status is planned.";

const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const READ_WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };

export const TOOL_DEFINITIONS: readonly ToolDefinition[] = [
	{
		name: "ultrathink_plan",
		description:
			"Start or continue an ultrathink planning session for a request. Returns the sessionId, the status, and the pending prompts. Answer each pending prompt, then call this again with the same sessionId and prompt until status is planned.",
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
		description: "Return the status of a planning session and its pending prompts.",
		inputSchema: {
			type: "object",
			properties: { sessionId: { type: "string" } },
			required: ["sessionId"],
			additionalProperties: false,
		},
		annotations: READ_ONLY,
	},
];

type RpcResponse =
	| { jsonrpc: "2.0"; id: unknown; result: unknown }
	| { jsonrpc: "2.0"; id: unknown; error: { code: number; message: string } };

interface ToolResult {
	content: { type: "text"; text: string }[];
	structuredContent: Record<string, unknown>;
	isError: boolean;
}

/**
 * Handles one parsed JSON-RPC payload: a single message or a batch.
 * Returns null when nothing should be sent back (notifications only).
 * Batch messages run one at a time, in payload order, so host side effects follow the batch order.
 */
export async function handleMcpPayload(host: McpToolHost, payload: unknown): Promise<{ body: unknown } | null> {
	if (!Array.isArray(payload)) {
		const reply = await handleMessage(host, payload);
		return reply === null ? null : { body: reply };
	}
	if (payload.length === 0) return { body: invalidRequest() };
	const replies: RpcResponse[] = [];
	for (const message of payload) {
		const reply = await handleMessage(host, message);
		if (reply !== null) replies.push(reply);
	}
	return replies.length === 0 ? null : { body: replies };
}

async function handleMessage(host: McpToolHost, message: unknown): Promise<RpcResponse | null> {
	if (!isRecord(message)) return invalidRequest();
	if (message.jsonrpc !== JSONRPC || typeof message.method !== "string") return invalidRequest();
	const id = message.id;
	const method = message.method;
	// A message without an id is a notification, and notifications/* never get a reply.
	// Notifications are not dispatched, so no host side effect runs without a reply.
	if (id === undefined || method.startsWith(NOTIFICATION_PREFIX)) return null;
	try {
		return await dispatch(host, id, method, message.params);
	} catch {
		// Host failures are reported without the thrown message or stack.
		return rpcError(id, INTERNAL_ERROR, "internal error");
	}
}

async function dispatch(host: McpToolHost, id: unknown, method: string, params: unknown): Promise<RpcResponse> {
	switch (method) {
		case "initialize":
			return rpcResult(id, initializeResult(params));
		case "ping":
			return rpcResult(id, {});
		case "tools/list":
			return rpcResult(id, { tools: TOOL_DEFINITIONS });
		case "tools/call":
			return callTool(host, id, params);
		default:
			return rpcError(id, METHOD_NOT_FOUND, "method not found");
	}
}

function initializeResult(params: unknown) {
	const requested = isRecord(params) ? params.protocolVersion : undefined;
	const protocolVersion =
		MCP_PROTOCOL_VERSIONS.find((version) => version === requested) ?? MCP_PROTOCOL_VERSIONS[0];
	return {
		protocolVersion,
		capabilities: { tools: {} },
		serverInfo: { name: "ultrathink", version: "0.2.0" },
		instructions: INSTRUCTIONS,
	};
}

async function callTool(host: McpToolHost, id: unknown, params: unknown): Promise<RpcResponse> {
	const name = isRecord(params) ? params.name : undefined;
	const args = isRecord(params) ? params.arguments : undefined;
	if (typeof name !== "string" || !TOOL_DEFINITIONS.some((tool) => tool.name === name)) {
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
		const data = outcome.data;
		if (!isRecord(data)) throw new Error("malformed host outcome");
		return {
			content: [{ type: "text", text: JSON.stringify(data) }],
			structuredContent: data,
			isError: false,
		};
	}
	const { code, errors } = outcome;
	if (typeof code !== "string") throw new Error("malformed host outcome");
	if (errors !== undefined && !isStringArray(errors)) throw new Error("malformed host outcome");
	return {
		content: [{ type: "text", text: `request refused: ${code}` }],
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
