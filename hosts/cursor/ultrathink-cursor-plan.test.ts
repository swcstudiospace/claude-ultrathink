// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOOK = join(import.meta.dir, "ultrathink-cursor-plan.js");

function runHook(
	input: unknown,
	env: Record<string, string>,
	root?: string,
): Promise<{ stdout: string; seen?: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [HOOK], {
			env: { ...process.env, ...env },
			stdio: ["pipe", "pipe", "pipe"],
		});
		let stdout = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString("utf8");
		});
		child.on("error", reject);
		child.on("close", () => {
			let seen: string | undefined;
			if (root) {
				try {
					seen = readFileSync(join(root, "seen.json"), "utf8");
				} catch {
					seen = undefined;
				}
			}
			resolve({ stdout, seen });
		});
		child.stdin.end(typeof input === "string" ? input : JSON.stringify(input));
	});
}

function fakeCheckout(script: string): string {
	const root = mkdtempSync(join(tmpdir(), "ultrathink-cursor-"));
	mkdirSync(join(root, "bin"), { recursive: true });
	mkdirSync(join(root, "hooks"), { recursive: true });
	writeFileSync(join(root, "hooks", "engine.ts"), "// stub\n");
	const launcher = join(root, "bin", "run-bun");
	writeFileSync(launcher, script);
	chmodSync(launcher, 0o755);
	return root;
}

describe("cursor planner hook", () => {
	test("fail-open: a missing checkout, bad stdin, an empty prompt, and a child session return {}", async () => {
		expect(JSON.parse((await runHook({ prompt: "add a route" }, { ULTRATHINK_ROOT: "/no/such/ultrathink" })).stdout)).toEqual({});
		expect(JSON.parse((await runHook("not-json", { ULTRATHINK_ROOT: "/no/such/ultrathink" })).stdout)).toEqual({});
		expect(JSON.parse((await runHook({ prompt: "   " }, { ULTRATHINK_ROOT: "/no/such/ultrathink" })).stdout)).toEqual({});
		expect(
			JSON.parse(
				(await runHook({ prompt: "add a route" }, { SWARM_CHILD: "1", ULTRATHINK_ROOT: "/no/such/ultrathink" })).stdout,
			),
		).toEqual({});
		expect(
			JSON.parse(
				(await runHook({ prompt: "add a route", is_subagent: true }, { ULTRATHINK_ROOT: "/no/such/ultrathink" })).stdout,
			),
		).toEqual({});
	});

	test("maps a fake engine plan, names host cursor, and drops a bad Graph ID", async () => {
		const root = fakeCheckout(`#!/bin/sh
cat > "$ULTRATHINK_ROOT/seen.json"
printf '%s\\n' '{"context":"PLAN","graphId":"ut-m1-abcdef12"}'
`);
		try {
			const planned = await runHook(
				{ prompt: "add /health", conversation_id: "conv-1", workspace_roots: ["/work"], model: "composer\ninjected" },
				{ ULTRATHINK_ROOT: root, ULTRATHINK_CURSOR_BUDGET_MS: "5000" },
				root,
			);
			const body = JSON.parse(planned.stdout) as { continue?: boolean; additional_context?: string };
			expect(body.continue).toBe(true);
			expect(body.additional_context?.startsWith("PLAN\n\n")).toBe(true);
			expect(body.additional_context).toContain("ultrathink-cursor");
			expect(body.additional_context).toContain("a01-orchestrator");
			expect(body.additional_context).toContain("Graph ID: ut-m1-abcdef12");
			expect(body.additional_context).toContain("swarm_run.py");
			const seen = JSON.parse(planned.seen ?? "{}") as { host?: string; prompt?: string; cwd?: string; model?: string };
			expect(seen).toMatchObject({ host: "cursor", prompt: "add /health", cwd: "/work" });
			expect(seen.model).toBeUndefined();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}

		const loose = fakeCheckout(`#!/bin/sh
cat >/dev/null
printf '%s\\n' '{"context":"PLAN","graphId":"not-a-graph"}'
`);
		try {
			const response = JSON.parse(
				(await runHook({ prompt: "add /health" }, { ULTRATHINK_ROOT: loose, ULTRATHINK_CURSOR_BUDGET_MS: "5000" })).stdout,
			) as { additional_context?: string };
			expect(response.additional_context).toContain("PLAN");
			expect(response.additional_context).not.toContain("not-a-graph");
		} finally {
			rmSync(loose, { recursive: true, force: true });
		}
	});

	test("engine failure and a skip return {}", async () => {
		const root = fakeCheckout("#!/bin/sh\ncat >/dev/null\nprintf '%s\\n' 'not-json'\n");
		try {
			expect(JSON.parse((await runHook({ prompt: "add /health" }, { ULTRATHINK_ROOT: root, ULTRATHINK_CURSOR_BUDGET_MS: "5000" })).stdout)).toEqual(
				{},
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
		const skipped = fakeCheckout(`#!/bin/sh
cat >/dev/null
printf '%s\\n' '{"skipped":"trivial","context":"PLAN"}'
`);
		try {
			expect(
				JSON.parse((await runHook({ prompt: "ok" }, { ULTRATHINK_ROOT: skipped, ULTRATHINK_CURSOR_BUDGET_MS: "5000" })).stdout),
			).toEqual({});
		} finally {
			rmSync(skipped, { recursive: true, force: true });
		}
	});

	test("a hung engine is cut off and the prompt still goes through", async () => {
		const root = fakeCheckout("#!/bin/sh\nsleep 30\n");
		try {
			expect(JSON.parse((await runHook({ prompt: "add /health" }, { ULTRATHINK_ROOT: root, ULTRATHINK_CURSOR_BUDGET_MS: "200" })).stdout)).toEqual(
				{},
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
