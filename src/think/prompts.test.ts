// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import { COT_SYSTEM_PROMPT } from "./prompts.ts";
import { MAX_RATIONALE_CHARS, MAX_STEPS, MIN_STEPS } from "./types.ts";

describe("COT_SYSTEM_PROMPT", () => {
	test("asks for the tracked step range and the matching rationale budget", () => {
		// Each rationale step becomes a Sub-Issue, so the prompt must demand the 4-8 range explicitly.
		expect(MIN_STEPS).toBe(4);
		expect(MAX_STEPS).toBe(8);
		expect(COT_SYSTEM_PROMPT).toContain(`between ${MIN_STEPS} and ${MAX_STEPS} numbered steps`);
		expect(COT_SYSTEM_PROMPT).toContain(`<rationale> at most ${MAX_RATIONALE_CHARS} characters`);
		expect(COT_SYSTEM_PROMPT).toContain("numbered 1., 2., 3. in order, each on its own line");
	});
});
