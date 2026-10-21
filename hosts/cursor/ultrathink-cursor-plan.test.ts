// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

function fakeCheckout(script: string, control?: string): string {
	const root = mkdtempSync(join(tmpdir(), "ultrathink-cursor-"));
	mkdirSync(join(root, "bin"), { recursive: true });
	mkdirSync(join(root, "hooks"), { recursive: true });
	writeFileSync(join(root, "hooks", "engine.ts"), "// stub\n");
	const launcher = join(root, "bin", "run-bun");
	writeFileSync(launcher, script);
	chmodSync(launcher, 0o755);
	if (control !== undefined) {
		const cli = join(root, "bin", "ultrathink");
		writeFileSync(cli, control);
		chmodSync(cli, 0o755);
	}
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
			expect(response.additional_context).not.toContain("Cursor swarm");
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

	test("a child that ignores SIGTERM is killed after the grace, and the prompt still goes through", async () => {
		const root = fakeCheckout("#!/bin/sh\ntrap '' TERM\nwhile :; do sleep 1; done\n");
		try {
			const started = Date.now();
			const response = await runHook({ prompt: "add /health" }, { ULTRATHINK_ROOT: root, ULTRATHINK_CURSOR_BUDGET_MS: "200" });
			expect(JSON.parse(response.stdout)).toEqual({});
			expect(Date.now() - started).toBeLessThan(5000);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("a multi-byte character split across stdout chunks is kept intact", async () => {
		// "é" is the two bytes \xc3 \xa9. The first chunk ends inside the character.
		const root = fakeCheckout(`#!/bin/sh
cat >/dev/null
printf '{"context":"caf\\303'
sleep 0.3
printf '\\251 plan"}\\n'
`);
		try {
			const response = JSON.parse((await runHook({ prompt: "add /health" }, { ULTRATHINK_ROOT: root, ULTRATHINK_CURSOR_BUDGET_MS: "5000" })).stdout) as {
				additional_context?: string;
			};
			expect(response.additional_context).toBe("café plan");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("a control command runs bin/ultrathink for host cursor and blocks the prompt with its output", async () => {
		const root = fakeCheckout(
			`#!/bin/sh
cat >/dev/null
touch "$ULTRATHINK_ROOT/engine-ran"
printf '%s\\n' '{"context":"PLAN"}'
`,
			`#!/bin/sh
printf 'host=%s args=%s\\n' "$ULTRATHINK_HOST" "$*"
`,
		);
		try {
			const env = { ULTRATHINK_ROOT: root, ULTRATHINK_CURSOR_BUDGET_MS: "5000", ULTRATHINK_HOST: "claude-code" };
			expect(JSON.parse((await runHook({ prompt: "/ultrathink-track off" }, env)).stdout)).toEqual({
				continue: false,
				user_message: "host=cursor args=track off",
			});
			expect(JSON.parse((await runHook({ prompt: "/ultrathink:ultrathink-skip" }, env)).stdout)).toEqual({
				continue: false,
				user_message: "host=cursor args=skip",
			});
			expect(JSON.parse((await runHook({ prompt: "/ultrathink status" }, env)).stdout)).toEqual({
				continue: false,
				user_message: "host=cursor args=status",
			});
			// A control command never reaches the planner.
			expect(existsSync(join(root, "engine-ran"))).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("/ultrathink-quick still goes to the planner, and a failed control run leaves the prompt unchanged", async () => {
		const quick = fakeCheckout(
			`#!/bin/sh
cat >/dev/null
printf '%s\\n' '{"skipped":"ultrathink-command"}'
`,
			`#!/bin/sh
printf 'intercepted\\n'
`,
		);
		const failing = fakeCheckout(
			`#!/bin/sh
cat >/dev/null
printf '%s\\n' '{"context":"PLAN"}'
`,
			"#!/bin/sh\nexit 3\n",
		);
		try {
			const quickEnv = { ULTRATHINK_ROOT: quick, ULTRATHINK_CURSOR_BUDGET_MS: "5000" };
			expect(JSON.parse((await runHook({ prompt: "/ultrathink-quick fix the typo" }, quickEnv)).stdout)).toEqual({});
			const failEnv = { ULTRATHINK_ROOT: failing, ULTRATHINK_CURSOR_BUDGET_MS: "5000" };
			expect(JSON.parse((await runHook({ prompt: "/ultrathink-off" }, failEnv)).stdout)).toEqual({});
		} finally {
			rmSync(quick, { recursive: true, force: true });
			rmSync(failing, { recursive: true, force: true });
		}
	});
});

describe("Cursor swarm handoff", () => {
	const repo = join(import.meta.dir, "..", "..");
	const cursorSkill = readFileSync(join(repo, "skills", "ultrathink-cursor", "SKILL.md"), "utf8");
	const kickoff = readFileSync(join(repo, "skills", "ultrathink-kickoff", "SKILL.md"), "utf8");

	test("the hook's swarm note is the heading that kickoff keys on", () => {
		expect(readFileSync(HOOK, "utf8")).toContain("## Cursor swarm");
		expect(kickoff).toContain("the Cursor swarm note (`## Cursor swarm`)");
	});

	test("the Cursor skill finishes only kickoff's state steps before the handoff, never its final prompt or dispatch", () => {
		expect(cursorSkill).not.toContain("finish `ultrathink-kickoff` first");
		expect(cursorSkill).toContain("Stop before its final prompt and its \"Proceed as normal\" section");
	});

	test("kickoff does only steps 1 and 4 of section 5 on a Cursor handoff, and section 6 is skipped", () => {
		const section5 = kickoff.slice(kickoff.indexOf("## 5. "), kickoff.indexOf("## 6. "));
		expect(section5).toContain("When the plan carries the Cursor swarm note (`## Cursor swarm`), do steps 1 and 4 only, then stop.");
		const section6 = kickoff.slice(kickoff.indexOf("## 6. "));
		expect(section6.startsWith("## 6. Proceed as normal\n\nSkip this section when the plan carries the Cursor swarm note")).toBe(true);
		// The dispatch sentence still exists for the non-Cursor hosts.
		expect(section6).toContain("Dispatch the graph's WORKFLOW waves as parallel subagents");
	});
});
