#!/usr/bin/env bun
// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Claude Code UserPromptSubmit hook entry (and `--ctl` control CLI).
 *
 * stdin: hook JSON from Claude Code. stdout: hook JSON with additionalContext, or a
 * block decision answering an `/ultrathink-<verb>` command (src/uplift/commands.ts).
 * Always exits 0 so the user's prompt is never blocked by a plugin failure.
 */
import { claudeConfigPaths, loadConfig } from "../src/config.ts";
import { isChildInvocation } from "../src/claude/complete.ts";
import { runPromptSubmit, type PromptSubmitInput } from "../src/claude/hook.ts";
import { defaultStateDir, readControl, sessionPath } from "../src/claude/state.ts";
import { recentConversationFromTranscript } from "../src/claude/transcript.ts";
import { parseUltrathinkCommand, runControl, trackingEnabled, trackingOff } from "../src/uplift/commands.ts";
import { planningTarget } from "../src/uplift/skill.ts";
import { writePlanCarrier } from "../src/host/carrier.ts";
import { claimTurn } from "../src/host/claim.ts";
import { detectHost } from "../src/host/detect.ts";
import { selectEngine } from "../src/host/engine.ts";
import { createGatewayTracker, trackCommand } from "../src/track/gateway.ts";
import { isSubagentEnvelope, parseEnvelope } from "../src/host/envelope.ts";

function log(message: string): void {
	if (process.env.ULTRATHINK_DEBUG === "1") process.stderr.write(`[ultrathink] ${message}\n`);
}

async function readStdin(): Promise<string> {
	try {
		return await new Response(Bun.stdin.stream()).text();
	} catch {
		return "";
	}
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	if (argv[0] === "--ctl") {
		process.stdout.write(`${await runControl(argv.slice(1), { stateDir: defaultStateDir(), cwd: process.cwd() })}\n`);
		return;
	}
	if (isChildInvocation()) return;
	if (process.env.ULTRATHINK_UPLIFT === "0") {
		log("skipped: ULTRATHINK_UPLIFT=0");
		return;
	}

	const envelope = parseEnvelope(await readStdin());
	const raw = envelope as PromptSubmitInput;
	if (raw.hook_event_name && raw.hook_event_name !== "UserPromptSubmit") return;
	// Grok runs UserPromptSubmit inside subagents too; only the main session plans and tracks.
	if (isSubagentEnvelope(envelope)) {
		log("skipped: subagent");
		return;
	}
	const cwd = raw.cwd?.trim() || process.cwd();
	// `/ultrathink-<verb>` runs before planning. quick: the host's command template delivers
	// the message, so plan nothing. Other verbs: answer with a block so no model turn runs.
	const command = parseUltrathinkCommand(raw.prompt ?? "");
	if (command?.verb === "quick") {
		log("skipped: quick");
		return;
	}
	if (command) {
		const reason = await runControl([command.verb, ...command.args.split(/\s+/).filter(Boolean)], { stateDir: defaultStateDir(), cwd });
		process.stdout.write(JSON.stringify({ decision: "block", reason }));
		return;
	}
	let input = raw;
	try {
		const target = planningTarget(raw.prompt ?? "", { cwd });
		// Yield before engine select: built-in slash commands and ultrathink's own skills
		// must not wait on the engine.
		if ("skip" in target) {
			log(`skipped: ${target.skip}`);
			return;
		}
		if (target.skill) input = { ...raw, prompt: target.text, skill: target.skill };
	} catch {
		// fail-open: a throwing skill parser plans the prompt as written
	}
	const host = detectHost();
	const stateDir = defaultStateDir();
	// Grok may dispatch this hook twice per turn (global hook file plus plugin hooks); only the first plans.
	const promptId = envelope.prompt_id ?? envelope.promptId;
	const turnSessionId = typeof raw.session_id === "string" ? raw.session_id.trim() : "";
	if (host === "grok-build" && typeof promptId === "string" && promptId.trim() && turnSessionId) {
		if (!claimTurn(stateDir, `${turnSessionId}:${promptId.trim()}`)) {
			log("skipped: duplicate hook for this turn");
			return;
		}
	}
	const config = loadConfig(claudeConfigPaths(cwd));
	const state = readControl(stateDir);
	const engine = await selectEngine(config, state, cwd);
	if ("skipped" in engine) {
		log("skipped: grok engine selected but not logged in (fallbackToClaude=false)");
		// A skill invocation must never receive a login-required systemMessage that eats the command.
		if (!input.skill) process.stdout.write(JSON.stringify({ systemMessage: engine.skipped }));
		return;
	}

	const result = await runPromptSubmit(input, {
		config,
		control: state,
		complete: engine.complete,
		engine: engine.label,
		engineError: engine.error,
		stateDir,
		surface: host,
		conversation: recentConversationFromTranscript,
		log,
		track: trackingEnabled(config, state) ? createGatewayTracker(config) : undefined,
		trackingOff: trackingOff(config, state),
		trackCommand: trackCommand(),
	});
	if (result.skipped) log(`skipped: ${result.skipped}`);
	if (result.output) {
		// Claude reads stdout first, so a carrier failure can never cost it the plan.
		// Grok discards stdout; last-plan.json is the carrier there.
		process.stdout.write(JSON.stringify(result.output));
		const sessionId = input.session_id?.trim() || "";
		try {
			writePlanCarrier({
				host,
				stateDir,
				sessionId,
				specPath: sessionId ? sessionPath(stateDir, sessionId).replace(/\.json$/, ".xml") : undefined,
				statePath: sessionId ? sessionPath(stateDir, sessionId) : undefined,
				graphId: result.record?.plan?.graphId,
				context: result.output.hookSpecificOutput.additionalContext,
			});
		} catch (error) {
			log(`carrier write failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}

// Exit explicitly once stdout drains: a lingering handle (in-flight upstream request)
// must not keep the hook alive past the tracker budget.
main()
	.catch((error) => {
		log(`fatal: ${error instanceof Error ? error.message : String(error)}`);
	})
	.finally(() => process.stdout.write("", () => process.exit(0)));
