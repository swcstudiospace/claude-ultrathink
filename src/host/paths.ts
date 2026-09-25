// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * State directories are host-scoped and never land inside `.planning/`.
 * An explicit `ULTRATHINK_STATE_DIR` still wins, unless it points into a
 * planning tree — that override is how a cwd GSD write used to clobber repos.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { detectHost } from "./detect.ts";
import type { HostId } from "./types.ts";

export function isPlanningPath(dir: string): boolean {
	const norm = dir.replace(/\\/g, "/").replace(/\/+$/, "");
	return norm === ".planning" || norm.endsWith("/.planning") || norm.includes("/.planning/");
}

export function stateDirForHost(host: HostId, env: Record<string, string | undefined> = process.env): string {
	switch (host) {
		case "grok-build": {
			const data = env.GROK_PLUGIN_DATA?.trim();
			if (data) return join(data, "ultrathink");
			return join(homedir(), ".grok", "plugin-data", "ultrathink");
		}
		case "hermes": {
			const home = env.HERMES_HOME?.trim() || join(homedir(), ".hermes");
			return join(home, "ultrathink");
		}
		case "muse": {
			const config = env.XDG_CONFIG_HOME?.trim();
			const home = config ? join(config, "muse") : join(homedir(), ".config", "muse");
			return join(home, "ultrathink");
		}
		case "omp": {
			const home = env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".omp", "agent");
			return join(home, "ultrathink");
		}
		case "claude-code": {
			const home = env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");
			return join(home, "ultrathink");
		}
	}
}

export function resolveStateDir(env: Record<string, string | undefined> = process.env): string {
	const host = detectHost(env);
	const fallback = stateDirForHost(host, env);
	const override = env.ULTRATHINK_STATE_DIR?.trim();
	if (!override) return fallback;
	if (isPlanningPath(override)) return fallback;
	return override;
}
