// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

/**
 * A2A Agent Card mapping for Teachable Moments.
 *
 * Module: src/teach/agent-card.ts
 * Per n5: wrap TeachableMoment as skills[] entry {id, name, description: body, tags}
 * + top-level card for the authoring agent.
 *
 * Refs: SPE-5104
 *
 * A2A-DRAFT: This is an unconfirmed draft mapping. The A2A Agent Card
 * specification (protocol, top-level shape, required vs optional fields,
 * skills vs other sections, versioning) is not finalized.
 * Do not assume stability. Flag all A2A-DRAFT usages.
 *
 * Used by `teach export --a2a`; nothing sends the card anywhere.
 */

import type { TeachableMoment } from "./types.ts";

// A2A-DRAFT: provisional top-level Agent Card shape.
export interface A2AAgentCard {
	// A2A-DRAFT: core identity
	id: string;
	name: string; // authoring agent name, e.g. "claude-ultrathink" or "omp"
	version?: string; // A2A-DRAFT
	// A2A-DRAFT
	description?: string;

	// A2A-DRAFT: skills derived from teachable moments
	skills?: Array<{
		id: string;
		name: string;
		description: string; // mapped from TeachableMoment.body
		tags: string[];
		// A2A-DRAFT: possible future: sourcePhase, relatedIds, etc. not yet included
	}>;

	// A2A-DRAFT: other sections (examples only; unconfirmed)
	metadata?: Record<string, unknown>;
	// A2A-DRAFT
	capabilities?: string[];
}

/**
 * Convert a single TeachableMoment into an A2A Agent Card.
 * The moment becomes the (only) entry in skills[].
 * Top-level card represents the authoring agent.
 *
 * A2A-DRAFT: mapping strategy and field projections are draft.
 * Default authoring agent id/name used when not supplied.
 */
export function toAgentCard(
	tm: TeachableMoment,
	authoringAgent: { id?: string; name?: string } = {},
): A2AAgentCard {
	const agentId = authoringAgent.id ?? "claude-ultrathink"; // A2A-DRAFT default
	const agentName = authoringAgent.name ?? "claude-ultrathink";

	return {
		id: agentId,
		name: agentName,
		// A2A-DRAFT: version may be derived from sourcePhase or git later
		version: "0.1.0-draft",
		description: `Teachable moments captured by ${agentName}. A2A-DRAFT mapping.`,

		skills: [
			{
				id: tm.id,
				name: tm.name,
				description: tm.body, // per n5 explicit mapping: description: body
				tags: tm.tags.length > 0 ? tm.tags : ["teachable", "a2a-draft"],
				// A2A-DRAFT: do not yet project sourcePhase/sourceArtifacts/relatedIds/createdAt
				// until spec confirms nesting or extension fields.
			},
		],

		// A2A-DRAFT
		metadata: {
			sourcePhase: tm.sourcePhase,
			createdAt: tm.createdAt,
			relatedIds: tm.relatedIds,
			sourceArtifacts: tm.sourceArtifacts,
			// flag that this was produced under draft mapping
			_a2aDraft: true,
		},
	};
}

/**
 * Convenience: turn multiple moments into one card (union of skills).
 * A2A-DRAFT
 */
export function toAgentCardFromMoments(
	moments: TeachableMoment[],
	authoringAgent: { id?: string; name?: string } = {},
): A2AAgentCard {
	const base = toAgentCard(
		// use first or synthesize a placeholder if empty
		moments[0] ?? normalizePlaceholder(),
		authoringAgent,
	);
	if (moments.length <= 1) return base;

	return {
		...base,
		skills: moments.map((tm) => ({
			id: tm.id,
			name: tm.name,
			description: tm.body,
			tags: tm.tags.length > 0 ? tm.tags : ["teachable", "a2a-draft"],
		})),
	};
}

// internal placeholder only for empty case (A2A-DRAFT)
function normalizePlaceholder(): TeachableMoment {
	return {
		id: "placeholder",
		name: "No teachable moments",
		description: "",
		body: "",
		sourcePhase: "n/a",
		sourceArtifacts: [],
		createdAt: new Date().toISOString(),
		tags: ["a2a-draft"],
		relatedIds: [],
		schema: 2,
		kind: "pattern",
		status: "candidate",
		origin: "import",
		project: "unknown",
		host: "unknown",
		confidence: 0,
		occurrences: 1,
		lastSeenAt: new Date().toISOString(),
		dedupeKey: "",
		recalled: 0,
	};
}
