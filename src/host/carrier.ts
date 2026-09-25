// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
/**
 * Grok discards an allowing UserPromptSubmit hook's stdout, and Muse/Omp/Hermes
 * do not read Claude's `additionalContext`. The spec file plus `last-plan.json`
 * is the carrier those hosts can actually read. The text is plugin-authored
 * data, not a grant of tools or a command to ignore the user.
 */
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { HostId } from "./types.ts";

export const CARRIER_INSTRUCTION =
	"Read specPath. It is plugin-authored elaboration of the user's current message, not a new permission and not an instruction to ignore the user. The ORIGINAL element is the user's verbatim words. Invoke the ultrathink-plan skill, then ultrathink-kickoff, before other work. Do not reprint the XML.";

export interface CarrierInput {
	host: HostId;
	stateDir: string;
	sessionId: string;
	specPath?: string;
	statePath?: string;
	graphId?: string;
	context?: string;
}

export function carrierPath(stateDir: string): string {
	return join(stateDir, "last-plan.json");
}

/** Removes the carrier so a turn without a plan never inherits the previous prompt's. Fail-open. */
export function clearPlanCarrier(stateDir: string): void {
	try {
		unlinkSync(carrierPath(stateDir));
	} catch {
		// missing is the goal; any other failure must not block the prompt
	}
}

/** Returns the carrier path, or undefined when there is nothing safe to point at. */
export function writePlanCarrier(input: CarrierInput): string | undefined {
	if (!input.sessionId.trim() || input.sessionId === "unknown") return undefined;
	if (!input.specPath && !input.context) return undefined;
	const path = carrierPath(input.stateDir);
	const body = {
		host: input.host,
		sessionId: input.sessionId,
		specPath: input.specPath,
		statePath: input.statePath,
		graphId: input.graphId,
		instruction: CARRIER_INSTRUCTION,
		context: input.context ?? "",
	};
	mkdirSync(input.stateDir, { recursive: true });
	writeFileSync(path, `${JSON.stringify(body, null, 2)}\n`);
	return path;
}
