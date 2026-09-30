// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio

/**
 * Teachable Moment schema (per n5 Graph of Thought conclusion from UPLIFTED_PROMPT).
 *
 * Module: src/teachable-moments/schema.ts
 * Refs: SPE-5104 + subissues.
 *
 * Schema fields (exact from n5):
 * - id
 * - name (teachable e.g. "Claude-Ultrathink has 2 Bugs when integrating Jev")
 * - description
 * - body
 * - sourcePhase
 * - sourceArtifacts
 * - createdAt
 * - tags
 * - relatedIds
 *
 * Intended for persistence via Hindsight (use mock via createMockHindsightClient for now).
 * No hooks/wiring yet (per wave).
 *
 * A2A-DRAFT: unconfirmed spec for Agent Card mapping.
 */

// A2A-DRAFT: fields and shapes are draft; confirm against full A2A Agent Card spec when available.
export interface TeachableMoment {
	id: string;
	name: string; // teachable title, e.g. "Claude-Ultrathink has 2 Bugs when integrating Jev"
	description: string;
	body: string;
	sourcePhase: string; // e.g. "n5", "phase-3", SPE subissue id
	sourceArtifacts: string[]; // e.g. ["issues/xxx.md", "src/foo.ts", "SPE-5104"]
	createdAt: string; // ISO 8601 UTC
	tags: string[];
	relatedIds: string[];
}

// A2A-DRAFT
export type TeachableMomentType = TeachableMoment;

/**
 * Input for creation (id/createdAt generated if absent).
 */
export interface TeachableMomentInput {
	name: string;
	description: string;
	body: string;
	sourcePhase: string;
	sourceArtifacts?: string[];
	tags?: string[];
	relatedIds?: string[];
}

/**
 * Normalize partial input into a full TeachableMoment.
 * Generates id (uuid or timestamp fallback) and createdAt if missing.
 * Trims strings, defaults arrays.
 *
 * A2A-DRAFT: normalization rules may evolve.
 */
export function normalizeTeachableMoment(
	input: Partial<TeachableMomentInput> & { id?: string; createdAt?: string },
): TeachableMoment {
	const now = new Date().toISOString();
	const id =
		input.id ??
		(globalThis.crypto?.randomUUID?.() ??
			`tm_${Date.now()}_${Math.random().toString(36).slice(2)}`);

	return {
		id,
		name: (input.name ?? "Untitled Teachable Moment").trim(),
		description: (input.description ?? "").trim(),
		body: (input.body ?? "").trim(),
		sourcePhase: (input.sourcePhase ?? "unknown").trim(),
		sourceArtifacts: Array.isArray(input.sourceArtifacts)
			? input.sourceArtifacts.filter(Boolean).map((s) => String(s).trim())
			: [],
		createdAt: input.createdAt ?? now,
		tags: Array.isArray(input.tags)
			? input.tags.filter(Boolean).map((t) => String(t).trim())
			: [],
		relatedIds: Array.isArray(input.relatedIds)
			? input.relatedIds.filter(Boolean).map((r) => String(r).trim())
			: [],
	};
}

// For Hindsight content payload (see hindsight-client.ts usage in smoke tests).
// A2A-DRAFT
export interface TeachableHindsightContent {
	type: "teachable";
	moment: TeachableMoment;
}
