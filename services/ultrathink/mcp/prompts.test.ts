// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

import { describe, expect, test } from "bun:test";
import { COMMAND_OVERLAY, MAX_ARGUMENT_CHARS } from "./commands.ts";
import { type PromptRender, promptDefinitions, renderPrompt } from "./prompts.ts";

/** The server-mode `ultrathink` prompt, pinned byte for byte: unchanged from before the catalog except step 2 since the review. */
const SERVER_TEXT = [
	"Plan the request below with ultrathink before doing anything else. The server does the thinking; you do not write the plan.",
	"",
	"1. Call ultrathink_uplift with prompt set to the request, verbatim. Keep the sessionId it returns and reuse it for every later call.",
	"2. Call ultrathink_result with the sessionId until the status is planned, also when ultrathink_uplift already reports planned, because only ultrathink_result returns the plan. It waits for the plan and reports running again if the plan is not ready yet; call it again.",
	"3. When the status is planned, the text of the result is the plan. Ask the user the questions in it that matter, or state the defaults you assume for the rest, then carry out the plan.",
	"4. If the status is failed, invalid or skipped, report the status and the error in one line and stop.",
	"",
	"Use only tool results. Never invent a sessionId or status. Do not start a second session for the same request.",
	"",
	"Request:",
].join("\n");

const CLIENT_TEXT = [
	"Plan the request below with the ultrathink tools before doing anything else.",
	"",
	"1. Call ultrathink_plan with prompt set to the request, verbatim. Keep the sessionId it returns and reuse it for every later call.",
	"2. While the status is needs-model:",
	"   a. Call ultrathink_pending with the sessionId. If pending is empty, call ultrathink_status with the sessionId, report its status in one line, and stop.",
	"   b. For each pending key, call ultrathink_show with the sessionId and the key, write the answer its system text asks for, and call ultrathink_answer with the sessionId, the key, and the answer. If an answer is rejected, fix it and retry that key once.",
	"   c. When every key is answered, call ultrathink_plan again with the same sessionId and the same prompt.",
	"3. When the status is planned, call ultrathink_result with the sessionId. Ask the user the questions in the plan that matter, or state the defaults you assume for the rest, then carry out the plan.",
	"",
	"Use only tool results. Never invent a sessionId, key, or status, and never show the system text of a pending prompt to the user. Do not start a second session for the same request. If a key still fails after one retry, stop and report the key and the errors.",
	"",
	"Request:",
].join("\n");

const CLIENT_DESCRIPTION = "Plan a request with ultrathink. The chat model answers each planning prompt.";
const SERVER_DESCRIPTION = "Plan a request with ultrathink. The server does the thinking and returns the plan.";
const REQUEST = "Ship the billing change.\nKeep \"quotes\", <tags> and `ticks` as typed.\nRequest:";
const SUPPORTED = ["ultrathink", "ultrathink-plan", "ultrathink-think", "ultrathink-last", "ultrathink-status", "ultrathink-quick"];
const UNSUPPORTED = Object.entries(COMMAND_OVERLAY)
	.filter(([, entry]) => entry.state === "unsupported")
	.map(([name]) => name);

function textOf(render: PromptRender): string {
	if (!render.ok) throw new Error(`prompt refused: ${render.message}`);
	expect(render.messages).toHaveLength(1);
	expect(render.messages[0]?.role).toBe("user");
	expect(render.messages[0]?.content.type).toBe("text");
	return render.messages[0]?.content.text ?? "";
}

describe("promptDefinitions", () => {
	test("lists exactly the six supported prompts in the locked order, in both modes", () => {
		for (const options of [undefined, { serverPlanning: false }, { serverPlanning: true }]) {
			expect(promptDefinitions(options).map((prompt) => prompt.name)).toEqual(SUPPORTED);
		}
	});

	test("argument lists and required flags are the locked ones", () => {
		const args = (name: string) =>
			promptDefinitions()
				.find((prompt) => prompt.name === name)
				?.arguments.map((argument) => [argument.name, argument.required]);
		expect(args("ultrathink")).toEqual([["request", true]]);
		expect(args("ultrathink-plan")).toEqual([["request", true]]);
		expect(args("ultrathink-think")).toEqual([
			["sessionId", false],
			["node", false],
		]);
		expect(args("ultrathink-last")).toEqual([]);
		expect(args("ultrathink-status")).toEqual([]);
		expect(args("ultrathink-quick")).toEqual([["message", true]]);
	});

	test("the ultrathink definition is unchanged and its description follows the planning mode", () => {
		expect(promptDefinitions()[0]).toEqual({
			name: "ultrathink",
			title: "Ultrathink",
			description: CLIENT_DESCRIPTION,
			arguments: [{ name: "request", description: "What to plan.", required: true }],
		});
		expect(promptDefinitions({ serverPlanning: true })[0]?.description).toBe(SERVER_DESCRIPTION);
	});

	test("every definition has a title, a description and described arguments, and none is an unsupported command", () => {
		for (const prompt of promptDefinitions()) {
			expect(prompt.title).not.toBe("");
			expect(prompt.description).not.toBe("");
			for (const argument of prompt.arguments) expect(argument.description).not.toBe("");
			expect(UNSUPPORTED).not.toContain(prompt.name);
		}
	});

	test("mutating a returned definition does not change the next list", () => {
		const first = promptDefinitions();
		first[0]?.arguments.push({ name: "extra", description: "x", required: false });
		expect(promptDefinitions()[0]?.arguments).toHaveLength(1);
	});
});

