// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import { toAgentCard, toAgentCardFromMoments } from "./agent-card.ts";
import type { TeachableMoment } from "./types.ts";

function moment(id: string, overrides: Partial<TeachableMoment> = {}): TeachableMoment {
	return {
		id,
		name: `lesson ${id}`,
		description: "short",
		body: `body of ${id}`,
		sourcePhase: "phase-1",
		sourceArtifacts: ["a.ts"],
		createdAt: "2026-01-01T00:00:00.000Z",
		tags: ["t1"],
		relatedIds: ["r1"],
		schema: 2,
		kind: "pattern",
		status: "confirmed",
		origin: "explicit",
		project: "proj",
		host: "omp",
		confidence: 1,
		occurrences: 1,
		lastSeenAt: "2026-01-01T00:00:00.000Z",
		dedupeKey: "k",
		recalled: 0,
		...overrides,
	};
}

describe("A2A-DRAFT agent card", () => {
	test("one moment becomes the only skill, with the body as its description and the draft markers set", () => {
		const card = toAgentCard(moment("m1"));
		expect(card).toMatchObject({ id: "claude-ultrathink", name: "claude-ultrathink", version: "0.1.0-draft" });
		expect(card.skills).toEqual([{ id: "m1", name: "lesson m1", description: "body of m1", tags: ["t1"] }]);
		expect(card.metadata).toEqual({
			sourcePhase: "phase-1",
			createdAt: "2026-01-01T00:00:00.000Z",
			relatedIds: ["r1"],
			sourceArtifacts: ["a.ts"],
			_a2aDraft: true,
		});
		expect(card.description).toContain("A2A-DRAFT");
	});

	test("the authoring agent can be named, and a moment without tags gets the draft tags", () => {
		const card = toAgentCard(moment("m1", { tags: [] }), { id: "omp-1", name: "omp" });
		expect(card).toMatchObject({ id: "omp-1", name: "omp" });
		expect(card.skills?.[0]?.tags).toEqual(["teachable", "a2a-draft"]);
	});

	test("several moments become one card with one skill each, in order", () => {
		const card = toAgentCardFromMoments([moment("a"), moment("b", { tags: [] })]);
		expect(card.skills?.map((skill) => skill.id)).toEqual(["a", "b"]);
		expect(card.skills?.[1]?.tags).toEqual(["teachable", "a2a-draft"]);
		expect(card.skills?.[1]?.description).toBe("body of b");
	});

	test("no moments gives a card with a single placeholder skill", () => {
		const card = toAgentCardFromMoments([]);
		expect(card.skills).toEqual([{ id: "placeholder", name: "No teachable moments", description: "", tags: ["a2a-draft"] }]);
		expect(card.metadata?._a2aDraft).toBe(true);
	});
});
