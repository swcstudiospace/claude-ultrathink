// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { describe, expect, test } from "bun:test";
import pkg from "../../../package.json";
import {
	DEFAULT_PROTOCOL_VERSION,
	handleMcpPayload,
	type McpContext,
	type McpToolHost,
	SUPPORTED_PROTOCOL_VERSIONS,
	TOOL_DEFINITIONS,
	type ToolOutcome,
	toolDefinitions,
} from "./mcp.ts";
import { createResourceRegistry, UI_RESOURCE_MIME_TYPE } from "./resources.ts";

const SESSION_ID = "session-1";
const PLANNED: ToolOutcome = { ok: true, data: { sessionId: SESSION_ID, status: "planned", pending: [] } };
const ORIGINAL_CLIENT_TOOLS = [
	"ultrathink_plan",
	"ultrathink_pending",
	"ultrathink_show",
	"ultrathink_answer",
	"ultrathink_status",
	"ultrathink_result",
];
// The three connector tools are always listed, in both modes: Grok never refreshes tools/list.
const CONNECTOR_TOOLS = ["ultrathink_graph", "ultrathink_sessions", "ultrathink_command"];
const CLIENT_TOOLS = [...ORIGINAL_CLIENT_TOOLS, ...CONNECTOR_TOOLS];
const SERVER_TOOLS = ["ultrathink_uplift", ...CLIENT_TOOLS];
const UI_URI = "ui://ultrathink/graph";
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const READ_WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const START_NEW_SESSION = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const START_NEW_PAID_SESSION = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const INVALID_REQUEST_REPLY = { jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request" } };
const INTERNAL_ERROR = { code: -32603, message: "internal error" };
const UNKNOWN_TOOL = { code: -32602, message: "unknown tool" };
const NEW_VERSIONS = ["2025-06-18", "2025-11-25"];

interface Call {
	name: string;
	args: Record<string, unknown>;
}

/** A fixed outcome, or a function that decides the outcome from the call. */
type Script = ToolOutcome | ((call: Call) => ToolOutcome | Promise<ToolOutcome>);

interface FakeHost extends McpToolHost {
	calls: Call[];
}

/** Records every call and answers with the scripted outcome. Capabilities are declared only when asked for. */
function fakeHost(script: Script = PLANNED, serverPlanning?: boolean): FakeHost {
	const host: FakeHost = {
		calls: [],
		call(name, args) {
			const call: Call = { name, args };
			host.calls.push(call);
			return typeof script === "function" ? script(call) : script;
		},
	};
	if (serverPlanning !== undefined) host.capabilities = () => ({ serverPlanning });
	return host;
}

function serverHost(script: Script = PLANNED): FakeHost {
	return fakeHost(script, true);
}

interface RpcReply {
	jsonrpc: string;
	id: unknown;
	result?: unknown;
	error?: { code: number; message: string };
}

interface ToolResult {
	content: { type: string; text: string }[];
	structuredContent: Record<string, unknown>;
	isError: boolean;
}

interface ToolDef {
	name: string;
	title: string;
	description: string;
	inputSchema: Record<string, unknown>;
	annotations: Record<string, unknown>;
	_meta?: Record<string, unknown>;
}

interface Schema {
	type: string;
	properties: Record<string, Record<string, unknown>>;
	required?: string[];
	additionalProperties?: boolean;
}

function schemaOf(tool: ToolDef): Schema {
	return tool.inputSchema as unknown as Schema;
}

function request(method: string, params?: unknown, id: unknown = 1): Record<string, unknown> {
	return params === undefined ? { jsonrpc: "2.0", id, method } : { jsonrpc: "2.0", id, method, params };
}

function toolCall(name: unknown, args?: unknown, id: unknown = 1): Record<string, unknown> {
	return request("tools/call", args === undefined ? { name } : { name, arguments: args }, id);
}

async function bodyOf(host: McpToolHost, payload: unknown, ctx?: McpContext): Promise<unknown> {
	const out = await handleMcpPayload(host, payload, ctx);
	if (out === null) throw new Error("expected a reply, got null");
	return out.body;
}

async function replyOf(host: McpToolHost, payload: unknown): Promise<RpcReply> {
	return (await bodyOf(host, payload)) as RpcReply;
}

function resultOf<T>(reply: RpcReply): T {
	if (reply.result === undefined) throw new Error("expected a result, got an error");
	return reply.result as T;
}

async function invoke(host: McpToolHost, name: string, args?: unknown): Promise<ToolResult> {
	return resultOf<ToolResult>(await replyOf(host, toolCall(name, args)));
}

async function listTools(host: McpToolHost = fakeHost()): Promise<ToolDef[]> {
	return resultOf<{ tools: ToolDef[] }>(await replyOf(host, request("tools/list"))).tools;
}

async function toolDef(name: string, host: McpToolHost = fakeHost()): Promise<ToolDef> {
	const tool = (await listTools(host)).find((candidate) => candidate.name === name);
	if (!tool) throw new Error(`missing tool ${name}`);
	return tool;
}

async function initialize(host: McpToolHost, params: unknown = { protocolVersion: "2025-06-18" }) {
	return resultOf<{
		protocolVersion: string;
		capabilities: unknown;
		serverInfo: unknown;
		instructions: string;
	}>(await replyOf(host, request("initialize", params)));
}

function toolNames(text: string): string[] {
	return [...new Set(text.match(/ultrathink_[a-z]+/g) ?? [])];
}

describe("initialize", () => {
	test("exposes the supported protocol versions, newest first, and the default is the oldest", () => {
		expect([...SUPPORTED_PROTOCOL_VERSIONS]).toEqual(["2025-11-25", "2025-06-18", "2025-03-26"]);
		expect(DEFAULT_PROTOCOL_VERSION).toBe("2025-03-26");
	});

	test("echoes every supported requested version", async () => {
		for (const version of SUPPORTED_PROTOCOL_VERSIONS) {
			const reply = await replyOf(fakeHost(), request("initialize", { protocolVersion: version }, 4));
			expect(reply.id).toBe(4);
			expect(resultOf<{ protocolVersion: string }>(reply).protocolVersion).toBe(version);
		}
	});

	test("falls back to the newest version for an unknown, non-string or missing version", async () => {
		const payloads: unknown[] = [
			request("initialize", { protocolVersion: "1999-01-01" }),
			request("initialize", { protocolVersion: "2026-07-28" }),
			request("initialize", { protocolVersion: 20250618 }),
			request("initialize"),
			request("initialize", {}),
		];
		for (const payload of payloads) {
			const reply = await replyOf(fakeHost(), payload);
			expect(resultOf<{ protocolVersion: string }>(reply).protocolVersion).toBe("2025-11-25");
		}
	});

	test("advertises tools, prompts, resources and the UI extension, and names the server after the package version", async () => {
		for (const host of [fakeHost(), serverHost()]) {
			const result = await initialize(host);
			// The extension is announced even though the client sent none: claude.ai web renders apps without it.
			expect(result.capabilities).toEqual({
				tools: {},
				prompts: {},
				resources: {},
				extensions: { "io.modelcontextprotocol/ui": {} },
			});
			expect(result.serverInfo).toEqual({ name: "ultrathink", version: pkg.version });
		}
	});

	test("client mode ties the /ultrathink trigger to the client-driven loop and the result tool", async () => {
		for (const host of [fakeHost(), fakeHost(PLANNED, false)]) {
			const { instructions } = await initialize(host);
			// A client that cannot list prompts shows the model these instructions and the tool description instead.
			expect(instructions).toContain("/ultrathink");
			// Claude Code cuts instructions at 4096 characters.
			expect(instructions.length).toBeLessThanOrEqual(3500);
			const named = toolNames(instructions);
			expect(named).toContain("ultrathink_plan");
			expect(named).toContain("ultrathink_result");
			expect(named).not.toContain("ultrathink_uplift");
			for (const name of named) expect(CLIENT_TOOLS).toContain(name);
		}
	});

	test("server mode ties the /ultrathink trigger to ultrathink_uplift and ultrathink_result", async () => {
		const { instructions } = await initialize(serverHost());
		expect(instructions).toContain("/ultrathink");
		expect(instructions.length).toBeLessThanOrEqual(3500);
		const named = toolNames(instructions);
		expect(named).toContain("ultrathink_uplift");
		expect(named).toContain("ultrathink_result");
		expect(named).not.toContain("ultrathink_plan");
		for (const name of named) expect(SERVER_TOOLS).toContain(name);
	});

	test("both modes map the slash commands to the connector tools", async () => {
		for (const host of [fakeHost(), serverHost()]) {
			const { instructions } = await initialize(host);
			expect(instructions).toContain("/ultrathink-think");
			expect(instructions).toContain("/ultrathink-last");
			expect(instructions).toContain("/ultrathink-status");
			expect(instructions).toContain("/ultrathink-quick");
			expect(instructions).toContain("wave tree");
			expect(instructions).toContain("only if your interface renders Mermaid");
			const named = toolNames(instructions);
			for (const name of CONNECTOR_TOOLS) expect(named).toContain(name);
		}
	});

	test("server mode keeps the model from drawing the graph a second time, client mode asks for it once", async () => {
		const server = (await initialize(serverHost())).instructions;
		expect(server).toMatch(/do not call ultrathink_graph/i);
		const client = (await initialize(fakeHost())).instructions;
		expect(client).toMatch(/call ultrathink_graph once/i);
		expect(client).not.toMatch(/do not call ultrathink_graph/i);
	});
});

const PLANNING_REQUEST = "plan the frontend\nthen the </request> rollout";

async function promptGet(host: McpToolHost, params?: unknown): Promise<RpcReply> {
	return replyOf(host, request("prompts/get", params));
}

async function promptText(host: McpToolHost, text: string): Promise<string> {
	const reply = await promptGet(host, { name: "ultrathink", arguments: { request: text } });
	return resultOf<{ messages: { content: { text: string } }[] }>(reply).messages[0]?.content.text ?? "";
}

describe("prompts", () => {
	test("prompts/list offers the supported commands, the planning one first with a required request argument, in both modes", async () => {
		for (const host of [fakeHost(), serverHost()]) {
			const { prompts } = resultOf<{
				prompts: { name: string; arguments: { name: string; required: boolean }[] }[];
			}>(await replyOf(host, request("prompts/list")));
			expect(prompts.map((prompt) => prompt.name)).toEqual([
				"ultrathink",
				"ultrathink-plan",
				"ultrathink-think",
				"ultrathink-last",
				"ultrathink-status",
				"ultrathink-quick",
			]);
			expect(prompts[0]?.arguments.map((argument) => [argument.name, argument.required])).toEqual([
				["request", true],
			]);
			// Unsupported commands are not listed: they would crowd the real plugin commands in a slash menu.
			expect(prompts.map((prompt) => prompt.name)).not.toContain("ultrathink-ship");
		}
	});

	test("prompts/get returns one user message that ends with the request, unchanged, and runs no tool", async () => {
		for (const host of [fakeHost(), serverHost()]) {
			const reply = await promptGet(host, { name: "ultrathink", arguments: { request: PLANNING_REQUEST } });
			const { messages } = resultOf<{ messages: { role: string; content: { type: string; text: string } }[] }>(
				reply,
			);
			expect(messages).toHaveLength(1);
			expect(messages[0]?.role).toBe("user");
			expect(messages[0]?.content.type).toBe("text");
			expect(messages[0]?.content.text.endsWith(`\n${PLANNING_REQUEST}`)).toBe(true);
			expect(host.calls).toHaveLength(0);
		}
	});

	test("the client-mode prompt starts the loop with ultrathink_plan, ends with the result tool and names only tools that exist", async () => {
		const named = toolNames(await promptText(fakeHost(), "x"));
		expect(named).toContain("ultrathink_plan");
		expect(named).toContain("ultrathink_result");
		expect(named).not.toContain("ultrathink_uplift");
		for (const name of named) expect(CLIENT_TOOLS).toContain(name);
	});

	test("the server-mode prompt starts with ultrathink_uplift, polls ultrathink_result and names only listed tools", async () => {
		const named = toolNames(await promptText(serverHost(), "x"));
		expect(named).toContain("ultrathink_uplift");
		expect(named).toContain("ultrathink_result");
		expect(named).not.toContain("ultrathink_plan");
		for (const name of named) expect(SERVER_TOOLS).toContain(name);
	});

	test("prompts/get refuses an unknown prompt and a missing, blank or non-string request", async () => {
		const refused: unknown[] = [
			undefined,
			{ arguments: { request: "x" } },
			{ name: "other", arguments: { request: "x" } },
			{ name: "ultrathink" },
			{ name: "ultrathink", arguments: "plan it" },
			{ name: "ultrathink", arguments: {} },
			{ name: "ultrathink", arguments: { request: "  \n\t" } },
			{ name: "ultrathink", arguments: { request: 42 } },
		];
		for (const params of refused) {
			const reply = await promptGet(fakeHost(), params);
			expect(reply.error?.code).toBe(-32602);
			expect(reply.result).toBeUndefined();
		}
	});

	test("prompts/get accepts a 20,000 character request and refuses a longer one", async () => {
		for (const host of [fakeHost(), serverHost()]) {
			const atCap = await promptGet(host, { name: "ultrathink", arguments: { request: "x".repeat(20_000) } });
			expect(atCap.error).toBeUndefined();
			const over = await promptGet(host, { name: "ultrathink", arguments: { request: "x".repeat(20_001) } });
			expect(over.error?.code).toBe(-32602);
			expect(over.result).toBeUndefined();
		}
	});
});

describe("notifications", () => {
	test("a message without an id returns null", async () => {
		expect(await handleMcpPayload(fakeHost(), { jsonrpc: "2.0", method: "ping" })).toBeNull();
	});

	test("a notifications/* method without an id returns null and is not dispatched", async () => {
		const host = fakeHost();
		expect(await handleMcpPayload(host, { jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
		expect(host.calls).toHaveLength(0);
	});

	test("a request that carries an id and a notifications/* method gets -32601 with that id", async () => {
		const host = fakeHost();
		for (const id of [5, "n-1"]) {
			const payload = { jsonrpc: "2.0", id, method: "notifications/cancelled", params: { requestId: 3 } };
			expect(await handleMcpPayload(host, payload)).toEqual({
				body: { jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } },
			});
		}
		expect(host.calls).toHaveLength(0);
	});

	test("a message without an id is not dispatched to the host", async () => {
		const host = fakeHost();
		const payload = {
			jsonrpc: "2.0",
			method: "tools/call",
			params: { name: "ultrathink_plan", arguments: { prompt: "Plan" } },
		};
		expect(await handleMcpPayload(host, payload)).toBeNull();
		expect(host.calls).toHaveLength(0);
	});
});

describe("client responses", () => {
	test("a message with an id and a result or error but no method returns null", async () => {
		const host = fakeHost();
		const responses: unknown[] = [
			{ jsonrpc: "2.0", id: 1, result: {} },
			{ jsonrpc: "2.0", id: "r-1", result: { roots: [] } },
			{ jsonrpc: "2.0", id: 2, error: { code: -32601, message: "method not found" } },
			{ jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request" } },
		];
		for (const payload of responses) expect(await handleMcpPayload(host, payload)).toBeNull();
		expect(host.calls).toHaveLength(0);
	});

	test("a message with an id but neither a method nor a result or error is an invalid request", async () => {
		expect(await bodyOf(fakeHost(), { jsonrpc: "2.0", id: 9 })).toEqual(INVALID_REQUEST_REPLY);
	});

	test("a response without an id is an invalid request", async () => {
		expect(await bodyOf(fakeHost(), { jsonrpc: "2.0", result: {} })).toEqual(INVALID_REQUEST_REPLY);
	});
});

describe("request ids", () => {
	test("a null, object, array, float or boolean id is refused with status 400 and -32600", async () => {
		const host = fakeHost();
		for (const id of [null, {}, { a: 1 }, [], [1], 1.5, true]) {
			const out = await handleMcpPayload(host, request("ping", undefined, id));
			expect(out).toEqual({ body: INVALID_REQUEST_REPLY, status: 400 });
		}
		expect(host.calls).toHaveLength(0);
	});

	test("an invalid id is not dispatched even for a tool call", async () => {
		const host = fakeHost();
		const out = await handleMcpPayload(host, toolCall("ultrathink_plan", { prompt: "Plan" }, null));
		expect(out).toEqual({ body: INVALID_REQUEST_REPLY, status: 400 });
		expect(host.calls).toHaveLength(0);
	});

	test("a string or integer id, including zero, negative and the empty string, is answered with no status", async () => {
		for (const id of ["a", "", 0, 7, -3, 12_345_678_901]) {
			const out = await handleMcpPayload(fakeHost(), request("ping", undefined, id));
			expect(out).toEqual({ body: { jsonrpc: "2.0", id, result: {} } });
		}
	});
});

describe("ping", () => {
	test("returns an empty result with the request id", async () => {
		expect(await bodyOf(fakeHost(), request("ping", undefined, "p-1"))).toEqual({
			jsonrpc: "2.0",
			id: "p-1",
			result: {},
		});
	});
});

describe("tools/list", () => {
	test("a host without capabilities lists the nine client-mode tools, without ultrathink_uplift", async () => {
		expect((await listTools()).map((tool) => tool.name)).toEqual(CLIENT_TOOLS);
	});

	test("a host with serverPlanning false lists the same nine tools", async () => {
		expect((await listTools(fakeHost(PLANNED, false))).map((tool) => tool.name)).toEqual(CLIENT_TOOLS);
	});

	test("a host with serverPlanning true lists ten tools, ultrathink_uplift first", async () => {
		expect((await listTools(serverHost())).map((tool) => tool.name)).toEqual(SERVER_TOOLS);
	});

	test("the list follows the host's capabilities on every call", async () => {
		let serverPlanning = false;
		const host = fakeHost();
		host.capabilities = () => ({ serverPlanning });
		expect((await listTools(host)).length).toBe(9);
		serverPlanning = true;
		expect((await listTools(host)).length).toBe(10);
	});

	test("returns the exported definitions", async () => {
		expect(await listTools(serverHost())).toEqual([...TOOL_DEFINITIONS]);
		expect(await listTools()).toEqual([...toolDefinitions(false)]);
		expect(toolDefinitions(true)).toEqual(TOOL_DEFINITIONS);
	});

	test("every tool has a title and a closed object schema and none declares an outputSchema", async () => {
		for (const tool of await listTools(serverHost())) {
			expect(tool.title.length).toBeGreaterThan(0);
			expect(schemaOf(tool).type).toBe("object");
			expect(schemaOf(tool).additionalProperties).toBe(false);
			expect("outputSchema" in tool).toBe(false);
			// A start call without sessionId makes a new session, so only the two start tools are not idempotent.
			expect(tool.annotations.idempotentHint).toBe(tool.name !== "ultrathink_uplift" && tool.name !== "ultrathink_plan");
		}
	});

	test("ultrathink_uplift leads with the /ultrathink trigger, requires prompt and is open-world", async () => {
		const uplift = await toolDef("ultrathink_uplift", serverHost());
		expect(uplift.title).toBe("Plan a request on the server");
		expect(uplift.description).toContain("/ultrathink");
		expect(uplift.description.indexOf("/ultrathink")).toBeLessThan(80);
		expect(schemaOf(uplift).required).toEqual(["prompt"]);
		expect(Object.keys(schemaOf(uplift).properties)).toEqual(["prompt", "sessionId"]);
		expect(uplift.annotations).toEqual(START_NEW_PAID_SESSION);
		expect(uplift.description).toContain("followed by a space");
		expect(uplift.description).toContain("starts with /ultrathink- (a hyphen) is a different command");
		expect(uplift.description).toContain("ultrathink_command");
	});

	test("ultrathink_result requires sessionId, bounds waitSeconds to 0..45 and offers brief or full detail", async () => {
		for (const host of [fakeHost(), serverHost()]) {
			const result = await toolDef("ultrathink_result", host);
			expect(result.title).toBe("Get the uplifted plan");
			expect(schemaOf(result).required).toEqual(["sessionId"]);
			expect(Object.keys(schemaOf(result).properties)).toEqual(["sessionId", "waitSeconds", "detail"]);
			const { waitSeconds, detail } = schemaOf(result).properties;
			expect(waitSeconds).toMatchObject({ type: "integer", minimum: 0, maximum: 45, default: 40 });
			expect(detail).toMatchObject({ type: "string", enum: ["brief", "full"], default: "brief" });
			expect(result.annotations).toEqual(READ_ONLY);
		}
	});

	test("the seven original tools keep their names, in order, after ultrathink_uplift", async () => {
		expect((await listTools(serverHost())).slice(0, 7).map((tool) => tool.name)).toEqual([
			"ultrathink_uplift",
			...ORIGINAL_CLIENT_TOOLS,
		]);
		expect((await listTools(serverHost())).slice(7).map((tool) => tool.name)).toEqual(CONNECTOR_TOOLS);
	});

	test("ultrathink_uplift and ultrathink_graph carry the UI resource in both the nested and the legacy flat key", async () => {
		for (const name of ["ultrathink_uplift", "ultrathink_graph"]) {
			const tool = await toolDef(name, serverHost());
			expect(tool._meta?.ui).toEqual({ resourceUri: UI_URI });
			expect(tool._meta?.["ui/resourceUri"]).toBe(UI_URI);
		}
		// Nothing is gated on what the client announced: the same list serves every client.
		expect((await toolDef("ultrathink_graph", fakeHost()))._meta?.ui).toEqual({ resourceUri: UI_URI });
	});

	test("ultrathink_result, ultrathink_graph and ultrathink_command allow results up to 200000 characters; no other tool has either meta", async () => {
		for (const tool of await listTools(serverHost())) {
			const hasLimit = ["ultrathink_result", "ultrathink_graph", "ultrathink_command"].includes(tool.name);
			expect(tool._meta?.["anthropic/maxResultSizeChars"]).toBe(hasLimit ? 200000 : undefined);
			const hasUi = tool.name === "ultrathink_uplift" || tool.name === "ultrathink_graph";
			expect(tool._meta?.ui !== undefined).toBe(hasUi);
		}
	});

	test("ultrathink_graph takes an optional sessionId, node and detail and is read-only", async () => {
		const graph = await toolDef("ultrathink_graph");
		expect(graph.description).toContain("/ultrathink-think");
		expect(graph.description).toContain("wave tree first");
		expect(schemaOf(graph).required).toBeUndefined();
		expect(Object.keys(schemaOf(graph).properties)).toEqual(["sessionId", "node", "detail"]);
		expect(schemaOf(graph).properties.detail).toMatchObject({ enum: ["brief", "full"] });
		expect(graph.annotations).toEqual(READ_ONLY);
	});

	test("ultrathink_sessions takes an optional limit of 1 to 20 and is read-only", async () => {
		const sessions = await toolDef("ultrathink_sessions");
		expect(sessions.description).toContain("/ultrathink-status");
		expect(sessions.description).toContain("wave tree first");
		expect(schemaOf(sessions).required).toBeUndefined();
		expect(schemaOf(sessions).properties.limit).toMatchObject({ type: "integer", minimum: 1, maximum: 20 });
		expect(sessions.annotations).toEqual(READ_ONLY);
	});

	test("ultrathink_command requires command, takes args and is read-only", async () => {
		const command = await toolDef("ultrathink_command");
		expect(command.description).toContain("/ultrathink-");
		expect(schemaOf(command).required).toEqual(["command"]);
		expect(Object.keys(schemaOf(command).properties)).toEqual(["command", "args"]);
		expect(command.annotations).toEqual(READ_ONLY);
	});

	test("ultrathink_plan requires prompt, takes an optional sessionId and is not read-only", async () => {
		const plan = await toolDef("ultrathink_plan");
		expect(plan.description).toContain("/ultrathink");
		expect(schemaOf(plan).required).toEqual(["prompt"]);
		expect(Object.keys(schemaOf(plan).properties)).toEqual(["prompt", "sessionId"]);
		expect(plan.annotations).toEqual(START_NEW_SESSION);
		expect(plan.description).toContain("followed by a space");
		expect(plan.description).toContain("starts with /ultrathink- (a hyphen) is a different command");
		expect(plan.description).toContain("ultrathink_command");
	});

	test("ultrathink_pending requires sessionId and is read-only", async () => {
		const pending = await toolDef("ultrathink_pending");
		expect(schemaOf(pending).required).toEqual(["sessionId"]);
		expect(Object.keys(schemaOf(pending).properties)).toEqual(["sessionId"]);
		expect(pending.annotations).toEqual(READ_ONLY);
	});

	test("ultrathink_show requires sessionId and key, makes part optional and read-only", async () => {
		const show = await toolDef("ultrathink_show");
		expect(schemaOf(show).required).toEqual(["sessionId", "key"]);
		expect(Object.keys(schemaOf(show).properties)).toEqual(["sessionId", "key", "part"]);
		expect(show.annotations).toEqual(READ_ONLY);
	});

	test("ultrathink_answer requires sessionId, key and answer and is not read-only", async () => {
		const answer = await toolDef("ultrathink_answer");
		expect(schemaOf(answer).required).toEqual(["sessionId", "key", "answer"]);
		expect(answer.annotations).toEqual(READ_WRITE);
	});

	test("ultrathink_status requires sessionId and is read-only", async () => {
		const status = await toolDef("ultrathink_status");
		expect(schemaOf(status).required).toEqual(["sessionId"]);
		expect(status.annotations).toEqual(READ_ONLY);
	});
});

describe("ultrathink_uplift", () => {
	test("is an unknown tool when the host has no capabilities or serverPlanning is false", async () => {
		for (const host of [fakeHost(), fakeHost(PLANNED, false)]) {
			expect(await replyOf(host, toolCall("ultrathink_uplift", { prompt: "Plan" }, 3))).toEqual({
				jsonrpc: "2.0",
				id: 3,
				error: UNKNOWN_TOOL,
			});
			expect(host.calls).toHaveLength(0);
		}
	});

	test("forwards its arguments to the host unchanged when serverPlanning is true", async () => {
		const host = serverHost();
		const args = { prompt: "Plan a launch", sessionId: SESSION_ID };
		const result = await invoke(host, "ultrathink_uplift", args);
		expect(result.isError).toBe(false);
		expect(host.calls).toEqual([{ name: "ultrathink_uplift", args }]);
		expect(host.calls[0]?.args).toBe(args);
	});

	test("a host that throws from capabilities fails the call with -32603 and no detail", async () => {
		const host = fakeHost();
		host.capabilities = () => {
			throw new Error("secret detail");
		};
		const body = await bodyOf(host, request("tools/list", undefined, "c-1"));
		expect(body).toEqual({ jsonrpc: "2.0", id: "c-1", error: INTERNAL_ERROR });
	});
});

describe("ultrathink_plan", () => {
	test("forwards the arguments to host.call unchanged", async () => {
		const host = fakeHost();
		const args = { prompt: "Plan a launch", sessionId: SESSION_ID };
		await invoke(host, "ultrathink_plan", args);
		expect(host.calls).toEqual([{ name: "ultrathink_plan", args }]);
		expect(host.calls[0]?.args).toBe(args);
	});

	test("does not add a sessionId when the caller omits it", async () => {
		const host = fakeHost();
		await invoke(host, "ultrathink_plan", { prompt: "Plan a launch" });
		expect(Object.keys(host.calls[0]?.args ?? {})).toEqual(["prompt"]);
	});
});

describe("ultrathink_show", () => {
	test("forwards an out-of-enum part to the host unchanged", async () => {
		const host = fakeHost();
		const args = { sessionId: SESSION_ID, key: "k1", part: "nonsense" };
		await invoke(host, "ultrathink_show", args);
		expect(host.calls).toEqual([
			{ name: "ultrathink_show", args: { sessionId: SESSION_ID, key: "k1", part: "nonsense" } },
		]);
	});

	test("the tools/list schema declares part as an enum of system and user only", async () => {
		const part = schemaOf(await toolDef("ultrathink_show")).properties.part;
		expect(part).toEqual({ type: "string", enum: ["system", "user"] });
	});
});

describe("argument forwarding", () => {
	test("every tool passes its arguments to the host unchanged", async () => {
		const cases: [string, Record<string, unknown>][] = [
			["ultrathink_pending", { sessionId: SESSION_ID }],
			["ultrathink_show", { sessionId: SESSION_ID, key: "k1", part: "user" }],
			["ultrathink_answer", { sessionId: SESSION_ID, key: "k1", answer: "option-a" }],
			["ultrathink_status", { sessionId: SESSION_ID }],
			["ultrathink_result", { sessionId: SESSION_ID, waitSeconds: 10, detail: "full" }],
			["ultrathink_graph", { sessionId: SESSION_ID, node: "n2", detail: "full" }],
			["ultrathink_sessions", { limit: 3 }],
			["ultrathink_command", { command: "ultrathink-ship", args: "the branch" }],
		];
		for (const [name, args] of cases) {
			const host = fakeHost();
			await invoke(host, name, args);
			expect(host.calls).toEqual([{ name, args }]);
		}
	});
});

describe("tool results", () => {
	test("a host success without text returns isError false with the data as structuredContent and JSON text", async () => {
		const data = { sessionId: SESSION_ID, status: "needs-model", pending: [{ key: "k1", stage: "clarify" }] };
		const result = await invoke(fakeHost({ ok: true, data }), "ultrathink_plan", { prompt: "Plan" });
		expect(result.isError).toBe(false);
		expect(result.structuredContent).toEqual(data);
		expect(result.content).toEqual([{ type: "text", text: JSON.stringify(data) }]);
	});

	test("a host that repeats the text in the data gives the same text in content and structuredContent", async () => {
		const text = "Graph of Thought: wave 1";
		const result = await invoke(fakeHost({ ok: true, data: { status: "planned", text }, text }), "ultrathink_graph", {});
		expect(result.content).toEqual([{ type: "text", text }]);
		expect(result.structuredContent.text).toBe(text);
	});

	test("a host success with text returns that text as the content and the data as structuredContent", async () => {
		const data = { sessionId: SESSION_ID, status: "planned", mode: "server" };
		const text = "Request: plan the launch\n\nGraph of Thought: wave 1";
		const result = await invoke(fakeHost({ ok: true, data, text }), "ultrathink_result", {
			sessionId: SESSION_ID,
		});
		expect(result.isError).toBe(false);
		expect(result.content).toEqual([{ type: "text", text }]);
		expect(result.structuredContent).toEqual(data);
		expect(JSON.stringify(result.content)).not.toContain("mode");
	});

	test("a non-string text is a malformed outcome", async () => {
		const host = fakeHost(() => ({ ok: true, data: {}, text: 5 }) as unknown as ToolOutcome);
		const body = await bodyOf(host, toolCall("ultrathink_result", { sessionId: SESSION_ID }, "x-1"));
		expect(body).toEqual({ jsonrpc: "2.0", id: "x-1", error: INTERNAL_ERROR });
	});

	test("a refusal ignores any text", async () => {
		const host = fakeHost(() => ({ ok: false, code: "not_found", text: "plan" }) as unknown as ToolOutcome);
		const result = await invoke(host, "ultrathink_result", { sessionId: SESSION_ID });
		expect(result.isError).toBe(true);
		expect(result.content).toEqual([{ type: "text", text: "request refused: not_found" }]);
	});

	test("an async host outcome is awaited", async () => {
		const host = fakeHost(async (call) => {
			const outcome: ToolOutcome = { ok: true, data: { echoed: call.name } };
			return outcome;
		});
		const result = await invoke(host, "ultrathink_pending", { sessionId: SESSION_ID });
		expect(result.isError).toBe(false);
		expect(result.structuredContent).toEqual({ echoed: "ultrathink_pending" });
	});

	test("a host refusal returns isError true with the code as structuredContent.error", async () => {
		const result = await invoke(fakeHost({ ok: false, code: "session_conflict" }), "ultrathink_plan", {
			prompt: "Plan",
			sessionId: SESSION_ID,
		});
		expect(result.isError).toBe(true);
		expect(result.structuredContent).toEqual({ error: "session_conflict" });
		expect(result.content).toEqual([{ type: "text", text: "request refused: session_conflict" }]);
	});

	test("a refusal with errors includes them in structuredContent", async () => {
		const errors = ["answer is not valid JSON", "missing field: angle"];
		const host = fakeHost({ ok: false, code: "invalid_answer", errors });
		const result = await invoke(host, "ultrathink_answer", { sessionId: SESSION_ID, key: "k1", answer: "x" });
		expect(result.isError).toBe(true);
		expect(result.structuredContent).toEqual({ error: "invalid_answer", errors });
	});

	test("a refusal with errors lists them in the content text after the code", async () => {
		const errors = ["answer is not valid JSON", "missing field: angle"];
		const host = fakeHost({ ok: false, code: "invalid_answer", errors });
		const result = await invoke(host, "ultrathink_answer", { sessionId: SESSION_ID, key: "k1", answer: "x" });
		expect(result.content).toEqual([
			{ type: "text", text: "request refused: invalid_answer (answer is not valid JSON; missing field: angle)" },
		]);
	});

	test("a refusal with an empty errors array keeps the bare code in the content text", async () => {
		const host = fakeHost({ ok: false, code: "invalid_answer", errors: [] });
		const result = await invoke(host, "ultrathink_answer", { sessionId: SESSION_ID, key: "k1", answer: "x" });
		expect(result.content).toEqual([{ type: "text", text: "request refused: invalid_answer" }]);
	});

	test("a refusal without errors has no errors key", async () => {
		const host = fakeHost({ ok: false, code: "not_found" });
		const result = await invoke(host, "ultrathink_status", { sessionId: SESSION_ID });
		expect(result.structuredContent).toEqual({ error: "not_found" });
		expect("errors" in result.structuredContent).toBe(false);
	});

	test("present non-object arguments return invalid_arguments without calling the host", async () => {
		const badArgs: unknown[] = [null, "prompt", ["prompt"], 7, true];
		for (const name of SERVER_TOOLS) {
			for (const args of badArgs) {
				const host = serverHost();
				const result = await invoke(host, name, args);
				expect(result.isError).toBe(true);
				expect(result.structuredContent).toEqual({ error: "invalid_arguments" });
				expect(result.content).toEqual([{ type: "text", text: "invalid arguments" }]);
				expect(host.calls).toHaveLength(0);
			}
		}
	});

	test("omitted arguments run the tool with an empty object", async () => {
		for (const name of ["ultrathink_sessions", "ultrathink_graph"]) {
			const host = serverHost();
			const result = await invoke(host, name);
			expect(result.isError).toBe(false);
			expect(host.calls).toEqual([{ name, args: {} }]);
		}
	});
});

describe("tools/call errors", () => {
	test("an unknown tool name returns -32602 and does not call the host", async () => {
		const host = fakeHost();
		expect(await replyOf(host, toolCall("ultrathink_delete", {}, 3))).toEqual({
			jsonrpc: "2.0",
			id: 3,
			error: UNKNOWN_TOOL,
		});
		expect(host.calls).toHaveLength(0);
	});

	test("a non-string or inherited name returns -32602", async () => {
		for (const name of [5, null, "toString", "constructor"]) {
			const reply = await replyOf(fakeHost(), toolCall(name));
			expect(reply.error).toEqual(UNKNOWN_TOOL);
		}
	});

	test("missing or non-object params return -32602", async () => {
		expect((await replyOf(fakeHost(), request("tools/call"))).error).toEqual(UNKNOWN_TOOL);
		expect((await replyOf(fakeHost(), request("tools/call", "ultrathink_plan"))).error).toEqual(UNKNOWN_TOOL);
	});
});

describe("unknown methods", () => {
	test("return -32601 with the request id", async () => {
		expect(await bodyOf(fakeHost(), request("sampling/createMessage", {}, 7))).toEqual({
			jsonrpc: "2.0",
			id: 7,
			error: { code: -32601, message: "method not found" },
		});
	});
});

describe("resources", () => {
	const HTML = "<!doctype html><title>graph</title>";
	const UI_META = { csp: {}, prefersBorder: false };

	function hostWithUi(): FakeHost {
		const host = fakeHost();
		host.resources = createResourceRegistry([
			{
				uri: UI_URI,
				name: "ultrathink-graph",
				title: "UltraThink graph",
				description: "The plan graph.",
				mimeType: UI_RESOURCE_MIME_TYPE,
				html: () => HTML,
				meta: UI_META,
			},
		]);
		return host;
	}

	test("resources/list returns the UI document with its mime type and _meta.ui", async () => {
		const { resources } = resultOf<{ resources: Record<string, unknown>[] }>(
			await replyOf(hostWithUi(), request("resources/list")),
		);
		expect(resources).toEqual([
			{
				uri: UI_URI,
				name: "ultrathink-graph",
				title: "UltraThink graph",
				description: "The plan graph.",
				mimeType: "text/html;profile=mcp-app",
				_meta: { ui: UI_META },
			},
		]);
	});

	test("resources/read returns the document with the MCP Apps mime type and _meta.ui", async () => {
		const reply = await replyOf(hostWithUi(), request("resources/read", { uri: UI_URI }));
		expect(resultOf<unknown>(reply)).toEqual({
			contents: [{ uri: UI_URI, mimeType: "text/html;profile=mcp-app", text: HTML, _meta: { ui: UI_META } }],
		});
	});

	test("resources/templates/list is empty", async () => {
		expect(resultOf<unknown>(await replyOf(hostWithUi(), request("resources/templates/list")))).toEqual({
			resourceTemplates: [],
		});
	});

	test("an unknown ui uri is -32002 with the request id", async () => {
		const body = await bodyOf(hostWithUi(), request("resources/read", { uri: "ui://ultrathink/other" }, "r-1"));
		expect(body).toEqual({ jsonrpc: "2.0", id: "r-1", error: { code: -32002, message: "resource not found" } });
	});

	test("a missing, non-string or non-ui uri is -32602", async () => {
		const refused: unknown[] = [undefined, {}, { uri: 5 }, { uri: null }, { uri: "https://example.com/x" }, { uri: "ui://" }, "ui://ultrathink/graph"];
		for (const params of refused) {
			const reply = await replyOf(hostWithUi(), request("resources/read", params));
			expect(reply.error?.code).toBe(-32602);
			expect(reply.result).toBeUndefined();
		}
	});

	test("a host without a registry lists nothing and finds nothing", async () => {
		const host = fakeHost();
		expect(resultOf<unknown>(await replyOf(host, request("resources/list")))).toEqual({ resources: [] });
		expect(resultOf<unknown>(await replyOf(host, request("resources/templates/list")))).toEqual({ resourceTemplates: [] });
		expect((await replyOf(host, request("resources/read", { uri: UI_URI }))).error?.code).toBe(-32002);
		expect((await replyOf(host, request("resources/read", { uri: 5 }))).error?.code).toBe(-32602);
		expect(host.calls).toHaveLength(0);
	});
});

describe("envelope", () => {
	test("a malformed envelope returns -32600 with id null", async () => {
		const malformed: unknown[] = [
			null,
			"ping",
			5,
			{ method: "ping", id: 1 },
			{ jsonrpc: "1.0", id: 1, method: "ping" },
			{ jsonrpc: "2.0", id: 1 },
			{ jsonrpc: "2.0", id: 1, method: 5 },
		];
		for (const payload of malformed) {
			expect(await bodyOf(fakeHost(), payload)).toEqual(INVALID_REQUEST_REPLY);
		}
	});

	test("a malformed envelope is reported even when it has no id", async () => {
		expect(await bodyOf(fakeHost(), { jsonrpc: "1.0", method: "ping" })).toEqual(INVALID_REQUEST_REPLY);
	});

	test("a malformed envelope keeps the default status", async () => {
		expect(await handleMcpPayload(fakeHost(), { jsonrpc: "2.0", id: 1 })).toEqual({ body: INVALID_REQUEST_REPLY });
	});

	test("an empty batch returns -32600 with id null", async () => {
		expect(await bodyOf(fakeHost(), [])).toEqual(INVALID_REQUEST_REPLY);
	});
});

describe("batch", () => {
	test("is handled when the version is absent or 2025-03-26", async () => {
		for (const ctx of [undefined, {}, { protocolVersion: "2025-03-26" }]) {
			const replies = (await bodyOf(fakeHost(), [request("ping", undefined, "a"), request("ping", undefined, "b")], ctx)) as RpcReply[];
			expect(replies.map((reply) => reply.id)).toEqual(["a", "b"]);
		}
	});

	test("is refused with status 400 and -32600 for 2025-06-18 and newer, without calling the host", async () => {
		for (const protocolVersion of NEW_VERSIONS) {
			const host = fakeHost();
			const batch = [toolCall("ultrathink_plan", { prompt: "Plan" }, 1), request("ping", undefined, 2)];
			expect(await handleMcpPayload(host, batch, { protocolVersion })).toEqual({
				body: INVALID_REQUEST_REPLY,
				status: 400,
			});
			expect(await handleMcpPayload(host, [], { protocolVersion })).toEqual({
				body: INVALID_REQUEST_REPLY,
				status: 400,
			});
			expect(host.calls).toHaveLength(0);
		}
	});

	test("a single request is handled for every version", async () => {
		for (const protocolVersion of SUPPORTED_PROTOCOL_VERSIONS) {
			const out = await handleMcpPayload(fakeHost(), request("ping", undefined, 1), { protocolVersion });
			expect(out).toEqual({ body: { jsonrpc: "2.0", id: 1, result: {} } });
		}
	});

	test("returns the replies in request order and skips notifications", async () => {
		const replies = (await bodyOf(fakeHost(), [
			request("ping", undefined, "a"),
			{ jsonrpc: "2.0", method: "notifications/initialized" },
			request("tools/list", undefined, "b"),
		])) as RpcReply[];
		expect(replies.map((reply) => reply.id)).toEqual(["a", "b"]);
		expect(replies[0]).toEqual({ jsonrpc: "2.0", id: "a", result: {} });
		const listed = resultOf<{ tools: ToolDef[] }>(replies[1] as RpcReply).tools;
		expect(listed.map((tool) => tool.name)).toEqual(CLIENT_TOOLS);
	});

	test("skips client responses", async () => {
		const replies = (await bodyOf(fakeHost(), [
			{ jsonrpc: "2.0", id: 1, result: {} },
			request("ping", undefined, "a"),
		])) as RpcReply[];
		expect(replies.map((reply) => reply.id)).toEqual(["a"]);
	});

	test("runs the host calls in batch order", async () => {
		const host = fakeHost();
		await bodyOf(host, [
			toolCall("ultrathink_plan", { prompt: "Plan" }, 1),
			toolCall("ultrathink_answer", { sessionId: SESSION_ID, key: "k1", answer: "a" }, 2),
			toolCall("ultrathink_status", { sessionId: SESSION_ID }, 3),
		]);
		expect(host.calls.map((call) => call.name)).toEqual([
			"ultrathink_plan",
			"ultrathink_answer",
			"ultrathink_status",
		]);
	});

	test("a batch of only notifications returns null", async () => {
		expect(
			await handleMcpPayload(fakeHost(), [
				{ jsonrpc: "2.0", method: "notifications/initialized" },
				{ jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: 3 } },
			]),
		).toBeNull();
	});

	test("a malformed element gets its own -32600 reply with id null", async () => {
		expect(await bodyOf(fakeHost(), [42, request("ping", undefined, "c")])).toEqual([
			INVALID_REQUEST_REPLY,
			{ jsonrpc: "2.0", id: "c", result: {} },
		]);
	});

	test("an element with an invalid id gets its own -32600 reply and the batch keeps its status", async () => {
		const out = await handleMcpPayload(fakeHost(), [request("ping", undefined, null), request("ping", undefined, "d")]);
		expect(out).toEqual({ body: [INVALID_REQUEST_REPLY, { jsonrpc: "2.0", id: "d", result: {} }] });
	});

	test("a batch of malformed elements and notifications returns only the malformed replies", async () => {
		expect(
			await bodyOf(fakeHost(), [null, { jsonrpc: "2.0", method: "ping" }, { jsonrpc: "2.0", id: 9 }]),
		).toEqual([INVALID_REQUEST_REPLY, INVALID_REQUEST_REPLY]);
	});
});

describe("host failures", () => {
	const DETAIL = "postgres://ultrathink:example@10.0.0.5/runs at /srv/ultrathink/stack.ts:12";

	test("a host that throws fails every tool with -32603 and no detail", async () => {
		const host = serverHost(() => {
			throw new Error(DETAIL);
		});
		for (const name of SERVER_TOOLS) {
			const body = await bodyOf(host, toolCall(name, { sessionId: SESSION_ID }, "t-1"));
			expect(body).toEqual({ jsonrpc: "2.0", id: "t-1", error: INTERNAL_ERROR });
			expect(JSON.stringify(body)).not.toContain(DETAIL);
			expect(JSON.stringify(body)).not.toContain("stack");
		}
	});

	test("a host that rejects returns -32603 with no detail", async () => {
		const host = fakeHost(async () => {
			throw new Error(DETAIL);
		});
		const body = await bodyOf(host, toolCall("ultrathink_status", { sessionId: SESSION_ID }, "t-2"));
		expect(body).toEqual({ jsonrpc: "2.0", id: "t-2", error: INTERNAL_ERROR });
		expect(JSON.stringify(body)).not.toContain(DETAIL);
	});

	test("a malformed host outcome returns -32603", async () => {
		const malformed: unknown[] = [
			undefined,
			null,
			"planned",
			{},
			{ ok: "yes", data: {} },
			{ ok: true },
			{ ok: true, data: [] },
			{ ok: true, data: "planned" },
			{ ok: false },
			{ ok: false, code: 500 },
			{ ok: false, code: "bad", errors: "not an array" },
			{ ok: false, code: "bad", errors: [1] },
		];
		for (const outcome of malformed) {
			const host = fakeHost(() => outcome as ToolOutcome);
			const body = await bodyOf(host, toolCall("ultrathink_show", { sessionId: SESSION_ID, key: "k1" }, "m-1"));
			expect(body).toEqual({ jsonrpc: "2.0", id: "m-1", error: INTERNAL_ERROR });
		}
	});

	test("a host failure fails only its own reply in a batch", async () => {
		const host = fakeHost((call) => {
			if (call.name === "ultrathink_status") throw new Error(DETAIL);
			return PLANNED;
		});
		const replies = (await bodyOf(host, [
			toolCall("ultrathink_pending", { sessionId: SESSION_ID }, "a"),
			toolCall("ultrathink_status", { sessionId: SESSION_ID }, "b"),
		])) as RpcReply[];
		expect(resultOf<ToolResult>(replies[0] as RpcReply).isError).toBe(false);
		expect(replies[1]).toEqual({ jsonrpc: "2.0", id: "b", error: INTERNAL_ERROR });
	});
});
