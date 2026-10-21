// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 SWC Studio
import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EVENT, HOOK_FILE, acquireHookLock, isOwned } from "./cursor-hooks.ts";
import { gsdCommandNames } from "../src/cursor/pstack.ts";
import {
	GSD_COMMAND_DIR,
	GSD_MARKER,
	PLAN_HOOK_FILE,
	PLAN_MARKER,
	PLAN_ROOT_FILE,
	externalSteps,
	isPlanOwned,
	main,
	removePlanHook,
	renderGsdCommand,
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
			const names = gsdCommandNames();
			expect(names.length).toBeGreaterThan(0);
			for (const name of names) {
				expect(readFileSync(join(cursorDir, "commands", `${name}.md`), "utf8")).toBe(renderGsdCommand(name));
			}
		} finally {
			rmSync(cursorDir, { recursive: true, force: true });
			rmSync(root, { recursive: true, force: true });
			rmSync(substrate, { recursive: true, force: true });
			rmSync(swarm, { recursive: true, force: true });
		}
	});

	test("install leaves a foreign GSD command and a symlink in place, and remove deletes only marked copies", () => {
		const cursorDir = mkdtempSync(join(tmpdir(), "cursor-plugin-gsd-"));
		const root = mkdtempSync(join(tmpdir(), "ultrathink-root-"));
		const outside = mkdtempSync(join(tmpdir(), "gsd-foreign-"));
		try {
			mkdirSync(join(root, "hosts", "cursor"), { recursive: true });
			writeFileSync(join(root, "hosts", "cursor", PLAN_HOOK_FILE), "#!/usr/bin/env node\n");
			const commands = join(cursorDir, "commands");
			mkdirSync(commands, { recursive: true });
			const foreign = join(commands, "gsd-plan-phase.md");
			writeFileSync(foreign, "# real GSD plan-phase\n");
			const link = join(commands, "gsd-ship.md");
			writeFileSync(join(outside, "gsd-ship.md"), "# linked\n");
			symlinkSync(join(outside, "gsd-ship.md"), link);
			const logs: string[] = [];
			expect(main(["install", "--cursor-dir", cursorDir], { env: {}, root, log: (line) => logs.push(line), nodeCandidates: [process.execPath] })).toBe(0);
			expect(readFileSync(foreign, "utf8")).toBe("# real GSD plan-phase\n");
			expect(lstatSync(link).isSymbolicLink()).toBe(true);
			expect(readFileSync(join(commands, "gsd-quick.md"), "utf8")).toContain(GSD_MARKER);
			expect(logs.some((line) => line.includes("left gsd-plan-phase.md in place"))).toBe(true);
			expect(logs.some((line) => line.includes("left gsd-ship.md in place"))).toBe(true);

			expect(main(["remove", "--cursor-dir", cursorDir], { env: {}, root, log: () => {}, nodeCandidates: [process.execPath] })).toBe(0);
			expect(existsSync(foreign)).toBe(true);
			expect(lstatSync(link).isSymbolicLink()).toBe(true);
			expect(existsSync(join(commands, "gsd-quick.md"))).toBe(false);
			expect(existsSync(join(commands, "gsd-autonomous.md"))).toBe(false);
			expect(existsSync(join(cursorDir, "hooks", PLAN_HOOK_FILE))).toBe(false);
		} finally {
			rmSync(cursorDir, { recursive: true, force: true });
			rmSync(root, { recursive: true, force: true });
			rmSync(outside, { recursive: true, force: true });
		}
	});
});

describe("shipped GSD commands", () => {
	test("the plugin lists the command directory and each file matches the renderer", () => {
		const root = join(import.meta.dir, "..");
		const manifest = JSON.parse(readFileSync(join(root, ".cursor-plugin", "plugin.json"), "utf8")) as {
			skills?: string;
			commands?: string[];
		};
		expect(manifest.skills).toBe("./skills/");
		expect(manifest.commands).toEqual(["./hosts/cursor/commands", `./${GSD_COMMAND_DIR}`]);
		const dir = join(root, GSD_COMMAND_DIR);
		const names = gsdCommandNames();
		expect(readdirSync(dir).filter((name) => name.endsWith(".md")).sort()).toEqual(names.map((name) => `${name}.md`).sort());
		for (const name of names) {
			const text = readFileSync(join(dir, `${name}.md`), "utf8");
			expect(text).toBe(renderGsdCommand(name));
			expect(text).toContain(`/${name}`);
			expect(text.startsWith("/")).toBe(false);
		}
	});
});

