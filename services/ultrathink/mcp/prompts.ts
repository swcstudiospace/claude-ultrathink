// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

/**
 * MCP prompts. A client that lists prompts can offer them as slash commands.
 * A prompt only returns text for the client to send. It runs no tool and has no side effect.
 * Which commands exist, and which are supported, is decided by the overlay in commands.ts.
 */

import { COMMAND_OVERLAY, type CommandArgument, MAX_ARGUMENT_CHARS, type OverlayEntry, overlayEntry, toPromptName } from "./commands.ts";

export interface PromptArgument {
	name: string;
	description: string;
	required: boolean;
}

export interface PromptDefinition {
	name: string;
	title: string;
	description: string;
	arguments: PromptArgument[];
}

export interface PromptMessage {
	role: "user";
	content: { type: "text"; text: string };
}

export type PromptRender =
	| { ok: true; description: string; messages: PromptMessage[] }
	| { ok: false; message: string };

export interface PromptOptions {
	/** True when the server plans with its own model. Default false: the chat model answers each planning prompt. */
	serverPlanning?: boolean;
}

const CLIENT_DESCRIPTION = "Plan a request with ultrathink. The chat model answers each planning prompt.";
const SERVER_DESCRIPTION = "Plan a request with ultrathink. The server does the thinking and returns the plan.";

/** Title and description of a listed prompt. The overlay owns the arguments; the planning prompts also depend on the mode. */
function promptText(name: string, entry: OverlayEntry, serverPlanning: boolean): { title: string; description: string } {
	const planning = serverPlanning ? SERVER_DESCRIPTION : CLIENT_DESCRIPTION;
	switch (name) {
		case "ultrathink":
			return { title: "Ultrathink", description: planning };
		case "ultrathink-plan":
			return { title: "Ultrathink plan", description: planning };
		case "ultrathink-think":
			return { title: "Ultrathink graph", description: "Show the Graph of Thought of a plan: its diagram, tree and one node's steps." };
		case "ultrathink-last":
			return { title: "Ultrathink last plan", description: "Show the newest planned session's plan with its diagram." };
		case "ultrathink-status":
			return { title: "Ultrathink status", description: "Show the planning mode, the token ceilings and recent sessions." };
		case "ultrathink-quick":
			return { title: "Ultrathink quick", description: "Answer one message directly, with no ultrathink planning." };
		default:
			return { title: name, description: entry.summary ?? name };
	}
}

function definition(name: string, entry: OverlayEntry, serverPlanning: boolean): PromptDefinition {
	return {
		name,
		...promptText(name, entry, serverPlanning),
		arguments: (entry.arguments ?? []).map((argument) => ({ ...argument })),
	};
}

/** Every supported command, in overlay order. Unsupported commands are left out of the list but still answer prompts/get. */
export function promptDefinitions(options?: PromptOptions): readonly PromptDefinition[] {
	const serverPlanning = options?.serverPlanning === true;
	return Object.entries(COMMAND_OVERLAY)
		.filter(([, entry]) => entry.state !== "unsupported")
		.map(([name, entry]) => definition(name, entry, serverPlanning));
}

const SERVER_INSTRUCTIONS = [
	"Plan the request below with ultrathink before doing anything else. The server does the thinking; you do not write the plan.",
	"",
	"1. Call ultrathink_uplift with prompt set to the request, verbatim. Keep the sessionId it returns and reuse it for every later call.",
	"2. While the status is running, call ultrathink_result with the sessionId. It waits for the plan and reports running again if the plan is not ready yet; call it again.",
	"3. When the status is planned, the text of the result is the plan. Ask the user the questions in it that matter, or state the defaults you assume for the rest, then carry out the plan.",
	"4. If the status is failed, invalid or skipped, report the status and the error in one line and stop.",
	"",
	"Use only tool results. Never invent a sessionId or status. Do not start a second session for the same request.",
	"",
	"Request:",
].join("\n");

