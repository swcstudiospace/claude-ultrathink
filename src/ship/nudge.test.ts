// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import type { SessionRecord } from "../claude/state.ts";
import type { TrackPlan } from "../track/types.ts";
import { shellArg } from "../track/gateway.ts";
import { SHIP_CLI, shipNudge } from "./nudge.ts";
import { DEFAULT_SHIP_CONFIG } from "./types.ts";

const record: SessionRecord = {
	sessionId: "s1",
	at: 1,
	result: { xml: "<BUILD_PROMPT/>", original: "x", root: "BUILD_PROMPT", source: "llm" },
	plan: { graphId: "g1" } as TrackPlan,
	skill: { name: "gsd-execute-phase", source: "slash" },
};
const precheck = { ok: true, reason: "ok", branch: "feat/x", base: "master", ahead: 3 };
const base = { record, config: { ...DEFAULT_SHIP_CONFIG, enabled: true }, precheck, statePath: "/s/s1.json", env: {} };

describe("shipNudge", () => {
	test("blocks with everything the agent needs to run the skill", () => {
		const nudge = shipNudge(base);
		expect(nudge?.decision).toBe("block");
		for (const part of ["gsd-execute-phase", "feat/x", "master", "stateFile=/s/s1.json", `CLI: ${shellArg(SHIP_CLI)}`, "ultrathink-ship"]) {
			expect(nudge?.reason).toContain(part);
		}
		expect(SHIP_CLI.endsWith("/bin/ultrathink-ship")).toBe(true);
		expect(nudge?.systemMessage).toContain("ultrathink-ship");
	});

	test("promises a merge only when ship.autoMerge is on", () => {
		const manual = shipNudge(base);
		expect(manual?.reason).toContain("leaves the PR for a manual merge (ship.autoMerge is off)");
		expect(manual?.reason).not.toContain("keeps retrying the merge");
		expect(manual?.systemMessage).toContain("manual merge");
		const auto = shipNudge({ ...base, config: { ...base.config, autoMerge: true } });
		expect(auto?.reason).toContain("keeps retrying the merge until the 5/5-reviewed PR merges");
		expect(auto?.reason).not.toContain("manual merge");
		expect(auto?.systemMessage).toEndWith("Greptile review, merge).");
	});

	test("stays silent when already nudged, merged, blocked, re-entered, off-skill, disabled (the default) or precheck fails", () => {
		const cases = [
			{ ...base, record: { ...record, ship: { phase: "pr-open" as const, rounds: [], nudgedAt: 5, updatedAt: 5 } } },
			{ ...base, record: { ...record, ship: { phase: "merged" as const, rounds: [], updatedAt: 5 } } },
			{ ...base, record: { ...record, ship: { phase: "blocked" as const, rounds: [], updatedAt: 5 } } },
			{ ...base, stopHookActive: true },
			{ ...base, record: { ...record, skill: { name: "docx", source: "slash" as const } } },
			{ ...base, record: { ...record, skill: undefined } },
			{ ...base, record: { ...record, plan: undefined } },
			{ ...base, env: { ULTRATHINK_SHIP: "0" } },
			{ ...base, config: DEFAULT_SHIP_CONFIG },
			{ ...base, precheck: { ok: false, reason: "on base", ahead: 0 } },
		];
		for (const input of cases) expect(shipNudge(input)).toBeUndefined();
	});

	test("an unfinished earlier ship phase without a nudge still fires", () => {
		const input = { ...base, record: { ...record, ship: { phase: "needs-fixes" as const, rounds: [], updatedAt: 5 } } };
		expect(shipNudge(input)?.decision).toBe("block");
	});
});