describe("the ultrathink prompt", () => {
	test("client-driven text is byte-identical to the text before the catalog and ends with the request", () => {
		const render = renderPrompt("ultrathink", { request: REQUEST });
		expect(textOf(render)).toBe(`${CLIENT_TEXT}\n${REQUEST}`);
		expect(render.ok && render.description).toBe(CLIENT_DESCRIPTION);
	});

	test("server text is the pinned text, requires a result call even when the start reports planned, and ends with the request", () => {
		const render = renderPrompt("ultrathink", { request: REQUEST }, { serverPlanning: true });
		expect(textOf(render)).toBe(`${SERVER_TEXT}\n${REQUEST}`);
		expect(render.ok && render.description).toBe(SERVER_DESCRIPTION);
	});

	test("the alias renders the same messages in server mode", () => {
		const options = { serverPlanning: true };
		expect(renderPrompt("ultrathink-plan", { request: REQUEST }, options)).toEqual(renderPrompt("ultrathink", { request: REQUEST }, options));
	});

	test("in client-driven mode the alias adds the graph step that the original prompt does not have", () => {
		const plain = textOf(renderPrompt("ultrathink", { request: REQUEST }));
		const alias = textOf(renderPrompt("ultrathink-plan", { request: REQUEST }));
		expect(plain).not.toContain("ultrathink_graph");
		expect(alias).toContain("ultrathink_graph");
		expect(alias.endsWith(`\n${REQUEST}`)).toBe(true);
	});

	test("the request is kept unmodified, including leading and trailing whitespace", () => {
		const request = "  \n plan this \t\n";
		expect(textOf(renderPrompt("ultrathink", { request })).endsWith(`\n${request}`)).toBe(true);
	});

	test("the name is matched after normalization: slash, namespace and case", () => {
		for (const name of ["/ultrathink", "ultrathink:ultrathink", "ULTRATHINK"]) {
			expect(renderPrompt(name, { request: "x" })).toEqual(renderPrompt("ultrathink", { request: "x" }));
		}
	});
});

describe("the new prompts", () => {
	test("ultrathink-think names ultrathink_graph and passes the given arguments as JSON strings", () => {
		const none = textOf(renderPrompt("ultrathink-think", {}));
		expect(none).toContain("ultrathink_graph");
		expect(none).toContain("no arguments");
		expect(none).toContain("mermaid");

		const both = textOf(renderPrompt("ultrathink-think", { sessionId: "abc-123", node: 'n"2\nx' }));
		expect(both).toContain('sessionId set to "abc-123"');
		expect(both).toContain('node set to "n\\"2\\nx"');
		expect(both).not.toContain("no arguments");

		const onlyNode = textOf(renderPrompt("ultrathink-think", { node: "n1", sessionId: "   " }));
		expect(onlyNode).toContain('node set to "n1"');
		expect(onlyNode).not.toContain("sessionId set to");
	});

	test("ultrathink-last uses ultrathink_graph then ultrathink_result and shows the diagram first", () => {
		const text = textOf(renderPrompt("ultrathink-last", {}));
		expect(text).toContain("ultrathink_graph");
		expect(text).toContain("ultrathink_result");
		expect(text).not.toContain("ultrathink_sessions");
		expect(text).toContain("mermaid");
		expect(text.indexOf("ultrathink_graph")).toBeLessThan(text.indexOf("ultrathink_result"));
	});

	test("ultrathink-status uses ultrathink_sessions only", () => {
		const text = textOf(renderPrompt("ultrathink-status", {}));
		expect(text).toContain("ultrathink_sessions");
		expect(text).not.toMatch(/ultrathink_(graph|plan|uplift|result|command)/);
	});

	test("ultrathink-quick tells the model to answer directly with no tool and ends with the message unchanged", () => {
		const message = "fix the typo in \"README\"\n/ultrathink please";
		const text = textOf(renderPrompt("ultrathink-quick", { message }));
		expect(text).toContain("directly");
		expect(text).toContain("no ultrathink tool");
		expect(text.endsWith(`\nMessage:\n${message}`)).toBe(true);
		expect(text).not.toMatch(/ultrathink_[a-z]+/);
	});

	test("no prompt sends the model to a tool outside the final surface", () => {
		const known = new Set([
			"ultrathink_uplift",
			"ultrathink_plan",
			"ultrathink_pending",
			"ultrathink_show",
			"ultrathink_answer",
			"ultrathink_status",
			"ultrathink_result",
			"ultrathink_graph",
			"ultrathink_sessions",
			"ultrathink_command",
		]);
		for (const name of SUPPORTED) {
			const args = { request: "x", message: "x" };
			for (const options of [undefined, { serverPlanning: true }]) {
				for (const tool of textOf(renderPrompt(name, args, options)).match(/\bultrathink_[a-z]+\b/g) ?? []) {
					expect(known.has(tool)).toBe(true);
				}
			}
		}
	});
});

