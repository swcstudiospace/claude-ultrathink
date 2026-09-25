// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import type { ShipConfig } from "./types.ts";

/** Whether the ship flow runs after `skillName` finishes. */
export function shipApplies(
	config: ShipConfig,
	skillName: string | undefined,
	env: Record<string, string | undefined> = process.env,
): boolean {
	if (!config.enabled || env.ULTRATHINK_SHIP === "0") return false;
	if (config.skills.length === 0) return true;
	return !!skillName && config.skills.some((prefix) => skillName.startsWith(prefix));
}
