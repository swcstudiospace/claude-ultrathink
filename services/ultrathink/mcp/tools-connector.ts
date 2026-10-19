// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

/**
 * The three connector tools that give the chat client the plugin's slash commands: ultrathink_graph
 * (/ultrathink-think), ultrathink_sessions (/ultrathink-status, first step of /ultrathink-last) and
 * ultrathink_command (every other /ultrathink-<name>). The handlers take their dependencies explicitly so the HTTP
 * host and a stdio host can build them the same way; none of them reads the clock or the environment.
 *
 * Claude Code hands the model `structuredContent` instead of `content` when a result has both, so every text-bearing
 * result carries the same text in `data.text` as in the tool content.
 */

import { clientPlanView } from "../engine/plan-view.ts";
import { type GraphView, type GraphViewNode, renderGraphBlock } from "../engine/graph-view.ts";
import type { HeadlessPlanner, ResultView } from "../engine/headless.ts";
import { isSessionId } from "../engine/journal.ts";
import { listSessions, newestPlannedSessionId, type SessionSummary } from "../engine/sessions.ts";
import { GRAPH_APP_URI } from "../ui/graph-app.ts";
import {
	type CatalogCommand,
	COMMAND_OVERLAY,
	type CommandCatalog,
	helpText,
	MAX_ARGUMENT_CHARS,
	resolveCommand,
} from "./commands.ts";
import type { ToolDefinition, ToolOutcome } from "./mcp.ts";

// idempotentHint only means something for a tool that writes; the read-only tools carry it too so every tool states it.
export const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };

/** Tells an MCP Apps host which `ui://` resource draws the result: the nested shape and the legacy flat key. */
export const GRAPH_UI_META: Record<string, unknown> = {
	ui: { resourceUri: GRAPH_APP_URI },
	"ui/resourceUri": GRAPH_APP_URI,
};

/** Claude Code otherwise cuts a tool result at a much smaller size than a full plan or graph needs. */
export const LARGE_RESULT_META: Record<string, unknown> = { "anthropic/maxResultSizeChars": 200_000 };

export const GRAPH_TOOL = "ultrathink_graph";
export const SESSIONS_TOOL = "ultrathink_sessions";
export const COMMAND_TOOL = "ultrathink_command";

/** The three tools, always listed: a client that never refreshes tools/list must not miss them. */
export const CONNECTOR_TOOL_DEFINITIONS: readonly ToolDefinition[] = [
	{
		name: GRAPH_TOOL,
		title: "Show the Graph of Thought of a plan",
		description:
			"The tool behind the /ultrathink-think command: a message that starts with /ultrathink-think and a command name is this command, not a request to plan. When the user's message starts with /ultrathink-think, call this with the sessionId that follows it (omit sessionId to use the newest planned session) and node when a node id follows. Returns the plan's Graph of Thought x Chain of Thought as a wave tree and a Mermaid diagram; node adds that node's question, steps and conclusion, and detail full adds every node's. Show the user the wave tree first, unchanged, in a code block, and the Mermaid diagram too only if your interface renders Mermaid. With server planning the plan card already shows the graph, so do not call this after ultrathink_result for the same session unless the user asks; with a client-answered plan, call it once when the plan is ready.",
		inputSchema: {
			type: "object",
			properties: {
				sessionId: {
					type: "string",
					description: "Session id of the plan to show. Omit to use the newest planned session.",
				},
				node: { type: "string", description: "Id of one node to show with its question, steps and conclusion." },
				detail: {
					type: "string",
					enum: ["brief", "full"],
					default: "brief",
					description: "full adds the question, steps and conclusion of every node.",
				},
			},
			additionalProperties: false,
		},
		annotations: READ_ONLY,
		_meta: { ...GRAPH_UI_META, ...LARGE_RESULT_META },
	},
	{
		name: SESSIONS_TOOL,
		title: "List recent planning sessions",
		description:
			"The tool behind the /ultrathink-status command and the first step of /ultrathink-last. When the user's message starts with /ultrathink-status, call this with no arguments and tell the user the planning mode, the token ceilings and today's usage when the result has them, and one line per recent session. For /ultrathink-last, call this with limit 5, then call ultrathink_graph and ultrathink_result with the sessionId of the newest session whose status is planned, and show the user its wave tree first, unchanged, in a code block. Lists the newest sessions first with their sessionId, status, mode, goal and node count.",
		inputSchema: {
			type: "object",
			properties: {
				limit: {
					type: "integer",
					minimum: 1,
					maximum: 20,
					default: 5,
					description: "How many sessions to list, newest first.",
				},
			},
			additionalProperties: false,
		},
		annotations: READ_ONLY,
	},
	{
		name: COMMAND_TOOL,
		title: "Run an ultrathink slash command",
		description:
			"The tool for every other /ultrathink-<name> slash command, such as /ultrathink-plan, /ultrathink-ship or /ultrathink-teach, that ultrathink_graph and ultrathink_sessions do not serve. When the user's message starts with /ultrathink- and a command name, call this with command set to that name and args set to everything after it, verbatim, then relay the returned message to the user and make the tool call it names in next. /ultrathink-quick <message> needs no tool: answer the message directly. Use command help to list every command and whether this connector supports it.",
		inputSchema: {
			type: "object",
			properties: {
				command: {
					type: "string",
					maxLength: 100,
					description: "The command name, for example ultrathink-ship, ship or /ultrathink-ship. help lists every command.",
				},
				args: {
					type: "string",
					maxLength: MAX_ARGUMENT_CHARS,
					description: "Everything the user typed after the command, verbatim.",
				},
			},
			required: ["command"],
			additionalProperties: false,
		},
		annotations: READ_ONLY,
	},
];

