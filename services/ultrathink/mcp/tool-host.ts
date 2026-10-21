// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

/**
 * The tool side of the MCP connector, shared by every transport: the HTTP router builds it with a planner, its metrics
 * and its ledger; a stdio server builds the same host without a planner. It runs the ten tools, never speaks JSON-RPC
 * (mcp.ts does) and never logs or counts on its own: the caller wraps `call` for that, and `onPlanFinished` reports
 * each finished server plan once.
 */

import type { HeadlessPlanner, ResultView } from "../engine/headless.ts";
import {
	type JournalOptions,
	type JournalResult,
	answerRequest,
	isSessionId,
	listPendingRequests,
	sessionStatus,
	showRequest,
	startPlan,
} from "../engine/journal.ts";
import { clientPlanView } from "../engine/plan-view.ts";
import type { CommandCatalog } from "./commands.ts";
import type { McpToolHost, ToolOutcome } from "./mcp.ts";
import type { ResourceRegistry } from "./resources.ts";
import { COMMAND_TOOL, GRAPH_TOOL, type PlanningInfo, SESSIONS_TOOL, createConnectorHandlers, textOutcome } from "./tools-connector.ts";

/** Finished plans remembered so each is counted once; the oldest are forgotten first. */
const COUNTED_PLANS_MAX = 2000;

export interface ToolHostDeps {
	journalOpts: JournalOptions;
	/** Absent in a host that cannot plan on the server: ultrathink_uplift is then refused and no tool waits on a job. */
	planner?: HeadlessPlanner;
	catalog: CommandCatalog;
	resources?: ResourceRegistry;
	/** Planning mode, ceilings and usage for ultrathink_sessions. Absent where there is no ledger. */
	planningInfo?: () => PlanningInfo;
	/** Called once for every server plan that reaches a final status, with the finished view. */
	onPlanFinished?: (view: ResultView) => void;
}

export interface ToolHost extends McpToolHost {
	capabilities(): { serverPlanning: boolean };
}

export function toOutcome(result: JournalResult<unknown>): ToolOutcome {
	if (result.ok) return { ok: true, data: result.data as Record<string, unknown> };
	return { ok: false, code: result.code, ...(result.errors !== undefined ? { errors: result.errors } : {}) };
}

export function createToolHost(deps: ToolHostDeps): ToolHost {
	const { journalOpts, planner } = deps;
	const countedPlans = new Set<string>();

	/** Counts a finished server plan once. */
	function recordFinished(view: ResultView): void {
		if (view.mode !== "server" || view.status === "running" || countedPlans.has(view.sessionId)) return;
		countedPlans.add(view.sessionId);
		if (countedPlans.size > COUNTED_PLANS_MAX) {
			const oldest = countedPlans.values().next().value;
			if (oldest !== undefined) countedPlans.delete(oldest);
		}
		deps.onPlanFinished?.(view);
	}

	const connector = createConnectorHandlers({
		stateDir: journalOpts.stateDir,
		...(planner ? { planner } : {}),
		catalog: deps.catalog,
		...(deps.planningInfo ? { planningInfo: deps.planningInfo } : {}),
		onFinished: recordFinished,
	});

	/** ultrathink_result without a planner: the views of client-driven sessions, validated as the planner would. */
	function clientResult(args: Record<string, unknown>): JournalResult<ResultView> {
		const { sessionId, detail, waitSeconds } = args;
		if (!isSessionId(sessionId)) return { ok: false, code: "invalid_session_id" };
		// Nothing to wait for without a planner, but a malformed value is refused as the planner would.
		if (waitSeconds !== undefined && (typeof waitSeconds !== "number" || Number.isNaN(waitSeconds))) {
			return { ok: false, code: "invalid_input" };
		}
		if (detail !== undefined && detail !== "brief" && detail !== "full") return { ok: false, code: "invalid_input" };
		return clientPlanView(journalOpts.stateDir, sessionId, detail === "full" ? "full" : "brief");
	}

	async function call(name: string, args: Record<string, unknown>): Promise<ToolOutcome> {
		switch (name) {
			case "ultrathink_plan": {
				// A server job and a client-driven plan share one session file; the reverse guard lives in headless start.
				if (planner?.status({ sessionId: args.sessionId }) != null) return { ok: false, code: "session_conflict" };
				return toOutcome(await startPlan(journalOpts, { prompt: args.prompt, sessionId: args.sessionId }));
			}
			case "ultrathink_pending": {
				const pending = listPendingRequests(journalOpts, { sessionId: args.sessionId });
				return toOutcome(pending.ok ? { ok: true, data: { pending: pending.data } } : pending);
			}
			case "ultrathink_show":
				return toOutcome(showRequest(journalOpts, { sessionId: args.sessionId, key: args.key, part: args.part }));
			case "ultrathink_answer":
				return toOutcome(answerRequest(journalOpts, { sessionId: args.sessionId, key: args.key, answer: args.answer }));
			case "ultrathink_status": {
				const server = planner?.status({ sessionId: args.sessionId });
				return toOutcome(server ?? sessionStatus(journalOpts, { sessionId: args.sessionId }));
			}
			case "ultrathink_uplift": {
				if (!planner) return { ok: false, code: "disabled" };
				const started = await planner.start({ prompt: args.prompt, sessionId: args.sessionId });
				if (started.ok && started.data.status !== "running") {
					// The start view carries no usage; the finished view does.
					const finished = await planner.result({ sessionId: started.data.sessionId, waitSeconds: 0 });
					if (finished.ok) recordFinished(finished.data);
				}
				return toOutcome(started);
			}
			case "ultrathink_result": {
				const result = planner
					? await planner.result({ sessionId: args.sessionId, waitSeconds: args.waitSeconds, detail: args.detail })
					: clientResult(args);
				if (!result.ok) return toOutcome(result);
				recordFinished(result.data);
				// The text stays in the structured data: Claude Code shows the model structuredContent instead of content.
				return textOutcome({ ...result.data }, result.data.text);
			}
			case GRAPH_TOOL:
				return connector.graph(args);
			case SESSIONS_TOOL:
				return connector.sessions(args);
			case COMMAND_TOOL:
				return connector.command(args);
			default:
				return { ok: false, code: "unknown_tool" };
		}
	}

	const host: ToolHost = {
		capabilities: () => ({ serverPlanning: planner?.enabled === true }),
		call,
	};
	if (deps.resources) host.resources = deps.resources;
	return host;
}