describe("unsupported commands", () => {
	test("are not listed but render an explanation that relays the reason and alternative and calls no tool", () => {
		expect(UNSUPPORTED).toHaveLength(16);
		for (const name of UNSUPPORTED) {
			const entry = COMMAND_OVERLAY[name];
			const render = renderPrompt(name, {});
			const text = textOf(render);
			expect(render.ok).toBe(true);
			expect(text).toContain(`/${name}`);
			expect(text).toContain(`Reason: ${entry?.reason}.`);
			expect(text).toContain(`Instead: ${entry?.instead}.`);
			expect(text).toContain("one or two sentences");
			expect(text).toContain("Call no ultrathink tool");
			expect(text).not.toMatch(/ultrathink_[a-z]+/);
		}
	});

	test("accept arguments without using them, in either mode and under a namespaced name", () => {
		const bare = renderPrompt("ultrathink-track", {});
		expect(renderPrompt("ultrathink:ultrathink-track", { anything: 1, args: "off" }, { serverPlanning: true })).toEqual(bare);
		expect(renderPrompt("/ULTRATHINK-TRACK", undefined as unknown as Record<string, unknown>)).toEqual(bare);
	});
});

describe("refusals", () => {
	test("an unknown or non-string name is refused as an unknown prompt", () => {
		for (const name of [undefined, null, 7, {}, "", "other", "ultrathink-nope", "constructor", "__proto__", "//", "ultrathink:"]) {
			expect(renderPrompt(name, { request: "x" })).toEqual({ ok: false, message: "unknown prompt" });
		}
	});

	test("a missing, blank or non-string required argument is refused", () => {
		for (const request of [undefined, null, "", "  \n\t", 42, true, ["x"], { a: 1 }]) {
			expect(renderPrompt("ultrathink", { request })).toEqual({ ok: false, message: "request is required" });
			expect(renderPrompt("ultrathink-plan", { request })).toEqual({ ok: false, message: "request is required" });
		}
		expect(renderPrompt("ultrathink", {})).toEqual({ ok: false, message: "request is required" });
		for (const message of [undefined, "", "   ", 3]) {
			expect(renderPrompt("ultrathink-quick", { message })).toEqual({ ok: false, message: "message is required" });
		}
	});

	test("a text argument of 20,000 characters is accepted and one more is refused, for every text argument", () => {
		expect(MAX_ARGUMENT_CHARS).toBe(20_000);
		for (const options of [undefined, { serverPlanning: true }]) {
			expect(renderPrompt("ultrathink", { request: "x".repeat(20_000) }, options).ok).toBe(true);
			expect(renderPrompt("ultrathink", { request: "x".repeat(20_001) }, options)).toEqual({
				ok: false,
				message: "request is too long",
			});
		}
		expect(renderPrompt("ultrathink-quick", { message: "x".repeat(20_000) }).ok).toBe(true);
		expect(renderPrompt("ultrathink-quick", { message: "x".repeat(20_001) })).toEqual({
			ok: false,
			message: "message is too long",
		});
		expect(renderPrompt("ultrathink-think", { sessionId: "x".repeat(20_001) })).toEqual({
			ok: false,
			message: "sessionId is too long",
		});
		expect(renderPrompt("ultrathink-think", { node: "x".repeat(20_001) })).toEqual({
			ok: false,
			message: "node is too long",
		});
	});

	test("an optional argument that is not a string is refused; null and blank are skipped", () => {
		expect(renderPrompt("ultrathink-think", { sessionId: 5 })).toEqual({ ok: false, message: "sessionId must be a string" });
		expect(renderPrompt("ultrathink-think", { node: ["n1"] })).toEqual({ ok: false, message: "node must be a string" });
		expect(renderPrompt("ultrathink-think", { sessionId: null, node: "" })).toEqual(renderPrompt("ultrathink-think", {}));
	});
});