/** What ultrathink_sessions reports about planning. Ceilings and usage exist only when the host plans on the server. */
export interface PlanningInfo {
	serverPlanning: boolean;
	model?: string;
	maxConcurrentPlans?: number;
	runTokenCeiling?: number;
	dailyTokenCeiling?: number;
	usedTodayTokens?: number;
}

export interface ConnectorDeps {
	stateDir: string;
	/** Absent in a host that cannot plan on the server; the views then come from the session records alone. */
	planner?: Pick<HeadlessPlanner, "enabled" | "result">;
	catalog: CommandCatalog;
	/** Absent in a host that has no ledger; ultrathink_sessions then reports only whether the host plans on the server. */
	planningInfo?: () => PlanningInfo;
	/** Called with every finished server plan the graph tool reads, so the host can count it once. */
	onFinished?: (view: ResultView) => void;
}

export interface ConnectorHandlers {
	graph(args: Record<string, unknown>): Promise<ToolOutcome>;
	sessions(args: Record<string, unknown>): ToolOutcome;
	command(args: Record<string, unknown>): Promise<ToolOutcome>;
}

/** Longest node id a caller may ask for; the view cuts ids to 40 characters. */
const MAX_NODE_CHARS = 100;
/** Sections of node detail stop being added once the text passes this, well under the 200000 the clients allow. */
const MAX_DETAIL_CHARS = 120_000;

const NO_PLANNED_SESSION =
	"There is no planned ultrathink session yet. Plan a request first with /ultrathink <request>, then ask again.";

const invalid = (...errors: string[]): ToolOutcome => ({ ok: false, code: "invalid_input", errors });

/** Result whose structured data carries the tool content text too (see the module comment). */
export function textOutcome(data: Record<string, unknown>, text: string): ToolOutcome {
	return { ok: true, data: { ...data, text }, text };
}

/** An optional string argument: absent, null and blank all mean "not given". */
function optionalText(value: unknown): { ok: true; value: string | undefined } | { ok: false } {
	if (value === undefined || value === null) return { ok: true, value: undefined };
	if (typeof value !== "string") return { ok: false };
	return { ok: true, value: value.trim() === "" ? undefined : value };
}

function nodeSection(node: GraphViewNode): string {
	const lines = [`### ${node.id}: ${node.title} [${node.kind}] - wave ${node.wave}`, `Question: ${node.question}`];
	if (node.steps.length > 0) lines.push("Steps:", ...node.steps.map((step, index) => `${index + 1}. ${step}`));
	if (node.conclusion !== "") lines.push(`Conclusion: ${node.conclusion}`);
	return lines.join("\n");
}

