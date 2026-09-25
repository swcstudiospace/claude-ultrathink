// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { carrierPath, clearPlanCarrier, writePlanCarrier } from "./carrier.ts";
import { claimTurn } from "./claim.ts";

const HOOK = join(import.meta.dir, "..", "..", "hooks", "uplift.ts");

let dir: string;
let stateDir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ultrathink-carrier-"));
	stateDir = join(dir, "state");
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function writeStalePlan(): string {
	const path = writePlanCarrier({ host: "grok-build", stateDir, sessionId: "s0", context: "<spec>old prompt</spec>" });
	if (!path) throw new Error("stale carrier not written");
	return path;
}

describe("clearPlanCarrier", () => {
	test("removes the carrier", () => {
		const path = writeStalePlan();
		clearPlanCarrier(stateDir);
		expect(existsSync(path)).toBe(false);
	});

	test("a missing carrier or state dir is fine", () => {
		expect(() => clearPlanCarrier(stateDir)).not.toThrow();
		mkdirSync(stateDir, { recursive: true });
		clearPlanCarrier(stateDir);
		expect(existsSync(carrierPath(stateDir))).toBe(false);
	});
});

describe("uplift hook on Grok", () => {
	function runHook(envelope: Record<string, unknown>): string {
		const home = join(dir, "home");
		mkdirSync(home, { recursive: true });
		const env: Record<string, string | undefined> = {};
		for (const [key, value] of Object.entries(process.env)) {
			if (!key.startsWith("ULTRATHINK_") && !key.startsWith("GROK_") && key !== "CLAUDE_CONFIG_DIR") env[key] = value;
		}
		const proc = Bun.spawnSync([process.execPath, HOOK], {
			cwd: dir,
			env: { ...env, HOME: home, XDG_CONFIG_HOME: join(home, ".config"), ULTRATHINK_HOST: "grok-build", ULTRATHINK_STATE_DIR: stateDir },
			stdin: Buffer.from(JSON.stringify({ hookEventName: "user_prompt_submit", cwd: dir, ...envelope })),
			stdout: "pipe",
			stderr: "pipe",
			timeout: 30_000,
		});
		expect(proc.exitCode).toBe(0);
		return proc.stdout.toString();
	}

	test("prompts that end without a plan remove the previous prompt's carrier", () => {
		for (const prompt of ["/ultrathink-quick fix the typo", "/model sonnet", "ok"]) {
			const path = writeStalePlan();
			runHook({ sessionId: "s1", promptId: prompt, userPrompt: prompt });
			expect(existsSync(path)).toBe(false);
		}
	});

	test("control commands and prompts while planning is off remove the carrier", () => {
		const path = writeStalePlan();
		expect(JSON.parse(runHook({ sessionId: "s1", promptId: "p1", userPrompt: "/ultrathink-off" }))).toMatchObject({ decision: "block" });
		expect(existsSync(path)).toBe(false);
		writeStalePlan();
		runHook({ sessionId: "s1", promptId: "p2", userPrompt: "refactor the billing module to use the new ledger api" });
		expect(existsSync(path)).toBe(false);
	});

	test("a duplicate dispatch of a claimed turn leaves the owner's carrier alone", () => {
		const path = writeStalePlan();
		expect(claimTurn(stateDir, "s1:p1")).toBe(true);
		runHook({ sessionId: "s1", promptId: "p1", userPrompt: "refactor the billing module to use the new ledger api" });
		expect(existsSync(path)).toBe(true);
	});

	test("a subagent prompt leaves the main session's carrier alone", () => {
		const path = writeStalePlan();
		runHook({ sessionId: "s1", promptId: "p2", subagentType: "explore", userPrompt: "/ultrathink-quick look around" });
		expect(existsSync(path)).toBe(true);
	});
});
