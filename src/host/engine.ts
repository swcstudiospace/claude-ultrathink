// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Completer selection shared by every host entry. Claude is the default.
 * Grok is opt-in and fails visibly when its login is missing, unless
 * `fallbackToClaude` is set. The shunt transport does not need `grok login`.
 */
import { grokAuthStatusFresh, redactSecrets } from "../grok/auth.ts";
import { createGrokCompleter } from "../grok/complete.ts";
import { grokEngineLabel } from "../grok/label.ts";
import { type ClaudeCompleter, createClaudeCompleter } from "../claude/complete.ts";
import type { UltrathinkConfig } from "../config.ts";
import type { ControlState } from "../claude/state.ts";

export interface SelectedEngine {
	label: string;
	complete: ClaudeCompleter;
	error: () => string | undefined;
}

export const GROK_LOGIN_REQUIRED = "Prompt Uplift skipped · Grok 4.7 login required (run `grok login`)";

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

export async function selectEngine(
	config: UltrathinkConfig,
	state: ControlState,
	cwd: string,
): Promise<SelectedEngine | { skipped: string }> {
	const engine = state.engine ?? config.think.engine;
	if (engine !== "grok" || !config.grok.enabled) return claudeEngine(config, cwd);
	if (config.grok.transport !== "shunt") {
		const auth = await grokAuthStatusFresh({ home: config.grok.home || undefined, bin: config.grok.bin });
		if (!auth.loggedIn || auth.expired) {
			if (config.grok.fallbackToClaude) return claudeEngine(config, cwd, " (grok fallback)");
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

export function engineLabel(config: UltrathinkConfig, state: ControlState): string {
	const engine = state.engine ?? config.think.engine;
	return engine === "grok" && config.grok.enabled ? grokEngineLabel(config.grok) : `claude:${config.claude.model || "session default"}`;
}
