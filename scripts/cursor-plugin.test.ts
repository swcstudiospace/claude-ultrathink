// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EVENT, HOOK_FILE, isOwned } from "./cursor-hooks.ts";
import {
	PLAN_HOOK_FILE,
	PLAN_MARKER,
	PLAN_ROOT_FILE,
	externalSteps,
	isPlanOwned,
	main,
	removePlanHook,
	upsertPlanHook,
} from "./cursor-plugin.ts";

const PSTACK = { type: "command", command: `/usr/bin/node /cursor/hooks/${HOOK_FILE}`, "ultrathink-managed": true };
const SUBSTRATE = {
	type: "command",
	command: "bun /opt/agent-substrate/packages/cli/src/index.ts brief --surface cursor --write",
	"substrate-managed": true,
};
const PLAN = {
	type: "command",
	command: `/usr/bin/node /cursor/hooks/${PLAN_HOOK_FILE}`,
	[PLAN_MARKER]: true,
};

function list(value: unknown): unknown[] {
	if (typeof value !== "object" || value === null || !("hooks" in value)) return [];
	const hooks = (value as { hooks?: unknown }).hooks;
	if (typeof hooks !== "object" || hooks === null || !(EVENT in hooks)) return [];
	const entries = (hooks as Record<string, unknown>)[EVENT];
	return Array.isArray(entries) ? entries : [];
}

describe("planner hook ownership", () => {
	test("the pstack installer does not own the planner entry, and the planner installer does not own pstack or substrate", () => {
		expect(isOwned(PLAN)).toBe(false);
		expect(isPlanOwned(PLAN)).toBe(true);
		expect(isPlanOwned(PSTACK)).toBe(false);
		expect(isPlanOwned(SUBSTRATE)).toBe(false);
	});

	test("install appends after pstack and substrate, and a second install is unchanged", () => {
		const first = upsertPlanHook({ hooks: { [EVENT]: [SUBSTRATE, PSTACK] } }, PLAN);
		expect(first.action).toBe("added");
		expect(list(first.next)).toEqual([SUBSTRATE, PSTACK, PLAN]);
		expect(upsertPlanHook(first.next, PLAN).action).toBe("unchanged");
	});

	test("remove drops only the planner entry", () => {
		const removed = removePlanHook({ hooks: { [EVENT]: [SUBSTRATE, PSTACK, PLAN] } });
		expect(removed.action).toBe("removed");
		expect(list(removed.next)).toEqual([SUBSTRATE, PSTACK]);
	});
});

describe("externalSteps", () => {
	test("skips a missing checkout and never names the swarm runner", () => {
		expect(externalSteps({}, "/repo")).toEqual([]);
		expect(externalSteps({ SWARM_ROOT: "/swarm" }, undefined).map((step) => step.name)).toEqual([]);
		const steps = externalSteps({ SUBSTRATE_ROOT: "/sub", SWARM_ROOT: "/swarm" }, "/repo");
		expect(steps.map((step) => step.name)).toEqual(["substrate-hooks", "substrate-mcp", "swarm-cursor"]);
		const flat = steps.flatMap((step) => step.argv).join(" ");
		expect(flat).not.toContain("swarm_run.py");
		expect(flat).not.toContain("autonomous_run.py");
		expect(flat).toContain("_install_cursor.py");
		expect(flat).toContain("--target");
		expect(flat).toContain("/repo");
	});
});

