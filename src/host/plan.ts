// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * One planning entry for every host. Hooks that already speak Claude JSON
 * call `runPromptSubmit` themselves; Hermes, Muse, and Omp call this.
 * Always fail-open: a skip or a throw becomes `{ context: "" }`.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { claudeConfigPaths, loadConfig, type UltrathinkConfig } from "../config.ts";
import { isChildInvocation } from "../claude/complete.ts";
import { runPromptSubmit } from "../claude/hook.ts";
import { readControl, sessionPath } from "../claude/state.ts";
import { recentConversationFromTranscript } from "../claude/transcript.ts";
import { parseUltrathinkCommand, trackingEnabled, trackingOff } from "../uplift/commands.ts";
import { decideUplift, isTrivial } from "../uplift/detect.ts";
import { planningTarget, type SkillInvocation } from "../uplift/skill.ts";
import { fetchBrief } from "../substrate/brief.ts";
import { writePlanCarrier } from "./carrier.ts";
import { createGatewayTracker, trackCommand, type Tracker } from "../track/gateway.ts";
import { detectHost } from "./detect.ts";
import { selectEngine } from "./engine.ts";
import { isOmpSubagentSessionId } from "./omp-session.ts";
import { resolveStateDir } from "./paths.ts";
import type { ProgressSink } from "./progress.ts";
import type { HostId } from "./types.ts";
import { buildPlanView, type PlanView } from "./view.ts";

export interface PlanRequest {
	host?: HostId;
	session_id?: string;
	prompt?: string;
	cwd?: string;
	transcript_path?: string;
	parent_session_id?: string;
	platform?: string;
}

export interface PlanResponse {
	context: string;
	specPath?: string;
	statePath?: string;
	graphId?: string;
	skipped?: string;
	carrierPath?: string;
	summary?: string;
	/** Display-only projection for host UIs; the model reads `context`. */
	view?: PlanView;
}

export interface PlanOptions {
	progress?: ProgressSink;
	/** Test seam for completer selection; defaults to `selectEngine`. */
	selectEngine?: typeof selectEngine;
	/** Test seam for the hook-side tracker; defaults to `createGatewayTracker`. */
	createTracker?: (config: UltrathinkConfig) => Tracker | undefined;
}

function skipReason(request: PlanRequest, env: Record<string, string | undefined>): string | undefined {
	if (env.ULTRATHINK_UPLIFT === "0" || env.ULTRATHINK_CHILD === "1" || isChildInvocation()) return "child-or-disabled";
	if (request.parent_session_id?.trim()) return "parent-session";
	if (request.platform?.trim() === "cron") return "cron";
	const prompt = request.prompt ?? "";
	if (!prompt.trim()) return "empty";
	return undefined;
}

export async function planPrompt(
	request: PlanRequest,
	env: Record<string, string | undefined> = process.env,
	options: PlanOptions = {},
): Promise<PlanResponse> {
	const started = Date.now();
	const skip = (reason: string | undefined): PlanResponse => {
		try {
			options.progress?.({ type: "end", at: Date.now(), outcome: "skipped", ...(reason ? { detail: reason } : {}) });
		} catch {
			// fail-open: progress is display only
		}
		return { context: "", skipped: reason };
	};
	const host = request.host ?? detectHost(env);
	const skipped = skipReason(request, env);
	if (skipped) return skip(skipped);
	if (host === "omp") {
		try {
			const agentDir = env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".omp", "agent");
			if (isOmpSubagentSessionId(request.session_id ?? "", { root: join(agentDir, "sessions") })) return skip("subagent");
		} catch {
			// fail-open: a throwing guard means "not a subagent"
		}
	}
	const cwd = request.cwd?.trim() || process.cwd();
	let text = request.prompt ?? "";
	let skill: SkillInvocation | undefined;
	try {
		// `/ultrathink-<verb>` (and the older `/ultrathink:<verb>` / `/ultrathink <verb>`) is a control command, never a request to plan.
		if (parseUltrathinkCommand(text)) return skip("ultrathink-command");
		const target = planningTarget(text, { cwd });
		if ("skip" in target) return skip(target.skip);
		text = target.text;
		skill = target.skill;
		// A Hermes skill loaded with no task (or only an ack) is a preamble, not a request to plan.
		if (host === "hermes" && skill && (!skill.instruction || isTrivial(skill.instruction))) return skip("skill-preamble");
	} catch {
		// fail-open: a throwing skill parser plans the prompt as written
	}
	const stateDir = resolveStateDir({ ...env, ULTRATHINK_HOST: host });
	try {
		const config = loadConfig(claudeConfigPaths(cwd, env));
		const control = readControl(stateDir);
		// Stateless skips (raw:, commands, uplifted XML, graph hand-offs, acks) never pay for engine selection; runPromptSubmit still applies enabled/skipOnce.
		const precheck = decideUplift(
			{ text, source: "user", idle: true },
			{ enabled: true, skipOnce: false, skipTrivial: config.uplift.skipTrivial },
		);
		if (precheck.action !== "uplift") return skip(`precheck-${precheck.action}`);
		const engine = await (options.selectEngine ?? selectEngine)(config, control, cwd);
		if ("skipped" in engine) return skip(engine.skipped);
		const sessionId = request.session_id?.trim() || "unknown";
		const result = await runPromptSubmit(
			{
				session_id: request.session_id,
				prompt: text,
				...(skill ? { skill } : {}),
				cwd,
				transcript_path: request.transcript_path,
			},
			{
				config,
				control,
				complete: engine.complete,
				engine: engine.label,
				engineError: engine.error,
				stateDir,
				surface: host,
				conversation: recentConversationFromTranscript,
				brief: (input) => fetchBrief(input, env),
				// On Hermes the kickoff skill creates rows through `track complete`, so an abandoned or killed hook never leaves orphan rows.
				track:
					host !== "hermes" && trackingEnabled(config, control, env)
						? (options.createTracker ?? createGatewayTracker)(config)
						: undefined,
				trackingOff: trackingOff(config, control),
				trackCommand: trackCommand(),
				progress: options.progress,
			},
		);
		if (result.skipped || !result.output) return skip(result.skipped);
		const context = result.output.hookSpecificOutput.additionalContext;
		const specPath = sessionPath(stateDir, sessionId).replace(/\.json$/, ".xml");
		const statePath = sessionPath(stateDir, sessionId);
		const graphId = result.record?.plan?.graphId;
		let carrier: string | undefined;
		try {
			carrier = writePlanCarrier({
				host,
				stateDir,
				sessionId,
				specPath,
				statePath,
				graphId,
				context,
			});
		} catch {
			// fail-open: the carrier is a pointer for hosts that drop context; the plan still stands
		}
		return {
			context,
			specPath,
			statePath,
			graphId,
			carrierPath: carrier,
			summary: result.output.systemMessage,
			...(result.record ? { view: buildPlanView(result.record, Date.now() - started) } : {}),
		};
	} catch {
		return skip("engine-error");
	}
}