/** The node ids are model text, so an exact match wins and a case-insensitive match is the fallback. */
function findNode(view: GraphView, wanted: string): GraphViewNode | undefined {
	const id = wanted.trim();
	return view.nodes.find((node) => node.id === id) ?? view.nodes.find((node) => node.id.toLowerCase() === id.toLowerCase());
}

function graphText(sessionId: string, view: GraphView, node: GraphViewNode | undefined, detail: "brief" | "full"): string {
	const parts = [`Session: ${sessionId}`, renderGraphBlock(view)];
	const sections = node ? [node] : detail === "full" ? view.nodes : [];
	let size = parts.join("\n\n").length;
	for (const [index, section] of sections.entries()) {
		if (size > MAX_DETAIL_CHARS) {
			parts.push(`[${sections.length - index} more node(s) left out to fit the size limit; ask for one with node.]`);
			break;
		}
		const text = nodeSection(section);
		size += text.length;
		parts.push(text);
	}
	return parts.join("\n\n");
}

function when(ms: number): string {
	const date = new Date(ms);
	return Number.isNaN(date.getTime()) ? "unknown time" : date.toISOString();
}

function planningLines(planning: PlanningInfo): string[] {
	if (!planning.serverPlanning) {
		return ["Planning: client-driven. The chat model answers the planning prompts; the server does not plan."];
	}
	const facts = [
		planning.model === undefined ? undefined : `model ${planning.model}`,
		planning.maxConcurrentPlans === undefined ? undefined : `up to ${planning.maxConcurrentPlans} plans at once`,
		planning.runTokenCeiling === undefined ? undefined : `${planning.runTokenCeiling} tokens per plan`,
		planning.dailyTokenCeiling === undefined ? undefined : `${planning.dailyTokenCeiling} tokens per day`,
		planning.usedTodayTokens === undefined ? undefined : `${planning.usedTodayTokens} tokens used today (UTC)`,
	].filter((fact): fact is string => fact !== undefined);
	return [`Planning: server planning${facts.length > 0 ? ` (${facts.join(", ")})` : ""}.`];
}

function sessionsText(sessions: readonly SessionSummary[], planning: PlanningInfo): string {
	const lines = planningLines(planning);
	if (sessions.length === 0) {
		lines.push("No sessions yet.");
		return lines.join("\n");
	}
	lines.push(`Recent sessions, newest first (${sessions.length}):`);
	for (const session of sessions) {
		const nodes = session.hasGraph ? `${session.nodeCount} nodes` : "no graph";
		const goal = session.goal === "" ? "(no goal yet)" : session.goal;
		lines.push(`- ${session.sessionId} | ${session.status} | ${session.mode} | ${when(session.updatedAt)} | ${nodes} | ${goal}`);
	}
	return lines.join("\n");
}

function describeCommand(command: CatalogCommand): Record<string, unknown> {
	return {
		name: command.name,
		state: command.state,
		description: command.description,
		...(command.aliasOf === undefined ? {} : { aliasOf: command.aliasOf }),
		...(command.summary === undefined ? {} : { summary: command.summary }),
		...(command.reason === undefined ? {} : { reason: command.reason }),
		...(command.instead === undefined ? {} : { instead: command.instead }),
	};
}

/**
 * The catalog built from the static overlay alone: the descriptions that the command files would add are empty.
 * The fallback of a release that ships without its commands/ and skills/ directories.
 */
export function catalogFromOverlay(overlay = COMMAND_OVERLAY): CommandCatalog {
	const commands: CatalogCommand[] = Object.entries(overlay).map(([name, entry]) => ({
		name,
		toolName: name.replaceAll("-", "_"),
		description: entry.description ?? "",
		sources: [],
		state: entry.state,
		tools: entry.tools,
		arguments: entry.arguments ?? [],
		...(entry.aliasOf === undefined ? {} : { aliasOf: entry.aliasOf }),
		...(entry.summary === undefined ? {} : { summary: entry.summary }),
		...(entry.reason === undefined ? {} : { reason: entry.reason }),
		...(entry.instead === undefined ? {} : { instead: entry.instead }),
	}));
	const index = new Map(commands.map((command) => [command.name, command]));
	return { commands, find: (name) => index.get(name) };
}

