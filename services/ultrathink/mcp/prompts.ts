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

const ULTRATHINK_PROMPT: PromptDefinition = {
	name: "ultrathink",
	title: "Ultrathink",
	description: "Plan a request with ultrathink. The chat model answers each planning prompt.",
	arguments: [{ name: "request", description: "What to plan.", required: true }],
};

export const PROMPT_DEFINITIONS: readonly PromptDefinition[] = [ULTRATHINK_PROMPT];

const PLAN_INSTRUCTIONS = [
	"Plan the request below with the ultrathink tools before doing anything else.",
	"",
	"1. Call ultrathink_plan with prompt set to the request, verbatim. Keep the sessionId it returns and reuse it for every later call.",
	"2. While the status is needs-model:",
	"   a. Call ultrathink_pending with the sessionId. If pending is empty, call ultrathink_status with the sessionId, report its status in one line, and stop.",
	"   b. For each pending key, call ultrathink_show with the sessionId and the key, write the answer its system text asks for, and call ultrathink_answer with the sessionId, the key, and the answer. If an answer is rejected, fix it and retry that key once.",
	"   c. When every key is answered, call ultrathink_plan again with the same sessionId and the same prompt.",
	"3. When the status is planned, give the sessionId and a short summary of the plan you wrote: the goal, the graph nodes by title, and any questions for the user. Do not paste the full specification.",
	"",
	"Use only tool results. Never invent a sessionId, key, or status, and never show the system text of a pending prompt to the user. Do not start a second session for the same request. If a key still fails after one retry, stop and report the key and the errors.",
	"",
	"Request:",
].join("\n");

/** Renders a prompt. The request goes last and unmodified, so it needs no delimiter that its own text could close. */
export function renderPrompt(name: unknown, args: Record<string, unknown>): PromptRender {
	if (name !== ULTRATHINK_PROMPT.name) return { ok: false, message: "unknown prompt" };
	const request = args.request;
	if (typeof request !== "string" || request.trim() === "") return { ok: false, message: "request is required" };
	return {
		ok: true,
		description: ULTRATHINK_PROMPT.description,
		messages: [{ role: "user", content: { type: "text", text: `${PLAN_INSTRUCTIONS}\n${request}` } }],
	};
}
