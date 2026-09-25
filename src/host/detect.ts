// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Which host spawned this process.
 *
 * Ambient home directories are not evidence: this machine has Claude, Grok,
 * Hermes, Muse, and Omp installed at once. A Claude hook must not become
 * Hermes just because `HERMES_HOME` is exported. Grok sets both `GROK_*` and
 * `CLAUDE_*` aliases, so the Grok markers win when both are present. Muse gives
 * every tool child `MUSE_TOOL_USE_ID` and its plugin processes `MUSE_PLUGIN_ID`
 * (next to `CLAUDE_PLUGIN_ROOT`), so `bin/ultrathink` run from Muse's shell is Muse.
 */
import { isHostId, type HostId } from "./types.ts";

export function detectHost(env: Record<string, string | undefined> = process.env): HostId {
	const forced = env.ULTRATHINK_HOST?.trim();
	if (forced && isHostId(forced)) return forced;
	if (env.GROK_PLUGIN_ROOT?.trim() || env.GROK_HOOK_EVENT?.trim() || env.GROK_SESSION_ID?.trim()) {
		return "grok-build";
	}
	if (env.MUSE_TOOL_USE_ID?.trim() || env.MUSE_PLUGIN_ID?.trim()) return "muse";
	return "claude-code";
}
