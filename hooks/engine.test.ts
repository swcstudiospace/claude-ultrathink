// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import { requestFrom } from "./engine.ts";

describe("requestFrom", () => {
	test("forwards the session model for per-model engine routing", () => {
		expect(requestFrom({ host: "omp", model: "muse-code/muse-spark-1.3-contributor" }).model).toBe(
			"muse-code/muse-spark-1.3-contributor",
		);
		expect(requestFrom({ host: "hermes", model: "xai-oauth/grok-4.7" }).model).toBe("xai-oauth/grok-4.7");
	});

	test("omits the model when absent or not a string", () => {
		expect(requestFrom({ host: "omp" }).model).toBeUndefined();
		expect(requestFrom({ host: "omp", model: 42 }).model).toBeUndefined();
		expect(requestFrom({ host: "omp", model: null }).model).toBeUndefined();
	});

	test("keeps the existing field aliases", () => {
		expect(
			requestFrom({
				host: "claude-code",
				sessionId: "s1",
				userPrompt: "hi",
				workspaceRoot: "/repo",
				transcriptPath: "/tmp/t.jsonl",
				parentSessionId: "p1",
				platform: "cron",
			}),
		).toEqual({
			host: "claude-code",
			session_id: "s1",
			prompt: "hi",
			cwd: "/repo",
			transcript_path: "/tmp/t.jsonl",
			parent_session_id: "p1",
			platform: "cron",
			model: undefined,
		});
	});

	test("rejects non-objects and unknown hosts", () => {
		expect(requestFrom(null)).toEqual({});
		expect(requestFrom("model")).toEqual({});
		expect(requestFrom({ host: "wat", model: "muse-spark" })).toEqual({ host: undefined, session_id: undefined, prompt: undefined, cwd: undefined, transcript_path: undefined, parent_session_id: undefined, platform: undefined, model: "muse-spark" });
	});
});
