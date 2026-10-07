// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * One planning entry for every host. Hooks that already speak Claude JSON
 * call `runPromptSubmit` themselves; Hermes, Muse, and Omp call this.
 * Always fail-open: a skip, a cancellation or a throw becomes `{ context: "" }`.
 * Deterministic skips run before an engine is selected; one selected engine
 * then serves every stage, and its safe resolution record travels with the plan.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { claudeConfigPaths, loadConfig, type UltrathinkConfig } from "../config.ts";
import { isChildInvocation } from "../claude/complete.ts";
import { type HookDeps, runPromptSubmit } from "../claude/hook.ts";
import { type ControlState, readControl, sessionPath, writeControl } from "../claude/state.ts";
import { recentConversationFromTranscript } from "../claude/transcript.ts";
import { parseUltrathinkCommand, trackingEnabled, trackingOff } from "../uplift/commands.ts";
import { decideUplift, isTrivial } from "../uplift/detect.ts";
import { planningTarget, type SkillInvocation } from "../uplift/skill.ts";
import { fetchBrief } from "../substrate/brief.ts";
import { writePlanCarrier } from "./carrier.ts";
import { createGatewayTracker, trackCommand, type Tracker } from "../track/gateway.ts";
import { detectHost } from "./detect.ts";
import { type ModelResolution, type NativeEngineSelector, selectEngine } from "./engine.ts";
import { isOmpSubagentSessionId } from "./omp-session.ts";
import { resolveStateDir } from "./paths.ts";
import type { ProgressSink } from "./progress.ts";
import type { HostId } from "./types.ts";
import type { UpliftState } from "../types.ts";
import { buildPlanView, type PlanView } from "./view.ts";

export interface PlanRequest {
	host?: HostId;
	session_id?: string;
	prompt?: string;
	cwd?: string;
	transcript_path?: string;
	parent_session_id?: string;
	platform?: string;
	/** Legacy session model evidence (Hermes forwards its hook payload's): a route hint for Hermes `auto` only, never a wire model, native target or credential binding. */
	model?: string;
	/** Optional opaque legacy provider declaration; never auth, endpoint or credential-binding proof. */
	provider?: string;
	/** Parser-generated: the entry was handed a host it does not recognize. Planning returns unresolved / unsupported-host. */
	invalidHost?: true;
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
	/**
	 * Safe selection record (§6) on a planned prompt, a selection skip (unresolved, with the notice as `summary`) and a
	 * cancellation after selection; absent on deterministic skips decided before an engine was selected.
	 */
	modelResolution?: ModelResolution;
}