/** What `/ultrathink-think <args>` carries: an optional session id, then an optional node id. */
function thinkArguments(text: string | undefined): { sessionId?: string; node?: string } | undefined {
	const tokens = (text ?? "").split(/\s+/).filter((token) => token !== "");
	if (tokens.length > 2) return undefined;
	const [first, second] = tokens;
	if (first === undefined) return {};
	if (isSessionId(first)) return second === undefined ? { sessionId: first } : { sessionId: first, node: second };
	return second === undefined ? { node: first } : undefined;
}

export function createConnectorHandlers(deps: ConnectorDeps): ConnectorHandlers {
	const { stateDir, planner, catalog } = deps;

	function planning(): PlanningInfo {
		const fallback: PlanningInfo = { serverPlanning: planner?.enabled === true };
		if (deps.planningInfo === undefined) return fallback;
		try {
			return deps.planningInfo();
		} catch {
			// A ledger that cannot answer must not hide the sessions.
			return fallback;
		}
	}

	async function graph(args: Record<string, unknown>): Promise<ToolOutcome> {
		const { detail } = args;
		if (detail !== undefined && detail !== "brief" && detail !== "full") return invalid("detail must be brief or full");
		const node = optionalText(args.node);
		if (!node.ok || (node.value !== undefined && node.value.length > MAX_NODE_CHARS)) {
			return invalid("node must be a node id of at most 100 characters");
		}
		const given = optionalText(args.sessionId);
		if (!given.ok) return { ok: false, code: "invalid_session_id" };
		let sessionId = given.value;
		if (sessionId === undefined) {
			sessionId = newestPlannedSessionId(stateDir);
			if (sessionId === undefined) return textOutcome({ status: "none" }, NO_PLANNED_SESSION);
		} else if (!isSessionId(sessionId)) {
			return { ok: false, code: "invalid_session_id" };
		}

		// The plan text of the view is not used here; brief keeps the render cheap.
		const read = planner
			? await planner.result({ sessionId, waitSeconds: 0, detail: "brief" })
			: clientPlanView(stateDir, sessionId, "brief");
		if (!read.ok) return read.errors === undefined ? { ok: false, code: read.code } : { ok: false, code: read.code, errors: read.errors };
		const view = read.data;
		deps.onFinished?.(view);

		const base = { sessionId: view.sessionId, status: view.status, mode: view.mode };
		if (view.status !== "planned") return textOutcome(base, view.text);
		if (!view.graph) {
			if (node.value !== undefined) return { ok: false, code: "not_found" };
			return textOutcome(
				base,
				`Session ${sessionId} is planned but has no graph to draw. Use ultrathink_result for the plan itself.`,
			);
		}
		const found = node.value === undefined ? undefined : findNode(view.graph, node.value);
		if (node.value !== undefined && found === undefined) return { ok: false, code: "not_found" };
		return textOutcome({ ...base, graph: view.graph }, graphText(sessionId, view.graph, found, detail === "full" ? "full" : "brief"));
	}

	function sessions(args: Record<string, unknown>): ToolOutcome {
		const { limit } = args;
		if (limit !== undefined && limit !== null && (typeof limit !== "number" || !Number.isFinite(limit))) {
			return invalid("limit must be a number from 1 to 20");
		}
		const list = listSessions(stateDir, typeof limit === "number" ? { limit } : {});
		const info = planning();
		return textOutcome({ sessions: list, planning: info }, sessionsText(list, info));
	}

	async function command(args: Record<string, unknown>): Promise<ToolOutcome> {
		if (typeof args.command !== "string" || args.command.trim() === "") return invalid("command is required");
		const rest = optionalText(args.args);
		if (!rest.ok) return invalid("args must be a string");
		if (rest.value !== undefined && rest.value.length > MAX_ARGUMENT_CHARS) return invalid("args is too long");
		const request = rest.value?.trim();

		const resolved = resolveCommand(args.command);
		if (resolved.kind === "help") {
			const text = helpText();
			return textOutcome(
				{ command: "help", support: "native", message: text, commands: catalog.commands.map(describeCommand) },
				text,
			);
		}
		if (resolved.kind === "unknown") {
			const known = resolved.suggestions.flatMap((name) => {
				const found = catalog.find(name);
				return found === undefined ? [] : [found];
			});
			const names = resolved.suggestions.map((name) => `/${name}`).join(", ");
			const text = `${JSON.stringify(args.command.slice(0, 100))} is not an ultrathink command. The closest are: ${names}. Call ultrathink_command with command help to list every command.`;
			return textOutcome({ command: args.command.trim().slice(0, 100), support: "unknown", message: text, commands: known.map(describeCommand) }, text);
		}

		const { name, entry, target } = resolved;
		const support = entry.state;
		switch (entry.state) {
			case "unsupported": {
				const text = `/${name} is not supported on this connector: ${entry.reason ?? "it needs a plugin host"}. Instead: ${entry.instead ?? "use it in a plugin host"}. Relay this to the user in one or two sentences and call no other tool.`;
				return textOutcome({ command: name, support, message: text }, text);
			}
			case "passthrough": {
				const text = `/${name} needs no ultrathink tool: answer the user's message directly and call no ultrathink tool.`;
				return textOutcome({ command: name, support, message: text }, text);
			}
			default:
				break;
		}

		switch (target) {
			case "ultrathink": {
				const serverPlanning = planner?.enabled === true;
				if (request === undefined) {
					const text = `/${name} needs a request to plan. Ask the user what to plan and call no tool.`;
					return textOutcome({ command: name, support, message: text }, text);
				}
				const tool = serverPlanning ? "ultrathink_uplift" : "ultrathink_plan";
				const text = serverPlanning
					? `Plan commands run through their own tools. Call ultrathink_uplift with prompt set to the request, verbatim; while its status is running call ultrathink_result with the sessionId until the status is planned, then ask the user the questions in the plan that matter and carry out the plan.`
					: `Plan commands run through their own tools. Call ultrathink_plan with prompt set to the request, verbatim, answer each pending prompt with ultrathink_show and ultrathink_answer, call ultrathink_plan again with the same sessionId and prompt until the status is planned, then call ultrathink_result with the sessionId.`;
				return textOutcome({ command: name, support, message: text, next: { tool, arguments: { prompt: request } } }, text);
			}
			case "ultrathink-think": {
				const parsed = thinkArguments(request);
				if (parsed === undefined) return invalid("args must be an optional session id and an optional node id");
				const inner = await graph(parsed);
				const shown = inner.ok && typeof inner.data.sessionId === "string";
				return wrapped(name, support, inner, shown ? "Graph of Thought of the plan. Show its wave tree to the user first, unchanged, in a code block." : NO_PLANNED_SESSION);
			}
			case "ultrathink-last": {
				const inner = await graph({});
				if (!inner.ok) return inner;
				const sessionId = inner.data.sessionId;
				const extra = typeof sessionId === "string" ? { next: { tool: "ultrathink_result", arguments: { sessionId } } } : {};
				const summary =
					typeof sessionId === "string"
						? "The newest planned session. Show its wave tree to the user first, unchanged, in a code block, then call ultrathink_result with the sessionId in next for the plan itself."
						: NO_PLANNED_SESSION;
				return wrapped(name, support, inner, summary, extra);
			}
			case "ultrathink-status": {
				return wrapped(name, support, sessions({}), "Planning mode, ceilings and recent sessions.");
			}
			default: {
				const text = `/${name} is not available on this connector. Call ultrathink_command with command help to list every command.`;
				return textOutcome({ command: name, support: "unknown", message: text }, text);
			}
		}
	}

	return { graph, sessions, command };
}

/** A handler's own output returned as a command result: its text unchanged, its other fields under `result`. */
function wrapped(
	command: string,
	support: string,
	inner: ToolOutcome,
	message: string,
	extra: Record<string, unknown> = {},
): ToolOutcome {
	if (!inner.ok) return inner;
	const { text, ...result } = inner.data;
	return textOutcome({ command, support, message, result, ...extra }, typeof text === "string" ? text : message);
}
