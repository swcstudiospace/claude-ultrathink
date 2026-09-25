// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * `/ultrathink-<verb>` commands, shared by every host: parsing, the tracking gates,
 * and the control actions behind the hooks, `bin/ultrathink`, and `hooks/uplift.ts --ctl`.
 * Control state lives in the host state dir, so each host toggles independently.
 */
import { claudeConfigPaths, loadConfig, type UltrathinkConfig } from "../config.ts";
import { type ControlState, readControl, readLast, writeControl } from "../claude/state.ts";
import { grokAuthStatusFresh, redactSecrets } from "../grok/auth.ts";
import { formatHitlEcho } from "../hitl/format.ts";
import { engineLabel } from "../host/engine.ts";
import { resolveStateDir } from "../host/paths.ts";
import { graphSketch } from "../think/graph.ts";
import { grokUserQuery, parseSlashCommand } from "./skill.ts";

export type UltrathinkVerb = "quick" | "skip" | "off" | "on" | "track" | "status";

export const ULTRATHINK_VERBS: readonly UltrathinkVerb[] = ["quick", "skip", "off", "on", "track", "status"];

export interface UltrathinkCommand {
	verb: UltrathinkVerb;
	args: string;
}

const USAGE = [
	"Usage: ultrathink <command>",
	"  status                 planning, tracking and engine state",
	"  off | on               planning off/on for this host until changed",
	"  skip                   do not plan the next message",
	"  track off|on|status    keep planning; stop/start creating Linear/Notion rows",
	"  last                   the last uplifted spec",
	"  think on|off|last      Graph of Thought",
	"  hitl on|off|last       HITL clarifications",
	"  grok [engine grok|claude]",
	"In an agent: /ultrathink-status, /ultrathink-off, /ultrathink-on, /ultrathink-skip, /ultrathink-track off|on,",
	"and /ultrathink-quick <message> sends one message as typed (no planning, no Linear/Notion rows).",
].join("\n");

/** `ultrathink-quick`, Claude's plugin-qualified `ultrathink:ultrathink-quick`, and the older `ultrathink:quick`. */
const VERB_NAME_RE = /^ultrathink(?::ultrathink-|[:-])(.+)$/;

/**
 * "/ultrathink-quick fix the typo", "/ultrathink-track off", Claude's plugin-qualified
 * "/ultrathink:ultrathink-quick …" and its expansion
 * "<command-name>/ultrathink:ultrathink-quick</command-name>…<command-args>fix the typo</command-args>",
 * plus the older "/ultrathink:quick …" and "/ultrathink quick …", also inside Grok's `<user_query>`
 * wrapper. Case-insensitive, args trimmed; undefined for anything else, including unknown verbs.
 */
export function parseUltrathinkCommand(text: string): UltrathinkCommand | undefined {
	const command = parseSlashCommand(grokUserQuery(text) ?? text);
	if (!command) return undefined;
	const name = command.name.toLowerCase();
	const named = VERB_NAME_RE.exec(name);
	let verb = named?.[1];
	let args = command.args ?? "";
	if (!named) {
		if (name !== "ultrathink") return undefined;
		const split = /^(\S+)([\s\S]*)$/.exec(args);
		verb = split?.[1]?.toLowerCase();
		args = split?.[2] ?? "";
	}
	const known = ULTRATHINK_VERBS.find((candidate) => candidate === verb);
	return known ? { verb: known, args: args.trim() } : undefined;
}

/** The planner's own tracker: the control toggle beats config; `ULTRATHINK_TRACK=0` beats both. */
export function trackingEnabled(
	config: UltrathinkConfig,
	control: ControlState,
	env: Record<string, string | undefined> = process.env,
): boolean {
	return (control.trackEnabled ?? config.track.enabled) && env.ULTRATHINK_TRACK !== "0";
}

/** Rows are not wanted at all: tracking turned off, or neither Notion nor Linear configured. Kickoff must not create them either. */
export function trackingOff(config: UltrathinkConfig, control: ControlState): boolean {
	return control.trackEnabled === false || (!config.notion.dataSourceUrl.trim() && !config.linear.team.trim());
}

function flag(value: boolean | undefined, fallback: boolean): string {
	return (value ?? fallback) ? "on" : "off";
}

/** `off` only when no rows are wanted; `kickoff` when config or ULTRATHINK_TRACK=0 stops just the planner's own tracker. */
function trackingLines(config: UltrathinkConfig, state: ControlState): string[] {
	let line = "Tracking: on (Linear/Notion rows)";
	if (state.trackEnabled === false) line = "Tracking: off (Linear/Notion rows)";
	else if (trackingOff(config, state)) line = "Tracking: on (not configured: set notion.dataSourceUrl / linear.team)";
	else if (!trackingEnabled(config, state)) line = "Tracking: kickoff (planner-side row creation off; /ultrathink-track off stops all rows)";
	return [
		line,
		`Notion: ${config.notion.dataSourceUrl.trim() || "not configured"}`,
		`Linear team: ${config.linear.team.trim() || "not configured"}`,
	];
}

/** `Grok: <model> @ <effort> · transport <t>` plus the gateway URL when shunt is active. */
function grokTransportLine(config: UltrathinkConfig): string {
	const { grok } = config;
	const base = `Grok: ${grok.model} @ ${grok.reasoningEffort} · transport ${grok.transport}`;
	return grok.transport === "shunt" ? `${base} · ${grok.shuntBaseUrl}/v1/messages · wire model ${grok.shuntModel} · max_tokens ${grok.shuntMaxTokens}` : base;
}

