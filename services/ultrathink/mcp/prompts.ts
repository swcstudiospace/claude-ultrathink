// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

/**
 * MCP prompts. A client that lists prompts can offer them as slash commands.
 * A prompt only returns text for the client to send. It runs no tool and has no side effect.
 */

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

/** The longest request a prompt accepts, in characters. */
export const MAX_REQUEST_CHARS = 20_000;

const PROMPT_NAME = "ultrathink";
const CLIENT_DESCRIPTION = "Plan a request with ultrathink. The chat model answers each planning prompt.";
const SERVER_DESCRIPTION = "Plan a request with ultrathink. The server does the thinking and returns the plan.";

function definition(options: PromptOptions | undefined): PromptDefinition {
	return {
		name: PROMPT_NAME,
		title: "Ultrathink",
		description: options?.serverPlanning === true ? SERVER_DESCRIPTION : CLIENT_DESCRIPTION,
		arguments: [{ name: "request", description: "What to plan.", required: true }],
	};
}

export function promptDefinitions(options?: PromptOptions): readonly PromptDefinition[] {
	return [definition(options)];
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

/**
 * Renders a prompt. The request goes last and unmodified, so it needs no delimiter that its own text could close.
 * A request over MAX_REQUEST_CHARS is refused.
 */
export function renderPrompt(name: unknown, args: Record<string, unknown>, options?: PromptOptions): PromptRender {
	if (name !== PROMPT_NAME) return { ok: false, message: "unknown prompt" };
	const request = args.request;
	if (typeof request !== "string" || request.trim() === "") return { ok: false, message: "request is required" };
	if (request.length > MAX_REQUEST_CHARS) return { ok: false, message: "request is too long" };
	const instructions = options?.serverPlanning === true ? SERVER_INSTRUCTIONS : CLIENT_INSTRUCTIONS;
	return {
		ok: true,
		description: definition(options).description,
		messages: [{ role: "user", content: { type: "text", text: `${instructions}\n${request}` } }],
	};
}