function runShell(command: string, stdin: string, env: Record<string, string>): Promise<string> {
	const { promise, resolve, reject } = Promise.withResolvers<string>();
	const child = spawn("/bin/sh", ["-c", command], { env, stdio: ["pipe", "pipe", "pipe"] });
	let stdout = "";
	child.stdout.on("data", (chunk) => {
		stdout += chunk.toString("utf8");
	});
	child.on("error", reject);
	child.on("close", () => resolve(stdout));
	child.stdin.end(stdin);
	return promise;
}

describe("installer restores and locks", () => {
	test("a dangling symlink where a GSD command goes is left alone, and its target is not created", () => {
		const cursorDir = mkdtempSync(join(tmpdir(), "cursor-plugin-dangle-"));
		const root = mkdtempSync(join(tmpdir(), "ultrathink-root-"));
		const outside = mkdtempSync(join(tmpdir(), "gsd-dangle-"));
		try {
			mkdirSync(join(root, "hosts", "cursor"), { recursive: true });
			writeFileSync(join(root, "hosts", "cursor", PLAN_HOOK_FILE), "#!/usr/bin/env node\n");
			const commands = join(cursorDir, "commands");
			mkdirSync(commands, { recursive: true });
			const target = join(outside, "gsd-ship.md");
			const link = join(commands, "gsd-ship.md");
			symlinkSync(target, link);
			const logs: string[] = [];
			expect(main(["install", "--cursor-dir", cursorDir], { env: {}, root, log: (line) => logs.push(line), nodeCandidates: [process.execPath] })).toBe(0);
			expect(existsSync(target)).toBe(false);
			expect(lstatSync(link).isSymbolicLink()).toBe(true);
			expect(logs.some((line) => line.includes("left gsd-ship.md in place"))).toBe(true);
			expect(readFileSync(join(commands, "gsd-quick.md"), "utf8")).toContain(GSD_MARKER);
		} finally {
			rmSync(cursorDir, { recursive: true, force: true });
			rmSync(root, { recursive: true, force: true });
			rmSync(outside, { recursive: true, force: true });
		}
	});

	test("a hook update that throws part way restores the staged hook and its root file", () => {
		const cursorDir = mkdtempSync(join(tmpdir(), "cursor-plugin-restore-"));
		const root = mkdtempSync(join(tmpdir(), "ultrathink-root-"));
		const missing = mkdtempSync(join(tmpdir(), "ultrathink-gone-"));
		try {
			mkdirSync(join(root, "hosts", "cursor"), { recursive: true });
			const source = join(root, "hosts", "cursor", PLAN_HOOK_FILE);
			writeFileSync(source, "// previous planner\n");
			const logs: string[] = [];
			const deps = { env: {}, root, log: (line: string) => logs.push(line), nodeCandidates: [process.execPath] };
			expect(main(["install", "--cursor-dir", cursorDir], deps)).toBe(0);
			const staged = join(cursorDir, "hooks", PLAN_HOOK_FILE);
			const rootFile = join(cursorDir, "hooks", PLAN_ROOT_FILE);
			const previous = readFileSync(staged, "utf8");
			// The new hook copies over the staged file, then writing the root file throws (its target directory is missing).
			writeFileSync(source, "// new planner\n");
			rmSync(rootFile);
			symlinkSync(join(missing, "absent", "root.txt"), rootFile);
			expect(main(["install", "--cursor-dir", cursorDir], deps)).toBe(1);
			expect(readFileSync(staged, "utf8")).toBe(previous);
			expect(logs.some((line) => line.includes("could not install the planner hook"))).toBe(true);
		} finally {
			rmSync(cursorDir, { recursive: true, force: true });
			rmSync(root, { recursive: true, force: true });
			rmSync(missing, { recursive: true, force: true });
		}
	});

	test("remove deletes GSD command files only while it holds the hook lock", () => {
		const cursorDir = mkdtempSync(join(tmpdir(), "cursor-plugin-lock-"));
		const root = mkdtempSync(join(tmpdir(), "ultrathink-root-"));
		try {
			mkdirSync(join(root, "hosts", "cursor"), { recursive: true });
			writeFileSync(join(root, "hosts", "cursor", PLAN_HOOK_FILE), "#!/usr/bin/env node\n");
			const deps = { env: {}, root, log: () => {}, nodeCandidates: [process.execPath], lockWaitMs: 0 };
			expect(main(["install", "--cursor-dir", cursorDir], deps)).toBe(0);
			const quick = join(cursorDir, "commands", "gsd-quick.md");
			const held = acquireHookLock(cursorDir, 0);
			if (!("release" in held)) throw new Error(held.reason);
			try {
				expect(main(["remove", "--cursor-dir", cursorDir], deps)).toBe(1);
				// Another update holds the lock, so nothing is deleted and the hook entry stays.
				expect(existsSync(quick)).toBe(true);
				expect(existsSync(join(cursorDir, "hooks", PLAN_HOOK_FILE))).toBe(true);
			} finally {
				held.release();
			}
			expect(main(["remove", "--cursor-dir", cursorDir], deps)).toBe(0);
			expect(existsSync(quick)).toBe(false);
		} finally {
			rmSync(cursorDir, { recursive: true, force: true });
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("Cursor control commands", () => {
	test("each control template runs the checkout's bin/ultrathink with host cursor, and none uses the Claude plugin root", () => {
		const dir = join(import.meta.dir, "..", "hosts", "cursor", "commands");
		const verbs = ["on", "off", "skip", "status", "track"];
		const names = [...verbs.map((verb) => `ultrathink-${verb}`), "ultrathink-quick"];
		expect(readdirSync(dir).filter((file) => file.endsWith(".md")).sort()).toEqual(names.map((name) => `${name}.md`).sort());
		for (const name of names) {
			const text = readFileSync(join(dir, `${name}.md`), "utf8");
			expect(text).toContain(`name: ${name}\n`);
			expect(text).not.toContain("CLAUDE_PLUGIN_ROOT");
		}
		for (const verb of verbs) {
			const text = readFileSync(join(dir, `ultrathink-${verb}.md`), "utf8");
			expect(text).toContain(`ULTRATHINK_HOST=cursor "$(cat "$HOME/.cursor/hooks/ultrathink-cursor-plan.root")/bin/ultrathink" ${verb} $ARGUMENTS`);
			expect(text).toContain(`ULTRATHINK_HOST=cursor "<that directory>/bin/ultrathink" ${verb} $ARGUMENTS`);
		}
	});
});

describe("installed planner hook", () => {
	test("the staged hook answers /ultrathink-status from its checkout with no ULTRATHINK_ROOT set", async () => {
		const cursorDir = mkdtempSync(join(tmpdir(), "cursor-plugin-e2e-"));
		const home = mkdtempSync(join(tmpdir(), "cursor-plugin-home-"));
		const checkout = join(import.meta.dir, "..");
		const node = Bun.which("node") ?? process.execPath;
		try {
			expect(main(["install", "--cursor-dir", cursorDir], { env: {}, root: checkout, log: () => {}, nodeCandidates: [node] })).toBe(0);
			const hooks = JSON.parse(readFileSync(join(cursorDir, "hooks.json"), "utf8")) as { hooks: Record<string, unknown[]> };
			const entry = hooks.hooks[EVENT]?.find(isPlanOwned) as { command?: string } | undefined;
			if (typeof entry?.command !== "string") throw new Error("planner entry missing from hooks.json");
			const stdout = await runShell(entry.command, JSON.stringify({ prompt: "/ultrathink-status", conversation_id: "e2e", workspace_roots: [home] }), {
				PATH: process.env.PATH ?? "",
				HOME: home,
				BUN: process.execPath,
				XDG_CONFIG_HOME: join(home, ".config"),
				CLAUDE_CONFIG_DIR: join(home, ".claude"),
			});
			const reply = JSON.parse(stdout) as { continue?: boolean; user_message?: string };
			expect(reply.continue).toBe(false);
			expect(reply.user_message).toContain("Prompt Uplift");
			expect(reply.user_message).toContain(join(home, ".cursor", "ultrathink"));
		} finally {
			rmSync(cursorDir, { recursive: true, force: true });
			rmSync(home, { recursive: true, force: true });
		}
	}, 60_000);
});
