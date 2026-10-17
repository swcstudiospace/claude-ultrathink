// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { describe, expect, test } from "bun:test";
import {
	handleMcpPayload,
	MCP_PROTOCOL_VERSIONS,
	type McpToolHost,
	TOOL_DEFINITIONS,
	type ToolOutcome,
} from "./mcp.ts";

const SESSION_ID = "session-1";
const PLANNED: ToolOutcome = { ok: true, data: { sessionId: SESSION_ID, status: "planned", pending: [] } };
const EXPECTED_TOOLS = [
	"ultrathink_plan",
	"ultrathink_pending",
	"ultrathink_show",
	"ultrathink_answer",
	"ultrathink_status",
];
const INSTRUCTIONS =
	"Run ultrathink planning here. Call ultrathink_plan, answer each pending prompt with ultrathink_show and ultrathink_answer, then call ultrathink_plan again with the same sessionId and prompt until status is planned.";
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const READ_WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false };
const INVALID_REQUEST_REPLY = { jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid request" } };
const INTERNAL_ERROR = { code: -32603, message: "internal error" };

interface Call {
	name: string;
	args: Record<string, unknown>;
}

/** A fixed outcome, or a function that decides the outcome from the call. */
type Script = ToolOutcome | ((call: Call) => ToolOutcome | Promise<ToolOutcome>);

interface FakeHost extends McpToolHost {
	calls: Call[];
}

/** Records every call and answers with the scripted outcome. */
function fakeHost(script: Script = PLANNED): FakeHost {
	const host: FakeHost = {
		calls: [],
		call(name, args) {
			const call: Call = { name, args };
			host.calls.push(call);
			return typeof script === "function" ? script(call) : script;
		},
	};
	return host;
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
	description: string;
	inputSchema: {
		type: string;
		properties: Record<string, { type: string; enum?: string[] }>;
		required?: string[];
		additionalProperties?: boolean;
	};
	annotations: Record<string, boolean>;
}

function request(method: string, params?: unknown, id: unknown = 1): Record<string, unknown> {
	return params === undefined ? { jsonrpc: "2.0", id, method } : { jsonrpc: "2.0", id, method, params };
}

function toolCall(name: unknown, args?: unknown, id: unknown = 1): Record<string, unknown> {
	return request("tools/call", args === undefined ? { name } : { name, arguments: args }, id);
}

async function bodyOf(host: McpToolHost, payload: unknown): Promise<unknown> {
	const out = await handleMcpPayload(host, payload);
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

async function listTools(): Promise<ToolDef[]> {
	return resultOf<{ tools: ToolDef[] }>(await replyOf(fakeHost(), request("tools/list"))).tools;
}

async function toolDef(name: string): Promise<ToolDef> {
	const tool = (await listTools()).find((candidate) => candidate.name === name);
	if (!tool) throw new Error(`missing tool ${name}`);
	return tool;
}

describe("initialize", () => {
	test("exposes the supported protocol versions, newest first", () => {
		expect([...MCP_PROTOCOL_VERSIONS]).toEqual(["2025-06-18", "2025-03-26"]);
	});

	test("negotiates 2025-06-18 when requested", async () => {
		const reply = await replyOf(fakeHost(), request("initialize", { protocolVersion: "2025-06-18" }, 1));
		expect(reply.id).toBe(1);
		expect(resultOf<{ protocolVersion: string }>(reply).protocolVersion).toBe("2025-06-18");
	});

	test("negotiates 2025-03-26 when requested", async () => {
		const reply = await replyOf(fakeHost(), request("initialize", { protocolVersion: "2025-03-26" }));
		expect(resultOf<{ protocolVersion: string }>(reply).protocolVersion).toBe("2025-03-26");
	});

	test("falls back to 2025-06-18 for an unknown, non-string or missing version", async () => {
		const payloads: unknown[] = [
			request("initialize", { protocolVersion: "1999-01-01" }),
			request("initialize", { protocolVersion: 20250618 }),
			request("initialize"),
			request("initialize", {}),
		];
		for (const payload of payloads) {
			const reply = await replyOf(fakeHost(), payload);
			expect(resultOf<{ protocolVersion: string }>(reply).protocolVersion).toBe("2025-06-18");
		}
	});

	test("returns the tools capability, server info 0.2.0 and instructions", async () => {
		const reply = await replyOf(fakeHost(), request("initialize", { protocolVersion: "2025-06-18" }));
		expect(resultOf<Record<string, unknown>>(reply)).toEqual({
			protocolVersion: "2025-06-18",
			capabilities: { tools: {} },
			serverInfo: { name: "ultrathink", version: "0.2.0" },
			instructions: INSTRUCTIONS,
		});
	});
});

describe("notifications", () => {
	test("a message without an id returns null", async () => {
		expect(await handleMcpPayload(fakeHost(), { jsonrpc: "2.0", method: "ping" })).toBeNull();
	});

	test("a notifications/* method returns null even when it carries an id", async () => {
		const payload = { jsonrpc: "2.0", id: 5, method: "notifications/cancelled", params: { requestId: 3 } };
		expect(await handleMcpPayload(fakeHost(), payload)).toBeNull();
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
	test("returns exactly the five ultrathink tools in order", async () => {
		expect((await listTools()).map((tool) => tool.name)).toEqual(EXPECTED_TOOLS);
	});

	test("returns the exported TOOL_DEFINITIONS", async () => {
		expect(await listTools()).toEqual([...TOOL_DEFINITIONS]);
	});

	test("every schema is a closed object schema", async () => {
		for (const tool of await listTools()) {
			expect(tool.inputSchema.type).toBe("object");
			expect(tool.inputSchema.additionalProperties).toBe(false);
		}
	});

	test("ultrathink_plan requires prompt, takes an optional sessionId and is not read-only", async () => {
		const plan = await toolDef("ultrathink_plan");
		expect(plan.description).toBe(
			"Start or continue an ultrathink planning session for a request. Returns the sessionId, the status, and the pending prompts. Answer each pending prompt, then call this again with the same sessionId and prompt until status is planned.",
		);
		expect(plan.inputSchema.required).toEqual(["prompt"]);
		expect(Object.keys(plan.inputSchema.properties)).toEqual(["prompt", "sessionId"]);
		expect(plan.annotations).toEqual(READ_WRITE);
	});

	test("ultrathink_pending requires sessionId and is read-only", async () => {
		const pending = await toolDef("ultrathink_pending");
		expect(pending.inputSchema.required).toEqual(["sessionId"]);
		expect(Object.keys(pending.inputSchema.properties)).toEqual(["sessionId"]);
		expect(pending.annotations).toEqual(READ_ONLY);
	});

	test("ultrathink_show requires sessionId and key, makes part optional and read-only", async () => {
		const show = await toolDef("ultrathink_show");
		expect(show.inputSchema.required).toEqual(["sessionId", "key"]);
		expect(Object.keys(show.inputSchema.properties)).toEqual(["sessionId", "key", "part"]);
		expect(show.annotations).toEqual(READ_ONLY);
	});

	test("ultrathink_answer requires sessionId, key and answer and is not read-only", async () => {
		const answer = await toolDef("ultrathink_answer");
		expect(answer.inputSchema.required).toEqual(["sessionId", "key", "answer"]);
		expect(answer.annotations).toEqual(READ_WRITE);
	});

	test("ultrathink_status requires sessionId and is read-only", async () => {
		const status = await toolDef("ultrathink_status");
		expect(status.inputSchema.required).toEqual(["sessionId"]);
		expect(status.annotations).toEqual(READ_ONLY);
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
		const part = (await toolDef("ultrathink_show")).inputSchema.properties.part;
		expect(part).toEqual({ type: "string", enum: ["system", "user"] });
		expect(part?.enum).not.toContain("nonsense");
	});
});

describe("argument forwarding", () => {
	test("every tool passes its arguments to the host unchanged", async () => {
		const cases: [string, Record<string, unknown>][] = [
			["ultrathink_pending", { sessionId: SESSION_ID }],
			["ultrathink_show", { sessionId: SESSION_ID, key: "k1", part: "user" }],
			["ultrathink_answer", { sessionId: SESSION_ID, key: "k1", answer: "option-a" }],
			["ultrathink_status", { sessionId: SESSION_ID }],
		];
		for (const [name, args] of cases) {
			const host = fakeHost();
			await invoke(host, name, args);
			expect(host.calls).toEqual([{ name, args }]);
		}
	});
});

describe("tool results", () => {
	test("a host success returns isError false with the data as structuredContent and JSON text", async () => {
		const data = { sessionId: SESSION_ID, status: "needs-model", pending: [{ key: "k1", stage: "clarify" }] };
		const result = await invoke(fakeHost({ ok: true, data }), "ultrathink_plan", { prompt: "Plan" });
		expect(result.isError).toBe(false);
		expect(result.structuredContent).toEqual(data);
		expect(result.content).toEqual([{ type: "text", text: JSON.stringify(data) }]);
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

	test("a refusal without errors has no errors key", async () => {
		const host = fakeHost({ ok: false, code: "not_found" });
		const result = await invoke(host, "ultrathink_status", { sessionId: SESSION_ID });
		expect(result.structuredContent).toEqual({ error: "not_found" });
		expect("errors" in result.structuredContent).toBe(false);
	});

	test("non-object arguments return invalid_arguments without calling the host", async () => {
		const badArgs: unknown[] = [undefined, null, "prompt", ["prompt"], 7, true];
		for (const name of EXPECTED_TOOLS) {
			for (const args of badArgs) {
				const host = fakeHost();
				const result = await invoke(host, name, args);
				expect(result.isError).toBe(true);
				expect(result.structuredContent).toEqual({ error: "invalid_arguments" });
				expect(result.content).toEqual([{ type: "text", text: "invalid arguments" }]);
				expect(host.calls).toHaveLength(0);
			}
		}
	});
});

describe("tools/call errors", () => {
	test("an unknown tool name returns -32602 and does not call the host", async () => {
		const host = fakeHost();
		expect(await replyOf(host, toolCall("ultrathink_delete", {}, 3))).toEqual({
			jsonrpc: "2.0",
			id: 3,
			error: { code: -32602, message: "unknown tool" },
		});
		expect(host.calls).toHaveLength(0);
	});

	test("a non-string or inherited name returns -32602", async () => {
		for (const name of [5, null, "toString", "constructor"]) {
			const reply = await replyOf(fakeHost(), toolCall(name));
			expect(reply.error).toEqual({ code: -32602, message: "unknown tool" });
		}
	});

	test("missing or non-object params return -32602", async () => {
		expect((await replyOf(fakeHost(), request("tools/call"))).error).toEqual({
			code: -32602,
			message: "unknown tool",
		});
		expect((await replyOf(fakeHost(), request("tools/call", "ultrathink_plan"))).error).toEqual({
			code: -32602,
			message: "unknown tool",
		});
	});
});

describe("unknown methods", () => {
	test("return -32601 with the request id", async () => {
		expect(await bodyOf(fakeHost(), request("resources/list", {}, 7))).toEqual({
			jsonrpc: "2.0",
			id: 7,
			error: { code: -32601, message: "method not found" },
		});
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

	test("an empty batch returns -32600 with id null", async () => {
		expect(await bodyOf(fakeHost(), [])).toEqual(INVALID_REQUEST_REPLY);
	});
});

describe("batch", () => {
	test("returns the replies in request order and skips notifications", async () => {
		const replies = (await bodyOf(fakeHost(), [
			request("ping", undefined, "a"),
			{ jsonrpc: "2.0", method: "notifications/initialized" },
			request("tools/list", undefined, "b"),
		])) as RpcReply[];
		expect(replies.map((reply) => reply.id)).toEqual(["a", "b"]);
		expect(replies[0]).toEqual({ jsonrpc: "2.0", id: "a", result: {} });
		const listed = resultOf<{ tools: ToolDef[] }>(replies[1] as RpcReply).tools;
		expect(listed.map((tool) => tool.name)).toEqual(EXPECTED_TOOLS);
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

	test("a batch of malformed elements and notifications returns only the malformed replies", async () => {
		expect(
			await bodyOf(fakeHost(), [null, { jsonrpc: "2.0", method: "ping" }, { jsonrpc: "2.0", id: 9 }]),
		).toEqual([INVALID_REQUEST_REPLY, INVALID_REQUEST_REPLY]);
	});
});

describe("host failures", () => {
	const DETAIL = "postgres://ultrathink:example@10.0.0.5/runs at /srv/ultrathink/stack.ts:12";

	test("a host that throws fails every tool with -32603 and no detail", async () => {
		const host = fakeHost(() => {
			throw new Error(DETAIL);
		});
		for (const name of EXPECTED_TOOLS) {
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
