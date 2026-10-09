// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * The one-line Teachable Moments status shown in the ultrathink status line, plus the read-only counts it and
 * `teach status` share. Only counts and mode words: never a key, a lesson body or prompt text. Counting is a local
 * file read and never creates the store, so asking for the status of a feature that is off leaves no trace.
 */
import { existsSync } from "node:fs";
import type { GatewayConfig } from "../gateway/types.ts";
import { resolveHindsight } from "../hindsight/settings.ts";
import type { HindsightConfig, HindsightReadiness } from "../hindsight/types.ts";
import { openStore, storeDir } from "./store.ts";
import { MOMENT_STATUSES, TEACH_KILL_ENV } from "./types.ts";
import type { MomentStatus, TeachConfig } from "./types.ts";

export interface MomentCounts {
	moments: Record<MomentStatus, number>;
	/** Pending Hindsight writes. */
	outbox: number;
}

/** Counts per status and the outbox size from `<stateDir>/teach`; zeros when the store does not exist or cannot be read. */
export function momentCounts(stateDir: string): MomentCounts {
	const moments = Object.fromEntries(MOMENT_STATUSES.map((status) => [status, 0])) as Record<MomentStatus, number>;
	const dir = storeDir(stateDir);
	if (!existsSync(dir)) return { moments, outbox: 0 };
	try {
		const store = openStore(dir);
		for (const moment of store.list()) moments[moment.status] += 1;
		return { moments, outbox: store.outbox().length };
	} catch {
		return { moments, outbox: 0 };
	}
}

export function hindsightReadiness(
	config: HindsightConfig,
	env: NodeJS.ProcessEnv,
	storePath?: string,
	gateway?: GatewayConfig,
): HindsightReadiness {
	return resolveHindsight(config, env, storePath === undefined ? { gateway } : { storePath, gateway }).readiness;
}

function hindsightWord(readiness: HindsightReadiness): string {
	if (readiness.state !== "unready") return readiness.state;
	const words = { "no-url": "no URL", "bad-url": "bad URL", "no-key": "no key", "no-token": "no token" } as const;
	return words[readiness.reason];
}

/** `Teach: off (...)` or `Teach: on · capture <mode> · recall on|off[ · <n> confirmed, <m> candidate][ · Hindsight <state> · outbox <k>]`. Counts need `stateDir`. */
export function teachStatusLine(
	config: { teach: TeachConfig; hindsight: HindsightConfig; gateway?: GatewayConfig },
	env: NodeJS.ProcessEnv,
	storePath?: string,
	stateDir?: string,
): string {
	if (!config.teach.enabled) return "Teach: off (opt-in: set teach.enabled)";
	if (env[TEACH_KILL_ENV] === "0") return `Teach: off (${TEACH_KILL_ENV}=0)`;
	const parts = [
		"Teach: on",
		`capture ${config.teach.capture}`,
		`recall ${config.teach.recall ? "on" : "off"}`,
	];
	let outbox: number | undefined;
	if (stateDir !== undefined) {
		const counts = momentCounts(stateDir);
		parts.push(`${counts.moments.confirmed} confirmed, ${counts.moments.candidate} candidate`);
		outbox = counts.outbox;
	}
	parts.push(`Hindsight ${hindsightWord(hindsightReadiness(config.hindsight, env, storePath, config.gateway))}`);
	if (outbox !== undefined) parts.push(`outbox ${outbox}`);
	return parts.join(" · ");
}