async function grokOauthLine(config: UltrathinkConfig): Promise<string> {
	if (config.grok.transport === "shunt") return "SuperGrok OAuth: not used (shunt gateway owns upstream auth)";
	const auth = await grokAuthStatusFresh({ home: config.grok.home || undefined, bin: config.grok.bin });
	if (!auth.loggedIn) return "SuperGrok OAuth: not logged in (run grok login)";
	if (auth.expired) return "SuperGrok OAuth: expired (run grok login)";
	return `SuperGrok OAuth: ${auth.email ?? "logged in"}${auth.expiresAt ? ` · expires ${auth.expiresAt}` : ""}`;
}

async function statusText(config: UltrathinkConfig, state: ControlState, stateDir: string): Promise<string> {
	const last = readLast(stateDir);
	const lines = [
		`Prompt Uplift ${flag(state.enabled, config.uplift.enabled)}${state.skipOnce ? " (skipping next prompt)" : ""}`,
		`Engine: ${engineLabel(config, state)}`,
		grokTransportLine(config),
		await grokOauthLine(config),
		`Graph of Thought ${flag(state.thinkEnabled, config.think.enabled)}`,
		`HITL clarifications ${flag(state.hitlEnabled, config.hitl.enabled)} · max ${config.hitl.maxQuestions}`,
		...trackingLines(config, state),
		`Model: ${config.claude.model || "session default"} · concurrency ${config.claude.concurrency}`,
		`State: ${stateDir}`,
	];
	if (last) lines.push(`Last: ${last.result.root} · ${last.result.source}${last.graph ? ` · ${last.graph.nodes.length} nodes` : ""}`);
	return lines.join("\n");
}

/**
 * Runs skip|off|on|track on|track off|status plus the legacy --ctl scopes
 * (think/hitl/grok/last) against stateDir and returns the user-facing text.
 * Never throws: an error becomes a message.
 */
export async function runControl(args: string[], input: { stateDir: string; cwd: string }): Promise<string> {
	try {
		const { stateDir, cwd } = input;
		const [command = "status", verb = "status", value] = args.map((arg) => arg.trim().toLowerCase()).filter(Boolean);
		const config = loadConfig(claudeConfigPaths(cwd));
		const state = readControl(stateDir);
		switch (command) {
			case "status":
				return await statusText(config, state, stateDir);
			case "on":
			case "off":
				writeControl(stateDir, { enabled: command === "on" });
				return `Prompt Uplift ${command}`;
			case "skip":
				writeControl(stateDir, { skipOnce: true });
				return "Prompt Uplift will skip the next prompt";
			case "last": {
				const last = readLast(stateDir);
				return last ? `${last.result.root} · ${last.result.source}\n\n${last.result.xml}` : "No uplift recorded yet";
			}
			case "track":
				switch (verb) {
					case "on":
					case "off":
						return trackingLines(config, writeControl(stateDir, { trackEnabled: verb === "on" })).join("\n");
					case "status":
						return trackingLines(config, state).join("\n");
					default:
						return "Usage: track on|off|status";
				}
			case "think":
				switch (verb) {
					case "on":
					case "off":
						writeControl(stateDir, { thinkEnabled: verb === "on" });
						return `Graph of Thought ${verb}`;
					case "last": {
						const last = readLast(stateDir);
						return last?.graph ? `${last.graph.goal}\n\n${graphSketch(last.graph)}` : "No thought graph recorded yet";
					}
					case "status":
						return `Graph of Thought ${flag(state.thinkEnabled, config.think.enabled)}`;
					default:
						return "Usage: think on|off|last|status";
				}
			case "hitl":
				switch (verb) {
					case "on":
					case "off":
						writeControl(stateDir, { hitlEnabled: verb === "on" });
						return `HITL clarifications ${verb}`;
					case "last":
						return formatHitlEcho(readLast(stateDir)?.clarifications ?? []);
					case "status":
						return `HITL clarifications ${flag(state.hitlEnabled, config.hitl.enabled)} · max ${config.hitl.maxQuestions}`;
					default:
						return "Usage: hitl on|off|last|status";
				}
			case "grok":
				switch (verb) {
					case "engine": {
						if (value !== "grok" && value !== "claude") return "Usage: grok engine grok|claude";
						writeControl(stateDir, { engine: value });
						return `Thinking engine set to ${engineLabel(config, { ...state, engine: value })}`;
					}
					case "status":
						return [`Engine: ${engineLabel(config, state)}`, grokTransportLine(config), await grokOauthLine(config)].join("\n");
					default:
						return "Usage: grok [status | engine grok|claude]";
				}
			default:
				return USAGE;
		}
	} catch (error) {
		return `ultrathink: ${redactSecrets(error instanceof Error ? error.message : String(error))}`;
	}
}

// `bin/ultrathink <verb> [args…]`: the host state dir comes from ULTRATHINK_HOST, else the detected host.
if (import.meta.main) {
	runControl(process.argv.slice(2), { stateDir: resolveStateDir(), cwd: process.cwd() }).then((text) => {
		process.stdout.write(`${text}\n`, () => process.exit(0));
	});
}