const CLIENT_INSTRUCTIONS = [
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

const THINK_INSTRUCTIONS_HEAD = "Show the Graph of Thought of an ultrathink plan.";

const THINK_INSTRUCTIONS_TAIL = [
	"2. Show the wave tree from the result to the user first, unchanged, in a code block. If your interface renders Mermaid, also show the mermaid diagram. Then, when a node was asked for, show that node's question, steps and conclusion.",
	"3. If the result says there is no planned session, say so in one line and stop.",
	"",
	"Use only tool results. Never invent a sessionId, a node or a graph. Call no other ultrathink tool.",
].join("\n");

const LAST_INSTRUCTIONS = [
	"Show the newest planned ultrathink plan with its Graph of Thought.",
	"",
	"1. Call ultrathink_sessions with limit 5. Pick the newest session whose status is planned. If there is none, say so in one line and stop.",
	"2. Call ultrathink_graph with that sessionId, and call ultrathink_result with that sessionId.",
	"3. Show the wave tree from ultrathink_graph to the user first, unchanged, in a code block (and the mermaid diagram too if your interface renders Mermaid). Then give the plan from ultrathink_result: what it decides and the questions in it that matter.",
	"",
	"Use only tool results. Never invent a sessionId. Do not start a plan.",
].join("\n");

const STATUS_INSTRUCTIONS = [
	"Show the state of ultrathink planning on this connector.",
	"",
	"1. Call ultrathink_sessions with no arguments.",
	"2. Report in a few lines the planning mode (server planning or client-driven), the token ceilings and the tokens used today when the result has them, then one line per recent session with its sessionId, status and goal.",
	"",
	"Use only tool results. Do not start a plan and call no other ultrathink tool.",
].join("\n");

const QUICK_INSTRUCTIONS = [
	"Answer the message below directly. Ultrathink planning and tracking are skipped for this one message: do not plan it and call no ultrathink tool.",
	"",
	"Message:",
].join("\n");

/** The user message for a command the connector does not support: relay the reason and the alternative, run nothing. */
function explanation(name: string, entry: OverlayEntry): string {
	return [
		`The user typed /${name}, which the ultrathink connector does not support.`,
		"",
		`Reason: ${entry.reason ?? ""}.`,
		`Instead: ${entry.instead ?? ""}.`,
		"",
		"Relay the reason and the alternative to the user in one or two sentences. Call no ultrathink tool and do nothing else for this message.",
	].join("\n");
}

function thinkInstructions(values: ReadonlyMap<string, string>): string {
	const given = ["sessionId", "node"].flatMap((argument) => {
		const value = values.get(argument);
		return value === undefined ? [] : [`${argument} set to ${JSON.stringify(value)}`];
	});
	const call =
		given.length === 0
			? "1. Call ultrathink_graph with no arguments; it uses the newest planned session."
			: `1. Call ultrathink_graph with ${given.join(" and ")}, and no other argument.`;
	return [THINK_INSTRUCTIONS_HEAD, "", call, THINK_INSTRUCTIONS_TAIL].join("\n");
}

/**
 * The text argument values of a prompt, validated against the overlay's argument list. A required argument that is
 * missing, blank or not a string is refused; an optional one is skipped when absent or blank and refused when it is
 * not a string. Nothing over MAX_ARGUMENT_CHARS is accepted. Values are kept unmodified.
 */
function readArguments(
	specs: readonly CommandArgument[],
	args: Record<string, unknown>,
): { ok: true; values: Map<string, string> } | { ok: false; message: string } {
	const values = new Map<string, string>();
	for (const spec of specs) {
		const value = args[spec.name];
		if (value === undefined || value === null) {
			if (spec.required) return { ok: false, message: `${spec.name} is required` };
			continue;
		}
		if (typeof value !== "string") {
			return { ok: false, message: spec.required ? `${spec.name} is required` : `${spec.name} must be a string` };
		}
		if (value.trim() === "") {
			if (spec.required) return { ok: false, message: `${spec.name} is required` };
			continue;
		}
		if (value.length > MAX_ARGUMENT_CHARS) return { ok: false, message: `${spec.name} is too long` };
		values.set(spec.name, value);
	}
	return { ok: true, values };
}

/** The user message of a supported command; the user's own text, where there is one, goes last and unmodified. */
function promptBody(name: string, values: ReadonlyMap<string, string>, serverPlanning: boolean): string | undefined {
	switch (name) {
		case "ultrathink":
		case "ultrathink-plan":
			return `${serverPlanning ? SERVER_INSTRUCTIONS : CLIENT_INSTRUCTIONS}\n${values.get("request") ?? ""}`;
		case "ultrathink-think":
			return thinkInstructions(values);
		case "ultrathink-last":
			return LAST_INSTRUCTIONS;
		case "ultrathink-status":
			return STATUS_INSTRUCTIONS;
		case "ultrathink-quick":
			return `${QUICK_INSTRUCTIONS}\n${values.get("message") ?? ""}`;
		default:
			return undefined;
	}
}

/** The overlay entry a prompt name stands for: `ultrathink-quick`, `/ultrathink-quick` and `ultrathink:ultrathink-quick` are one prompt. */
function promptEntry(name: unknown): { name: string; entry: OverlayEntry } | undefined {
	if (typeof name !== "string") return undefined;
	try {
		const key = toPromptName(name);
		const entry = overlayEntry(COMMAND_OVERLAY, key);
		return entry === undefined ? undefined : { name: key, entry };
	} catch {
		return undefined;
	}
}

/**
 * Renders a prompt. The user's text goes last and unmodified, so it needs no delimiter that its own text could close.
 * A text argument over MAX_ARGUMENT_CHARS is refused. An unsupported command renders an explanation instead of an error.
 */
export function renderPrompt(name: unknown, args: Record<string, unknown>, options?: PromptOptions): PromptRender {
	const found = promptEntry(name);
	if (found === undefined) return { ok: false, message: "unknown prompt" };
	if (found.entry.state === "unsupported") {
		return {
			ok: true,
			description: `/${found.name} is not supported on the connector.`,
			messages: [{ role: "user", content: { type: "text", text: explanation(found.name, found.entry) } }],
		};
	}
	const parsed = readArguments(found.entry.arguments ?? [], args);
	if (!parsed.ok) return parsed;
	const serverPlanning = options?.serverPlanning === true;
	const text = promptBody(found.name, parsed.values, serverPlanning);
	if (text === undefined) return { ok: false, message: "unknown prompt" };
	return {
		ok: true,
		description: definition(found.name, found.entry, serverPlanning).description,
		messages: [{ role: "user", content: { type: "text", text } }],
	};
}
