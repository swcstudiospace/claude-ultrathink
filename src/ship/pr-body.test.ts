// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import type { SessionRecord } from "../claude/state.ts";
import { DECISIONS_ERROR_KINDS } from "../decisions/types.ts";
import type { DecisionRecord } from "../decisions/types.ts";
import { buildPr } from "./pr-body.ts";
import type { Assessment } from "./types.ts";

const RECORD = { sessionId: "s", at: 1, result: { xml: "", original: "Add a --verbose flag", root: "" } } as unknown as SessionRecord;
const MODEL = "typesafe/jev-1.13-20260917";
const OK: DecisionRecord = {
	point: "ship",
	outcome: "ok",
	model: MODEL,
	id: "gen-dec-test",
	p: 0.94,
	probabilities: { complete: 0.94 },
	threshold: 0.2,
	action: "none",
	latencyMs: 120,
	attempts: 1,
	cost: 0.000019,
	at: 5,
};
const ERROR: DecisionRecord = {
	point: "ship",
	outcome: "error",
	model: "~typesafe/jev-latest",
	probabilities: {},
	threshold: 0.2,
	action: "fail-open",
	latencyMs: 80,
	attempts: 1,
	error: "credits",
	at: 5,
};
const ASSESSMENT: Assessment = {
	done: true,
	confidence: 0.9,
	summary: "ok",
	gaps: [],
	signals: { git: { onBase: false, ahead: 1, dirty: [], untracked: 0, pushed: true } },
	source: "llm",
	mode: "gate",
	at: 1,
};

/** The lines of the body's `## Assessment` section (the body ends with a newline). */
function assessmentLines(body: string): string[] {
	return body.split("## Assessment\n\n")[1]?.split("\n\n")[0]?.trimEnd().split("\n") ?? [];
}

describe("buildPr Jev line", () => {
	test("an ok decision is the last line of ## Assessment, after the gaps and the advisory judge lines (AC-6.10)", () => {
		const { body } = buildPr(RECORD, {
			...ASSESSMENT,
			mode: "advisory",
			gaps: ["docs"],
			judge: { done: false, confidence: 0.6, summary: "", gaps: ["tests"] },
			decision: OK,
		});
		const lines = assessmentLines(body);
		expect(lines).toContain("- Judge notes:");
		expect(lines.at(-1)).toBe("- Jev: P(complete) 0.94 · typesafe/jev-1.13-20260917");
		expect(body.split("\n").filter((line) => line.startsWith("- Jev:"))).toHaveLength(1);
	});

	test("the line names what Jev did to the outcome, with P truncated to two decimals", () => {
		const cases: [DecisionRecord, string][] = [
			[{ ...OK, p: 0.79, action: "approve", threshold: 0.7 }, `- Jev: P(complete) 0.79 · ${MODEL} · approved (no LLM verdict)`],
			[{ ...OK, p: 0.3, action: "reject", threshold: 0.7 }, `- Jev: P(complete) 0.30 · ${MODEL} · rejected (no LLM verdict)`],
			[{ ...OK, p: 0.03, action: "veto" }, `- Jev: P(complete) 0.03 · ${MODEL} · veto`],
			[{ ...OK, p: 0.199, action: "veto" }, `- Jev: P(complete) 0.19 · ${MODEL} · veto`],
			[{ ...OK, p: 0.03, action: "advise-veto" }, `- Jev: P(complete) 0.03 · ${MODEL} · veto (advisory: shipped anyway)`],
		];
		for (const [decision, line] of cases) {
			expect(assessmentLines(buildPr(RECORD, { ...ASSESSMENT, decision }).body).at(-1)).toBe(line);
		}
	});

	test("a failed decision reads - Jev: error (<kind>) for every kind (AC-4.12)", () => {
		for (const kind of DECISIONS_ERROR_KINDS) {
			const { body } = buildPr(RECORD, { ...ASSESSMENT, decision: { ...ERROR, error: kind } });
			expect(assessmentLines(body).at(-1)).toBe(`- Jev: error (${kind})`);
		}
	});

	test("the model is scrubbed of control characters and local paths and kept on one line", () => {
		const { body } = buildPr(RECORD, { ...ASSESSMENT, decision: { ...OK, model: "evil\u0007/model\n## Injected /root/secret.txt" } });
		expect(assessmentLines(body).at(-1)).toBe("- Jev: P(complete) 0.94 · evil/model ## Injected <local path>");
		expect(body).not.toContain("\n## Injected");
		expect(body).not.toContain("/root/");
	});

	test("an assessment without a decision has no Jev line", () => {
		expect(buildPr(RECORD, ASSESSMENT).body).not.toContain("Jev");
	});
});
