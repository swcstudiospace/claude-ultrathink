// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Completer selection shared by every host entry. `think.engine: auto` (the
 * default) inherits the host's engine; an explicit engine always wins. Grok
 * fails visibly when its login is missing and was explicitly chosen, unless
 * `fallbackToClaude` is set; a host-default grok without a login falls back
 * to Muse instead. The shunt transport does not need `grok login`.
 */
import { grokAuthStatusFresh, redactSecrets } from "../grok/auth.ts";
import { createGrokCompleter } from "../grok/complete.ts";
import { grokEngineLabel } from "../grok/label.ts";
import { type ClaudeCompleter, createClaudeCompleter } from "../claude/complete.ts";
import { createMuseCompleter } from "../muse/complete.ts";
import type { UltrathinkConfig } from "../config.ts";
import type { ControlState } from "../claude/state.ts";
import { detectHost } from "./detect.ts";
import type { HostId } from "./types.ts";

export interface SelectedEngine {
	label: string;
	complete: ClaudeCompleter;
	error: () => string | undefined;
}

export const GROK_LOGIN_REQUIRED = "Prompt Uplift skipped · Grok 4.7 login required (run `grok login`)";

/** Engine inherited per host when `think.engine` is `auto` (hermes/omp keep today's Muse default). */
export const HOST_DEFAULT_ENGINES: Record<HostId, "claude" | "grok" | "muse"> = {
	"claude-code": "claude",
	"grok-build": "grok",
	hermes: "claude",
	muse: "muse",
	omp: "claude",
};

function captureFirstError(label: string, complete: ClaudeCompleter): SelectedEngine {
	let first: string | undefined;
	return {
		label,
		complete: async (system, user, signal) => {
			try {
				return await complete(system, user, signal);
			} catch (error) {
				first ??= redactSecrets(error instanceof Error ? error.message : String(error));
				throw error;
			}
		},
		error: () => first,
	};
}

function claudeEngine(config: UltrathinkConfig, cwd: string, suffix = ""): SelectedEngine {
	return captureFirstError(
		`claude:${config.claude.model || "session default"}${suffix}`,
		createClaudeCompleter({
			bin: config.claude.bin,
			model: config.claude.model || undefined,
			settingSources: config.claude.settingSources,
			thinking: config.claude.thinking,
			cwd,
			timeoutMs: config.claude.callTimeoutMs,
		}),
	);
}

function museEngine(config: UltrathinkConfig, cwd: string, suffix = ""): SelectedEngine {
	return captureFirstError(
		`muse:${config.muse.model || "session default"}${suffix}`,
		createMuseCompleter({
			bin: config.muse.bin,
			model: config.muse.model || undefined,
			reasoningEffort: config.muse.reasoningEffort,
			cwd,
			timeoutMs: config.muse.callTimeoutMs,
		}),
	);
}

export async function selectEngine(
	config: UltrathinkConfig,
	state: ControlState,
	cwd: string,
	host?: HostId,
): Promise<SelectedEngine | { skipped: string }> {
	const requested = state.engine ?? config.think.engine;
	const engine = requested === "auto" ? HOST_DEFAULT_ENGINES[host ?? detectHost()] : requested;
	if (engine === "muse") return museEngine(config, cwd);
	if (engine !== "grok" || !config.grok.enabled) return claudeEngine(config, cwd);
	if (config.grok.transport !== "shunt") {
		const auth = await grokAuthStatusFresh({ home: config.grok.home || undefined, bin: config.grok.bin });
		if (!auth.loggedIn || auth.expired) {
			if (config.grok.fallbackToClaude) return claudeEngine(config, cwd, " (grok fallback)");
			if (requested === "auto") return claudeEngine(config, cwd, " (grok unavailable)");
			return { skipped: GROK_LOGIN_REQUIRED };
		}
	}
	return captureFirstError(
		grokEngineLabel(config.grok),
		createGrokCompleter({
			baseUrl: config.grok.baseUrl,
			model: config.grok.model,
			reasoningEffort: config.grok.reasoningEffort,
			timeoutMs: config.grok.callTimeoutMs,
			home: config.grok.home || undefined,
			transport: config.grok.transport,
			bin: config.grok.bin,
			cwd,
			shuntBaseUrl: config.grok.shuntBaseUrl,
			shuntModel: config.grok.shuntModel,
			shuntMaxTokens: config.grok.shuntMaxTokens,
		}),
	);
}

export function engineLabel(config: UltrathinkConfig, state: ControlState, host?: HostId): string {
	const requested = state.engine ?? config.think.engine;
	const engine = requested === "auto" ? HOST_DEFAULT_ENGINES[host ?? detectHost()] : requested;
	if (engine === "muse") return `muse:${config.muse.model || "session default"}`;
	return engine === "grok" && config.grok.enabled ? grokEngineLabel(config.grok) : `claude:${config.claude.model || "session default"}`;
}
