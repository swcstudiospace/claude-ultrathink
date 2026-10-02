// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeSession } from "../src/claude/state.ts";
import { DEFAULT_HINDSIGHT_CONFIG } from "../src/hindsight/types.ts";
import { DEFAULT_TEACH_CONFIG, type CaptureMode, type TeachContext, type TeachDigest } from "../src/teach/types.ts";
import type { TrackPlan } from "../src/track/types.ts";
import { runStop, type StopDeps } from "./stop.ts";

const DIGEST: TeachDigest = {
	host: "claude-code",
	sessionId: "s1",
	cwd: "/repo",
	at: "2026-10-02T00:00:00.000Z",
	turns: [{ role: "user", text: "fix it" }],
	toolCalls: 5,
	outcome: "completed",
};

describe("stop hook teach capture", () => {
	let dir = "";
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "ut-stop-"));
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	const spawned: { digest: TeachDigest; stateDir: string; host: string }[] = [];
	const digestArgs: unknown[] = [];
	beforeEach(() => {
		spawned.length = 0;
		digestArgs.length = 0;
	});

	const setup = (enabled: boolean, capture: CaptureMode, env: NodeJS.ProcessEnv = {}): StopDeps => ({
		stateDir: dir,
		child: false,
		env,
		repoRoot: "/plugin",
		teachContext: (options) =>
			({
				host: options.host ?? "claude-code",
				cwd: options.cwd ?? "",
				env: options.env ?? {},
				stateDir: join(dir, "teach-state"),
				config: { teach: { ...DEFAULT_TEACH_CONFIG, enabled, capture }, hindsight: DEFAULT_HINDSIGHT_CONFIG },
			}) satisfies TeachContext,
		digest: (path, meta) => {
			digestArgs.push({ path, meta });
			return DIGEST;
		},
		spawn: (digest, options) => {
			spawned.push({ digest, stateDir: options.stateDir, host: options.host });
			return { spawned: true };
		},
	});
	const envelope = (extra: Record<string, unknown> = {}) =>
		JSON.stringify({ session_id: "s1", cwd: "/repo", transcript_path: "/t/s1.jsonl", ...extra });

	test("observe mode spawns exactly once for a main session, with the transcript read as completed", () => {
		expect(runStop(envelope(), setup(true, "observe"))).toBeUndefined();
		expect(spawned).toEqual([{ digest: DIGEST, stateDir: join(dir, "teach-state"), host: "claude-code" }]);
		expect(digestArgs).toEqual([
			{ path: "/t/s1.jsonl", meta: { host: "claude-code", sessionId: "s1", cwd: "/repo", outcome: "completed" } },
		]);
	});

	test("auto mode spawns, and the host follows ULTRATHINK_HOST (muse)", () => {
		runStop(envelope(), setup(true, "auto", { ULTRATHINK_HOST: "muse" }));
		expect(spawned.map((s) => s.host)).toEqual(["muse"]);
	});

	test("an untracked session still captures and prints nothing; a tracked one keeps its sync message", () => {
		const deps = setup(true, "observe");
		expect(runStop(envelope(), deps)).toBeUndefined();
		writeSession(dir, {
			sessionId: "s1",
			at: 1,
			result: { xml: "", original: "", root: "BUILD_PROMPT", source: "llm" },
			plan: { graphId: "g-1" } as TrackPlan,
		} as unknown as Parameters<typeof writeSession>[1]);
		// reason "shutdown" is Grok's session-end Stop: no ship check, so no operator config is read.
		const out = runStop(envelope({ reason: "shutdown" }), deps);
		expect(JSON.parse(out ?? "{}")).toEqual({ systemMessage: expect.stringContaining("graphId=g-1") });
		expect(spawned).toHaveLength(2);
	});

	test.each<[string, StopDeps, Record<string, unknown>]>([
		["explicit capture", setup(true, "explicit"), {}],
		["Teachable Moments disabled", setup(false, "auto"), {}],
		["ULTRATHINK_TEACH=0", setup(true, "auto", { ULTRATHINK_TEACH: "0" }), {}],
		["a child invocation", { ...setup(true, "observe"), child: true }, {}],
		["a subagent envelope", setup(true, "observe"), { agent_id: "a1" }],
		["a Grok subagent envelope", setup(true, "observe"), { subagentType: "explore" }],
		["stop_hook_active", setup(true, "observe"), { stop_hook_active: true }],
		["a missing transcript_path", setup(true, "observe"), { transcript_path: undefined }],
		["an empty transcript_path", setup(true, "observe"), { transcript_path: "" }],
	])("never spawns for %s", (_name, deps, extra) => {
		expect(runStop(envelope(extra), deps)).toBeUndefined();
		expect(spawned).toHaveLength(0);
	});

	test("a Grok camelCase envelope is captured", () => {
		runStop(JSON.stringify({ sessionId: "g1", cwd: "/repo", transcriptPath: "/t/g1.jsonl" }), setup(true, "observe", { ULTRATHINK_HOST: "grok-build" }));
		expect(spawned.map((s) => s.host)).toEqual(["grok-build"]);
		expect(digestArgs).toEqual([
			{ path: "/t/g1.jsonl", meta: { host: "grok-build", sessionId: "g1", cwd: "/repo", outcome: "completed" } },
		]);
	});

	test("an unreadable transcript (no digest) does not spawn", () => {
		expect(runStop(envelope(), { ...setup(true, "observe"), digest: () => undefined })).toBeUndefined();
		expect(spawned).toHaveLength(0);
	});

	test("a throwing digest, spawn or context leaves the output unchanged", () => {
		writeSession(dir, {
			sessionId: "s1",
			at: 1,
			result: { xml: "", original: "", root: "BUILD_PROMPT", source: "llm" },
			plan: { graphId: "g-2" } as TrackPlan,
		} as unknown as Parameters<typeof writeSession>[1]);
		const base = setup(true, "observe");
		const boom = () => {
			throw new Error("boom");
		};
		const expected = runStop(envelope({ reason: "shutdown" }), { ...setup(false, "explicit") });
		expect(expected).toContain("graphId=g-2");
		for (const deps of [{ ...base, digest: boom }, { ...base, spawn: boom }, { ...base, teachContext: boom }]) {
			expect(runStop(envelope({ reason: "shutdown" }), deps)).toBe(expected);
		}
	});
});
