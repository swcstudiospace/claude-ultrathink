// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Stop-hook decision: block the stop once per session and ask the agent to run
 * ultrathink-ship when a matching GSD skill run left committed work on a branch.
 */
import { join } from "node:path";
import type { SessionRecord } from "../claude/state.ts";
import { shipApplies } from "./policy.ts";
import { shellArg } from "../track/gateway.ts";
import type { ShipConfig } from "./types.ts";

/** Absolute path of the ship CLI; agents run it from the user's project, not the plugin repo. */
export const SHIP_CLI = join(import.meta.dir, "..", "..", "bin", "ultrathink-ship");

export interface ShipNudge {
	decision: "block";
	reason: string;
	systemMessage: string;
}

export function shipNudge(input: {
	record: SessionRecord;
	config: ShipConfig;
	precheck: { ok: boolean; branch?: string; base?: string; ahead: number };
	statePath: string;
	stopHookActive?: boolean;
	env?: Record<string, string | undefined>;
}): ShipNudge | undefined {
	const { record, precheck } = input;
	if (input.stopHookActive || !record.plan) return undefined;
	const skill = record.skill?.name;
	if (!skill || !shipApplies(input.config, skill, input.env ?? process.env)) return undefined;
	const ship = record.ship;
	if (ship?.phase === "merged" || ship?.phase === "blocked" || ship?.nudgedAt !== undefined) return undefined;
	if (!precheck.ok || !precheck.branch || !precheck.base) return undefined;
	const autoMerge = input.config.autoMerge;
	const merge = autoMerge ? "merges" : "leaves the PR for a manual merge (ship.autoMerge is off)";
	return {
		decision: "block",
		reason: `Ultrathink: the ${skill} run looks finished on branch ${precheck.branch} (${precheck.ahead} ${precheck.ahead === 1 ? "commit" : "commits"} ahead of ${precheck.base}). Invoke the ultrathink-ship skill now with stateFile=${input.statePath} (CLI: ${shellArg(SHIP_CLI)}): it checks whether the task is done, opens a PR into ${precheck.base}, runs the Greptile review until 5/5 and ${merge}.`,
		systemMessage: `Ultrathink · ${skill} finished on ${precheck.branch}; running ultrathink-ship (PR into ${precheck.base}, Greptile review, ${autoMerge ? "merge" : "manual merge"}).`,
	};
}