export interface PlanOptions {
	progress?: ProgressSink;
	/** Test seam for completer selection; defaults to `selectEngine`. An injected selector stays authoritative. */
	selectEngine?: typeof selectEngine;
	/** In-process native selector (Omp); selection consults it only for Omp planning under `auto`. Never crosses a process boundary. */
	native?: NativeEngineSelector;
	/** The whole planning lifetime: selection, every stage, tracking and delivery stop once it aborts. */
	signal?: AbortSignal;
	/** Captured config for this flight, used as given; defaults to the layered config files for the request's cwd. */
	config?: UltrathinkConfig;
	/** Captured control state, used as given; defaults to the host's control file. Skip-once consumption still writes control. */
	control?: ControlState;
	/** State directory for control, sessions, specs and the carrier; defaults to the host's resolved state directory. */
	stateDir?: string;
	/** Test seam for the hook-side tracker; defaults to `createGatewayTracker`. */
	createTracker?: (config: UltrathinkConfig) => Tracker | undefined;
	/** Test seams for the lessons and RAGFlow lookups (see HookDeps); default to the configured Teachable Moments and RAGFlow. */
	recall?: HookDeps["recall"];
	ground?: HookDeps["ground"];
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
	const skip = (reason: string | undefined, modelResolution?: ModelResolution): PlanResponse => {
		const withResolution = modelResolution ? { modelResolution } : {};
		try {
			options.progress?.({ type: "end", at: Date.now(), outcome: "skipped", ...(reason ? { detail: reason } : {}), ...withResolution });
		} catch {
			// fail-open: progress is display only
		}
		return { context: "", skipped: reason, ...withResolution };
	};
	const host = request.host ?? detectHost(env);
	const skipped = skipReason(request, env);
	if (skipped) return skip(skipped);
	const cwd = request.cwd?.trim() || process.cwd();
	if (request.invalidHost) {
		// An entry handed a host it does not recognize gets a visible unresolved record, never a detected host's route,
		// control or state. The record uses the §6 vocabulary only: diagnostic host "unknown", no transport, provider or
		// model, and a label generated from these fixed fields; the raw host value never reaches it.
		try {
			const config = options.config ?? loadConfig(claudeConfigPaths(cwd, env));
			const requested = options.control?.engine;
			const unsupported: ModelResolution = {
				version: "1.0.0",
				state: "unresolved",
				host: "unknown",
				source: "none",
				reason: "unsupported-host",
				engineSelection: { engine: requested ?? config.think.engine, source: requested === undefined ? "config" : "control", nativeOptOut: false },
				modelKnown: false,
				label: "unknown:unresolved [unsupported-host]",
			};
			return { ...skip(unsupported.reason, unsupported), summary: `Prompt Uplift skipped · ${unsupported.label}` };
		} catch {
			return skip("engine-error");
		}
	}
	if (host === "omp") {
		try {
			const agentDir = env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".omp", "agent");
			if (isOmpSubagentSessionId(request.session_id ?? "", { root: join(agentDir, "sessions") })) return skip("subagent");
		} catch {
			// fail-open: a throwing guard means "not a subagent"
		}
	}
	let text = request.prompt ?? "";
	let skill: SkillInvocation | undefined;
	// Supplied config, control and stateDir are this flight's captured values, never alternate stores: skip-once is still
	// consumed here and written to the one state directory planning, carriers and commands share.
	const stateDir = options.stateDir ?? resolveStateDir({ ...env, ULTRATHINK_HOST: host });
	let control: ControlState = options.control ?? {};
	try {
		// `/ultrathink-<verb>` (and the older `/ultrathink:<verb>` / `/ultrathink <verb>`) is a control command, never a request to plan.
		if (parseUltrathinkCommand(text)) return skip("ultrathink-command");
		const target = planningTarget(text, { cwd });
		if ("skip" in target) return skip(target.skip);
		text = target.text;
		skill = target.skill;
		control = options.control ?? readControl(stateDir);
		// A Hermes skill loaded with no task (or only an ack) is a preamble, not a request to plan. An armed
		// /ultrathink-skip must still be consumed by runPromptSubmit, as a trivial prompt consumes it on Claude.
		if (control.skipOnce !== true && host === "hermes" && skill && (!skill.instruction || isTrivial(skill.instruction)))
			return skip("skill-preamble");
	} catch {
		// fail-open: a throwing skill parser plans the prompt as written
	}
	let resolution: ModelResolution | undefined;
	try {
		const config = options.config ?? loadConfig(claudeConfigPaths(cwd, env));
		// Every uplift skip is decided here, before an engine is selected: the stateless ones (raw:, commands, uplifted XML,
		// graph hand-offs, acks), planning turned off, and an armed /ultrathink-skip, which is consumed and saved now, as the
		// Claude hook does, so a failed engine selection can never leave it armed for a later task.
		const state: UpliftState = {
			enabled: control.enabled ?? config.uplift.enabled,
			skipOnce: control.skipOnce === true,
			skipTrivial: config.uplift.skipTrivial,
		};
		const decision = decideUplift({ text, source: "user", idle: true }, state);
		if (control.skipOnce === true && !state.skipOnce) {
			control = { ...control, skipOnce: false };
			try {
				writeControl(stateDir, { skipOnce: false });
			} catch {
				// fail-open: the skip still applies to this prompt
			}
		}
		if (decision.action !== "uplift") return skip(`precheck-${decision.action}`);
		// Only eligible input reaches selection, so a skipped prompt never meets the native selector or cancellation. A
		// flight cancelled already selects nothing: no native lookup, auth or inference.
		if (options.signal?.aborted) return skip("aborted");
		const sessionId = request.session_id?.trim() || "unknown";
		const engine = await (options.selectEngine ?? selectEngine)(config, control, cwd, {
			host,
			sessionModel: request.model,
			provider: request.provider,
			sessionId: request.session_id?.trim() || undefined,
			signal: options.signal,
			native: options.native,
			purpose: "planning",
		});
		resolution = engine.resolution;
		// A selection skip (unresolved): empty context, the stable reason code, the safe notice and the record.
		if ("skipped" in engine)
			return { ...skip(engine.skipped, resolution), summary: engine.notice ?? `Prompt Uplift skipped · ${resolution.label}` };
		if (options.signal?.aborted) return skip("aborted", resolution);
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
				modelResolution: resolution,
				stateDir,
				surface: host,
				conversation: recentConversationFromTranscript,
				brief: (input) => fetchBrief(input, env, config.substrate.url),
				// On Hermes the kickoff skill creates rows through `track complete`, so an abandoned or killed hook never leaves orphan rows.
				track:
					host !== "hermes" && trackingEnabled(config, control, env)
						? (options.createTracker ?? createGatewayTracker)(config)
						: undefined,
				trackingOff: trackingOff(config, control),
				trackCommand: trackCommand(),
				progress: options.progress,
				// The plan gate itself runs in runPromptSubmit (AD-P1); the host's env holds its key and URL override.
				decisionsDeps: { env },
				...(options.recall ? { recall: options.recall } : {}),
				...(options.ground ? { ground: options.ground } : {}),
				signal: options.signal,
			},
		);
		// A flight cancelled once its plan was built delivers nothing: no carrier, no context.
		if (options.signal?.aborted) return skip("aborted", resolution);
		if (result.skipped || !result.output) return { ...skip(result.skipped), ...(result.notice ? { summary: result.notice } : {}) };
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
			modelResolution: resolution,
			...(result.record ? { view: buildPlanView(result.record, Date.now() - started) } : {}),
		};
	} catch {
		// Cancellation is caught here, at the fail-open host boundary, with the safe record once selection produced one.
		if (options.signal?.aborted) return skip("aborted", resolution);
		return skip("engine-error");
	}
}