describe("main", () => {
	test("install is idempotent and leaves the other hook entries in place", () => {
		const cursorDir = mkdtempSync(join(tmpdir(), "cursor-plugin-"));
		const root = mkdtempSync(join(tmpdir(), "ultrathink-root-"));
		try {
			mkdirSync(join(root, "hosts", "cursor"), { recursive: true });
			writeFileSync(join(root, "hosts", "cursor", PLAN_HOOK_FILE), "#!/usr/bin/env node\n");
			writeFileSync(
				join(cursorDir, "hooks.json"),
				`${JSON.stringify({ hooks: { [EVENT]: [SUBSTRATE, PSTACK] } }, null, 2)}\n`,
			);
			const logs: string[] = [];
			const log = (line: string) => logs.push(line);
			expect(main(["install", "--cursor-dir", cursorDir], { env: {}, root, log, nodeCandidates: [process.execPath] })).toBe(0);
			expect(main(["install", "--cursor-dir", cursorDir], { env: {}, root, log, nodeCandidates: [process.execPath] })).toBe(0);
			const hooks = JSON.parse(readFileSync(join(cursorDir, "hooks.json"), "utf8")) as {
				hooks: Record<string, unknown[]>;
			};
			expect(hooks.hooks[EVENT]?.[0]).toEqual(SUBSTRATE);
			expect(hooks.hooks[EVENT]?.[1]).toEqual(PSTACK);
			expect(hooks.hooks[EVENT]).toHaveLength(3);
			expect(isPlanOwned(hooks.hooks[EVENT]?.[2])).toBe(true);
			expect(readFileSync(join(cursorDir, "hooks", PLAN_ROOT_FILE), "utf8").trim()).toBe(root);
			expect(logs.filter((line) => line.includes("entry added"))).toHaveLength(1);
			expect(logs.some((line) => line.includes("already current"))).toBe(true);

			expect(main(["remove", "--cursor-dir", cursorDir], { env: {}, root, log, nodeCandidates: [process.execPath] })).toBe(0);
			const after = JSON.parse(readFileSync(join(cursorDir, "hooks.json"), "utf8")) as {
				hooks: Record<string, unknown[]>;
			};
			expect(after.hooks[EVENT]).toEqual([SUBSTRATE, PSTACK]);
			expect(existsSync(join(cursorDir, "hooks", PLAN_HOOK_FILE))).toBe(false);
		} finally {
			rmSync(cursorDir, { recursive: true, force: true });
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("a missing substrate or swarm script is skipped and the hook still installs", () => {
		const cursorDir = mkdtempSync(join(tmpdir(), "cursor-plugin-ext-"));
		const root = mkdtempSync(join(tmpdir(), "ultrathink-root-"));
		const substrate = mkdtempSync(join(tmpdir(), "substrate-missing-"));
		const swarm = mkdtempSync(join(tmpdir(), "swarm-missing-"));
		try {
			mkdirSync(join(root, "hosts", "cursor"), { recursive: true });
			writeFileSync(join(root, "hosts", "cursor", PLAN_HOOK_FILE), "#!/usr/bin/env node\n");
			const ran: string[][] = [];
			const code = main(["install", "--cursor-dir", cursorDir, "--target", join(cursorDir, "repo")], {
				env: { SUBSTRATE_ROOT: substrate, SWARM_ROOT: swarm },
				root,
				log: () => {},
				nodeCandidates: [process.execPath],
				run: (argv) => {
					ran.push(argv);
					return 0;
				},
			});
			expect(code).toBe(0);
			expect(ran).toEqual([]);
			expect(existsSync(join(cursorDir, "hooks", PLAN_HOOK_FILE))).toBe(true);
		} finally {
			rmSync(cursorDir, { recursive: true, force: true });
			rmSync(root, { recursive: true, force: true });
			rmSync(substrate, { recursive: true, force: true });
			rmSync(swarm, { recursive: true, force: true });
		}
	});

	test("a present swarm installer is invoked and a failing substrate projector does not fail the hook", () => {
		const cursorDir = mkdtempSync(join(tmpdir(), "cursor-plugin-run-"));
		const root = mkdtempSync(join(tmpdir(), "ultrathink-root-"));
		const substrate = mkdtempSync(join(tmpdir(), "substrate-present-"));
		const swarm = mkdtempSync(join(tmpdir(), "swarm-present-"));
		const target = join(cursorDir, "repo");
		try {
			mkdirSync(join(root, "hosts", "cursor"), { recursive: true });
			writeFileSync(join(root, "hosts", "cursor", PLAN_HOOK_FILE), "#!/usr/bin/env node\n");
			const projector = join(substrate, "packages", "projector", "src");
			mkdirSync(projector, { recursive: true });
			writeFileSync(join(projector, "cursor.ts"), "// projector\n");
			writeFileSync(join(projector, "cursor-mcp.ts"), "// mcp\n");
			mkdirSync(join(swarm, "scripts"), { recursive: true });
			const installer = join(swarm, "scripts", "_install_cursor.py");
			writeFileSync(installer, "# installer\n");
			chmodSync(installer, 0o644);
			const ran: string[][] = [];
			const code = main(["install", "--cursor-dir", cursorDir, "--target", target], {
				env: { SUBSTRATE_ROOT: substrate, SWARM_ROOT: swarm },
				root,
				log: () => {},
				nodeCandidates: [process.execPath],
				run: (argv) => {
					ran.push(argv);
					return argv[1]?.endsWith("cursor.ts") ? 1 : 0;
				},
			});
			expect(code).toBe(0);
			expect(ran[2]).toEqual(["python3", installer, "--target", target]);
			expect(ran.flat().join(" ")).not.toContain("swarm_run.py");
		} finally {
			rmSync(cursorDir, { recursive: true, force: true });
			rmSync(root, { recursive: true, force: true });
			rmSync(substrate, { recursive: true, force: true });
			rmSync(swarm, { recursive: true, force: true });
		}
	});
});
